import { Capacitor, registerPlugin, SystemBars, SystemBarsStyle } from '@capacitor/core'

const appearance = registerPlugin<{ setTheme(options: { theme: 'dark' | 'light' }): Promise<void> }>('ASTariaAppearance')

/** SystemBars sets icon contrast; ASTariaAppearance owns transparent bars/insets. */
export async function setAndroidAppearance(night: boolean) {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return
  await SystemBars.setStyle({ style: night ? SystemBarsStyle.Dark : SystemBarsStyle.Light })
  await appearance.setTheme({ theme: night ? 'dark' : 'light' })
}
