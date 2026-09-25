from __future__ import annotations

import hashlib
import math
import random
from dataclasses import dataclass
from typing import Sequence

import numpy as np


def audio_frame_type(
    audio_chunk: np.ndarray,
    *,
    peak_threshold: float = 0.0025,
    rms_threshold: float = 0.0008,
) -> int:
    """Classify one 20 ms PCM chunk for LiveTalking's visual renderer.

    LiveTalking uses ``type=0`` to drive mouth inference and ``type=1`` to
    render a neutral frame.  Upstream marks every uploaded/TTS chunk as type
    zero, including encoded trailing silence, which leaves the lips moving
    after the audible utterance has ended.  Reclassify only genuinely quiet
    chunks; the PCM itself is preserved and still reaches the WebRTC audio
    track unchanged.
    """

    samples = np.asarray(audio_chunk, dtype=np.float32).reshape(-1)
    if samples.size == 0:
        return 1
    finite = samples[np.isfinite(samples)]
    if finite.size == 0:
        return 1
    peak = float(np.max(np.abs(finite)))
    rms = float(np.sqrt(np.mean(np.square(finite, dtype=np.float64))))
    return 1 if peak <= peak_threshold and rms <= rms_threshold else 0


def _smoothstep(value: float) -> float:
    bounded = max(0.0, min(1.0, value))
    return bounded * bounded * (3.0 - 2.0 * bounded)


def _blink_envelope(rng: random.Random, *, secondary: bool = False) -> list[float]:
    peak = rng.uniform(0.74, 0.90) if secondary else rng.uniform(0.86, 1.0)
    closing_frames = rng.choice((2, 2, 3))
    opening_frames = rng.choice((3, 4, 4, 5))
    hold_frames = 1 if rng.random() < (0.10 if secondary else 0.22) else 0
    closing = [peak * _smoothstep((index + 1) / closing_frames) for index in range(closing_frames)]
    hold = [peak * rng.uniform(0.965, 1.0) for _ in range(hold_frames)]
    opening = [
        peak * (1.0 - _smoothstep((index + 1) / (opening_frames + 1)))
        for index in range(opening_frames)
    ]
    return closing + hold + opening


def _blink_interval(rng: random.Random) -> float:
    interval = math.exp(rng.gauss(math.log(3.7), 0.34))
    if rng.random() < 0.13:
        interval += rng.uniform(1.0, 2.4)
    return max(2.2, min(7.8, interval))


@dataclass
class NaturalBlinkScheduler:
    """Produce deterministic but non-periodic per-frame blink amplitudes."""

    seed_text: str
    fps: int = 25

    def __post_init__(self) -> None:
        seed = int.from_bytes(hashlib.sha256(self.seed_text.encode("utf-8")).digest()[:8], "big")
        self._rng = random.Random(seed)
        self._frame_index = 0
        # A short first interval makes every newly opened demo session visibly
        # alive without forcing all personas to blink at the same moment.
        self._next_start = max(1, round(self._rng.uniform(1.4, 3.2) * self.fps))
        self._active: list[float] = []
        self._active_index = 0
        self._queued_secondary_at: int | None = None

    def _schedule_next(self) -> None:
        self._next_start = self._frame_index + max(1, round(_blink_interval(self._rng) * self.fps))

    def next_amount(self) -> float:
        amount = 0.0
        if self._active_index < len(self._active):
            amount = self._active[self._active_index]
            self._active_index += 1
            if self._active_index >= len(self._active):
                self._active = []
                self._active_index = 0
        elif self._queued_secondary_at is not None and self._frame_index >= self._queued_secondary_at:
            self._active = _blink_envelope(self._rng, secondary=True)
            self._active_index = 1
            amount = self._active[0]
            self._queued_secondary_at = None
            self._schedule_next()
        elif self._frame_index >= self._next_start:
            self._active = _blink_envelope(self._rng)
            self._active_index = 1
            amount = self._active[0]
            if self._rng.random() < 0.12:
                self._queued_secondary_at = self._frame_index + round(self._rng.uniform(0.32, 0.58) * self.fps)
            else:
                self._schedule_next()
        self._frame_index += 1
        return amount


def _valid_face_box(
    value: Sequence[float] | np.ndarray | None,
    width: int,
    height: int,
) -> tuple[int, int, int, int] | None:
    if value is None or len(value) != 4:
        return None
    try:
        x0, y0, x1, y1 = (int(float(part)) for part in value)
    except (TypeError, ValueError):
        return None
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(width, x1), min(height, y1)
    if x1 - x0 < 32 or y1 - y0 < 32:
        return None
    return x0, y0, x1, y1


def _pinch_eye(roi: np.ndarray) -> np.ndarray:
    """Create a softly closed-eye target without touching the mouth."""

    import cv2

    height, width = roi.shape[:2]
    if height < 8 or width < 8:
        return roi
    centre = int(round(height * 0.55))
    upper_source = max(1, int(round(height * 0.34)))
    lower_source = min(height - 2, int(round(height * 0.72)))

    map_y = np.empty((height, width), dtype=np.float32)
    for row in range(height):
        if row <= centre:
            source_row = (row / max(1, centre)) * upper_source
        else:
            source_row = lower_source + (
                (row - centre) / max(1, height - 1 - centre)
            ) * (height - 1 - lower_source)
        map_y[row, :] = source_row
    map_x = np.tile(np.arange(width, dtype=np.float32), (height, 1))
    target = cv2.remap(
        roi,
        map_x,
        map_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101,
    )

    # The upper/lower skin fields meet at the eyelid. A single curved line,
    # coloured from the person's own eye region, restores the natural crease
    # without painting a generic black stripe.
    mean_colour = np.mean(roi.reshape(-1, roi.shape[2]), axis=0)
    line_colour = tuple(int(max(0, min(255, value * 0.48))) for value in mean_colour)
    cv2.ellipse(
        target,
        (width // 2, centre),
        (max(2, int(width * 0.34)), max(1, int(height * 0.055))),
        0,
        4,
        176,
        line_colour,
        max(1, int(round(height * 0.025))),
        cv2.LINE_AA,
    )
    return target


def apply_synthetic_blink(
    frame: np.ndarray,
    face_box: Sequence[float] | np.ndarray | None,
    amount: float,
) -> np.ndarray:
    """Blend a bounded eye-only blink into one BGR avatar frame."""

    if amount <= 0.0:
        return frame
    import cv2

    height, width = frame.shape[:2]
    box = _valid_face_box(face_box, width, height)
    if box is None:
        return frame
    x0, y0, x1, y1 = box
    face_width, face_height = x1 - x0, y1 - y0
    eye_top = y0 + round(face_height * 0.20)
    eye_bottom = y0 + round(face_height * 0.50)
    eye_regions = (
        (x0 + round(face_width * 0.10), eye_top, x0 + round(face_width * 0.49), eye_bottom),
        (x0 + round(face_width * 0.51), eye_top, x0 + round(face_width * 0.90), eye_bottom),
    )

    result = frame.copy()
    bounded_amount = max(0.0, min(1.0, float(amount)))
    for eye_index, (ex0, ey0, ex1, ey1) in enumerate(eye_regions):
        roi = frame[ey0:ey1, ex0:ex1]
        if roi.size == 0:
            continue
        target = _pinch_eye(roi)
        roi_height, roi_width = roi.shape[:2]
        mask = np.zeros((roi_height, roi_width), dtype=np.float32)
        cv2.ellipse(
            mask,
            (roi_width // 2, roi_height // 2),
            (max(2, int(roi_width * 0.48)), max(2, int(roi_height * 0.46))),
            0,
            0,
            360,
            1.0,
            -1,
        )
        mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=max(1.2, roi_height * 0.055))
        # A few percent of left/right asymmetry avoids the mechanical look of
        # two eyelids moving as pixel-identical mirrors.
        asymmetry = 0.97 if eye_index == 0 else 1.0
        weight = (mask * min(1.0, bounded_amount * asymmetry))[..., None]
        blended = roi.astype(np.float32) * (1.0 - weight) + target.astype(np.float32) * weight
        result[ey0:ey1, ex0:ex1] = np.clip(blended, 0, 255).astype(np.uint8)
    return result
