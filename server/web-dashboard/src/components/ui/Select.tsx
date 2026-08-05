/**
 * [INPUT]: 依赖 React 原生 select 属性与 clsx。
 * [OUTPUT]: 对外提供带标签、提示和语义 token 的受控 Select 原语。
 * [POS]: components/ui 的基础选择器；小枚举与触屏降级统一使用。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { forwardRef } from "react";
import type { SelectHTMLAttributes } from "react";
import clsx from "clsx";

interface Props extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
}

export const Select = forwardRef<HTMLSelectElement, Props>(function Select(
  { label, hint, options, className, ...rest },
  ref,
) {
  return (
    <label className="block">
      {label && (
        <span className="text-[11px] font-semibold tracking-wider uppercase text-muted-foreground block mb-1.5">
          {label}
        </span>
      )}
      <span className="relative block">
        <select
          ref={ref}
          className={clsx(
            "h-10 w-full pl-3 pr-9 rounded-md bg-background/70 border border-border text-[13.5px] text-foreground appearance-none focus:outline-none focus:border-ring focus:ring-2 focus:ring-inset focus:ring-ring/30",
            className,
          )}
          {...rest}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
        >
          <path d="M3 5.5L7 9.5L11 5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {hint && <span className="text-[11.5px] text-muted-foreground mt-1 block">{hint}</span>}
    </label>
  );
});
