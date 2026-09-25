#!/usr/bin/env bash
set -euo pipefail

readonly tunnel_unit="${ECHO_DEMO_TUNNEL_UNIT:-echo-demo-tunnel.service}"
readonly origin_file="${ECHO_DEMO_ORIGIN_FILE:-/home/user/echo/runtime/demo-proxy-origin.url}"

current_origin=""
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  tunnel_pid="$(systemctl --user show --property MainPID --value "${tunnel_unit}")"
  if [[ "${tunnel_pid}" =~ ^[1-9][0-9]*$ ]]; then
    current_origin="$(
      journalctl --user "_PID=${tunnel_pid}" -n 200 --no-pager -o cat 2>/dev/null \
        | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' \
        | tail -n 1 \
        || true
    )"
  fi

  if [[ "${current_origin}" =~ ^https://[a-z0-9-]+\.trycloudflare\.com$ ]]; then
    break
  fi
  sleep 5
done

if [[ ! "${current_origin}" =~ ^https://[a-z0-9-]+\.trycloudflare\.com$ ]]; then
  printf 'No Quick Tunnel URL was found for the current %s process.\n' "${tunnel_unit}" >&2
  exit 1
fi

origin_dir="$(dirname "${origin_file}")"
mkdir -p "${origin_dir}"
temporary_file="$(mktemp "${origin_file}.tmp.XXXXXX")"
trap 'rm -f "${temporary_file}"' EXIT
printf '%s\n' "${current_origin}" > "${temporary_file}"
chmod 600 "${temporary_file}"
mv -f "${temporary_file}" "${origin_file}"
trap - EXIT

printf 'ECHO proxy origin discovery file updated: %s\n' "${current_origin}"
