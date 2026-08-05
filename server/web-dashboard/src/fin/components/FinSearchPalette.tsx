/**
 * [INPUT]: 依赖 finApi 的只读主数据/流水请求与 GlobalSearchPalette 的交互显示。
 * [OUTPUT]: 仅在用户打开 ⌘K 时加载财务搜索语料并渲染原有命令面板。
 * [POS]: fin 域的按需搜索适配层，避免统一 shell 在常驻状态预取任何业务数据。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useEffect, useState } from "react";
import { finApi } from "../../api/fin";
import type { Configuration, Transaction } from "../types";
import { GlobalSearchPalette } from "./GlobalSearchPalette";

export function FinSearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void Promise.all([finApi.listTransactions({ limit: 2000 }), finApi.configuration()]).then(([nextTransactions, nextConfiguration]) => {
      if (!alive) return;
      setTransactions(nextTransactions);
      setConfiguration(nextConfiguration);
    }).catch(() => {
      if (!alive) return;
      setTransactions([]);
      setConfiguration(null);
    });
    return () => { alive = false; };
  }, [open]);

  return <GlobalSearchPalette
    open={open}
    onClose={onClose}
    transactions={transactions}
    accounts={configuration?.accounts || []}
    projects={configuration?.settings.projects || []}
    categories={configuration?.categories || []}
    counterparties={configuration?.settings.counterparties || []}
  />;
}
