import {
  CHATGPT_CODEX_BASE_URL,
  getProviderPreset,
  inferProviderOptions,
  inferProviderType,
  isTrustedLegacyPassthroughUrl,
  resolveProviderConnection,
} from './provider-registry.js';

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function tomlStr(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlKey(value) {
  const key = String(value);
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlStr(key);
}

function tomlScalar(value) {
  if (typeof value === 'string') return tomlStr(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error('provider_options 只能包含字符串、布尔值或有限数字');
}

function tomlInlineTable(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('provider_options 必须是对象');
  }
  return `{ ${Object.entries(options)
    .map(([key, value]) => `${tomlKey(key)} = ${tomlScalar(value)}`)
    .join(', ')} }`;
}

// 把 providers 数组序列化为 [[providers]] 区块文本(每块带一行可读注释)
export function buildProvidersRegion(providers) {
  const blocks = providers.map((provider) => {
    const lines = [];
    lines.push(`# ${provider.name || provider.id} (${provider.auth})${provider.enabled === false ? ' — 已停用' : ''}`);
    lines.push('[[providers]]');
    lines.push(`id = ${tomlStr(provider.id)}`);
    lines.push(`name = ${tomlStr(provider.name || provider.id)}`);
    if (provider.provider_type) lines.push(`provider_type = ${tomlStr(provider.provider_type)}`);
    if (provider.provider_options && Object.keys(provider.provider_options).length) {
      lines.push(`provider_options = ${tomlInlineTable(provider.provider_options)}`);
    }
    lines.push(`base_url = ${tomlStr(provider.base_url || '')}`);
    lines.push(`auth = ${tomlStr(provider.auth || 'bearer')}`);
    if (provider.token_env) lines.push(`token_env = ${tomlStr(provider.token_env)}`);
    lines.push(`models = [${(provider.models || []).map(tomlStr).join(', ')}]`);
    lines.push(`enabled = ${provider.enabled === false ? 'false' : 'true'}`);
    return lines.join('\n');
  });
  return blocks.join('\n\n');
}

// 在完整 config 文本里只替换 providers 区域,其余原样保留。
export function replaceProvidersRegion(text, providers) {
  const lines = text.split('\n');
  const heads = [];
  lines.forEach((line, index) => {
    if (line.trim() === '[[providers]]') heads.push(index);
  });
  const region = buildProvidersRegion(providers);
  if (!heads.length) return `${text.replace(/\s+$/, '')}\n\n${region}\n`;

  const start = heads[0];
  const lastStart = heads.at(-1);
  let lastKeyValue = lastStart;
  for (let index = lastStart + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('[')) break;
    if (trimmed !== '' && !trimmed.startsWith('#') && trimmed.includes('=')) lastKeyValue = index;
  }
  const before = lines.slice(0, start);
  const after = lines.slice(lastKeyValue + 1);
  while (before.length) {
    const trimmed = before.at(-1).trim();
    if (trimmed === '' || trimmed.startsWith('#')) before.pop();
    else break;
  }
  const parts = [...before, '', region, ''];
  while (after.length && after[0].trim() === '') after.shift();
  if (after.length) parts.push(...after);
  return parts.join('\n');
}

function normalizeCommonProviderFields(provider) {
  const id = String(provider.id || '').trim();
  if (!id) throw new Error('provider id 不能为空');
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error(`provider id 只能含字母/数字/_/-/.(收到 '${id}')`);
  }

  let tokenEnv = '';
  if (provider.token_env !== undefined && provider.token_env !== null && provider.token_env !== '') {
    if (typeof provider.token_env !== 'string'
      || provider.token_env !== provider.token_env.trim()
      || !ENV_NAME_RE.test(provider.token_env)) {
      throw new Error('token_env 必须是无前后空白的合法环境变量名');
    }
    tokenEnv = provider.token_env;
  }

  if (provider.models !== undefined && !Array.isArray(provider.models) && typeof provider.models !== 'string') {
    throw new Error('models 必须是数组或分隔字符串');
  }
  const rawModels = Array.isArray(provider.models)
    ? provider.models
    : String(provider.models || '').split(/[\n,，;]+/);
  return {
    id,
    name: String(provider.name || id).trim(),
    tokenEnv,
    models: [...new Set(rawModels.map((model) => String(model).trim()).filter(Boolean))],
    enabled: !(provider.enabled === false || provider.enabled === 'false'),
  };
}

// 规范化前端提交的 provider 对象(models 支持数组或逗号/换行分隔字符串)
export function normalizeProvider(input) {
  const provider = input || {};
  if (Object.hasOwn(provider, 'token')) throw new Error('新供应商配置禁止 inline token；请通过 API Key 字段保存到 env');
  const common = normalizeCommonProviderFields(provider);

  const explicitType = String(provider.provider_type || '').trim();
  const providerType = explicitType || inferProviderType(provider.base_url);
  const preset = getProviderPreset(providerType);
  if (!preset) throw new Error(`未知 provider_type '${providerType}'`);
  if (!preset.routable) throw new Error(`provider '${providerType}' 不支持 Responses 直连`);
  const auth = String(provider.auth || preset.auth).trim();
  if (auth !== preset.auth) {
    throw new Error(`provider '${providerType}' 的 auth 必须由服务端固定为 '${preset.auth}'`);
  }
  const submittedOptions = provider.provider_options && Object.keys(provider.provider_options).length
    ? provider.provider_options
    : inferProviderOptions(providerType, provider.base_url);
  const connection = resolveProviderConnection(
    providerType,
    submittedOptions,
    provider.base_url || '',
  );
  if (providerType === 'custom') {
    const disguisedType = inferProviderType(connection.baseUrl);
    const disguisedPreset = getProviderPreset(disguisedType);
    if (disguisedType !== 'custom' && disguisedPreset && !disguisedPreset.routable) {
      throw new Error(`unsupported official endpoint '${disguisedType}' 不能保存为 Custom`);
    }
  }
  const normalized = {
    id: common.id,
    name: common.name,
    provider_type: connection.providerType,
    provider_options: { ...connection.providerOptions },
    base_url: connection.baseUrl,
    auth,
  };
  if (auth === 'bearer' && common.tokenEnv) normalized.token_env = common.tokenEnv;
  normalized.models = common.models;
  normalized.enabled = common.enabled;
  return normalized;
}

// Existing config is a compatibility input, not a mutation contract. Providers
// without provider_type keep their safe URL/auth, while explicit modern entries
// still obey the registry's authoritative connection and auth policy.
export function normalizeProviderForLoad(input) {
  const provider = input || {};
  const common = normalizeCommonProviderFields(provider);
  const explicitType = String(provider.provider_type || '').trim();
  const inlineToken = typeof provider.token === 'string' && provider.token.length ? provider.token : '';

  if (explicitType) {
    const candidate = { ...provider };
    delete candidate.token;
    const requestedAuth = String(provider.auth || '').trim();
    if (explicitType === 'chatgpt-sub' && requestedAuth === 'chatgpt_oauth') {
      candidate.auth = 'chatgpt_subscription';
      const normalized = normalizeProvider(candidate);
      normalized.auth = 'chatgpt_oauth';
      return normalized;
    }
    const normalized = normalizeProvider(candidate);
    if (inlineToken && normalized.auth === 'bearer') normalized.token = inlineToken;
    return normalized;
  }

  const auth = String(provider.auth || 'bearer').trim();
  if (!['bearer', 'chatgpt_subscription', 'chatgpt_oauth', 'passthrough'].includes(auth)) {
    throw new Error(`未知 auth 类型 '${auth}'`);
  }
  const legacyConnection = resolveProviderConnection('custom', {}, provider.base_url || '');
  let providerType = 'custom';
  let providerOptions = { ...legacyConnection.providerOptions };
  let baseUrl = legacyConnection.baseUrl;

  if (auth === 'chatgpt_subscription' || auth === 'chatgpt_oauth') {
    if (baseUrl !== CHATGPT_CODEX_BASE_URL) {
      throw new Error('legacy ChatGPT auth 只允许精确的 ChatGPT Codex origin/base path');
    }
    providerType = 'chatgpt-sub';
    providerOptions = {};
    baseUrl = CHATGPT_CODEX_BASE_URL;
  } else if (auth === 'passthrough') {
    if (!isTrustedLegacyPassthroughUrl(baseUrl)) {
      throw new Error('legacy passthrough 只允许 loopback 或 registry 精确可信 origin');
    }
    const inferredType = inferProviderType(baseUrl);
    const inferredPreset = getProviderPreset(inferredType);
    if (inferredPreset?.routable && inferredType !== 'custom') {
      providerType = inferredType;
      providerOptions = { ...inferProviderOptions(inferredType, baseUrl) };
    }
  } else {
    const inferredType = inferProviderType(baseUrl);
    const inferredPreset = getProviderPreset(inferredType);
    if (inferredPreset?.routable && inferredPreset.auth === 'bearer' && inferredType !== 'custom') {
      try {
        const inferred = resolveProviderConnection(inferredType, inferProviderOptions(inferredType, baseUrl), baseUrl);
        if (inferred.baseUrl === baseUrl) {
          providerType = inferred.providerType;
          providerOptions = { ...inferred.providerOptions };
        }
      } catch { /* Safe legacy bearer stays Custom with its original URL. */ }
    }
  }

  const normalized = {
    id: common.id,
    name: common.name,
    provider_type: providerType,
    provider_options: providerOptions,
    base_url: baseUrl,
    auth,
    models: common.models,
    enabled: common.enabled,
  };
  if ((auth === 'bearer' || auth === 'chatgpt_oauth') && common.tokenEnv) normalized.token_env = common.tokenEnv;
  if (auth === 'bearer' && inlineToken) normalized.token = inlineToken;
  return normalized;
}

// Stable, secret-free identity for the authoritative upstream connection.
// IDs, display names, model lists and credential references are deliberately
// excluded: they do not change where a bearer credential will be sent.
export function providerConnectionIdentity(input) {
  const provider = normalizeProviderForLoad(input);
  const providerOptions = Object.fromEntries(
    Object.entries(provider.provider_options || {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify({
    provider_type: provider.provider_type,
    provider_options: providerOptions,
    base_url: provider.base_url,
  });
}
