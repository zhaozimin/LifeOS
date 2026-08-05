/**
 * [INPUT]: 依赖 TimeOS health API 与浏览器定时器。
 * [OUTPUT]: 对外提供本地节点连接状态，30 秒低频复核且不读取任何用户活动。
 * [POS]: components 的运行状态指示器；只检测服务可达性，不参与记录与统计。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useEffect, useState } from "react";
import { Loader2, Wifi, WifiOff } from "lucide-react";
import { api } from "../api/client";

export function StatusIndicator() {
  const [status, setStatus] = useState<"checking" | "online" | "offline">("checking");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const probe = async () => {
      try {
        await api.health();
        if (active) setStatus("online");
      } catch {
        if (active) setStatus("offline");
      }
      if (active) timer = setTimeout(probe, 30_000);
    };
    void probe();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  const Icon = status === "checking" ? Loader2 : status === "online" ? Wifi : WifiOff;
  return (
    <span className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card/70 px-3 text-xs text-muted-foreground">
      <Icon size={14} className={status === "checking" ? "animate-spin" : status === "online" ? "text-success" : "text-destructive"} />
      {status === "checking" ? "检查中" : status === "online" ? "本地已连接" : "本地未连接"}
    </span>
  );
}
