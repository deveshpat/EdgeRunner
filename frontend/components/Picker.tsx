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
  onOpenModal?: () => void;
  badge?: string;
  isLoading?: boolean;
}

export function Picker({
  label,
  options,
  value,
  onChange,
  disabled,
  onOpenModal,
  badge,
  isLoading,
}: PickerProps) {
  const currentOption = options.find((o) => o.id === value) ?? {
    id: value,
    name: value || "select…",
  };

  const isModelPicker = label.toLowerCase().includes("payload");

  if (onOpenModal) {
    return (
      <div className="flex min-w-0 items-center gap-1.5 text-xs sm:text-sm font-mono">
        <button
          type="button"
          disabled={disabled}
          onClick={onOpenModal}
          className="group flex max-w-[140px] xs:max-w-[180px] sm:max-w-[240px] md:max-w-[280px] min-w-0 items-center gap-1.5 sm:gap-2 truncate rounded border border-term-border bg-term-bg px-2 sm:px-2.5 py-1 text-term-dim transition-all hover:border-term-green hover:text-term-fg focus:border-term-green focus:outline-none disabled:opacity-50"
          title={currentOption.description || currentOption.name}
        >
          <span className="text-xs font-semibold text-term-green shrink-0">
            {isModelPicker ? "◈" : "⚙"}
          </span>
          <span className="truncate text-xs sm:text-sm font-medium text-term-fg group-hover:text-term-green transition-colors">
            {currentOption.name}
          </span>
          {badge ? (
            <span className="shrink-0 rounded border border-term-green/50 bg-term-green/10 px-1 text-[9px] font-bold text-term-green">
              ●
            </span>
          ) : isLoading ? (
            <span className="shrink-0 text-[10px] text-term-amber animate-pulse font-bold">
              ⚡
            </span>
          ) : (
            <span className="text-[10px] text-term-dim group-hover:text-term-fg transition-colors shrink-0">
              ▾
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs sm:text-sm font-mono">
      <div className="relative flex items-center min-w-0">
        <select
          className="max-w-[90px] xs:max-w-[120px] sm:max-w-[150px] min-w-0 cursor-pointer truncate rounded border border-term-border bg-term-bg px-2 sm:px-2.5 py-1 text-xs sm:text-sm text-term-fg transition-colors hover:border-term-green focus:border-term-green focus:outline-none disabled:opacity-50"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.id} value={o.id} title={o.description} className="bg-term-bg text-term-fg">
              {o.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
