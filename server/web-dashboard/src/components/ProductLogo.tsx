/**
 * [INPUT]: 依赖 LifeOS 的时间×金钱品牌语义和主题 primary token；不依赖任何图标库。
 * [OUTPUT]: 对外提供可缩放的 LifeOS 图标与文字标识。
 * [POS]: shell 的品牌原语；登录门和导航壳共享，不承担域切换。
 *        几何与 docs/assets/logo.svg、public/ 下的 PWA 图标同源——表盘是时间，
 *        右下角压边的 ¥ 是金钱，两半共用一个入口。品牌标识刻意内联而不从图标库引入：
 *        lucide 之类的通用库随 npm update 变形，而 logo 变形没有任何测试会变红。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export function ProductLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <svg
          width={18}
          height={18}
          viewBox="0 0 512 512"
          fill="none"
          role="img"
          aria-label="LifeOS"
        >
          <circle cx="220" cy="220" r="140" stroke="currentColor" strokeWidth="46" />
          <path
            d="M220 138v82l58 34"
            stroke="currentColor"
            strokeWidth="46"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* 角标压在表盘边缘：外圈用容器底色让出一道缝，两半才读成一个整体而非两枚贴纸 */}
          <circle cx="382" cy="382" r="122" className="fill-primary" />
          <circle cx="382" cy="382" r="98" fill="currentColor" />
          <path
            d="M347 342l35 40 35-40M382 380v62M354 396h56M354 420h56"
            className="stroke-primary"
            strokeWidth="26"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {!compact && <span className="serif text-[20px] font-semibold tracking-tight">LifeOS</span>}
    </div>
  );
}
