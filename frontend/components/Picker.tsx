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
    <label className="flex min-w-0 items-center gap-2 text-xs">
      <span className="shrink-0 text-term-dim uppercase tracking-wider">{label}</span>
      <select
        className="max-w-[45vw] min-w-0 truncate rounded border border-term-border
                   bg-term-panel px-2 py-1 text-term-fg focus:border-term-green
                   focus:outline-none disabled:opacity-50 cursor-pointer sm:max-w-[220px]"
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
