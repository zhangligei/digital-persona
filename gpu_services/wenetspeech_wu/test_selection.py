import unittest

from gpu_services.wenetspeech_wu.selection import (
    TranscriptCandidate,
    choose_auto_transcript,
    choose_transcript,
)


class TranscriptSelectionTests(unittest.TestCase):
    def test_prefers_wu_for_chinese_whisper_result(self):
        selected = choose_transcript(
            TranscriptCandidate("我不知道", "faster-whisper", "zh", 0.98),
            "阿拉勿晓得",
            0.71,
        )
        self.assertEqual(selected.engine, "wenetspeech-wu-conformer-u2pp")
        self.assertEqual(selected.text, "阿拉勿晓得")

    def test_recovers_wu_when_whisper_language_is_uncertain(self):
        selected = choose_transcript(
            TranscriptCandidate("", "faster-whisper", "en", 0.51),
            "侬今朝到啥地方去",
            0.78,
        )
        self.assertEqual(selected.language, "wuu")

    def test_keeps_confident_english(self):
        selected = choose_transcript(
            TranscriptCandidate("How are you today?", "faster-whisper", "en", 0.99),
            "好啊有台",
            0.80,
        )
        self.assertEqual(selected.engine, "faster-whisper")
        self.assertEqual(selected.text, "How are you today?")

    def test_rejects_non_han_wu_hypothesis(self):
        selected = choose_transcript(
            TranscriptCandidate("hello", "faster-whisper", "en", 0.60),
            "hello",
            0.95,
        )
        self.assertEqual(selected.engine, "faster-whisper")

    def test_auto_routes_explicit_shanghai_markers(self):
        selected = choose_auto_transcript(
            TranscriptCandidate("你今天到什么地方去", "faster-whisper", "zh", 0.97),
            "侬今朝到啥地方去白相",
            0.76,
        )
        self.assertEqual(selected.spoken_variant, "shanghainese")
        self.assertEqual(selected.text, "侬今朝到啥地方去白相")
        self.assertGreater(selected.variant_confidence or 0, 0.70)

    def test_auto_recovers_shanghai_when_whisper_is_uncertain(self):
        selected = choose_auto_transcript(
            TranscriptCandidate("今早礼拜六我准备打扫卫生", "faster-whisper", "zh", 0.72),
            "今朝是礼拜六我准备辣屋里向打扫卫生",
            0.89,
        )
        self.assertEqual(selected.spoken_variant, "shanghainese")
        self.assertEqual(selected.engine, "wenetspeech-wu-conformer-u2pp")

    def test_auto_routes_broader_wu_markers_without_calling_it_shanghai(self):
        selected = choose_auto_transcript(
            TranscriptCandidate("我们今天到哪里去", "faster-whisper", "zh", 0.94),
            "伲今朝到陆里去",
            0.72,
        )
        self.assertEqual(selected.spoken_variant, "wu")
        self.assertEqual(selected.engine, "wenetspeech-wu-conformer-u2pp")

    def test_auto_keeps_mandarin_when_wu_decoder_has_no_dialect_evidence(self):
        selected = choose_auto_transcript(
            TranscriptCandidate("我们今天去公园散步", "faster-whisper", "zh", 0.98),
            "我们今天去公园散步",
            0.88,
        )
        self.assertEqual(selected.spoken_variant, "mandarin")
        self.assertEqual(selected.engine, "faster-whisper")

    def test_auto_keeps_confident_english_before_wu_hypothesis(self):
        selected = choose_auto_transcript(
            TranscriptCandidate("How are you today?", "faster-whisper", "en", 0.99),
            "好啊有台",
            0.91,
        )
        self.assertEqual(selected.spoken_variant, "english")
        self.assertEqual(selected.text, "How are you today?")


if __name__ == "__main__":
    unittest.main()
