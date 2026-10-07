# Anime avatar latency demo

Open `/demo` after starting the ECHO app:

```bash
npm run dev
```

The page is a deliberately lightweight proof-of-concept for the cloud
conversation latency ceiling. It uses an original transparent anime avatar
and CSS mouth/head motion, so the visual layer does not wait for video
generation. The timeline reports text-response, first-audio, first-frame and
utterance-complete timings.

When `OPENAI_API_KEY` is present, set `ECHO_DEMO_ENABLED=true` and the demo
route uses one direct Responses API call with a short spoken-companion prompt.
The reply is then sent to `/api/demo/tts`, a server-only proxy for the cloud
speech endpoint. The proxy returns the provider's streamed MP3 response and
the browser feeds it into `MediaSource` so playback can begin before the
entire file has arrived. `ECHO_TTS_MODEL` and `ECHO_TTS_VOICE` are optional.

If the key is absent, invalid, or the provider is unavailable, the page falls
back to browser speech and marks that mode explicitly. This keeps the page
recordable without exposing an API key or presenting a local fallback as a
cloud measurement.

The demo is intentionally separate from the production persona and LiveTalking
routes. It answers the first experiment question — how quickly a simple anime
character can respond — before adding RAG, multi-agent orchestration, voice
cloning or full video rendering.

The mouth overlay is placed over the mouth already present in the source
illustration. It stays transparent while idle, which avoids the old “two
mouths” artifact, and only opens at the same coordinates while audio is
playing.
