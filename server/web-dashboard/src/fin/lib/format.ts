/**
 * HTML 转义 — 用户数据（账户名/商户/项目/分类名等）进入 ECharts tooltip 的
 * HTML 字符串前必须转义，否则构成存储型 XSS（可窃取 localStorage 里的 token）。
 * ECharts tooltip 默认以 innerHTML 渲染 formatter 返回值。
 */
const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}

/** 货币格式 — 永远写完整数字，不做缩位（财务克制原则）。 */
export function formatCurrency(value: number, opts: { withSign?: boolean } = {}): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const formatted = new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(abs);
  if (opts.withSign && value !== 0) {
    return `${value < 0 ? "−" : "+"}¥${formatted}`;
  }
  return `${value < 0 ? "−" : ""}¥${formatted}`;
}

/** 简短金额（用于卡片大数字，仍保留 2 位小数）。 */
export function formatCurrencyCompact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

/** 百分比 */
export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

/** 用于交易列表的相对日期 */
export function formatDate(iso: string): string {
  if (!iso) return "";
  const day = iso.slice(0, 10);
  return day;
}

export function formatDateTime(iso: string): string {
  if (!iso || iso.length < 16) return iso || "";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** ISO month "YYYY-MM" 转中文 */
export function formatMonth(monthKey: string): string {
  if (!monthKey || monthKey.length !== 7) return monthKey;
  const [year, month] = monthKey.split("-");
  return `${year}年 ${parseInt(month, 10)}月`;
}

export function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
