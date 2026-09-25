/**
 * Speech boundary.
 *
 * These contracts cover TTS dispatch, voice-reference preparation, and STT.
 * The current implementation reaches the GPU stack through LiveTalking's
 * authenticated gateway; callers intentionally do not know whether the
 * implementation is CosyVoice, FastWhisper, or an approved fallback.
 */
export {
  dispatchLiveReferenceAudio,
  dispatchLiveSpeech,
  saveVoiceReference,
  transcribeVoiceClip,
  usesDemoReferenceAudio,
  voiceRefPath,
} from "@/back_end/services/livetalking";
