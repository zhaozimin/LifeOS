/**
 * [INPUT]: 依赖 src/lib/timelineCallouts.ts 的可读性阈值与标签排布纯函数。
 * [OUTPUT]: 提供居中、消重、回推、拥挤退化和 23px 边界的 Node 回归测试。
 * [POS]: web-dashboard 的细节栏几何变异锁；无需 DOM 即可证明标签与画布边界关系。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  needsCallout,
  placeCallouts,
} from "./src/lib/timelineCallouts.ts";

const options = {
  pixelsPerMinute: 1,
  canvasHeight: 200,
  labelHeight: 30,
  labelGap: 6,
};

test("单个标签精确居中于锚点", () => {
  assert.deepEqual(
    placeCallouts([{ id: "a", startMinute: 85, endMinute: 115 }], options),
    [{ id: "a", anchorY: 100, labelY: 85 }],
  );
});

test("相邻锚点按标签高度与间距下推", () => {
  const result = placeCallouts([
    { id: "a", startMinute: 40, endMinute: 50 },
    { id: "b", startMinute: 50, endMinute: 60 },
  ], options);
  assert.equal(result[1].labelY - result[0].labelY, 36);
});

test("末尾越界时回推且全部标签留在画布内", () => {
  const result = placeCallouts([
    { id: "a", startMinute: 150, endMinute: 160 },
    { id: "b", startMinute: 180, endMinute: 190 },
  ], options);
  assert.equal(result[1].labelY, 170);
  assert.ok(result.every((item) => item.labelY >= 0 && item.labelY + 30 <= 200));
});

test("标签总高超过画布时均匀退化且不抛异常", () => {
  const result = placeCallouts(
    Array.from({ length: 8 }, (_, index) => ({
      id: String(index),
      startMinute: index * 5,
      endMinute: index * 5 + 2,
    })),
    { ...options, canvasHeight: 100 },
  );
  assert.equal(result.length, 8);
  assert.equal(result[0].labelY, 0);
  assert.equal(result[7].labelY, 70);
  assert.ok(result.every((item) => item.labelY >= 0 && item.labelY + 30 <= 100));
});

test("23px 及以下牵线，24px 不牵线", () => {
  assert.equal(needsCallout(24, 1), false);
  assert.equal(needsCallout(23, 1), true);
  assert.equal(needsCallout(46, 0.5), true);
  assert.equal(needsCallout(48, 0.5), false);
});
