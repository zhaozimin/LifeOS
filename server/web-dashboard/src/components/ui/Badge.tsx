/**
 * [INPUT]: 依赖 React span 属性、clsx 与主题状态色 token。
 * [OUTPUT]: 对外提供紧凑语义标签 Badge。
 * [POS]: components/ui 的只读标记原语；不编码时间领域判断。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { HTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

type Tone =
  | "neutral"
  | "outline"
  | "primary"
  | "success"
  | "warning"
  | "destructive"
  | "brand-orange"
  | "brand-blue"
  | "brand-violet";

interface Props extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  uppercase?: boolean;
  children: ReactNode;
}

const toneClass: Record<Tone, string> = {
  neutral: "bg-muted text-foreground",
  outline: "bg-transparent border border-border text-muted-foreground",
  primary: "bg-primary text-primary-foreground",
  success: "bg-emerald-600/18 text-emerald-900",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  destructive: "bg-red-600/16 text-red-900",
  "brand-orange": "bg-[var(--brand-orange)]/22 text-[#a85a2c] dark:text-[#f2c388]",
  "brand-blue": "bg-blue-600/16 text-blue-900",
  "brand-violet": "bg-[var(--brand-violet)]/18 text-[#7a2cab] dark:text-[#d480ff]",
};

export function Badge({ tone = "neutral", uppercase, className, children, ...rest }: Props) {
  return (
    <span
      className={clsx(
        "inline-flex items-center px-2.5 py-[2px] rounded-md border border-transparent font-medium",
        uppercase ? "text-[10.5px] tracking-wider uppercase" : "text-[12px]",
        toneClass[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
