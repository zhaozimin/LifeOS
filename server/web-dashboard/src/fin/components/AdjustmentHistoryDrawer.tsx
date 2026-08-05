import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { ArrowDownRight, ArrowUpRight, History, X } from "lucide-react";
import type { Account, Transaction } from "../types";
import { api } from "../api/client";
import { useApi } from "../lib/useApi";
import { formatCurrency } from "../lib/format";

interface Props {
  open: boolean;
  account: Account | null;
  onClose: () => void;
}

export function AdjustmentHistoryDrawer({ open, account, onClose }: Props) {
  const { data: transactions } = useApi(
    () => (account ? api.listTransactions({ limit: 3000 }) : Promise.resolve([] as Transaction[])),
    [account?.id, open],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  const adjustments = useMemo(() => {
    if (!account || !transactions) return [];
    return transactions
      .filter(
        (tx) =>
          tx.source === "adjustment" &&
          [tx.accountName, tx.fromAccountName, tx.toAccountName].some((name) => name === account.name),
      )
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }, [account, transactions]);

  const stats = useMemo(() => {
    const total = adjustments.reduce((sum, tx) => {
      const sign = tx.kind === "income" ? 1 : tx.kind === "expense" ? -1 : 0;
      return sum + sign * tx.amount;
    }, 0);
    const lastAdjustedAt = adjustments[0]?.occurredAt;
    return { total, count: adjustments.length, lastAdjustedAt };
  }, [adjustments]);

  if (!open || !account) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="relative ml-auto flex h-full w-full max-w-[640px] flex-col bg-background shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-white"
                style={{ background: account.tintHex || "#7f91d6" }}
              >
                <History size={16} />
              </span>
              <h2 className="truncate text-display-sm">{account.name} · 调整历史</h2>
            </div>
            <div className="mt-1 text-[12.5px] text-muted-foreground">
              共 {stats.count} 条余额调整
              {stats.lastAdjustedAt && ` · 最近 ${stats.lastAdjustedAt.slice(0, 10)}`}
              {" · 累计差额 "}
              <span className={stats.total >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"}>
                {stats.total >= 0 ? "+" : "−"}{formatCurrency(Math.abs(stats.total))}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {adjustments.length === 0 && (
            <div className="rounded-lg border border-border bg-background/40 p-8 text-center text-[13px] text-muted-foreground">
              该账户没有「余额调整」交易。<br/>
              下次在「财务设置 → 账户管理」里改动当前余额时，差额会自动写一条 source='adjustment' 的交易，会出现在这里。
            </div>
          )}
          {adjustments.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full table-fixed border-collapse text-left text-[13px]">
                <colgroup>
                  <col className="w-[110px]" />
                  <col className="w-[80px]" />
                  <col className="w-auto" />
                  <col className="w-[120px]" />
                </colgroup>
                <thead className="bg-muted/30 text-caption-uppercase">
                  <tr>
                    <th className="px-3 py-2 font-semibold">日期</th>
                    <th className="px-3 py-2 font-semibold">方向</th>
                    <th className="px-3 py-2 font-semibold">备注</th>
                    <th className="px-3 py-2 text-right font-semibold">差额</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustments.map((tx) => (
                    <tr key={tx.id} className="border-t border-border/60 hover:bg-muted/20">
                      <td className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground">
                        {tx.occurredAt.slice(0, 10)}
                      </td>
                      <td className="px-3 py-2">
                        {tx.kind === "income" ? (
                          <span className="inline-flex items-center gap-1 rounded border border-emerald-700/30 bg-emerald-600/10 px-1.5 py-0.5 text-[10.5px] text-emerald-800 dark:text-emerald-300">
                            <ArrowDownRight size={10} /> 多出
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded border border-red-700/30 bg-red-600/10 px-1.5 py-0.5 text-[10.5px] text-red-800 dark:text-red-300">
                            <ArrowUpRight size={10} /> 少了
                          </span>
                        )}
                      </td>
                      <td className="truncate px-3 py-2 text-muted-foreground">{tx.note || tx.title}</td>
                      <td className={`px-3 py-2 text-right font-serif tabular-nums ${tx.kind === "income" ? "text-emerald-800" : "text-red-700"}`}>
                        {tx.kind === "income" ? "+" : "−"}¥{tx.amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 rounded-md border border-border bg-background/30 p-3 text-[12px] text-muted-foreground">
            💡 这些"余额调整"交易由系统自动生成 — 当你在「账户管理」改动当前余额时，与系统计算值之间的差额会写一条 income/expense 交易，让"账实不符"在账本里可追溯（即所谓"黑洞资金"）。
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
