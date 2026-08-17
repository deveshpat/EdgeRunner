"use client";

interface LogoProps {
  variant?: "hero" | "navbar";
  className?: string;
}

const ASCII_LINES = [
  { text: "███████╗██████╗  ██████╗ ███████╗", isEdge: true },
  { text: "██╔════╝██╔══██╗██╔════╝ ██╔════╝", isEdge: true },
  { text: "█████╗  ██║  ██║██║  ███╗█████╗", isEdge: true },
  { text: "██╔══╝  ██║  ██║██║   ██║██╔══╝", isEdge: true },
  { text: "███████╗██████╔╝╚██████╔╝███████╗", isEdge: true },
  { text: "╚══════╝╚═════╝  ╚═════╝ ╚══════╝", isEdge: true },
  { text: "██████╗ ██╗   ██╗███╗   ██╗███╗   ██╗███████╗██████╗", isEdge: false },
  { text: "██╔══██╗██║   ██║████╗  ██║████╗  ██║██╔════╝██╔══██╗", isEdge: false },
  { text: "██████╔╝██║   ██║██╔██╗ ██║██╔██╗ ██║█████╗  ██████╔╝", isEdge: false },
  { text: "██╔══██╗██║   ██║██║╚██╗██║██║╚██╗██║██╔══╝  ██╔══██╗", isEdge: false },
  { text: "██║  ██║╚██████╔╝██║ ╚████║██║ ╚████║███████╗██║  ██║", isEdge: false },
  { text: "╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝", isEdge: false },
];

export function Logo({ variant = "hero", className = "" }: LogoProps) {
  if (variant === "navbar") {
    return (
      <div className={`flex items-center justify-center select-none ${className}`}>
        <svg
          viewBox="0 0 556 260"
          className="h-7 sm:h-8 w-auto drop-shadow-[0_0_10px_rgba(57,255,20,0.35)] transition-all hover:opacity-90"
          aria-label="EdgeRunner"
        >
          <text x="28" y="32" xmlSpace="preserve" fontFamily="'Cascadia Code','Fira Code',Consolas,Menlo,Monaco,'Courier New',monospace" fontSize="16" fill="#39FF14">
            {ASCII_LINES.map((line, i) => (
              <tspan key={i} x={line.isEdge ? "119" : "28"} dy={i === 0 ? "0" : "18.40"}>
                {line.text}
              </tspan>
            ))}
          </text>
        </svg>
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center justify-center select-none ${className}`}>
      <svg
        viewBox="0 0 556 260"
        className="w-full max-w-[440px] sm:max-w-[500px] md:max-w-[540px] h-auto drop-shadow-[0_0_20px_rgba(57,255,20,0.3)] transition-all"
        aria-label="EdgeRunner"
      >
        <text x="28" y="32" xmlSpace="preserve" fontFamily="'Cascadia Code','Fira Code',Consolas,Menlo,Monaco,'Courier New',monospace" fontSize="16" fill="#39FF14">
          {ASCII_LINES.map((line, i) => (
            <tspan key={i} x={line.isEdge ? "119" : "28"} dy={i === 0 ? "0" : "18.40"}>
              {line.text}
            </tspan>
          ))}
        </text>
      </svg>
    </div>
  );
}
