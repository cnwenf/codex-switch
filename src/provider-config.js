import {
  getProviderPreset,
  inferProviderType,
  resolveProviderConnection,
} from './provider-registry.js';

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

function inferProviderOptions(providerType, baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl || ''));
  } catch {
    return {};
  }
  const hostname = url.hostname.toLowerCase();
  if (providerType === 'aws-bedrock') {
    const match = hostname.match(/^bedrock-mantle\.([a-z]{2}(?:-[a-z]+)+-\d+)\.api\.aws$/);
    return match ? { region: match[1] } : {};
  }
  if (providerType === 'bailian') {
    const workspace = hostname.match(/^([a-z0-9_-]+)\.([a-z]{2}(?:-[a-z]+)+-\d+)\.maas\.aliyuncs\.com$/i);
    if (workspace) return { region: workspace[2], workspace_id: workspace[1] };
    const region = {
      'dashscope.aliyuncs.com': 'cn-beijing',
      'dashscope-intl.aliyuncs.com': 'ap-southeast-1',
      'dashscope-us.aliyuncs.com': 'us-east-1',
    }[hostname];
    return region ? { region, workspace_id: '' } : {};
  }
  if (providerType === 'tencent-tokenhub') {
    return { site: hostname === 'tokenhub-intl.tencentcloudmaas.com' ? 'intl' : 'cn' };
  }
  if (providerType === 'cloudflare-workers-ai') {
    const match = url.pathname.match(/^\/client\/v4\/accounts\/([A-Za-z0-9_-]+)\/ai\/v1\/?$/);
    return match ? { account_id: match[1] } : {};
  }
  if (providerType === 'azure-openai') {
    return { resource_endpoint: `${url.protocol}//${url.host}` };
  }
  if (providerType === 'nvidia-nim') return { base_url: String(baseUrl) };
  return {};
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
    if (provider.token) lines.push(`token = ${tomlStr(provider.token)}`);
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

// 规范化前端提交的 provider 对象(models 支持数组或逗号/换行分隔字符串)
export function normalizeProvider(input) {
  const provider = input || {};
  const id = String(provider.id || '').trim();
  if (!id) throw new Error('provider id 不能为空');
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error(`provider id 只能含字母/数字/_/-/.(收到 '${id}')`);
  }

  const auth = String(provider.auth || 'bearer').trim();
  if (!['bearer', 'chatgpt_subscription', 'chatgpt_oauth', 'passthrough'].includes(auth)) {
    throw new Error(`未知 auth 类型 '${auth}'`);
  }

  const explicitType = String(provider.provider_type || '').trim();
  const providerType = explicitType || inferProviderType(provider.base_url);
  const preset = getProviderPreset(providerType);
  if (!preset) throw new Error(`未知 provider_type '${providerType}'`);
  if (!preset.routable) throw new Error(`provider '${providerType}' 不支持 Responses 直连`);
  const submittedOptions = provider.provider_options && Object.keys(provider.provider_options).length
    ? provider.provider_options
    : inferProviderOptions(providerType, provider.base_url);
  const connection = resolveProviderConnection(
    providerType,
    submittedOptions,
    provider.base_url || '',
  );

  const rawModels = Array.isArray(provider.models)
    ? provider.models
    : String(provider.models || '').split(/[\n,，;]+/);
  const models = [...new Set(rawModels.map((model) => String(model).trim()).filter(Boolean))];
  const normalized = {
    id,
    name: String(provider.name || id).trim(),
    provider_type: connection.providerType,
    provider_options: { ...connection.providerOptions },
    base_url: connection.baseUrl,
    auth,
  };
  if (auth === 'bearer' || auth === 'chatgpt_oauth') {
    if (provider.token_env && String(provider.token_env).trim()) {
      normalized.token_env = String(provider.token_env).trim();
    }
    if (provider.token && String(provider.token).trim()) normalized.token = String(provider.token).trim();
  }
  normalized.models = models;
  normalized.enabled = !(provider.enabled === false || provider.enabled === 'false');
  return normalized;
}
