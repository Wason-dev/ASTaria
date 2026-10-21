import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'dev.wason.ASTaria',
  appName: 'ASTaria',
  webDir: 'dist-mobile',
  ios: { path: 'mobile/ios', contentInset: 'never', preferredContentMode: 'mobile' },
  android: { path: 'mobile/android', allowMixedContent: false },
  server: { androidScheme: 'https' },
  // No remote server.url: pages and data stay on the device. AI requests are
  // separate, explicit requests to the user's configured provider.
  plugins: {
    SystemBars: { style: 'DARK', initialViewportFitValueHint: 'cover', insetsHandling: 'css' },
    LocalNotifications: { smallIcon: 'ic_stat_astaria', iconColor: '#d5bb8b' },
  },
}
export default config
