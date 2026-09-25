#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import pickle
from pathlib import Path

import cv2
import numpy as np

from gpu_services.livetalking_gateway.procedural_idle import _eye_openness, _valid_box


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure blink events in a LiveTalking recording.")
    parser.add_argument("video", type=Path)
    parser.add_argument("avatar_root", type=Path)
    args = parser.parse_args()

    capture = cv2.VideoCapture(str(args.video.resolve()))
    if not capture.isOpened():
        raise ValueError(f"could not open {args.video}")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 25.0)
    with (args.avatar_root / "coords.pkl").open("rb") as source:
        coordinates = pickle.load(source)

    openness: list[float | None] = []
    frame_index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        height, width = frame.shape[:2]
        raw_box = coordinates[frame_index % len(coordinates)] if coordinates else None
        box = _valid_box(raw_box, width, height)
        openness.append(_eye_openness(frame, box) if box is not None else None)
        frame_index += 1
    capture.release()

    valid = np.asarray([value for value in openness if value is not None], dtype=np.float32)
    if valid.size < max(10, len(openness) // 3):
        raise ValueError("too few frames produced usable eye landmarks")
    baseline = float(np.median(valid))
    threshold = baseline * 0.76

    events: list[dict[str, float | int]] = []
    start: int | None = None
    values: list[float] = []
    for index, value in enumerate(openness + [None]):
        is_closed = value is not None and value < threshold
        if is_closed:
            if start is None:
                start = index
                values = []
            values.append(float(value))
        elif start is not None:
            events.append({
                "start_frame": start,
                "time_seconds": round(start / fps, 3),
                "duration_frames": index - start,
                "minimum_openness": round(min(values), 5),
                "depth_ratio": round(min(values) / baseline, 4),
            })
            start = None
            values = []

    starts = [int(event["start_frame"]) for event in events]
    intervals = [round((later - earlier) / fps, 3) for earlier, later in zip(starts, starts[1:])]
    result = {
        "video": str(args.video),
        "frames": len(openness),
        "fps": round(fps, 3),
        "duration_seconds": round(len(openness) / fps, 3),
        "baseline_eye_openness": round(baseline, 5),
        "closed_threshold": round(threshold, 5),
        "blink_count": len(events),
        "blink_intervals_seconds": intervals,
        "events": events,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if events else 2


if __name__ == "__main__":
    raise SystemExit(main())
