# domains/
> L2 | 父级: ../CLAUDE.md

成员清单
time/: 时间账本领域；冻结时区、I1–I4、reconcile 与时间域 API 在 P1 从 TimeOS 业务代码整体平移，局部地图见 `time/CLAUDE.md`。
finance/: 财务账本领域；汇率、报销、导入、预算、周期与财务 API 在 P2 从钦定 FinOS 基线函数级平移，局部地图见 `finance/CLAUDE.md`。

法则：两个目录是业务与数据边界，不是命名空间装饰。任一领域只接受自己的 Ledger；共享能力只下沉 core，绝不互相导入 service 或存储层。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
