/**
 * [INPUT]: 依赖 zustand 的 create 与 persist（localStorage 键 finance-time-range，version 3）。
 * [OUTPUT]: 对外提供 useTimeRangeStore（dimension/bucket 与两个 setter）与 reconcileBucket 归一规则。
 * [POS]: 财务三页共享的时间区间真源；bucket 是不透明区间键，编解码归 fin/lib/timeRange，store 只负责存。
 *   store 跨会话持久化，所以它保存的 bucket 完全可能指向当前账本里已经不存在的区间——
 *   reconcileBucket 就是「显示哪个区间就用哪个区间过滤」这条不变式的落点，
 *   由持有可选桶列表的 TimeRangePicker 负责写回，页面只读不算。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TimeDimension = "all" | "custom" | "week" | "month" | "quarter" | "year";

interface TimeRangeState {
  dimension: TimeDimension;
  /** ISO 形式的具体范围键：custom=YYYY-MM-DD..YYYY-MM-DD / week=YYYY-Www / month=YYYY-MM / quarter=YYYY-Qn / year=YYYY / all="" */
  bucket: string;
  setDimension: (dim: TimeDimension) => void;
  setBucket: (bucket: string) => void;
}

/**
 * 把持久化下来的 bucket 归一到当前真实可选的区间。
 *
 * 事故形态：picker 只在本地算了个「有效桶」用来显示，从不写回 store；
 * store 里那个已经失效的旧 bucket 仍然是页面过滤的依据——下拉写着 7 月、页面按 8 月算，
 * 整块看板一片 ¥0 且没有任何解释。bucket 走 persist，这个错位跨会话长期驻留。
 *
 * 归一只对「按桶枚举」的维度成立：
 * - all 不做裁剪、custom 的键由日历解释，两者的 bucket 都不由桶列表管辖，必须原样返回，
 *   否则一次归一就把用户选定的自定义区间抹掉了；
 * - 桶列表为空时没有可归一的目标，返回空串（= 不裁剪），与 Autocomplete 的「（无流水）」占位同源。
 */
export function reconcileBucket(
  dimension: TimeDimension,
  bucket: string,
  buckets: ReadonlyArray<{ value: string }>,
): string {
  if (dimension === "all" || dimension === "custom") return bucket;
  if (buckets.some((option) => option.value === bucket)) return bucket;
  return buckets[0]?.value ?? "";
}

export const useTimeRangeStore = create<TimeRangeState>()(
  persist(
    (set) => ({
      dimension: "all",
      bucket: "",
      setDimension: (dim) => set({ dimension: dim }),
      setBucket: (bucket) => set({ bucket }),
    }),
    {
      name: "finance-time-range",
      version: 3,
      migrate: () => ({ dimension: "all", bucket: "" }),
    },
  ),
);
