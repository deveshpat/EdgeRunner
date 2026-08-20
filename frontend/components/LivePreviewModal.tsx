"use client";

import { useEffect, useRef, useState } from "react";
import { vfs } from "@/lib/wasmShell";

interface LivePreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialUrl?: string;
}

export function LivePreviewModal({ isOpen, onClose, initialUrl }: LivePreviewModalProps) {
  const [htmlFiles, setHtmlFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>("index.html");
  const [customUrl, setCustomUrl] = useState<string>(initialUrl || "");
  const [mode, setMode] = useState<"vfs" | "url">(initialUrl ? "url" : "vfs");
  const [device, setDevice] = useState<"responsive" | "desktop" | "tablet" | "mobile">("responsive");
  const [logs, setLogs] = useState<string[]>([]);
  const [showConsole, setShowConsole] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Scan VFS for HTML files on open
  useEffect(() => {
    if (!isOpen) return;
    const all = vfs.listFiles();
    const htmls = all.filter((f) => f.endsWith(".html") || f.endsWith(".htm"));
    setHtmlFiles(htmls.length > 0 ? htmls : ["index.html"]);
    if (htmls.length > 0 && !htmls.includes(selectedFile)) {
      setSelectedFile(htmls[0]);
    }
  }, [isOpen, selectedFile]);

  // Update URL when initialUrl changes
  useEffect(() => {
    if (initialUrl) {
      setCustomUrl(initialUrl);
      setMode("url");
    }
  }, [initialUrl]);

  // Render HTML content with auto-injected script & relative asset resolution
  function generateHtmlBundle(): string {
    const rawHtml = vfs.readFile(selectedFile) || `<!DOCTYPE html>
<html>
<head>
  <title>EdgeRunner Live Preview</title>
  <style>
    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
    h1 { color: #39FF14; font-family: monospace; }
    p { color: #94a3b8; font-size: 14px; }
  </style>
</head>
<body>
  <h1>⚡ EDGERUNNER LIVE PREVIEW</h1>
  <p>Create an <code>index.html</code> or web app in the workspace to preview it live.</p>
</body>
</html>`;

    let bundled = rawHtml;

    // Inline linked local CSS and JS files from VFS
    bundled = bundled.replace(/<link\s+[^>]*href=["']([^"']+\.css)["'][^>]*>/gi, (match, href) => {
      const cleanHref = href.replace(/^\.?\//, "");
      const cssContent = vfs.readFile(cleanHref);
      return cssContent ? `<style>/* ${cleanHref} */\n${cssContent}\n</style>` : match;
    });

    bundled = bundled.replace(/<script\s+[^>]*src=["']([^"']+\.js)["'][^>]*>\s*<\/script>/gi, (match, src) => {
      const cleanSrc = src.replace(/^\.?\//, "");
      const jsContent = vfs.readFile(cleanSrc);
      return jsContent ? `<script>/* ${cleanSrc} */\n${jsContent}\n</script>` : match;
    });

    const consoleInterceptor = `
<script>
  (function() {
    var _log = console.log, _warn = console.warn, _error = console.error;
    function send(type, args) {
      try {
        var msg = Array.prototype.slice.call(args).map(function(a) {
          return typeof a === 'object' ? JSON.stringify(a) : String(a);
        }).join(' ');
        window.parent.postMessage({ type: 'er-console', level: type, message: msg }, '*');
      } catch(e) {}
    }
    console.log = function() { send('log', arguments); _log.apply(console, arguments); };
    console.warn = function() { send('warn', arguments); _warn.apply(console, arguments); };
    console.error = function() { send('error', arguments); _error.apply(console, arguments); };
  })();
</script>
`;

    return consoleInterceptor + bundled;
  }

  function reloadIframe() {
    if (!iframeRef.current) return;
    if (mode === "url" && customUrl) {
      iframeRef.current.src = customUrl;
    } else {
      const doc = iframeRef.current.contentDocument;
      if (doc) {
        doc.open();
        doc.write(generateHtmlBundle());
        doc.close();
      }
    }
  }

  useEffect(() => {
    if (isOpen) {
      reloadIframe();
    }
  }, [isOpen, selectedFile, mode, customUrl]);

  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data && e.data.type === "er-console") {
        setLogs((prev) => [...prev.slice(-100), `[${e.data.level}] ${e.data.message}`]);
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  function handlePopout() {
    if (mode === "url" && customUrl) {
      window.open(customUrl, "_blank");
    } else {
      const bundle = generateHtmlBundle();
      const blob = new Blob([bundle], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
    }
  }

  if (!isOpen) return null;

  const deviceWidths = {
    responsive: "w-full max-w-full",
    desktop: "w-full max-w-5xl",
    tablet: "w-[768px]",
    mobile: "w-[375px]",
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-2 sm:p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-[90vh] max-h-[820px] w-full max-w-5xl flex-col rounded-lg border border-term-border bg-term-bg shadow-2xl font-mono text-xs overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header & Address Bar */}
        <div className="flex flex-wrap items-center justify-between border-b border-term-border bg-term-panel px-3 py-2 gap-2 select-none shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-term-green font-bold text-xs flex items-center gap-1.5">
              <span>🌐</span>
              <span className="hidden xs:inline">LIVE PREVIEW</span>
            </span>

            {/* Mode Switcher */}
            <div className="flex rounded border border-term-border bg-term-bg p-0.5 text-[10px]">
              <button
                onClick={() => setMode("vfs")}
                className={`px-1.5 py-0.5 rounded ${mode === "vfs" ? "bg-term-green/20 text-term-green font-semibold" : "text-term-dim"}`}
              >
                Workspace
              </button>
              <button
                onClick={() => setMode("url")}
                className={`px-1.5 py-0.5 rounded ${mode === "url" ? "bg-term-green/20 text-term-green font-semibold" : "text-term-dim"}`}
              >
                URL / Port
              </button>
            </div>
          </div>

          {/* Center Address & File Selector */}
          <div className="flex flex-1 items-center min-w-[180px] max-w-md gap-1.5">
            {mode === "vfs" ? (
              <select
                value={selectedFile}
                onChange={(e) => setSelectedFile(e.target.value)}
                className="flex-1 rounded border border-term-border bg-term-bg px-2 py-0.5 text-xs text-term-fg focus:outline-none focus:border-term-green"
              >
                {htmlFiles.map((f) => (
                  <option key={f} value={f}>
                    📄 {f}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && reloadIframe()}
                placeholder="http://localhost:3000, https://…"
                className="flex-1 rounded border border-term-border bg-term-bg px-2 py-0.5 text-xs text-term-fg focus:outline-none focus:border-term-green"
              />
            )}
            <button
              onClick={reloadIframe}
              className="rounded border border-term-border px-1.5 py-0.5 text-term-dim hover:text-term-fg text-xs"
              title="Reload preview"
            >
              ↻
            </button>
            <button
              onClick={handlePopout}
              className="rounded border border-term-green/40 bg-term-green/10 text-term-green px-2 py-0.5 text-[11px] font-semibold hover:bg-term-green/20 transition-colors"
              title="Open in new browser tab"
            >
              ↗ Tab
            </button>
          </div>

          {/* Right: Device & Popout */}
          <div className="flex items-center gap-1.5">
            <div className="hidden md:flex items-center rounded border border-term-border bg-term-bg p-0.5 text-[10px]">
              {(["responsive", "desktop", "tablet", "mobile"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDevice(d)}
                  className={`px-1.5 py-0.5 rounded capitalize ${device === d ? "bg-term-green/20 text-term-green font-semibold" : "text-term-dim hover:text-term-fg"}`}
                >
                  {d === "responsive" ? "Auto" : d}
                </button>
              ))}
            </div>

            <button
              onClick={() => setShowConsole((c) => !c)}
              className={`hidden sm:inline-block rounded border px-1.5 py-0.5 text-[10px] transition-colors ${showConsole ? "border-term-green text-term-green bg-term-green/10" : "border-term-border text-term-dim"}`}
              title="Toggle Console Log Drawer"
            >
              Console ({logs.length})
            </button>

            <button
              onClick={onClose}
              className="flex h-5 w-5 items-center justify-center rounded border border-term-border text-term-dim hover:text-term-red text-xs transition-colors"
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Informative notice for external URL security restrictions */}
        {mode === "url" && customUrl && !customUrl.includes("localhost") && !customUrl.includes("127.0.0.1") && (
          <div className="bg-term-amber/10 border-b border-term-amber/30 px-3 py-1 text-[11px] text-term-amber flex items-center justify-between">
            <span className="truncate">
              Note: External websites (like github.com) may block iframe embedding via X-Frame-Options headers.
            </span>
            <button
              onClick={handlePopout}
              className="ml-2 underline font-bold shrink-0 hover:text-term-fg"
            >
              Open in Tab ↗
            </button>
          </div>
        )}

        {/* Viewport Canvas */}
        <div className="flex-1 bg-term-panel/40 flex items-center justify-center p-2 sm:p-4 overflow-auto">
          <div className={`h-full bg-white shadow-2xl rounded transition-all duration-200 overflow-hidden ${deviceWidths[device]}`}>
            <iframe
              ref={iframeRef}
              className="w-full h-full border-0 bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              title="EdgeRunner Sandboxed Preview"
            />
          </div>
        </div>

        {/* Console Logs Drawer */}
        {showConsole && (
          <div className="border-t border-term-border bg-term-panel p-2.5 max-h-36 overflow-y-auto shrink-0 font-mono text-[10px]">
            <div className="flex items-center justify-between pb-1 border-b border-term-border/40 text-term-dim mb-1">
              <span>SANDBOX CONSOLE LOGS</span>
              <button onClick={() => setLogs([])} className="hover:text-term-fg">
                clear
              </button>
            </div>
            {logs.length === 0 ? (
              <p className="text-term-dim italic">No logs emitted yet.</p>
            ) : (
              logs.map((l, i) => (
                <p key={i} className="text-term-fg font-mono leading-relaxed">
                  {l}
                </p>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
