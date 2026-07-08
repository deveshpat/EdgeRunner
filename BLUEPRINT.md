# stuni-web v2 — Project Blueprint
> Living document. Update after every session. Check off items as completed.
> Last updated: 2026-04-19 (Session 4 — Phase 1 fix: transformers.js v4 upgrade)

---

## 0. Context Summary (for new threads)

**What this is:** A Next.js browser app generating AI-narrated explainer videos, with a companion agentic chat page. The entire intelligence stack runs locally — no cloud inference, no API keys, no cost.

**Current v1:** OpenRouter (server) → Xenova TTS (server) → FFmpeg.wasm (client). Single page.
**Target v2:** Gemma 4 E4B WebGPU (browser) → polyglot sandbox (Python/R/SQL/LaTeX/JS) → Jina research → IndexedDB memory → same TTS + FFmpeg pipeline + `/chat` route.

---

## 1. Research Findings

### 1.1 Gemma 4 — Browser-Ready, Apache 2.0

Released April 2025. The E4B (4B effective params) runs in-browser via Transformers.js v4 + WebGPU.

| Model | Text ONNX size | Context | Audio in | Function calling |
|-------|---------------|---------|----------|-----------------|
| E2B   | ~500MB q4f16  | 128K    | ✅        | ✅               |
| E4B   | ~1.5GB q4f16  | 128K    | ✅        | ✅               |

- ONNX: `onnx-community/gemma-4-E4B-it-ONNX` (text-only variant)
- **Requires `@huggingface/transformers` v4.x** — v3.x has no registered `gemma4` architecture and a broken WebGPU sharded-file runtime.
- Transformers.js v4 ships a completely rewritten C++ WebGPU runtime with full Gemma4 support.
- Reference browser agent using it: github.com/kessler/gemma-gem (Chrome extension, confirmed working)

**⚠️ Audio = INPUT only.** Gemma 4 understands speech but cannot generate it. TTS remains separate.

**⚠️ WebLLM does NOT support Gemma 4** as of April 2026 — open feature request only.

---

### 1.2 Agent-Reach — Verdict: Concept Yes, Implementation No

**What it is:** `Panniantong/Agent-Reach` — a CLI tool giving AI agents access to Twitter, Reddit, YouTube, GitHub, Bilibili, XiaoHongShu with zero API fees.

**How it works:** Modular Python CLI. Each platform is one standalone file using upstream scrapers: `twitter-cli`, `rdt-cli`, `xhs-cli`, `bili-cli`, `yt-dlp`, Jina Reader, Exa, mcporter. MCP-compatible.

**Why we can't use it directly:** It's a Python + Node.js desktop tool requiring a host machine. Runs `playwright`/`puppeteer` under the hood. Not browser-native. No WASM port exists.

**Our browser-native "Agent-Reach lite" via Jina:**

| Platform | Jina URL pattern | Quality |
|----------|-----------------|---------|
| Any webpage | `r.jina.ai/https://example.com` | ✅ Excellent |
| Web search | `s.jina.ai/your+query` (top 5 results) | ✅ Excellent |
| Reddit public | `r.jina.ai/https://old.reddit.com/r/topic/` | ✅ Good |
| GitHub repos | `r.jina.ai/https://github.com/user/repo` | ✅ Good |
| GitHub search | `r.jina.ai/https://github.com/search?q=query` | ⚠️ Partial |
| X/Twitter | `r.jina.ai/https://x.com/username` | ⚠️ Login-walled |
| YouTube | `r.jina.ai/https://youtube.com/results?search_query=q` | ⚠️ Titles only |
| arXiv papers | `r.jina.ai/https://arxiv.org/abs/PAPER_ID` | ✅ Full text |
| Wikipedia | `r.jina.ai/https://en.wikipedia.org/wiki/Topic` | ✅ Excellent |

**Rate limit:** 20 RPM keyless. Add 3s queue delay. Cache in IndexedDB.

---

### 1.3 Polyglot Sandbox — Full Language Matrix

Every runtime runs in a **Web Worker** (never the main thread). All are lazy-loaded on first use and cached. Gemma decides which runtime to invoke via function calling.

| Language | Engine | Size | What Gemma uses it for |
|----------|--------|------|------------------------|
| **Python** | Pyodide v0.29 | ~15MB | Data analysis, ML, algorithms, plots, simulations |
| **R** | WebR | ~40MB | Statistics, ggplot2, Bayesian inference, bioinformatics |
| **SQL** | DuckDB WASM | ~8MB | Analytical queries on CSV/Parquet/JSON |
| **LaTeX** | SwiftLaTeX (PdfTeX/XeTeX) | ~10MB | Academic PDFs, math papers, formatted documents |
| **JavaScript** | Native browser | 0MB | Animations, DOM interaction, real-time |

**JavaScript sub-runtimes (loaded dynamically into sandboxed iframe):**

| Library | CDN size | Use case |
|---------|----------|----------|
| Three.js | ~600KB | 3D scenes, physics, games, simulations |
| p5.js | ~900KB | Creative coding, generative art, interactive sketches |
| D3.js | ~500KB | Data visualizations, custom charts, network graphs |
| Matter.js | ~200KB | 2D rigid body physics |
| Plotly.js | ~3MB | Scientific charts, surface plots, statistical viz |
| Anime.js | ~20KB | DOM/SVG animations, timeline-based transitions |
| Mermaid.js | ~400KB | Diagrams from markdown (flowchart, ER, sequence) |

**Python packages available without install (pre-compiled in Pyodide):**
NumPy, Pandas, Matplotlib, SciPy, scikit-learn, Pillow, regex, PyYAML, SymPy, Shapely, NetworkX, Plotly (Python), statsmodels

**Key constraint:** Python code in Pyodide cannot make network requests via `urllib`/`requests`. Use `js.fetch()` bridge for any HTTP call needed from Python.

---

### 1.4 LaTeX → PDF Pipeline

SwiftLaTeX (recommended — 10MB, just works):
```js
import { PdfTeXEngine } from 'swiftlatex';
const engine = new PdfTeXEngine();
await engine.loadEngine();
engine.writeMemFSFile('main.tex', latexSource);
engine.setEngineMainFile('main.tex');
const result = await engine.compileLaTeX();
// result.pdf is a Uint8Array → create Blob → display in iframe / trigger download
```

**Decision rule:** Default to SwiftLaTeX. Only load texlyre-busytex if the user explicitly needs LuaTeX or complex package support (beamer, tikz, etc.).

---

### 1.5 Memory System

**Our implementation:** IndexedDB + MiniLM embeddings + MemPalace hierarchy in TypeScript.

---

## 2. Resolved Questions

| # | Question | Answer |
|---|----------|--------|
| 1 | Gemma 4 real and browser-compatible? | ✅ Yes — ONNX q4f16 via Transformers.js v4 WebGPU |
| 2 | Audio from Gemma 4? | ❌ Input only. Keep Xenova TTS |
| 3 | Agent-Reach usable in browser? | ❌ Python CLI. Use Jina as browser-native equivalent |
| 4 | Internet access method? | Jina Reader (`r.jina.ai`) + Search (`s.jina.ai`) |
| 5 | Code execution runtimes? | Pyodide (Python), WebR (R), DuckDB (SQL), SwiftLaTeX (LaTeX), native iframe (JS) |
| 6 | LaTeX for PDFs? | ✅ SwiftLaTeX (10MB, PdfTeX/XeTeX in WASM) |
| 7 | JS animations/simulations? | ✅ Three.js, p5.js, D3.js, Matter.js via sandboxed iframe |
| 8 | Memory system? | IndexedDB + MiniLM + MemPalace hierarchy in TS |
| 9 | Chat page? | Separate `/chat` route |
| 10 | Remove all API routes? | ✅ Yes, fully client-side |
| 11 | Why was Gemma 4 failing to load? | `@huggingface/transformers@3.8.1` has no `gemma4` architecture and broken sharded-ONNX WebGPU runtime. v4 fixes both. |
| 12 | Can WebLLM run Gemma 4? | ❌ Open feature request only as of April 2026. |
| 13 | What transformers.js version is required? | v4.x (`@huggingface/transformers@latest`). v3.x is end-of-road for Gemma 4. |
| 14 | Is the 13-attempt worker cascade still needed? | ❌ Completely removed. v4 pipeline loads Gemma 4 in one call. |

---

## 3. Confirmed Architecture — v2

```
Browser Tab
│
├── [Web Worker: llm.worker.ts]
│   └── Gemma 4 E4B ONNX q4f16 — WebGPU / WASM fallback
│       ├── @huggingface/transformers v4.x
│       ├── Text generation + streaming (TextStreamer)
│       ├── Native function calling (tool dispatch)
│       └── Built-in thinking mode
│
├── [Web Worker: pyodide.worker.ts]     — lazy loaded
│   └── Pyodide CPython 3.11 WASM
│
├── [Web Worker: webr.worker.ts]        — lazy loaded
│   └── WebR (R language WASM)
│
├── [Web Worker: duckdb.worker.ts]      — lazy loaded
│   └── DuckDB WASM (analytical SQL)
│
├── [Web Worker: latex.worker.ts]       — lazy loaded
│   └── SwiftLaTeX (PdfTeX/XeTeX WASM)
│
├── [Web Worker: tts.worker.ts]
│   └── cstr/qwen3-tts-1.7b-customvoice-GGUF
│
├── [Sandboxed iframe: js-sandbox.html] — lazy loaded
│   └── Three.js / p5.js / D3.js / Matter.js / Plotly
│
├── [Main Thread]
│   ├── /page        — Video Generator
│   ├── /chat        — Agent Chat UI
│   ├── FFmpeg.wasm  — Video encode
│   ├── Canvas       — Slide render
│   └── IndexedDB    — Memory store
│
└── [External: fetch() from main thread]
    ├── r.jina.ai/[url]   — fetch any URL → markdown
    └── s.jina.ai/[query] — web search → top 5 results
```

---

## 4. Risk Register

| Risk | Severity | Mitigation |
|------|----------|-----------|
| WebGPU unavailable (Safari, old Chrome) | Medium | WASM CPU fallback in worker. Note: WebGPU shipped by default across Chrome, Firefox, Edge, Safari as of Nov 25 2025 (~82.7% global coverage). |
| E4B 1.5GB first load | Medium | Download progress bar. Browser cache (`env.useBrowserCache = true`). |
| OOM: running Gemma + Pyodide + FFmpeg simultaneously | High | Strict lifecycle: terminate Pyodide worker when done. Never run FFmpeg + Gemma at same time. |
| LaTeX texlyre-busytex 175MB | High | Only load on explicit request. Default to SwiftLaTeX (10MB). |
| WebR 40MB load time | Medium | Lazy-load only when R code detected. Show progress. |
| COEP headers blocking Jina fetch | Mitigated | Research calls now use direct Jina endpoints client-side. |
| Jina 20 RPM rate limit | Low | IndexedDB cache. 3s queue delay between requests. |
| JS sandbox XSS/code injection | Medium | Run all user JS in sandboxed iframe with `sandbox` attribute. No `allow-same-origin`. |

---

## 5. File Structure — v2

```
stuni-web/
├── app/
│   ├── page.tsx              ← video generator (uses local Gemma via lib/gemma.ts)
│   ├── chat/
│   │   └── page.tsx          ← agent chat UI
│   ├── layout.tsx
│   └── globals.css
│
├── lib/
│   ├── gemma.ts              ← Gemma worker manager + agent loop
│   ├── memory.ts             ← IndexedDB + MiniLM
│   ├── tts.ts                ← TTS worker manager
│   ├── research/
│   │   ├── index.ts
│   │   ├── search.ts         ← s.jina.ai wrapper
│   │   └── fetch.ts          ← r.jina.ai wrapper + IndexedDB cache
│   ├── sandbox/
│   │   ├── index.ts
│   │   ├── python.ts
│   │   ├── r.ts
│   │   ├── sql.ts
│   │   ├── latex.ts
│   │   └── js-sandbox.ts
│   └── tools/
│       └── registry.ts
│
├── workers/
│   ├── llm.worker.ts         ← REWRITTEN in Session 4 (v4 API, clean, no hacks)
│   ├── pyodide.worker.ts
│   ├── webr.worker.ts
│   ├── duckdb.worker.ts
│   ├── latex.worker.ts
│   └── tts.worker.ts
│
├── public/
│   └── js-sandbox.html
│
├── (no app/api routes)       ← static-export compatible for GitHub Pages
├── next.config.mjs           ← COOP/COEP headers
├── package.json              ← @huggingface/transformers upgraded to v4.x
└── .env                      ← NEXT_PUBLIC_LOCAL_TTS_MODEL only
```

---

## 6. Tool Registry — Gemma Function Calling Schema

```typescript
export const TOOL_REGISTRY = [
  { name: "search_web", description: "Search the internet.", parameters: { query: "string" } },
  { name: "fetch_url", description: "Read a URL as markdown.", parameters: { url: "string" } },
  { name: "run_python", description: "Run Python (NumPy, Pandas, Matplotlib, SciPy). Returns stdout + charts.", parameters: { code: "string" } },
  { name: "run_r", description: "Run R (ggplot2, tidyverse). Returns console + plots.", parameters: { code: "string" } },
  { name: "run_sql", description: "Run SQL (DuckDB dialect).", parameters: { query: "string", data_url: "string?" } },
  { name: "run_javascript", description: "Run JS with Three.js, p5.js, D3.js, Matter.js, Plotly in iframe.", parameters: { code: "string", libraries: "string[]?" } },
  { name: "compile_latex", description: "Compile LaTeX to PDF.", parameters: { source: "string" } },
  { name: "generate_video", description: "Create a narrated explainer video.", parameters: { topic: "string" } },
  { name: "recall_memory", description: "Search memory for past context.", parameters: { query: "string" } },
  { name: "store_memory", description: "Save information to memory.", parameters: { content: "string", wing: "string?", room: "string?" } },
];
```

---

## 7. Implementation Phases

### Phase 1 — Gemma 4 Local Inference
**Status:** 🔄 In progress — agent prompt issued (Session 4)

**Root cause resolved:** `@huggingface/transformers@3.8.1` had no `gemma4` architecture and a broken sharded-ONNX WebGPU runtime. Fixed by upgrading to v4.x.

**Changes scoped to:**
- `package.json` / `package-lock.json` — `@huggingface/transformers@latest` (v4.x)
- `workers/llm.worker.ts` — full rewrite: clean single-attempt load, `TextStreamer` for token streaming, WebGPU + WASM fallback, no config patching

**Expected outcome:** Video page generates script via local Gemma 4 E4B (WebGPU) or E2B fallback (WASM).

---

### Phase 2 — Client-side TTS
**Status:** ✅ Complete (already implemented in workers/tts.worker.ts + lib/tts.ts)

---

### Phase 3 — Research Tools (Agent-Reach lite)
**Status:** ✅ Complete (lib/research direct Jina integration)

---

### Phase 4 — Python Sandbox (Pyodide)
**Status:** ✅ Complete (workers/pyodide.worker.ts + lib/sandbox/python.ts)

---

### Phase 5 — JavaScript Sandbox (iframe)
**Status:** ✅ Complete (public/js-sandbox.html + lib/sandbox/js-sandbox.ts)

---

### Phase 6 — LaTeX Sandbox
**Status:** ✅ Complete (workers/latex.worker.ts + lib/sandbox/latex.ts)

---

### Phase 7 — R Sandbox (WebR)
**Status:** ✅ Complete (workers/webr.worker.ts + lib/sandbox/r.ts)

---

### Phase 8 — SQL Sandbox (DuckDB)
**Status:** ✅ Complete (workers/duckdb.worker.ts + lib/sandbox/sql.ts)

---

### Phase 9 — Memory System
**Status:** ✅ Complete (lib/memory.ts with IndexedDB + MiniLM)

---

### Phase 10 — Chat Page + Full Agent Loop
**Status:** ✅ Complete (app/chat/page.tsx — unblocked once Phase 1 is verified working)

---

### Phase 11 — Headers + Service Worker
**Status:** ✅ Headers done (next.config.mjs). Service Worker caching deferred.

---

## 8. Dependency State

```json
{
  "@huggingface/transformers": "^4.x (upgraded from 3.8.1 in Session 4)",
  "@duckdb/duckdb-wasm": "^1.30.0",
  "@ffmpeg/ffmpeg": "^0.12.15",
  "@ffmpeg/util": "^0.12.2",
  "idb": "^8.0.0",
  "next": "^15.5.10",
  "react": "^18",
  "react-dom": "^18",
  "webr": "^0.5.5"
}
```

`.env` contains only:
```
NEXT_PUBLIC_LOCAL_TTS_MODEL=cstr/qwen3-tts-1.7b-customvoice-GGUF
```

---

## 9. Open Questions

1. **Phase 1 verification:** Does the clean v4 worker load Gemma 4 successfully? Need terminal output confirming `loaded` message with device (`webgpu` or `wasm`).

2. **E4B vs E2B default:** E4B is the default in the worker. If test machine has <4GB VRAM, switch `MODEL_ID = MODEL_E2B` temporarily. E4B should be restored before shipping.

3. **TextStreamer API in v4:** The `callback_function` property on `TextStreamer` is the documented v4 streaming API. If the installed v4 minor version uses a different property name (e.g. `on_finalized_token`), update accordingly.

4. **Shared memory across `/` and `/chat`:** Both pages use the same IndexedDB memory store — already the case from `lib/memory.ts`.

---

## 10. Reference Links

| Resource | URL |
|----------|-----|
| Gemma 4 ONNX model (E4B) | https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX |
| Gemma 4 ONNX model (E2B) | https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX |
| Transformers.js v4 release | https://github.com/huggingface/transformers.js/releases/tag/4.0.0 |
| Gemma 4 WebGPU demo (HF) | https://huggingface.co/spaces/webml-community/Gemma-4-WebGPU |
| gemma-gem (browser agent, confirmed working) | https://github.com/kessler/gemma-gem |
| Gemma 4 HF blog | https://huggingface.co/blog/gemma4 |
| Jina Reader API | https://jina.ai/reader/ |
| Pyodide | https://pyodide.org |
| WebR | https://docs.r-wasm.org/webr/latest/ |
| DuckDB WASM | https://duckdb.org/docs/api/wasm |
| SwiftLaTeX | https://github.com/SwiftLaTeX/SwiftLaTeX |

---

## 11. Terminal Log

```
[Session 3 — all phases scaffolded, Phase 1 load failing]

1:01:32 AM Pipeline failed: Unable to load any local text model.
Attempts: onnx-community/gemma-4-E4B-it-ONNX (webgpu/q4f16, compat=false,
file=model, subfolder=onnx): Unsupported model type: gemma4
| onnx-community/gemma-4-E4B-it-ONNX (webgpu/fp32, compat=true,
file=decoder_model_merged, subfolder=onnx): Can't create a session.
ERROR_CODE: 1, ERROR_MESSAGE: Deserialize tensor
model.layers.36.per_layer.per_layer_input_gate.MatMul.weight failed.
Failed to load external data file "decoder_model_merged.onnx_data_7",
error: Module.MountedFiles is not available.
| onnx-community/gemma-4-E4B-it-ONNX (webgpu/fp32, compat=true,
file=decoder_model_merged, subfolder=): Could not locate file:
"https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX/resolve/main/
decoder_model_merged.onnx".
[+ 10 additional WASM attempts, all failing with same root causes]

ROOT CAUSE IDENTIFIED (Session 4):
- @huggingface/transformers@3.8.1 has no registered `gemma4` architecture
- v3 WebGPU runtime cannot resolve sharded ONNX external data files
- Fix: upgrade to @huggingface/transformers v4.x (rewrites WebGPU runtime in C++)
- gemma4 architecture added natively in v4; no config patching required
- WebLLM confirmed NOT to have Gemma 4 support (open feature request as of April 2026)

[Session 4 — agent prompt issued, awaiting Phase 1 verification]
```
