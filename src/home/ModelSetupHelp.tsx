/** Optional guidance only; connection saving and testing use the existing settings flow. */
export function ModelSetupHelp({ mobile }: { mobile: boolean }) {
  return <section className="first-run-model-help" aria-label="模型连接方式">
    <dl className="first-run-model-routes">
      {!mobile && <div><dt>桌面本地 · Ollama / LM Studio</dt><dd>在这台电脑上安装并运行模型，再到「设置 → 析熙」配置本地连接；无需 DeepSeek API Key，效果与速度取决于设备和模型。</dd></div>}
      <div><dt>{mobile ? '手机端 · DeepSeek API 云端' : '云端 · DeepSeek API'}</dt><dd>联网使用 DeepSeek，相关对话与事项会发送给该服务。已有 API Key 可在下方保存。{mobile && '手机仅使用云端模型，不运行或连接电脑的本地模型。'}</dd></div>
    </dl>
    <p>API Key 是开放平台的调用凭证，不是登录密码，也不是聊天会员。平台按 API 用量计费。</p>
    <details className="first-run-model-steps">
      <summary>如何获取 DeepSeek API Key</summary>
      <ol>
        <li>打开 <a href="https://platform.deepseek.com/" target="_blank" rel="noopener noreferrer">DeepSeek 开放平台</a>，在官网登录。</li>
        <li>确认 API 余额，按平台提示开通或充值 API 服务。</li>
        <li>进入 <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer">API keys</a>，创建密钥。</li>
        <li>复制密钥，回到 ASTaria，在下方粘贴并保存。</li>
        <li>到「设置 → 析熙」点击「测试连接」，确认可用；测试会产生少量 API 用量。</li>
      </ol>
    </details>
  </section>
}
