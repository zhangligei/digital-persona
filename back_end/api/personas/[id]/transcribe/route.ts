import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/back_end/services/auth";
import { getDb } from "@/back_end/services/db";
import { isLiveTalkingConfigured } from "@/back_end/services/live-avatar";
import { transcribeVoiceClip } from "@/back_end/services/speech";
import { normalizeSttLanguagePreference } from "@/shared/stt-language";
import type { SpokenLanguageVariant } from "@/shared/stt-language";

export type TranscribeResponseBody = {
  ok: true;
  text: string;
  spokenVariant: SpokenLanguageVariant;
  variantConfidence: number | null;
} | { ok: false; error: string };

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const user = await getCurrentUser().catch(() => null);
  if (!user || !user.emailVerified) {
    return NextResponse.json<TranscribeResponseBody>({ ok: false, error: "You're not logged in." }, { status: 401 });
  }

  if (!isLiveTalkingConfigured()) {
    return NextResponse.json<TranscribeResponseBody>(
      { ok: false, error: "Speech-to-text isn't configured yet." },
      { status: 503 },
    );
  }

  const { id: personaId } = await params;

  try {
    const persona = await db.persona.findFirst({ where: { id: personaId, userId: user.id } });
    if (!persona) {
      return NextResponse.json<TranscribeResponseBody>({ ok: false, error: "Persona not found." }, { status: 404 });
    }

    const formData = await request.formData().catch(() => null);
    const audio = formData?.get("audio");
    if (!(audio instanceof File) || audio.size === 0) {
      return NextResponse.json<TranscribeResponseBody>({ ok: false, error: "No audio received." }, { status: 400 });
    }

    const configuredPreference = normalizeSttLanguagePreference(persona.sttDialectPreference);
    // Live conversation uses automatic Chinese variety routing. Keep an
    // explicit English-only profile as an override, while legacy Mandarin/Wu
    // defaults become evidence-based auto detection rather than forcing the
    // visitor to change a setting before every turn.
    const dialectPreference = configuredPreference === "english" ? "english" : "auto";
    const transcription = await transcribeVoiceClip(personaId, audio, dialectPreference);
    if (transcription === null) {
      return NextResponse.json<TranscribeResponseBody>(
        { ok: false, error: "Couldn't reach the transcription server." },
        { status: 502 },
      );
    }

    return NextResponse.json<TranscribeResponseBody>({ ok: true, ...transcription });
  } catch (error) {
    console.error("POST /api/personas/[id]/transcribe failed", error);
    return NextResponse.json<TranscribeResponseBody>({ ok: false, error: "Transcription failed." }, { status: 500 });
  }
}
