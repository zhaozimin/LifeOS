/**
 * [INPUT]: 依赖 @testing-library/react 的真实渲染与 src/components/ErrorBoundary 真实实现。
 * [OUTPUT]: 锁定渲染故障隔离的四条契约：兜住 render 期抛出、故障半径止于边界内、
 *   重试可复位、resetKey 变化即自救。
 * [POS]: web-dashboard 的组件级变异锁；这些契约只有真的渲染出来才验得了，
 *   源码文本断言挡得住「有人删掉这行」，挡不住「这行在真实渲染里没生效」。
 *   本项目已发生两次白屏事故，ErrorBoundary 是为此加的安全网——没验过的安全网不算安全网。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

// fireEvent 会把事件包进 act()：React 19 下裸 .click() 触发的状态更新不会被冲刷，
// 断言会读到更新前的 DOM——那是测试写法问题，不是产品问题，但足以让人误判。
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { ErrorBoundary } from "./src/components/ErrorBoundary";

/** React 会把捕获到的错误也打进 console.error；测试期静音，避免真实失败被噪音淹没。 */
let quiet: ReturnType<typeof vi.spyOn>;
beforeAll(() => { quiet = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterAll(() => { quiet.mockRestore(); });

function Boom({ message = "渲染炸了" }: { message?: string }): never {
  throw new Error(message);
}

test("子树 render 期抛出被兜住，降级卡片点名区块并给出可转达的摘要", () => {
  render(
    <ErrorBoundary label="财务状况">
      <Boom message="formatAxisCurrency is not defined" />
    </ErrorBoundary>,
  );

  // 不是白屏：降级 UI 真的挂上了 DOM
  expect(document.body.textContent).not.toBe("");
  // 点名是哪一块出的问题——用户得知道该说什么
  expect(screen.getByText(/财务状况/)).toBeInTheDocument();
  // 摘要一行可抄走；这正是上次白屏事故里用户拿不到的东西
  expect(screen.getByText(/formatAxisCurrency is not defined/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /重试/ })).toBeInTheDocument();
});

test("故障半径止于边界内：边界外的顶栏与导航必须仍在 DOM 上", () => {
  // 复刻 Layout 的真实结构——header 与 Sidebar 是 <main> 的兄弟，只有 Outlet 被包住。
  render(
    <div>
      <header>
        <button type="button">刷新数据</button>
      </header>
      <nav>
        <a href="/dashboard/time/day">今天</a>
      </nav>
      <main>
        <ErrorBoundary label="资金流量">
          <Boom />
        </ErrorBoundary>
      </main>
    </div>,
  );

  // 页面炸了，但用户还能点顶栏、还能切页自救——这是把边界放在 <main> 内的全部理由
  expect(screen.getByRole("button", { name: "刷新数据" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "今天" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /重试/ })).toBeInTheDocument();
});

test("重试按钮复位边界；子组件恢复正常后内容真的回来", () => {
  function Flaky() {
    const [ok, setOk] = useState(false);
    return (
      <div>
        <button type="button" onClick={() => setOk(true)}>修好它</button>
        <ErrorBoundary label="试验区">{ok ? <span>内容回来了</span> : <Boom />}</ErrorBoundary>
      </div>
    );
  }

  render(<Flaky />);
  expect(screen.getByRole("button", { name: /重试/ })).toBeInTheDocument();

  // 先让子组件不再抛，再点重试——边界必须重新渲染子树而不是永久停在降级态
  fireEvent.click(screen.getByRole("button", { name: "修好它" }));
  fireEvent.click(screen.getByRole("button", { name: /重试/ }));

  expect(screen.getByText("内容回来了")).toBeInTheDocument();
});

test("resetKey 变化即自救：切页不必先点重试", () => {
  const { rerender } = render(
    <ErrorBoundary label="财务状况" resetKey="/dashboard/fin/status">
      <Boom />
    </ErrorBoundary>,
  );
  expect(screen.getByRole("button", { name: /重试/ })).toBeInTheDocument();

  // 用户切到另一个页面：resetKey 变了，同时子树换成健康组件
  rerender(
    <ErrorBoundary label="今天" resetKey="/dashboard/time/day">
      <span>今天的时间线</span>
    </ErrorBoundary>,
  );

  expect(screen.getByText("今天的时间线")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /重试/ })).not.toBeInTheDocument();
});
