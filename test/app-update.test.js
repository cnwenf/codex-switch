import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const MODULE_PATH = path.join(REPO_ROOT, 'src', 'app-update.js');

async function loadUpdater() {
  assert.equal(fs.existsSync(MODULE_PATH), true);
  const updater = await import('../src/app-update.js');
  assert.equal(typeof updater.summarizeReleaseUpdate, 'function');
  assert.equal(typeof updater.buildInstallerCommand, 'function');
  assert.equal(typeof updater.buildInstallerEnvironment, 'function');
  return updater;
}

function release(tag, assetNames) {
  return {
    tag_name: tag,
    html_url: `https://github.com/cnwenf/codex-switch/releases/tag/${tag}`,
    assets: assetNames.map((name) => ({
      name,
      state: 'uploaded',
      size: 123,
      browser_download_url: `https://github.com/cnwenf/codex-switch/releases/download/${tag}/${name}`,
    })),
  };
}

test('admin update metadata accepts only the exact versioned DMG and checksum pair', async () => {
  const { summarizeReleaseUpdate } = await loadUpdater();
  const tag = 'v0.6.0';
  const dmg = 'CodexSwitch-0.6.0-macos-arm64.dmg';
  const checksum = `${dmg}.sha256`;
  const ready = summarizeReleaseUpdate(release(tag, [dmg, checksum]), '0.5.0');
  assert.equal(ready.newer, true);
  assert.equal(ready.assetsReady, true);
  assert.equal(ready.assetName, dmg);
  assert.equal(ready.checksumName, checksum);

  for (const assets of [
    ['CodexSwitch-latest-macos-arm64.dmg', checksum],
    [dmg],
    [dmg, 'checksums.txt'],
  ]) {
    const pending = summarizeReleaseUpdate(release(tag, assets), '0.5.0');
    assert.equal(pending.newer, true);
    assert.equal(pending.assetsReady, false);
    assert.equal(pending.assetUrl, null);
    assert.equal(pending.checksumUrl, null);
  }

  const conflicting = release(tag, [dmg, checksum]);
  conflicting.assets.push({
    name: dmg,
    state: 'starter',
    size: 0,
    browser_download_url: 'https://example.test/not-the-release-asset',
  });
  assert.equal(summarizeReleaseUpdate(conflicting, '0.5.0').assetsReady, false);

  const buildTag = 'v0.6.0+build.1';
  const buildDmg = 'CodexSwitch-0.6.0+build.1-macos-arm64.dmg';
  const buildChecksum = `${buildDmg}.sha256`;
  const encoded = release(buildTag, [buildDmg, buildChecksum]);
  for (const asset of encoded.assets) {
    asset.browser_download_url = `https://github.com/cnwenf/codex-switch/releases/download/${encodeURIComponent(buildTag)}/${encodeURIComponent(asset.name)}`;
  }
  assert.equal(summarizeReleaseUpdate(encoded, '0.5.0').assetsReady, true);
});

test('admin updater invokes the single installer script with the exact frozen tag', async () => {
  const { buildInstallerCommand, buildInstallerEnvironment } = await loadUpdater();
  assert.deepEqual(buildInstallerCommand(REPO_ROOT, 'v0.6.0'), {
    file: '/bin/sh',
    args: [path.join(REPO_ROOT, 'scripts', 'install-app.sh'), '--release-tag', 'v0.6.0'],
  });
  assert.throws(() => buildInstallerCommand(REPO_ROOT, 'v0.6.0\n--evil'), /tag/i);
  const installerEnvironment = buildInstallerEnvironment({
    HOME: '/fixture/home',
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    OPENAI_API_KEY: 'fixture-provider-secret',
    CODEX_SWITCH_INSTALL_DEST: '/fixture/attacker-selected.app',
  });
  assert.deepEqual(installerEnvironment, {
    HOME: '/fixture/home',
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    CODEX_SWITCH_INSTALL_NO_APP_CONTROL: '1',
  });
  assert.equal(JSON.stringify(installerEnvironment).includes('fixture-provider-secret'), false);
  const collisionSafe = buildInstallerEnvironment({
    HOME: 'fixture-secret-bound-to-home',
    PATH: '/usr/bin:/bin',
  }, new Set(['HOME']));
  assert.equal(Object.hasOwn(collisionSafe, 'HOME'), false);
  assert.equal(JSON.stringify(collisionSafe).includes('fixture-secret-bound-to-home'), false);
});

test('admin server delegates app replacement instead of carrying a second DMG installer', () => {
  const server = fs.readFileSync(path.join(REPO_ROOT, 'src', 'server.js'), 'utf8');
  assert.match(server, /buildInstallerCommand\(REPO_ROOT,\s*chk\.tag\)/);
  assert.doesNotMatch(server, /function installDmg\s*\(/);
  assert.doesNotMatch(server, /fs\.rmSync\([^\n]*Codex Switch\.app/);
});
