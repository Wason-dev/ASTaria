import { localApi } from '../xixi/api'
import type { LocalStatus } from '../xixi/types'

// Compatibility metadata only: secrets are never returned or loaded from browser storage.
export type ApiSettings = {
  id: 'default'; provider: 'deepseekflash'; endpoint: string; model: string;
  apiKey: string; configured: boolean; updatedAt: string
}
export interface SettingsStore {
  getApiSettings(): Promise<ApiSettings>
  saveApiSettings(patch: Omit<ApiSettings, 'id' | 'updatedAt' | 'configured'>): Promise<ApiSettings>
}
export class LocalSettingsStore implements SettingsStore {
  async getApiSettings(): Promise<ApiSettings> {
    const status = await localApi<LocalStatus>('/status')
    return { id: 'default', provider: 'deepseekflash', endpoint: 'https://api.deepseek.com/chat/completions', model: status.model, apiKey: '', configured: status.configured, updatedAt: new Date().toISOString() }
  }
  async saveApiSettings(patch: Omit<ApiSettings, 'id' | 'updatedAt' | 'configured'>) {
    if (patch.apiKey.trim()) await localApi('/settings/key', { key: patch.apiKey.trim() })
    return this.getApiSettings()
  }
}
export const settingsStore: SettingsStore = new LocalSettingsStore()
