/**
 * [INPUT]: 依赖 Date/Intl 与 timezone/source/非空 resolvedTimezone/nullable currentSystemTimezone 双时区契约。
 * [OUTPUT]: 对外提供拒绝浏览器猜测的投影时区、仅候选可用时的 system 漂移 blank→blank 迁移判定、墙钟日期边界与统计筛选状态机。
 * [POS]: web-dashboard 的时间状态边界；resolvedTimezone 独占日期投影，nullable currentSystemTimezone 只参与用户显式迁移判断。
 *   本模块的 Date 一律是「墙钟载体」：年月日时分被放进 UTC 槽位，只许经 getUTC* 读回，它不代表绝对时刻。
 *   载体曾经建在浏览器本地时区上——而本地时区处在 DST 缺失小时时，那个墙钟值在本地根本不可表示，
 *   `new Date(y, m, d, h, ...)` 自动前跳一小时，isoMinute 读回的业务分钟整体晚 60 分钟：
 *   当前时刻线画错位置、日界判断跟着漂、blankDraft 预填的起止会被服务端 future_timestamp 拒绝。
 *   日历原语（addDays/rangeForWeek/rangeForMonth）因此也一并落在 UTC 槽位——与 isoDate 同一个读回口径，
 *   混用即错位。契约：同一份输入在任何浏览器时区下必须给出同一答案。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export function healthRecordTimeZone(
  timeZone: string,
  source: "system" | "config",
  resolvedTimeZone: string,
): string {
  const selected = source === "config" ? timeZone : resolvedTimeZone;
  if (!selected) throw new RangeError("服务端没有提供可用的 resolvedTimezone。");
  return selected;
}

export function recordTimeZoneSelectionChanged(
  draft: string,
  configuration: {
    timezone: string;
    timezoneSource: "system" | "config";
    resolvedTimezone: string;
    currentSystemTimezone: string | null;
  },
): boolean {
  const configured = configuration.timezoneSource === "config" ? configuration.timezone : "";
  if (draft !== configured) return true;
  return configuration.timezoneSource === "system"
    && draft === ""
    && configuration.currentSystemTimezone !== null
    && configuration.resolvedTimezone !== configuration.currentSystemTimezone;
}

export function recordNow(timeZone: string, instant: Date = new Date()): Date {
  const values: Record<string, number> = {};
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  // 墙钟分量装进 UTC 槽位：本地时区的 DST 缺失小时不在这条路径上，投影因此与浏览器时区无关。
  return new Date(Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second,
  ));
}

/**
 * 墙钟载体上的分钟加减。
 *
 * 载体的年月日时分住在 UTC 槽位，因此加减也必须走 getUTC 与 setUTC 一族。
 * 调用方若顺手用本地的 setMinutes/getMinutes，浏览器会先把载体的 epoch 按本机时区
 * 渲染一遍再做算术：当渲染结果恰好落在春季前跳后的那一小时里，
 * 「减 60 分钟」指向的本地时刻根本不存在，JS 自动前跳，净位移为 0——
 * blankDraft 的「一小时前」于是塌成零长度草稿。算术收在本模块，调用方就不必记住槽位。
 */
export function shiftMinutes(carrier: Date, amount: number): Date {
  const moved = new Date(carrier);
  moved.setUTCMinutes(moved.getUTCMinutes() + amount);
  return moved;
}


export function isoDate(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isoMinute(value: Date): string {
  return `${isoDate(value)}T${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}`;
}

export function addDays(day: string, amount: number): string {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return isoDate(value);
}

export function minuteOfDay(value: string): number {
  const [, time = "00:00"] = value.split("T");
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

export function rangeForWeek(day: string, weekStart: "monday" | "sunday"): [string, string] {
  const value = new Date(`${day}T12:00:00Z`);
  const weekday = value.getUTCDay();
  const delta = weekStart === "monday" ? (weekday + 6) % 7 : weekday;
  return [addDays(day, -delta), addDays(day, 6 - delta)];
}

export function rangeForMonth(day: string): [string, string] {
  const value = new Date(`${day}T12:00:00Z`);
  const start = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1, 12));
  const end = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0, 12));
  return [isoDate(start), isoDate(end)];
}

export type StatsMode = "today" | "week" | "month" | "custom";
export type DateRange = readonly [string, string];

export interface StatsSelection {
  mode: StatsMode;
  range: DateRange;
}

export function rangeForStatsMode(
  mode: StatsMode,
  today: string,
  weekStart: "monday" | "sunday",
  currentRange: DateRange,
): DateRange {
  if (mode === "today") return [today, today];
  if (mode === "week") return rangeForWeek(today, weekStart);
  if (mode === "month") return [rangeForMonth(today)[0], today];
  return currentRange;
}

export function selectStatsMode(
  mode: StatsMode,
  today: string,
  weekStart: "monday" | "sunday",
  currentRange: DateRange,
): StatsSelection {
  return { mode, range: rangeForStatsMode(mode, today, weekStart, currentRange) };
}
