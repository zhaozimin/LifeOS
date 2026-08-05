/**
 * [INPUT]: 依赖 ReactNode。
 * [OUTPUT]: 提供财务看板 KPI 状态卡。
 * [POS]: Overview 的可复用指标展示原语。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { ReactNode } from "react";


export function StatusCard({
  icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn";
}) {
  const color = {
    neutral: "text-foreground",
    good: "text-success",
    warn: "text-primary",
  }[tone];
  return (
    <div className="rounded-lg border border-border bg-card/90 p-4">
      <div className="mb-3 flex items-center gap-3 text-muted-foreground">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-muted">{icon}</span>
        <span className="text-caption">{label}</span>
      </div>
      <div className={`text-display-sm tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
