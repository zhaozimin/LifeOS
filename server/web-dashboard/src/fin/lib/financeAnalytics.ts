/**
 * [INPUT]: 依赖财务领域类型与时间范围筛选规则。
 * [OUTPUT]: 对外提供余额、流水归属、汇总与图表数据转换函数。
 * [POS]: web-dashboard 的纯业务分析层；为页面和图表隔离原始 API 数据中的边界情况。
 *   本层所有聚合都以「输入是整本账」为前提，页面读取不得设置会截断历史的 limit。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import type {
  Account,
  AccountOwnership,
  RecurringFrequency,
  RecurringRule,
  SankeyLink,
  SankeyNode,
  TaxConfig,
  Transaction,
  ViewMode,
} from "../types";
import type { TimeDimension } from "../store/timeRange";
// 显式 .ts：本模块要能被 node --test 直接 import，无扩展名的运行期导入 Node 认不了。
// tsconfig 已开 allowImportingTsExtensions，Vite 与 tsc 都照常。
import { transactionMatchesRange } from "./timeRange.ts";

export function accountOwnershipMap(accounts: Account[]): Record<string, AccountOwnership> {
  return Object.fromEntries(
    accounts.map((account) => [account.name, account.ownership || "unspecified"]),
  );
}

export function transactionBelongsToView(
  tx: Transaction,
  view: ViewMode,
  ownership: Record<string, AccountOwnership>,
): boolean {
  if (view === "combined") return true;
  return [tx.accountName, tx.fromAccountName, tx.toAccountName].some(
    (name) => name && ownership[name] === view,
  );
}

export function filterTransactions(
  transactions: Transaction[],
  accounts: Account[],
  view: ViewMode,
  dimension: TimeDimension,
  bucket: string,
): Transaction[] {
  const ownership = accountOwnershipMap(accounts);
  return transactions.filter(
    (tx) =>
      transactionBelongsToView(tx, view, ownership) &&
      transactionMatchesRange(tx, dimension, bucket),
  );
}

/** 汇总取本位币折算额（外币交易 amount 是原币，直接相加会混币）；缺快照时回退原币。 */
function baseAmount(tx: Transaction): number {
  const b = tx.amountInBaseCurrency;
  return typeof b === "number" && Number.isFinite(b) ? b : tx.amount;
}

export function summarizeTransactions(transactions: Transaction[]) {
  const income = transactions
    .filter((tx) => tx.kind === "income")
    .reduce((sum, tx) => sum + baseAmount(tx), 0);
  const expense = transactions
    .filter((tx) => tx.kind === "expense")
    .reduce((sum, tx) => sum + baseAmount(tx), 0);
  const transfer = transactions
    .filter((tx) => tx.kind === "transfer")
    .reduce((sum, tx) => sum + baseAmount(tx), 0);
  const dates = new Set(transactions.map((tx) => tx.occurredAt.slice(0, 10)).filter(Boolean));
  return {
    income,
    expense,
    transfer,
    net: income - expense,
    count: transactions.length,
    dayCount: dates.size,
  };
}

/** 1.7 多币种：把账户原币金额折算到 base currency。
 * rates 缺省或币种缺失时按 1:1 处理（不影响 CNY 账户）。 */
export function convertToBase(amount: number, currency: string | undefined, rates?: Record<string, number>): number {
  if (!rates) return amount;
  const code = (currency || "CNY").toUpperCase();
  const rate = rates[code];
  if (typeof rate !== "number" || rate <= 0) return amount;
  return amount * rate;
}

/**
 * 参与余额聚合的账户：软删除的一律不算。
 *
 * 三个聚合函数曾各自 filter 一遍且都不看 deletedAt，于是被删账户的余额继续计入净资产——
 * 而同一份 draft 在 fin/pages/SettingsPage 里已经排除了它，删除卡片还明确写着「净资产 −50,000」。
 * 用户按提示删了账户、被告知净资产会降，看板却纹丝不动，两处对同一件事给出两个数。
 * 收敛成一道口径，下一个新增的聚合就不会再漏。
 */
function liveAccounts(accounts: Account[], ownership?: AccountOwnership): Account[] {
  return accounts.filter(
    (account) => !account.deletedAt && (!ownership || account.ownership === ownership),
  );
}

export function accountBalance(
  accounts: Account[],
  ownership?: AccountOwnership,
  rates?: Record<string, number>,
): number {
  // 净资产：资产之和 减去 负债之和（信用卡 / 房贷 / 消费贷等），按 base currency 折算
  return liveAccounts(accounts, ownership)
    .reduce((sum, account) => {
      const value = account.currentBalance ?? account.openingBalance ?? 0;
      const converted = convertToBase(value, account.currency, rates);
      const sign = account.classification === "liability" ? -1 : 1;
      return sum + converted * sign;
    }, 0);
}

export function totalAssets(accounts: Account[], ownership?: AccountOwnership, rates?: Record<string, number>): number {
  return liveAccounts(accounts, ownership)
    .filter((account) => account.classification !== "liability")
    .reduce((sum, account) => {
      const value = account.currentBalance ?? account.openingBalance ?? 0;
      return sum + convertToBase(value, account.currency, rates);
    }, 0);
}

export function totalLiabilities(accounts: Account[], ownership?: AccountOwnership, rates?: Record<string, number>): number {
  return liveAccounts(accounts, ownership)
    .filter((account) => account.classification === "liability")
    .reduce((sum, account) => {
      const value = account.currentBalance ?? account.openingBalance ?? 0;
      return sum + convertToBase(value, account.currency, rates);
    }, 0);
}

export function averageMonthlyExpense(transactions: Transaction[]): number {
  const monthly = new Map<string, number>();
  for (const tx of transactions) {
    if (tx.kind !== "expense") continue;
    const key = tx.occurredAt.slice(0, 7) || "unknown";
    monthly.set(key, (monthly.get(key) || 0) + tx.amount);
  }
  if (monthly.size === 0) return 0;
  return Array.from(monthly.values()).reduce((sum, value) => sum + value, 0) / monthly.size;
}

export function runwayMonths(balance: number, monthlyExpense: number): string {
  if (monthlyExpense <= 0) return "∞";
  return `${(balance / monthlyExpense).toFixed(1)} 个月`;
}

export function buildSankey(transactions: Transaction[], accounts: Account[]) {
  const accountNames = new Set(accounts.map((account) => account.name));
  // 出边表 source →（target → 累计金额）：既是聚合容器，也是判环用的邻接表。
  // 曾把两个名字编码成 `${source}__${target}` 当 key，回解时 split("__") 取前两段——
  // 账户名叫「现金__备用」就会解出既不是节点、也从没出现过的 source/target，
  // ECharts 静默丢弃这条边，这笔钱在「全局资金流」里凭空消失。
  // 名字是用户写的自由文本，任何分隔符都可能出现在里面：结构化数据不进字符串，就没有回解这一步。
  const links = new Map<string, Map<string, number>>();
  const nodeColor = new Map<string, string>();

  const remember = (name: string, color: string) => {
    if (!nodeColor.has(name)) nodeColor.set(name, color);
  };

  const canReach = (from: string, target: string): boolean => {
    const visited = new Set<string>();
    const pending = [from];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of links.get(current)?.keys() ?? []) pending.push(next);
    }
    return false;
  };

  const add = (source: string, target: string, value: number, sourceColor: string, targetColor: string) => {
    if (!source || !target || value <= 0) return;
    // ECharts Sankey 只接受有向无环图。真实账本允许来源与账户同名或资金往返，
    // 但这类边无法被桑基图表达，必须在展示模型中跳过，绝不能让它炸掉整个页面。
    if (source === target || canReach(target, source)) return;
    const outgoing = links.get(source) ?? new Map<string, number>();
    outgoing.set(target, (outgoing.get(target) || 0) + value);
    links.set(source, outgoing);
    remember(source, sourceColor);
    remember(target, targetColor);
  };

  const accountColor = (name: string) =>
    accounts.find((account) => account.name === name)?.tintHex || "#7f91d6";

  for (const tx of transactions) {
    const amount = Math.abs(Number(tx.amount) || 0);
    const categoryName = tx.category?.name || "未分类";
    const projectName = tx.projectName || categoryName;
    const sourceName = tx.sourceName || tx.merchant || tx.title || "资金来源";

    if (tx.kind === "income") {
      const target = tx.toAccountName || tx.accountName || "未命名账户";
      add(sourceName, target, amount, "#87b99b", accountColor(target));
    }

    if (tx.kind === "transfer") {
      const source = tx.fromAccountName || tx.accountName || "转出账户";
      const target = tx.toAccountName || "转入账户";
      add(source, target, amount, accountColor(source), accountColor(target));
    }

    if (tx.kind === "expense") {
      const source = tx.fromAccountName || tx.accountName || "支出账户";
      add(source, projectName, amount, accountColor(source), "#c69a7d");
      if (projectName !== categoryName) add(projectName, categoryName, amount, "#c69a7d", "#e09672");
    }
  }

  const nodes: SankeyNode[] = Array.from(nodeColor.entries()).map(([name, color]) => ({
    name,
    itemStyle: {
      color: accountNames.has(name) ? accountColor(name) : color,
    },
  }));
  const sankeyLinks: SankeyLink[] = [];
  for (const [source, outgoing] of links) {
    for (const [target, value] of outgoing) {
      sankeyLinks.push({ source, target, value: Number(value.toFixed(2)) });
    }
  }

  return { nodes, links: sankeyLinks };
}

export function buildProjectRoi(transactions: Transaction[]) {
  const groups = new Map<string, { cost: number; revenue: number }>();
  for (const tx of transactions) {
    const key = tx.projectName || tx.tags?.[0] || tx.category?.name || "未归类";
    const current = groups.get(key) || { cost: 0, revenue: 0 };
    if (tx.kind === "income") current.revenue += tx.amount;
    if (tx.kind === "expense") current.cost += tx.amount;
    groups.set(key, current);
  }

  const entries = Array.from(groups.entries())
    .filter(([, item]) => item.cost > 0 || item.revenue > 0)
    .sort((a, b) => b[1].cost + b[1].revenue - (a[1].cost + a[1].revenue))
    .slice(0, 6);

  return {
    projects: entries.map(([name]) => name),
    cost: entries.map(([, item]) => Number(item.cost.toFixed(2))),
    revenue: entries.map(([, item]) => Number(item.revenue.toFixed(2))),
  };
}

export function buildWorkLifeExpense(transactions: Transaction[], accounts: Account[]) {
  const ownership = accountOwnershipMap(accounts);
  const months = Array.from(new Set(transactions.map((tx) => tx.occurredAt.slice(0, 7)).filter(Boolean)))
    .sort()
    .slice(-12);

  const work = months.map((month) =>
    transactions
      .filter((tx) => tx.kind === "expense" && tx.occurredAt.startsWith(month))
      .filter((tx) => ownership[tx.fromAccountName || tx.accountName] === "company")
      .reduce((sum, tx) => sum + tx.amount, 0),
  );
  const life = months.map((month) =>
    transactions
      .filter((tx) => tx.kind === "expense" && tx.occurredAt.startsWith(month))
      .filter((tx) => ownership[tx.fromAccountName || tx.accountName] === "personal")
      .reduce((sum, tx) => sum + tx.amount, 0),
  );

  return {
    months: months.map((month) => month.replace("-", "/")),
    work,
    life,
  };
}

/** 1.8 现金流预测：从一条 recurring rule 的 nextDueAt 起，往后 days 天内会触发的所有日期。
 * 与后端 advance_due_date 等价。月/年用同日前进，月末取月末。 */
function generateRuleEvents(rule: RecurringRule, days: number): string[] {
  if (!rule.enabled) return [];
  const events: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + days);
  const endDate = rule.endDate ? new Date(`${rule.endDate}T23:59:59`) : null;

  let cursor = new Date(`${rule.nextDueAt}T00:00:00`);
  for (let i = 0; i < 365 && cursor <= horizon; i += 1) {
    if (endDate && cursor > endDate) break;
    if (cursor >= today) {
      events.push(cursor.toISOString().slice(0, 10));
    }
    cursor = advanceCursor(cursor, rule.frequency, rule.intervalN || 1);
  }
  return events;
}

function advanceCursor(date: Date, frequency: RecurringFrequency, n: number): Date {
  const next = new Date(date);
  if (frequency === "daily") next.setDate(next.getDate() + n);
  else if (frequency === "weekly") next.setDate(next.getDate() + 7 * n);
  else if (frequency === "monthly") {
    const day = next.getDate();
    next.setMonth(next.getMonth() + n, 1);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDay));
  } else if (frequency === "yearly") {
    const day = next.getDate();
    next.setFullYear(next.getFullYear() + n, next.getMonth(), 1);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDay));
  } else {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

export function forecastCashflow(rules: RecurringRule[], days: number) {
  const buckets = new Map<string, number>(); // date → daily net (income - expense)
  for (const rule of rules) {
    const tplAmount = Number((rule.template as { amount?: number } | undefined)?.amount) || 0;
    const tplKind = (rule.template as { kind?: string } | undefined)?.kind || "expense";
    const sign = tplKind === "income" ? 1 : tplKind === "expense" ? -1 : 0;
    if (sign === 0 || tplAmount <= 0) continue;
    for (const date of generateRuleEvents(rule, days)) {
      buckets.set(date, (buckets.get(date) || 0) + sign * tplAmount);
    }
  }
  // 输出按日期排序的累计净额
  const labels: string[] = [];
  const dailyNet: number[] = [];
  const cumulativeNet: number[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let acc = 0;
  for (let i = 0; i <= days; i += 1) {
    const day = new Date(today);
    day.setDate(day.getDate() + i);
    const key = day.toISOString().slice(0, 10);
    const net = buckets.get(key) || 0;
    acc += net;
    labels.push(key.slice(5)); // MM-DD
    dailyNet.push(Number(net.toFixed(2)));
    cumulativeNet.push(Number(acc.toFixed(2)));
  }
  return { labels, dailyNet, cumulativeNet };
}

export function recurringTotals(rules: RecurringRule[]) {
  let monthlyExpense = 0;
  let monthlyIncome = 0;
  const subscriptionList: Array<{ id: string; name: string; amount: number; kind: string; frequency: RecurringFrequency }> = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const tplAmount = Number((rule.template as { amount?: number } | undefined)?.amount) || 0;
    const tplKind = (rule.template as { kind?: string } | undefined)?.kind || "expense";
    if (tplAmount <= 0) continue;
    // 标准化为月化金额
    let monthly = 0;
    if (rule.frequency === "monthly") monthly = tplAmount / (rule.intervalN || 1);
    else if (rule.frequency === "weekly") monthly = (tplAmount * 4.345) / (rule.intervalN || 1);
    else if (rule.frequency === "daily") monthly = (tplAmount * 30.42) / (rule.intervalN || 1);
    else if (rule.frequency === "yearly") monthly = tplAmount / (12 * (rule.intervalN || 1));
    if (tplKind === "expense") monthlyExpense += monthly;
    else if (tplKind === "income") monthlyIncome += monthly;
    if (rule.frequency === "monthly" && tplKind === "expense") {
      subscriptionList.push({ id: rule.id, name: rule.name, amount: tplAmount, kind: tplKind, frequency: rule.frequency });
    }
  }
  subscriptionList.sort((a, b) => b.amount - a.amount);
  return {
    monthlyExpense: Number(monthlyExpense.toFixed(2)),
    monthlyIncome: Number(monthlyIncome.toFixed(2)),
    monthlyNet: Number((monthlyIncome - monthlyExpense).toFixed(2)),
    yearlyExpense: Number((monthlyExpense * 12).toFixed(2)),
    subscriptions: subscriptionList,
  };
}

/** P3-2.3 followup：按当前年/季度聚合 taxCategory 标记的交易，跑预估算法。 */
export function summarizeTax(
  transactions: Transaction[],
  taxConfig: TaxConfig | undefined,
  options: { year?: number; quarter?: number } = {},
) {
  const now = new Date();
  const year = options.year ?? now.getFullYear();
  const quarter = options.quarter ?? Math.floor(now.getMonth() / 3) + 1;
  const startMonth = (quarter - 1) * 3; // 0-indexed
  const endMonth = startMonth + 2;
  const inPeriod = (occurredAt: string) => {
    if (!occurredAt || occurredAt.length < 7) return false;
    const y = Number(occurredAt.slice(0, 4));
    const m = Number(occurredAt.slice(5, 7)) - 1;
    return y === year && m >= startMonth && m <= endMonth;
  };

  const filtered = transactions.filter((tx) => inPeriod(tx.occurredAt));
  const sumBy = (cat: string) =>
    filtered
      .filter((tx) => tx.taxCategory === cat)
      .reduce((sum, tx) => sum + tx.amount, 0);

  const businessIncome = sumBy("business-income");
  const deductible = sumBy("business-expense-deductible");
  const nondeductible = sumBy("business-expense-nondeductible");
  const profit = businessIncome - deductible;

  const vatRate = taxConfig?.vatRate ?? 0.03;
  const personalThreshold = taxConfig?.personalThreshold ?? 60000;
  const personalRate = taxConfig?.personalRate ?? 0.20;
  const sebRate = taxConfig?.sebRate ?? 0.10;

  // 起征点按年算，季度报表里只显示本季度收入，但应税利润仍按"超过年度起征点的部分"
  // 这里简化：假设年内累计已超起征点，按本季度净利润直接计税
  const vatEstimate = Math.max(businessIncome, 0) * vatRate;
  const taxableProfit = Math.max(profit - personalThreshold / 4, 0); // 季度均摊起征点
  const personalTaxEstimate = taxableProfit * personalRate;
  const sebEstimate = Math.max(profit, 0) * sebRate;

  return {
    year,
    quarter,
    label: `${year} Q${quarter}`,
    businessIncome: Number(businessIncome.toFixed(2)),
    deductible: Number(deductible.toFixed(2)),
    nondeductible: Number(nondeductible.toFixed(2)),
    profit: Number(profit.toFixed(2)),
    vatEstimate: Number(vatEstimate.toFixed(2)),
    taxableProfit: Number(taxableProfit.toFixed(2)),
    personalTaxEstimate: Number(personalTaxEstimate.toFixed(2)),
    sebEstimate: Number(sebEstimate.toFixed(2)),
    transactionCount: filtered.length,
  };
}

export function dailyGroups(transactions: Transaction[]) {
  const groups = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const day = tx.occurredAt.slice(0, 10) || "未知日期";
    groups.set(day, [...(groups.get(day) || []), tx]);
  }
  return Array.from(groups.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, items]) => ({
      date,
      items: items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
      summary: summarizeTransactions(items),
    }));
}
