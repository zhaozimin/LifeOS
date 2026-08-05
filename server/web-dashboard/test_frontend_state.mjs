/**
 * [INPUT]: 依赖 lib/dates、lib/autocomplete、lib/export 的页面状态与数据主权纯函数。
 * [OUTPUT]: 锁定筛选/组合框、全量分页与导出白名单保留冻结 IANA/nullable 系统候选、UTC 锚点且不泄露 Token。
 * [POS]: web-dashboard 的前端状态回归层；用 Node 内建测试覆盖无需 DOM 的关键交互与导出不变量。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import assert from "node:assert/strict";
import test from "node:test";
import { firstEnabledOptionIndex, selectedOptionIndex } from "./src/lib/autocomplete.ts";
import {
  buildTimeOSExport,
  collectAllSegments,
  serializeTimeOSExport,
  timeOSExportFileName,
} from "./src/lib/export.ts";
import { rangeForStatsMode, selectStatsMode } from "./src/lib/dates.ts";

test("统计刷新只重算快捷模式，不覆盖自定义范围", () => {
  const custom = ["2026-07-01", "2026-07-05"];
  assert.equal(rangeForStatsMode("custom", "2026-07-30", "sunday", custom), custom);
  assert.deepEqual(rangeForStatsMode("today", "2026-07-30", "monday", custom), ["2026-07-30", "2026-07-30"]);
  assert.deepEqual(rangeForStatsMode("week", "2026-07-30", "monday", custom), ["2026-07-27", "2026-08-02"]);
  assert.deepEqual(rangeForStatsMode("week", "2026-07-30", "sunday", custom), ["2026-07-26", "2026-08-01"]);
  assert.deepEqual(selectStatsMode("month", "2026-07-30", "monday", custom), {
    mode: "month",
    range: ["2026-07-01", "2026-07-30"],
  });
});

test("组合框打开时保持当前有效选项，回退时跳过禁用项", () => {
  const options = [
    { value: "system", disabled: true },
    { value: "America/Los_Angeles" },
    { value: "Asia/Shanghai" },
  ];
  assert.equal(selectedOptionIndex(options, "Asia/Shanghai"), 2);
  assert.equal(selectedOptionIndex(options, "missing"), 1);
  assert.equal(firstEnabledOptionIndex(options), 1);
});

test("全量导出按 offset 翻页且每页显式包含已删除记录", async () => {
  const all = Array.from({ length: 5 }, (_, index) => segment(`segment-${index}`, `2026-07-0${index + 1}T09:00`));
  const requests = [];
  const result = await collectAllSegments(async (request) => {
    requests.push(request);
    return { segments: all.slice(request.offset, request.offset + request.limit), total: all.length };
  }, { pageSize: 2 });

  assert.deepEqual(result.map((item) => item.id), all.map((item) => item.id));
  assert.deepEqual(requests.map(({ offset, limit, includeDeleted }) => ({ offset, limit, includeDeleted })), [
    { offset: 0, limit: 2, includeDeleted: true },
    { offset: 2, limit: 2, includeDeleted: true },
    { offset: 4, limit: 2, includeDeleted: true },
  ]);
});

test("当前无分页接口一次返回全量时不会重复请求", async () => {
  const all = [segment("one", "2026-07-01T09:00"), segment("two", "2026-07-02T09:00")];
  let calls = 0;
  const result = await collectAllSegments(async () => {
    calls += 1;
    return { segments: all, total: all.length };
  }, { pageSize: 1 });
  assert.equal(calls, 1);
  assert.equal(result.length, 2);
});

test("分页无进展时硬失败，不静默生成残缺导出", async () => {
  const first = segment("same", "2026-07-01T09:00");
  await assert.rejects(
    collectAllSegments(async () => ({ segments: [first], total: 2 }), { pageSize: 1 }),
    /只取得 1 条/,
  );
});

test("JSON 导出只复制业务白名单字段并稳定排序，不泄露 Token", () => {
  const configuration = {
    natures: ["core", "support", "recovery", "leisure"],
    categories: [{ id: "category-core", name: "开发", nature: "core", keywords: ["代码"] }],
    projects: [{ id: "project-one", name: "TimeOS", status: "active" }],
    settings: { weekStart: "monday" },
    timezone: "",
    timezoneSource: "system",
    resolvedTimezone: "America/Los_Angeles",
    currentSystemTimezone: null,
    accessToken: "TOP-SECRET-TOKEN",
  };
  const later = { ...segment("later", "2026-07-02T09:00"), secret: "SEGMENT-SECRET" };
  const earlier = { ...segment("earlier", "2026-07-01T09:00"), deletedAt: "2026-07-03T00:00:00Z" };
  const payload = buildTimeOSExport(configuration, [later, earlier], "2026-07-30T12:34:56.789Z");
  const json = serializeTimeOSExport(payload);

  assert.deepEqual(payload.segments.map((item) => item.id), ["earlier", "later"]);
  assert.deepEqual(payload.counts, { segments: 2, deletedSegments: 1, categories: 1, projects: 1 });
  assert.equal(json.includes("TOP-SECRET-TOKEN"), false);
  assert.equal(json.includes("SEGMENT-SECRET"), false);
  assert.equal(payload.configuration.resolvedTimezone, "America/Los_Angeles");
  assert.equal(payload.configuration.currentSystemTimezone, null);
  assert.equal(payload.segments[0].startedUtc, "2026-07-01T16:00:00+00:00");
  assert.equal(payload.segments[0].endedUtc, "2026-07-01T17:00:00+00:00");
  assert.equal(json.endsWith("\n"), true);
  assert.equal(timeOSExportFileName(payload.exportedAt), "timeos-export-20260730T123456Z.json");
});

function segment(id, startedAt) {
  return {
    id,
    title: id,
    category: { name: "开发", nature: "core" },
    projectName: null,
    startedAt,
    endedAt: `${startedAt.slice(0, 11)}10:00`,
    startedUtc: `${startedAt.slice(0, 10)}T16:00:00+00:00`,
    endedUtc: `${startedAt.slice(0, 10)}T17:00:00+00:00`,
    deductionMinutes: 0,
    deductionNote: null,
    tags: [],
    note: null,
    source: "manual",
    createdAt: "2026-07-30T00:00:00Z",
    updatedAt: "2026-07-30T00:00:00Z",
    deletedAt: null,
    grossMinutes: 60,
    pureMinutes: 60,
  };
}
