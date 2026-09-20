import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'

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
  code: ({ children }) => <code>{children}</code>,
  pre: ({ children }) => <pre>{children}</pre>,
}

export function MessageMarkdown({ content }: { content: string }) {
  return <div className="xixi-markdown"><ReactMarkdown components={components} skipHtml>{content}</ReactMarkdown></div>
}

function isSafeHref(href: string | undefined) {
  if (!href) return false
  try {
    const protocol = new URL(href, window.location.href).protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch { return false }
}
