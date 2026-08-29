# ECHO LiveTalking gateway

This localhost service restores the authenticated API boundary that the web
application expects without mixing ECHO account/media concerns into the
upstream LiveTalking checkout. It listens on port `8010`, validates the same
short-lived HMAC bearer token minted by the Cloudflare application, and:

- proxies WebRTC signaling and live-speech calls to LiveTalking on `8011`;
- streams private persona media from the application's authenticated R2 route;
- normalizes browser camera media to H.264 MP4 and voice references to 16 kHz WAV;
- runs one durable avatar-preparation job at a time and exposes truthful task
  status/readiness endpoints;
- proxies STT and agentic-memory calls to separately restartable services.

Runtime media, task state, model weights, and secrets live under
`/home/user/echo/runtime`, `/home/user/echo/models`, and
`/home/user/echo/secrets`; none belong in Git.

Install `requirements.txt` into the isolated LiveTalking environment. Avatar
preparation imports MuseTalk's landmark pipeline, so `face-recognition` (and
its compiled `dlib` dependency) is required even though the HTTP gateway itself
only imports `aiohttp`. The host also needs `ffmpeg`/`ffprobe` on the gateway's
`PATH` for camera-media and voice-reference normalization.

The MuseTalk checkout expects these runtime-only model directories through its
`models` symlink: `musetalkV15`, `sd-vae`, `whisper`, and
`face-parse-bisent`. The last directory must contain both `79999_iter.pth`
and the official PyTorch `resnet18-5c106cde.pth`; missing either file causes
avatar preparation to fail after landmark extraction rather than producing a
usable partial package.

The gateway and LiveTalking launchers source
`${ECHO_ROOT}/secrets/livetalking.env`. Keep that file at mode `0600` and
never commit it. For public WebRTC sessions it supplies
`LIVETALKING_SESSION_SECRET`, `TURN_SERVER_URL`, `TURN_USERNAME`, and
`TURN_CREDENTIAL`. LiveTalking retains STUN/direct candidates and adds the
authenticated TURN relay; the browser receives the same relay configuration
from the Worker.

When a persona has no separate passive scan, avatar preparation can create a
twelve-second deterministic procedural idle loop from a neutral baked frame.
The fallback combines bounded mean-reverting head drift, subtle breathing and
long-tailed blink timing. Every blink varies its depth and close/open cadence,
and an occasional softer double blink prevents the loop from looking like one
repeated action. It never replaces a supplied passive scan, runs only during
preparation, consumes no persistent GPU memory and fails open to the
established full-frame fallback. Set
`ECHO_PROCEDURAL_IDLE_ENABLED=0` to disable it.
