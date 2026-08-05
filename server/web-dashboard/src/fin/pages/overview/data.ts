/**
 * [INPUT]: 依赖账户归属和交易模型。
 * [OUTPUT]: 提供收入、项目、工作生活聚合与账户流水选择。
 * [POS]: Overview 的纯数据转换层。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { accountOwnershipMap } from "../../lib/financeAnalytics";
import type { Account, Transaction } from "../../types";


export function buildIncomeTrend(transactions: Transaction[]) {
  const buckets = new Map<
    string,
    { income: number; expense: number; incomeTransactions: Transaction[]; allTransactions: Transaction[] }
  >();
  for (const tx of transactions) {
    const label = monthLabel(tx);
    if (!label) continue;
    const current = buckets.get(label) || {
      income: 0,
      expense: 0,
      incomeTransactions: [],
      allTransactions: [],
    };
    if (tx.kind === "income") {
      current.income += tx.amount;
      current.incomeTransactions.push(tx);
    }
    if (tx.kind === "expense") current.expense += tx.amount;
    current.allTransactions.push(tx);
    buckets.set(label, current);
  }

  const labels = Array.from(buckets.keys()).sort().slice(-14);
  return {
    labels,
    income: labels.map((label) => Number((buckets.get(label)?.income || 0).toFixed(2))),
    net: labels.map((label) => {
      const item = buckets.get(label);
      return Number(((item?.income || 0) - (item?.expense || 0)).toFixed(2));
    }),
    incomeTransactions: new Map(labels.map((label) => [label, buckets.get(label)?.incomeTransactions || []])),
    allTransactions: new Map(labels.map((label) => [label, buckets.get(label)?.allTransactions || []])),
  };
}

export function buildProjectCostRevenue(transactions: Transaction[]) {
  const groups = new Map<string, { cost: number; revenue: number; transactions: Transaction[] }>();
  for (const tx of transactions) {
    const project = tx.projectName?.trim();
    if (!project) continue;
    const current = groups.get(project) || { cost: 0, revenue: 0, transactions: [] };
    if (tx.kind === "expense") current.cost += tx.amount;
    if (tx.kind === "income") current.revenue += tx.amount;
    current.transactions.push(tx);
    groups.set(project, current);
  }

  const entries = Array.from(groups.entries())
    .filter(([, item]) => item.cost > 0 || item.revenue > 0)
    .sort((a, b) => b[1].cost + b[1].revenue - (a[1].cost + a[1].revenue))
    .slice(0, 14);

  return {
    projects: entries.map(([name]) => name),
    cost: entries.map(([, item]) => Number(item.cost.toFixed(2))),
    revenue: entries.map(([, item]) => Number(item.revenue.toFixed(2))),
    transactions: new Map(entries.map(([name, item]) => [name, item.transactions])),
  };
}

export function buildWorkLifeExpense(transactions: Transaction[], accounts: Account[]) {
  const ownership = accountOwnershipMap(accounts);
  const monthKeys = Array.from(
    new Set(transactions.filter((tx) => tx.kind === "expense").map((tx) => monthLabel(tx)).filter(Boolean)),
  )
    .sort()
    .slice(-12);
  const transactionMap = new Map<string, Transaction[]>();

  const work = monthKeys.map((label) => {
    const items = transactions.filter(
      (tx) =>
        tx.kind === "expense" &&
        monthLabel(tx) === label &&
        ownership[tx.fromAccountName || tx.accountName] === "company",
    );
    transactionMap.set(`${label}__company`, items);
    return Number(items.reduce((sum, tx) => sum + tx.amount, 0).toFixed(2));
  });

  const life = monthKeys.map((label) => {
    const items = transactions.filter(
      (tx) =>
        tx.kind === "expense" &&
        monthLabel(tx) === label &&
        ownership[tx.fromAccountName || tx.accountName] === "personal",
    );
    transactionMap.set(`${label}__personal`, items);
    return Number(items.reduce((sum, tx) => sum + tx.amount, 0).toFixed(2));
  });

  return { months: monthKeys, work, life, transactions: transactionMap };
}

export function transactionsForAccount(transactions: Transaction[], accountName: string) {
  return transactions.filter((tx) =>
    [tx.accountName, tx.fromAccountName, tx.toAccountName].some((name) => name === accountName),
  );
}

export function monthLabel(tx: Transaction) {
  return tx.occurredAt?.slice(0, 7).replace("-", "/") || "";
}

export function formatAxisCurrency(value: number) {
  const abs = Math.abs(value);
  if (abs >= 10000) return `¥${(value / 10000).toFixed(1)}w`;
  if (abs >= 1000) return `¥${(value / 1000).toFixed(1)}k`;
  return `¥${Math.round(value)}`;
}
