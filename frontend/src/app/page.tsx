"use client";

import { useState, useEffect, useRef } from "react";
import { Send, Terminal, Cpu, Settings2, CheckCircle2, XCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";

type Message = {
  role: "user" | "assistant";
  content: string;
  thoughts?: string[];
};

export default function EdgeRunnerUI() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [backendUrl, setBackendUrl] = useState("https://afraid-cobras-travel.loca.lt");
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Ping backend to check status
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch(`${backendUrl}/health`);
        setIsOnline(res.ok);
      } catch {
        setIsOnline(false);
      }
    };
    checkStatus();
    const interval = setInterval(checkStatus, 10000);
    return () => clearInterval(interval);
  }, [backendUrl]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMsg: Message = { role: "user", content: input };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch(`${backendUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, userMsg].map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!response.ok) throw new Error("Backend connection failed");

      const data = await response.json();
      
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.response, thoughts: data.thought_process },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "⚠️ Connection error. Make sure your EdgeRunner backend is running on your machine." },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-neutral-950 text-neutral-200 font-sans selection:bg-cyan-900 selection:text-cyan-50">
      
      {/* HEADER */}
      <header className="flex items-center justify-between p-4 bg-neutral-900 border-b border-neutral-800 shadow-md">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-cyan-950 rounded-lg text-cyan-400">
            <Cpu size={24} />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wider text-neutral-100">EDGERUNNER</h1>
            <p className="text-xs text-neutral-400">Local Agentic Harness</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-950 rounded-full border border-neutral-800">
            {isOnline ? (
              <><CheckCircle2 size={14} className="text-emerald-500" /> <span className="text-emerald-500/80">Engine Online</span></>
            ) : (
              <><XCircle size={14} className="text-red-500" /> <span className="text-red-500/80">Disconnected</span></>
            )}
          </div>
          <button className="p-2 hover:bg-neutral-800 rounded-full transition-colors">
            <Settings2 size={20} className="text-neutral-400" />
          </button>
        </div>
      </header>

      {/* CHAT AREA */}
      <main className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-neutral-500 space-y-4">
            <Terminal size={48} className="opacity-20" />
            <p>System ready. Waiting for input.</p>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div key={idx} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
            
            {/* AGENT THOUGHT PROCESS (Only shows if there are thoughts) */}
            {msg.role === "assistant" && msg.thoughts && msg.thoughts.length > 0 && (
              <div className="mb-2 max-w-[85%] md:max-w-[70%] w-full">
                <div className="text-xs text-cyan-600 mb-1 flex items-center gap-2 font-mono ml-2">
                  <Terminal size={12} /> Agent Reflection Logs
                </div>
                <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 space-y-3 font-mono text-xs text-neutral-400 overflow-x-auto">
                  {msg.thoughts.map((thought, i) => (
                    <div key={i} className="border-l-2 border-neutral-700 pl-3">
                      {thought}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* MAIN MESSAGE BUBBLE */}
            <div
              className={`max-w-[85%] md:max-w-[70%] p-4 rounded-2xl ${
                msg.role === "user"
                  ? "bg-cyan-900/40 border border-cyan-800/50 rounded-tr-none text-cyan-50"
                  : "bg-neutral-800/50 border border-neutral-700/50 rounded-tl-none"
              }`}
            >
              <div className="prose prose-invert prose-p:leading-relaxed prose-pre:bg-neutral-900 prose-pre:border prose-pre:border-neutral-700 max-w-none">
                <ReactMarkdown>{msg.content}</ReactMarkdown>
              </div>
            </div>
          </div>
        ))}
        
        {isLoading && (
          <div className="flex items-start max-w-[70%]">
            <div className="bg-neutral-800/50 border border-neutral-700/50 p-4 rounded-2xl rounded-tl-none animate-pulse text-cyan-500/70 text-sm font-mono flex items-center gap-2">
              <Terminal size={16} className="animate-bounce" /> Harness is thinking & executing code...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </main>

      {/* INPUT AREA */}
      <footer className="p-4 bg-neutral-900 border-t border-neutral-800">
        <div className="max-w-4xl mx-auto flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Give the agent a task (e.g. 'Write a python script to check my IP address')..."
            className="flex-1 bg-neutral-950 border border-neutral-800 rounded-xl p-4 text-neutral-200 focus:outline-none focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700 resize-none"
            rows={1}
            style={{ minHeight: "56px", maxHeight: "200px" }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            className="p-4 bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 disabled:hover:bg-cyan-700 text-white rounded-xl transition-colors flex items-center justify-center"
          >
            <Send size={20} />
          </button>
        </div>
      </footer>
    </div>
  );
}
