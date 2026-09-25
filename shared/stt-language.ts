export const STT_LANGUAGE_PREFERENCES = ["auto", "mandarin", "wu", "english"] as const;

export const SPOKEN_LANGUAGE_VARIANTS = ["english", "mandarin", "wu", "shanghainese"] as const;

export type SttLanguagePreference = (typeof STT_LANGUAGE_PREFERENCES)[number];
export type SpokenLanguageVariant = (typeof SPOKEN_LANGUAGE_VARIANTS)[number];

export function isSttLanguagePreference(value: unknown): value is SttLanguagePreference {
  return typeof value === "string" && STT_LANGUAGE_PREFERENCES.includes(value as SttLanguagePreference);
}

export function normalizeSttLanguagePreference(value: unknown): SttLanguagePreference {
  return isSttLanguagePreference(value) ? value : "auto";
}

export function isSpokenLanguageVariant(value: unknown): value is SpokenLanguageVariant {
  return typeof value === "string" && SPOKEN_LANGUAGE_VARIANTS.includes(value as SpokenLanguageVariant);
}
