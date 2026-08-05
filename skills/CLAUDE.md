# skills/
> L2 | 父级: ../CLAUDE.md

成员清单
lifeos/: LifeOS 的记录技能；薄路由连接时间与财务领域规则，局部地图见 `lifeos/CLAUDE.md`。
lifeos-install/: 引导安装技能；从 GitHub Release 取回整套系统、校验 sha256、部署、装自启并把 lifeos 技能分发进本机各 Agent 宿主，局部地图见 `lifeos-install/CLAUDE.md`。

法则：Skill 只解释用户意图并调用脚本。密钥、日期、账本状态、金额与回执正确性必须由 scripts 的确定性代码裁定。

两个技能是先后关系而非并列：lifeos-install 负责把系统装上本机，装完退场；此后一切记录与查询归 lifeos。因此 lifeos-install 不 import lifeos 的任何脚本——引导阶段那套脚本还没落到本机，依赖它就是循环。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

