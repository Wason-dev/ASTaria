import test from 'node:test'
import assert from 'node:assert/strict'
import { Vector2, Texture } from 'three'
import { SelectiveBloom } from '../src/prototype/postprocessing.ts'

test('light endpoint skips only zero-contribution bloom passes; any positive night resumes the full pipeline', () => {
  const calls=[]
  const renderer={getPixelRatio:()=>1.5,setRenderTarget:target=>calls.push(target),render:()=>{}}
  const bloom=new SelectiveBloom(renderer),texture=new Texture(),pointer=new Vector2(.2,.7)
  bloom.resize(1920,1080,false)
  for(const night of [0,Number.EPSILON,.3,1,0,1]) {
    calls.length=0
    bloom.render(texture,night,pointer,.4)
    assert.equal(calls.length,night>0?4:1)
    assert.equal(calls.at(-1),null,'final pass always composites at full resolution')
    assert.equal(bloom.composite.uniforms.uBase.value,texture)
    assert.equal(bloom.composite.uniforms.uNight.value,night)
    assert.equal(bloom.composite.uniforms.uPointerStrength.value,.4,'cursor optics stay enabled')
    if(night>0)assert.deepEqual(calls.slice(0,3),[bloom.ping,bloom.pong,bloom.ping])
  }
  assert.equal(bloom.ping.width,480)
  assert.equal(bloom.ping.height,270)
  bloom.dispose();texture.dispose()
})
