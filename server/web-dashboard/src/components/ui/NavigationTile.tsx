/**
 * [INPUT]: 依赖 lucide-react 图标类型与 clsx 的状态类合并能力。
 * [OUTPUT]: 对外提供 NavigationTile，统一侧边栏 2×2 导航块的选中、默认与悬停外观。
 * [POS]: components/ui 的导航原语；Sidebar 注入路由语义并消费其选中与悬停状态，
 *   财务设计系统页把同一实现当作活文档渲染。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";

export function NavigationTile({
  icon: Icon,
  label,
  active = false,
  className,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "flex h-14 w-full flex-col items-center justify-center gap-1 rounded-md border text-[12.5px] font-semibold transition-colors",
        active
          ? "border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground"
          : "border-sidebar-border bg-background/35 text-muted-foreground hover:bg-sidebar-accent/55 hover:text-sidebar-foreground",
        className,
      )}
    >
      <Icon size={16} />
      <span className="whitespace-nowrap">{label}</span>
    </span>
  );
}
