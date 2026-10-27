import { Capacitor, registerPlugin, SystemBars, SystemBarsStyle } from '@capacitor/core'

const appearance = registerPlugin<{ setTheme(options: { theme: 'dark' | 'light' }): Promise<void> }>('ASTariaAppearance')

/** Android owns transparent insets; iOS keeps the native window backing themed. */
export async function setNativeAppearance(night: boolean) {
  if (!Capacitor.isNativePlatform()) return
  const platform = Capacitor.getPlatform()
  if (platform !== 'android' && platform !== 'ios') return
  if (platform === 'android') await SystemBars.setStyle({ style: night ? SystemBarsStyle.Dark : SystemBarsStyle.Light })
  await appearance.setTheme({ theme: night ? 'dark' : 'light' })
}
