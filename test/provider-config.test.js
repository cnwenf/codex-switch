import assert from 'node:assert/strict';
import test from 'node:test';
import TOML from '@iarna/toml';
import {
  buildProvidersRegion,
  normalizeProvider,
  replaceProvidersRegion,
} from '../src/provider-config.js';
import {
  cacheDiscoveredModels,
  capsCache,
  resolveCaps,
} from '../src/caps.js';

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
  assert.deepEqual(provider.models, ['model-a', 'model-b']);
});

test('legacy parameterized preset URLs keep their inferred connection options', () => {
  const bailian = normalizeProvider({
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

  const bedrock = normalizeProvider({
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
    const provider = normalizeProvider({
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
  cacheDiscoveredModels('provider-a', [{
    id: 'discovered-model',
    contextWindow: 196000,
    input: { image: true },
    reasoning: false,
    source: 'api',
  }]);

  assert.deepEqual(resolveCaps({}, { id: 'provider-a' }, 'discovered-model'), {
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
  }, { id: 'provider-a' }, 'discovered-model'), {
    contextWindow: 32000,
    vision: false,
    levels: ['high'],
    defaultLevel: 'high',
    source: 'config override',
  });
});

test('unknown discovery vision falls back to static metadata while explicit false overrides it', (t) => {
  t.after(() => capsCache.clear());
  const provider = { id: 'provider-vision' };
  cacheDiscoveredModels(provider.id, [{
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

  cacheDiscoveredModels(provider.id, [{
    id: 'qwen3.8-max',
    contextWindow: null,
    input: { image: false },
    reasoning: 'unknown',
    source: 'api',
  }]);
  assert.equal(resolveCaps({}, provider, 'qwen3.8-max').vision, false);
});
