import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exercise the real CSS cascade in an owned browser, including a modal in the
// top layer. This fixture complements production screenshots; it is not a
// replacement for the real camera, WebGL or native-device acceptance.
const chromeBinary = process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const hasChrome = await access(chromeBinary).then(() => true, () => false)
test('daylight survives page cover, modal promotion and reversal without stacking veils', {
  skip: !hasChrome && 'Set CHROME_BINARY to an installed Chromium browser for CSS integration checks',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astaria-light-cascade-'))
  try {
    const paths = [
      'src/prototype/prototype.css', 'src/home/home.css',
      'src/home/theme.css', 'src/planner/planner-glass.css',
      'src/xixi/free-time.css', 'src/xixi/orbit-studio.css',
      'src/xixi/horizon-studio.css', 'mobile/ui/mobile-workspaces.css',
      'mobile/runtime/mobile.css',
    ]
    const css = (await Promise.all(paths.map(path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')))).join('\n')
    const html = `<!doctype html><html data-mobile="android"><meta charset="utf-8"><style>${css}</style>
      <main class="p0" data-night="false"><div class="home-workspace" data-theme="light" data-page="free-time" data-effect-preview="false">
        <div class="mobile-workspace-scene" aria-hidden="true"></div>
        <section class="free-time-page" data-theme="light" data-active="true"><div class="free-time-background"></div></section>
        <section class="mobile-schedule-workspace"><div class="mobile-schedule-panel"><div class="m-calendar-body"><span class="home-glass-measure"><span class="home-glass-surface" style="--glass-tint:.3;--glass-rim:.4"></span></span></div></div></section>
        <dialog class="orbit-studio horizon-studio" style="--orbit-reveal:1;--horizon-ui-reveal:1">
          <div><canvas class="orbit-canvas"></canvas><div class="orbit-caption"><p>拖动光带或组名排序</p></div>
          <footer class="orbit-footer"><div class="horizon-tools"><div class="horizon-group-controls"><button>调整分组</button></div></div><div class="orbit-actions"><button class="orbit-cancel">取消</button></div></footer></div>
        </dialog>
      </div></main><pre id="results"></pre><script>
      const home=document.querySelector('.home-workspace'), page=document.querySelector('.free-time-page'), dialog=document.querySelector('dialog');
      const style=(selector,pseudo)=>getComputedStyle(document.querySelector(selector),pseudo);
      const results={states:[]};
      dialog.showModal();
      for(const covered of [false,true,false,true,false]){
        home.dataset.stringCovered=String(covered);page.dataset.active=String(!covered);
        const scene=style('.mobile-workspace-scene');
        results.states.push({covered,background:scene.backgroundColor,opacity:scene.opacity,
          pageBackground:style('.free-time-background').backgroundColor,
          modalBackground:style('dialog').backgroundColor,backdrop:style('dialog','::backdrop').backgroundColor,
          colorScheme:style('dialog').colorScheme,copy:style('.orbit-caption p').color,
          copyOpacity:style('.orbit-caption').opacity,shadow:style('.orbit-caption p').textShadow,
          cancel:style('.orbit-cancel').color,tools:style('.horizon-group-controls button').color});
      }
      home.dataset.page='schedule';
      results.schedule={background:style('.mobile-workspace-scene').backgroundColor,
        surface:style('.mobile-schedule-panel .home-glass-surface').backgroundColor,extraVeil:style('.home-workspace','::before').content};
      home.dataset.theme='dark';home.dataset.glassTone='dark';page.dataset.theme='dark';
      results.dark={colorScheme:style('dialog').colorScheme,tools:style('.horizon-group-controls button').color,
        surface:style('.mobile-schedule-panel .home-glass-surface').backgroundColor};
      document.querySelector('#results').textContent=JSON.stringify(results);
      </script>`
    const input = join(directory, 'cascade.html')
    await writeFile(input, html)
    const output = await new Promise((resolve, reject) => {
      const child = spawn(chromeBinary, [
        '--headless=new', '--dump-dom', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update', '--disable-sync',
        `--user-data-dir=${join(directory, 'profile')}`, `file://${input}`,
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => { child.kill(); reject(Error('Owned CSS-test Chrome timed out')) }, 30000)
      child.stdout.on('data', data => { stdout += data })
      child.stderr.on('data', data => { stderr += data })
      child.on('error', reject)
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(Error(stderr)) })
    })
    const serialized = /<pre id="results">([^<]+)<\/pre>/.exec(output)?.[1]
    assert.ok(serialized, 'the browser executed the cascade fixture')
    const result = JSON.parse(serialized.replaceAll('&quot;', '"').replaceAll('&amp;', '&'))
    for (const state of result.states) {
      assert.equal(state.background, 'rgba(252, 253, 255, 0.65)')
      assert.equal(state.opacity, '1')
      assert.equal(state.pageBackground, 'rgba(0, 0, 0, 0)', 'one light source, without a second page veil')
      assert.equal(state.modalBackground, 'rgba(0, 0, 0, 0)')
      assert.equal(state.backdrop, 'rgba(0, 0, 0, 0)')
      assert.equal(state.colorScheme, 'light')
      for (const key of ['copy', 'cancel', 'tools']) assert.equal(state[key], 'rgb(48, 52, 58)')
      assert.equal(state.copyOpacity, '1', 'small text must retain contrast over the shadow')
      assert.equal(state.shadow, 'none')
    }
    assert.equal(result.schedule.surface, 'rgba(250, 251, 252, 0.2)')
    assert.equal(result.schedule.extraVeil, 'none', 'mobile schedule must not stack a content-only wash below the status bar')
    assert.equal(result.schedule.background, 'rgba(252, 253, 255, 0.65)')
    assert.equal(result.dark.colorScheme, 'dark')
    assert.equal(result.dark.tools, 'rgb(173, 155, 123)')
    assert.equal(result.dark.surface, 'rgba(8, 10, 14, 0.62)')

    // The shadow is the darkest possible background. Check the composited
    // small text there, rather than measuring contrast against plain white.
    const linear = value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
    const luminance = rgb => rgb.reduce((sum, value, i) => sum + linear(value / 255) * [.2126, .7152, .0722][i], 0)
    const background = [252, 253, 255].map(value => value * .65)
    const contrast = (luminance(background) + .05) / (luminance([48, 52, 58]) + .05)
    assert.ok(contrast >= 4.5, `footer contrast over the actual veil must meet 4.5:1, got ${contrast}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
