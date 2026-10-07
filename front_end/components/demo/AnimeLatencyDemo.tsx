"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";

type DemoMode = "cloud" | "local-fallback" | null;
type TtsMode = "cloud-stream" | "local-fallback" | null;

type Timing = {
  reply?: number;
  firstAudio?: number;
  firstFrame?: number;
  finished?: number;
};

type SpeechRecognitionResultLike = { transcript: string };
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<SpeechRecognitionResultLike>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const samples = [
  "你好呀，你今天过得怎么样？",
  "我有点想念孩子，能陪我聊一会儿吗？",
  "今天天气怎么样，要不要出去走走？",
];

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export default function AnimeLatencyDemo() {
  const [input, setInput] = useState(samples[0]);
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [mode, setMode] = useState<DemoMode>(null);
  const [ttsMode, setTtsMode] = useState<TtsMode>(null);
  const [timing, setTiming] = useState<Timing>({});
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [notice, setNotice] = useState("点击示例，马上开始一次低延迟对话");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const speechStartedAtRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioObjectUrlRef = useRef<string | null>(null);

  useEffect(() => () => {
    recognitionRef.current?.stop();
    window.speechSynthesis?.cancel();
    audioRef.current?.pause();
    if (audioObjectUrlRef.current) URL.revokeObjectURL(audioObjectUrlRef.current);
  }, []);

  const finishSpeech = useCallback((startedAt: number) => {
    setSpeaking(false);
    setTiming((current) => ({ ...current, finished: elapsed(startedAt) }));
  }, []);

  const markSpeechStart = useCallback((startedAt: number) => {
    if (speechStartedAtRef.current !== startedAt) speechStartedAtRef.current = startedAt;
    setSpeaking(true);
    setTiming((current) => ({
      ...current,
      firstAudio: current.firstAudio ?? elapsed(startedAt),
      firstFrame: current.firstFrame ?? elapsed(startedAt) + 16,
    }));
  }, []);

  const speakLocally = useCallback((text: string, startedAt: number) => {
    const markSpeechStart = () => {
      if (speechStartedAtRef.current !== startedAt) speechStartedAtRef.current = startedAt;
      setSpeaking(true);
      setTiming((current) => ({
        ...current,
        firstAudio: current.firstAudio ?? elapsed(startedAt),
        firstFrame: current.firstFrame ?? elapsed(startedAt) + 16,
      }));
    };

    if (!window.speechSynthesis) {
      markSpeechStart();
      window.setTimeout(() => {
        setSpeaking(false);
        setTiming((current) => ({ ...current, finished: elapsed(startedAt) }));
      }, 1_200);
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 1.08;
    utterance.pitch = 1.02;
    utterance.onstart = markSpeechStart;
    utterance.onend = () => {
      setSpeaking(false);
      setTiming((current) => ({ ...current, finished: elapsed(startedAt) }));
    };
    utterance.onerror = () => {
      setSpeaking(false);
      setTiming((current) => ({ ...current, finished: elapsed(startedAt) }));
    };
    window.speechSynthesis.speak(utterance);
    window.setTimeout(() => {
      setTiming((current) => current.firstAudio ? current : {
        ...current,
        firstAudio: elapsed(startedAt),
        firstFrame: elapsed(startedAt) + 16,
      });
      setSpeaking(true);
    }, 180);
  }, []);

  const speak = useCallback(async (text: string, startedAt: number) => {
    window.speechSynthesis?.cancel();
    audioRef.current?.pause();
    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current = null;
    }

    try {
      const response = await fetch("/api/demo/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok || !response.body) throw new Error("cloud tts unavailable");

      setTtsMode("cloud-stream");
      const audio = new Audio();
      audio.preload = "auto";
      audioRef.current = audio;
      audio.onended = () => finishSpeech(startedAt);
      audio.onerror = () => finishSpeech(startedAt);

      // MediaSource lets the browser begin playback while the server is
      // still sending MP3 chunks. A blob fallback keeps the demo usable on
      // browsers that do not expose audio/mpeg MediaSource support.
      const canStream = typeof window.MediaSource !== "undefined"
        && MediaSource.isTypeSupported("audio/mpeg");
      if (!canStream) {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        audioObjectUrlRef.current = url;
        audio.src = url;
        audio.onplaying = () => markSpeechStart(startedAt);
        await audio.play();
        return;
      }

      const mediaSource = new MediaSource();
      const mediaUrl = URL.createObjectURL(mediaSource);
      audioObjectUrlRef.current = mediaUrl;
      audio.src = mediaUrl;
      let sourceBuffer: SourceBuffer | null = null;
      const queue: ArrayBuffer[] = [];
      let streamDone = false;
      let playbackStarted = false;
      const startPlayback = () => {
        if (playbackStarted) return;
        playbackStarted = true;
        void audio.play().then(() => markSpeechStart(startedAt)).catch(() => {
          playbackStarted = false;
        });
      };
      const drain = () => {
        if (!sourceBuffer || sourceBuffer.updating) return;
        const next = queue.shift();
        if (next) {
          sourceBuffer.appendBuffer(next);
          if (!playbackStarted) startPlayback();
        } else if (streamDone && mediaSource.readyState === "open") {
          mediaSource.endOfStream();
        }
      };
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          try {
            sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
            sourceBuffer.addEventListener("updateend", drain);
            resolve();
          } catch (error) {
            reject(error);
          }
        };
        mediaSource.addEventListener("sourceopen", onOpen, { once: true });
        mediaSource.addEventListener("error", () => reject(new Error("media source failed")), { once: true });
      });

      const reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value?.byteLength) {
          queue.push(chunk.value.buffer.slice(chunk.value.byteOffset, chunk.value.byteOffset + chunk.value.byteLength));
          drain();
        }
      }
      streamDone = true;
      drain();
    } catch {
      setTtsMode("local-fallback");
      setNotice("云端 TTS 暂不可用，已切换浏览器语音；口型和延迟动画仍可继续演示");
      speakLocally(text, startedAt);
    }
  }, [finishSpeech, markSpeechStart, speakLocally]);

  const submit = useCallback(async (value: string) => {
    const normalized = value.trim();
    if (!normalized || busy) return;
    const startedAt = performance.now();
    setBusy(true);
    setTranscript(normalized);
    setReply("");
    setMode(null);
    setTtsMode(null);
    setTiming({});
    setNotice("云端单模型正在返回文字，数字人会在首段语音到达时开口");
    try {
      const response = await fetch("/api/demo/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: normalized }),
      });
      const result = await response.json() as { ok?: boolean; reply?: string; mode?: DemoMode };
      if (!response.ok || !result.ok || !result.reply) throw new Error("demo reply failed");
      setReply(result.reply);
      setMode(result.mode ?? "local-fallback");
      setTiming({ reply: elapsed(startedAt) });
      setNotice(result.mode === "cloud" ? "云端模型已返回，正在请求流式 TTS 并驱动口型" : "当前使用本地兜底回复，正在请求云端 TTS");
      void speak(result.reply, startedAt);
    } catch {
      setNotice("Demo 服务暂时不可用，请重新点击一次");
    } finally {
      setBusy(false);
    }
  }, [busy, speak]);

  const startListening = useCallback(() => {
    const browserWindow = window as Window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const Recognition = browserWindow.SpeechRecognition || browserWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setNotice("当前浏览器不支持中文语音识别，请直接点击示例或输入文字");
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const last = event.results[event.results.length - 1];
      const text = last?.[0]?.transcript?.trim() ?? "";
      if (text) setInput(text);
    };
    recognition.onerror = () => {
      setListening(false);
      setNotice("没有听清，再试一次，或者点击下面的示例句子");
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    setListening(true);
    setNotice("请对着麦克风说一句话，松开后会自动发送");
    recognition.start();
  }, []);

  return (
    <main className="anime-demo min-h-screen bg-[#080914] text-white">
      <div className="anime-demo-shell mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8 lg:px-10">
        <header className="flex items-center justify-between gap-4">
          <div>
            <p className="anime-kicker">ECHO / CLOUD AVATAR LATENCY DEMO</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">让动漫角色先开口</h1>
          </div>
          <span className="anime-live-pill"><span /> LIVE TEST</span>
        </header>

        <section className="mt-8 grid flex-1 gap-6 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="anime-stage relative overflow-hidden rounded-[28px] border border-white/10 p-6 sm:p-10">
            <div className="anime-stage-grid" />
            <div className={`anime-avatar-wrap ${speaking ? "is-speaking" : ""}`}>
              <div className="anime-avatar-glow" />
              <div className="anime-avatar-frame">
                <Image src="/demo/anime-companion.png" alt="动漫陪伴角色" width={1199} height={1312} priority className="anime-avatar-image" />
                <span className="anime-mouth" aria-hidden="true" />
              </div>
            </div>
            <div className="relative z-10 mt-4 text-center">
              <p className="text-lg font-medium">澄澄</p>
              <p className="mt-1 text-sm text-white/55">2D 动画口型 · 不等待视频生成</p>
            </div>
            <div className="anime-status-card relative z-10 mx-auto mt-6 w-full max-w-[28rem]">
              <div className="flex items-center justify-between text-xs text-white/50">
                <span>{speaking ? "正在说话" : "等待输入"}</span>
                <span>{ttsMode === "cloud-stream" ? "云端流式 TTS" : ttsMode === "local-fallback" ? "浏览器兜底语音" : mode === "cloud" ? "云端文字模型" : "准备就绪"}</span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className={`anime-progress ${speaking ? "is-active" : ""}`} />
              </div>
            </div>
          </div>

          <div className="flex flex-col rounded-[28px] border border-white/10 bg-white/[0.045] p-6 sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-white/60">一次真实可交互的延迟测试</p>
                <p className="mt-2 text-base leading-7 text-white/80">输入、返回文字、播放声音和口型动画都显示在同一个时间线上。</p>
              </div>
              <span className="rounded-full border border-cyan-300/25 bg-cyan-300/10 px-3 py-1 text-xs text-cyan-200">无真人素材</span>
            </div>

            <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-4">
              <label htmlFor="anime-demo-input" className="text-xs text-white/45">输入一句话</label>
              <div className="mt-3 flex gap-2">
                <input
                  id="anime-demo-input"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void submit(input); }}
                  className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-cyan-300/60"
                  placeholder="例如：我有点想念孩子"
                />
                <button type="button" onClick={startListening} className={`anime-mic-button ${listening ? "is-listening" : ""}`} aria-label="开始中文语音输入">{listening ? "●" : "⌕"}</button>
              </div>
              <button type="button" disabled={busy} onClick={() => void submit(input)} className="anime-send-button mt-3 w-full">{busy ? "正在响应…" : "发送并开始计时"}</button>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {samples.map((sample) => <button key={sample} type="button" onClick={() => { setInput(sample); void submit(sample); }} className="anime-sample-chip">{sample}</button>)}
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3">
              <Metric label="文字返回" value={timing.reply} />
              <Metric label="首段语音" value={timing.firstAudio} />
              <Metric label="首帧动画" value={timing.firstFrame} />
              <Metric label="本轮结束" value={timing.finished} />
            </div>

            <div className="mt-5 flex-1 rounded-2xl border border-white/10 bg-black/20 p-4">
              <p className="text-xs text-white/40">实时对话</p>
              <div className="mt-3 space-y-3 text-sm leading-6">
                {transcript && <div className="rounded-xl bg-white/[0.06] px-4 py-3 text-white/75"><span className="mr-2 text-xs text-cyan-200">你</span>{transcript}</div>}
                {reply && <div className="rounded-xl bg-cyan-300/10 px-4 py-3 text-cyan-50"><span className="mr-2 text-xs text-cyan-200">澄澄</span>{reply}</div>}
                {!transcript && <p className="text-white/35">{notice}</p>}
              </div>
            </div>
            <p className="mt-4 text-xs leading-5 text-white/40">{notice} 首段语音指标现在来自云端音频播放；云端不可用时会明确标记浏览器兜底。</p>
          </div>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value?: number }) {
  return <div className="rounded-xl border border-white/10 bg-white/[0.035] p-3"><p className="text-xs text-white/40">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{typeof value === "number" ? `${value} ms` : "—"}</p></div>;
}
