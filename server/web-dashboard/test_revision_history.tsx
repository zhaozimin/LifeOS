/**
 * [INPUT]: 依赖 @testing-library/react 的真实渲染与 RevisionHistoryModal 的服务端版本投影。
 * [OUTPUT]: 锁定旧内容灰色删除线、新内容正常显示、AI 操作者和删除原因可见四条契约。
 * [POS]: web-dashboard 的数据安全组件变异锁；样式和文字必须真实进入 DOM 才算可见历史。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { RevisionHistoryModal } from "./src/components/RevisionHistoryModal";
import type { AuditEvent } from "./src/types";

function event(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    id: "revision-1",
    occurredAt: "2026-08-03T12:00:00+00:00",
    actor: "agent",
    action: "update",
    entityType: "transaction",
    entityId: "tx-1",
    entityName: "午饭",
    impact: {},
    payload: {
      before: { title: "午饭（AI 记错）", amount: 25, kind: "expense", accountName: "微信", category: { name: "餐饮" }, occurredAt: "2026-08-03T12:00:00+08:00" },
      after: { title: "午饭", amount: 28, kind: "expense", accountName: "微信", category: { name: "餐饮" }, occurredAt: "2026-08-03T12:00:00+08:00" },
      reason: "用户确认更正",
    },
    ...overrides,
  };
}

test("修改记录把旧内容显示成灰色删除线，新内容保持正常样式", () => {
  render(<RevisionHistoryModal open onClose={() => {}} events={[event({})]} entityType="transaction" />);

  const oldVersion = screen.getByText(/午饭（AI 记错）/);
  const newVersion = screen.getByText(/^午饭 · 支出/);
  expect(oldVersion).toHaveClass("text-slate-500", "line-through", "decoration-slate-400");
  expect(newVersion).not.toHaveClass("line-through");
  expect(screen.getByText("AI Agent")).toBeInTheDocument();
  expect(screen.getByText("修改：名称、金额")).toBeInTheDocument();
  expect(screen.getByText("原因：用户确认更正")).toBeInTheDocument();
});

test("删除记录只留下带灰色删除线的原内容和删除原因", () => {
  const deleted = event({
    id: "revision-delete",
    action: "delete",
    payload: {
      before: { title: "重复午饭", amount: 25, kind: "expense", accountName: "微信", category: { name: "餐饮" }, occurredAt: "2026-08-03T12:00:00+08:00" },
      after: { title: "重复午饭", amount: 25, kind: "expense", accountName: "微信", category: { name: "餐饮" }, occurredAt: "2026-08-03T12:00:00+08:00", deletedAt: "2026-08-03T13:00:00+00:00" },
      reason: "重复记录",
    },
  });
  render(<RevisionHistoryModal open onClose={() => {}} events={[deleted]} entityType="transaction" />);

  const oldVersion = screen.getByText(/重复午饭/);
  expect(oldVersion).toHaveClass("line-through", "decoration-slate-400");
  expect(screen.getByText("原因：重复记录")).toBeInTheDocument();
  expect(screen.getAllByText(/重复午饭/)).toHaveLength(1);
});
