import { getProviderPreset, resolveProviderConnection } from './provider-registry.js';

const UNKNOWN = 'unknown';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 5;
const MAX_MODELS = 2_000;
const MAX_REDIRECTS = 3;
const MAX_URL_DECODE_DEPTH = 3;
const VALID_PERCENT_ESCAPE = /%[0-9a-f]{2}/i;
const MALFORMED_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/i;

const INPUT_MODALITIES = Object.freeze(['text', 'image', 'audio', 'video', 'file']);
const OUTPUT_MODALITIES = Object.freeze(['text', 'image', 'audio', 'video']);

const STATIC_CATALOGS = Object.freeze({
  openai: Object.freeze([
    { id: 'gpt-5', responses: true, reasoning: true, tools: true },
    { id: 'gpt-5-mini', responses: true, reasoning: true, tools: true },
    { id: 'gpt-4.1', responses: true, reasoning: false, tools: true },
    { id: 'o3', responses: true, reasoning: true, tools: true },
    { id: 'o4-mini', responses: true, reasoning: true, tools: true },
  ]),
  fireworks: Object.freeze([
    { id: 'accounts/fireworks/models/gpt-oss-120b', responses: true, reasoning: true, tools: true },
  ]),
  'volcengine-ark': Object.freeze([
    { id: 'doubao-seed-1-6', name: 'Doubao Seed 1.6（参考模型，路由时填写 Endpoint ID）', responses: true },
    { id: 'doubao-seed-1-6-thinking', name: 'Doubao Seed 1.6 Thinking（参考模型，路由时填写 Endpoint ID）', responses: true, reasoning: true },
  ]),
  'cloudflare-workers-ai': Object.freeze([
    {
      id: '@cf/openai/gpt-oss-120b', name: 'GPT-OSS 120B', responses: true,
      input_modalities: ['text'], output_modalities: ['text'], reasoning: true, tools: true,
    },
    {
      id: '@cf/openai/gpt-oss-20b', name: 'GPT-OSS 20B', responses: true,
      input_modalities: ['text'], output_modalities: ['text'], reasoning: true, tools: true,
    },
  ]),
});

// Official TokenHub Responses protocol matrix, reviewed 2026-08-24. The Models
// endpoint itself returns only identity and status, so discovery intersects this
// allowlist with the key-accessible online inventory.
const TENCENT_RESPONSES_MODELS = new Set([
  'hy3',
  'hy3-preview',
  'qwen3.5-flash',
  'qwen3.5-plus',
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
  'kimi-k2.6',
  'kimi-k2.5',
  'deepseek-v4-flash-202605',
  'deepseek-v4-pro-202606',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'minimax-m3',
  'minimax-m2.7',
  'mimo-v2.5-pro',
]);

const emptyModalities = () => ({
  input: Object.fromEntries(INPUT_MODALITIES.map((name) => [name, UNKNOWN])),
  output: Object.fromEntries(OUTPUT_MODALITIES.map((name) => [name, UNKNOWN])),
});

const authHeaders = (apiKey) => ({
  accept: 'application/json',
  authorization: `Bearer ${apiKey}`,
  'user-agent': 'codex-switch/provider-discovery',
});

class DiscoveryHttpError extends Error {
  constructor(status) {
    super('Provider request failed');
    this.name = 'DiscoveryHttpError';
    this.status = status;
  }
}

class DiscoverySafetyError extends Error {
  constructor(code) {
    super('Provider discovery request could not be completed');
    this.name = 'DiscoverySafetyError';
    this.code = code;
  }
}

function withTimeout(timeoutMs, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('provider request timeout')), timeoutMs);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function finiteNumber(...values) {
  const value = firstDefined(...values);
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function explicitBoolean(...values) {
  const value = firstDefined(...values);
  return typeof value === 'boolean' ? value : UNKNOWN;
}

function normalizeModalityName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'images') return 'image';
  if (normalized === 'videos') return 'video';
  if (normalized === 'files' || normalized === 'document') return 'file';
  return normalized;
}

function normalizeModalitySet(value, names) {
  if (Array.isArray(value)) {
    const present = new Set(value.map(normalizeModalityName));
    return Object.fromEntries(names.map((name) => [name, present.has(name)]));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(names.map((name) => [
      name,
      typeof value[name] === 'boolean' ? value[name] : UNKNOWN,
    ]));
  }
  return Object.fromEntries(names.map((name) => [name, UNKNOWN]));
}

function inferModalitiesFromCapabilities(value) {
  const inferred = emptyModalities();
  if (!Array.isArray(value)) return inferred;
  const capabilities = new Set(value.map((item) => String(item).trim().toUpperCase()));
  const mark = (direction, ...modalities) => {
    for (const modality of modalities) inferred[direction][modality] = true;
  };
  if (capabilities.has('TG')) {
    mark('input', 'text');
    mark('output', 'text');
  }
  if (capabilities.has('VU')) {
    mark('input', 'text', 'image');
    mark('output', 'text');
  }
  if (capabilities.has('IG')) {
    mark('input', 'text');
    mark('output', 'image');
  }
  if (capabilities.has('VG')) {
    mark('input', 'text');
    mark('output', 'video');
  }
  if (capabilities.has('ASR')) {
    mark('input', 'audio');
    mark('output', 'text');
  }
  if (capabilities.has('TTS')) {
    mark('input', 'text');
    mark('output', 'audio');
  }
  return inferred;
}

function parameterCapability(model, names) {
  const parameters = firstDefined(model.supported_parameters, model.supportedParameters);
  if (!Array.isArray(parameters)) return UNKNOWN;
  const normalized = new Set(parameters.map((value) => String(value).toLowerCase().replaceAll('_', '-')));
  return names.some((name) => normalized.has(name));
}

function listedCapability(value, names) {
  if (!Array.isArray(value)) return UNKNOWN;
  const normalized = new Set(value.map((item) => String(item).toLowerCase().replaceAll('_', '-')));
  return names.some((name) => normalized.has(name));
}

function preferKnown(...values) {
  return values.find((value) => value !== UNKNOWN) ?? UNKNOWN;
}

function containsSecretInStringFields(value, apiKey, seen = new Set()) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) return false;
  if (typeof value === 'string') return value.includes(apiKey);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const fields = Array.isArray(value) ? value : Object.values(value);
  return fields.some((field) => containsSecretInStringFields(field, apiKey, seen));
}

function urlComponentIsUnsafe(value, apiKey, alreadyDecoded = false) {
  let current = String(value);
  const hasApiKey = typeof apiKey === 'string' && apiKey.length > 0;
  if (hasApiKey && current.includes(apiKey)) return true;
  if (!alreadyDecoded && MALFORMED_PERCENT_ESCAPE.test(current)) return true;

  for (let depth = 0; depth < MAX_URL_DECODE_DEPTH; depth += 1) {
    if (!VALID_PERCENT_ESCAPE.test(current)) return false;
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return true;
    }
    if (decoded === current) return false;
    current = decoded;
    if (hasApiKey && current.includes(apiKey)) return true;
  }

  // The depth bound permits three decoding transformations. Probe once more
  // without accepting the result so deeper encodings fail closed.
  if (!VALID_PERCENT_ESCAPE.test(current)) return false;
  try {
    return decodeURIComponent(current) !== current;
  } catch {
    return true;
  }
}

function urlContainsExactSecret(url, apiKey) {
  if (typeof apiKey === 'string' && apiKey.length > 0 && url.href.includes(apiKey)) return true;

  if (url.pathname.split('/').some((segment) => urlComponentIsUnsafe(segment, apiKey))) return true;

  const rawQuery = url.search.slice(1);
  for (const field of rawQuery ? rawQuery.split('&') : []) {
    const separator = field.indexOf('=');
    const name = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? '' : field.slice(separator + 1);
    if (urlComponentIsUnsafe(name, apiKey) || urlComponentIsUnsafe(value, apiKey)) return true;
  }

  for (const [name, value] of url.searchParams) {
    // URLSearchParams performs the first decode; continue canonicalizing each
    // name and value independently so nested encodings cannot hide the key.
    if (urlComponentIsUnsafe(name, apiKey, true) || urlComponentIsUnsafe(value, apiKey, true)) return true;
  }

  return urlComponentIsUnsafe(url.hash.slice(1), apiKey);
}

function protocolCapability(model) {
  const protocols = firstDefined(
    model.supported_protocols,
    model.supportedProtocols,
    model.protocols,
    model.supported_endpoints,
    model.supportedEndpoints,
  );
  if (!Array.isArray(protocols)) return UNKNOWN;
  return protocols.some((value) => /(^|[/_-])responses?($|[/_-])/i.test(String(value)));
}

export function normalizeOpenAIModel(model, source = 'api') {
  if (!model || typeof model !== 'object') return null;
  const idValue = firstDefined(model.id, model.model, model.model_id, model.name);
  if (typeof idValue !== 'string' || !idValue.trim()) return null;
  const id = idValue.trim();
  const modalities = emptyModalities();
  const inferredModalities = inferModalitiesFromCapabilities(model.capabilities);
  const inputMetadata = firstDefined(
    model.input_modalities,
    model.inputModalities,
    model.architecture?.input_modalities,
    model.architecture?.inputModalities,
    model.inference_metadata?.request_modality,
    model.inference_metadata?.requestModalities,
    model.modalities?.input,
    inferredModalities.input,
  );
  const outputMetadata = firstDefined(
    model.output_modalities,
    model.outputModalities,
    model.architecture?.output_modalities,
    model.architecture?.outputModalities,
    model.inference_metadata?.response_modality,
    model.inference_metadata?.responseModalities,
    model.modalities?.output,
    inferredModalities.output,
  );
  modalities.input = normalizeModalitySet(inputMetadata, INPUT_MODALITIES);
  modalities.output = normalizeModalitySet(outputMetadata, OUTPUT_MODALITIES);

  const tools = firstDefined(
    explicitBoolean(
      model.tools,
      model.supports_tools,
      model.supportTools,
      model.support_function_call,
      model.supportFunctionCall,
      model.capabilities?.tools,
      model.inference_metadata?.support_function_call,
      model.inference_metadata?.support_tool_call,
    ),
  );
  const reasoning = explicitBoolean(
    model.reasoning,
    model.supports_reasoning,
    model.support_reasoning,
    model.supportReasoning,
    model.capabilities?.reasoning,
    model.inference_metadata?.support_reasoning,
  );
  const responses = explicitBoolean(
    model.responses,
    model.supports_responses,
    model.support_responses,
    model.supportResponses,
    model.capabilities?.responses,
  );

  return {
    id,
    name: String(firstDefined(model.display_name, model.displayName, model.title, model.name, id)),
    contextWindow: finiteNumber(
      model.context_window,
      model.contextWindow,
      model.context_length,
      model.contextLength,
      model.max_context_length,
      model.model_info?.context_window,
      model.top_provider?.context_length,
    ),
    maxOutputTokens: finiteNumber(
      model.max_output_tokens,
      model.maxOutputTokens,
      model.max_completion_tokens,
      model.output_token_limit,
      model.model_info?.max_output_tokens,
      model.top_provider?.max_completion_tokens,
    ),
    input: modalities.input,
    output: modalities.output,
    tools: preferKnown(
      tools,
      parameterCapability(model, ['tools', 'tool-choice', 'function-call', 'functions']),
      listedCapability(model.features, ['function-calling', 'tool-calling']),
    ),
    reasoning: preferKnown(
      reasoning,
      parameterCapability(model, ['reasoning', 'include-reasoning']),
      listedCapability(model.capabilities, ['reasoning']),
    ),
    responses: responses === UNKNOWN ? protocolCapability(model) : responses,
    source: ['api', 'static', 'unknown'].includes(source) ? source : 'unknown',
  };
}

function mergeTriState(apiValue, staticValue) {
  return apiValue === UNKNOWN ? staticValue : apiValue;
}

function mergeNormalizedModel(apiModel, staticModel, rawApi) {
  if (!staticModel) return apiModel;
  const hasApiName = ['display_name', 'displayName', 'title', 'name']
    .some((field) => typeof rawApi[field] === 'string' && rawApi[field].trim());
  return {
    ...staticModel,
    ...apiModel,
    name: hasApiName ? apiModel.name : staticModel.name,
    contextWindow: apiModel.contextWindow ?? staticModel.contextWindow,
    maxOutputTokens: apiModel.maxOutputTokens ?? staticModel.maxOutputTokens,
    input: Object.fromEntries(INPUT_MODALITIES.map((name) => [
      name, mergeTriState(apiModel.input[name], staticModel.input[name]),
    ])),
    output: Object.fromEntries(OUTPUT_MODALITIES.map((name) => [
      name, mergeTriState(apiModel.output[name], staticModel.output[name]),
    ])),
    tools: mergeTriState(apiModel.tools, staticModel.tools),
    reasoning: mergeTriState(apiModel.reasoning, staticModel.reasoning),
    responses: mergeTriState(apiModel.responses, staticModel.responses),
    source: 'api',
  };
}

function normalizeModels(rawModels, providerType, source, warnings, apiKey) {
  const staticModels = new Map((STATIC_CATALOGS[providerType] || []).map((raw) => {
    const normalized = normalizeOpenAIModel(raw, 'static');
    return [normalized.id, normalized];
  }));
  const byId = new Map();
  let malformed = 0;
  let unsafe = 0;
  for (const raw of Array.isArray(rawModels) ? rawModels : []) {
    const apiModel = normalizeOpenAIModel(raw, source);
    if (!apiModel) {
      malformed += 1;
      continue;
    }
    const normalized = source === 'api'
      ? mergeNormalizedModel(apiModel, staticModels.get(apiModel.id), raw)
      : apiModel;
    if (containsSecretInStringFields(normalized, apiKey)) {
      unsafe += 1;
      continue;
    }
    byId.set(apiModel.id, normalized);
    if (byId.size >= MAX_MODELS) break;
  }
  if (malformed) warnings.push('Some malformed model entries were skipped.');
  if (unsafe) warnings.push('Some model entries containing sensitive data were skipped.');
  if ((Array.isArray(rawModels) ? rawModels.length : 0) > MAX_MODELS) {
    warnings.push('Model discovery was limited to 2,000 entries.');
  }
  return [...byId.values()];
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export function validateDiscoveryUrl(value, providerType) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error('Invalid provider discovery URL.');
  }
  if (url.username || url.password) throw new Error('Provider discovery URLs cannot contain credentials.');
  const loopbackHttpAllowed = ['custom', 'nvidia-nim'].includes(providerType)
    && url.protocol === 'http:'
    && isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttpAllowed) {
    throw new Error(providerType === 'custom' || providerType === 'nvidia-nim'
      ? 'Provider discovery URL must use HTTPS, or loopback HTTP.'
      : 'Provider discovery URL must use HTTPS.');
  }
  return url;
}

function destinationClass(url) {
  return isLoopbackHost(url.hostname) ? 'loopback' : 'non-loopback';
}

function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

function fetchWithAbort(fetchImpl, url, init) {
  if (init.signal?.aborted) return Promise.reject(init.signal.reason || new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(init.signal.reason || new Error('aborted'));
    init.signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => fetchImpl(url, init))
      .then(resolve, reject)
      .finally(() => init.signal?.removeEventListener('abort', onAbort));
  });
}

function readWithAbort(reader, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.read()
      .then(resolve, reject)
      .finally(() => signal?.removeEventListener('abort', onAbort));
  });
}

async function readBoundedResponse(response, signal) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let cancellationRequested = false;
  const cancelWithoutWaiting = () => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch { /* An untrusted stream may throw synchronously from cancel. */ }
  };
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        cancelWithoutWaiting();
        throw new DiscoverySafetyError('response_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    cancelWithoutWaiting();
    if (error instanceof DiscoverySafetyError) throw error;
    throw new DiscoverySafetyError('network');
  } finally {
    try { reader.releaseLock(); } catch { /* A cancelled pending read may retain the lock briefly. */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function cancelUnreadResponse(response) {
  if (!response?.body) return;
  try {
    Promise.resolve(response.body.cancel()).catch(() => {});
  } catch { /* An untrusted stream may throw synchronously from cancel. */ }
}

async function requestJson(context, initialUrl) {
  let url = validateDiscoveryUrl(initialUrl, context.providerType);
  if (urlContainsExactSecret(url, context.apiKey)) throw new DiscoverySafetyError('unsafe_url');
  const initialClass = destinationClass(url);
  const initialOrigin = url.origin;
  for (let redirects = 0; ; redirects += 1) {
    let response;
    try {
      response = await fetchWithAbort(context.fetchImpl, url, {
        method: 'GET',
        headers: context.headers,
        signal: context.signal,
        redirect: 'manual',
      });
    } catch {
      throw new DiscoverySafetyError('network');
    }
    if (!(response instanceof Response)) throw new DiscoverySafetyError('invalid_response');
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      cancelUnreadResponse(response);
      if (redirects >= MAX_REDIRECTS) throw new DiscoverySafetyError('redirect_limit');
      const location = response.headers.get('location');
      if (!location) throw new DiscoverySafetyError('unsafe_redirect');
      let next;
      try {
        next = validateDiscoveryUrl(new URL(location, url).toString(), context.providerType);
      } catch {
        throw new DiscoverySafetyError('unsafe_redirect');
      }
      if (urlContainsExactSecret(next, context.apiKey)) throw new DiscoverySafetyError('unsafe_redirect');
      if (destinationClass(next) !== initialClass || next.origin !== initialOrigin) {
        throw new DiscoverySafetyError('unsafe_redirect');
      }
      url = next;
      continue;
    }
    if (!response.ok) {
      cancelUnreadResponse(response);
      throw new DiscoveryHttpError(response.status);
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      cancelUnreadResponse(response);
      throw new DiscoverySafetyError('response_too_large');
    }
    const bytes = await readBoundedResponse(response, context.signal);
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new DiscoverySafetyError('invalid_json');
    }
  }
}

function nextPageUrl(body, currentUrl, apiKey) {
  const next = firstDefined(body?.next, body?.next_page, body?.pagination?.next, body?.meta?.next);
  if (typeof next === 'string' && next) {
    const current = new URL(currentUrl);
    const resolved = new URL(next, current);
    if (resolved.origin !== current.origin
      || resolved.username
      || resolved.password
      || urlContainsExactSecret(resolved, apiKey)) {
      throw new DiscoverySafetyError('unsafe_pagination');
    }
    return resolved.toString();
  }
  if (body?.has_more && typeof body?.last_id === 'string' && body.last_id) {
    if (urlComponentIsUnsafe(body.last_id, apiKey)) throw new DiscoverySafetyError('unsafe_pagination');
    const url = new URL(currentUrl);
    url.searchParams.set('after', body.last_id);
    if (urlContainsExactSecret(url, apiKey)) throw new DiscoverySafetyError('unsafe_pagination');
    return url.toString();
  }
  return null;
}

async function collectOpenAIModels(context, initialUrl) {
  const collected = [];
  let url = initialUrl;
  let limitedByPages = false;
  for (let page = 0; page < MAX_PAGES && url && collected.length < MAX_MODELS; page += 1) {
    const body = await requestJson(context, url);
    if (Array.isArray(body?.data)) collected.push(...body.data.slice(0, MAX_MODELS - collected.length));
    const next = nextPageUrl(body, url, context.apiKey);
    limitedByPages = page === MAX_PAGES - 1 && Boolean(next);
    url = next;
  }
  if (limitedByPages) context.warnings.push('Model discovery stopped at the five-page limit.');
  if (collected.length >= MAX_MODELS) context.warnings.push('Model discovery was limited to 2,000 entries.');
  return collected;
}

async function genericModelsAdapter(context) {
  const models = await collectOpenAIModels(context, joinUrl(context.baseUrl, 'models'));
  return { models, modelSource: 'api' };
}

async function xaiAdapter(context) {
  await requestJson(context, joinUrl(context.baseUrl, 'api-key'));
  const body = await requestJson(context, joinUrl(context.baseUrl, 'language-models'));
  return { models: Array.isArray(body?.models) ? body.models : [], modelSource: 'api' };
}

async function openRouterAdapter(context) {
  await requestJson(context, joinUrl(context.baseUrl, 'key'));
  let models;
  try {
    models = await collectOpenAIModels(context, joinUrl(context.baseUrl, 'models/user'));
  } catch (error) {
    if (!(error instanceof DiscoveryHttpError) || error.status !== 404) throw error;
    context.warnings.push('The user-filtered catalog was unavailable; the public catalog was used.');
    models = await collectOpenAIModels(context, joinUrl(context.baseUrl, 'models'));
  }
  models = models.filter((model) => {
    const outputs = firstDefined(model?.architecture?.output_modalities, model?.output_modalities);
    return !Array.isArray(outputs) || outputs.map(normalizeModalityName).includes('text');
  });
  return { models, modelSource: 'api' };
}

function isTencentResponsesModel(model) {
  const status = firstDefined(model?.status, model?.state);
  if (status !== undefined && !['online', 'active', 'available', 'enabled'].includes(String(status).toLowerCase())) return false;
  const explicit = explicitBoolean(
    model?.responses,
    model?.supports_responses,
    model?.support_responses,
    model?.capabilities?.responses,
    model?.protocol_compatibility?.responses,
  );
  if (explicit !== UNKNOWN) return explicit;
  const protocol = protocolCapability(model);
  if (protocol !== UNKNOWN) return protocol;
  return TENCENT_RESPONSES_MODELS.has(model?.id);
}

async function tencentAdapter(context) {
  const models = await collectOpenAIModels(context, joinUrl(context.baseUrl, 'models'));
  return {
    models: models.filter(isTencentResponsesModel).map((model) => ({ ...model, responses: true })),
    modelSource: 'api',
  };
}

function bailianNativeBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}/api/v1/models`;
}

async function bailianAdapter(context) {
  const models = [];
  let total = Infinity;
  for (let page = 1; page <= MAX_PAGES && models.length < total && models.length < MAX_MODELS; page += 1) {
    const url = new URL(bailianNativeBaseUrl(context.baseUrl));
    url.searchParams.set('page_no', String(page));
    url.searchParams.set('page_size', '100');
    const body = await requestJson(context, url.toString());
    const pageModels = Array.isArray(body?.output?.models) ? body.output.models : [];
    total = finiteNumber(body?.output?.total) ?? models.length + pageModels.length;
    models.push(...pageModels.slice(0, MAX_MODELS - models.length));
    if (!pageModels.length) break;
  }
  if (models.length < total && models.length < MAX_MODELS) {
    context.warnings.push('Model discovery stopped at the five-page limit.');
  }
  if (models.length >= MAX_MODELS && total > MAX_MODELS) {
    context.warnings.push('Model discovery was limited to 2,000 entries.');
  }
  return { models, modelSource: 'api' };
}

function staticAdapter(providerType, modelSource, message) {
  return async () => ({
    models: STATIC_CATALOGS[providerType] || [],
    modelSource,
    validation: { status: 'unverified', message },
  });
}

const ADAPTERS = Object.freeze({
  openai: genericModelsAdapter,
  xai: xaiAdapter,
  openrouter: openRouterAdapter,
  groq: genericModelsAdapter,
  fireworks: genericModelsAdapter,
  'baidu-qianfan': genericModelsAdapter,
  'volcengine-ark': staticAdapter(
    'volcengine-ark',
    'manual',
    'Enter an Ark endpoint ID; validity is verified by the first Codex request.',
  ),
  'tencent-tokenhub': tencentAdapter,
  bailian: bailianAdapter,
  'aws-bedrock': genericModelsAdapter,
  'azure-openai': staticAdapter(
    'azure-openai',
    'manual',
    'Enter an Azure deployment name; inventory models are not routable deployment IDs.',
  ),
  'cloudflare-workers-ai': staticAdapter(
    'cloudflare-workers-ai',
    'static',
    'The official Responses model whitelist is shown without probing the token.',
  ),
  'nvidia-nim': genericModelsAdapter,
  custom: genericModelsAdapter,
});

export function mapDiscoveryError(errorOrResponse) {
  const statusCode = errorOrResponse instanceof Response
    ? errorOrResponse.status
    : errorOrResponse instanceof DiscoveryHttpError
      ? errorOrResponse.status
      : null;
  if (statusCode === 401) return { status: 'invalid', message: 'API key was rejected by the provider.' };
  if (statusCode === 402 || statusCode === 403) {
    return { status: 'forbidden', message: 'The provider denied access to model discovery.' };
  }
  if (statusCode === 429) return { status: 'rate_limited', message: 'The provider rate-limited model discovery.' };
  if (statusCode === 404) return { status: 'unsupported', message: 'This provider does not expose the required discovery endpoint.' };
  return { status: 'unreachable', message: 'The provider could not be reached for model discovery.' };
}

function resolveConnectionSafely(input) {
  try {
    return resolveProviderConnection(input.providerType, input.providerOptions || {}, input.baseUrl || '');
  } catch (error) {
    const message = String(error?.message || '');
    const safe = [
      /^Invalid /,
      /^Azure resource /,
      /^Base URL /,
      /base URL is required$/,
    ].some((pattern) => pattern.test(message));
    throw new Error(safe ? message : 'Invalid provider connection settings.');
  }
}

export async function discoverProvider(input, dependencies = {}) {
  const providerType = String(input?.providerType || '');
  const preset = getProviderPreset(providerType);
  if (!preset || preset.compatibility === 'unsupported') {
    return {
      validation: { status: 'unsupported', message: 'Direct Responses discovery is not supported for this provider.' },
      compatibility: preset?.compatibility || 'unsupported',
      models: [],
      modelSource: 'manual',
      warnings: [],
    };
  }

  const connection = resolveConnectionSafely(input || {});
  const adapter = ADAPTERS[providerType];
  if (!adapter) {
    return {
      validation: { status: 'unsupported', message: 'No discovery adapter is available for this provider.' },
      compatibility: preset.compatibility,
      models: [],
      modelSource: 'manual',
      warnings: [],
    };
  }

  const staticOnly = ['volcengine-ark', 'azure-openai', 'cloudflare-workers-ai'].includes(providerType);
  if (!staticOnly && !input.apiKey) {
    return {
      validation: { status: 'invalid', message: 'An API key is required for model discovery.' },
      compatibility: preset.compatibility,
      models: [],
      modelSource: 'manual',
      warnings: [],
    };
  }

  const timeout = withTimeout(REQUEST_TIMEOUT_MS, input.signal);
  const warnings = [];
  const context = {
    providerType,
    baseUrl: connection.baseUrl,
    providerOptions: connection.providerOptions,
    fetchImpl: dependencies.fetchImpl || globalThis.fetch,
    headers: authHeaders(input.apiKey || ''),
    apiKey: input.apiKey || '',
    signal: timeout.signal,
    warnings,
  };
  try {
    const discovered = await adapter(context);
    const models = normalizeModels(
      discovered.models,
      providerType,
      discovered.modelSource === 'api' ? 'api' : 'static',
      warnings,
      context.apiKey,
    );
    return {
      validation: discovered.validation || { status: 'valid', message: 'Credentials and discovery endpoint were accepted.' },
      compatibility: preset.compatibility,
      models,
      modelSource: discovered.modelSource,
      warnings,
    };
  } catch (error) {
    return {
      validation: mapDiscoveryError(error),
      compatibility: preset.compatibility,
      models: [],
      modelSource: 'manual',
      warnings,
    };
  } finally {
    timeout.done();
  }
}
