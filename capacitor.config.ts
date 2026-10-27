import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'dev.wason.ASTaria',
  appName: 'ASTaria',
  webDir: 'dist-mobile',
  // Only DOM panes scroll. WebKit's outer scroll view must not pan the entire
  // scene towards a focused input while our foreground is avoiding the IME.
  ios: { path: 'mobile/ios', contentInset: 'never', preferredContentMode: 'mobile', scrollEnabled: false, zoomEnabled: true },
  android: { path: 'mobile/android', allowMixedContent: false },
  server: { androidScheme: 'https' },
  // No remote server.url: pages and data stay on the device. AI requests are
  // separate, explicit requests to the user's configured provider.
  plugins: {
    // ASTariaAppearance owns edge-to-edge safe areas and animated IME insets.
    // A second native padding owner would resize the WebView ahead of the IME.
    SystemBars: { style: 'DARK', initialViewportFitValueHint: 'cover', insetsHandling: 'disable' },
    LocalNotifications: { smallIcon: 'ic_stat_astaria', iconColor: '#d5bb8b' },
  },
}
export default config
