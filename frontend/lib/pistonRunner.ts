"use client";

/**
 * Free Multi-Language Cloud Execution Engine (Wandbox API).
 *
 * 100% Free, Zero Setup, Zero Accounts, Zero Whitelist restrictions.
 * Supports: C, C++, Rust, Go, Java, Python, Ruby, PHP, Zig, Swift, etc.
 */

const COMPILER_MAP: Record<string, string> = {
  c: "gcc-head-c",
  cpp: "gcc-head",
  "c++": "gcc-head",
  rust: "rust-1.82.0",
  rs: "rust-1.82.0",
  go: "go-1.23.2",
  golang: "go-1.23.2",
  java: "openjdk-jdk-22+36",
  python: "cpython-3.12.7",
  py: "cpython-3.12.7",
  python3: "cpython-3.12.7",
  php: "php-8.3.12",
  ruby: "ruby-4.0.2",
  rb: "ruby-4.0.2",
};

export async function executeViaPiston(
  language: string,
  sourceCode: string,
  filename: string = "main",
  args: string[] = [],
  stdin: string = "",
): Promise<{ output: string; exitCode: number }> {
  const l = language.toLowerCase();
  const compiler = COMPILER_MAP[l] || "gcc-head";

  // For single-file Java on online runners, strip 'public' from class declaration
  let code = sourceCode;
  if (l === "java") {
    code = code.replace(/public\s+class\s+([A-Za-z0-9_]+)/g, "class $1");
  }

  // For C/C++, ensure preprocessor #include directives are on their own lines
  if (l === "c" || l === "cpp" || l === "c++") {
    code = code.replace(/(#include\s*<[^>]+>)\s*([^\n\r])/g, "$1\n$2");
    code = code.replace(/(#include\s*"[^"]+")\s*([^\n\r])/g, "$1\n$2");
  }

  try {
    const res = await fetch("https://wandbox.org/api/compile.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        compiler,
        code,
        stdin,
        runtime_args: args.join(" "),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { output: `Cloud execution error (${res.status}): ${errText}`, exitCode: 1 };
    }

    const data = await res.json();
    const compilerErr = data.compiler_error ? `[compiler error]\n${data.compiler_error}\n` : "";
    const programErr = data.program_error ? `[runtime error]\n${data.program_error}\n` : "";
    const programOut = data.program_output || "";
    const exitCode = parseInt(data.status || "0", 10);

    const fullOutput = (compilerErr + programErr + programOut).trimEnd();
    return {
      output: fullOutput || "(no output)",
      exitCode,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Cloud runner connection failed: ${msg}`, exitCode: 1 };
  }
}
