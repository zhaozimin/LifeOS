import { useMemo } from "react";
import { Repeat } from "lucide-react";
import type { RecurringRule } from "../types";
import { recurringTotals } from "../lib/financeAnalytics";
import { formatCurrency } from "../lib/format";

export function SubscriptionsCard({ rules }: { rules: RecurringRule[] }) {
  const totals = useMemo(() => recurringTotals(rules), [rules]);
  if (totals.subscriptions.length === 0) {
    return (
      <div className="empty-state">
        在「财务设置 → 周期账目」加一条月度支出规则后，这里会列出订阅清单。
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3 rounded-md border border-border bg-background/40 px-4 py-3">
        <div>
          <div className="text-caption text-muted-foreground">月度订阅支出 · 共 {totals.subscriptions.length} 项</div>
          <div className="font-serif text-[18px] tabular-nums text-destructive">
            {formatCurrency(totals.monthlyExpense)} / 月
          </div>
        </div>
        <div className="text-right">
          <div className="text-caption text-muted-foreground">年化</div>
          <div className="font-serif text-[14px] tabular-nums text-foreground">
            {formatCurrency(totals.yearlyExpense)}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {totals.subscriptions.map((sub) => (
          <div
            key={sub.id}
            className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/30 px-3 py-2 text-[13px]"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Repeat size={13} />
              </span>
              <span className="truncate font-medium">{sub.name}</span>
            </div>
            <span className="font-serif tabular-nums text-foreground">{formatCurrency(sub.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
