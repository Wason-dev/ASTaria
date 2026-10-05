import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Frozen native screenshots verify the no-op blur removal and final chat layout. */
export async function verifyInteractionVisuals(window, directory) {
  const evaluate=script=>window.webContents.executeJavaScript(script)
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
  const rows=[]
  window.unmaximize();window.setSize(1200,820);window.show();window.focus()
  for(const theme of ['dark','light'])for(const glass of ['clear','soft'])for(const page of ['首页','工作台','余时']) {
    await evaluate(`(async()=>{
      const headers={'Content-Type':'application/json','X-Astaria-Local':'1'},expected=await fetch('/api/preferences',{headers}).then(r=>r.json());
      const response=await fetch('/api/preferences',{method:'POST',headers,body:JSON.stringify({expected,value:{...expected,theme:${JSON.stringify(theme)},glass:${JSON.stringify(glass)},render:{profile:'full',quality:'ultra',glass:'auto'}}})});
      if(!response.ok)throw Error('Visual preference update failed');
      window.dispatchEvent(new CustomEvent('astaria-preferences-change',{detail:await response.json()}));
      if(document.querySelector('#home-menu').inert)document.querySelector('.home-brand').click();
      [...document.querySelectorAll('#home-menu button')].find(b=>b.textContent.trim()===${JSON.stringify(page)}).click();
    })()`)
    await delay(1200)
    if(page==='首页') { await evaluate(`document.querySelector('.home-launch').click()`);await delay(3800) }
    const state=await evaluate(`(()=>{
      const e=window.__ASTARIA_P0__;e.setPaused(true);e.finishCameraTransition();e.pointerActive=false;e.finishPointerTransition();e.setNight(${theme==='dark'?1:0},true);
      e.simulationTime=4;e.nextFrameAt=0;e.frame(performance.now());e.cancelFrame();
      const panel=document.querySelector('.home-morph'),p=panel.getBoundingClientRect();
      return {page:document.querySelector('.home-workspace').dataset.page,morph:{x:p.x,y:p.y,width:p.width,height:p.height},overflow:document.documentElement.scrollWidth>innerWidth,quality:e.getSnapshot().quality};
    })()`)
    await delay(300)
    const before=await window.webContents.capturePage()
    const changed=await evaluate(`(()=>{
      window.__zeroBlurChanges=[...document.querySelectorAll('.home-glass-surface,.wb-background')].filter(e=>getComputedStyle(e).backdropFilter==='none'&&e.getBoundingClientRect().width>0).map(e=>({e,filter:e.style.backdropFilter}));
      for(const {e} of window.__zeroBlurChanges)e.style.backdropFilter='blur(0px)';
      return window.__zeroBlurChanges.length;
    })()`)
    await delay(150)
    const after=await window.webContents.capturePage()
    const a=before.toBitmap(),b=after.toBitmap()
    if(a.length!==b.length)throw Error('Visual capture dimensions changed')
    let max=0,different=0,large=0
    for(let index=0;index<a.length;index++){const d=Math.abs(a[index]-b[index]);max=Math.max(max,d);if(d)different++;if(d>1)large++}
    await evaluate(`(()=>{for(const {e,filter} of window.__zeroBlurChanges)e.style.backdropFilter=filter;delete window.__zeroBlurChanges;window.__ASTARIA_P0__.setPaused(false)})()`)
    const stem=`visual-${theme}-${glass}-${state.page}`
    await writeFile(join(directory,`${stem}.png`),before.toPNG())
    if(large)await writeFile(join(directory,`${stem}-zero-blur.png`),after.toPNG())
    const row={theme,glass,...state,changed,maxChannelDelta:max,differentChannels:different,largeDeltaChannels:large,totalChannels:a.length}
    rows.push(row)
    if(state.overflow||state.quality!=='ultra')throw Error(`Visual layout failed: ${JSON.stringify(row)}`)
  }
  await writeFile(join(directory,'interaction-visuals.json'),JSON.stringify(rows,null,2))
  console.log('ASTARIA_INTERACTION_VISUALS',JSON.stringify(rows))
  const retained=await evaluate(`(async()=>{
    const nav=label=>{if(document.querySelector('#home-menu').inert)document.querySelector('.home-brand').click();[...document.querySelectorAll('#home-menu button')].find(b=>b.textContent.trim()===label).click()};
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    nav('工作台');await delay(400);
    const page=document.querySelector('.workbench'),view=document.querySelector('.wb-scroll');view.scrollTop=60;const scroll=view.scrollTop;
    nav('余时');await delay(50);const during=getComputedStyle(page).contentVisibility;
    await delay(250);const after=getComputedStyle(page).contentVisibility;
    nav('工作台');await delay(400);const resumed=getComputedStyle(page).contentVisibility;
    const result={during,after,resumed,sameNode:page===document.querySelector('.workbench'),scrollRetained:scroll===view.scrollTop};
    if(during!=='visible'||after!=='hidden'||resumed!=='visible'||!result.sameNode||!result.scrollRetained)throw Error('Retained workspace failed: '+JSON.stringify(result));
    nav('余时');await delay(50);nav('工作台');await delay(250);
    if(getComputedStyle(page).contentVisibility!=='visible')throw Error('Rapid return left workspace hidden');
    return result;
  })()`)
  await writeFile(join(directory,'retained-pages.json'),JSON.stringify(retained,null,2))
  console.log('ASTARIA_RETAINED_PAGES',JSON.stringify(retained))
}
