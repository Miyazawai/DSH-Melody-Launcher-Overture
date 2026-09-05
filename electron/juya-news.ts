// 「橘鸦 AI 早报」（daily.juya.uk）RSS 文字新闻卡：轻量正则解析 RSS 2.0 + 磁盘缓存（SWR），
// 与 skills.sh 索引同款机制：fresh 秒回、stale 先回旧数据后台刷新、miss 才拉网。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const JUYA_NEWS_FEED_URL = 'https://daily.juya.uk/rss.xml'
export const NEWS_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const NEWS_MAX_ITEMS = 30

import type { NewsFeedResult, NewsHeadline, NewsItem, NewsSection } from '../src/types'

export interface NewsCacheFile {
  /** 3 = 条目带分组 sections 字段；旧 version 2/1 缓存视为 miss 强制重拉。 */
  version: 3
  fetchedAt: number
  items: NewsItem[]
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" }

function decodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39|apos);/g, match => ENTITIES[match] ?? match)
}

/** 取 <tag>…</tag> 内容：支持 CDATA、剥 HTML 标签、解实体。 */
function pickTag(block: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block)
  if (!match) return ''
  let value = match[1].trim()
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(value)
  if (cdata) value = cdata[1].trim()
  value = value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  return decodeEntities(value)
}

export function parseRssFeed(xml: string): NewsItem[] {
  if (typeof xml !== 'string' || !xml.includes('<item')) return []
  const items: NewsItem[] = []
  for (const block of xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []) {
    const title = pickTag(block, 'title')
    const link = pickTag(block, 'link')
    if (!title || !link) continue
    items.push({
      title,
      link,
      pubDate: pickTag(block, 'pubDate'),
      summary: pickTag(block, 'description').slice(0, 220),
    })
    if (items.length >= NEWS_MAX_ITEMS) break
  }
  return items
}

/** 把一段 HTML 里的 `<li>标题 <a href>↗</a> <code>#N</code></li>` 清洗成速览条目。 */
function collectHeadlines(scope: string, maxItems: number): NewsHeadline[] {
  const headlines: NewsHeadline[] = []
  const seen = new Set<string>()
  for (const block of scope.match(/<li[^>]*>[\s\S]*?<\/li>/gi) ?? []) {
    const href = /<a[^>]*href="([^"]+)"/i.exec(block)?.[1] ?? ''
    if (!/^https?:\/\//i.test(href) || seen.has(href)) continue
    const text = decodeEntities(
      block
        .replace(/<a[\s\S]*?<\/a>/gi, '')
        .replace(/<code[\s\S]*?<\/code>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/[↗→]/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    if (text.length < 4 || text.length > 160) continue
    seen.add(href)
    headlines.push({ text, link: href })
    if (headlines.length >= maxItems) break
  }
  return headlines
}

/**
 * 当日文章页的「要闻」小节：`<h3>要闻</h3><ul><li>标题 <a href="真实链接">↗</a> <code>#N</code></li>…`。
 * RSS 的 description 是压平的纯文本（链接只剩 ↗ 编号），真实链接只在文章页里。
 */
export function parseHeadlinesFromPage(html: string, maxItems = 6): NewsHeadline[] {
  const section = /<h[23][^>]*>\s*要闻\s*<\/h[23]>/i.exec(html)
  const start = section ? section.index + section[0].length : 0
  const nextHeading = section ? html.slice(start).search(/<h[23][^>]*>/i) : -1
  const scope = section ? html.slice(start, nextHeading >= 0 ? start + nextHeading : undefined) : html
  return collectHeadlines(scope, maxItems)
}

/**
 * 当日文章页「概览」下的全部速览栏目（要闻/模型发布/开发生态/产品应用/…，均为 h3 小节）。
 * 空栏目跳过，条目清洗规则与要闻一致。
 */
export function parseNewsSectionsFromPage(
  html: string,
  opts: { maxSections?: number; maxPerSection?: number } = {},
): NewsSection[] {
  const maxSections = opts.maxSections ?? 7
  const maxPerSection = opts.maxPerSection ?? 6
  const sections: NewsSection[] = []
  const headings = [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)]
  for (let index = 0; index < headings.length; index += 1) {
    const start = headings[index].index + headings[index][0].length
    const end = index + 1 < headings.length ? headings[index + 1].index : html.length
    const title = decodeEntities(headings[index][1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    if (!title) continue
    const items = collectHeadlines(html.slice(start, end), maxPerSection)
    if (items.length === 0) continue
    sections.push({ title, items })
    if (sections.length >= maxSections) break
  }
  return sections
}

export function lookupNewsCache(
  file: NewsCacheFile | null,
  now: number,
  ttlMs = NEWS_CACHE_TTL_MS,
): { status: 'fresh' | 'stale' | 'miss'; items: NewsItem[] } {
  // version 3 = 带 sections 分组；旧缓存（2 及以前）视为 miss，强制重拉拿全栏目。
  if (!file || typeof file !== 'object' || file.version !== 3 || typeof file.fetchedAt !== 'number' || !Array.isArray(file.items)) {
    return { status: 'miss', items: [] }
  }
  const items = file.items.filter(item => item && typeof item.title === 'string' && typeof item.link === 'string')
    .map(item => {
      const headlines = Array.isArray(item.headlines)
        ? item.headlines.filter((h): h is NewsHeadline => Boolean(h) && typeof h.text === 'string' && typeof h.link === 'string').slice(0, 10)
        : undefined
      const sections = Array.isArray(item.sections)
        ? item.sections
          .filter((s): s is NewsSection => Boolean(s) && typeof s.title === 'string' && Array.isArray(s.items))
          .map(section => ({
            title: section.title,
            items: section.items.filter((h): h is NewsHeadline => Boolean(h) && typeof h.text === 'string' && typeof h.link === 'string').slice(0, 10),
          }))
          .filter(section => section.items.length > 0)
        : undefined
      return {
        title: item.title,
        link: item.link,
        pubDate: typeof item.pubDate === 'string' ? item.pubDate : '',
        summary: typeof item.summary === 'string' ? item.summary : '',
        ...(headlines && headlines.length > 0 ? { headlines } : {}),
        ...(sections && sections.length > 0 ? { sections } : {}),
      }
    })
  return { status: now - file.fetchedAt <= ttlMs ? 'fresh' : 'stale', items }
}

export function createNewsCacheStore(filePath: string) {
  return {
    async read(): Promise<NewsCacheFile | null> {
      try {
        return JSON.parse(await readFile(filePath, 'utf8')) as NewsCacheFile
      } catch {
        return null
      }
    },
    async write(file: NewsCacheFile): Promise<void> {
      try {
        await mkdir(path.dirname(filePath), { recursive: true })
        await writeFile(filePath, JSON.stringify(file), 'utf8')
      } catch {
        // 缓存只是加速器。
      }
    },
  }
}

// Cloudflare Pages 对无 UA / node UA 的请求可能直接拒绝，伪装成浏览器。
const FEED_HEADERS = { accept: 'application/rss+xml, application/xml, text/xml', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' }
const PAGE_HEADERS = { accept: 'text/html', 'user-agent': FEED_HEADERS['user-agent'] }

export async function fetchNewsFeed(fetchImpl: typeof fetch, url = JUYA_NEWS_FEED_URL): Promise<NewsItem[]> {
  const response = await fetchImpl(url, { headers: FEED_HEADERS, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const items = parseRssFeed(await response.text())
  if (items.length === 0) throw new Error('订阅源没有可显示的条目')
  const latest = items[0]
  if (latest?.link) {
    // 当日各栏目的速览与真实链接只在文章页里；抓不到不影响订阅源本身。
    try {
      const page = await fetchImpl(latest.link, { headers: PAGE_HEADERS, signal: AbortSignal.timeout(15_000) })
      if (page.ok) {
        const pageHtml = await page.text()
        const sections = parseNewsSectionsFromPage(pageHtml)
        if (sections.length > 0) {
          items[0] = { ...latest, sections, headlines: sections[0]?.items }
        } else {
          const headlines = parseHeadlinesFromPage(pageHtml)
          if (headlines.length > 0) items[0] = { ...latest, headlines }
        }
      }
    } catch {
      // 忽略：渲染层会回退到当日摘要。
    }
  }
  return items
}
