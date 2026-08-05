/**
 * [INPUT]: 依赖 TimeOS `/v1/*` 的 camelCase JSON 契约。
 * [OUTPUT]: 对外提供含非空 resolvedTimezone 冻结 IANA 与 nullable currentSystemTimezone 候选 IANA 的 health/configuration、带 overlong 软标记的 UTC 时段、不可覆盖修改版本、主数据、统计和错误类型。
 * [POS]: web-dashboard 的领域类型边界；页面和 API 客户端共享，禁止各页复制响应形状。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export type Nature = "core" | "support" | "recovery" | "leisure";
export type SegmentSource = "agent" | "manual" | "import";
export type TimezoneHistoryMode = "convert" | "preserve";

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actor: string;
  action: "create" | "update" | "delete" | "restore" | string;
  entityType: string;
  entityId: string;
  entityName: string;
  impact: Record<string, unknown>;
  payload: {
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    reason?: string | null;
  };
}

export interface Health {
  status: string;
  version: string;
  buildId: string;
  port: number;
  dbPath: string;
  pid: number;
  timezone: string;
  timezoneSource: "system" | "config";
  resolvedTimezone: string;
  currentSystemTimezone: string | null;
  domains?: {
    time: {
      dbPath: string;
      timezone: string;
      timezoneSource: "system" | "config";
      resolvedTimezone: string;
      currentSystemTimezone: string | null;
    };
    finance: { dbPath: string; lastIngestedAt: string | null };
  };
}

export interface Category {
  id: string;
  name: string;
  nature: Nature;
  keywords: string[];
  builtin?: boolean;
  protected?: boolean;
}

export interface Project {
  id: string;
  name: string;
  status: string;
}

export interface Segment {
  id: string;
  title: string;
  category: { name: string; nature: Nature };
  projectName: string | null;
  startedAt: string;
  endedAt: string | null;
  startedUtc: string;
  endedUtc: string | null;
  deductionMinutes: number;
  deductionNote: string | null;
  tags: string[];
  note: string | null;
  source: SegmentSource;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedBy?: string | null;
  deletionReason?: string | null;
  autoClosedBy?: string | null;
  grossMinutes: number | null;
  pureMinutes: number | null;
  // 服务端软标记：已闭合且毛分钟数越过 overlongSegmentMinutes 才为 true，进行中时段恒为 false。
  // 服务端不写此字段时视为未标记，只提示不拒绝，绝不影响时段本身的呈现。
  overlong?: boolean;
}

export interface Configuration {
  natures: Nature[];
  categories: Category[];
  projects: Project[];
  settings: { weekStart: "monday" | "sunday" };
  timezone: string;
  timezoneSource: "system" | "config";
  resolvedTimezone: string;
  currentSystemTimezone: string | null;
  // 超长软标记阈值（分钟）；前端判定「进行中且已跑超阈值」的唯一来源，禁止硬编码 480。
  // 可选是为了兼容尚未发布该字段的旧服务端：缺失时进行中时段一律不标记，已闭合仍采信 overlong。
  overlongSegmentMinutes?: number;
}

export interface DaySummary {
  date: string;
  effectiveWorkMinutes: number;
  grossMinutes: number;
  recordedMinutes: number;
  gapMinutes: number;
  coverage: number;
  partial: boolean;
}

export interface RangeSummary {
  from: string;
  to: string;
  byNature: Array<{ nature: Nature; grossMinutes: number; pureMinutes: number }>;
  byCategory: Array<{ name: string; nature: Nature; grossMinutes: number; pureMinutes: number; segmentCount: number }>;
  byProject: Array<{ projectName: string; grossMinutes: number; pureMinutes: number; segmentCount: number }>;
  effectiveWorkMinutes: number;
  grossWorkMinutes: number;
  recordedMinutes: number;
  gapMinutes: number;
  deductionMinutes: number;
  coverage: number;
  days: DaySummary[];
}

export interface Gap {
  start: string;
  end: string;
  minutes: number;
}

export interface GapsResponse {
  date: string;
  gaps: Gap[];
  recordedMinutes: number;
  gapMinutes: number;
  coverage: number;
  openSegment: { id: string; title: string; startedAt: string; ageMinutes: number } | null;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  valid?: string[];
  conflicts?: Array<{ id: string; title: string; startedAt: string; endedAt: string | null }>;
}
