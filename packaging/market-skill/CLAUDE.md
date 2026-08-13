# market-skill/
> L2 | 父级: ../CLAUDE.md

市场 Skill 的覆盖层。构建时 `make_skill_bundle.py` 会把本目录整个复制成包体骨架，再往里补三样东西：`skills/zzm-lifeos/references/` 的三份协议、`skills/zzm-lifeos/scripts/` 的八个 ctl 脚本、以及 `payload/`（发布树的可逆镜像 + manifest.json）。**本目录里出现的每个文件都必须是「市场形态独有」的**，凡是能从 zzm-lifeos 复制的都不许在这里留副本。

## 成员清单

SKILL.md: 统一入口与安全宪法；四分意图路由（安装运维/时间/财务/查询）、字段推断五级顺序、混合句拆两笔、回执长度硬要求、面板密钥一次性交付。`{{VERSION}}` 占位符由构建器替换。
README.md: 给上传者与市场审核者看的包体说明——包里有什么、扩展名为什么带 .txt 后缀、全程不出网的隐私边界。`{{VERSION}}`/`{{FILE_COUNT}}`/`{{TREE_SHA256}}` 由构建器替换。
references/installation.md: 离线安装协议。与 zzm-lifeos 的 deployment.md 分工：那份讲「已装好的系统怎么迁移、远程访问、排查」，本份只讲「从包内 payload 到一个跑起来的服务」这一段。
references/time-recording.md / fin-bookkeeping.md / deployment.md: 构建时槽位；仓库里只是指回真源的占位页，出包时被 `skills/zzm-lifeos/references/` 的同名真源原样覆盖——占位让发布物里 SKILL.md 的相对链接永远解析得到，覆盖让协议永远只有一份。
scripts/: 市场形态的执行层；仓库里只有薄封装 lifeos_setup.py 与地图，安装编排器与 ctl 脚本全部构建时复制，局部地图见 `scripts/CLAUDE.md`。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
