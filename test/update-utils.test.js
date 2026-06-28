'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { compareVersions, isNewer, parseRepo, pickInstallerAsset } = require('../electron/update-utils');

test('compareVersions: ordering, padding, v-prefix, pre-release', () => {
  assert.strictEqual(compareVersions('0.2.0', '0.1.0'), 1);
  assert.strictEqual(compareVersions('0.1.0', '0.2.0'), -1);
  assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
  assert.strictEqual(compareVersions('0.1.10', '0.1.2'), 1, 'numeric, not lexical');
  assert.strictEqual(compareVersions('v0.2.0', '0.2.0'), 0, 'leading v ignored');
  assert.strictEqual(compareVersions('1.2', '1.2.0'), 0, 'missing patch == 0');
  assert.strictEqual(compareVersions('0.2.0-beta.1', '0.2.0'), 0, 'pre-release suffix ignored');
});

test('isNewer: only strictly greater is an update', () => {
  assert.ok(isNewer('0.2.0', '0.1.9'));
  assert.ok(!isNewer('0.1.0', '0.1.0'));
  assert.ok(!isNewer('0.1.0', '0.2.0'));
});

test('parseRepo: https, ssh, shorthand, fallback', () => {
  const fb = { owner: 'fb', repo: 'fb' };
  assert.deepStrictEqual(parseRepo({ url: 'https://github.com/Roialfassi/Smart-Gallery-Timeline.git' }, fb),
    { owner: 'Roialfassi', repo: 'Smart-Gallery-Timeline' });
  assert.deepStrictEqual(parseRepo('git@github.com:Owner/Repo.git', fb), { owner: 'Owner', repo: 'Repo' });
  assert.deepStrictEqual(parseRepo('https://github.com/a/b', fb), { owner: 'a', repo: 'b' });
  assert.deepStrictEqual(parseRepo(undefined, fb), fb, 'falls back when missing');
  assert.deepStrictEqual(parseRepo('https://gitlab.com/a/b', fb), fb, 'non-github falls back');
});

test('pickInstallerAsset: prefer Setup exe, else any exe, else null', () => {
  const setup = { name: 'Smart Gallery Timeline Setup 0.2.0.exe' };
  const other = { name: 'tool.exe' };
  const yml = { name: 'latest.yml' };
  assert.strictEqual(pickInstallerAsset([yml, other, setup]), setup);
  assert.strictEqual(pickInstallerAsset([yml, other]), other);
  assert.strictEqual(pickInstallerAsset([yml]), null);
  assert.strictEqual(pickInstallerAsset([]), null);
  assert.strictEqual(pickInstallerAsset(undefined), null);
});
