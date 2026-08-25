import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function writeExecutable(target, contents) {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

function writeCapturingNode(target) {
  writeExecutable(target, `#!/bin/sh
{
  printf '%s\\0' "\${NODE_EXTRA_CA_CERTS+x}" "\${NODE_EXTRA_CA_CERTS-}" "\${LAUNCH_TEST_VALUE-}" "$0"
  for argument in "$@"; do printf '%s\\0' "$argument"; done
} > "$LAUNCH_CAPTURE"
`);
}

function readNullFields(target) {
  const fields = fs.readFileSync(target).toString().split('\0');
  assert.equal(fields.pop(), '');
  return fields;
}

function findCAArtifacts(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name === 'extra-ca.pem' || entry.name.startsWith('.ca-')) found.push(target);
    }
  };
  visit(root);
  return found;
}

function installToolLinks(bin, tools) {
  for (const [name, target] of Object.entries(tools)) fs.symlinkSync(target, path.join(bin, name));
}

test('source launcher enables system CA without changing inherited extra CA or evaluating argv paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-source-launcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project ' newline\nbackslash \\ $(touch PWNED_SOURCE) `touch PWNED_TICK`");
  const home = path.join(root, 'home');
  const state = path.join(home, '.codex-switch');
  const bin = path.join(root, 'bin');
  const capture = path.join(root, 'launch.capture');
  const caToolMarker = path.join(root, 'ca-tool-called');
  const inheritedCA = path.join(root, "caller extra ' ca.pem");
  const hostileArgs = [
    path.join(root, "arg with spaces ' \\ $(touch PWNED_ARG)"),
    "line one\nline two `touch PWNED_ARG_TICK`",
  ];

  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src'));
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts/start.sh'), path.join(project, 'scripts/start.sh'));
  fs.writeFileSync(path.join(project, 'scripts/prepare-ca.sh'), 'mktemp >/dev/null 2>&1 || :\n');
  fs.writeFileSync(path.join(project, 'src/server.js'), 'fixture');
  fs.writeFileSync(path.join(state, 'env'), "LAUNCH_TEST_VALUE='loaded from env'\nexport LAUNCH_TEST_VALUE\n");
  fs.writeFileSync(inheritedCA, 'caller-owned fixture');
  fs.writeFileSync(path.join(root, 'system.keychain'), 'fixture');
  writeCapturingNode(path.join(bin, 'node'));
  writeExecutable(path.join(bin, 'openssl'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(bin, 'security'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(bin, 'mktemp'), '#!/bin/sh\nprintf called > "$CA_TOOL_MARKER"\nexit 1\n');

  const result = spawnSync('/bin/sh', [path.join(project, 'scripts/start.sh'), ...hostileArgs], {
    cwd: root,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      NODE_EXTRA_CA_CERTS: inheritedCA,
      CODEX_SWITCH_SYSTEM_KEYCHAIN: path.join(root, 'system.keychain'),
      LAUNCH_CAPTURE: capture,
      CA_TOOL_MARKER: caToolMarker,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readNullFields(capture), [
    'x', inheritedCA, 'loaded from env', path.join(bin, 'node'),
    '--use-system-ca', 'src/server.js', ...hostileArgs,
  ]);
  assert.equal(fs.existsSync(caToolMarker), false, 'launcher must not invoke CA bundle tooling');
  assert.deepEqual(findCAArtifacts(home), []);
  assert.equal(fs.existsSync(path.join(root, 'PWNED_SOURCE')), false);
  assert.equal(fs.existsSync(path.join(root, 'PWNED_TICK')), false);
  assert.equal(fs.existsSync(path.join(root, 'PWNED_ARG')), false);
  assert.equal(fs.existsSync(path.join(root, 'PWNED_ARG_TICK')), false);
});

test('packaged server launcher preserves positional paths and inherited CA while enabling system CA', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-server-launcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostile = path.join(root, "single ' double \" newline\nbackslash \\ $(touch PWNED_DOLLAR) `touch PWNED_TICK`");
  const home = path.join(root, 'home');
  const envFile = path.join(hostile, 'local env');
  const nodeBin = path.join(hostile, 'node "bin" $() `tick`');
  const serverJs = path.join(hostile, 'server "file" $() `tick`.js');
  const inheritedCA = path.join(hostile, 'caller extra CA.pem');
  const capture = path.join(root, 'launch-output');
  fs.mkdirSync(hostile);
  fs.mkdirSync(home);
  fs.writeFileSync(envFile, "LAUNCH_TEST_VALUE='loaded from env'\nexport LAUNCH_TEST_VALUE\n");
  fs.writeFileSync(serverJs, 'fixture');
  fs.writeFileSync(inheritedCA, 'caller-owned fixture');
  writeCapturingNode(nodeBin);

  const result = spawnSync('/bin/sh', [
    path.join(REPO_ROOT, 'scripts/launch-server.sh'),
    envFile,
    nodeBin,
    serverJs,
  ], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      NODE_EXTRA_CA_CERTS: inheritedCA,
      LAUNCH_CAPTURE: capture,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readNullFields(capture), [
    'x', inheritedCA, 'loaded from env', nodeBin, '--use-system-ca', serverJs,
  ]);
  assert.deepEqual(findCAArtifacts(home), []);
  assert.equal(fs.existsSync(path.join(root, 'PWNED_DOLLAR')), false);
  assert.equal(fs.existsSync(path.join(root, 'PWNED_TICK')), false);
});

test('build-generated shell fallback uses native system CA and packages no CA generator', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-build-launcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project ' newline\nbackslash \\ $(touch PWNED_BUILD) `touch PWNED_TICK`");
  fs.cpSync(REPO_ROOT, project, {
    recursive: true,
    filter(source) {
      const relative = path.relative(REPO_ROOT, source);
      const top = relative.split(path.sep)[0];
      return !['.git', '.worktrees', 'dist', 'node_modules', '.superpowers'].includes(top);
    },
  });
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const captureApp = path.join(root, 'captured.app');
  const launchOutput = path.join(root, 'launch-output');
  const inheritedCA = path.join(root, "caller extra ' CA.pem");
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.writeFileSync(inheritedCA, 'caller-owned fixture');
  installToolLinks(bin, {
    awk: '/usr/bin/awk', cat: '/bin/cat', chmod: '/bin/chmod', cp: '/bin/cp', dirname: '/usr/bin/dirname',
    du: '/usr/bin/du', grep: '/usr/bin/grep', head: '/usr/bin/head', ln: '/bin/ln',
    mkdir: '/bin/mkdir', rm: '/bin/rm', sed: '/usr/bin/sed',
    sleep: '/bin/sleep', tar: '/usr/bin/tar',
  });
  writeExecutable(path.join(bin, 'shasum'), '#!/bin/sh\nexec /usr/bin/shasum "$@"\n');
  writeExecutable(path.join(bin, 'node'), `#!/bin/sh
if [ "$1" = "-p" ]; then printf '%s\\n' '0.5.0'; exit 0; fi
{
  printf '%s\\0' "\${NODE_EXTRA_CA_CERTS+x}" "\${NODE_EXTRA_CA_CERTS-}" "\${LAUNCH_TEST_VALUE-}" "$0"
  for argument in "$@"; do printf '%s\\0' "$argument"; done
} > "$LAUNCH_CAPTURE"
`);
  writeExecutable(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(bin, 'codesign'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(bin, 'lsof'), '#!/bin/sh\nexit 1\n');
  writeExecutable(path.join(bin, 'open'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(bin, 'hdiutil'), `#!/bin/sh
src=''
previous=''
last=''
for argument in "$@"; do
  if [ "$previous" = '-srcfolder' ]; then src=$argument; fi
  previous=$argument
  last=$argument
done
/bin/cp -R "$src/Codex Switch.app" "$CAPTURE_APP" || exit 1
: > "$last"
`);

  const tarRoot = path.join(root, 'tar-root');
  const runtimeDir = path.join(tarRoot, 'node-v22.23.2-darwin-arm64', 'bin');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(path.join(bin, 'node'), path.join(runtimeDir, 'node'));
  fs.chmodSync(path.join(runtimeDir, 'node'), 0o755);
  const downloads = path.join(project, 'dist', 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const tarball = path.join(downloads, 'node-v22.23.2-darwin-arm64.tar.gz');
  const tarResult = spawnSync('/usr/bin/tar', ['-czf', tarball, '-C', tarRoot, 'node-v22.23.2-darwin-arm64'], { encoding: 'utf8' });
  assert.equal(tarResult.status, 0, tarResult.stderr);
  const digest = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  fs.writeFileSync(path.join(downloads, 'SHASUMS256-v22.23.2.txt'), `${digest}  node-v22.23.2-darwin-arm64.tar.gz\n`);

  const build = spawnSync('/bin/sh', ['scripts/build-macos-app.sh'], {
    cwd: project,
    env: { HOME: home, PATH: bin, CAPTURE_APP: captureApp, LAUNCH_CAPTURE: launchOutput },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

  const launcher = path.join(captureApp, 'Contents', 'MacOS', 'codex-switch-launcher');
  const packagedNode = path.join(captureApp, 'Contents', 'MacOS', 'node');
  const appResources = path.join(captureApp, 'Contents', 'Resources', 'app');
  const serverJs = `${path.dirname(packagedNode)}/../Resources/app/src/server.js`;
  assert.equal(fs.existsSync(path.join(appResources, 'scripts', 'prepare-ca.sh')), false);
  const launch = spawnSync('/bin/sh', [launcher], {
    cwd: project,
    env: {
      HOME: home,
      PATH: bin,
      NODE_EXTRA_CA_CERTS: inheritedCA,
      LAUNCH_CAPTURE: launchOutput,
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(launch.status, 0, `${launch.stdout}\n${launch.stderr}`);
  assert.deepEqual(readNullFields(launchOutput), [
    'x', inheritedCA, '', packagedNode, '--use-system-ca', serverJs,
  ]);
  assert.deepEqual(findCAArtifacts(home), []);
  assert.equal(fs.existsSync(path.join(project, 'PWNED_BUILD')), false);
  assert.equal(fs.existsSync(path.join(project, 'PWNED_TICK')), false);
});

function runInstallVersionGate(t, version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-install-node-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'project');
  const npmMarker = path.join(root, 'npm-called');
  const probeMarker = path.join(root, 'system-ca-probed');
  fs.mkdirSync(bin);
  fs.mkdirSync(project);
  fs.copyFileSync(path.join(REPO_ROOT, 'install.sh'), path.join(project, 'install.sh'));
  fs.writeFileSync(path.join(project, 'config.toml'), '[proxy]\nlisten = "127.0.0.1:8787"\n');
  writeExecutable(path.join(bin, 'node'), `#!/bin/sh
case "$1" in
  -e) printf '%s\\n' "\${NODE_FIXTURE_VERSION%%.*}" ;;
  -p) printf '%s\\n' "$NODE_FIXTURE_VERSION" ;;
  -v) printf 'v%s\\n' "$NODE_FIXTURE_VERSION" ;;
  --use-system-ca)
    printf probed > "$PROBE_MARKER"
    major=\${NODE_FIXTURE_VERSION%%.*}
    remainder=\${NODE_FIXTURE_VERSION#*.}
    minor=\${remainder%%.*}
    if { [ "$major" -eq 22 ] && [ "$minor" -ge 15 ]; } \
      || { [ "$major" -ge 23 ] && { [ "$major" -gt 23 ] || [ "$minor" -ge 8 ]; }; }; then
      exit 0
    fi
    exit 9
    ;;
  *) exit 0 ;;
esac
`);
  writeExecutable(path.join(bin, 'npm'), '#!/bin/sh\nprintf called > "$NPM_MARKER"\nexit 73\n');
  const result = spawnSync('/bin/sh', ['install.sh'], {
    cwd: project,
    env: {
      HOME: path.join(root, 'home'),
      PATH: `${bin}:/usr/bin:/bin`,
      NODE_FIXTURE_VERSION: version,
      NPM_MARKER: npmMarker,
      PROBE_MARKER: probeMarker,
    },
    encoding: 'utf8',
  });
  return { ...result, npmMarker, probeMarker };
}

test('source installer rejects Node 22.14 before dependency installation', (t) => {
  const result = runInstallVersionGate(t, '22.14.9');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /22\.15\.0|23\.8\.0/);
  assert.equal(fs.existsSync(result.npmMarker), false);
  assert.equal(fs.existsSync(result.probeMarker), true);
});

test('source installer admits Node 22.15 through the version gate', (t) => {
  const result = runInstallVersionGate(t, '22.15.0');
  assert.equal(result.status, 73, result.stdout + result.stderr);
  assert.equal(fs.existsSync(result.npmMarker), true);
  assert.equal(fs.existsSync(result.probeMarker), true);
});

test('source installer rejects Node 23.7 when the runtime lacks --use-system-ca', (t) => {
  const result = runInstallVersionGate(t, '23.7.0');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(fs.existsSync(result.npmMarker), false);
  assert.equal(fs.existsSync(result.probeMarker), true);
});

test('source installer admits Node 23.8 when the runtime accepts --use-system-ca', (t) => {
  const result = runInstallVersionGate(t, '23.8.0');
  assert.equal(result.status, 73, result.stdout + result.stderr);
  assert.equal(fs.existsSync(result.npmMarker), true);
  assert.equal(fs.existsSync(result.probeMarker), true);
});

test('package engines express the non-monotonic Node system-CA support range', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(packageJson.engines.node, '>=22.15.0 <23 || >=23.8.0');
  assert.equal(lockfile.packages[''].engines.node, '>=22.15.0 <23 || >=23.8.0');
});
