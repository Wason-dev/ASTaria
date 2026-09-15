import Dexie, { type Table } from 'dexie'

export type ApiSettings = {
  id: 'default'
  provider: 'deepseekflash'
  endpoint: string
  model: string
  apiKey: string
  updatedAt: string
}

class SettingsDatabase extends Dexie {
  settings!: Table<ApiSettings, string>
  constructor() {
    super('astaria-settings')
    this.version(1).stores({ settings: 'id, updatedAt' })
  }
}

const db = new SettingsDatabase()
const defaults: ApiSettings = { id: 'default', provider: 'deepseekflash', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', apiKey: '', updatedAt: new Date(0).toISOString() }

export interface SettingsStore {
  getApiSettings(): Promise<ApiSettings>
  saveApiSettings(patch: Omit<ApiSettings, 'id' | 'updatedAt'>): Promise<ApiSettings>
}

export class LocalSettingsStore implements SettingsStore {
  async getApiSettings() { const stored = await db.settings.get('default'); return stored ? structuredClone(stored) : structuredClone(defaults) }
  async saveApiSettings(patch: Omit<ApiSettings, 'id' | 'updatedAt'>) { const next: ApiSettings = { ...patch, id: 'default', updatedAt: new Date().toISOString() }; await db.settings.put(next); return structuredClone(next) }
}

export const settingsStore: SettingsStore = new LocalSettingsStore()
