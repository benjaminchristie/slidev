import type MagicString from 'magic-string-stack'
import type MarkdownExit from 'markdown-exit'
import { SourceMapConsumer } from 'source-map-js'

// Stamps rendered blocks with the original slide lines they came from, so an editor can map
// a click on the slide back to the markdown:
//   <p data-src="4,6">                                   text block
//   <Metric data-src="7,8" data-src-tag="0" data-component="Metric">   component tag, nth within those lines
// Lines go through the transformer source map, so they stay exact when preparsers or
// transformers (snippets, code imports) shift the text. Dev mode only.

const BLOCKS = new Set([
  'paragraph_open',
  'heading_open',
  'list_item_open',
  'blockquote_open',
  'table_open',
  'bullet_list_open',
  'ordered_list_open',
])

const COMPONENT_TAG = /<([A-Z][\w-]*|[a-z]\w*-[\w-]+)(?=[\s/>])/g
// A picture, video or embed on its own line(s) is a block too, so it can be selected and removed.
const MEDIA_BLOCK = /^\s*<(img|video|iframe|audio|figure|picture)(?=[\s/>])/i

export default function MarkdownItSourceLines(md: MarkdownExit, markdownTransformMap: Map<string, MagicString>) {
  ;(md as any).__slidevSourceLines = true
  const consumers = new WeakMap<MagicString, SourceMapConsumer>()

  function consumer(id: string | undefined) {
    const s = id && markdownTransformMap.get(id)
    if (!s)
      return undefined
    let smc = consumers.get(s)
    if (!smc) {
      const map = s.generateMap()
      smc = new SourceMapConsumer({ ...map, version: map.version.toString(), sourcesContent: map.sourcesContent?.map(c => c ?? '') })
      consumers.set(s, smc)
    }
    return smc
  }

  const parse = md.parse
  md.parse = function (src, env) {
    const smc = consumer(env?.id)
    const original = (line: number) => {
      if (!smc)
        return line
      const mapped = smc.originalPositionFor({ line: line + 1, column: 0 }).line
      return mapped == null || mapped <= 0 ? null : mapped - 1
    }
    const range = (map: [number, number]) => {
      const start = original(map[0]) ?? map[0]
      let end = original(map[1])
      if (end == null) {
        end = start + 1
        for (let l = map[1] - 1; l > map[0]; l--) {
          const m = original(l)
          if (m != null) {
            end = m + 1
            break
          }
        }
      }
      return `${start},${Math.max(start + 1, end)}`
    }
    const stamp = (html: string, src: string, counter: { n: number }) =>
      html.replace(COMPONENT_TAG, (m, name: string) => /^(?:v-|template$)/i.test(name)
        ? m
        : `${m} data-src="${src}" data-src-tag="${counter.n++}" data-component="${name}"`)

    const tokens = parse.call(this, src, env)
    let para = ''
    let counter = { n: 0 }
    for (const token of tokens) {
      if (!token.map)
        continue
      const src = range(token.map as [number, number])
      if (BLOCKS.has(token.type)) {
        token.attrSet('data-src', src)
        if (token.type === 'paragraph_open') {
          para = src
          counter = { n: 0 }
        }
      }
      // Slidev hands block-level component tags over as top-level html_inline tokens.
      else if (token.type === 'html_block' || token.type === 'html_inline') {
        token.content = stamp(token.content, src, { n: 0 })
        if (token.type === 'html_block' && MEDIA_BLOCK.test(token.content))
          token.content = token.content.replace(MEDIA_BLOCK, m => `${m} data-src="${src}"`)
      }
      else if (token.type === 'inline' && token.children && para) {
        for (const child of token.children) {
          if (child.type === 'html_inline' && !child.content.startsWith('</'))
            child.content = stamp(child.content, para, counter)
        }
      }
    }
    return tokens
  }
}
