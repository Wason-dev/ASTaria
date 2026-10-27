import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
// plutil parses the actual plist and PBX object graph without Xcode builds,
// package resolution, account access, signing or network requests.
const plist = path => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', fileURLToPath(new URL(path, root))], { encoding: 'utf8' }))
const options = { skip: process.platform !== 'darwin' }

test('R19 app manifest declares only established required-reason uses', options, () => {
  const privacy = plist('mobile/ios/App/App/PrivacyInfo.xcprivacy')
  assert.deepEqual(Object.keys(privacy), ['NSPrivacyAccessedAPITypes'], 'no inferred collection or tracking declaration')
  assert.deepEqual(privacy.NSPrivacyAccessedAPITypes, [
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] },
  ])
})

test('R19 the app target copies its own manifest via the Resources build phase', options, () => {
  const project = plist('mobile/ios/App/App.xcodeproj/project.pbxproj'), objects = project.objects
  const targets = objects[project.rootObject].targets.map(id => objects[id])
  const app = targets.find(target => target.productType === 'com.apple.product-type.application')
  assert.ok(app)
  const refs = Object.entries(objects).filter(([, object]) => object.isa === 'PBXFileReference' && object.path === 'PrivacyInfo.xcprivacy')
  assert.equal(refs.length, 1)
  const [refId, ref] = refs[0]
  assert.equal(ref.sourceTree, '<group>')
  const appGroup = Object.values(objects).find(object => object.isa === 'PBXGroup' && object.path === 'App')
  assert.ok(appGroup.children.includes(refId))
  const resources = app.buildPhases.map(id => objects[id]).filter(phase => phase.isa === 'PBXResourcesBuildPhase')
  const copies = resources.flatMap(phase => phase.files.map(id => objects[id])).filter(file => file.fileRef === refId)
  assert.equal(copies.length, 1)
})
