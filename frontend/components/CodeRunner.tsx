"use client";

import { useEffect, useRef, useState } from "react";

// Languages we can execute in the browser.
const JS_LANGS = new Set(["js", "javascript", "jsx", "mjs"]);
const HTML_LANGS = new Set(["html", "htm"]);

export function isRunnable(lang: string | null): boolean {
  if (!lang) return false;
  const l = lang.toLowerCase();
  return JS_LANGS.has(l) || HTML_LANGS.has(l);
}

interface LogLine {
  level: string;
  text: string;
}

// A sandboxed <iframe sandbox="allow-scripts"> has a null origin: the code
// can't touch the parent app, localStorage, cookies, or same-origin network.
// JS runs via postMessage handshake; HTML is rendered directly.
export function CodeRunner({
  getCode,
  lang,
}: {
  getCode: () => string;
  lang: string;
}) {
  const isHtml = HTML_LANGS.has(lang.toLowerCase());
  const [code, setCode] = useState("");
  const [runId, setRunId] = useState(0);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  function run() {
    setCode(getCode()); // capture the block's current text at run time
    setLogs([]);
    setRunning(true);
    setRunId((n) => n + 1);
  }

  // JS execution: handshake with the sandboxed iframe, collect output.
  useEffect(() => {
    if (runId === 0 || isHtml) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    let settled = false;
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== iframe.contentWindow) return;
      const d = ev.data as { __er_run?: number; type?: string; payload?: LogLine };
      if (!d || !d.__er_run) return;
      if (d.type === "ready") {
        iframe.contentWindow?.postMessage({ __er_code: code }, "*");
      } else if (d.type === "log" && d.payload) {
        setLogs((prev) => [...prev, d.payload as LogLine]);
      } else if (d.type === "done") {
        settled = true;
        setRunning(false);
        window.removeEventListener("message", onMessage);
      }
    };
    window.addEventListener("message", onMessage);
    const timer = setTimeout(() => {
      if (!settled) {
        setLogs((prev) => [...prev, { level: "error", text: "timed out (5s)" }]);
        setRunning(false);
        window.removeEventListener("message", onMessage);
      }
    }, 5000);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
  }, [runId, code, isHtml]);

  return (
    <div className="er-runner">
      <button className="er-run-btn" onClick={run} disabled={running}>
        {running ? "running…" : "▶ run"}
      </button>

      {runId > 0 && isHtml && (
        <iframe
          key={runId}
          title="output"
          sandbox="allow-scripts"
          className="er-run-frame"
          srcDoc={code}
        />
      )}

      {runId > 0 && !isHtml && (
        <>
          {/* hidden executor */}
          <iframe
            key={runId}
            ref={iframeRef}
            title="runner"
            sandbox="allow-scripts"
            style={{ display: "none" }}
            srcDoc={JS_HARNESS}
          />
          {logs.length > 0 && (
            <div className="er-run-out">
              {logs.map((l, i) => (
                <div key={i} className={`er-log er-log-${l.level}`}>
                  {l.text}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Runs inside the sandboxed iframe. Receives code via postMessage, evaluates it
// (top-level await + return supported), and streams console output + result +
// errors back to the parent. Code is passed by message, never string-injected
// into this HTML, so it can't break out of the script.
const JS_HARNESS = `<!doctype html><html><body><script>
var send=function(t,p){parent.postMessage({__er_run:1,type:t,payload:p},'*')};
var fmt=function(x){try{return typeof x==='object'?JSON.stringify(x,null,2):String(x)}catch(e){return String(x)}};
['log','info','warn','error','debug'].forEach(function(m){
  var orig=console[m]?console[m].bind(console):function(){};
  console[m]=function(){var a=[].slice.call(arguments);send('log',{level:m,text:a.map(fmt).join(' ')});orig.apply(console,arguments)};
});
window.onerror=function(msg){send('log',{level:'error',text:String(msg)});};
window.addEventListener('message',function(ev){
  var code=ev.data&&ev.data.__er_code;
  if(typeof code!=='string')return;
  (async function(){
    try{
      var r=await eval('(async function(){'+code+'\\n})()');
      if(r!==undefined)send('log',{level:'result',text:fmt(r)});
    }catch(e){send('log',{level:'error',text:(e&&e.stack)||String(e)})}
    send('done',{});
  })();
});
send('ready',{});
<\/script></body></html>`;
