export async function localApi<T>(path: string, body?: unknown): Promise<T> {
  const url = path.startsWith('/api/') ? path : `/api/${path.replace(/^\//, '')}`
  let response: Response
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-ASTaria-Local': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    })
  } catch { throw new Error('本机服务暂时无法连接，请确认 ASTaria 正在运行') }
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('请重新启动 ASTaria 本机服务后再试')
  const result = await response.json()
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '操作暂时未完成，请重试')
  return result as T
}
