/**
 * [INPUT]: 依赖 Segment 的 startedUtc/endedUtc 真值、记录时区、UTC 当前瞬间与墙上当前分钟。
 * [OUTPUT]: 对外提供 24h 墙钟坐标、DST 感知 UTC 日界、真实时长/扣除分片、折叠片段保守投影、拖拽安全判定、超长软标记判定与文案、空白与日期序列纯函数。
 * [POS]: lib 的时间轴领域层；UTC 独占计时和扣除分配，墙钟只负责 0–1440 排版，DST 非单射日明确降级为不可拖拽，超长只提示不拒绝。
 *   午夜前跳的时区里 00:00 并不存在，此时日界二分降级到「当地这一天真正开始的那一瞬」而非抛错——
 *   本层被日/周视图在 render 期直接调用，抛错等于白屏。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import type { Gap, Segment } from "../types.ts";

const MINUTES_PER_DAY = 24 * 60;
const MAX_WALL_RESOLUTION_MINUTES = 3 * 60;
// 现实 IANA 偏移落在 −12:00…+14:00，取 15h 作为二分窗口的安全外边界。
const MAX_ZONE_OFFSET_MINUTES = 15 * 60;

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const dayBoundsCache = new Map<string, readonly [number, number]>();

export interface DayRange {
  start: string;
  end: string;
  elapsedMinutes: number;
}

export interface DaySlice {
  start: string;
  end: string;
  startMinute: number;
  endMinute: number;
  gross: number;
  pure: number;
  wallClockDiscontinuity: boolean;
}

export interface TimelineClock {
  timeZone: string;
  nowUtc: string;
}

export function epochMinute(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) throw new RangeError(`无效的墙上分钟：${value}`);
  const [, year, month, day, hour, minute] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  ) / 60_000;
}

export function formatEpochMinute(value: number): string {
  return new Date(value * 60_000).toISOString().slice(0, 16);
}

export function utcEpochMinute(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new RangeError(`无效的 UTC 分钟：${value}`);
  return Math.floor(milliseconds / 60_000);
}

export function formatUtcEpochMinute(value: number): string {
  return new Date(value * 60_000).toISOString();
}

function nextDay(day: string): string {
  return formatEpochMinute(epochMinute(`${day}T00:00`) + MINUTES_PER_DAY).slice(0, 10);
}

function resolvedTimeZone(timeZone: string): string {
  if (!timeZone || timeZone === "system") {
    throw new RangeError("时间轴必须使用服务端 resolvedTimezone，不能由浏览器解析 system。");
  }
  return timeZone;
}

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const resolved = resolvedTimeZone(timeZone);
  const cached = formatterCache.get(resolved);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolved,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(resolved, formatter);
  return formatter;
}

export function formatUtcMinuteInTimeZone(utcMinute: number, timeZone: string): string {
  const values: Record<string, string> = {};
  for (const part of zonedFormatter(timeZone).formatToParts(new Date(utcMinute * 60_000))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

// 前跳日的保守降级：取「墙上时间首次不早于目标」的最早 UTC 分钟。
// 墙钟在前跳时严格递增（只是跳过一段），谓词单调，二分必然收敛；
// 窗口两端都远在 ±15h 之外，左端恒 false、右端恒 true。
// 墙钟串是定宽 `YYYY-MM-DDTHH:MM`，字典序即时序，可直接比较。
function utcMinuteAtOrAfterWallMinute(value: string, timeZone: string): number {
  const target = epochMinute(value);
  let low = target - MAX_ZONE_OFFSET_MINUTES;
  let high = target + MAX_ZONE_OFFSET_MINUTES;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (formatUtcMinuteInTimeZone(middle, timeZone) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function utcMinuteForUniqueWallMinute(value: string, timeZone: string): number {
  const target = epochMinute(value);
  let candidate = target;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const projected = epochMinute(formatUtcMinuteInTimeZone(candidate, timeZone));
    const correction = target - projected;
    if (correction === 0) {
      // 午夜通常唯一；若历史时区恰在午夜回拨，取最早候选作为自然日左闭边界。
      let earliest = candidate;
      for (let delta = 1; delta <= MAX_WALL_RESOLUTION_MINUTES; delta += 1) {
        const earlier = candidate - delta;
        if (formatUtcMinuteInTimeZone(earlier, timeZone) === value) earliest = earlier;
      }
      return earliest;
    }
    candidate += correction;
  }
  // 迭代不收敛只有一种成因：这个墙上分钟在该时区根本不存在。
  // 午夜前跳的 IANA 区（America/Santiago、Asia/Beirut 等）会在切换日把 00:00 直接跳成 01:00，
  // 定点迭代于是在跳变两侧 ±60 分钟来回震荡。旧实现在此抛 RangeError，而调用它的
  // localDayAbsoluteMinutes / sliceSegmentForDay / deriveDayGaps 全在 render 期，
  // 一抛就把切换日与其前一日的整条时间轴连同页面一起打穿。
  // 保守降级：不存在的午夜取「这一自然日真正开始的那一瞬」（当地 01:00）作为左闭边界。
  // 该日绝对分钟数于是是真实的 1380 而非 1440，isWallClockEditSafe 照常判为不可拖拽——
  // 与本模块既有的 DST 只读降级同构，不新增第二套口径。
  return utcMinuteAtOrAfterWallMinute(value, timeZone);
}

function localDayUtcBounds(day: string, timeZone: string): readonly [number, number] {
  const resolved = resolvedTimeZone(timeZone);
  const key = `${resolved}:${day}`;
  const cached = dayBoundsCache.get(key);
  if (cached) return cached;
  const bounds = [
    utcMinuteForUniqueWallMinute(`${day}T00:00`, resolved),
    utcMinuteForUniqueWallMinute(`${nextDay(day)}T00:00`, resolved),
  ] as const;
  if (bounds[1] <= bounds[0]) throw new RangeError(`${day} 的记录时区日界无效。`);
  dayBoundsCache.set(key, bounds);
  return bounds;
}

export function localDayAbsoluteMinutes(day: string, timeZone: string): number {
  const [start, end] = localDayUtcBounds(day, timeZone);
  return end - start;
}

export function dayRange(day: string, nowMinute: string): DayRange {
  const start = `${day}T00:00`;
  const tomorrow = `${nextDay(day)}T00:00`;
  const today = nowMinute.slice(0, 10);

  if (day < today) return { start, end: tomorrow, elapsedMinutes: MINUTES_PER_DAY };
  if (day > today) return { start, end: start, elapsedMinutes: 0 };

  const elapsedMinutes = Math.max(
    0,
    Math.min(MINUTES_PER_DAY, epochMinute(nowMinute) - epochMinute(start)),
  );
  return {
    start,
    end: formatEpochMinute(epochMinute(start) + elapsedMinutes),
    elapsedMinutes,
  };
}

function roundedCumulativeDeduction(
  deductionMinutes: number,
  elapsedGross: number,
  totalGross: number,
): number {
  if (elapsedGross <= 0 || deductionMinutes <= 0) return 0;
  if (elapsedGross >= totalGross) return deductionMinutes;

  const numerator = deductionMinutes * elapsedGross;
  const quotient = Math.floor(numerator / totalGross);
  const remainder = numerator % totalGross;
  const doubledRemainder = remainder * 2;
  if (doubledRemainder < totalGross) return quotient;
  if (doubledRemainder > totalGross) return quotient + 1;
  return quotient % 2 === 0 ? quotient : quotient + 1;
}

export function sliceSegmentForDay(
  segment: Segment,
  day: string,
  nowMinute: string,
  clock: TimelineClock = { timeZone: "UTC", nowUtc: `${nowMinute}:00+00:00` },
): DaySlice | null {
  const range = dayRange(day, nowMinute);
  if (range.elapsedMinutes === 0) return null;

  const [dayStart, dayEnd] = localDayUtcBounds(day, clock.timeZone);
  const current = utcEpochMinute(clock.nowUtc);
  const visibleEnd = day < nowMinute.slice(0, 10)
    ? dayEnd
    : Math.max(dayStart, Math.min(dayEnd, current));
  const segmentStart = utcEpochMinute(segment.startedUtc);
  const segmentEnd = utcEpochMinute(segment.endedUtc ?? clock.nowUtc);
  const start = Math.max(segmentStart, dayStart);
  const end = Math.min(segmentEnd, visibleEnd);
  if (end <= start) return null;

  const gross = end - start;
  let deduction = 0;
  if (segment.endedAt && segment.deductionMinutes > 0) {
    const totalGross = segmentEnd - segmentStart;
    if (totalGross > 0) {
      const allocatedBefore = roundedCumulativeDeduction(
        segment.deductionMinutes,
        start - segmentStart,
        totalGross,
      );
      const allocatedThroughEnd = roundedCumulativeDeduction(
        segment.deductionMinutes,
        end - segmentStart,
        totalGross,
      );
      deduction = allocatedThroughEnd - allocatedBefore;
    }
  }

  const startWall = formatUtcMinuteInTimeZone(start, clock.timeZone);
  const endWall = formatUtcMinuteInTimeZone(end, clock.timeZone);
  const rawStartMinute = wallCoordinate(startWall, day);
  const rawEndMinute = wallCoordinate(endWall, day);
  const wallClockDiscontinuity = gross !== rawEndMinute - rawStartMinute;
  const [startMinute, endMinute] = rawEndMinute > rawStartMinute
    ? [rawStartMinute, rawEndMinute]
    : foldedWallEnvelope(rawStartMinute, rawEndMinute);

  return {
    start: startWall,
    end: endWall,
    startMinute,
    endMinute,
    gross,
    pure: gross - deduction,
    wallClockDiscontinuity,
  };
}

function wallCoordinate(value: string, day: string): number {
  const valueDay = value.slice(0, 10);
  if (valueDay < day) return 0;
  if (valueDay > day) return MINUTES_PER_DAY;
  return epochMinute(value) - epochMinute(`${day}T00:00`);
}

function foldedWallEnvelope(startMinute: number, endMinute: number): readonly [number, number] {
  const lower = Math.min(startMinute, endMinute);
  const upper = Math.max(startMinute, endMinute);
  const start = Math.max(0, Math.floor(lower / 60) * 60);
  const end = Math.min(
    MINUTES_PER_DAY,
    Math.max(start + 60, Math.ceil(upper / 60) * 60),
  );
  return [start, end];
}

export function segmentHasWallClockDiscontinuity(
  segment: Segment,
  nowMinute: string,
  nowUtc: string,
): boolean {
  const absoluteStart = utcEpochMinute(segment.startedUtc);
  const absoluteEnd = utcEpochMinute(segment.endedUtc ?? nowUtc);
  const wallStart = epochMinute(segment.startedAt);
  const wallEnd = epochMinute(segment.endedAt ?? nowMinute);
  return absoluteEnd - absoluteStart !== wallEnd - wallStart;
}

export function isWallClockEditSafe(
  segment: Segment,
  day: string,
  nowMinute: string,
  clock: TimelineClock,
): boolean {
  return localDayAbsoluteMinutes(day, clock.timeZone) === MINUTES_PER_DAY
    && !segmentHasWallClockDiscontinuity(segment, nowMinute, clock.nowUtc);
}

// 超长软标记的钦定文案；时间轴各处只提示不评判，文案在此定义一次，避免多处复制走样。
export const OVERLONG_SEGMENT_LABEL = "可疑 · 超长未闭合";

// 判定一个时段是否该挂超长软标记。
// 已闭合：直接采信服务端 overlong，毛分钟数与阈值的比较点唯一落在服务端 rules，前端不重算。
// 进行中：服务端投影恒为 false（毛分钟数尚未确定），只能由本层用配置阈值与已过分钟数补齐。
// 阈值缺失或非正数时进行中一律不标记——软标记宁可漏报，也不能凭猜测评判用户的记录。
export function isSegmentOverlong(
  segment: Segment,
  overlongMinutes: number | null,
  nowUtc: string,
): boolean {
  if (segment.endedUtc) return segment.overlong === true;
  if (overlongMinutes === null || !Number.isFinite(overlongMinutes) || overlongMinutes <= 0) {
    return false;
  }
  return utcEpochMinute(nowUtc) - utcEpochMinute(segment.startedUtc) > overlongMinutes;
}

export function toGap(day: string, start: number, end: number): Gap {
  const dayStart = epochMinute(`${day}T00:00`);
  return {
    start: formatEpochMinute(dayStart + start),
    end: formatEpochMinute(dayStart + end),
    minutes: end - start,
  };
}

export function deriveDayGaps(
  segments: Segment[],
  day: string,
  nowMinute: string,
  clock: TimelineClock = { timeZone: "UTC", nowUtc: `${nowMinute}:00+00:00` },
): Gap[] {
  const { elapsedMinutes } = dayRange(day, nowMinute);
  if (elapsedMinutes === 0) return [];

  const intervals = segments
    .map((segment) => sliceSegmentForDay(segment, day, nowMinute, clock))
    .filter((slice): slice is DaySlice => slice !== null)
    .map(({ startMinute, endMinute }) => [
      Math.max(0, startMinute),
      Math.min(elapsedMinutes, endMinute),
    ] as const)
    .filter(([start, end]) => start < end)
    .sort(([left], [right]) => left - right);

  const gaps: Gap[] = [];
  let cursor = 0;
  for (const [start, end] of intervals) {
    if (cursor < start) gaps.push(toGap(day, cursor, start));
    cursor = Math.max(cursor, end);
  }
  if (cursor < elapsedMinutes) gaps.push(toGap(day, cursor, elapsedMinutes));
  return gaps;
}

export function daysInRange(from: string, to: string): string[] {
  const start = epochMinute(`${from}T00:00`);
  const end = epochMinute(`${to}T00:00`);
  if (end < start) return [];

  const days: string[] = [];
  for (let cursor = start; cursor <= end; cursor += MINUTES_PER_DAY) {
    days.push(formatEpochMinute(cursor).slice(0, 10));
  }
  return days;
}
