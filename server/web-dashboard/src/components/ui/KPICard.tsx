/**
 * [INPUT]: 依赖 Card 语义 token、可选趋势/图标与 clsx。
 * [OUTPUT]: 对外提供衬线大数字、tabular-nums 和三档强调层级的 KPI 卡。
 * [POS]: components/ui 的指标展示原语；今日与统计页共享，不解释数值好坏。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { ReactNode } from "react";
import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

interface Props {
  label: string;
  value: string;
  change?: string;
  trend?: "up" | "down" | "flat";
  helper?: string;
  icon?: ReactNode;
  emphasis?: "default" | "primary" | "subtle";
}

export function KPICard({
  label,
  value,
  change,
  trend = "flat",
  helper,
  icon,
  emphasis = "default",
}: Props) {
  const surfaceClass = {
    default: "bg-card text-card-foreground border border-border",
    primary: "bg-primary text-primary-foreground",
    subtle: "bg-muted/40 text-foreground border border-border",
  }[emphasis];

  const trendIcon =
    trend === "up" ? <ArrowUpRight size={14} /> : trend === "down" ? <ArrowDownRight size={14} /> : <Minus size={14} />;

  return (
    <div className={clsx("rounded-xl p-5 flex flex-col gap-3 min-h-[148px]", surfaceClass)}>
      <div className="flex items-center justify-between">
        <span
          className={clsx(
            "text-[11px] font-semibold tracking-wider uppercase",
            emphasis === "default" ? "text-muted-foreground" : "opacity-80",
          )}
        >
          {label}
        </span>
        {icon && <span className="opacity-70">{icon}</span>}
      </div>
      <div className="serif text-[28px] tabular-nums leading-none mt-1">{value}</div>
      <div className="flex items-center gap-2 mt-auto">
        {change && (
          <span
            className={clsx(
              "inline-flex items-center gap-1 text-[12px] font-medium",
              emphasis !== "default"
                ? "opacity-90"
                : trend === "up"
                ? "text-emerald-600 dark:text-emerald-400"
                : trend === "down"
                ? "text-[#a85a2c] dark:text-[#f2a472]"
                : "text-muted-foreground",
            )}
          >
            {trendIcon}
            {change}
          </span>
        )}
        {helper && (
          <span
            className={clsx(
              "text-[11.5px]",
              emphasis === "default" ? "text-muted-foreground" : "opacity-70",
            )}
          >
            {helper}
          </span>
        )}
      </div>
    </div>
  );
}
