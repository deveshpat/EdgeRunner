<p align="center">
  <img src="EdgeRunner.svg" alt="EdgeRunner Logo" width="550" />
</p>

<p align="center">
  <strong>An autonomous agent harness & high-throughput neural runtime for edge nodes and remote GPUs.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-14.2-black?style=flat-square&logo=next.js" alt="Next.js" />
  <img src="https://img.shields.io/badge/FastAPI-0.115-009688?style=flat-square&logo=fastapi" alt="FastAPI" />
  <img src="https://img.shields.io/badge/llama.cpp-GGUF-39FF14?style=flat-square&logo=cplusplus" alt="llama.cpp" />
  <img src="https://img.shields.io/badge/Kaggle-GPU%20Rig-20BEFF?style=flat-square&logo=kaggle" alt="Kaggle" />
  <img src="https://img.shields.io/badge/Typography-JetBrains%20Mono-white?style=flat-square" alt="JetBrains Mono" />
</p>

---

## ⚡ Overview

**EdgeRunner** is a terminal-aesthetic web workspace and execution runtime designed to run frontier LLMs (GGUF quantizations) on remote GPU nodes (e.g., Kaggle T4/P100 instances, local `llama-server` rigs) with agentic tool-calling capabilities.

Featuring a two-phased UI model, dynamic multi-session window docking, drag-and-drop layout management, in-flight GGUF weight switching, and autonomous code execution in sandboxed environments.

```
┌──────────────┐          SSE / HTTP          ┌──────────────────┐          ┌──────────────────────┐
│  Frontend    │  ───────────────────────▶    │  FastAPI Backend │  ──────▶ │  llama-server (GGUF) │
│  (Next.js)   │  ◀───────────────────────    │  (Tunnelled URL) │  ◀────── │  + Tools Sandbox     │
│  Terminal UI │   Real-time Event Stream     │                  │          │  (Remote GPU / Local)│
└──────────────┘                              └──────────────────┘          └──────────────────────┘
```

---

## 🚀 Key Features

### 1. Two-Phased Cyberpunk Terminal Interface
- **Phase 1: Hero Landing Page**: Clean, distraction-free view featuring a centered vector wordmark and vertical CLI slash commands:
  - `[ 01 ]` **`/new`** (`⌘⇧N`) — Start a fresh session.
  - `[ 02 ]` **`/resume`** (`⌘B`) — Open the sessions history drawer.
  - `[ 03 ]` **`/model`** (`⌘M`) — Open the Neural Payload Matrix.
- **Phase 2: Active Workspace**: Full-width top navbar with window traffic lights, status pill (`⏻ OFFLINE` $\rightarrow$ `⚡ CONNECTING…` $\rightarrow$ `● ONLINE`), and multi-session grid.

### 2. Unlimited Multi-Session Docking Grid & Drag-and-Drop
- **Unlimited Panes**: Open and dock multiple concurrent sessions side-by-side in a responsive, auto-scaling grid.
- **In-Place Selection**: Clicking any window highlights it in-place without shifting or rearranging other panes; prompts typed in the composer route directly to the active pane.
- **Drag-and-Drop Reordering**: Rearrange pane positions within the grid via header grip handles (`⠿`).
- **Drag-and-Drop Docking from Sidebar**: Drag any past session from the history drawer onto the canvas to instantly dock it alongside active sessions.
- **Quick Expansion**: Press **`Enter`** or double-click any pane header to expand it to full-screen view (or press **`⌘\`** to toggle between docking all and focusing active).

### 3. Neural Payload Matrix & In-Flight Model Switching
- **Dynamic GGUF Switcher**: Download and swap active model weights on the remote GPU backend in-flight without restarting the worker.
- **2026 SOTA Model Registry**:
  - `DeepSeek-V4 Pro 4B / 9B` — Frontier edge reasoning engines.
  - `Qwen 3.5 / 3.8 (4B, 9B, 27B)` & `Qwen3 Coder 30B` — Flagship open weights for coding and chat.
  - `Gemma 4 26B MoE` & `Bonsai 27B` — Google & Prism high-throughput architectures.

### 4. Dual Execution Harnesses
- **Chat Harness (`chat`)**: Ultra-low-latency direct token streaming over OpenAI-compatible `/v1/chat/completions`.
- **Agent Harness (`agent`)**: Autonomous ReAct coding agent with tool-calling loop (up to 5 iterations) and real-time execution:
  - `run_python` — Python 3 interpreter in isolated container.
  - `run_shell` — Bash command execution (GCC, Node, Go, `pip install`, file inspection).
  - `calculator` — Safe AST arithmetic & math evaluation (`sqrt`, `log`, `sin`, `pi`, etc.).
  - `clock`, `random_number`, `text_stats`, `hash_text` (SHA256, SHA1, MD5).

### 5. JetBrains Mono Typography & Neon Halo Glow
- Styled with `JetBrains Mono` font for razor-sharp legibility and optical letter-spacing.
- Centralized theme tokens in [`frontend/app/globals.css`](frontend/app/globals.css) and [`frontend/tailwind.config.ts`](frontend/tailwind.config.ts) for instant color customization.

---

## ⌨️ Keyboard Shortcuts Matrix

| Key Combo | Action | Description |
| :--- | :--- | :--- |
| **`⌘K` / `Ctrl+K`** | **Home / Reset** | Closes workspace and returns to the clean Hero Landing Page |
| **`⌘⇧N` / `Ctrl+Shift+N`** | **New Session** | Creates a new session (reuses blank session if present) |
| **`⌘B` / `Ctrl+B`** | **Sessions History** | Toggles the slide-out history drawer |
| **`⌘M` / `Ctrl+M`** | **Model Matrix** | Opens the Neural Payload Matrix and weight switcher |
| **`⌘\` / `Ctrl+\`** | **Dock / Expand** | Cycles between docking all windows and focusing active |
| **`Tab` / `Shift+Tab`** | **Cycle Windows** | Cycles active focus forward / backward across sessions |
| **`Enter`** | **Expand Window** | Expands selected active window to full-screen view (in docked mode) |
| **`⌘,` / `Ctrl+,`** | **Settings** | Toggles Kaggle compute rig and backend configuration panel |
| **`⌘L` / `Ctrl+L`** | **Clear Transcript** | Clears message history for the currently active session |
| **`Escape`** | **Dismiss / Abort** | Closes active modals/drawers and aborts streaming |
| **`⌘/`** or **`?`** | **Shortcuts HUD** | Displays the interactive keyboard cheatsheet |

---

## 🛠️ Quick Start

### 1. Backend Setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e .

# Run the FastAPI server
uvicorn app.main:app --reload --port 8000
```

Run tests:
```bash
pytest
```

### 2. Frontend Setup

```bash
cd frontend
npm install

# Start the Next.js dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. The frontend automatically connects to `http://localhost:8000` (configurable via `NEXT_PUBLIC_API_URL`).

### 3. Remote GPU Deployment (Kaggle)
1. Open a Kaggle Notebook with GPU acceleration (T4 or P100).
2. Use the deployment scripts in `kaggle/` or the in-app **⚙ Settings Panel** to launch the automated worker script with Cloudflare tunneling.
3. Paste the tunnel URL into EdgeRunner to stream tokens directly from your Kaggle GPU instance.

---

## 📁 Repository Structure

```
EdgeRunner/
├── EdgeRunner.svg              # Authentic ASCII vector wordmark
├── backend/
│   ├── app/
│   │   ├── harnesses/          # Chat, Agent, and Echo execution harnesses
│   │   ├── routers/            # API endpoints (chat, models, catalog, session)
│   │   ├── model_manager.py    # GGUF downloader & dynamic server lifecycle
│   │   ├── tools.py            # Sandboxed Python, shell, and math tools
│   │   └── main.py             # FastAPI entrypoint
│   └── tests/                  # Pytest test suite (48 unit/integration tests)
├── frontend/
│   ├── app/                    # Next.js App Router (layout, landing, workspace)
│   ├── components/             # Composer, Picker, Sidebar, Modals, Logo
│   ├── lib/                    # Storage, API clients, Kaggle & Model hooks
│   └── tailwind.config.ts      # Terminal color tokens & JetBrains Mono font
└── kaggle/                     # Automated remote Kaggle bootstrap runners
```

---

## 📜 License

MIT License. Designed and crafted for high-performance edge inference.
