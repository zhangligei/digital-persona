#!/usr/bin/env bash
set -euo pipefail

echo_root="${ECHO_ROOT:-/home/user/echo}"
service_root="${LIVETALKING_SERVICE_ROOT:-${echo_root}/services/livetalking}"
python_bin="${LIVETALKING_PYTHON:-${echo_root}/envs/livetalking/bin/python}"

secret_file="${ECHO_LIVETALKING_SECRET_FILE:-${echo_root}/secrets/livetalking.env}"
if [[ -r "${secret_file}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${secret_file}"
  set +a
fi

default_avatar="${ECHO_DEFAULT_AVATAR_ID:-persona_cmsjqcvp60002psp73uk39ks9}"
default_ref="${ECHO_DEFAULT_VOICE_REF:-${service_root}/data/voice_refs/cmsjqcvp60002psp73uk39ks9.wav}"
max_sessions="${ECHO_MAX_LIVE_SESSIONS:-2}"

if [[ ! -d "${service_root}/data/avatars/${default_avatar}" ]]; then
  echo "Default avatar package is missing: ${default_avatar}" >&2
  exit 1
fi
if [[ ! -f "${default_ref}" ]]; then
  echo "Default voice reference is missing: ${default_ref}" >&2
  exit 1
fi

export CUDA_VISIBLE_DEVICES="${LIVETALKING_CUDA_DEVICE:-0}"
export PATH="${echo_root}/envs/livetalking/bin:${PATH}"
export PYTHONPATH="${echo_root}/app:${service_root}:${PYTHONPATH:-}"

cd "${service_root}"
exec "${python_bin}" app.py \
  --config '' \
  --transport webrtc \
  --model musetalk \
  --avatar_id "${default_avatar}" \
  --batch_size "${ECHO_MUSETALK_BATCH_SIZE:-8}" \
  --tts cosyvoice \
  --REF_FILE "${default_ref}" \
  --REF_TEXT "${ECHO_DEFAULT_VOICE_TEXT:-Reference voice for ECHO.}" \
  --TTS_SERVER "${COSYVOICE_SERVER_URL:-http://127.0.0.1:9880}" \
  --max_session "${max_sessions}" \
  --listenport "${LIVETALKING_UPSTREAM_PORT:-8011}" \
  --stun "${LIVETALKING_STUN_URL:-stun:stun.cloudflare.com:3478}"
