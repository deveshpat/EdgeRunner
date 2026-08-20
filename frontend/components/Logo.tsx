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
          className="h-9 xs:h-10 sm:h-11 max-w-[240px] xs:max-w-[290px] sm:max-w-[380px] md:max-w-[440px] w-auto text-term-green fill-current drop-shadow-[0_0_18px_rgba(57,255,20,0.45)] transition-all hover:opacity-90 shrink-0"
          aria-label="EdgeRunner"
        >
          <text
            x="300"
            y="32"
            textAnchor="middle"
            xmlSpace="preserve"
            fontFamily="'JetBrains Mono','Cascadia Code','Fira Code',Consolas,Menlo,monospace"
            fontSize="15"
            fill="currentColor"
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
        className="w-full max-w-[340px] xs:max-w-[420px] sm:max-w-[540px] md:max-w-[620px] h-auto text-term-green fill-current drop-shadow-[0_0_24px_rgba(57,255,20,0.35)] transition-all px-1"
        aria-label="EdgeRunner"
      >
        <text
          x="300"
          y="32"
          textAnchor="middle"
          xmlSpace="preserve"
          fontFamily="'JetBrains Mono','Cascadia Code','Fira Code',Consolas,Menlo,monospace"
          fontSize="15"
          fill="currentColor"
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
