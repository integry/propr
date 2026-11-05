interface ConnectToggleProps {
  checked: boolean;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
}

export function ConnectToggle({ checked, disabled, onToggle }: ConnectToggleProps) {
  return (
    <label className="flex cursor-pointer items-center gap-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onToggle(e.target.checked)}
        className="h-4 w-4 flex-shrink-0 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
      />
      <span className="text-sm font-medium text-slate-900">Allow MCP clients through ProPR Connect</span>
    </label>
  );
}
