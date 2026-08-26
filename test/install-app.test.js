import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const INSTALLER = path.join(REPO_ROOT, 'scripts', 'install-app.sh');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-macos-app.sh');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release-dmg.yml');
const APP_BUNDLE_INSTALLER = path.join(REPO_ROOT, 'scripts', 'install-app-bundle.cjs');
const require = createRequire(import.meta.url);

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
  assert.match(workflow, /ref:\s*refs\/tags\/\$\{\{\s*steps\.release\.outputs\.tag\s*\}\}/);
  assert.match(workflow, /EXPECTED_TAG_COMMIT=\$\(git rev-list -n 1 "refs\/tags\/\$TAG"\)/);
  assert.match(workflow, /ACTUAL_HEAD=\$\(git rev-parse HEAD\)/);
  assert.match(workflow, /"\$ACTUAL_HEAD" != "\$EXPECTED_TAG_COMMIT"/);
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

test('macOS build stages the lockfile and installs production dependencies reproducibly', () => {
  const buildScript = fs.readFileSync(BUILD_SCRIPT, 'utf8');

  assert.match(buildScript, /cp package\.json package-lock\.json config\.toml "\$RES\/app\/"/);
  assert.match(buildScript, /cp scripts\/install-app\.sh scripts\/install-app-bundle\.cjs "\$RES\/app\/scripts\/"/);
  assert.match(buildScript, /npm ci --omit=dev --ignore-scripts --no-fund --no-audit --loglevel=error/);
  assert.doesNotMatch(buildScript, /npm install --omit=dev/);
});

test('installer JSON parsing uses only macOS 11 plist interfaces', () => {
  const installer = fs.readFileSync(INSTALLER, 'utf8');

  assert.match(installer, /\/usr\/bin\/plutil -convert xml1/);
  assert.match(installer, /\/usr\/libexec\/PlistBuddy/);
  assert.doesNotMatch(installer, /\braw\b|-expect/);
});

test('installer rm and cp stubs never mutate fixtures or accept paths outside the fixture root', (t) => {
  const fixture = createFixture(t);
  const stubEnv = fixture.env;
  const rmStub = path.join(fixture.root, 'bin', 'rm');
  const cpStub = path.join(fixture.root, 'bin', 'cp');
  const sentinel = path.join(fixture.root, 'sentinel');
  const copied = path.join(fixture.root, 'copied');
  fs.writeFileSync(sentinel, 'keep me');
  assert.doesNotMatch(fs.readFileSync(rmStub, 'utf8'), /exec\s+\/bin\/rm/);
  assert.doesNotMatch(fs.readFileSync(cpStub, 'utf8'), /exec\s+\/bin\/cp/);

  const safeRm = spawnSync(rmStub, ['-rf', sentinel], { env: stubEnv, encoding: 'utf8' });
  assert.equal(safeRm.status, 0, safeRm.stderr);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep me');

  const safeCp = spawnSync(cpStub, [sentinel, copied], { env: stubEnv, encoding: 'utf8' });
  assert.equal(safeCp.status, 0, safeCp.stderr);
  assert.equal(fs.existsSync(copied), false);

  const rejectedRm = spawnSync(rmStub, ['-rf', '/Applications/Codex Switch.app'], {
    env: stubEnv,
    encoding: 'utf8',
  });
  assert.notEqual(rejectedRm.status, 0);

  const rejectedCp = spawnSync(cpStub, ['-R', sentinel, '/Applications/Codex Switch.app'], {
    env: stubEnv,
    encoding: 'utf8',
  });
  assert.notEqual(rejectedCp.status, 0);
});

function releaseJson(tag, assets = []) {
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
    assets: assets.map((asset, index) => ({
      url: `https://api.github.com/repos/cnwenf/codex-switch/releases/assets/${index + 1}`,
      id: index + 1,
      name: typeof asset === 'string' ? asset : asset.name,
      content_type: 'application/octet-stream',
      state: typeof asset === 'string' ? 'uploaded' : asset.state,
      size: 12,
      browser_download_url: typeof asset === 'string'
        ? `https://github.com/cnwenf/codex-switch/releases/download/${tag}/${asset}`
        : asset.browser_download_url ?? `https://github.com/cnwenf/codex-switch/releases/download/${tag}/${asset.name}`,
    })),
  });
}

function writeExecutable(filename, source) {
  fs.writeFileSync(filename, source, { mode: 0o755 });
}

function createFixture(t, {
  tag = 'v0.5.0',
  tagResponses,
  tagStatuses = [],
  tagCurlExitStatuses = [],
  latestStatus = 200,
  latestResponse,
  dmgContents = 'fixture dmg bytes',
  checksumContents,
  pollDelays = '0 0 0',
  timeoutSeconds = 900,
  curlAdvanceSeconds = 0,
  startEpoch = 1000,
  useRealCurl = false,
  useRealClock = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-installer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const tagDir = path.join(root, 'tag-responses');
  const mount = path.join(root, 'mounted volume');
  const dest = path.join(root, 'Applications', 'Codex Switch.app');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(tagDir);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.mkdirSync(path.join(mount, 'Codex Switch.app'), { recursive: true });
  fs.mkdirSync(path.join(mount, 'Codex Switch.app', 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(mount, 'Codex Switch.app', 'Contents', 'Resources', 'app', 'scripts'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(mount, 'Codex Switch.app', 'Contents', 'MacOS', 'node'));
  fs.copyFileSync(
    APP_BUNDLE_INSTALLER,
    path.join(mount, 'Codex Switch.app', 'Contents', 'Resources', 'app', 'scripts', 'install-app-bundle.cjs'),
  );

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
    fs.writeFileSync(path.join(tagDir, `${index + 1}.status`), String(tagStatuses[index] ?? 200));
    fs.writeFileSync(path.join(tagDir, `${index + 1}.exit`), String(tagCurlExitStatuses[index] ?? 0));
  });
  fs.writeFileSync(path.join(root, 'latest.json'), latestResponse ?? releaseJson(tag));
  fs.writeFileSync(path.join(root, 'now'), String(startEpoch));

  if (!useRealCurl) writeExecutable(path.join(bin, 'curl'), String.raw`#!/bin/sh
set -eu
output=
write_out=
url=
fail_on_http=false
printf '%s\n' "$*" >> "$FAKE_CURL_ARGS_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -w|--write-out) write_out=$2; shift 2 ;;
    --retry|--retry-delay|--retry-max-time|--max-time|--connect-timeout|--resolve) shift 2 ;;
    -f|-f*) fail_on_http=true; shift ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\n' "$url" >> "$FAKE_CURL_LOG"
now=$(/bin/cat "$FAKE_NOW_FILE")
printf '%s\n' "$((now + FAKE_CURL_ADVANCE_SECONDS))" > "$FAKE_NOW_FILE"
status=200
curl_exit=0
body=
effective_url=$url
case "$url" in
  https://api.github.com/*/releases/latest)
    status=$FAKE_LATEST_STATUS
    body=$FAKE_LATEST_JSON
    ;;
  https://github.com/*/releases/latest)
    effective_url="https://github.com/cnwenf/codex-switch/releases/tag/$FAKE_LATEST_TAG"
    ;;
  */releases/tags/*)
    count=0
    [ ! -f "$FAKE_TAG_STATE" ] || count=$(/bin/cat "$FAKE_TAG_STATE")
    count=$((count + 1))
    printf '%s\n' "$count" > "$FAKE_TAG_STATE"
    response="$FAKE_TAG_DIR/$count.json"
    [ -f "$response" ] || exit 22
    status=$(/bin/cat "$FAKE_TAG_DIR/$count.status")
    curl_exit=$(/bin/cat "$FAKE_TAG_DIR/$count.exit")
    body=$response
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
if [ -n "$body" ]; then
  if [ -n "$output" ]; then
    /bin/cp "$body" "$output"
  else
    /bin/cat "$body"
  fi
fi
if [ -n "$write_out" ]; then
  case "$write_out" in
    *url_effective*) printf '%s' "$effective_url" ;;
    *) printf '%s' "$status" ;;
  esac
fi
[ "$curl_exit" -eq 0 ] || exit "$curl_exit"
if [ "$fail_on_http" = true ] && [ "$status" -ge 400 ]; then
  exit 22
fi
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
set -eu
[ -n "$FAKE_FIXTURE_ROOT" ] || exit 97
is_install=false
for operand in "$@"; do
  case "$operand" in
    -*) continue ;;
    "$FAKE_FIXTURE_ROOT"|"$FAKE_FIXTURE_ROOT"/*) ;;
    *) printf 'refusing rm outside fixture root: %s\n' "$operand" >&2; exit 97 ;;
  esac
  [ "$operand" != "$CODEX_SWITCH_INSTALL_DEST" ] || is_install=true
done
[ "$is_install" != true ] || printf '%s\n' "$*" >> "$FAKE_INSTALL_LOG"
exit 0
`);

  writeExecutable(path.join(bin, 'cp'), String.raw`#!/bin/sh
set -eu
[ -n "$FAKE_FIXTURE_ROOT" ] || exit 97
is_install=false
for operand in "$@"; do
  case "$operand" in
    -*) continue ;;
    "$FAKE_FIXTURE_ROOT"|"$FAKE_FIXTURE_ROOT"/*) ;;
    *) printf 'refusing cp outside fixture root: %s\n' "$operand" >&2; exit 97 ;;
  esac
  [ "$operand" != "$CODEX_SWITCH_INSTALL_DEST" ] || is_install=true
done
[ "$is_install" != true ] || printf '%s\n' "$*" >> "$FAKE_INSTALL_LOG"
exit 0
`);

  writeExecutable(path.join(bin, 'open'), String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_OPEN_LOG"
`);
  writeExecutable(path.join(bin, 'xattr'), '#!/bin/sh\nexit 0\n');
  if (!useRealClock) writeExecutable(path.join(bin, 'date'), String.raw`#!/bin/sh
set -eu
[ "$#" -eq 1 ] && [ "$1" = +%s ] || exit 2
/bin/cat "$FAKE_NOW_FILE"
`);
  if (!useRealClock) writeExecutable(path.join(bin, 'sleep'), String.raw`#!/bin/sh
set -eu
case "$1" in ''|*[!0-9]*) exit 2 ;; esac
now=$(/bin/cat "$FAKE_NOW_FILE")
printf '%s\n' "$((now + $1))" > "$FAKE_NOW_FILE"
printf '%s\n' "$1" >> "$FAKE_SLEEP_LOG"
`);

  const logs = {
    curl: path.join(root, 'curl.log'),
    curlArgs: path.join(root, 'curl-args.log'),
    hdiutil: path.join(root, 'hdiutil.log'),
    install: path.join(root, 'install.log'),
    open: path.join(root, 'open.log'),
    sleep: path.join(root, 'sleep.log'),
  };
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    TMPDIR: root,
    CODEX_SWITCH_INSTALL_DEST: dest,
    CODEX_SWITCH_RELEASE_POLL_DELAYS: pollDelays,
    CODEX_SWITCH_RELEASE_TIMEOUT_SECONDS: String(timeoutSeconds),
    FAKE_FIXTURE_ROOT: root,
    FAKE_CURL_LOG: logs.curl,
    FAKE_CURL_ARGS_LOG: logs.curlArgs,
    FAKE_CURL_ADVANCE_SECONDS: String(curlAdvanceSeconds),
    FAKE_HDIUTIL_LOG: logs.hdiutil,
    FAKE_INSTALL_LOG: logs.install,
    FAKE_OPEN_LOG: logs.open,
    FAKE_SLEEP_LOG: logs.sleep,
    FAKE_NOW_FILE: path.join(root, 'now'),
    FAKE_LATEST_JSON: path.join(root, 'latest.json'),
    FAKE_LATEST_STATUS: String(latestStatus),
    FAKE_LATEST_TAG: tag,
    FAKE_TAG_STATE: path.join(root, 'tag-state'),
    FAKE_TAG_DIR: tagDir,
    FAKE_DMG: dmg,
    FAKE_CHECKSUM: checksum,
    FAKE_MOUNT: mount,
  };

  return { root, bin, dest, env, logs, tag, dmgName, checksumName, dmg, nowFile: path.join(root, 'now') };
}

function runInstaller(fixture, source) {
  const args = [INSTALLER];
  if (Array.isArray(source)) args.push(...source);
  else if (source !== undefined) args.push(source);
  return spawnSync('sh', args, {
    cwd: REPO_ROOT,
    env: fixture.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

function runPipedInstaller(fixture, source) {
  return spawnSync('sh', ['-s', '--', source], {
    cwd: fixture.root,
    env: fixture.env,
    input: fs.readFileSync(INSTALLER, 'utf8'),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

function readLog(filename) {
  if (!fs.existsSync(filename)) return [];
  return fs.readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean);
}

function loadAppBundleInstaller() {
  assert.equal(fs.existsSync(APP_BUNDLE_INSTALLER), true);
  const module = require(APP_BUNDLE_INSTALLER);
  assert.equal(typeof module.installAppBundle, 'function');
  return module.installAppBundle;
}

function createBundleSwapFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-bundle-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'Applications'), { recursive: true });
  const physicalParent = fs.realpathSync(path.join(root, 'Applications'));
  const sourceApp = path.join(root, 'Mounted', 'Codex Switch.app');
  const destination = path.join(physicalParent, 'Codex Switch.app');
  fs.mkdirSync(sourceApp, { recursive: true });
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(sourceApp, 'version'), 'new');
  fs.writeFileSync(path.join(destination, 'version'), 'old');
  return { root, physicalParent, sourceApp, destination };
}

test('shared app-bundle installer stages and atomically replaces a validated destination', (t) => {
  const installAppBundle = loadAppBundleInstaller();
  const fixture = createBundleSwapFixture(t);
  installAppBundle(fixture);
  assert.equal(fs.readFileSync(path.join(fixture.destination, 'version'), 'utf8'), 'new');
  assert.deepEqual(
    fs.readdirSync(fixture.physicalParent).filter((name) => name.startsWith('.codex-switch-')),
    [],
  );
});

test('shared app-bundle installer preserves the live app when staging copy fails', (t) => {
  const installAppBundle = loadAppBundleInstaller();
  const fixture = createBundleSwapFixture(t);
  const failingFs = { ...fs, cpSync() { throw new Error('fixture copy failure'); } };
  assert.throws(() => installAppBundle({ ...fixture, fsImpl: failingFs }), /copy failure/);
  assert.equal(fs.readFileSync(path.join(fixture.destination, 'version'), 'utf8'), 'old');
});

test('shared app-bundle installer rolls the previous app back when the final rename fails', (t) => {
  const installAppBundle = loadAppBundleInstaller();
  const fixture = createBundleSwapFixture(t);
  let renameCount = 0;
  const failingFs = {
    ...fs,
    renameSync(...args) {
      renameCount += 1;
      if (renameCount === 2) throw new Error('fixture rename failure');
      return fs.renameSync(...args);
    },
  };
  assert.throws(() => installAppBundle({ ...fixture, fsImpl: failingFs }), /rename failure/);
  assert.equal(fs.readFileSync(path.join(fixture.destination, 'version'), 'utf8'), 'old');
  assert.equal(fs.readdirSync(fixture.physicalParent).some((name) => name.startsWith('.codex-switch-backup.')), false);
});

async function startDeadlineHttpServer(t, root) {
  const serverFile = path.join(root, 'deadline-server.cjs');
  const eventLog = path.join(root, 'http-events.log');
  fs.writeFileSync(serverFile, String.raw`const fs = require('node:fs');
const http = require('node:http');

const eventLog = process.argv[2];
let requests = 0;
const server = http.createServer((_request, response) => {
  requests += 1;
  fs.appendFileSync(eventLog, 'request-' + requests + '\n');
  if (requests === 1) {
    fs.appendFileSync(eventLog, 'response-1-429\n');
    response.writeHead(429, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end('{"message":"rate limited"}');
    return;
  }
  fs.appendFileSync(eventLog, 'response-2-blocking-start\n');
  response.once('close', () => {
    fs.appendFileSync(eventLog, 'response-2-client-closed\n');
  });
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.write('{"assets":[');
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write('READY ' + server.address().port + '\n');
});
`);

  const child = spawn(process.execPath, [serverFile, eventLog], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));

  return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`local HTTP fixture did not start: ${stderr}`));
    }, 3000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/READY ([0-9]+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ apiBase: `http://127.0.0.1:${match[1]}`, eventLog });
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`local HTTP fixture exited ${code}: ${stderr}`));
    });
  });
}

function installRealCurlProxy(fixture, apiBase) {
  writeExecutable(path.join(fixture.bin, 'curl'), String.raw`#!/bin/sh
set -eu
output=
write_out=
max_time=
connect_timeout=
retry=
retry_delay=
retry_max_time=
url=
printf '%s\n' "$*" >> "$FAKE_CURL_ARGS_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -w|--write-out) write_out=$2; shift 2 ;;
    --max-time) max_time=$2; shift 2 ;;
    --connect-timeout) connect_timeout=$2; shift 2 ;;
    --retry) retry=$2; shift 2 ;;
    --retry-delay) retry_delay=$2; shift 2 ;;
    --retry-max-time) retry_max_time=$2; shift 2 ;;
    --resolve) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  https://api.github.com/*)
    suffix=$(printf '%s' "$url" | /usr/bin/sed 's#^https://api.github.com##')
    url="$REAL_HTTP_API_BASE$suffix"
    ;;
  *) exit 97 ;;
esac
set -- /usr/bin/curl -sSL
[ -z "$max_time" ] || set -- "$@" --max-time "$max_time"
[ -z "$connect_timeout" ] || set -- "$@" --connect-timeout "$connect_timeout"
[ -z "$retry" ] || set -- "$@" --retry "$retry"
[ -z "$retry_delay" ] || set -- "$@" --retry-delay "$retry_delay"
[ -z "$retry_max_time" ] || set -- "$@" --retry-max-time "$retry_max_time"
[ -z "$output" ] || set -- "$@" -o "$output"
[ -z "$write_out" ] || set -- "$@" --write-out "$write_out"
set -- "$@" "$url"
exec "$@"
`);
  fixture.env.REAL_HTTP_API_BASE = apiBase;
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
  assert.match(readLog(fixture.logs.open).join('\n'), new RegExp(fixture.dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('latest install falls back to public release URLs when anonymous API quota is exhausted', (t) => {
  const tag = 'v0.5.0';
  const fixture = createFixture(t, { tag, latestStatus: 403 });

  const result = runInstaller(fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /API.*限流.*公开 Release/);
  assert.deepEqual(readLog(fixture.logs.curl), [
    'https://api.github.com/repos/cnwenf/codex-switch/releases/latest',
    'https://github.com/cnwenf/codex-switch/releases/latest',
    'https://github.com/cnwenf/codex-switch/releases/download/v0.5.0/CodexSwitch-0.5.0-macos-arm64.dmg.sha256',
    'https://github.com/cnwenf/codex-switch/releases/download/v0.5.0/CodexSwitch-0.5.0-macos-arm64.dmg',
    'https://github.com/cnwenf/codex-switch/releases/download/v0.5.0/CodexSwitch-0.5.0-macos-arm64.dmg',
    'https://github.com/cnwenf/codex-switch/releases/download/v0.5.0/CodexSwitch-0.5.0-macos-arm64.dmg.sha256',
  ]);
  assert.equal(readLog(fixture.logs.sleep).length, 0);
  assert.match(result.stdout, /SHA-256 校验通过/);
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

test('release title and body cannot impersonate a missing uploaded DMG asset', (t) => {
  const tag = 'v0.5.0';
  const dmgName = 'CodexSwitch-0.5.0-macos-arm64.dmg';
  const checksumName = `${dmgName}.sha256`;
  const metadata = JSON.parse(releaseJson(tag, [checksumName]));
  metadata.name = dmgName;
  metadata.body = `pending ${dmgName} and ${checksumName}`;
  const response = JSON.stringify(metadata);
  const fixture = createFixture(t, {
    tag,
    tagResponses: [response, response],
    pollDelays: '0',
  });

  const result = runInstaller(fixture, ['--release-tag', tag]);

  assert.notEqual(result.status, 0);
  assert.equal(readLog(fixture.logs.curl).some((url) => url.includes('/releases/download/')), false);
});

test('starter assets are not treated as uploaded release assets', (t) => {
  const tag = 'v0.5.0';
  const dmgName = 'CodexSwitch-0.5.0-macos-arm64.dmg';
  const checksumName = `${dmgName}.sha256`;
  const response = releaseJson(tag, [
    { name: dmgName, state: 'starter' },
    { name: checksumName, state: 'starter' },
  ]);
  const fixture = createFixture(t, {
    tag,
    tagResponses: [response, response],
    pollDelays: '0',
  });

  const result = runInstaller(fixture, ['--release-tag', tag]);

  assert.notEqual(result.status, 0);
  assert.equal(readLog(fixture.logs.curl).some((url) => url.includes('/releases/download/')), false);
});

test('duplicate exact-name assets fail closed instead of selecting one arbitrarily', (t) => {
  const tag = 'v0.5.0';
  const dmgName = 'CodexSwitch-0.5.0-macos-arm64.dmg';
  const checksumName = `${dmgName}.sha256`;
  const response = releaseJson(tag, [dmgName, dmgName, checksumName]);
  const fixture = createFixture(t, {
    tag,
    tagResponses: [response, response],
    pollDelays: '0',
  });

  const result = runInstaller(fixture, ['--release-tag', tag]);

  assert.notEqual(result.status, 0);
  assert.equal(readLog(fixture.logs.curl).some((url) => url.includes('/releases/download/')), false);
});

test('malformed release assets metadata fails closed with a clear error', (t) => {
  const tag = 'v0.5.0';
  const metadata = JSON.parse(releaseJson(tag));
  metadata.assets = { name: 'not-an-array' };
  const fixture = createFixture(t, {
    tag,
    tagResponses: [JSON.stringify(metadata)],
    pollDelays: '0',
  });

  const result = runInstaller(fixture, ['--release-tag', tag]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Release 资产元数据无效/);
  assert.equal(readLog(fixture.logs.curl).some((url) => url.includes('/releases/download/')), false);
});

test('exact-tag metadata tag_name must byte-match the frozen tag before assets are parsed', async (t) => {
  const tag = 'v0.5.0';
  const dmgName = 'CodexSwitch-0.5.0-macos-arm64.dmg';
  const checksumName = `${dmgName}.sha256`;
  const readyMetadata = JSON.parse(releaseJson(tag, [dmgName, checksumName]));
  const missingTag = { ...readyMetadata };
  delete missingTag.tag_name;
  const wrongTagWithMalformedAssets = {
    ...readyMetadata,
    tag_name: 'v9.9.9',
    assets: { name: 'not-an-array' },
  };
  const duplicateTag = releaseJson(tag, [dmgName, checksumName])
    .replace(/^\{/, `{"tag_name":"${tag}",`);
  const cases = [
    ['another tag', JSON.stringify({ ...readyMetadata, tag_name: 'v9.9.9' })],
    ['reviewer tag with trailing LF', JSON.stringify({ ...readyMetadata, tag_name: 'v9.9.9\n' })],
    ['frozen tag with trailing LF', JSON.stringify({ ...readyMetadata, tag_name: `${tag}\n` })],
    ['frozen tag with trailing CR', JSON.stringify({ ...readyMetadata, tag_name: `${tag}\r` })],
    ['frozen tag with embedded NUL', JSON.stringify({ ...readyMetadata, tag_name: `${tag}\0` })],
    ['missing tag_name', JSON.stringify(missingTag)],
    ['duplicate tag_name', duplicateTag],
    ['non-string tag_name', JSON.stringify({ ...readyMetadata, tag_name: 500 })],
    ['wrong tag before malformed assets', JSON.stringify(wrongTagWithMalformedAssets)],
  ];

  for (const [label, response] of cases) {
    await t.test(label, (subtest) => {
      const fixture = createFixture(subtest, {
        tag,
        tagResponses: [response],
        pollDelays: '0',
      });

      const result = runInstaller(fixture, ['--release-tag', tag]);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Release tag_name 元数据无效/);
      assert.doesNotMatch(result.stderr, /\/usr\/bin\/awk:|syntax error|bailing out/);
      assert.equal(readLog(fixture.logs.curl).filter((url) => url.includes('/releases/tags/')).length, 1);
      assert.equal(readLog(fixture.logs.curl).some((url) => url.includes('/releases/download/')), false);
      assert.equal(readLog(fixture.logs.hdiutil).length, 0);
      assert.equal(readLog(fixture.logs.install).length, 0);
    });
  }
});

test('release asset fields are compared byte-for-byte without trimming control bytes', async (t) => {
  const tag = 'v0.5.0';
  const dmgName = 'CodexSwitch-0.5.0-macos-arm64.dmg';
  const checksumName = `${dmgName}.sha256`;
  const dmgUrl = `https://github.com/cnwenf/codex-switch/releases/download/${tag}/${dmgName}`;
  const cases = [
    ['name trailing LF', { name: `${dmgName}\n`, state: 'uploaded', browser_download_url: dmgUrl }],
    ['name trailing CR', { name: `${dmgName}\r`, state: 'uploaded', browser_download_url: dmgUrl }],
    ['name embedded NUL', { name: `${dmgName}\0`, state: 'uploaded', browser_download_url: dmgUrl }],
    ['state trailing LF', { name: dmgName, state: 'uploaded\n', browser_download_url: dmgUrl }],
    ['download URL trailing LF', { name: dmgName, state: 'uploaded', browser_download_url: `${dmgUrl}\n` }],
    ['different download URL', { name: dmgName, state: 'uploaded', browser_download_url: 'https://example.test/other.dmg' }],
  ];

  for (const [label, maliciousDmg] of cases) {
    await t.test(label, (subtest) => {
      const response = releaseJson(tag, [maliciousDmg, checksumName]);
      const fixture = createFixture(subtest, {
        tag,
        tagResponses: [response, response],
        pollDelays: '0',
      });

      const result = runInstaller(fixture, ['--release-tag', tag]);

      assert.notEqual(result.status, 0);
      assert.equal(readLog(fixture.logs.curl).some((url) => url.includes('/releases/download/')), false);
      assert.equal(readLog(fixture.logs.hdiutil).length, 0);
    });
  }
});

test('a newline-bearing latest tag cannot be trimmed into a trusted download URL', (t) => {
  const tag = 'v0.5.0';
  const fixture = createFixture(t, {
    tag,
    latestResponse: releaseJson(`${tag}\n`),
  });

  const result = runInstaller(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /无效 tag|元数据无效/);
  assert.equal(readLog(fixture.logs.curl).some((url) => url.includes('/releases/download/')), false);
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
  assert.match(result.stderr, /sh scripts\/install-app\.sh --release-tag 'v0\.5\.0'/);
  assert.doesNotMatch(result.stderr, /releases\/download/);
  assert.equal(readLog(fixture.logs.install).length, 0);
});

test('an exact release tag bypasses latest but still waits for and verifies the asset pair', (t) => {
  const tag = 'v0.5.0+build.1';
  const dmgName = 'CodexSwitch-0.5.0+build.1-macos-arm64.dmg';
  const checksumName = `${dmgName}.sha256`;
  const metadata = JSON.parse(releaseJson(tag, [
    {
      name: '工具-预览.dmg',
      state: 'uploaded',
      browser_download_url: 'https://github.com/cnwenf/codex-switch/releases/download/v0.5.0%2Bbuild.1/%E5%B7%A5%E5%85%B7.dmg',
    },
    dmgName,
    checksumName,
  ]));
  metadata.name = '构建版本 🧪';
  metadata.body = '正常 Unicode 元数据不影响精确资产匹配。';
  const fixture = createFixture(t, {
    tag,
    tagResponses: [JSON.stringify(metadata)],
  });

  const result = runInstaller(fixture, ['--release-tag', fixture.tag]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readLog(fixture.logs.curl), [
    'https://api.github.com/repos/cnwenf/codex-switch/releases/tags/v0.5.0%2Bbuild.1',
    'https://github.com/cnwenf/codex-switch/releases/download/v0.5.0%2Bbuild.1/CodexSwitch-0.5.0%2Bbuild.1-macos-arm64.dmg',
    'https://github.com/cnwenf/codex-switch/releases/download/v0.5.0%2Bbuild.1/CodexSwitch-0.5.0%2Bbuild.1-macos-arm64.dmg.sha256',
  ]);
  assert.match(result.stdout, /SHA-256 校验通过/);
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

test('release polling enforces a real wall-clock deadline and caps every API curl to remaining time', (t) => {
  const tag = 'v0.5.0';
  const empty = releaseJson(tag);
  const fixture = createFixture(t, {
    tag,
    tagResponses: [empty, empty, empty, empty],
    pollDelays: '4 4 4',
    timeoutSeconds: 5,
    curlAdvanceSeconds: 2,
    startEpoch: 1000,
  });

  const result = runInstaller(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /等待 Release 资产超时/);
  assert.equal(Number(fs.readFileSync(fixture.nowFile, 'utf8')), 1005);
  const apiArgs = readLog(fixture.logs.curlArgs).filter((line) => line.includes('api.github.com'));
  assert.deepEqual(apiArgs.map((line) => Number(line.match(/--max-time ([0-9]+)/)?.[1])), [5, 3]);
  for (const args of apiArgs) {
    const maxTime = Number(args.match(/--max-time ([0-9]+)/)?.[1]);
    assert.equal(Number(args.match(/--connect-timeout ([0-9]+)/)?.[1]), maxTime);
    assert.doesNotMatch(args, /--retry(?:[ -]|$)/);
  }
  assert.equal(readLog(fixture.logs.curl).some((url) => url.includes('/releases/download/')), false);
});

test('a real rate-limited metadata request switches to public assets within the deadline', async (t) => {
  const fixture = createFixture(t, {
    pollDelays: '0 0',
    timeoutSeconds: 2,
    useRealCurl: true,
    useRealClock: true,
  });
  const server = await startDeadlineHttpServer(t, fixture.root);
  installRealCurlProxy(fixture, server.apiBase);

  const startedAt = performance.now();
  const result = runInstaller(fixture, ['--release-tag', fixture.tag]);
  const elapsedMs = performance.now() - startedAt;

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /等待 Release 资产超时/);
  assert.ok(elapsedMs < 3200, `two-second deadline overran: ${elapsedMs}ms`);
  const events = readLog(server.eventLog);
  assert.deepEqual(events.filter((event) => event.startsWith('request-')), ['request-1']);
  assert.equal(events.includes('response-1-429'), true);
  assert.equal(events.includes('response-2-blocking-start'), false);
  const metadataArgs = readLog(fixture.logs.curlArgs).filter((line) => line.includes('/releases/tags/'));
  assert.equal(metadataArgs.length, 1);
  assert.equal(metadataArgs.every((line) => !/--retry(?:[ -]|$)/.test(line)), true);
  assert.equal(readLog(fixture.logs.curlArgs).some((line) => line.includes('/releases/download/')), true);
});

test('GitHub rate limits switch an exact tag immediately to public release assets', (t) => {
  const tag = 'v0.5.0';
  const dmgName = 'CodexSwitch-0.5.0-macos-arm64.dmg';
  const checksumName = `${dmgName}.sha256`;
  const fixture = createFixture(t, {
    tag,
    tagResponses: [releaseJson(tag)],
    tagStatuses: [429],
    pollDelays: '1 1 1',
    timeoutSeconds: 30,
  });

  const result = runInstaller(fixture, ['--release-tag', tag]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /GitHub API.*速率限制.*公开 Release/);
  assert.equal(readLog(fixture.logs.curl).filter((url) => url.includes('/releases/tags/')).length, 1);
  assert.equal(readLog(fixture.logs.curl).filter((url) => url.includes('/releases/download/')).length, 4);
  assert.equal(readLog(fixture.logs.sleep).length, 0);
  const tagArgs = readLog(fixture.logs.curlArgs).filter((line) => line.includes('/releases/tags/'));
  assert.equal(tagArgs.every((line) => !/--retry(?:[ -]|$)/.test(line)), true);
  assert.match(result.stdout, /SHA-256 校验通过/);
});

test('tag metadata DNS and HTTP failures retry only in the outer frozen-tag loop', (t) => {
  const tag = 'v0.5.0';
  const dmgName = 'CodexSwitch-0.5.0-macos-arm64.dmg';
  const checksumName = `${dmgName}.sha256`;
  const fixture = createFixture(t, {
    tag,
    tagResponses: [
      releaseJson(tag),
      releaseJson(tag),
      releaseJson(tag, [dmgName, checksumName]),
    ],
    tagStatuses: [0, 500, 200],
    tagCurlExitStatuses: [6, 0, 0],
    pollDelays: '0 0 0',
    timeoutSeconds: 30,
  });

  const result = runInstaller(fixture, ['--release-tag', tag]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /GitHub API 暂时不可用/);
  assert.equal(readLog(fixture.logs.curl).filter((url) => url.includes('/releases/tags/')).length, 3);
  const tagArgs = readLog(fixture.logs.curlArgs).filter((line) => line.includes('/releases/tags/'));
  assert.equal(tagArgs.every((line) => !/--retry(?:[ -]|$)/.test(line)), true);
  assert.match(result.stdout, /SHA-256 校验通过/);
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
  assert.equal(fs.lstatSync(fixture.dest).isSymbolicLink(), false);
  assert.equal(fs.statSync(fixture.dest).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(fixture.dest, 'Contents', 'MacOS', 'node')), true);
  assert.match(readLog(fixture.logs.open).join('\n'), new RegExp(fixture.dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a curl-piped installer uses the bundle swap helper embedded in the mounted app', (t) => {
  const fixture = createFixture(t);

  const result = runPipedInstaller(fixture, fixture.dmg);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /缺少共享安全换包实现/);
  assert.equal(fs.lstatSync(fixture.dest).isSymbolicLink(), false);
  assert.equal(fs.statSync(fixture.dest).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(fixture.dest, 'Contents', 'MacOS', 'node')), true);
});

test('installer rejects unsafe destination overrides before mount or copy', async (t) => {
  const cases = [
    ['filesystem root', '/'],
    ['home directory', null],
    ['Applications directory', '/Applications'],
    ['relative path', 'Applications/Codex Switch.app'],
    ['dot segment', '/tmp/../Applications/Codex Switch.app'],
    ['wrong app basename', '/tmp/Other.app'],
    ['unexpected parent', '/tmp/Codex Switch.app'],
  ];

  for (const [label, requestedDestination] of cases) {
    await t.test(label, (subtest) => {
      const fixture = createFixture(subtest);
      fixture.env.CODEX_SWITCH_INSTALL_DEST = requestedDestination ?? fixture.env.HOME;
      const result = runInstaller(fixture, fixture.dmg);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /安装目标.*无效|拒绝.*安装目标/);
      assert.equal(readLog(fixture.logs.hdiutil).length, 0);
      assert.equal(readLog(fixture.logs.install).length, 0);
    });
  }
});

test('installer rejects an explicitly empty destination before mount or copy', (t) => {
  const fixture = createFixture(t);
  fixture.env.CODEX_SWITCH_INSTALL_DEST = '';

  const result = runInstaller(fixture, fixture.dmg);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /安装目标.*不能为空/);
  assert.equal(readLog(fixture.logs.hdiutil).length, 0);
  assert.equal(readLog(fixture.logs.install).length, 0);
});

test('installer rejects destination symlink escapes before mount or copy', (t) => {
  const fixture = createFixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-installer-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const linkedParent = path.join(fixture.root, 'linked-Applications');
  fs.symlinkSync(outside, linkedParent);
  fixture.env.CODEX_SWITCH_INSTALL_DEST = path.join(linkedParent, 'Codex Switch.app');

  const result = runInstaller(fixture, fixture.dmg);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /安装目标.*无效|拒绝.*安装目标/);
  assert.equal(readLog(fixture.logs.hdiutil).length, 0);
  assert.equal(readLog(fixture.logs.install).length, 0);
  assert.equal(fs.existsSync(path.join(outside, 'Codex Switch.app')), false);
});

test('installer never follows a destination symlink swapped in after validation', (t) => {
  const fixture = createFixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-installer-race-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'outside must survive');
  fs.mkdirSync(fixture.dest, { recursive: true });
  fs.writeFileSync(path.join(fixture.dest, 'old.txt'), 'old install');

  const mountedNode = path.join(fixture.env.FAKE_MOUNT, 'Codex Switch.app', 'Contents', 'MacOS', 'node');
  const helperMarker = path.join(fixture.root, 'atomic-helper-invoked');
  fs.unlinkSync(mountedNode);
  writeExecutable(mountedNode, String.raw`#!/bin/sh
set -eu
printf 'invoked\n' > "$FIXTURE_HELPER_MARKER"
/bin/rm -rf "$CODEX_SWITCH_INSTALL_DEST"
/bin/ln -s "$FIXTURE_ATTACK_TARGET" "$CODEX_SWITCH_INSTALL_DEST"
exec "$FIXTURE_REAL_NODE" "$@"
`);
  fixture.env.FIXTURE_ATTACK_TARGET = outside;
  fixture.env.FIXTURE_REAL_NODE = process.execPath;
  fixture.env.FIXTURE_HELPER_MARKER = helperMarker;

  const result = runInstaller(fixture, fixture.dmg);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(helperMarker, 'utf8'), 'invoked\n');
  assert.equal(fs.lstatSync(fixture.dest).isSymbolicLink(), false);
  assert.equal(fs.statSync(fixture.dest).isDirectory(), true);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside must survive');
  assert.equal(fs.existsSync(path.join(outside, 'Codex Switch.app')), false);
});
