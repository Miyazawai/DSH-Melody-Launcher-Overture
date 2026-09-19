/**
 * 官方默认整合包构建脚本（CI 与本地共用）。
 *
 *   npm run pack:official -- --dsh 0.1.5-rc.2 --serial 1
 *
 * 流程：解析版本 → 组装 staging 家目录（pnpm 装插件 + 抄基线技能 + 下 officecli 二进制 +
 * 写原生外观）→ 用启动器自己的快照导出管线打成 `official-pack-v<版本>.zip`。
 *
 * 出包判据只有 `@linxin666/dsh-web-all`（见 .github/workflows/official-pack.yml）：
 * officecli 自己发新版不会触发出包，但每次出包都会把它升到当时最新版。
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  candidatesFromPackument,
  compareVersions,
  pickRecommendedDshVersion,
  readDshVersionIndex,
} from '../electron/dsh-release'
import { githubCandidateUrls } from '../electron/github-archive'
import { planSnapshot, writeSnapshotZip } from '../electron/pack-snapshot'
import { downloadReleaseAsset } from '../electron/release-download'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_DIR = path.join(REPO_ROOT, 'official-pack')
const NPM_MIRROR = 'https://registry.npmmirror.com'
const OFFICECLI_MAX_BYTES = 80 * 1024 * 1024
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'DSH-Launcher',
  'User-Agent-Note': 'official-pack-builder',
}

interface Baseline {
  profileId: string
  displayNamePrefix: string
  coreBundles: string[]
  webUiPackage: string
  skills: string[]
  officeCli: { repository: string; assetName: string; targetPath: string; defaultTag: string }
  versionScheme: { template: string; defaultSerial: number }
}

interface Options {
  dshVersion?: string
  serial: number
  officeCliTag: string
  webAllVersion?: string
  stage: string
  outDir: string
  pnpm: string
  force: boolean
  keepStage: boolean
}

function parseArgs(argv: string[]): Options {
  const read = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const has = (name: string): boolean => argv.includes(`--${name}`)
  return {
    dshVersion: read('dsh'),
    serial: Number(read('serial') ?? '') || 0,
    officeCliTag: read('officecli-tag') ?? 'latest',
    webAllVersion: read('web-all'),
    // 默认暂存目录带上 pid：两次构建并发时不会互相删对方的 staging。
    stage: read('stage') ?? path.join(os.tmpdir(), `dml-official-pack-build-${process.pid}`),
    outDir: read('out') ?? path.join(REPO_ROOT, 'release'),
    pnpm: read('pnpm') ?? 'pnpm',
    force: has('force'),
    keepStage: has('keep-stage'),
  }
}

/** 跑一个命令并把输出透传到 stdout（CI 日志里能看到 pnpm 进度）。 */
async function runStep(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } })
    child.once('error', reject)
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`${executable} ${args.join(' ')} 退出码 ${code}`))))
  })
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { 'User-Agent': 'DSH-Launcher' } })
  if (!response.ok) throw new Error(`${url} 返回 ${response.status}`)
  return response.json()
}

/** npm 上的最新版本（大陆走 npmmirror）。 */
async function resolveNpmLatest(packageName: string): Promise<string> {
  const encoded = packageName.replace('/', '%2F')
  const body = await fetchJson(`${NPM_MIRROR}/${encoded}`) as { 'dist-tags'?: Record<string, string> }
  const latest = body['dist-tags']?.latest
  if (!latest || !latest.trim()) throw new Error(`读取 ${packageName} 最新版本失败。`)
  return latest.trim()
}

/** officecli 的发布 tag（默认 latest）。 */
async function resolveOfficeCliTag(repository: string, assetName: string, requested: string): Promise<{ tag: string; assetUrl: string }> {
  const endpoint = requested === 'latest'
    ? `https://api.github.com/repos/${repository}/releases/latest`
    : `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(requested)}`
  const body = await fetchJson(endpoint) as { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> }
  const tag = body.tag_name?.trim()
  if (!tag) throw new Error(`读取 ${repository} 的 ${requested} 发布信息失败。`)
  const asset = (body.assets ?? []).find(item => item.name === assetName)
  if (!asset?.browser_download_url) throw new Error(`${repository}@${tag} 里没有 ${assetName}。`)
  return { tag, assetUrl: asset.browser_download_url }
}

/** 不带启动器的 DSH 版本时才需要联网解析（用户看版本号即知适配哪个 DSH）。 */
async function resolveRecommendedDshVersion(): Promise<string> {
  const candidates = [NPM_MIRROR, 'https://registry.npmjs.org']
  const index = await readDshVersionIndex(fetch, candidates, { timeoutMs: 20_000 })
  const recommended = pickRecommendedDshVersion(candidatesFromPackument(index))
  if (!recommended) throw new Error('没能从 npm 解析出推荐 DSH 版本。')
  return recommended.version
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const baseline = JSON.parse(await readFile(path.join(BASELINE_DIR, 'manifest.json'), 'utf8')) as Baseline

  const dshVersion = options.dshVersion?.trim() || await resolveRecommendedDshVersion()
  const webAllVersion = options.webAllVersion?.trim() || await resolveNpmLatest(baseline.webUiPackage)
  const serial = options.serial || baseline.versionScheme.defaultSerial
  const packVersion = baseline.versionScheme.template
    .replace('{dshVersion}', dshVersion)
    .replace('{serial}', String(serial))
  const assetName = `official-pack-v${packVersion}.zip`
  const zipPath = path.join(options.outDir, assetName)

  console.log(`目标：DSH ${dshVersion} · ${baseline.webUiPackage} ${webAllVersion} · 官方包 ${packVersion}`)
  if (existsSync(zipPath) && !options.force) {
    throw new Error(`${zipPath} 已存在；要覆盖请加 --force（或换 --serial）。`)
  }

  const { tag: officeCliTag, assetUrl: officeCliAssetUrl } = await resolveOfficeCliTag(baseline.officeCli.repository, baseline.officeCli.assetName, options.officeCliTag)
  console.log(`OfficeCLI：${officeCliTag}`)

  // ── staging：家目录镜像 ────────────────────────────────────────────────
  const stage = options.stage
  await rm(stage, { recursive: true, force: true })
  const profileDir = path.join(stage, 'profiles', baseline.profileId)
  await mkdir(profileDir, { recursive: true })

  await writeFile(path.join(stage, 'settings.yaml'), await readFile(path.join(BASELINE_DIR, 'settings.yaml'), 'utf8'), 'utf8')
  await writeFile(path.join(stage, 'skin-center-active.json'), await readFile(path.join(BASELINE_DIR, 'skin-center-active.json'), 'utf8'), 'utf8')
  await cp(path.join(BASELINE_DIR, 'skills'), path.join(stage, 'skills'), { recursive: true })

  await writeFile(path.join(profileDir, 'profile.yaml'), [
    `name: ${baseline.profileId}`,
    'description: ""',
    `dshVersion: ${dshVersion}`,
    'source:',
    '  kind: local',
    `createdAt: ${new Date().toISOString()}`,
    `updatedAt: ${new Date().toISOString()}`,
    'exportedAt: null',
    '',
  ].join('\n'), 'utf8')

  // 插件声明：bundles 决定 DSH 加载什么，dependencies 让包管理器把插件本体拉下来。
  await writeFile(path.join(profileDir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${baseline.profileId}`,
    private: true,
    dsh: { profile: { bundles: [...baseline.coreBundles, baseline.webUiPackage] } },
    dependencies: { [baseline.webUiPackage]: `^${webAllVersion}` },
  }, null, 2)}\n`, 'utf8')

  // 包管理器配置（hoisted + 原生模块构建许可）随基线走，不靠现场生成。
  await cp(path.join(BASELINE_DIR, 'pnpm-workspace.yaml'), path.join(profileDir, 'pnpm-workspace.yaml'))

  console.log('安装插件本体（pnpm）…')
  await runStep(options.pnpm, ['add', `${baseline.webUiPackage}@${webAllVersion}`, '--reporter=append-only', '--config.confirmModulesPurge=false'], profileDir, {
    CI: 'true',
    npm_config_registry: NPM_MIRROR,
  })
  // 既有官方包里从来没有 cloudflared 的二进制（运行时由插件按需获取）；
  // 万一某些 pnpm 版本仍然执行了它的下载，这里兜底删掉，避免包体积凭空多 40MB。
  const cloudflaredBin = path.join(profileDir, 'node_modules', 'cloudflared', 'bin')
  if (existsSync(cloudflaredBin)) {
    await rm(cloudflaredBin, { recursive: true, force: true })
    console.log('已移除 cloudflared 运行时二进制（与既有官方包一致）。')
  }

  console.log('下载 OfficeCLI 引擎…')
  const officeCliTarget = path.join(stage, ...baseline.officeCli.targetPath.split('/'))
  await mkdir(path.dirname(officeCliTarget), { recursive: true })
  let officeCliBuffer: Buffer | null = null
  let lastError: unknown = null
  for (const url of githubCandidateUrls(officeCliAssetUrl)) {
    try {
      officeCliBuffer = await downloadReleaseAsset(url, OFFICECLI_MAX_BYTES, undefined, fetch)
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!officeCliBuffer) throw new Error(`OfficeCLI 下载失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
  await writeFile(officeCliTarget, officeCliBuffer)

  // ── 导出：与整合包页「导出」同一条管线（个人数据剔除规则自动生效）──
  const plan = await planSnapshot(stage, { packId: baseline.profileId })
  if (plan.entries.length === 0) throw new Error('staging 家目录是空的，没有可导出的内容。')
  await mkdir(options.outDir, { recursive: true })
  await writeSnapshotZip(plan, zipPath)
  if (!options.keepStage) await rm(stage, { recursive: true, force: true })

  const sizeMb = Math.round((await readFile(zipPath)).length / 1048576)
  console.log(`\n出包完成：${zipPath}（${sizeMb}MB，${plan.entries.length} 个文件，剔除 ${plan.excluded.length} 个）`)
  // CI 用这几行写进 Release 正文，便于追溯「这个包是用什么建的」。
  console.log('--- official-pack-meta ---')
  console.log(`web-all: ${webAllVersion}`)
  console.log(`officecli: ${officeCliTag}`)
  console.log(`dsh: ${dshVersion}`)
  console.log(`official-pack-version: ${packVersion}`)
  console.log(`official-pack-asset: ${assetName}`)
  console.log(`official-pack-bytes: ${(await readFile(zipPath)).length}`)
}

await main().catch(error => {
  console.error(`\n出包失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
