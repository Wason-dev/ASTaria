import test from 'node:test'
import assert from 'node:assert/strict'
import { selectRelease as legacy } from './fixtures/beta121-release-selector.mjs'
import { selectRelease as current } from '../desktop/updates.mjs'

const tag='v1.0.0'
const names=['ASTaria-1.0.0-mac-arm64-signed.dmg','ASTaria-1.0.0-mac-arm64-signed.manifest.json','ASTaria-1.0.0-win-x64-setup.exe','ASTaria-1.0.0-win-x64.manifest.json']
const release={tag_name:tag,draft:false,prerelease:false,assets:names.map(name=>({name,state:'uploaded',size:1024,browser_download_url:`https://github.com/Wason-dev/ASTaria/releases/download/${tag}/${name}`}))}
test('R18 full v1.0.0 tag remains discoverable to Beta12.1 on both platforms',()=>{
  for(const platform of ['darwin','win32']) {
    const installed={version:'0.1.0-beta.12.1',platform,arch:platform==='darwin'?'arm64':'x64'}
    const old=legacy([release],installed)
    assert.equal(old.version,'1.0.0')
    assert.equal(old.releaseUrl,'https://github.com/Wason-dev/ASTaria/releases/tag/v1.0.0')
    if(platform==='win32')assert.equal(old.assetName,names[2])
    else assert.equal(old.downloadUrl,null,'old Mac selector can offer release page, not silently install an adhoc build')
    assert.ok(current([release],installed).downloadUrl)
  }
})
test('R18 abbreviated display name cannot replace the published three-part tag',()=>{
  assert.equal(legacy([{...release,tag_name:'v1.0'}],{version:'0.1.0-beta.12.1',platform:'darwin',arch:'arm64'}),null)
})
