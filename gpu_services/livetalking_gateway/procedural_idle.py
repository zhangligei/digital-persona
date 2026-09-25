from __future__ import annotations

import hashlib
import json
import math
import os
import pickle
import random
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Sequence

from .avatar_runtime import apply_synthetic_blink


@dataclass(frozen=True)
class MotionSample:
    translate_x: float
    translate_y: float
    rotation_degrees: float
    scale: float
    blink: float


def _seed_for(value: str) -> int:
    return int.from_bytes(hashlib.sha256(value.encode("utf-8")).digest()[:8], "big")


def _smoothstep(value: float) -> float:
    bounded = max(0.0, min(1.0, value))
    return bounded * bounded * (3.0 - 2.0 * bounded)


def _blink_envelope(rng: random.Random, *, secondary: bool = False) -> list[float]:
    """Return one subtly unique asymmetric close/open blink curve."""

    peak = rng.uniform(0.76, 0.92) if secondary else rng.uniform(0.86, 1.0)
    closing_frames = rng.choice((2, 2, 3))
    opening_frames = rng.choice((3, 4, 4, 5))
    hold_frames = 1 if rng.random() < (0.12 if secondary else 0.24) else 0
    closing = [peak * _smoothstep((index + 1) / closing_frames) for index in range(closing_frames)]
    hold = [peak * rng.uniform(0.965, 1.0) for _ in range(hold_frames)]
    # Leave a small positive final sample so the last eyelid motion eases into
    # the neutral source frame instead of snapping open on the next frame.
    opening = [
        peak * (1.0 - _smoothstep((index + 1) / (opening_frames + 1)))
        for index in range(opening_frames)
    ]
    return closing + hold + opening


def _blink_interval(rng: random.Random) -> float:
    # A bounded log-normal distribution gives many ordinary intervals and a
    # few longer pauses. Uniform spacing still looks metronomic when a loop is
    # replayed, even if its lower and upper limits are technically random.
    interval = math.exp(rng.gauss(math.log(3.7), 0.34))
    if rng.random() < 0.13:
        interval += rng.uniform(1.0, 2.4)
    return max(2.2, min(7.8, interval))


def _apply_blink(blink_values: list[float], start: int, envelope: Sequence[float]) -> None:
    for offset, value in enumerate(envelope):
        if start + offset < len(blink_values):
            blink_values[start + offset] = max(blink_values[start + offset], value)


def motion_samples(frame_count: int, fps: int, seed_text: str) -> list[MotionSample]:
    """Build a bounded, deterministic relaxed-motion curve.

    The low-frequency head drift is an Ornstein-Uhlenbeck process, so it
    wanders naturally but returns toward centre instead of walking out of the
    crop. Breathing uses two slightly different sine periods. Blink timing
    follows a bounded long-tailed distribution; every blink varies its depth,
    closing speed, opening speed and optional hold, with an occasional softer
    double blink. The result stays deterministic for reproducible avatar
    packages, but no longer looks like one action fired by a metronome.
    """

    if frame_count <= 0 or fps <= 0:
        return []
    rng = random.Random(_seed_for(seed_text))
    blink_values = [0.0] * frame_count
    next_blink = _blink_interval(rng)
    while round(next_blink * fps) < frame_count:
        start = round(next_blink * fps)
        _apply_blink(blink_values, start, _blink_envelope(rng))
        if rng.random() < 0.12:
            double_start = start + round(rng.uniform(0.32, 0.58) * fps)
            _apply_blink(blink_values, double_start, _blink_envelope(rng, secondary=True))
        next_blink += _blink_interval(rng)

    x = y = rotation = 0.0
    samples: list[MotionSample] = []
    for index in range(frame_count):
        x = max(-2.8, min(2.8, x * 0.94 + rng.gauss(0.0, 0.18)))
        y = max(-1.8, min(1.8, y * 0.95 + rng.gauss(0.0, 0.11)))
        rotation = max(-0.32, min(0.32, rotation * 0.96 + rng.gauss(0.0, 0.018)))
        seconds = index / fps
        breath = math.sin((2.0 * math.pi * seconds) / 4.4)
        secondary = math.sin((2.0 * math.pi * seconds) / 7.1 + 0.7)
        samples.append(
            MotionSample(
                translate_x=x,
                translate_y=y + breath * 0.36,
                rotation_degrees=rotation,
                scale=1.0 + breath * 0.0018 + secondary * 0.0007,
                blink=blink_values[index],
            )
        )
    return samples


def _valid_box(value: object, width: int, height: int) -> tuple[int, int, int, int] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        x0, y0, x1, y1 = (int(float(part)) for part in value)
    except (TypeError, ValueError):
        return None
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(width, x1), min(height, y1)
    if x1 - x0 < 24 or y1 - y0 < 24:
        return None
    return x0, y0, x1, y1


def _neutral_frame(
    image_paths: Sequence[Path],
    coordinates: Sequence[object],
) -> tuple[object, tuple[int, int, int, int], int]:
    import cv2
    import numpy as np

    candidates: list[tuple[float, int, object, tuple[int, int, int, int]]] = []
    for index, path in enumerate(image_paths):
        image = cv2.imread(os.fspath(path), cv2.IMREAD_COLOR)
        if image is None:
            continue
        height, width = image.shape[:2]
        box = _valid_box(coordinates[index] if index < len(coordinates) else None, width, height)
        if box is None:
            continue
        x0, y0, x1, y1 = box
        face_width, face_height = x1 - x0, y1 - y0
        mouth = image[
            y0 + round(face_height * 0.61) : y0 + round(face_height * 0.87),
            x0 + round(face_width * 0.24) : x0 + round(face_width * 0.76),
        ]
        if mouth.size == 0:
            continue
        gray = cv2.cvtColor(mouth, cv2.COLOR_BGR2GRAY)
        dark_fraction = float(np.mean(gray < 58))
        sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        score = dark_fraction + (0.03 if sharpness < 25.0 else 0.0)
        candidates.append((score, index, image, box))
    if not candidates:
        raise ValueError("no usable neutral source frame was found")
    _score, index, image, box = min(candidates, key=lambda item: (item[0], item[1]))
    return image, box, index


def _eye_openness(image, box: tuple[int, int, int, int]) -> float | None:
    try:
        import face_recognition
        import numpy as np
    except ImportError:
        return None

    x0, y0, x1, y1 = box
    rgb = image[:, :, ::-1]
    landmarks = face_recognition.face_landmarks(
        rgb,
        face_locations=[(y0, x1, y1, x0)],
        model="large",
    )
    if not landmarks:
        return None
    ratios: list[float] = []
    for key in ("left_eye", "right_eye"):
        points = np.asarray(landmarks[0].get(key, []), dtype=np.float32)
        if points.shape != (6, 2):
            continue
        horizontal = float(np.linalg.norm(points[0] - points[3]))
        if horizontal <= 0:
            continue
        vertical = float(np.linalg.norm(points[1] - points[5]) + np.linalg.norm(points[2] - points[4]))
        ratios.append(vertical / (2.0 * horizontal))
    return sum(ratios) / len(ratios) if ratios else None


def _natural_blink_target(
    base,
    base_box: tuple[int, int, int, int],
    base_index: int,
    image_paths: Sequence[Path],
    coordinates: Sequence[object],
) -> tuple[object | None, int | None]:
    import cv2
    import numpy as np

    base_openness = _eye_openness(base, base_box)
    if base_openness is None:
        return None, None
    # A blink lasts only a handful of frames. Sampling around 360 candidates
    # keeps preparation bounded while making it very unlikely that a normal
    # guided recording's natural blink is skipped entirely.
    step = max(1, len(image_paths) // 360)
    candidates: list[tuple[float, int, object, tuple[int, int, int, int]]] = []
    for index in range(0, len(image_paths), step):
        if index == base_index:
            continue
        image = cv2.imread(os.fspath(image_paths[index]), cv2.IMREAD_COLOR)
        if image is None or image.shape != base.shape:
            continue
        box = _valid_box(
            coordinates[index] if index < len(coordinates) else None,
            image.shape[1],
            image.shape[0],
        )
        if box is None:
            continue
        openness = _eye_openness(image, box)
        if openness is not None:
            candidates.append((openness, index, image, box))
    if not candidates:
        return None, None
    openness, index, closed, closed_box = min(candidates, key=lambda item: item[0])
    # Reject a merely different gaze. A real blink must be materially more
    # closed than the selected neutral frame.
    if openness >= min(0.22, base_openness * 0.72):
        return None, None

    bx0, by0, bx1, by1 = base_box
    cx0, cy0, cx1, cy1 = closed_box
    scale_x = (bx1 - bx0) / max(1.0, cx1 - cx0)
    scale_y = (by1 - by0) / max(1.0, cy1 - cy0)
    matrix = np.asarray(
        [[scale_x, 0.0, bx0 - cx0 * scale_x], [0.0, scale_y, by0 - cy0 * scale_y]],
        dtype=np.float32,
    )
    aligned = cv2.warpAffine(
        closed,
        matrix,
        (base.shape[1], base.shape[0]),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101,
    )
    face_width, face_height = bx1 - bx0, by1 - by0
    mask = np.zeros(base.shape[:2], dtype=np.float32)
    centre = (bx0 + face_width // 2, by0 + round(face_height * 0.36))
    axes = (max(2, round(face_width * 0.43)), max(2, round(face_height * 0.17)))
    cv2.ellipse(mask, centre, axes, 0, 0, 360, 1.0, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=max(2.0, face_width * 0.035))[..., None]
    target = aligned.astype(np.float32) * mask + base.astype(np.float32) * (1.0 - mask)
    return np.clip(target, 0, 255).astype(np.uint8), index


def _blink_frame(image, natural_target, amount: float):
    import cv2

    if natural_target is None or amount <= 0:
        return image
    return cv2.addWeighted(image, 1.0 - amount, natural_target, amount, 0.0)


def generate_procedural_idle(
    full_images: Path,
    coordinates_path: Path,
    output_dir: Path,
    avatar_id: str,
    *,
    seconds: float = 12.0,
    fps: int = 25,
) -> dict:
    """Generate a subtle fallback idle loop from the baked avatar frames.

    This never replaces a real passive scan. It is used only when no idle
    recording was supplied, and any failure is handled by the caller's
    established full-frame copy fallback.
    """

    import cv2

    image_paths = sorted(full_images.glob("*.png"))
    if not image_paths:
        raise ValueError("avatar has no full images")
    with coordinates_path.open("rb") as source:
        coordinates = pickle.load(source)  # internally generated MuseTalk metadata
    if not isinstance(coordinates, list):
        raise ValueError("avatar coordinates are invalid")
    base, box, source_index = _neutral_frame(image_paths, coordinates)
    blink_target, blink_source_index = _natural_blink_target(
        base,
        box,
        source_index,
        image_paths,
        coordinates,
    )
    blink_mode = "natural"
    if blink_target is None:
        # Some guided scans contain no usable closed-eye source frame. The old
        # fallback silently produced an avatar that never blinked at all. Keep
        # the natural-source path when available, but synthesize an eye-only
        # target from the selected neutral frame as a deterministic last resort.
        blink_target = apply_synthetic_blink(base, box, 1.0)
        blink_mode = "synthetic"
    height, width = base.shape[:2]
    frame_count = max(1, round(seconds * fps))
    curve = motion_samples(frame_count, fps, avatar_id)

    output_dir.mkdir(parents=True, exist_ok=True)
    for stale in output_dir.glob("*.png"):
        stale.unlink()
    centre = (width / 2.0, height / 2.0)
    for index, sample in enumerate(curve):
        blinked = _blink_frame(base, blink_target, sample.blink)
        matrix = cv2.getRotationMatrix2D(centre, sample.rotation_degrees, sample.scale)
        matrix[0, 2] += sample.translate_x
        matrix[1, 2] += sample.translate_y
        rendered = cv2.warpAffine(
            blinked,
            matrix,
            (width, height),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT_101,
        )
        destination = output_dir / f"{index:08d}.png"
        if not cv2.imwrite(os.fspath(destination), rendered):
            raise OSError(f"could not write {destination}")

    metadata = {
        "version": 3,
        "generator": "bounded-ou-breath-varied-blink-fallback",
        "frames": frame_count,
        "fps": fps,
        "source_frame_index": source_index,
        "natural_blink_source_index": blink_source_index,
        "blink_mode": blink_mode,
        "source_dimensions": [width, height],
        "motion_bounds": {
            "translate_x": 2.8,
            "translate_y": 1.8,
            "rotation_degrees": 0.32,
            "scale_delta": 0.0025,
        },
        "preview": [asdict(sample) for sample in curve[:3]],
    }
    temporary = output_dir / "procedural_idle.json.tmp"
    destination = output_dir / "procedural_idle.json"
    temporary.write_text(json.dumps(metadata, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, destination)
    return metadata
