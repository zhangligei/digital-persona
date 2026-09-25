from __future__ import annotations

import asyncio
import ctypes
import logging
import os
import tempfile
import threading
import time
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, web
from faster_whisper import WhisperModel

from gpu_services.speech_recognition.language import forced_language, gate_transcript, normalize_preference
from gpu_services.speech_style.profile import build_speech_profile, speech_style_summary


LOGGER = logging.getLogger("echo-speech-recognition")
MODEL_NAME = os.environ.get("FASTER_WHISPER_MODEL", "small")
DEVICE = os.environ.get("FASTER_WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("FASTER_WHISPER_COMPUTE_TYPE", "float16" if DEVICE == "cuda" else "int8")
MODEL_ROOT = os.environ.get("FASTER_WHISPER_MODEL_ROOT", "/home/user/echo/models/faster-whisper")
WU_URL = os.environ.get("WENETSPEECH_WU_URL", "http://127.0.0.1:9890/transcribe-path")
MAX_AUDIO_BYTES = int(os.environ.get("STT_MAX_AUDIO_BYTES", str(20 * 1024 * 1024)))


def require_cuda_runtime() -> None:
    """Fail startup instead of reporting healthy with a broken lazy runtime."""

    if DEVICE != "cuda":
        return
    for library in ("libcublas.so.12", "libcudnn.so.9"):
        try:
            ctypes.CDLL(library)
        except OSError as error:
            raise RuntimeError(f"Faster-Whisper CUDA dependency is unavailable: {library}") from error


require_cuda_runtime()
MODEL = WhisperModel(
    MODEL_NAME,
    device=DEVICE,
    compute_type=COMPUTE_TYPE,
    download_root=MODEL_ROOT,
)
INFERENCE_LOCK = threading.Lock()


def transcribe_file(path: Path, preference: str) -> dict:
    started = time.perf_counter()
    language = forced_language(preference)
    with INFERENCE_LOCK:
        segments_iterator, info = MODEL.transcribe(
            str(path),
            beam_size=5,
            vad_filter=True,
            language=language,
            word_timestamps=True,
            condition_on_previous_text=False,
        )
        segments = list(segments_iterator)
    rows = [
        {
            "start": float(segment.start),
            "end": float(segment.end),
            "text": segment.text.strip(),
            "words": [
                {"start": float(word.start), "end": float(word.end), "word": word.word}
                for word in (segment.words or [])
                if word.start is not None and word.end is not None
            ],
        }
        for segment in segments
        if segment.text.strip()
    ]
    raw_text = " ".join(row["text"] for row in rows).strip()
    text = gate_transcript(raw_text, preference)
    detected_language = getattr(info, "language", None)
    profile = build_speech_profile(rows, detected_language or language)
    return {
        "text": text,
        "engine": "faster-whisper",
        "language": detected_language,
        "language_probability": float(getattr(info, "language_probability", 0.0) or 0.0),
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "speech_profile": profile,
        "speech_style_summary": speech_style_summary(profile),
    }


async def maybe_use_wu(request: web.Request, path: Path, preference: str, fallback: dict) -> dict:
    if preference not in {"wu", "auto"}:
        if preference == "english":
            fallback["spoken_variant"] = "english"
            fallback["variant_confidence"] = fallback.get("language_probability")
        else:
            fallback["spoken_variant"] = "mandarin"
            fallback["variant_confidence"] = fallback.get("language_probability")
        return fallback
    try:
        async with request.app["http"].post(
            WU_URL,
            json={"path": str(path), "fallback": fallback, "preference": preference},
        ) as response:
            if response.status != 200:
                raise ValueError(f"Wu STT returned HTTP {response.status}")
            result = await response.json()
            if not isinstance(result, dict) or not isinstance(result.get("text"), str):
                raise ValueError("Wu STT returned an invalid response")
            result.setdefault("speech_profile", fallback.get("speech_profile"))
            result.setdefault("speech_style_summary", fallback.get("speech_style_summary"))
            return result
    except Exception:
        LOGGER.warning("Wu STT unavailable; retaining Faster-Whisper result", exc_info=True)
        language = str(fallback.get("language") or "").lower()
        fallback["spoken_variant"] = "english" if language == "en" else "mandarin"
        fallback["variant_confidence"] = fallback.get("language_probability")
        return fallback


async def health(_request: web.Request) -> web.Response:
    return web.json_response({
        "ok": True,
        "service": "echo-speech-recognition",
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
    })


async def transcribe(request: web.Request) -> web.Response:
    temporary_path: Path | None = None
    try:
        reader = await request.multipart()
        preference = "auto"
        audio_part = None
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == "dialect":
                preference = normalize_preference(await part.text())
            elif part.name == "audio":
                audio_part = part
                suffix = Path(part.filename or "utterance.webm").suffix.lower()
                if suffix not in {".wav", ".mp3", ".m4a", ".mp4", ".mov", ".webm", ".ogg", ".opus"}:
                    raise ValueError("unsupported audio container")
                with tempfile.NamedTemporaryFile(suffix=suffix or ".bin", delete=False) as temporary:
                    written = 0
                    while chunk := await part.read_chunk(256 * 1024):
                        written += len(chunk)
                        if written > MAX_AUDIO_BYTES:
                            raise ValueError("audio exceeds the service limit")
                        temporary.write(chunk)
                    temporary_path = Path(temporary.name)
        if audio_part is None or temporary_path is None or temporary_path.stat().st_size == 0:
            raise ValueError("audio is required")
        fallback = await asyncio.to_thread(transcribe_file, temporary_path, preference)
        result = await maybe_use_wu(request, temporary_path, preference, fallback)
        return web.json_response(result)
    except (OSError, ValueError) as error:
        return web.json_response({"detail": str(error)}, status=400)
    except Exception:
        LOGGER.exception("transcription failed")
        return web.json_response({"detail": "transcription failed"}, status=500)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


async def startup(app: web.Application) -> None:
    app["http"] = ClientSession(timeout=ClientTimeout(total=20, connect=3))


async def cleanup(app: web.Application) -> None:
    await app["http"].close()


def create_app() -> web.Application:
    app = web.Application(client_max_size=MAX_AUDIO_BYTES)
    app.on_startup.append(startup)
    app.on_cleanup.append(cleanup)
    app.add_routes([web.get("/health", health), web.post("/transcribe", transcribe)])
    return app


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    web.run_app(create_app(), host="127.0.0.1", port=int(os.environ.get("STT_PORT", "9891")))
