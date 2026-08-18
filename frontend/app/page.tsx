"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Composer } from "@/components/Composer";
import { FileExplorerModal } from "@/components/FileExplorerModal";
import { InteractiveTerminal } from "@/components/InteractiveTerminal";
import { LivePreviewModal } from "@/components/LivePreviewModal";
import { Logo } from "@/components/Logo";
import { Message } from "@/components/Message";
import { ModelPickerModal } from "@/components/ModelPickerModal";
import { Picker } from "@/components/Picker";
import { SettingsModal } from "@/components/SettingsModal";
import { ShortcutsModal } from "@/components/ShortcutsModal";
import { Sidebar } from "@/components/Sidebar";
import { fetchCatalog, hasBackend, type Catalog } from "@/lib/api";
import { LAUNCH_MODELS } from "@/lib/models";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from "@/lib/storage";
import { useBackend } from "@/lib/useBackend";
import { useConversations } from "@/lib/useConversations";
import { useKaggle } from "@/lib/useKaggle";
import { useModelManager } from "@/lib/useModelManager";

export default function Home() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [showModelModal, setShowModelModal] = useState(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [showFilesModal, setShowFilesModal] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);
  const [showTerminalDrawer, setShowTerminalDrawer] = useState(false);
  const [terminalViewModes, setTerminalViewModes] = useState<Record<string, "feed" | "interactive">>({});
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [trafficHovered, setTrafficHovered] = useState(false);
  const [dockedSessionIds, setDockedSessionIds] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"landing" | "workspace">("landing");
  const [atBottom, setAtBottom] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Kaggle & Local control plane (auto-stops Kaggle worker when local backend is alive)
  const kaggle = useKaggle();
  const backend = useBackend(
    useCallback(() => {
      if (kaggle.state === "online") {
        kaggle.stop();
      }
    }, [kaggle]),
  );
  const backendOnline = kaggle.state === "online" || backend.status === "online";

  const modelManager = useModelManager(backendOnline);
  const [customSelectedModel, setCustomSelectedModel] = useState<{
    id: string;
    name: string;
    repo: string;
    file: string;
    gpu?: boolean;
  } | null>(null);

  // Reconcile model list: curated defaults + custom selected + live backend catalog.
  const modelOptions = useMemo(() => {
    const optionsMap = new Map<
      string,
      {
        id: string;
        name: string;
        description?: string;
        repo?: string;
        file?: string;
        gpu?: boolean;
      }
    >();

    const register = (
      id: string,
      name: string,
      description?: string,
      repo?: string,
      file?: string,
      gpu?: boolean,
    ) => {
      const key = id.replace(/\.gguf$/i, "").toLowerCase();
      const existing = optionsMap.get(key);
      if (existing && existing.name.includes("[MOUNTED]")) {
        return;
      }
      optionsMap.set(key, {
        id,
        name,
        description,
        repo,
        file: file || (id.endsWith(".gguf") ? id : `${id}.gguf`),
        gpu,
      });
    };

    // 1. Live backend catalog
    for (const m of catalog?.models ?? []) {
      const cleanId = m.id.split("/").pop()?.replace(/\.gguf$/i, "") ?? m.id;
      const lm = LAUNCH_MODELS.find(
        (x) =>
          x.id.toLowerCase() === cleanId.toLowerCase() ||
          x.file.replace(/\.gguf$/i, "").toLowerCase() === cleanId.toLowerCase(),
      );
      register(
        m.id,
        m.name,
        m.description,
        lm?.repo,
        lm?.file || (m.id.endsWith(".gguf") ? m.id : `${m.id}.gguf`),
        lm?.gpu,
      );
    }

    // 2. Custom selected model
    if (customSelectedModel) {
      register(
        customSelectedModel.id,
        customSelectedModel.name,
        `${customSelectedModel.repo} :: ${customSelectedModel.file}`,
        customSelectedModel.repo,
        customSelectedModel.file,
        customSelectedModel.gpu,
      );
    }

    // 3. Curated launch models
    for (const m of LAUNCH_MODELS) {
      const alias = m.file.replace(/\.gguf$/i, "");
      register(alias, m.label, m.note, m.repo, m.file, m.gpu);
    }

    return Array.from(optionsMap.values());
  }, [catalog, customSelectedModel]);

  const chat = useConversations(
    {
      model: modelOptions[0]?.id ?? "Qwen3.5-4B-Q4_K_M",
      harness: "chat",
    },
    settings,
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadCatalog = useCallback(() => {
    setCatalogError(null);
    if (!hasBackend()) {
      setCatalog(null);
      return;
    }
    fetchCatalog()
      .then(setCatalog)
      .catch((e) => setCatalogError(`Could not reach backend: ${e.message}`));
  }, []);

  const handleSelectModel = useCallback(
    async (selected: {
      id: string;
      name: string;
      repo: string;
      file: string;
      gpu?: boolean;
    }) => {
      setCustomSelectedModel(selected);
      chat.setModel(selected.id);
      kaggle.setLaunchModel(selected.id, selected.repo, selected.file);
      if (selected.gpu && kaggle.accelerator !== "gpu") {
        kaggle.setAccelerator("gpu");
      }

      if (backendOnline) {
        await modelManager.switchModel({
          repo: selected.repo,
          file: selected.file,
          modelId: selected.id,
          gpu: selected.gpu ?? (kaggle.accelerator === "gpu"),
          hfToken: kaggle.hfToken,
        });
        loadCatalog();
      }
    },
    [backendOnline, chat, kaggle, loadCatalog, modelManager],
  );

  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [isCanvasDragOver, setIsCanvasDragOver] = useState(false);
  const [paneViewModes, setPaneViewModes] = useState<Record<string, "chat" | "terminal" | "workspace">>({});

  // Toggle multi-session split view dock (cycles between all windows docked and single focused window)
  const toggleSplitDock = useCallback(() => {
    setViewMode("workspace");
    if (dockedSessionIds.length > 0) {
      // Collapse all other docked windows, keeping ONLY the currently active/selected window
      setDockedSessionIds([]);
    } else {
      // Dock all available sessions if more than 1 conversation exists
      if (chat.conversations.length > 1) {
        setDockedSessionIds(chat.conversations.map((c) => c.id));
      }
    }
  }, [dockedSessionIds, chat.conversations]);

  const undockSession = useCallback((id: string) => {
    setDockedSessionIds((prev) => {
      const next = prev.filter((x) => x !== id);
      if (next.length <= 1) return [];
      return next;
    });
  }, []);

  const handleCanvasDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsCanvasDragOver(false);
      const droppedId =
        e.dataTransfer.getData("application/edgerunner-session-id") ||
        e.dataTransfer.getData("text/plain");

      if (!droppedId) return;

      setViewMode("workspace");
      if (dockedSessionIds.length === 0) {
        const currentId = chat.active?.id;
        if (currentId && currentId !== droppedId) {
          setDockedSessionIds([currentId, droppedId]);
        } else {
          const other = chat.conversations.find((c) => c.id !== droppedId);
          setDockedSessionIds(other ? [other.id, droppedId] : [droppedId]);
        }
      } else if (!dockedSessionIds.includes(droppedId)) {
        setDockedSessionIds((prev) => [...prev, droppedId]);
      }
      chat.select(droppedId);
    },
    [chat, dockedSessionIds],
  );

  // Listen for in-terminal editor launch (nano/vim) from feed or commands to auto-switch to interactive PTY
  useEffect(() => {
    function handleOpenTerminalEditor() {
      const activeId = chat.active?.id;
      if (activeId) {
        setTerminalViewModes((prev) => ({ ...prev, [activeId]: "interactive" }));
      }
      setViewMode("workspace");
    }
    window.addEventListener("edgerunner:open-terminal-editor", handleOpenTerminalEditor);
    return () => window.removeEventListener("edgerunner:open-terminal-editor", handleOpenTerminalEditor);
  }, [chat.active?.id]);

  // Global Keyboard Shortcuts (Collision-free & Cross-platform)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isInput =
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA" ||
        document.activeElement?.tagName === "SELECT";

      const isAlt = e.altKey;
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      const code = e.code;
      const key = e.key ? e.key.toLowerCase() : "";

      // Tab / Shift+Tab: Cycle between sessions (docked panes or single window conversations)
      if (e.key === "Tab" && !isCmdOrCtrl && !isAlt) {
        if (viewMode === "workspace") {
          if (dockedSessionIds.length > 1) {
            e.preventDefault();
            const currentIndex = dockedSessionIds.indexOf(chat.active?.id || "");
            const nextIndex = e.shiftKey
              ? (currentIndex - 1 + dockedSessionIds.length) % dockedSessionIds.length
              : (currentIndex + 1) % dockedSessionIds.length;
            chat.select(dockedSessionIds[nextIndex]);
            return;
          } else if (chat.conversations.length > 1) {
            e.preventDefault();
            const currentIndex = chat.conversations.findIndex(
              (c) => c.id === chat.active?.id,
            );
            const nextIndex = e.shiftKey
              ? (currentIndex - 1 + chat.conversations.length) % chat.conversations.length
              : (currentIndex + 1) % chat.conversations.length;
            chat.select(chat.conversations[nextIndex].id);
            return;
          }
        }
      }

      // Enter when session sidebar is open: closes drawer to currently selected session in workspace
      if (sidebarOpen && (code === "Enter" || key === "enter") && !isCmdOrCtrl && !e.shiftKey) {
        e.preventDefault();
        setSidebarOpen(false);
        setViewMode("workspace");
        return;
      }

      // Enter when in dock mode: expands active pane to full single-window view
      if (dockedSessionIds.length > 0 && (code === "Enter" || key === "enter") && !isCmdOrCtrl && !e.shiftKey) {
        if (!isInput || !input.trim()) {
          e.preventDefault();
          setDockedSessionIds([]);
          return;
        }
      }

      // Option/Alt + T or ⌘+Shift+L or ⌘T: Toggle Light/Dark Theme
      if (
        (isAlt && (code === "KeyT" || key === "t" || e.key === "†")) ||
        (isCmdOrCtrl && e.shiftKey && (code === "KeyL" || key === "l")) ||
        (isCmdOrCtrl && (code === "KeyT" || key === "t"))
      ) {
        e.preventDefault();
        toggleTheme();
        return;
      }

      // Option/Alt + N or ⌘N: New Session
      if ((isAlt && (code === "KeyN" || key === "n" || e.key === "~")) || (isCmdOrCtrl && (code === "KeyN" || key === "n"))) {
        e.preventDefault();
        chat.create();
        setViewMode("workspace");
        return;
      }

      // ⌘/Ctrl + K: Clear to Landing Page / Home
      if (isCmdOrCtrl && (code === "KeyK" || key === "k" || e.key === "")) {
        e.preventDefault();
        setViewMode("landing");
        setDockedSessionIds([]);
        return;
      }

      // ⌘/Ctrl + Backspace or Shift+Delete or Option+Backspace: Delete Active Session
      if (
        (((isCmdOrCtrl || isAlt) && (code === "Backspace" || code === "Delete" || key === "backspace" || key === "delete")) ||
          (e.shiftKey && (code === "Delete" || key === "delete"))) &&
        !isInput
      ) {
        e.preventDefault();
        if (chat.active) {
          chat.remove(chat.active.id);
          if (chat.conversations.length <= 1) {
            setViewMode("landing");
          }
        }
        return;
      }

      // ⌘/Ctrl + B or Option+B: Toggle Sidebar
      if ((isCmdOrCtrl && (code === "KeyB" || key === "b")) || (isAlt && (code === "KeyB" || key === "b" || e.key === "∫"))) {
        e.preventDefault();
        setSidebarOpen((s) => !s);
        return;
      }

      // ⌘/Ctrl + M or Option+M: Model Picker Matrix
      if ((isCmdOrCtrl && (code === "KeyM" || key === "m")) || (isAlt && (code === "KeyM" || key === "m" || e.key === "µ"))) {
        e.preventDefault();
        setShowModelModal((s) => !s);
        return;
      }

      // Option/Alt + P: Toggle Live Web/Game Preview
      if (isAlt && (code === "KeyP" || key === "p" || e.key === "π")) {
        e.preventDefault();
        setShowPreviewModal((s) => !s);
        return;
      }

      // ⌘/Ctrl + 1 or Option+1: Switch to / Chat Mode
      if ((isCmdOrCtrl || isAlt) && (code === "Digit1" || code === "Numpad1" || key === "1" || e.key === "¡")) {
        e.preventDefault();
        chat.setHarness("chat");
        setViewMode("workspace");
        return;
      }

      // ⌘/Ctrl + 2 or Option+2 or ⌘E: Switch to Fullscreen Workspace
      if (
        (isCmdOrCtrl && (code === "KeyE" || key === "e")) ||
        ((isCmdOrCtrl || isAlt) && (code === "Digit2" || code === "Numpad2" || key === "2" || e.key === "™"))
      ) {
        e.preventDefault();
        chat.setHarness("workspace");
        setViewMode("workspace");
        return;
      }

      // ⌘/Ctrl + 3 or Option+3 or ⌘J: Switch to Terminal Mode
      if (
        ((isCmdOrCtrl || isAlt) && (code === "Digit3" || code === "Numpad3" || key === "3" || e.key === "£")) ||
        (isCmdOrCtrl && (code === "KeyJ" || key === "j"))
      ) {
        e.preventDefault();
        chat.setHarness("terminal");
        setViewMode("workspace");
        return;
      }

      // ⌘/Ctrl + 4 or Option+4: Switch to Agent Mode
      if ((isCmdOrCtrl || isAlt) && (code === "Digit4" || code === "Numpad4" || key === "4" || e.key === "¢")) {
        e.preventDefault();
        chat.setHarness("agent");
        setViewMode("workspace");
        return;
      }

      // ⌘/Ctrl + \ or Option+D: Toggle Split Screen Dock
      if (
        (isCmdOrCtrl && (code === "Backslash" || key === "\\")) ||
        (isAlt && (code === "KeyD" || key === "d" || e.key === "∂"))
      ) {
        e.preventDefault();
        toggleSplitDock();
        return;
      }

      // ⌘/Ctrl + ,: Toggle Settings
      if (isCmdOrCtrl && (code === "Comma" || key === ",")) {
        e.preventDefault();
        setShowSettings((s) => !s);
        return;
      }

      // ⌘/Ctrl + / or ?: Shortcuts Modal
      if (isCmdOrCtrl && (code === "Slash" || key === "/" || key === "?")) {
        e.preventDefault();
        setShowShortcutsModal((s) => !s);
        return;
      }

      // Ctrl + L: Clear current session messages (standard terminal clear)
      if (e.ctrlKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        if (chat.active) {
          chat.deleteMessage(-1);
        }
        return;
      }

      // ⌘/Ctrl + /: Shortcuts HUD
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setShowShortcutsModal((s) => !s);
        return;
      }

      // ? when not in input: Shortcuts HUD
      if (e.key === "?" && !isInput && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShowShortcutsModal(true);
        return;
      }

      // Auto-focus text sandbox when user starts typing on keyboard
      if (
        !isInput &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.key.length === 1 &&
        e.key !== "?" &&
        !showModelModal &&
        !showFilesModal &&
        !showPreviewModal &&
        !showTerminalDrawer &&
        !showShortcutsModal &&
        !showSettings &&
        !sidebarOpen
      ) {
        const composerEl = document.querySelector<HTMLTextAreaElement>("textarea");
        if (composerEl) {
          composerEl.focus();
        }
      }

      // Escape: Close modals / abort stream
      if (e.key === "Escape") {
        if (showShortcutsModal) {
          setShowShortcutsModal(false);
          return;
        }
        if (showFilesModal) {
          setShowFilesModal(false);
          return;
        }
        if (showPreviewModal) {
          setShowPreviewModal(false);
          return;
        }
        if (showTerminalDrawer) {
          setShowTerminalDrawer(false);
          return;
        }
        if (showModelModal) {
          setShowModelModal(false);
          return;
        }
        if (showSettings) {
          setShowSettings(false);
          return;
        }
        if (sidebarOpen) {
          setSidebarOpen(false);
          return;
        }
        if (chat.busy) {
          chat.stop();
          return;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [chat, showFilesModal, showModelModal, showPreviewModal, showSettings, showShortcutsModal, showTerminalDrawer, sidebarOpen, toggleSplitDock]);

  // Listen for Live Preview trigger from messages or terminal
  useEffect(() => {
    function handleOpenPreview(e: any) {
      if (e.detail?.url) {
        setPreviewUrl(e.detail.url);
      } else {
        setPreviewUrl(undefined);
      }
      setShowPreviewModal(true);
    }
    window.addEventListener("edgerunner:open-preview", handleOpenPreview);
    function handleOpenWorkspace() {
      setShowFilesModal(true);
    }
    window.addEventListener("edgerunner:open-workspace", handleOpenWorkspace);
    return () => {
      window.removeEventListener("edgerunner:open-preview", handleOpenPreview);
      window.removeEventListener("edgerunner:open-workspace", handleOpenWorkspace);
    };
  }, []);

  // Load theme on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const saved = (localStorage.getItem("edgerunner.theme") as "dark" | "light") || "dark";
      setTheme(saved);
      document.documentElement.setAttribute("data-theme", saved);
    }
  }, []);

  function toggleTheme() {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      if (typeof window !== "undefined") {
        localStorage.setItem("edgerunner.theme", next);
        document.documentElement.setAttribute("data-theme", next);
      }
      return next;
    });
  }

  // Load settings on mount.
  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  // (Re)load catalog when active backend changes
  useEffect(() => {
    loadCatalog();
  }, [loadCatalog, kaggle.state, kaggle.publicUrl, backend.status, backend.url]);

  useEffect(() => {
    if (!backendOnline) return;
    const isPlaceholder =
      !catalog || catalog.models.some((m) => m.description.startsWith("Placeholder"));
    if (!isPlaceholder) return;
    const poll = setInterval(loadCatalog, 4000);
    const stop = setTimeout(() => clearInterval(poll), 300_000);
    return () => {
      clearInterval(poll);
      clearTimeout(stop);
    };
  }, [backendOnline, catalog, loadCatalog]);

  // Keep active conversation pointed at a known model
  useEffect(() => {
    const a = chat.active;
    if (modelOptions.length === 0 || !a) return;
    const ids = modelOptions.map((m) => m.id);
    if (a.model && !ids.includes(a.model)) {
      if (customSelectedModel && customSelectedModel.id === a.model) return;
      chat.setModel(modelOptions[0].id);
    }
  }, [modelOptions, chat, customSelectedModel]);

  // Autoscroll
  useEffect(() => {
    if (atBottom) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [chat.active, chat.streaming, chat.liveTools, atBottom]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const active = chat.active;
  const model = chat.model || active?.model || catalog?.models[0]?.id || "";
  const harness = chat.harness || active?.harness || "chat";
  const canRegenerate =
    !chat.busy &&
    !!active &&
    active.messages.some((m) => m.role === "assistant");

  // Multi-docked sessions list
  const dockedConvos = useMemo(() => {
    return dockedSessionIds
      .map((id) => chat.conversations.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c);
  }, [dockedSessionIds, chat.conversations]);

  function submit() {
    const text = input.trim();
    if (!text || chat.busy) return;

    // Handle slash command shortcuts typed in text sandbox
    const lower = text.toLowerCase();
    if (lower === "/chat") {
      chat.setHarness("chat");
      setViewMode("workspace");
      setInput("");
      return;
    }
    if (lower === "/agent") {
      chat.setHarness("agent");
      setViewMode("workspace");
      setInput("");
      return;
    }
    if (lower === "/workspace" || lower === "/files" || lower === "/file") {
      chat.setHarness("workspace");
      setViewMode("workspace");
      setInput("");
      return;
    }
    if (lower === "/terminal" || lower === "/term" || lower === "/bash") {
      chat.setHarness("terminal");
      setViewMode("workspace");
      setInput("");
      return;
    }
    if (lower === "/model" || lower === "/models") {
      setShowModelModal(true);
      setInput("");
      return;
    }
    if (lower === "/settings" || lower === "/config") {
      setShowSettings(true);
      setInput("");
      return;
    }
    if (lower === "/help" || lower === "/shortcuts") {
      setShowShortcutsModal(true);
      setInput("");
      return;
    }

    const isFromLanding = viewMode === "landing";
    if (dockedSessionIds.length > 0) {
      setDockedSessionIds([]);
    }
    setViewMode("workspace");
    chat.send(text, isFromLanding);
    setInput("");
  }

  function handleStartNewSession() {
    chat.create();
    setViewMode("workspace");
  }

  function handleTogglePower() {
    if (!kaggle.configured) {
      setShowSettings(true);
    } else if (
      ["online", "packing", "pushing", "provisioning"].includes(kaggle.state)
    ) {
      kaggle.stop();
    } else {
      kaggle.start();
    }
  }

  // Pickers element rendered at bottom-right of text sandbox
  const sandboxPickers = (
    <div className="flex items-center gap-1.5 font-mono text-xs select-none">
      {/* Model / Payload Picker */}
      {harness !== "terminal" && (
        <Picker
          label="payload"
          options={modelOptions}
          value={
            modelOptions.find(
              (m) =>
                m.id === model ||
                m.id.replace(/\.gguf$/i, "").toLowerCase() ===
                  model.replace(/\.gguf$/i, "").toLowerCase(),
            )?.id ?? model
          }
          onChange={(id) => {
            const found = modelOptions.find(
              (m) =>
                m.id === id ||
                m.id.replace(/\.gguf$/i, "").toLowerCase() ===
                  id.replace(/\.gguf$/i, "").toLowerCase(),
            );
            const lm = LAUNCH_MODELS.find(
              (m) =>
                m.id === id ||
                m.file.replace(/\.gguf$/i, "").toLowerCase() ===
                  id.replace(/\.gguf$/i, "").toLowerCase() ||
                m.file === id,
            );
            const repo =
              found?.repo ||
              lm?.repo ||
              customSelectedModel?.repo ||
              "unsloth/Qwen3.5-4B-GGUF";
            const file =
              found?.file ||
              lm?.file ||
              customSelectedModel?.file ||
              (id.endsWith(".gguf") ? id : `${id}.gguf`);
            handleSelectModel({
              id,
              name: found?.name || id,
              repo,
              file,
              gpu: found?.gpu ?? lm?.gpu,
            });
          }}
          onOpenModal={() => setShowModelModal(true)}
          badge={
            modelManager.activeModelId &&
            (model.toLowerCase().includes(modelManager.activeModelId.toLowerCase()) ||
              modelManager.activeModelId.toLowerCase().includes(model.toLowerCase()))
              ? "ONLINE"
              : undefined
          }
          isLoading={modelManager.isSwitching}
          disabled={chat.busy || modelManager.isSwitching}
        />
      )}

      {/* Compute Rig Power Status & Toggle Button (shifted to sandbox for chat/agent) */}
      {(harness === "chat" || harness === "agent") && (
        backendOnline ? (
          <button
            onClick={handleTogglePower}
            disabled={kaggle.busy}
            className="flex items-center gap-1.5 rounded border border-term-green/60 bg-term-green/10 px-2 sm:px-2.5 py-0.5 text-xs text-term-green hover:border-term-red hover:text-term-red hover:bg-term-red/10 transition-all font-semibold"
            title="Compute Rig Online (Click to Disconnect)"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-term-green animate-pulse" />
            <span>ONLINE</span>
          </button>
        ) : kaggle.busy || kaggle.state === "provisioning" || kaggle.state === "packing" || kaggle.state === "pushing" ? (
          <button
            onClick={kaggle.stop}
            className="flex items-center gap-1.5 rounded border border-term-amber/50 bg-term-amber/10 px-2 sm:px-2.5 py-0.5 text-xs text-term-amber animate-pulse hover:border-term-red hover:text-term-red transition-all font-semibold"
            title="Rig Starting Up… (Click to Cancel)"
          >
            <span>⚡</span>
            <span className="hidden xs:inline">CONNECTING…</span>
          </button>
        ) : (
          <button
            onClick={handleTogglePower}
            disabled={kaggle.busy}
            className="flex items-center gap-1.5 rounded border border-term-border bg-term-panel px-2 sm:px-2.5 py-0.5 text-xs text-term-dim hover:border-term-green hover:text-term-green transition-all font-semibold"
            title="Compute Rig Offline (Click to Launch)"
          >
            <span>⏻</span>
            <span>OFFLINE</span>
          </button>
        )
      )}

      {/* Terminal View Mode Feed / PTY Toggle */}
      {harness === "terminal" && active && (
        <div className="flex items-center rounded border border-term-border bg-term-bg p-0.5 text-[10px]">
          <button
            onClick={() => setTerminalViewModes((prev) => ({ ...prev, [active.id]: "feed" }))}
            className={`px-1.5 py-0.5 rounded transition-colors ${
              (terminalViewModes[active.id] || "feed") === "feed"
                ? "bg-term-green/20 text-term-green font-semibold"
                : "text-term-dim hover:text-term-fg"
            }`}
            title="Block Message Feed view"
          >
            Feed
          </button>
          <button
            onClick={() => setTerminalViewModes((prev) => ({ ...prev, [active.id]: "interactive" }))}
            className={`px-1.5 py-0.5 rounded transition-colors ${
              terminalViewModes[active.id] === "interactive"
                ? "bg-term-green/20 text-term-green font-semibold"
                : "text-term-dim hover:text-term-fg"
            }`}
            title="Interactive xterm.js PTY Screen"
          >
            ⚡ PTY
          </button>
        </div>
      )}

      {/* Modern Theme Switcher Slider with Emoji Thumb */}
      <div
        onClick={toggleTheme}
        className="relative flex items-center h-6 w-12 rounded-full border border-term-border bg-term-panel px-1 cursor-pointer select-none transition-all hover:border-term-green shadow-inner shrink-0"
        title={`Switch to ${theme === "dark" ? "Light" : "Dark"} Mode (⌥T / Alt+T)`}
        role="button"
        aria-label="Toggle Theme"
      >
        <span className={`flex-1 text-[10px] text-center transition-opacity ${theme === "light" ? "opacity-100" : "opacity-30"}`}>
          ☀️
        </span>
        <span className={`flex-1 text-[10px] text-center transition-opacity ${theme === "dark" ? "opacity-100" : "opacity-30"}`}>
          🌙
        </span>
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full border border-term-border bg-term-bg shadow-md flex items-center justify-center text-[10px] transition-all duration-300 ease-out ${
            theme === "dark" ? "left-[calc(100%-1.35rem)]" : "left-0.5"
          }`}
        >
          {theme === "dark" ? "🌙" : "☀️"}
        </span>
      </div>

      {/* Stop / Regenerate Buttons */}
      {chat.busy ? (
        <button
          onClick={chat.stop}
          className="flex items-center gap-1 rounded border border-term-red/60 bg-term-bg px-1.5 py-0.5 text-[10px] text-term-red hover:bg-term-red/10 transition-colors"
          title="Abort active stream"
        >
          <span>■</span>
        </button>
      ) : (
        canRegenerate && (
          <button
            onClick={chat.regenerate}
            disabled={modelManager.isSwitching}
            className="flex items-center gap-1 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-[10px] text-term-dim hover:border-term-green hover:text-term-green disabled:opacity-25 transition-colors"
            title="Retry last response"
          >
            <span>↻</span>
          </button>
        )
      )}
    </div>
  );

  return (
    <main className="flex h-[100dvh] w-full max-w-full overflow-hidden bg-term-bg text-term-fg font-mono">
      {/* Session History Slide-out Drawer (available on Landing & Workspace) */}
      <Sidebar
        conversations={chat.conversations}
        activeId={active?.id ?? null}
        onSelect={(id) => {
          chat.select(id);
          setViewMode("workspace");
        }}
        onCreate={() => {
          chat.create();
          setViewMode("workspace");
        }}
        onDelete={(id) => {
          setDockedSessionIds((prev) => prev.filter((x) => x !== id));
          chat.remove(id);
        }}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="flex h-full w-full flex-1 flex-col transition-all overflow-hidden">
        {/* Full-Length Top Navbar */}
        {viewMode === "workspace" ? (
          <header className="relative w-full border-b border-term-border bg-term-panel/60 px-2.5 sm:px-4 py-2 sm:py-2.5 text-xs select-none transition-all duration-300">
            <div className="flex items-center justify-between gap-2 sm:gap-4 w-full h-7">
              {/* Left: Window Controls + History Trigger */}
              <div className="flex items-center gap-2 sm:gap-3 shrink-0 z-10">
                {/* Traffic Lights */}
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => {
                      // Red dot returns directly to Hero Landing Page
                      setDockedSessionIds([]);
                      setViewMode("landing");
                    }}
                    title="Close session & return to Landing (⌘K)"
                    className="h-3 w-3 rounded-full bg-[#FF5F56] transition-transform hover:scale-110 active:scale-95 shadow-sm"
                  />
                  <button
                    onClick={() => chat.active && chat.deleteMessage(-1)}
                    title="Clear Active Transcript (⌘L)"
                    className="h-3 w-3 rounded-full bg-[#FFBD2E] transition-transform hover:scale-110 active:scale-95 shadow-sm"
                  />
                  <button
                    onClick={toggleSplitDock}
                    title={dockedConvos.length > 0 ? "Collapse to Selected Active Window (⌘\\)" : "Dock All Windows (⌘\\)"}
                    className={`h-3 w-3 rounded-full ${
                      dockedConvos.length > 0 ? "bg-[#3ecf5c] ring-1 ring-white" : "bg-[#27C93F]"
                    } transition-transform hover:scale-110 active:scale-95 shadow-sm`}
                  />
                </div>
              </div>

              {/* Center: Perfectly Centered EdgeRunner Logo */}
              <div
                onClick={() => {
                  setDockedSessionIds([]);
                  setViewMode("landing");
                }}
                className="absolute left-1/2 -translate-x-1/2 flex items-center justify-center cursor-pointer hover:opacity-90 transition-opacity pointer-events-auto"
                title="Return to Hero Landing (⌘K)"
              >
                <Logo variant="navbar" />
              </div>

              {/* Right: Mode Switcher + Shortcuts + Settings */}
              <div className="flex items-center gap-1.5 sm:gap-2 justify-end shrink-0 z-10">
                <button
                  onClick={() => {
                    // Complete Cycle: chat -> agent -> terminal -> workspace -> chat
                    if (harness === "chat") chat.setHarness("agent");
                    else if (harness === "agent") chat.setHarness("terminal");
                    else if (harness === "terminal") chat.setHarness("workspace");
                    else chat.setHarness("chat");
                    setViewMode("workspace");
                  }}
                  className="group flex items-center gap-1 h-7 sm:h-8 rounded-md border border-term-border bg-term-panel px-2 sm:px-2.5 text-xs font-mono font-semibold transition-all hover:border-term-green/80 hover:bg-term-green/[0.04]"
                  title="Active Mode: Click to cycle (/chat → /agent → /terminal → /workspace) or use ⌥1/⌥2/⌥3/⌥4"
                >
                  <span className="text-term-dim group-hover:text-term-fg transition-colors">[</span>
                  <span className="text-term-green font-bold">/</span>
                  <span className="text-term-fg group-hover:text-term-green transition-colors">
                    {harness === "workspace" ? "workspace" : harness === "terminal" ? "terminal" : harness === "agent" ? "agent" : "chat"}
                  </span>
                  <span className="text-term-dim group-hover:text-term-fg transition-colors">]</span>
                  <span className="text-[10px] text-term-dim group-hover:text-term-green ml-0.5">▾</span>
                </button>

                <button
                  onClick={() => setShowShortcutsModal(true)}
                  className="flex items-center justify-center h-7 sm:h-8 px-2 rounded border border-term-border bg-term-panel text-term-dim hover:text-term-green hover:border-term-green transition-colors text-xs"
                  title="Keyboard Shortcuts Guide (⌘/)"
                >
                  ⌘/
                </button>
                <button
                  onClick={() => setShowSettings(true)}
                  className="flex items-center justify-center h-7 sm:h-8 w-7 sm:w-8 rounded border border-term-border bg-term-panel text-term-dim hover:text-term-green hover:border-term-dim transition-colors text-xs"
                  title="Settings & Rig Config (⌘,)"
                >
                  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                    <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
                  </svg>
                </button>
              </div>
            </div>
          </header>
        ) : null}

        {/* Two-Phased Main Content Area */}
        {viewMode === "landing" ? (
          /* Phase 1: Hero Landing Page */
          <div className="flex flex-1 flex-col items-center justify-start sm:justify-center px-3 py-3 sm:py-6 text-center select-none overflow-y-auto w-full">
            <div className="w-full max-w-5xl flex flex-col items-center space-y-4 sm:space-y-6 my-auto py-2">
              {/* Centered Grand Glowing Original Logo */}
              <Logo variant="hero" className="w-full py-1 sm:py-3" />

              {/* Landing Mode Selection Cards: Vertically Stacked /chat, /agent, /terminal, /workspace */}
              <div className="w-full max-w-xl mx-auto flex flex-col gap-2 py-2 text-left select-none">
                {/* 01: /chat */}
                <button
                  onClick={() => {
                    chat.create("chat");
                    setViewMode("workspace");
                  }}
                  className="group flex items-center justify-between rounded-lg border border-term-border/80 bg-term-panel/40 px-4 py-2.5 sm:py-3 text-sm sm:text-base text-term-fg transition-all duration-200 hover:border-term-green hover:bg-term-green/[0.04] hover:text-term-green hover:shadow-[0_0_20px_rgba(57,255,20,0.2)]"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-bold text-term-dim group-hover:text-term-green font-mono transition-colors">
                      [ 01 ]
                    </span>
                    <div className="font-semibold text-sm sm:text-base tracking-wide font-mono">
                      <span className="text-term-green font-bold">/</span>chat
                    </div>
                  </div>
                  <span className="text-xs text-term-dim group-hover:text-term-fg">
                    Neural Assistant & Inference
                  </span>
                </button>

                {/* 02: /agent */}
                <button
                  onClick={() => {
                    chat.create("agent");
                    setViewMode("workspace");
                  }}
                  className="group flex items-center justify-between rounded-lg border border-term-border/80 bg-term-panel/40 px-4 py-2.5 sm:py-3 text-sm sm:text-base text-term-fg transition-all duration-200 hover:border-term-green hover:bg-term-green/[0.04] hover:text-term-green hover:shadow-[0_0_20px_rgba(57,255,20,0.2)]"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-bold text-term-dim group-hover:text-term-green font-mono transition-colors">
                      [ 02 ]
                    </span>
                    <div className="font-semibold text-sm sm:text-base tracking-wide font-mono">
                      <span className="text-term-green font-bold">/</span>agent
                    </div>
                  </div>
                  <span className="text-xs text-term-dim group-hover:text-term-fg">
                    Autonomous ReAct Coding Agent
                  </span>
                </button>

                {/* 03: /terminal */}
                <button
                  onClick={() => {
                    chat.create("terminal");
                    setViewMode("workspace");
                  }}
                  className="group flex items-center justify-between rounded-lg border border-term-border/80 bg-term-panel/40 px-4 py-2.5 sm:py-3 text-sm sm:text-base text-term-fg transition-all duration-200 hover:border-term-green hover:bg-term-green/[0.04] hover:text-term-green hover:shadow-[0_0_20px_rgba(57,255,20,0.2)]"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-bold text-term-dim group-hover:text-term-green font-mono transition-colors">
                      [ 03 ]
                    </span>
                    <div className="font-semibold text-sm sm:text-base tracking-wide font-mono">
                      <span className="text-term-green font-bold">/</span>terminal
                    </div>
                  </div>
                  <span className="text-xs text-term-dim group-hover:text-term-fg">
                    Interactive Wasm PTY & Shell
                  </span>
                </button>

                {/* 04: /workspace */}
                <button
                  onClick={() => {
                    chat.setHarness("workspace");
                    setViewMode("workspace");
                  }}
                  className="group flex items-center justify-between rounded-lg border border-term-border/80 bg-term-panel/40 px-4 py-2.5 sm:py-3 text-sm sm:text-base text-term-fg transition-all duration-200 hover:border-term-green hover:bg-term-green/[0.04] hover:text-term-green hover:shadow-[0_0_20px_rgba(57,255,20,0.2)]"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-bold text-term-dim group-hover:text-term-green font-mono transition-colors">
                      [ 04 ]
                    </span>
                    <div className="font-semibold text-sm sm:text-base tracking-wide font-mono">
                      <span className="text-term-green font-bold">/</span>workspace
                    </div>
                  </div>
                  <span className="text-xs text-term-dim group-hover:text-term-fg">
                    VS Code Monaco & Git DAG
                  </span>
                </button>
              </div>

              {/* Direct Launch Sandbox Composer: Horizontally Wide Matching Workspace */}
              <div className="w-full max-w-5xl pt-2 sm:pt-4 pb-2 sm:pb-3 text-left">
                <Composer
                  value={input}
                  onChange={setInput}
                  onSubmit={submit}
                  placeholder={
                    harness === "terminal"
                      ? "Type a shell command (e.g. ls -la, python3 script.py, pip install …) [↵ to run]"
                      : "Type a prompt to launch session… (↵ to send)"
                  }
                  disabled={chat.busy || modelManager.isSwitching}
                  bottomRight={sandboxPickers}
                  harness={harness}
                />
              </div>

              {/* Shortcuts Matrix Footer */}
              <div className="flex flex-wrap items-center justify-center gap-1.5 sm:gap-2 pt-1 pb-4 text-[10px] sm:text-[11px] text-term-dim">
                <button
                  onClick={() => setShowTerminalDrawer(true)}
                  className="rounded border border-term-border/70 bg-term-panel/30 px-2 py-0.5 hover:text-term-green transition-colors"
                >
                  ⌘J Terminal
                </button>
                <button
                  onClick={() => setShowFilesModal(true)}
                  className="rounded border border-term-border/70 bg-term-panel/30 px-2 py-0.5 hover:text-term-green transition-colors"
                >
                  ⌘E Workspace
                </button>
                <button
                  onClick={() => setShowSettings(true)}
                  className="rounded border border-term-border/70 bg-term-panel/30 px-2 py-0.5 hover:text-term-green transition-colors"
                >
                  ⌘, Settings
                </button>
                <button
                  onClick={toggleTheme}
                  className="rounded border border-term-border/70 bg-term-panel/30 px-2 py-0.5 hover:text-term-green transition-colors"
                >
                  ⌘T Theme
                </button>
                <span className="rounded border border-term-border/70 bg-term-panel/30 px-2 py-0.5">
                  ⌘K Home
                </span>
                <span className="rounded border border-term-border/70 bg-term-panel/30 px-2 py-0.5">
                  ⌘M Models
                </span>
                <button
                  onClick={() => setShowShortcutsModal(true)}
                  className="rounded border border-term-border/70 bg-term-panel/30 px-2 py-0.5 hover:text-term-green transition-colors"
                >
                  ⌘/ Shortcuts
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Phase 2: Active Workspace Mode with Multi-Session Docking Grid */
          <div className="flex flex-1 flex-col overflow-hidden w-full h-full px-2 sm:px-4 pt-1 sm:pt-2 pb-2">
            {/* Transcript Area / Multi-Session Dock Grid / Drag & Drop Target */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                if (!isCanvasDragOver) setIsCanvasDragOver(true);
              }}
              onDragLeave={() => setIsCanvasDragOver(false)}
              onDrop={handleCanvasDrop}
              className={`relative flex-1 overflow-hidden min-h-0 py-1 transition-all rounded-lg ${
                isCanvasDragOver ? "ring-2 ring-term-green bg-term-green/[0.02]" : ""
              }`}
            >
              {dockedConvos.length > 0 ? (
                /* Multi-Session Dock Grid: unlimited windows + in-place selection + drag and drop reordering */
                <div
                  className={`grid h-full gap-3 overflow-y-auto ${
                    dockedConvos.length === 2
                      ? "grid-cols-1 md:grid-cols-2"
                      : dockedConvos.length === 3
                        ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
                        : dockedConvos.length === 4
                          ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-4"
                          : dockedConvos.length <= 6
                            ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
                            : "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                  }`}
                >
                  {dockedConvos.map((convo, index) => {
                    const isActive = convo.id === active?.id;
                    const isDragging = draggedIndex === index;
                    const isDragOver = dragOverIndex === index;
                    const paneMode = paneViewModes[convo.id] || (convo.harness === "terminal" ? "terminal" : "chat");

                    return (
                      <div
                        key={convo.id}
                        draggable
                        onDragStart={(e) => {
                          setDraggedIndex(index);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          if (dragOverIndex !== index) setDragOverIndex(index);
                        }}
                        onDragLeave={() => {
                          if (dragOverIndex === index) setDragOverIndex(null);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (draggedIndex !== null && draggedIndex !== index) {
                            setDockedSessionIds((prev) => {
                              const next = [...prev];
                              const [moved] = next.splice(draggedIndex, 1);
                              next.splice(index, 0, moved);
                              return next;
                            });
                          }
                          setDraggedIndex(null);
                          setDragOverIndex(null);
                        }}
                        onDragEnd={() => {
                          setDraggedIndex(null);
                          setDragOverIndex(null);
                        }}
                        onClick={() => chat.select(convo.id)}
                        onDoubleClick={() => {
                          chat.select(convo.id);
                          setDockedSessionIds([]);
                        }}
                        className={`flex flex-col h-full rounded-lg overflow-hidden cursor-pointer transition-all duration-200 ${
                          isDragging ? "opacity-35 scale-[0.98]" : ""
                        } ${
                          isDragOver ? "ring-2 ring-term-green ring-offset-2 ring-offset-term-bg" : ""
                        } ${
                          isActive
                            ? "border-2 border-term-green/90 bg-term-bg/60 shadow-[0_0_18px_rgba(57,255,20,0.15)]"
                            : "border border-term-border bg-term-bg/30 opacity-80 hover:opacity-100 hover:border-term-dim"
                        }`}
                      >
                        {/* Pane Header */}
                        <div
                          onDoubleClick={() => setDockedSessionIds([])}
                          title="Double-click header or press Enter to expand to full window"
                          className={`flex items-center justify-between px-3 py-1.5 text-xs select-none transition-colors ${
                            isActive
                              ? "border-b border-term-border/80 bg-term-panel/80 text-term-fg"
                              : "border-b border-term-border/60 bg-term-panel/40 text-term-dim"
                          }`}
                        >
                          <div className="flex items-center gap-2 truncate">
                            <span
                              className="cursor-grab text-term-dim hover:text-term-fg text-[11px]"
                              title="Drag to rearrange pane position"
                            >
                              ⠿
                            </span>
                            {isActive ? (
                              <span className="text-term-green font-bold text-[11px] shrink-0">● ACTIVE</span>
                            ) : (
                              <span className="text-term-dim text-[11px] shrink-0">○ DOCKED</span>
                            )}
                            <span className={`truncate ${isActive ? "text-term-fg font-medium" : "text-term-dim"}`}>
                              {convo.title || "Session"}
                            </span>
                            {/* Pane Mode Switcher: Dock Workspace, Terminal, or Chat in any combo */}
                            <div className="flex items-center rounded border border-term-border/70 p-0.5 text-[9px] font-mono bg-term-bg/60">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPaneViewModes((prev) => ({ ...prev, [convo.id]: "chat" }));
                                }}
                                className={`px-1.5 py-0.5 rounded transition-colors ${
                                  paneMode === "chat"
                                    ? "bg-term-green/20 text-term-green font-bold"
                                    : "text-term-dim hover:text-term-fg"
                                }`}
                                title="Chat / Message Feed"
                              >
                                /chat
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPaneViewModes((prev) => ({ ...prev, [convo.id]: "terminal" }));
                                }}
                                className={`px-1.5 py-0.5 rounded transition-colors ${
                                  paneMode === "terminal"
                                    ? "bg-term-green/20 text-term-green font-bold"
                                    : "text-term-dim hover:text-term-fg"
                                }`}
                                title="Interactive Terminal PTY"
                              >
                                /terminal
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPaneViewModes((prev) => ({ ...prev, [convo.id]: "workspace" }));
                                }}
                                className={`px-1.5 py-0.5 rounded transition-colors ${
                                  paneMode === "workspace"
                                    ? "bg-term-green/20 text-term-green font-bold"
                                    : "text-term-dim hover:text-term-fg"
                                }`}
                                title="VS Code Monaco & File Tree"
                              >
                                /workspace
                              </button>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-[9px] text-term-dim uppercase truncate max-w-[70px]">
                              [{convo.model.replace(/\.gguf$/i, "")}]
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                undockSession(convo.id);
                              }}
                              className="text-[11px] text-term-dim hover:text-term-red px-1 transition-colors"
                              title="Undock this pane"
                            >
                              ✕
                            </button>
                          </div>
                        </div>

                        {/* Pane Message Transcript OR Interactive Terminal OR Inline Workspace */}
                        {paneMode === "workspace" ? (
                          <div className="flex-1 overflow-hidden p-0 h-full">
                            <FileExplorerModal isOpen={true} inline={true} />
                          </div>
                        ) : paneMode === "terminal" ? (
                          <div className="flex-1 overflow-hidden p-0 h-full">
                            <InteractiveTerminal className="h-full rounded-none border-0 shadow-none" />
                          </div>
                        ) : (
                          <div
                            ref={isActive ? scrollRef : undefined}
                            onScroll={isActive ? onScroll : undefined}
                            className="flex-1 overflow-y-auto px-2.5 py-3 text-sm leading-relaxed"
                          >
                            {convo.messages.length === 0 ? (
                              <div className="flex h-full flex-col items-center justify-center py-6 text-center">
                                <p className="text-term-dim text-xs">
                                  {isActive
                                    ? "Type a prompt below to interact with this session."
                                    : "Click anywhere on this box to focus."}
                                </p>
                              </div>
                            ) : (
                              convo.messages.map((m, i) => (
                                <Message
                                  key={i}
                                  role={m.role}
                                  content={m.content}
                                  tools={m.tools}
                                  stats={m.stats}
                                  harness={convo.harness}
                                  onDelete={isActive ? () => chat.deleteMessage(i) : undefined}
                                  onEdit={isActive ? (newContent) => chat.editMessage(i, newContent) : undefined}
                                />
                              ))
                            )}
                            {isActive && (chat.streaming || chat.liveTools.length > 0) && (
                              <Message
                                role="assistant"
                                content={chat.streaming}
                                tools={chat.liveTools}
                                harness={convo.harness}
                                streaming
                              />
                            )}
                            {isActive && chat.error && (
                              <p className="py-2 text-term-red text-xs">⚠ {chat.error}</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                /* Single Active Session: Fullscreen Workspace OR Interactive Terminal OR Chat Transcript */
                harness === "workspace" ? (
                  <div className="h-full w-full overflow-hidden flex flex-col">
                    <FileExplorerModal
                      isOpen={true}
                      inline={true}
                      onClose={() => setViewMode("landing")}
                    />
                  </div>
                ) : active?.harness === "terminal" && terminalViewModes[active.id] === "interactive" ? (
                  <div className="h-full flex flex-col overflow-hidden">
                    <InteractiveTerminal className="flex-1 rounded-lg border border-term-border shadow-md" />
                  </div>
                ) : (
                  <div
                    ref={scrollRef}
                    onScroll={onScroll}
                    className="h-full overflow-y-auto px-1 py-3 text-sm leading-relaxed sm:px-2"
                  >
                    {!active || active.messages.length === 0 ? (
                      <div className="flex h-full flex-col items-center justify-center py-8 text-center">
                        <Logo variant="hero" className="mb-4 max-w-[340px]" />
                        <div className="max-w-md space-y-2">
                          <p className="text-xs text-term-dim">
                            Ready for inference on your compute node.
                          </p>
                        </div>
                      </div>
                    ) : (
                      active.messages.map((m, i) => (
                        <Message
                          key={i}
                          role={m.role}
                          content={m.content}
                          tools={m.tools}
                          stats={m.stats}
                          harness={active?.harness || harness}
                          onDelete={() => chat.deleteMessage(i)}
                          onEdit={(newContent) => chat.editMessage(i, newContent)}
                        />
                      ))
                    )}
                    {(chat.streaming || chat.liveTools.length > 0) && (
                      <Message
                        role="assistant"
                        content={chat.streaming}
                        tools={chat.liveTools}
                        harness={active?.harness || harness}
                        streaming
                      />
                    )}
                    {chat.error && <p className="py-2 text-term-red text-xs">⚠ {chat.error}</p>}
                    {catalogError &&
                      (backendOnline ? (
                        <p className="py-2 text-term-red text-xs">⚠ {catalogError}</p>
                      ) : (
                        <p className="py-2 text-term-dim text-xs">
                          No backend connected yet. Open ⚙ settings → hit start on compute rig.
                        </p>
                      ))}
                  </div>
                )
              )}

              {!atBottom && harness !== "workspace" && (
                <button
                  onClick={scrollToBottom}
                  className="absolute bottom-3 right-3 flex items-center gap-1 rounded border border-term-border
                             bg-term-panel/90 backdrop-blur px-2.5 py-1 text-xs text-term-dim
                             hover:border-term-green hover:text-term-green shadow-md transition-colors"
                >
                  <span>▾</span>
                  <span>bottom</span>
                </button>
              )}
            </div>

            {/* Composer & Bottom Sandbox Controls (hidden when in fullscreen workspace mode) */}
            {harness !== "workspace" && (
              <div className="pt-2 pb-2">
                {modelManager.isSwitching && (
                  <div className="mb-2 flex items-center justify-between rounded border border-term-amber/40 bg-term-amber/10 px-3 py-1.5 text-xs text-term-amber">
                    <div className="flex items-center gap-2">
                      <span className="animate-pulse">⚡</span>
                      <span>{modelManager.loadingMessage || "SWITCHING PAYLOAD…"}</span>
                    </div>
                    {modelManager.downloadProgress > 0 && (
                      <span className="text-[10px]">
                        {modelManager.downloadProgress}% ({Math.round(modelManager.downloadedMb)}/
                        {Math.round(modelManager.totalMb)}MB)
                      </span>
                    )}
                  </div>
                )}

                {modelManager.error && (
                  <div className="mb-2 rounded border border-term-red/40 bg-term-red/10 px-3 py-1 text-xs text-term-red">
                    ⚠ {modelManager.error}
                  </div>
                )}

                <Composer
                  value={input}
                  onChange={setInput}
                  onSubmit={submit}
                  disabled={chat.busy || modelManager.isSwitching}
                  bottomRight={sandboxPickers}
                  harness={harness}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <ModelPickerModal
        isOpen={showModelModal}
        onClose={() => setShowModelModal(false)}
        currentModelId={model}
        onSelectModel={handleSelectModel}
        modelManager={modelManager}
        hfToken={kaggle.hfToken}
        gpuActive={kaggle.accelerator === "gpu"}
      />

      <ShortcutsModal
        isOpen={showShortcutsModal}
        onClose={() => setShowShortcutsModal(false)}
      />

      <FileExplorerModal
        isOpen={showFilesModal}
        onClose={() => setShowFilesModal(false)}
      />

      <LivePreviewModal
        isOpen={showPreviewModal}
        onClose={() => setShowPreviewModal(false)}
        initialUrl={previewUrl}
      />

      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        kaggle={kaggle}
        backend={backend}
        settings={settings}
        onSettingsChange={updateSettings}
      />
    </main>
  );
}
