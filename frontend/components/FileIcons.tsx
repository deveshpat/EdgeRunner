"use client";

import React from "react";

export function FileIcon({ path, className = "w-4 h-4 shrink-0" }: { path: string; className?: string }) {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const name = path.split("/").pop()?.toLowerCase() || "";

  if (name === "dockerfile" || name.startsWith("dockerfile.")) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="#0db7ed">
        <path d="M13 3h-2v2h2V3zm-3 0H8v2h2V3zm-3 0H5v2h2V3zm9 3h-2v2h2V6zm-3 0h-2v2h2V6zm-3 0H8v2h2V6zm-3 0H5v2h2V6zm12 3h-2v2h2V9zm-3 0h-2v2h2V9zm-3 0h-2v2h2V9zm-3 0H8v2h2V9zm-3 0H5v2h2V9zm15.42 2.76C21.7 13.9 19.9 15 17.5 15c-.4 0-.8-.03-1.18-.1-1.04 1.9-3.04 3.1-5.32 3.1-2.58 0-4.81-1.53-5.74-3.79-.42.06-.86.1-1.31.1-1.05 0-2.02-.3-2.85-.81L0 14.5c.67 3.65 3.84 6.5 7.69 6.5 2.87 0 5.4-1.54 6.77-3.84 2.5.34 4.88-.67 6.38-2.6.43.34.95.54 1.51.54 1.38 0 2.5-1.12 2.5-2.5 0-1.06-.66-1.97-1.6-2.34-.11.17-.22.34-.33.5z"/>
      </svg>
    );
  }

  if (name === ".gitignore" || name.endsWith(".git")) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="#f05032">
        <path d="M21.62 10.38L13.62 2.38a2.29 2.29 0 0 0-3.24 0L8.43 4.33l4.06 4.06a2.71 2.71 0 0 1 3.44 3.44l3.91 3.91a2.7 2.7 0 1 1-1.62 1.62l-3.66-3.66v5.2a2.7 2.7 0 1 1-2.29 0V13.6l-3.32-3.32-4.57 4.57a2.29 2.29 0 0 0 0 3.24l8 8a2.29 2.29 0 0 0 3.24 0l7.38-7.38a2.29 2.29 0 0 0 0-3.24z"/>
      </svg>
    );
  }

  switch (ext) {
    case "py":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <path fill="#3776ab" d="M11.92 2C6.98 2 7.29 4.14 7.29 4.14l.01 2.22h4.72v.67H5.34S2 6.64 2 11.59s2.91 4.79 2.91 4.79h1.74v-2.45s-.1-2.91 2.87-2.91h4.94s2.76.05 2.76-2.68V4.87S17.47 2 11.92 2zM9.54 3.53a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7z"/>
          <path fill="#ffd43b" d="M12.08 22c4.94 0 4.63-2.14 4.63-2.14l-.01-2.22H11.98v-.67h6.68S22 17.36 22 12.41s-2.91-4.79-2.91-4.79h-1.74v2.45s.1 2.91-2.87 2.91h-4.94s-2.76-.05-2.76 2.68v3.46S6.53 22 12.08 22zm2.38-1.53a.85.85 0 1 1 0-1.7.85.85 0 0 1 0-1.7z"/>
        </svg>
      );

    case "ts":
    case "tsx":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="22" height="22" x="1" y="1" rx="4" fill="#3178c6"/>
          <path fill="#fff" d="M11.25 11.5h-2.5V19h-2v-7.5h-2.5V9.75h7V11.5zm8 2.25c0-.85-.35-1.5-1.05-1.95s-1.7-.8-3-.1.05v-1.7c1.3-.25 2.5-.35 3.6-.35 1.5 0 2.65.35 3.45 1.05.8.7 1.2 1.65 1.2 2.85 0 .8-.25 1.5-.75 2.1-.5.6-1.3 1.05-2.4 1.35 1.25.3 2.15.75 2.7 1.35.55.6.85 1.35.85 2.25 0 1.3-.45 2.35-1.35 3.1-.9.75-2.2 1.15-3.9 1.15-1.4 0-2.8-.2-4.2-.6v-1.85c1.4.45 2.75.7 4.05.7 1.15 0 2.05-.25 2.7-.75.65-.5.95-1.2.95-2.1 0-.9-.35-1.6-1.05-2.1-.7-.5-1.75-.85-3.15-1.05v-1.5c1.1-.2 1.95-.55 2.55-1.05.6-.5.9-1.15.9-1.95z"/>
        </svg>
      );

    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="22" height="22" x="1" y="1" rx="4" fill="#f7df1e"/>
          <path fill="#000" d="M7.5 17.5c0 .8.3 1.3.8 1.7.5.4 1.2.6 2 .6 1 0 1.8-.3 2.4-.8.6-.5.9-1.2.9-2v-6.5h-2v6.3c0 .4-.1.7-.3.9-.2.2-.6.3-1 .3-.5 0-.8-.1-1-.3-.2-.2-.3-.5-.3-.9v-2.8H7.5v3.5zm7.3-6.9h2.2c.4 0 .8.1 1.1.3.3.2.5.5.6.9.1.4.1.8.1 1.3 0 .7-.1 1.3-.4 1.7-.3.4-.7.7-1.3.9.7.2 1.2.5 1.5 1 .3.5.5 1.1.5 1.8 0 .8-.2 1.5-.6 2.1-.4.6-1 1-1.7 1.3-.7.3-1.6.4-2.6.4-1.1 0-2.1-.2-3.1-.6v-1.8c.9.4 1.9.6 2.9.6.8 0 1.4-.2 1.8-.5.4-.3.6-.8.6-1.4 0-.6-.2-1-.6-1.3-.4-.3-1-.4-1.8-.4h-1.1v-1.6h1.2c.7 0 1.2-.1 1.5-.4.3-.3.5-.7.5-1.1 0-.4-.1-.8-.4-1-.3-.2-.7-.4-1.3-.4-.8 0-1.6.2-2.3.6v-1.7c.9-.4 1.8-.6 2.7-.6z"/>
        </svg>
      );

    case "rs":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="#dea584">
          <path fill="#dea584" d="M21.5 12a9.5 9.5 0 0 1-9.5 9.5A9.5 9.5 0 0 1 2.5 12 9.5 9.5 0 0 1 12 2.5a9.5 9.5 0 0 1 9.5 9.5zM12 4.5A7.5 7.5 0 0 0 4.5 12a7.5 7.5 0 0 0 7.5 7.5 7.5 7.5 0 0 0 7.5-7.5A7.5 7.5 0 0 0 12 4.5z"/>
          <path fill="#dea584" d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm-1.5 7.5v-5h2.5a1.5 1.5 0 0 1 1.5 1.5c0 .6-.3 1.1-.8 1.3l1 2.2h-1.2l-.9-2h-.6v2h-1.5zm1.5-3.5h1a.5.5 0 0 0 .5-.5.5.5 0 0 0-.5-.5h-1v1z"/>
        </svg>
      );

    case "go":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="#00add8">
          <path d="M1.5 10.8c.2-.5.5-1 1-1.3.5-.3 1.1-.4 1.8-.4.9 0 1.6.3 2.2.8.6.5.9 1.2.9 2.1 0 .9-.3 1.6-.9 2.2-.6.6-1.4.9-2.3.9-.9 0-1.6-.3-2.1-.8-.5-.5-.8-1.2-.8-2.1 0-.5.1-.9.2-1.4zm10.7-3.9h2.3v9.5h-2.1v-1.1c-.4.4-.8.7-1.3.9-.5.2-1.1.3-1.7.3-1.1 0-2-.4-2.7-1.1-.7-.7-1-1.7-1-2.9 0-1.2.3-2.2 1-2.9.7-.7 1.6-1.1 2.7-1.1.6 0 1.2.1 1.7.4.5.3.9.6 1.1 1V6.9zm8.5 4.8c0 1.4-.4 2.5-1.1 3.3-.7.8-1.7 1.2-2.9 1.2s-2.2-.4-2.9-1.2c-.7-.8-1.1-1.9-1.1-3.3s.4-2.5 1.1-3.3c.7-.8 1.7-1.2 2.9-1.2s2.2.4 2.9 1.2c.8.8 1.1 1.9 1.1 3.3z"/>
        </svg>
      );

    case "c":
    case "h":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" fill="#00599c" />
          <path d="M14.5 8.5a4 4 0 0 0-5 0 4 4 0 0 0 0 7 4 4 0 0 0 5 0" fill="none" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round"/>
        </svg>
      );

    case "cpp":
    case "cc":
    case "hpp":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" fill="#00599c" />
          <path d="M11 9a3 3 0 0 0-3 0 3 3 0 0 0 0 6 3 3 0 0 0 3 0M14 12h3M15.5 10.5v3M18.5 12h3M20 10.5v3" fill="none" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round"/>
        </svg>
      );

    case "html":
    case "htm":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="#e34f26">
          <path d="M3 2l1.6 18.2L12 22l7.4-1.8L21 2H3zm14.8 6.5h-8l.2 2.2h7.6l-.6 6.3-4.9 1.4-5-1.4-.3-3.6h2.2l.2 1.8 2.9.8 2.9-.8.3-3.3H7.5L6.9 6.2h11.2l-.3 2.3z"/>
        </svg>
      );

    case "css":
    case "scss":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="#1572b6">
          <path d="M3 2l1.6 18.2L12 22l7.4-1.8L21 2H3zm14.7 6.5H9.2l-.2-2.3h9l.3-2.2H6.5l.7 6.8h8.8l-.4 4.5-3.6 1-3.6-1-.2-2.4H6l.4 4.2 5.6 1.6 5.6-1.6.8-8.6z"/>
        </svg>
      );

    case "json":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="#facc15">
          <path d="M7 3C5.3 3 4 4.3 4 6v4c0 1.1-.9 2-2 2 1.1 0 2 .9 2 2v4c0 1.7 1.3 3 3 3h1v-2H7c-.6 0-1-.4-1-1v-4c0-1.1-.9-2-2-2 1.1 0 2-.9 2-2V6c0-.6.4-1 1-1h1V3H7zm10 0h-1v2h1c.6 0 1 .4 1 1v4c0 1.1.9 2 2 2-1.1 0-2 .9-2 2v4c0 .6-.4 1-1 1h-1v2h1c1.7 0 3-1.3 3-3v-4c0-1.1.9-2 2-2-1.1 0-2-.9-2-2V6c0-1.7-1.3-3-3-3z"/>
        </svg>
      );

    case "md":
    case "markdown":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="22" height="16" x="1" y="4" rx="2" fill="#083fa1"/>
          <path fill="#38bdf8" d="M3 6h18v12H3V6zm2 2v8h2.5l2-2.5 2 2.5H14V8h-2v4.5l-2-2.5-2 2.5V8H5zm11 0h2v4.5h2L17.5 16 15 12.5h2V8z"/>
        </svg>
      );

    case "sh":
    case "bash":
    case "zsh":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="22" height="18" x="1" y="3" rx="3" fill="#1e293b" stroke="#4ade80" strokeWidth="1.5"/>
          <path fill="#4ade80" d="M5 8l4 3-4 3v-2l2-1-2-1V8zm6 5h5v2h-5v-2z"/>
        </svg>
      );

    case "svg":
    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
    case "gif":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3" fill="none" stroke="#c084fc" strokeWidth="2"/>
          <circle cx="8" cy="8" r="2" fill="#c084fc"/>
          <path fill="#c084fc" d="M20 15l-5-5L3 21h17a2 2 0 0 0 2-2v-4z"/>
        </svg>
      );

    case "sql":
    case "db":
    case "sqlite":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <ellipse cx="12" cy="6" rx="8" ry="3" fill="none" stroke="#38bdf8" strokeWidth="2"/>
          <path fill="none" stroke="#38bdf8" strokeWidth="2" d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/>
        </svg>
      );

    case "yaml":
    case "yml":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="#fb7185">
          <path d="M4 4l5 7v9h2v-9l5-7h-2.5L10 8.5 6.5 4H4zm11 11h5v2h-5v-2zm-3 4h8v2h-8v-2z"/>
        </svg>
      );

    default:
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm1 7V3.5L18.5 9H15z" opacity="0.8"/>
        </svg>
      );
  }
}
