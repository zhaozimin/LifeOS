/**
 * [INPUT]: 依赖 src/lib/timelineInteraction.ts 的五级缩放真源、整屏解析、分钟吸附、边缘调整、整段移动与冲突检测。
 * [OUTPUT]: 提供五级数组不变、整屏密度、整数分钟、时长守恒、日界及半开相邻边界的 Node 回归测试。
 * [POS]: web-dashboard 的时间轴手势数学变异锁；无需 DOM 即可证明所有交互候选都满足服务端 I2/I3 边界。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  TIMELINE_DAY_BOUNDS,
  TIMELINE_ZOOM_LEVELS,
  adjustSegmentEdge,
  getSegmentConflict,
  getTimelineZoomLevel,
  moveSegment,
  resolveTimelineZoom,
  snapMinute,
  visibleMinutesForHeight,
} from "./src/lib/timelineInteraction.ts";

test("五级缩放真源固定网格、像素密度、吸附和标签", () => {
  assert.deepEqual(
    TIMELINE_ZOOM_LEVELS.map((level) => ({
      id: level.id,
      gridMinutes: level.gridMinutes,
      pixelsPerMinute: level.pixelsPerMinute,
      snapMinutes: level.snapMinutes,
      label: level.label,
    })),
    [
      { id: "60m", gridMinutes: 60, pixelsPerMinute: 0.8, snapMinutes: 15, label: "60 分钟" },
      { id: "30m", gridMinutes: 30, pixelsPerMinute: 1.6, snapMinutes: 10, label: "30 分钟" },
      { id: "10m", gridMinutes: 10, pixelsPerMinute: 4.8, snapMinutes: 5, label: "10 分钟" },
      { id: "5m", gridMinutes: 5, pixelsPerMinute: 9.6, snapMinutes: 1, label: "5 分钟" },
      { id: "1m", gridMinutes: 1, pixelsPerMinute: 24, snapMinutes: 1, label: "1 分钟" },
    ],
  );
  assert.deepEqual(
    TIMELINE_ZOOM_LEVELS.map((level) =>
      visibleMinutesForHeight(480, level.pixelsPerMinute)),
    [600, 300, 100, 50, 20],
  );
  assert.equal(getTimelineZoomLevel("10m"), TIMELINE_ZOOM_LEVELS[2]);
});

test("整屏档按视口高度解析但不污染五级缩放真源", () => {
  assert.equal(resolveTimelineZoom("fit", 720).pixelsPerMinute, 0.5);
  assert.equal(resolveTimelineZoom("fit", 100).pixelsPerMinute, 0.25);
  assert.equal(resolveTimelineZoom("fit", null).pixelsPerMinute, 0.8);
  assert.equal(resolveTimelineZoom("30m", 720), getTimelineZoomLevel("30m"));
  assert.equal(TIMELINE_ZOOM_LEVELS.length, 5);
});

test("吸附以指定锚点取最近刻度并始终返回整数分钟", () => {
  assert.equal(snapMinute(642.4, 5), 640);
  assert.equal(snapMinute(642.6, 5), 645);
  assert.equal(snapMinute(107.6, 5, 2), 107);
  assert.equal(Number.isInteger(snapMinute(642.6, 5)), true);
});

test("拖开始边缘只改开始并受前一时段和最短时长约束", () => {
  const original = { start: 641, end: 649 };
  const constraints = {
    previousEnd: 632,
    nextStart: 655,
    snapMinutes: 5,
  };

  assert.deepEqual(
    adjustSegmentEdge(original, "start", 636.8, constraints),
    { start: 635, end: 649 },
  );
  assert.deepEqual(
    adjustSegmentEdge(original, "start", 620, constraints),
    { start: 632, end: 649 },
  );
  assert.deepEqual(
    adjustSegmentEdge(original, "start", 649, constraints),
    { start: 648, end: 649 },
  );
  assert.deepEqual(original, { start: 641, end: 649 });
});

test("拖结束边缘只改结束并受后一时段和日界约束", () => {
  const segment = { start: 641, end: 649 };
  assert.deepEqual(
    adjustSegmentEdge(segment, "end", 660, {
      nextStart: 655,
      snapMinutes: 5,
    }),
    { start: 641, end: 655 },
  );
  assert.deepEqual(
    adjustSegmentEdge(segment, "end", 640, { snapMinutes: 5 }),
    { start: 641, end: 642 },
  );
  assert.deepEqual(
    adjustSegmentEdge({ start: 1430, end: 1435 }, "end", 1500, {
      dayBounds: TIMELINE_DAY_BOUNDS,
      snapMinutes: 15,
    }),
    { start: 1430, end: 1440 },
  );
});

test("按分钟差整体移动保留原始偏移与持续时长", () => {
  const segment = { start: 641, end: 649 };
  const moved = moveSegment(segment, { deltaMinutes: 7.4 }, { snapMinutes: 5 });

  assert.deepEqual(moved, { start: 646, end: 654 });
  assert.equal(moved.end - moved.start, segment.end - segment.start);
  assert.deepEqual(segment, { start: 641, end: 649 });
});

test("按目标开始时间移动会吸附并被日界与相邻时段夹住", () => {
  const segment = { start: 641, end: 649 };
  const constraints = {
    dayBounds: { start: 600, end: 660 },
    previousEnd: 632,
    nextStart: 655,
    snapMinutes: 5,
  };

  assert.deepEqual(
    moveSegment(segment, { targetStart: 650.1 }, constraints),
    { start: 647, end: 655 },
  );
  assert.deepEqual(
    moveSegment(segment, { targetStart: 610 }, constraints),
    { start: 632, end: 640 },
  );
});

test("绝对分钟边界允许跨午夜时段等长移动", () => {
  const segment = { start: 1430, end: 1490 };
  const moved = moveSegment(
    segment,
    { deltaMinutes: 15 },
    {
      dayBounds: { start: 0, end: 2880 },
      snapMinutes: 5,
    },
  );

  assert.deepEqual(moved, { start: 1445, end: 1505 });
  assert.equal(moved.end - moved.start, 60);
  assert.equal(
    getSegmentConflict(moved, { dayBounds: { start: 0, end: 2880 } }),
    null,
  );
});

test("半开区间允许首尾相接并准确报告日界或相邻冲突", () => {
  const constraints = {
    dayBounds: { start: 0, end: 1440 },
    previousEnd: 632,
    nextStart: 655,
  };

  assert.equal(getSegmentConflict({ start: 632, end: 655 }, constraints), null);
  assert.equal(
    getSegmentConflict({ start: 631, end: 655 }, constraints),
    "overlaps-previous",
  );
  assert.equal(
    getSegmentConflict({ start: 632, end: 656 }, constraints),
    "overlaps-next",
  );
  assert.equal(
    getSegmentConflict({ start: -1, end: 10 }, constraints),
    "before-day",
  );
  assert.equal(
    getSegmentConflict({ start: 1430, end: 1441 }, constraints),
    "after-day",
  );
});

test("非法区间、非整数候选和无法容纳的移动显式失败", () => {
  assert.equal(getSegmentConflict({ start: 10.5, end: 20 }), "non-integer");
  assert.equal(getSegmentConflict({ start: 20, end: 20 }), "invalid-range");
  assert.equal(
    getSegmentConflict(
      { start: 20, end: 21 },
      { minDurationMinutes: 2 },
    ),
    "shorter-than-minimum",
  );
  assert.throws(
    () => moveSegment(
      { start: 10, end: 30 },
      { deltaMinutes: 5 },
      { previousEnd: 100, nextStart: 110 },
    ),
    /没有足够空间/,
  );
  assert.throws(
    () => moveSegment(
      { start: 10, end: 20 },
      { deltaMinutes: 5, targetStart: 30 },
    ),
    /必须且只能提供/,
  );
});
