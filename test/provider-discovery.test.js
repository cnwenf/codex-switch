import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoverProvider,
  mapDiscoveryError,
  normalizeOpenAIModel,
  validateDiscoveryUrl,
} from '../src/provider-discovery.js';
import { normalizeProvider } from '../src/provider-config.js';

const response = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});

const percentEncode = (value, depth) => {
  let encoded = value;
  for (let index = 0; index < depth; index += 1) encoded = encodeURIComponent(encoded);
  return encoded;
};

function cancellableResponse(status, headers = {}) {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"pending":true}'));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { status, headers }),
    wasCancelled: () => cancelled,
  };
}

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
  assert.deepEqual(result.models[0].output, { text: true, image: false, audio: false, video: false });
  assert.equal(result.models[0].tools, true);
  assert.equal(result.models[0].reasoning, true);
  assert.equal(result.models[0].contextWindow, 131072);
  assert.equal(result.models[0].maxOutputTokens, 8192);
  assert.equal(JSON.stringify(result).includes('secret-test-key'), false);
  assert.equal(calls.every((call) => call.authorization === 'Bearer secret-test-key'), true);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ['/api/v1/key', '/api/v1/models/user']);
});

test('missing fields stay unknown', async () => {
  const result = await discoverProvider({ providerType: 'openai', providerOptions: {}, apiKey: 'secret' }, {
    fetchImpl: async () => response(200, { data: [{ id: 'new-model', object: 'model' }] }),
  });
  assert.equal(result.models[0].input.image, 'unknown');
  assert.equal(result.models[0].reasoning, 'unknown');
  assert.equal(result.models[0].responses, 'unknown');
});

test('a complete modalities array marks omitted modalities false', () => {
  const model = normalizeOpenAIModel({
    id: 'complete-modalities',
    input_modalities: ['TEXT', 'audio'],
    output_modalities: ['text'],
  }, 'api');
  assert.deepEqual(model.input, { text: true, image: false, audio: true, video: false, file: false });
  assert.deepEqual(model.output, { text: true, image: false, audio: false, video: false });
});

test('Bailian official capability codes infer input and output modalities', () => {
  const cases = [
    ['TG', 'input', 'text'],
    ['TG', 'output', 'text'],
    ['VU', 'input', 'image'],
    ['VU', 'output', 'text'],
    ['IG', 'input', 'text'],
    ['IG', 'output', 'image'],
    ['VG', 'input', 'text'],
    ['VG', 'output', 'video'],
    ['ASR', 'input', 'audio'],
    ['ASR', 'output', 'text'],
    ['TTS', 'input', 'text'],
    ['TTS', 'output', 'audio'],
  ];
  for (const [capability, direction, modality] of cases) {
    const model = normalizeOpenAIModel({ id: capability, capabilities: [capability] }, 'api');
    assert.equal(model[direction][modality], true, `${capability} ${direction}.${modality}`);
  }
  const textModel = normalizeOpenAIModel({ id: 'text-only', capabilities: ['TG'] }, 'api');
  assert.equal(textModel.output.video, 'unknown');
});

test('explicit modality arrays override Bailian capability inference', () => {
  const model = normalizeOpenAIModel({
    id: 'explicit-overrides',
    capabilities: ['VG'],
    input_modalities: ['audio'],
    output_modalities: ['text'],
  }, 'api');
  assert.deepEqual(model.input, { text: false, image: false, audio: true, video: false, file: false });
  assert.deepEqual(model.output, { text: true, image: false, audio: false, video: false });
});

test('unsupported vendors never make network calls', async () => {
  let called = false;
  const result = await discoverProvider({ providerType: 'deepseek', providerOptions: {}, apiKey: 'secret' }, {
    fetchImpl: async () => { called = true; throw new Error('must not run'); },
  });
  assert.equal(called, false);
  assert.equal(result.validation.status, 'unsupported');
  assert.deepEqual(result.models, []);
});

test('status codes map without leaking upstream body or key', async () => {
  const result = await discoverProvider({ providerType: 'xai', providerOptions: {}, apiKey: 'secret-401' }, {
    fetchImpl: async () => response(401, { error: { message: 'bad secret-401' } }),
  });
  assert.equal(result.validation.status, 'invalid');
  assert.equal(JSON.stringify(result).includes('secret-401'), false);
  assert.equal(JSON.stringify(result).includes('bad'), false);
});

test('successful model discovery skips model ids and names that echo the API key', async () => {
  const apiKey = 'fixture-success-echo-key';
  const result = await discoverProvider({ providerType: 'openai', providerOptions: {}, apiKey }, {
    fetchImpl: async () => response(200, { data: [
      { id: apiKey, name: 'Unsafe ID' },
      { id: 'unsafe-name-model', name: `Unsafe ${apiKey}` },
      { id: 'clean-model', name: 'Clean Model' },
    ] }),
  });
  assert.deepEqual(result.models.map((model) => model.id), ['clean-model']);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
  assert.equal(result.warnings.every((warning) => !warning.includes(apiKey)), true);
});

test('a quote-containing API key skips the unsafe model before dedupe and preserves the safe id', async () => {
  const apiKey = 'fixture"quoted-key';
  const result = await discoverProvider({ providerType: 'openai', providerOptions: {}, apiKey }, {
    fetchImpl: async () => response(200, { data: [
      { id: `model-${apiKey}`, name: 'Unsafe Model' },
      { id: 'model-[redacted]', name: 'Safe Model' },
    ] }),
  });
  assert.deepEqual(result.models.map(({ id, name }) => ({ id, name })), [
    { id: 'model-[redacted]', name: 'Safe Model' },
  ]);
  assert.equal(result.warnings.includes('Some model entries containing sensitive data were skipped.'), true);
});

test('a backslash and newline API key in any normalized string skips the entire model', async () => {
  const apiKey = 'fixture\\line\nkey';
  const result = await discoverProvider({ providerType: 'openai', providerOptions: {}, apiKey }, {
    fetchImpl: async () => response(200, { data: [
      { id: 'unsafe-name-model', name: `Unsafe ${apiKey}` },
      { id: 'safe-model', name: 'Safe Model' },
    ] }),
  });
  assert.deepEqual(result.models.map(({ id, name }) => ({ id, name })), [
    { id: 'safe-model', name: 'Safe Model' },
  ]);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test('generic Models adapters use their resolved endpoint and normalize API identities', async () => {
  const cases = [
    ['openai', {}, '', 'https://api.openai.com/v1/models'],
    ['groq', {}, '', 'https://api.groq.com/openai/v1/models'],
    ['fireworks', {}, '', 'https://api.fireworks.ai/inference/v1/models'],
    ['aws-bedrock', { region: 'eu-west-1' }, '', 'https://bedrock-mantle.eu-west-1.api.aws/v1/models'],
    ['nvidia-nim', { base_url: 'http://127.0.0.1:8000/v1' }, '', 'http://127.0.0.1:8000/v1/models'],
    ['custom', {}, 'https://gateway.example.test/v1', 'https://gateway.example.test/v1/models'],
  ];

  for (const [providerType, providerOptions, baseUrl, expectedUrl] of cases) {
    let actualUrl;
    const result = await discoverProvider({ providerType, providerOptions, baseUrl, apiKey: 'fixture-key' }, {
      fetchImpl: async (url) => {
        actualUrl = String(url);
        return response(200, { data: [{ id: `${providerType}-model`, context_window: 4096 }] });
      },
    });
    assert.equal(actualUrl, expectedUrl);
    assert.equal(result.validation.status, 'valid');
    assert.equal(result.models[0].id, `${providerType}-model`);
    assert.equal(result.models[0].contextWindow, 4096);
  }
});

test('xAI validates the key and reads rich language models', async () => {
  const paths = [];
  const result = await discoverProvider({ providerType: 'xai', providerOptions: {}, apiKey: 'fixture-key' }, {
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      if (String(url).endsWith('/api-key')) return response(200, { api_key_id: 'redacted-id' });
      return response(200, { models: [{
        id: 'grok-rich', aliases: ['grok-latest'], context_length: 256000,
        input_modalities: ['text', 'image'], output_modalities: ['text'],
      }] });
    },
  });
  assert.deepEqual(paths, ['/v1/api-key', '/v1/language-models']);
  assert.equal(result.validation.status, 'valid');
  assert.equal(result.models[0].contextWindow, 256000);
  assert.equal(result.models[0].input.image, true);
});

test('OpenRouter falls back from unavailable user models and removes non-text output models', async () => {
  const paths = [];
  const result = await discoverProvider({ providerType: 'openrouter', providerOptions: {}, apiKey: 'fixture-key' }, {
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      if (String(url).endsWith('/key')) return response(200, { data: {} });
      if (String(url).endsWith('/models/user')) return response(404, { error: { message: 'missing' } });
      return response(200, { data: [
        { id: 'text-model', architecture: { output_modalities: ['text'] } },
        { id: 'image-model', architecture: { output_modalities: ['image'] } },
      ] });
    },
  });
  assert.deepEqual(paths, ['/api/v1/key', '/api/v1/models/user', '/api/v1/models']);
  assert.deepEqual(result.models.map((model) => model.id), ['text-model']);
});

test('Baidu Qianfan rich metadata maps into the normalized contract', async () => {
  const result = await discoverProvider({ providerType: 'baidu-qianfan', providerOptions: {}, apiKey: 'fixture-key' }, {
    fetchImpl: async () => response(200, { data: [{
      id: 'ernie-rich', name: 'ERNIE Rich', context_window: 128000, max_output_tokens: 8192,
      input_modalities: ['text', 'image'], output_modalities: ['text'],
      support_function_call: true, support_reasoning: false, support_responses: true,
    }] }),
  });
  assert.equal(result.models[0].maxOutputTokens, 8192);
  assert.equal(result.models[0].tools, true);
  assert.equal(result.models[0].reasoning, false);
  assert.equal(result.models[0].responses, true);
});

test('Tencent TokenHub keeps only online Responses-compatible models', async () => {
  const result = await discoverProvider({
    providerType: 'tencent-tokenhub', providerOptions: { site: 'intl' }, apiKey: 'fixture-key',
  }, {
    fetchImpl: async (url) => {
      assert.equal(String(url), 'https://tokenhub-intl.tencentcloudmaas.com/v1/models');
      return response(200, { data: [
        { id: 'native', status: 'online', supported_protocols: ['responses'] },
        { id: 'compatible', status: 'online', capabilities: { responses: true } },
        { id: 'hy3', status: 'online' },
        { id: 'chat-only', status: 'online', supported_protocols: ['chat_completions'] },
        { id: 'offline', status: 'offline', supported_protocols: ['responses'] },
      ] });
    },
  });
  assert.deepEqual(result.models.map((model) => model.id), ['native', 'compatible', 'hy3']);
  assert.equal(result.models.every((model) => model.responses === true), true);
});

test('TokenHub static matrix excludes glm-5-turbo and glm-5 without explicit Responses metadata', async () => {
  const result = await discoverProvider({
    providerType: 'tencent-tokenhub', providerOptions: { site: 'cn' }, apiKey: 'fixture-key',
  }, {
    fetchImpl: async () => response(200, { data: [
      { id: 'hy3', status: 'online' },
      { id: 'glm-5-turbo', status: 'online' },
      { id: 'glm-5', status: 'online' },
    ] }),
  });
  assert.deepEqual(result.models.map((model) => model.id), ['hy3']);
});

test('Bailian follows bounded native pagination', async () => {
  const pages = [];
  const result = await discoverProvider({
    providerType: 'bailian',
    providerOptions: { region: 'cn-beijing', workspace_id: '' },
    apiKey: 'secret',
  }, {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin + parsed.pathname, 'https://dashscope.aliyuncs.com/api/v1/models');
      pages.push(parsed.searchParams.get('page_no'));
      const page = Number(pages.at(-1));
      return response(200, { output: {
        total: 2,
        models: page === 1
          ? [{
            model: 'qwen-a',
            capabilities: ['TG', 'Reasoning'],
            features: ['function-calling'],
            model_info: { context_window: 1000 },
            inference_metadata: { request_modality: ['Text', 'Image'] },
          }]
          : [{ model: 'qwen-b', model_info: { context_window: 2000 }, inference_metadata: { request_modality: ['Text'] } }],
      } });
    },
  });
  assert.deepEqual(pages, ['1', '2']);
  assert.deepEqual(result.models.map((model) => model.id), ['qwen-a', 'qwen-b']);
  assert.deepEqual(result.models[0].input, { text: true, image: true, audio: false, video: false, file: false });
  assert.equal(result.models[0].tools, true);
  assert.equal(result.models[0].reasoning, true);
});

test('Bailian workspace discovery uses the native workspace host and stops after five pages', async () => {
  const pages = [];
  const result = await discoverProvider({
    providerType: 'bailian',
    providerOptions: { region: 'cn-beijing', workspace_id: 'workspace123' },
    apiKey: 'fixture-key',
  }, {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.host, 'workspace123.cn-beijing.maas.aliyuncs.com');
      pages.push(parsed.searchParams.get('page_no'));
      return response(200, { output: { total: 99, models: [{ model: `qwen-${pages.length}` }] } });
    },
  });
  assert.deepEqual(pages, ['1', '2', '3', '4', '5']);
  assert.equal(result.models.length, 5);
  assert.equal(result.warnings.some((warning) => /page|limit/i.test(warning)), true);
});

test('legacy Bailian workspace normalization reaches the native discovery adapter', async () => {
  const provider = normalizeProvider({
    id: 'legacy-workspace',
    name: 'Legacy Workspace',
    auth: 'bearer',
    token_env: 'LEGACY_WORKSPACE_API_KEY',
    base_url: 'https://workspace123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-workspace'],
  });
  const calls = [];
  const result = await discoverProvider({
    providerType: provider.provider_type,
    providerOptions: provider.provider_options,
    baseUrl: provider.base_url,
    apiKey: 'fixture-key',
  }, {
    fetchImpl: async (url) => {
      calls.push(String(url));
      return response(200, {
        data: [{ id: 'wrong-generic-model' }],
        output: { total: 1, models: [{ model: 'qwen-workspace' }] },
      });
    },
  });
  assert.equal(
    new URL(calls[0]).origin + new URL(calls[0]).pathname,
    'https://workspace123.ap-southeast-1.maas.aliyuncs.com/api/v1/models',
  );
  assert.deepEqual(result.models.map((model) => model.id), ['qwen-workspace']);
});

test('model collection is capped at 2,000 entries', async () => {
  const data = Array.from({ length: 2001 }, (_, index) => ({ id: `model-${index}` }));
  const result = await discoverProvider({ providerType: 'openai', providerOptions: {}, apiKey: 'fixture-key' }, {
    fetchImpl: async () => response(200, { data }),
  });
  assert.equal(result.models.length, 2000);
  assert.equal(result.warnings.some((warning) => /2,?000|limit/i.test(warning)), true);
});

test('static and manual adapters do not probe billable or non-inventory APIs', async () => {
  for (const [providerType, providerOptions, expectedStatus, expectedSource] of [
    ['volcengine-ark', {}, 'unverified', 'manual'],
    ['azure-openai', { resource_endpoint: 'https://fixture.openai.azure.com' }, 'unverified', 'manual'],
    ['cloudflare-workers-ai', { account_id: 'fixture-account' }, 'unverified', 'static'],
  ]) {
    let called = false;
    const result = await discoverProvider({ providerType, providerOptions, apiKey: 'fixture-key' }, {
      fetchImpl: async () => { called = true; throw new Error('must not run'); },
    });
    assert.equal(called, false);
    assert.equal(result.validation.status, expectedStatus);
    assert.equal(result.modelSource, expectedSource);
  }
});

test('Cloudflare static catalog is explicitly Responses-compatible', async () => {
  const result = await discoverProvider({
    providerType: 'cloudflare-workers-ai', providerOptions: { account_id: 'fixture-account' }, apiKey: 'fixture-key',
  });
  assert.deepEqual(result.models.map((model) => model.id), ['@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b']);
  assert.equal(result.models.every((model) => model.responses === true), true);
  assert.equal(result.models.every((model) => model.source === 'static'), true);
});

test('Custom rejects non-loopback HTTP', async () => {
  await assert.rejects(
    discoverProvider({ providerType: 'custom', baseUrl: 'http://example.com/v1', apiKey: 'secret' }),
    /HTTPS|loopback/,
  );
});

test('discovery URL validation rejects credentials and unsafe redirects', () => {
  assert.throws(() => validateDiscoveryUrl('https://user:pass@example.test/models', 'custom'), /credentials/i);
  assert.throws(() => validateDiscoveryUrl('http://10.0.0.1/models', 'custom'), /HTTPS|loopback/i);
  assert.doesNotThrow(() => validateDiscoveryUrl('http://[::1]:8000/v1/models', 'nvidia-nim'));
  assert.throws(() => validateDiscoveryUrl('http://127.0.0.1:8000/models', 'openai'), /HTTPS/i);
});

test('redirects cannot change from a public destination to loopback', async () => {
  const result = await discoverProvider({
    providerType: 'custom', baseUrl: 'https://gateway.example.test/v1', apiKey: 'fixture-key',
  }, {
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8000/v1/models' } }),
  });
  assert.equal(result.validation.status, 'unreachable');
  assert.equal(JSON.stringify(result).includes('127.0.0.1'), false);
});

test('cross-origin redirects cannot forward the bearer key', async () => {
  const calls = [];
  const result = await discoverProvider({
    providerType: 'custom', baseUrl: 'https://gateway.example.test/v1', apiKey: 'fixture-redirect-key',
  }, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), authorization: init.headers.authorization });
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://attacker.example/models' } });
      }
      return response(200, { data: [{ id: 'stolen-key-model' }] });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.validation.status, 'unreachable');
  assert.equal(JSON.stringify(result).includes('fixture-redirect-key'), false);
});

test('redirect responses cancel their unread body before discovery follows the next URL', async () => {
  const redirect = cancellableResponse(302, { location: '/v1/models-final' });
  let calls = 0;
  const result = await discoverProvider({
    providerType: 'custom', baseUrl: 'https://gateway.example.test/v1', apiKey: 'fixture-cancel-redirect-key',
  }, {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? redirect.response : response(200, { data: [{ id: 'fixture-model' }] });
    },
  });
  assert.equal(result.validation.status, 'valid');
  assert.equal(redirect.wasCancelled(), true);
});

test('HTTP error responses cancel their unread body before returning a sanitized status', async () => {
  const unauthorized = cancellableResponse(401, { 'content-type': 'application/json' });
  const result = await discoverProvider({
    providerType: 'openai', providerOptions: {}, apiKey: 'fixture-cancel-http-key',
  }, {
    fetchImpl: async () => unauthorized.response,
  });
  assert.equal(result.validation.status, 'invalid');
  assert.equal(unauthorized.wasCancelled(), true);
});

test('declared oversized responses cancel their unread body before failing closed', async () => {
  const oversized = cancellableResponse(200, {
    'content-type': 'application/json',
    'content-length': String(4 * 1024 * 1024 + 1),
  });
  const result = await discoverProvider({
    providerType: 'openai', providerOptions: {}, apiKey: 'fixture-cancel-length-key',
  }, {
    fetchImpl: async () => oversized.response,
  });
  assert.equal(result.validation.status, 'unreachable');
  assert.equal(oversized.wasCancelled(), true);
});

test('an API key embedded in the initial URL path is rejected before fetch', async () => {
  const apiKey = 'fixture-initial-url-key';
  let called = false;
  const result = await discoverProvider({
    providerType: 'custom', baseUrl: `https://gateway.example.test/${apiKey}/v1`, apiKey,
  }, {
    fetchImpl: async () => {
      called = true;
      return response(200, { data: [{ id: 'model' }] });
    },
  });
  assert.equal(called, false);
  assert.equal(result.validation.status, 'unreachable');
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test('a percent-encoded API key in the initial URL path is rejected before fetch', async () => {
  const apiKey = 'fixture/initial"key';
  let called = false;
  const result = await discoverProvider({
    providerType: 'custom',
    baseUrl: `https://gateway.example.test/${encodeURIComponent(apiKey)}/v1`,
    apiKey,
  }, {
    fetchImpl: async () => {
      called = true;
      return response(200, { data: [{ id: 'model' }] });
    },
  });
  assert.equal(called, false);
  assert.equal(result.validation.status, 'unreachable');
});

test('an API key embedded in a same-origin redirect path is rejected before the next fetch', async () => {
  const apiKey = 'fixture-redirect-url-key';
  const calls = [];
  const result = await discoverProvider({
    providerType: 'custom', baseUrl: 'https://gateway.example.test/v1', apiKey,
  }, {
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(null, {
        status: 302,
        headers: { location: `https://gateway.example.test/${apiKey}/models` },
      });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.validation.status, 'unreachable');
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test('a percent-encoded API key in a same-origin redirect path is rejected before the next fetch', async () => {
  const apiKey = 'fixture\\redirect\nkey';
  const calls = [];
  const result = await discoverProvider({
    providerType: 'custom', baseUrl: 'https://gateway.example.test/v1', apiKey,
  }, {
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(null, {
        status: 302,
        headers: { location: `https://gateway.example.test/${encodeURIComponent(apiKey)}/models` },
      });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.validation.status, 'unreachable');
});

test('double, triple, and over-bound encoded redirect components are rejected', async () => {
  const apiKey = 'fixture/redirect"layer-key';
  for (const depth of [2, 3, 5]) {
    const encoded = percentEncode(apiKey, depth);
    for (const target of [
      `https://gateway.example.test/${encoded}/models`,
      `https://gateway.example.test/models?${encoded}=page`,
      `https://gateway.example.test/models?cursor=${encoded}`,
      `https://gateway.example.test/models#${encoded}`,
    ]) {
      let calls = 0;
      const result = await discoverProvider({
        providerType: 'custom', baseUrl: 'https://gateway.example.test/v1', apiKey,
      }, {
        fetchImpl: async () => {
          calls += 1;
          return new Response(null, { status: 302, headers: { location: target } });
        },
      });
      assert.equal(calls, 1, `depth ${depth}: ${target}`);
      assert.equal(result.validation.status, 'unreachable');
    }
  }
});

test('cross-origin pagination links cannot forward the bearer key', async () => {
  const calls = [];
  const result = await discoverProvider({
    providerType: 'custom', baseUrl: 'https://gateway.example.test/v1', apiKey: 'fixture-pagination-key',
  }, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), authorization: init.headers.authorization });
      return response(200, {
        data: [{ id: 'first-page-model' }],
        next: 'https://attacker.example/models?page=2',
      });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.validation.status, 'unreachable');
  assert.equal(JSON.stringify(result).includes('fixture-pagination-key'), false);
});

test('an API key embedded in a same-origin pagination path is rejected before the next fetch', async () => {
  const apiKey = 'fixture-pagination-url-key';
  const calls = [];
  const result = await discoverProvider({
    providerType: 'custom', baseUrl: 'https://gateway.example.test/v1', apiKey,
  }, {
    fetchImpl: async (url) => {
      calls.push(String(url));
      return response(200, {
        data: [{ id: 'first-page-model' }],
        next: `https://gateway.example.test/${apiKey}/models?page=2`,
      });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.validation.status, 'unreachable');
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test('a percent-encoded API key in a pagination query is rejected before the next fetch', async () => {
  const apiKey = 'fixture/pagination"key';
  const calls = [];
  const result = await discoverProvider({
    providerType: 'custom', baseUrl: 'https://gateway.example.test/v1', apiKey,
  }, {
    fetchImpl: async (url) => {
      calls.push(String(url));
      return response(200, {
        data: [{ id: 'first-page-model' }],
        next: `https://gateway.example.test/v1/models?cursor=${encodeURIComponent(apiKey)}`,
      });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.validation.status, 'unreachable');
});

test('double, triple, and over-bound encoded pagination components are rejected', async () => {
  const apiKey = 'fixture/pagination"layer-key';
  for (const depth of [2, 3, 5]) {
    const encoded = percentEncode(apiKey, depth);
    for (const next of [
      `https://gateway.example.test/${encoded}/models`,
      `https://gateway.example.test/models?${encoded}=page`,
      `https://gateway.example.test/models?cursor=${encoded}`,
      `https://gateway.example.test/models#${encoded}`,
    ]) {
      let calls = 0;
      const result = await discoverProvider({
        providerType: 'custom', baseUrl: 'https://gateway.example.test/v1', apiKey,
      }, {
        fetchImpl: async () => {
          calls += 1;
          return response(200, { data: [{ id: 'first-page-model' }], next });
        },
      });
      assert.equal(calls, 1, `depth ${depth}: ${next}`);
      assert.equal(result.validation.status, 'unreachable');
    }
  }
});

test('malformed percent encoding in redirect and pagination path or query fails closed', async () => {
  for (const flow of ['redirect', 'pagination']) {
    for (const target of [
      'https://gateway.example.test/%ZZ/models',
      'https://gateway.example.test/models?cursor=%ZZ',
    ]) {
      let calls = 0;
      const result = await discoverProvider({
        providerType: 'custom', baseUrl: 'https://gateway.example.test/v1', apiKey: 'fixture-key',
      }, {
        fetchImpl: async () => {
          calls += 1;
          if (flow === 'redirect') {
            return new Response(null, { status: 302, headers: { location: target } });
          }
          return response(200, { data: [{ id: 'first-page-model' }], next: target });
        },
      });
      assert.equal(calls, 1, `${flow}: ${target}`);
      assert.equal(result.validation.status, 'unreachable');
    }
  }
});

test('benign encoded pagination components continue to the next page', async () => {
  const calls = [];
  const result = await discoverProvider({
    providerType: 'custom', baseUrl: 'https://gateway.example.test/v1', apiKey: 'fixture-key',
  }, {
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return response(200, {
          data: [{ id: 'first-page-model' }],
          next: 'https://gateway.example.test/v1/mo%64els?cursor=page%202&kind=model%2Ftext#page%202',
        });
      }
      return response(200, { data: [{ id: 'second-page-model' }] });
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.models.map((model) => model.id), ['first-page-model', 'second-page-model']);
  assert.equal(result.validation.status, 'valid');
});

test('encoded percent literals in pagination query and fragment remain usable', async (t) => {
  for (const [name, next] of [
    ['single-encoded query percent', 'https://gateway.example.test/v1/models?cursor=100%25done'],
    ['nested query percent', 'https://gateway.example.test/v1/models?cursor=percent%2525encoded'],
    ['single-encoded fragment percent', 'https://gateway.example.test/v1/models#one%25two'],
  ]) {
    await t.test(name, async () => {
      const calls = [];
      const result = await discoverProvider({
        providerType: 'custom', baseUrl: 'https://gateway.example.test/v1', apiKey: 'fixture-key',
      }, {
        fetchImpl: async (url) => {
          calls.push(String(url));
          if (calls.length === 1) {
            return response(200, { data: [{ id: 'first-page-model' }], next });
          }
          return response(200, { data: [{ id: 'second-page-model' }] });
        },
      });
      assert.equal(calls.length, 2);
      assert.deepEqual(result.models.map((model) => model.id), ['first-page-model', 'second-page-model']);
      assert.equal(result.validation.status, 'valid');
    });
  }
});

test('nested encoding is rejected for initial and last-id-derived URLs by the shared predicate', async () => {
  const apiKey = 'fixture/shared/url-key';
  let initialCalls = 0;
  const initialResult = await discoverProvider({
    providerType: 'custom',
    baseUrl: `https://gateway.example.test/${percentEncode(apiKey, 2)}/v1`,
    apiKey,
  }, {
    fetchImpl: async () => {
      initialCalls += 1;
      return response(200, { data: [{ id: 'model' }] });
    },
  });
  assert.equal(initialCalls, 0);
  assert.equal(initialResult.validation.status, 'unreachable');

  let paginationCalls = 0;
  const paginationResult = await discoverProvider({
    providerType: 'custom', baseUrl: 'https://gateway.example.test/v1', apiKey,
  }, {
    fetchImpl: async () => {
      paginationCalls += 1;
      return response(200, {
        data: [{ id: 'first-page-model' }],
        has_more: true,
        last_id: percentEncode(apiKey, 2),
      });
    },
  });
  assert.equal(paginationCalls, 1);
  assert.equal(paginationResult.validation.status, 'unreachable');
});

test('malformed percent encoding in last_id fails closed before the next fetch', async () => {
  let calls = 0;
  const result = await discoverProvider({
    providerType: 'custom', baseUrl: 'https://gateway.example.test/v1', apiKey: 'fixture-key',
  }, {
    fetchImpl: async () => {
      calls += 1;
      return response(200, {
        data: [{ id: 'first-page-model' }],
        has_more: true,
        last_id: 'cursor%ZZ',
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.validation.status, 'unreachable');
});

test('malformed percent encoding is rejected before fetch instead of bypassing URL inspection', async () => {
  let called = false;
  const result = await discoverProvider({
    providerType: 'custom', baseUrl: 'https://gateway.example.test/%ZZ/v1', apiKey: 'fixture-key',
  }, {
    fetchImpl: async () => {
      called = true;
      return response(200, { data: [{ id: 'model' }] });
    },
  });
  assert.equal(called, false);
  assert.equal(result.validation.status, 'unreachable');
});

test('oversized responses fail safely without returning body or secret material', async () => {
  const secret = 'fixture-secret-oversize';
  const body = JSON.stringify({ data: [{ id: secret, padding: 'x'.repeat(4 * 1024 * 1024) }] });
  const result = await discoverProvider({ providerType: 'openai', providerOptions: {}, apiKey: secret }, {
    fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  assert.equal(result.validation.status, 'unreachable');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('response streaming is cancelled as soon as the 4 MiB limit is crossed', async () => {
  let cancelled = false;
  let failureTimer;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(3 * 1024 * 1024));
      controller.enqueue(new Uint8Array(2 * 1024 * 1024));
      failureTimer = setTimeout(() => controller.error(new Error('reader consumed beyond the safety limit')), 20);
    },
    cancel() {
      cancelled = true;
      clearTimeout(failureTimer);
    },
  });
  const result = await discoverProvider({ providerType: 'openai', providerOptions: {}, apiKey: 'fixture-key' }, {
    fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  assert.equal(result.validation.status, 'unreachable');
  assert.equal(cancelled, true);
});

test('an untrusted non-resolving stream cancel cannot block discovery settlement', async () => {
  let cancelCalled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(5 * 1024 * 1024));
    },
    cancel() {
      cancelCalled = true;
      return new Promise(() => {});
    },
  });
  const settled = await Promise.race([
    discoverProvider({ providerType: 'openai', providerOptions: {}, apiKey: 'fixture-key' }, {
      fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    }),
    new Promise((resolve) => setTimeout(() => resolve('cancel-blocked'), 100)),
  ]);
  assert.notEqual(settled, 'cancel-blocked');
  assert.equal(settled.validation.status, 'unreachable');
  assert.equal(cancelCalled, true);
});

test('thrown errors and URLs are reduced to stable sanitized messages', async () => {
  const secret = 'fixture-secret-thrown';
  const result = await discoverProvider({ providerType: 'openai', providerOptions: {}, apiKey: secret }, {
    fetchImpl: async () => { throw new Error(`fetch https://example.test/?token=${secret} failed`); },
  });
  assert.equal(result.validation.status, 'unreachable');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes('example.test'), false);
});

test('discovery error mapping is stable for response and thrown error classes', () => {
  assert.deepEqual(mapDiscoveryError(new Response(null, { status: 401 })), {
    status: 'invalid', message: 'API key was rejected by the provider.',
  });
  assert.equal(mapDiscoveryError(new Response(null, { status: 402 })).status, 'forbidden');
  assert.equal(mapDiscoveryError(new Response(null, { status: 403 })).status, 'forbidden');
  assert.equal(mapDiscoveryError(new Response(null, { status: 429 })).status, 'rate_limited');
  assert.equal(mapDiscoveryError(new Response(null, { status: 503 })).status, 'unreachable');
  assert.equal(mapDiscoveryError(new Error('secret details')).status, 'unreachable');
  assert.equal(JSON.stringify(mapDiscoveryError(new Error('secret details'))).includes('secret details'), false);
});
