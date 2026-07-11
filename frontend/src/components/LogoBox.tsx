"use client";

const ASCII = `███████╗██████╗  ██████╗ ███████╗
██╔════╝██╔══██╗██╔════╝ ██╔════╝
█████╗  ██║  ██║██║  ███╗█████╗  
██╔══╝  ██║  ██║██║   ██║██╔══╝  
███████╗██████╔╝╚██████╔╝███████╗
╚══════╝╚═════╝  ╚═════╝ ╚══════╝
██████╗ ██╗   ██╗███╗   ██╗███╗   ██╗███████╗██████╗ 
██╔══██╗██║   ██║████╗  ██║████╗  ██║██╔════╝██╔══██╗
██████╔╝██║   ██║██╔██╗ ██║██╔██╗ ██║█████╗  ██████╔╝
██╔══██╗██║   ██║██║╚██╗██║██║╚██╗██║██╔══╝  ██╔══██╗
██║  ██║╚██████╔╝██║ ╚████║██║ ╚████║███████╗██║  ██║
╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝`;

/** Compact single-line mark for tight headers */
export function LogoMark({ className = "" }: { className?: string }) {
  return (
    <span className={`er-logo ${className}`} style={{ letterSpacing: "0.18em" }}>
      EDGERUNNER
    </span>
  );
}

/** Boxed init logo — OpenCode / Claude Code style home mark */
export function LogoBox({
  subtitle = "coding agent harness",
  pulse = false,
  tag,
}: {
  subtitle?: string;
  pulse?: boolean;
  tag?: string;
}) {
  return (
    <div className={`er-logo-box ${pulse ? "pulse" : ""}`}>
      <pre className="er-logo-ascii hidden sm:block" aria-hidden>
        {ASCII}
      </pre>
      <div className="er-logo sm:hidden">EDGERUNNER</div>
      <div className="er-logo-sub">{subtitle}</div>
      {tag ? <div className="er-logo-tag">{tag}</div> : null}
    </div>
  );
}
