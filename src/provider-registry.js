const GROUPS = Object.freeze({
  direct: '直接与聚合 API',
  cloud: '云平台与自托管',
  unsupported: '暂不支持直连',
  custom: '自定义',
});

const COMPATIBILITY_NOTES = Object.freeze({
  unsupported: '未验证官方 Responses 直连支持；可改用 OpenRouter 或已验证的自定义网关。',
  unverified: 'Responses 兼容性尚未验证；请只在你信任的端点完成实际连接与模型验证后使用。',
  limited: 'Responses 支持存在已知限制，请在实际使用前验证模型与参数。',
  beta: 'Responses API 仍处于 Beta 阶段。',
});

export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

const UNSUPPORTED_PROVIDERS = Object.freeze([
  ['kimi', 'Kimi（月之暗面）'],
  ['glm', 'GLM（智谱）'],
  ['deepseek', 'DeepSeek（深度求索）'],
  ['gemini', 'Google Gemini（谷歌）'],
  ['anthropic', 'Anthropic Claude'],
  ['mistral', 'Mistral AI（法国）'],
  ['together', 'Together AI（聚合平台）'],
  ['cerebras', 'Cerebras（芯片云）'],
  ['siliconflow', '硅基流动'],
]);

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRoutableCompatibility(value) {
  return value === 'supported' || value === 'beta' || value === 'limited';
}

function projectPublic(definition) {
  const { buildBaseUrl, ...publicPreset } = definition;
  return freeze({
    ...publicPreset,
    options: definition.options.map((option) => ({ ...option })),
    compatibilityNote: definition.compatibilityNote || COMPATIBILITY_NOTES[definition.compatibility] || '',
  });
}

function preset(definition) {
  const entry = {
    auth: 'bearer',
    options: [],
    requiresManualModel: false,
    ...definition,
    routable: definition.routable ?? isRoutableCompatibility(definition.compatibility),
  };
  entry.public = projectPublic(entry);
  return freeze(entry);
}

export const PROVIDER_PRESETS = freeze([
  preset({ id: 'chatgpt-sub', name: 'ChatGPT 订阅', group: GROUPS.direct, compatibility: 'supported', auth: 'chatgpt_subscription', tokenEnv: '', baseUrl: CHATGPT_CODEX_BASE_URL }),
  preset({ id: 'openai', name: 'OpenAI API', group: GROUPS.direct, compatibility: 'supported', tokenEnv: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1' }),
  preset({ id: 'xai', name: 'xAI', group: GROUPS.direct, compatibility: 'supported', tokenEnv: 'XAI_API_KEY', baseUrl: 'https://api.x.ai/v1' }),
  preset({ id: 'openrouter', name: 'OpenRouter', group: GROUPS.direct, compatibility: 'supported', tokenEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' }),
  preset({ id: 'groq', name: 'Groq', group: GROUPS.direct, compatibility: 'beta', tokenEnv: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1' }),
  preset({ id: 'fireworks', name: 'Fireworks AI', group: GROUPS.direct, compatibility: 'supported', tokenEnv: 'FIREWORKS_API_KEY', baseUrl: 'https://api.fireworks.ai/inference/v1' }),
  preset({ id: 'baidu-qianfan', name: '百度千帆', group: GROUPS.direct, compatibility: 'supported', tokenEnv: 'QIANFAN_API_KEY', baseUrl: 'https://qianfan.baidubce.com/v2' }),
  preset({ id: 'volcengine-ark', name: '火山方舟', group: GROUPS.direct, compatibility: 'supported', tokenEnv: 'ARK_API_KEY', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', requiresManualModel: true }),
  preset({ id: 'tencent-tokenhub', name: '腾讯 TokenHub', group: GROUPS.direct, compatibility: 'limited', tokenEnv: 'TENCENT_TOKENHUB_API_KEY', options: [{ name: 'site', type: 'select', default: 'cn', choices: ['cn', 'intl'] }], buildBaseUrl: ({ site }) => (site === 'intl' ? 'https://tokenhub-intl.tencentcloudmaas.com/v1' : 'https://tokenhub.tencentmaas.com/v1') }),
  preset({ id: 'bailian', name: '阿里云百炼', group: GROUPS.direct, compatibility: 'limited', tokenEnv: 'DASHSCOPE_API_KEY', options: [{ name: 'region', type: 'select', default: 'cn-beijing', choices: ['cn-beijing', 'ap-southeast-1', 'us-east-1'] }, { name: 'workspace_id', type: 'text', default: '' }], buildBaseUrl: bailianBaseUrl }),
  preset({ id: 'aws-bedrock', name: 'AWS Bedrock', group: GROUPS.cloud, compatibility: 'supported', tokenEnv: 'AWS_BEDROCK_API_KEY', options: [{ name: 'region', type: 'text', default: 'us-east-1' }], buildBaseUrl: ({ region }) => `https://bedrock-mantle.${region}.api.aws/v1` }),
  preset({ id: 'azure-openai', name: 'Azure OpenAI / Microsoft Foundry', group: GROUPS.cloud, compatibility: 'supported', tokenEnv: 'AZURE_OPENAI_API_KEY', options: [{ name: 'resource_endpoint', type: 'url', default: '' }], buildBaseUrl: ({ resource_endpoint: endpoint }) => `${endpoint}/openai/v1`, requiresManualModel: true }),
  preset({ id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI', group: GROUPS.cloud, compatibility: 'limited', tokenEnv: 'CLOUDFLARE_API_TOKEN', options: [{ name: 'account_id', type: 'text', default: '' }], buildBaseUrl: ({ account_id: accountId }) => `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1` }),
  preset({ id: 'nvidia-nim', name: 'NVIDIA NIM（自托管）', group: GROUPS.cloud, compatibility: 'unverified', routable: true, tokenEnv: 'NVIDIA_NIM_API_KEY', options: [{ name: 'base_url', type: 'url', default: 'http://127.0.0.1:8000/v1' }] }),
  ...UNSUPPORTED_PROVIDERS.map(([id, name]) => preset({ id, name, group: GROUPS.unsupported, compatibility: 'unsupported', tokenEnv: '' })),
  preset({ id: 'custom', name: '自定义', group: GROUPS.custom, compatibility: 'unverified', routable: true, tokenEnv: 'CUSTOM_API_KEY', options: [{ name: 'base_url', type: 'url', default: '' }] }),
]);

const PRESETS_BY_ID = new Map(PROVIDER_PRESETS.map((entry) => [entry.id, entry]));
const HOST_TYPES = Object.freeze([
  ['api.openai.com', 'openai'], ['api.x.ai', 'xai'], ['openrouter.ai', 'openrouter'],
  ['api.groq.com', 'groq'], ['api.fireworks.ai', 'fireworks'], ['qianfan.baidubce.com', 'baidu-qianfan'],
  ['ark.cn-beijing.volces.com', 'volcengine-ark'], ['tokenhub.tencentmaas.com', 'tencent-tokenhub'], ['tokenhub-intl.tencentcloudmaas.com', 'tencent-tokenhub'],
  ['dashscope.aliyuncs.com', 'bailian'], ['dashscope-intl.aliyuncs.com', 'bailian'], ['dashscope-us.aliyuncs.com', 'bailian'],
  ['api.cloudflare.com', 'cloudflare-workers-ai'],
  ['api.deepseek.com', 'deepseek'], ['api.moonshot.cn', 'kimi'], ['open.bigmodel.cn', 'glm'],
]);

export { isRoutableCompatibility };

export function getProviderPreset(providerType) {
  return PRESETS_BY_ID.get(providerType) || null;
}

export function listProviderPresets() {
  return PROVIDER_PRESETS.map((entry) => entry.public);
}

export function inferProviderType(baseUrl) {
  try {
    const url = new URL(String(baseUrl));
    const hostname = url.hostname.toLowerCase();
    if (normalizeUrlForComparison(url) === CHATGPT_CODEX_BASE_URL) return 'chatgpt-sub';
    if ((hostname.endsWith('.openai.azure.com') || hostname.endsWith('.services.ai.azure.com'))
      && ['/openai/v1', '/openai/v1/'].includes(url.pathname)
      && !url.search && !url.hash && !url.username && !url.password) return 'azure-openai';
    if (/^bedrock-mantle\.[a-z]{2}(?:-[a-z]+)+-\d+\.api\.aws$/.test(hostname)) return 'aws-bedrock';
    if (/^[a-z0-9_-]+\.(?:cn-beijing|ap-southeast-1|us-east-1)\.maas\.aliyuncs\.com$/.test(hostname)) return 'bailian';
    for (const [host, type] of HOST_TYPES) {
      if (host.endsWith('.') ? hostname.startsWith(host) : hostname === host) return type;
    }
  } catch { /* Existing malformed URLs fall back to Custom. */ }
  return 'custom';
}

export function inferProviderOptions(providerType, baseUrl) {
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
    const workspace = hostname.match(/^([a-z0-9_-]+)\.(cn-beijing|ap-southeast-1|us-east-1)\.maas\.aliyuncs\.com$/i);
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

function isLoopbackHost(hostname) {
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function normalizeUrlForComparison(value) {
  const url = value instanceof URL ? value : new URL(String(value));
  if (url.username || url.password || url.search || url.hash) throw new Error('URL contains untrusted components');
  return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '');
}

// Legacy passthrough may keep inbound Authorization only for a local endpoint
// or for a registry URL that round-trips to one exact official connection.
export function isTrustedLegacyPassthroughUrl(value) {
  let url;
  try {
    url = new URL(String(value));
    if (url.username || url.password || url.search || url.hash) return false;
  } catch {
    return false;
  }
  if (isLoopbackHost(url.hostname) && (url.protocol === 'http:' || url.protocol === 'https:')) return true;
  if (url.protocol !== 'https:') return false;
  const providerType = inferProviderType(url);
  const provider = getProviderPreset(providerType);
  if (!provider || !provider.routable || ['custom', 'nvidia-nim'].includes(provider.id)) return false;
  try {
    const resolved = resolveProviderConnection(provider.id, inferProviderOptions(provider.id, url), String(url));
    return normalizeUrlForComparison(url) === normalizeUrlForComparison(resolved.baseUrl);
  } catch {
    return false;
  }
}

export function resolveProviderConnection(providerType, providerOptions = {}, customBaseUrl = '') {
  const preset = getProviderPreset(providerType) || getProviderPreset('custom');
  const input = (preset.id === 'custom' && customBaseUrl)
    ? { ...providerOptions, base_url: customBaseUrl }
    : providerOptions;
  const options = normalizeOptions(preset, input);
  let baseUrl;
  if (preset.baseUrl) baseUrl = preset.baseUrl;
  else if (preset.buildBaseUrl) baseUrl = preset.buildBaseUrl(options);
  else baseUrl = normalizeConnectionUrl(customBaseUrl || options.base_url, preset.id);
  return freeze({ providerType: preset.id, providerOptions: options, baseUrl });
}

function normalizeOptions(preset, input) {
  const options = {};
  for (const field of preset.options) {
    const value = input[field.name] ?? field.default;
    options[field.name] = typeof value === 'string' ? value.trim() : value;
    if (field.type === 'select' && !field.choices.includes(options[field.name])) {
      throw new Error(`Invalid ${field.name}`);
    }
  }
  if (preset.id === 'aws-bedrock') assertRegion(options.region);
  if (preset.id === 'bailian') assertIdentifier(options.workspace_id, 'workspace ID', true);
  if (preset.id === 'cloudflare-workers-ai') assertIdentifier(options.account_id, 'account ID');
  if (preset.id === 'azure-openai') options.resource_endpoint = normalizeAzureEndpoint(options.resource_endpoint);
  if (preset.id === 'nvidia-nim' || preset.id === 'custom') options.base_url = normalizeConnectionUrl(options.base_url, preset.id);
  return freeze(options);
}

function bailianBaseUrl({ region, workspace_id: workspaceId }) {
  const host = { 'cn-beijing': 'dashscope.aliyuncs.com', 'ap-southeast-1': 'dashscope-intl.aliyuncs.com', 'us-east-1': 'dashscope-us.aliyuncs.com' }[region];
  return workspaceId
    ? `https://${workspaceId}.${region}.maas.aliyuncs.com/compatible-mode/v1`
    : `https://${host}/compatible-mode/v1`;
}

function assertRegion(region) {
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region || '')) throw new Error('Invalid AWS region');
}

function assertIdentifier(value, label, optional = false) {
  if (optional && !value) return;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid ${label}`);
}

function normalizeAzureEndpoint(value) {
  if (!value) throw new Error('Azure resource endpoint is required');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Azure resource endpoint must be an HTTPS URL');
  const azureResourceHost = url.hostname.endsWith('.openai.azure.com') || url.hostname.endsWith('.services.ai.azure.com');
  if (!azureResourceHost) throw new Error('Azure resource host must use an Azure OpenAI or AI Foundry domain');
  if (!['/', '/openai/v1', '/openai/v1/'].includes(url.pathname)) throw new Error('Azure resource endpoint must be an origin or end in /openai/v1');
  return `${url.protocol}//${url.host}`;
}

function normalizeConnectionUrl(value, providerType) {
  if (!value) throw new Error(`${providerType === 'custom' ? 'Custom' : 'NIM'} base URL is required`);
  const url = new URL(value);
  const loopback = url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL must use HTTPS, or loopback HTTP');
  }
  return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '');
}
