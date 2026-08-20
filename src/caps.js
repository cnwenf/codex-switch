// codex-switch — model capability resolution.
// Data flows: [model_overrides in config.toml] > [live fetch from Bailian /api/v1/models]
//             > [built-in static table below] > [conservative default].
// Capabilities feed the generated catalog.json consumed by Codex
// (codex-rs ModelInfo schema, codex-rs/protocol/src/openai_models.rs).
//
// 对 codex 请求体零改写:本模块只影响 catalog 生成,不影响转发路径上的任何字节。

// ---------- built-in static table (web-researched 2026-08-20) ----------
// gpt-5.6 / gpt-5.6-sol:
//   developers.openai.com/api/docs/models/gpt-5.6-sol — context 1,050,000;
//   Reasoning.effort: none, low, medium (default), high, xhigh, max;
//   openai.com/index/gpt-5-6 — ultra available in the Codex product (Plus+, chatgpt backend).
// gpt-5.5:
//   openai.com/index/introducing-gpt-5-5 — in Codex: 400K context,
//   five levels: non-reasoning(none)/low/medium(default)/high/xhigh; vision multimodal.
// codex-1:
//   openai.com/index/introducing-codex — tested at 192K max context at launch (2025-05);
//   2026 product supports image input. Context set to a safe low-biased 256K
//   (Codex compacts earlier rather than overflowing upstream). 用户可用 override 覆盖。
// qwen3.8-max / qwen3.7-plus / qwen3.7-flash:
//   help.aliyun.com/zh/model-studio/qwen3-8-max — context 1,000,000, 输入模态 Image+Text+Video;
//   help.aliyun.com/zh/model-studio/qwen3-7-plus, qwen3-7-flash — same;
//   help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses —
//   reasoning.effort 支持 none/minimal/low/medium/high/xhigh/max 共 7 档(默认 xhigh);
//   xhigh/max 仅华北2(北京)与新加坡可用,故 default 取 medium(全地域安全)。
const STATIC_CAPS = {
  'gpt-5.6': {
    contextWindow: 1000000,
    vision: true,
    levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultLevel: 'medium',
  },
  'gpt-5.6-sol': {
    contextWindow: 1000000,
    vision: true,
    levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultLevel: 'medium',
  },
  'gpt-5.5': {
    contextWindow: 400000,
    vision: true,
    levels: ['none', 'low', 'medium', 'high', 'xhigh'],
    defaultLevel: 'medium',
  },
  'codex-1': {
    contextWindow: 256000, // estimate: low-biased (launch doc 192K; product reports higher)
    vision: true,
    levels: ['low', 'medium', 'high', 'xhigh'],
    defaultLevel: 'medium',
  },
  'qwen3.8-max': {
    contextWindow: 1000000,
    vision: true,
    levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultLevel: 'medium',
  },
  'qwen3.7-plus': {
    contextWindow: 1000000,
    vision: true,
    levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultLevel: 'medium',
  },
  'qwen3.7-flash': {
    contextWindow: 1000000,
    vision: true,
    levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultLevel: 'medium',
  },
};

// Unknown model: don't advertise effort levels (Codex then sends no effort param
// and the upstream default applies — safest) and assume no vision.
const DEFAULT_CAPS = { contextWindow: 128000, vision: false, levels: [], defaultLevel: null };

const EFFORT_DESCRIPTIONS = {
  none: 'Non-reasoning',
  minimal: 'Minimal reasoning',
  low: 'Low reasoning',
  medium: 'Medium reasoning (default)',
  high: 'High reasoning',
  xhigh: 'Extra high reasoning',
  max: 'Maximum reasoning',
  ultra: 'Ultra (multi-agent)',
};

// ---------- live fetch from Bailian native model-list API ----------
// GET /api/v1/models (DashScope native, not compatible-mode) returns per-model
// model_info.context_window / inference_metadata.request_modality (Text/Image/Audio/Video).
// 文档: help.aliyun.com/zh/model-studio/list-models
const CAPS_TTL_MS = 30 * 60 * 1000;
const capsCache = new Map(); // providerId -> { at, models: Map<modelId, {contextWindow, vision}> }

export function bailianModelsUrl(baseUrl) {
  try {
    const u = new URL(String(baseUrl || ''));
    const h = u.hostname;
    if (h === 'dashscope.aliyuncs.com' || h === 'dashscope-intl.aliyuncs.com' || h.endsWith('.maas.aliyuncs.com')) {
      return `${u.protocol}//${h}/api/v1/models`;
    }
  } catch {}
  return null;
}

async function fetchBailianPage(modelsUrl, token, pageNo) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(`${modelsUrl}?page_size=100&page_no=${pageNo}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j || j.success !== true || !j.output) throw new Error(`bad response: ${JSON.stringify(j?.message || j?.code || j).slice(0, 200)}`);
    return j.output;
  } finally {
    clearTimeout(timer);
  }
}

// Returns Map<modelId, {contextWindow, vision}> for the provider's own model list,
// or null when the provider is not a Bailian endpoint (no auto-fetch).
export async function fetchProviderCaps(provider) {
  const modelsUrl = bailianModelsUrl(provider.base_url);
  if (!modelsUrl) return null;
  const token = (provider.token_env && process.env[provider.token_env]) || provider.token;
  if (!token) throw new Error(`no token (env ${provider.token_env || 'token'} unset)`);

  const want = new Set(provider.models || []);
  const found = new Map();
  let total = Infinity;
  for (let page = 1; page <= 5 && found.size < want.size; page++) {
    const out = await fetchBailianPage(modelsUrl, token, page);
    total = Number(out.total) || 0;
    if (!Array.isArray(out.models) || out.models.length === 0) break;
    for (const m of out.models) {
      if (!want.has(m.model)) continue;
      const mi = m.model_info || {};
      const cw = Number.isFinite(mi.context_window) ? mi.context_window : mi.max_input_tokens;
      const modalities = m.inference_metadata?.request_modality || [];
      found.set(m.model, {
        contextWindow: Number.isFinite(cw) ? cw : null,
        vision: modalities.includes('Image'),
      });
      if (found.size >= want.size) break;
    }
    if (page * 100 >= total) break;
  }
  return found;
}

export { capsCache, CAPS_TTL_MS };

// ---------- resolution ----------
// Priority: config.toml [model_overrides] > cached Bailian fetch > static > default.
export function resolveCaps(config, provider, modelId) {
  const over = config.model_overrides?.[modelId];
  const cached = capsCache.get(provider.id);
  const fetched = cached?.models?.get(modelId);
  const stat = STATIC_CAPS[modelId] || DEFAULT_CAPS;
  let source;
  if (over) source = 'config override';
  else if (fetched) source = 'bailian api';
  else if (STATIC_CAPS[modelId]) source = 'built-in static';
  else source = 'default (unknown model)';
  return {
    contextWindow: over?.context_window ?? fetched?.contextWindow ?? stat.contextWindow,
    vision: !!(over?.vision ?? fetched?.vision ?? stat.vision),
    levels: over?.reasoning_efforts ?? stat.levels,
    defaultLevel: over?.default_reasoning_effort ?? stat.defaultLevel ?? (stat.levels.includes('medium') ? 'medium' : null),
    source,
  };
}

// ---------- catalog.json entry (codex-rs ModelInfo wire schema) ----------
// Required keys per codex-rs/protocol/src/openai_models.rs + its deserialization tests.
// input_modalities must be explicit: omitted defaults to [text, image] in core.
export function buildCatalogEntry(modelId, caps, provider) {
  const entry = {
    slug: modelId,
    display_name: `${modelId} (${provider.name || provider.id})`,
    description: `${provider.name || provider.id} via codex-switch`,
    supported_reasoning_levels: (caps.levels || []).map((effort) => ({
      effort,
      description: EFFORT_DESCRIPTIONS[effort] || effort,
    })),
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    support_verbosity: false,
    truncation_policy: { mode: 'bytes', limit: 10000 },
    input_modalities: caps.vision ? ['text', 'image'] : ['text'],
    experimental_supported_tools: [],
    effective_context_window_percent: 95,
    supports_reasoning_summary_parameter: true,
    default_reasoning_summary: 'auto',
  };
  if (caps.contextWindow != null) entry.context_window = caps.contextWindow;
  if (caps.defaultLevel) entry.default_reasoning_level = caps.defaultLevel;
  return entry;
}