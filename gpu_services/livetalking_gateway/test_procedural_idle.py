from __future__ import annotations

import unittest
import importlib.util

import numpy as np

from gpu_services.livetalking_gateway.procedural_idle import (
    _blink_frame,
    motion_samples,
)


class ProceduralIdleMotionTests(unittest.TestCase):
    def test_motion_is_deterministic_and_bounded(self) -> None:
        first = motion_samples(300, 25, "persona_example")
        second = motion_samples(300, 25, "persona_example")
        self.assertEqual(first, second)
        self.assertTrue(first)
        for sample in first:
            self.assertLessEqual(abs(sample.translate_x), 2.8)
            self.assertLessEqual(abs(sample.translate_y), 2.2)
            self.assertLessEqual(abs(sample.rotation_degrees), 0.32)
            self.assertGreaterEqual(sample.scale, 0.9975)
            self.assertLessEqual(sample.scale, 1.0025)
            self.assertGreaterEqual(sample.blink, 0.0)
            self.assertLessEqual(sample.blink, 1.0)

    def test_blinks_are_present_but_not_continuous(self) -> None:
        samples = motion_samples(25 * 20, 25, "persona_blinks")
        blink_frames = [index for index, sample in enumerate(samples) if sample.blink > 0]
        self.assertGreaterEqual(len(blink_frames), 10)
        self.assertLess(len(blink_frames), len(samples) // 5)

    def test_blinks_vary_in_timing_duration_and_depth(self) -> None:
        samples = motion_samples(25 * 60, 25, "persona_varied_blinks")
        events: list[list[float]] = []
        current: list[float] = []
        starts: list[int] = []
        for index, sample in enumerate(samples):
            if sample.blink > 0:
                if not current:
                    starts.append(index)
                current.append(sample.blink)
            elif current:
                events.append(current)
                current = []
        if current:
            events.append(current)

        self.assertGreaterEqual(len(events), 10)
        self.assertGreaterEqual(len({len(event) for event in events}), 3)
        self.assertGreaterEqual(len({round(max(event), 3) for event in events}), 5)
        intervals = [later - earlier for earlier, later in zip(starts, starts[1:])]
        self.assertGreaterEqual(len(set(intervals)), 6)

    def test_blink_curve_is_asymmetric_and_eases_open(self) -> None:
        samples = motion_samples(25 * 20, 25, "persona_asymmetric_blinks")
        event: list[float] = []
        for sample in samples:
            if sample.blink > 0:
                event.append(sample.blink)
            elif event:
                break
        self.assertGreaterEqual(len(event), 5)
        peak_index = event.index(max(event))
        self.assertGreaterEqual(peak_index, 1)
        self.assertGreater(len(event) - peak_index - 1, 1)
        self.assertGreater(event[-1], 0.0)
        self.assertLess(event[-1], event[-2])

    def test_invalid_dimensions_return_no_samples(self) -> None:
        self.assertEqual(motion_samples(0, 25, "x"), [])
        self.assertEqual(motion_samples(10, 0, "x"), [])

    @unittest.skipUnless(importlib.util.find_spec("cv2"), "OpenCV is not installed in the lightweight local test runtime")
    def test_synthetic_target_can_drive_blink_when_scan_has_no_closed_frame(self) -> None:
        base = np.full((40, 40, 3), 180, dtype=np.uint8)
        target = base.copy()
        target[10:20] = 40
        rendered = _blink_frame(base, target, 0.75)
        self.assertFalse(np.array_equal(rendered, base))
        self.assertGreater(float(np.mean(base[10:20])), float(np.mean(rendered[10:20])))


if __name__ == "__main__":
    unittest.main()
