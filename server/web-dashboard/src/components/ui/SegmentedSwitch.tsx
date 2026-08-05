/**
 * [INPUT]: 依赖 clsx；受控组件，value 由调用方持有。
 * [OUTPUT]: 对外提供 SegmentedSwitch —— 带滑块指示的分段开关（2~4 档，thumb 平移动画）。
 * [POS]: components/ui 的少档位模式原语；两域合并后的单一实现，财务记账模式开关消费它，
 *   同样适合统计毛/纯等受控状态，本体不承担业务判断。
 *   与 Tabs 的边界：前者切换模式状态，后者切换内容面板。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import clsx from "clsx";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export function SegmentedSwitch<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (next: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={clsx(
        "relative inline-grid h-9 auto-cols-fr grid-flow-col items-stretch rounded-md border border-border bg-muted/50 p-0.5 select-none",
        className,
      )}
    >
      {/* 滑块：宽度 = 1/n，按选中索引平移 */}
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 rounded-[5px] bg-card shadow-sm transition-transform duration-200 ease-out"
        style={{ width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={clsx(
            "relative z-10 rounded-[5px] px-3 text-[13px] font-medium whitespace-nowrap transition-colors",
            option.value === value ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
