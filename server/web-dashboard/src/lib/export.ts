/**
 * [INPUT]: 依赖含非空 resolvedTimezone/nullable currentSystemTimezone 的 Configuration、UTC Segment 与分页读取函数。
 * [OUTPUT]: 对外提供全量去重分页收集、保留冻结 IANA/nullable 系统候选与 UTC 锚点的白名单 JSON、稳定序列化和文件名纯函数。
 * [POS]: lib 的数据主权边界；排除密钥与未知字段，同时保住跨机器后仍可重建墙钟和绝对顺序的真源。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import type { Configuration, Segment } from "../types";

export interface SegmentPage {
  segments: Segment[];
  total: number;
}

export interface SegmentPageRequest {
  offset: number;
  limit: number;
  includeDeleted: true;
  signal?: AbortSignal;
}

export type SegmentPageReader = (request: SegmentPageRequest) => Promise<SegmentPage>;

export interface TimeOSExport {
  kind: "timeos-export";
  schemaVersion: 1;
  exportedAt: string;
  scope: "all";
  includesDeleted: true;
  configuration: Configuration;
  segments: Segment[];
  counts: {
    segments: number;
    deletedSegments: number;
    categories: number;
    projects: number;
  };
}

const DEFAULT_PAGE_SIZE = 500;
const MAX_EXPORT_PAGES = 10_000;

export async function collectAllSegments(
  readPage: SegmentPageReader,
  options: { pageSize?: number; signal?: AbortSignal } = {},
): Promise<Segment[]> {
  const pageSize = Math.max(1, Math.floor(options.pageSize || DEFAULT_PAGE_SIZE));
  const segments: Segment[] = [];
  const seen = new Set<string>();
  let offset = 0;

  for (let pageNumber = 0; pageNumber < MAX_EXPORT_PAGES; pageNumber += 1) {
    options.signal?.throwIfAborted();
    const page = await readPage({ offset, limit: pageSize, includeDeleted: true, signal: options.signal });
    if (!Array.isArray(page.segments) || !Number.isInteger(page.total) || page.total < 0) {
      throw new Error("TimeOS 返回了无效的导出分页响应。");
    }

    let added = 0;
    for (const segment of page.segments) {
      if (!segment?.id || seen.has(segment.id)) continue;
      seen.add(segment.id);
      segments.push(segment);
      added += 1;
    }

    if (segments.length >= page.total) return segments;
    if (page.segments.length === 0 || added === 0) {
      throw new Error(`导出未完成：服务端声明 ${page.total} 条，但只取得 ${segments.length} 条。`);
    }
    offset += page.segments.length;
  }

  throw new Error("导出分页超过安全上限，已停止以避免生成不完整文件。");
}

export function buildTimeOSExport(
  configuration: Configuration,
  segments: readonly Segment[],
  exportedAt = new Date().toISOString(),
): TimeOSExport {
  const safeConfiguration: Configuration = {
    natures: [...configuration.natures],
    categories: configuration.categories.map((category) => ({
      id: category.id,
      name: category.name,
      nature: category.nature,
      keywords: [...category.keywords],
      ...(category.builtin === undefined ? {} : { builtin: category.builtin }),
      ...(category.protected === undefined ? {} : { protected: category.protected }),
    })),
    projects: configuration.projects.map((project) => ({
      id: project.id,
      name: project.name,
      status: project.status,
    })),
    settings: { weekStart: configuration.settings.weekStart },
    timezone: configuration.timezone,
    timezoneSource: configuration.timezoneSource,
    resolvedTimezone: configuration.resolvedTimezone,
    currentSystemTimezone: configuration.currentSystemTimezone,
  };
  const safeSegments = segments.map(copySegment).sort((left, right) => (
    left.startedUtc.localeCompare(right.startedUtc) || left.id.localeCompare(right.id)
  ));

  return {
    kind: "timeos-export",
    schemaVersion: 1,
    exportedAt,
    scope: "all",
    includesDeleted: true,
    configuration: safeConfiguration,
    segments: safeSegments,
    counts: {
      segments: safeSegments.length,
      deletedSegments: safeSegments.filter((segment) => !!segment.deletedAt).length,
      categories: safeConfiguration.categories.length,
      projects: safeConfiguration.projects.length,
    },
  };
}

export function serializeTimeOSExport(payload: TimeOSExport): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function timeOSExportFileName(exportedAt: string): string {
  const stamp = exportedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `timeos-export-${stamp}.json`;
}

function copySegment(segment: Segment): Segment {
  return {
    id: segment.id,
    title: segment.title,
    category: { name: segment.category.name, nature: segment.category.nature },
    projectName: segment.projectName,
    startedAt: segment.startedAt,
    endedAt: segment.endedAt,
    startedUtc: segment.startedUtc,
    endedUtc: segment.endedUtc,
    deductionMinutes: segment.deductionMinutes,
    deductionNote: segment.deductionNote,
    tags: [...segment.tags],
    note: segment.note,
    source: segment.source,
    createdAt: segment.createdAt,
    updatedAt: segment.updatedAt,
    deletedAt: segment.deletedAt,
    deletedBy: segment.deletedBy,
    deletionReason: segment.deletionReason,
    autoClosedBy: segment.autoClosedBy,
    grossMinutes: segment.grossMinutes,
    pureMinutes: segment.pureMinutes,
  };
}
