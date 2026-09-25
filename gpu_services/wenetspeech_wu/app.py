from __future__ import annotations

import argparse
import asyncio
import logging
import math
import os
import sys
import tempfile
import threading
import time
from contextlib import nullcontext
from pathlib import Path

import torch
import torchaudio
import yaml
import soundfile as sf
from aiohttp import web

from selection import TranscriptCandidate, choose_transcript


logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
LOGGER = logging.getLogger("wenetspeech-wu")

SERVICE_DIR = Path(__file__).resolve().parent
WENET_REPO = Path(os.environ.get("WENET_REPO", SERVICE_DIR / "wenet")).resolve()
MODEL_DIR = Path(os.environ.get("WENETSPEECH_WU_MODEL_DIR", SERVICE_DIR / "model"))
CONFIG_PATH = MODEL_DIR / "train.yaml"
CHECKPOINT_PATH = MODEL_DIR / "u2++.pt"
DICTIONARY_PATH = MODEL_DIR / "dict" / "lang_char.txt"
DEVICE = os.environ.get("WENETSPEECH_WU_DEVICE", "cuda")
DTYPE = os.environ.get("WENETSPEECH_WU_DTYPE", "fp32").lower()
MAX_AUDIO_BYTES = int(os.environ.get("WENETSPEECH_WU_MAX_AUDIO_BYTES", str(20 * 1024 * 1024)))
ALLOWED_ROOTS = tuple(
    Path(root).resolve()
    for root in os.environ.get(
        "WENETSPEECH_WU_ALLOWED_ROOTS",
        "/tmp,/data/echodigitalpersona/runtime/jobs",
    ).split(",")
    if root.strip()
)

for required_path in (WENET_REPO, CONFIG_PATH, CHECKPOINT_PATH, DICTIONARY_PATH):
    if not required_path.exists():
        raise RuntimeError(f"Required WenetSpeech-Wu path is missing: {required_path}")

sys.path.insert(0, str(WENET_REPO))
from wenet.utils.init_model import init_model  # noqa: E402
from wenet.utils.init_tokenizer import init_tokenizer  # noqa: E402


def _load_runtime():
    with CONFIG_PATH.open("r", encoding="utf-8") as config_file:
        configs = yaml.safe_load(config_file)
    configs["tokenizer_conf"]["symbol_table_path"] = str(DICTIONARY_PATH)
    configs["tokenizer_conf"]["non_lang_syms_path"] = None
    tokenizer = init_tokenizer(configs)
    # ASLP-lab's published inference YAML omits the two dimensions that
    # WeNet's training entrypoint normally derives before saving a runtime
    # config. Recover them from the checkpoint's own feature/vocabulary files.
    configs.setdefault(
        "input_dim",
        int(configs["dataset_conf"].get("fbank_conf", {}).get("num_mel_bins", 80)),
    )
    configs.setdefault("output_dim", tokenizer.vocab_size())
    args = argparse.Namespace(
        checkpoint=str(CHECKPOINT_PATH),
        jit=False,
        use_lora=False,
        lora_ckpt_path=None,
    )
    model, _ = init_model(args, configs)
    model = model.to(torch.device(DEVICE)).eval()
    LOGGER.info("Loaded Conformer-U2pp-Wu from %s on %s (%s)", CHECKPOINT_PATH, DEVICE, DTYPE)
    return model, tokenizer


MODEL, TOKENIZER = _load_runtime()
INFERENCE_LOCK = threading.Lock()


def _is_allowed_audio_path(candidate: Path) -> bool:
    return any(candidate == root or root in candidate.parents for root in ALLOWED_ROOTS)


def _validate_audio_path(raw_path: str) -> Path:
    candidate = Path(raw_path).resolve(strict=True)
    if not _is_allowed_audio_path(candidate):
        raise ValueError("audio path is outside the disposable job roots")
    if not candidate.is_file() or candidate.suffix.lower() != ".wav":
        raise ValueError("audio path must reference a WAV file")
    if candidate.stat().st_size <= 0 or candidate.stat().st_size > MAX_AUDIO_BYTES:
        raise ValueError("audio file is empty or exceeds the service limit")
    return candidate


def _features(audio_path: Path) -> tuple[torch.Tensor, torch.Tensor, float]:
    # torchaudio 2.9 delegates file loading to the optional TorchCodec
    # package. The Wu boundary accepts canonical WAV only, so SoundFile is a
    # smaller and more stable decoder and leaves torchaudio responsible only
    # for resampling and Kaldi features.
    samples, sample_rate = sf.read(str(audio_path), dtype="float32", always_2d=True)
    waveform = torch.from_numpy(samples.T.copy())
    if waveform.numel() == 0:
        raise ValueError("audio contains no samples")
    waveform = waveform.mean(dim=0, keepdim=True)
    if sample_rate != 16_000:
        waveform = torchaudio.functional.resample(waveform, sample_rate, 16_000)
    duration_seconds = waveform.shape[1] / 16_000
    if duration_seconds < 0.12:
        raise ValueError("audio is too short to transcribe")
    features = torchaudio.compliance.kaldi.fbank(
        waveform * (1 << 15),
        num_mel_bins=80,
        frame_length=25,
        frame_shift=10,
        dither=0.0,
        energy_floor=0.0,
        sample_frequency=16_000,
        window_type="povey",
    )
    features = features.unsqueeze(0).to(DEVICE)
    lengths = torch.tensor([features.shape[1]], dtype=torch.long, device=DEVICE)
    return features, lengths, duration_seconds


def _autocast_context():
    if not DEVICE.startswith("cuda"):
        return nullcontext()
    if DTYPE == "bf16":
        return torch.autocast(device_type="cuda", dtype=torch.bfloat16)
    if DTYPE == "fp16":
        return torch.autocast(device_type="cuda", dtype=torch.float16)
    return nullcontext()


def _transcribe(audio_path: Path) -> dict[str, object]:
    started = time.perf_counter()
    features, lengths, duration_seconds = _features(audio_path)
    with INFERENCE_LOCK, torch.inference_mode(), _autocast_context():
        results = MODEL.decode(
            ["attention_rescoring"],
            features,
            lengths,
            beam_size=10,
            decoding_chunk_size=-1,
            num_decoding_left_chunks=-1,
            ctc_weight=0.0,
            reverse_weight=0.0,
        )
    hypothesis = results["attention_rescoring"][0]
    text = TOKENIZER.detokenize(hypothesis.tokens)[0].strip()
    confidence = float(hypothesis.confidence)
    if not math.isfinite(confidence):
        confidence = 0.0
    return {
        "text": text,
        "engine": "wenetspeech-wu-conformer-u2pp",
        "language": "wuu",
        "confidence": max(0.0, min(1.0, confidence)),
        "score": float(hypothesis.score),
        "duration_seconds": round(duration_seconds, 3),
        "latency_ms": round((time.perf_counter() - started) * 1000),
    }


def _transcribe_and_select(payload: dict[str, object]) -> dict[str, object]:
    raw_path = payload.get("path")
    if not isinstance(raw_path, str) or not raw_path:
        raise ValueError("path is required")
    raw_fallback = payload.get("fallback")
    fallback_payload = raw_fallback if isinstance(raw_fallback, dict) else {}
    audio_path = _validate_audio_path(raw_path)
    wu_result = _transcribe(audio_path)
    fallback = TranscriptCandidate(
        text=str(fallback_payload.get("text") or ""),
        engine=str(fallback_payload.get("engine") or "faster-whisper"),
        language=str(fallback_payload["language"]) if fallback_payload.get("language") else None,
        language_probability=float(fallback_payload["language_probability"])
        if fallback_payload.get("language_probability") is not None
        else None,
    )
    preference = str(payload.get("preference") or "wu").strip().lower()
    selected = choose_transcript(
        fallback,
        str(wu_result["text"]),
        float(wu_result["confidence"]),
        preference=preference,
    )
    return {
        "text": selected.text,
        "engine": selected.engine,
        "language": selected.language,
        "language_probability": selected.language_probability,
        "confidence": selected.confidence,
        "spoken_variant": selected.spoken_variant,
        "variant_confidence": selected.variant_confidence,
        "wu": wu_result,
    }


async def health(_request: web.Request) -> web.Response:
    return web.json_response({
        "ok": True,
        "engine": "wenetspeech-wu-conformer-u2pp",
        "device": DEVICE,
        "dtype": DTYPE,
    })


async def transcribe_path(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("JSON object is required")
        result = await asyncio.to_thread(_transcribe_and_select, payload)
        return web.json_response(result)
    except (OSError, ValueError) as error:
        return web.json_response({"detail": str(error)}, status=400)
    except Exception:
        LOGGER.exception("WenetSpeech-Wu transcription failed")
        return web.json_response({"detail": "dialect transcription failed"}, status=500)


async def transcribe_upload(request: web.Request) -> web.Response:
    temporary_path: Path | None = None
    try:
        reader = await request.multipart()
        audio_part = None
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == "audio":
                audio_part = part
                break
        if audio_part is None or Path(audio_part.filename or "utterance.wav").suffix.lower() != ".wav":
            raise ValueError("WAV audio is required")
        payload = await audio_part.read(decode=True)
        if not payload or len(payload) > MAX_AUDIO_BYTES:
            raise ValueError("audio is empty or exceeds the service limit")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temporary_file:
            temporary_file.write(payload)
            temporary_path = Path(temporary_file.name)
        result = await asyncio.to_thread(_transcribe, temporary_path)
        return web.json_response(result)
    except (OSError, ValueError) as error:
        return web.json_response({"detail": str(error)}, status=400)
    except Exception:
        LOGGER.exception("WenetSpeech-Wu upload transcription failed")
        return web.json_response({"detail": "dialect transcription failed"}, status=500)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


app = web.Application(client_max_size=MAX_AUDIO_BYTES)
app.add_routes([
    web.get("/health", health),
    web.post("/transcribe-path", transcribe_path),
    web.post("/transcribe", transcribe_upload),
])


if __name__ == "__main__":
    web.run_app(app, host="127.0.0.1", port=int(os.environ.get("WENETSPEECH_WU_PORT", "9890")))
