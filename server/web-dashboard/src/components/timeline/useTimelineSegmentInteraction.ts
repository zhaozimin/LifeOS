/**
 * [INPUT]: 依赖 React Pointer Events、完整 Segment 账本、记录时区墙钟与 UTC 当前瞬间、DST 拖拽安全判定、缩放几何、区间纯函数和一次性 PUT 回调。
 * [OUTPUT]: 对外提供普通日的单选、长按平移、端点/键盘调整与 UTC 同步预览；DST 非单射日只保留双击设置并停用直接调时。
 * [POS]: components/timeline 的手势状态机；先由 UTC/墙钟领域层裁定是否可编辑，再把安全的 DOM 输入收敛为一次最小字段写入。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  ButtonHTMLAttributes,
  KeyboardEvent,
  PointerEvent,
  RefObject,
} from "react";
import type { Segment } from "../../types";
import {
  TIMELINE_LONG_PRESS_MS,
  TIMELINE_PRESS_CANCEL_DISTANCE_PX,
} from "../ui/TimelineCanvas";
import {
  epochMinute,
  formatEpochMinute,
  formatUtcEpochMinute,
  isWallClockEditSafe,
  utcEpochMinute,
} from "../../lib/timeline";
import { adjustSegmentEdge, moveSegment } from "../../lib/timelineInteraction";
import type {
  MinuteRange,
  SegmentEdge,
  TimelineEditConstraints,
} from "../../lib/timelineInteraction";

const MAX_SEGMENT_MINUTES = 24 * 60;

type GestureMode = "pressing" | "moving" | "resizing-start" | "resizing-end" | "committing";

type VisualState = {
  segmentId: string;
  mode: GestureMode;
};

type Preview = {
  segmentId: string;
  range: MinuteRange;
};

type BaseGesture = {
  segment: Segment;
  original: MinuteRange;
  pointerId: number;
  originClientX: number;
  originClientY: number;
  originMinute: number;
  target: HTMLButtonElement;
};

type PendingGesture = BaseGesture & {
  kind: "pending";
  timer: number;
};

type MovingGesture = BaseGesture & {
  kind: "moving";
  constraints: TimelineEditConstraints;
};

type ResizingGesture = BaseGesture & {
  kind: "resizing";
  edge: SegmentEdge;
  edgeOffset: number;
  constraints: TimelineEditConstraints;
};

type Gesture = PendingGesture | MovingGesture | ResizingGesture;
type PointerBinding = Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  | "onClick"
  | "onDoubleClick"
  | "onKeyDown"
  | "onPointerDown"
  | "onPointerMove"
  | "onPointerUp"
  | "onPointerCancel"
  | "onLostPointerCapture"
  | "onContextMenu"
  | "onPointerEnter"
  | "onFocus"
>;

export interface TimelineSegmentAvailability {
  canMove: boolean;
  canResizeStart: boolean;
  canResizeEnd: boolean;
}

export interface TimelineSegmentVisualState extends TimelineSegmentAvailability {
  selected: boolean;
  pressing: boolean;
  moving: boolean;
  resizing: boolean;
  committing: boolean;
}

export interface TimelineResizeBinding extends PointerBinding {
  role: "separator";
  tabIndex: number;
  "aria-orientation": "horizontal";
  "aria-label": string;
  "aria-valuetext": string;
}

export function useTimelineSegmentInteraction({
  day,
  nowMinute,
  nowUtc,
  recordTimeZone,
  allSegments,
  pixelsPerMinute,
  snapMinutes,
  viewportRef,
  onEdit,
  onTimeChange,
}: {
  day: string;
  nowMinute: string;
  nowUtc: string;
  recordTimeZone: string;
  allSegments: Segment[];
  pixelsPerMinute: number;
  snapMinutes: number;
  viewportRef: RefObject<HTMLDivElement | null>;
  onEdit: (segment: Segment) => void;
  onTimeChange: (
    segment: Segment,
    changes: { startedAt?: string; endedAt?: string },
  ) => Promise<Segment>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visual, setVisual] = useState<VisualState | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const gestureRef = useRef<Gesture | null>(null);
  const previewRef = useRef<Preview | null>(null);
  const suppressClickUntilRef = useRef(0);
  const dayStart = epochMinute(`${day}T00:00`);
  const dayEnd = dayStart + MAX_SEGMENT_MINUTES;
  const now = epochMinute(nowMinute);
  const today = nowMinute.slice(0, 10);

  const minuteAtClientY = useCallback((clientY: number): number => {
    const viewport = viewportRef.current;
    if (!viewport) return 0;
    const rect = viewport.getBoundingClientRect();
    return (clientY - rect.top + viewport.scrollTop) / pixelsPerMinute;
  }, [pixelsPerMinute, viewportRef]);

  const clearGesture = useCallback((message?: string) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (gesture?.kind === "pending") window.clearTimeout(gesture.timer);
    try {
      if (gesture && gesture.target.hasPointerCapture(gesture.pointerId)) {
        gesture.target.releasePointerCapture(gesture.pointerId);
      }
    } catch {
      // DOM 已卸载时无需再释放指针捕获。
    }
    previewRef.current = null;
    setPreview(null);
    setVisual(null);
    if (message) setAnnouncement(message);
  }, []);

  useEffect(() => {
    clearGesture();
  }, [clearGesture, day, pixelsPerMinute, snapMinutes]);

  useEffect(() => {
    const cancelPendingOnGlobalPointerMove = (event: globalThis.PointerEvent) => {
      const gesture = gestureRef.current;
      if (gesture?.kind !== "pending" || gesture.pointerId !== event.pointerId) return;
      const distance = Math.hypot(
        event.clientX - gesture.originClientX,
        event.clientY - gesture.originClientY,
      );
      if (distance > TIMELINE_PRESS_CANCEL_DISTANCE_PX) clearGesture();
    };
    const cancelPendingOnGlobalPointerUp = () => {
      if (gestureRef.current?.kind === "pending") clearGesture();
    };
    const cancelOnPointerFailure = () => {
      if (gestureRef.current) clearGesture("调整已取消。");
    };
    const cancelOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !gestureRef.current) return;
      event.preventDefault();
      clearGesture("调整已取消。");
    };
    const blockTouchScrollWhileEditing = (event: TouchEvent) => {
      const kind = gestureRef.current?.kind;
      if (kind === "moving" || kind === "resizing") event.preventDefault();
    };
    window.addEventListener("pointermove", cancelPendingOnGlobalPointerMove);
    window.addEventListener("pointerup", cancelPendingOnGlobalPointerUp);
    window.addEventListener("pointercancel", cancelOnPointerFailure);
    window.addEventListener("blur", cancelOnPointerFailure);
    window.addEventListener("keydown", cancelOnEscape);
    document.addEventListener("touchmove", blockTouchScrollWhileEditing, { passive: false });
    return () => {
      window.removeEventListener("pointermove", cancelPendingOnGlobalPointerMove);
      window.removeEventListener("pointerup", cancelPendingOnGlobalPointerUp);
      window.removeEventListener("pointercancel", cancelOnPointerFailure);
      window.removeEventListener("blur", cancelOnPointerFailure);
      window.removeEventListener("keydown", cancelOnEscape);
      document.removeEventListener("touchmove", blockTouchScrollWhileEditing);
      clearGesture();
    };
  }, [clearGesture]);

  const fullRange = useCallback((segment: Segment): MinuteRange => ({
    start: epochMinute(segment.startedAt),
    end: epochMinute(segment.endedAt ?? nowMinute),
  }), [nowMinute]);

  const neighbors = useCallback((segment: Segment, range: MinuteRange) => {
    let previousEnd: number | null = null;
    let nextStart: number | null = null;
    for (const other of allSegments) {
      if (other.id === segment.id || other.deletedAt) continue;
      const otherStart = epochMinute(other.startedAt);
      const otherEnd = epochMinute(other.endedAt ?? nowMinute);
      if (otherEnd <= range.start && (previousEnd === null || otherEnd > previousEnd)) {
        previousEnd = otherEnd;
      }
      if (otherStart >= range.end && (nextStart === null || otherStart < nextStart)) {
        nextStart = otherStart;
      }
    }
    return { previousEnd, nextStart };
  }, [allSegments, nowMinute]);

  const availability = useCallback((segment: Segment): TimelineSegmentAvailability => {
    if (!isWallClockEditSafe(segment, day, nowMinute, {
      timeZone: recordTimeZone,
      nowUtc,
    })) {
      return { canMove: false, canResizeStart: false, canResizeEnd: false };
    }
    const startsHere = segment.startedAt.slice(0, 10) === day;
    const endsInsideDay = segment.endedAt?.slice(0, 10) === day;
    const endsAtDayBoundary = segment.endedAt
      ? epochMinute(segment.endedAt) === dayEnd
      : false;
    const editableDay = day <= today;
    return {
      canMove: editableDay && !!segment.endedAt && startsHere && endsInsideDay,
      canResizeStart: editableDay && startsHere,
      canResizeEnd: editableDay && !!segment.endedAt
        && (!!endsInsideDay || endsAtDayBoundary),
    };
  }, [day, dayEnd, nowMinute, nowUtc, recordTimeZone, today]);

  const moveConstraints = useCallback((
    segment: Segment,
    range: MinuteRange,
  ): TimelineEditConstraints => {
    const neighbor = neighbors(segment, range);
    return {
      dayBounds: {
        start: dayStart,
        end: day === today ? Math.min(dayEnd, now) : dayEnd,
      },
      previousEnd: neighbor.previousEnd,
      nextStart: neighbor.nextStart,
      snapMinutes,
      minDurationMinutes: Math.max(1, segment.deductionMinutes),
    };
  }, [day, dayEnd, dayStart, neighbors, now, snapMinutes, today]);

  const resizeConstraints = useCallback((
    segment: Segment,
    range: MinuteRange,
  ): TimelineEditConstraints => {
    const neighbor = neighbors(segment, range);
    const visibleEnd = day === today ? Math.min(dayEnd, now) : dayEnd;
    const bounds = {
      start: Math.min(dayStart, range.start),
      end: Math.max(visibleEnd, range.end),
    };
    const maximumDurationStart = range.end - MAX_SEGMENT_MINUTES;
    const maximumDurationEnd = range.start + MAX_SEGMENT_MINUTES;
    return {
      dayBounds: bounds,
      previousEnd: Math.max(
        bounds.start,
        maximumDurationStart,
        neighbor.previousEnd ?? bounds.start,
      ),
      nextStart: Math.min(
        bounds.end,
        maximumDurationEnd,
        neighbor.nextStart ?? bounds.end,
      ),
      snapMinutes,
      minDurationMinutes: Math.max(1, segment.deductionMinutes),
    };
  }, [day, dayEnd, dayStart, neighbors, now, snapMinutes, today]);

  const commit = useCallback(async (
    segment: Segment,
    original: MinuteRange,
    candidate: MinuteRange,
    kind: "move" | "resize-start" | "resize-end",
    focusTarget?: HTMLButtonElement,
  ) => {
    const unchanged = candidate.start === original.start && candidate.end === original.end;
    if (unchanged) {
      clearGesture();
      return;
    }
    gestureRef.current = null;
    suppressClickUntilRef.current = performance.now() + 500;
    setPreview({ segmentId: segment.id, range: candidate });
    setVisual({ segmentId: segment.id, mode: "committing" });
    const changes: { startedAt?: string; endedAt?: string } = {};
    if (kind === "resize-end") {
      changes.endedAt = formatEpochMinute(candidate.end);
    } else {
      changes.startedAt = formatEpochMinute(candidate.start);
      if (kind === "move" && segment.endedAt) {
        changes.endedAt = formatEpochMinute(candidate.end);
      }
    }
    try {
      await onTimeChange(segment, changes);
      setAnnouncement(
        `${segment.title} 已调整为 ${formatEpochMinute(candidate.start).slice(11)} 到 ${
          segment.endedAt ? formatEpochMinute(candidate.end).slice(11) : "进行中"
        }。`,
      );
    } catch {
      setAnnouncement(`${segment.title} 调整失败，已恢复原时间。`);
    } finally {
      setPreview(null);
      setVisual(null);
      window.requestAnimationFrame(() => focusTarget?.focus());
    }
  }, [clearGesture, onTimeChange]);

  const finishPointerGesture = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === "pending") {
      clearGesture();
      return;
    }
    const currentPreview = previewRef.current;
    const candidate = currentPreview?.segmentId === gesture.segment.id
      ? currentPreview.range
      : gesture.original;
    const kind = gesture.kind === "moving"
      ? "move"
      : gesture.edge === "start" ? "resize-start" : "resize-end";
    void commit(gesture.segment, gesture.original, candidate, kind, gesture.target);
  }, [clearGesture, commit]);

  const movePointerGesture = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === "pending") {
      const distance = Math.hypot(
        event.clientX - gesture.originClientX,
        event.clientY - gesture.originClientY,
      );
      if (distance > TIMELINE_PRESS_CANCEL_DISTANCE_PX) clearGesture();
      return;
    }
    event.preventDefault();
    const currentMinute = minuteAtClientY(event.clientY);
    try {
      const range = gesture.kind === "moving"
        ? moveSegment(
          gesture.original,
          { deltaMinutes: currentMinute - gesture.originMinute },
          gesture.constraints,
        )
        : adjustSegmentEdge(
          gesture.original,
          gesture.edge,
          Math.min(
            dayEnd,
            Math.max(dayStart, dayStart + currentMinute + gesture.edgeOffset),
          ),
          gesture.constraints,
        );
      const nextPreview = { segmentId: gesture.segment.id, range };
      previewRef.current = nextPreview;
      setPreview(nextPreview);
    } catch {
      // 约束函数只会在账本边界已失效时抛出；保持最后一个合法预览。
    }
  }, [clearGesture, dayEnd, dayStart, minuteAtClientY]);

  const eventBindings = useCallback((segment: Segment): PointerBinding => {
    const state = availability(segment);
    const committing = visual?.segmentId === segment.id && visual.mode === "committing";
    return {
      onPointerEnter: () => setSelectedId(segment.id),
      onFocus: () => setSelectedId(segment.id),
      onClick: () => {
        if (committing) return;
        if (performance.now() < suppressClickUntilRef.current) return;
        setSelectedId(segment.id);
      },
      onDoubleClick: (event) => {
        event.preventDefault();
        if (committing) return;
        if (performance.now() < suppressClickUntilRef.current) return;
        clearGesture();
        onEdit(segment);
      },
      onKeyDown: (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (committing) return;
        clearGesture();
        onEdit(segment);
      },
      onPointerDown: (event) => {
        if (!state.canMove || committing) {
          setSelectedId(segment.id);
          return;
        }
        if (event.pointerType === "mouse" && event.button !== 0) return;
        const original = fullRange(segment);
        const target = event.currentTarget;
        const pending: PendingGesture = {
          kind: "pending",
          segment,
          original,
          pointerId: event.pointerId,
          originClientX: event.clientX,
          originClientY: event.clientY,
          originMinute: minuteAtClientY(event.clientY),
          target,
          timer: 0,
        };
        pending.timer = window.setTimeout(() => {
          if (gestureRef.current !== pending) return;
          try {
            target.setPointerCapture(pending.pointerId);
          } catch {
            clearGesture();
            return;
          }
          gestureRef.current = {
            ...pending,
            kind: "moving",
            constraints: moveConstraints(segment, original),
          };
          const nextPreview = { segmentId: segment.id, range: original };
          previewRef.current = nextPreview;
          setPreview(nextPreview);
          setVisual({ segmentId: segment.id, mode: "moving" });
          setAnnouncement(`正在移动 ${segment.title}。`);
        }, TIMELINE_LONG_PRESS_MS);
        gestureRef.current = pending;
        setSelectedId(segment.id);
        setVisual({ segmentId: segment.id, mode: "pressing" });
      },
      onPointerMove: movePointerGesture,
      onPointerUp: finishPointerGesture,
      onPointerCancel: () => clearGesture("调整已取消。"),
      onLostPointerCapture: () => {
        if (gestureRef.current?.segment.id === segment.id) clearGesture("调整已取消。");
      },
      onContextMenu: (event) => {
        if (gestureRef.current?.segment.id === segment.id) event.preventDefault();
      },
    };
  }, [
    availability,
    clearGesture,
    finishPointerGesture,
    fullRange,
    minuteAtClientY,
    moveConstraints,
    movePointerGesture,
    onEdit,
    visual?.mode,
    visual?.segmentId,
  ]);

  const resizeBindings = useCallback((
    segment: Segment,
    edge: SegmentEdge,
  ): TimelineResizeBinding => {
    const original = fullRange(segment);
    const value = edge === "start" ? original.start : original.end;
    const label = edge === "start" ? "调整开始时间" : "调整结束时间";
    const startResize = (event: PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      clearGesture();
      event.currentTarget.setPointerCapture(event.pointerId);
      const originMinute = minuteAtClientY(event.clientY);
      gestureRef.current = {
        kind: "resizing",
        edge,
        segment,
        original,
        pointerId: event.pointerId,
        originClientX: event.clientX,
        originClientY: event.clientY,
        originMinute,
        edgeOffset: value - dayStart - originMinute,
        target: event.currentTarget,
        constraints: resizeConstraints(segment, original),
      };
      setSelectedId(segment.id);
      const nextPreview = { segmentId: segment.id, range: original };
      previewRef.current = nextPreview;
      setPreview(nextPreview);
      setVisual({
        segmentId: segment.id,
        mode: edge === "start" ? "resizing-start" : "resizing-end",
      });
      setAnnouncement(`${label}：${formatEpochMinute(value).slice(11)}。`);
    };
    const adjustWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const delta = event.key === "ArrowUp" ? -1 : 1;
      const step = snapMinutes;
      const constraints = resizeConstraints(segment, original);
      const candidate = adjustSegmentEdge(
        original,
        edge,
        value + delta * step,
        constraints,
      );
      setSelectedId(segment.id);
      const nextPreview = { segmentId: segment.id, range: candidate };
      previewRef.current = nextPreview;
      setPreview(nextPreview);
      void commit(
        segment,
        original,
        candidate,
        edge === "start" ? "resize-start" : "resize-end",
        event.currentTarget,
      );
    };
    return {
      role: "separator",
      tabIndex: 0,
      "aria-orientation": "horizontal",
      "aria-label": `${segment.title}：${label}`,
      "aria-valuetext": formatEpochMinute(value).slice(11),
      onKeyDown: adjustWithKeyboard,
      onPointerDown: startResize,
      onPointerMove: movePointerGesture,
      onPointerUp: finishPointerGesture,
      onPointerCancel: () => clearGesture("调整已取消。"),
      onLostPointerCapture: () => {
        if (gestureRef.current?.segment.id === segment.id) clearGesture("调整已取消。");
      },
      onContextMenu: (event) => event.preventDefault(),
    };
  }, [
    clearGesture,
    commit,
    dayStart,
    finishPointerGesture,
    fullRange,
    minuteAtClientY,
    movePointerGesture,
    resizeConstraints,
    snapMinutes,
  ]);

  const displaySegment = useCallback((segment: Segment): Segment => {
    if (preview?.segmentId !== segment.id) return segment;
    const original = fullRange(segment);
    return {
      ...segment,
      startedAt: formatEpochMinute(preview.range.start),
      endedAt: segment.endedAt ? formatEpochMinute(preview.range.end) : null,
      startedUtc: formatUtcEpochMinute(
        utcEpochMinute(segment.startedUtc) + preview.range.start - original.start,
      ),
      endedUtc: segment.endedUtc ? formatUtcEpochMinute(
        utcEpochMinute(segment.endedUtc) + preview.range.end - original.end,
      ) : null,
    };
  }, [fullRange, preview]);

  const visualState = useCallback((segment: Segment): TimelineSegmentVisualState => {
    const available = availability(segment);
    const active = visual?.segmentId === segment.id ? visual.mode : null;
    return {
      ...available,
      selected: selectedId === segment.id,
      pressing: active === "pressing",
      moving: active === "moving",
      resizing: active === "resizing-start" || active === "resizing-end",
      committing: active === "committing",
    };
  }, [availability, selectedId, visual]);

  return {
    selectedId,
    select: setSelectedId,
    announcement,
    displaySegment,
    visualState,
    eventBindings,
    resizeBindings,
    cancel: clearGesture,
  };
}
