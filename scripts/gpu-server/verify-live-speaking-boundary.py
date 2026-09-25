#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path

import soundfile as sf
from aiohttp import ClientSession, FormData


async def main_async() -> int:
    parser = argparse.ArgumentParser(description="Measure renderer speaking state around one audio upload.")
    parser.add_argument("session_id")
    parser.add_argument("audio", type=Path)
    parser.add_argument("--base-url", default="http://127.0.0.1:8011")
    args = parser.parse_args()

    info = sf.info(str(args.audio.resolve()))
    audio_duration = float(info.frames / info.samplerate)
    timeline: list[tuple[float, bool]] = []

    async with ClientSession() as session:
        form = FormData()
        form.add_field("sessionid", args.session_id)
        with args.audio.open("rb") as audio_file:
            form.add_field("file", audio_file, filename=args.audio.name, content_type="audio/wav")
            response = await session.post(f"{args.base_url}/humanaudio", data=form)
            if response.status != 200:
                raise RuntimeError(f"humanaudio returned HTTP {response.status}: {await response.text()}")
            await response.read()

        started = time.perf_counter()
        deadline = started + audio_duration + 4.0
        while time.perf_counter() < deadline:
            response = await session.post(
                f"{args.base_url}/is_speaking",
                json={"sessionid": args.session_id},
            )
            payload = await response.json()
            timeline.append((time.perf_counter() - started, bool(payload.get("data"))))
            await asyncio.sleep(0.10)

    speaking_samples = [seconds for seconds, speaking in timeline if speaking]
    if not speaking_samples:
        raise RuntimeError("renderer never entered speaking state")
    first_true = min(speaking_samples)
    last_true = max(speaking_samples)
    first_false_after = next(
        (seconds for seconds, speaking in timeline if seconds > last_true and not speaking),
        None,
    )
    # The upload begins feeding the renderer before the first poll. Compare
    # the first observed false state after speech with the source duration;
    # one inference batch plus the real-time output cushion should stay below
    # 0.8 seconds.
    stopped_at = first_false_after if first_false_after is not None else timeline[-1][0]
    excess = stopped_at - audio_duration
    result = {
        "audio_duration_seconds": round(audio_duration, 3),
        "first_speaking_seconds": round(first_true, 3),
        "last_speaking_sample_seconds": round(last_true, 3),
        "first_silent_sample_seconds": round(stopped_at, 3),
        "visual_tail_beyond_audio_seconds": round(excess, 3),
        "mouth_stopped_on_time": bool(excess < 0.80),
        "poll_samples": len(timeline),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["mouth_stopped_on_time"] else 2


def main() -> int:
    return asyncio.run(main_async())


if __name__ == "__main__":
    raise SystemExit(main())
