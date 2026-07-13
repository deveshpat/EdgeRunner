"use client";

import { isValidElement, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { CodeRunner, isRunnable } from "./CodeRunner";

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
                {children}
              </code>
            ) : (
              <code className="er-inline-code" {...props}>
                {children}
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

function CodeBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const lang = languageOf(children);

  function copy() {
    const text = ref.current?.innerText ?? "";
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  const getCode = () => ref.current?.innerText ?? "";

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
