"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { useLocale } from "@/front_end/state/locale-context";
import { STT_LANGUAGE_PREFERENCES, type SttLanguagePreference } from "@/shared/stt-language";

export type SttDialectPreference = SttLanguagePreference;

const TRACK_PADDING = 3;
const SPRING = { stiffness: 500, damping: 32 };

function nearestIndex(rawIndex: number, startIndex: number, maxIndex: number): number {
  const clamped = Math.min(maxIndex, Math.max(0, rawIndex));
  const lower = Math.floor(clamped);
  const upper = Math.ceil(clamped);
  if (lower === upper) return lower;
  const fraction = clamped - lower;
  if (fraction === 0.5) return startIndex <= lower ? upper : lower;
  return fraction < 0.5 ? lower : upper;
}

// Same Apple-style momentum-segmented pattern as NameModal's PersonaStyleSlider
// (Realistic/Cartoon) — drag with rubber-banding, spring-snaps to the nearest
// segment on release.
export function DialectSlider({
  value,
  onChange,
}: {
  value: SttDialectPreference;
  onChange: (value: SttDialectPreference) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [segmentWidth, setSegmentWidth] = useState(0);
  const x = useMotionValue(0);
  const reduceMotion = useReducedMotion();
  const { locale } = useLocale();
  const activeIndex = STT_LANGUAGE_PREFERENCES.indexOf(value);
  const dragStartIndexRef = useRef(activeIndex);

  useEffect(() => {
    const measure = () => {
      if (trackRef.current) setSegmentWidth((trackRef.current.offsetWidth - TRACK_PADDING * 2) / STT_LANGUAGE_PREFERENCES.length);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    if (!segmentWidth) return;
    const controls = animate(x, activeIndex * segmentWidth, {
      type: reduceMotion ? "tween" : "spring",
      duration: reduceMotion ? 0 : undefined,
      ...SPRING,
    });
    return () => controls.stop();
  }, [activeIndex, reduceMotion, segmentWidth, x]);

  const snapTo = useCallback((index: number) => {
    const nextIndex = Math.max(0, Math.min(STT_LANGUAGE_PREFERENCES.length - 1, index));
    if (nextIndex === activeIndex || !segmentWidth) {
      if (segmentWidth) {
        animate(x, activeIndex * segmentWidth, { type: reduceMotion ? "tween" : "spring", duration: reduceMotion ? 0 : undefined, ...SPRING });
      }
      return;
    }
    onChange(STT_LANGUAGE_PREFERENCES[nextIndex]);
  }, [activeIndex, onChange, reduceMotion, segmentWidth, x]);

  return (
    <div ref={trackRef} className="relative mt-sm flex w-full select-none overflow-hidden rounded-pill bg-canvas p-[3px]">
      {segmentWidth > 0 && (
        <motion.div
          drag="x"
          dragConstraints={{ left: 0, right: segmentWidth * (STT_LANGUAGE_PREFERENCES.length - 1) }}
          dragElastic={0}
          dragMomentum={false}
          onDragStart={() => {
            dragStartIndexRef.current = Math.round(x.get() / segmentWidth);
          }}
          onDragEnd={() => snapTo(nearestIndex(
            x.get() / segmentWidth,
            dragStartIndexRef.current,
            STT_LANGUAGE_PREFERENCES.length - 1,
          ))}
          style={{ x, width: segmentWidth }}
          className="absolute top-[3px] bottom-[3px] left-[3px] cursor-grab touch-none rounded-pill bg-surface-chip-translucent shadow-dock active:cursor-grabbing"
        />
      )}
      {STT_LANGUAGE_PREFERENCES.map((dialect, index) => (
        <button
          key={dialect}
          type="button"
          aria-pressed={value === dialect}
          onClick={() => snapTo(index)}
          className={`relative z-10 flex-1 py-xs text-center font-text text-caption-strong transition-colors duration-150 ${value === dialect ? "pointer-events-none text-ink" : "text-ink-muted-48"}`}
        >
          {dialect === "auto"
            ? (locale === "zh" ? "自动" : "Auto")
            : dialect === "mandarin"
            ? (locale === "zh" ? "普通话" : "Mandarin")
            : dialect === "wu"
              ? (locale === "zh" ? "吴语" : "Wu Dialect")
              : (locale === "zh" ? "英语" : "English")}
        </button>
      ))}
    </div>
  );
}
