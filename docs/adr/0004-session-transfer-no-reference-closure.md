# 会话迁移只搬记录，不做引用闭包

会话记录里写满了只属于源包的名字：`agentPreset:"study"`、`config.provider:"deepseek-official"`、`source.plugin:"user-approval"`。把它们并进另一个包时，我们决定**只搬记录本身**（`sessions/` + `dsh-session-archive/` + `attachments/`），不自动搬预设、技能、插件，也不顺带搬 API 配置；迁移完成后给一张"这些名字在目标包里没找到"的提示清单。

## Considered options

- **按引用闭包搬**（连带装上预设/技能/插件）：被否。它会把"移动聊天记录"这一单变成一次跨包安装，牵出两处不属于本次范围的东西——技能与预设的安装收据根本不区分来自哪个包（`skill-receipts.ts` 的注释声称能区分，但 `SkillInstallReceipt` 里没有 `packId` 字段），以及插件在目标包 DSH 版本下的解析。
- **顺带把 API 配置也搬过去**（否则每条会话的模型名解析不出来）：被否，用户明确要求迁移就是"只搬会话"。后果已知并接受：目标包没有同名供应商时，那几条历史的模型/预设栏会显示异常。

## Consequences

「聊天记录」在用户嘴里是一个词，在系统里是**有边界的三处目录**，且它**不含** API 配置、预设与插件——这条边界写进 `CONTEXT.md`，避免以后有人把它"顺手修成"闭包搬运。
