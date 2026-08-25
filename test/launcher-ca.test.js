import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);

function createCertificate(root, name) {
  const key = path.join(root, `${name}.key`);
  const cert = path.join(root, `${name}.pem`);
  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', `/CN=${name}`, '-keyout', key, '-out', cert,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return cert;
}

test('CA preparation preserves an existing bundle and exports only the combined file path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const existing = path.join(root, 'existing.pem');
  fs.writeFileSync(path.join(root, 'system.keychain'), 'fixture keychain placeholder');
  fs.writeFileSync(existing, 'fixture-existing-ca\n', { mode: 0o600 });
  const security = path.join(bin, 'security');
  fs.writeFileSync(security, `#!/bin/sh
if [ "$1" = "login-keychain" ]; then
  echo '"${root}/login.keychain-db"'
  exit 0
fi
if [ "$1" = "find-certificate" ]; then
  echo 'fixture-keychain-ca'
  exit 0
fi
exit 1
`, { mode: 0o755 });

  const result = spawnSync('/bin/sh', ['-c', '. ./scripts/prepare-ca.sh; printf "%s" "$NODE_EXTRA_CA_CERTS"'], {
    cwd: REPO_ROOT,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      NODE_EXTRA_CA_CERTS: existing,
      CODEX_SWITCH_SYSTEM_KEYCHAIN: path.join(root, 'system.keychain'),
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const bundle = path.join(home, '.codex-switch', 'extra-ca.pem');
  assert.equal(result.stdout, bundle);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'fixture-existing-ca\n');
  assert.match(fs.readFileSync(bundle, 'utf8'), /fixture-existing-ca/);
  assert.match(fs.readFileSync(bundle, 'utf8'), /fixture-keychain-ca/);
  assert.equal(result.stderr.includes('fixture-existing-ca'), false);
  assert.equal(result.stderr.includes('fixture-keychain-ca'), false);
});

test('CA preparation separates PEM inputs that have no trailing newline into a parseable bundle', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-pem-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const existing = createCertificate(root, 'existing-extra-ca');
  const keychain = createCertificate(root, 'system-keychain-ca');
  fs.writeFileSync(existing, fs.readFileSync(existing, 'utf8').trimEnd(), { mode: 0o600 });
  fs.writeFileSync(keychain, fs.readFileSync(keychain, 'utf8').trimEnd(), { mode: 0o600 });
  const systemKeychain = path.join(root, 'system.keychain');
  fs.writeFileSync(systemKeychain, 'fixture keychain placeholder');
  fs.writeFileSync(path.join(bin, 'security'), `#!/bin/sh
if [ "$1" = "login-keychain" ]; then
  exit 0
fi
if [ "$1" = "find-certificate" ]; then
  cat "$KEYCHAIN_CERT_FIXTURE"
  exit 0
fi
exit 1
`, { mode: 0o755 });

  const result = spawnSync('/bin/sh', ['-c', '. ./scripts/prepare-ca.sh; printf "%s" "$NODE_EXTRA_CA_CERTS"'], {
    cwd: REPO_ROOT,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      NODE_EXTRA_CA_CERTS: existing,
      CODEX_SWITCH_SYSTEM_KEYCHAIN: systemKeychain,
      KEYCHAIN_CERT_FIXTURE: keychain,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const bundle = path.join(home, '.codex-switch', 'extra-ca.pem');
  assert.equal(result.stdout, bundle);
  assert.match(fs.readFileSync(bundle, 'utf8'), /END CERTIFICATE-----\n-----BEGIN CERTIFICATE/);

  const pkcs7 = path.join(root, 'bundle.p7b');
  const parseBundle = spawnSync('openssl', [
    'crl2pkcs7', '-nocrl', '-certfile', bundle, '-out', pkcs7,
  ], { encoding: 'utf8' });
  assert.equal(parseBundle.status, 0, parseBundle.stderr);
  const parsed = spawnSync('openssl', [
    'pkcs7', '-in', pkcs7, '-print_certs', '-noout',
  ], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(parsed.stdout, /CN=existing-extra-ca/);
  assert.match(parsed.stdout, /CN=system-keychain-ca/);
});

test('CA preparation preserves the inherited CA path when publishing the combined bundle fails', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-mv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const state = path.join(home, '.codex-switch');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(bin);
  const existing = path.join(root, 'existing.pem');
  const systemKeychain = path.join(root, 'system.keychain');
  const staleBundle = path.join(state, 'extra-ca.pem');
  fs.writeFileSync(existing, 'inherited-ca\n', { mode: 0o600 });
  fs.writeFileSync(systemKeychain, 'fixture keychain placeholder');
  fs.writeFileSync(staleBundle, 'stale-bundle\n', { mode: 0o600 });
  fs.writeFileSync(path.join(bin, 'security'), `#!/bin/sh
if [ "$1" = "login-keychain" ]; then exit 0; fi
if [ "$1" = "find-certificate" ]; then printf '%s' 'keychain-ca'; exit 0; fi
exit 1
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'mv'), '#!/bin/sh\necho "fixture mv failed" >&2\nexit 73\n', { mode: 0o755 });

  const result = spawnSync('/bin/sh', ['-c', '. ./scripts/prepare-ca.sh; printf "%s" "$NODE_EXTRA_CA_CERTS"'], {
    cwd: REPO_ROOT,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      NODE_EXTRA_CA_CERTS: existing,
      CODEX_SWITCH_SYSTEM_KEYCHAIN: systemKeychain,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, existing);
  assert.equal(fs.readFileSync(staleBundle, 'utf8'), 'stale-bundle\n');
  assert.match(result.stderr, /failed to publish extra CA bundle/);
});

test('server launcher treats hostile paths as positional data and starts the exact node target', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-launcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostile = path.join(root, 'space " $(touch PWNED_DOLLAR) `touch PWNED_TICK`');
  fs.mkdirSync(hostile);
  const envFile = path.join(hostile, 'local env');
  const prepareCA = path.join(hostile, 'prepare "ca" $() `tick`');
  const nodeBin = path.join(hostile, 'node "bin" $() `tick`');
  const serverJs = path.join(hostile, 'server "file" $() `tick`.js');
  const output = path.join(root, 'launch-output');
  fs.writeFileSync(envFile, "LAUNCH_TEST_VALUE='loaded from env'\nexport LAUNCH_TEST_VALUE\n");
  fs.writeFileSync(prepareCA, "LAUNCH_CA_VALUE='prepared ca'\nexport LAUNCH_CA_VALUE\n");
  fs.writeFileSync(serverJs, 'fixture');
  fs.writeFileSync(nodeBin, `#!/bin/sh
printf '%s\\n' "$LAUNCH_TEST_VALUE" "$LAUNCH_CA_VALUE" "$0" "$1" > "$LAUNCH_OUTPUT"
`, { mode: 0o755 });

  const result = spawnSync('/bin/sh', [
    path.join(REPO_ROOT, 'scripts/launch-server.sh'),
    envFile,
    prepareCA,
    nodeBin,
    serverJs,
  ], {
    cwd: root,
    env: { ...process.env, LAUNCH_OUTPUT: output },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(output, 'utf8').trimEnd().split('\n'), [
    'loaded from env',
    'prepared ca',
    nodeBin,
    serverJs,
  ]);
  assert.equal(fs.existsSync(path.join(root, 'PWNED_DOLLAR')), false);
  assert.equal(fs.existsSync(path.join(root, 'PWNED_TICK')), false);
});

test('packaged launchers source the shared CA preparation before starting child Node', () => {
  const swift = fs.readFileSync(path.join(REPO_ROOT, 'assets/launcher/CodexSwitchLauncher.swift'), 'utf8');
  const build = fs.readFileSync(path.join(REPO_ROOT, 'scripts/build-macos-app.sh'), 'utf8');
  const start = fs.readFileSync(path.join(REPO_ROOT, 'scripts/start.sh'), 'utf8');

  assert.match(swift, /scripts\/prepare-ca\.sh/);
  assert.match(swift, /scripts\/launch-server\.sh/);
  assert.doesNotMatch(swift, /sh\.arguments\s*=\s*\["-c"/);
  assert.match(build, /cp scripts\/prepare-ca\.sh/);
  assert.match(build, /cp scripts\/launch-server\.sh/);
  assert.match(build, /\. "\$APP\/scripts\/prepare-ca\.sh"/);
  assert.match(build, /"\$NODE" "\$APP\/src\/server\.js"/);
  assert.match(start, /\. .*prepare-ca\.sh/);
});
