# ECHO stable demo proxy

This small Cloudflare Worker provides a stable `workers.dev` URL for the RTX
3090 demo without requiring access to the student-owned production Worker.
It streams requests and responses to the current TryCloudflare origin, rewrites
same-origin redirects and cookies, and does not store application credentials.

The active origin is stored in the `ORIGIN_CONFIG` KV binding. The non-secret
`ORIGIN_BASE_URL` Wrangler variable is only a fallback. The 3090 host publishes
its latest Quick Tunnel URL in the public LiveTalking health response, and a
Worker cron reads that stable discovery endpoint once per minute. This avoids
the DNS poisoning and TLS blocking that prevents the 3090 host from calling a
`workers.dev` URL directly.

## Operations

```bash
WRANGLER_WRITE_LOGS=false ../../node_modules/.bin/wrangler types --config wrangler.jsonc
WRANGLER_WRITE_LOGS=false ../../node_modules/.bin/wrangler deploy --config wrangler.jsonc
```

Health check: `GET /__echo_proxy_health`.

The files in `3090/` are installed as follows:

- `sync-demo-proxy-origin.sh` ->
  `/home/user/echo/app/scripts/gpu-server/sync-demo-proxy-origin.sh`
- `echo-demo-origin-sync.service` and `.timer` ->
  `/home/user/.config/systemd/user/`
- `origin-sync.conf` ->
  `/home/user/.config/systemd/user/echo-demo-tunnel.service.d/`

The timer refreshes the local discovery file every five minutes. The tunnel
unit drop-in also schedules an immediate refresh after every tunnel start;
installing the drop-in does not require restarting an already-running tunnel.
The Worker then reconciles KV from
`https://livetalking.echodigitalpersona.com/health` every minute.
