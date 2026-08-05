# fin/pages/settings/
> L2 | 父级: ../CLAUDE.md

成员清单
constants.ts: 设置面板 ID、记账模式、账户归属、周期频率与其他不可变选择项；MVP 导航清单排除货币和周期面板。
primitives.tsx: 统计、卡片、色板、汇率编辑与草稿克隆等共享原语。
master-data-cards.tsx: 仪表盘定制、账户、项目和资金来源面板。
categories.tsx: 类别和客户合作方面板，以及审计金额符号展示。
import-tax.tsx: 账单导入预览/提交与税务配置面板。
recurring.tsx: 保留的周期账目规则实现；当前 MVP 不从 SettingsPage 或设置导航触发。

法则：各文件只编辑一组设置职责；上层 SettingsPage 只保存草稿、切换面板并编排写入。
constants.ts 是这些选项的唯一真源，SettingsPage 与各面板一律导入——拆分时曾在两处各存一份逐字节副本，
两份不会同时被想起，迟早各自漂移。本目录同样禁用 `@ts-nocheck`。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
