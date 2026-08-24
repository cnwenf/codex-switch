import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getProviderPreset,
  inferProviderType,
  isRoutableCompatibility,
  listProviderPresets,
  resolveProviderConnection,
} from '../src/provider-registry.js';

test('Custom is last and unsupported vendors remain searchable', () => {
  const presets = listProviderPresets();
  assert.equal(presets.at(-1).id, 'custom');
  assert.equal(presets.find((item) => item.id === 'kimi').compatibility, 'unsupported');
  assert.equal(presets.find((item) => item.id === 'deepseek').routable, false);
  assert.equal(presets.find((item) => item.id === 'deepseek').name, 'DeepSeek（深度求索）');
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
  assert.equal(
    resolveProviderConnection('tencent-tokenhub', { site: 'cn' }, '').baseUrl,
    'https://tokenhub.tencentmaas.com/v1',
  );
  assert.equal(
    resolveProviderConnection('tencent-tokenhub', { site: 'intl' }, '').baseUrl,
    'https://tokenhub-intl.tencentcloudmaas.com/v1',
  );
});

test('known hosts infer provider types without changing old config', () => {
  assert.equal(inferProviderType('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(inferProviderType('https://api.deepseek.com'), 'deepseek');
  assert.equal(inferProviderType('https://gateway.example.test/v1'), 'custom');
});

test('public preset projection contains no executable functions', () => {
  assert.doesNotThrow(() => JSON.stringify(getProviderPreset('openrouter').public));
  assert.equal(Object.values(getProviderPreset('openrouter').public).some((value) => typeof value === 'function'), false);
});

test('only supported, beta, and limited presets are routable', () => {
  assert.equal(isRoutableCompatibility('supported'), true);
  assert.equal(isRoutableCompatibility('beta'), true);
  assert.equal(isRoutableCompatibility('limited'), true);
  assert.equal(isRoutableCompatibility('unsupported'), false);
  assert.equal(isRoutableCompatibility('unverified'), false);
  assert.equal(getProviderPreset('volcengine-ark').compatibility, 'supported');
  assert.equal(getProviderPreset('nvidia-nim').compatibility, 'limited');
  assert.equal(getProviderPreset('custom').compatibility, 'limited');
});

test('derived connection fields reject invalid identifiers and normalize Azure URLs', () => {
  assert.throws(() => resolveProviderConnection('aws-bedrock', { region: 'not a region' }, ''), /region/i);
  assert.throws(() => resolveProviderConnection('cloudflare-workers-ai', { account_id: '../account' }, ''), /account/i);
  assert.throws(() => resolveProviderConnection('bailian', { region: 'cn-beijing', workspace_id: '../workspace' }, ''), /workspace/i);
  assert.throws(() => resolveProviderConnection('azure-openai', { resource_endpoint: 'ftp://example.test' }, ''), /HTTPS/i);
  assert.equal(
    resolveProviderConnection('azure-openai', { resource_endpoint: 'https://example.openai.azure.com/' }, '').baseUrl,
    'https://example.openai.azure.com/openai/v1',
  );
  assert.equal(
    resolveProviderConnection('azure-openai', { resource_endpoint: 'https://example.openai.azure.com/openai/v1' }, '').baseUrl,
    'https://example.openai.azure.com/openai/v1',
  );
  assert.equal(
    resolveProviderConnection('azure-openai', { resource_endpoint: 'https://example.services.ai.azure.com' }, '').baseUrl,
    'https://example.services.ai.azure.com/openai/v1',
  );
  assert.throws(() => resolveProviderConnection('azure-openai', { resource_endpoint: 'https://example.test' }, ''), /Azure resource host/i);
  assert.throws(() => resolveProviderConnection('azure-openai', { resource_endpoint: 'https://example.openai.azure.com/other-path' }, ''), /origin|openai\/v1/i);
});

test('Custom and NIM only accept HTTPS or loopback HTTP URLs', () => {
  assert.throws(() => resolveProviderConnection('custom', {}, 'http://example.test/v1'), /HTTPS|loopback/i);
  assert.equal(resolveProviderConnection('custom', {}, 'http://127.0.0.1:9000/v1').baseUrl, 'http://127.0.0.1:9000/v1');
  assert.equal(resolveProviderConnection('nvidia-nim', { base_url: 'http://localhost:8000/v1' }, '').baseUrl, 'http://localhost:8000/v1');
  assert.equal(resolveProviderConnection('custom', {}, 'http://[::1]:9000/v1').baseUrl, 'http://[::1]:9000/v1');
  assert.equal(resolveProviderConnection('nvidia-nim', { base_url: 'http://[::1]:8000/v1' }, '').baseUrl, 'http://[::1]:8000/v1');
});

test('Bailian uses current regions and workspace hostnames', () => {
  assert.deepEqual(
    getProviderPreset('bailian').options.find((option) => option.name === 'region').choices,
    ['cn-beijing', 'ap-southeast-1', 'us-east-1'],
  );
  assert.equal(
    resolveProviderConnection('bailian', { region: 'cn-beijing', workspace_id: 'workspace123' }, '').baseUrl,
    'https://workspace123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  );
  assert.equal(
    resolveProviderConnection('bailian', { region: 'us-east-1', workspace_id: 'workspace123' }, '').baseUrl,
    'https://workspace123.us-east-1.maas.aliyuncs.com/compatible-mode/v1',
  );
});

test('Bailian inference accepts only exact workspace and supported-region hosts', () => {
  assert.equal(
    inferProviderType('https://workspace123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'),
    'bailian',
  );
  assert.equal(
    inferProviderType('https://workspace123.eu-west-1.maas.aliyuncs.com/compatible-mode/v1'),
    'custom',
  );
  assert.equal(
    inferProviderType('https://workspace123.ap-southeast-1.maas.aliyuncs.com.evil.test/compatible-mode/v1'),
    'custom',
  );
  assert.equal(
    inferProviderType('https://extra.workspace123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'),
    'custom',
  );
});

test('Bedrock inference accepts only exact regional hosts', () => {
  assert.equal(inferProviderType('https://bedrock-mantle.us-east-1.api.aws/v1'), 'aws-bedrock');
  assert.equal(inferProviderType('https://bedrock-mantle.us-east-1.api.aws.evil.test/v1'), 'custom');
  assert.equal(inferProviderType('https://bedrock-mantle.not-a-region.api.aws/v1'), 'custom');
});

test('select fields reject values outside their published choices', () => {
  assert.throws(() => resolveProviderConnection('tencent-tokenhub', { site: 'us' }, ''), /site/i);
  assert.throws(() => resolveProviderConnection('bailian', { region: 'us-west-1', workspace_id: '' }, ''), /region/i);
});
