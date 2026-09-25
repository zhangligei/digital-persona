from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, FormData, web

from .auth import AuthError, SessionIdentity, verify_session_token
from .media import canonical_avatar_video, canonical_voice_reference, download_private_media, safe_filename
from .speech_profile import profile_path_for_voice, save_speech_profile
from .tasks import AVATAR_ID_RE, AvatarTaskStore


LOGGER = logging.getLogger("echo-livetalking-gateway")
PERSONA_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,160}$")
QUICK_TUNNEL_ORIGIN_RE = re.compile(r"^https://[a-z0-9-]+\.trycloudflare\.com$")


def json_ok(data: dict | None = None, *, status: int = 200) -> web.Response:
    payload: dict = {"code": 0, "msg": "ok"}
    if data is not None:
        payload["data"] = data
    return web.json_response(payload, status=status)


def json_error(message: str, *, status: int = 400, code: int = -1) -> web.Response:
    return web.json_response({"code": code, "msg": str(message)}, status=status)


def _bearer_token(request: web.Request) -> str:
    authorization = request.headers.get("Authorization", "")
    if not authorization.startswith("Bearer "):
        raise AuthError("missing bearer token")
    return authorization[7:].strip()


@web.middleware
async def auth_middleware(request: web.Request, handler):
    if request.path in {"/health", "/ready"}:
        return await handler(request)
    try:
        token = _bearer_token(request)
        identity = verify_session_token(token, request.app["session_secret"])
    except AuthError as error:
        return json_error(str(error), status=401)
    request["bearer_token"] = token
    request["identity"] = identity
    return await handler(request)


async def health(request: web.Request) -> web.Response:
    upstream_ok = False
    try:
        async with request.app["http"].get(f'{request.app["upstream_url"]}/api/admin/config') as response:
            upstream_ok = response.status == 200
    except Exception:
        pass
    payload = {"ok": True, "service": "echo-livetalking-gateway", "upstream": upstream_ok}
    try:
        demo_origin = request.app["demo_origin_file"].read_text(encoding="utf-8").strip()
        if QUICK_TUNNEL_ORIGIN_RE.fullmatch(demo_origin):
            payload["demoOrigin"] = demo_origin
    except OSError:
        pass
    return web.json_response(payload)


async def proxy(request: web.Request) -> web.StreamResponse:
    upstream = f'{request.app["upstream_url"]}{request.rel_url}'
    body = await request.read()
    headers = {}
    if request.content_type:
        headers["Content-Type"] = request.headers.get("Content-Type", request.content_type)
    async with request.app["http"].request(request.method, upstream, data=body, headers=headers) as response:
        response_body = await response.read()
        content_type = response.headers.get("Content-Type", "application/json")
        return web.Response(body=response_body, status=response.status, headers={"Content-Type": content_type})


async def submit_avatar(request: web.Request) -> web.Response:
    identity: SessionIdentity = request["identity"]
    payload = await request.json()
    avatar_id = str(payload.get("avatar_id") or "")
    expected_avatar_id = f"persona_{identity.persona_id}"
    if avatar_id != expected_avatar_id or not AVATAR_ID_RE.fullmatch(avatar_id):
        return json_error("avatar id does not match the authenticated persona", status=403)
    source_url = str(payload.get("source_url") or "")
    source_name = safe_filename(str(payload.get("file_name") or "source.mp4"))
    idle_url = str(payload.get("idle_source_url") or "")
    idle_name = safe_filename(str(payload.get("idle_file_name") or "idle.mp4"))
    if not source_url:
        return json_error("source_url is required")

    job_root = request.app["jobs_dir"] / "uploads" / identity.persona_id
    job_root.mkdir(parents=True, exist_ok=True)
    nonce = os.urandom(8).hex()
    source_upload = job_root / f"{nonce}-{source_name}"
    source_mp4 = job_root / f"{nonce}-source.mp4"
    idle_upload = job_root / f"{nonce}-{idle_name}"
    idle_mp4 = job_root / f"{nonce}-idle.mp4"
    try:
        await download_private_media(request.app["http"], source_url, request["bearer_token"], source_upload)
        await canonical_avatar_video(source_upload, source_mp4)
        prepared_idle: Path | None = None
        if idle_url:
            await download_private_media(request.app["http"], idle_url, request["bearer_token"], idle_upload)
            await canonical_avatar_video(idle_upload, idle_mp4)
            prepared_idle = idle_mp4
        task_id = await request.app["task_store"].submit(avatar_id, source_mp4, prepared_idle)
        return json_ok({"task_id": task_id})
    except (OSError, ValueError, asyncio.TimeoutError) as error:
        LOGGER.exception("avatar submission failed persona=%s", identity.persona_id)
        return json_error(str(error), status=422)
    finally:
        source_upload.unlink(missing_ok=True)
        idle_upload.unlink(missing_ok=True)


async def avatar_task(request: web.Request) -> web.Response:
    task = request.app["task_store"].get(request.match_info["task_id"])
    if task is None:
        return json_error("Task not found", status=404, code=404)
    identity: SessionIdentity = request["identity"]
    if task.get("avatar_id") != f"persona_{identity.persona_id}":
        return json_error("task does not belong to this persona", status=403)
    return json_ok(task)


async def avatar_readiness(request: web.Request) -> web.Response:
    identity: SessionIdentity = request["identity"]
    persona_id = request.match_info["persona_id"]
    if persona_id != identity.persona_id:
        return json_error("persona mismatch", status=403)
    status = request.app["task_store"].readiness(f"persona_{persona_id}")
    return json_ok({"status": status})


async def delete_persona(request: web.Request) -> web.Response:
    identity: SessionIdentity = request["identity"]
    persona_id = request.match_info["persona_id"]
    if persona_id != identity.persona_id or not PERSONA_ID_RE.fullmatch(persona_id):
        return json_error("persona mismatch", status=403)
    avatar_root = (request.app["service_root"] / "data" / "avatars" / f"persona_{persona_id}").resolve()
    voice_ref = (request.app["service_root"] / "data" / "voice_refs" / f"{persona_id}.wav").resolve()
    expected_parent = (request.app["service_root"] / "data" / "avatars").resolve()
    if avatar_root.parent != expected_parent:
        return json_error("invalid avatar path", status=400)
    if avatar_root.exists():
        shutil.rmtree(avatar_root)
    voice_ref.unlink(missing_ok=True)
    profile_path_for_voice(voice_ref).unlink(missing_ok=True)
    return json_ok({"deleted": True})


async def _transcribe_path(request: web.Request, audio_path: Path, dialect: str) -> dict:
    form = FormData()
    audio_file = audio_path.open("rb")
    form.add_field("audio", audio_file, filename=audio_path.name, content_type="audio/wav")
    form.add_field("dialect", dialect)
    try:
        async with request.app["http"].post(f'{request.app["stt_url"]}/transcribe', data=form) as response:
            payload = await response.json()
            if response.status != 200:
                raise ValueError(payload.get("detail") or f"STT returned HTTP {response.status}")
            return payload
    finally:
        audio_file.close()


async def save_voice_reference(request: web.Request) -> web.Response:
    identity: SessionIdentity = request["identity"]
    payload = await request.json()
    persona_id = str(payload.get("persona_id") or "")
    if persona_id != identity.persona_id or not PERSONA_ID_RE.fullmatch(persona_id):
        return json_error("persona mismatch", status=403)
    source_url = str(payload.get("source_url") or "")
    file_name = safe_filename(str(payload.get("file_name") or "voice.bin"))
    if not source_url:
        return json_error("source_url is required")

    job_root = request.app["jobs_dir"] / "voice" / persona_id
    job_root.mkdir(parents=True, exist_ok=True)
    upload = job_root / f"{os.urandom(8).hex()}-{file_name}"
    destination = request.app["service_root"] / "data" / "voice_refs" / f"{persona_id}.wav"
    try:
        await download_private_media(request.app["http"], source_url, request["bearer_token"], upload)
        await canonical_voice_reference(upload, destination)
        transcription = await _transcribe_path(request, destination, "auto")
        save_speech_profile(destination, transcription.get("speech_profile"))
        return json_ok({
            "path": f"data/voice_refs/{persona_id}.wav",
            "text": str(transcription.get("text") or "").strip(),
            "speech_profile": transcription.get("speech_profile"),
            "speech_style_summary": transcription.get("speech_style_summary"),
        })
    except (OSError, ValueError, asyncio.TimeoutError) as error:
        LOGGER.exception("voice reference failed persona=%s", persona_id)
        return json_error(str(error), status=422)
    finally:
        upload.unlink(missing_ok=True)


async def speak_voice_reference(request: web.Request) -> web.Response:
    """Drive the authenticated persona with its saved reference WAV.

    This is intentionally server-side: the browser never receives a path to
    the GPU filesystem, while LiveTalking still performs the real WebRTC
    audio-driven mouth animation through its existing ``/humanaudio`` route.
    """
    identity: SessionIdentity = request["identity"]
    persona_id = identity.persona_id
    if not PERSONA_ID_RE.fullmatch(persona_id):
        return json_error("invalid persona id", status=400)

    payload = await request.json()
    session_id = str(payload.get("sessionid") or "").strip()
    if not session_id or len(session_id) > 160:
        return json_error("a valid live-session id is required", status=400)

    voice_root = (request.app["service_root"] / "data" / "voice_refs").resolve()
    voice_ref = (voice_root / f"{persona_id}.wav").resolve()
    if voice_ref.parent != voice_root:
        return json_error("invalid voice-reference path", status=400)
    if not voice_ref.is_file():
        return json_error("voice reference is missing", status=404)

    form = FormData()
    audio_file = voice_ref.open("rb")
    form.add_field("sessionid", session_id)
    form.add_field("file", audio_file, filename=voice_ref.name, content_type="audio/wav")
    try:
        async with request.app["http"].post(
            f'{request.app["upstream_url"]}/humanaudio',
            data=form,
        ) as response:
            response_body = await response.read()
            content_type = response.headers.get("Content-Type", "application/json")
            return web.Response(
                body=response_body,
                status=response.status,
                headers={"Content-Type": content_type},
            )
    finally:
        audio_file.close()


async def transcribe_voice(request: web.Request) -> web.Response:
    reader = await request.multipart()
    audio_path: Path | None = None
    dialect = "mandarin"
    try:
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == "dialect":
                dialect = (await part.text()).strip().lower()
            elif part.name == "audio":
                name = safe_filename(part.filename or "utterance.webm")
                audio_path = request.app["jobs_dir"] / "stt" / f"{os.urandom(8).hex()}-{name}"
                audio_path.parent.mkdir(parents=True, exist_ok=True)
                with audio_path.open("wb") as output:
                    while chunk := await part.read_chunk(256 * 1024):
                        output.write(chunk)
        if audio_path is None:
            return json_error("audio is required")
        payload = await _transcribe_path(request, audio_path, dialect)
        spoken_variant = str(payload.get("spoken_variant") or "").strip().lower()
        if spoken_variant not in {"english", "mandarin", "wu", "shanghainese"}:
            spoken_variant = "english" if str(payload.get("language") or "").lower() == "en" else "mandarin"
        return json_ok({
            "text": str(payload.get("text") or "").strip(),
            "engine": payload.get("engine"),
            "spoken_variant": spoken_variant,
            "variant_confidence": payload.get("variant_confidence"),
        })
    except (OSError, ValueError, asyncio.TimeoutError) as error:
        return json_error(str(error), status=422)
    finally:
        if audio_path:
            audio_path.unlink(missing_ok=True)


async def rag_proxy(request: web.Request) -> web.Response:
    tail = request.match_info.get("tail", "")
    upstream = f'{request.app["memory_url"]}/api/rag/{tail}'
    body = await request.read()
    headers = {"Authorization": request.headers.get("Authorization", "")}
    if request.content_type:
        headers["Content-Type"] = request.headers.get("Content-Type", request.content_type)
    async with request.app["http"].request(request.method, upstream, data=body, headers=headers, params=request.query) as response:
        return web.Response(body=await response.read(), status=response.status, headers={"Content-Type": response.headers.get("Content-Type", "application/json")})


async def startup(app: web.Application) -> None:
    app["http"] = ClientSession(timeout=ClientTimeout(total=120, connect=15))
    await app["task_store"].start()


async def cleanup(app: web.Application) -> None:
    await app["task_store"].close()
    await app["http"].close()


def create_app() -> web.Application:
    service_root = Path(os.environ.get("LIVETALKING_SERVICE_ROOT", "/home/user/echo/services/livetalking")).resolve()
    jobs_dir = Path(os.environ.get("ECHO_JOBS_DIR", "/home/user/echo/runtime/jobs")).resolve()
    python_executable = Path(os.environ.get("LIVETALKING_PYTHON", "/home/user/echo/envs/livetalking/bin/python")).resolve()
    secret = os.environ.get("LIVETALKING_SESSION_SECRET", "")
    if not secret:
        raise RuntimeError("LIVETALKING_SESSION_SECRET is required")

    app = web.Application(client_max_size=110 * 1024 * 1024, middlewares=[auth_middleware])
    app.update({
        "session_secret": secret,
        "service_root": service_root,
        "jobs_dir": jobs_dir,
        "upstream_url": os.environ.get("LIVETALKING_UPSTREAM_URL", "http://127.0.0.1:8011").rstrip("/"),
        "stt_url": os.environ.get("ECHO_STT_URL", "http://127.0.0.1:9891").rstrip("/"),
        "memory_url": os.environ.get("AGENTIC_MEMORY_URL", "http://127.0.0.1:9010").rstrip("/"),
        "demo_origin_file": Path(
            os.environ.get("ECHO_DEMO_ORIGIN_FILE", "/home/user/echo/runtime/demo-proxy-origin.url")
        ).resolve(),
    })
    app["task_store"] = AvatarTaskStore(jobs_dir, service_root, python_executable)
    app.on_startup.append(startup)
    app.on_cleanup.append(cleanup)

    app.router.add_get("/health", health)
    app.router.add_get("/ready", health)
    for path in ("/offer", "/human", "/humanaudio", "/set_audiotype", "/record", "/interrupt_talk", "/is_speaking", "/close_session"):
        app.router.add_route("*", path, proxy)
    app.router.add_post("/api/avatar/task-from-url", submit_avatar)
    app.router.add_post("/api/avatar/task/{task_id}", avatar_task)
    app.router.add_post("/api/avatar/persona/{persona_id}/status", avatar_readiness)
    app.router.add_delete("/api/avatar/persona/{persona_id}", delete_persona)
    app.router.add_post("/api/voice/reference-from-url", save_voice_reference)
    app.router.add_post("/api/voice/speak-reference", speak_voice_reference)
    app.router.add_post("/api/voice/transcribe", transcribe_voice)
    app.router.add_route("*", "/api/rag/{tail:.*}", rag_proxy)
    return app


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    web.run_app(create_app(), host=os.environ.get("GATEWAY_HOST", "127.0.0.1"), port=int(os.environ.get("GATEWAY_PORT", "8010")))
