/**
 * [INPUT]: 依赖 react 的 createContext/useContext；由 App 注入其 recordTimeZone 状态的唯一写入口。
 * [OUTPUT]: 对外提供 RecordTimeZoneProvider 与 useRecordTimeZoneChange。
 * [POS]: components 的应用级状态桥。记录时区真源在 App，但改写它的表单在
 *   `/settings/:panelId` 这条 Route 之下——中间隔着 Layout 与 Outlet，setter 传不下去。
 *   本文件只把「变更通知」这一条能力下放，不下放读取口径：日/统计页仍从 App 拿 prop，
 *   保证渲染时区只有一个来源，杜绝两条读取路径漂移。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

type RecordTimeZoneChange = (timeZone: string) => void;

const RecordTimeZoneChangeContext = createContext<RecordTimeZoneChange | null>(null);

export function RecordTimeZoneProvider({
  onChange,
  children,
}: {
  onChange: RecordTimeZoneChange;
  children: ReactNode;
}) {
  return (
    <RecordTimeZoneChangeContext.Provider value={onChange}>
      {children}
    </RecordTimeZoneChangeContext.Provider>
  );
}

export function useRecordTimeZoneChange(): RecordTimeZoneChange {
  const onChange = useContext(RecordTimeZoneChangeContext);
  // 缺 Provider 时宁可炸掉：静默吞掉时区变更正是日历不刷新的成因，不能再退回空实现
  if (!onChange) {
    throw new Error("useRecordTimeZoneChange 必须在 RecordTimeZoneProvider 之内使用。");
  }
  return onChange;
}
