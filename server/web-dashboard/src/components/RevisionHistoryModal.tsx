/**
 * [INPUT]: 依赖共享 Modal、服务端 AuditEvent 的真实 before/after 版本与打开状态。
 * [OUTPUT]: 对外提供时间/账目共用的修改痕迹弹窗；旧版本统一灰色删除线，新版本正常显示。
 * [POS]: components 的跨域审计可视化；只展示服务端已经落库的事实，不推测或改写记录。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { Bot, History, UserRound } from "lucide-react";
import type { AuditEvent } from "../types";
import { Modal } from "./ui/Modal";

type RecordValue = Record<string, unknown> | null | undefined;

const ACTION_LABEL: Record<string, string> = { create: "新增", update: "修改", delete: "删除", restore: "恢复" };
const FIELD_LABEL: Record<string, string> = {
  title: "名称", amount: "金额", kind: "类型", occurredAt: "时间", category: "分类",
  accountName: "账户", fromAccountName: "转出账户", toAccountName: "转入账户",
  projectName: "项目", startedAt: "开始时间", endedAt: "结束时间",
  deductionMinutes: "扣除时间", note: "备注", tags: "标签", reimbursementStatus: "报销状态",
};
const COMPARED_FIELDS = Object.keys(FIELD_LABEL);

function text(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join("、") || "—";
  if (typeof value === "object") {
    const named = value as { name?: unknown };
    return typeof named.name === "string" ? named.name : JSON.stringify(value);
  }
  return String(value);
}

function changedFields(before: RecordValue, after: RecordValue): string[] {
  if (!before || !after) return [];
  return COMPARED_FIELDS
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => FIELD_LABEL[key]);
}

function recordSummary(value: RecordValue, entityType: string): string {
  if (!value) return "";
  if (entityType === "segment") {
    const parts = [text(value.title), text(value.category), `${text(value.startedAt)} → ${text(value.endedAt)}`];
    if (value.projectName) parts.push(`项目：${text(value.projectName)}`);
    if (Number(value.deductionMinutes || 0) > 0) parts.push(`扣除 ${text(value.deductionMinutes)} 分钟`);
    if (value.note) parts.push(`备注：${text(value.note)}`);
    return parts.join(" · ");
  }
  const kind = { income: "收入", expense: "支出", transfer: "转账" }[String(value.kind)] || text(value.kind);
  const account = value.kind === "transfer" ? `${text(value.fromAccountName)} → ${text(value.toAccountName)}` : text(value.accountName);
  const parts = [text(value.title), `${kind} ¥${Number(value.amount || 0).toLocaleString("zh-CN")}`, account, text(value.category), text(value.occurredAt)];
  if (value.projectName) parts.push(`项目：${text(value.projectName)}`);
  if (value.note) parts.push(`备注：${text(value.note)}`);
  return parts.join(" · ");
}

function actorLabel(actor: string): string {
  if (["agent", "openClaw"].includes(actor)) return "AI Agent";
  if (["dashboard", "manual"].includes(actor)) return "用户手动";
  if (actor === "import") return "导入";
  return actor;
}

export function RevisionHistoryModal({ open, onClose, events, loading = false, error = "", entityType }: {
  open: boolean;
  onClose: () => void;
  events: AuditEvent[];
  loading?: boolean;
  error?: string;
  entityType: "segment" | "transaction";
}) {
  const revisions = events.filter((event) => event.entityType === entityType && ["create", "update", "delete", "restore"].includes(event.action));
  return (
    <Modal open={open} onClose={onClose} title="修改痕迹" description="这里显示已经保存到本地账本的真实版本。灰色删除线是旧内容或删除内容；当前统计只读取最新有效版本。">
      <div className="max-h-[62vh] space-y-3 overflow-y-auto pr-1">
        {loading && <p className="py-8 text-center text-sm text-muted-foreground">正在读取本地修改历史…</p>}
        {!loading && error && <p className="rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-sm text-destructive">{error}</p>}
        {!loading && !error && revisions.length === 0 && <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground"><History size={22} /><p className="text-sm">还没有修改痕迹。</p></div>}
        {!loading && !error && revisions.map((event) => {
          const before = event.payload.before;
          const after = event.payload.after;
          const fields = changedFields(before, after);
          const isAgent = ["agent", "openClaw"].includes(event.actor);
          return (
            <article key={event.id} className="rounded-lg border border-border bg-muted/20 p-3.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{ACTION_LABEL[event.action] || event.action}</span>
                <span className="inline-flex items-center gap-1">{isAgent ? <Bot size={13} /> : <UserRound size={13} />}{actorLabel(event.actor)}</span>
                <time>{new Date(event.occurredAt).toLocaleString("zh-CN")}</time>
              </div>
              {fields.length > 0 && <p className="mt-2 text-xs text-muted-foreground">修改：{fields.join("、")}</p>}
              {event.payload.reason && <p className="mt-1 text-xs text-muted-foreground">原因：{event.payload.reason}</p>}
              {before && <p className="mt-2 text-sm leading-6 text-slate-500 line-through decoration-slate-400 decoration-1">{recordSummary(before, entityType)}</p>}
              {after && event.action !== "delete" && <p className="mt-1 text-sm leading-6 text-foreground">{recordSummary(after, entityType)}</p>}
            </article>
          );
        })}
      </div>
    </Modal>
  );
}
