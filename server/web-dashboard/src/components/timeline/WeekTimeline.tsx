/**
 * [INPUT]: 依赖一周 Segment、记录时区墙钟与 UTC 当前瞬间、DST 感知跨日裁剪、整屏/五档缩放、nature 调色板与 TimelineEvent。
 * [OUTPUT]: 对外提供共享 24h 墙钟比例尺、七个日期列、UTC 真实时长、折叠片段保守投影和当前时刻线。
 * [POS]: components/timeline 的周视图编排器；复用日视图 UTC/墙钟分层和事项原语，但因七列密度不启用细节栏与直接调时。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { Nature, Segment } from "../../types";
import { daysInRange, isSegmentOverlong, sliceSegmentForDay } from "../../lib/timeline";
import { minuteOfDay } from "../../lib/dates";
import {
  resolveTimelineZoom,
  TIMELINE_FIT_ZOOM_ID,
  TIMELINE_ZOOM_LEVELS,
} from "../../lib/timelineInteraction";
import type { TimelineZoomSelection } from "../../lib/timelineInteraction";
import { TimelineZoomControl } from "../ui/TimelineCanvas";
import { TimelineEvent } from "./TimelineEvent";

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEK_HEAD_HEIGHT = 45;
const ZOOM_OPTIONS = [
  { value: TIMELINE_FIT_ZOOM_ID, label: "整屏" },
  ...TIMELINE_ZOOM_LEVELS.map((level) => ({ value: level.id, label: level.label })),
] satisfies ReadonlyArray<{ value: TimelineZoomSelection; label: string }>;

function weekday(day: string) {
  return WEEKDAY[new Date(`${day}T12:00:00`).getDay()];
}

export function WeekTimeline({
  from,
  to,
  segments,
  nowMinute,
  nowUtc,
  recordTimeZone,
  natureColors,
  overlongSegmentMinutes,
  zoomId,
  onZoomChange,
  onEdit,
}: {
  from: string;
  to: string;
  segments: Segment[];
  nowMinute: string;
  nowUtc: string;
  recordTimeZone: string;
  natureColors: Record<Nature, string>;
  /** 超长阈值随 configuration 下发；缺失时只标记服务端已判定的已闭合时段。 */
  overlongSegmentMinutes: number | null;
  zoomId: TimelineZoomSelection;
  onZoomChange: (zoomId: TimelineZoomSelection) => void;
  onEdit: (segment: Segment) => void;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const fitHeight = viewportHeight === null ? null : Math.max(1, viewportHeight - WEEK_HEAD_HEIGHT);
  const zoom = resolveTimelineZoom(zoomId, fitHeight);
  const dayHeight = 1440 * zoom.pixelsPerMinute;
  const days = daysInRange(from, to);
  const today = nowMinute.slice(0, 10);
  const nowTop = minuteOfDay(nowMinute) * zoom.pixelsPerMinute;

  useEffect(() => {
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const next = Math.floor(viewport.clientHeight);
      setViewportHeight((current) => current !== null && Math.abs(current - next) < 1 ? current : next);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport]);

  return (
    <div className="timeos-week-frame" data-zoom={zoomId}>
      <div className="timeos-timeline-toolbar">
        <span className="timeos-timeline-toolbar__hint">七日共享同一真实比例尺</span>
        <TimelineZoomControl value={zoomId} options={ZOOM_OPTIONS} onChange={onZoomChange} />
      </div>
      <div ref={setViewport} className="timeos-week-scroll">
        <div className="timeos-week-view">
          <div className="timeos-week-head">
            <span aria-hidden="true" />
            {days.map((day) => (
              <div key={day} className={day === today ? "is-today" : ""}>
                <strong>{day.slice(8)}</strong>
                <span>{weekday(day)}</span>
              </div>
            ))}
          </div>
          <div
            className="timeos-week-grid"
            style={{
              height: dayHeight,
              "--timeline-grid-size": `${60 * zoom.pixelsPerMinute}px`,
            } as CSSProperties}
          >
            <div className="timeos-time-axis" aria-hidden="true">
              {Array.from({ length: 13 }, (_, index) => {
                const hour = index * 2;
                return (
                  <span
                    key={hour}
                    className="timeos-hour-label"
                    style={{ top: hour * 60 * zoom.pixelsPerMinute }}
                  >
                    {String(hour).padStart(2, "0")}:00
                  </span>
                );
              })}
            </div>
            {days.map((day) => {
              const slices = segments
                .map((segment) => ({
                  segment,
                  slice: sliceSegmentForDay(segment, day, nowMinute, {
                    timeZone: recordTimeZone,
                    nowUtc,
                  }),
                }))
                .filter((entry): entry is { segment: Segment; slice: NonNullable<typeof entry.slice> } => !!entry.slice);
              return (
                <div key={day} className={`timeos-week-day${day === today ? " is-today" : ""}`}>
                  {slices.map(({ segment, slice }) => (
                    <TimelineEvent
                      key={`${segment.id}-${day}`}
                      segment={segment}
                      start={slice.start}
                      end={slice.end}
                      durationMinutes={slice.gross}
                      color={natureColors[segment.category.nature]}
                      variant="week"
                      // 判定针对整条时段，不针对被日界裁开的这一片：
                      // 跨夜吞掉一整天正是超长的典型形态，若按 slice 判定反而每片都不超标。
                      overlong={isSegmentOverlong(segment, overlongSegmentMinutes, nowUtc)}
                      style={{
                        top: slice.startMinute * zoom.pixelsPerMinute,
                        height: Math.max(1, (slice.endMinute - slice.startMinute) * zoom.pixelsPerMinute),
                        left: 4,
                        right: 4,
                      }}
                      onEdit={onEdit}
                    />
                  ))}
                  {day === today && (
                    <div
                      className="timeos-now-line"
                      style={{ top: nowTop, left: 0, right: 0 } as CSSProperties}
                      aria-label={`当前时间 ${nowMinute.slice(11)}`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
