/**
 * [INPUT]: 依赖筛选后/完整 Segment 账本、Gap、记录时区墙钟与 UTC 当前瞬间、服务端下发的超长阈值、DST 裁剪、超长判定、整屏缩放与细节栏纯函数、设计系统时间画布及页面一次性 PUT 回调。
 * [OUTPUT]: 对外提供 24h 墙钟时间轴、UTC 真实时长、折叠片段保守投影、DST 日只读拖拽降级、超长软标记、短时段细节与普通日调时。
 * [POS]: components/timeline 的单日领域编排器；UTC/墙钟与超长语义由 lib 裁定，本层只把安全状态、几何、标签、色块和手柄映射到设计系统。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, WheelEvent } from "react";
import type { Gap, Nature, Segment } from "../../types";
import { minuteOfDay } from "../../lib/dates";
import {
  isSegmentOverlong,
  localDayAbsoluteMinutes,
  OVERLONG_SEGMENT_LABEL,
  sliceSegmentForDay,
} from "../../lib/timeline";
import {
  resolveTimelineZoom,
  TIMELINE_FIT_ZOOM_ID,
  TIMELINE_ZOOM_LEVELS,
} from "../../lib/timelineInteraction";
import type { TimelineZoomSelection } from "../../lib/timelineInteraction";
import { needsCallout, placeCallouts } from "../../lib/timelineCallouts";
import { NATURE_LABEL, formatMinutes } from "../../lib/nature";
import { Button } from "../ui/Button";
import {
  TIMELINE_CALLOUT_GUTTER_PX,
  TIMELINE_CALLOUT_LABEL_GAP_PX,
  TIMELINE_CALLOUT_LABEL_HEIGHT_PX,
  TimelineCallout,
  TimelineDayFrame,
  TimelineDistributionBlock,
  TimelineNowLine,
  TimelineResizeHandles,
  TimelineZoomControl,
} from "../ui/TimelineCanvas";
import type {
  TimelineGestureState,
  TimelineResizeHandleConfig,
} from "../ui/TimelineCanvas";
import { TimelineEvent } from "./TimelineEvent";
import { useTimelineSegmentInteraction } from "./useTimelineSegmentInteraction";
import type {
  TimelineResizeBinding,
  TimelineSegmentVisualState,
} from "./useTimelineSegmentInteraction";

const ZOOM_OPTIONS = [
  { value: TIMELINE_FIT_ZOOM_ID, label: "整屏" },
  ...TIMELINE_ZOOM_LEVELS.map((level) => ({ value: level.id, label: level.label })),
] satisfies ReadonlyArray<{ value: TimelineZoomSelection; label: string }>;

function gestureState(state: TimelineSegmentVisualState): TimelineGestureState {
  if (state.resizing) return "resizing";
  if (state.moving) return "moving";
  if (state.pressing) return "pressing";
  return "idle";
}

function resizeHandle(
  binding: TimelineResizeBinding,
  label: string,
  disabled: boolean,
): TimelineResizeHandleConfig {
  const { "aria-label": ariaLabel, ...rest } = binding;
  return { ...rest, ariaLabel, label, disabled };
}

export function DayTimeline({
  day,
  segments,
  allSegments,
  gaps,
  nowMinute,
  nowUtc,
  recordTimeZone,
  overlongSegmentMinutes,
  natureColors,
  zoomId,
  calloutsEnabled,
  onZoomChange,
  onCalloutsEnabledChange,
  onEdit,
  onFillGap,
  onTimeChange,
}: {
  day: string;
  segments: Segment[];
  allSegments: Segment[];
  gaps: Gap[];
  nowMinute: string;
  nowUtc: string;
  recordTimeZone: string;
  // 服务端 configuration 下发的超长阈值；尚未取到配置时传 null，进行中时段即不标记。
  overlongSegmentMinutes: number | null;
  natureColors: Record<Nature, string>;
  zoomId: TimelineZoomSelection;
  calloutsEnabled: boolean;
  onZoomChange: (zoomId: TimelineZoomSelection) => void;
  onCalloutsEnabledChange: (enabled: boolean) => void;
  onEdit: (segment: Segment) => void;
  onFillGap: (gap: Gap) => void;
  onTimeChange: (
    segment: Segment,
    changes: { startedAt?: string; endedAt?: string },
  ) => Promise<Segment>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const zoom = resolveTimelineZoom(zoomId, viewportHeight);
  const previousPixelsPerMinute = useRef(zoom.pixelsPerMinute);
  const pendingCenterMinute = useRef<number | null>(null);
  const lastPositionedDay = useRef<string | null>(null);
  const interaction = useTimelineSegmentInteraction({
    day,
    nowMinute,
    nowUtc,
    recordTimeZone,
    allSegments,
    pixelsPerMinute: zoom.pixelsPerMinute,
    snapMinutes: zoom.snapMinutes,
    viewportRef,
    onEdit,
    onTimeChange,
  });

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const nextHeight = Math.floor(viewport.clientHeight);
      setViewportHeight((current) => (
        current !== null && Math.abs(current - nextHeight) < 1 ? current : nextHeight
      ));
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const previous = previousPixelsPerMinute.current;
    const next = zoom.pixelsPerMinute;
    previousPixelsPerMinute.current = next;
    if (zoomId === TIMELINE_FIT_ZOOM_ID || !viewport || previous === next) return;
    const centerMinute = pendingCenterMinute.current
      ?? (viewport.scrollTop + viewport.clientHeight / 2) / previous;
    pendingCenterMinute.current = null;
    viewport.scrollTop = Math.max(0, centerMinute * next - viewport.clientHeight / 2);
  }, [zoom.pixelsPerMinute, zoomId]);

  const entries = useMemo(
    () => segments
      .map((original) => {
        const segment = interaction.displaySegment(original);
        return {
          original,
          segment,
          overlong: isSegmentOverlong(segment, overlongSegmentMinutes, nowUtc),
          slice: sliceSegmentForDay(segment, day, nowMinute, {
            timeZone: recordTimeZone,
            nowUtc,
          }),
        };
      })
      .filter((entry): entry is typeof entry & {
        slice: NonNullable<typeof entry.slice>;
      } => entry.slice !== null)
      .sort((left, right) => left.slice.startMinute - right.slice.startMinute),
    [
      day,
      interaction.displaySegment,
      nowMinute,
      nowUtc,
      overlongSegmentMinutes,
      recordTimeZone,
      segments,
    ],
  );

  const isToday = day === nowMinute.slice(0, 10);
  const transitionDay = localDayAbsoluteMinutes(day, recordTimeZone) !== 1440;
  const nowTop = minuteOfDay(nowMinute) * zoom.pixelsPerMinute;

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (zoomId === TIMELINE_FIT_ZOOM_ID) {
      lastPositionedDay.current = null;
      return;
    }
    if (!viewport || lastPositionedDay.current === day) return;
    const targetMinute = isToday
      ? minuteOfDay(nowMinute)
      : entries[0]?.slice.startMinute ?? 0;
    viewport.scrollTop = Math.max(
      0,
      targetMinute * zoom.pixelsPerMinute - viewport.clientHeight / 2,
    );
    lastPositionedDay.current = day;
  }, [day, entries, isToday, nowMinute, zoom.pixelsPerMinute, zoomId]);

  const selectZoom = (nextZoomId: TimelineZoomSelection) => {
    const viewport = viewportRef.current;
    if (viewport && nextZoomId !== TIMELINE_FIT_ZOOM_ID) {
      pendingCenterMinute.current = zoomId === TIMELINE_FIT_ZOOM_ID
        ? (isToday ? minuteOfDay(nowMinute) : entries[0]?.slice.startMinute ?? 0)
        : (viewport.scrollTop + viewport.clientHeight / 2) / zoom.pixelsPerMinute;
    }
    onZoomChange(nextZoomId);
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const index = ZOOM_OPTIONS.findIndex((option) => option.value === zoomId);
    const direction = event.deltaY > 0 ? -1 : 1;
    const next = ZOOM_OPTIONS[Math.min(Math.max(index + direction, 0), ZOOM_OPTIONS.length - 1)];
    if (next && next.value !== zoomId) selectZoom(next.value);
  };

  const calloutItems = useMemo(() => {
    const items = [
      ...gaps.map((gap) => {
        const startMinute = minuteOfDay(gap.start);
        const endMinute = gap.end.endsWith("T00:00") ? 1440 : minuteOfDay(gap.end);
        return {
          id: `gap:${gap.start}:${gap.end}`,
          kind: "gap" as const,
          gap,
          startMinute,
          endMinute,
        };
      }),
      ...entries.map((entry) => ({
        id: `segment:${entry.original.id}`,
        kind: "segment" as const,
        ...entry,
        startMinute: entry.slice.startMinute,
        endMinute: entry.slice.endMinute,
      })),
    ];
    return items
      .filter((item) => needsCallout(item.endMinute - item.startMinute, zoom.pixelsPerMinute))
      .sort((left, right) => left.startMinute - right.startMinute);
  }, [entries, gaps, zoom.pixelsPerMinute]);

  const calloutPlacements = useMemo(() => placeCallouts(
    calloutItems,
    {
      pixelsPerMinute: zoom.pixelsPerMinute,
      canvasHeight: 1440 * zoom.pixelsPerMinute,
      labelHeight: TIMELINE_CALLOUT_LABEL_HEIGHT_PX,
      labelGap: TIMELINE_CALLOUT_LABEL_GAP_PX,
    },
  ), [calloutItems, zoom.pixelsPerMinute]);
  const placementById = useMemo(
    () => new Map(calloutPlacements.map((placement) => [placement.id, placement])),
    [calloutPlacements],
  );

  const callouts = calloutItems.map((item) => {
    const placement = placementById.get(item.id);
    if (!placement) return null;
    if (item.kind === "gap") {
      return (
        <TimelineCallout
          key={item.id}
          title="空白 · 待补录"
          nature="尚未记录"
          note="点击补录"
          time={`${item.gap.start.slice(11)}–${item.gap.end.slice(11)} · ${formatMinutes(item.gap.minutes)}`}
          gap
          timelineColor="var(--muted-foreground)"
          style={{ top: placement.labelY }}
          actionProps={{
            "aria-label": `补录 ${item.gap.start.slice(11)} 到 ${item.gap.end.slice(11)}`,
            onClick: () => onFillGap(item.gap),
          }}
        />
      );
    }
    const selected = interaction.selectedId === item.original.id;
    const color = natureColors[item.segment.category.nature];
    // 与「空白 · 待补录」同一条 note 通道：软标记排在用户备注之前，两者共存不互相顶替。
    const calloutNote = [item.overlong ? OVERLONG_SEGMENT_LABEL : null, item.segment.note]
      .filter(Boolean)
      .join(" · ");
    return (
      <TimelineCallout
        key={item.id}
        title={item.segment.title}
        nature={NATURE_LABEL[item.segment.category.nature]}
        note={calloutNote ? `· ${calloutNote}` : undefined}
        time={`${item.slice.start.slice(11)}–${item.segment.endedAt ? item.slice.end.slice(11) : "进行中"} · ${formatMinutes(item.slice.gross)}`}
        highlighted={selected}
        timelineColor={color}
        style={{ top: placement.labelY }}
        actionProps={{
          "aria-label": `${item.segment.title}，打开设置`,
          onPointerEnter: () => interaction.select(item.original.id),
          onFocus: () => interaction.select(item.original.id),
          onClick: () => {
            interaction.select(item.original.id);
            onEdit(item.original);
          },
        }}
      />
    );
  });

  const calloutLines = calloutItems.map((item) => {
    const placement = placementById.get(item.id);
    if (!placement) return null;
    const selected = item.kind === "segment" && interaction.selectedId === item.original.id;
    const color = item.kind === "segment"
      ? natureColors[item.segment.category.nature]
      : "var(--muted-foreground)";
    const labelCenter = placement.labelY + TIMELINE_CALLOUT_LABEL_HEIGHT_PX / 2;
    const endX = TIMELINE_CALLOUT_GUTTER_PX;
    return (
      <g key={item.id} data-highlighted={selected || undefined}>
        <polyline
          fill="none"
          stroke={color}
          strokeWidth={selected ? 1.8 : 1}
          strokeDasharray={item.kind === "gap" ? "3 3" : undefined}
          opacity={selected ? 1 : 0.55}
          points={`0,${placement.anchorY} 10,${placement.anchorY} ${endX - 12},${labelCenter} ${endX},${labelCenter}`}
        />
        <circle cx="0" cy={placement.anchorY} r="2.5" fill={color} opacity={selected ? 1 : 0.75} />
      </g>
    );
  });

  const distribution = (
    <>
      {gaps.map((gap) => {
        const start = minuteOfDay(gap.start);
        const end = gap.end.endsWith("T00:00") ? 1440 : minuteOfDay(gap.end);
        const label = `补录 ${gap.start.slice(11)}–${gap.end.slice(11)}，${formatMinutes(gap.minutes)}`;
        return (
          <TimelineDistributionBlock
            key={`${gap.start}-${gap.end}`}
            variant="gap"
            style={{
              top: start * zoom.pixelsPerMinute,
              height: Math.max(1, (end - start) * zoom.pixelsPerMinute),
            }}
            actionProps={{ "aria-label": label, title: label, onClick: () => onFillGap(gap) }}
          />
        );
      })}
      {entries.map(({ original, segment, overlong, slice }) => {
        const state = interaction.visualState(original);
        return (
          <TimelineDistributionBlock
            key={`${original.id}-${day}`}
            timelineColor={natureColors[segment.category.nature]}
            selected={state.selected}
            gesture={gestureState(state)}
            canMove={false}
            className={segment.endedAt ? undefined : "timeos-breathe"}
            aria-hidden="true"
            title={`${segment.title} · ${slice.start.slice(11)}–${segment.endedAt ? slice.end.slice(11) : "进行中"}${overlong ? ` · ${OVERLONG_SEGMENT_LABEL}` : ""}`}
            style={{
              top: slice.startMinute * zoom.pixelsPerMinute,
              height: Math.max(1, (slice.endMinute - slice.startMinute) * zoom.pixelsPerMinute),
            }}
          />
        );
      })}
      {isToday && <TimelineNowLine top={nowTop} label={`当前时间 ${nowMinute.slice(11)}`} />}
    </>
  );

  return (
    <>
      <div className="timeos-timeline-toolbar">
        <span className="timeos-timeline-toolbar__hint">
          {transitionDay
            ? "夏令时切换日 · 显示实际时长 · 拖拽已停用，请双击设置"
            : "单击选中 · 长按拖动 · 双击设置"}
        </span>
        <div className="flex min-w-0 items-center gap-2">
          <Button
            size="sm"
            variant={calloutsEnabled ? "primary" : "outline"}
            aria-pressed={calloutsEnabled}
            onClick={() => onCalloutsEnabledChange(!calloutsEnabled)}
          >
            细节栏 · {calloutsEnabled ? "开" : "关"}
          </Button>
          <TimelineZoomControl value={zoomId} options={ZOOM_OPTIONS} onChange={selectZoom} />
        </div>
      </div>
      <TimelineDayFrame
        data-zoom={zoomId}
        pixelsPerMinute={zoom.pixelsPerMinute}
        gridMinutes={zoom.gridMinutes}
        viewportRef={viewportRef}
        viewportAriaLabel={`${day} 可缩放单日时间轴`}
        distributionAriaLabel={`${day} 活动分钟分布`}
        detailsAriaLabel={`${day} 具体事项`}
        distribution={distribution}
        calloutsEnabled={calloutsEnabled}
        callouts={callouts}
        calloutLines={calloutLines}
        onViewportWheel={onWheel}
        overlay={isToday ? <TimelineNowLine top={nowTop} label={`当前时间 ${nowMinute.slice(11)}`} /> : undefined}
      >
        {entries.map(({ original, segment, overlong, slice }) => {
          const state = interaction.visualState(original);
          const startBinding = state.canResizeStart ? interaction.resizeBindings(original, "start") : null;
          const endBinding = state.canResizeEnd ? interaction.resizeBindings(original, "end") : null;
          const handles = state.selected && (startBinding || endBinding) ? (
            <TimelineResizeHandles
              start={startBinding ? resizeHandle(startBinding, segment.startedAt.slice(11), state.committing) : false}
              end={endBinding ? resizeHandle(endBinding, segment.endedAt?.slice(11) || "进行中", state.committing) : false}
            />
          ) : undefined;
          return (
            <TimelineEvent
              key={`${original.id}-${day}`}
              segment={segment}
              start={slice.start}
              end={slice.end}
              durationMinutes={slice.gross}
              color={natureColors[segment.category.nature]}
              variant="day"
              style={{
                top: slice.startMinute * zoom.pixelsPerMinute,
                height: Math.max(1, (slice.endMinute - slice.startMinute) * zoom.pixelsPerMinute),
              } as CSSProperties}
              onEdit={onEdit}
              actionProps={{ ...interaction.eventBindings(original), "aria-busy": state.committing || undefined }}
              selected={state.selected}
              gesture={gestureState(state)}
              canMove={state.canMove && !state.committing}
              overlong={overlong}
              handles={handles}
            />
          );
        })}
      </TimelineDayFrame>
      <p className="sr-only" aria-live="polite">{interaction.announcement}</p>
    </>
  );
}
