/**
 * [INPUT]: 依赖 store/timeRange 的 TimeDimension 与 types 的 Transaction（均为类型导入，无运行时耦合）。
 * [OUTPUT]: 对外提供区间键编解码（currentBucket/bucketOf/rangeBucket/parseRangeBucket）、
 *   区间边界与文案（rangeBounds/rangeLabel/labelForBucket/DIMENSION_LABEL）、
 *   流水归属判定（transactionMatchesRange/deriveBuckets）与日期原语（parseDay/isoDay/startOfDay/isoWeek/isoWeekYear）。
 * [POS]: fin/lib 的时间区间真源；区间以「不透明字符串键」在 store、URL 与筛选之间流转，
 *   页面只认键不认 Date，边界解释权全部收在本文件，避免各页面私算月末与周起点。
 *   全部按浏览器本地日历计算——财务只关心自然日，不引入记录时区口径。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { TimeDimension } from "../store/timeRange";
import type { Transaction } from "../types";

export const DIMENSION_LABEL: Record<TimeDimension, string> = {
  year: "年",
  quarter: "季度",
  month: "月",
  week: "周",
  custom: "自定义区间",
  all: "全部",
};

export function currentBucket(dim: TimeDimension, ref = new Date()): string {
  switch (dim) {
    case "year":
      return String(ref.getFullYear());
    case "quarter":
      return `${ref.getFullYear()}-Q${Math.ceil((ref.getMonth() + 1) / 3)}`;
    case "month":
      return monthKey(ref);
    case "week":
      // 周桶键必须用 ISO 周年份而非自然年：跨年那几天两者不同，
      // 混用会把 2025-12-29 编成 2025-W01，再解回 2024-12-30 那一周。
      return `${isoWeekYear(ref)}-W${String(isoWeek(ref)).padStart(2, "0")}`;
    case "custom":
      return rangeBucket(ref, ref);
    default:
      return "";
  }
}

export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function bucketOf(occurredAt: string, dim: TimeDimension): string {
  if (!occurredAt || occurredAt.length < 10) return "";
  const d = new Date(occurredAt);
  if (Number.isNaN(d.getTime())) return "";
  return currentBucket(dim, d);
}

export function deriveBuckets(
  transactions: Transaction[],
  dim: TimeDimension,
): Array<{ value: string; label: string }> {
  if (dim === "all" || dim === "custom") return [];
  const set = new Set<string>();
  for (const tx of transactions) {
    const key = bucketOf(tx.occurredAt, dim);
    if (key) set.add(key);
  }
  return Array.from(set)
    .sort()
    .reverse()
    .map((value) => ({ value, label: labelForBucket(dim, value) }));
}

export function labelForBucket(dim: TimeDimension, key: string): string {
  switch (dim) {
    case "year":
      return `${key} 年`;
    case "quarter": {
      const [year, quarter] = key.split("-Q");
      return `${year} 年第 ${quarter} 季度`;
    }
    case "month": {
      const [year, month] = key.split("-");
      return `${year} 年 ${Number(month)} 月`;
    }
    case "week": {
      const [year, week] = key.split("-W");
      return `${year} 年第 ${Number(week)} 周`;
    }
    case "custom": {
      const { from, to } = parseRangeBucket(key);
      if (!from || !to) return "自定义区间";
      return `${formatDateDots(from)} - ${formatDateDots(to)}`;
    }
    default:
      return "全部时间";
  }
}

export function transactionMatchesRange(
  tx: Transaction,
  dim: TimeDimension,
  bucket: string,
): boolean {
  if (dim === "all" || !bucket) return true;
  if (dim === "custom") {
    const day = parseDay(tx.occurredAt);
    const { from, to } = parseRangeBucket(bucket);
    if (!day || !from || !to) return true;
    return day.getTime() >= startOfDay(from).getTime() && day.getTime() <= startOfDay(to).getTime();
  }
  return bucketOf(tx.occurredAt, dim) === bucket;
}

export function rangeBounds(
  dim: TimeDimension,
  bucket: string,
  transactions: Transaction[] = [],
): { from?: Date; to?: Date } {
  if (dim === "all") {
    const dates = transactions
      .map((tx) => parseDay(tx.occurredAt))
      .filter((date): date is Date => Boolean(date))
      .sort((a, b) => a.getTime() - b.getTime());
    return { from: dates[0], to: dates[dates.length - 1] };
  }

  if (!bucket) return {};

  if (dim === "custom") {
    return parseRangeBucket(bucket);
  }

  if (dim === "year") {
    const year = Number(bucket);
    return {
      from: new Date(year, 0, 1),
      to: new Date(year, 11, 31),
    };
  }

  if (dim === "quarter") {
    const [yearText, quarterText] = bucket.split("-Q");
    const year = Number(yearText);
    const quarter = Number(quarterText);
    const startMonth = (quarter - 1) * 3;
    return {
      from: new Date(year, startMonth, 1),
      to: new Date(year, startMonth + 3, 0),
    };
  }

  if (dim === "month") {
    const [yearText, monthText] = bucket.split("-");
    const year = Number(yearText);
    const month = Number(monthText) - 1;
    return {
      from: new Date(year, month, 1),
      to: new Date(year, month + 1, 0),
    };
  }

  if (dim === "week") {
    const [yearText, weekText] = bucket.split("-W");
    const year = Number(yearText);
    const week = Number(weekText);
    const from = isoWeekStart(year, week);
    const to = new Date(from);
    to.setDate(from.getDate() + 6);
    return { from, to };
  }

  return {};
}

export function rangeLabel(
  dim: TimeDimension,
  bucket: string,
  transactions: Transaction[] = [],
): string {
  const { from, to } = rangeBounds(dim, bucket, transactions);
  if (!from || !to) return dim === "all" ? "全部时间" : labelForBucket(dim, bucket);
  return `${formatDateDots(from)} - ${formatDateDots(to)}`;
}

export function formatDateDots(date: Date): string {
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

export function parseDay(iso: string): Date | null {
  if (!iso || iso.length < 10) return null;
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

export function rangeBucket(from: Date, to: Date): string {
  const start = startOfDay(from);
  const end = startOfDay(to);
  const [a, b] = start.getTime() <= end.getTime() ? [start, end] : [end, start];
  return `${isoDay(a)}..${isoDay(b)}`;
}

export function parseRangeBucket(bucket: string): { from?: Date; to?: Date } {
  const [fromText, toText] = bucket.split("..");
  const from = parseDay(fromText || "");
  const to = parseDay(toText || fromText || "");
  if (!from || !to) return {};
  return from.getTime() <= to.getTime() ? { from, to } : { from: to, to: from };
}

export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** ISO 周的归属由该周的周四决定；周号与周年份必须取自同一个周四。 */
function isoThursday(date: Date): Date {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return d;
}

export function isoWeek(date: Date): number {
  const thursday = isoThursday(date);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** ISO 周年份，跨年那几天与自然年不同：2025-12-29 属于 ISO 2026 年第 1 周。 */
export function isoWeekYear(date: Date): number {
  return isoThursday(date).getUTCFullYear();
}

function isoWeekStart(year: number, week: number): Date {
  const jan4 = new Date(year, 0, 4);
  const jan4Day = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - jan4Day + 1 + (week - 1) * 7);
  return monday;
}
