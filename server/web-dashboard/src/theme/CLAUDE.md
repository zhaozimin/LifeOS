# theme/
> L2 | 父级: ../CLAUDE.md

成员清单
base.ts: 主题类型、token 派生与 `makeTheme`，不含具体色板数据。
index.ts: 71 套主题的唯一聚合注册表、查询与 CSS token 应用接口。
palettes/: 每组至多 9 个色板的数据分片，局部地图见 `palettes/CLAUDE.md`。

法则：主题数据只在 palettes/ 出现；时间、财务和图表只从 index.ts 读取同一套色板。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
