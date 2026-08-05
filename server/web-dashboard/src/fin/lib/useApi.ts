/**
 * [INPUT]: 依赖 react 的 useEffect/useRef/useState；loader 由调用方提供，本文件不认识任何 API 客户端。
 * [OUTPUT]: 对外提供 useApi —— 返回 { data, error, loading, refresh } 的只读取数 hook。
 * [POS]: fin/lib 的页面取数骨架。loader 存进 ref 后再调用，使调用方可以就地写闭包而不必 useCallback；
 *   真正的重跑时机由 deps 与 refresh 的 tick 共同决定。卸载后用 aborted 挡掉迟到响应，
 *   防止已离开的页面把旧数据写回。只读不写：任何写操作必须走 api 客户端并显式 refresh。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from "react";

interface State<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refresh: () => void;
}

export function useApi<T>(loader: () => Promise<T>, deps: ReadonlyArray<unknown>): State<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    setError(null);
    loaderRef.current()
      .then((value) => {
        if (!aborted) {
          setData(value);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!aborted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });
    return () => {
      aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, error, loading, refresh: () => setTick((t) => t + 1) };
}
