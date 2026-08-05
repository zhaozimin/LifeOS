/**
 * [INPUT]: 依赖 transactions、TimeRangePicker 与 FinCalendarDrawer。
 * [OUTPUT]: 提供财务三页共用的时间粒度和日历区间栏。
 * [POS]: 财务域页面级筛选器；替代旧 FinOS sidebar 对统一 shell 的业务耦合。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import type { Transaction } from "../types";
import { FinCalendarDrawer } from "./FinCalendarDrawer";
import { TimeRangePicker } from "./TimeRangePicker";

export function FinTimeRangeBar({ transactions }: { transactions: Transaction[] }) {
  return <section className="mb-4 flex flex-wrap items-end justify-between gap-3 rounded-lg border border-border bg-card/60 px-4 py-3">
    <TimeRangePicker transactions={transactions} />
    <FinCalendarDrawer />
  </section>;
}
