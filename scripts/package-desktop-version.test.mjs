import test from 'node:test'
import assert from 'node:assert/strict'
import { bundleVersionFor } from './package-desktop.mjs'

test('bundle versions outrank the old iconless helper and retain release order', () => {
  const versions = ['0.1.0-alpha.1', '0.1.0-beta.5', '0.1.0-beta.6', '0.1.0-rc.1', '0.1.0', '0.1.1', '0.2.0', '1.0.0']
  assert.deepEqual(versions.map(bundleVersionFor), ['2.1.0a1', '2.1.0b5', '2.1.0b6', '2.1.0fc1', '2.1.0', '2.1.1', '2.2.0', '3.0.0'])
  assert.equal(bundleVersionFor('0.1.0-beta.6+local'), bundleVersionFor('0.1.0-beta.6'))
})

test('unsupported prerelease and out-of-range versions fail packaging', () => {
  for (const version of ['0.1.0-preview.1', '0.1.0-beta.0', '0.1.0-beta.256', '9998.0.0']) {
    assert.throws(() => bundleVersionFor(version), /Desktop bundle version/u)
  }
})
