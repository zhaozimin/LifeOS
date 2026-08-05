import { Building2, User, Layers } from "lucide-react";
import clsx from "clsx";
import { useViewStore } from "../store/view";
import type { ViewMode } from "../types";

const options: Array<{ value: ViewMode; label: string; icon: React.ReactNode }> = [
  { value: "company", label: "公司", icon: <Building2 size={13} /> },
  { value: "personal", label: "个人", icon: <User size={13} /> },
  { value: "combined", label: "合并", icon: <Layers size={13} /> },
];

export function ViewSwitcher({ orientation = "horizontal" }: { orientation?: "horizontal" | "vertical" }) {
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);

  return (
    <div
      role="tablist"
      aria-label="账户视角"
      className={clsx(
        "inline-flex p-1 rounded-md bg-sidebar-accent/60 border border-sidebar-border",
        orientation === "horizontal" ? "flex-row gap-1 w-full" : "flex-col gap-1 w-full",
      )}
    >
      {options.map((opt) => {
        const active = opt.value === view;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => setView(opt.value)}
            className={clsx(
              "inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[12px] font-medium transition-colors flex-1",
              active
                ? "bg-sidebar text-sidebar-foreground shadow-sm"
                : "text-muted-foreground hover:text-sidebar-foreground",
            )}
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
