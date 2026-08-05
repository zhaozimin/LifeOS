/**
 * [INPUT]: 依赖 ui/Button、ui/Badge、lib/financeAnalytics 汇总、lib/useBodyScrollLock、
 *   index.css 的 animate-overlay-in / animate-drawer-up 动效类。
 * [OUTPUT]: 对外提供 TransactionDrawer —— 底部上滑的流水明细抽屉，图表/看板钻取的通用容器。
 * [POS]: OverviewPage 与 FlowPage 点击图表节点后的明细层；z-70，低于编辑弹窗 z-80。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { memo, useEffect, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Hash, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { formatCurrency } from "../lib/format";
import { summarizeTransactions } from "../lib/financeAnalytics";
import { useBodyScrollLock } from "../lib/useBodyScrollLock";
import type { Transaction } from "../types";

interface Props {
  open: boolean;
  title: string;
  description?: string;
  transactions: Transaction[];
  onClose: () => void;
  onEdit: (transaction: Transaction) => void;
}

const KIND_LABEL = {
  income: "收入",
  expense: "支出",
  transfer: "转账",
} as const;

const KIND_TONE = {
  income: "success",
  expense: "destructive",
  transfer: "brand-blue",
} as const;

export const TransactionDrawer = memo(function TransactionDrawer({
  open,
  title,
  description,
  transactions,
  onClose,
  onEdit,
}: Props) {
  useBodyScrollLock(open);
  const sorted = useMemo(
    () => [...transactions].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
    [transactions],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const summary = summarizeTransactions(transactions);

  return createPortal(
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="关闭流水抽屉遮罩"
        className="animate-overlay-in absolute inset-0 bg-black/45"
        onClick={onClose}
      />
      <section
        className="animate-drawer-up absolute inset-x-0 bottom-0 mx-auto flex h-[72vh] max-h-[820px] min-h-[360px] w-full max-w-6xl flex-col rounded-t-xl border border-border bg-card text-card-foreground shadow-[0_-24px_90px_rgba(0,0,0,0.35)]"
      >
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="serif text-[24px] leading-tight">{title}</h2>
            {description && <p className="mt-1 text-body-sm text-muted-foreground">{description}</p>}
          </div>
          <div className="flex items-center gap-2">
            <Metric icon={<TrendingUp size={18} />} label="收入" value={formatCurrency(summary.income)} tone="success" />
            <Metric icon={<TrendingDown size={18} />} label="支出" value={formatCurrency(summary.expense)} tone="danger" />
            <Metric icon={<Hash size={18} />} label="条数" value={summary.count} />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {sorted.length === 0 ? (
            <div className="empty-state">当前图表节点没有对应流水。</div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[860px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-border bg-muted/20 text-caption-uppercase">
                    <th className="px-4 py-3 font-semibold">时间</th>
                    <th className="px-4 py-3 font-semibold">类型</th>
                    <th className="px-4 py-3 font-semibold">摘要</th>
                    <th className="px-4 py-3 font-semibold">账户</th>
                    <th className="px-4 py-3 font-semibold">分类 / 项目</th>
                    <th className="px-4 py-3 font-semibold">操作</th>
                    <th className="px-4 py-3 text-right font-semibold">金额</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((tx) => (
                    <tr key={tx.id} className="border-b border-border/80 last:border-0 hover:bg-muted/25">
                      <td className="px-4 py-3 text-mono text-muted-foreground">
                        {tx.occurredAt.slice(0, 16).replace("T", " ")}
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={KIND_TONE[tx.kind]}>{KIND_LABEL[tx.kind]}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => onEdit(tx)}
                          className="text-left font-semibold text-foreground hover:text-primary"
                        >
                          {tx.title}
                        </button>
                        {tx.merchant && tx.merchant !== tx.title && (
                          <div className="text-caption">{tx.merchant}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-body-sm text-muted-foreground">
                        {tx.kind === "transfer"
                          ? `${tx.fromAccountName || "?"} → ${tx.toAccountName || "?"}`
                          : tx.accountName}
                      </td>
                      <td className="px-4 py-3 text-body-sm">
                        {tx.category?.name || "未分类"}
                        {tx.projectName && <span className="text-muted-foreground"> · {tx.projectName}</span>}
                      </td>
                      <td className="px-4 py-3">
                        <Button variant="text" size="sm" onClick={() => onEdit(tx)}>
                          编辑
                        </Button>
                      </td>
                      <td className="px-4 py-3 text-right font-serif tabular-nums">
                        {tx.kind === "expense" ? "−" : tx.kind === "income" ? "+" : ""}
                        {formatCurrency(tx.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <footer className="border-t border-border bg-card/95 px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-caption">当前显示 {summary.count} 条流水</span>
            <Button variant="outline" className="w-full sm:w-auto" onClick={onClose}>
              关闭流水页面
            </Button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
});

function Metric({
  icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
  tone?: "neutral" | "success" | "danger";
}) {
  const styles = {
    neutral: {
      value: "text-foreground",
    },
    success: {
      value: "text-emerald-800",
    },
    danger: {
      value: "text-red-700",
    },
  }[tone];

  return (
    <div className="flex h-[58px] w-[154px] shrink-0 items-center gap-3 rounded-md border border-border bg-background/55 px-3">
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0 text-left">
        <div className="text-[11px] font-semibold leading-tight text-muted-foreground">{label}</div>
        <div className={`mt-1 whitespace-nowrap text-[15px] leading-none tabular-nums ${styles.value}`}>
          {value}
        </div>
      </div>
    </div>
  );
}
