/**
 * [INPUT]: 依赖 @testing-library/react 的真实渲染、被 mock 的 fin api 客户端与图表壳，
 *   以及 src/fin/pages/FlowPage 的真实实现。
 * [OUTPUT]: 锁定财务页取数的两条契约：顶栏刷新信号必须真的触发重取、
 *   流水必须按整本账取而不是分页头部。
 * [POS]: web-dashboard 的组件级取数变异锁。
 *   这两条此前只能靠「源码里有没有这几个字」的文本断言硬扛——
 *   文本断言挡得住「有人删掉依赖数组里的 refreshKey」，
 *   挡不住「Provider 下发的是个常量，于是 refreshKey 永远不变」：#19 正是后者，
 *   顶栏刷新按钮对整个财务侧完全无效，而四页的依赖数组里确实都写着 refreshKey。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { FULL_LEDGER_LIMIT } from "./src/fin/lib/financeAnalytics.ts";

const listTransactions = vi.fn(async () => []);
const configuration = vi.fn(async () => ({
  accounts: [],
  categories: [],
  settings: { ledgerMode: "personal", exchangeRates: { baseCurrency: "CNY", rates: {} } },
}));

vi.mock("./src/fin/api/client", () => ({ api: { listTransactions, configuration } }));
// 图表走 canvas，在 happy-dom 里不可靠；本文件只关心取数，不关心绘制。
vi.mock("./src/fin/components/charts/SankeyChart", () => ({ SankeyChart: () => null }));

/** 刷新信号由 Layout 经 context 下发；这里用可控值替身，好在同一次渲染里推进它。 */
let signal = 0;
vi.mock("./src/components/Layout", () => ({ useRefreshSignal: () => signal }));

const { FlowPage } = await import("./src/fin/pages/FlowPage");

beforeEach(() => {
  signal = 0;
  listTransactions.mockClear();
  configuration.mockClear();
});

test("资金流量按整本账取流水，不留分页截断", async () => {
  render(<FlowPage />);
  await waitFor(() => expect(listTransactions).toHaveBeenCalled());

  // 服务端按 occurred_at DESC 切片，limit 拿到的是「最近 N 条」的头部：
  // 早期的账整体不进页面，桑基缺早期路径、可支撑月数偏差、早期月份从下拉里消失。
  expect(listTransactions).toHaveBeenCalledWith({ limit: FULL_LEDGER_LIMIT });
  expect(FULL_LEDGER_LIMIT).toBeGreaterThanOrEqual(100000);
});

test("顶栏刷新信号推进时，财务页真的重新取数", async () => {
  const { rerender } = render(<FlowPage />);
  await waitFor(() => expect(listTransactions).toHaveBeenCalledTimes(1));
  const configurationCalls = configuration.mock.calls.length;

  // 用户点了顶栏「刷新数据」：信号 +1
  signal = 1;
  rerender(<FlowPage />);

  await waitFor(() => expect(listTransactions).toHaveBeenCalledTimes(2));
  expect(configuration.mock.calls.length).toBeGreaterThan(configurationCalls);
});

test("信号不变时不重复取数——刷新必须由点击驱动，不能每次重渲染都打服务端", async () => {
  const { rerender } = render(<FlowPage />);
  await waitFor(() => expect(listTransactions).toHaveBeenCalledTimes(1));

  rerender(<FlowPage />);
  rerender(<FlowPage />);

  expect(listTransactions).toHaveBeenCalledTimes(1);
  void screen;
});
