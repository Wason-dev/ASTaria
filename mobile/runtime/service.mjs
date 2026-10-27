import { createServiceCore } from '../../server/serviceCore.mjs'
import { createXixi } from '../../server/xixiCore.mjs'
import { ValidationError } from '../../server/validation.mjs'
import { createWebSearch } from '../../server/webSearchCore.mjs'
import { getModelSettings } from '../../server/modelSettingsCore.mjs'
import { getPreferences } from '../../server/preferences.mjs'
import { readOnboarding } from '../../server/onboarding.mjs'

const unavailable = () => { throw new ValidationError('手机端暂不安装本地模型，请使用云端连接', 501) }

/** Each request has its own completion scope. Database writes stay synchronous;
 * no second mobile rule engine or desktop HTTP server is involved. */
export function createMobileService({ db, vault, fetcher, complete, webSearch, persona, working, platform = 'web-preview' }) {
  // A phone's first profile starts frosted. Explicit existing/imported choices
  // remain authoritative; desktop defaults are independent.
  if (!db.getPreference('app')) {
    // Otherwise the legacy migration would mistake this programmatic default
    // for a user's saved setup and skip first-run onboarding.
    readOnboarding(db)
    db.setPreference('app', { ...getPreferences(db), glass: 'soft' })
  }
  webSearch ??= createWebSearch({ keychain: vault, fetcher, getSettings: () => getModelSettings(db) })
  const core = createMobileServiceScope()
  return {
    ...core,
    dispatch(path, input, options) {
      if (path.startsWith('/api/settings/compatible/') || (path === '/api/settings/provider' && input?.provider === 'compatible')) throw new ValidationError('手机端的其它 API 接入仍在准备，请先使用 DeepSeek', 501)
      if (/^\/api\/settings\/(?:local\/(?:models|test)|provider)(?:\?|$)/u.test(path) && (path.includes('/local/') || input?.provider === 'local')) unavailable()
      // Each concurrent request keeps its completion settings in its own scope.
      // Network waits cannot freeze task reads or edits on the worker.
      const scoped = createMobileServiceScope()
      return scoped.dispatch(path, input, options)
    },
  }
  function createMobileServiceScope() {
    let selected
    return createServiceCore({ db, vault, fetcher, complete, webSearch,
      dataDirectory: '设备私有存储', secretStorage: platform === 'ios' ? 'iOS 钥匙串' : platform === 'android' ? 'Android Keystore' : '浏览器预览不保存 API Key',
      xixiFactory: options => createXixi({ ...options, persona, working }),
      localModelInstaller: { options: () => ({ supported: false, options: [], message: '手机端暂不部署桌面本地模型' }), get: unavailable, start: unavailable, cancel: unavailable },
      deviceRecommendation: () => ({ platform, arch: 'mobile', memoryGB: 0, cpu: '手机', logicalCores: 0, recommendedModel: null, recommendedContextTokens: 0, acceleration: '系统 WebView GPU', recommendations: [], note: '手机端暂不部署桌面本地模型；本机事项无需模型连接。' }),
      completionScope: { getStore: () => selected, async run(completion, callback) { selected = completion; try { return await callback() } finally { selected = undefined } } },
    })
  }
}
