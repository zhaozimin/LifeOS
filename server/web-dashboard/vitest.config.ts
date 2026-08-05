/**
 * [INPUT]: 依赖 vite.config.ts 的插件与转译管线、happy-dom 环境与 @testing-library/react。
 * [OUTPUT]: 对外提供组件级回归的运行配置；只收 `test_*.tsx`，纯函数回归仍归 node --test。
 * [POS]: web-dashboard 的第二个测试宿主，专职验证「只有渲染出来才能验」的东西。
 *   为什么必须有它：ErrorBoundary 是本项目两次白屏事故后加的安全网，
 *   而 node --test 连 `.tsx` 都读不了（实测 `Unknown file extension ".tsx"`），
 *   于是它此前只能靠「源码里有没有这行字」的文本断言硬扛——
 *   那种断言挡得住「有人删掉这行」，挡不住「这行在真实渲染里没生效」。
 *   一张没验过的安全网，会在最需要它的那天才告诉你它是破的。
 *   为什么不合并成一个宿主：纯函数回归直接 import 真实 `.ts` 源码、零转译、跑完只要几十毫秒，
 *   是这套代码的主力变异锁；把它们迁进转译管线只会变慢，换不来任何覆盖。
 *   分工按「需不需要 DOM」划，不按文件类型凑。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "happy-dom",
      include: ["test_*.tsx"],
      globals: false,
      restoreMocks: true,
      // 组件测试不该碰网络：任何漏网的真实请求都要当场炸出来，而不是静默挂起。
      setupFiles: ["./test_setup.ts"],
    },
  }),
);
