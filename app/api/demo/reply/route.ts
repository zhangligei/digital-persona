import { NextResponse } from "next/server";

const DEFAULT_REPLY = "我听到了。我们慢慢聊，今天有什么想和我分享的吗？";

function fallbackReply(input: string): string {
  if (/(想念|想你|子女|孩子|家人)/i.test(input)) {
    return "我在这里陪你。你想聊聊孩子，还是说说今天发生的事情？";
  }
  if (/(天气|出去|散步|活动)/i.test(input)) {
    return "听起来很适合慢慢走一走。别着急，按照自己的节奏来就好。";
  }
  if (/(你好|嗨|在吗)/i.test(input)) {
    return "你好呀，我在这里。你今天过得怎么样？";
  }
  return DEFAULT_REPLY;
}

function responseText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = body as { output_text?: unknown; output?: unknown };
  if (typeof value.output_text === "string" && value.output_text.trim()) {
    return value.output_text.trim();
  }
  if (!Array.isArray(value.output)) return null;
  for (const item of value.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as { type?: unknown; text?: unknown });
      if (text.type === "output_text" && typeof text.text === "string" && text.text.trim()) {
        return text.text.trim();
      }
    }
  }
  return null;
}

export async function POST(request: Request) {
  const startedAt = performance.now();
  const body = await request.json().catch(() => null) as { input?: unknown } | null;
  const input = typeof body?.input === "string" ? body.input.trim().slice(0, 500) : "";
  if (!input) {
    return NextResponse.json({ ok: false, error: "Please say something first." }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const demoEnabled = process.env.ECHO_DEMO_ENABLED !== "false";
  if (apiKey && demoEnabled) {
    try {
      const response = await fetch(
        `${process.env.OPENAI_API_BASE_URL?.trim().replace(/\/+$/, "") || "https://api.openai.com"}/v1/responses`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
            instructions: "Reply in warm, concise spoken Mandarin as a friendly digital companion. Use one or two short sentences and never mention being an AI.",
            input,
            max_output_tokens: 100,
          }),
          signal: AbortSignal.timeout(4_000),
        },
      );
      const responseBody = await response.json().catch(() => null);
      const reply = response.ok ? responseText(responseBody) : null;
      if (reply) {
        return NextResponse.json({
          ok: true,
          reply,
          mode: "cloud",
          elapsedMs: Math.round(performance.now() - startedAt),
        }, { headers: { "Cache-Control": "no-store" } });
      }
    } catch {
      // The demo remains recordable when the optional cloud model is offline.
    }
  }

  return NextResponse.json({
    ok: true,
    reply: fallbackReply(input),
    mode: "local-fallback",
    elapsedMs: Math.round(performance.now() - startedAt),
  }, { headers: { "Cache-Control": "no-store" } });
}
