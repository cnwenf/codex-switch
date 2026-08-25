import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

function writeSecurityFixture(bin, { systemOutput, systemStatus = 0, loginOutput = '' }) {
  const security = path.join(bin, 'security');
  fs.writeFileSync(security, `#!/bin/sh
if [ "$1" = "login-keychain" ]; then
  printf '%s' "$LOGIN_KEYCHAIN_OUTPUT"
  exit 0
fi
if [ "$1" = "find-certificate" ]; then
  if [ "$SYSTEM_CERT_STATUS" -ne 0 ]; then exit "$SYSTEM_CERT_STATUS"; fi
  [ -z "$SYSTEM_CERT_FIXTURE" ] || /bin/cat "$SYSTEM_CERT_FIXTURE"
  exit 0
fi
exit 1
`, { mode: 0o755 });
  return {
    SYSTEM_CERT_FIXTURE: systemOutput ?? '',
    SYSTEM_CERT_STATUS: String(systemStatus),
    LOGIN_KEYCHAIN_OUTPUT: loginOutput,
  };
}

function runPrepareCA({ home, bin, inherited, systemKeychain, extraEnv = {}, command }) {
  return spawnSync('/bin/sh', ['-c', command ?? '. ./scripts/prepare-ca.sh; printf "%s" "$NODE_EXTRA_CA_CERTS"'], {
    cwd: REPO_ROOT,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      NODE_EXTRA_CA_CERTS: inherited,
      CODEX_SWITCH_SYSTEM_KEYCHAIN: systemKeychain,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

function assertCertificateBundle(bundle, expectedCommonNames) {
  const pkcs7 = `${bundle}.p7b`;
  const parseBundle = spawnSync('openssl', [
    'crl2pkcs7', '-nocrl', '-certfile', bundle, '-out', pkcs7,
  ], { encoding: 'utf8' });
  assert.equal(parseBundle.status, 0, parseBundle.stderr);
  const parsed = spawnSync('openssl', [
    'pkcs7', '-in', pkcs7, '-print_certs', '-noout',
  ], { encoding: 'utf8' });
  fs.rmSync(pkcs7, { force: true });
  assert.equal(parsed.status, 0, parsed.stderr);
  for (const commonName of expectedCommonNames) assert.match(parsed.stdout, new RegExp(`CN=${commonName}`));
}

function modeBits(target) {
  return fs.statSync(target).mode & 0o777;
}

test('CA preparation preserves an unset inherited NODE_EXTRA_CA_CERTS state when no bundle can be built', () => {
  const result = spawnSync('/bin/sh', ['-c', '. ./scripts/prepare-ca.sh; printf "%s" "${NODE_EXTRA_CA_CERTS+x}"'], {
    cwd: REPO_ROOT,
    env: {
      HOME: os.tmpdir(),
      PATH: '/usr/bin:/bin',
      CODEX_SWITCH_SYSTEM_KEYCHAIN: path.join(os.tmpdir(), 'missing-system.keychain'),
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('CA preparation preserves an existing bundle and exports only the combined file path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const existing = createCertificate(root, 'existing-fixture-ca');
  const keychain = createCertificate(root, 'keychain-fixture-ca');
  fs.writeFileSync(path.join(root, 'system.keychain'), 'fixture keychain placeholder');
  const security = path.join(bin, 'security');
  fs.writeFileSync(security, `#!/bin/sh
if [ "$1" = "login-keychain" ]; then
  echo '"${root}/login.keychain-db"'
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
      CODEX_SWITCH_SYSTEM_KEYCHAIN: path.join(root, 'system.keychain'),
      KEYCHAIN_CERT_FIXTURE: keychain,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const bundle = path.join(home, '.codex-switch', 'extra-ca.pem');
  assert.equal(result.stdout, bundle);
  assertCertificateBundle(bundle, ['existing-fixture-ca', 'keychain-fixture-ca']);
  assert.equal(result.stderr.includes('existing-fixture-ca'), false);
  assert.equal(result.stderr.includes('keychain-fixture-ca'), false);
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

  assertCertificateBundle(bundle, ['existing-extra-ca', 'system-keychain-ca']);
});

test('CA preparation accepts and normalizes a valid CRLF PEM bundle', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-crlf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const inherited = createCertificate(root, 'crlf-inherited-ca');
  const systemCert = createCertificate(root, 'crlf-system-ca');
  fs.writeFileSync(inherited, fs.readFileSync(inherited, 'utf8').replace(/\n/g, '\r\n'));
  const systemKeychain = path.join(root, 'system.keychain');
  fs.writeFileSync(systemKeychain, 'fixture');
  const fixtureEnv = writeSecurityFixture(bin, { systemOutput: systemCert });

  const result = runPrepareCA({ home, bin, inherited, systemKeychain, extraEnv: fixtureEnv });

  const bundle = path.join(home, '.codex-switch', 'extra-ca.pem');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, bundle);
  assert.equal(fs.readFileSync(bundle).includes(13), false);
  assertCertificateBundle(bundle, ['crlf-inherited-ca', 'crlf-system-ca']);
});

test('CA preparation completes a real certificate build from fully hostile paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-ca-' newline\nbackslash \\ $(touch PWNED_SUB) `touch PWNED_TICK`-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home ' \n tab\t \\ $() `tick`");
  const bin = path.join(root, "bin ' \n tab\t \\ $() `tick`");
  const state = path.join(home, ".state ' \n tab\t \\ $() `tick`");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const inherited = createCertificate(root, "hostile-inherited-ca");
  const systemCert = createCertificate(root, "hostile-system-ca");
  const systemKeychain = path.join(root, "system ' \n \\ $() `tick`.keychain");
  fs.writeFileSync(systemKeychain, 'fixture');
  const fixtureEnv = writeSecurityFixture(bin, { systemOutput: systemCert });

  const result = runPrepareCA({
    home,
    bin,
    inherited,
    systemKeychain,
    extraEnv: { ...fixtureEnv, CODEX_SWITCH_STATE_DIR: state },
  });

  const bundle = path.join(state, 'extra-ca.pem');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, bundle);
  assertCertificateBundle(bundle, ['hostile-inherited-ca', 'hostile-system-ca']);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'PWNED_SUB')), false);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'PWNED_TICK')), false);
  assert.deepEqual(fs.readdirSync(state), ['extra-ca.pem']);
  assert.equal(modeBits(state), 0o700);
  assert.equal(modeBits(bundle), 0o600);
});

test('CA preparation refuses a symlink state directory without modifying its victim', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-state-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const victimDir = path.join(root, 'victim');
  const state = path.join(home, '.codex-switch');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.mkdirSync(victimDir);
  fs.symlinkSync(victimDir, state);
  const inherited = createCertificate(root, 'state-symlink-inherited-ca');
  const systemCert = createCertificate(root, 'state-symlink-system-ca');
  const systemKeychain = path.join(root, 'system.keychain');
  fs.writeFileSync(systemKeychain, 'fixture');
  const fixtureEnv = writeSecurityFixture(bin, { systemOutput: systemCert });

  const result = runPrepareCA({ home, bin, inherited, systemKeychain, extraEnv: fixtureEnv });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, inherited);
  assert.deepEqual(fs.readdirSync(victimDir), []);
  assert.match(result.stderr, /unsafe CA state directory/);
  assert.equal(result.stderr.includes(state), false);
});

test('CA preparation repairs private state-directory permissions before creating scratch files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-state-mode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const state = path.join(home, '.codex-switch');
  fs.mkdirSync(state, { recursive: true, mode: 0o777 });
  fs.chmodSync(state, 0o777);
  fs.mkdirSync(bin);
  const inherited = createCertificate(root, 'state-mode-inherited-ca');
  const systemCert = createCertificate(root, 'state-mode-system-ca');
  const systemKeychain = path.join(root, 'system.keychain');
  fs.writeFileSync(systemKeychain, 'fixture');
  const fixtureEnv = writeSecurityFixture(bin, { systemOutput: systemCert });

  const result = runPrepareCA({ home, bin, inherited, systemKeychain, extraEnv: fixtureEnv });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, path.join(state, 'extra-ca.pem'));
  assert.equal(modeBits(state), 0o700);
});

test('CA preparation rejects a final bundle symlink and never modifies its victim', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-final-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const state = path.join(home, '.codex-switch');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(bin);
  const inherited = createCertificate(root, 'final-symlink-inherited-ca');
  const systemCert = createCertificate(root, 'final-symlink-system-ca');
  const victim = path.join(root, 'victim.pem');
  const bundle = path.join(state, 'extra-ca.pem');
  fs.writeFileSync(victim, 'DO NOT MODIFY\n');
  const before = fs.readFileSync(victim);
  fs.symlinkSync(victim, bundle);
  const systemKeychain = path.join(root, 'system.keychain');
  fs.writeFileSync(systemKeychain, 'fixture');
  const fixtureEnv = writeSecurityFixture(bin, { systemOutput: systemCert });

  const result = runPrepareCA({ home, bin, inherited, systemKeychain, extraEnv: fixtureEnv });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, inherited);
  assert.deepEqual(fs.readFileSync(victim), before);
  assert.equal(fs.lstatSync(bundle).isSymbolicLink(), true);
  assert.match(result.stderr, /unsafe existing extra CA bundle/);
});

test('CA preparation rejects a symlink returned by mktemp without touching its victim', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-mktemp-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const state = path.join(home, '.codex-switch');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(bin);
  const inherited = createCertificate(root, 'mktemp-inherited-ca');
  const systemCert = createCertificate(root, 'mktemp-system-ca');
  const victim = path.join(root, 'victim');
  const trap = path.join(state, '.attacker-temp');
  fs.writeFileSync(victim, 'DO NOT MODIFY\n');
  const before = fs.readFileSync(victim);
  fs.symlinkSync(victim, trap);
  fs.writeFileSync(path.join(bin, 'mktemp'), `#!/bin/sh\nprintf '%s\\n' "$MKTEMP_ATTACK_PATH"\n`, { mode: 0o755 });
  const systemKeychain = path.join(root, 'system.keychain');
  fs.writeFileSync(systemKeychain, 'fixture');
  const fixtureEnv = writeSecurityFixture(bin, { systemOutput: systemCert });

  const result = runPrepareCA({
    home,
    bin,
    inherited,
    systemKeychain,
    extraEnv: { ...fixtureEnv, MKTEMP_ATTACK_PATH: trap },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, inherited);
  assert.deepEqual(fs.readFileSync(victim), before);
  assert.equal(fs.lstatSync(trap).isSymbolicLink(), true);
  assert.match(result.stderr, /failed to create secure CA scratch files/);
});

test('CA publication safely replaces a target symlink introduced at the mv boundary', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-publish-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const state = path.join(home, '.codex-switch');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(bin);
  const inherited = createCertificate(root, 'publish-race-inherited-ca');
  const systemCert = createCertificate(root, 'publish-race-system-ca');
  const oldValid = createCertificate(root, 'publish-race-old-ca');
  const victim = path.join(root, 'victim');
  const bundle = path.join(state, 'extra-ca.pem');
  fs.writeFileSync(victim, 'DO NOT MODIFY\n');
  const before = fs.readFileSync(victim);
  fs.copyFileSync(oldValid, bundle);
  fs.writeFileSync(path.join(bin, 'mv'), `#!/bin/sh
/bin/rm -f "$RACE_BUNDLE"
/bin/ln -s "$RACE_VICTIM" "$RACE_BUNDLE"
exec /bin/mv "$@"
`, { mode: 0o755 });
  const systemKeychain = path.join(root, 'system.keychain');
  fs.writeFileSync(systemKeychain, 'fixture');
  const fixtureEnv = writeSecurityFixture(bin, { systemOutput: systemCert });

  const result = runPrepareCA({
    home,
    bin,
    inherited,
    systemKeychain,
    extraEnv: { ...fixtureEnv, RACE_BUNDLE: bundle, RACE_VICTIM: victim },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, bundle);
  assert.deepEqual(fs.readFileSync(victim), before);
  assert.equal(fs.lstatSync(bundle).isSymbolicLink(), false);
  assertCertificateBundle(bundle, ['publish-race-inherited-ca', 'publish-race-system-ca']);
});

test('CA preparation exposes only fixed errors when mktemp fails noisily', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-error-redaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const inherited = createCertificate(root, 'redaction-inherited-ca');
  const systemCert = createCertificate(root, 'redaction-system-ca');
  const systemKeychain = path.join(root, 'system.keychain');
  fs.writeFileSync(systemKeychain, 'fixture');
  const secretError = "SECRET internal path ' \n \\ $() `tick` certificate body";
  fs.writeFileSync(path.join(bin, 'mktemp'), '#!/bin/sh\nprintf \'%s\\n\' "$SECRET_ERROR" >&2\nexit 76\n', { mode: 0o755 });
  const fixtureEnv = writeSecurityFixture(bin, { systemOutput: systemCert });

  const result = runPrepareCA({
    home,
    bin,
    inherited,
    systemKeychain,
    extraEnv: { ...fixtureEnv, SECRET_ERROR: secretError },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, inherited);
  assert.equal(result.stderr.includes(secretError), false);
  assert.equal(result.stderr.includes(root), false);
  assert.equal(result.stderr.trim(), '[codex-switch] failed to create secure CA scratch files; preserving inherited NODE_EXTRA_CA_CERTS');
});

test('CA preparation traps termination during partial scratch creation and removes only its created file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-partial-trap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const state = path.join(home, '.codex-switch');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(bin);
  const inherited = createCertificate(root, 'partial-trap-inherited-ca');
  const systemCert = createCertificate(root, 'partial-trap-system-ca');
  const systemKeychain = path.join(root, 'system.keychain');
  const countFile = path.join(root, 'mktemp-count');
  const createdFile = path.join(root, 'created-path');
  fs.writeFileSync(systemKeychain, 'fixture');
  fs.writeFileSync(countFile, '0\n');
  fs.writeFileSync(path.join(bin, 'mktemp'), `#!/bin/sh
count=$(/bin/cat "$MKTEMP_COUNT_FILE") || exit 77
count=$((count + 1))
printf '%s\n' "$count" > "$MKTEMP_COUNT_FILE" || exit 77
if [ "$count" -gt 1 ]; then
  kill -TERM "$MAIN_SHELL_PID"
  exit 78
fi
created=$(/usr/bin/mktemp "$@") || exit 77
printf '%s' "$created" > "$MKTEMP_CREATED_FILE" || exit 77
printf '%s\n' "$created"
`, { mode: 0o755 });
  const fixtureEnv = writeSecurityFixture(bin, { systemOutput: systemCert });
  const command = 'MAIN_SHELL_PID=$$; export MAIN_SHELL_PID; . ./scripts/prepare-ca.sh';

  const result = runPrepareCA({
    home,
    bin,
    inherited,
    systemKeychain,
    command,
    extraEnv: {
      ...fixtureEnv,
      MKTEMP_COUNT_FILE: countFile,
      MKTEMP_CREATED_FILE: createdFile,
    },
  });

  assert.notEqual(result.status, 0);
  const created = fs.readFileSync(createdFile, 'utf8');
  assert.equal(fs.existsSync(created), false);
  assert.deepEqual(fs.readdirSync(state), []);
});

test('CA preparation rejects malformed inherited PEM without replacing the last valid bundle', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-inherited-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const state = path.join(home, '.codex-switch');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(bin);
  const inherited = path.join(root, 'inherited.pem');
  const oldBundle = path.join(state, 'extra-ca.pem');
  const oldValid = createCertificate(root, 'old-valid-ca');
  const systemCert = createCertificate(root, 'system-valid-ca');
  const systemKeychain = path.join(root, 'system.keychain');
  fs.writeFileSync(inherited, '-----BEGIN CERTIFICATE-----\nnot-base64\n-----END CERTIFICATE-----\n');
  fs.copyFileSync(oldValid, oldBundle);
  fs.writeFileSync(systemKeychain, 'fixture');
  const fixtureEnv = writeSecurityFixture(bin, { systemOutput: systemCert });
  const before = fs.readFileSync(oldBundle);

  const result = runPrepareCA({ home, bin, inherited, systemKeychain, extraEnv: fixtureEnv });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, inherited);
  assert.deepEqual(fs.readFileSync(oldBundle), before);
  assert.doesNotMatch(result.stderr, /not-base64|inherited\.pem/);
});

for (const fixture of [
  { name: 'a non-zero security response', output: undefined, status: 71 },
  { name: 'an empty security response', output: undefined, status: 0 },
  { name: 'a malformed security response', content: 'certificate-shaped-garbage\n', status: 0 },
]) {
  test(`CA preparation rejects ${fixture.name} without replacing the last valid bundle`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-security-invalid-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    const state = path.join(home, '.codex-switch');
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(bin);
    const inherited = createCertificate(root, 'inherited-valid-ca');
    const oldValid = createCertificate(root, 'old-valid-ca');
    const oldBundle = path.join(state, 'extra-ca.pem');
    const systemKeychain = path.join(root, 'system.keychain');
    fs.copyFileSync(oldValid, oldBundle);
    fs.writeFileSync(systemKeychain, 'fixture');
    let systemOutput = fixture.output;
    if (fixture.content !== undefined) {
      systemOutput = path.join(root, 'security-output.pem');
      fs.writeFileSync(systemOutput, fixture.content);
    }
    const fixtureEnv = writeSecurityFixture(bin, { systemOutput, systemStatus: fixture.status });
    const before = fs.readFileSync(oldBundle);

    const result = runPrepareCA({ home, bin, inherited, systemKeychain, extraEnv: fixtureEnv });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, inherited);
    assert.deepEqual(fs.readFileSync(oldBundle), before);
    assert.equal(result.stderr.includes('certificate-shaped-garbage'), false);
  });
}

test('CA preparation validates and rebuilds a stale self-pointing bundle before exporting it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-self-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const state = path.join(home, '.codex-switch');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(bin);
  const bundle = path.join(state, 'extra-ca.pem');
  const systemCert = createCertificate(root, 'rebuilt-system-ca');
  const systemKeychain = path.join(root, 'system.keychain');
  fs.writeFileSync(bundle, 'stale invalid bundle\n');
  fs.writeFileSync(systemKeychain, 'fixture');
  const fixtureEnv = writeSecurityFixture(bin, { systemOutput: systemCert });

  const result = runPrepareCA({ home, bin, inherited: bundle, systemKeychain, extraEnv: fixtureEnv });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, bundle);
  assertCertificateBundle(bundle, ['rebuilt-system-ca']);
});

for (const malformed of [
  '',
  '-----BEGIN CERTIFICATE-----\nunterminated\n',
  '-----END CERTIFICATE-----\n',
  'garbage before a certificate\n',
]) {
  test('CA preparation rejects empty, unbalanced, or non-PEM inherited content', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-structure-invalid-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    const state = path.join(home, '.codex-switch');
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(bin);
    const inherited = path.join(root, "untrusted ' path\n$(touch PWNED_CA) \\.pem");
    const oldValid = createCertificate(root, 'structure-old-valid-ca');
    const systemCert = createCertificate(root, 'structure-system-valid-ca');
    const oldBundle = path.join(state, 'extra-ca.pem');
    const systemKeychain = path.join(root, 'system.keychain');
    fs.writeFileSync(inherited, malformed);
    fs.copyFileSync(oldValid, oldBundle);
    fs.writeFileSync(systemKeychain, 'fixture');
    const fixtureEnv = writeSecurityFixture(bin, { systemOutput: systemCert });
    const before = fs.readFileSync(oldBundle);

    const result = runPrepareCA({ home, bin, inherited, systemKeychain, extraEnv: fixtureEnv });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, inherited);
    assert.deepEqual(fs.readFileSync(oldBundle), before);
    assert.equal(fs.existsSync(path.join(REPO_ROOT, 'PWNED_CA')), false);
    assert.equal(result.stderr.includes(inherited), false);
    assert.equal(result.stderr.includes(malformed.trim()), malformed.trim() === '');
    assert.deepEqual(fs.readdirSync(state), ['extra-ca.pem']);
  });
}

test('CA preparation preserves the old bundle when appending a validated component fails', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-append-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const state = path.join(home, '.codex-switch');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(bin);
  const inherited = createCertificate(root, 'append-inherited-ca');
  const oldValid = createCertificate(root, 'append-old-valid-ca');
  const systemCert = createCertificate(root, 'append-system-valid-ca');
  const oldBundle = path.join(state, 'extra-ca.pem');
  const systemKeychain = path.join(root, 'system.keychain');
  fs.copyFileSync(oldValid, oldBundle);
  fs.writeFileSync(systemKeychain, 'fixture');
  fs.writeFileSync(path.join(bin, 'cat'), '#!/bin/sh\nexit 72\n', { mode: 0o755 });
  const fixtureEnv = writeSecurityFixture(bin, { systemOutput: systemCert });
  const before = fs.readFileSync(oldBundle);

  const result = runPrepareCA({ home, bin, inherited, systemKeychain, extraEnv: fixtureEnv });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, inherited);
  assert.deepEqual(fs.readFileSync(oldBundle), before);
});

test('CA preparation preserves the old bundle when writing a PEM separator fails', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-printf-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const state = path.join(home, '.codex-switch');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(bin);
  const inherited = createCertificate(root, 'printf-inherited-ca');
  const oldValid = createCertificate(root, 'printf-old-valid-ca');
  const systemCert = createCertificate(root, 'printf-system-valid-ca');
  const oldBundle = path.join(state, 'extra-ca.pem');
  const systemKeychain = path.join(root, 'system.keychain');
  fs.copyFileSync(oldValid, oldBundle);
  fs.writeFileSync(systemKeychain, 'fixture');
  const fixtureEnv = writeSecurityFixture(bin, { systemOutput: systemCert });
  const before = fs.readFileSync(oldBundle);
  const command = `printf() {
  if [ "$1" = '\\n' ]; then return 74; fi
  command printf "$@"
}
. ./scripts/prepare-ca.sh
/usr/bin/printf '%s' "$NODE_EXTRA_CA_CERTS"`;

  const result = runPrepareCA({ home, bin, inherited, systemKeychain, extraEnv: fixtureEnv, command });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, inherited);
  assert.deepEqual(fs.readFileSync(oldBundle), before);
});

test('CA preparation preserves the old bundle when the temporary file cannot be created', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-temp-fail-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const state = path.join(home, '.codex-switch');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(bin);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inherited = createCertificate(root, 'temp-inherited-ca');
  const oldValid = createCertificate(root, 'temp-old-valid-ca');
  const systemCert = createCertificate(root, 'temp-system-valid-ca');
  const oldBundle = path.join(state, 'extra-ca.pem');
  const systemKeychain = path.join(root, 'system.keychain');
  fs.copyFileSync(oldValid, oldBundle);
  fs.writeFileSync(systemKeychain, 'fixture');
  fs.writeFileSync(path.join(bin, 'mktemp'), '#!/bin/sh\nexit 75\n', { mode: 0o755 });
  const fixtureEnv = writeSecurityFixture(bin, { systemOutput: systemCert });
  const before = fs.readFileSync(oldBundle);

  const result = runPrepareCA({ home, bin, inherited, systemKeychain, extraEnv: fixtureEnv });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, inherited);
  assert.deepEqual(fs.readFileSync(oldBundle), before);
});

test('CA preparation preserves the inherited CA path when publishing the combined bundle fails', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-ca-mv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const state = path.join(home, '.codex-switch');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(bin);
  const existing = createCertificate(root, 'mv-inherited-ca');
  const keychain = createCertificate(root, 'mv-keychain-ca');
  const systemKeychain = path.join(root, 'system.keychain');
  const staleBundle = path.join(state, 'extra-ca.pem');
  fs.writeFileSync(systemKeychain, 'fixture keychain placeholder');
  const oldValid = createCertificate(root, 'mv-old-valid-ca');
  fs.copyFileSync(oldValid, staleBundle);
  const before = fs.readFileSync(staleBundle);
  fs.writeFileSync(path.join(bin, 'security'), `#!/bin/sh
if [ "$1" = "login-keychain" ]; then exit 0; fi
if [ "$1" = "find-certificate" ]; then /bin/cat "$KEYCHAIN_CERT_FIXTURE"; exit 0; fi
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
      KEYCHAIN_CERT_FIXTURE: keychain,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, existing);
  assert.deepEqual(fs.readFileSync(staleBundle), before);
  assert.match(result.stderr, /failed to publish extra CA bundle/);
});

test('server launcher treats hostile paths as positional data and starts the exact node target', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-launcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostile = path.join(root, "single ' double \" newline\nbackslash \\ $(touch PWNED_DOLLAR) `touch PWNED_TICK`");
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
printf '%s\\0' "$LAUNCH_TEST_VALUE" "$LAUNCH_CA_VALUE" "$0" "$1" > "$LAUNCH_OUTPUT"
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
  const expected = Buffer.concat([
    Buffer.from('loaded from env\0prepared ca\0'),
    Buffer.from(nodeBin),
    Buffer.from('\0'),
    Buffer.from(serverJs),
    Buffer.from('\0'),
  ]);
  assert.deepEqual(fs.readFileSync(output), expected);
  assert.equal(fs.existsSync(path.join(root, 'PWNED_DOLLAR')), false);
  assert.equal(fs.existsSync(path.join(root, 'PWNED_TICK')), false);
});

test('build-generated shell fallback round-trips hostile app paths without evaluating them', (t) => {
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
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  for (const [name, target] of Object.entries({
    awk: '/usr/bin/awk', cat: '/bin/cat', chmod: '/bin/chmod', cp: '/bin/cp', dirname: '/usr/bin/dirname',
    du: '/usr/bin/du', grep: '/usr/bin/grep', head: '/usr/bin/head', ln: '/bin/ln',
    mkdir: '/bin/mkdir', rm: '/bin/rm', sed: '/usr/bin/sed', shasum: '/usr/bin/shasum',
    sleep: '/bin/sleep', tar: '/usr/bin/tar',
  })) fs.symlinkSync(target, path.join(bin, name));
  const fakeNode = `#!/bin/sh
if [ "$1" = "-p" ]; then printf '%s\\n' '0.5.0'; exit 0; fi
printf '%s\\0' "$0" "$1" > "$LAUNCH_OUTPUT"
`;
  fs.writeFileSync(path.join(bin, 'node'), fakeNode, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codesign'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'hdiutil'), `#!/bin/sh
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
`, { mode: 0o755 });

  const tarRoot = path.join(root, 'tar-root');
  const runtimeDir = path.join(tarRoot, 'node-v22.23.2-darwin-arm64', 'bin');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'node'), fakeNode, { mode: 0o755 });
  const downloads = path.join(project, 'dist', 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const tarball = path.join(downloads, 'node-v22.23.2-darwin-arm64.tar.gz');
  const tarResult = spawnSync('/usr/bin/tar', ['-czf', tarball, '-C', tarRoot, 'node-v22.23.2-darwin-arm64'], { encoding: 'utf8' });
  assert.equal(tarResult.status, 0, tarResult.stderr);
  const digest = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  fs.writeFileSync(path.join(downloads, 'SHASUMS256-v22.23.2.txt'), `${digest}  node-v22.23.2-darwin-arm64.tar.gz\n`);

  const build = spawnSync('/bin/sh', ['scripts/build-macos-app.sh'], {
    cwd: project,
    env: {
      HOME: home,
      PATH: bin,
      CAPTURE_APP: captureApp,
      LAUNCH_OUTPUT: launchOutput,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

  const launcher = path.join(captureApp, 'Contents', 'MacOS', 'codex-switch-launcher');
  const packagedNode = path.join(captureApp, 'Contents', 'MacOS', 'node');
  const serverJs = `${path.dirname(packagedNode)}/../Resources/app/src/server.js`;
  const launch = spawnSync('/bin/sh', [launcher], {
    cwd: project,
    env: {
      HOME: home,
      PATH: bin,
      LAUNCH_OUTPUT: launchOutput,
      CODEX_SWITCH_SYSTEM_KEYCHAIN: path.join(root, 'missing-system.keychain'),
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(launch.status, 0, `${launch.stdout}\n${launch.stderr}`);
  const expected = Buffer.concat([
    Buffer.from(packagedNode),
    Buffer.from('\0'),
    Buffer.from(serverJs),
    Buffer.from('\0'),
  ]);
  assert.deepEqual(fs.readFileSync(launchOutput), expected);
  assert.equal(fs.existsSync(path.join(project, 'PWNED_BUILD')), false);
  assert.equal(fs.existsSync(path.join(project, 'PWNED_TICK')), false);
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
