"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useWorkspaceFiles, type FileItem } from "@/lib/useWorkspaceFiles";
import { gitManager, type GitCommit } from "@/lib/gitManager";
import { wasmShell } from "@/lib/wasmShell";
import { zipExporter } from "@/lib/zipExporter";
import { FileIcon } from "./FileIcons";

// Dynamically load Monaco Editor (VS Code Editor Engine)
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

interface FileExplorerModalProps {
  isOpen: boolean;
  onClose?: () => void;
  onRunFile?: (path: string) => void;
  inline?: boolean;
}

function getLanguageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "py": return "python";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx": return "javascript";
    case "ts":
    case "tsx": return "typescript";
    case "rs": return "rust";
    case "c":
    case "h": return "c";
    case "cpp":
    case "cc":
    case "hpp": return "cpp";
    case "go": return "go";
    case "java": return "java";
    case "rb": return "ruby";
    case "php": return "php";
    case "html":
    case "htm": return "html";
    case "css":
    case "scss": return "css";
    case "json": return "json";
    case "md":
    case "markdown": return "markdown";
    case "sh":
    case "bash":
    case "zsh": return "shell";
    case "yaml":
    case "yml": return "yaml";
    case "sql": return "sql";
    case "xml":
    case "svg": return "xml";
    default: return "plaintext";
  }
}

export function FileExplorerModal({ isOpen, onClose, inline }: FileExplorerModalProps) {
  const { items, loading, error, refresh, readFile, writeFile, mkdir, deleteItem } = useWorkspaceFiles();
  const [activityTab, setActivityTab] = useState<"explorer" | "search" | "git">("explorer");

  // Open tabs
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [originalContent, setOriginalContent] = useState<string>("");
  const [loadingFile, setLoadingFile] = useState<boolean>(false);
  const [savingFile, setSavingFile] = useState<boolean>(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");

  // New file / folder creation
  const [newFileName, setNewFileName] = useState<string>("");
  const [newFolderName, setNewFolderName] = useState<string>("");
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);

  // Execution state
  const [isRunning, setIsRunning] = useState(false);
  const [runOutput, setRunOutput] = useState<{ title: string; output: string; exitCode: number } | null>(null);

  // Git state
  const [gitStatus, setGitStatus] = useState<{
    branch: string;
    staged: string[];
    modified: string[];
    untracked: string[];
  }>({ branch: "main", staged: [], modified: [], untracked: [] });
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [commitMessage, setCommitMessage] = useState<string>("");
  const [gitNotice, setGitNotice] = useState<string | null>(null);

  const importFileRef = useRef<HTMLInputElement>(null);
  const [isLight, setIsLight] = useState(false);
  const [mobileTab, setMobileTab] = useState<"files" | "editor">("files");

  // Folder collapse / expand state
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  const [allCollapsed, setAllCollapsed] = useState(false);

  const toggleFolder = (path: string) => {
    setCollapsedFolders((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const toggleCollapseAll = () => {
    setAllCollapsed((prev) => {
      const next = !prev;
      if (next) {
        const map: Record<string, boolean> = {};
        function mark(nodes: FileItem[]) {
          for (const n of nodes) {
            if (n.type === "directory") {
              map[n.path] = true;
              if (n.children) mark(n.children);
            }
          }
        }
        mark(items);
        setCollapsedFolders(map);
      } else {
        setCollapsedFolders({});
      }
      return next;
    });
  };

  // Real-time theme change observation
  useEffect(() => {
    function updateTheme() {
      if (typeof document !== "undefined") {
        setIsLight(document.documentElement.getAttribute("data-theme") === "light");
      }
    }
    updateTheme();

    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    function handleRejection(e: PromiseRejectionEvent) {
      const reason = e.reason;
      if (
        reason === "Canceled" ||
        reason?.message === "Canceled" ||
        reason?.name === "Canceled" ||
        reason?.type === "cancel" ||
        (typeof reason === "string" && reason.includes("Canceled"))
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      observer.disconnect();
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, [isOpen]);

  const refreshGit = () => {
    setGitStatus(gitManager.status());
    setCommits(gitManager.log(20));
  };

  useEffect(() => {
    if (isOpen) {
      refresh();
      refreshGit();
    }
  }, [isOpen, refresh]);

  // Listen to external open events (e.g. from nano / code command)
  useEffect(() => {
    function handleOpenTargetFile(e: any) {
      if (e.detail?.path) {
        handleSelectFile(e.detail.path);
      }
    }
    window.addEventListener("edgerunner:open-file", handleOpenTargetFile);
    return () => window.removeEventListener("edgerunner:open-file", handleOpenTargetFile);
  }, []);

  async function handleSelectFile(path: string) {
    if (!openFiles.includes(path)) {
      setOpenFiles((prev) => [...prev, path]);
    }
    setSelectedFile(path);
    setMobileTab("editor");
    setLoadingFile(true);
    setSaveStatus(null);
    try {
      const data = await readFile(path);
      setFileContent(data.content);
      setOriginalContent(data.content);
    } catch {
      setFileContent("// Error reading file");
    } finally {
      setLoadingFile(false);
    }
  }

  function handleCloseTab(path: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    const next = openFiles.filter((f) => f !== path);
    setOpenFiles(next);
    if (selectedFile === path) {
      if (next.length > 0) {
        handleSelectFile(next[next.length - 1]);
      } else {
        setSelectedFile(null);
        setFileContent("");
      }
    }
  }

  async function handleSave() {
    if (!selectedFile) return;
    setSavingFile(true);
    setSaveStatus(null);
    try {
      await writeFile(selectedFile, fileContent);
      setOriginalContent(fileContent);
      setSaveStatus("✓ saved");
      refreshGit();
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveStatus(`error: ${msg}`);
    } finally {
      setSavingFile(false);
    }
  }

  async function handleDelete(path: string) {
    if (!confirm(`Delete ${path}?`)) return;
    await deleteItem(path);
    handleCloseTab(path);
    refreshGit();
  }

  async function handleCreateNewFile() {
    const name = newFileName.trim();
    if (!name) return;
    await writeFile(name, "");
    setNewFileName("");
    setShowNewFileInput(false);
    handleSelectFile(name);
    refreshGit();
  }

  async function handleCreateNewFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    await mkdir(name);
    setNewFolderName("");
    setShowNewFolderInput(false);
    refreshGit();
  }

  async function handleRunCurrentFile() {
    if (!selectedFile) return;
    setIsRunning(true);
    let cmd = selectedFile;
    if (selectedFile.endsWith(".py")) cmd = `python3 ${selectedFile}`;
    else if (selectedFile.endsWith(".js") || selectedFile.endsWith(".mjs")) cmd = `node ${selectedFile}`;
    else if (selectedFile.endsWith(".sh") || selectedFile.endsWith(".bash")) cmd = `bash ${selectedFile}`;
    else if (selectedFile.endsWith(".c")) cmd = `gcc ${selectedFile}`;
    else if (selectedFile.endsWith(".cpp")) cmd = `g++ ${selectedFile}`;
    else if (selectedFile.endsWith(".rs")) cmd = `rustc ${selectedFile}`;
    else if (selectedFile.endsWith(".go")) cmd = `go ${selectedFile}`;
    else cmd = `cat ${selectedFile}`;

    try {
      const res = await wasmShell.execute(cmd);
      setRunOutput({
        title: cmd,
        output: res.output || "(no output)",
        exitCode: res.exitCode,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setRunOutput({ title: cmd, output: `error: ${msg}`, exitCode: 1 });
    } finally {
      setIsRunning(false);
    }
  }

  function handleStageAll() {
    gitManager.add(".");
    refreshGit();
    setGitNotice("✓ Staged all changes");
    setTimeout(() => setGitNotice(null), 2500);
  }

  function handleStageFile(file: string) {
    gitManager.add(file);
    refreshGit();
  }

  function handleCommit() {
    if (!commitMessage.trim()) return;
    gitManager.commit(commitMessage.trim());
    setCommitMessage("");
    refreshGit();
    setGitNotice("✓ Commit successful");
    setTimeout(() => setGitNotice(null), 2500);
  }

  function handleCheckout(branchOrHash: string) {
    gitManager.checkout(branchOrHash);
    refreshGit();
    refresh();
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const text = await file.text();
      await writeFile(file.name, text);
    }
    refresh();
    refreshGit();
  }

  // Flattened file list for searching
  const flattenedFiles = useMemo(() => {
    const list: string[] = [];
    function collect(nodes: FileItem[]) {
      for (const n of nodes) {
        if (n.type === "file") list.push(n.path);
        if (n.children) collect(n.children);
      }
    }
    collect(items);
    return list;
  }, [items]);

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return flattenedFiles.filter((p) => p.toLowerCase().includes(q));
  }, [searchQuery, flattenedFiles]);

  if (!isOpen) return null;

  const content = (
    <div
      className={`flex flex-col rounded-lg border border-term-border bg-term-bg font-mono text-sm sm:text-base overflow-hidden ${
        inline ? "h-full w-full shadow-none border-0 rounded-none" : "h-[92vh] max-h-[950px] w-full max-w-6xl shadow-2xl"
      }`}
      onClick={(e) => e.stopPropagation()}
    >
      {/* VS Code Window Titlebar - Only rendered when in modal mode (to prevent duplicate traffic lights in inline/fullscreen mode) */}
      {!inline && (
        <div className="flex items-center justify-between border-b border-term-border bg-term-panel px-3 py-2 shrink-0 select-none text-xs sm:text-sm">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 mr-1">
              <button
                onClick={onClose}
                title="Close Workspace"
                className="h-3 w-3 rounded-full bg-[#FF5F56] transition-transform hover:scale-110 active:scale-95 shadow-sm"
              />
              <button
                onClick={onClose}
                title="Minimize Workspace"
                className="h-3 w-3 rounded-full bg-[#FFBD2E] transition-transform hover:scale-110 active:scale-95 shadow-sm"
              />
              <button
                title="Expand Workspace"
                className="h-3 w-3 rounded-full bg-[#27C93F] transition-transform hover:scale-110 active:scale-95 shadow-sm"
              />
            </div>
            <span className="text-term-dim font-semibold ml-1 truncate max-w-[140px] sm:max-w-[280px]">
              {selectedFile ? `${selectedFile.split("/").pop()} — EdgeRunner VS Code` : "EdgeRunner Workspace"}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => zipExporter.downloadZip()}
              className="flex items-center gap-1.5 rounded border border-term-border px-2.5 py-1 text-xs text-term-dim hover:text-term-green hover:border-term-green transition-colors"
              title="Download entire workspace as a .zip file"
            >
              <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                <path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"/>
              </svg>
              <span className="hidden sm:inline">Export .ZIP</span>
            </button>
          </div>
        </div>
      )}

        {/* Main Work Area */}
        <div className="flex flex-1 overflow-hidden">
          {/* VS Code Activity Bar (Far Left) */}
          <div className="w-12 sm:w-14 bg-term-panel border-r border-term-border flex flex-col items-center py-3 gap-3 shrink-0 select-none">
            <button
              onClick={() => {
                setActivityTab("explorer");
                setMobileTab("files");
              }}
              className={`p-2 rounded transition-colors ${
                activityTab === "explorer" ? "text-term-green bg-term-green/10" : "text-term-dim hover:text-term-fg"
              }`}
              title="Explorer (Files & Folders)"
            >
              <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
              </svg>
            </button>

            <button
              onClick={() => {
                setActivityTab("search");
                setMobileTab("files");
              }}
              className={`p-2 rounded transition-colors ${
                activityTab === "search" ? "text-term-green bg-term-green/10" : "text-term-dim hover:text-term-fg"
              }`}
              title="Search Workspace Files"
            >
              <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
              </svg>
            </button>

            <button
              onClick={() => {
                setActivityTab("git");
                setMobileTab("files");
                refreshGit();
              }}
              className={`p-2 rounded transition-colors relative ${
                activityTab === "git" ? "text-term-green bg-term-green/10" : "text-term-dim hover:text-term-fg"
              }`}
              title="Source Control (Git DAG)"
            >
              <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                <path d="M19.5 8a3.5 3.5 0 0 0-3.32 2.41 4.5 4.5 0 0 0-4.68 3.59A3.5 3.5 0 0 0 8 13.5V6.82a3.5 3.5 0 1 0-2 0v10.36a3.5 3.5 0 1 0 2.05.58 4.48 4.48 0 0 0 4.14-3.26 4.51 4.51 0 0 0 3.81-2.9 3.5 3.5 0 1 0 3.5-3.1zM6 4a1.5 1.5 0 1 1-1.5 1.5A1.5 1.5 0 0 1 6 4zm1 16a1.5 1.5 0 1 1 1.5-1.5A1.5 1.5 0 0 1 7 20zm12.5-9a1.5 1.5 0 1 1 1.5-1.5 1.5 1.5 0 0 1-1.5 1.5z"/>
              </svg>
              {gitStatus.modified.length > 0 && (
                <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-term-green" />
              )}
            </button>

            <button
              onClick={() => zipExporter.downloadZip()}
              className="mt-auto p-2 rounded transition-colors text-term-dim hover:text-term-green hover:bg-term-green/10"
              title="Export Workspace as .ZIP"
            >
              <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                <path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"/>
              </svg>
            </button>
          </div>

          {/* VS Code Side Bar (Explorer / Search / Git) */}
          <div className={`w-full md:w-64 sm:w-72 bg-term-panel/40 border-r border-term-border flex-col shrink-0 select-none ${mobileTab === "files" ? "flex" : "hidden md:flex"}`}>
            {activityTab === "explorer" && (
              <>
                {/* Explorer Toolbar Header */}
                <div className="flex items-center justify-between border-b border-term-border p-2 sm:p-2.5 text-xs text-term-dim">
                  <div className="flex items-center gap-1.5 truncate">
                    <span className="uppercase font-bold tracking-wider text-[11px] truncate">Explorer</span>
                    {openFiles.length > 0 && (
                      <button
                        onClick={() => setMobileTab("editor")}
                        className="md:hidden px-1.5 py-0.5 rounded border border-term-border bg-term-panel text-term-green text-[10px] font-bold"
                        title="Switch to Editor"
                      >
                        Code ({openFiles.length}) →
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {/* New File */}
                    <button
                      onClick={() => {
                        setShowNewFileInput((x) => !x);
                        setShowNewFolderInput(false);
                      }}
                      className="p-1 rounded hover:bg-term-panel text-term-dim hover:text-term-green transition-colors"
                      title="New File"
                    >
                      <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                        <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 14h-3v3h-2v-3H8v-2h3v-3h2v3h3v2zm-3-7V3.5L18.5 9H13z"/>
                      </svg>
                    </button>

                    {/* New Folder */}
                    <button
                      onClick={() => {
                        setShowNewFolderInput((x) => !x);
                        setShowNewFileInput(false);
                      }}
                      className="p-1 rounded hover:bg-term-panel text-term-dim hover:text-term-green transition-colors"
                      title="New Folder"
                    >
                      <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                        <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3v-3h2v3h3v2z"/>
                      </svg>
                    </button>

                    {/* Upload Files */}
                    <button
                      onClick={() => importFileRef.current?.click()}
                      className="p-1 rounded hover:bg-term-panel text-term-dim hover:text-term-green transition-colors"
                      title="Upload Files from Device"
                    >
                      <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                        <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/>
                      </svg>
                    </button>
                    <input
                      ref={importFileRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={handleImportFile}
                    />

                    {/* Quick Search */}
                    <button
                      onClick={() => {
                        setActivityTab("search");
                        setMobileTab("files");
                      }}
                      className="p-1 rounded hover:bg-term-panel text-term-dim hover:text-term-green transition-colors"
                      title="Search Workspace Files"
                    >
                      <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                        <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                      </svg>
                    </button>

                    {/* Collapse / Expand All Folders */}
                    <button
                      onClick={toggleCollapseAll}
                      className="p-1 rounded hover:bg-term-panel text-term-dim hover:text-term-green transition-colors"
                      title={allCollapsed ? "Expand All Folders" : "Collapse All Folders"}
                    >
                      <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                        <path d="M4 4h16v2H4zm0 6h16v2H4zm4 6h8v2H8z"/>
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Inline New File Input */}
                {showNewFileInput && (
                  <div className="p-2 border-b border-term-border flex items-center gap-1 bg-term-panel/70">
                    <input
                      type="text"
                      placeholder="main.py, index.ts…"
                      value={newFileName}
                      onChange={(e) => setNewFileName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleCreateNewFile()}
                      className="flex-1 rounded border border-term-border bg-term-bg px-2 py-1 text-xs text-term-fg focus:outline-none focus:border-term-green"
                      autoFocus
                    />
                    <button
                      onClick={handleCreateNewFile}
                      className="rounded border border-term-green/60 bg-term-green/20 px-2 py-1 text-xs text-term-green font-bold"
                    >
                      OK
                    </button>
                  </div>
                )}

                {/* Inline New Folder Input */}
                {showNewFolderInput && (
                  <div className="p-2 border-b border-term-border flex items-center gap-1 bg-term-panel/70">
                    <input
                      type="text"
                      placeholder="src, components…"
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleCreateNewFolder()}
                      className="flex-1 rounded border border-term-border bg-term-bg px-2 py-1 text-xs text-term-fg focus:outline-none focus:border-term-green"
                      autoFocus
                    />
                    <button
                      onClick={handleCreateNewFolder}
                      className="rounded border border-term-green/60 bg-term-green/20 px-2 py-1 text-xs text-term-green font-bold"
                    >
                      OK
                    </button>
                  </div>
                )}

                {/* Tree Items List */}
                <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
                  {loading && items.length === 0 ? (
                    <p className="py-6 text-center text-term-dim text-xs">Loading tree…</p>
                  ) : error ? (
                    <p className="py-4 text-center text-term-red text-xs">{error}</p>
                  ) : items.length === 0 ? (
                    <div className="py-8 text-center text-term-dim text-xs">
                      <p>Workspace is empty.</p>
                      <p className="mt-1 text-[11px]">Create files with the new file or folder icons above</p>
                    </div>
                  ) : (
                    <RenderTreeItems
                      items={items}
                      selectedFile={selectedFile}
                      onSelect={handleSelectFile}
                      onDelete={handleDelete}
                      collapsedFolders={collapsedFolders}
                      onToggleFolder={toggleFolder}
                    />
                  )}
                </div>
              </>
            )}

            {activityTab === "search" && (
              <div className="flex-1 flex flex-col p-3 gap-2">
                <span className="text-xs uppercase font-bold text-term-dim tracking-wider">Search Workspace</span>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by file name…"
                  className="w-full rounded border border-term-border bg-term-bg px-2.5 py-1.5 text-xs text-term-fg focus:outline-none focus:border-term-green"
                  autoFocus
                />
                <div className="flex-1 overflow-y-auto space-y-1 mt-1">
                  {searchResults.map((p) => (
                    <div
                      key={p}
                      onClick={() => handleSelectFile(p)}
                      className="flex items-center gap-2 rounded px-2.5 py-1.5 hover:bg-term-panel cursor-pointer text-xs text-term-fg"
                    >
                      <FileIcon path={p} className="w-4 h-4 shrink-0" />
                      <span className="truncate">{p}</span>
                    </div>
                  ))}
                  {searchQuery && searchResults.length === 0 && (
                    <p className="text-xs text-term-dim text-center py-4">No matching files</p>
                  )}
                </div>
              </div>
            )}

            {activityTab === "git" && (
              <div className="flex-1 flex flex-col p-3 overflow-y-auto space-y-3 text-xs">
                <div className="flex items-center justify-between border-b border-term-border pb-2">
                  <span className="font-bold text-term-fg uppercase tracking-wider">Source Control (Git)</span>
                  <button
                    onClick={handleStageAll}
                    className="text-[11px] font-bold text-term-green hover:underline"
                  >
                    + Stage All
                  </button>
                </div>

                {/* Staged & Modified Files */}
                <div className="space-y-1.5">
                  <span className="text-[11px] uppercase font-bold text-term-dim">
                    Changes ({gitStatus.staged.length + gitStatus.modified.length + gitStatus.untracked.length})
                  </span>
                  <div className="space-y-1 max-h-36 overflow-y-auto">
                    {gitStatus.staged.map((f) => (
                      <div key={f} className="flex items-center justify-between text-term-green text-xs">
                        <span className="truncate flex items-center gap-1">
                          <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                          </svg>
                          {f}
                        </span>
                        <span className="text-[10px] uppercase">[staged]</span>
                      </div>
                    ))}
                    {gitStatus.modified.map((f) => (
                      <div key={f} className="flex items-center justify-between text-term-amber text-xs">
                        <span className="truncate">● {f}</span>
                        <button
                          onClick={() => handleStageFile(f)}
                          className="text-[10px] text-term-dim hover:text-term-fg"
                        >
                          + stage
                        </button>
                      </div>
                    ))}
                    {gitStatus.untracked.map((f) => (
                      <div key={f} className="flex items-center justify-between text-term-dim text-xs">
                        <span className="truncate">? {f}</span>
                        <button
                          onClick={() => handleStageFile(f)}
                          className="text-[10px] text-term-dim hover:text-term-fg"
                        >
                          + stage
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Commit Box */}
                <div className="space-y-1.5 pt-2 border-t border-term-border">
                  <textarea
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    placeholder="Commit message (⌘Enter to commit)…"
                    className="w-full h-16 p-2 rounded border border-term-border bg-term-bg text-term-fg text-xs focus:outline-none focus:border-term-green resize-none"
                  />
                  <button
                    onClick={handleCommit}
                    disabled={!commitMessage.trim()}
                    className="w-full rounded border border-term-green/60 bg-term-green/20 py-1 text-xs font-bold text-term-green hover:bg-term-green/30 disabled:opacity-40"
                  >
                    Commit
                  </button>
                  {gitNotice && (
                    <p className="text-xs text-center text-term-green font-semibold">{gitNotice}</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* VS Code Editor & Tab Stage */}
          <div className={`flex-1 flex-col bg-term-bg overflow-hidden ${mobileTab === "editor" ? "flex" : "hidden md:flex"}`}>
            {openFiles.length > 0 ? (
              <>
                {/* VS Code Tab Bar */}
                <div className="flex items-center justify-between border-b border-term-border bg-term-panel shrink-0 select-none overflow-x-auto">
                  <div className="flex items-center overflow-x-auto">
                    {openFiles.map((f) => {
                      const isTabActive = f === selectedFile;
                      const isMod = f === selectedFile && fileContent !== originalContent;
                      return (
                        <div
                          key={f}
                          onClick={() => handleSelectFile(f)}
                          className={`flex items-center gap-2 px-3.5 py-2 border-r border-term-border text-xs sm:text-sm cursor-pointer transition-colors ${
                            isTabActive
                              ? "bg-term-bg text-term-fg font-bold border-t-2 border-t-term-green"
                              : "bg-term-panel text-term-dim hover:bg-term-bg/60 hover:text-term-fg"
                          }`}
                        >
                          <FileIcon path={f} className="w-4 h-4 shrink-0" />
                          <span className="truncate max-w-[150px]">{f.split("/").pop()}</span>
                          {isMod && <span className="h-2 w-2 rounded-full bg-term-amber ml-1" />}
                          <button
                            onClick={(e) => handleCloseTab(f, e)}
                            className="text-term-dim hover:text-term-fg text-xs ml-1.5 p-0.5 rounded"
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 px-3 py-1">
                    {saveStatus && (
                      <span className="text-xs text-term-green font-semibold animate-pulse">
                        {saveStatus}
                      </span>
                    )}
                    <button
                      onClick={handleRunCurrentFile}
                      disabled={isRunning || !selectedFile}
                      className="flex items-center gap-1.5 rounded bg-term-green/20 border border-term-green/50 px-2.5 py-1 text-xs font-semibold text-term-green hover:bg-term-green/30 transition-colors"
                      title="Run file"
                    >
                      <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z"/>
                      </svg>
                      <span>{isRunning ? "Running…" : "Run"}</span>
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={savingFile || fileContent === originalContent}
                      className="rounded border border-term-border bg-term-panel px-2.5 py-1 text-xs font-semibold text-term-dim hover:text-term-fg disabled:opacity-40 transition-colors"
                      title="Save (⌘S)"
                    >
                      {savingFile ? "saving…" : "Save"}
                    </button>
                  </div>
                </div>

                {/* VS Code Breadcrumb Bar */}
                <div className="flex items-center px-3 py-1.5 text-xs text-term-dim border-b border-term-border/60 bg-term-bg select-none gap-1.5 truncate">
                  <button
                    onClick={() => setMobileTab("files")}
                    className="md:hidden flex items-center gap-1 px-1.5 py-0.5 rounded border border-term-border bg-term-panel text-term-green hover:text-term-fg text-[11px] font-bold shrink-0 mr-1"
                    title="Back to file tree"
                  >
                    ← Files
                  </button>
                  <span>workspace</span>
                  <span>›</span>
                  <span className="text-term-fg font-semibold truncate">{selectedFile}</span>
                </div>

                {/* Monaco Editor Container */}
                <div className="flex-1 relative overflow-hidden">
                  {loadingFile ? (
                    <div className="flex h-full items-center justify-center text-term-dim text-sm">
                      Loading file…
                    </div>
                  ) : (
                    <MonacoEditor
                      height="100%"
                      path={selectedFile || "default.txt"}
                      language={selectedFile ? getLanguageFromPath(selectedFile) : "plaintext"}
                      value={fileContent}
                      theme={isLight ? "vs" : "vs-dark"}
                      onChange={(v) => setFileContent(v || "")}
                      keepCurrentModel={true}
                      options={{
                        minimap: { enabled: true },
                        fontSize: 14.5,
                        fontFamily: "'JetBrains Mono', Menlo, Monaco, monospace",
                        lineNumbers: "on",
                        scrollBeyondLastLine: false,
                        tabSize: 2,
                        wordWrap: "on",
                        automaticLayout: true,
                        renderWhitespace: "selection",
                      }}
                    />
                  )}
                </div>

                {/* Run Output Drawer */}
                {runOutput && (
                  <div className="border-t border-term-border bg-term-bg p-3 max-h-48 overflow-y-auto shrink-0 font-mono text-xs sm:text-sm">
                    <div className="flex items-center justify-between pb-1 border-b border-term-border text-xs text-term-dim mb-1">
                      <span>Terminal Output: {runOutput.title}</span>
                      <div className="flex items-center gap-2">
                        <span className={runOutput.exitCode === 0 ? "text-term-green font-bold" : "text-term-red font-bold"}>
                          ● exit {runOutput.exitCode}
                        </span>
                        <button
                          onClick={() => setRunOutput(null)}
                          className="hover:text-term-fg text-xs"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                    <pre className="whitespace-pre-wrap break-words text-term-fg font-mono">{runOutput.output}</pre>
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center p-6 text-center text-term-dim select-none">
                <svg className="w-16 h-16 fill-term-dim/40 mb-4" viewBox="0 0 24 24">
                  <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
                </svg>
                <p className="text-base font-semibold text-term-fg">VS Code Monaco Workspace</p>
                <p className="text-sm mt-1 max-w-sm">
                  Select a file from the explorer or create new files using the action toolbar above.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* VS Code Bottom Status Bar */}
        <div className="flex items-center justify-between border-t border-term-border bg-term-panel px-3.5 py-1.5 shrink-0 select-none text-xs text-term-dim">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-term-green font-semibold">
              <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                <path d="M19.5 8a3.5 3.5 0 0 0-3.32 2.41 4.5 4.5 0 0 0-4.68 3.59A3.5 3.5 0 0 0 8 13.5V6.82a3.5 3.5 0 1 0-2 0v10.36a3.5 3.5 0 1 0 2.05.58 4.48 4.48 0 0 0 4.14-3.26 4.51 4.51 0 0 0 3.81-2.9 3.5 3.5 0 1 0 3.5-3.1zM6 4a1.5 1.5 0 1 1-1.5 1.5A1.5 1.5 0 0 1 6 4zm1 16a1.5 1.5 0 1 1 1.5-1.5A1.5 1.5 0 0 1 7 20zm12.5-9a1.5 1.5 0 1 1 1.5-1.5 1.5 1.5 0 0 1-1.5 1.5z"/>
              </svg>
              <span>{gitStatus.branch}</span>
            </span>
            <span>0 ⊗ 0 ⚠</span>
          </div>

          <div className="flex items-center gap-4">
            <span>Spaces: 2</span>
            <span>UTF-8</span>
            <span className="uppercase text-term-fg font-semibold">
              {selectedFile ? getLanguageFromPath(selectedFile) : "Plain Text"}
            </span>
            <span className="text-term-green">Prettier ✓</span>
          </div>
        </div>
      </div>
  );

  if (inline) {
    return content;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-2 sm:p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      {content}
    </div>
  );
}

function RenderTreeItems({
  items,
  selectedFile,
  onSelect,
  onDelete,
  collapsedFolders,
  onToggleFolder,
  depth = 0,
}: {
  items: FileItem[];
  selectedFile: string | null;
  onSelect: (path: string) => void;
  onDelete: (path: string) => void;
  collapsedFolders: Record<string, boolean>;
  onToggleFolder: (path: string) => void;
  depth?: number;
}) {
  return (
    <div className="space-y-0.5">
      {items.map((item) => {
        const isSelected = item.path === selectedFile;
        const isDir = item.type === "directory";
        const isCollapsed = collapsedFolders[item.path] ?? false;

        return (
          <div key={item.path} style={{ paddingLeft: `${depth * 10}px` }}>
            <div
              onClick={() => (isDir ? onToggleFolder(item.path) : onSelect(item.path))}
              className={`group flex items-center justify-between rounded px-2.5 py-1.5 cursor-pointer transition-colors text-xs sm:text-sm ${
                isSelected
                  ? "bg-term-green/20 text-term-green font-bold"
                  : "text-term-dim hover:text-term-fg hover:bg-term-panel"
              }`}
            >
              <div className="flex items-center gap-2 truncate">
                {isDir ? (
                  <>
                    <svg
                      className={`w-3 h-3 text-term-dim transition-transform ${isCollapsed ? "-rotate-90" : "rotate-0"}`}
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                    </svg>
                    <svg className="w-4 h-4 text-term-amber shrink-0" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                    </svg>
                  </>
                ) : (
                  <FileIcon path={item.path} className="w-4 h-4 shrink-0" />
                )}
                <span className="truncate">{item.name}</span>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(item.path);
                }}
                className="opacity-0 group-hover:opacity-100 text-xs text-term-dim hover:text-term-red px-1 transition-opacity"
                title="Delete"
              >
                ✕
              </button>
            </div>
            {isDir && item.children && !isCollapsed && (
              <RenderTreeItems
                items={item.children}
                selectedFile={selectedFile}
                onSelect={onSelect}
                onDelete={onDelete}
                collapsedFolders={collapsedFolders}
                onToggleFolder={onToggleFolder}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
