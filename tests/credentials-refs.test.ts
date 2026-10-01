import { describe, expect, it } from 'vitest'
import { CREDENTIAL_NAME, describeRefRenames, normalizeRefName, planRefRenames } from '../electron/credentials-refs'

describe('凭据引用名合法化：issue #11 里的两个真实坏名字', () => {
  it('数字名补前导下划线，URL 名折叠成标识符', () => {
    expect(normalizeRefName('1')).toBe('_1')
    expect(normalizeRefName('https://www.roxyai.online')).toBe('HTTPS_WWW_ROXYAI_ONLINE')
  })

  it('合法名原样返回，幂等因此由构造保证', () => {
    for (const name of ['DEEPSEEK_API_KEY', '_1', 'A', 'a_b_2']) {
      expect(normalizeRefName(name)).toBe(name)
    }
  })

  it('纯符号名与超长名都有合法落点', () => {
    expect(normalizeRefName('---')).toBe('CREDENTIAL')
    expect(normalizeRefName('!!!')).toBe('CREDENTIAL')
    const long = normalizeRefName(`${'A'.repeat(300)}/x`)
    expect(long.length).toBeLessThanOrEqual(128)
    expect(long.endsWith('_')).toBe(false)
    expect(CREDENTIAL_NAME.test(long)).toBe(true)
  })

  it('大写化后不会撞上 YAML 的小写保留字', () => {
    for (const name of ['true', 'null', 'inf', '~', 'no', 'NaN']) {
      const next = normalizeRefName(name)
      expect(CREDENTIAL_NAME.test(next)).toBe(true)
      // 名字本身仍是普通字符串，不会被再次解析成布尔/空值。
      expect(next[0]).toMatch(/[A-Za-z_]/)
    }
  })
})

describe('引用名分配：冲突与顺序', () => {
  it('非法名撞已有合法名时加后缀，合法名那条永不动', () => {
    const renames = planRefRenames(['DEEPSEEK_API_KEY', 'deepseek-api-key'])
    expect(renames).toEqual([{ from: 'deepseek-api-key', to: 'DEEPSEEK_API_KEY_2' }])
  })

  it('两个非法名折叠到同一基名时按文档顺序排队', () => {
    const renames = planRefRenames(['roxy.ai', 'ROXY-AI'])
    expect(renames).toEqual([
      { from: 'roxy.ai', to: 'ROXY_AI' },
      { from: 'ROXY-AI', to: 'ROXY_AI_2' },
    ])
  })

  it('同一份文档改第二次时一条都不用改', () => {
    const names = ['1', 'https://www.roxyai.online', 'ROXY-AI', 'DEEPSEEK_API_KEY']
    const first = planRefRenames(names)
    expect(first).toHaveLength(3)
    const renamed = names.map(name => first.find(entry => entry.from === name)?.to ?? name)
    expect(renamed.every(name => CREDENTIAL_NAME.test(name))).toBe(true)
    expect(planRefRenames(renamed)).toEqual([])
  })

  it('摘要只含名字，便于写进日志而不泄露密钥', () => {
    expect(describeRefRenames([{ from: '1', to: '_1' }])).toBe('1→_1')
  })
})
