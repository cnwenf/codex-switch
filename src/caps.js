// codex-switch — model capability resolution.
// Data flows: [model_overrides in config.toml] > [provider discovery cache]
//             > [built-in static table below] > [conservative default].
// Capabilities feed the generated catalog.json consumed by Codex
// (codex-rs ModelInfo schema, codex-rs/protocol/src/openai_models.rs).
// 官方模型不走本模块:server.js mergeCatalog 用 official.js 的二进制镜像条目。
//
// 对 codex 请求体零改写:本模块只影响 catalog 生成,不影响转发路径上的任何字节。

// ---------- built-in static table ----------
// 官方模型(gpt-5.6-*/gpt-5.5/gpt-5.4*/gpt-5.2/codex-auto-review):
//   正常路径由 official.js 从 codex 二进制内嵌 catalog 逐字节镜像,这里的静态值
//   仅是找不到二进制时的回退,数值取自官方内嵌 catalog(codex-cli 0.144.1 提取):
//   gpt-5.6-sol/terra/luna: ctx 372000,levels low/medium/high/xhigh/max
//     (ultra 仅 sol/terra),default sol=low、其余 medium;
//   gpt-5.5/gpt-5.4/gpt-5.4-mini/gpt-5.2/codex-auto-review:
//     ctx 272000,levels low/medium/high/xhigh,default medium;全部支持图片输入。
//   注意:gpt-5.6(裸 slug)与 codex-1 不存在,官方后端会拒绝,切勿加回。
// qwen3.8-max / qwen3.7-plus / qwen3.7-flash:
//   help.aliyun.com/zh/model-studio/qwen3-8-max — context 1,000,000, 输入模态 Image+Text+Video;
//   help.aliyun.com/zh/model-studio/qwen3-7-plus, qwen3-7-flash — same;
//   help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses —
//   reasoning.effort 支持 none/minimal/low/medium/high/xhigh/max 共 7 档(默认 xhigh);
//   xhigh/max 仅华北2(北京)与新加坡可用,故 default 取 medium(全地域安全)。
const STATIC_CAPS = {
  'gpt-5.6-sol': {
    contextWindow: 372000,
    vision: true,
    levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultLevel: 'low',
  },
  'gpt-5.6-terra': {
    contextWindow: 372000,
    vision: true,
    levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultLevel: 'medium',
  },
  'gpt-5.6-luna': {
    contextWindow: 372000,
    vision: true,
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultLevel: 'medium',
  },
  'gpt-5.5': {
    contextWindow: 272000,
    vision: true,
    levels: ['low', 'medium', 'high', 'xhigh'],
    defaultLevel: 'medium',
  },
  'gpt-5.4': {
    contextWindow: 272000,
    vision: true,
    levels: ['low', 'medium', 'high', 'xhigh'],
    defaultLevel: 'medium',
  },
  'gpt-5.4-mini': {
    contextWindow: 272000,
    vision: true,
    levels: ['low', 'medium', 'high', 'xhigh'],
    defaultLevel: 'medium',
  },
  'gpt-5.2': {
    contextWindow: 272000,
    vision: true,
    levels: ['low', 'medium', 'high', 'xhigh'],
    defaultLevel: 'medium',
  },
  'codex-auto-review': {
    contextWindow: 272000,
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

const CAPS_TTL_MS = 30 * 60 * 1000;
const capsCache = new Map();

export function cacheDiscoveredModels(providerId, models) {
  capsCache.set(providerId, {
    at: Date.now(),
    models: new Map(models.map((model) => [model.id, {
      contextWindow: model.contextWindow,
      vision: model.input?.image,
      reasoning: model.reasoning,
      source: model.source,
    }])),
  });
}

export { capsCache, CAPS_TTL_MS };

// ---------- resolution ----------
// Priority: config.toml [model_overrides] > provider discovery > static > default.
export function resolveCaps(config, provider, modelId) {
  const over = config.model_overrides?.[modelId];
  const cached = capsCache.get(provider.id);
  const fetched = cached?.models?.get(modelId);
  const stat = STATIC_CAPS[modelId] || DEFAULT_CAPS;
  const discoveredVision = typeof fetched?.vision === 'boolean' ? fetched.vision : undefined;
  let source;
  if (over) source = 'config override';
  else if (fetched) source = `provider discovery (${fetched.source || 'unknown'})`;
  else if (STATIC_CAPS[modelId]) source = 'built-in static';
  else source = 'default (unknown model)';
  return {
    contextWindow: over?.context_window ?? fetched?.contextWindow ?? stat.contextWindow,
    vision: !!(over?.vision ?? discoveredVision ?? stat.vision),
    levels: over?.reasoning_efforts ?? (fetched?.reasoning === false ? [] : stat.levels),
    defaultLevel: over?.default_reasoning_effort
      ?? (fetched?.reasoning === false ? null : stat.defaultLevel)
      ?? (stat.levels.includes('medium') ? 'medium' : null),
    source,
  };
}

// ---------- catalog.json entry (codex-rs ModelInfo wire schema) ----------
// Required keys per codex-rs/protocol/src/openai_models.rs + its deserialization tests.
// input_modalities must be explicit: omitted defaults to [text, image] in core.

// 美化模型展示名:qwen3.8-max → "Qwen3.8 Max"(连字符→空格,每词首字母大写)。
// 常见缩写整体大写(gpt → GPT),避免出现 "Gpt" 这种丑写法。
// 只影响展示(display_name);路由用的模型 id(slug)一个字节都不变。
const NAME_ACRONYMS = new Set(['gpt', 'api', 'llm', 'url', 'ws']);
export function prettifyModelName(id) {
  return String(id)
    .split('-')
    .map((w) => {
      if (!w) return w;
      if (NAME_ACRONYMS.has(w.toLowerCase())) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

export function buildCatalogEntry(modelId, caps, provider) {
  const entry = {
    slug: modelId,
    display_name: `${prettifyModelName(modelId)} (${provider.name || provider.id})`,
    description: `${provider.name || provider.id} via codex-switch`,
    supported_reasoning_levels: (caps.levels || []).map((effort) => ({
      effort,
      description: EFFORT_DESCRIPTIONS[effort] || effort,
    })),
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    // 0.144.x 必填字段(无 serde default),已对照 codex-rs rust-v0.144.1
    // codex-rs/protocol/src/openai_models.rs 逐一核对:
    //   base_instructions: String / supports_reasoning_summaries: bool /
    //   supports_parallel_tool_calls: bool / experimental_supported_tools: Vec<String>。
    // 新版本没有的字段被 serde 忽略(ModelInfo 无 deny_unknown_fields),多给无害。
    base_instructions: '',
    supports_reasoning_summaries: true,
    support_verbosity: false,
    truncation_policy: { mode: 'bytes', limit: 10000 },
    supports_parallel_tool_calls: true,
    input_modalities: caps.vision ? ['text', 'image'] : ['text'],
    experimental_supported_tools: [],
    effective_context_window_percent: 95,
    supports_reasoning_summary_parameter: true, // 0.145+ 的字段名;0.144 忽略
    default_reasoning_summary: 'auto',
  };
  if (caps.contextWindow != null) entry.context_window = caps.contextWindow;
  if (caps.defaultLevel) entry.default_reasoning_level = caps.defaultLevel;
  return entry;
}
