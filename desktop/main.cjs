const { app, BrowserWindow, dialog, shell, session, Menu, screen } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { randomBytes } = require('node:crypto')
const { mkdtempSync, mkdirSync } = require('node:fs')

const resourceRoot = path.join(process.resourcesPath, 'app')
let window
let desktopServer
let service
let quitting = false
let appOrigin
let nativeWindowButtonsVisible = false
let nativeWindowButtonsPoll
const smokeTest = process.argv.includes('--smoke-test')
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
  const [{ createLocalService, DATA_DIRECTORY }, { createKeychain }, { createDesktopServer }] = await Promise.all([
    import(pathToFileURL(path.join(resourceRoot, 'server/index.mjs')).href),
    import(pathToFileURL(path.join(resourceRoot, 'server/keychain.mjs')).href),
    import(pathToFileURL(path.join(resourceRoot, 'desktop/server.mjs')).href),
  ])
  if (smokeTest) {
    const { createDatabase } = await import(pathToFileURL(path.join(resourceRoot, 'server/database.mjs')).href)
    service = createLocalService({ db: createDatabase(path.join(smokeDirectory, 'test.sqlite')),
      dataDirectory: smokeDirectory, vault: { status: async () => false },
      complete: async () => { throw new Error('Smoke tests must not call a model') },
    })
  } else {
    service = createLocalService({
      vault: createKeychain(DATA_DIRECTORY, { binaryPath: path.join(resourceRoot, 'bin/astaria-keychain') }),
    })
  }
  const token = randomBytes(32).toString('hex')
  desktopServer = createDesktopServer({ root: path.join(resourceRoot, 'dist'), service, token, port: smokeTest ? 0 : undefined })
  const url = await desktopServer.listen()
  appOrigin = new URL(url).origin
  const clipboardWrite = (contents, permission) => {
    if (permission !== 'clipboard-sanitized-write' || !contents || contents.id !== window?.webContents.id) return false
    try { return new URL(contents.getURL()).origin === appOrigin } catch { return false }
  }
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(clipboardWrite(contents, permission)))
  session.defaultSession.setPermissionCheckHandler((contents, permission) => clipboardWrite(contents, permission))
  Menu.setApplicationMenu(Menu.buildFromTemplate([
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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  if (process.platform === 'darwin') {
    const setNativeWindowButtons = visible => {
      if (!window || window.isDestroyed() || nativeWindowButtonsVisible === visible) return
      nativeWindowButtonsVisible = visible
      window.setWindowButtonVisibility(visible)
    }
    const pointerIsOverTrafficLights = () => {
      if (!window || window.isDestroyed() || window.isFullScreen()) return false
      const bounds = window.getBounds()
      const pointer = screen.getCursorScreenPoint()
      return pointer.x >= bounds.x && pointer.x <= bounds.x + 92
        && pointer.y >= bounds.y && pointer.y <= bounds.y + 42
    }
    let hideTimer
    const trackNativeWindowButtons = () => {
      if (!window || window.isDestroyed() || window.isFullScreen()) return
      if (pointerIsOverTrafficLights()) {
        clearTimeout(hideTimer)
        setNativeWindowButtons(true)
        return
      }
      if (nativeWindowButtonsVisible && !hideTimer) {
        hideTimer = setTimeout(() => {
          hideTimer = undefined
          if (!pointerIsOverTrafficLights()) setNativeWindowButtons(false)
        }, 220)
      }
    }
    setNativeWindowButtons(false)
    nativeWindowButtonsPoll = setInterval(trackNativeWindowButtons, 50)
    window.on('enter-full-screen', () => setNativeWindowButtons(true))
    window.on('leave-full-screen', () => {
      clearTimeout(hideTimer)
      setNativeWindowButtons(false)
    })
    window.on('enter-html-full-screen', () => setNativeWindowButtons(true))
    window.on('leave-html-full-screen', () => {
      clearTimeout(hideTimer)
      setNativeWindowButtons(false)
    })
    // Expose only a smoke-test probe; this is never enabled in normal builds.
    if (smokeTest) window.__astariaNativeWindowButtonsVisible = () => nativeWindowButtonsVisible
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
    if (nativeWindowButtonsPoll) clearInterval(nativeWindowButtonsPoll)
    nativeWindowButtonsPoll = undefined
    window = null
  })
  window.webContents.on('render-process-gone', () => {
    dialog.showErrorBox('ASTaria 页面已停止', '本机数据仍保存在数据库中。请退出后重新打开 ASTaria。')
  })
  await window.loadURL(url)
  if (smokeTest) {
    const { runDesktopSmoke } = await import(pathToFileURL(path.join(resourceRoot, 'desktop/smoke.mjs')).href)
    await runDesktopSmoke(window, smokeDirectory)
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
  event.preventDefault()
  // Bound quit while preserving SQLite's atomic transactions. If a provider
  // never settles, process exit leaves durable turn recovery for next launch.
  const deadline = setTimeout(() => app.exit(0), 10_000)
  Promise.resolve(desktopServer ? desktopServer.close() : service?.close())
    .finally(() => { clearTimeout(deadline); app.quit() })
    .catch(() => {})
})
