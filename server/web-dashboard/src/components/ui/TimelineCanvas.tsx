/**
 * [INPUT]: 依赖 React 受控属性、clsx、lucide 图标，以及调用方映射好的分钟几何和交互回调。
 * [OUTPUT]: 对外提供时间轴缩放、可扩展五列日画布、细节标签/引导线、时间刻度、分布块、事项块、当前线与缩放手柄设计系统原语。
 * [POS]: components/ui 的时间画布视觉与结构真源；领域组件只映射记录数据、整数分钟和持久化行为，短块可读性由细节栏承接。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { forwardRef } from "react";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  ReactNode,
  Ref,
  UIEventHandler,
  WheelEventHandler,
} from "react";
import clsx from "clsx";
import { Minus, Plus } from "lucide-react";

export const TIMELINE_LONG_PRESS_MS = 380;
export const TIMELINE_PRESS_CANCEL_DISTANCE_PX = 8;
export const TIMELINE_CALLOUT_GUTTER_PX = 56;
export const TIMELINE_CALLOUT_LABEL_HEIGHT_PX = 30;
export const TIMELINE_CALLOUT_LABEL_GAP_PX = 6;

export type TimelineGestureState = "idle" | "pressing" | "moving" | "resizing";

type TimelineCSSProperties = CSSProperties & {
  "--timeline-color"?: string;
  "--timeline-day-height"?: string;
  "--timeline-grid-size"?: string;
  "--timeline-minute-size"?: string;
  "--timeline-viewport-height"?: string;
  "--timeline-long-press-duration"?: string;
};

export interface TimelineZoomOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
}

export function TimelineZoomControl<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel = "时间轴缩放",
  className,
}: {
  value: T;
  options: readonly TimelineZoomOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  if (options.length === 0) return null;
  const currentIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const current = options[currentIndex];

  function select(index: number) {
    const option = options[Math.min(Math.max(index, 0), options.length - 1)];
    if (option && option.value !== value) onChange(option.value);
  }

  return (
    <div className={clsx("timeos-timeline-zoom", className)} aria-label={ariaLabel}>
      <span className="timeos-timeline-zoom__title">时间缩放</span>
      <button
        type="button"
        className="timeos-timeline-zoom__step"
        aria-label="缩小时间轴"
        disabled={disabled || currentIndex === 0}
        onClick={() => select(currentIndex - 1)}
      >
        <Minus size={14} aria-hidden />
      </button>
      <input
        className="timeos-timeline-zoom__range"
        type="range"
        min={0}
        max={options.length - 1}
        step={1}
        value={currentIndex}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-valuetext={current.label}
        onChange={(event) => select(Number(event.currentTarget.value))}
      />
      <button
        type="button"
        className="timeos-timeline-zoom__step"
        aria-label="放大时间轴"
        disabled={disabled || currentIndex === options.length - 1}
        onClick={() => select(currentIndex + 1)}
      >
        <Plus size={14} aria-hidden />
      </button>
      <output className="timeos-timeline-zoom__value" aria-live="polite">
        {current.label}
      </output>
    </div>
  );
}

export interface TimelineTimeAxisProps extends HTMLAttributes<HTMLDivElement> {
  dayMinutes?: number;
  labelMinutes: number;
  pixelsPerMinute: number;
  formatLabel?: (minute: number) => string;
}

export function TimelineTimeAxis({
  dayMinutes = 24 * 60,
  labelMinutes,
  pixelsPerMinute,
  formatLabel = formatTimelineMinute,
  className,
  ...rest
}: TimelineTimeAxisProps) {
  const safeDayMinutes = positive(dayMinutes, 24 * 60);
  const safeLabelMinutes = positive(labelMinutes, 60);
  const safePixelsPerMinute = positive(pixelsPerMinute, 0.8);
  const ticks = Array.from(
    { length: Math.floor(safeDayMinutes / safeLabelMinutes) + 1 },
    (_, index) => index * safeLabelMinutes,
  );
  if (ticks[ticks.length - 1] !== safeDayMinutes) ticks.push(safeDayMinutes);

  return (
    <div className={clsx("timeos-time-axis", className)} aria-hidden="true" {...rest}>
      {ticks.map((minute) => (
        <span
          key={minute}
          className="timeos-hour-label"
          style={{ top: minute * safePixelsPerMinute }}
        >
          {formatLabel(minute)}
        </span>
      ))}
    </div>
  );
}

export interface TimelineDayFrameProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  pixelsPerMinute: number;
  gridMinutes: number;
  labelMinutes?: number;
  dayMinutes?: number;
  viewportHeight?: number | string;
  viewportClassName?: string;
  viewportStyle?: CSSProperties;
  viewportAriaLabel?: string;
  distributionAriaLabel?: string;
  detailsAriaLabel?: string;
  axis?: ReactNode;
  distribution?: ReactNode;
  children?: ReactNode;
  overlay?: ReactNode;
  callouts?: ReactNode;
  calloutLines?: ReactNode;
  calloutsEnabled?: boolean;
  onViewportScroll?: UIEventHandler<HTMLDivElement>;
  onViewportWheel?: WheelEventHandler<HTMLDivElement>;
  viewportRef?: Ref<HTMLDivElement>;
}

export function TimelineDayFrame({
  pixelsPerMinute,
  gridMinutes,
  labelMinutes,
  dayMinutes = 24 * 60,
  viewportHeight,
  viewportClassName,
  viewportStyle,
  viewportAriaLabel = "单日时间轴",
  distributionAriaLabel = "活动分钟分布",
  detailsAriaLabel = "具体事项",
  axis,
  distribution,
  children,
  overlay,
  callouts,
  calloutLines,
  calloutsEnabled = false,
  onViewportScroll,
  onViewportWheel,
  viewportRef,
  className,
  style,
  ...rest
}: TimelineDayFrameProps) {
  const safePixelsPerMinute = positive(pixelsPerMinute, 0.8);
  const safeGridMinutes = positive(gridMinutes, 60);
  const safeDayMinutes = positive(dayMinutes, 24 * 60);
  const safeLabelMinutes = positive(
    labelMinutes ?? defaultLabelMinutes(safeGridMinutes),
    60,
  );
  const timelineStyle = {
    ...style,
    "--timeline-minute-size": `${safePixelsPerMinute}px`,
    "--timeline-grid-size": `${safeGridMinutes * safePixelsPerMinute}px`,
    "--timeline-day-height": `${safeDayMinutes * safePixelsPerMinute}px`,
    ...(viewportHeight === undefined
      ? {}
      : { "--timeline-viewport-height": cssLength(viewportHeight) }),
  } as TimelineCSSProperties;

  return (
    <div
      className={clsx("timeos-day-view timeos-timeline", className)}
      style={timelineStyle}
      {...rest}
    >
      <div className="timeos-day-head text-caption-uppercase" data-callouts={calloutsEnabled ? "on" : "off"} aria-hidden="true">
        <span>时间</span>
        <span>分布</span>
        <span>具体事项</span>
        {calloutsEnabled && <span aria-hidden="true" />}
        {calloutsEnabled && <span>细节</span>}
      </div>
      <div
        ref={viewportRef}
        className={clsx("timeos-day-viewport", viewportClassName)}
        style={viewportStyle}
        aria-label={viewportAriaLabel}
        onScroll={onViewportScroll}
        onWheel={onViewportWheel}
      >
        <div className="timeos-day-grid" data-callouts={calloutsEnabled ? "on" : "off"}>
          {axis ?? (
            <TimelineTimeAxis
              dayMinutes={safeDayMinutes}
              labelMinutes={safeLabelMinutes}
              pixelsPerMinute={safePixelsPerMinute}
            />
          )}
          <div className="timeos-activity-lane" aria-label={distributionAriaLabel}>
            {distribution}
          </div>
          <div className="timeos-detail-lanes" aria-label={detailsAriaLabel}>
            {children}
            {overlay}
          </div>
          {calloutsEnabled && (
            <svg
              className="timeos-callout-lines"
              width={TIMELINE_CALLOUT_GUTTER_PX}
              height={safeDayMinutes * safePixelsPerMinute}
              viewBox={`0 0 ${TIMELINE_CALLOUT_GUTTER_PX} ${safeDayMinutes * safePixelsPerMinute}`}
              aria-hidden="true"
            >
              {calloutLines}
            </svg>
          )}
          {calloutsEnabled && (
            <div className="timeos-callout-lane" aria-label="短时段细节">
              {callouts}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function TimelineCallout({
  title,
  nature,
  note,
  time,
  gap = false,
  highlighted = false,
  timelineColor,
  actionProps,
  style,
}: {
  title: ReactNode;
  nature?: ReactNode;
  note?: ReactNode;
  time: ReactNode;
  gap?: boolean;
  highlighted?: boolean;
  timelineColor?: string;
  actionProps: TimelineActionProps;
  style: CSSProperties;
}) {
  return (
    <button
      {...actionProps}
      type="button"
      className={clsx("timeos-callout", gap && "timeos-callout--gap", actionProps.className)}
      data-highlighted={highlighted || undefined}
      style={interactionStyle(style, timelineColor, TIMELINE_LONG_PRESS_MS)}
    >
      <i aria-hidden="true" />
      <b>{title}</b>
      {nature !== undefined && <em>{nature}</em>}
      {note !== undefined && <u>{note}</u>}
      <span>{time}</span>
    </button>
  );
}

type TimelineActionProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "type"
>;

interface TimelineFrameState {
  selected?: boolean;
  gesture?: TimelineGestureState;
  canMove?: boolean;
  longPressDurationMs?: number;
}

export interface TimelineDistributionBlockProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "color">,
    TimelineFrameState {
  variant?: "activity" | "gap";
  timelineColor?: string;
  actionProps?: TimelineActionProps;
  handles?: ReactNode;
  children?: ReactNode;
}

export const TimelineDistributionBlock = forwardRef<
  HTMLDivElement,
  TimelineDistributionBlockProps
>(function TimelineDistributionBlock(
  {
    variant = "activity",
    timelineColor,
    selected = false,
    gesture = "idle",
    canMove = false,
    longPressDurationMs = TIMELINE_LONG_PRESS_MS,
    actionProps,
    handles,
    children,
    className,
    style,
    ...rest
  },
  ref,
) {
  const { className: actionClassName, ...restActionProps } = actionProps ?? {};
  return (
    <div
      ref={ref}
      className={clsx(
        "timeos-distribution-block",
        `timeos-distribution-block--${variant}`,
        className,
      )}
      style={interactionStyle(style, timelineColor, longPressDurationMs)}
      data-selected={selected || undefined}
      data-gesture={gesture}
      data-can-move={canMove || undefined}
      {...rest}
    >
      {actionProps ? (
        <button
          {...restActionProps}
          type="button"
          className={clsx("timeos-distribution-block__action", actionClassName)}
        >
          {children}
        </button>
      ) : (
        <span className="timeos-distribution-block__action" aria-hidden="true">
          {children}
        </span>
      )}
      <span className="timeos-long-press-indicator" aria-hidden="true" />
      {handles}
    </div>
  );
});

export interface TimelineEventFrameProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "color">,
    TimelineFrameState {
  variant: "day" | "week";
  timelineColor: string;
  actionProps: TimelineActionProps;
  handles?: ReactNode;
  children: ReactNode;
}

export const TimelineEventFrame = forwardRef<HTMLDivElement, TimelineEventFrameProps>(
  function TimelineEventFrame(
    {
      variant,
      timelineColor,
      selected = false,
      gesture = "idle",
      canMove = false,
      longPressDurationMs = TIMELINE_LONG_PRESS_MS,
      actionProps,
      handles,
      children,
      className,
      style,
      ...rest
    },
    ref,
  ) {
    const { className: actionClassName, ...restActionProps } = actionProps;
    return (
      <div
        ref={ref}
        className={clsx(
          "timeos-timeline-event",
          `timeos-timeline-event--${variant}`,
          className,
        )}
        style={interactionStyle(style, timelineColor, longPressDurationMs)}
        data-selected={selected || undefined}
        data-gesture={gesture}
        data-can-move={canMove || undefined}
        {...rest}
      >
        <button
          {...restActionProps}
          type="button"
          className={clsx("timeos-timeline-event__action", actionClassName)}
        >
          {children}
        </button>
        <span className="timeos-long-press-indicator" aria-hidden="true" />
        {handles}
      </div>
    );
  },
);

export function TimelineEventContent({
  title,
  duration,
  meta,
  note,
}: {
  title: ReactNode;
  duration?: ReactNode;
  meta?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <>
      <span className="timeos-event-heading">
        <strong>{title}</strong>
        {duration !== undefined && <span>{duration}</span>}
      </span>
      {meta !== undefined && <span className="timeos-event-meta">{meta}</span>}
      {note !== undefined && <span className="timeos-event-note">{note}</span>}
    </>
  );
}

export interface TimelineResizeHandleConfig
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type" | "aria-label"> {
  ariaLabel: string;
  label?: ReactNode;
}

export interface TimelineResizeHandlesProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  start?: TimelineResizeHandleConfig | false;
  end?: TimelineResizeHandleConfig | false;
}

export function TimelineResizeHandles({
  start,
  end,
  className,
  ...rest
}: TimelineResizeHandlesProps) {
  if (!start && !end) return null;
  return (
    <div className={clsx("timeos-resize-handles", className)} {...rest}>
      {start && <TimelineResizeHandle edge="start" config={start} />}
      {end && <TimelineResizeHandle edge="end" config={end} />}
    </div>
  );
}

function TimelineResizeHandle({
  edge,
  config,
}: {
  edge: "start" | "end";
  config: TimelineResizeHandleConfig;
}) {
  const {
    ariaLabel,
    label,
    onPointerDown,
    onClick,
    onDoubleClick,
    ...buttonProps
  } = config;
  return (
    <button
      {...buttonProps}
      type="button"
      role="separator"
      aria-orientation="horizontal"
      className="timeos-resize-handle"
      data-resize-edge={edge}
      aria-label={ariaLabel}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown?.(event);
      }}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onDoubleClick?.(event);
      }}
    >
      <span className="timeos-resize-handle__line" aria-hidden="true" />
      {label !== undefined && (
        <span className="timeos-resize-handle__label">{label}</span>
      )}
    </button>
  );
}

export function TimelineNowLine({
  top,
  label,
  className,
  style,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  top: number;
  label: string;
}) {
  return (
    <div
      className={clsx("timeos-now-line", className)}
      style={{ ...style, top }}
      aria-label={label}
      {...rest}
    />
  );
}

function interactionStyle(
  style: CSSProperties | undefined,
  timelineColor: string | undefined,
  longPressDurationMs: number,
): TimelineCSSProperties {
  return {
    ...style,
    ...(timelineColor ? { "--timeline-color": timelineColor } : {}),
    "--timeline-long-press-duration": `${positive(
      longPressDurationMs,
      TIMELINE_LONG_PRESS_MS,
    )}ms`,
  };
}

function formatTimelineMinute(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function defaultLabelMinutes(gridMinutes: number): number {
  if (gridMinutes >= 60) return 120;
  if (gridMinutes >= 30) return 60;
  if (gridMinutes >= 10) return 30;
  if (gridMinutes >= 5) return 15;
  return 5;
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function cssLength(value: number | string): string {
  return typeof value === "number" ? `${value}px` : value;
}
