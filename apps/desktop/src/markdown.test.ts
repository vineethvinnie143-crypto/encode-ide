import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderMarkdown } from './markdown'

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
})
