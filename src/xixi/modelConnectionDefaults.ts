import type { ProviderSettings } from './types'

/** A suggested download is a draft, never an installed or configured model. */
export function withRecommendedLocalModel(settings: ProviderSettings, model: string | null): ProviderSettings {
  if (settings.provider !== 'local' || settings.local.engine !== 'ollama' || settings.local.model.trim() || !model) return settings
  return { ...settings, local: { ...settings.local, model } }
}
