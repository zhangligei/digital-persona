#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import pickle
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np
import soundfile as sf

from gpu_services.livetalking_gateway.procedural_idle import _valid_box


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify mouth motion settles when recorded speech ends.")
    parser.add_argument("video", type=Path)
    parser.add_argument("avatar_root", type=Path)
    parser.add_argument(
        "--ffmpeg",
        default="/home/user/echo/envs/livetalking/bin/ffmpeg",
    )
    args = parser.parse_args()

    with tempfile.NamedTemporaryFile(suffix=".wav") as extracted:
        subprocess.run(
            [
                args.ffmpeg,
                "-v", "error", "-y", "-i", str(args.video.resolve()),
                "-ac", "1", "-ar", "16000", extracted.name,
            ],
            check=True,
        )
        audio, sample_rate = sf.read(extracted.name, dtype="float32")

    capture = cv2.VideoCapture(str(args.video.resolve()))
    if not capture.isOpened():
        raise ValueError(f"could not open {args.video}")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 25.0)
    with (args.avatar_root / "coords.pkl").open("rb") as source:
        coordinates = pickle.load(source)

    dark_fraction: list[float] = []
    mouth_motion: list[float] = []
    previous_gray = None
    frame_index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        height, width = frame.shape[:2]
        raw_box = coordinates[frame_index % len(coordinates)] if coordinates else None
        box = _valid_box(raw_box, width, height)
        if box is None:
            dark_fraction.append(0.0)
            mouth_motion.append(0.0)
            frame_index += 1
            continue
        x0, y0, x1, y1 = box
        face_width, face_height = x1 - x0, y1 - y0
        mouth = frame[
            y0 + round(face_height * 0.58):y0 + round(face_height * 0.88),
            x0 + round(face_width * 0.22):x0 + round(face_width * 0.78),
        ]
        gray = cv2.cvtColor(mouth, cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, (128, 96), interpolation=cv2.INTER_AREA)
        dark_fraction.append(float(np.mean(gray < 58)))
        mouth_motion.append(
            float(np.mean(np.abs(gray.astype(np.float32) - previous_gray.astype(np.float32))))
            if previous_gray is not None and previous_gray.shape == gray.shape
            else 0.0
        )
        previous_gray = gray
        frame_index += 1
    capture.release()

    samples_per_frame = sample_rate / fps
    audio_rms: list[float] = []
    for index in range(len(dark_fraction)):
        start = round(index * samples_per_frame)
        end = round((index + 1) * samples_per_frame)
        chunk = audio[start:end]
        audio_rms.append(float(np.sqrt(np.mean(np.square(chunk, dtype=np.float64)))) if chunk.size else 0.0)
    active = [index for index, rms in enumerate(audio_rms) if rms > 0.0008]
    if not active:
        raise ValueError("recording contains no audible speech")
    speech_start, speech_end = active[0], active[-1]
    settle_start = min(len(mouth_motion), speech_end + round(0.60 * fps))
    settle_end = min(len(mouth_motion), speech_end + round(2.60 * fps))
    tail_motion = np.asarray(mouth_motion[settle_start:settle_end], dtype=np.float32)
    speech_motion = np.asarray(mouth_motion[speech_start:speech_end + 1], dtype=np.float32)
    tail_dark = np.asarray(dark_fraction[settle_start:settle_end], dtype=np.float32)
    speech_dark = np.asarray(dark_fraction[speech_start:speech_end + 1], dtype=np.float32)

    speech_motion_median = float(np.median(speech_motion))
    tail_motion_median = float(np.median(tail_motion)) if tail_motion.size else 0.0
    motion_ratio = tail_motion_median / max(1e-6, speech_motion_median)
    result = {
        "video": str(args.video),
        "frames": len(mouth_motion),
        "fps": round(fps, 3),
        "speech_start_seconds": round(speech_start / fps, 3),
        "speech_end_seconds": round((speech_end + 1) / fps, 3),
        "analysis_tail_seconds": [round(settle_start / fps, 3), round(settle_end / fps, 3)],
        "speech_mouth_motion_median": round(speech_motion_median, 5),
        "tail_mouth_motion_median": round(tail_motion_median, 5),
        "tail_to_speech_motion_ratio": round(motion_ratio, 4),
        "speech_mouth_dark_fraction_median": round(float(np.median(speech_dark)), 5),
        "tail_mouth_dark_fraction_median": round(float(np.median(tail_dark)), 5) if tail_dark.size else 0.0,
        "mouth_settled": bool(motion_ratio < 0.42),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["mouth_settled"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
