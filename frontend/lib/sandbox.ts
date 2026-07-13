// Programmatic sandboxed JS execution — a hidden <iframe sandbox="allow-scripts">
// (null origin: no access to the app, localStorage, cookies). Used by the code
// runner and by the browser agent's run_javascript tool.

export interface RunResult {
  logs: { level: string; text: string }[];
  ok: boolean;
}

const HARNESS = `<!doctype html><html><body><script>
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

export function runJs(code: string, timeoutMs = 5000): Promise<RunResult> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      return resolve({ logs: [{ level: "error", text: "no DOM" }], ok: false });
    }
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.style.display = "none";
    iframe.srcdoc = HARNESS;
    const logs: RunResult["logs"] = [];
    let done = false;

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      iframe.remove();
      resolve({ logs, ok });
    };
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== iframe.contentWindow) return;
      const d = ev.data as { __er_run?: number; type?: string; payload?: { level: string; text: string } };
      if (!d?.__er_run) return;
      if (d.type === "ready") {
        iframe.contentWindow?.postMessage({ __er_code: code }, "*");
      } else if (d.type === "log" && d.payload) {
        logs.push(d.payload);
      } else if (d.type === "done") {
        finish(!logs.some((l) => l.level === "error"));
      }
    };
    const timer = setTimeout(() => {
      logs.push({ level: "error", text: `timed out (${timeoutMs}ms)` });
      finish(false);
    }, timeoutMs);
    window.addEventListener("message", onMessage);
    document.body.appendChild(iframe);
  });
}

export function formatRun(r: RunResult): string {
  if (!r.logs.length) return "(no output)";
  return r.logs.map((l) => (l.level === "result" ? "=> " : "") + l.text).join("\n");
}
