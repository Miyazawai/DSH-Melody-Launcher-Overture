import net from 'node:net'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createRuntimeController } from '../electron/runtime'
import type { NodeRuntime } from '../electron/node-runtime'
import type { AppSettings, LaunchFailureStage } from '../src/types'
import {
  LAUNCH_STAGE_LABELS,
  LAUNCH_STAGE_TITLES,
  launchFailureHeadline,
} from '../src/lib/launch-failure'

/**
 * 启动失败必须带上"死在哪一步"。
 *
 * 此前只有"进程起来了又退出"和"子进程 error"两类会记 lastFailure，
 * 而端口探测失败、spawn 同步抛错这两类只 throw——渲染层拿到的是一条裸 toast，
 * 既没有完整诊断，也没有那份能直接粘给 agent 的修复提示词。
 */

function controllerSettings(): AppSettings {
  return {
    dshInstallPath: path.join(process.cwd(), 'dsh-runtime'),
    dshHome: path.join(process.cwd(), '.dsh'),
    profileName: 'pack-demo',
    workspace: process.cwd(),
    launchExecutable: 'dsh.cmd',
    launchArgs: ['web'],
    // 挑一个高位端口，避免和真实服务撞；启动器自己会往上找可用端口。
    webPort: 39_817,
    openAfterLaunch: true,
  }
}

function managedNode(): NodeRuntime {
  const root = path.join(process.cwd(), 'managed-node')
  return {
    root,
    node: path.join(root, process.platform === 'win32' ? 'node.exe' : 'node'),
    npm: path.join(root, process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    npx: path.join(root, process.platform === 'win32' ? 'npx.cmd' : 'npx'),
    managed: true,
  }
}

function fakeChild(pid: number) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & { kill: ReturnType<typeof vi.fn> }
  Object.assign(child, {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
  return child
}

function makeController(spawnProcess: (file: string, args: string[]) => ChildProcessWithoutNullStreams, settings = controllerSettings()) {
  const states: unknown[] = []
  return {
    states,
    runtime: createRuntimeController({
      readSettings: async () => settings,
      prepareNodeRuntime: async () => managedNode(),
      fallbackWorkspace: () => process.cwd(),
      emitOutput: () => {},
      emitState: state => { states.push(state) },
      openExternal: () => {},
      spawnProcess: spawnProcess as never,
    }),
  }
}

describe('启动失败的阶段标记', () => {
  it('spawn 同步抛错也记失败，并且带阶段与原因', async () => {
    const error = new Error('spawn dsh.cmd EACCES')
    const { runtime } = makeController(() => { throw error })

    await expect(runtime.start()).rejects.toThrow(/EACCES/)

    const failure = runtime.failure()
    expect(failure?.stage).toBe('spawn')
    expect(failure?.diagnostics).toContain('失败阶段：拉起 DSH 进程')
    expect(failure?.diagnostics).toContain('原因：spawn dsh.cmd EACCES')
    expect(failure?.diagnostics).toContain('启动命令：')
    expect(failure?.profileName).toBe('pack-demo')
  })

  it('子进程 error 事件记为 spawn 阶段', async () => {
    const child = fakeChild(4210)
    const { runtime } = makeController(() => child)

    await runtime.start()
    expect(runtime.failure()).toBeNull()

    child.emit('error', new Error('ENOENT exec'))
    const failure = runtime.failure()
    expect(failure?.stage).toBe('spawn')
    expect(failure?.diagnostics).toContain('原因：ENOENT exec')
    await runtime.stop()
  })

  it('非零退出记为 exited 阶段，诊断里保留退出代码与 stderr', async () => {
    const child = fakeChild(4211)
    const { runtime } = makeController(() => child)

    await runtime.start()
    // 必须在 start 之后再写：stderr 的 data 监听器是启动时才挂上的，提前写会丢。
    ;(child.stderr as unknown as PassThrough).write('boom: 无法解析配置\n')
    child.emit('exit', 3)

    // 退出处理里有异步收尾（凭据恢复等），轮询而不是睡固定时长。
    let failure = runtime.failure()
    for (let attempt = 0; !failure && attempt < 60; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      failure = runtime.failure()
    }
    expect(failure?.stage).toBe('exited')
    expect(failure?.diagnostics).toContain('失败阶段：运行中退出')
    expect(failure?.diagnostics).toContain('退出代码：3')
    expect(failure?.diagnostics).toContain('boom: 无法解析配置')
  })

  it('端口全不可用时也记失败（这一类此前只 throw，弹窗根本收不到）', async () => {
    // 控制器不给 findAvailableWebPort 注入探针，所以只能真占住 PORT_FALLBACK_ATTEMPTS 个端口。
    const base = 42_817
    const servers = await Promise.all(Array.from({ length: 10 }, (_, offset) => new Promise<net.Server>((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(base + offset, '127.0.0.1', () => resolve(server))
    })))

    try {
      const settings = { ...controllerSettings(), webPort: base }
      const { runtime } = makeController(() => fakeChild(4212), settings)
      await expect(runtime.start()).rejects.toThrow(/端口/)

      const failure = runtime.failure()
      expect(failure?.stage).toBe('port')
      expect(failure?.diagnostics).toContain('失败阶段：准备本地端口')
      expect(failure?.diagnostics).toContain('均不可用')
      expect(failure?.diagnostics).toContain('常见原因：')
    } finally {
      await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    }
  }, 30_000)

  it('每个阶段都有可读标签和弹窗标题（漏一个编译期就拦不住）', () => {
    const stages: LaunchFailureStage[] = ['port', 'spawn', 'exited']
    for (const stage of stages) {
      expect(LAUNCH_STAGE_LABELS[stage]).toBeTruthy()
      expect(LAUNCH_STAGE_TITLES[stage]).toContain('DSH')
    }
  })

  it('headline 跳过元信息行，挑出真正的原因句', () => {
    const diagnostics = [
      '失败阶段：准备本地端口',
      '从端口 39817 开始连续检测 10 个端口，均不可用。',
      '期望端口：39817（可在「设置 → Web 端口」改）',
      '启动命令：dsh.cmd web',
      '常见原因：上一个没退干净的 DSH 还占着端口。',
    ].join('\n')
    expect(launchFailureHeadline(diagnostics)).toBe('从端口 39817 开始连续检测 10 个端口，均不可用。')
    expect(launchFailureHeadline('启动命令：dsh.cmd web\n工作目录：/tmp')).toBe('进程没有输出更多信息')
  })
})
