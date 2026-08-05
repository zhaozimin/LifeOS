/**
 * [INPUT]: 依赖 src/lib/timeline.ts 的墙钟坐标、UTC 日界、单日裁剪、覆盖窗口、超长软标记判定与文案、空白推导与日期序列纯函数。
 * [OUTPUT]: 提供普通日、DST 回拨/前拨真实时长、午夜前跳日不存在午夜的保守降级、折叠片段保守投影、扣除守恒、超长软标记、gap 和周日数组的 Node 回归测试。
 * [POS]: web-dashboard 的时间轴领域变异锁；无需浏览器即可验证 UTC 算时长、墙钟只排版、DST 日禁用拖拽及超长只提示不拒绝。
 *   日界解析被日/周页在 render 期直接调用，所以「不抛错」本身就是一条被锁死的契约。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  dayRange,
  daysInRange,
  deriveDayGaps,
  epochMinute,
  formatEpochMinute,
  isSegmentOverlong,
  isWallClockEditSafe,
  localDayAbsoluteMinutes,
  OVERLONG_SEGMENT_LABEL,
  sliceSegmentForDay,
} from "./src/lib/timeline.ts";

function segment({
  id = "segment",
  startedAt,
  endedAt,
  startedUtc = `${startedAt}:00+00:00`,
  endedUtc = endedAt ? `${endedAt}:00+00:00` : null,
  deductionMinutes = 0,
  overlong,
}) {
  return {
    id,
    title: id,
    category: { name: "写作", nature: "core" },
    projectName: null,
    startedAt,
    endedAt,
    startedUtc,
    endedUtc,
    deductionMinutes,
    deductionNote: null,
    tags: [],
    note: null,
    source: "agent",
    createdAt: "2026-07-27T00:00:00Z",
    updatedAt: "2026-07-27T00:00:00Z",
    deletedAt: null,
    grossMinutes: null,
    pureMinutes: null,
    ...(overlong === undefined ? {} : { overlong }),
  };
}

test("墙上分钟与绝对分钟坐标可逆，跨午夜不依赖浏览器时区", () => {
  for (const value of ["2026-07-28T00:00", "2026-07-28T09:59", "2026-07-29T00:01"]) {
    assert.equal(formatEpochMinute(epochMinute(value)), value);
  }
  assert.equal(
    formatEpochMinute(epochMinute("2026-07-28T23:59") + 2),
    "2026-07-29T00:01",
  );
});

test("秋季回拨普通片段用 UTC 显示真实 180 分钟并停用墙钟拖拽", () => {
  const clock = {
    timeZone: "America/Los_Angeles",
    nowUtc: "2026-11-02T20:00:00+00:00",
  };
  const item = segment({
    startedAt: "2026-11-01T00:30",
    endedAt: "2026-11-01T02:30",
    startedUtc: "2026-11-01T07:30:00+00:00",
    endedUtc: "2026-11-01T10:30:00+00:00",
    deductionMinutes: 30,
  });
  const slice = sliceSegmentForDay(item, "2026-11-01", "2026-11-02T12:00", clock);

  assert.equal(localDayAbsoluteMinutes("2026-11-01", clock.timeZone), 1500);
  assert.deepEqual(slice && {
    startMinute: slice.startMinute,
    endMinute: slice.endMinute,
    gross: slice.gross,
    pure: slice.pure,
    wallClockDiscontinuity: slice.wallClockDiscontinuity,
  }, {
    startMinute: 30,
    endMinute: 150,
    gross: 180,
    pure: 150,
    wallClockDiscontinuity: true,
  });
  assert.equal(isWallClockEditSafe(item, "2026-11-01", "2026-11-02T12:00", clock), false);
});

test("秋季回拨中墙钟倒挂但 UTC 正向的片段不消失", () => {
  const clock = {
    timeZone: "America/Los_Angeles",
    nowUtc: "2026-11-02T20:00:00+00:00",
  };
  const item = segment({
    startedAt: "2026-11-01T01:50",
    endedAt: "2026-11-01T01:10",
    startedUtc: "2026-11-01T08:50:00+00:00",
    endedUtc: "2026-11-01T09:10:00+00:00",
    deductionMinutes: 2,
  });
  const slice = sliceSegmentForDay(item, "2026-11-01", "2026-11-02T12:00", clock);

  assert.deepEqual(slice && {
    start: slice.start,
    end: slice.end,
    startMinute: slice.startMinute,
    endMinute: slice.endMinute,
    gross: slice.gross,
    pure: slice.pure,
    wallClockDiscontinuity: slice.wallClockDiscontinuity,
  }, {
    start: "2026-11-01T01:50",
    end: "2026-11-01T01:10",
    startMinute: 60,
    endMinute: 120,
    gross: 20,
    pure: 18,
    wallClockDiscontinuity: true,
  });
});

test("跨回拨午夜按 UTC 日界分片并让扣除守恒", () => {
  const clock = {
    timeZone: "America/Los_Angeles",
    nowUtc: "2026-11-03T20:00:00+00:00",
  };
  const item = segment({
    startedAt: "2026-10-31T23:00",
    endedAt: "2026-11-01T07:00",
    startedUtc: "2026-11-01T06:00:00+00:00",
    endedUtc: "2026-11-01T15:00:00+00:00",
    deductionMinutes: 9,
  });
  const first = sliceSegmentForDay(item, "2026-10-31", "2026-11-03T12:00", clock);
  const second = sliceSegmentForDay(item, "2026-11-01", "2026-11-03T12:00", clock);

  assert.deepEqual(
    [first?.gross, first?.pure, second?.gross, second?.pure],
    [60, 59, 480, 472],
  );
  assert.equal(
    (first?.gross ?? 0) - (first?.pure ?? 0)
      + (second?.gross ?? 0) - (second?.pure ?? 0),
    9,
  );
});

test("春季前拨日也是 24 小时墙钟排版、真实 1380 分钟领域日", () => {
  assert.equal(localDayAbsoluteMinutes("2026-03-08", "America/Los_Angeles"), 1380);
  const clock = {
    timeZone: "America/Los_Angeles",
    nowUtc: "2026-03-09T20:00:00+00:00",
  };
  const item = segment({
    startedAt: "2026-03-08T01:30",
    endedAt: "2026-03-08T03:30",
    startedUtc: "2026-03-08T09:30:00+00:00",
    endedUtc: "2026-03-08T10:30:00+00:00",
  });
  const slice = sliceSegmentForDay(item, "2026-03-08", "2026-03-09T12:00", clock);
  assert.equal(slice?.gross, 60);
  assert.equal(slice?.wallClockDiscontinuity, true);
});

test("午夜前跳区里不存在的 00:00 保守降级，不再抛错打穿 render", () => {
  // America/Santiago 2026-09-06：当地 24:00 直接跳成 01:00，00:00–00:59 这一小时根本不存在。
  // 旧实现的定点迭代在跳变两侧 ±60 分钟震荡到耗尽后抛 RangeError；而日界解析全在 render 期，
  // 一抛就把切换日与其前一日的日/周时间轴连同整页一起打成白屏。
  // 降级口径：取「这一自然日真正开始的那一瞬」，于是该日就是真实的 23 小时。
  assert.equal(localDayAbsoluteMinutes("2026-09-06", "America/Santiago"), 1380);
  // 前一日的右开边界正是那个不存在的午夜，但它自己仍是完整 24 小时，不许被降级路径削掉。
  assert.equal(localDayAbsoluteMinutes("2026-09-05", "America/Santiago"), 1440);
  // 换一个午夜前跳区结论一致——这是这一族时区的性质，不是某个 IANA 的特例。
  assert.equal(localDayAbsoluteMinutes("2026-03-29", "Asia/Beirut"), 1380);
  // 同一时区的午夜回拨日午夜是存在的，必须继续走最早候选分支，25 小时不能被降级路径吃掉。
  assert.equal(localDayAbsoluteMinutes("2026-04-04", "America/Santiago"), 1500);
});

test("午夜前跳日照常裁片、推空白，并按既有 DST 口径停用墙钟拖拽", () => {
  const clock = {
    timeZone: "America/Santiago",
    nowUtc: "2026-09-07T20:00:00+00:00",
  };
  const item = segment({
    startedAt: "2026-09-06T01:30",
    endedAt: "2026-09-06T02:30",
    startedUtc: "2026-09-06T04:30:00+00:00",
    endedUtc: "2026-09-06T05:30:00+00:00",
  });
  const slice = sliceSegmentForDay(item, "2026-09-06", "2026-09-07T12:00", clock);

  assert.deepEqual(slice && {
    startMinute: slice.startMinute,
    endMinute: slice.endMinute,
    gross: slice.gross,
    pure: slice.pure,
  }, {
    startMinute: 90,
    endMinute: 150,
    gross: 60,
    pure: 60,
  });
  // 该日绝对分钟数不是 1440，按既有口径直接判为不可拖拽，无需为前跳另立一套判据。
  assert.equal(isWallClockEditSafe(item, "2026-09-06", "2026-09-07T12:00", clock), false);
  // 墙钟仍只负责 0–1440 排版：被跳过的那一小时照常留在首段空白里，不做特殊挖空。
  assert.deepEqual(deriveDayGaps([item], "2026-09-06", "2026-09-07T12:00", clock), [
    { start: "2026-09-06T00:00", end: "2026-09-06T01:30", minutes: 90 },
    { start: "2026-09-06T02:30", end: "2026-09-07T00:00", minutes: 1290 },
  ]);
});

test("短时段保留真实分钟高度", () => {
  const slice = sliceSegmentForDay(
    segment({ startedAt: "2026-07-28T10:00", endedAt: "2026-07-28T10:04" }),
    "2026-07-28",
    "2026-07-28T12:00",
  );
  assert.deepEqual(slice, {
    start: "2026-07-28T10:00",
    end: "2026-07-28T10:04",
    startMinute: 600,
    endMinute: 604,
    gross: 4,
    pure: 4,
    wallClockDiscontinuity: false,
  });
});

test("跨午夜按累计差值分摊扣除且总量守恒", () => {
  const item = segment({
    startedAt: "2026-07-27T23:10",
    endedAt: "2026-07-28T00:50",
    deductionMinutes: 3,
  });
  const first = sliceSegmentForDay(item, "2026-07-27", "2026-07-29T12:00");
  const second = sliceSegmentForDay(item, "2026-07-28", "2026-07-29T12:00");

  assert.deepEqual(
    [first?.gross, first?.pure, second?.gross, second?.pure],
    [50, 48, 50, 49],
  );
  assert.equal(
    (first?.gross ?? 0) - (first?.pure ?? 0)
      + (second?.gross ?? 0) - (second?.pure ?? 0),
    3,
  );
});

test("扣除分摊与服务端半偶舍入保持一致", () => {
  const item = segment({
    startedAt: "2026-07-27T23:00",
    endedAt: "2026-07-29T01:00",
    deductionMinutes: 13,
  });
  const first = sliceSegmentForDay(item, "2026-07-27", "2026-07-30T12:00");
  const middle = sliceSegmentForDay(item, "2026-07-28", "2026-07-30T12:00");
  const last = sliceSegmentForDay(item, "2026-07-29", "2026-07-30T12:00");

  assert.deepEqual(
    [first, middle, last].map((slice) => (slice?.gross ?? 0) - (slice?.pure ?? 0)),
    [0, 12, 1],
  );
});

test("历史日覆盖全天并推导午夜边界 gap", () => {
  const gaps = deriveDayGaps(
    [segment({ startedAt: "2026-07-27T23:00", endedAt: "2026-07-28T01:30" })],
    "2026-07-28",
    "2026-07-29T12:00",
  );
  assert.deepEqual(gaps, [{
    start: "2026-07-28T01:30",
    end: "2026-07-29T00:00",
    minutes: 1350,
  }]);
  assert.deepEqual(dayRange("2026-07-28", "2026-07-29T12:00"), {
    start: "2026-07-28T00:00",
    end: "2026-07-29T00:00",
    elapsedMinutes: 1440,
  });
});

test("今日 gap 只计算到当前分钟并合并重叠区间", () => {
  const gaps = deriveDayGaps([
    segment({ id: "a", startedAt: "2026-07-28T09:00", endedAt: "2026-07-28T10:00" }),
    segment({ id: "b", startedAt: "2026-07-28T09:30", endedAt: "2026-07-28T10:30" }),
  ], "2026-07-28", "2026-07-28T11:00");

  assert.deepEqual(gaps, [
    { start: "2026-07-28T00:00", end: "2026-07-28T09:00", minutes: 540 },
    { start: "2026-07-28T10:30", end: "2026-07-28T11:00", minutes: 30 },
  ]);
});

test("未来日没有覆盖窗口、时段切片和 gap", () => {
  const item = segment({
    startedAt: "2026-07-29T09:00",
    endedAt: "2026-07-29T10:00",
  });
  assert.deepEqual(dayRange("2026-07-29", "2026-07-28T11:00"), {
    start: "2026-07-29T00:00",
    end: "2026-07-29T00:00",
    elapsedMinutes: 0,
  });
  assert.equal(sliceSegmentForDay(item, "2026-07-29", "2026-07-28T11:00"), null);
  assert.deepEqual(deriveDayGaps([item], "2026-07-29", "2026-07-28T11:00"), []);
});

test("已闭合超长时段只采信服务端 overlong，前端不重算毛分钟数", () => {
  // 2026-07-31 那条被补到 16h42m 的「睡觉」：吞掉整个白天，正是软标记要拦下的现象。
  const overnight = {
    startedAt: "2026-07-30T23:00",
    endedAt: "2026-07-31T15:42",
  };
  assert.equal(
    isSegmentOverlong(segment({ ...overnight, overlong: true }), 480, "2026-08-01T09:00:00Z"),
    true,
  );
  // 服务端说不超长就是不超长；1002 分钟摆在眼前也不许前端另开一个比较点。
  assert.equal(
    isSegmentOverlong(segment({ ...overnight, overlong: false }), 480, "2026-08-01T09:00:00Z"),
    false,
  );
  // 旧服务端不发这个字段时视为未标记，而不是猜测。
  assert.equal(
    isSegmentOverlong(segment(overnight), 480, "2026-08-01T09:00:00Z"),
    false,
  );
  // 已闭合分支与阈值无关，配置还没到手也照样显示服务端的结论。
  assert.equal(
    isSegmentOverlong(segment({ ...overnight, overlong: true }), null, "2026-08-01T09:00:00Z"),
    true,
  );
});

test("进行中时段由前端用配置阈值和已过分钟补判，严格超过才可疑", () => {
  const open = segment({ id: "睡觉", startedAt: "2026-07-31T00:00", endedAt: null });

  assert.equal(isSegmentOverlong(open, 480, "2026-07-31T07:59:00Z"), false);
  // 恰好 480 分钟不标记，与服务端 gross > OVERLONG_SEGMENT_MINUTES 的严格大于同构。
  assert.equal(isSegmentOverlong(open, 480, "2026-07-31T08:00:00Z"), false);
  assert.equal(isSegmentOverlong(open, 480, "2026-07-31T08:01:00Z"), true);
  // 阈值来自服务端配置：换一个阈值，判定跟着换，前端没有第二个 480。
  assert.equal(isSegmentOverlong(open, 600, "2026-07-31T08:01:00Z"), false);
  assert.equal(isSegmentOverlong(open, 600, "2026-07-31T10:01:00Z"), true);
  // 时钟回跳导致已过分钟为负也不能标记。
  assert.equal(isSegmentOverlong(open, 480, "2026-07-30T20:00:00Z"), false);
});

test("阈值缺失或非正数时进行中一律不标记，宁可漏报也不评判", () => {
  const running = segment({ startedAt: "2026-07-31T00:00", endedAt: null });
  for (const threshold of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isSegmentOverlong(running, threshold, "2026-07-31T20:00:00Z"), false);
  }
  assert.equal(isSegmentOverlong(running, 480, "2026-07-31T20:00:00Z"), true);
});

test("超长软标记文案是钦定金样，时间轴各处共用同一份", () => {
  assert.equal(OVERLONG_SEGMENT_LABEL, "可疑 · 超长未闭合");
});

test("跨夜吞天：整条超长而每一片都不超长，周视图必须按整条判定", () => {
  // 2026-07-31 的真实形态：一条 23:00 起、次日 15:42 才闭合的「睡觉」，共 16h42m。
  const swallowed = segment({
    id: "睡觉",
    startedAt: "2026-07-30T23:00",
    endedAt: "2026-07-31T15:42",
    overlong: true,
  });

  // 整条：服务端已判超长，前端直接采信。
  assert.equal(isSegmentOverlong(swallowed, 480, "2026-07-31T16:00:00Z"), true);

  // 但按日界裁开后，没有任何一片够得上 8 小时——
  // 周视图若按 slice 判定，最刺眼的那条反而一个标记都不会出现。
  const slices = ["2026-07-30", "2026-07-31"].map((day) =>
    sliceSegmentForDay(swallowed, day, "2026-07-31T16:00"),
  );
  assert.equal(slices.every((slice) => slice !== null), true);
  assert.deepEqual(slices.map((slice) => slice.gross), [60, 942]);
  assert.equal(slices[0].gross <= 480, true);

  // 第二片确实超过 480，但这是巧合而非依据：把它挪成两片各 8 小时以内，
  // 整条仍然超长——判定的主语只能是时段本身。
  const evenlySplit = segment({
    id: "跨夜均分",
    startedAt: "2026-07-30T20:00",
    endedAt: "2026-07-31T04:30",
    overlong: true,
  });
  const evenSlices = ["2026-07-30", "2026-07-31"].map((day) =>
    sliceSegmentForDay(evenlySplit, day, "2026-07-31T16:00"),
  );
  assert.deepEqual(evenSlices.map((slice) => slice.gross), [240, 270]);
  assert.equal(evenSlices.every((slice) => slice.gross <= 480), true);
  assert.equal(isSegmentOverlong(evenlySplit, 480, "2026-07-31T16:00:00Z"), true);
});

test("日期范围包含首尾并可直接生成一周七列", () => {
  assert.deepEqual(daysInRange("2026-07-27", "2026-08-02"), [
    "2026-07-27",
    "2026-07-28",
    "2026-07-29",
    "2026-07-30",
    "2026-07-31",
    "2026-08-01",
    "2026-08-02",
  ]);
  assert.deepEqual(daysInRange("2026-08-02", "2026-07-27"), []);
});
