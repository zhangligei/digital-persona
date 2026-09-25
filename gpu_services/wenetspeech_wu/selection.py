from __future__ import annotations

import math
import re
from dataclasses import dataclass


_HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_LATIN_RE = re.compile(r"[A-Za-z]")
_WENET_ENGINE = "wenetspeech-wu-conformer-u2pp"

# Lexical evidence is intentionally conservative. WenetSpeech-Wu can decode
# ordinary Mandarin too, so a Chinese decode alone is not proof of Wu speech.
# Shanghai markers are kept separate from broader Jiangnan Wu vocabulary so
# the response controller can choose the requested regional variety.
_SHANGHAI_MARKERS = (
    "阿拉", "侬", "伊拉", "伊", "勿要", "勿", "勒浪", "勒海", "辣海",
    "哪能", "白相", "交关", "辰光", "爷叔", "老早", "今朝", "屋里向", "浪向",
)
_WU_MARKERS = (
    "伲", "倷", "覅", "弗", "呒没", "呒", "朆", "陆里", "该搭",
    "格末", "介许", "个咾", "蛮好个", "吃生活",
)
_VERY_STRONG_SHANGHAI = ("阿拉", "侬", "勒浪", "勒海", "辣海", "哪能")
_VERY_STRONG_WU = ("伲", "倷", "覅", "呒没", "陆里")


@dataclass(frozen=True)
class TranscriptCandidate:
    text: str
    engine: str
    language: str | None = None
    language_probability: float | None = None
    confidence: float | None = None
    spoken_variant: str | None = None
    variant_confidence: float | None = None


def _bounded_probability(value: float | None) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return max(0.0, min(1.0, value))


def han_ratio(text: str) -> float:
    visible = [character for character in text if not character.isspace()]
    if not visible:
        return 0.0
    return sum(bool(_HAN_RE.fullmatch(character)) for character in visible) / len(visible)


def latin_ratio(text: str) -> float:
    visible = [character for character in text if not character.isspace()]
    if not visible:
        return 0.0
    return sum(bool(_LATIN_RE.fullmatch(character)) for character in visible) / len(visible)


def _marker_score(text: str, markers: tuple[str, ...]) -> int:
    return sum(text.count(marker) for marker in markers)


def dialect_variant(text: str) -> tuple[str | None, float]:
    """Return a dialect variety only when lexical evidence is explicit."""

    shanghai_score = _marker_score(text, _SHANGHAI_MARKERS)
    wu_score = _marker_score(text, _WU_MARKERS)
    if any(marker in text for marker in _VERY_STRONG_SHANGHAI) or shanghai_score >= 2:
        return "shanghainese", min(0.98, 0.78 + 0.06 * max(1, shanghai_score))
    if any(marker in text for marker in _VERY_STRONG_WU) or wu_score >= 2:
        return "wu", min(0.96, 0.74 + 0.06 * max(1, wu_score))
    return None, 0.0


def choose_auto_transcript(
    fallback: TranscriptCandidate,
    wu_text: str,
    wu_confidence: float | None,
) -> TranscriptCandidate:
    """Route English, Mandarin, Shanghai and other Wu conservatively."""

    fallback_text = fallback.text.strip()
    dialect_text = wu_text.strip()
    language = (fallback.language or "").lower()
    language_probability = _bounded_probability(fallback.language_probability)
    confidence = _bounded_probability(wu_confidence)

    if (
        language == "en"
        and (language_probability or 0.0) >= 0.82
        and latin_ratio(fallback_text) >= 0.55
    ):
        return TranscriptCandidate(
            fallback_text,
            fallback.engine,
            fallback.language,
            language_probability,
            fallback.confidence,
            "english",
            language_probability,
        )

    dialect_usable = (
        bool(dialect_text)
        and han_ratio(dialect_text) >= 0.45
        and (confidence is None or confidence >= 0.35)
    )
    if dialect_usable:
        variant, lexical_confidence = dialect_variant(dialect_text)
        if variant is not None:
            acoustic_confidence = confidence if confidence is not None else 0.55
            return TranscriptCandidate(
                dialect_text,
                _WENET_ENGINE,
                "wuu",
                None,
                confidence,
                variant,
                min(0.99, lexical_confidence * 0.72 + acoustic_confidence * 0.28),
            )

    fallback_looks_chinese = han_ratio(fallback_text) >= 0.30
    chinese_language = language in {"zh", "yue", "wuu", "cmn"}
    if fallback_looks_chinese or chinese_language:
        return TranscriptCandidate(
            fallback_text,
            fallback.engine,
            fallback.language,
            language_probability,
            fallback.confidence,
            "mandarin",
            language_probability if language_probability is not None else 0.60,
        )

    if language == "en" or latin_ratio(fallback_text) >= 0.55:
        return TranscriptCandidate(
            fallback_text,
            fallback.engine,
            fallback.language,
            language_probability,
            fallback.confidence,
            "english",
            language_probability if language_probability is not None else 0.55,
        )
    return TranscriptCandidate(
        fallback_text,
        fallback.engine,
        fallback.language,
        language_probability,
        fallback.confidence,
        "mandarin",
        0.45,
    )


def choose_transcript(
    fallback: TranscriptCandidate,
    wu_text: str,
    wu_confidence: float | None,
    preference: str = "wu",
) -> TranscriptCandidate:
    """Choose Wu ASR only when the acoustic/language evidence supports it.

    FastWhisper remains authoritative for confidently non-Chinese speech.
    WenetSpeech-Wu is preferred for Chinese/Wu speech and can recover a Wu
    utterance that Whisper classified uncertainly. Cross-model raw decode
    scores are intentionally not compared; only WeNet's normalized confidence
    and language/script evidence are used.
    """

    if preference == "auto":
        return choose_auto_transcript(fallback, wu_text, wu_confidence)

    fallback_text = fallback.text.strip()
    dialect_text = wu_text.strip()
    confidence = _bounded_probability(wu_confidence)
    if not dialect_text or han_ratio(dialect_text) < 0.45:
        return TranscriptCandidate(
            fallback_text,
            fallback.engine,
            fallback.language,
            _bounded_probability(fallback.language_probability),
            fallback.confidence,
            "english" if (fallback.language or "").lower() == "en" else None,
            _bounded_probability(fallback.language_probability),
        )

    language = (fallback.language or "").lower()
    language_probability = _bounded_probability(fallback.language_probability)
    fallback_looks_chinese = han_ratio(fallback_text) >= 0.30
    chinese_language = language in {"zh", "yue", "wuu", "cmn"}
    whisper_is_uncertain = language_probability is None or language_probability < 0.82
    wu_is_usable = confidence is None or confidence >= 0.35
    wu_is_strong = confidence is not None and confidence >= 0.62

    if wu_is_usable and (chinese_language or fallback_looks_chinese):
        variant, variant_confidence = dialect_variant(dialect_text)
        return TranscriptCandidate(
            dialect_text,
            _WENET_ENGINE,
            "wuu",
            None,
            confidence,
            variant or "wu",
            variant_confidence or confidence,
        )
    if wu_is_strong and (not fallback_text or whisper_is_uncertain):
        variant, variant_confidence = dialect_variant(dialect_text)
        return TranscriptCandidate(
            dialect_text,
            _WENET_ENGINE,
            "wuu",
            None,
            confidence,
            variant or "wu",
            variant_confidence or confidence,
        )
    return TranscriptCandidate(
        fallback_text,
        fallback.engine,
        fallback.language,
        language_probability,
        fallback.confidence,
        "english" if (fallback.language or "").lower() == "en" else None,
        language_probability,
    )
