# Provider Discovery and Capability Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship codex-switch v0.5.0 with a truthful searchable provider directory, automatic credential validation, model/capability discovery, searchable model selection, and no default Bailian provider.

**Architecture:** Keep byte-preserving Responses routing unchanged. Add a backend-owned provider registry and isolated discovery adapters, persist provider type/options alongside the existing derived URL, and move the management page into its own renderer module. Unsupported Chat-Completions-only vendors remain searchable informational entries and cannot create broken routes.

**Tech Stack:** Node.js 20+ ESM, built-in `fetch` and `node:test`, `@iarna/toml`, server-rendered HTML/CSS/vanilla JavaScript, macOS Swift/AppKit packaging scripts.

**Spec:** `docs/superpowers/specs/2026-08-24-provider-discovery-design.md`

## Global Constraints

- Request and response bodies, including SSE, remain byte-for-byte passthrough.
- API keys never appear in `config.toml`, browser responses, logs, tests, or repository files.
- Preset URLs are resolved server-side; Custom and self-hosted URLs allow HTTPS plus loopback HTTP only.
- Missing capability fields map to `"unknown"`, never automatically to `false`.
- Kimi, GLM, DeepSeek, Gemini, Anthropic, Mistral, Together, Cerebras, and SiliconFlow are informational unsupported entries, not routable presets.
- Existing provider configurations without `provider_type` or `provider_options` remain valid.
- Fresh default configuration contains ChatGPT subscription only.
- Release version is `0.5.0`.

---

### Task 1: Test Foundation and Fresh-Install Default

**Files:**
- Modify: `package.json`
- Modify: `config.toml`
- Create: `test/default-config.test.js`

**Interfaces:**
- Consumes: current repository configuration and `@iarna/toml`.
- Produces: `npm test` and a default-config regression test used by release verification.

- [ ] **Step 1: Add the failing default-config test**

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import TOML from '@iarna/toml';

test('fresh config contains only the ChatGPT subscription provider', () => {
  const config = TOML.parse(fs.readFileSync(new URL('../config.toml', import.meta.url), 'utf8'));
  assert.deepEqual(config.providers.map((provider) => provider.id), ['chatgpt-sub']);
  assert.equal(config.providers.some((provider) => provider.id === 'bailian'), false);
});
```

- [ ] **Step 2: Add the test script and verify RED**

```json
"scripts": {
  "test": "node --test",
  "start": "sh scripts/start.sh",
  "stop": "node src/server.js stop",
  "status": "node src/server.js status"
}
```

Run: `npm test -- test/default-config.test.js`

Expected: FAIL because `config.toml` still contains `bailian`.

- [ ] **Step 3: Remove the shipped Bailian block and update comments**

Keep the complete `chatgpt-sub` block. Remove the `[[providers]] id = "bailian"` block and rewrite capability comments so they describe generalized live discovery instead of Bailian-only discovery.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- test/default-config.test.js`

Expected: 1 passing test.

- [ ] **Step 5: Commit**

```bash
git add package.json config.toml test/default-config.test.js
git commit -m "test: lock fresh-install provider defaults"
```

### Task 2: Provider Registry and URL Derivation

**Files:**
- Create: `src/provider-registry.js`
- Create: `test/provider-registry.test.js`

**Interfaces:**
- Consumes: plain provider option objects.
- Produces:
  - `PROVIDER_PRESETS`
  - `getProviderPreset(providerType)`
  - `listProviderPresets()`
  - `inferProviderType(baseUrl)`
  - `resolveProviderConnection(providerType, providerOptions, customBaseUrl)`
  - `isRoutableCompatibility(value)`

- [ ] **Step 1: Write failing registry tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getProviderPreset,
  inferProviderType,
  listProviderPresets,
  resolveProviderConnection,
} from '../src/provider-registry.js';

test('Custom is last and unsupported vendors remain searchable', () => {
  const presets = listProviderPresets();
  assert.equal(presets.at(-1).id, 'custom');
  assert.equal(presets.find((item) => item.id === 'kimi').compatibility, 'unsupported');
  assert.equal(presets.find((item) => item.id === 'deepseek').routable, false);
});

test('fixed and parameterized URLs resolve deterministically', () => {
  assert.equal(resolveProviderConnection('xai', {}, '').baseUrl, 'https://api.x.ai/v1');
  assert.equal(
    resolveProviderConnection('aws-bedrock', { region: 'us-east-1' }, '').baseUrl,
    'https://bedrock-mantle.us-east-1.api.aws/v1',
  );
  assert.equal(
    resolveProviderConnection('cloudflare-workers-ai', { account_id: 'abc123' }, '').baseUrl,
    'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1',
  );
});

test('known hosts infer provider types without changing old config', () => {
  assert.equal(inferProviderType('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(inferProviderType('https://api.deepseek.com'), 'deepseek');
  assert.equal(inferProviderType('https://gateway.example.test/v1'), 'custom');
});

test('public preset projection contains no executable functions', () => {
  assert.doesNotThrow(() => JSON.stringify(getProviderPreset('openrouter').public));
});
```

- [ ] **Step 2: Run registry tests to verify RED**

Run: `npm test -- test/provider-registry.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the immutable registry**

```js
const GROUPS = {
  direct: '直接与聚合 API',
  cloud: '云平台与自托管',
  unsupported: '暂不支持直连',
  custom: '自定义',
};

const preset = (definition) => Object.freeze({
  auth: 'bearer',
  options: [],
  ...definition,
  routable: ['supported', 'beta', 'limited', 'unverified'].includes(definition.compatibility),
});

export const PROVIDER_PRESETS = Object.freeze([
  preset({ id: 'openai', name: 'OpenAI API', group: GROUPS.direct, compatibility: 'supported', tokenEnv: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1' }),
  preset({ id: 'xai', name: 'xAI', group: GROUPS.direct, compatibility: 'supported', tokenEnv: 'XAI_API_KEY', baseUrl: 'https://api.x.ai/v1' }),
  preset({ id: 'openrouter', name: 'OpenRouter', group: GROUPS.direct, compatibility: 'supported', tokenEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' }),
  preset({ id: 'groq', name: 'Groq', group: GROUPS.direct, compatibility: 'beta', tokenEnv: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1' }),
  preset({ id: 'fireworks', name: 'Fireworks AI', group: GROUPS.direct, compatibility: 'supported', tokenEnv: 'FIREWORKS_API_KEY', baseUrl: 'https://api.fireworks.ai/inference/v1' }),
  preset({ id: 'baidu-qianfan', name: '百度千帆', group: GROUPS.direct, compatibility: 'supported', tokenEnv: 'QIANFAN_API_KEY', baseUrl: 'https://qianfan.baidubce.com/v2' }),
  preset({ id: 'volcengine-ark', name: '火山方舟', group: GROUPS.direct, compatibility: 'unverified', tokenEnv: 'ARK_API_KEY', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }),
  preset({ id: 'tencent-tokenhub', name: '腾讯 TokenHub', group: GROUPS.direct, compatibility: 'limited', tokenEnv: 'TENCENT_TOKENHUB_API_KEY', options: [{ name: 'site', type: 'select', default: 'cn', choices: ['cn', 'intl'] }] }),
  preset({ id: 'bailian', name: '阿里云百炼', group: GROUPS.direct, compatibility: 'limited', tokenEnv: 'DASHSCOPE_API_KEY', options: [{ name: 'region', type: 'select', default: 'cn-beijing', choices: ['cn-beijing', 'ap-southeast-1', 'us-west-1'] }, { name: 'workspace_id', type: 'text', default: '' }] }),
  preset({ id: 'aws-bedrock', name: 'AWS Bedrock', group: GROUPS.cloud, compatibility: 'supported', tokenEnv: 'AWS_BEDROCK_API_KEY', options: [{ name: 'region', type: 'text', default: 'us-east-1' }] }),
  preset({ id: 'azure-openai', name: 'Azure OpenAI / Microsoft Foundry', group: GROUPS.cloud, compatibility: 'supported', tokenEnv: 'AZURE_OPENAI_API_KEY', options: [{ name: 'resource_endpoint', type: 'url', default: '' }] }),
  preset({ id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI', group: GROUPS.cloud, compatibility: 'limited', tokenEnv: 'CLOUDFLARE_API_TOKEN', options: [{ name: 'account_id', type: 'text', default: '' }] }),
  preset({ id: 'nvidia-nim', name: 'NVIDIA NIM（自托管）', group: GROUPS.cloud, compatibility: 'unverified', tokenEnv: 'NVIDIA_NIM_API_KEY', options: [{ name: 'base_url', type: 'url', default: 'http://127.0.0.1:8000/v1' }] }),
  ...['kimi', 'glm', 'deepseek', 'gemini', 'anthropic', 'mistral', 'together', 'cerebras', 'siliconflow'].map((id) => preset({ id, name: id, group: GROUPS.unsupported, compatibility: 'unsupported', tokenEnv: '' })),
  preset({ id: 'custom', name: '自定义', group: GROUPS.custom, compatibility: 'unverified', tokenEnv: 'CUSTOM_API_KEY', options: [{ name: 'base_url', type: 'url', default: '' }] }),
]);
```

Implement URL derivation with explicit validation for region, resource endpoint, account ID, workspace ID, and loopback Custom/NIM URLs. Return a safe `public` projection without functions.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- test/provider-registry.test.js`

Expected: all registry tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/provider-registry.js test/provider-registry.test.js
git commit -m "feat: add extensible provider preset registry"
```

### Task 3: Discovery Adapters and Capability Normalization

**Files:**
- Create: `src/provider-discovery.js`
- Create: `test/provider-discovery.test.js`

**Interfaces:**
- Consumes: `getProviderPreset()`, `resolveProviderConnection()`, an optional injected `fetchImpl`, provider options, and an API key.
- Produces:
  - `discoverProvider(input, dependencies)`
  - `normalizeOpenAIModel(model, source)`
  - `mapDiscoveryError(errorOrResponse)`
  - `validateDiscoveryUrl(url, providerType)`
  - normalized models with tri-state capability flags.

- [ ] **Step 1: Write failing normalization, adapter, and secret-safety tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverProvider } from '../src/provider-discovery.js';

const response = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('OpenRouter validation and user models normalize capabilities', async () => {
  const calls = [];
  const result = await discoverProvider({
    providerType: 'openrouter',
    providerOptions: {},
    apiKey: 'secret-test-key',
  }, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), authorization: init.headers.authorization });
      if (String(url).endsWith('/key')) return response(200, { data: { limit: 10 } });
      return response(200, { data: [{
        id: 'vendor/model',
        name: 'Vendor Model',
        context_length: 131072,
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        top_provider: { max_completion_tokens: 8192 },
        supported_parameters: ['tools', 'reasoning'],
      }] });
    },
  });
  assert.equal(result.validation.status, 'valid');
  assert.deepEqual(result.models[0].input, { text: true, image: true, audio: false, video: false, file: false });
  assert.equal(result.models[0].tools, true);
  assert.equal(result.models[0].reasoning, true);
  assert.equal(JSON.stringify(result).includes('secret-test-key'), false);
  assert.equal(calls.every((call) => call.authorization === 'Bearer secret-test-key'), true);
});

test('missing fields stay unknown', async () => {
  const result = await discoverProvider({ providerType: 'openai', providerOptions: {}, apiKey: 'secret' }, {
    fetchImpl: async () => response(200, { data: [{ id: 'new-model', object: 'model' }] }),
  });
  assert.equal(result.models[0].input.image, 'unknown');
  assert.equal(result.models[0].reasoning, 'unknown');
});

test('unsupported vendors never make network calls', async () => {
  let called = false;
  const result = await discoverProvider({ providerType: 'deepseek', providerOptions: {}, apiKey: 'secret' }, {
    fetchImpl: async () => { called = true; throw new Error('must not run'); },
  });
  assert.equal(called, false);
  assert.equal(result.validation.status, 'unsupported');
});

test('status codes map without leaking upstream body or key', async () => {
  const result = await discoverProvider({ providerType: 'xai', providerOptions: {}, apiKey: 'secret-401' }, {
    fetchImpl: async () => response(401, { error: { message: 'bad secret-401' } }),
  });
  assert.equal(result.validation.status, 'invalid');
  assert.equal(JSON.stringify(result).includes('secret-401'), false);
});
```

- [ ] **Step 2: Run discovery tests to verify RED**

Run: `npm test -- test/provider-discovery.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement bounded fetching and normalized capabilities**

```js
const UNKNOWN = 'unknown';
const emptyModalities = () => ({
  input: { text: UNKNOWN, image: UNKNOWN, audio: UNKNOWN, video: UNKNOWN, file: UNKNOWN },
  output: { text: UNKNOWN, image: UNKNOWN, audio: UNKNOWN },
});

const withTimeout = (timeoutMs, signal) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('provider request timeout')), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  return { signal: controller.signal, done: () => clearTimeout(timer) };
};

const authHeaders = (apiKey) => ({
  accept: 'application/json',
  authorization: `Bearer ${apiKey}`,
  'user-agent': 'codex-switch/provider-discovery',
});
```

Implement a 10-second timeout, a 4 MiB JSON response limit, at most five pages and 2,000 models, sanitized errors, and adapters for:

- generic Models: OpenAI, Groq, Fireworks, AWS Bedrock, NVIDIA NIM, Custom;
- xAI key plus language-models;
- OpenRouter key plus user/public models;
- Baidu Qianfan rich models;
- Tencent TokenHub response-compatible filtering;
- Bailian native paginated models;
- static/manual results for Volcengine, Azure deployment names, and Cloudflare's Responses whitelist.

Use one adapter table keyed by provider type. Merge API values over official static values and leave absent values unknown.

- [ ] **Step 4: Add pagination and URL-safety tests**

```js
test('Bailian follows bounded native pagination', async () => {
  const pages = [];
  const result = await discoverProvider({
    providerType: 'bailian',
    providerOptions: { region: 'cn-beijing', workspace_id: '' },
    apiKey: 'secret',
  }, {
    fetchImpl: async (url) => {
      pages.push(new URL(url).searchParams.get('page_no'));
      const page = Number(pages.at(-1));
      return response(200, { output: {
        total: 2,
        models: page === 1
          ? [{ model: 'qwen-a', model_info: { context_window: 1000 }, inference_metadata: { request_modality: ['Text', 'Image'] } }]
          : [{ model: 'qwen-b', model_info: { context_window: 2000 }, inference_metadata: { request_modality: ['Text'] } }],
      } });
    },
  });
  assert.deepEqual(pages, ['1', '2']);
  assert.deepEqual(result.models.map((model) => model.id), ['qwen-a', 'qwen-b']);
});

test('Custom rejects non-loopback HTTP', async () => {
  await assert.rejects(
    discoverProvider({ providerType: 'custom', baseUrl: 'http://example.com/v1', apiKey: 'secret' }),
    /HTTPS|loopback/,
  );
});
```

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- test/provider-discovery.test.js`

Expected: all adapter and safety tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/provider-discovery.js test/provider-discovery.test.js
git commit -m "feat: discover provider models and capabilities"
```

### Task 4: Provider Persistence and Generalized Capability Cache

**Files:**
- Create: `src/provider-config.js`
- Create: `test/provider-config.test.js`
- Modify: `src/caps.js`
- Modify: `src/server.js`

**Interfaces:**
- Consumes: registry resolution, normalized discovered models, parsed TOML providers.
- Produces:
  - `normalizeProvider(input)`
  - `buildProvidersRegion(providers)`
  - `replaceProvidersRegion(text, providers)`
  - `cacheDiscoveredModels(providerId, models)`
  - generalized `resolveCaps(config, provider, modelId)`.

- [ ] **Step 1: Write failing persistence tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import TOML from '@iarna/toml';
import { buildProvidersRegion, normalizeProvider, replaceProvidersRegion } from '../src/provider-config.js';

test('provider type and options round-trip through TOML', () => {
  const provider = normalizeProvider({
    id: 'bedrock-us',
    name: 'AWS Bedrock',
    provider_type: 'aws-bedrock',
    provider_options: { region: 'us-east-1' },
    auth: 'bearer',
    token_env: 'AWS_BEDROCK_API_KEY',
    base_url: 'https://ignored.example',
    models: ['openai.gpt-oss-120b'],
  });
  const parsed = TOML.parse(buildProvidersRegion([provider])).providers[0];
  assert.equal(parsed.provider_type, 'aws-bedrock');
  assert.deepEqual(parsed.provider_options, { region: 'us-east-1' });
  assert.equal(parsed.base_url, 'https://bedrock-mantle.us-east-1.api.aws/v1');
});

test('unsupported presets cannot be normalized into routes', () => {
  assert.throws(() => normalizeProvider({
    id: 'deepseek',
    name: 'DeepSeek',
    provider_type: 'deepseek',
    auth: 'bearer',
    token_env: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat'],
  }), /不支持.*Responses/);
});

test('legacy providers remain custom and keep their URL', () => {
  const provider = normalizeProvider({
    id: 'legacy',
    name: 'Legacy',
    auth: 'bearer',
    token_env: 'LEGACY_API_KEY',
    base_url: 'https://legacy.example/v1',
    models: 'model-a,model-b',
  });
  assert.equal(provider.provider_type, 'custom');
  assert.equal(provider.base_url, 'https://legacy.example/v1');
});
```

- [ ] **Step 2: Run persistence tests to verify RED**

Run: `npm test -- test/provider-config.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Extract provider persistence from server.js**

Move `tomlStr`, provider region building/replacement, and normalization into `src/provider-config.js`. Serialize `provider_options` as a TOML inline table with string, boolean, and finite-number values only. Re-resolve preset base URLs server-side during normalization. Reject unsupported preset types.

Update `server.js` to import these functions without changing snapshot, history, toggle, delete, or hot-reload semantics.

- [ ] **Step 4: Generalize the capability cache**

```js
export function cacheDiscoveredModels(providerId, models) {
  capsCache.set(providerId, {
    at: Date.now(),
    models: new Map(models.map((model) => [model.id, {
      contextWindow: model.contextWindow,
      vision: model.input?.image === true,
      reasoning: model.reasoning,
      source: model.source,
    }])),
  });
}
```

Replace Bailian-only refresh calls with discovery of configured enabled providers. A refresh failure returns a status entry and does not clear a valid prior cache.

- [ ] **Step 5: Verify persistence and existing syntax**

Run: `npm test -- test/provider-config.test.js test/provider-registry.test.js test/provider-discovery.test.js`

Run: `node --check src/server.js && node --check src/caps.js`

Expected: all tests pass and both syntax checks exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/provider-config.js src/caps.js src/server.js test/provider-config.test.js
git commit -m "refactor: persist provider presets and cache discovery"
```

### Task 5: Admin Preset and Discovery APIs

**Files:**
- Modify: `src/server.js`
- Create: `test/admin-api.test.js`

**Interfaces:**
- Consumes: `listProviderPresets()`, `discoverProvider()`, existing env-key status, provider CRUD.
- Produces:
  - `GET /__admin/provider-presets`
  - `POST /__admin/provider-discover`
  - provider responses including inferred type/options and capability cache summary.

- [ ] **Step 1: Write failing subprocess integration tests**

Create a temporary config and local stub upstream, spawn `node src/server.js` with `CODEXSWITCH_CONFIG` and an unused loopback port, and assert:

```js
test('admin returns safe presets and discovers a Custom model', async (t) => {
  const app = await startCodexSwitchFixture(t);
  const presets = await fetch(`${app.origin}/__admin/provider-presets`).then((res) => res.json());
  assert.equal(presets.presets.at(-1).id, 'custom');
  assert.equal(JSON.stringify(presets).includes('buildBaseUrl'), false);

  const discovered = await fetch(`${app.origin}/__admin/provider-discover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider_type: 'custom',
      base_url: app.upstreamOrigin + '/v1',
      api_key: 'fixture-secret',
    }),
  }).then((res) => res.json());
  assert.equal(discovered.validation.status, 'valid');
  assert.deepEqual(discovered.models.map((model) => model.id), ['fixture-model']);
  assert.equal(JSON.stringify(discovered).includes('fixture-secret'), false);
});
```

Add a second test proving that editing may reuse only the configured provider's own `token_env`; arbitrary environment-variable names in the request are ignored.

- [ ] **Step 2: Run admin tests to verify RED**

Run: `npm test -- test/admin-api.test.js`

Expected: preset or discovery endpoint returns 404.

- [ ] **Step 3: Implement the admin endpoints**

```js
if (req.method === 'GET' && p === '/__admin/provider-presets') {
  return sendJson(res, 200, { ok: true, presets: listProviderPresets() });
}

if (req.method === 'POST' && p === '/__admin/provider-discover') {
  const explicitKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  const saved = explicitKey ? '' : resolveSavedProviderKey(body.provider_id);
  const result = await discoverProvider({
    providerType: body.provider_type,
    providerOptions: body.provider_options || {},
    baseUrl: body.base_url,
    apiKey: explicitKey || saved,
  });
  if (body.provider_id && result.models.length) cacheDiscoveredModels(body.provider_id, result.models);
  return sendJson(res, 200, result);
}
```

`resolveSavedProviderKey(providerId)` must look up the current provider by ID and read only that provider's configured `token_env`; do not accept a client-provided environment variable name.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- test/admin-api.test.js`

Expected: all admin integration tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/admin-api.test.js
git commit -m "feat: expose provider discovery admin APIs"
```

### Task 6: Searchable Provider and Model Combobox UI

**Files:**
- Create: `src/admin-page.js`
- Create: `test/admin-page.test.js`
- Modify: `src/server.js`

**Interfaces:**
- Consumes: preset and discovery admin APIs plus existing provider CRUD/env-key APIs.
- Produces: `renderAdminPage({ host, port, version })` and the guided provider modal.

- [ ] **Step 1: Write failing page-structure tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAdminPage } from '../src/admin-page.js';

test('provider form has searchable provider and multi-model comboboxes', () => {
  const html = renderAdminPage({ host: '127.0.0.1', port: 8787, version: '0.5.0' });
  assert.match(html, /id="providerSearch"/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /id="modelSearch"/);
  assert.match(html, /id="selectedModels"/);
  assert.match(html, /id="providerCompatibility"/);
  assert.match(html, /id="discoveryStatus"/);
});

test('API key is password-only and never embedded as a JavaScript value', () => {
  const html = renderAdminPage({ host: '127.0.0.1', port: 8787, version: '0.5.0' });
  assert.match(html, /id="f-apikey" type="password"/);
  assert.doesNotMatch(html, /api[_-]?key\s*[:=]\s*['"][^'"]+/i);
});
```

- [ ] **Step 2: Run page tests to verify RED**

Run: `npm test -- test/admin-page.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Extract the current page renderer**

Move `renderAdminPage` and its required escaping helper into `src/admin-page.js`. Pass host, port, and version explicitly. Keep all existing tabs, provider cards, history, Codex apply/restore, autostart, update, export/import, and toast behavior.

Update `server.js` to call `renderAdminPage({ host, port, version: PKG_VERSION })`.

- [ ] **Step 4: Replace the form with the guided searchable UI**

Implement:

- a provider search input with grouped listbox, arrow-key navigation, Enter selection, Escape closing, and Custom last;
- server-rendered compatibility status with supported/beta/limited/unsupported styles;
- dynamic connection fields from the public registry schema;
- URL preview that is editable only for Custom/NIM;
- a 700 ms API-key debounce plus immediate blur validation and request cancellation;
- a searchable multi-model listbox with checkboxes, keyboard selection, selected chips, manual ID entry, and capability badges;
- unsupported vendor explanation plus “改用 OpenRouter” action;
- preservation of existing selected/manual model IDs during refresh;
- save blocking for missing key, invalid key, unsupported presets, and empty model selection according to the Spec.

Use native controls, `role="combobox"`, `role="listbox"`, `aria-expanded`, `aria-activedescendant`, visible focus styles, and reduced-motion-safe transitions.

- [ ] **Step 5: Add pure browser-state tests**

Export small helpers from `admin-page.js` for test use:

```js
export function filterOptions(items, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  return needle
    ? items.filter((item) => `${item.name} ${item.id}`.toLocaleLowerCase().includes(needle))
    : items.slice();
}

export function mergeSelectedModels(currentIds, discoveredModels) {
  const byId = new Map(discoveredModels.map((model) => [model.id, model]));
  return [...new Set(currentIds)].map((id) => byId.get(id) || { id, name: id, source: 'manual' });
}
```

Assert Chinese/English provider search, Custom remaining last when unfiltered, duplicate-free selections, and manual-model preservation.

- [ ] **Step 6: Verify page and integration tests**

Run: `npm test -- test/admin-page.test.js test/admin-api.test.js`

Run: `node --check src/admin-page.js && node --check src/server.js`

Expected: all tests and syntax checks pass.

- [ ] **Step 7: Commit**

```bash
git add src/admin-page.js src/server.js test/admin-page.test.js
git commit -m "feat: add searchable provider and model setup"
```

### Task 6B: Whole-Page Theme, Layout, and Interaction Redesign

**Files:**
- Modify: `src/admin-page.js`
- Modify: `test/admin-page.test.js`

**Interfaces:**
- Consumes: completed Task 6 behavior, `PRODUCT.md`, `DESIGN.md`, Impeccable critique/polish guidance, frontend accessibility patterns, and real-browser screenshots.
- Produces: a cohesive macOS-oriented local developer-tool theme and layout without changing endpoints, payloads, state transitions, persistence, or provider/model business rules.

- [ ] **Step 1: Capture the current UI and run a structured critique**

Deploy the current page with isolated fixture data. Inspect desktop and narrow layouts in a real browser. Record specific findings for theme, information hierarchy, typography, spacing, density, alignment, navigation, forms, dialogs, provider cards, status treatment, and interaction feedback. Use the Impeccable product-register critique and reject category-reflex “dark AI console” styling.

- [ ] **Step 2: Write visual-contract regression tests**

Add tests that lock down the new design system and accessibility invariants without coupling to incidental pixel values:

- semantic surface/text/accent/status tokens with WCAG AA contrast;
- clear type and spacing hierarchy;
- bounded readable content width and responsive breakpoints;
- consistent control height, focus ring, disabled/reference treatment, and dialog/listbox layering;
- reduced-motion handling;
- no gradient text, decorative glass blur, side-stripe cards, nested card grids, or layout-property animation;
- all pre-existing form IDs, API calls, actions, and state helpers remain present.

Run the focused suite and record RED before changing production styles or markup.

- [ ] **Step 3: Redesign theme and page structure**

Replace the current dark-console theme with a restrained, high-clarity macOS developer-tool system. Improve the top-level page rhythm, navigation, provider summary/list, configuration history, Codex apply/restore area, empty/loading states, and dialog composition. Use deliberate surface layers, readable typography, consistent alignment, fewer unnecessary card boundaries, and status colors reserved for meaning.

Do not change business logic, endpoint paths, request/response bodies, provider compatibility rules, discovery/save gates, or persistence behavior.

- [ ] **Step 4: Refine interaction design**

Polish hover/focus/active/disabled/loading/error states, provider and model combobox affordances, inline validation, selection chips, disclosure behavior, dialogs, toasts, and narrow-screen layout. Preserve all Task 6 keyboard semantics and security invariants. Motion must be short, state-driven, and disabled under `prefers-reduced-motion`.

- [ ] **Step 5: Verify behavior parity and visual quality**

Run Task 5+6 tests and the full suite. In a real browser, compare desktop and narrow screenshots, exercise all primary flows, check overflow/focus/contrast, and confirm no existing action disappeared. Run syntax, diff, DOM-sink, credential, and accessibility scans.

- [ ] **Step 6: Commit**

```bash
git add src/admin-page.js test/admin-page.test.js
git commit -m "style: redesign provider management experience"
```

### Task 7: Version, Documentation, and Full Automated Verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `DESIGN.md`

**Interfaces:**
- Consumes: implemented v0.5.0 behavior.
- Produces: accurate user documentation and release metadata.

- [ ] **Step 1: Update version metadata**

Run: `npm version 0.5.0 --no-git-tag-version`

Expected: `package.json` and `package-lock.json` both report `0.5.0`.

- [ ] **Step 2: Update README usage and compatibility table**

Document the guided setup, automatic validation, searchable model selection, capability provenance, fresh-install default, supported/beta/limited providers, and unsupported popular direct APIs. Explain that unsupported vendors can be accessed through OpenRouter when the desired model is available there.

- [ ] **Step 3: Update DESIGN.md**

Replace Bailian-only capability discovery with the registry/adapter architecture, add validation states, provider options persistence, security limits, and the Responses compatibility boundary.

- [ ] **Step 4: Run complete automated verification**

Run:

```bash
npm test
node --check src/server.js
node --check src/caps.js
node --check src/provider-registry.js
node --check src/provider-discovery.js
node --check src/provider-config.js
node --check src/admin-page.js
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json README.md DESIGN.md
git commit -m "docs: prepare provider discovery v0.5.0"
```

### Task 8: Local Deployment, Browser Inspection, and Available-Key Evidence

**Files:**
- No repository files unless verification reveals a defect.

**Interfaces:**
- Consumes: the built source application, browser-control skill, and names of locally configured environment keys.
- Produces: verification evidence separated into live-tested, stub-tested, and documentation-only providers.

- [ ] **Step 1: Read browser-control instructions and inspect key names only**

Read the full `browser:control-in-app-browser` skill before browser actions. List configured variable names from `~/.codex-switch/env` and the current process without printing values. Before reading or using any secret value for a live provider request, explicitly confirm that sensitive operation with the user as required by the workstation policy.

- [ ] **Step 2: Deploy the source build locally**

Run: `./install.sh`

Expected: service listens on `127.0.0.1:8787` and `GET /__admin/health` reports version `0.5.0`.

- [ ] **Step 3: Inspect the real page**

Open `http://127.0.0.1:8787/` in the in-app browser and verify:

- provider search finds direct and unsupported entries;
- Custom is last;
- fixed URLs are read-only and parameterized URLs update;
- unsupported Kimi/GLM/DeepSeek explain the Responses limitation;
- API-key validation states render without exposing the key;
- model search, keyboard navigation, multi-selection, manual IDs, capability badges, and edit preservation work;
- narrow viewport remains usable.

Capture screenshots for the provider selector and discovered-model state.

- [ ] **Step 4: Live-test only locally available keys**

For each key whose presence is confirmed and whose use is explicitly approved, run validation/model discovery from the page or admin API. Never print the key. Report HTTP result, model count, and capability-source coverage only.

Providers without keys remain “stub-tested + official docs verified,” not live-tested.

- [ ] **Step 5: Fix and re-run if needed**

For any defect, write a failing regression test, verify RED, implement the minimal fix, verify GREEN, repeat the affected browser scenario, and commit with a scoped `fix:` message.

### Task 9: DMG Build, Install Smoke Test, Push, and GitHub Release

**Files:**
- Generated: `dist/CodexSwitch-0.5.0-macos-arm64.dmg`
- Generated: `dist/CodexSwitch-0.5.0-macos-arm64.dmg.sha256`

**Interfaces:**
- Consumes: clean v0.5.0 source tree and release credentials.
- Produces: pushed `main`, tag `v0.5.0`, and a public GitHub Release with verified DMG and checksum assets.

- [ ] **Step 1: Run final pre-build verification**

Run:

```bash
npm ci --ignore-scripts
npm test
git diff --check
git status --short
```

Expected: tests pass and the worktree is clean.

- [ ] **Step 2: Build and verify the DMG**

Run:

```bash
sh scripts/build-macos-app.sh
codesign --verify --deep --strict --verbose=2 "dist/staging/Codex Switch.app" 2>/dev/null || true
shasum -a 256 dist/CodexSwitch-0.5.0-macos-arm64.dmg > dist/CodexSwitch-0.5.0-macos-arm64.dmg.sha256
hdiutil verify dist/CodexSwitch-0.5.0-macos-arm64.dmg
```

Because the build script removes staging after signing, verify the mounted app signature in the next step even if the staging path is absent.

- [ ] **Step 3: Mount and smoke-test the bundled app**

Mount the DMG with `hdiutil attach -nobrowse -readonly`, run `codesign --verify --deep --strict` against the mounted app, inspect its bundled `package.json` and `config.toml`, launch it on an unused test configuration if necessary, verify the health endpoint and management page, then detach the explicit mount point.

- [ ] **Step 4: Verify repository and release authentication**

Run: `git push --dry-run origin main` and `gh auth status`.

If CLI auth remains unavailable, use the already signed-in GitHub browser only after the user confirms any sensitive login/token interaction. Do not expose credentials in commands, URLs, logs, or chat.

- [ ] **Step 5: Push commits and create the release**

```bash
git push origin main
git tag -a v0.5.0 -m "codex-switch v0.5.0"
git push origin v0.5.0
gh release create v0.5.0 \
  dist/CodexSwitch-0.5.0-macos-arm64.dmg \
  dist/CodexSwitch-0.5.0-macos-arm64.dmg.sha256 \
  --title "codex-switch v0.5.0" \
  --notes-file /tmp/codex-switch-v0.5.0-release-notes.md
```

Release notes must summarize provider discovery, truthful Responses compatibility, searchable models/capabilities, no default Bailian, security behavior, and verification evidence without mentioning or exposing keys.

- [ ] **Step 6: Verify the published release**

Run:

```bash
gh release view v0.5.0 --json url,tagName,isDraft,isPrerelease,assets
curl -fsSL https://api.github.com/repos/cnwenf/codex-switch/releases/tags/v0.5.0
```

Expected: public non-draft `v0.5.0` with both assets and matching sizes. Download the published checksum and compare it with the local DMG checksum.

- [ ] **Step 7: Final handoff**

Report:

- commit and tag;
- release URL;
- automated test totals;
- browser and DMG evidence;
- providers live-tested versus stub/docs-tested;
- any remaining vendor limitations, especially unsupported direct Responses APIs.
