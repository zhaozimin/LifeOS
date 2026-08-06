# skills/zzm-lifeos/
> L2 | 父级: ../CLAUDE.md

成员清单
SKILL.md: 单一薄入口（≤60 行）；带 name/description 前言供 Agent 发现，按部署、时间、财务三分意图加载按需协议，常驻层只保留两域通用的字段推断五级顺序、混合句拆两笔与 display 回执边界。
agents/openai.yaml: 面向 Codex 的 LifeOS 技能元数据。
references/time-recording.md: 时间记录语义、钟点与 display 规则；时间行五符号字典真源。
references/fin-bookkeeping.md: 财务字段、结构化信用卡还款护栏、新建路径 90 秒重复闸的确认纪律（收到 409 duplicate_record 禁止自动重试，须先只读核对既有那一笔并向用户确认，确认是另一笔才带 --allow-duplicate）、导入重复风险与账务行回显规则；账务行六符号字典真源。
references/deployment.md: 单进程安装、隔离演练、旧双安装迁移、旧双指针归档、Tailscale 与生产切换边界。
scripts/: 安全连接、时间/财务命令和展示纯函数；局部地图见 `scripts/CLAUDE.md`。

法则：一个句子同时含时间与金钱时，必须拆成 time 与 fin 两笔真实写入；两笔各自输出自身 display，绝不混成一行。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

