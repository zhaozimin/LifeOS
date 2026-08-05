/**
 * [INPUT]: 依赖 ui/Modal、ui/Button、ReimbursementPill 的 ReimbursementStatusTag、
 *   api/client 的 settleReimbursement、lib/reimbursement 的判定函数、lib/format 的 formatCurrency。
 * [OUTPUT]: 对外提供 ReimbursementSettleSheet —— 回款核销对账抽屉：
 *   针对一笔报销回款收入，勾选它覆盖了哪些垫付支出，批量核销/撤销。
 * [POS]: LedgerPage 报销流程的第三步（回款对账）；第一步记垫付、第二步收回款
 *   都走 TransactionEditSheet，本组件只负责"劈开回款"这一件事。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useState } from "react";
import { CheckSquare, Square } from "lucide-react";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { ReimbursementStatusTag } from "./ReimbursementPill";
import { api } from "../api/client";
import { formatCurrency } from "../lib/format";
import { isPendingReimbursement, isReimbursable } from "../lib/reimbursement";
import type { Transaction } from "../types";

interface Props {
  open: boolean;
  /** 被核销的回款收入 */
  income: Transaction | null;
  /** 全量流水（用于筛出垫付候选） */
  transactions: Transaction[];
  onClose: () => void;
  onSettled: () => void;
}

export function ReimbursementSettleSheet({ open, income, transactions, onClose, onSettled }: Props) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 候选 = 尚未回款的垫付 + 已挂在这笔回款名下的（可取消勾选）
  const candidates = useMemo(() => {
    if (!income) return [];
    return transactions
      .filter((tx) => !tx.deletedAt && isReimbursable(tx))
      .filter((tx) => isPendingReimbursement(tx) || tx.reimbursedBy === income.id)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }, [income, transactions]);

  const initiallyLinked = useMemo(() => {
    if (!income) return new Set<string>();
    return new Set(candidates.filter((tx) => tx.reimbursedBy === income.id).map((tx) => tx.id));
  }, [candidates, income]);

  useEffect(() => {
    if (open) {
      setChecked(new Set(initiallyLinked));
      setError(null);
    }
  }, [open, initiallyLinked]);

  const checkedSum = useMemo(
    () => candidates.filter((tx) => checked.has(tx.id)).reduce((sum, tx) => sum + tx.amount, 0),
    [candidates, checked],
  );
  const incomeAmount = income?.amount || 0;
  const diff = incomeAmount - checkedSum;

  const dirty = useMemo(() => {
    if (checked.size !== initiallyLinked.size) return true;
    for (const id of checked) if (!initiallyLinked.has(id)) return true;
    return false;
  }, [checked, initiallyLinked]);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onConfirm = async () => {
    if (!income) return;
    setSaving(true);
    setError(null);
    try {
      await api.settleReimbursement({
        incomeId: income.id,
        settleIds: [...checked],
        unsettleIds: [...initiallyLinked].filter((id) => !checked.has(id)),
      });
      onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "核销失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="回款核销"
      description={income ? `${income.occurredAt.slice(0, 10)} · ${income.title} · ${formatCurrency(income.amount)}` : undefined}
      size="md"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className={`text-[12.5px] tabular-nums ${diff === 0 ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}`}>
            已勾选 {formatCurrency(checkedSum)}
            {diff > 0 && ` · 剩余 ${formatCurrency(diff)} 未对应垫付`}
            {diff < 0 && ` · 勾选超出回款 ${formatCurrency(-diff)}`}
            {diff === 0 && checkedSum > 0 && " · 金额对平"}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>取消</Button>
            <Button onClick={onConfirm} disabled={saving || !dirty}>
              {saving ? "核销中…" : "确认核销"}
            </Button>
          </div>
        </div>
      }
    >
      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          {error}
        </div>
      )}
      {candidates.length === 0 ? (
        <div className="empty-state">没有待核销的垫付支出。</div>
      ) : (
        <div className="max-h-[52vh] space-y-1 overflow-y-auto pr-1">
          {candidates.map((tx) => {
            const active = checked.has(tx.id);
            return (
              <button
                key={tx.id}
                type="button"
                onClick={() => toggle(tx.id)}
                className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  active
                    ? "border-primary/45 bg-primary/5"
                    : "border-border bg-background/45 hover:bg-muted/40"
                }`}
              >
                <span className={active ? "text-primary" : "text-muted-foreground/60"}>
                  {active ? <CheckSquare size={17} /> : <Square size={17} />}
                </span>
                <span className="w-[84px] shrink-0 text-mono text-[12.5px] text-muted-foreground tabular-nums">
                  {tx.occurredAt.slice(0, 10)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-foreground">{tx.title}</span>
                  <span className="block truncate text-[11.5px] text-muted-foreground">
                    {tx.accountName}
                    {tx.projectName ? ` · ${tx.projectName}` : ""}
                  </span>
                </span>
                <ReimbursementStatusTag status={tx.reimbursementStatus} className="shrink-0" />
                <span className="w-[96px] shrink-0 text-right font-serif text-[15px] tabular-nums text-red-700 dark:text-red-400">
                  {formatCurrency(tx.amount)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
