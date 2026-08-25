import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);

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

test('packaged launchers source the shared CA preparation before starting child Node', () => {
  const swift = fs.readFileSync(path.join(REPO_ROOT, 'assets/launcher/CodexSwitchLauncher.swift'), 'utf8');
  const build = fs.readFileSync(path.join(REPO_ROOT, 'scripts/build-macos-app.sh'), 'utf8');
  const start = fs.readFileSync(path.join(REPO_ROOT, 'scripts/start.sh'), 'utf8');

  assert.match(swift, /scripts\/prepare-ca\.sh/);
  assert.match(build, /cp scripts\/prepare-ca\.sh/);
  assert.match(build, /\. "\$APP\/scripts\/prepare-ca\.sh"/);
  assert.match(start, /\. .*prepare-ca\.sh/);
});
