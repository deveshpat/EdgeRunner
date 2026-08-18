"use client";

import { useEffect, useRef, useState } from "react";
import { vfs, wasmShell } from "@/lib/wasmShell";

interface CodeEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialFile?: string;
}

export function CodeEditorModal({
  isOpen,
  onClose,
  initialFile,
}: CodeEditorModalProps) {
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string>("");
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
  const [newFileName, setNewFileName] = useState("");
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  // Terminal Run state
  const [runOutput, setRunOutput] = useState<string | null>(null);
  const [runExitCode, setRunExitCode] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load files on mount
  useEffect(() => {
    if (!isOpen) return;
    const all = vfs.listFiles();
    const defaultTabs = all.slice(0, 5);
    const startTab = initialFile || defaultTabs[0] || "main.py";

    if (!defaultTabs.includes(startTab) && vfs.readFile(startTab) !== null) {
      defaultTabs.unshift(startTab);
    }

    setOpenTabs(defaultTabs);
    setActiveTab(startTab);

    const contents: Record<string, string> = {};
    for (const tab of defaultTabs) {
      contents[tab] = vfs.readFile(tab) || "";
    }
    if (!contents[startTab]) {
      contents[startTab] = vfs.readFile(startTab) || "";
    }
    setFileContents(contents);
    setDirtyTabs(new Set());
  }, [isOpen, initialFile]);

  // Handle Tab Switch
  function switchTab(tab: string) {
    setActiveTab(tab);
    if (!fileContents[tab]) {
      const content = vfs.readFile(tab) || "";
      setFileContents((prev) => ({ ...prev, [tab]: content }));
    }
  }

  // Handle Close Tab
  function closeTab(tab: string, e: React.MouseEvent) {
    e.stopPropagation();
    const remaining = openTabs.filter((t) => t !== tab);
    setOpenTabs(remaining);
    if (activeTab === tab && remaining.length > 0) {
      switchTab(remaining[0]);
    }
  }

  // Handle Content Change
  function handleContentChange(val: string) {
    if (!activeTab) return;
    setFileContents((prev) => ({ ...prev, [activeTab]: val }));
    setDirtyTabs((prev) => new Set(prev).add(activeTab));
  }

  // Save Active File
  function saveActiveFile() {
    if (!activeTab) return;
    const content = fileContents[activeTab] ?? "";
    vfs.writeFile(activeTab, content);
    setDirtyTabs((prev) => {
      const next = new Set(prev);
      next.delete(activeTab);
      return next;
    });
    setSaveStatus("✓ Saved");
    setTimeout(() => setSaveStatus(null), 2000);
  }

  // Create New File
  function handleCreateNewFile() {
    const clean = newFileName.trim();
    if (!clean) return;
    vfs.writeFile(clean, "");
    setOpenTabs((prev) => (prev.includes(clean) ? prev : [...prev, clean]));
    setFileContents((prev) => ({ ...prev, [clean]: "" }));
    setActiveTab(clean);
    setNewFileName("");
    setShowNewFileInput(false);
  }

  // Run Active File in Terminal / Multi-Language Engine
  async function handleRunActiveFile() {
    if (!activeTab) return;
    saveActiveFile();
    setIsRunning(true);
    setRunOutput(null);
    setRunExitCode(null);

    let cmd = activeTab;
    if (activeTab.endsWith(".c")) cmd = `gcc ${activeTab}`;
    else if (activeTab.endsWith(".cpp") || activeTab.endsWith(".cc")) cmd = `g++ ${activeTab}`;
    else if (activeTab.endsWith(".rs")) cmd = `rustc ${activeTab}`;
    else if (activeTab.endsWith(".go")) cmd = `go run ${activeTab}`;
    else if (activeTab.endsWith(".java")) cmd = `java ${activeTab}`;
    else if (activeTab.endsWith(".py")) cmd = `python3 ${activeTab}`;
    else if (activeTab.endsWith(".js")) cmd = `node ${activeTab}`;
    else if (activeTab.endsWith(".rb")) cmd = `ruby ${activeTab}`;
    else if (activeTab.endsWith(".php")) cmd = `php ${activeTab}`;

    try {
      const res = await wasmShell.execute(cmd);
      setRunOutput(res.output || "(no output)");
      setRunExitCode(res.exitCode);
    } catch (err: unknown) {
      setRunOutput(String(err));
      setRunExitCode(1);
    } finally {
      setIsRunning(false);
    }
  }

  // Keyboard Shortcuts (⌘S to save, ⌘↵ to run)
  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveActiveFile();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleRunActiveFile();
    }
    // Handle Tab key in textarea
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = ta.value;
      const next = val.substring(0, start) + "  " + val.substring(end);
      handleContentChange(next);
      setTimeout(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      }, 0);
    }
  }

  if (!isOpen) return null;

  const currentText = (activeTab ? fileContents[activeTab] : "") ?? "";
  const lines = currentText.split("\n");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-2 sm:p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-[90vh] max-h-[820px] w-full max-w-5xl flex-col rounded-lg border border-term-border bg-term-bg shadow-2xl font-mono text-xs overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header / Actions */}
        <div className="flex items-center justify-between border-b border-term-border bg-term-panel px-3 py-2 shrink-0 select-none">
          <div className="flex items-center gap-2">
            <span className="text-term-green font-bold text-sm">📝</span>
            <span className="font-bold text-xs uppercase text-term-fg">
              Workspace Code Editor
            </span>
          </div>

          <div className="flex items-center gap-2">
            {saveStatus && (
              <span className="text-term-green font-semibold text-[11px] animate-pulse">
                {saveStatus}
              </span>
            )}
            <button
              onClick={saveActiveFile}
              disabled={!activeTab}
              className="rounded border border-term-green/60 bg-term-green/10 px-2.5 py-1 text-xs font-bold text-term-green hover:bg-term-green/20 transition-colors"
              title="Save File (⌘S)"
            >
              💾 Save
            </button>
            <button
              onClick={handleRunActiveFile}
              disabled={!activeTab || isRunning}
              className="rounded border border-term-green bg-term-green text-black px-2.5 py-1 text-xs font-bold hover:opacity-90 transition-opacity disabled:opacity-50"
              title="Run Active File (⌘↵)"
            >
              {isRunning ? "⚡ Running…" : "▶ Run (⌘↵)"}
            </button>
            <button
              onClick={onClose}
              className="flex h-6 w-6 items-center justify-center rounded border border-term-border text-term-dim hover:border-term-green hover:text-term-fg text-xs transition-colors"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Tab Bar */}
        <div className="flex items-center border-b border-term-border bg-term-panel/40 px-2 pt-1.5 gap-1 shrink-0 overflow-x-auto select-none">
          {openTabs.map((tab) => {
            const isActive = tab === activeTab;
            const isDirty = dirtyTabs.has(tab);
            return (
              <div
                key={tab}
                onClick={() => switchTab(tab)}
                className={`flex items-center gap-2 px-3 py-1 rounded-t border-t border-x cursor-pointer transition-colors text-xs ${
                  isActive
                    ? "bg-term-bg border-term-border text-term-green font-bold"
                    : "bg-term-panel/40 border-transparent text-term-dim hover:text-term-fg"
                }`}
              >
                <span>{tab}</span>
                {isDirty && <span className="h-1.5 w-1.5 rounded-full bg-term-amber" title="Unsaved changes" />}
                <button
                  onClick={(e) => closeTab(tab, e)}
                  className="hover:text-term-red text-[10px] opacity-60 hover:opacity-100"
                >
                  ✕
                </button>
              </div>
            );
          })}

          {showNewFileInput ? (
            <div className="flex items-center gap-1 pb-1">
              <input
                type="text"
                placeholder="filename.py"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateNewFile();
                  if (e.key === "Escape") setShowNewFileInput(false);
                }}
                autoFocus
                className="h-6 w-28 rounded border border-term-green bg-term-bg px-1.5 text-xs text-term-fg focus:outline-none"
              />
              <button
                onClick={handleCreateNewFile}
                className="text-[10px] text-term-green font-bold"
              >
                ✓
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowNewFileInput(true)}
              className="px-2 py-1 text-xs text-term-dim hover:text-term-green transition-colors pb-1.5 font-bold"
              title="Add New File"
            >
              + New
            </button>
          )}
        </div>

        {/* Editor Body: Line Numbers + Textarea */}
        <div className="flex flex-1 overflow-hidden bg-term-bg relative">
          {activeTab ? (
            <>
              {/* Line Numbers */}
              <div className="w-12 select-none border-r border-term-border/50 bg-term-panel/20 py-3 text-right pr-3 font-mono text-xs text-term-dim/40 leading-relaxed overflow-hidden shrink-0">
                {lines.map((_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>

              {/* Textarea Code Canvas */}
              <textarea
                ref={textareaRef}
                value={currentText}
                onChange={(e) => handleContentChange(e.target.value)}
                onKeyDown={handleKeyDown}
                spellCheck={false}
                className="flex-1 resize-none bg-transparent p-3 font-mono text-xs sm:text-sm text-term-fg focus:outline-none leading-relaxed overflow-auto"
                placeholder="Start coding here… (⌘S to save, ⌘↵ to run)"
              />
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center text-term-dim">
              <p>No file open. Click "+ New" or select a file from the workspace.</p>
            </div>
          )}
        </div>

        {/* Live Run Output Drawer */}
        {runOutput !== null && (
          <div className="border-t border-term-border bg-term-panel/95 h-36 flex flex-col shrink-0">
            <div className="flex items-center justify-between px-3 py-1 border-b border-term-border text-[10px] text-term-dim select-none">
              <div className="flex items-center gap-2">
                <span className="font-bold text-term-fg">TERMINAL OUTPUT</span>
                <span
                  className={
                    runExitCode === 0
                      ? "text-term-green font-semibold"
                      : "text-term-red font-semibold"
                  }
                >
                  ● exit {runExitCode}
                </span>
              </div>
              <button
                onClick={() => setRunOutput(null)}
                className="hover:text-term-fg transition-colors"
              >
                ✕ Close
              </button>
            </div>
            <pre className="flex-1 overflow-y-auto p-3 font-mono text-xs text-term-fg whitespace-pre-wrap">
              {runOutput}
            </pre>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-term-border bg-term-panel/40 px-3 py-1.5 text-[10px] text-term-dim shrink-0 select-none">
          <span>
            {activeTab ? `${activeTab} · ${lines.length} lines · UTF-8` : "No File"}
          </span>
          <div className="flex items-center gap-3">
            <span>⌘S: Save</span>
            <span>⌘↵: Run</span>
            <span>Tab: 2 Spaces</span>
          </div>
        </div>
      </div>
    </div>
  );
}
