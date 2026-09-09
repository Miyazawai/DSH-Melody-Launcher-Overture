<div align="center">

<img src="public/launcher-logo.png" alt="DSH 旋律启动器：序曲" width="128" />

# DSH 旋律启动器：序曲

**DSH-Melody-Launcher: Overture —— 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Windows 桌面启动器（C 端分支）**

下载一个 exe，首启自动带入「官方默认整合包」：DSH 本体、Web 全家桶界面、Office 文档技能全部就位，点「启动 DSH」就能对话、做 PPT、写周报 —— 无需预装任何东西。

<br />

[![Release](https://img.shields.io/github/v/release/Miyazawai/DSH-Melody-Launcher-Overture?style=for-the-badge&logo=github&color=6C7BFF)](https://github.com/Miyazawai/DSH-Melody-Launcher-Overture/releases/latest)
[![Build](https://img.shields.io/github/actions/workflow/status/Miyazawai/DSH-Melody-Launcher-Overture/build.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=build)](https://github.com/Miyazawai/DSH-Melody-Launcher-Overture/actions/workflows/build.yml)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/Miyazawai/DSH-Melody-Launcher-Overture/releases)
[![Upstream](https://img.shields.io/badge/上游-rirko%2Fdsh--melody--launcher-6C7BFF?style=for-the-badge&logo=github&logoColor=white)](https://github.com/rirko/dsh-melody-launcher)
[![Tests](https://img.shields.io/badge/tests-728%20passing-6E9F18?style=for-the-badge&logo=vitest&logoColor=white)](https://github.com/Miyazawai/DSH-Melody-Launcher-Overture)

[![Electron](https://img.shields.io/badge/Electron-43-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev/)
[![Vitest](https://img.shields.io/badge/Vitest-4-6E9F18?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)

**简体中文** · [English](README.en.md)

</div>

---

> [!NOTE]
> **关于本仓库**：「序曲（Overture）」是 [rirko/dsh-melody-launcher](https://github.com/rirko/dsh-melody-launcher) 的 **C 端分支**，对应「暴力整合包模式」产品线。上游仓库是启动器的主线；本分支聚焦**个人玩家的整合包体验**——开箱即玩、按包隔离、整包搬运。架构与词汇表见上游主线，本分支的增量决策记录在 `CONTEXT.md` 与 [CHANGELOG.md](CHANGELOG.md)。

---

## 这是什么

**DSH 旋律启动器：序曲** 把 DeepSeek Harness（DSH）的下载、部署、插件管理和启动流程收拢到一个图形界面里。交互方式参考《我的世界》**忘却的旋律启动器**：在真正启动之前，先在一个地方把版本、插件、技能、预设都安排妥当。

「序曲」的核心概念是**整合包（Modpack）**：

> 每个整合包 = 一套真隔离环境（DSH 版本 + 插件 + 技能 + 预设 + 配置 + 会话），互不串扰。你可以同时养着「稳定工作包」和「尝鲜测试包」，随点随切；还能把整包发给朋友，对方导入即可启动。

| 原本要做的事 | 用启动器之后 |
| --- | --- |
| 装 Node.js → 装 npm → `npx @deepseek-ai/dsh` | 下载一个 exe，首启全自动部署 |
| 翻 GitHub 找插件、手敲 `dsh plugin add` | 内置 DSH Market / 技能市场，一键安装 |
| 想让 AI 帮你做 PPT / 周报 / 表格 | 官方默认整合包自带 Office 技能，装好就能用 |
| 多套环境互相污染，删了重装 | 新建一个整合包，天然隔离，互不影响 |
| 把自己的配置折腾半天分享给朋友 | 导出 = 整个环境打包成 zip，对方导入即可启动 |
| 开终端、记命令、盯输出 | 一个按钮启动，进程与日志全程托管 |

## v0.1.1 更新亮点

- **官方默认整合包** —— 首次启动自动获取导入：DSH 本体 + Web 全家桶界面 + Office 文档技能（Word / Excel / PPT）+ AI 去味写作技能，开箱即用。可以删，删了随时一键「恢复官方整合包」。
- **快照式导出 / 导入** —— 把整合包连插件本体、依赖、技能、配置整个打成 zip；导出前自动剔除 API Key、会话记录等个人数据，绝对路径自动改写。**对方导入即可启动，全程不联网重装依赖。**
- **Office 文档能力** —— 官方包内置 [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) 技能四件套与引擎本体（随包搬运）：对 AI 说一句「把这季度数据做成汇报 PPT」，就能拿到可继续编辑的 `.pptx` / `.docx` / `.xlsx`。
- **运行态分段按钮** —— 浏览器页面关掉了？首页大按钮左段停止服务、右段一键重开网页。
- **删除更安全** —— 整合包删除改为原子回收站：服务还挂着时删除会整体失败并明确报错，绝不会出现「记录还在、环境没了」的半删状态。

## 界面速览

| | |
| --- | --- |
| **启动页** —— AI 日报全栏目滚动、一键启动、当前整合包快切 | **运行中** —— 左段停止服务，右段一键重开网页 |
| ![启动页](docs/screenshots/shot-01-home.png) | ![运行态](docs/screenshots/shot-09-running-split.png) |
| **整合包** —— 官方默认包带「官方」徽标，计数实时探测 | **删除二次确认** —— 点删除变红「确定删除」，说清删什么留什么 |
| ![整合包](docs/screenshots/shot-02-packs.png) | ![删除确认](docs/screenshots/shot-03-delete-arm.png) |
| **技能管理** —— 官方包自带 Office 四件套与去味写作，可启停可卸载 | **技能市场** —— 1900+ 技能按分类浏览安装 |
| ![技能管理](docs/screenshots/shot-05-skills-installed.png) | ![技能市场](docs/screenshots/shot-04-skill-market.png) |
| **插件** —— 核心组合层受保护，启停不删本体 | **DSH Market** —— 3400+ 精选插件，搜索 / 分类 / 检查更新 |
| ![插件](docs/screenshots/shot-06-plugins.png) | ![DSH Market](docs/screenshots/shot-08-dsh-market.png) |
| **DSH 版本** —— 已装与可下载版本一目了然，切换只在整合包页 | |
| ![DSH 版本](docs/screenshots/shot-07-versions.png) | |

## 核心特性

### 官方默认整合包：下载即有

- **首启自动获取** —— 启动器后台核对版本，自动从 GitHub Release 拉取官方包 zip 并导入，进度可见，全程零操作
- **内容基线** —— Web 全家桶界面（任务板 / Git 图 / 皮肤中心 / 社区插件…）、Office 文档技能（含 33MB 引擎随包搬运）、去 AI 味中文写作技能
- **可删可恢复** —— 官方包没有特权，删了整合包页出现「恢复官方整合包」按钮；启动器更新带来新版官方包时，新包自动出现、旧包并存不覆盖

### 整合包：真隔离环境

- **按包隔离** —— 每个整合包有独立的派生家目录，DSH 版本、插件、技能、预设、配置、会话全套隔离，互不串扰
- **快照搬运** —— 导出 = 家目录整个进 zip（自动剔除 API Key / 会话 / 用量等个人数据，绝对路径相对化，符号链接重建），导入即可启动
- **零包引导态** —— 删光所有整合包不慌：三步引导卡带你从零重建，不会偷偷生成兜底包

### 零依赖部署

- **自动准备 Node.js / pnpm** —— 启动器自带便携运行时（SHA-256 校验、断点续传），不需要系统装 Node
- **自动准备 DSH** —— 导入的包缺 DSH 版本时弹窗确认后自动补装
- **GitHub 加速** —— DSH 版本列表、插件目录、官方包下载统一走「用户镜像 → 直连 → 公共镜像」候选链，大陆网络可用

### 启动与进程管理

- **一个按钮启动** —— 以 `dsh --profile <整合包> --no-open --port N` 拉起对应包，服务就绪自动打开网页；网页关了就点首页右段「打开网页」
- **进程生命周期托管** —— 启动、停止、实时日志；退出启动器时同步收尾 DSH 及伴随进程
- **失败原因直达** —— DSH 异常退出时，命令、退出码、stderr 以错误弹窗呈现，还能一键复制「修复引导提示词」交给 AI

### 统一资源市场

- **DSH Market** —— 精选插件目录（awesome-dsh-plugin 数据源），搜索、分类、检查更新
- **技能市场** —— 1900+ 技能按分类浏览，严格校验 `SKILL.md` 结构后安装
- **启停 ≠ 卸载** —— 开关只控制下次启动是否加载；卸载按钮连文件一起删，核心组合层禁止停用

## 快速开始

### 1. 下载

前往 [**Releases**](https://github.com/Miyazawai/DSH-Melody-Launcher-Overture/releases) 下载 `DSH-Launcher-*-portable.exe`，单文件、免安装。

> [!IMPORTANT]
> 便携版目前**未使用商业代码签名证书**。首次运行时 Windows SmartScreen 可能提示来源未知 —— 请确认文件确实来自本仓库 Release 页面后，选择「更多信息 → 仍要运行」。

### 2. 等官方包就位

首次启动会自动下载导入「官方默认整合包」（约 128MB，含 DSH 本体与全部资源；整合包页顶部有进度横幅）。完成后首页显示当前整合包为「官方默认整合包」。

### 3. 填 Key，启动

「设置」里填入 DeepSeek / 其他模型 API Key（写入当前包私有凭据，不随包分享）→ 回启动页点「**启动 DSH**」→ 浏览器自动打开 Web 工作台，开聊。

### 4. 试试 Office 技能

对 AI 说：「用 officecli 创建一个 pptx，标题是季度汇报，再加一页要点」。几秒后拿到可继续编辑的 `.pptx`。

### 5. 分享你的整合包

整合包页点「导出」→ 把 zip 发给朋友 → 对方「导入整合包」即可启动，你的插件、技能、配置原样重现（个人数据已自动剔除）。

## 从源码运行

```powershell
git clone https://github.com/Miyazawai/DSH-Melody-Launcher-Overture.git
cd DSH-Melody-Launcher-Overture
npm install
npm run dev           # 开发模式
npm test              # Vitest 全量测试
npm run build         # 类型检查 + 产物构建
npm run package:win   # 打包 Windows 便携 exe
```

要求 Node.js ≥ 20。

> [!TIP]
> **发版**：推 `v*` 标签即可触发 CI 自动打包并把便携 exe 挂到 Release：
> `git tag -a v0.1.1 -m "v0.1.1" && git push origin v0.1.1`
> 同时把 `official-pack-v<版本>.zip`（整合包页导出后改名）上传到对应 Release，官方包机制按 `OFFICIAL_PACK_VERSION` 常量核对。

## 数据与配置

| 内容 | 位置 |
| --- | --- |
| 启动器数据（packs.json / 设置 / 运行时） | `%APPDATA%\dsh-launcher` |
| 整合包家目录（含包自带工具 `tools/`） | `%APPDATA%\dsh-launcher\dsh-packs\<包id>` |
| DSH 版本缓存 | `%APPDATA%\dsh-launcher\dsh-runtime\versions` |
| 机器级托管工具（OfficeCLI 兜底下载） | `%APPDATA%\dsh-launcher\dsh-tools` |
| 默认 DSH 家目录 | `~/.dsh` |

> 导出整合包时，API Key、会话记录、用量统计、任务板等**个人数据一律不进包**。

## 与上游的关系

- 上游主线：[rirko/dsh-melody-launcher](https://github.com/rirko/dsh-melody-launcher) —— 启动器主线开发与插件目录 PR 的目标仓库
- 本仓库：序曲（Overture）独立发布线 —— 便携 exe 与官方默认整合包都发布在这里的 Releases
- 两边共享核心架构（派生家目录咽喉点、packs.json 唯一清单等）；本分支的增量以「首公里上手体验」为准绳：**零依赖部署、官方包开箱即玩、整包搬运**

## 联系与反馈

- 官方用户 QQ 群：**625155044**（欢迎一起开发，QQ：1250104511）
- 问题反馈请开 [Issue](https://github.com/Miyazawai/DSH-Melody-Launcher-Overture/issues)，附上启动器版本与复现步骤

---

项目坚持**非盈利**方向。启动器只是本地工具，所有 DSH 相关资源版权归 DeepSeek 各自权利人所有。
