<div align="center">

<img src="public/launcher-logo.png" alt="DSH Melody Launcher: Overture" width="128" />

# DSH Melody Launcher: Overture

**A Windows desktop launcher for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the C-end branch of [rirko/dsh-melody-launcher](https://github.com/rirko/dsh-melody-launcher)**

Built around **modpacks**: every modpack is a truly isolated environment — its own DSH version, plugins, skills, presets, config and sessions. Download one executable and go; no Node.js required up front.

[![Release](https://img.shields.io/github/v/release/Miyazawai/DSH-Melody-Launcher-Overture?style=for-the-badge&logo=github&color=6C7BFF)](https://github.com/Miyazawai/DSH-Melody-Launcher-Overture/releases/latest)
[![Build](https://img.shields.io/github/actions/workflow/status/Miyazawai/DSH-Melody-Launcher-Overture/build.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=build)](https://github.com/Miyazawai/DSH-Melody-Launcher-Overture/actions/workflows/build.yml)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/Miyazawai/DSH-Melody-Launcher-Overture/releases)
[![Upstream](https://img.shields.io/badge/upstream-rirko%2Fdsh--melody--launcher-6C7BFF?style=for-the-badge&logo=github&logoColor=white)](https://github.com/rirko/dsh-melody-launcher)

**[简体中文](README.md) · English**

</div>

---

> [!NOTE]
> **Overture** is the C-end ("暴力整合包模式" / modpack-first) line of [rirko/dsh-melody-launcher](https://github.com/rirko/dsh-melody-launcher). The upstream repo hosts the mainline; this branch focuses on the first-km experience for individual players: zero-dependency onboarding, per-pack isolation, and one-click launch. See the [Chinese README](README.md) for the full documentation.

## Highlights

- **Modpacks = real isolation** — each pack gets a derived home directory; DSH version, plugins, skills, presets and sessions never leak across packs. Create / import / switch / export with live counters.
- **Zero-dependency onboarding** — the launcher downloads DSH, a portable Node.js runtime (SHA-256 verified, resumable) and a private pnpm automatically. Nothing to preinstall.
- **Curated markets** — DSH Market (3,300+ featured plugins) and a Skill Market (1,900+ skills), with strict `SKILL.md` validation and enable/disable that never deletes files.
- **One-click launch** — starts `dsh --profile <pack> --no-open --port N`, opens the browser when ready, and reports exit code / stderr as a toast if DSH crashes.
- **AI Daily** — the home page aggregates the day's AI news into all sections, scrollable in place.

## Screenshots

| Home | DSH Versions |
| --- | --- |
| ![Home](docs/screenshots/shot-01-home.png) | ![Versions](docs/screenshots/shot-02-versions.png) |
| **DSH Market** | **Skill Market** |
| ![DSH Market](docs/screenshots/shot-07-dsh-market.png) | ![Skill Market](docs/screenshots/shot-08-skill-market.png) |
| **Modpacks** | **New Modpack** |
| ![Modpacks](docs/screenshots/shot-06-packs.png) | ![New Modpack](docs/screenshots/shot-09-new-pack.png) |

## Getting started

1. Grab `DSH-Launcher-*-portable.exe` from [**Releases**](https://github.com/Miyazawai/DSH-Melody-Launcher-Overture/releases). The binary is not code-signed yet, so SmartScreen may warn — verify it comes from this repo, then choose "More info → Run anyway".
2. Click **Install DSH** on the home page (the launcher fetches everything it needs).
3. Go to the **Modpacks** tab → **New Modpack** → name it and pick a DSH version → **Create**.
4. Back on the home page, hit **Launch DSH**. Fill in your DeepSeek API key when prompted (stored with 0600 permissions).

## Build from source

Requires Node.js ≥ 20.

```powershell
git clone https://github.com/Miyazawai/DSH-Melody-Launcher-Overture.git
cd DSH-Melody-Launcher-Overture
npm install
npm run dev           # dev mode
npm test              # Vitest
npm run package:win   # portable exe
```

---

Non-profit project. The launcher is a local tool only; all DSH-related assets belong to their respective owners.
