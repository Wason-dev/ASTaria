import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { MathFormula, MathTableContext } from './MathFormula'
import { normalizeMathDelimiters, remarkReadableMath } from './markdownMath'
import './markdown-rich.css'

const plugins = [remarkGfm, remarkMath, remarkReadableMath]

const components: Components = {
  // Keep all assistant prose inside the existing compact message rhythm.
  p: ({ children }) => <p>{children}</p>,
  strong: ({ children }) => <strong>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  ul: ({ children }) => <ul>{children}</ul>,
  ol: ({ children }) => <ol>{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  br: () => <br />,
  blockquote: ({ children }) => <blockquote>{children}</blockquote>,
  a: ({ children, href }) => isSafeHref(href) ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>,
  // Do not request or render remote image resources. Alt text remains useful
  // when a provider includes an image in a reply.
  img: ({ alt }) => alt ? <span className="xixi-markdown-image-alt">{alt}</span> : null,
  table: ({ children }) => <MathTableContext.Provider value><div className="xixi-markdown-table" role="region" aria-label="回复中的表格" tabIndex={0}><table>{children}</table></div></MathTableContext.Provider>,
  th: ({ children, style }) => <th scope="col" data-align={style?.textAlign}>{children}</th>,
  td: ({ children, style }) => <td data-align={style?.textAlign}>{children}</td>,
  code: ({ children, className }) => className?.split(' ').includes('math-inline')
    ? <MathFormula source={String(children)} /> : <code>{children}</code>,
  pre: ({ children, node }) => {
    const code = node?.children[0]
    if (code?.type === 'element' && code.tagName === 'code' && Array.isArray(code.properties.className)
      && code.properties.className.includes('math-display')) {
      return <MathFormula source={code.children.map(child => child.type === 'text' ? child.value : '').join('')} display />
    }
    return <pre>{children}</pre>
  },
}

export const MessageMarkdown = memo(function MessageMarkdown({ content }: { content: string }) {
  const source = useMemo(() => normalizeMathDelimiters(content), [content])
  return <div className="xixi-markdown"><ReactMarkdown components={components} remarkPlugins={plugins} skipHtml>{source}</ReactMarkdown></div>
})

function isSafeHref(href: string | undefined) {
  if (!href) return false
  try {
    const protocol = new URL(href, window.location.href).protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch { return false }
}
