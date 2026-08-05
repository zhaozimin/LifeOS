import type { Account, Project, Transaction } from "../types";
import { formatCurrency } from "../lib/format";

interface ProjectGoalSummary {
  project: Project;
  current: number;
  target: number;
  percent: number;
  remaining: number;
  daysLeft: number | null;
  overdue: boolean;
}

export function buildSavingsGoalSummaries(
  projects: Project[],
  accounts: Account[],
  transactions: Transaction[],
): ProjectGoalSummary[] {
  const today = new Date();
  return projects
    .filter((p) => p.goal && (p.goal.targetAmount || 0) > 0)
    .map((project) => {
      const goal = project.goal!;
      const target = goal.targetAmount || 0;
      let current = 0;
      // 优先：绑定账户的当前余额
      if (goal.sourceAccountId) {
        const acct = accounts.find((a) => a.id === goal.sourceAccountId);
        if (acct) {
          current = acct.currentBalance ?? acct.openingBalance ?? 0;
        }
      }
      // 否则：累计该项目下所有 income
      if (!goal.sourceAccountId) {
        current = transactions
          .filter((tx) => tx.kind === "income" && tx.projectName === project.name)
          .reduce((sum, tx) => sum + tx.amount, 0);
      }
      const percent = target > 0 ? Math.min(100, (current / target) * 100) : 0;
      const remaining = Math.max(target - current, 0);
      let daysLeft: number | null = null;
      let overdue = false;
      if (goal.targetDate) {
        const target_date = new Date(`${goal.targetDate}T23:59:59`);
        const diff_ms = target_date.getTime() - today.getTime();
        daysLeft = Math.ceil(diff_ms / (1000 * 60 * 60 * 24));
        overdue = daysLeft < 0 && current < target;
      }
      return { project, current, target, percent, remaining, daysLeft, overdue };
    });
}

export function SavingsGoalCard({
  summaries,
  onClick,
}: {
  summaries: ProjectGoalSummary[];
  onClick?: (project: Project) => void;
}) {
  if (!summaries.length) return null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {summaries.map((item) => (
        <SavingsGoalRing key={item.project.id} summary={item} onClick={onClick} />
      ))}
    </div>
  );
}

function SavingsGoalRing({
  summary,
  onClick,
}: {
  summary: ProjectGoalSummary;
  onClick?: (project: Project) => void;
}) {
  const { project, current, target, percent, remaining, daysLeft, overdue } = summary;
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (percent / 100) * circumference;
  const Wrapper: React.ElementType = onClick ? "button" : "div";
  const tone = overdue
    ? { stroke: "stroke-destructive", text: "text-destructive" }
    : percent >= 100
      ? { stroke: "stroke-emerald-500", text: "text-emerald-700 dark:text-emerald-300" }
      : percent >= 60
        ? { stroke: "stroke-emerald-500", text: "text-emerald-700 dark:text-emerald-300" }
        : percent >= 30
          ? { stroke: "stroke-amber-500", text: "text-amber-700 dark:text-amber-300" }
          : { stroke: "stroke-blue-500", text: "text-blue-700 dark:text-blue-300" };

  return (
    <Wrapper
      type={onClick ? "button" : undefined}
      onClick={onClick ? () => onClick(project) : undefined}
      className={`group/goal flex w-full items-center gap-4 rounded-lg border border-border bg-background/40 p-4 text-left transition-colors hover:border-border/80 ${onClick ? "cursor-pointer" : ""}`}
    >
      <div className="relative h-[88px] w-[88px] shrink-0">
        <svg viewBox="0 0 88 88" className="h-full w-full -rotate-90">
          <circle cx="44" cy="44" r={radius} className="fill-none stroke-muted/40" strokeWidth="8" />
          <circle
            cx="44"
            cy="44"
            r={radius}
            className={`fill-none ${tone.stroke}`}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`font-serif text-[18px] tabular-nums ${tone.text}`}>{percent.toFixed(0)}%</span>
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="truncate text-[14.5px] font-semibold text-foreground">{project.name}</div>
        {project.goal?.description && (
          <div className="truncate text-[12px] text-muted-foreground">{project.goal.description}</div>
        )}
        <div className="text-[12.5px] tabular-nums text-muted-foreground">
          {formatCurrency(current)} / {formatCurrency(target)}
        </div>
        <div className={`text-[12px] tabular-nums ${overdue ? "text-destructive" : "text-muted-foreground"}`}>
          {overdue
            ? `已逾期 · 还差 ${formatCurrency(remaining)}`
            : remaining > 0
              ? `差 ${formatCurrency(remaining)}${daysLeft !== null ? ` · 剩 ${daysLeft} 天` : ""}`
              : `已完成${daysLeft !== null && daysLeft >= 0 ? ` · 提前 ${daysLeft} 天` : ""}`}
        </div>
      </div>
    </Wrapper>
  );
}
