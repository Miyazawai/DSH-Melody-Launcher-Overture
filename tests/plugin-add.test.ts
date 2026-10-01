import { describe, expect, it } from 'vitest'
import { parsePluginAddInput } from '../src/lib/plugin-add'

describe('手动添加插件的输入解析（issue #10）', () => {
  it('认得各种写法的 GitHub 来源', () => {
    expect(parsePluginAddInput('https://github.com/owner/dsh-example')).toEqual({
      kind: 'github', name: 'owner/dsh-example', display: 'GitHub 仓库 owner/dsh-example',
    })
    expect(parsePluginAddInput('  github.com/owner/dsh-example.git  ')).toEqual({
      kind: 'github', name: 'owner/dsh-example', display: 'GitHub 仓库 owner/dsh-example',
    })
    expect(parsePluginAddInput('git@github.com:owner/dsh-example.git').name).toBe('owner/dsh-example')
    expect(parsePluginAddInput('github:owner/dsh-example').name).toBe('owner/dsh-example')
    // 裸 owner/repo 不可能是合法包名（带斜杠又没有 @scope），只可能是仓库。
    expect(parsePluginAddInput('owner/dsh-example').kind).toBe('github')
  })

  it('认得 npm 包名与可选版本', () => {
    expect(parsePluginAddInput('dsh-example')).toEqual({ kind: 'npm', name: 'dsh-example', display: 'npm 包 dsh-example' })
    expect(parsePluginAddInput('@scope/dsh-example')).toEqual({
      kind: 'npm', name: '@scope/dsh-example', display: 'npm 包 @scope/dsh-example',
    })
    expect(parsePluginAddInput('dsh-example@1.2.3')).toEqual({
      kind: 'npm', name: 'dsh-example', version: '1.2.3', display: 'npm 包 dsh-example@1.2.3',
    })
    expect(parsePluginAddInput('@scope/dsh-example@0.1.7-rc.1').version).toBe('0.1.7-rc.1')
    expect(parsePluginAddInput('dsh-example@latest').version).toBe('latest')
  })

  it('拒绝空输入与不成形的包名', () => {
    expect(() => parsePluginAddInput('   ')).toThrow(/请输入/)
    expect(() => parsePluginAddInput('bad package')).toThrow(/插件名称无效/)
    expect(() => parsePluginAddInput('demo-plugin@1.0.0 latest')).toThrow(/版本格式无效/)
    expect(() => parsePluginAddInput('@')).toThrow(/插件名称无效/)
  })

  it('非 GitHub 的链接不假装能装', () => {
    expect(() => parsePluginAddInput('https://gitlab.com/owner/repo')).toThrow(/只支持 GitHub/)
  })

  it('scoped 包名前导的 @ 不会被当成版本分隔符', () => {
    const target = parsePluginAddInput('@deepseek-ai/dsh-example')
    expect(target.name).toBe('@deepseek-ai/dsh-example')
    expect(target.version).toBeUndefined()
  })
})
