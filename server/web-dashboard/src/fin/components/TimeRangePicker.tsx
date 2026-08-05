/**
 * [INPUT]: 依赖 store/timeRange 的 dimension/bucket 与 reconcileBucket、lib/timeRange 的 deriveBuckets、共享 Tabs 与财务 Autocomplete。
 * [OUTPUT]: 对外提供 TimeRangePicker（维度 tab + 仅有流水的具体区间下拉），并转出 transactionMatchesRange 供旧调用点复用。
 * [POS]: 财务时间范围栏的选择器；桶列表在这里推导，因此「显示的区间必须就是过滤用的区间」这条不变式也由这里闭合——
 *   算出的有效桶同步写回 store，页面只读 store，两边不可能各说各话。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useEffect, useMemo } from "react";
import { CategoryTabs } from "../../components/ui/Tabs";
import { Autocomplete } from "./ui/Autocomplete";
import { reconcileBucket, useTimeRangeStore, type TimeDimension } from "../store/timeRange";
import { deriveBuckets, transactionMatchesRange } from "../lib/timeRange";
import type { Transaction } from "../types";

const DIMENSIONS: Array<{ value: TimeDimension; label: string }> = [
  { value: "custom", label: "自定义" },
  { value: "week", label: "本周" },
  { value: "month", label: "本月" },
  { value: "quarter", label: "本季度" },
  { value: "year", label: "本年" },
  { value: "all", label: "全部时间" },
];

const HINT: Record<TimeDimension, string> = {
  custom: "使用侧边栏日历选择区间。",
  week: "仅显示有流水的周次。",
  month: "仅显示有流水的月份。",
  quarter: "仅显示有流水的季度。",
  year: "仅显示有流水的年份。",
  all: "全部时间内的所有流水。",
};

interface Props {
  transactions: Transaction[];
}

/** 智能时间筛选：维度 + 仅有流水的具体值。 */
export function TimeRangePicker({ transactions }: Props) {
  const { dimension, bucket, setDimension, setBucket } = useTimeRangeStore();

  const buckets = useMemo(() => deriveBuckets(transactions, dimension), [transactions, dimension]);

  // store 里的 bucket 可能已经失效（切了维度、那个月的流水被软删、账本本身变了），
  // 归一到当前真实可选的区间——这个值同时用于显示和过滤。
  const effectiveBucket = useMemo(
    () => reconcileBucket(dimension, bucket, buckets),
    [bucket, buckets, dimension],
  );
  // 只算不写就是 #20：picker 显示归一后的月份、页面却拿 store 里的旧月份去过滤，看板一片 ¥0。
  // 桶列表为空时不写：那要么是流水还在路上，要么是空账本——此时写回只会把用户的选择在加载途中抹掉，
  // 而两种情况下过滤结果都是空，显示与过滤不会出现可见分叉。
  useEffect(() => {
    if (buckets.length > 0 && effectiveBucket !== bucket) setBucket(effectiveBucket);
  }, [bucket, buckets, effectiveBucket, setBucket]);

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <span className="block text-[11px] font-semibold tracking-wider uppercase text-muted-foreground mb-1.5">
          时间维度
        </span>
        <CategoryTabs
          value={dimension}
          onChange={(v) => {
            setDimension(v);
            // 自动定位到第一个有数据的 bucket
            const next = deriveBuckets(transactions, v);
            setBucket(next[0]?.value || "");
          }}
          options={DIMENSIONS}
          size="sm"
        />
      </div>
      {dimension !== "all" && dimension !== "custom" && (
        <div className="min-w-[200px]">
          <Autocomplete
            label={LABEL_FOR_DIM[dimension]}
            value={effectiveBucket}
            onChange={(value) => setBucket(value)}
            options={
              buckets.length > 0
                ? buckets
                : [{ value: "", label: "（无流水）", disabled: true }]
            }
            hint={HINT[dimension]}
          />
        </div>
      )}
    </div>
  );
}

const LABEL_FOR_DIM: Record<TimeDimension, string> = {
  custom: "",
  week: "选择周",
  month: "选择月",
  quarter: "选择季度",
  year: "选择年",
  all: "",
};

export { transactionMatchesRange };
