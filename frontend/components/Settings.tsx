"use client";

import type { Settings } from "@/lib/storage";

interface SettingsPanelProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}

function Slider({ label, value, min, max, step, format, onChange }: SliderProps) {
  return (
    <label className="flex items-center gap-3 text-xs">
      <span className="w-24 text-term-dim uppercase tracking-wider">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="er-slider flex-1"
      />
      <span className="w-14 text-right text-term-fg tabular-nums">
        {format ? format(value) : value}
      </span>
    </label>
  );
}

export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  return (
    <div className="mt-2 space-y-2 rounded border border-term-border bg-term-panel/50 p-3">
      <Slider
        label="temperature"
        value={settings.temperature}
        min={0}
        max={2}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(v) => onChange({ temperature: v })}
      />
      <Slider
        label="top_p"
        value={settings.topP}
        min={0}
        max={1}
        step={0.01}
        format={(v) => v.toFixed(2)}
        onChange={(v) => onChange({ topP: v })}
      />
      <Slider
        label="max_tokens"
        value={settings.maxTokens}
        min={64}
        max={8192}
        step={64}
        onChange={(v) => onChange({ maxTokens: v })}
      />
    </div>
  );
}
