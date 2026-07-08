"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { gemma } from "@/lib/gemma";
import { tts } from "@/lib/tts";

type Slide = {
  spoken_text: string;
  slide_heading: string;
  slide_bullet: string;
};

type GeneratedAudio = {
  blob: Blob;
  durationSec: number;
};

type GpuPreflight = {
  checked: boolean;
  hasNavigatorGpu: boolean;
  secureContext: boolean;
  adapterAvailable: boolean;
  error: string | null;
};

const DEFAULT_PROMPT = "Accelerators in India";
const SCRIPT_GEN_TIMEOUT_MS = 240_000;

function parseSlidesFromLLM(raw: string): Slide[] {
  const startIndex = raw.indexOf("[");
  const endIndex = raw.lastIndexOf("]");
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error("LLM output did not contain a JSON array.");
  }

  const parsed = JSON.parse(raw.slice(startIndex, endIndex + 1));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Parsed script is empty.");
  }

  return parsed.map((item, idx) => {
    if (
      typeof item?.spoken_text !== "string" ||
      typeof item?.slide_heading !== "string" ||
      typeof item?.slide_bullet !== "string"
    ) {
      throw new Error(`Slide ${idx + 1} does not match required schema.`);
    }
    return {
      spoken_text: item.spoken_text.trim(),
      slide_heading: item.slide_heading.trim(),
      slide_bullet: item.slide_bullet.trim(),
    };
  });
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  const words = text.split(/\s+/);
  let line = "";
  let currentY = y;

  words.forEach((word) => {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line, x, currentY);
      line = word;
      currentY += lineHeight;
    } else {
      line = testLine;
    }
  });

  if (line) {
    ctx.fillText(line, x, currentY);
  }
}

function drawSlideToBlob(slide: Slide): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 854;
  canvas.height = 480;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas context is unavailable.");
  }

  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#0f172a");
  gradient.addColorStop(1, "#111827");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#1f2937";
  ctx.fillRect(54, 54, 746, 372);

  ctx.textAlign = "center";
  ctx.fillStyle = "#f9fafb";
  ctx.font = "bold 38px Arial";
  wrapText(ctx, slide.slide_heading, canvas.width / 2, 150, 670, 48);

  ctx.font = "24px Arial";
  ctx.fillStyle = "#d1d5db";
  wrapText(ctx, `• ${slide.slide_bullet}`, canvas.width / 2, 290, 700, 34);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to export slide as PNG."));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

async function getAudioDuration(blob: Blob): Promise<number> {
  const context = new AudioContext();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    return audioBuffer.duration;
  } finally {
    await context.close();
  }
}

export default function Home() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [isGenerating, setIsGenerating] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [slideCount, setSlideCount] = useState(0);
  const [modelProgressPct, setModelProgressPct] = useState(0);
  const [showModelProgress, setShowModelProgress] = useState(false);
  const [gpuPreflight, setGpuPreflight] = useState<GpuPreflight>({
    checked: false,
    hasNavigatorGpu: false,
    secureContext: false,
    adapterAvailable: false,
    error: null,
  });
  const ffmpegRef = useRef<unknown>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    let cancelled = false;

    const runPreflight = async () => {
      const secureContext = window.isSecureContext;
      const nav = navigator as Navigator & {
        gpu?: {
          requestAdapter: () => Promise<unknown>;
        };
      };
      const gpu = nav.gpu;

      const hasNavigatorGpu = typeof gpu !== "undefined";

      if (!secureContext || !hasNavigatorGpu) {
        if (!cancelled) {
          setGpuPreflight({
            checked: true,
            hasNavigatorGpu,
            secureContext,
            adapterAvailable: false,
            error: !secureContext
              ? "Page is not running in a secure context (HTTPS)."
              : "navigator.gpu is not available in this browser.",
          });
        }
        return;
      }

      try {
        if (!gpu) {
          return;
        }
        const adapter = await gpu.requestAdapter();
        if (!cancelled) {
          setGpuPreflight({
            checked: true,
            hasNavigatorGpu,
            secureContext,
            adapterAvailable: Boolean(adapter),
            error: adapter ? null : "No WebGPU adapter was returned by the browser.",
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!cancelled) {
          setGpuPreflight({
            checked: true,
            hasNavigatorGpu,
            secureContext,
            adapterAvailable: false,
            error: `WebGPU adapter request failed: ${message}`,
          });
        }
      }
    };

    runPreflight();

    return () => {
      cancelled = true;
    };
  }, []);

  const canRunGemma4 = gpuPreflight.checked && gpuPreflight.secureContext && gpuPreflight.adapterAvailable;

  const PIPELINE_STEPS = [
    { label: "Script", num: "1" },
    { label: "Visuals", num: "2" },
    { label: "Audio", num: "3" },
    { label: "Render", num: "4" },
  ];

  const activeStep: number =
    ({
      "Writing Script": 0,
      "Generating Visuals": 1,
      "Generating Audio": 2,
      "Rendering Video": 3,
      Done: 4,
    } as Record<string, number>)[status] ?? -1;

  const statusColor =
    status === "Done"
      ? "text-emerald-400 bg-emerald-400/10 border-emerald-400/20"
      : status === "Failed"
        ? "text-red-400 bg-red-400/10 border-red-400/20"
        : status === "Idle"
          ? "text-slate-400 bg-slate-800/60 border-slate-700"
          : "text-amber-400 bg-amber-400/10 border-amber-400/20";

  const appendLog = (line: string) => {
    console.log(`[stuni-web] ${line}`);
    setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()}  ${line}`]);
  };

  const generateVideo = async () => {
    if (!prompt.trim() || isGenerating) {
      return;
    }

    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
      setVideoUrl(null);
    }

    setSlideCount(0);
    setLogs([]);
    setModelProgressPct(0);
    setShowModelProgress(false);
    setIsGenerating(true);
    setStatus("Loading AI");
    appendLog("Starting generation pipeline.");

    try {
      setStatus("Writing Script");
      const llmPrompt = `You are an educational scriptwriter for short explainer videos.
Return valid raw JSON only. Do not use markdown, code fences, or extra text.
Generate 3 slides in this exact format:
[{"spoken_text":"...","slide_heading":"...","slide_bullet":"..."}]

Keep each spoken_text under 18 words.
Keep each slide_heading under 8 words.
Keep each slide_bullet to a single concise line.

Topic: ${prompt}`;

      appendLog("Step 1/4: Loading Gemma 4 (first load downloads ~1.5GB, cached after).");
      setShowModelProgress(true);
      await gemma.load((p) => {
        const progress = p.progress;
        if (typeof progress === "number") {
          setModelProgressPct(Math.max(0, Math.min(100, Math.round(progress))));
        }
        if (typeof p.file === "string" && typeof progress === "number") {
          appendLog(`Model: ${p.file} ${Math.round(progress)}%`);
        }
      });
      setShowModelProgress(false);

      appendLog("Gemma 4 ready. Generating script.");

      let rawScript = "";
      let tokenCount = 0;
      let lastHeartbeat = Date.now();

      await Promise.race([
        gemma.generate({
          messages: [{ role: "user", content: llmPrompt }],
          max_new_tokens: 320,
          onToken: (token) => {
            rawScript += token;
            tokenCount += 1;

            const now = Date.now();
            if (now - lastHeartbeat >= 3000) {
              appendLog(`Script generation in progress... (${tokenCount} tokens)`);
              lastHeartbeat = now;
            }
          },
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("Script generation timed out after 4 minutes. Please retry."));
          }, SCRIPT_GEN_TIMEOUT_MS);
        }),
      ]);

      appendLog(`LLM raw output received (${rawScript.length} chars).`);
      const slides = parseSlidesFromLLM(rawScript);
      setSlideCount(slides.length);
      appendLog(`Parsed ${slides.length} slides from script JSON.`);

      setStatus("Generating Visuals");
      appendLog("Step 2/4: Drawing slides on hidden canvas.");
      const slideImages: Blob[] = [];
      for (let i = 0; i < slides.length; i += 1) {
        const imageBlob = await drawSlideToBlob(slides[i]);
        slideImages.push(imageBlob);
        appendLog(`Rendered slide_${i + 1}.png`);
      }

      setStatus("Generating Audio");
      appendLog("Step 3/4: Generating audio with local TTS worker.");
      const audioFiles: GeneratedAudio[] = [];
      for (let i = 0; i < slides.length; i += 1) {
        const wavBlob = await tts.synthesize(slides[i].spoken_text);
        const durationSec = await getAudioDuration(wavBlob);
        audioFiles.push({ blob: wavBlob, durationSec });
        appendLog(`Generated audio_${i + 1}.wav (${durationSec.toFixed(2)}s)`);
      }

      setStatus("Rendering Video");
      appendLog("Step 4/4: Loading FFmpeg.wasm.");
      if (!ffmpegRef.current) {
        const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([
          import("@ffmpeg/ffmpeg"),
          import("@ffmpeg/util"),
        ]);
        const ffmpeg = new FFmpeg();
        ffmpeg.on("log", ({ message }) => appendLog(`ffmpeg: ${message}`));
        await ffmpeg.load({
          coreURL: await toBlobURL(
            "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js",
            "text/javascript",
          ),
          wasmURL: await toBlobURL(
            "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm",
            "application/wasm",
          ),
        });
        ffmpegRef.current = { ffmpeg, fetchFile };
      } else {
        appendLog("FFmpeg already initialized. Reusing runtime.");
      }

      const { ffmpeg, fetchFile } = ffmpegRef.current as {
        ffmpeg: {
          writeFile: (name: string, data: Uint8Array) => Promise<void>;
          exec: (args: string[]) => Promise<number>;
          readFile: (name: string) => Promise<Uint8Array>;
          deleteFile: (name: string) => Promise<void>;
        };
        fetchFile: (file: Blob) => Promise<Uint8Array>;
      };

      const segmentNames: string[] = [];
      for (let i = 0; i < slides.length; i += 1) {
        const slideName = `slide_${i + 1}.png`;
        const audioName = `audio_${i + 1}.wav`;
        const segmentName = `segment_${i + 1}.mp4`;
        segmentNames.push(segmentName);

        await ffmpeg.writeFile(slideName, await fetchFile(slideImages[i]));
        await ffmpeg.writeFile(audioName, await fetchFile(audioFiles[i].blob));
        const segmentExitCode = await ffmpeg.exec([
          "-loop",
          "1",
          "-i",
          slideName,
          "-i",
          audioName,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-profile:v",
          "baseline",
          "-level",
          "3.0",
          "-crf",
          "30",
          "-pix_fmt",
          "yuv420p",
          "-r",
          "12",
          "-c:a",
          "aac",
          "-b:a",
          "96k",
          "-shortest",
          "-t",
          audioFiles[i].durationSec.toFixed(3),
          segmentName,
        ]);

        if (segmentExitCode !== 0) {
          throw new Error(
            `FFmpeg failed while rendering ${segmentName} (exit ${segmentExitCode}). Try shorter text or fewer slides.`,
          );
        }

        appendLog(`Rendered ${segmentName}`);

        await ffmpeg.deleteFile(slideName).catch(() => undefined);
        await ffmpeg.deleteFile(audioName).catch(() => undefined);
      }

      const concatFile = segmentNames.map((name) => `file '${name}'`).join("\n");
      await ffmpeg.writeFile("segments.txt", new TextEncoder().encode(concatFile));
      const concatExitCode = await ffmpeg.exec([
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        "segments.txt",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "stuni_explainer.mp4",
      ]);

      if (concatExitCode !== 0) {
        throw new Error(
          `FFmpeg failed while concatenating segments (exit ${concatExitCode}).`,
        );
      }

      for (const segmentName of segmentNames) {
        await ffmpeg.deleteFile(segmentName).catch(() => undefined);
      }
      await ffmpeg.deleteFile("segments.txt").catch(() => undefined);

      const output = await ffmpeg.readFile("stuni_explainer.mp4");
      const outputBytes = output instanceof Uint8Array ? new Uint8Array(output) : output;
      // Avoid allocating a second full-size copy of the rendered video in memory.
      const outputUrl = URL.createObjectURL(
        new Blob([outputBytes], { type: "video/mp4" }),
      );
      setVideoUrl(outputUrl);
      setStatus("Done");
      appendLog("Pipeline complete. Video is ready.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error.";
      setStatus("Failed");
      appendLog(`Pipeline failed: ${message}`);
    } finally {
      setShowModelProgress(false);
      setIsGenerating(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 relative overflow-x-hidden">
      <div className="fixed inset-0 -z-10 bg-[radial-gradient(ellipse_80%_55%_at_50%_-5%,rgba(99,102,241,0.13),transparent)]" />
      <div
        className="fixed inset-0 -z-10 opacity-40"
        style={{
          backgroundImage:
            "radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />

      <div className="relative max-w-3xl mx-auto px-4 py-12 space-y-6">
        <header className="text-center space-y-3 pb-2">
          <div className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 mb-1">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse inline-block" />
            Gemma 4 · Local TTS · FFmpeg.wasm
          </div>
          <h1
            className="text-6xl font-extrabold tracking-tight"
            style={{
              background: "linear-gradient(to bottom, #fff 30%, #94a3b8)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            stuni
          </h1>
          <p className="text-slate-500 text-sm">
            Type a topic. Get a fully narrated explainer video.
          </p>
          <div>
            <Link href="/chat" className="text-xs text-indigo-300 underline">
              Open stuni chat
            </Link>
          </div>
        </header>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 backdrop-blur-sm p-6 space-y-4 shadow-2xl shadow-black/50">
          <div className="flex items-center justify-between">
            <label
              htmlFor="prompt"
              className="text-xs font-semibold text-slate-400 uppercase tracking-widest"
            >
              Topic
            </label>
            {slideCount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/20">
                {slideCount} slides
              </span>
            )}
          </div>

          <textarea
            id="prompt"
            className="w-full h-36 rounded-xl border border-slate-700/80 bg-slate-950/80 p-4 text-sm text-slate-100 placeholder-slate-600 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 resize-none transition-colors"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. How does the immune system work?"
            disabled={isGenerating}
          />

          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-slate-400 uppercase tracking-widest">WebGPU Preflight</span>
              {canRunGemma4 ? (
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  Ready
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                  Blocked
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
              <div className="rounded-md border border-slate-800 px-2 py-1 text-slate-300">
                HTTPS: {gpuPreflight.secureContext ? "yes" : "no"}
              </div>
              <div className="rounded-md border border-slate-800 px-2 py-1 text-slate-300">
                navigator.gpu: {gpuPreflight.hasNavigatorGpu ? "yes" : "no"}
              </div>
              <div className="rounded-md border border-slate-800 px-2 py-1 text-slate-300">
                Adapter: {gpuPreflight.adapterAvailable ? "yes" : "no"}
              </div>
            </div>
            {!canRunGemma4 && gpuPreflight.checked && (
              <p className="text-amber-300/90">{gpuPreflight.error || "WebGPU checks failed."}</p>
            )}
            {!gpuPreflight.checked && (
              <p className="text-slate-500">Checking browser capabilities...</p>
            )}
          </div>

          {showModelProgress && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-slate-400">
                <span>Downloading model</span>
                <span>{modelProgressPct}%</span>
              </div>
              <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${modelProgressPct}%` }}
                />
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={generateVideo}
            disabled={isGenerating || !prompt.trim() || !canRunGemma4}
            className="group relative w-full rounded-xl px-4 py-3.5 font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden"
          >
            <span className="absolute inset-0 bg-gradient-to-r from-indigo-600 to-violet-600 group-hover:from-indigo-500 group-hover:to-violet-500 transition-all duration-200" />
            <span
              className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity"
              style={{
                background:
                  "radial-gradient(circle at 50% 120%, rgba(120,119,198,0.35), transparent 60%)",
              }}
            />
            <span className="relative flex items-center justify-center gap-2">
              {isGenerating ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  {status}…
                </>
              ) : (
                <>
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  Generate Video
                </>
              )}
            </span>
          </button>
        </div>

        {(isGenerating || status === "Done" || status === "Failed") && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur-sm px-6 py-5">
            <div className="flex items-center">
              {PIPELINE_STEPS.map((step, i) => {
                const isDone = activeStep > i;
                const isActive = activeStep === i;
                const isFailed = status === "Failed" && isActive;
                return (
                  <div key={step.label} className="flex items-center flex-1 last:flex-none">
                    <div className="flex flex-col items-center gap-1.5">
                      <div
                        className={[
                          "w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold border transition-all duration-300",
                          isFailed
                            ? "bg-red-500/15 text-red-400 border-red-500/40"
                            : isDone
                              ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/40"
                              : isActive
                                ? "bg-indigo-500/20 text-indigo-300 border-indigo-500/50 animate-pulse"
                                : "bg-slate-800/80 text-slate-600 border-slate-700/60",
                        ].join(" ")}
                      >
                        {isDone ? "✓" : isFailed ? "✕" : step.num}
                      </div>
                      <span
                        className={[
                          "text-xs font-medium",
                          isFailed
                            ? "text-red-400"
                            : isDone
                              ? "text-emerald-400"
                              : isActive
                                ? "text-indigo-300"
                                : "text-slate-600",
                        ].join(" ")}
                      >
                        {step.label}
                      </span>
                    </div>
                    {i < PIPELINE_STEPS.length - 1 && (
                      <div
                        className={`h-px flex-1 mx-3 mb-5 transition-all duration-500 ${
                          isDone ? "bg-emerald-500/30" : "bg-slate-800"
                        }`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-2xl border border-slate-800 bg-[#070b11] overflow-hidden">
            <div className="flex items-center gap-1.5 px-4 py-3 border-b border-slate-800/80">
              <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
              <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
              <span className="w-3 h-3 rounded-full bg-[#28c840]" />
              <span className="ml-3 text-[11px] text-slate-600 font-mono flex-1">pipeline.log</span>
              <span className={`text-[10px] px-2 py-0.5 rounded border font-mono font-medium ${statusColor}`}>
                {status}
              </span>
            </div>
            <div className="p-4 h-64 overflow-y-auto space-y-px font-mono text-[11px] leading-5">
              {logs.length === 0 ? (
                <p className="text-slate-700 italic">Waiting for pipeline to start…</p>
              ) : (
                logs.map((line, i) => (
                  <p key={i} className="text-emerald-400/90">
                    <span className="text-slate-700 select-none mr-1">›</span>
                    {line}
                  </p>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden flex flex-col">
            {videoUrl ? (
              <>
                <video controls className="w-full">
                  <source src={videoUrl} type="video/mp4" />
                </video>
                <div className="px-4 py-3 flex items-center justify-between border-t border-slate-800">
                  <span className="text-[11px] text-slate-500 font-mono">stuni_explainer.mp4</span>
                  <a
                    href={videoUrl}
                    download="stuni_explainer.mp4"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-xs font-semibold transition-colors"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Download
                  </a>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center flex-1 min-h-[16rem] gap-4">
                <div className="w-16 h-16 rounded-2xl border border-slate-800 bg-slate-900/80 flex items-center justify-center text-slate-700">
                  <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                    <line x1="7" y1="2" x2="7" y2="22" />
                    <line x1="17" y1="2" x2="17" y2="22" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <line x1="2" y1="7" x2="7" y2="7" />
                    <line x1="2" y1="17" x2="7" y2="17" />
                    <line x1="17" y1="17" x2="22" y2="17" />
                    <line x1="17" y1="7" x2="22" y2="7" />
                  </svg>
                </div>
                <div className="text-center">
                  <p className="text-sm text-slate-500">No video yet</p>
                  <p className="text-xs text-slate-700 mt-0.5">Generate one above to see it here</p>
                </div>
              </div>
            )}
          </div>
        </div>

        <footer className="text-center text-[11px] text-slate-800 pb-2">
          stuni-web · Gemma 4 · Local TTS · FFmpeg.wasm
        </footer>
      </div>
    </div>
  );
}
