import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeMathDelimiters } from '../src/xixi/markdownMath.ts'
import { typesetMath } from '../src/xixi/mathTypesetting.ts'

test('standard LaTeX delimiters normalize without changing code or incomplete stream fragments', () => {
  assert.equal(normalizeMathDelimiters(String.raw`由 \(x^{2}+y_{1}\) 可得 \[\frac{a}{b}\]`), '由 $x^{2}+y_{1}$ 可得 \n$$\n\\frac{a}{b}\n$$\n')
  for (const source of [String.raw`还在写 \(\frac{a}{`, '行内代码 `\\(x\\)`', '```tex\n\\[x^{2}\\]\n```', '~~~\n\\(a\\)\n~~~', '    \\(x\\)\n', String.raw`$\frac{a}{b}$ 与 $$x^2$$`, String.raw`\\(literal\\)`, '价格 $5，另一个是 $10']) assert.equal(normalizeMathDelimiters(source), source)
})

test('fractions, powers, subscripts, roots and equations emit selectable HTML with semantic MathML', () => {
  const result = typesetMath(String.raw`\frac{\alpha+\beta}{\alpha\beta} + x^{12} + a_{n+1} = \sqrt{2}`, true)
  for (const element of ['mfrac', 'msup', 'msub', 'msqrt', 'math']) assert.match(result, new RegExp(`<${element}[ >]`))
  assert.match(result, /katex-display/)
  assert.match(result, /annotation encoding="application\/x-tex"/)
  assert.doesNotMatch(result, /<img|<script|<iframe|<style/)
})

test('broken, excessively long and runaway math safely falls back instead of aborting a reply', () => {
  assert.equal(typesetMath(String.raw`\frac{a}{`, false), null)
  assert.equal(typesetMath('x'.repeat(8001), false), null)
  assert.equal(typesetMath(String.raw`\def\loop{\loop}\loop`, false), null)
  assert.equal(typesetMath(String.raw`\notARealCommand{x}`, false), null)
  typesetMath(String.raw`\gdef\abc{123}\abc`, false)
  assert.equal(typesetMath(String.raw`\abc`, false), null, 'macros cannot escape into the next formula')
})

test('model formulas cannot load remote images, emit links or attach arbitrary HTML attributes', () => {
  for (const source of [String.raw`\includegraphics{https://example.invalid/pixel}`, String.raw`\href{javascript:alert(1)}{x}`, String.raw`\htmlClass{evil}{x}`, String.raw`\htmlStyle{position:fixed}{x}`]) {
    const html = typesetMath(source, false) ?? ''
    assert.doesNotMatch(html, /<img|<a\s|class="evil"|style="position:fixed|<script/i)
  }
})
