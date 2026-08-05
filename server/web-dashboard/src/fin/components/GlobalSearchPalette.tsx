import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { ArrowLeftRight, ArrowDownRight, ArrowUpRight, FolderKanban, Landmark, Search, Tags, UserSquare } from "lucide-react";
import type { Account, CategoryRef, Counterparty, Project, Transaction } from "../types";
import { formatCurrency } from "../lib/format";

interface Props {
  open: boolean;
  onClose: () => void;
  transactions: Transaction[];
  accounts: Account[];
  projects: Project[];
  categories: CategoryRef[];
  counterparties: Counterparty[];
}

interface ResultGroup {
  key: string;
  label: string;
  items: Array<{
    id: string;
    title: string;
    subtitle?: string;
    onSelect: () => void;
    icon: React.ReactNode;
  }>;
}

export function GlobalSearchPalette({
  open,
  onClose,
  transactions,
  accounts,
  projects,
  categories,
  counterparties,
}: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setTimeout(() => inputRef.current?.focus(), 50);
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  // 输入变更时复位高亮到第 0 项
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const groups = useMemo<ResultGroup[]>(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];

    const txMatches = transactions
      .filter((tx) =>
        [tx.title, tx.merchant, tx.note, tx.accountName, tx.category?.name, tx.projectName, ...(tx.tags || [])]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(needle)),
      )
      .slice(0, 8)
      .map((tx) => ({
        id: tx.id,
        title: tx.title,
        subtitle: `${tx.occurredAt.slice(0, 10)} · ${tx.accountName} · ${formatCurrency(tx.amount)}`,
        icon: tx.kind === "income" ? <ArrowDownRight size={14} /> : tx.kind === "expense" ? <ArrowUpRight size={14} /> : <ArrowLeftRight size={14} />,
        onSelect: () => {
          sessionStorage.setItem("ledger-search-q", tx.title);
          onClose();
          navigate("/fin/ledger");
        },
      }));

    const accMatches = accounts
      .filter((a) => a.name.toLowerCase().includes(needle))
      .slice(0, 5)
      .map((a) => ({
        id: a.id,
        title: a.name,
        subtitle: `${a.classification === "liability" ? "负债" : "资产"} · ${formatCurrency(a.currentBalance ?? a.openingBalance ?? 0)}`,
        icon: <Landmark size={14} />,
        onSelect: () => {
          sessionStorage.setItem("settings-target-panel", "accounts");
          onClose();
          navigate("/settings/finance-accounts");
        },
      }));

    const projMatches = projects
      .filter((p) => p.name.toLowerCase().includes(needle))
      .slice(0, 5)
      .map((p) => ({
        id: p.id,
        title: p.name,
        subtitle: p.note || (p.trackingEnabled ? "追踪中" : "未追踪"),
        icon: <FolderKanban size={14} />,
        onSelect: () => {
          sessionStorage.setItem("settings-target-panel", "projects");
          onClose();
          navigate("/settings/finance-projects");
        },
      }));

    const catMatches = categories
      .filter((c) => c.name.toLowerCase().includes(needle))
      .slice(0, 5)
      .map((c) => ({
        id: c.id || c.name,
        title: c.name,
        subtitle: `${c.direction || "支出"} · ${(c.keywords || []).slice(0, 3).join(", ") || "无关键词"}`,
        icon: <Tags size={14} />,
        onSelect: () => {
          sessionStorage.setItem("settings-target-panel", "categories");
          onClose();
          navigate("/settings/finance-categories");
        },
      }));

    const cpMatches = counterparties
      .filter((cp) => cp.name.toLowerCase().includes(needle))
      .slice(0, 5)
      .map((cp) => ({
        id: cp.id,
        title: cp.name,
        subtitle: cp.kind,
        icon: <UserSquare size={14} />,
        onSelect: () => {
          sessionStorage.setItem("settings-target-panel", "counterparties");
          onClose();
          navigate("/settings/finance-counterparties");
        },
      }));

    return [
      { key: "tx", label: "交易", items: txMatches },
      { key: "acc", label: "账户", items: accMatches },
      { key: "proj", label: "项目", items: projMatches },
      { key: "cat", label: "分类", items: catMatches },
      { key: "cp", label: "对手方", items: cpMatches },
    ].filter((g) => g.items.length > 0);
  }, [query, transactions, accounts, projects, categories, counterparties, navigate, onClose]);

  const flatItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // 上下键 + 回车 + Esc
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (flatItems.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((prev) => (prev + 1) % flatItems.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((prev) => (prev - 1 + flatItems.length) % flatItems.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        flatItems[activeIndex]?.onSelect();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, flatItems, activeIndex]);

  // 高亮项滚动到可见
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLButtonElement>(`[data-search-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  const totalCount = groups.reduce((sum, g) => sum + g.items.length, 0);

  // 各 group 的起始全局序号，方便给行加 data-search-idx
  let runningIdx = 0;

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-start justify-center px-4 pt-[14vh]" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-[640px] overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search size={16} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索交易 / 账户 / 项目 / 分类 / 对手方…（Esc 退出）"
            className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground/60"
          />
          <span className="hidden rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
            ⌘K
          </span>
        </div>
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto">
          {!query.trim() && (
            <div className="px-4 py-12 text-center text-[13px] text-muted-foreground">
              开始输入关键词以搜索全部数据。
            </div>
          )}
          {query.trim() && totalCount === 0 && (
            <div className="px-4 py-12 text-center text-[13px] text-muted-foreground">
              没有匹配「{query}」的结果
            </div>
          )}
          {groups.map((group) => (
            <div key={group.key} className="border-b border-border last:border-0">
              <div className="px-4 py-2 text-caption-uppercase">{group.label}</div>
              {group.items.map((item) => {
                const idx = runningIdx++;
                const isActive = idx === activeIndex;
                return (
                  <button
                    key={`${group.key}-${item.id}`}
                    type="button"
                    data-search-idx={idx}
                    onClick={item.onSelect}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={`flex w-full items-center gap-3 border-t border-border/50 px-4 py-2.5 text-left text-[13px] transition-colors first:border-t-0 ${
                      isActive ? "bg-primary/10 text-foreground" : "hover:bg-muted/40"
                    }`}
                  >
                    <span className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                      isActive ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
                    }`}>
                      {item.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">{item.title}</span>
                      {item.subtitle && (
                        <span className="block truncate text-[11.5px] text-muted-foreground">{item.subtitle}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {flatItems.length > 0 && (
          <div className="border-t border-border bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
            <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono">↑↓</kbd> 选择 ·
            <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono ml-1">Enter</kbd> 跳转 ·
            <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono ml-1">Esc</kbd> 关闭
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
