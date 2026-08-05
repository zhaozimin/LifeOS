/**
 * [INPUT]: 依赖调用方提供的短时段分钟边界、实际每分钟像素与细节标签尺寸。
 * [OUTPUT]: 对外提供 23px 可读性判定，以及不越出画布的细节标签纵向排布纯函数。
 * [POS]: lib 的时间轴可读性算法层；只计算锚点与标签位置，不感知 React、DOM 或视觉样式。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/** 与 timeline.css 的 @container timeos-event (max-height: 23px) 同源。 */
export const TIMELINE_CALLOUT_MAX_HEIGHT = 23;

export interface CalloutInput {
  readonly id: string;
  readonly startMinute: number;
  readonly endMinute: number;
}

export interface CalloutPlacement {
  readonly id: string;
  readonly anchorY: number;
  readonly labelY: number;
}

export function needsCallout(
  durationMinutes: number,
  pixelsPerMinute: number,
): boolean {
  return durationMinutes > 0
    && pixelsPerMinute > 0
    && durationMinutes * pixelsPerMinute <= TIMELINE_CALLOUT_MAX_HEIGHT;
}

export function placeCallouts(
  items: readonly CalloutInput[],
  options: {
    pixelsPerMinute: number;
    canvasHeight: number;
    labelHeight: number;
    labelGap: number;
  },
): CalloutPlacement[] {
  if (items.length === 0) return [];
  const { pixelsPerMinute, canvasHeight, labelHeight, labelGap } = options;
  if (![pixelsPerMinute, canvasHeight, labelHeight].every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError("引导线布局尺寸必须是有限正数。");
  }
  if (!Number.isFinite(labelGap) || labelGap < 0) {
    throw new RangeError("引导线标签间距必须是有限非负数。");
  }

  const anchors = items.map((item) => (
    (item.startMinute + item.endMinute) / 2 * pixelsPerMinute
  ));
  const usableHeight = Math.max(0, canvasHeight - labelHeight);
  const requiredHeight = items.length * labelHeight + (items.length - 1) * labelGap;

  // 画布物理上容不下全部标签时，允许标签互相靠近，但仍均匀铺满且不越界。
  if (requiredHeight > canvasHeight) {
    return items.map((item, index) => ({
      id: item.id,
      anchorY: anchors[index],
      labelY: items.length === 1 ? usableHeight / 2 : index / (items.length - 1) * usableHeight,
    }));
  }

  const positions: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const wanted = anchors[index] - labelHeight / 2;
    positions.push(index === 0
      ? wanted
      : Math.max(wanted, positions[index - 1] + labelHeight + labelGap));
  }

  if (positions[positions.length - 1] + labelHeight > canvasHeight) {
    for (let index = positions.length - 1; index >= 0; index -= 1) {
      positions[index] = Math.min(
        positions[index],
        index === positions.length - 1
          ? canvasHeight - labelHeight
          : positions[index + 1] - labelHeight - labelGap,
      );
    }
  }

  for (let index = 0; index < positions.length; index += 1) {
    positions[index] = Math.max(
      positions[index],
      index === 0 ? 0 : positions[index - 1] + labelHeight + labelGap,
    );
  }

  return items.map((item, index) => ({
    id: item.id,
    anchorY: anchors[index],
    labelY: positions[index],
  }));
}
