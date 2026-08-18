"use client";

interface LogoProps {
  variant?: "hero" | "navbar";
  className?: string;
}

const ASCII_LINES = [
  "███████╗██████╗  ██████╗ ███████╗",
  "██╔════╝██╔══██╗██╔════╝ ██╔════╝",
  "█████╗  ██║  ██║██║  ███╗█████╗  ",
  "██╔══╝  ██║  ██║██║   ██║██╔══╝  ",
  "███████╗██████╔╝╚██████╔╝███████╗",
  "╚══════╝╚═════╝  ╚═════╝ ╚══════╝",
  "██████╗ ██╗   ██╗███╗   ██╗███╗   ██╗███████╗██████╗ ",
  "██╔══██╗██║   ██║████╗  ██║████╗  ██║██╔════╝██╔══██╗",
  "██████╔╝██║   ██║██╔██╗ ██║██╔██╗ ██║█████╗  ██████╔╝",
  "██╔══██╗██║   ██║██║╚██╗██║██║╚██╗██║██╔══╝  ██╔══██╗",
  "██║  ██║╚██████╔╝██║ ╚████║██║ ╚████║███████╗██║  ██║",
  "╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝",
];

export function Logo({ variant = "hero", className = "" }: LogoProps) {
  if (variant === "navbar") {
    return (
      <div className={`flex items-center justify-center select-none min-w-0 ${className}`}>
        <svg
          viewBox="0 0 600 260"
          preserveAspectRatio="xMidYMid meet"
          className="h-6 xs:h-7 sm:h-8 max-w-[200px] xs:max-w-[260px] sm:max-w-[320px] w-auto drop-shadow-[0_0_10px_rgba(57,255,20,0.35)] transition-all hover:opacity-90 shrink-0"
          aria-label="EdgeRunner"
        >
          <text
            x="300"
            y="32"
            textAnchor="middle"
            xmlSpace="preserve"
            fontFamily="'JetBrains Mono','Cascadia Code','Fira Code',Consolas,Menlo,monospace"
            fontSize="15"
            fill="#39FF14"
          >
            {ASCII_LINES.map((line, i) => (
              <tspan key={i} x="300" dy={i === 0 ? "0" : "18.5"}>
                {line}
              </tspan>
            ))}
          </text>
        </svg>
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center justify-center select-none w-full ${className}`}>
      <svg
        viewBox="0 0 600 260"
        preserveAspectRatio="xMidYMid meet"
        className="w-full max-w-[300px] xs:max-w-[360px] sm:max-w-[460px] md:max-w-[540px] h-auto drop-shadow-[0_0_20px_rgba(57,255,20,0.3)] transition-all px-1"
        aria-label="EdgeRunner"
      >
        <text
          x="300"
          y="32"
          textAnchor="middle"
          xmlSpace="preserve"
          fontFamily="'JetBrains Mono','Cascadia Code','Fira Code',Consolas,Menlo,monospace"
          fontSize="15"
          fill="#39FF14"
        >
          {ASCII_LINES.map((line, i) => (
            <tspan key={i} x="300" dy={i === 0 ? "0" : "18.5"}>
              {line}
            </tspan>
          ))}
        </text>
      </svg>
    </div>
  );
}
