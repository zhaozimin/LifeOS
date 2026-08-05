# skills/lifeos-install/
> L2 | 父级: ../CLAUDE.md

成员清单
SKILL.md: 薄入口（≤60 行）；带 name/description 前言供 Agent 发现，把「装/看/卸/换宿主」四种意图映射到四条子命令，常驻层只保留六条执行纪律。它不判断任何正确性——域白名单、校验和、目标占用、双 dbPath 归属全在脚本里裁定，这样「Agent 换了个说法」不会变成「安全边界换了个说法」。
scripts/: 引导安装的唯一实现与其纯函数金样；局部地图见 `scripts/CLAUDE.md`。

法则：本 Skill 与 `lifeos` 是先后关系而非并列——它只负责把 LifeOS 从 GitHub Release 装到本机，装完即退场，绝不触碰账本。因此它不 import `lifeos` 的任何脚本：引导阶段那套脚本还没落到本机，依赖它就是循环。

面板地址含访问密钥，是整条链上唯一的明文出口：脚本用 `Secret` 把它挡在 `str()`/`repr()` 之外并对所有子进程输出脱敏，SKILL.md 则规定它只被逐字转达给用户本人一次。两层缺一不可——脚本管「不会漏」，SKILL.md 管「不会被转存」。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
