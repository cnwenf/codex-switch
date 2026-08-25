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
  models = [],
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
    `models = [${models.map((model) => JSON.stringify(model)).join(', ')}]`,
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
      baseUrl: provider.baseUrl || `${upstreamOrigin}${provider.basePath || '/v1'}`,
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
  return { origin, upstreamOrigin, upstreamRequests, home, configPath, output: () => output };
}

async function postJson(origin, pathname, body) {
  return fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postRawConfig(origin, text) {
  return fetch(`${origin}/__admin/config`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: text,
  });
}

async function waitForProviderCache(origin, providerId, expectedStatus = 'fresh', timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/__admin/providers`);
    const payload = await response.json();
    const provider = payload.providers.find((entry) => entry.id === providerId);
    if (provider?.capability_cache?.status === expectedStatus) return provider;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`provider '${providerId}' cache did not become ${expectedStatus}`);
}

function finishDiscoveryResponse(response, contextWindow) {
  if (!response || response.writableEnded) return;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: contextWindow }] }));
}

async function waitUntil(predicate, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

test('admin returns safe presets and discovers a Custom model', async (t) => {
  const app = await startCodexSwitchFixture(t);
  const presetResponse = await fetch(`${app.origin}/__admin/provider-presets`);
  assert.equal(presetResponse.status, 200);
  const presets = await presetResponse.json();
  assert.equal(presets.presets.at(-1).id, 'custom');
  assert.equal(JSON.stringify(presets).includes('buildBaseUrl'), false);
  assert.equal(presets.presets.find((preset) => preset.id === 'openai').requiresManualModel, false);
  assert.equal(presets.presets.find((preset) => preset.id === 'volcengine-ark').requiresManualModel, true);
  assert.equal(presets.presets.find((preset) => preset.id === 'azure-openai').requiresManualModel, true);

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
    providers: [{ id: 'saved-custom', tokenEnv: 'SAVED_FIXTURE_KEY', enabled: true }],
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

test('a saved key cannot be reused after a Custom connection URL changes', async (t) => {
  const savedKey = 'fixture-cross-origin-secret';
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'saved-custom',
      providerType: 'custom',
      providerOptions: { base_url: '' },
      baseUrl: undefined,
      tokenEnv: 'SAVED_CUSTOM_ORIGIN_KEY',
      enabled: true,
    }],
    childEnv: { SAVED_CUSTOM_ORIGIN_KEY: savedKey },
  });
  const before = app.upstreamRequests.length;
  const response = await postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'saved-custom',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/different-v1`,
  });

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.validation.status, 'invalid');
  assert.equal(app.upstreamRequests.length, before);
  assert.equal(JSON.stringify(result).includes(savedKey), false);
  assert.equal(app.output().includes(savedKey), false);
});

test('changing a Custom connection requires a new key and leaves the saved route unchanged on rejection', async (t) => {
  const savedKey = 'fixture-update-origin-secret';
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'saved-custom',
      providerType: 'custom',
      providerOptions: { base_url: '' },
      tokenEnv: 'SAVED_CUSTOM_UPDATE_KEY',
      enabled: true,
      models: ['fixture-model'],
    }],
    childEnv: { SAVED_CUSTOM_UPDATE_KEY: savedKey },
  });
  const changedUrl = `${app.upstreamOrigin}/different-v1`;
  const response = await postJson(app.origin, '/__admin/providers/update', {
    origId: 'saved-custom',
    provider: {
      id: 'saved-custom',
      name: 'Saved Custom',
      provider_type: 'custom',
      provider_options: { base_url: changedUrl },
      base_url: changedUrl,
      auth: 'bearer',
      token_env: 'SAVED_CUSTOM_UPDATE_KEY',
      models: ['fixture-model'],
      enabled: true,
    },
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /新.*API Key|API Key.*连接/);
  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  assert.equal(providers.providers.find((provider) => provider.id === 'saved-custom').base_url, `${app.upstreamOrigin}/v1`);
  assert.equal(app.upstreamRequests.some((request) => request.authorization === `Bearer ${savedKey}` && request.path.startsWith('/different-v1')), false);
  assert.equal(app.output().includes(savedKey), false);
});

test('adding a validated provider with its key refreshes capabilities before the API returns', async (t) => {
  const key = 'fixture-atomic-add-secret';
  const app = await startCodexSwitchFixture(t, {
    upstreamHandler(req, res) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{
        id: 'fixture-model',
        context_window: 424242,
        input_modalities: ['text', 'image'],
      }] }));
    },
  });
  const response = await postJson(app.origin, '/__admin/providers', {
    id: 'new-custom',
    name: 'New Custom',
    provider_type: 'custom',
    provider_options: { base_url: `${app.upstreamOrigin}/v1` },
    base_url: `${app.upstreamOrigin}/v1`,
    auth: 'bearer',
    token_env: 'NEW_CUSTOM_KEY',
    api_key: key,
    models: ['fixture-model'],
    enabled: true,
  });

  assert.equal(response.status, 200);
  const savedResult = await response.json();
  assert.equal(savedResult.capability_refresh.status, 'ok');
  assert.equal(JSON.stringify(savedResult).includes(key), false);
  assert.equal(app.upstreamRequests.at(-1).authorization, `Bearer ${key}`);
  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  assert.equal(providers.providers.find((provider) => provider.id === 'new-custom').capability_cache.status, 'fresh');
  const generated = await fetch(`${app.origin}/__admin/codex-config`).then((res) => res.json());
  const model = JSON.parse(generated.catalog_json).models.find((entry) => entry.slug === 'fixture-model');
  assert.equal(model.context_window, 424242);
  assert.deepEqual(model.input_modalities, ['text', 'image']);
  assert.equal(app.output().includes(key), false);
});

test('adding a bearer provider cannot rebind an already configured environment key', async (t) => {
  const existingKey = 'fixture-existing-environment-secret';
  const app = await startCodexSwitchFixture(t, {
    childEnv: { REBOUND_CUSTOM_KEY: existingKey },
  });

  const response = await postJson(app.origin, '/__admin/providers', {
    id: 'rebound-custom',
    provider_type: 'custom',
    provider_options: { base_url: `${app.upstreamOrigin}/v1` },
    base_url: `${app.upstreamOrigin}/v1`,
    auth: 'bearer',
    token_env: 'REBOUND_CUSTOM_KEY',
    models: ['fixture-model'],
    enabled: true,
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /API Key/);
  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  assert.equal(providers.providers.some((provider) => provider.id === 'rebound-custom'), false);
  assert.equal(app.upstreamRequests.length, 0);
  assert.equal(app.output().includes(existingKey), false);
});

test('editing the same connection cannot rebind its credential reference without a new key', async (t) => {
  const savedKey = 'fixture-same-connection-saved-secret';
  const arbitraryKey = 'fixture-same-connection-arbitrary-secret';
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'same-connection',
      providerType: 'custom',
      providerOptions: { base_url: '' },
      tokenEnv: 'SAME_CONNECTION_SAVED_KEY',
      enabled: true,
      models: ['fixture-model'],
    }],
    childEnv: {
      SAME_CONNECTION_SAVED_KEY: savedKey,
      SAME_CONNECTION_ARBITRARY_KEY: arbitraryKey,
    },
  });

  const response = await postJson(app.origin, '/__admin/providers/update', {
    origId: 'same-connection',
    provider: {
      id: 'same-connection',
      provider_type: 'custom',
      provider_options: { base_url: `${app.upstreamOrigin}/v1` },
      base_url: `${app.upstreamOrigin}/v1`,
      auth: 'bearer',
      token_env: 'SAME_CONNECTION_ARBITRARY_KEY',
      models: ['fixture-model'],
      enabled: true,
    },
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /API Key|凭证/);
  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  assert.equal(providers.providers.find((provider) => provider.id === 'same-connection').token_env, 'SAME_CONNECTION_SAVED_KEY');
  assert.equal(app.upstreamRequests.some((request) => request.authorization === `Bearer ${arbitraryKey}`), false);
  assert.equal(app.output().includes(savedKey) || app.output().includes(arbitraryKey), false);
});

test('CRUD, raw config, and history reject non-canonical token_env names', async (t) => {
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'canonical-env',
      providerType: 'custom',
      tokenEnv: 'REVIEW_KEY',
      enabled: true,
      models: ['fixture-model'],
    }],
    childEnv: { REVIEW_KEY: 'fixture-canonical-env-secret' },
  });
  const current = await fetch(`${app.origin}/__admin/config`).then((response) => response.text());

  const edited = await postJson(app.origin, '/__admin/providers/update', {
    origId: 'canonical-env',
    provider: {
      id: 'canonical-env',
      provider_type: 'custom',
      provider_options: { base_url: `${app.upstreamOrigin}/v1` },
      base_url: `${app.upstreamOrigin}/v1`,
      auth: 'bearer',
      token_env: ' REVIEW_KEY ',
      models: ['fixture-model'],
      enabled: true,
    },
  });
  assert.equal(edited.status, 400);
  assert.match((await edited.json()).error, /token_env|环境变量名/);

  const malformed = current.replace('token_env = "REVIEW_KEY"', 'token_env = " REVIEW_KEY "');
  const raw = await postRawConfig(app.origin, malformed);
  assert.equal(raw.status, 400);
  assert.match((await raw.json()).error, /token_env|环境变量名/);

  const historyDir = path.join(app.home, '.codex-switch', 'history');
  const historyFile = 'config.20260825030303.001.toml';
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(path.join(historyDir, historyFile), malformed);
  const restored = await postJson(app.origin, '/__admin/history/restore', { file: historyFile });
  assert.equal(restored.status, 400);
  assert.match((await restored.json()).error, /token_env|环境变量名/);

  const after = await fetch(`${app.origin}/__admin/config`).then((response) => response.text());
  assert.equal(after, current);
  assert.equal(app.upstreamRequests.some((request) => request.authorization === 'Bearer undefined'), false);
  assert.equal(app.output().includes('fixture-canonical-env-secret'), false);
});

test('raw config cannot add a bearer provider by borrowing an existing process environment key', async (t) => {
  const borrowedKey = 'fixture-raw-borrowed-secret';
  const app = await startCodexSwitchFixture(t, {
    childEnv: { RAW_BORROWED_KEY: borrowedKey },
  });
  const current = await fetch(`${app.origin}/__admin/config`).then((response) => response.text());
  const attempted = `${current.trimEnd()}\n\n${providerBlock({
    id: 'raw-borrowed',
    baseUrl: `${app.upstreamOrigin}/borrowed-v1`,
    tokenEnv: 'RAW_BORROWED_KEY',
    enabled: true,
    providerType: 'custom',
    models: ['fixture-model'],
  })}\n`;

  const response = await postRawConfig(app.origin, attempted);

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /raw config|API Key|bearer/i);
  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  assert.equal(providers.providers.some((provider) => provider.id === 'raw-borrowed'), false);
  assert.equal(app.upstreamRequests.some((request) => request.path.startsWith('/borrowed-v1')), false);
  assert.equal(app.output().includes(borrowedKey), false);
});

test('raw config cannot change a bearer connection or rebind its credential reference', async (t) => {
  const savedKey = 'fixture-raw-saved-secret';
  const arbitraryKey = 'fixture-raw-arbitrary-secret';
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'raw-existing',
      providerType: 'custom',
      tokenEnv: 'RAW_SAVED_KEY',
      enabled: true,
      models: ['fixture-model'],
    }],
    childEnv: {
      RAW_SAVED_KEY: savedKey,
      RAW_ARBITRARY_KEY: arbitraryKey,
    },
  });
  await waitForProviderCache(app.origin, 'raw-existing');
  const current = await fetch(`${app.origin}/__admin/config`).then((response) => response.text());

  const changedConnection = current.replaceAll(`${app.upstreamOrigin}/v1`, `${app.upstreamOrigin}/changed-v1`);
  const connectionResponse = await postRawConfig(app.origin, changedConnection);
  assert.equal(connectionResponse.status, 400);
  assert.match((await connectionResponse.json()).error, /raw config|API Key|连接/i);

  const reboundCredential = current.replace('token_env = "RAW_SAVED_KEY"', 'token_env = "RAW_ARBITRARY_KEY"');
  const credentialResponse = await postRawConfig(app.origin, reboundCredential);
  assert.equal(credentialResponse.status, 400);
  assert.match((await credentialResponse.json()).error, /raw config|API Key|凭证/i);

  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  const saved = providers.providers.find((provider) => provider.id === 'raw-existing');
  assert.equal(saved.base_url, `${app.upstreamOrigin}/v1`);
  assert.equal(saved.token_env, 'RAW_SAVED_KEY');
  assert.equal(app.upstreamRequests.some((request) => request.path.startsWith('/changed-v1')), false);
  assert.equal(app.upstreamRequests.some((request) => request.authorization === `Bearer ${arbitraryKey}`), false);
  assert.equal(app.output().includes(savedKey) || app.output().includes(arbitraryKey), false);
});

test('raw provider mutation revokes an older p2 discovery before a blocking p1 refresh', async (t) => {
  let p1Requests = 0;
  let p2Requests = 0;
  let blockedP1;
  let staleP2;
  const app = await startCodexSwitchFixture(t, {
    providers: [
      {
        id: 'raw-race-p1',
        basePath: '/p1-v1',
        providerType: 'custom',
        tokenEnv: 'RAW_RACE_P1_KEY',
        enabled: true,
        models: ['p1-model'],
      },
      {
        id: 'raw-race-p2',
        basePath: '/p2-v1',
        providerType: 'custom',
        tokenEnv: 'RAW_RACE_P2_KEY',
        enabled: true,
        models: ['fixture-model'],
      },
    ],
    childEnv: {
      RAW_RACE_P1_KEY: 'fixture-raw-race-p1-secret',
      RAW_RACE_P2_KEY: 'fixture-raw-race-p2-secret',
    },
    upstreamHandler(req, res) {
      if (req.url.startsWith('/p1-v1')) {
        p1Requests += 1;
        if (p1Requests >= 2) {
          blockedP1 = res;
          return;
        }
        return finishDiscoveryResponse(res, 111111);
      }
      if (req.url.startsWith('/p2-v1')) {
        p2Requests += 1;
        if (p2Requests >= 2) {
          staleP2 = res;
          return;
        }
        return finishDiscoveryResponse(res, 222222);
      }
      return finishDiscoveryResponse(res, 999999);
    },
  });
  t.after(() => {
    finishDiscoveryResponse(blockedP1, 111111);
    finishDiscoveryResponse(staleP2, 303030);
  });

  await waitForProviderCache(app.origin, 'raw-race-p1');
  await waitForProviderCache(app.origin, 'raw-race-p2');
  const oldDiscovery = postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'raw-race-p2',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/p2-v1`,
  });
  await waitUntil(() => Boolean(staleP2), 'old p2 discovery did not start');

  const original = await fetch(`${app.origin}/__admin/config`).then((response) => response.text());
  const renamed = original.replace('name = "raw-race-p2"', 'name = "raw-race-p2 changed"');
  const configured = await postRawConfig(app.origin, renamed);
  assert.equal(configured.status, 200);
  await waitUntil(() => Boolean(blockedP1), 'new p1 refresh did not block');

  finishDiscoveryResponse(staleP2, 303030);
  assert.equal((await oldDiscovery).status, 200);
  const generated = await fetch(`${app.origin}/__admin/codex-config`).then((response) => response.json());
  const fixtureModel = JSON.parse(generated.catalog_json).models.find((model) => model.slug === 'fixture-model');
  assert.equal(fixtureModel.context_window, 128000);
  finishDiscoveryResponse(blockedP1, 111111);
});

test('a provider mutation cancels an older refresh-all batch before its next provider starts', async (t) => {
  const oldP2Key = 'fixture-old-batch-p2-secret';
  const newP2Key = 'fixture-new-batch-p2-secret';
  let p1Requests = 0;
  let blockedP1;
  const app = await startCodexSwitchFixture(t, {
    providers: [
      {
        id: 'batch-p1',
        basePath: '/batch-p1-v1',
        providerType: 'custom',
        tokenEnv: 'BATCH_P1_KEY',
        enabled: true,
        models: ['p1-model'],
      },
      {
        id: 'batch-p2',
        basePath: '/batch-p2-v1',
        providerType: 'custom',
        tokenEnv: 'BATCH_P2_OLD_KEY',
        enabled: true,
        models: ['fixture-model'],
      },
    ],
    childEnv: {
      BATCH_P1_KEY: 'fixture-batch-p1-secret',
      BATCH_P2_OLD_KEY: oldP2Key,
    },
    upstreamHandler(req, res) {
      if (req.url.startsWith('/batch-p1-v1')) {
        p1Requests += 1;
        if (p1Requests >= 2) {
          blockedP1 = res;
          return;
        }
      }
      return finishDiscoveryResponse(res, 111111);
    },
  });
  t.after(() => finishDiscoveryResponse(blockedP1, 111111));

  await waitForProviderCache(app.origin, 'batch-p1');
  await waitForProviderCache(app.origin, 'batch-p2');
  const oldP2RequestsBefore = app.upstreamRequests.filter(
    (request) => request.path.startsWith('/batch-p2-v1') && request.authorization === `Bearer ${oldP2Key}`,
  ).length;

  const staleBatch = postJson(app.origin, '/__admin/fetch-capabilities', {});
  await waitUntil(() => Boolean(blockedP1), 'old refresh-all p1 did not block');
  const updated = await postJson(app.origin, '/__admin/providers/update', {
    origId: 'batch-p2',
    provider: {
      id: 'batch-p2',
      provider_type: 'custom',
      provider_options: { base_url: `${app.upstreamOrigin}/batch-p2-v1` },
      base_url: `${app.upstreamOrigin}/batch-p2-v1`,
      auth: 'bearer',
      token_env: 'BATCH_P2_NEW_KEY',
      api_key: newP2Key,
      models: ['fixture-model'],
      enabled: true,
    },
  });
  assert.equal(updated.status, 200);
  finishDiscoveryResponse(blockedP1, 111111);
  const staleResult = await staleBatch;
  assert.equal(staleResult.status, 200);

  const oldP2RequestsAfter = app.upstreamRequests.filter(
    (request) => request.path.startsWith('/batch-p2-v1') && request.authorization === `Bearer ${oldP2Key}`,
  ).length;
  assert.equal(oldP2RequestsAfter, oldP2RequestsBefore);
  assert.equal(app.upstreamRequests.some(
    (request) => request.path.startsWith('/batch-p2-v1') && request.authorization === `Bearer ${newP2Key}`,
  ), true);
  assert.equal(app.output().includes(oldP2Key) || app.output().includes(newP2Key), false);
});

test('history restore rejects a bearer connection change that has no same-request API key', async (t) => {
  const savedKey = 'fixture-history-saved-secret';
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'history-credential',
      providerType: 'custom',
      tokenEnv: 'HISTORY_SAVED_KEY',
      enabled: true,
      models: ['fixture-model'],
    }],
    childEnv: { HISTORY_SAVED_KEY: savedKey },
  });
  await waitForProviderCache(app.origin, 'history-credential');
  const current = await fetch(`${app.origin}/__admin/config`).then((response) => response.text());
  const unsafeSnapshot = current.replaceAll(`${app.upstreamOrigin}/v1`, `${app.upstreamOrigin}/history-v1`);
  const historyDir = path.join(app.home, '.codex-switch', 'history');
  const historyFile = 'config.20260825010101.001.toml';
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(path.join(historyDir, historyFile), unsafeSnapshot);

  const response = await postJson(app.origin, '/__admin/history/restore', { file: historyFile });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /history|API Key|连接|凭证/i);
  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  assert.equal(providers.providers.find((provider) => provider.id === 'history-credential').base_url, `${app.upstreamOrigin}/v1`);
  assert.equal(app.upstreamRequests.some((request) => request.path.startsWith('/history-v1')), false);
  assert.equal(app.output().includes(savedKey), false);
});

test('history restore revokes an older p2 discovery before a blocking p1 refresh', async (t) => {
  let p1Requests = 0;
  let p2Requests = 0;
  let blockedP1;
  let staleP2;
  const app = await startCodexSwitchFixture(t, {
    providers: [
      {
        id: 'history-race-p1',
        name: 'history-race-p1 current',
        basePath: '/history-p1-v1',
        providerType: 'custom',
        tokenEnv: 'HISTORY_RACE_P1_KEY',
        enabled: true,
        models: ['p1-model'],
      },
      {
        id: 'history-race-p2',
        name: 'history-race-p2 current',
        basePath: '/history-p2-v1',
        providerType: 'custom',
        tokenEnv: 'HISTORY_RACE_P2_KEY',
        enabled: true,
        models: ['fixture-model'],
      },
    ],
    childEnv: {
      HISTORY_RACE_P1_KEY: 'fixture-history-race-p1-secret',
      HISTORY_RACE_P2_KEY: 'fixture-history-race-p2-secret',
    },
    upstreamHandler(req, res) {
      if (req.url.startsWith('/history-p1-v1')) {
        p1Requests += 1;
        if (p1Requests >= 2) {
          blockedP1 = res;
          return;
        }
        return finishDiscoveryResponse(res, 111111);
      }
      if (req.url.startsWith('/history-p2-v1')) {
        p2Requests += 1;
        if (p2Requests >= 2) {
          staleP2 = res;
          return;
        }
        return finishDiscoveryResponse(res, 222222);
      }
      return finishDiscoveryResponse(res, 999999);
    },
  });
  t.after(() => {
    finishDiscoveryResponse(blockedP1, 111111);
    finishDiscoveryResponse(staleP2, 404040);
  });

  await waitForProviderCache(app.origin, 'history-race-p1');
  await waitForProviderCache(app.origin, 'history-race-p2');
  const current = await fetch(`${app.origin}/__admin/config`).then((response) => response.text());
  const historical = current.replace('name = "history-race-p2 current"', 'name = "history-race-p2 historical"');
  const historyDir = path.join(app.home, '.codex-switch', 'history');
  const historyFile = 'config.20260825020202.001.toml';
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(path.join(historyDir, historyFile), historical);

  const oldDiscovery = postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'history-race-p2',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/history-p2-v1`,
  });
  await waitUntil(() => Boolean(staleP2), 'old history p2 discovery did not start');
  const restored = await postJson(app.origin, '/__admin/history/restore', { file: historyFile });
  assert.equal(restored.status, 200);
  await waitUntil(() => Boolean(blockedP1), 'history refresh p1 did not block');

  finishDiscoveryResponse(staleP2, 404040);
  assert.equal((await oldDiscovery).status, 200);
  const generated = await fetch(`${app.origin}/__admin/codex-config`).then((response) => response.json());
  const fixtureModel = JSON.parse(generated.catalog_json).models.find((model) => model.slug === 'fixture-model');
  assert.equal(fixtureModel.context_window, 128000);
  finishDiscoveryResponse(blockedP1, 111111);
});

test('an atomic provider and key save rolls config back when credential persistence fails', async (t) => {
  const key = 'fixture-rollback-secret';
  const app = await startCodexSwitchFixture(t);
  const envDir = path.join(app.home, '.codex-switch');
  fs.mkdirSync(path.join(envDir, 'env.tmp'), { recursive: true });

  const response = await postJson(app.origin, '/__admin/providers', {
    id: 'rollback-custom',
    provider_type: 'custom',
    provider_options: { base_url: `${app.upstreamOrigin}/v1` },
    base_url: `${app.upstreamOrigin}/v1`,
    auth: 'bearer',
    token_env: 'ROLLBACK_CUSTOM_KEY',
    api_key: key,
    models: ['fixture-model'],
    enabled: true,
  });

  assert.equal(response.status, 400);
  const result = await response.json();
  assert.equal(JSON.stringify(result).includes(key), false);
  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  assert.equal(providers.providers.some((provider) => provider.id === 'rollback-custom'), false);
  assert.equal(app.upstreamRequests.length, 0);
  assert.equal(app.output().includes(key), false);
});

test('raw config load failure rolls back config, process routing, and cache metadata', async (t) => {
  const key = 'fixture-load-rollback-secret';
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'load-rollback',
      providerType: 'custom',
      tokenEnv: 'LOAD_ROLLBACK_KEY',
      enabled: true,
      models: ['fixture-model'],
    }],
    childEnv: { LOAD_ROLLBACK_KEY: key },
    upstreamHandler(req, res) {
      return finishDiscoveryResponse(res, 515151);
    },
  });
  await waitForProviderCache(app.origin, 'load-rollback');
  const beforeText = fs.readFileSync(app.configPath, 'utf8');
  const beforeProviders = await fetch(`${app.origin}/__admin/providers`).then((response) => response.json());
  const beforeCache = beforeProviders.providers.find((provider) => provider.id === 'load-rollback').capability_cache;
  const invalidRuntime = beforeText.replace('models = ["fixture-model"]', 'models = { invalid = true }');

  const response = await postRawConfig(app.origin, invalidRuntime);

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /iterable|models|load|配置/i);
  assert.equal(fs.readFileSync(app.configPath, 'utf8'), beforeText);
  const afterProviders = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  assert.deepEqual(
    afterProviders.providers.find((provider) => provider.id === 'load-rollback').capability_cache,
    beforeCache,
  );
  const discovery = await postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'load-rollback',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
  });
  assert.equal((await discovery.json()).validation.status, 'valid');
  assert.equal(app.upstreamRequests.at(-1).authorization, `Bearer ${key}`);
  assert.equal(app.output().includes(key), false);
});

test('failed credential persistence restores the pre-mutation generation and refresh lease', async (t) => {
  const oldKey = 'fixture-lease-rollback-old-secret';
  const newKey = 'fixture-lease-rollback-new-secret';
  let requests = 0;
  let delayedResponse;
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'lease-rollback',
      providerType: 'custom',
      tokenEnv: 'LEASE_ROLLBACK_KEY',
      enabled: true,
      models: ['fixture-model'],
    }],
    childEnv: { LEASE_ROLLBACK_KEY: oldKey },
    upstreamHandler(req, res) {
      requests += 1;
      if (requests >= 2 && req.url.startsWith('/v1')) {
        delayedResponse = res;
        return;
      }
      return finishDiscoveryResponse(res, 111111);
    },
  });
  t.after(() => finishDiscoveryResponse(delayedResponse, 333333));
  await waitForProviderCache(app.origin, 'lease-rollback');

  const inFlight = postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'lease-rollback',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
  });
  await waitUntil(() => Boolean(delayedResponse), 'pre-mutation discovery did not block');
  fs.mkdirSync(path.join(app.home, '.codex-switch', 'env.tmp'), { recursive: true });
  const failed = await postJson(app.origin, '/__admin/providers/update', {
    origId: 'lease-rollback',
    provider: {
      id: 'lease-rollback',
      provider_type: 'custom',
      provider_options: { base_url: `${app.upstreamOrigin}/changed-v1` },
      base_url: `${app.upstreamOrigin}/changed-v1`,
      auth: 'bearer',
      token_env: 'LEASE_ROLLBACK_KEY',
      api_key: newKey,
      models: ['fixture-model'],
      enabled: true,
    },
  });
  assert.equal(failed.status, 400);

  finishDiscoveryResponse(delayedResponse, 333333);
  assert.equal((await inFlight).status, 200);
  const generated = await fetch(`${app.origin}/__admin/codex-config`).then((response) => response.json());
  assert.equal(JSON.parse(generated.catalog_json).models.find((model) => model.slug === 'fixture-model').context_window, 333333);
  const providers = await fetch(`${app.origin}/__admin/providers`).then((response) => response.json());
  assert.equal(providers.providers.find((provider) => provider.id === 'lease-rollback').base_url, `${app.upstreamOrigin}/v1`);
  assert.equal(app.upstreamRequests.some((request) => request.authorization === `Bearer ${newKey}`), false);
  assert.equal(app.output().includes(oldKey) || app.output().includes(newKey), false);
});

test('failed provider and key rotation restores config, env, process key, and cached metadata', async (t) => {
  const oldKey = 'fixture-complete-rollback-old-secret';
  const newKey = 'fixture-complete-rollback-new-secret';
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'rollback-existing',
      providerType: 'custom',
      providerOptions: { base_url: '' },
      tokenEnv: 'ROLLBACK_EXISTING_KEY',
      enabled: true,
      models: ['fixture-model'],
    }],
    childEnv: { ROLLBACK_EXISTING_KEY: oldKey },
    upstreamHandler(req, res) {
      const contextWindow = req.url.startsWith('/changed-v1') ? 222222 : 111111;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: contextWindow }] }));
    },
  });
  const seeded = await postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'rollback-existing',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
  });
  assert.equal((await seeded.json()).validation.status, 'valid');
  const savedOldKey = await postJson(app.origin, '/__admin/env-keys/save', {
    name: 'ROLLBACK_EXISTING_KEY', value: oldKey,
  });
  assert.equal(savedOldKey.status, 200);
  const before = await fetch(`${app.origin}/__admin/codex-config`).then((res) => res.json());
  assert.equal(JSON.parse(before.catalog_json).models.find((model) => model.slug === 'fixture-model').context_window, 111111);
  const beforeProviders = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  const beforeCache = beforeProviders.providers.find((provider) => provider.id === 'rollback-existing').capability_cache;
  assert.equal(beforeCache.status, 'fresh');

  fs.mkdirSync(path.join(app.home, '.codex-switch', 'env.tmp'), { recursive: true });
  const response = await postJson(app.origin, '/__admin/providers/update', {
    origId: 'rollback-existing',
    provider: {
      id: 'rollback-existing',
      provider_type: 'custom',
      provider_options: { base_url: `${app.upstreamOrigin}/changed-v1` },
      base_url: `${app.upstreamOrigin}/changed-v1`,
      auth: 'bearer',
      token_env: 'ROLLBACK_EXISTING_KEY',
      api_key: newKey,
      models: ['fixture-model'],
      enabled: true,
    },
  });

  assert.equal(response.status, 400);
  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  const restored = providers.providers.find((provider) => provider.id === 'rollback-existing');
  assert.equal(restored.base_url, `${app.upstreamOrigin}/v1`);
  assert.deepEqual(restored.capability_cache, beforeCache);
  const after = await fetch(`${app.origin}/__admin/codex-config`).then((res) => res.json());
  assert.equal(JSON.parse(after.catalog_json).models.find((model) => model.slug === 'fixture-model').context_window, 111111);
  const exported = await fetch(`${app.origin}/__admin/providers/export?id=rollback-existing`).then((res) => res.json());
  assert.equal(exported.provider.api_key, oldKey);
  const rediscovered = await postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'rollback-existing',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
  });
  assert.equal((await rediscovered.json()).validation.status, 'valid');
  assert.equal(app.upstreamRequests.at(-1).authorization, `Bearer ${oldKey}`);
  assert.equal(JSON.stringify({ providers, after }).includes(oldKey), false);
  assert.equal(app.output().includes(oldKey) || app.output().includes(newKey), false);
});

test('editing a provider invalidates old capabilities and refreshes only with the new connection key', async (t) => {
  const oldKey = 'fixture-old-edit-secret';
  const newKey = 'fixture-new-edit-secret';
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'editable-custom',
      providerType: 'custom',
      providerOptions: { base_url: '' },
      tokenEnv: 'EDITABLE_CUSTOM_KEY',
      enabled: true,
      models: ['fixture-model'],
    }],
    childEnv: { EDITABLE_CUSTOM_KEY: oldKey },
    upstreamHandler(req, res) {
      const contextWindow = req.url.startsWith('/new-v1') ? 222222 : 111111;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: contextWindow }] }));
    },
  });
  const initial = await postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'editable-custom',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
  });
  assert.equal((await initial.json()).validation.status, 'valid');

  const updated = await postJson(app.origin, '/__admin/providers/update', {
    origId: 'editable-custom',
    provider: {
      id: 'editable-custom',
      provider_type: 'custom',
      provider_options: { base_url: `${app.upstreamOrigin}/new-v1` },
      base_url: `${app.upstreamOrigin}/new-v1`,
      auth: 'bearer',
      token_env: 'EDITABLE_CUSTOM_KEY',
      api_key: newKey,
      models: ['fixture-model'],
      enabled: true,
    },
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).capability_refresh.status, 'ok');
  const generated = await fetch(`${app.origin}/__admin/codex-config`).then((res) => res.json());
  assert.equal(JSON.parse(generated.catalog_json).models.find((model) => model.slug === 'fixture-model').context_window, 222222);
  const newConnectionRequests = app.upstreamRequests.filter((request) => request.path.startsWith('/new-v1'));
  assert.ok(newConnectionRequests.length > 0);
  assert.equal(newConnectionRequests.every((request) => request.authorization === `Bearer ${newKey}`), true);
  assert.equal(newConnectionRequests.some((request) => request.authorization === `Bearer ${oldKey}`), false);
  assert.equal(app.output().includes(oldKey) || app.output().includes(newKey), false);
});

test('deleting and reusing a provider ID cannot resurrect capabilities from its old connection', async (t) => {
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'reused-custom',
      providerType: 'custom',
      providerOptions: { base_url: '' },
      tokenEnv: 'OLD_REUSED_CUSTOM_KEY',
      enabled: true,
      models: ['fixture-model'],
    }],
    childEnv: { OLD_REUSED_CUSTOM_KEY: 'fixture-old-reused-secret' },
    upstreamHandler(req, res) {
      if (req.headers.authorization === 'Bearer fixture-new-reused-secret') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid fixture key' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 333333 }] }));
    },
  });
  const seeded = await postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'reused-custom',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
  });
  assert.equal((await seeded.json()).validation.status, 'valid');
  assert.equal((await postJson(app.origin, '/__admin/providers/delete', { id: 'reused-custom' })).status, 200);

  const added = await postJson(app.origin, '/__admin/providers', {
    id: 'reused-custom',
    provider_type: 'custom',
    provider_options: { base_url: `${app.upstreamOrigin}/new-v1` },
    base_url: `${app.upstreamOrigin}/new-v1`,
    auth: 'bearer',
    token_env: 'NEW_REUSED_CUSTOM_KEY',
    api_key: 'fixture-new-reused-secret',
    models: ['fixture-model'],
    enabled: true,
  });
  assert.equal(added.status, 200);
  assert.equal((await added.json()).capability_refresh.status, 'invalid');
  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  assert.deepEqual(providers.providers.find((provider) => provider.id === 'reused-custom').capability_cache, {
    status: 'missing', model_count: 0, updated_at: null,
  });
  const generated = await fetch(`${app.origin}/__admin/codex-config`).then((res) => res.json());
  assert.equal(JSON.parse(generated.catalog_json).models.find((model) => model.slug === 'fixture-model').context_window, 128000);
});

test('a delayed discovery cannot overwrite a deleted and re-added provider with the same URL', async (t) => {
  const oldKey = 'fixture-generation-old-secret';
  const newKey = 'fixture-generation-new-secret';
  let oldRequests = 0;
  let delayedResponse;
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'generation-custom',
      providerType: 'custom',
      providerOptions: { base_url: '' },
      tokenEnv: 'GENERATION_OLD_KEY',
      enabled: true,
      models: ['fixture-model'],
    }],
    childEnv: { GENERATION_OLD_KEY: oldKey },
    upstreamHandler(req, res) {
      if (req.headers.authorization === `Bearer ${oldKey}`) {
        oldRequests += 1;
        if (oldRequests >= 2) {
          delayedResponse = res;
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 101010 }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 202020 }] }));
    },
  });

  await waitUntil(() => oldRequests >= 1, 'initial capability refresh did not finish');
  const stale = postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'generation-custom',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
  });
  await waitUntil(() => Boolean(delayedResponse), 'delayed old discovery did not start');
  assert.equal((await postJson(app.origin, '/__admin/providers/delete', { id: 'generation-custom' })).status, 200);
  const added = await postJson(app.origin, '/__admin/providers', {
    id: 'generation-custom',
    provider_type: 'custom',
    provider_options: { base_url: `${app.upstreamOrigin}/v1` },
    base_url: `${app.upstreamOrigin}/v1`,
    auth: 'bearer',
    token_env: 'GENERATION_NEW_KEY',
    api_key: newKey,
    models: ['fixture-model'],
    enabled: true,
  });
  assert.equal(added.status, 200);
  delayedResponse.writeHead(200, { 'content-type': 'application/json' });
  delayedResponse.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 303030 }] }));
  assert.equal((await stale).status, 200);

  const generated = await fetch(`${app.origin}/__admin/codex-config`).then((res) => res.json());
  assert.equal(JSON.parse(generated.catalog_json).models.find((model) => model.slug === 'fixture-model').context_window, 202020);
  assert.equal(app.output().includes(oldKey) || app.output().includes(newKey), false);
});

test('a delayed refresh from a changed connection cannot evict the new connection cache', async (t) => {
  const oldKey = 'fixture-connection-race-old-secret';
  const newKey = 'fixture-connection-race-new-secret';
  let oldRequests = 0;
  let delayedResponse;
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'connection-race',
      providerType: 'custom',
      providerOptions: { base_url: '' },
      tokenEnv: 'CONNECTION_RACE_KEY',
      enabled: true,
      models: ['fixture-model'],
    }],
    childEnv: { CONNECTION_RACE_KEY: oldKey },
    upstreamHandler(req, res) {
      if (req.url.startsWith('/v1')) {
        oldRequests += 1;
        if (oldRequests >= 2) {
          delayedResponse = res;
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 111111 }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 222222 }] }));
    },
  });

  await waitUntil(() => oldRequests >= 1, 'initial capability refresh did not finish');
  const stale = postJson(app.origin, '/__admin/env-keys/save', {
    name: 'CONNECTION_RACE_KEY', value: oldKey,
  });
  await waitUntil(() => Boolean(delayedResponse), 'delayed old refresh did not start');
  const updated = await postJson(app.origin, '/__admin/providers/update', {
    origId: 'connection-race',
    provider: {
      id: 'connection-race',
      provider_type: 'custom',
      provider_options: { base_url: `${app.upstreamOrigin}/new-v1` },
      base_url: `${app.upstreamOrigin}/new-v1`,
      auth: 'bearer',
      token_env: 'CONNECTION_RACE_KEY',
      api_key: newKey,
      models: ['fixture-model'],
      enabled: true,
    },
  });
  assert.equal(updated.status, 200);
  delayedResponse.writeHead(200, { 'content-type': 'application/json' });
  delayedResponse.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 333333 }] }));
  assert.equal((await stale).status, 200);

  const generated = await fetch(`${app.origin}/__admin/codex-config`).then((res) => res.json());
  assert.equal(JSON.parse(generated.catalog_json).models.find((model) => model.slug === 'fixture-model').context_window, 222222);
  assert.equal(app.output().includes(oldKey) || app.output().includes(newKey), false);
});

test('enabling a saved provider refreshes its capabilities before toggle returns', async (t) => {
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'disabled-custom',
      providerType: 'custom',
      providerOptions: { base_url: '' },
      tokenEnv: 'DISABLED_REFRESH_KEY',
      enabled: false,
      models: ['fixture-model'],
    }],
    childEnv: { DISABLED_REFRESH_KEY: 'fixture-disabled-refresh-secret' },
    upstreamHandler(req, res) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 616161 }] }));
    },
  });

  const response = await postJson(app.origin, '/__admin/providers/toggle', {
    id: 'disabled-custom', enabled: true,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).capability_refresh.status, 'ok');
  const generated = await fetch(`${app.origin}/__admin/codex-config`).then((res) => res.json());
  assert.equal(JSON.parse(generated.catalog_json).models.find((model) => model.slug === 'fixture-model').context_window, 616161);
});

test('an explicit key cannot cache Custom discovery under a saved provider of another type', async (t) => {
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'saved-xai',
      providerType: 'xai',
      providerOptions: {},
      baseUrl: 'https://api.x.ai/v1',
      tokenEnv: 'SAVED_XAI_FIXTURE_KEY',
      enabled: true,
      models: ['fixture-model'],
    }],
    upstreamHandler(req, res) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{
        id: 'fixture-model',
        context_window: 424242,
        input_modalities: ['text', 'image'],
      }] }));
    },
  });
  const response = await postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'saved-xai',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
    api_key: 'fixture-explicit-cross-type-secret',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).validation.status, 'valid');

  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  const saved = providers.providers.find((provider) => provider.id === 'saved-xai');
  assert.deepEqual(saved.capability_cache, { status: 'missing', model_count: 0, updated_at: null });
  const generated = await fetch(`${app.origin}/__admin/codex-config`).then((res) => res.json());
  const catalog = JSON.parse(generated.catalog_json);
  assert.notEqual(catalog.models.find((model) => model.slug === 'fixture-model').context_window, 424242);
});

test('an explicit key cannot seed cache for a provider id that does not exist yet', async (t) => {
  const app = await startCodexSwitchFixture(t, {
    upstreamHandler(req, res) {
      if (req.headers.authorization === 'Bearer fixture-future-saved-secret') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid fixture key' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 424242 }] }));
    },
  });
  const discovery = await postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'future-custom',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
    api_key: 'fixture-explicit-future-secret',
  });
  assert.equal(discovery.status, 200);
  assert.equal((await discovery.json()).validation.status, 'valid');

  const added = await postJson(app.origin, '/__admin/providers', {
    id: 'future-custom',
    name: 'Future Custom',
    provider_type: 'custom',
    provider_options: { base_url: `${app.upstreamOrigin}/v1` },
    base_url: `${app.upstreamOrigin}/v1`,
    auth: 'bearer',
    token_env: 'FUTURE_CUSTOM_FIXTURE_KEY',
    api_key: 'fixture-future-saved-secret',
    models: ['fixture-model'],
    enabled: true,
  });
  assert.equal(added.status, 200);
  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  const saved = providers.providers.find((provider) => provider.id === 'future-custom');
  assert.deepEqual(saved.capability_cache, { status: 'missing', model_count: 0, updated_at: null });
  const generated = await fetch(`${app.origin}/__admin/codex-config`).then((res) => res.json());
  const catalog = JSON.parse(generated.catalog_json);
  assert.notEqual(catalog.models.find((model) => model.slug === 'fixture-model').context_window, 424242);
});

test('an explicit key caches discovery for the enabled saved provider with the same type', async (t) => {
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'saved-custom',
      providerType: 'custom',
      providerOptions: { base_url: '' },
      tokenEnv: 'SAVED_CUSTOM_FIXTURE_KEY',
      enabled: true,
      models: ['fixture-model'],
    }],
    upstreamHandler(req, res) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 424242 }] }));
    },
  });
  const response = await postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'saved-custom',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
    api_key: 'fixture-explicit-same-type-secret',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).validation.status, 'valid');
  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  const saved = providers.providers.find((provider) => provider.id === 'saved-custom');
  assert.equal(saved.capability_cache.status, 'fresh');
  assert.equal(saved.capability_cache.model_count, 1);
  const generated = await fetch(`${app.origin}/__admin/codex-config`).then((res) => res.json());
  const catalog = JSON.parse(generated.catalog_json);
  assert.equal(catalog.models.find((model) => model.slug === 'fixture-model').context_window, 424242);
});

test('an explicit key cannot cache discovery for a disabled saved provider', async (t) => {
  const app = await startCodexSwitchFixture(t, {
    providers: [{
      id: 'disabled-custom',
      providerType: 'custom',
      providerOptions: { base_url: '' },
      tokenEnv: 'DISABLED_CUSTOM_FIXTURE_KEY',
      enabled: false,
      models: ['fixture-model'],
    }],
  });
  const response = await postJson(app.origin, '/__admin/provider-discover', {
    provider_id: 'disabled-custom',
    provider_type: 'custom',
    base_url: `${app.upstreamOrigin}/v1`,
    api_key: 'fixture-explicit-disabled-secret',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).validation.status, 'valid');
  const providers = await fetch(`${app.origin}/__admin/providers`).then((res) => res.json());
  const saved = providers.providers.find((provider) => provider.id === 'disabled-custom');
  assert.deepEqual(saved.capability_cache, { status: 'missing', model_count: 0, updated_at: null });
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
    api_key: 'fixture-xai-save-secret',
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
