import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const INSTALLER = path.join(REPO_ROOT, 'scripts', 'install-app.sh');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release-dmg.yml');

const ACTION_SHAS = {
  checkout: '3d3c42e5aac5ba805825da76410c181273ba90b1',
  setupNode: '820762786026740c76f36085b0efc47a31fe5020',
  uploadArtifact: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  downloadArtifact: '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
};

function workflowSource() {
  return fs.readFileSync(WORKFLOW, 'utf8');
}

test('release workflow pins the published or dispatched tag in a least-privilege arm64 build', () => {
  const workflow = workflowSource();

  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /release:\s*\n\s+types:\s*\[published\]/);
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+tag:/);
  assert.match(workflow, /concurrency:\s*\n\s+group:.*tag/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /build:\s*\n(?:.|\n)*?runs-on:\s*macos-14/);
  assert.match(workflow, /build:\s*\n(?:.|\n)*?permissions:\s*\n\s+contents:\s*read/);
  assert.match(workflow, /timeout-minutes:\s*[1-9][0-9]*/);
  assert.match(workflow, /test "\$\(uname -m\)" = arm64/);
  assert.match(workflow, new RegExp(`actions/checkout@${ACTION_SHAS.checkout}`));
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /ref:\s*\$\{\{\s*steps\.release\.outputs\.tag\s*\}\}/);
  assert.match(workflow, new RegExp(`actions/setup-node@${ACTION_SHAS.setupNode}`));
  assert.match(workflow, /node-version:\s*["']?22\.23\.2["']?/);
  assert.match(workflow, /^\s*NODE_VERSION:\s*v22\.23\.2$/m);
  assert.doesNotMatch(workflow, /uses:\s*actions\/[^\s@]+@v\d+/);
  assert.doesNotMatch(workflow, /secrets\.|personal[_-]?access[_-]?token|\bPAT\b/i);
});

test('release workflow verifies the existing mutable release and transfers a checked DMG pair', () => {
  const workflow = workflowSource();

  assert.match(workflow, /tag_name/);
  assert.match(workflow, /draft/);
  assert.match(workflow, /has\("immutable"\)/);
  assert.match(workflow, /immutable\s*==\s*false/);
  assert.match(workflow, /v\$\{VERSION\}/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /scripts\/build-macos-app\.sh/);
  assert.match(workflow, /codesign --verify/);
  assert.match(workflow, /hdiutil verify/);
  assert.match(workflow, /shasum -a 256/);
  assert.match(workflow, /shasum -a 256 -c/);
  assert.match(workflow, new RegExp(`actions/upload-artifact@${ACTION_SHAS.uploadArtifact}`));
  assert.match(workflow, /retention-days:\s*1/);
  assert.match(workflow, /compression-level:\s*0/);
});

test('release workflow publishes idempotently without overwriting a partial or divergent release', () => {
  const workflow = workflowSource();

  assert.match(workflow, /publish:\s*\n(?:.|\n)*?runs-on:\s*ubuntu-latest/);
  assert.match(workflow, /publish:\s*\n(?:.|\n)*?permissions:\s*\n\s+contents:\s*write/);
  assert.match(workflow, new RegExp(`actions/download-artifact@${ACTION_SHAS.downloadArtifact}`));
  assert.match(workflow, /gh release upload/);
  assert.doesNotMatch(workflow, /gh release upload[^\n]*--clobber/);
  assert.match(workflow, /gh release download/);
  assert.match(workflow, /dmg_present/);
  assert.match(workflow, /checksum_present/);
  assert.match(workflow, /cmp /);
  assert.match(workflow, /only one release asset exists/i);
});

function releaseJson(tag, assetNames = []) {
  return JSON.stringify({
    url: `https://api.github.com/repos/cnwenf/codex-switch/releases/1`,
    html_url: `https://github.com/cnwenf/codex-switch/releases/tag/${tag}`,
    id: 1,
    tag_name: tag,
    target_commitish: 'main',
    draft: false,
    immutable: false,
    prerelease: false,
    created_at: '2026-08-25T00:00:00Z',
    published_at: '2026-08-25T00:00:00Z',
    assets: assetNames.map((name, index) => ({
      url: `https://api.github.com/repos/cnwenf/codex-switch/releases/assets/${index + 1}`,
      id: index + 1,
      name,
      content_type: 'application/octet-stream',
      state: 'uploaded',
      size: 12,
      browser_download_url: `https://github.com/cnwenf/codex-switch/releases/download/${tag}/${name}`,
    })),
  });
}

function writeExecutable(filename, source) {
  fs.writeFileSync(filename, source, { mode: 0o755 });
}

function createFixture(t, {
  tag = 'v0.5.0',
  tagResponses,
  dmgContents = 'fixture dmg bytes',
  checksumContents,
  pollDelays = '0 0 0',
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-installer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const tagDir = path.join(root, 'tag-responses');
  const mount = path.join(root, 'mounted volume');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(tagDir);
  fs.mkdirSync(path.join(mount, 'Codex Switch.app'), { recursive: true });

  const version = tag.slice(1);
  const dmgName = `CodexSwitch-${version}-macos-arm64.dmg`;
  const checksumName = `${dmgName}.sha256`;
  const dmg = path.join(root, dmgName);
  const checksum = path.join(root, checksumName);
  fs.writeFileSync(dmg, dmgContents);
  const digest = createHash('sha256').update(dmgContents).digest('hex');
  fs.writeFileSync(checksum, checksumContents ?? `${digest}  ${dmgName}\n`);

  const responses = tagResponses ?? [releaseJson(tag, [dmgName, checksumName])];
  responses.forEach((response, index) => {
    fs.writeFileSync(path.join(tagDir, `${index + 1}.json`), response);
  });
  fs.writeFileSync(path.join(root, 'latest.json'), releaseJson(tag));

  writeExecutable(path.join(bin, 'curl'), String.raw`#!/bin/sh
set -eu
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    --retry|--max-time|--resolve) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\n' "$url" >> "$FAKE_CURL_LOG"
case "$url" in
  */releases/latest)
    /bin/cat "$FAKE_LATEST_JSON"
    ;;
  */releases/tags/*)
    count=0
    [ ! -f "$FAKE_TAG_STATE" ] || count=$(/bin/cat "$FAKE_TAG_STATE")
    count=$((count + 1))
    printf '%s\n' "$count" > "$FAKE_TAG_STATE"
    response="$FAKE_TAG_DIR/$count.json"
    [ -f "$response" ] || exit 22
    /bin/cat "$response"
    ;;
  *.sha256)
    [ -n "$output" ]
    /bin/cp "$FAKE_CHECKSUM" "$output"
    ;;
  *.dmg)
    [ -n "$output" ]
    /bin/cp "$FAKE_DMG" "$output"
    ;;
  *)
    exit 22
    ;;
esac
`);

  writeExecutable(path.join(bin, 'hdiutil'), String.raw`#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_HDIUTIL_LOG"
case "$1" in
  attach) printf '/dev/disk9 Apple_HFS %s\n' "$FAKE_MOUNT" ;;
  detach|verify) exit 0 ;;
  *) exit 2 ;;
esac
`);

  writeExecutable(path.join(bin, 'rm'), String.raw`#!/bin/sh
case "$*" in
  *"/Applications/Codex Switch.app"*)
    printf '%s\n' "$*" >> "$FAKE_INSTALL_LOG"
    exit 0
    ;;
esac
exec /bin/rm "$@"
`);

  writeExecutable(path.join(bin, 'cp'), String.raw`#!/bin/sh
case "$*" in
  *"/Applications/Codex Switch.app"*)
    printf '%s\n' "$*" >> "$FAKE_INSTALL_LOG"
    exit 0
    ;;
esac
exec /bin/cp "$@"
`);

  writeExecutable(path.join(bin, 'open'), String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_OPEN_LOG"
`);
  writeExecutable(path.join(bin, 'xattr'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');

  const logs = {
    curl: path.join(root, 'curl.log'),
    hdiutil: path.join(root, 'hdiutil.log'),
    install: path.join(root, 'install.log'),
    open: path.join(root, 'open.log'),
  };
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    CODEX_SWITCH_RELEASE_POLL_DELAYS: pollDelays,
    FAKE_CURL_LOG: logs.curl,
    FAKE_HDIUTIL_LOG: logs.hdiutil,
    FAKE_INSTALL_LOG: logs.install,
    FAKE_OPEN_LOG: logs.open,
    FAKE_LATEST_JSON: path.join(root, 'latest.json'),
    FAKE_TAG_STATE: path.join(root, 'tag-state'),
    FAKE_TAG_DIR: tagDir,
    FAKE_DMG: dmg,
    FAKE_CHECKSUM: checksum,
    FAKE_MOUNT: mount,
  };

  return { root, env, logs, tag, dmgName, checksumName, dmg };
}

function runInstaller(fixture, source) {
  const args = [INSTALLER];
  if (source !== undefined) args.push(source);
  return spawnSync('sh', args, {
    cwd: REPO_ROOT,
    env: fixture.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

function readLog(filename) {
  if (!fs.existsSync(filename)) return [];
  return fs.readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean);
}

test('latest install freezes one tag and downloads the exact DMG/checksum pair', (t) => {
  const fixture = createFixture(t, { tag: 'v0.5.0+build.1' });

  const result = runInstaller(fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const curlUrls = readLog(fixture.logs.curl);
  assert.deepEqual(curlUrls, [
    'https://api.github.com/repos/cnwenf/codex-switch/releases/latest',
    'https://api.github.com/repos/cnwenf/codex-switch/releases/tags/v0.5.0%2Bbuild.1',
    'https://github.com/cnwenf/codex-switch/releases/download/v0.5.0%2Bbuild.1/CodexSwitch-0.5.0%2Bbuild.1-macos-arm64.dmg',
    'https://github.com/cnwenf/codex-switch/releases/download/v0.5.0%2Bbuild.1/CodexSwitch-0.5.0%2Bbuild.1-macos-arm64.dmg.sha256',
  ]);
  assert.match(result.stdout, /SHA-256 校验通过/);
  assert.match(readLog(fixture.logs.open).join('\n'), /\/Applications\/Codex Switch\.app/);
});

test('latest install polls only the frozen tag until both assets are present', (t) => {
  const tag = 'v0.5.0';
  const dmgName = 'CodexSwitch-0.5.0-macos-arm64.dmg';
  const checksumName = `${dmgName}.sha256`;
  const fixture = createFixture(t, {
    tag,
    tagResponses: [
      releaseJson(tag),
      releaseJson(tag, [dmgName]),
      releaseJson(tag, [dmgName, checksumName]),
    ],
  });

  const result = runInstaller(fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const curlUrls = readLog(fixture.logs.curl);
  assert.equal(curlUrls.filter((url) => url.endsWith('/releases/latest')).length, 1);
  assert.equal(curlUrls.filter((url) => url.includes('/releases/tags/v0.5.0')).length, 3);
  assert.equal(curlUrls.filter((url) => url.includes('/releases/download/')).length, 2);
  assert.match(result.stdout, /DMG 与 checksum 尚未同时就绪/);
});

test('latest install times out with the frozen release URL and rerun command', (t) => {
  const tag = 'v0.5.0';
  const fixture = createFixture(t, {
    tag,
    tagResponses: [releaseJson(tag), releaseJson(tag)],
    pollDelays: '0',
  });

  const result = runInstaller(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GitHub Actions 可能仍在构建/);
  assert.match(result.stderr, /https:\/\/github\.com\/cnwenf\/codex-switch\/releases\/tag\/v0\.5\.0/);
  assert.match(result.stderr, /sh scripts\/install-app\.sh .*CodexSwitch-0\.5\.0-macos-arm64\.dmg/);
  assert.equal(readLog(fixture.logs.install).length, 0);
});

test('latest install rejects a configured polling window over fifteen minutes', (t) => {
  const tag = 'v0.5.0';
  const fixture = createFixture(t, {
    tag,
    tagResponses: [releaseJson(tag), releaseJson(tag, [
      'CodexSwitch-0.5.0-macos-arm64.dmg',
      'CodexSwitch-0.5.0-macos-arm64.dmg.sha256',
    ])],
    pollDelays: '901',
  });

  const result = runInstaller(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /轮询总时长不能超过 900 秒/);
  assert.equal(readLog(fixture.logs.install).length, 0);
});

test('latest install fails closed before mounting when checksum content differs', (t) => {
  const fixture = createFixture(t, {
    checksumContents: `${'0'.repeat(64)}  CodexSwitch-0.5.0-macos-arm64.dmg\n`,
  });

  const result = runInstaller(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256 校验失败/);
  assert.equal(readLog(fixture.logs.hdiutil).length, 0);
  assert.equal(readLog(fixture.logs.install).length, 0);
});

test('latest install rejects a checksum for any basename except the exact asset', (t) => {
  const fixture = createFixture(t, {
    checksumContents: `${'a'.repeat(64)}  another-file.dmg\n`,
  });

  const result = runInstaller(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum 格式无效/);
  assert.equal(readLog(fixture.logs.hdiutil).length, 0);
});

test('latest install rejects a digest that is not exactly 64 hexadecimal characters', (t) => {
  const fixture = createFixture(t, {
    checksumContents: `${'a'.repeat(63)}  CodexSwitch-0.5.0-macos-arm64.dmg\n`,
  });

  const result = runInstaller(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum 格式无效/);
  assert.equal(readLog(fixture.logs.hdiutil).length, 0);
});

test('an explicit DMG URL bypasses release APIs and does not require a remote checksum', (t) => {
  const fixture = createFixture(t);
  const source = 'https://downloads.example.test/custom-build.dmg';

  const result = runInstaller(fixture, source);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readLog(fixture.logs.curl), [source]);
  assert.doesNotMatch(result.stdout, /SHA-256 校验通过/);
});

test('a local DMG bypasses curl and preserves the installation/launch path', (t) => {
  const fixture = createFixture(t);

  const result = runInstaller(fixture, fixture.dmg);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readLog(fixture.logs.curl).length, 0);
  assert.match(readLog(fixture.logs.install).join('\n'), /\/Applications\/Codex Switch\.app/);
  assert.match(readLog(fixture.logs.open).join('\n'), /\/Applications\/Codex Switch\.app/);
});
