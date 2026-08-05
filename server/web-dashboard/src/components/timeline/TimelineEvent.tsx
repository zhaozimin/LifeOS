/**
 * [INPUT]: 依赖 Segment 领域对象、裁剪后的墙上时间、父级算好的绝对布局与超长软标记判定、lib/timeline 的标记文案与设计系统 TimelineEventFrame。
 * [OUTPUT]: 对外提供日/周时间轴共享的领域事项映射；按真实容器尺寸呈现标题、时间、备注、超长软标记及可选手势状态/控制柄。
 * [POS]: components/timeline 的事项适配器；把领域文案映射到设计系统原语，不计算时间边界、不判定超长、不定义视觉样式。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import type {
  ButtonHTMLAttributes,
  CSSProperties,
  ReactNode,
} from "react";
import type { Segment } from "../../types";
import { formatMinutes } from "../../lib/nature";
import { OVERLONG_SEGMENT_LABEL } from "../../lib/timeline";
import {
  TimelineEventContent,
  TimelineEventFrame,
} from "../ui/TimelineCanvas";
import type { TimelineGestureState } from "../ui/TimelineCanvas";

const SOURCE_LABEL = { agent: "AI", manual: "手动", import: "导入" } as const;

export function TimelineEvent({
  segment,
  start,
  end,
  durationMinutes,
  color,
  style,
  variant,
  onEdit,
  actionProps,
  selected = false,
  gesture = "idle",
  canMove = false,
  overlong = false,
  handles,
}: {
  segment: Segment;
  start: string;
  end: string;
  durationMinutes: number;
  color: string;
  style: CSSProperties;
  variant: "day" | "week";
  onEdit: (segment: Segment) => void;
  actionProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type">;
  selected?: boolean;
  gesture?: TimelineGestureState;
  canMove?: boolean;
  overlong?: boolean;
  handles?: ReactNode;
}) {
  const note = segment.note?.trim();
  const project = segment.projectName?.trim();
  const endLabel = segment.endedAt ? end.slice(11) : "进行中";
  // 软标记走既有 meta 行（同一套点分中文短语与 muted 语义色），只前置一段提示文字；
  // 色块、时长、标题一律照常呈现，不隐藏也不灰化——记录不评判。
  const meta = [
    overlong ? OVERLONG_SEGMENT_LABEL : undefined,
    `${start.slice(11)}–${endLabel}`,
    segment.category.name,
    project,
    SOURCE_LABEL[segment.source],
  ].filter(Boolean).join(" · ");
  const label = [
    segment.title,
    meta,
    note,
    formatMinutes(durationMinutes),
  ].filter(Boolean).join("，");

  return (
    <TimelineEventFrame
      variant={variant}
      timelineColor={color}
      className={segment.endedAt ? undefined : "timeos-breathe"}
      style={style}
      selected={selected}
      gesture={gesture}
      canMove={canMove}
      handles={handles}
      actionProps={{
        "aria-label": label,
        "aria-pressed": selected || undefined,
        title: label,
        onClick: actionProps ? undefined : () => onEdit(segment),
        ...actionProps,
      }}
    >
      <TimelineEventContent
        title={segment.title}
        duration={formatMinutes(durationMinutes)}
        meta={meta}
        note={note || undefined}
      />
    </TimelineEventFrame>
  );
}
