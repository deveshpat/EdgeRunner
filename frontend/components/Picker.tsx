"use client";

interface Option {
  id: string;
  name: string;
  description?: string;
}

interface PickerProps {
  label: string;
  options: Option[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

export function Picker({
  label,
  options,
  value,
  onChange,
  disabled,
}: PickerProps) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-term-dim uppercase tracking-wider">{label}</span>
      <select
        className="bg-term-panel border border-term-border text-term-fg rounded px-2 py-1
                   focus:outline-none focus:border-term-green disabled:opacity-50
                   cursor-pointer"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id} title={o.description}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
