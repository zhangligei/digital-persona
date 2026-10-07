# Anime avatar latency demo

Open `/demo` after starting the ECHO app:

```bash
npm run dev
```

The page is a deliberately lightweight proof-of-concept for the cloud
conversation latency ceiling. It uses an original transparent anime avatar,
client-side mouth/head motion and browser speech output, so the visual layer
does not wait for video generation. The timeline reports text-response,
first-audio, first-frame and utterance-complete timings.

When `OPENAI_API_KEY` is present, set `ECHO_DEMO_ENABLED=true` and the demo
route uses one direct Responses API call with a short spoken-companion prompt.
Without that configuration it uses a deterministic local fallback and labels
the mode in the UI. This keeps the page recordable without exposing an API key
or pretending that a local fallback is a cloud-model measurement.

The demo is intentionally separate from the production persona and LiveTalking
routes. It answers the first experiment question — how quickly a simple anime
character can respond — before adding RAG, multi-agent orchestration, voice
cloning or full video rendering.
