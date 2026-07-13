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
        // terminal palette
        term: {
          bg: "#0a0e0a",
          panel: "#0f140f",
          border: "#1e2a1e",
          dim: "#4a5a4a",
          fg: "#c8e6c8",
          green: "#3ecf5c",
          amber: "#e6b23e",
          red: "#e6483e",
        },
      },
      fontFamily: {
        mono: [
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
