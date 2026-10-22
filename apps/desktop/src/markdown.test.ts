import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderMarkdown, renderMarkdownBlocks } from './markdown'

describe('markdown', () => {
  it('draws a fenced block with its language and a Copy button, with the code escaped', () => {
    const html = renderMarkdown('Here:\n\n```ts\nconst a = "<b>" && 1\n```\n')
    assert.match(html, /<p>Here:<\/p>/)
    assert.match(html, /<span class="code-lang">ts<\/span><button type="button" class="code-copy">Copy<\/button>/)
    assert.match(html, /<pre><code class="language-ts">const a = &quot;&lt;b&gt;&quot; &amp;&amp; 1<\/code><\/pre>/)
    assert.doesNotMatch(html, /<b>/)
  })

  it('calls an unlabelled block text', () => {
    assert.match(renderMarkdown('```\nplain\n```'), /<span class="code-lang">text<\/span>/)
  })

  it('keeps inline code, emphasis and safe links, and drops unsafe ones', () => {
    const html = renderMarkdown('Use `npm test` and **be careful** [docs](https://example.com) [bad](javascript:alert(1))')
    assert.match(html, /<code>npm test<\/code>/)
    assert.match(html, /<strong>be careful<\/strong>/)
    assert.match(html, /<a href="https:\/\/example.com"/)
    assert.doesNotMatch(html, /href="javascript/)
  })

  it('escapes raw html', () => {
    assert.doesNotMatch(renderMarkdown('<script>alert(1)</script>'), /<script>/)
  })

  const SAMPLE = [
    '# A title',
    'First paragraph with `code`, **bold** and a [link](https://example.com).\nIt goes on here.',
    '- one\n- two\n- three',
    '1. first\n2. second',
    '| Case | Cost |\n| --- | --- |\n| Cold | 12 ms |\n| Warm | 1 ms |',
    '```ts\nconst a = 1\n\nconst b = 2\n```',
    '> quoted\n> twice',
    '---',
    'The last paragraph.',
  ].join('\n\n')

  it('splits into one element per block, which joined are the page', () => {
    const blocks = renderMarkdownBlocks(SAMPLE)
    assert.equal(blocks.length, 9)
    assert.equal(blocks.join(''), renderMarkdown(SAMPLE))
    for (const block of blocks) {
      const tag = /^<([a-z0-9]+)/.exec(block)?.[1]
      assert.ok(tag, block)
      assert.ok(tag === 'hr' ? block === '<hr />' : block.endsWith(`</${tag}>`), `one ${tag} element: ${block}`)
    }
  })

  it('keeps every block but the last two the same while an answer streams in', () => {
    const final = renderMarkdownBlocks(SAMPLE)
    for (let length = 1; length <= SAMPLE.length; length += 3) {
      const blocks = renderMarkdownBlocks(SAMPLE.slice(0, length))
      for (let index = 0; index < blocks.length - 2; index++) {
        assert.equal(blocks[index], final[index], `block ${index} after ${length} characters`)
      }
    }
  })
})
