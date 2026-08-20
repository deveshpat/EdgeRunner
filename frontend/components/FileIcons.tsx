"use client";

import React from "react";
import {
  FileText,
  Folder,
  FolderOpen,
  Image,
  Database,
  Archive,
  GitBranch,
  Settings,
} from "lucide-react";

export function FolderIcon({ isOpen, className = "w-4 h-4 shrink-0" }: { isOpen?: boolean; className?: string }) {
  if (isOpen) {
    return <FolderOpen className={`${className} text-term-amber`} />;
  }
  return <Folder className={`${className} text-term-amber`} />;
}

export function FileIcon({ path, className = "w-4 h-4 shrink-0" }: { path: string; className?: string }) {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const name = path.split("/").pop()?.toLowerCase() || "";

  // Dockerfile
  if (name === "dockerfile" || name.startsWith("dockerfile.")) {
    return (
      <svg className={className} viewBox="0 0 24 24">
        <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#0db7ed"/>
        <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#ffffff" fontSize="8" fontWeight="900" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">
          DOCK
        </text>
      </svg>
    );
  }

  // Git files
  if (name === ".gitignore" || name.endsWith(".git") || name === ".gitmodules") {
    return <GitBranch className={`${className} text-[#f05032]`} />;
  }

  switch (ext) {
    // TypeScript (.ts)
    case "ts":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#3178c6"/>
          <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#ffffff" fontSize="10" fontWeight="900" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">
            TS
          </text>
        </svg>
      );

    // TypeScript React (.tsx)
    case "tsx":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#235a97"/>
          <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#ffffff" fontSize="8" fontWeight="900" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">
            TSX
          </text>
        </svg>
      );

    // JavaScript (.js, .mjs, .cjs)
    case "js":
    case "mjs":
    case "cjs":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#f7df1e"/>
          <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#000000" fontSize="10" fontWeight="900" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">
            JS
          </text>
        </svg>
      );

    // JavaScript React (.jsx)
    case "jsx":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#20232a"/>
          <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#61dafb" fontSize="8" fontWeight="900" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">
            JSX
          </text>
        </svg>
      );

    // Python (.py)
    case "py":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#3776ab"/>
          <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#ffd43b" fontSize="10" fontWeight="900" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">
            PY
          </text>
        </svg>
      );

    // Rust (.rs)
    case "rs":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#f74c00"/>
          <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#ffffff" fontSize="10" fontWeight="900" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">
            RS
          </text>
        </svg>
      );

    // Go (.go)
    case "go":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#00add8"/>
          <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#ffffff" fontSize="10" fontWeight="900" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">
            GO
          </text>
        </svg>
      );

    // C (.c, .h)
    case "c":
    case "h":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#00599c"/>
          <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#ffffff" fontSize="11" fontWeight="900" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">
            C
          </text>
        </svg>
      );

    // C++ (.cpp, .cc, .hpp, .cxx)
    case "cpp":
    case "cc":
    case "hpp":
    case "cxx":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#004482"/>
          <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#ffffff" fontSize="8" fontWeight="900" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">
            C++
          </text>
        </svg>
      );

    // HTML (.html, .htm)
    case "html":
    case "htm":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#e34f26"/>
          <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#ffffff" fontSize="7" fontWeight="900" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">
            HTML
          </text>
        </svg>
      );

    // CSS / SCSS (.css, .scss, .sass, .less)
    case "css":
    case "scss":
    case "sass":
    case "less":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#1572b6"/>
          <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#ffffff" fontSize="8" fontWeight="900" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">
            CSS
          </text>
        </svg>
      );

    // JSON (.json)
    case "json":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#facc15"/>
          <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#000000" fontSize="8" fontWeight="900" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">
            {"{ }"}
          </text>
        </svg>
      );

    // Markdown (.md, .markdown)
    case "md":
    case "markdown":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#083fa1"/>
          <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#38bdf8" fontSize="9.5" fontWeight="900" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">
            MD
          </text>
        </svg>
      );

    // Shell Scripts (.sh, .bash, .zsh)
    case "sh":
    case "bash":
    case "zsh":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#0f172a" stroke="#4ade80" strokeWidth="1.5"/>
          <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#4ade80" fontSize="9" fontWeight="900" fontFamily="ui-monospace, monospace">
            {">_"}
          </text>
        </svg>
      );

    // Image / Vector files (.svg, .png, .jpg, .jpeg, .webp, .gif)
    case "svg":
      return (
        <svg className={className} viewBox="0 0 24 24">
          <rect width="20" height="20" x="2" y="2" rx="3.5" fill="#ff9900"/>
          <text x="12" y="13" textAnchor="middle" dominantBaseline="central" fill="#ffffff" fontSize="8" fontWeight="900" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">
            SVG
          </text>
        </svg>
      );

    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
    case "gif":
    case "ico":
      return <Image className={`${className} text-[#c084fc]`} />;

    // Database & SQL (.sql, .db, .sqlite)
    case "sql":
    case "db":
    case "sqlite":
      return <Database className={`${className} text-[#38bdf8]`} />;

    // YAML / Config (.yaml, .yml, .toml, .ini, .env)
    case "yaml":
    case "yml":
    case "toml":
    case "ini":
    case "env":
      return <Settings className={`${className} text-[#fb7185]`} />;

    // Archive (.zip, .tar, .gz, .rar, .7z)
    case "zip":
    case "tar":
    case "gz":
    case "rar":
    case "7z":
      return <Archive className={`${className} text-[#a855f7]`} />;

    default:
      return <FileText className={`${className} text-term-dim`} />;
  }
}
