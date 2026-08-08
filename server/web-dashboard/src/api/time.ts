/**
 * [INPUT]: 依赖 core.ts 的单 Token 传输层与 types.ts 的时间领域响应契约。
 * [OUTPUT]: 提供全部 `/v1/time/*` 时间账本请求、默认全量的不可覆盖修改版本及唯一共享的 health 读取。
 * [POS]: 时间页面的 API 门面；禁止页面自行拼装域前缀。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { request, type RequestOptions } from "./core";
import type { AuditEvent, Configuration, GapsResponse, Health, RangeSummary, Segment, TimezoneHistoryMode } from "../types";

type ReadOptions = Pick<RequestOptions, "signal">;
type CategoryOrProject = Configuration["categories"][number] | Configuration["projects"][number];

export const timeApi = {
  health: () => request<Health>("GET", "/v1/health"),
  configuration: (options: ReadOptions = {}) => request<Configuration>("GET", "/v1/time/configuration", options),
  updateSettings: (settings: Configuration["settings"]) => request<{ settings: Configuration["settings"] }>("PUT", "/v1/time/configuration", { body: { settings } }),
  updateTimezone: (timezone: string, historyMode: TimezoneHistoryMode) => request<Pick<Configuration, "timezone" | "timezoneSource" | "resolvedTimezone" | "currentSystemTimezone"> & { historyMode: TimezoneHistoryMode; convertedSegments: number }>("PUT", "/v1/time/configuration", { body: { timezone, historyMode } }),
  segments: (params: { from?: string; to?: string; source?: string; includeDeleted?: boolean; offset?: number; limit?: number } = {}, options: ReadOptions = {}) => request<{ segments: Segment[]; total: number }>("GET", "/v1/time/segments", { params, signal: options.signal }),
  createSegment: (body: Record<string, unknown>) => request<{ segment: Segment; closedPrevious: Segment | null }>("POST", "/v1/time/segments", { body }),
  updateSegment: (id: string, body: Record<string, unknown>) => request<{ segment: Segment }>("PUT", `/v1/time/segments/${encodeURIComponent(id)}`, { body }),
  deleteSegment: (id: string, reason: string) => request<{ segment: Segment }>("DELETE", `/v1/time/segments/${encodeURIComponent(id)}`, { body: { reason, operator: "dashboard" } }),
  summary: (from: string, to: string, options: ReadOptions = {}) => request<RangeSummary>("GET", "/v1/time/summary/range", { params: { from, to }, signal: options.signal }),
  gaps: (date: string, options: ReadOptions = {}) => request<GapsResponse>("GET", "/v1/time/gaps", { params: { date }, signal: options.signal }),
  auditEvents: (options: ReadOptions = {}) => request<AuditEvent[]>("GET", "/v1/time/audit/events", { signal: options.signal }),
  masterOperation: (body: Record<string, unknown>) => request<{ ok: true; entity: CategoryOrProject }>("POST", "/v1/time/agent/operations", { body }),
};
