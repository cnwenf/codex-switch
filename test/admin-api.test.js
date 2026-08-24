import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

async function unusedPort() {
  const server = net.createServer();
  const address = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHealth(origin, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`codex-switch exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${origin}/__admin/health`);
      if (response.ok) return;
    } catch { /* Process may not have entered listen() yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('codex-switch fixture did not become healthy');
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function providerBlock({
  id,
  name = id,
  baseUrl,
  tokenEnv,
  enabled = false,
  providerType,
  providerOptions,
}) {
  const lines = [
    '[[providers]]',
    `id = ${JSON.stringify(id)}`,
    `name = ${JSON.stringify(name)}`,
  ];
  if (providerType) lines.push(`provider_type = ${JSON.stringify(providerType)}`);
  if (providerOptions) {
    const fields = Object.entries(providerOptions)
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
      .join(', ');
    lines.push(`provider_options = { ${fields} }`);
  }
  lines.push(
    `base_url = ${JSON.stringify(baseUrl)}`,
    'auth = "bearer"',
    `token_env = ${JSON.stringify(tokenEnv)}`,
    'models = []',
    `enabled = ${enabled}`,
  );
  return lines.join('\n');
}

async function startCodexSwitchFixture(t, { providers = [], childEnv = {}, upstreamHandler } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-admin-'));
  const upstreamRequests = [];
  const upstream = http.createServer((req, res) => {
    upstreamRequests.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization || '',
    });
    if (upstreamHandler) return upstreamHandler(req, res);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fixture-model', object: 'model' }] }));
  });
  const upstreamAddress = await listen(upstream);
  const upstreamOrigin = `http://127.0.0.1:${upstreamAddress.port}`;
  const port = await unusedPort();
  const configPath = path.join(home, 'config.toml');
  const config = [
    '[proxy]',
    `listen = "127.0.0.1:${port}"`,
    'mount_prefix = "/v1"',
    `auth_json_path = ${JSON.stringify(path.join(home, '.codex', 'auth.json'))}`,
    '',
    ...providers.map((provider) => providerBlock({
      ...provider,
      baseUrl: provider.baseUrl || `${upstreamOrigin}/v1`,
    })),
    '',
  ].join('\n');
  fs.writeFileSync(configPath, config);

  let output = '';
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: REPO_ROOT,
    env: {
      HOME: home,
      PATH: '/usr/bin:/bin',
      TMPDIR: os.tmpdir(),
      CODEXSWITCH_CONFIG: configPath,
      ...childEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  t.after(async () => {
    await stopChild(child);
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${port}`;
  await waitForHealth(origin, child);
  return { origin, upstreamOrigin, upstreamRequests, output: () => output };
}

async function postJson(origin, pathname, body) {
  return fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('admin returns safe presets and discovers a Custom model', async (t) => {
  const app = await startCodexSwitchFixture(t);
  const presetResponse = await fetch(`${app.origin}/__admin/provider-presets`);
  assert.equal(presetResponse.status, 200);
  const presets = await presetResponse.json();
  assert.equal(presets.presets.at(-1).id, 'custom');
  assert.equal(JSON.stringify(presets).includes('buildBaseUrl'), false);

  const key = 'fixture-explicit-discovery-secret';
  const discoveryResponse = await postJson(app.origin, '/__admin/provider-discover', {
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
    api_key: key,
  });
  assert.equal(discoveryResponse.status, 200);
  const discovered = await discoveryResponse.json();
  assert.equal(discovered.validation.status, 'valid');
  assert.deepEqual(discovered.models.map((model) => model.id), ['fixture-model']);
  assert.equal(app.upstreamRequests.at(-1).authorization, `Bearer ${key}`);
  assert.equal(JSON.stringify(discovered).includes(key), false);
  assert.equal(app.output().includes(key), false);
});

test('editing reuses only the saved provider token_env and exposes a safe cache summary', async (t) => {
  const savedKey = 'fixture-saved-provider-secret';
  const arbitraryKey = 'fixture-arbitrary-environment-secret';
  const app = await startCodexSwitchFixture(t, {
    providers: [{ id: 'saved-custom', tokenEnv: 'SAVED_FIXTURE_KEY' }],
    childEnv: {
      SAVED_FIXTURE_KEY: savedKey,
      ARBITRARY_FIXTURE_KEY: arbitraryKey,
    },
  });

  const response = await postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'saved-custom',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
    token_env: 'ARBITRARY_FIXTURE_KEY',
    api_key_env: 'ARBITRARY_FIXTURE_KEY',
  });
  assert.equal(response.status, 200);
  const discovered = await response.json();
  assert.equal(discovered.validation.status, 'valid');
  assert.equal(app.upstreamRequests.at(-1).authorization, `Bearer ${savedKey}`);

  const beforeUnknown = app.upstreamRequests.length;
  const unknownResponse = await postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'unknown-provider',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
    token_env: 'SAVED_FIXTURE_KEY',
    api_key_env: 'SAVED_FIXTURE_KEY',
  });
  assert.equal(unknownResponse.status, 200);
  const unknown = await unknownResponse.json();
  assert.equal(unknown.validation.status, 'invalid');
  assert.equal(app.upstreamRequests.length, beforeUnknown);

  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  const saved = providers.providers.find((provider) => provider.id === 'saved-custom');
  assert.equal(saved.provider_type, 'custom');
  assert.deepEqual(saved.provider_options, { base_url: `${app.upstreamOrigin}/v1` });
  assert.deepEqual(saved.capability_cache, {
    status: 'fresh',
    model_count: 1,
    updated_at: saved.capability_cache.updated_at,
  });
  assert.match(saved.capability_cache.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  const serialized = JSON.stringify({ discovered, unknown, providers });
  assert.equal(serialized.includes(savedKey), false);
  assert.equal(serialized.includes(arbitraryKey), false);
  assert.equal(app.output().includes(savedKey), false);
  assert.equal(app.output().includes(arbitraryKey), false);
});

test('a saved key cannot be reused under a different provider type', async (t) => {
  const savedKey = 'fixture-cross-provider-secret';
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'saved-xai',
      providerType: 'xai',
      providerOptions: {},
      baseUrl: 'https://api.x.ai/v1',
      tokenEnv: 'SAVED_XAI_FIXTURE_KEY',
    }],
    childEnv: { SAVED_XAI_FIXTURE_KEY: savedKey },
  });
  const response = await postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'saved-xai',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.validation.status, 'invalid');
  assert.equal(app.upstreamRequests.length, 0);
  assert.equal(JSON.stringify(result).includes(savedKey), false);
  assert.equal(app.output().includes(savedKey), false);
});

test('discovery maps upstream status without exposing upstream errors or secrets', async (t) => {
  const key = 'fixture-denied-discovery-secret';
  const app = await startCodexSwitchFixture(t, {
    upstreamHandler(req, res) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: `provider rejected ${key}`,
        stack: `InternalProviderError: ${key}`,
      }));
    },
  });
  const response = await postJson(app.origin, '/__admin/provider-discover', {
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
    api_key: key,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.validation.status, 'invalid');
  assert.deepEqual(result.models, []);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(key), false);
  assert.equal(serialized.includes('InternalProviderError'), false);
  assert.equal(serialized.includes('provider rejected'), false);
  assert.equal(app.output().includes(key), false);
});

test('provider save re-resolves preset URLs and rejects unsupported routes', async (t) => {
  const app = await startCodexSwitchFixture(t);
  const addResponse = await postJson(app.origin, '/__admin/providers', {
    id: 'xai-fixture',
    name: 'xAI fixture',
    provider_type: 'xai',
    provider_options: {},
    base_url: `${app.upstreamOrigin}/attacker-controlled`,
    auth: 'bearer',
    token_env: 'XAI_FIXTURE_KEY',
    models: ['grok-fixture'],
  });
  assert.equal(addResponse.status, 200);
  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  const saved = providers.providers.find((provider) => provider.id === 'xai-fixture');
  assert.equal(saved.base_url, 'https://api.x.ai/v1');
  assert.equal(saved.provider_type, 'xai');
  assert.deepEqual(saved.provider_options, {});

  const unsupportedResponse = await postJson(app.origin, '/__admin/providers', {
    id: 'deepseek-fixture',
    provider_type: 'deepseek',
    auth: 'bearer',
    token_env: 'DEEPSEEK_FIXTURE_KEY',
    models: ['deepseek-chat'],
  });
  assert.equal(unsupportedResponse.status, 400);
  const unsupported = await unsupportedResponse.json();
  assert.match(unsupported.error, /不支持.*Responses/);
});

test('admin discovery rejects oversized bodies and remains healthy', async (t) => {
  const app = await startCodexSwitchFixture(t);
  const oversizedKey = `fixture-oversized-${'x'.repeat(70 * 1024)}`;
  const response = await postJson(app.origin, '/__admin/provider-discover', {
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
    api_key: oversizedKey,
  });
  assert.equal(response.status, 413);
  const result = await response.json();
  assert.deepEqual(result, { error: 'request body too large' });
  assert.equal(JSON.stringify(result).includes(oversizedKey), false);
  assert.equal(app.output().includes(oversizedKey), false);
  assert.equal((await fetch(`${app.origin}/__admin/health`)).status, 200);
});

test('aborting a stale discovery request cancels the upstream request', async (t) => {
  let markStarted;
  let markClosed;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const closed = new Promise((resolve) => { markClosed = resolve; });
  const app = await startCodexSwitchFixture(t, {
    upstreamHandler(req) {
      markStarted();
      req.socket.once('close', markClosed);
    },
  });
  const controller = new AbortController();
  const pending = fetch(`${app.origin}/__admin/provider-discover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_type: 'custom',
      base_url: `${app.upstreamOrigin}/v1`,
      api_key: 'fixture-stale-request-secret',
    }),
    signal: controller.signal,
  });
  await Promise.race([
    started,
    new Promise((_, reject) => setTimeout(() => reject(new Error('upstream request did not start')), 1_000)),
  ]);
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('upstream request was not cancelled')), 1_000)),
  ]);
  assert.equal((await fetch(`${app.origin}/__admin/health`)).status, 200);
  assert.equal(app.output().includes('fixture-stale-request-secret'), false);
});
