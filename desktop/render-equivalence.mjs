import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beta10BloomFragment } from './bloom-reference.mjs'

/** Compare actual GPU output against the frozen BetaX shader in an isolated smoke profile. */
export async function verifyRenderEquivalence(window, directory) {
  const rows = await window.webContents.executeJavaScript(`(() => {
    const e=window.__ASTARIA_P0__, b=e.bloom, r=e.renderer, gl=r.getContext();
    e.setPaused(true);e.cancelFrame();
    const material=b.composite, original=new material.constructor({
      vertexShader:material.vertexShader, fragmentShader:${JSON.stringify(beta10BloomFragment)},
      uniforms:material.uniforms, depthTest:false, depthWrite:false
    });
    const width=320,height=240,ratio=r.getPixelRatio(),cssWidth=e.cssWidth,cssHeight=e.cssHeight;
    r.setPixelRatio(1);r.setSize(width,height,false);b.resize(width,height,false);
    const input=e.sceneTarget.texture, rows=[];
    const read=()=>{const bytes=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);return bytes};
    try {
      for(const night of [0,0.000001,0.5,1])for(const strength of [0,0.000001,0.4,1]){
        b.composite=original;
        b.prefilter.uniforms.uInput.value=input;b.pass(b.prefilter,b.ping);
        b.blur.uniforms.uInput.value=b.ping.texture;b.blur.uniforms.uDirection.value.set(3/width,0);b.pass(b.blur,b.pong);
        b.blur.uniforms.uInput.value=b.pong.texture;b.blur.uniforms.uDirection.value.set(0,3/height);b.pass(b.blur,b.ping);
        original.uniforms.uBase.value=input;original.uniforms.uNight.value=night;
        original.uniforms.uPointerStrength.value=strength;original.uniforms.uPointer.value.set(0.31,0.57);
        b.pass(original,null);const reference=read();
        b.composite=material;b.render(input,night,original.uniforms.uPointer.value,strength);const candidate=read();
        let max=0,different=0;
        for(let i=0;i<reference.length;i++){const delta=Math.abs(reference[i]-candidate[i]);max=Math.max(max,delta);if(delta)different++}
        rows.push({night,strength,maxChannelDelta:max,differentChannels:different,totalChannels:reference.length});
      }
      return rows;
    }finally{
      b.composite=material;original.dispose();r.setPixelRatio(ratio);r.setSize(cssWidth,cssHeight,false);
      b.resize(e.resolution.x,e.resolution.y,e.quality==='safe');e.setPaused(false);
    }
  })()`)
  await writeFile(join(directory, 'render-equivalence.json'), JSON.stringify(rows, null, 2))
  if (rows.some(row => row.maxChannelDelta > 1)) throw new Error(`Bloom visual regression: ${JSON.stringify(rows)}`)
  console.log('ASTARIA_RENDER_EQUIVALENCE', JSON.stringify(rows))
}
