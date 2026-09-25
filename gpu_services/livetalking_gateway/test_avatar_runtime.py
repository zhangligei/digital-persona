from __future__ import annotations

import unittest
import importlib.util

import numpy as np

from gpu_services.livetalking_gateway.avatar_runtime import (
    NaturalBlinkScheduler,
    apply_synthetic_blink,
    audio_frame_type,
)


class AudioFrameTypeTests(unittest.TestCase):
    def test_silence_is_not_sent_to_mouth_inference(self) -> None:
        self.assertEqual(audio_frame_type(np.zeros(320, dtype=np.float32)), 1)
        self.assertEqual(audio_frame_type(np.full(320, 0.0004, dtype=np.float32)), 1)

    def test_real_speech_and_short_transients_remain_speaking(self) -> None:
        speech = np.sin(np.linspace(0, 8 * np.pi, 320, dtype=np.float32)) * 0.04
        self.assertEqual(audio_frame_type(speech), 0)
        transient = np.zeros(320, dtype=np.float32)
        transient[160] = 0.01
        self.assertEqual(audio_frame_type(transient), 0)

    def test_invalid_samples_degrade_to_silence(self) -> None:
        self.assertEqual(audio_frame_type(np.asarray([], dtype=np.float32)), 1)
        self.assertEqual(audio_frame_type(np.asarray([np.nan, np.inf], dtype=np.float32)), 1)


class NaturalBlinkSchedulerTests(unittest.TestCase):
    def test_schedule_is_deterministic_bounded_and_non_periodic(self) -> None:
        first = NaturalBlinkScheduler("persona_example", fps=25)
        second = NaturalBlinkScheduler("persona_example", fps=25)
        first_curve = [first.next_amount() for _ in range(25 * 60)]
        second_curve = [second.next_amount() for _ in range(25 * 60)]
        self.assertEqual(first_curve, second_curve)
        self.assertTrue(all(0.0 <= value <= 1.0 for value in first_curve))

        starts: list[int] = []
        in_blink = False
        for index, value in enumerate(first_curve):
            if value > 0 and not in_blink:
                starts.append(index)
                in_blink = True
            elif value == 0:
                in_blink = False
        self.assertGreaterEqual(len(starts), 10)
        intervals = [later - earlier for earlier, later in zip(starts, starts[1:])]
        self.assertGreaterEqual(len(set(intervals)), 6)

    def test_first_blink_is_visible_early_in_a_demo_session(self) -> None:
        scheduler = NaturalBlinkScheduler("persona_demo", fps=25)
        curve = [scheduler.next_amount() for _ in range(25 * 4)]
        self.assertTrue(any(value > 0 for value in curve))


class SyntheticBlinkTests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec("cv2"), "OpenCV is not installed in the lightweight local test runtime")
    def test_blink_only_changes_the_eye_band(self) -> None:
        import cv2

        frame = np.full((220, 220, 3), (170, 185, 205), dtype=np.uint8)
        box = (30, 20, 190, 200)
        cv2.ellipse(frame, (84, 83), (22, 9), 0, 0, 360, (35, 30, 28), -1)
        cv2.ellipse(frame, (136, 83), (22, 9), 0, 0, 360, (35, 30, 28), -1)
        cv2.ellipse(frame, (110, 155), (25, 8), 0, 0, 180, (60, 55, 50), 2)

        blinked = apply_synthetic_blink(frame, box, 1.0)
        difference = np.max(np.abs(blinked.astype(np.int16) - frame.astype(np.int16)), axis=2)
        eye_difference = int(np.count_nonzero(difference[55:115, 40:180]))
        mouth_difference = int(np.count_nonzero(difference[130:185, 65:155]))
        self.assertGreater(eye_difference, 500)
        self.assertEqual(mouth_difference, 0)

    @unittest.skipUnless(importlib.util.find_spec("cv2"), "OpenCV is not installed in the lightweight local test runtime")
    def test_zero_amount_and_invalid_box_are_noops(self) -> None:
        frame = np.full((80, 80, 3), 128, dtype=np.uint8)
        self.assertIs(apply_synthetic_blink(frame, (10, 10, 70, 70), 0.0), frame)
        self.assertTrue(np.array_equal(apply_synthetic_blink(frame, (0, 0, 1, 1), 1.0), frame))


if __name__ == "__main__":
    unittest.main()
