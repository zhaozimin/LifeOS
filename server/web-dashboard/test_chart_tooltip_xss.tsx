/**
 * [INPUT]: 依赖 @testing-library/react 的真实渲染、被 mock 的 EChart 壳（捕获真实 option），
 *   以及 fin/components/charts 下各图表的真实实现。
 * [OUTPUT]: 锁定「用户可控字符串进 tooltip HTML 前必须转义」这条纪律的**调用点**，
 *   而不只是 escapeHtml 这个原语本身。
 * [POS]: web-dashboard 的组件级安全变异锁。
 *   ECharts 对**字符串型 tooltip.formatter** 的返回值走 el.innerHTML，
 *   而账户名、分类名、项目名、商户名全是用户与 Agent 可控输入。
 *   本文件不去渲染 canvas（happy-dom 里不可靠），而是把真实 option 里的 formatter 取出来调用，
 *   再把返回的 HTML 塞进真 DOM——注入成功与否由「有没有元素被造出来」判定，
 *   这比断言「源码里有 escapeHtml 这几个字」强得多：后者挡不住 escapeHtml 自己被改坏。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { render } from "@testing-library/react";
import { expect, test, vi } from "vitest";

/** 捕获图表实际下发的 option；组件内的 formatter 闭包因此可被真实调用。 */
const captured: Array<Record<string, any>> = [];
vi.mock("./src/fin/components/charts/EChart", () => ({
  EChart: (props: { option: Record<string, any> }) => {
    captured.push(props.option);
    return null;
  },
}));

const { ThresholdRingChart } = await import("./src/fin/components/charts/ThresholdRingChart");
const { SankeyChart } = await import("./src/fin/components/charts/SankeyChart");
const { AccountBarChart } = await import("./src/fin/components/charts/AccountBarChart");

/** 三种最常见的注入载荷：闭合标签、事件属性、以及不依赖标签的属性逃逸。 */
const PAYLOADS = [
  '<img src=x onerror="globalThis.__pwned=1">',
  '<script>globalThis.__pwned=1</script>',
  '"><svg onload="globalThis.__pwned=1">',
];

/**
 * 把 HTML 塞进真 DOM，返回**由载荷造出来的危险节点**。
 *
 * 不能简单断言「零元素」：tooltip 模板自己就含 <br/> 与 <b>，那是我们的排版标签。
 * 该判的是注入是否成活——脚本/外链元素出现，或任何元素带上了 on* 事件属性。
 */
function dangerousNodesIn(html: string): string[] {
  const host = document.createElement("div");
  host.innerHTML = html;
  const bad: string[] = [];
  for (const el of Array.from(host.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (["script", "img", "svg", "iframe", "object", "embed", "link", "style"].includes(tag)) bad.push(tag);
    for (const attribute of Array.from(el.attributes)) {
      if (attribute.name.toLowerCase().startsWith("on")) bad.push(`${tag}[${attribute.name}]`);
    }
  }
  return bad;
}

function collectFormatters(option: Record<string, any>): Array<(params: any) => any> {
  const found: Array<(params: any) => any> = [];
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.tooltip?.formatter === "function") found.push(node.tooltip.formatter);
    if (Array.isArray(node)) node.forEach(visit);
    else Object.values(node).forEach(visit);
  };
  visit(option);
  return found;
}

test("账户环形图的 tooltip 不把账户名当 HTML 执行", () => {
  for (const payload of PAYLOADS) {
    captured.length = 0;
    (globalThis as any).__pwned = undefined;

    render(
      <ThresholdRingChart
        accounts={[{ name: payload, current: 100, threshold: 200 }]}
        onAccountClick={() => {}}
      />,
    );

    const formatters = collectFormatters(captured[0] ?? {});
    expect(formatters.length, "没有捕获到 tooltip.formatter，测试本身失效了").toBeGreaterThan(0);

    for (const formatter of formatters) {
      const html = String(formatter({ name: payload, data: { name: payload }, value: 1 }));
      // 载荷必须以文本形态出现（说明它确实被渲染了，不是被整段丢弃）
      expect(html).toContain("&lt;");
      // 且不得造出任何元素
      expect(dangerousNodesIn(html), `载荷成活了：${payload}`).toEqual([]);
    }
    expect((globalThis as any).__pwned).toBeUndefined();
  }
});

test("桑基图与账户柱状图的 tooltip 同样不执行用户数据", () => {
  const payload = PAYLOADS[0];

  captured.length = 0;
  render(
    <SankeyChart
      nodes={[{ name: payload }, { name: "工资卡" }]}
      links={[{ source: payload, target: "工资卡", value: 100 }]}
    />,
  );
  for (const formatter of collectFormatters(captured[0] ?? {})) {
    for (const params of [
      { dataType: "edge", data: { source: payload, target: "工资卡", value: 100 } },
      { dataType: "node", data: { name: payload }, name: payload },
    ]) {
      expect(dangerousNodesIn(String(formatter(params)))).toEqual([]);
    }
  }

  captured.length = 0;
  render(<AccountBarChart data={[{ name: payload, amount: 100, color: "#000" }]} />);
  for (const formatter of collectFormatters(captured[0] ?? {})) {
    const html = String(formatter([{ name: payload, value: 100, data: { name: payload } }]));
    expect(dangerousNodesIn(html)).toEqual([]);
  }
});
