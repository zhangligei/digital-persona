"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";

type DemoMode = "cloud" | "local-fallback" | null;

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
  const [timing, setTiming] = useState<Timing>({});
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [notice, setNotice] = useState("点击示例，马上开始一次低延迟对话");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const speechStartedAtRef = useRef<number | null>(null);

  useEffect(() => () => {
    recognitionRef.current?.stop();
    window.speechSynthesis?.cancel();
  }, []);

  const speak = useCallback((text: string, startedAt: number) => {
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

  const submit = useCallback(async (value: string) => {
    const normalized = value.trim();
    if (!normalized || busy) return;
    const startedAt = performance.now();
    setBusy(true);
    setTranscript(normalized);
    setReply("");
    setMode(null);
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
      setNotice(result.mode === "cloud" ? "云端模型已返回，正在播放语音并驱动口型" : "当前使用本地兜底回复，仍可观察动画和端到端计时");
      speak(result.reply, startedAt);
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
                <span>{mode === "cloud" ? "单模型云端" : mode === "local-fallback" ? "本地兜底" : "准备就绪"}</span>
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
            <p className="mt-4 text-xs leading-5 text-white/40">{notice} 这个页面优先展示响应速度；接入真实云端 TTS 时，口型动画可以继续复用。</p>
          </div>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value?: number }) {
  return <div className="rounded-xl border border-white/10 bg-white/[0.035] p-3"><p className="text-xs text-white/40">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{typeof value === "number" ? `${value} ms` : "—"}</p></div>;
}
