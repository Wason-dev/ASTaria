import { Component, type ErrorInfo, type ReactNode } from 'react'

/** Rendering failures must leave a usable recovery surface above the scene. */
export class RenderErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Do not send task or conversation content to an external error collector.
  }
  render() {
    if (!this.state.failed) return this.props.children
    return <main className="app-recovery" role="alert">
      <strong>ASTaria</strong><h1>这个界面暂时遇到了问题</h1>
      <p>已保存的内容仍保留在本机。可以先重新打开界面；若问题继续，刷新应用后重试。</p>
      <div><button type="button" onClick={() => this.setState({ failed: false })}>重新打开界面</button><button type="button" onClick={() => location.reload()}>刷新应用</button></div>
    </main>
  }
}
