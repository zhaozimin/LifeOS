# packaging/
> L2 | 父级: ../CLAUDE.md

第四条分发路径的源。前三条（AI 引导装、下载 ZIP、从源码装）都以 GitHub Release 为中心，本目录支撑的第四条不依赖任何远端：把整棵发布树塞进一个 Skill，用户在第三方 Skill 市场点一次下载，就在本机拿到了全部源码与安装器。

本目录**刻意不在 `make_release.sh` 的 RELEASE_PATHS 白名单里**——它是构建输入，不是发布物成员。因此它不会随 GitHub 发布包分发，也不会被 payload 递归包进自己。

## 成员清单

market-skill/: 市场 Skill 的覆盖层，只存放「与仓库内 zzm-lifeos 不同的那部分」——统一入口 SKILL.md、离线安装协议 references/installation.md、自足安装器 scripts/lifeos_setup.py。时间与财务协议、ctl 脚本一律由 `make_skill_bundle.py` 在构建时从 `skills/zzm-lifeos/` 复制进来，仓库里不留第二份副本；改协议只改那一份，市场包下次构建自动跟上。

构建入口在仓库根 `make_skill_bundle.py`，进料是 `make_release.sh` 已扫描过的 `dist/lifeos-<版本>/`。市场包因此永远是发布物的派生形态，不可能含有发布物不含的东西。

发布物名字是 `zzm-lifeos-full-<版本>.zip`，**刻意不以 `lifeos-` 开头**：安装器把 `lifeos-<版本>.zip` 认作整套系统的包，任何同前缀的新附件都会让它看见两个候选而按「有歧义不猜」整条拒绝。v1.2.0 就是这么塌的——歧义在 Release 的附件集合里而不在客户端版本里，所以连已经发出去的旧 skill 一起失效。往这个 Release 加任何新附件之前，先去 `test_lifeos_bootstrap.py` 的真实附件集合金样里证明它不制造歧义。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
