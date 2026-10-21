import { readDocument } from './documentReader'

self.onmessage = async (event: MessageEvent<{ file: File }>) => {
  try {
    const attachment = await readDocument(event.data.file, title => self.postMessage({ channel: 'astaria-document-v1', type: 'progress', title }))
    self.postMessage({ channel: 'astaria-document-v1', type: 'done', attachment })
  } catch (error) {
    self.postMessage({ channel: 'astaria-document-v1', type: 'error', message: error instanceof Error ? error.message : '文档读取失败，请重新选择' })
  }
}
