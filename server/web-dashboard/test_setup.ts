/**
 * [INPUT]: 依赖 @testing-library/jest-dom 的匹配器与 vitest 生命周期钩子。
 * [OUTPUT]: 组件回归的统一前置：每例后卸载 DOM，并把任何真实网络请求变成硬失败。
 * [POS]: vitest.config.ts 指定的唯一 setupFile；不含任何断言，只立规矩。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

beforeEach(() => {
  // 组件回归一律不许出网。漏网的真实请求在 happy-dom 里会静默挂起，
  // 表现为「测试莫名变慢」而不是「测试失败」——那是最难查的一类不稳定。
  // 这里让它当场炸出来，谁需要网络谁自己 mock。
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("组件回归不得发起真实网络请求；请在用例内显式 mock。");
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
