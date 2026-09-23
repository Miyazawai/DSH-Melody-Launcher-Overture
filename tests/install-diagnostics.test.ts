import { describe, expect, it } from 'vitest'
import { MIN_NODE_VERSION, PNPM_VERSION } from '../electron/node-runtime'
import { describeInstallFailure, engineMismatchHint } from '../electron/install-diagnostics'
import type { NodeRuntime } from '../electron/node-runtime'

const node: NodeRuntime = {
  root: 'C:\\tools\\node',
  node: 'C:\\tools\\node\\node.exe',
  npm: 'C:\\tools\\node\\npm.cmd',
  npx: 'C:\\tools\\node\\npx.cmd',
  managed: false,
  origin: 'system',
}

describe('安装失败的环境不匹配识别', () => {
  it('认得 npm 与 pnpm 的引擎报错，并给出可照做的动作', () => {
    const samples = [
      'npm ERR! code EBADENGINE\nnpm ERR! notsup Required: {"node":">=22.13"}',
      'ERROR Unsupported engine for pnpm@11.21.0: wanted: {"node":">=22.13"}',
      'pnpm: Your Node version v16.20.2 is incompatible with this version of pnpm.',
      "Error: Cannot find module 'node:util'\n  at Module._resolveFilename",
    ]
    for (const output of samples) {
      const hint = engineMismatchHint(output, '16.20.2')
      expect(hint, output.slice(0, 40)).toBeTruthy()
      expect(hint).toContain(MIN_NODE_VERSION)
      // 关键：给一个明确的下一步（把日志发给我们），而不是让用户自己猜「代码 1」是什么意思。
      expect(hint).toContain('请把下面的日志原文发给我们')
    }
  })

  it('与版本无关的失败不乱认', () => {
    expect(engineMismatchHint('npm ERR! 404 @deepseek-ai/dsh@9.9.9 not found', '24.19.0')).toBeNull()
    expect(engineMismatchHint('Error: ECONNRESET while downloading', '24.19.0')).toBeNull()
    // 这句既可能是老 Node 解析不了 ??，也可能只是坏 JSON——宁可不下判断。
    expect(engineMismatchHint("SyntaxError: Unexpected token '?' in JSON at position 12", '16.20.2')).toBeNull()
  })
})

describe('安装失败说明的组装', () => {
  it('摘要、环境快照、输出尾部按顺序出现', () => {
    const message = describeInstallFailure({
      action: 'DSH 0.1.5-rc.2 安装',
      exitCode: 1,
      output: 'npm ERR! code EBADENGINE\nrequired node >=22.13, current v16.20.2',
      node,
      nodeVersion: '16.20.2',
    })
    expect(message.startsWith('DSH 0.1.5-rc.2 安装失败（代码 1）。')).toBe(true)
    expect(message).toContain('16.20.2')
    expect(message).toContain('本机 PATH')
    expect(message).toContain(PNPM_VERSION)
    expect(message).toContain('EBADENGINE')
    expect(message.indexOf('运行环境')).toBeGreaterThan(message.indexOf('这通常是'))
  })

  it('探不到版本与超长输出都要稳住', () => {
    const message = describeInstallFailure({
      action: 'DSH 安装',
      exitCode: null,
      output: 'x'.repeat(9_000),
      node: { ...node, origin: 'bundled' },
      nodeVersion: null,
    })
    expect(message).toContain('代码 未知')
    expect(message).toContain('探测失败')
    expect(message).toContain('启动器自带')
    expect(message.length).toBeLessThan(6_000)
  })
})
