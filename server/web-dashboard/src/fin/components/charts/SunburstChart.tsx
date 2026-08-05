import type { EChartsOption } from "echarts";
import { EChart } from "./EChart";
import { getPalette } from "./theme";
import { useThemeStore } from "../../store/theme";
import { escapeHtml } from "../../lib/format";
import type { SunburstNode } from "../../types";

interface Props {
  data: SunburstNode[];
  height?: number;
}

export function SunburstChart({ data, height = 360 }: Props) {
  const resolved = useThemeStore((s) => s.resolved);
  const paletteId = useThemeStore((s) => s.palette);
  const palette = getPalette(resolved === "dark", paletteId);

  if (!data.length) {
    return <div className="empty-state">本期暂无支出分布</div>;
  }

  const option: EChartsOption = {
    tooltip: {
      trigger: "item",
      formatter: ((params: any) => {
        const path =
          (params.treePathInfo as Array<{ name: string }> | undefined)
            ?.map((p) => p.name)
            .filter(Boolean)
            .slice(1)
            .join(" / ") || params.name;
        const value = Number(params.value || 0);
        return `${escapeHtml(path)}<br/><b>¥${value.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}</b>`;
      }) as any,
    },
    series: [
      {
        type: "sunburst",
        data,
        radius: ["18%", "92%"],
        emphasis: { focus: "ancestor" },
        label: {
          rotate: "tangential",
          color: palette.bg,
          fontFamily: "'Inter', 'Noto Sans SC', sans-serif",
          fontSize: 11,
        },
        levels: [
          {},
          {
            r0: "18%",
            r: "55%",
            label: { rotate: "tangential", fontWeight: 500 },
            itemStyle: { borderRadius: 4, borderColor: palette.bg, borderWidth: 1.5 },
          },
          {
            r0: "55%",
            r: "92%",
            label: { align: "right" },
            itemStyle: { borderRadius: 3, borderColor: palette.bg, borderWidth: 1 },
          },
        ],
      },
    ],
  };

  return <EChart option={option} style={{ width: "100%", height }} />;
}
