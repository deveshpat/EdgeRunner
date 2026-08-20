"use client";

import {
  Fragment,
  cloneElement,
  isValidElement,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { CodeRunner, isRunnable } from "./CodeRunner";

const ANSI_COLOR_MAP: Record<string, string> = {
  "30": "#4b5563", // Dark Gray
  "31": "#ef4444", // Red
  "32": "#22c55e", // Green
  "33": "#f59e0b", // Yellow / Amber
  "34": "#60a5fa", // Blue
  "35": "#c084fc", // Magenta / Purple
  "36": "#22d3ee", // Cyan
  "37": "#f3f4f6", // White
  "90": "#6b7280", // Bright Black (Gray)
  "91": "#f87171", // Bright Red
  "92": "#4ade80", // Bright Green
  "93": "#fcd34d", // Bright Yellow
  "94": "#93c5fd", // Bright Blue
  "95": "#d8b4fe", // Bright Magenta
  "96": "#67e8f9", // Bright Cyan
  "97": "#ffffff", // Bright White
};

export function parseAnsiToReact(input: string): ReactNode {
  // Regex to match ANSI escape codes like \x1b[1;34m, \u001b[0m, or [1;34m, [0m
  const ansiRegex = /(?:\x1b|\u001b)?\[([0-9;]+)m/g;

  if (!ansiRegex.test(input)) {
    return input;
  }

  ansiRegex.lastIndex = 0;
  const elements: ReactNode[] = [];
  let lastIdx = 0;
  let currentColor: string | undefined = undefined;
  let isBold = false;
  let isDim = false;
  let match: RegExpExecArray | null;

  while ((match = ansiRegex.exec(input)) !== null) {
    const chunk = input.slice(lastIdx, match.index);
    if (chunk) {
      if (currentColor || isBold || isDim) {
        elements.push(
          <span
            key={elements.length}
            style={{
              color: currentColor,
              fontWeight: isBold ? "600" : "normal",
              opacity: isDim ? 0.75 : 1,
            }}
          >
            {chunk}
          </span>,
        );
      } else {
        elements.push(chunk);
      }
    }

    const codes = match[1].split(";");
    for (const code of codes) {
      if (code === "0" || code === "") {
        currentColor = undefined;
        isBold = false;
        isDim = false;
      } else if (code === "1") {
        isBold = true;
      } else if (code === "2") {
        isDim = true;
      } else if (ANSI_COLOR_MAP[code]) {
        currentColor = ANSI_COLOR_MAP[code];
      }
    }

    lastIdx = ansiRegex.lastIndex;
  }

  const remaining = input.slice(lastIdx);
  if (remaining) {
    if (currentColor || isBold || isDim) {
      elements.push(
        <span
          key={elements.length}
          style={{
            color: currentColor,
            fontWeight: isBold ? "600" : "normal",
            opacity: isDim ? 0.75 : 1,
          }}
        >
          {remaining}
        </span>,
      );
    } else {
      elements.push(remaining);
    }
  }

  return <>{elements}</>;
}

function renderAnsiChildren(children: ReactNode): ReactNode {
  if (typeof children === "string") {
    return parseAnsiToReact(children);
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => (
      <Fragment key={i}>{renderAnsiChildren(child)}</Fragment>
    ));
  }
  if (isValidElement(children) && (children.props as { children?: ReactNode })?.children) {
    return cloneElement(children as React.ReactElement<{ children?: ReactNode }>, {
      children: renderAnsiChildren((children.props as { children?: ReactNode }).children),
    });
  }
  return children;
}

// Renders assistant/system markdown with a terminal aesthetic: GFM tables and
// lists, styled links, and fenced code blocks with a language label + copy
// button. Syntax highlighting classes come from rehype-highlight (styled in
// globals.css).
export function Markdown({ content }: { content: string }) {
  return (
    <div className="er-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          code: ({ className, children, ...props }) =>
            className ? (
              <code className={className} {...props}>
                {renderAnsiChildren(children)}
              </code>
            ) : (
              <code className="er-inline-code" {...props}>
                {renderAnsiChildren(children)}
              </code>
            ),
          a: ({ children, ...props }) => (
            <a target="_blank" rel="noreferrer" {...props}>
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function extractRawText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractRawText).join("");
  if (isValidElement(node) && (node.props as { children?: ReactNode })?.children) {
    return extractRawText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

function CodeBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const lang = languageOf(children);

  const rawText = extractRawText(children).trim();
  if (!rawText) {
    return null;
  }

  function copy() {
    const text = ref.current?.innerText ?? rawText;
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  const getCode = () => ref.current?.innerText ?? rawText;

  return (
    <div className="er-codeblock">
      <div className="er-codeblock-bar">
        <span className="er-codeblock-lang">{lang ?? "code"}</span>
        <button className="er-codeblock-copy" onClick={copy}>
          {copied ? "✓ copied" : "copy"}
        </button>
      </div>
      <pre ref={ref}>{children}</pre>
      {isRunnable(lang) && <CodeRunner getCode={getCode} lang={lang!} />}
    </div>
  );
}

// Pull the language name out of the child <code>'s "language-xxx" class.
function languageOf(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const className: string = (children.props as { className?: string })?.className ?? "";
  const match = className.match(/language-(\w+)/);
  return match ? match[1] : null;
}
