import type { BudgetStatusItem } from "../types";
import { formatCurrency } from "../lib/format";

export function BudgetProgressCard({
  items,
  totalBudget,
  totalSpent,
  totalRemaining,
  month,
  onItemClick,
}: {
  items: BudgetStatusItem[];
  totalBudget: number;
  totalSpent: number;
  totalRemaining: number;
  month: string;
  onItemClick?: (item: BudgetStatusItem) => void;
}) {
  if (!items.length) {
    return (
      <div className="empty-state">
        在「财务设置 → 类别管理」给支出分类设置月度预算后，这里会出现进度卡。
      </div>
    );
  }

  const overallPercent = totalBudget > 0 ? (totalSpent / totalBudget) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3 rounded-md border border-border bg-background/40 px-4 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-caption text-muted-foreground">{month} 总预算</span>
          <span className="font-serif text-[18px] tabular-nums text-foreground">
            {formatCurrency(totalSpent)} / {formatCurrency(totalBudget)}
          </span>
        </div>
        <span
          className={`text-[13px] tabular-nums font-medium ${
            totalRemaining >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"
          }`}
        >
          {totalRemaining >= 0 ? "剩余" : "超支"} {formatCurrency(Math.abs(totalRemaining))} · {overallPercent.toFixed(1)}%
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <BudgetRow key={item.categoryId} item={item} onClick={onItemClick} />
        ))}
      </div>
    </div>
  );
}

function BudgetRow({
  item,
  onClick,
}: {
  item: BudgetStatusItem;
  onClick?: (item: BudgetStatusItem) => void;
}) {
  const percent = Math.min(100, Math.max(0, item.percentUsed));
  const overflow = item.percentUsed > 100;
  const tone =
    item.percentUsed > 100
      ? { text: "text-destructive", bg: "bg-destructive", track: "bg-destructive/15" }
      : item.percentUsed > 80
        ? { text: "text-amber-700 dark:text-amber-300", bg: "bg-amber-500", track: "bg-amber-500/15" }
        : { text: "text-emerald-700 dark:text-emerald-300", bg: "bg-emerald-500", track: "bg-emerald-500/15" };

  const Wrapper: React.ElementType = onClick ? "button" : "div";

  return (
    <Wrapper
      type={onClick ? "button" : undefined}
      onClick={onClick ? () => onClick(item) : undefined}
      className={`group/budget rounded-lg border border-border bg-background/40 p-4 text-left transition-colors hover:border-border/80 ${onClick ? "cursor-pointer" : ""}`}
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: item.color }} />
          <span className="truncate text-[14px] font-semibold text-foreground">{item.name}</span>
        </div>
        <span className={`text-[12.5px] tabular-nums font-medium ${tone.text}`}>
          {item.percentUsed.toFixed(1)}%
        </span>
      </div>
      <div className={`relative h-2 overflow-hidden rounded-full ${tone.track}`}>
        <div className={`h-full rounded-full ${tone.bg}`} style={{ width: `${percent}%` }} />
        {overflow && (
          <div
            className="absolute inset-y-0 left-0 h-full bg-destructive/40"
            style={{ width: `${Math.min(100, item.percentUsed - 100)}%`, backdropFilter: "saturate(1.4)" }}
          />
        )}
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3 text-[12px]">
        <span className="text-muted-foreground tabular-nums">
          已花 {formatCurrency(item.spent)} / {formatCurrency(item.budget)}
        </span>
        <span className={`tabular-nums ${tone.text}`}>
          {item.remaining >= 0 ? `剩余 ${formatCurrency(item.remaining)}` : `超支 ${formatCurrency(-item.remaining)}`}
        </span>
      </div>
    </Wrapper>
  );
}
