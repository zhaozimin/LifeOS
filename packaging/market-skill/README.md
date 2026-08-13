# zzm-lifeos-full · LifeOS {{VERSION}} 自足安装包

会说话，就会记录人生。LifeOS 是一套跑在**用户自己电脑上**的时间统计 + 个人记账系统：单进程、只监听 `127.0.0.1`、两本永不合库的 SQLite 账本、自带网页面板。本 Skill 把整套系统的发布物揣在兜里，装上 Skill 即拥有全部源码，安装全程**零网络**。

## 这个包里有什么

```
zzm-lifeos-full/
├── SKILL.md                 # 统一入口：安装运维 + 时间记录 + 财务记账 + 查询
├── references/              # 四份协议：离线安装 / 时间 / 财务 / 部署疑难
├── scripts/                 # 安装编排器与记录执行层（Python 3.9+ 标准库）
└── payload/                 # LifeOS {{VERSION}} 完整发布树的可逆镜像
    ├── manifest.json        # 逐文件清单：路径、权限、sha256（树指纹 {{TREE_SHA256}}…）
    └── tree/                # {{FILE_COUNT}} 个成员：服务端源码、预构建面板、中文手册
```

## 为什么很多文件带 `.txt` 后缀

Skill 平台只允许有限的几种扩展名（.md/.txt/.html/.css/.js/.py/.json/.xml）。payload 里的 shell 脚本、图标等成员因此做了**可逆归一化**：文本成员改名加 `.txt`，二进制成员转 base64 存为 `.b64.txt`，原路径、权限与 sha256 全部记录在 `manifest.json`。安装时逐文件校验并还原，还原结果与 GitHub Release 的发布树**逐字节相同**。

## 隐私边界

- 安装、记录、查询全程不出网；本 Skill 没有任何下载、遥测或上传行为。
- 数据只存在本机：`<安装目录>/server/runtime/` 下两本 SQLite，用户看得见、拷得走、删得掉。
- 面板访问密钥只保存在本机 0600 权限文件里，Skill 被要求绝不转存。

## 来源

- 项目主页与三条传统安装路径：https://github.com/zhaozimin/LifeOS
- 本包由 LifeOS 仓库的 `make_skill_bundle.py` 从已扫描的 v{{VERSION}} 发布树构建，出包前经同一套敏感信息扫描。
- 许可证：MIT（payload 内附 LICENSE）。
