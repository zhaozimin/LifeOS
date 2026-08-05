/**
 * [INPUT]: 依赖 LifeOS 的时间×金钱品牌语义和主题 primary token。
 * [OUTPUT]: 对外提供可缩放的 LifeOS 图标与文字标识。
 * [POS]: shell 的品牌原语；登录门和导航壳共享，不承担域切换。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { HeartPulse } from "lucide-react";

export function ProductLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <HeartPulse size={18} strokeWidth={2.2} />
      </span>
      {!compact && <span className="serif text-[20px] font-semibold tracking-tight">LifeOS</span>}
    </div>
  );
}
