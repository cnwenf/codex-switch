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
  return { origin, upstreamOrigin, upstreamRequests, home, output: () => output };
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
    provider_options: { base_url: 'https://new-unconfigured.example/v1' },
    base_url: 'https://new-unconfigured.example/v1',
    auth: 'bearer',
    token_env: 'NEW_REUSED_CUSTOM_KEY',
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
