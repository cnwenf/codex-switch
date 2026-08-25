import assert from 'node:assert/strict';
import test from 'node:test';
import TOML from '@iarna/toml';
import * as providerConfig from '../src/provider-config.js';
import {
  cacheDiscoveredModels,
  capsCache,
  resolveCaps,
} from '../src/caps.js';

const {
  buildProvidersRegion,
  normalizeProvider,
  providerConnectionIdentity,
  replaceProvidersRegion,
} = providerConfig;
const normalizeProviderForLoad = providerConfig.normalizeProviderForLoad || normalizeProvider;

function customProvider(id, baseUrl = `https://${id}.example/v1`) {
  return normalizeProvider({
    id,
    provider_type: 'custom',
    provider_options: { base_url: baseUrl },
    base_url: baseUrl,
    auth: 'bearer',
    token_env: `${id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_KEY`,
    models: [],
  });
}

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

test('token_env is canonical at the normalization boundary', () => {
  const base = {
    id: 'canonical-token-env',
    provider_type: 'custom',
    provider_options: { base_url: 'https://example.invalid/v1' },
    base_url: 'https://example.invalid/v1',
    auth: 'bearer',
    models: ['fixture-model'],
  };

  assert.equal(normalizeProvider({ ...base, token_env: 'REVIEW_KEY' }).token_env, 'REVIEW_KEY');
  for (const tokenEnv of [' REVIEW_KEY ', 'REVIEW-KEY', '9REVIEW_KEY', 'REVIEW.KEY', 'REVIEW KEY']) {
    assert.throws(
      () => normalizeProvider({ ...base, token_env: tokenEnv }),
      /token_env|环境变量名/,
    );
  }
});

test('connection identity covers authoritative options without credential material', () => {
  const beijing = normalizeProviderForLoad({
    id: 'bailian-a',
    provider_type: 'bailian',
    provider_options: { region: 'cn-beijing', workspace_id: '' },
    auth: 'bearer',
    token_env: 'SECRET_ENV_NAME',
    token: 'fixture-inline-secret',
    models: ['qwen-plus'],
  });
  const singapore = normalizeProviderForLoad({
    ...beijing,
    provider_options: { region: 'ap-southeast-1', workspace_id: '' },
  });
  const identity = providerConnectionIdentity(beijing);

  assert.notEqual(identity, providerConnectionIdentity(singapore));
  assert.equal(identity.includes('SECRET_ENV_NAME'), false);
  assert.equal(identity.includes('fixture-inline-secret'), false);
  assert.equal(identity.includes('qwen-plus'), false);
});

test('new provider auth and origin are bound to the selected registry preset', () => {
  const accepted = [
    {
      label: 'fixed bearer preset ignores a submitted URL',
      input: {
        id: 'xai-bound', provider_type: 'xai', provider_options: {},
        base_url: 'https://attacker.example/v1', auth: 'bearer', token_env: 'XAI_BOUND_KEY', models: ['grok'],
      },
      auth: 'bearer',
      baseUrl: 'https://api.x.ai/v1',
    },
    {
      label: 'subscription preset ignores a submitted URL',
      input: {
        id: 'chatgpt-bound', provider_type: 'chatgpt-sub', provider_options: {},
        base_url: 'https://attacker.example/v1', auth: 'chatgpt_subscription', models: ['gpt-fixture'],
      },
      auth: 'chatgpt_subscription',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
    },
  ];
  for (const entry of accepted) {
    const normalized = normalizeProvider(entry.input);
    assert.equal(normalized.auth, entry.auth, entry.label);
    assert.equal(normalized.base_url, entry.baseUrl, entry.label);
  }

  const rejected = [
    ['Custom subscription', 'custom', 'chatgpt_subscription', 'https://gateway.example/v1'],
    ['Custom OAuth', 'custom', 'chatgpt_oauth', 'https://gateway.example/v1'],
    ['Custom passthrough', 'custom', 'passthrough', 'https://gateway.example/v1'],
    ['NIM OAuth', 'nvidia-nim', 'chatgpt_oauth', 'http://127.0.0.1:8000/v1'],
    ['preset passthrough', 'xai', 'passthrough', 'https://api.x.ai/v1'],
  ];
  for (const [label, providerType, auth, baseUrl] of rejected) {
    assert.throws(() => normalizeProvider({
      id: `rejected-${providerType}-${auth}`,
      provider_type: providerType,
      provider_options: { base_url: baseUrl },
      base_url: baseUrl,
      auth,
      token_env: 'REJECTED_AUTH_KEY',
      models: ['fixture-model'],
    }), /auth|认证/i, label);
  }
});

test('legacy load keeps bearer endpoints but limits OAuth and passthrough to trusted destinations', () => {
  const legacyBearerCases = [
    ['kimi', 'https://api.moonshot.cn/v1'],
    ['glm', 'https://open.bigmodel.cn/api/paas/v4'],
    ['deepseek', 'https://api.deepseek.com/v1'],
  ];
  for (const [id, baseUrl] of legacyBearerCases) {
    const provider = normalizeProviderForLoad({
      id, base_url: baseUrl, auth: 'bearer', token_env: `${id.toUpperCase()}_KEY`, models: [`${id}-model`],
    });
    assert.equal(provider.provider_type, 'custom', id);
    assert.equal(provider.base_url, baseUrl, id);
    assert.equal(provider.auth, 'bearer', id);
  }

  for (const auth of ['chatgpt_subscription', 'chatgpt_oauth']) {
    const provider = normalizeProviderForLoad({
      id: `legacy-${auth}`,
      base_url: 'https://chatgpt.com/backend-api/codex',
      auth,
      models: ['gpt-fixture'],
    });
    assert.equal(provider.provider_type, 'chatgpt-sub');
    assert.equal(provider.auth, auth);
    assert.throws(() => normalizeProviderForLoad({
      id: `unsafe-${auth}`,
      base_url: 'https://attacker.example/v1',
      auth,
      models: ['fixture-model'],
    }), /ChatGPT|auth|认证|origin/i);
  }

  for (const baseUrl of ['http://127.0.0.1:9000/v1', 'https://api.x.ai/v1']) {
    const provider = normalizeProviderForLoad({
      id: 'safe-legacy-passthrough', base_url: baseUrl, auth: 'passthrough', models: ['fixture-model'],
    });
    assert.equal(provider.base_url, baseUrl);
    assert.equal(provider.auth, 'passthrough');
  }
  assert.throws(() => normalizeProviderForLoad({
    id: 'unsafe-legacy-passthrough',
    base_url: 'https://attacker.example/v1',
    auth: 'passthrough',
    models: ['fixture-model'],
  }), /passthrough|trusted|可信/i);
});

test('new Custom mutations reject unsupported official endpoints and client inline tokens', () => {
  const disguised = {
    id: 'disguised-deepseek',
    provider_type: 'custom',
    provider_options: { base_url: 'https://api.deepseek.com/v1' },
    base_url: 'https://api.deepseek.com/v1',
    auth: 'bearer',
    token_env: 'DISGUISED_KEY',
    models: ['deepseek-chat'],
  };
  assert.throws(() => normalizeProvider(disguised), /unsupported|不支持|official/i);
  assert.throws(() => normalizeProvider({
    ...disguised,
    provider_options: { base_url: 'https://gateway.example/v1' },
    base_url: 'https://gateway.example/v1',
    token: 'fixture-client-inline-token',
  }), /inline|token|凭证/i);

  const legacy = normalizeProviderForLoad({
    id: 'legacy-inline',
    base_url: 'https://gateway.example/v1',
    auth: 'bearer',
    token: 'fixture-server-only-inline-token',
    models: ['fixture-model'],
  });
  assert.equal(Boolean(legacy.token), true);
  const serialized = buildProvidersRegion([legacy]);
  assert.equal(serialized.includes('fixture-server-only-inline-token'), false);
  assert.equal(/\btoken\s*=/.test(serialized), false);
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
  const provider = normalizeProviderForLoad({
    id: 'legacy',
    name: 'Legacy',
    auth: 'bearer',
    token_env: 'LEGACY_API_KEY',
    base_url: 'https://legacy.example/v1',
    models: 'model-a,model-b',
  });
  assert.equal(provider.provider_type, 'custom');
  assert.equal(provider.base_url, 'https://legacy.example/v1');
  assert.deepEqual(provider.models, ['model-a', 'model-b']);
});

test('legacy parameterized preset URLs keep their inferred connection options', () => {
  const bailian = normalizeProviderForLoad({
    id: 'legacy-bailian',
    name: 'Legacy Bailian',
    auth: 'bearer',
    token_env: 'LEGACY_BAILIAN_API_KEY',
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus'],
  });
  assert.equal(bailian.provider_type, 'bailian');
  assert.deepEqual(bailian.provider_options, { region: 'ap-southeast-1', workspace_id: '' });
  assert.equal(bailian.base_url, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');

  const bedrock = normalizeProviderForLoad({
    id: 'legacy-bedrock',
    name: 'Legacy Bedrock',
    auth: 'bearer',
    token_env: 'LEGACY_BEDROCK_API_KEY',
    base_url: 'https://bedrock-mantle.eu-west-1.api.aws/v1',
    models: ['bedrock-model'],
  });
  assert.equal(bedrock.provider_type, 'aws-bedrock');
  assert.deepEqual(bedrock.provider_options, { region: 'eu-west-1' });
  assert.equal(bedrock.base_url, 'https://bedrock-mantle.eu-west-1.api.aws/v1');
});

test('legacy Bailian workspace URLs normalize all supported regions', () => {
  for (const region of ['cn-beijing', 'ap-southeast-1', 'us-east-1']) {
    const baseUrl = `https://workspace123.${region}.maas.aliyuncs.com/compatible-mode/v1`;
    const provider = normalizeProviderForLoad({
      id: `legacy-bailian-workspace-${region}`,
      name: 'Legacy Bailian Workspace',
      auth: 'bearer',
      token_env: 'LEGACY_BAILIAN_WORKSPACE_API_KEY',
      base_url: baseUrl,
      models: ['qwen-plus'],
    });
    assert.equal(provider.provider_type, 'bailian', region);
    assert.deepEqual(provider.provider_options, {
      region,
      workspace_id: 'workspace123',
    });
    assert.equal(provider.base_url, baseUrl, region);
  }
});

test('provider options serialize only TOML inline-table scalar values', () => {
  const region = buildProvidersRegion([{
    id: 'custom-scalars',
    name: 'Custom Scalars',
    provider_type: 'custom',
    provider_options: {
      label: 'a "quoted" value',
      enabled: true,
      weight: 1.5,
    },
    base_url: 'https://gateway.example/v1',
    auth: 'bearer',
    token_env: 'CUSTOM_SCALARS_API_KEY',
    models: ['model-a'],
    enabled: true,
  }]);
  assert.deepEqual(TOML.parse(region).providers[0].provider_options, {
    label: 'a "quoted" value',
    enabled: true,
    weight: 1.5,
  });
  assert.throws(() => buildProvidersRegion([{
    id: 'unsafe-options',
    provider_options: { nested: { value: 'not allowed' } },
  }]), /provider_options/);
});

test('provider region replacement preserves non-provider sections', () => {
  const original = [
    '[proxy]',
    'listen = "127.0.0.1:8787"',
    '',
    '# Old provider',
    '[[providers]]',
    'id = "old"',
    'name = "Old"',
    'base_url = "https://old.example/v1"',
    'auth = "bearer"',
    'token_env = "OLD_API_KEY"',
    'models = ["old-model"]',
    'enabled = true',
    '',
    '# Keep this documentation.',
    '[model_overrides.new-model]',
    'context_window = 64000',
    '',
  ].join('\n');
  const replacement = normalizeProvider({
    id: 'new',
    name: 'New',
    base_url: 'https://new.example/v1',
    auth: 'bearer',
    token_env: 'NEW_API_KEY',
    models: ['new-model'],
  });
  const updated = replaceProvidersRegion(original, [replacement]);
  const parsed = TOML.parse(updated);
  assert.deepEqual(parsed.providers.map((provider) => provider.id), ['new']);
  assert.equal(parsed.proxy.listen, '127.0.0.1:8787');
  assert.equal(parsed.model_overrides['new-model'].context_window, 64000);
  assert.match(updated, /# Keep this documentation\./);
});

test('normalized discovery cache supplies capabilities below config overrides', (t) => {
  t.after(() => capsCache.clear());
  const provider = customProvider('provider-a');
  cacheDiscoveredModels(provider, [{
    id: 'discovered-model',
    contextWindow: 196000,
    input: { image: true },
    reasoning: false,
    source: 'api',
  }]);

  assert.deepEqual(resolveCaps({}, provider, 'discovered-model'), {
    contextWindow: 196000,
    vision: true,
    levels: [],
    defaultLevel: null,
    source: 'provider discovery (api)',
  });
  assert.deepEqual(resolveCaps({
    model_overrides: {
      'discovered-model': {
        context_window: 32000,
        vision: false,
        reasoning_efforts: ['high'],
        default_reasoning_effort: 'high',
      },
    },
  }, provider, 'discovered-model'), {
    contextWindow: 32000,
    vision: false,
    levels: ['high'],
    defaultLevel: 'high',
    source: 'config override',
  });
});

test('unknown discovery vision falls back to static metadata while explicit false overrides it', (t) => {
  t.after(() => capsCache.clear());
  const provider = customProvider('provider-vision');
  cacheDiscoveredModels(provider, [{
    id: 'qwen3.8-max',
    contextWindow: null,
    input: { image: 'unknown' },
    reasoning: 'unknown',
    source: 'api',
  }, {
    id: 'unknown-static-model',
    contextWindow: null,
    input: { image: 'unknown' },
    reasoning: 'unknown',
    source: 'api',
  }]);
  assert.equal(capsCache.get(provider.id).models.get('qwen3.8-max').vision, 'unknown');
  assert.equal(resolveCaps({}, provider, 'qwen3.8-max').vision, true);
  assert.equal(resolveCaps({}, provider, 'unknown-static-model').vision, false);

  cacheDiscoveredModels(provider, [{
    id: 'qwen3.8-max',
    contextWindow: null,
    input: { image: false },
    reasoning: 'unknown',
    source: 'api',
  }]);
  assert.equal(resolveCaps({}, provider, 'qwen3.8-max').vision, false);
});

test('discovery capabilities are bound to the complete normalized provider connection', (t) => {
  t.after(() => capsCache.clear());
  const providerA = normalizeProvider({
    id: 'reused-provider',
    provider_type: 'custom',
    provider_options: { base_url: 'https://gateway-a.example/v1' },
    base_url: 'https://gateway-a.example/v1',
    auth: 'bearer',
    token_env: 'REUSED_PROVIDER_KEY',
    models: ['same-model'],
  });
  const providerB = normalizeProvider({
    ...providerA,
    provider_options: { base_url: 'https://gateway-b.example/v1' },
    base_url: 'https://gateway-b.example/v1',
  });
  cacheDiscoveredModels(providerA, [{
    id: 'same-model',
    contextWindow: 424242,
    input: { image: true },
    reasoning: false,
    source: 'api',
  }]);

  assert.equal(resolveCaps({}, providerA, 'same-model').contextWindow, 424242);
  assert.deepEqual(resolveCaps({}, providerB, 'same-model'), {
    contextWindow: 128000,
    vision: false,
    levels: [],
    defaultLevel: null,
    source: 'default (unknown model)',
  });
});

test('expired discovery capabilities fail closed during catalog resolution', (t) => {
  t.after(() => capsCache.clear());
  const provider = normalizeProvider({
    id: 'expired-provider',
    provider_type: 'custom',
    provider_options: { base_url: 'https://expired.example/v1' },
    base_url: 'https://expired.example/v1',
    auth: 'bearer',
    token_env: 'EXPIRED_PROVIDER_KEY',
    models: ['expired-model'],
  });
  cacheDiscoveredModels(provider, [{
    id: 'expired-model',
    contextWindow: 515151,
    input: { image: true },
    reasoning: false,
    source: 'api',
  }]);
  capsCache.get(provider.id).at = Date.now() - 30 * 60 * 1000 - 1;

  assert.deepEqual(resolveCaps({}, provider, 'expired-model'), {
    contextWindow: 128000,
    vision: false,
    levels: [],
    defaultLevel: null,
    source: 'default (unknown model)',
  });
});
