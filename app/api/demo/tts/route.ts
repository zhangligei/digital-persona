import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Server-side TTS proxy for the anime latency experiment.
 *
 * The browser only receives the audio stream; the provider key never leaves
 * the server. OpenAI's audio stream is returned directly so the client can
 * start its MediaSource as soon as the first bytes arrive.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, 4_096) : "";
  if (!text) {
    return NextResponse.json({ ok: false, error: "Please provide text." }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const enabled = process.env.ECHO_DEMO_TTS_ENABLED !== "false";
  if (!apiKey || !enabled) {
    return NextResponse.json({ ok: false, error: "Cloud TTS is not configured." }, { status: 503 });
  }

  const baseUrl = process.env.OPENAI_API_BASE_URL?.trim().replace(/\/+$/, "") || "https://api.openai.com";
  const model = process.env.ECHO_TTS_MODEL?.trim() || "gpt-4o-mini-tts";
  const voice = process.env.ECHO_TTS_VOICE?.trim() || "coral";
  try {
    const upstream = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        instructions: "用自然、温和、清晰的普通话说话，像一位耐心的家人陪伴老人。语速略慢，不要播报腔。",
        response_format: "mp3",
        stream_format: "audio",
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ ok: false, error: "Cloud TTS request failed." }, { status: 502 });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
        "Cache-Control": "no-store",
        "X-ECHO-TTS": "cloud-stream",
        "X-ECHO-TTS-MODEL": model,
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Cloud TTS request timed out." }, { status: 504 });
  }
}
