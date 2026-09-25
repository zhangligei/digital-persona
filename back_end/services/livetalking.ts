import {
  isSpokenLanguageVariant,
  type SpokenLanguageVariant,
  type SttLanguagePreference,
} from "@/shared/stt-language";

// Bridges this app's backend to the standalone LiveTalking WebRTC avatar
// server running on a separate GPU box. The browser talks to that server
// directly for the actual video/audio stream — Cloudflare Workers can't
// proxy a stateful WebRTC media session — so this module's only job is
// issuing a short-lived signed token the browser attaches to its requests.
// LiveTalking has no auth of its own; a matching HMAC check was added to
// its app.py so it only accepts requests carrying a token signed with this
// same secret. See docs/livetalking-integration.md.

const TOKEN_TTL_SECONDS = 10 * 60; // one conversation's worth

export type LiveSessionTokenPayload = {
  uid: string;
  pid: string;
  exp: number;
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

export function isLiveTalkingConfigured(): boolean {
  return Boolean(process.env.LIVETALKING_SESSION_SECRET && process.env.LIVETALKING_SERVER_URL);
}

export function liveTalkingServerUrl(): string | null {
  return process.env.LIVETALKING_SERVER_URL ?? null;
}

/**
 * TURN relay config for the browser's own RTCPeerConnection. Needed because
 * the GPU box's WebRTC media (unlike the plain HTTP signaling above) can't
 * reach the browser directly — it sits behind a NAT that only forwards the
 * specific ports explicitly mapped for it, not the ephemeral ports WebRTC
 * picks per session. Undefined fields mean TURN isn't configured yet, in
 * which case the browser falls back to STUN-only (direct P2P), which may or
 * may not work depending on both sides' networks.
 */
export function turnServerConfig(): { urls: string[]; username: string; credential: string } | null {
  // Comma-separated because Tencent's CLB assigned TCP and UDP different
  // external ports for the same internal 3478 — one env var, multiple URLs,
  // each tagged with its own ?transport= so the browser knows which is which.
  const rawUrls = process.env.TURN_SERVER_URL;
  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;
  if (!rawUrls || !username || !credential) return null;
  const urls = rawUrls.split(",").map((url) => url.trim()).filter(Boolean);
  if (urls.length === 0) return null;
  return { urls, username, credential };
}

export async function createLiveSessionToken(userId: string, personaId: string): Promise<string | null> {
  const secret = process.env.LIVETALKING_SESSION_SECRET;
  if (!secret) return null;

  const payload: LiveSessionTokenPayload = {
    uid: userId,
    pid: personaId,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSign(secret, payloadB64);
  return `${payloadB64}.${signature}`;
}

export const LIVE_SESSION_TOKEN_TTL_SECONDS = TOKEN_TTL_SECONDS;

/**
 * Sends already-generated text to an existing LiveTalking WebRTC session.
 *
 * Keep this server-to-server rather than exposing the plain-HTTP GPU service
 * to browsers: the public site is HTTPS, so a direct browser request would
 * be blocked as mixed content. It is shared by the legacy `/human` route and
 * by the messages route's background dispatch path.
 */
export async function dispatchLiveSpeech({
  userId,
  personaId,
  sessionId,
  utteranceId,
  text,
}: {
  userId: string;
  personaId: string;
  sessionId: string;
  /** Stable chat-message id used by the GPU gateway for idempotency. */
  utteranceId: string;
  text: string;
}): Promise<void> {
  const serverUrl = liveTalkingServerUrl();
  const token = await createLiveSessionToken(userId, personaId);
  if (!serverUrl || !token) throw new Error("The live avatar server isn't configured yet.");

  const response = await fetch(`${serverUrl}/human`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      sessionid: sessionId,
      utterance_id: utteranceId,
      text,
      type: "echo",
    }),
    // This is now awaited directly in the messages route's critical path
    // (not handed to after()), so its timeout directly bounds how long an
    // ordinary chat reply can be held up by a slow/degraded GPU box. /human
    // only enqueues synthesis — a healthy GPU acks in well under a second —
    // so 2.5s is generous for the normal case while keeping a bad GPU from
    // dragging basic text chat down toward the 8s it used to allow.
    signal: AbortSignal.timeout(2_500),
  });
  if (!response.ok) throw new Error(`Avatar server returned ${response.status}.`);
}

/**
 * Plays this authenticated persona's saved reference WAV through the same
 * LiveTalking WebRTC session used by ordinary text-driven speech.
 *
 * The GPU gateway resolves the file from the token's persona id, so callers
 * cannot choose another persona's audio or expose a GPU filesystem path.
 */
export async function dispatchLiveReferenceAudio({
  userId,
  personaId,
  sessionId,
}: {
  userId: string;
  personaId: string;
  sessionId: string;
}): Promise<void> {
  const serverUrl = liveTalkingServerUrl();
  const token = await createLiveSessionToken(userId, personaId);
  if (!serverUrl || !token) throw new Error("The live avatar server isn't configured yet.");

  const response = await fetch(`${serverUrl}/api/voice/speak-reference`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionid: sessionId }),
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`Avatar reference-audio server returned ${response.status}.`);
}

/**
 * Temporary, deployment-scoped showcase mode. Production behavior is
 * unchanged unless an operator explicitly lists persona ids in the env var.
 */
export function usesDemoReferenceAudio(personaId: string): boolean {
  const configured = process.env.ECHO_DEMO_REFERENCE_AUDIO_PERSONAS;
  if (!configured) return false;
  return configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(personaId);
}

/**
 * Starts LiveTalking's configured relaxed action/idle state after a WebRTC
 * session is established. It is intentionally best-effort: deployments that
 * have not yet installed a persona idle-action clip continue to serve normal
 * speech without failing the conversation.
 */
export async function setLiveAvatarIdleAction({
  userId,
  personaId,
  sessionId,
  audiotype = 1,
}: {
  userId: string;
  personaId: string;
  sessionId: string;
  /** LiveTalking reserves type 1 for the normal no-speech/idle state. */
  audiotype?: 1;
}): Promise<void> {
  const serverUrl = liveTalkingServerUrl();
  const token = await createLiveSessionToken(userId, personaId);
  if (!serverUrl || !token) throw new Error("The live avatar server isn't configured yet.");

  const response = await fetch(`${serverUrl}/set_audiotype`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionid: sessionId, audiotype }),
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`Avatar action server returned ${response.status}.`);
}

/** Releases a GPU/WebRTC session when its browser peer is closed or times out. */
export async function closeLiveAvatarSession({
  userId,
  personaId,
  sessionId,
}: {
  userId: string;
  personaId: string;
  sessionId: string;
}): Promise<void> {
  const serverUrl = liveTalkingServerUrl();
  const token = await createLiveSessionToken(userId, personaId);
  if (!serverUrl || !token) return;

  const response = await fetch(`${serverUrl}/close_session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionid: sessionId }),
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`Avatar close server returned ${response.status}.`);
}

// --- Server-to-server calls (avatar/voice training) -------------------------
// Everything below runs from this backend directly against the GPU box, not
// from the browser — same signed-token scheme, minted with a fixed "system"
// subject since there's no end-user request in flight during training.

async function systemToken(personaId: string): Promise<string | null> {
  return createLiveSessionToken("system", personaId);
}

// A800 pulls private files through this Worker endpoint using its existing
// short-lived HMAC token. The Worker streams the R2 body directly and never
// materializes a second copy of the upload in its own heap.
function privatePersonaMediaUrl(personaId: string, assetId: string): string {
  const origin = process.env.PUBLIC_APP_ORIGIN ?? "https://echodigitalpersona.com";
  return `${origin}/api/internal/persona-media/${encodeURIComponent(personaId)}/${encodeURIComponent(assetId)}`;
}

export type AvatarTrainingTask = {
  status: "pending" | "processing" | "running" | "completed" | "failed";
  progress: number;
  error_msg: string;
};

export type VoiceSpeechProfile = {
  version: 1;
  confidence: "low" | "medium" | "high";
  language: string;
  sample_duration_seconds: number;
  speaking_rate: number;
  speaking_rate_unit: "words_per_second" | "characters_per_second";
  speed_factor: number;
  pause_style: "sparse" | "balanced" | "frequent";
  pauses_per_minute: number;
  observed_pause_count: number;
  median_short_pause_ms: number;
  median_long_pause_ms: number;
  long_pause_ratio: number;
  preferred_boundary: "sentence" | "clause" | "unpunctuated";
};

export type SavedVoiceReference = {
  transcript: string | null;
  /** Aggregate timing only; it contains no transcript content or voice embedding. */
  speechProfile: VoiceSpeechProfile | null;
  /** A grounded prompt/memory description derived from speechProfile. */
  speechStyleSummary: string | null;
};

/**
 * Checks the durable MuseTalk package on the A800. Task state itself lives
 * in memory there, so it is intentionally not the source of truth after a
 * LiveTalking restart.
 */
export async function getAvatarReadiness(personaId: string): Promise<"completed" | "missing" | null> {
  const serverUrl = liveTalkingServerUrl();
  const token = await systemToken(personaId);
  if (!serverUrl || !token) return null;

  try {
    const response = await fetch(`${serverUrl}/api/avatar/persona/${encodeURIComponent(personaId)}/status`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await response.json()) as { code: number; data?: { status?: unknown } };
    const status = body.data?.status;
    if (!response.ok || body.code !== 0 || (status !== "completed" && status !== "missing")) return null;
    return status;
  } catch (error) {
    console.error("[persona-training] avatar readiness check failed", { personaId, error });
    return null;
  }
}

/**
 * Submits a video (or a single photo — the server loops it into a short
 * clip) to LiveTalking's own async avatar-generation job queue. Returns the
 * task id to poll, or an error. Does not wait for the job to finish.
 */
export async function submitAvatarTrainingJob(
  personaId: string,
  avatarId: string,
  sourceAsset: { id: string; fileName: string },
  // The passive scan, when given, becomes MuseTalk's separate idle-only
  // loop (see docs/gpu-liveportrait-integration.md) rather than sourceAsset
  // itself needing to double as both the main avatar and the idle loop.
  idleSourceAsset?: { id: string; fileName: string },
): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
  const serverUrl = liveTalkingServerUrl();
  const token = await systemToken(personaId);
  if (!serverUrl || !token) return { ok: false, error: "The avatar training server isn't configured." };

  try {
    console.info("[persona-training] submitting avatar job", {
      personaId,
      avatarId,
      sourceAssetId: sourceAsset.id,
      sourceFileName: sourceAsset.fileName,
      idleSourceAssetId: idleSourceAsset?.id ?? null,
    });
    const response = await fetch(`${serverUrl}/api/avatar/task-from-url`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "musetalk",
        avatar_id: avatarId,
        version: "v15",
        source_url: privatePersonaMediaUrl(personaId, sourceAsset.id),
        file_name: sourceAsset.fileName,
        ...(idleSourceAsset ? {
          idle_source_url: privatePersonaMediaUrl(personaId, idleSourceAsset.id),
          idle_file_name: idleSourceAsset.fileName,
        } : {}),
      }),
      // This enqueues the job, but the GPU box does synchronous ffmpeg
      // canonicalization of both source videos before it returns a task id
      // — measured at ~35s in production for a guided+idle pair, not the
      // near-instant response this endpoint's name suggests. The timeout
      // must clear that with real margin (larger videos, GPU load) or it
      // aborts perfectly healthy submissions. Still must not hang
      // indefinitely on a genuinely slow/unresponsive GPU box — without a
      // bound, a stuck fetch here never throws, so the caller's try/catch
      // never runs and a persona can be stranded at status "processing"
      // forever (see the matching note on saveVoiceReference below, which
      // is the incident that surfaced this gap).
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await response.json()) as { code: number; msg: string; data?: { task_id: string } };
    if (!response.ok || body.code !== 0 || !body.data) {
      console.error("[persona-training] avatar job rejected", { personaId, avatarId, status: response.status, error: body.msg });
      return { ok: false, error: body.msg || `Avatar server returned ${response.status}.` };
    }
    console.info("[persona-training] avatar job accepted", { personaId, avatarId, taskId: body.data.task_id });
    return { ok: true, taskId: body.data.task_id };
  } catch (error) {
    console.error("[persona-training] avatar job submission failed", { personaId, avatarId, error });
    return { ok: false, error: "Couldn't reach the avatar training server." };
  }
}

export async function getAvatarTrainingTask(personaId: string, taskId: string): Promise<AvatarTrainingTask | null> {
  const serverUrl = liveTalkingServerUrl();
  const token = await systemToken(personaId);
  if (!serverUrl || !token) return null;

  try {
    // POST, not GET: this deployment sits behind a Tencent CLB listener
    // that redirects plain GET requests for reasons outside this app (see
    // docs/livetalking-integration.md) — the GPU box registers a POST alias
    // on the same path for exactly this.
    const response = await fetch(`${serverUrl}/api/avatar/task/${taskId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as { code: number; data?: AvatarTrainingTask };
    if (!response.ok || body.code !== 0 || !body.data) {
      console.warn("[persona-training] avatar task unavailable", { personaId, taskId, status: response.status });
      return null;
    }
    console.info("[persona-training] avatar task status", { personaId, taskId, status: body.data.status, progress: body.data.progress });
    return body.data;
  } catch (error) {
    console.error("[persona-training] avatar task poll failed", { personaId, taskId, error });
    return null;
  }
}

/**
 * Persists a persona's chosen voice-reference clip on the GPU box at a
 * stable, convention-based path (data/voice_refs/<personaId>.wav — see
 * voiceRefPath()) and transcribes it for CosyVoice's own zero-shot
 * prompt_text. Not a general STT call — this runs once per training pass,
 * not per conversation turn.
 */
export async function saveVoiceReference(
  personaId: string,
  sourceAsset: { id: string; fileName: string },
): Promise<SavedVoiceReference | null> {
  const serverUrl = liveTalkingServerUrl();
  const token = await systemToken(personaId);
  if (!serverUrl || !token) return null;

  try {
    const response = await fetch(`${serverUrl}/api/voice/reference-from-url`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: personaId,
        source_url: privatePersonaMediaUrl(personaId, sourceAsset.id),
        file_name: sourceAsset.fileName,
      }),
      // This runs inside prepareVoiceReference's `after()` background
      // callback. Without a bound, a GPU box that accepts the connection
      // but never responds leaves this fetch permanently pending — the
      // surrounding try/catch only guards against thrown errors, not an
      // unsettled promise — so the caller's finally-style cleanup never
      // runs and the persona is stranded at status "processing" forever.
      // This happened in production; see docs/gpu-liveportrait-integration.md.
      signal: AbortSignal.timeout(45_000),
    });
    const body = (await response.json()) as {
      code: number;
      data?: {
        path: string;
        text: string;
        speech_profile?: VoiceSpeechProfile;
        speech_style_summary?: string;
      };
    };
    if (!response.ok || body.code !== 0 || !body.data) return null;
    return {
      transcript: body.data.text?.trim() || null,
      speechProfile: body.data.speech_profile ?? null,
      speechStyleSummary: body.data.speech_style_summary?.trim() || null,
    };
  } catch {
    return null;
  }
}

/** Matches voice_reference's save path on the GPU box exactly — see app.py's voice_reference handler. */
export function voiceRefPath(personaId: string): string {
  return `data/voice_refs/${personaId}.wav`;
}

/**
 * LiveTalking's MuseTalk avatar generator stores numbered source-video frames
 * under this directory. Registering them as silence action type 1 makes its
 * renderer loop the real source motion (breathing, blinking, posture shifts)
 * between spoken audio rather than holding the first frame forever.
 *
 * This is generated server-side from the already-authorised avatar id; it is
 * never accepted from the browser as an arbitrary GPU filesystem path.
 */
// idle_imgs is a LivePortrait-enhanced loop (natural blinking/micro-motion)
// baked alongside the avatar when training runs the LivePortrait step; not
// every avatar has one (older avatars, or a training run where the
// enhancement step failed — it degrades gracefully, never blocks training).
// LiveTalking's own loader already no-ops a missing/empty imgpath rather
// than erroring, falling back to its normal no-custom-action behavior, so
// it's safe to always point here rather than track per-avatar readiness.
export function personaIdleActionConfig(avatarId: string): string {
  return JSON.stringify([
    {
      audiotype: 1,
      imgpath: `data/avatars/${avatarId}/idle_imgs`,
    },
  ]);
}

/**
 * Removes a persona's trained MuseTalk avatar directory and CosyVoice voice
 * reference file from the GPU box. Training data (R2, Postgres, the RAG
 * vector store) is cleaned up elsewhere — this is the piece that only lives
 * on the GPU box itself, so a persona delete doesn't leave 50-100MB+ of
 * orphaned avatar files behind. Safe to call even if the persona was never
 * trained (the GPU box just reports nothing to remove).
 */
export async function deletePersonaGpuFiles(personaId: string): Promise<boolean> {
  const serverUrl = liveTalkingServerUrl();
  const token = await systemToken(personaId);
  if (!serverUrl || !token) return false;

  try {
    const response = await fetch(`${serverUrl}/api/avatar/persona/${personaId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok;
  } catch {
    // A slow/unreachable GPU box shouldn't be able to hang or fail the
    // persona delete this is called from — the DB/R2 cleanup that matters
    // most to the user still goes through either way.
    return false;
  }
}

/**
 * Confirms a candidate video/photo shows the same person as a persona's
 * facial scan, via the GPU box's face_recognition-backed comparison. Used
 * to keep an unrelated or mis-tagged video upload from ever becoming the
 * source MuseTalk trains a persona's avatar on. Returns null (not a hard
 * false) when the check itself couldn't run — callers should treat that as
 * "couldn't verify," not "confirmed mismatch."
 */
export async function checkFaceMatch(
  personaId: string,
  referenceAsset: { id: string; fileName: string },
  candidateAsset: { id: string; fileName: string },
): Promise<{ match: boolean; distance?: number } | null> {
  const serverUrl = liveTalkingServerUrl();
  const token = await systemToken(personaId);
  if (!serverUrl || !token) return null;

  try {
    const response = await fetch(`${serverUrl}/api/avatar/face-match-from-url`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        reference_url: privatePersonaMediaUrl(personaId, referenceAsset.id),
        reference_name: referenceAsset.fileName,
        candidate_url: privatePersonaMediaUrl(personaId, candidateAsset.id),
        candidate_name: candidateAsset.fileName,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json()) as { code: number; data?: { match: boolean; distance?: number } };
    if (!response.ok || body.code !== 0 || !body.data) return null;
    return body.data;
  } catch {
    return null;
  }
}

/**
 * Transcribes one always-on-mic utterance (a browser-side VAD segment) via
 * the GPU box's Whisper model. Unlike saveVoiceReference, nothing is
 * persisted on the server — this runs once per spoken chat turn, not once
 * per training pass, so there's no file to keep around afterward.
 */
export async function transcribeVoiceClip(
  personaId: string,
  audioBlob: File,
  dialectPreference: SttLanguagePreference = "auto",
): Promise<{
  text: string;
  spokenVariant: SpokenLanguageVariant;
  variantConfidence: number | null;
} | null> {
  const serverUrl = liveTalkingServerUrl();
  const token = await systemToken(personaId);
  if (!serverUrl || !token) return null;

  const form = new FormData();
  form.set("audio", audioBlob, audioBlob.name);
  form.set("dialect", dialectPreference);

  try {
    const response = await fetch(`${serverUrl}/api/voice/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as {
      code: number;
      data?: {
        text: string;
        spoken_variant?: unknown;
        variant_confidence?: unknown;
      };
    };
    if (!response.ok || body.code !== 0 || !body.data) return null;
    const spokenVariant = isSpokenLanguageVariant(body.data.spoken_variant)
      ? body.data.spoken_variant
      : "mandarin";
    const variantConfidence = typeof body.data.variant_confidence === "number"
      && Number.isFinite(body.data.variant_confidence)
      ? Math.max(0, Math.min(1, body.data.variant_confidence))
      : null;
    return { text: body.data.text, spokenVariant, variantConfidence };
  } catch {
    return null;
  }
}
