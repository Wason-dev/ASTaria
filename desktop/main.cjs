const { app, BrowserWindow, dialog, shell, session, Menu, screen, powerMonitor, net, safeStorage } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { randomBytes } = require('node:crypto')
const { mkdtempSync, mkdirSync } = require('node:fs')
const { readFile, writeFile, realpath } = require('node:fs/promises')
const { watchWindowButtons } = require('./window-buttons.cjs')
const { createNetFetch } = require('./net-fetch.cjs')

const resourceRoot = path.join(process.resourcesPath, 'app')
let window
let desktopServer
let service
let quitting = false
let appOrigin
let updateTimer
let updates
let reminders
let sync
const smokeTest = process.argv.includes('--smoke-test')
function updateWindowTheme() {
  if (process.platform === 'win32' && window && !window.isDestroyed()) {
    window.setTitleBarOverlay({ color: '#00000000', symbolColor: service.windowTheme() === 'light' ? '#30343a' : '#eeeae3', height: 28 })
  }
}
// The acceptance run must never open the user's SQLite file or Keychain.
const smokeDirectory = smokeTest ? mkdtempSync(path.join(app.getPath('temp'), 'astaria-smoke-')) : null
const smokeProfile = smokeDirectory ? path.join(smokeDirectory, 'profile') : null
// Electron scopes the instance lock to userData; isolate smoke runs before locking.
if (smokeProfile) {
  mkdirSync(smokeProfile, { recursive: true, mode: 0o700 })
  app.setPath('userData', smokeProfile)
}

const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()

// Keep browser storage separate from the shared SQLite data directory.
app.setName('ASTaria')
if (!smokeTest) {
  const profile = path.join(app.getPath('appData'), 'ASTaria', 'desktop-profile')
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  app.setPath('userData', profile)
}

app.on('second-instance', () => {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.focus()
})

function externalLink(value) {
  try {
    const url = new URL(value)
    if (['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password) {
      void shell.openExternal(value).catch(() => {})
    }
  } catch { /* Ignore malformed links. */ }
}

async function start() {
  const [{ createLocalService, DATA_DIRECTORY }, { createKeychain }, { createDesktopServer }, { createUpdateService }] = await Promise.all([
    import(pathToFileURL(path.join(resourceRoot, 'server/index.mjs')).href),
    import(pathToFileURL(path.join(resourceRoot, 'server/keychain.mjs')).href),
    import(pathToFileURL(path.join(resourceRoot, 'desktop/server.mjs')).href),
    import(pathToFileURL(path.join(resourceRoot, 'desktop/updates.mjs')).href),
  ])
  const pkg = JSON.parse(await readFile(path.join(resourceRoot, 'package.json'), 'utf8'))
  let build = {}
  try { build = JSON.parse(await readFile(path.join(resourceRoot, 'build-info.json'), 'utf8')) } catch { /* Older bundles still expose their full package version. */ }
  const { createSecretStore } = await import(pathToFileURL(path.join(resourceRoot, 'desktop/secretStore.mjs')).href)
  const secrets = createSecretStore({ safeStorage, directory: path.join(smokeDirectory ?? DATA_DIRECTORY, 'secrets') })
  if (smokeTest && process.platform === 'win32') {
    const fixture = randomBytes(32).toString('hex')
    secrets.write('sync-key', fixture)
    if (secrets.read('sync-key') !== fixture) throw new Error('Windows system encryption roundtrip failed')
    secrets.remove('sync-key')
    console.log('ASTARIA_WINDOWS_SECRET_STORE_PASSED')
  }
  if (smokeTest) {
    const { createDatabase } = await import(pathToFileURL(path.join(resourceRoot, 'server/database.mjs')).href)
    const smokeDb = createDatabase(path.join(smokeDirectory, 'test.sqlite'))
    smokeDb.setPreference('onboarding-completed', true)
    service = createLocalService({ db: smokeDb,
      dataDirectory: smokeDirectory, vault: { status: async () => false },
      complete: async () => { throw new Error('Smoke tests must not call a model') },
      onMutation: updateWindowTheme,
    })
  } else {
    service = createLocalService({
      vault: process.platform === 'win32' ? secrets.apiVault : createKeychain(DATA_DIRECTORY, { binaryPath: path.join(resourceRoot, 'bin/astaria-keychain'), binarySha256: build.nativeHelpers?.keychainSha256 }),
      onMutation: () => { reminders?.schedule(); updateWindowTheme() },
    })
  }
  if (!smokeTest) {
    const { createFolderSync } = await import(pathToFileURL(path.join(resourceRoot, 'desktop/folderSync.mjs')).href)
    sync = createFolderSync({ store: service.syncStore, secrets, dataDirectory: DATA_DIRECTORY,
      selectDirectory: async () => {
        const result = await dialog.showOpenDialog(window, { title: '选择已共享的同步目录', properties: ['openDirectory', 'createDirectory'] })
        return result.canceled ? null : result.filePaths[0]
      },
      saveKey: async (value, allowed) => {
        const result = await dialog.showSaveDialog(window, { title: '保存同步恢复密钥，请存到共享目录以外的安全位置', defaultPath: 'ASTaria-sync-recovery-key.txt' })
        if (result.canceled || !result.filePath) return
        const destination = path.join(await realpath(path.dirname(result.filePath)), path.basename(result.filePath))
        if (!allowed(destination)) throw new Error('恢复密钥不能保存在同步目录中')
        await writeFile(destination, `${value}\n`, { mode: 0o600, flag: 'wx' })
      }, onApplied: () => {
        reminders?.schedule()
        if (window && !window.isDestroyed()) void window.webContents.executeJavaScript("window.dispatchEvent(new Event('astaria-local-data-change'))").catch(() => {})
      },
    })
    sync.start()
    powerMonitor.on('resume', () => { void sync.run() })
  }
  const updateStateFile = path.join(app.getPath('userData'), 'update-check.json')
  const scheduleInstall = async candidate => {
    if (smokeTest || process.platform !== 'darwin' || quitting) throw new Error('当前暂不支持自动安装')
    const { prepareMacUpdate, launchMacUpdate } = await import(pathToFileURL(path.join(resourceRoot, 'desktop/updateInstaller.mjs')).href)
    const prepared = await prepareMacUpdate({ ...candidate,
      appBundle: path.resolve(path.dirname(process.execPath), '..', '..'),
      resultFile: path.join(app.getPath('userData'), 'update-install-result'),
    })
    await service.whenIdle()
    await launchMacUpdate(prepared)
    setTimeout(() => app.quit(), 250)
  }

  updates = createUpdateService({ current: { ...build, version: pkg.version, platform: process.platform, arch: process.arch },
    fetcher: createNetFetch(net), stateFile: updateStateFile, installResultFile: path.join(app.getPath('userData'), 'update-install-result'), downloadDirectory: path.join(app.getPath('userData'), 'updates'), installer: scheduleInstall, allowNetwork: !smokeTest })
  if (!smokeTest && process.platform === 'darwin') {
    const { createReminderService, nativeReminderRunner } = await import(pathToFileURL(path.join(resourceRoot, 'desktop/reminders.mjs')).href)
    reminders = createReminderService({ stateFile: path.join(app.getPath('userData'), 'system-reminders.json'),
      snapshot: service.reminderSnapshot, run: nativeReminderRunner(path.join(resourceRoot, 'bin/ASTariaReminders.app/Contents/MacOS/astaria-reminders')) })
    void reminders.initialize()
    powerMonitor.on('resume', () => reminders.schedule())
  }
  const token = randomBytes(32).toString('hex')
  desktopServer = createDesktopServer({ root: path.join(resourceRoot, 'dist'), service, token, updates, reminders, sync, port: smokeTest ? 0 : undefined })
  const url = await desktopServer.listen()
  appOrigin = new URL(url).origin
  const clipboardWrite = (contents, permission) => {
    if (permission !== 'clipboard-sanitized-write' || !contents || contents.id !== window?.webContents.id) return false
    try { return new URL(contents.getURL()).origin === appOrigin } catch { return false }
  }
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(clipboardWrite(contents, permission)))
  session.defaultSession.setPermissionCheckHandler((contents, permission) => clipboardWrite(contents, permission))
  Menu.setApplicationMenu(process.platform === 'win32' ? null : Menu.buildFromTemplate([
    { role: 'appMenu', label: 'ASTaria' },
    { role: 'editMenu', label: '编辑' },
    { label: '显示', submenu: [{ role: 'reload', label: '刷新页面' }, { role: 'togglefullscreen', label: '切换全屏' }] },
    { role: 'windowMenu', label: '窗口' },
  ]))
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    backgroundColor: '#050608',
    title: 'ASTaria',
    // Keep full-size content and control the native buttons ourselves. The
    // built-in customButtonsOnHover hit area can hide the buttons as soon as
    // the pointer crosses onto a traffic light, especially with a draggable
    // renderer strip over the top edge.
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 12, y: 8 },
    } : {}),
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: service.windowTheme() === 'light' ? '#30343a' : '#eeeae3', height: 28 },
    } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  if (process.platform === 'win32') {
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      if (input.key === 'F11') { event.preventDefault(); window.setFullScreen(!window.isFullScreen()) }
      if (input.control && !input.alt && input.key.toLowerCase() === 'r') { event.preventDefault(); window.reload() }
    })
  }
  if (process.platform === 'darwin') {
    const nativeButtons = watchWindowButtons(window, screen)
    // Expose only a smoke-test probe; this is never enabled in normal builds.
    if (smokeTest) window.__astariaNativeWindowButtonsVisible = nativeButtons.isVisible
  }
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${url}*`] }, (details, callback) => {
    if (details.webContentsId !== window?.webContents.id) { callback({ cancel: true }); return }
    // The capability lives only in the main process, never in renderer code,
    // the URL, localStorage, logs or a persistent cookie.
    callback({ requestHeaders: { ...details.requestHeaders, 'X-Astaria-Desktop': token } })
  })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    externalLink(target)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    if (target !== url && !target.startsWith(`${url}#`)) {
      event.preventDefault()
      externalLink(target)
    }
  })
  window.once('ready-to-show', () => window?.show())
  window.on('closed', () => {
    clearTimeout(updateTimer)
    window = null
  })
  window.webContents.on('render-process-gone', () => {
    dialog.showErrorBox('ASTaria 页面已停止', '本机数据仍保存在数据库中。请退出后重新打开 ASTaria。')
  })
  await window.loadURL(url)
  const healthIndex = process.argv.indexOf('--astaria-update-health')
  if (!smokeTest && healthIndex >= 0 && process.argv[healthIndex + 1]) {
    // The local service and renderer must both be ready before replacement succeeds.
    const rendered = await window.webContents.executeJavaScript("new Promise(resolve => { let attempts = 0; const check = () => { if (document.querySelector('#root')?.children.length) resolve(true); else if (++attempts < 100) setTimeout(check, 100); else resolve(false); }; check(); })")
    if (!rendered) throw new Error('Updated renderer did not start')
    const { acknowledgeMacUpdate } = await import(pathToFileURL(path.join(resourceRoot, 'desktop/updateInstaller.mjs')).href)
    await acknowledgeMacUpdate(path.resolve(path.dirname(process.execPath), '..', '..'), process.argv[healthIndex + 1])
  }
  if (!smokeTest) {
    // One delayed startup check, then at most once every six hours while visible.
    // Focus/resume rechecks the cached deadline instead of waking a hidden app.
    const checkUpdates = async () => {
      reminders?.schedule()
      if (!quitting && window && !window.isDestroyed() && window.isVisible() && !window.isMinimized()) {
        const state = await updates.check()
        if (!quitting && window && !window.isDestroyed()) schedule(state.automatic && state.nextCheckAt
          ? Math.max(60_000, Date.parse(state.nextCheckAt) - Date.now()) : 6 * 60 * 60 * 1000)
      } else if (!quitting && window && !window.isDestroyed()) schedule(6 * 60 * 60 * 1000)
    }
    const schedule = delay => {
      clearTimeout(updateTimer)
      updateTimer = setTimeout(() => { void checkUpdates() }, delay)
      updateTimer.unref?.()
    }
    window.on('focus', checkUpdates)
    powerMonitor.on('resume', checkUpdates)
    schedule(20_000)
  }
  if (smokeTest) {
    const { runDesktopSmoke } = await import(pathToFileURL(path.join(resourceRoot, 'desktop/smoke.mjs')).href)
    await runDesktopSmoke(window, smokeDirectory)
    if (process.argv.includes('--measure-performance')) {
      const { measureDesktopPerformance } = await import(pathToFileURL(path.join(resourceRoot, 'desktop/performance-smoke.mjs')).href)
      await measureDesktopPerformance(window, smokeDirectory)
    }
    app.quit()
  }
}

if (primaryInstance) app.whenReady().then(start).catch(error => {
  if (smokeTest) { console.error('ASTARIA_SMOKE_FAILED', error.stack ?? error.code ?? error.name); app.exit(1); return }
  dialog.showErrorBox('ASTaria 无法启动', error.code === 'EADDRINUSE'
    ? '本机 5199 端口被占用。请关闭占用该端口的程序后重试。'
    : '无法启动本机服务或读取应用资源。请重新安装 ASTaria；原有数据库不会被删除。')
  app.quit()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', event => {
  if (quitting) return
  quitting = true
  clearTimeout(updateTimer)
  updates?.close()
  event.preventDefault()
  // Bound quit while preserving SQLite's atomic transactions. If a provider
  // never settles, process exit leaves durable turn recovery for next launch.
  const deadline = setTimeout(() => app.exit(0), 10_000)
  Promise.resolve(desktopServer ? desktopServer.close() : service?.close())
    .finally(() => { clearTimeout(deadline); app.quit() })
    .catch(() => {})
})
