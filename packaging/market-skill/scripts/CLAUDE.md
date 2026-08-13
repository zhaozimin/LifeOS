# scripts/
> L2 | 父级: ../CLAUDE.md

市场 Skill 的执行层。本目录在仓库里只有两个源文件；其余成员全部由 `make_skill_bundle.py` 在构建时从真源复制进来，仓库不留副本。

## 成员清单（构建后形态）

lifeos_setup.py: 市场形态的安装运维薄封装（仓库源）；把「payload 就在身边、自己已住在某个宿主里」翻译成 lifeos_bootstrap 的 `--payload` 与 `--exclude-host`，不实现任何安装逻辑。
lifeos_bootstrap.py: 安装编排层（构建时复制自 skills/zzm-lifeos-install/scripts/）；`--payload` 分支走随包清单还原发布树，其余编排（预检→原子交换→自启→health→回滚）与 GitHub 路径逐行相同。
lifeos_source.py: 发布树来源层（构建时复制，同上）；manifest 裁定与逐文件 sha256 还原都在这里。
lifeos_deploy.py: 升级文件系统事务（构建时复制，同上）。
lifeconn.py / timectl.py / finctl.py / timeview.py / finview.py / timeclock.py / time_commands.py / install_lifeos_router.py: 记录期执行层（构建时复制自 skills/zzm-lifeos/scripts/），行为与仓库内 zzm-lifeos 完全一致。

法则：`Secret` 是访问密钥在进程内的唯一形态；所有子进程输出转发给用户前必须过 `scrub`。失败必须带「下一步」。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
