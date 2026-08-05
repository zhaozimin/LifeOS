/**
 * [INPUT]: 依赖调用方提供的整数分钟区间、缩放级别、可编辑边界与相邻时段边界。
 * [OUTPUT]: 对外提供五级缩放真源、表现层整屏解析、分钟吸附、边缘调时长、整段平移和半开区间冲突检测纯函数。
 * [POS]: lib 的时间轴交互领域层；整屏只解析实际几何而不污染五级领域数组，手势统一收敛到整数分钟约束。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export type TimelineZoomId = "60m" | "30m" | "10m" | "5m" | "1m";
export const TIMELINE_FIT_ZOOM_ID = "fit";
export type TimelineZoomSelection = typeof TIMELINE_FIT_ZOOM_ID | TimelineZoomId;
export type TimelineGridMinutes = 60 | 30 | 10 | 5 | 1;
export type SegmentEdge = "start" | "end";

export interface TimelineZoomLevel {
  readonly id: TimelineZoomId;
  readonly gridMinutes: TimelineGridMinutes;
  readonly pixelsPerMinute: number;
  readonly snapMinutes: number;
  readonly label: string;
}

export interface MinuteRange {
  readonly start: number;
  readonly end: number;
}

export interface TimelineEditConstraints {
  readonly dayBounds?: MinuteRange;
  readonly previousEnd?: number | null;
  readonly nextStart?: number | null;
  readonly snapMinutes?: number;
  readonly minDurationMinutes?: number;
}

export type SegmentMovement =
  | { readonly deltaMinutes: number; readonly targetStart?: never }
  | { readonly targetStart: number; readonly deltaMinutes?: never };

export type TimelineConflict =
  | "non-integer"
  | "invalid-range"
  | "shorter-than-minimum"
  | "before-day"
  | "after-day"
  | "overlaps-previous"
  | "overlaps-next";

export const TIMELINE_DAY_BOUNDS: MinuteRange = Object.freeze({
  start: 0,
  end: 24 * 60,
});

/**
 * 前四级保持每格 48px；分钟级压到 24px，既保留单分钟可操作性，
 * 又避免整日画布在最高倍率下无意义地翻倍。
 */
export const TIMELINE_ZOOM_LEVELS: readonly TimelineZoomLevel[] = Object.freeze([
  { id: "60m", gridMinutes: 60, pixelsPerMinute: 0.8, snapMinutes: 15, label: "60 分钟" },
  { id: "30m", gridMinutes: 30, pixelsPerMinute: 1.6, snapMinutes: 10, label: "30 分钟" },
  { id: "10m", gridMinutes: 10, pixelsPerMinute: 4.8, snapMinutes: 5, label: "10 分钟" },
  { id: "5m", gridMinutes: 5, pixelsPerMinute: 9.6, snapMinutes: 1, label: "5 分钟" },
  { id: "1m", gridMinutes: 1, pixelsPerMinute: 24, snapMinutes: 1, label: "1 分钟" },
]);

/** 整屏档的可读性下限；小于它时宁可保留滚动，也不压碎刻度。 */
export const TIMELINE_FIT_MIN_PPM = 0.25;

export function resolveTimelineZoom(
  selection: TimelineZoomSelection,
  viewportHeight: number | null,
): TimelineZoomLevel {
  if (selection !== TIMELINE_FIT_ZOOM_ID) return getTimelineZoomLevel(selection);
  const base = getTimelineZoomLevel("60m");
  if (!viewportHeight || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return base;
  const pixelsPerMinute = Math.max(
    Math.floor(viewportHeight) / (24 * 60),
    TIMELINE_FIT_MIN_PPM,
  );
  return { ...base, pixelsPerMinute, label: "整屏" };
}

export function getTimelineZoomLevel(id: TimelineZoomId): TimelineZoomLevel {
  const level = TIMELINE_ZOOM_LEVELS.find((candidate) => candidate.id === id);
  if (!level) throw new RangeError(`未知的时间轴缩放级别：${id}`);
  return level;
}

export function visibleMinutesForHeight(
  viewportHeight: number,
  pixelsPerMinute: number,
): number {
  assertFinitePositive(viewportHeight, "视口高度");
  assertFinitePositive(pixelsPerMinute, "每分钟像素");
  return viewportHeight / pixelsPerMinute;
}

export function snapMinute(
  minute: number,
  snapMinutes: number,
  anchorMinute = 0,
): number {
  assertFinite(minute, "目标分钟");
  assertPositiveInteger(snapMinutes, "吸附分钟");
  assertInteger(anchorMinute, "吸附锚点");
  return anchorMinute + Math.round((minute - anchorMinute) / snapMinutes) * snapMinutes;
}

export function getSegmentConflict(
  segment: MinuteRange,
  constraints: TimelineEditConstraints = {},
): TimelineConflict | null {
  const { dayBounds, previousEnd, nextStart, minDurationMinutes } =
    normalizeConstraints(constraints);

  if (!Number.isInteger(segment.start) || !Number.isInteger(segment.end)) {
    return "non-integer";
  }
  if (segment.end <= segment.start) return "invalid-range";
  if (segment.end - segment.start < minDurationMinutes) return "shorter-than-minimum";
  if (segment.start < dayBounds.start) return "before-day";
  if (segment.end > dayBounds.end) return "after-day";
  if (previousEnd !== null && segment.start < previousEnd) return "overlaps-previous";
  if (nextStart !== null && segment.end > nextStart) return "overlaps-next";
  return null;
}

export function adjustSegmentEdge(
  segment: MinuteRange,
  edge: SegmentEdge,
  targetMinute: number,
  constraints: TimelineEditConstraints = {},
): MinuteRange {
  assertSegment(segment);
  const normalized = normalizeConstraints(constraints);
  const window = editWindow(normalized);
  const snappedTarget = snapMinute(
    targetMinute,
    normalized.snapMinutes,
    normalized.dayBounds.start,
  );

  if (edge === "start") {
    if (segment.end > window.end) {
      throw new RangeError("固定结束时间已经越过日界或后一时段。");
    }
    const latestStart = segment.end - normalized.minDurationMinutes;
    if (latestStart < window.start) {
      throw new RangeError("相邻时段之间没有足够空间调整开始时间。");
    }
    return {
      start: clamp(snappedTarget, window.start, latestStart),
      end: segment.end,
    };
  }

  if (edge === "end") {
    if (segment.start < window.start) {
      throw new RangeError("固定开始时间已经越过日界或前一时段。");
    }
    const earliestEnd = segment.start + normalized.minDurationMinutes;
    if (earliestEnd > window.end) {
      throw new RangeError("相邻时段之间没有足够空间调整结束时间。");
    }
    return {
      start: segment.start,
      end: clamp(snappedTarget, earliestEnd, window.end),
    };
  }

  throw new RangeError(`未知的时段边缘：${edge satisfies never}`);
}

export function moveSegment(
  segment: MinuteRange,
  movement: SegmentMovement,
  constraints: TimelineEditConstraints = {},
): MinuteRange {
  assertSegment(segment);
  const normalized = normalizeConstraints(constraints);
  const window = editWindow(normalized);
  const duration = segment.end - segment.start;
  const latestStart = window.end - duration;
  if (latestStart < window.start) {
    throw new RangeError("日界或相邻时段之间没有足够空间容纳当前时长。");
  }

  const deltaMinutes = movement.deltaMinutes;
  const targetStart = movement.targetStart;
  const hasDelta = deltaMinutes !== undefined;
  const hasTarget = targetStart !== undefined;
  if (hasDelta === hasTarget) {
    throw new TypeError("整体移动必须且只能提供 deltaMinutes 或 targetStart。");
  }

  let requestedStart: number;
  if (deltaMinutes !== undefined) {
    assertFinite(deltaMinutes, "移动分钟差");
    requestedStart = segment.start + snapMinute(deltaMinutes, normalized.snapMinutes);
  } else {
    if (targetStart === undefined) {
      throw new TypeError("整体移动缺少目标分钟。");
    }
    assertFinite(targetStart, "目标开始分钟");
    requestedStart = snapMinute(
      targetStart,
      normalized.snapMinutes,
      normalized.dayBounds.start,
    );
  }

  const start = clamp(requestedStart, window.start, latestStart);
  return { start, end: start + duration };
}

interface NormalizedConstraints {
  dayBounds: MinuteRange;
  previousEnd: number | null;
  nextStart: number | null;
  snapMinutes: number;
  minDurationMinutes: number;
}

function normalizeConstraints(
  constraints: TimelineEditConstraints,
): NormalizedConstraints {
  const dayBounds = constraints.dayBounds ?? TIMELINE_DAY_BOUNDS;
  assertSegment(dayBounds, "日界");

  const previousEnd = constraints.previousEnd ?? null;
  const nextStart = constraints.nextStart ?? null;
  if (previousEnd !== null) assertInteger(previousEnd, "前一时段结束分钟");
  if (nextStart !== null) assertInteger(nextStart, "后一时段开始分钟");

  const snapMinutes = constraints.snapMinutes ?? 1;
  const minDurationMinutes = constraints.minDurationMinutes ?? 1;
  assertPositiveInteger(snapMinutes, "吸附分钟");
  assertPositiveInteger(minDurationMinutes, "最短时长");

  return {
    dayBounds,
    previousEnd,
    nextStart,
    snapMinutes,
    minDurationMinutes,
  };
}

function editWindow(constraints: NormalizedConstraints): MinuteRange {
  const start = Math.max(
    constraints.dayBounds.start,
    constraints.previousEnd ?? constraints.dayBounds.start,
  );
  const end = Math.min(
    constraints.dayBounds.end,
    constraints.nextStart ?? constraints.dayBounds.end,
  );
  if (end < start) {
    throw new RangeError("前后相邻时段边界互相倒置。");
  }
  return { start, end };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function assertSegment(segment: MinuteRange, label = "时段"): void {
  assertInteger(segment.start, `${label}开始分钟`);
  assertInteger(segment.end, `${label}结束分钟`);
  if (segment.end <= segment.start) {
    throw new RangeError(`${label}结束分钟必须严格晚于开始分钟。`);
  }
}

function assertInteger(value: number, label: string): void {
  assertFinite(value, label);
  if (!Number.isInteger(value)) throw new RangeError(`${label}必须是整数。`);
}

function assertPositiveInteger(value: number, label: string): void {
  assertInteger(value, label);
  if (value <= 0) throw new RangeError(`${label}必须大于 0。`);
}

function assertFinitePositive(value: number, label: string): void {
  assertFinite(value, label);
  if (value <= 0) throw new RangeError(`${label}必须大于 0。`);
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label}必须是有限数字。`);
}
