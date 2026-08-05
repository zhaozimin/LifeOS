/**
 * [INPUT]: 依赖 lucide 的 CheckCircle2/AlertCircle、clsx。
 * [OUTPUT]: 对外提供 StatusPill —— 保存状态指示胶囊（success/warning 两种语气）。
 * [POS]: components/ui 的保存反馈原语；两域合并后的单一实现，财务设置页头的“已保存/有未保存改动”消费它。
 *   对比度铁律：文字永远用 --foreground，状态色只落在图标上——emerald 文字在部分暗色主题不可读，此为修正。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import clsx from "clsx";

export function StatusPill({ tone, children, className }: { tone: "success" | "warning"; children: ReactNode; className?: string }) {
  return (
    <span
      aria-live="polite"
      className={clsx(
        "inline-flex h-9 select-none items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card/80 px-3 text-[13.5px] font-medium text-foreground",
        className,
      )}
    >
      {tone === "success" ? (
        <CheckCircle2 size={14} className="shrink-0 text-emerald-500" aria-hidden />
      ) : (
        <AlertCircle size={14} className="shrink-0 text-amber-500" aria-hidden />
      )}
      {children}
    </span>
  );
}
