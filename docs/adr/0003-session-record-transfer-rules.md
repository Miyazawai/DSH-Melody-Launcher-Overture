# 会话记录跨包搬运：扫目录为准、按世代过滤、不碰登记表

会话历史要能在两个整合包之间搬，而"能不能显示、会不会把目标包搞坏"由上游 DSH 的读取规则决定，不看我们的意愿。实测读到的三条约束 shaping 了这个功能：

1. DSH 是**扫 `sessions/` 目录**列出会话的（`dsh-workspace/lib/index.js:729-731` → `dsh-session-persistence-jsonl` 的 `list()` 全是 `readdir`），扫到没登记的项目会**自己新建**登记项。所以启动器**不读写 `storages/workspace.json`**——碰它只会破坏用户已有的项目清单。
2. 但有一条硬门：会话头的 `cwd` 必须能解析到**真实存在的目录**，否则该会话被丢进 `invalidSessionIds` 静默忽略（`indexHeader:710-727`、`bootstrap:600-601`）。本机内 A→B 天然满足；**跨机器导出的聊天记录在对方机器上大概率一条都不显示**。这一点必须写进导出警告，而不是让用户以为文件坏了。
3. 塞进 `sessions/` 的日志若世代或压缩方式与同目录不一致，DSH 启动时抛 `encodingMismatch` / `legacyLayout` / 迁移链外抛 `SessionFormatUnsupportedMigrationError`——**症状是目标包起不来**。因此"往别的包里写会话"的两条路径（本机迁移、升版副本）都先逐条核对世代/压缩/头部版本，不合格的跳过并报告"因版本差异未导入 N 条"；写之前给目标包那几处留快照，界面提供「撤销这次导入」。

导出侧**不做**这套过滤：整合包自带 DSH 版本，导入方按包里那个版本装运行时，世代天然配套，加检查只会制造假阳性。

附件按 `sha256:` 内容寻址（`dsh-attachment-local`，落在 `attachments/v1/`），会话 JSONL 存的是 id 不是路径，因此搬运可自然去重；但 `files/`（原名）与 `file-objects/`（字节）必须同进同出，否则图片与文件在界面上断链。投影缓存 `storages/session_projcache*` 是可重建缓存，**永不搬**，让 DSH 自己重建。
