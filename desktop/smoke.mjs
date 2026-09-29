import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Run only with --smoke-test. The launcher creates an isolated temporary
// profile/database, injects an empty vault and forbids model calls.
export async function runDesktopSmoke(window, directory) {
  const check = await window.webContents.executeJavaScript(`(async () => {
    const api = async (path, body) => {
      const response = await fetch('/api' + path, { method: body ? 'POST' : 'GET',
        headers: { 'X-Astaria-Local': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      if (!response.ok) throw new Error('API acceptance failed: ' + path);
      return result;
    };
    const status = await api('/status');
    if (status.configured || status.storage !== 'SQLite') throw new Error('Smoke isolation failed');
    await api('/tasks/create', { title: 'Desktop acceptance task' });
    const backup = await api('/data/export');
    if (!JSON.stringify(backup).includes('Desktop acceptance task')) throw new Error('Persistence failed');
    await api('/planner');
    await api('/preferences');
    for (let attempt = 0; attempt < 50 && !document.querySelector('#root')?.textContent?.trim(); attempt++)
      await new Promise(resolve => setTimeout(resolve, 100));
    if (!document.querySelector('#root')?.textContent?.trim()) throw new Error('React mount failed');
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 unavailable');
    return { react: true, api: true, sqlite: true, webgl2: true,
      nodeIntegration: typeof window.require === 'undefined', url: location.origin };
  })()`)
  if (!check.nodeIntegration) throw new Error('Renderer Node integration must be disabled')
  if (process.platform === 'darwin') {
    // The main process owns this probe; production only uses AppKit's native
    // traffic-light controls and never exposes it to the renderer.
    if (typeof window.__astariaNativeWindowButtonsVisible !== 'function'
      || window.__astariaNativeWindowButtonsVisible())
      throw new Error('Native window buttons must start hidden until hovered')
    if (!window.isClosable() || !window.isMinimizable() || !window.isFullScreenable())
      throw new Error('Hover controls must retain native close, minimize and fullscreen actions')
    const bounds = window.getBounds(), content = window.getContentBounds()
    if (bounds.width !== content.width || bounds.height !== content.height)
      throw new Error('Scene must fill the native window without a title bar')
    const inspectChrome = () => window.webContents.executeJavaScript(`(() => {
      const drag = document.querySelector('.desktop-drag-region');
      const nav = document.querySelector('.home-brand');
      const scene = document.querySelector('.p0');
      if (!drag || !nav || !scene) throw new Error('Desktop chrome did not mount');
      const strip = drag.getBoundingClientRect(), button = nav.getBoundingClientRect();
      const background = scene.getBoundingClientRect();
      const target = document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2);
      if (getComputedStyle(drag).getPropertyValue('-webkit-app-region') !== 'drag'
        || strip.top !== 0 || strip.bottom > button.top || strip.width !== innerWidth
        || background.top !== 0 || background.height !== innerHeight || !nav.contains(target))
        throw new Error('Window drag strip covers navigation or leaves a scene gap');
      return { width: innerWidth, height: innerHeight, dragHeight: strip.height, navigationClickable: true };
    })()`)
    const initial = await inspectChrome()
    const [minWidth, minHeight] = window.getMinimumSize()
    window.setSize(minWidth, minHeight)
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const minimum = await inspectChrome()
    window.setBounds(bounds)
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    if (window.__astariaNativeWindowButtonsVisible()) throw new Error('Resizing must not reveal native window buttons')
    const nativeButtons = window.getWindowButtonPosition()
    if (nativeButtons?.x !== 12 || nativeButtons?.y !== 8) throw new Error('Native window button position changed')
    const fullscreenSkip = process.env.ASTARIA_SMOKE_SKIP_FULLSCREEN_REASON
    if (!fullscreenSkip) {
    window.show(); window.focus()
    await new Promise(resolve => setTimeout(resolve, 500))
    window.setFullScreen(true)
    for (let attempt = 0; attempt < 100 && (!window.isFullScreen() || !window.__astariaNativeWindowButtonsVisible()); attempt++)
      await new Promise(resolve => setTimeout(resolve, 100))
    if (!window.isFullScreen() || !window.__astariaNativeWindowButtonsVisible())
      throw new Error(`Fullscreen must reveal native window buttons (isFullScreen=${window.isFullScreen()}, visible=${window.__astariaNativeWindowButtonsVisible()})`)
    window.setFullScreen(false)
    for (let attempt = 0; attempt < 100 && (window.isFullScreen() || window.__astariaNativeWindowButtonsVisible()); attempt++)
      await new Promise(resolve => setTimeout(resolve, 100))
    if (window.isFullScreen() || window.__astariaNativeWindowButtonsVisible())
      throw new Error('Leaving fullscreen must restore hidden native window buttons')
    }
    check.windowChrome = { fullSizeContent: true, initial, minimum, nativeButtons,
      nativeButtonsHiddenByDefault: true, nativeWindowActionsAvailable: true,
      fullscreenRevealsNativeButtons: fullscreenSkip ? null : true, fullscreenRestoresHoverMode: fullscreenSkip ? null : true,
      ...(fullscreenSkip ? { fullscreenSkipped: fullscreenSkip } : {}) }
  }
  await writeFile(join(directory, 'home.png'), (await window.webContents.capturePage()).toPNG())
  const report = { ...check, directory, passed: true, checkedAt: new Date().toISOString() }
  await writeFile(join(directory, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log('ASTARIA_SMOKE_PASSED', JSON.stringify(report))
}
