import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/back_end/services/auth";
import { getDb } from "@/back_end/services/db";
import { getPersonaReply, type PersonaConversationTurn } from "@/back_end/services/persona-ai";
import { incrementPlatformMetrics } from "@/back_end/services/metrics";
import { ingestConversationMessage } from "@/back_end/services/persona-rag";
import { maskInappropriateLanguage } from "@/back_end/services/moderation";
import { isLiveTalkingConfigured } from "@/back_end/services/live-avatar";
import {
  dispatchLiveReferenceAudio,
  dispatchLiveSpeech,
  usesDemoReferenceAudio,
} from "@/back_end/services/speech";
import { hasPaidAccess } from "@/back_end/services/limits";
import { isSpokenLanguageVariant } from "@/shared/stt-language";

export type ChatMessageDTO = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
};

export type GetMessagesResponseBody =
  | { ok: true; messages: ChatMessageDTO[] }
  | { ok: false; error: string };

export type SendMessageResponseBody =
  | { ok: true; userMessage: ChatMessageDTO; replyMessage: ChatMessageDTO; liveSpeechQueued: boolean }
  | { ok: false; error: string };

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const user = await getCurrentUser().catch(() => null);
  if (!user || !user.emailVerified) {
    return NextResponse.json<GetMessagesResponseBody>(
      { ok: false, error: "You're not logged in." },
      { status: 401 },
    );
  }

  const { id: personaId } = await params;

  try {
    const persona = await db.persona.findFirst({ where: { id: personaId, userId: user.id } });
    if (!persona) {
      return NextResponse.json<GetMessagesResponseBody>(
        { ok: false, error: "Persona not found." },
        { status: 404 },
      );
    }
    if (persona.status !== "active") {
      return NextResponse.json<GetMessagesResponseBody>(
        { ok: false, error: "This persona is still being prepared." },
        { status: 409 },
      );
    }

    const messages = await db.chatMessage.findMany({
      where: { personaId },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, content: true, createdAt: true },
    });

    return NextResponse.json<GetMessagesResponseBody>({
      ok: true,
      messages: messages.map((message) => ({
        ...message,
        createdAt: message.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("GET /api/personas/[id]/messages failed", error);
    return NextResponse.json<GetMessagesResponseBody>(
      { ok: false, error: "Couldn't load messages — the database isn't reachable yet." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const user = await getCurrentUser().catch(() => null);
  if (!user || !user.emailVerified) {
    return NextResponse.json<SendMessageResponseBody>(
      { ok: false, error: "You're not logged in." },
      { status: 401 },
    );
  }

  const { id: personaId } = await params;
  const body = await request.json().catch(() => null);
  const content = typeof body?.content === "string" ? maskInappropriateLanguage(body.content.trim()) : "";
  // A session id is only useful while the subscriber has an already-open
  // WebRTC session. The short length cap prevents this background path from
  // becoming a vehicle for arbitrary oversized payloads.
  const liveSessionId = typeof body?.liveSessionId === "string" && body.liveSessionId.length <= 160
    ? body.liveSessionId.trim()
    : "";
  const requestedLocale = body?.locale === "zh" ? "zh" : "en";
  const spokenVariant = isSpokenLanguageVariant(body?.spokenVariant)
    ? body.spokenVariant
    : undefined;

  if (!content) {
    return NextResponse.json<SendMessageResponseBody>(
      { ok: false, error: "Message can't be empty." },
      { status: 400 },
    );
  }

  try {
    const persona = await db.persona.findFirst({ where: { id: personaId, userId: user.id } });
    if (!persona) {
      return NextResponse.json<SendMessageResponseBody>(
        { ok: false, error: "Persona not found." },
        { status: 404 },
      );
    }
    if (persona.status !== "active") {
      return NextResponse.json<SendMessageResponseBody>(
        { ok: false, error: "This persona is still being prepared." },
        { status: 409 },
      );
    }

    const userMessage = await db.chatMessage.create({
      data: { personaId, role: "user", content },
      select: { id: true, role: true, content: true, createdAt: true },
    });

    const recentRows = await db.chatMessage.findMany({
      where: { personaId },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { role: true, content: true },
    });
    const recentMessages: PersonaConversationTurn[] = [];
    for (const message of recentRows.reverse()) {
      if (message.role === "user") recentMessages.push({ role: "user", content: message.content });
      if (message.role === "persona") recentMessages.push({ role: "persona", content: message.content });
    }

    // A deployment may opt selected fictional demo personas into a stable,
    // source-grounded showcase reply. The visible bubble uses the exact
    // transcript of the audio that the GPU will play, preventing a Mandarin
    // TTS fallback from being presented as Wu dialect and keeping speech and
    // text synchronized. No production persona changes unless the explicit
    // environment allow-list contains its id.
    const useReferenceAudio = usesDemoReferenceAudio(personaId)
      && Boolean(persona.voiceRefTranscript)
      && !spokenVariant;
    let replyContent: string;
    if (useReferenceAudio) {
      replyContent = maskInappropriateLanguage(persona.voiceRefTranscript!);
    } else {
      const replyResult = await getPersonaReply({
        personaId,
        personaName: persona.name,
        message: content,
        locale: requestedLocale,
        recentMessages,
        voiceReferenceTranscript: persona.voiceRefTranscript,
        responseLanguage: spokenVariant,
      });
      if (!replyResult.ok) {
        // A provider outage is not something the persona said. Remove the
        // provisional user row so retrying does not duplicate an unanswered
        // turn, and surface a real service error instead of permanently saving
        // and speaking a canned failure sentence in the persona's voice.
        await db.chatMessage.delete({ where: { id: userMessage.id } }).catch((cleanupError) => {
          console.error("Couldn't remove unanswered chat turn", cleanupError);
        });
        return NextResponse.json<SendMessageResponseBody>(
          {
            ok: false,
            error: requestedLocale === "zh"
              ? "回复服务暂时不可用，请稍后重试。"
              : "The reply service is temporarily unavailable. Please try again.",
          },
          { status: 503 },
        );
      }
      replyContent = maskInappropriateLanguage(replyResult.text);
    }

    const replyMessage = await db.chatMessage.create({
      data: { personaId, role: "persona", content: replyContent },
      select: { id: true, role: true, content: true, createdAt: true },
    });

    // Persist both real turns after the visible response is returned. RAG
    // ingestion is intentionally outside the critical path: the current
    // turn is already in the model input, while a transient vector-service
    // outage must not make chat unavailable. The metrics increment was
    // previously awaited here too, on the request's critical path, despite
    // already being best-effort (its own .catch() below never surfaces to
    // the caller) — it bought nothing but latency, so it moves into the
    // same background pass.
    after(async () => {
      await Promise.all([
        ingestConversationMessage(personaId, userMessage.id, "user", content),
        ingestConversationMessage(personaId, replyMessage.id, "persona", replyContent),
        incrementPlatformMetrics({ messagesExchanged: 2 }),
      ].map((task) => task.catch((backgroundError) => {
        console.error("Background post-reply task failed", backgroundError);
      })));
    });

    // Dispatch the avatar speech request as soon as the reply is known,
    // rather than returning it to the browser and waiting for a second
    // client-side HTTP request. This is deliberately awaited rather than
    // handed to after(): after()/waitUntil() in this OpenNext deployment is
    // best-effort, not a durable queue, and under bursty concurrent
    // requests (e.g. several always-on-mic turns arriving close together,
    // each its own Worker invocation) its callback can be dropped before
    // the outbound fetch to the GPU box ever completes — with no retry and
    // nothing surfaced to the client, since the HTTP response had already
    // gone out claiming success. /human on the GPU side only enqueues
    // synthesis (fast ack, not full TTS+render), so awaiting it here costs
    // a network round trip, not the full speech-generation time.
    //
    // liveSpeechQueued reports whether the dispatch actually reached the
    // GPU, not merely whether it was attempted: the frontend's own
    // useEffect (LiveTalkingAvatar.tsx) skips its client-side speak
    // fallback whenever this is true, trusting the backend already
    // handled it. Reporting true for a dispatch that silently failed
    // disables that fallback for no reason — this is the same bug that
    // let some replies never get spoken.
    let liveSpeechQueued = false;
    if (
      liveSessionId &&
      isLiveTalkingConfigured() &&
      hasPaidAccess(user.subscriptionStatus, user.subscriptionRenewsAt)
    ) {
      try {
        if (useReferenceAudio) {
          await dispatchLiveReferenceAudio({
            userId: user.id,
            personaId,
            sessionId: liveSessionId,
          });
        } else {
          await dispatchLiveSpeech({
            userId: user.id,
            personaId,
            sessionId: liveSessionId,
            utteranceId: replyMessage.id,
            text: replyContent,
          });
        }
        liveSpeechQueued = true;
      } catch (liveError) {
        // Text chat remains successful if the optional live service is
        // down; the client falls back to its own client-side dispatch.
        console.error("Live-speech dispatch failed", liveError);
      }
    }

    return NextResponse.json<SendMessageResponseBody>({
      ok: true,
      userMessage: { ...userMessage, createdAt: userMessage.createdAt.toISOString() },
      replyMessage: { ...replyMessage, createdAt: replyMessage.createdAt.toISOString() },
      liveSpeechQueued,
    });
  } catch (error) {
    console.error("POST /api/personas/[id]/messages failed", error);
    return NextResponse.json<SendMessageResponseBody>(
      { ok: false, error: "Couldn't send — the database isn't reachable yet." },
      { status: 500 },
    );
  }
}
