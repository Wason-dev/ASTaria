import test from 'node:test'
import assert from 'node:assert/strict'
import { bundleVersionFor } from './package-desktop.mjs'

test('bundle versions outrank the old iconless helper and retain release order', () => {
  const versions = ['0.1.0-alpha.1', '0.1.0-beta.5', '0.1.0-beta.6', '0.1.0-rc.1', '0.1.0', '0.1.1', '0.2.0', '1.0.0']
  assert.deepEqual(versions.map(bundleVersionFor), ['2.1.0a1', '2.1.0b5', '2.1.0b6', '2.1.0fc1', '2.1.0', '2.1.1', '2.2.0', '3.0.0'])
  assert.equal(bundleVersionFor('0.1.0-beta.6+local'), bundleVersionFor('0.1.0-beta.6'))
  assert.deepEqual(['0.1.0-beta.12', '0.1.0-beta.12.0', '0.1.0-beta.12.1', '0.1.0-beta.12.9', '0.1.0-beta.13', '0.1.0-beta.13.1', '0.1.0'].map(bundleVersionFor),
    ['2.1.0b12', '2.1.0b120', '2.1.0b121', '2.1.0b129', '2.1.0b130', '2.1.0b131', '2.1.0'])
})

test('unsupported prerelease and out-of-range versions fail packaging', () => {
  for (const version of ['0.1.0-preview.1', '0.1.0-beta.0', '0.1.0-beta.256', '0.1.0-beta.12.10', '0.1.0-beta.11.1', '0.1.0-beta.12.01', '9998.0.0']) {
    assert.throws(() => bundleVersionFor(version), /Desktop bundle version/u)
  }
})
