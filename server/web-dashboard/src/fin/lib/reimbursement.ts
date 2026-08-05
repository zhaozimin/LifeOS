/**
 * [INPUT]: 依赖 types 的 ReimbursementStatus / Transaction。
 * [OUTPUT]: 对外提供 REIMBURSEMENT_STATUS_META、REIMBURSEMENT_INCOME_SOURCE、
 *   isReimbursable / isPendingReimbursement / isReimbursementIncome 判定函数。
 * [POS]: lib 层的报销领域模型；ReimbursementPieCard、LedgerPage、ReimbursementSettleSheet
 *   共享同一套状态语义，避免各页面私造判定逻辑。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { ReimbursementStatus, Transaction } from "../types";

export const REIMBURSEMENT_STATUS_META: Array<{ value: ReimbursementStatus; label: string }> = [
  { value: "draft", label: "待报销" },
  { value: "submitted", label: "已提交" },
  { value: "reimbursed", label: "已报销" },
  { value: "rejected", label: "已驳回" },
];

/** 报销回款的资金来源名（与服务端 source-reimbursement 种子一致） */
export const REIMBURSEMENT_INCOME_SOURCE = "报销回款";

/** 带报销属性的支出（无论已报未报） */
export function isReimbursable(tx: Transaction): boolean {
  return tx.kind === "expense" && !!tx.reimbursementStatus && tx.reimbursementStatus !== "notApplicable";
}

/** 尚未回款的垫付（draft/submitted/rejected 都算未拿到钱） */
export function isPendingReimbursement(tx: Transaction): boolean {
  return isReimbursable(tx) && tx.reimbursementStatus !== "reimbursed";
}

/** 报销回款收入（可对其核销垫付） */
export function isReimbursementIncome(tx: Transaction): boolean {
  return tx.kind === "income" && tx.sourceName === REIMBURSEMENT_INCOME_SOURCE;
}
