/**
 * [INPUT]: 依赖 react 的 Component/ErrorInfo、lucide-react 图标与 ui 的 Button/Card 原语。
 * [OUTPUT]: 对外提供 ErrorBoundary class 组件，把子树 render 期异常收敛成可重试的降级卡片。
 * [POS]: components 的渲染故障隔离层；全站唯一的 componentDidCatch 承载点。
 *   由 Layout 套在 <Outlet/> 外侧，故障半径止于内容区——顶栏、Sidebar 与主题壳都在它外面，
 *   页面炸掉时导航仍然可点，用户切页即自救；App 另有一层同款兜底，只为把壳层崩溃从白屏拉回可读。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { TriangleAlert, RotateCcw } from "lucide-react";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";

interface Props {
  /** 出问题的区块名，直接进降级文案；Layout 传当前页面标题。 */
  label: string;
  /** 变化即自动复位。Layout 传 pathname——用户切到别的页面就等于自救，不必先点重试。 */
  resetKey?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// 摘要是「用户能一眼抄走转达的一行」，不是给开发者的完整栈：
// 名字 + 消息足够定位，长栈只会让人复制不全。完整栈走 console。
function summarize(error: Error): string {
  return `${error.name || "Error"}: ${error.message || "（无错误消息）"}`;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  // React 只把 Error 实例之外的抛出物原样带上来，这里统一收敛成 Error，降级 UI 才有稳定字段。
  static getDerivedStateFromError(thrown: unknown): State {
    return { error: thrown instanceof Error ? thrown : new Error(String(thrown)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 白屏事故的教训是「看不见」，不是「日志太多」：这里是唯一的诊断出口，必须留下组件栈。
    console.error(`[ErrorBoundary] 「${this.props.label}」渲染失败`, error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  retry = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <Card role="alert" padding="md" className="my-3 max-w-3xl border-destructive/40">
        <div className="flex items-start gap-3">
          <TriangleAlert size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <h2 className="text-title-md text-foreground">
              「{this.props.label}」这一块没能显示出来
            </h2>
            <p className="mt-1.5 text-[12.5px] leading-6 text-muted-foreground">
              出问题的只有这块内容。顶栏和左上角导航仍然可用，可以先切到别的页面继续记录；
              把下面这行摘要转达给维护者即可定位。
            </p>
            <pre className="mt-3 max-h-40 overflow-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap break-words text-foreground/85">
              {summarize(error)}
            </pre>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-3"
              leading={<RotateCcw size={14} />}
              onClick={this.retry}
            >
              重试
            </Button>
          </div>
        </div>
      </Card>
    );
  }
}
