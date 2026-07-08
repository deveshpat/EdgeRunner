# stuni-web (v2)

stuni-web is a browser-local AI video and agent app built with Next.js.
The primary goal is zero cloud inference for core workflows.

## What runs locally

1. Gemma text generation in a web worker:
- Model: onnx-community/gemma-4-E2B-it-ONNX
- Runtime: WebGPU with WASM fallback

2. TTS in a web worker:
- Model: cstr/qwen3-tts-1.7b-customvoice-GGUF (default)

3. Video rendering in browser:
- Canvas slide rendering
- FFmpeg.wasm for segment encode + concat

4. Agent tooling:
- Web research via Jina wrappers in lib/research
- Python sandbox (Pyodide)
- R sandbox (WebR)
- SQL sandbox (DuckDB WASM)
- LaTeX sandbox (SwiftLaTeX, assets required)
- JavaScript sandbox iframe

5. Persistent memory:
- IndexedDB entry + embedding store via lib/memory

## Pages

- /: explainer video generation pipeline
- /chat: local agent chat with tool-call events and memory context

## Setup

```bash
npm install
npm run dev
```

Open http://localhost:3000

## Deploy to GitHub Pages

- A workflow is available at `.github/workflows/deploy-pages.yml`.
- Push to `main` (or run the workflow manually) to publish.
- The app will be available at `https://deveshpat.github.io/Stuni-web/`.

## Environment

Only local model env is required for TTS override.

```bash
NEXT_PUBLIC_LOCAL_TTS_MODEL=cstr/qwen3-tts-1.7b-customvoice-GGUF
```

No OpenRouter or API key env vars are required for the local-first flow.

## SwiftLaTeX assets (required for LaTeX tool)

Place SwiftLaTeX runtime files in public/swiftlatex:
- PdfTeXEngine.js
- required .wasm files from SwiftLaTeX release

If assets are missing, compile_latex will fail with an explicit error.

## Notes

- First model loads are large and expected to be slow.
- /chat tool execution quality depends on local browser capabilities.
- COOP/COEP headers are enabled in next.config.mjs for worker/runtime compatibility.
