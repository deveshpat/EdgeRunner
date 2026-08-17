import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // terminal palette (reads directly from CSS variables in globals.css)
        term: {
          bg: "var(--term-bg, #0a0e0a)",
          panel: "var(--term-panel, #0f140f)",
          border: "var(--term-border, #1e2a1e)",
          dim: "var(--term-dim, #4a5a4a)",
          fg: "var(--term-fg, #c8e6c8)",
          green: "var(--term-green, #39FF14)",
          amber: "var(--term-amber, #e6b23e)",
          red: "var(--term-red, #e6483e)",
        },
      },
      fontFamily: {
        mono: [
          "var(--font-mono)",
          "JetBrains Mono",
          "Fira Code",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
