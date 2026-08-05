/**
 * [INPUT]: 依赖受控 tab 值、标签列表与 clsx。
 * [OUTPUT]: 对外提供统一键值切换与选中态的 Tabs 原语。
 * [POS]: components/ui 的多面板导航原语；CategoryTabs 是财务账本与设置分组导航的唯一实现，保持无业务状态。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import clsx from "clsx";

interface Props<T extends string> {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel?: string;
  size?: "md" | "sm";
  variant?: "segmented" | "pills";
}

export function CategoryTabs<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = "md",
  variant = "segmented",
}: Props<T>) {
  const isPills = variant === "pills";
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={clsx(
        "inline-flex items-center",
        isPills ? "flex-wrap gap-2" : "gap-1 rounded-md border border-border bg-muted/70 p-1",
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(opt.value)}
            className={clsx(
              "font-medium transition-colors",
              isPills ? "rounded-md border shadow-sm" : "rounded-sm",
              size === "sm" ? "px-2.5 py-1 text-[12px]" : "px-3.5 py-1.5 text-[13.5px]",
              isPills
                ? active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
                : active
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
