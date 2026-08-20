// codex-switch — thin model-id-routing proxy for Codex.
// Pure passthrough: zero body rewriting. Only auth headers are injected/swapped per provider.
//
// Codex points ONE model_provider at this proxy; the proxy routes each request to
// the correct upstream by reading body.model. Body + SSE responses are forwarded byte-for-byte.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';
import { buildCatalogEntry, capsCache, CAPS_TTL_MS, fetchProviderCaps, resolveCaps } from './caps.js';
import { officialCatalog } from './official.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function resolveConfigPath() {
  if (process.env.CODEXSWITCH_CONFIG) return process.env.CODEXSWITCH_CONFIG;
  const local = path.join(__dirname, '..', 'config.local.toml');
  if (fs.existsSync(local)) return local; // 本地覆盖(私有端点等),已在 .gitignore,不进 Git
  return path.join(__dirname, '..', 'config.toml');
}
const CONFIG_PATH = resolveConfigPath();
const PID_FILE = path.join(os.homedir(), '.codex-switch', 'run.pid');
const DEFAULT_LISTEN = '127.0.0.1:8787';
const DEFAULT_MOUNT = '/v1';

// ---------- config + route table (mtime-cached hot reload) ----------
let cfg = null;
let routeTable = new Map();
let cfgMtime = 0;

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function buildRouteTable(c) {
  const m = new Map();
  for (const p of c.providers || []) {
    if (p.enabled === false) continue; // 停用的供应商不进路由表(管理页可重新启用)
    for (const model of p.models || []) {
      if (m.has(model)) {
        console.warn(`[codex-switch] duplicate model '${model}': '${m.get(model).id}' shadowed by '${p.id}'`);
      }
      m.set(model, p);
    }
  }
  // 官方目录自动同步:chatgpt_subscription 供应商自动承接 codex 二进制内嵌官方
  // catalog 里的全部模型(OpenAI 新增模型随 codex 升级自动发现,无需手工维护)。
  // 提取失败时静默跳过,配置里手写的 models 列表仍然生效(回退)。
  const sub = (c.providers || []).find((p) => p.enabled !== false && p.auth === 'chatgpt_subscription');
  if (sub) {
    try {
      const oc = officialCatalog();
      let added = 0;
      for (const slug of oc.models.keys()) {
        if (!m.has(slug)) { m.set(slug, sub); added++; }
      }
      if (oc.models.size) console.log(`[codex-switch] official sync: ${oc.models.size} embedded models (${added} new) via '${sub.id}'`);
    } catch (e) {
      console.warn(`[codex-switch] official catalog sync skipped: ${e.message}`);
    }
  }
  return m;
}

function loadConfig() {
  const stat = fs.statSync(CONFIG_PATH);
  if (cfg && stat.mtimeMs === cfgMtime) return;
  const text = fs.readFileSync(CONFIG_PATH, 'utf8');
  const next = TOML.parse(text);
  cfg = next;
  cfgMtime = stat.mtimeMs;
  routeTable = buildRouteTable(cfg);
  console.log(`[codex-switch] config (re)loaded: ${cfg.providers?.length || 0} providers, ${routeTable.size} models`);
}

function getConfig() {
  loadConfig();
  return cfg;
}
// 二进制指纹:codex 升级(官方新增模型)后无需改配置/重启,路由表自动重建。
// officialCatalog() 内部按 (mtime,size) 缓存,这里只做廉价 stat。
let binFingerprint = '';
function officialFingerprint() {
  try {
    return officialCatalog().sources.map((s) => `${s.bin}:${s.mtimeMs}:${s.modelCount}`).join('|');
  } catch { return ''; }
}
function getRouteTable() {
  loadConfig();
  const fp = officialFingerprint();
  if (fp !== binFingerprint) {
    routeTable = buildRouteTable(cfg);
    binFingerprint = fp;
  }
  return routeTable;
}
function getListenParts() {
  const listen = getConfig().proxy?.listen || DEFAULT_LISTEN;
  const [host, port] = listen.split(':');
  return { host: host || '127.0.0.1', port: Number(port) || 8787 };
}

// ---------- auth.json (read-only, never write, never refresh) ----------
let authCache = { data: null, mtime: 0, p: null };
function readAuthJson() {
  const p = expandHome(getConfig().proxy?.auth_json_path || '~/.codex/auth.json');
  if (!fs.existsSync(p)) return null;
  const stat = fs.statSync(p);
  if (authCache.p === p && stat.mtimeMs === authCache.mtime && authCache.data) return authCache.data;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  authCache = { data, mtime: stat.mtimeMs, p };
  return data;
}

// ---------- auth header plan per provider ----------
// Returns { set: {header:value}, strip: [headerNames...] } relative to incoming request.
function authPlan(provider) {
  const type = provider.auth;
  if (type === 'passthrough') return { set: {}, strip: [] };
  if (type === 'bearer') {
    const token = (provider.token_env && process.env[provider.token_env]) || provider.token;
    if (!token) throw new Error(`provider '${provider.id}': no token (env ${provider.token_env || 'token'} unset)`);
    return { set: { authorization: `Bearer ${token}` }, strip: ['authorization', 'chatgpt-account-id'] };
  }
  if (type === 'chatgpt_subscription') {
    // Keep Codex's OAuth bearer (fresh, managed by Codex). Ensure ChatGPT-Account-ID present.
    const a = readAuthJson();
    const accountId = a?.tokens?.account_id || a?.account_id;
    return { set: accountId ? { 'chatgpt-account-id': String(accountId) } : {}, strip: [] };
  }
  if (type === 'chatgpt_oauth') {
    // Fallback (no requires_openai_auth): strip incoming, inject both from auth.json.
    const a = readAuthJson();
    if (!a?.tokens?.access_token) throw new Error(`provider '${provider.id}': auth.json has no access_token`);
    const set = { authorization: `Bearer ${a.tokens.access_token}` };
    const accountId = a?.tokens?.account_id || a?.account_id;
    if (accountId) set['chatgpt-account-id'] = String(accountId);
    return { set, strip: ['authorization', 'chatgpt-account-id'] };
  }
  throw new Error(`provider '${provider.id}': unknown auth type '${type}'`);
}

// ---------- codex 侧配置:官方订阅检测 + 一键应用/备份/还原 ----------
// 只做管理页展示 + ~/.codex 文件的手术式合并。官方自有配置与模型条目绝对不覆盖:
// 合并时只增删 codex-switch 自己的两段内容,其余字节原样保留。
const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_CFG = path.join(CODEX_DIR, 'config.toml');
const CODEX_CATALOG = path.join(CODEX_DIR, 'catalog.json');
const BACKUP_DIR = path.join(os.homedir(), '.codex-switch', 'backups');
const CATALOG_LINE = 'model_catalog_json = "~/.codex/catalog.json"   # replaces the bundled model catalog';
// 不切换 provider,Codex 仍会把所有请求发给官方 openai;必须整体指向本地代理,
// 由代理按 body.model 路由(官方模型 → chatgpt 后端,其余 → 各自上游)。
const MODEL_PROVIDER_LINE = 'model_provider = "codexswitch"   # codex-switch: route ALL models via the local proxy';

// 官方订阅检测:只做存在性判断,绝不读取/打印任何 token 值。
// 返回登录状态、脱敏账号、官方模型列表(不在本代理路由表中的 catalog 条目)与
// 官方配置段名(除 [model_providers.codexswitch] 外的所有段),供页面展示与保护。
function maskIdentity(id) {
  if (!id) return null;
  const s = String(id);
  const at = s.indexOf('@');
  if (at > 0) return s.slice(0, 2) + '***' + s.slice(at); // 邮箱:只露前 2 字符
  return s.length <= 4 ? s : '••••' + s.slice(-4); // 非邮箱 id:只露末 4 位
}

function detectOfficial() {
  const auth = readAuthJson();
  const loggedIn = !!(auth?.tokens?.access_token);
  const identity = maskIdentity(
    auth?.tokens?.account?.email || auth?.email || auth?.tokens?.account_id || auth?.account_id
  );
  const sections = [];
  if (fs.existsSync(CODEX_CFG)) {
    const re = /^\s*\[([^\]]+)\]\s*$/gm;
    let m;
    while ((m = re.exec(fs.readFileSync(CODEX_CFG, 'utf8'))) !== null) {
      const name = m[1].trim();
      if (name !== 'model_providers.codexswitch') sections.push(name);
    }
  }
  let officialModels = [];
  if (fs.existsSync(CODEX_CATALOG)) {
    try {
      const mine = new Set(getRouteTable().keys());
      const cat = JSON.parse(fs.readFileSync(CODEX_CATALOG, 'utf8'));
      officialModels = (cat.models || []).map((x) => x.slug).filter((s) => s && !mine.has(s));
    } catch { officialModels = []; }
  }
  // 官方内嵌目录自动同步状态(来源二进制 + 模型清单),供管理页展示
  let embeddedCatalog = null;
  try {
    const oc = officialCatalog();
    if (oc.models.size) {
      embeddedCatalog = {
        modelCount: oc.models.size,
        slugs: [...oc.models.keys()],
        sources: oc.sources.map((s) => ({ bin: s.bin, models: s.modelCount, mtimeMs: s.mtimeMs })),
      };
    }
  } catch { embeddedCatalog = null; }
  return {
    loggedIn,
    identity,
    authPath: expandHome(getConfig().proxy?.auth_json_path || '~/.codex/auth.json'),
    catalogExists: fs.existsSync(CODEX_CATALOG),
    configSections: sections,
    officialModels,
    embeddedCatalog,
  };
}

// [model_providers.codexswitch] TOML 块,页面展示与合并写入共用同一份
function codexProviderBlock() {
  const c = getConfig();
  const { host, port } = getListenParts();
  const mountPrefix = (c.proxy?.mount_prefix || DEFAULT_MOUNT).replace(/\/+$/, '');
  const base_url = `http://${host}:${port}${mountPrefix}`;
  return `[model_providers.codexswitch]
name = "codex-switch"
base_url = "${base_url}"
wire_api = "responses"
requires_openai_auth = true   # Codex manages OAuth refresh + carries subscription headers
`;
}

// 手术式合并 ~/.codex/config.toml:
//  - model_provider 行:已有则替换该行,没有则插到文件头部
//  - model_catalog_json 行:已有则替换该行,没有则插到文件头部
//  - [model_providers.codexswitch] 段:已有旧段则整段替换,没有则追加到文件末尾
//  其余所有字节原样保留(官方配置绝对不覆盖)。
function mergeCodexConfigToml(existing) {
  const lines = existing.split('\n');
  const mpIdx = lines.findIndex((l) => /^\s*model_provider\s*=/.test(l));
  if (mpIdx >= 0) lines[mpIdx] = MODEL_PROVIDER_LINE;
  else lines.unshift(MODEL_PROVIDER_LINE);
  const cfgIdx = lines.findIndex((l) => /^\s*model_catalog_json\s*=/.test(l));
  if (cfgIdx >= 0) lines[cfgIdx] = CATALOG_LINE;
  else lines.unshift(CATALOG_LINE);
  const blockLines = codexProviderBlock().trimEnd().split('\n');
  const hdrIdx = lines.findIndex((l) => l.trim() === '[model_providers.codexswitch]');
  if (hdrIdx >= 0) {
    let end = hdrIdx + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    lines.splice(hdrIdx, end - hdrIdx, ...blockLines);
  } else {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(...blockLines, '');
  }
  return lines.join('\n');
}

// 官方模型条目镜像:以 codex 二进制内嵌条目为底,逐字段保留官方原值
// (additional_speed_tiers/service_tiers=快速模式,model_messages=官方系统提示,
//  context_window/truncation/verbosity/... 全部 1:1),只改三处:
//  1) display_name 追加供应商名(页面可辨认走的是哪个供应商);
//  2) description 追加 via codex-switch 标记;
//  3) prefer_websockets 强制关:官方 wss 传输指向 chatgpt.com,本地代理是纯 HTTP。
function mirrorOfficialEntry(entry, provider) {
  const e = JSON.parse(JSON.stringify(entry));
  e.display_name = `${entry.display_name || entry.slug} (${provider.name || provider.id})`;
  e.description = entry.description ? `${entry.description} · via codex-switch` : `via codex-switch (${provider.name || provider.id})`;
  e.prefer_websockets = false;
  return e;
}

// 合并 ~/.codex/catalog.json:保留所有官方条目(其 slug 不在本代理路由表内的
// 全部原样保留),追加 codex-switch 代理的模型条目。官方 slug 用镜像条目
// (百分百精确),非官方模型(qwen 等)用合成条目。
function mergeCatalog(existingText) {
  const mine = new Set(getRouteTable().keys());
  const oc = officialCatalog();
  let cat = { models: [] };
  if (existingText) {
    try { cat = JSON.parse(existingText); } catch { cat = { models: [] }; }
  }
  // 保留非本代理路由的条目(真正的官方内容绝不覆盖);但清掉我们自己的过期条目
  // (description 含 via codex-switch 标记且已不在路由表中,例如失效的旧模型 id),
  // 否则它们会残留在选择器里继续被官方后端拒绝。
  const kept = (Array.isArray(cat.models) ? cat.models : [])
    .filter((x) => x?.slug && !mine.has(x.slug))
    .filter((x) => !String(x.description || '').includes('via codex-switch'));
  const c = getConfig();
  for (const [id, prov] of getRouteTable().entries()) {
    const off = oc.models.get(id);
    if (off) kept.push(mirrorOfficialEntry(off, prov));
    else kept.push(buildCatalogEntry(id, resolveCaps(c, prov, id), prov));
  }
  return JSON.stringify({ ...cat, models: kept }, null, 2) + '\n';
}

// ---------- 备份 / 还原 ----------
// 备份:应用前把目标文件复制到 ~/.codex-switch/backups/<原名>.<时间戳>.<序号>.bak
// 还原:按原文件名取最新一份备份覆盖回 ~/.codex/。
function backupTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function backupFile(p) {
  if (!fs.existsSync(p)) return null; // 原本就不存在,写新文件无需备份
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const base = path.basename(p);
  let n = 0;
  let dest;
  do {
    n += 1;
    dest = path.join(BACKUP_DIR, `${base}.${backupTimestamp()}.${String(n).padStart(3, '0')}.bak`);
  } while (fs.existsSync(dest));
  fs.copyFileSync(p, dest);
  return dest;
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.bak'))
    .map((f) => {
      const m = f.match(/^(.+)\.(\d{14})\.(\d{3})\.bak$/);
      return { file: f, original: m ? m[1] : f, at: m ? m[2] : '' };
    })
    .sort((a, b) => (a.at === b.at ? a.file.localeCompare(b.file) : b.at.localeCompare(a.at)));
}

function restoreLatest() {
  const restored = [];
  for (const original of [path.basename(CODEX_CFG), path.basename(CODEX_CATALOG)]) {
    const b = listBackups().find((x) => x.original === original);
    if (!b) continue;
    fs.copyFileSync(path.join(BACKUP_DIR, b.file), path.join(CODEX_DIR, original));
    restored.push({ file: original, from: b.file });
  }
  return restored;
}

// 合并后的 catalog.json 内容校验(写入 ~/.codex 前必过):
// JSON 可解析 + 每个模型条目具备 codex-rs rust-v0.144.1 ModelInfo 无默认必填字段,
// 且取值类型/枚举合法。官方条目(非本代理路由)只做基本结构校验;严格校验只针对
// codex-switch 自己生成的条目。校验不过绝不落盘 —— Codex 读到坏 catalog 会拒绝启动对话。
function validateCatalogJson(text, mine) {
  let cat;
  try { cat = JSON.parse(text); } catch (e) {
    return { ok: false, error: `catalog.json 不是合法 JSON: ${e.message}` };
  }
  if (!cat || !Array.isArray(cat.models)) return { ok: false, error: 'catalog.json 缺少顶层 models 数组' };
  const REQUIRED = ['slug', 'display_name', 'supported_reasoning_levels', 'shell_type', 'visibility',
    'supported_in_api', 'priority', 'base_instructions', 'supports_reasoning_summaries',
    'support_verbosity', 'truncation_policy', 'supports_parallel_tool_calls', 'experimental_supported_tools'];
  const SHELL_TYPES = ['default', 'local', 'unified_exec', 'disabled', 'shell_command'];
  const VISIBILITY = ['list', 'hide', 'none'];
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const MODES = ['bytes', 'tokens'];
  const MODALITIES = ['text', 'image'];
  for (const m of cat.models) {
    if (!m || typeof m !== 'object' || typeof m.slug !== 'string') {
      return { ok: false, error: 'models 数组含非法条目(需对象且 slug 为字符串)' };
    }
    if (!mine.has(m.slug)) continue; // 官方条目:只查基本结构,绝不因我们的校验拒绝官方内容
    const miss = REQUIRED.filter((k) => m[k] === undefined);
    if (miss.length) return { ok: false, error: `模型 '${m.slug}' 缺少必填字段: ${miss.join(', ')}` };
    if (!Number.isInteger(m.priority)) return { ok: false, error: `模型 '${m.slug}' 的 priority 必须是整数` };
    if (typeof m.supported_in_api !== 'boolean' || typeof m.support_verbosity !== 'boolean'
      || typeof m.supports_parallel_tool_calls !== 'boolean' || typeof m.supports_reasoning_summaries !== 'boolean') {
      return { ok: false, error: `模型 '${m.slug}' 的布尔字段类型不合法` };
    }
    if (!SHELL_TYPES.includes(m.shell_type) || !VISIBILITY.includes(m.visibility)) {
      return { ok: false, error: `模型 '${m.slug}' 的 shell_type/visibility 取值不合法` };
    }
    if (typeof m.truncation_policy !== 'object' || !MODES.includes(m.truncation_policy?.mode)
      || !Number.isFinite(m.truncation_policy?.limit)) {
      return { ok: false, error: `模型 '${m.slug}' 的 truncation_policy 必须含 mode(bytes|tokens) 与数字 limit` };
    }
    for (const lv of m.supported_reasoning_levels) {
      if (typeof lv?.effort !== 'string' || !EFFORTS.includes(lv.effort) || typeof lv?.description !== 'string') {
        return { ok: false, error: `模型 '${m.slug}' 的 supported_reasoning_levels 含非法条目(需 effort 枚举 + description 字符串)` };
      }
    }
    if (m.input_modalities !== undefined && (!Array.isArray(m.input_modalities)
      || m.input_modalities.some((im) => !MODALITIES.includes(im)))) {
      return { ok: false, error: `模型 '${m.slug}' 的 input_modalities 取值非法(仅 text/image)` };
    }
    if (m.default_reasoning_level !== undefined && !EFFORTS.includes(m.default_reasoning_level)) {
      return { ok: false, error: `模型 '${m.slug}' 的 default_reasoning_level 取值非法` };
    }
  }
  return { ok: true };
}

// 一键应用:合并 → 内容校验(TOML/JSON/ModelInfo 必填字段)→ 全部通过才备份并写入。
// 校验失败返回 {ok:false,...},绝不写半个坏文件。
function applyToCodex() {
  const before = detectOfficial();
  const cfgExisted = fs.existsSync(CODEX_CFG);
  const mergedCfg = mergeCodexConfigToml(cfgExisted ? fs.readFileSync(CODEX_CFG, 'utf8') : '');
  try { TOML.parse(mergedCfg); } catch (e) {
    return { ok: false, error: '合并后的 ~/.codex/config.toml 不是合法 TOML,未写入任何文件', detail: String(e.message) };
  }
  const existingCat = fs.existsSync(CODEX_CATALOG) ? fs.readFileSync(CODEX_CATALOG, 'utf8') : '';
  const mergedCat = mergeCatalog(existingCat);
  // 严格校验只针对我们合成的条目(qwen 等);官方镜像条目逐字节来自官方二进制,
  // 结构天然合法,绝不因我们的校验规则拒绝官方内容。
  const oc = officialCatalog();
  const officialSynced = [...getRouteTable().keys()].filter((s) => oc.models.has(s));
  const strictMine = new Set([...getRouteTable().keys()].filter((s) => !oc.models.has(s)));
  const v = validateCatalogJson(mergedCat, strictMine);
  if (!v.ok) return { ok: false, error: '合并后的 catalog.json 校验失败,未写入任何文件', detail: v.error };

  const backups = [];
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  const b1 = backupFile(CODEX_CFG);
  if (b1) backups.push({ file: path.basename(CODEX_CFG), backup: path.basename(b1) });
  fs.writeFileSync(CODEX_CFG, mergedCfg);
  const b2 = backupFile(CODEX_CATALOG);
  if (b2) backups.push({ file: path.basename(CODEX_CATALOG), backup: path.basename(b2) });
  fs.writeFileSync(CODEX_CATALOG, mergedCat);

  const after = detectOfficial();
  const preserved = {
    configSectionsBefore: before.configSections.length,
    configSectionsAfter: after.configSections.length,
    officialModelsBefore: before.officialModels.length,
    officialModelsAfter: after.officialModels.length,
    officialModels: after.officialModels,
  };
  preserved.officialSyncedModels = officialSynced;
  console.log(`[codex-switch] codex-apply: backups=${backups.length}, sections ${preserved.configSectionsBefore}→${preserved.configSectionsAfter}, official models ${preserved.officialModelsBefore}→${preserved.officialModelsAfter}, mirrored from binaries: ${officialSynced.length}`);
  return { ok: true, backups, preserved };
}

// ---------- capability refresh (Bailian live model list, cached 30 min) ----------
// Fetches context_window / input modalities from the Bailian native /api/v1/models
// for providers that are DashScope endpoints; other providers are skipped (static
// table in caps.js covers them). Never touches request forwarding — catalog only.
async function refreshAllCaps(force) {
  const results = [];
  for (const provider of getConfig().providers || []) {
    if (provider.enabled === false) continue; // 停用的供应商不联网拉能力
    if (!force) {
      const cached = capsCache.get(provider.id);
      if (cached && Date.now() - cached.at < CAPS_TTL_MS) {
        results.push({ provider: provider.id, status: 'cached', models: cached.models.size });
        continue;
      }
    }
    try {
      const models = await fetchProviderCaps(provider);
      if (models === null) {
        results.push({ provider: provider.id, status: 'skipped' });
      } else {
        capsCache.set(provider.id, { at: Date.now(), models });
        results.push({ provider: provider.id, status: 'ok', models: models.size });
      }
    } catch (e) {
      results.push({ provider: provider.id, status: 'error', detail: String(e.message) });
    }
  }
  console.log(`[codex-switch] caps refresh: ${results.map((r) => `${r.provider}=${r.status}`).join(', ')}`);
  return results;
}

// ---------- helpers ----------
const HOP_BY_HOP = new Set([
  'host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding',
  'upgrade', 'proxy-connection', 'te', 'trailer', 'expect',
]);

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- proxy forward ----------
async function forwardToUpstream(req, bodyBuf, provider, suffix, res) {
  const upstreamUrl = provider.base_url.replace(/\/+$/, '') + suffix;
  const plan = authPlan(provider);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (plan.strip.includes(lk)) continue;
    if (plan.set[lk] !== undefined) continue; // we'll set our own
    headers[lk] = v;
  }
  for (const [k, v] of Object.entries(plan.set)) headers[k] = v;

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuf,
    });
  } catch (e) {
    sendJson(res, 502, { error: 'upstream connect failed', detail: String(e.message), upstream: upstreamUrl });
    return;
  }

  const outHeaders = {};
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) return;
    // streaming raw bytes: drop length/encoding (fetch may have decompressed)
    if (lk === 'content-length' || lk === 'content-encoding') return;
    outHeaders[k] = v;
  });
  res.writeHead(upstream.status, outHeaders);

  if (upstream.body) {
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => { try { res.destroy(); } catch {} });
    nodeStream.pipe(res);
  } else {
    res.end();
  }
}

async function handleProxy(req, bodyBuf, res) {
  const mountPrefix = getConfig().proxy?.mount_prefix || DEFAULT_MOUNT;
  const url = new URL(req.url, 'http://x');
  let suffix = url.pathname;
  if (suffix.startsWith(mountPrefix)) suffix = suffix.slice(mountPrefix.length);
  if (!suffix.startsWith('/')) suffix = '/' + suffix;
  suffix += url.search || '';

  // GET /models → aggregate all enabled models (so Codex can discover without catalog.json)
  if (req.method === 'GET' && (suffix === '/models' || suffix === '/models/')) {
    const data = [];
    for (const [id, prov] of getRouteTable().entries()) {
      data.push({ id, object: 'model', owned_by: prov.id });
    }
    return sendJson(res, 200, { object: 'list', data });
  }

  // route by body.model
  let modelId = null;
  if (bodyBuf && bodyBuf.length) {
    try { modelId = JSON.parse(bodyBuf.toString('utf8')).model || null; } catch { /* non-JSON body */ }
  }
  if (!modelId) return sendJson(res, 502, { error: 'no model in request body, cannot route', path: suffix });

  const provider = getRouteTable().get(modelId);
  if (!provider) return sendJson(res, 502, { error: `no provider for model '${modelId}'` });

  return forwardToUpstream(req, bodyBuf, provider, suffix, res);
}

// ---------- provider CRUD + 配置历史(管理页用) ----------
// 设计:providers 仍然住在 config.toml(代理的唯一事实来源),管理页通过
// 「区块手术」只重写 [[providers]] 区域,文件其余部分([proxy]、
// [model_overrides]、尾部注释)逐字节保留。每次改动前先把当前
// config.toml 快照进 ~/.codex-switch/history/,供「配置历史」逐个还原。
const HISTORY_DIR = path.join(os.homedir(), '.codex-switch', 'history');

function tomlStr(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// 把 providers 数组序列化为 [[providers]] 区块文本(每块带一行可读注释)
function buildProvidersRegion(providers) {
  const blocks = providers.map((p) => {
    const lines = [];
    lines.push(`# ${p.name || p.id} (${p.auth})${p.enabled === false ? ' — 已停用' : ''}`);
    lines.push('[[providers]]');
    lines.push(`id = ${tomlStr(p.id)}`);
    lines.push(`name = ${tomlStr(p.name || p.id)}`);
    lines.push(`base_url = ${tomlStr(p.base_url || '')}`);
    lines.push(`auth = ${tomlStr(p.auth || 'bearer')}`);
    if (p.token_env) lines.push(`token_env = ${tomlStr(p.token_env)}`);
    if (p.token) lines.push(`token = ${tomlStr(p.token)}`);
    lines.push(`models = [${(p.models || []).map(tomlStr).join(', ')}]`);
    lines.push(`enabled = ${p.enabled === false ? 'false' : 'true'}`);
    return lines.join('\n');
  });
  return blocks.join('\n\n');
}

// 在完整 config 文本里只替换 providers 区域,其余原样保留。
// 区域 = 第一个 [[providers]] 头 ~ 最后一个 provider 块的最后一个键值行;
// 其后的注释/其它段(如 model_overrides 文档)全部留在 after 里不动。
function replaceProvidersRegion(text, providers) {
  const lines = text.split('\n');
  const heads = [];
  lines.forEach((l, i) => { if (l.trim() === '[[providers]]') heads.push(i); });
  const region = buildProvidersRegion(providers);
  if (!heads.length) {
    return text.replace(/\s+$/, '') + '\n\n' + region + '\n';
  }
  const start = heads[0];
  const lastStart = heads[heads.length - 1];
  let lastKV = lastStart;
  for (let i = lastStart + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('[')) break; // 下一个段(非 providers)
    if (t !== '' && !t.startsWith('#') && t.includes('=')) lastKV = i;
  }
  const before = lines.slice(0, start);
  const after = lines.slice(lastKV + 1);
  // 剥掉 before 尾部紧贴 providers 的注释/空行(避免留下失配旧注释)
  while (before.length) {
    const t = before[before.length - 1].trim();
    if (t === '' || t.startsWith('#')) before.pop(); else break;
  }
  const parts = [...before, '', region, ''];
  while (after.length && after[0].trim() === '') after.shift();
  if (after.length) parts.push(...after);
  return parts.join('\n');
}

// 改动前快照当前 config.toml → 配置历史
function snapshotConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const ts = backupTimestamp();
  let n = 0;
  let dest;
  do {
    n += 1;
    dest = path.join(HISTORY_DIR, `config.${ts}.${String(n).padStart(3, '0')}.toml`);
  } while (fs.existsSync(dest));
  fs.copyFileSync(CONFIG_PATH, dest);
  return dest;
}

function listHistory() {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  return fs.readdirSync(HISTORY_DIR)
    .filter((f) => /^config\.\d{14}\.\d{3}\.toml$/.test(f))
    .map((f) => {
      const m = f.match(/^config\.(\d{14})\.(\d{3})\.toml$/);
      const size = fs.statSync(path.join(HISTORY_DIR, f)).size;
      return { file: f, time: m[1], seq: m[2], size };
    })
    .sort((a, b) => (a.time === b.time ? b.seq.localeCompare(a.seq) : b.time.localeCompare(a.time)));
}

function restoreHistory(file) {
  const safe = path.basename(file);
  const src = path.join(HISTORY_DIR, safe);
  if (!fs.existsSync(src)) throw new Error(`快照不存在: ${safe}`);
  const text = fs.readFileSync(src, 'utf8');
  try { TOML.parse(text); } catch (e) { throw new Error(`快照不是合法 TOML,拒绝还原: ${e.message}`); }
  snapshotConfig(); // 先给当前状态留一份后悔药
  fs.writeFileSync(CONFIG_PATH, text);
  cfgMtime = 0; loadConfig();
  return safe;
}

// 规范化前端提交的 provider 对象(models 支持数组或逗号/换行分隔字符串)
function normalizeProvider(p) {
  const id = String(p.id || '').trim();
  if (!id) throw new Error('provider id 不能为空');
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error(`provider id 只能含字母/数字/_/-/.(收到 '${id}')`);
  const auth = String(p.auth || 'bearer').trim();
  if (!['bearer', 'chatgpt_subscription', 'chatgpt_oauth', 'passthrough'].includes(auth)) {
    throw new Error(`未知 auth 类型 '${auth}'`);
  }
  const rawModels = Array.isArray(p.models) ? p.models : String(p.models || '').split(/[\n,，;]+/);
  const models = [...new Set(rawModels.map((m) => String(m).trim()).filter(Boolean))];
  const o = {
    id,
    name: String(p.name || id).trim(),
    base_url: String(p.base_url || '').trim(),
    auth,
  };
  if (auth === 'bearer' || auth === 'chatgpt_oauth') {
    if (p.token_env && String(p.token_env).trim()) o.token_env = String(p.token_env).trim();
    if (p.token && String(p.token).trim()) o.token = String(p.token).trim();
  }
  o.models = models;
  o.enabled = !(p.enabled === false || p.enabled === 'false');
  return o;
}

// 所有 provider 变更的统一通道:解析 → 变更 → 重组 TOML → 校验 → 快照 → 写盘 → 热重载
function mutateProviders(fn) {
  loadConfig();
  const providers = (cfg.providers || []).map((p) => ({ ...p }));
  const result = fn(providers);
  const existing = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : '';
  const text = replaceProvidersRegion(existing, providers);
  try { TOML.parse(text); } catch (e) {
    throw new Error(`内部错误:重组后的 config 不是合法 TOML,未写入: ${e.message}`);
  }
  snapshotConfig();
  fs.writeFileSync(CONFIG_PATH, text);
  cfgMtime = 0; loadConfig();
  refreshAllCaps(true).catch((e) => console.warn(`[codex-switch] caps refresh failed: ${e.message}`));
  return result;
}

function requireBearerCred(np) {
  if (np.auth === 'bearer' && !np.token_env && !np.token) {
    throw new Error(`provider '${np.id}': bearer 认证需要填写 token_env(环境变量名)`);
  }
}

function addProvider(p) {
  const np = normalizeProvider(p);
  requireBearerCred(np);
  return mutateProviders((providers) => {
    if (providers.some((x) => x.id === np.id)) throw new Error(`provider '${np.id}' 已存在`);
    providers.push(np);
    return { ok: true, id: np.id };
  });
}

function updateProvider(origId, p) {
  const np = normalizeProvider(p);
  return mutateProviders((providers) => {
    const i = providers.findIndex((x) => x.id === origId);
    if (i === -1) throw new Error(`未找到 provider '${origId}'`);
    if (np.id !== origId && providers.some((x) => x.id === np.id)) throw new Error(`provider '${np.id}' 已存在`);
    const orig = providers[i];
    // 密钥绝不回传前端;编辑时若未重新提供凭证,沿用原有 token/token_env
    if (!np.token && !np.token_env) {
      if (orig.token) np.token = orig.token;
      if (orig.token_env) np.token_env = orig.token_env;
    }
    requireBearerCred(np);
    providers[i] = np;
    return { ok: true, id: np.id };
  });
}

function toggleProvider(id, enabled) {
  return mutateProviders((providers) => {
    const p = providers.find((x) => x.id === id);
    if (!p) throw new Error(`未找到 provider '${id}'`);
    p.enabled = !!enabled;
    return { ok: true, id, enabled: p.enabled };
  });
}

function deleteProvider(id) {
  return mutateProviders((providers) => {
    const i = providers.findIndex((x) => x.id === id);
    if (i === -1) throw new Error(`未找到 provider '${id}'`);
    providers.splice(i, 1);
    return { ok: true, id };
  });
}

// 已启用供应商模型的并集(Codex 实际可见的模型集合)。
// 直接取路由表:含官方内嵌目录自动同步进来的模型。
function enabledUnion() {
  const c = getConfig();
  const enabled = (c.providers || []).filter((p) => p.enabled !== false);
  return { providers: enabled.length, total: (c.providers || []).length, models: [...getRouteTable().keys()] };
}

// ---------- admin ----------
function generateCodexConfig() {
  const c = getConfig();
  const configToml = `# --- codex-switch: add to ~/.codex/config.toml (or click "应用并备份" below) ---
${CATALOG_LINE}

${codexProviderBlock().trimEnd()}
`;
  const oc = officialCatalog();
  const catalog = { models: [] };
  for (const [id, prov] of getRouteTable().entries()) {
    const off = oc.models.get(id);
    if (off) catalog.models.push(mirrorOfficialEntry(off, prov));
    else catalog.models.push(buildCatalogEntry(id, resolveCaps(c, prov, id), prov));
  }
  return { config_toml: configToml, catalog_json: JSON.stringify(catalog, null, 2) };
}

function renderAdminPage() {
  const { host, port } = getListenParts();
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>codex-switch · 供应商管理</title>
<style>
:root{
  --bg:#0a0c10; --bg2:#0e1117; --panel:#12161f; --panel2:#171c28;
  --border:#232a38; --border2:#2f3950;
  --text:#e8ebf2; --muted:#8a93a6; --faint:#5d6678;
  --accent:#6d8dff; --accent2:#93aaff;
  --ok:#3ddc97; --warn:#ffc861; --err:#ff6b7a;
  --mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;
}
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;
  background:radial-gradient(1100px 520px at 75% -10%,rgba(109,141,255,.09),transparent 60%),
             radial-gradient(800px 400px at -10% 110%,rgba(61,220,151,.05),transparent 55%),var(--bg);
  min-height:100vh}
::selection{background:rgba(109,141,255,.32)}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:6px}
::-webkit-scrollbar-track{background:transparent}
.mono{font-family:var(--mono);font-size:.8rem}
.muted{color:var(--muted)}
.ok{color:var(--ok)}
.err{color:var(--err)}
.note{margin:.2rem 0 0;font-size:.8rem;color:var(--faint);line-height:1.7}
.hint{color:var(--faint);font-size:.8rem}

.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:1rem;
  padding:.7rem 1.5rem;background:rgba(10,12,16,.78);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:.55rem;font-weight:650;font-size:1.02rem;white-space:nowrap}
.brand .logo{width:22px;height:22px;color:var(--accent);flex:none}
.brand .sub{color:var(--faint);font-weight:400;font-size:.78rem;margin-left:.2rem}
.tabs{display:flex;gap:.25rem;background:var(--panel);border:1px solid var(--border);padding:.25rem;border-radius:11px;margin:0 auto}
.tabbtn{cursor:pointer;font:inherit;font-size:.85rem;color:var(--muted);background:transparent;border:none;
  padding:.35rem 1rem;border-radius:8px;transition:.15s;white-space:nowrap}
.tabbtn:hover{color:var(--text)}
.tabbtn.active{background:var(--panel2);color:var(--text);font-weight:600;box-shadow:inset 0 0 0 1px var(--border2)}
.chips{display:flex;gap:.45rem;align-items:center}
.chip{font:11.5px/1.6 var(--mono);color:var(--muted);border:1px solid var(--border);background:var(--panel);
  padding:.18rem .6rem;border-radius:999px;white-space:nowrap}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--faint);margin-right:.4rem;vertical-align:1px}
.dot.on{background:var(--ok);box-shadow:0 0 8px var(--ok)}

main{max-width:1080px;margin:1.5rem auto 2.5rem;padding:0 1.25rem}
.pane{display:flex;flex-direction:column;gap:1rem}
.pane-head{display:flex;justify-content:space-between;align-items:flex-end;gap:1rem;flex-wrap:wrap}
.pane-head h2{margin:0;font-size:1.18rem;font-weight:700}
.pane-actions{display:flex;gap:.6rem}

.btn{cursor:pointer;font:inherit;font-size:.84rem;color:var(--text);background:var(--panel2);border:1px solid var(--border2);
  padding:.42rem 1rem;border-radius:9px;transition:border-color .15s,color .15s,background .15s,transform .05s;white-space:nowrap}
.btn:hover{border-color:var(--accent);color:var(--accent2)}
.btn:active{transform:translateY(1px)}
.btn:disabled{opacity:.5;cursor:default}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#0a0c10;font-weight:650}
.btn.primary:hover{background:var(--accent2);border-color:var(--accent2);color:#0a0c10}
.btn.danger:hover{border-color:var(--err);color:var(--err)}
.btn.small{font-size:.78rem;padding:.3rem .8rem}

.union-bar{font-size:.86rem;margin-top:.3rem}
.union-bar b{color:var(--accent2)}
.union-chips{display:flex;flex-wrap:wrap;gap:.35rem;padding:.8rem .95rem;background:var(--bg2);
  border:1px solid var(--border);border-radius:12px}
.mtag{display:inline-block;font:11.5px/1.6 var(--mono);padding:.08rem .5rem;border-radius:6px;
  background:rgba(109,141,255,.1);border:1px solid rgba(109,141,255,.28);color:var(--accent2);white-space:nowrap}

.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:.9rem}
.pcard{background:linear-gradient(180deg,var(--panel),var(--bg2));border:1px solid var(--border);border-radius:14px;
  padding:1rem 1.15rem;display:flex;flex-direction:column;gap:.55rem;transition:border-color .15s,opacity .15s}
.pcard:hover{border-color:var(--border2)}
.pcard.off{opacity:.6}
.pcard-top{display:flex;justify-content:space-between;align-items:center;gap:.6rem}
.pcard-id{display:flex;align-items:center;gap:.5rem;min-width:0}
.pcard-id b{font-size:.98rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pid{font:11px/1.6 var(--mono);color:var(--faint);background:var(--panel2);border:1px solid var(--border);
  border-radius:5px;padding:0 .4rem;white-space:nowrap}
.pcard-row{display:flex;align-items:baseline;gap:.5rem;font-size:.8rem;min-width:0}
.pcard-row .lbl{color:var(--faint);font-size:.7rem;text-transform:uppercase;letter-spacing:.07em;flex:none;width:3.2em}
.pcard-row .url{word-break:break-all;color:var(--muted)}
.cred{color:var(--faint);font:11px/1.6 var(--mono)}
.warn-text{color:var(--warn);font-size:.75rem}
.pcard-models{display:flex;flex-wrap:wrap;gap:.3rem;min-height:1.6em}
.pcard-actions{display:flex;gap:.5rem;margin-top:.2rem;padding-top:.7rem;border-top:1px solid var(--border)}

.switch{position:relative;display:inline-block;width:38px;height:22px;flex:none}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:var(--border2);border-radius:999px;transition:.18s;cursor:pointer}
.slider:before{content:'';position:absolute;width:16px;height:16px;left:3px;top:3px;background:#cfd6e4;border-radius:50%;transition:.18s}
.switch input:checked + .slider{background:var(--ok)}
.switch input:checked + .slider:before{transform:translateX(16px);background:#08130d}

.empty{border:1px dashed var(--border2);border-radius:14px;padding:2.4rem 1rem;text-align:center;color:var(--faint)}

.hrow{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.72rem 1rem;
  border:1px solid var(--border);border-radius:11px;background:var(--panel);margin-bottom:.55rem}
.hrow:hover{border-color:var(--border2)}
.hinfo{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;min-width:0}
.htime{font-weight:600}
.hseq,.hsize{color:var(--faint);font-size:.78rem;font-family:var(--mono)}
.hfile{color:var(--faint);font-size:.72rem;word-break:break-all}

.card{background:linear-gradient(180deg,var(--panel),var(--bg2));border:1px solid var(--border);border-radius:14px;
  padding:1.15rem 1.35rem;box-shadow:inset 0 1px 0 rgba(255,255,255,.03),0 8px 24px rgba(0,0,0,.25)}
.card-head{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap;margin-bottom:.6rem}
.card-head h2{margin:0;font-size:1rem;font-weight:650;display:flex;align-items:center;gap:.5rem}
.bar{display:inline-block;width:4px;height:.95em;border-radius:2px;background:var(--accent);flex:none}
.status{font-size:.85rem;min-height:1.4em;margin-top:.55rem}
.badge{display:inline-block;font-size:.72rem;line-height:1.5;padding:.1rem .55rem;border-radius:999px;
  border:1px solid var(--border2);color:var(--muted);background:var(--panel2);white-space:nowrap}
.badge.ok{color:var(--ok);border-color:rgba(61,220,151,.4);background:rgba(61,220,151,.08)}
.badge.warn{color:var(--warn);border-color:rgba(255,200,97,.4);background:rgba(255,200,97,.08)}
table{width:100%;border-collapse:collapse;font-size:.85rem}
td{padding:.5rem .6rem;border-bottom:1px solid rgba(35,42,56,.6);vertical-align:top}
tbody tr:last-child td{border-bottom:none}
.kv td:first-child{color:var(--faint);width:120px;font-size:.72rem;text-transform:uppercase;letter-spacing:.07em}
#backupList{margin-top:.7rem;font-size:.8rem;color:var(--muted)}
#backupList ul{margin:.4rem 0 0;padding-left:1.15rem;columns:2;column-gap:2.2rem}
#backupList li{margin:.18rem 0;font:11.5px/1.6 var(--mono);color:var(--faint);break-inside:avoid}
details{border:1px solid var(--border);border-radius:10px;padding:.55rem .95rem;margin-top:.65rem;background:var(--bg2)}
summary{cursor:pointer;font-size:.82rem;color:var(--muted);user-select:none;list-style:none;display:flex;align-items:center;gap:.5rem}
summary::-webkit-details-marker{display:none}
summary:before{content:'▸';color:var(--faint);transition:transform .15s;flex:none}
details[open] summary:before{transform:rotate(90deg)}
pre{font-family:var(--mono);font-size:.75rem;line-height:1.6;background:#0b0e14;border:1px solid var(--border);
  border-radius:10px;padding:.9rem 1rem;overflow:auto;max-height:420px;margin:.6rem 0 0}

#modalWrap{position:fixed;inset:0;z-index:50;background:rgba(5,8,12,.66);backdrop-filter:blur(4px);
  display:flex;align-items:flex-start;justify-content:center;padding:7vh 1rem 2rem;overflow:auto}
#modal{width:min(580px,100%);background:var(--panel);border:1px solid var(--border2);border-radius:16px;
  padding:1.25rem 1.4rem;box-shadow:0 24px 64px rgba(0,0,0,.5)}
.modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:.4rem}
.modal-head b{font-size:1.05rem}
.xbtn{cursor:pointer;background:none;border:none;color:var(--faint);font-size:1rem;padding:.2rem .4rem;border-radius:6px}
.xbtn:hover{color:var(--text);background:var(--panel2)}
.frow{margin:.8rem 0}
.frow > label{display:block;font-size:.72rem;color:var(--faint);margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.07em}
.frow input,.frow select,.frow textarea{width:100%;background:#0b0e14;color:var(--text);border:1px solid var(--border);
  border-radius:9px;padding:.5rem .7rem;font:inherit;font-size:.88rem}
.frow input:focus,.frow select:focus,.frow textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(109,141,255,.14)}
.frow input.mono{font-family:var(--mono);font-size:.8rem}
.frow textarea{resize:vertical;font-family:var(--mono);font-size:.8rem;line-height:1.7}
.fhint{font-size:.72rem;color:var(--faint);margin-top:.3rem}
label.ck{display:flex;align-items:center;gap:.5rem;font-size:.9rem;cursor:pointer;text-transform:none;color:var(--text)}
label.ck input{width:auto}
.modal-foot{display:flex;justify-content:flex-end;gap:.6rem;margin-top:1.1rem}

#toast{position:fixed;left:50%;bottom:2rem;transform:translateX(-50%) translateY(20px);opacity:0;pointer-events:none;
  background:var(--panel2);border:1px solid var(--border2);color:var(--text);padding:.55rem 1.2rem;border-radius:10px;
  font-size:.86rem;transition:.2s;z-index:60;box-shadow:0 12px 32px rgba(0,0,0,.4);max-width:82vw}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
#toast.ok{border-color:rgba(61,220,151,.5)}
#toast.err{border-color:rgba(255,107,122,.55);color:var(--err)}

footer{max-width:1080px;margin:0 auto;padding:0 1.25rem 2.6rem;color:var(--faint);font-size:.76rem;
  display:flex;gap:1.4rem;justify-content:center;flex-wrap:wrap}
@media(max-width:860px){
  .topbar{flex-wrap:wrap}
  .tabs{order:3;width:100%;justify-content:center}
  #backupList ul{columns:1}
}
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <svg class="logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h5l3-6h10M8 12l3 6h10"/><circle cx="3.2" cy="12" r="1.7"/><circle cx="20.8" cy="6" r="1.7"/><circle cx="20.8" cy="18" r="1.7"/></svg>
    codex-switch<span class="sub">多供应商模型路由</span>
  </div>
  <nav class="tabs">
    <button id="tabbtn-providers" class="tabbtn active" onclick="switchTab('providers')">供应商</button>
    <button id="tabbtn-codex" class="tabbtn" onclick="switchTab('codex')">Codex 接入</button>
    <button id="tabbtn-history" class="tabbtn" onclick="switchTab('history')">配置历史</button>
  </nav>
  <div class="chips">
    <span class="chip"><span class="dot on"></span>运行中</span>
    <span class="chip">${esc(host)}:${port}</span>
  </div>
</header>
<main>

  <section id="tab-providers" class="pane">
    <div class="pane-head">
      <div>
        <h2>供应商</h2>
        <div id="unionBar" class="union-bar muted">加载中…</div>
      </div>
      <div class="pane-actions">
        <button class="btn" onclick="refreshCaps()">刷新模型能力</button>
        <button class="btn primary" onclick="openAdd()">＋ 添加供应商</button>
      </div>
    </div>
    <div id="unionChips" class="union-chips"><span class="hint">加载中…</span></div>
    <div id="providerGrid" class="grid"></div>
    <p class="note">Codex 看到的模型 = 所有「启用」供应商的模型并集。停用供应商不会删除它,只是从路由表和并集中移除。密钥只存环境变量名,页面与配置文件里永远不出现明文。</p>
  </section>

  <section id="tab-codex" class="pane" style="display:none">
    <section class="card">
      <div class="card-head"><h2><span class="bar"></span>Codex 接入</h2></div>
      <p class="note">一键写入 <code>~/.codex/</code>:改动前自动备份 → 手术式合并(只增改 codex-switch 自己的两段配置,官方内容一字节不动)→ catalog.json 合并时保留全部官方条目。还原 = 取最新备份覆盖回去。应用后重启 Codex 生效。</p>
      <div id="codexStatus" class="status muted">尚未应用。</div>
      <div id="backupList"></div>
      <div class="pane-actions" style="margin-top:.8rem">
        <button class="btn primary" onclick="applyCodex()">应用并备份</button>
        <button class="btn danger" onclick="restoreCodex()">一键还原</button>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2><span class="bar"></span>官方订阅</h2><span id="subStatus" class="badge">检测中…</span></div>
      <table id="subTable" class="kv" style="display:none"><tbody>
        <tr><td>登录状态</td><td id="subLogin"></td></tr>
        <tr><td>账号(脱敏)</td><td class="mono" id="subId"></td></tr>
        <tr><td>auth.json</td><td class="mono" id="subAuth"></td></tr>
        <tr><td>官方模型</td><td id="subModels"></td></tr>
<tr><td>官方目录同步</td><td id="subEmbedded"></td></tr>
        <tr><td>配置段</td><td id="subSections"></td></tr>
      </tbody></table>
      <p class="note">官方订阅的模型列表与配置只读展示;应用 / 还原时绝对不覆盖、不删除。</p>
    </section>
    <section class="card">
      <div class="card-head"><h2><span class="bar"></span>Codex 侧配置预览</h2><span class="badge">由「应用并备份」写入</span></div>
      <details><summary class="mono">~/.codex/config.toml(将合并的段)</summary><pre id="codexCfg"></pre></details>
      <details><summary class="mono">~/.codex/catalog.json(合并后的目录)</summary><pre id="codexCat"></pre></details>
    </section>
  </section>

  <section id="tab-history" class="pane" style="display:none">
    <div class="pane-head">
      <div>
        <h2>配置历史</h2>
        <div class="union-bar muted" id="histCount"></div>
      </div>
      <div class="pane-actions"><button class="btn" onclick="loadHistory()">刷新</button></div>
    </div>
    <p class="note">每次在页面上改动供应商配置之前,都会自动把 <span class="mono">config.toml</span> 备份到这里。点「还原」会先把当前配置备份一份,再用所选版本覆盖,然后热重载路由表。</p>
    <div id="historyList"></div>
  </section>

</main>
<footer><span>零请求改写</span><span>只监听 127.0.0.1</span><span>纯配置驱动</span><span>MIT</span></footer>

<div id="modalWrap" style="display:none">
  <div id="modal">
    <div class="modal-head"><b id="modalTitle">添加供应商</b><button class="xbtn" onclick="closeModal()">✕</button></div>
    <div class="frow"><label>ID</label><input id="f-id" class="mono" placeholder="例如 bailian(仅限字母/数字/_/-/.)" spellcheck="false"></div>
    <div class="frow"><label>名称</label><input id="f-name" placeholder="显示名称,留空同 ID"></div>
    <div class="frow"><label>认证方式</label>
      <select id="f-auth" onchange="authChanged()">
        <option value="bearer">bearer — API Key(走环境变量)</option>
        <option value="chatgpt_subscription">chatgpt_subscription — ChatGPT 订阅</option>
        <option value="chatgpt_oauth">chatgpt_oauth — ChatGPT OAuth</option>
        <option value="passthrough">passthrough — 透传客户端凭证</option>
      </select>
    </div>
    <div class="frow"><label>Base URL</label><input id="f-baseurl" class="mono" placeholder="https://…" spellcheck="false"></div>
    <div class="frow" id="f-tokenenv-wrap"><label>Token 环境变量名</label>
      <input id="f-tokenenv" class="mono" placeholder="例如 DASHSCOPE_API_KEY" spellcheck="false">
      <div class="fhint">密钥本身放在环境变量里(如 ~/.codex-switch/env),这里只填变量名;编辑时清空也保持原值不变。</div>
    </div>
    <div class="frow"><label>模型列表</label>
      <textarea id="f-models" rows="4" placeholder="每行一个模型,或用逗号分隔。例如:&#10;qwen3.8-max&#10;qwen3.7-plus" spellcheck="false"></textarea>
      <div class="fhint">Codex 看到的模型 = 所有启用供应商的模型并集。</div>
    </div>
    <div class="frow"><label class="ck"><input type="checkbox" id="f-enabled" checked> 启用该供应商</label></div>
    <div id="formMsg" class="status"></div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" id="saveBtn" onclick="saveProvider()">保存</button>
    </div>
  </div>
</div>
<div id="toast"></div>

<script>
var CURRENT={providers:[],union:{providers:0,total:0,models:[]}};
var EDITING=null;
function $(id){return document.getElementById(id);}
function escH(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
var PRETTY_ACR={gpt:1,api:1,llm:1,url:1,ws:1};
function prettyName(s){return String(s==null?'':s).split('-').map(function(w){if(!w)return w;if(PRETTY_ACR[w.toLowerCase()])return w.toUpperCase();return w.charAt(0).toUpperCase()+w.slice(1);}).join(' ');}
function toast(msg,ok){var t=$('toast');t.textContent=msg;t.className='show '+(ok===false?'err':'ok');clearTimeout(t._h);t._h=setTimeout(function(){t.className='';},2800);}
function api(url,body){
  var opts=body===undefined?{method:'GET'}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)};
  return fetch(url,opts).then(function(r){
    return r.json().catch(function(){return {error:'invalid response'};}).then(function(j){
      if(!r.ok){throw new Error(j.error||('HTTP '+r.status));}
      return j;
    });
  });
}
function switchTab(name){
  var tabs=['providers','codex','history'];
  for(var i=0;i<tabs.length;i++){
    var pane=$('tab-'+tabs[i]);var btn=$('tabbtn-'+tabs[i]);
    if(tabs[i]===name){pane.style.display='flex';btn.className='tabbtn active';}
    else{pane.style.display='none';btn.className='tabbtn';}
  }
  if(name==='providers')loadProviders();
  if(name==='history')loadHistory();
  if(name==='codex'){loadCodexStatus();loadCodexPreview();}
}

/* ---------- 供应商 ---------- */
function loadProviders(){
  api('/__admin/providers').then(function(j){
    CURRENT.providers=j.providers||[];
    CURRENT.union=j.union||{providers:0,total:0,models:[]};
    CURRENT.officialSync=j.officialSync||{modelCount:0,sources:[]};
    renderUnion();renderCards();
  }).catch(function(e){toast('加载供应商失败: '+e.message,false);});
}
function renderUnion(){
  var u=CURRENT.union;
  $('unionBar').innerHTML='已启用 <b>'+u.providers+'</b> / '+u.total+' 个供应商 · Codex 当前可见模型 <b>'+u.models.length+'</b> 个(并集)';
  var chips=$('unionChips');
  if(!u.models.length){chips.innerHTML='<span class="hint">没有启用的供应商或模型为空,Codex 将看不到任何模型。</span>';return;}
  chips.innerHTML=u.models.map(function(m){return '<span class="mtag" title="'+escH(m)+'">'+escH(prettyName(m))+'</span>';}).join('');
}
function renderCards(){
  var g=$('providerGrid');var ps=CURRENT.providers;
  if(!ps.length){g.innerHTML='<div class="empty">还没有供应商。点右上角「＋ 添加供应商」创建第一个。</div>';return;}
  g.innerHTML=ps.map(cardHtml).join('');
}
function cardHtml(p){
  var on=p.enabled!==false;
  var models=(p.models||[]).map(function(m){return '<span class="mtag" title="'+escH(m)+'">'+escH(prettyName(m))+'</span>';}).join('')||'<span class="hint">未配置模型</span>';
  if(p.auth==='chatgpt_subscription'&&CURRENT.officialSync&&CURRENT.officialSync.modelCount){
    models+='<span class="hint"> … 另有官方内嵌目录 '+CURRENT.officialSync.modelCount+' 个模型自动同步(快速模式/官方提示词逐字节保留,升级 codex 自动更新)</span>';
  }
  var cred='';
  if(p.token_env)cred='<span class="cred">env: '+escH(p.token_env)+'</span>';
  else if(p.auth==='bearer')cred='<span class="warn-text">缺少凭证</span>';
  return '<div class="pcard'+(on?'':' off')+'">'
    +'<div class="pcard-top">'
      +'<div class="pcard-id"><span class="dot'+(on?' on':'')+'"></span><b>'+escH(p.name||p.id)+'</b><span class="pid">'+escH(p.id)+'</span></div>'
      +'<label class="switch" title="'+(on?'点击停用':'点击启用')+'"><input type="checkbox" data-toggle="1" data-id="'+escH(p.id)+'" '+(on?'checked':'')+'><span class="slider"></span></label>'
    +'</div>'
    +'<div class="pcard-row"><span class="lbl">认证</span><span class="badge">'+escH(p.auth)+'</span>'+cred+'</div>'
    +'<div class="pcard-row"><span class="lbl">地址</span><span class="url mono">'+escH(p.base_url||'—')+'</span></div>'
    +'<div class="pcard-row"><span class="lbl">模型</span></div>'
    +'<div class="pcard-models">'+models+'</div>'
    +'<div class="pcard-actions">'
      +'<button class="btn small" data-act="edit" data-id="'+escH(p.id)+'">编辑</button>'
      +'<button class="btn small danger" data-act="del" data-id="'+escH(p.id)+'">删除</button>'
    +'</div>'
  +'</div>';
}
function toggleP(id,on){
  api('/__admin/providers/toggle',{id:id,enabled:on}).then(function(){
    toast((on?'已启用: ':'已停用: ')+id);loadProviders();
  }).catch(function(e){toast('切换失败: '+e.message,false);loadProviders();});
}
function delP(id){
  if(!confirm('确认删除供应商 "'+id+'"?会先自动备份当前配置。'))return;
  api('/__admin/providers/delete',{id:id}).then(function(){
    toast('已删除: '+id);loadProviders();
  }).catch(function(e){toast('删除失败: '+e.message,false);});
}
function authChanged(){
  var a=$('f-auth').value;
  $('f-tokenenv-wrap').style.display=(a==='bearer'||a==='chatgpt_oauth')?'':'none';
}
function setMsg(msg,ok){
  var el=$('formMsg');
  if(!msg){el.textContent='';el.className='status';return;}
  el.textContent=msg;el.className='status '+(ok===false?'err':'ok');
}
function openAdd(){
  EDITING=null;
  $('modalTitle').textContent='添加供应商';
  $('f-id').value='';$('f-id').readOnly=false;
  $('f-name').value='';$('f-auth').value='bearer';$('f-baseurl').value='';
  $('f-tokenenv').value='';$('f-models').value='';$('f-enabled').checked=true;
  setMsg('');authChanged();
  $('modalWrap').style.display='flex';
  $('f-id').focus();
}
function openEdit(id){
  var p=null;
  for(var i=0;i<CURRENT.providers.length;i++){if(CURRENT.providers[i].id===id){p=CURRENT.providers[i];break;}}
  if(!p){toast('未找到供应商: '+id,false);return;}
  EDITING=id;
  $('modalTitle').textContent='编辑供应商 · '+id;
  $('f-id').value=p.id;$('f-id').readOnly=true;
  $('f-name').value=p.name||'';
  $('f-auth').value=p.auth||'bearer';
  $('f-baseurl').value=p.base_url||'';
  $('f-tokenenv').value=p.token_env||'';
  $('f-models').value=(p.models||[]).join('\\n');
  $('f-enabled').checked=p.enabled!==false;
  setMsg('');authChanged();
  $('modalWrap').style.display='flex';
  $('f-name').focus();
}
function closeModal(){$('modalWrap').style.display='none';}
function saveProvider(){
  var p={
    id:$('f-id').value.trim(),
    name:$('f-name').value.trim(),
    auth:$('f-auth').value,
    base_url:$('f-baseurl').value.trim(),
    models:$('f-models').value,
    enabled:$('f-enabled').checked
  };
  var te=$('f-tokenenv').value.trim();
  if(te)p.token_env=te;
  if(!p.id){setMsg('ID 不能为空',false);return;}
  var url='/__admin/providers';var body=p;
  if(EDITING!==null){url='/__admin/providers/update';body={origId:EDITING,provider:p};}
  $('saveBtn').disabled=true;
  api(url,body).then(function(){
    $('saveBtn').disabled=false;
    toast(EDITING!==null?'供应商已更新: '+p.id:'供应商已添加: '+p.id);
    closeModal();loadProviders();
  },function(e){
    $('saveBtn').disabled=false;
    setMsg(e.message,false);
  });
}
$('providerGrid').addEventListener('click',function(e){
  var t=e.target.closest?e.target.closest('[data-act]'):null;
  if(!t)return;
  var id=t.getAttribute('data-id');
  if(t.getAttribute('data-act')==='edit')openEdit(id);
  if(t.getAttribute('data-act')==='del')delP(id);
});
$('providerGrid').addEventListener('change',function(e){
  var t=e.target;
  if(t&&t.matches&&t.matches('[data-toggle]'))toggleP(t.getAttribute('data-id'),t.checked);
});
function refreshCaps(){
  toast('正在联网获取模型能力…');
  api('/__admin/fetch-capabilities',{}).then(function(){
    toast('模型能力刷新完成');loadProviders();
  }).catch(function(e){toast('刷新失败: '+e.message,false);});
}

/* ---------- 配置历史 ---------- */
function fmtTime(t){
  if(!t||t.length!==14)return t||'';
  return t.slice(0,4)+'-'+t.slice(4,6)+'-'+t.slice(6,8)+' '+t.slice(8,10)+':'+t.slice(10,12)+':'+t.slice(12,14);
}
function fmtSize(n){
  if(n==null)return '';
  if(n<1024)return n+' B';
  if(n<1048576)return (n/1024).toFixed(1)+' KB';
  return (n/1048576).toFixed(2)+' MB';
}
function loadHistory(){
  api('/__admin/history').then(function(j){
    var hs=j.history||[];
    $('histCount').textContent=hs.length?('共 '+hs.length+' 份备份,按时间倒序'):'';
    var el=$('historyList');
    if(!hs.length){el.innerHTML='<div class="empty">还没有配置备份。每次在页面上改动供应商配置,都会自动在这里生成一份。</div>';return;}
    el.innerHTML=hs.map(function(h){
      return '<div class="hrow">'
        +'<div class="hinfo">'
          +'<span class="htime">'+fmtTime(h.time)+'</span>'
          +'<span class="hseq">#'+escH(h.seq)+'</span>'
          +'<span class="hsize">'+fmtSize(h.size)+'</span>'
          +'<span class="hfile mono">'+escH(h.file)+'</span>'
        +'</div>'
        +'<button class="btn small" data-act="restore" data-file="'+escH(h.file)+'">还原</button>'
      +'</div>';
    }).join('');
  }).catch(function(e){toast('加载配置历史失败: '+e.message,false);});
}
function restoreHist(file){
  if(!confirm('确认还原到这份配置?\\n'+file+'\\n\\n会先把当前配置备份一份,再覆盖并热重载。'))return;
  api('/__admin/history/restore',{file:file}).then(function(j){
    toast('已还原: '+j.restored);loadProviders();loadHistory();
  }).catch(function(e){toast('还原失败: '+e.message,false);});
}
$('historyList').addEventListener('click',function(e){
  var t=e.target.closest?e.target.closest('[data-act]'):null;
  if(!t)return;
  if(t.getAttribute('data-act')==='restore')restoreHist(t.getAttribute('data-file'));
});

/* ---------- Codex 接入 ---------- */
function loadCodexPreview(){
  api('/__admin/codex-config').then(function(d){
    $('codexCfg').textContent=d.config_toml;
    $('codexCat').textContent=d.catalog_json;
  }).catch(function(){});
}
function setCodexStatus(cls,msg){var el=$('codexStatus');el.className='status '+cls;el.textContent=msg;}
function loadCodexStatus(){
  var sub=$('subStatus');
  api('/__admin/codex-status').then(function(j){
    sub.className=j.loggedIn?'badge ok':'badge warn';
    sub.textContent=j.loggedIn?'官方账号已登录':'未检测到官方登录';
    $('subTable').style.display='table';
    $('subLogin').textContent=j.loggedIn?'✓ 已登录(auth.json 含 access_token)':'✗ 未登录(auth.json 无 access_token)';
    $('subId').textContent=j.identity||'—';
    $('subAuth').textContent=j.authPath||'—';
    var om=j.officialModels||[];
    $('subModels').textContent=om.length?(om.length+' 个: '+om.join(', ')):'0 个(应用后将显示被保留的官方 catalog 条目)';
    var em=j.embeddedCatalog;
    $('subEmbedded').textContent=em
      ?('✓ '+em.modelCount+' 个模型自动同步自 codex 二进制 — '+em.sources.map(function(s){return s.bin+' ['+s.models+' 个]';}).join(' ; ')+'。官方新增模型:升级 codex 后点「应用并备份」即生效。')
      :'✗ 未找到 codex 二进制内嵌目录(回退:仅用配置文件中的模型列表)';
    var secs=j.configSections||[];
    $('subSections').textContent=secs.length?(secs.length+' 段: '+secs.slice(0,15).join(', ')+(secs.length>15?' …':'')):'0 段';
    var bl=$('backupList');
    bl.textContent='';
    var bs=j.backups||[];
    if(!bs.length){bl.textContent='暂无备份(点「应用并备份」会在改动前自动生成)。';return;}
    bl.textContent='备份('+bs.length+' 份,还原取最新一份):';
    var ul=document.createElement('ul');
    for(var i=0;i<bs.length&&i<12;i++){var li=document.createElement('li');li.textContent=bs[i].original+' ← '+bs[i].file;ul.appendChild(li);}
    if(bs.length>12){var li2=document.createElement('li');li2.textContent='… 共 '+bs.length+' 份';ul.appendChild(li2);}
    bl.appendChild(ul);
  }).catch(function(){sub.className='badge warn';sub.textContent='查询失败';});
}
function applyCodex(){
  setCodexStatus('muted','应用中:备份 + 校验 + 手术式合并…');
  api('/__admin/codex-apply',{}).then(function(j){
    setCodexStatus('ok','✓ 已应用并备份 '+(j.backups||[]).length+' 份 · 官方配置段 '+(j.preserved&&j.preserved.configSectionsAfter!=null?j.preserved.configSectionsAfter:'?')+' 段、官方模型 '+(j.preserved&&j.preserved.officialModelsAfter!=null?j.preserved.officialModelsAfter:'?')+' 个全部保留 — 重启 Codex 生效');
    loadCodexStatus();
  }).catch(function(e){setCodexStatus('err','✗ 应用失败: '+e.message);});
}
function restoreCodex(){
  setCodexStatus('muted','正在还原最新备份…');
  api('/__admin/codex-restore',{}).then(function(j){
    setCodexStatus('ok','✓ 已还原: '+((j.restored&&j.restored.length)?j.restored.map(function(x){return x.file+' ← '+x.from;}).join(', '):'(无备份可还原)'));
    loadCodexStatus();
  }).catch(function(e){setCodexStatus('err','✗ 还原失败: '+e.message);});
}

loadProviders();
loadCodexStatus();
loadCodexPreview();
</script>
</body></html>`;
}

async function handleAdmin(req, bodyBuf, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendHtml(res, 200, renderAdminPage());

  let body = {};
  if (bodyBuf.length && String(req.headers['content-type'] || '').includes('application/json')) {
    try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch (e) {
      return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e.message) });
    }
  }

  // ---------- providers CRUD ----------
  if (p.startsWith('/__admin/providers')) {
    try {
      if (req.method === 'GET' && p === '/__admin/providers') {
        const c = getConfig();
        const providers = (c.providers || []).map((x) => {
          const o = { ...x };
          delete o.token; // 明文密钥绝不回传前端
          return o;
        });
        let officialSync = { modelCount: 0, sources: [] };
        try {
          const oc = officialCatalog();
          officialSync = { modelCount: oc.models.size, sources: oc.sources.map((s) => ({ bin: s.bin, models: s.modelCount })) };
        } catch { /* 提取失败不影响供应商列表 */ }
        return sendJson(res, 200, { ok: true, providers, union: enabledUnion(), officialSync });
      }
      if (req.method === 'POST' && p === '/__admin/providers') {
        return sendJson(res, 200, addProvider(body));
      }
      if (req.method === 'POST' && p === '/__admin/providers/update') {
        return sendJson(res, 200, updateProvider(String(body.origId || ''), body.provider || body));
      }
      if (req.method === 'POST' && p === '/__admin/providers/toggle') {
        return sendJson(res, 200, toggleProvider(String(body.id || ''), body.enabled));
      }
      if (req.method === 'POST' && p === '/__admin/providers/delete') {
        return sendJson(res, 200, deleteProvider(String(body.id || '')));
      }
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message) });
    }
    return sendJson(res, 404, { error: 'not found', path: p });
  }

  // ---------- config history ----------
  if (p.startsWith('/__admin/history')) {
    try {
      if (req.method === 'GET' && p === '/__admin/history') {
        return sendJson(res, 200, { ok: true, history: listHistory() });
      }
      if (req.method === 'POST' && p === '/__admin/history/restore') {
        const restored = restoreHistory(String(body.file || ''));
        refreshAllCaps(true).catch((e) => console.warn(`[codex-switch] caps refresh failed: ${e.message}`));
        return sendJson(res, 200, { ok: true, restored });
      }
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message) });
    }
    return sendJson(res, 404, { error: 'not found', path: p });
  }

  // ---------- codex side ----------
  if (req.method === 'GET' && p === '/__admin/codex-config') return sendJson(res, 200, generateCodexConfig());
  if (req.method === 'GET' && p === '/__admin/codex-status') {
    return sendJson(res, 200, { ok: true, ...detectOfficial(), backups: listBackups() });
  }
  if (req.method === 'POST' && p === '/__admin/codex-apply') {
    const r = applyToCodex();
    if (!r.ok) return sendJson(res, 400, r);
    return sendJson(res, 200, r);
  }
  if (req.method === 'POST' && p === '/__admin/codex-restore') {
    const restored = restoreLatest();
    const after = detectOfficial();
    return sendJson(res, 200, { ok: true, restored, officialModels: after.officialModels });
  }

  // ---------- raw config / capabilities ----------
  if (req.method === 'GET' && p === '/__admin/config') {
    const text = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : '';
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(text);
  }
  if (req.method === 'POST' && p === '/__admin/config') {
    const text = bodyBuf.toString('utf8');
    try { TOML.parse(text); } catch (e) {
      return sendJson(res, 400, { error: 'TOML parse failed', detail: String(e.message) });
    }
    snapshotConfig();
    fs.writeFileSync(CONFIG_PATH, text);
    cfgMtime = 0; loadConfig(); // force reload
    refreshAllCaps(true).catch((e) => console.warn(`[codex-switch] caps refresh failed: ${e.message}`));
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/__admin/fetch-capabilities') {
    const results = await refreshAllCaps(true);
    return sendJson(res, 200, { ok: true, results });
  }

  return sendJson(res, 404, { error: 'not found', path: p });
}

// ---------- request dispatch ----------
function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const mountPrefix = getConfig().proxy?.mount_prefix || DEFAULT_MOUNT;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);
    const isAdmin = url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/__admin');
    const isProxy = url.pathname.startsWith(mountPrefix);
    if (isAdmin) handleAdmin(req, bodyBuf, res).catch((e) => sendJson(res, 500, { error: String(e.message) }));
    else if (isProxy) handleProxy(req, bodyBuf, res).catch((e) => sendJson(res, 500, { error: String(e.message) }));
    else sendJson(res, 404, { error: 'not found', path: url.pathname });
  });
  req.on('error', () => { try { res.destroy(); } catch {} });
}

// ---------- lifecycle: start / stop / status ----------
function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }

function start() {
  console.log(`[codex-switch] config file: ${CONFIG_PATH}`);
  loadConfig();
  const off = detectOfficial();
  console.log(off.loggedIn
    ? `[codex-switch] official subscription: logged in (${off.identity || 'account'}), preserving ${off.configSections.length} config sections + ${off.officialModels.length} official models`
    : '[codex-switch] official subscription: not detected (auth.json missing or no access_token)');
  const { host, port } = getListenParts();
  const server = http.createServer(handle);
  server.on('error', (e) => {
    console.error(`[codex-switch] listen error: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    ensureDir(PID_FILE);
    fs.writeFileSync(PID_FILE, String(process.pid));
    console.log(`[codex-switch] listening on ${host}:${port} (pid ${process.pid})`);
    console.log(`[codex-switch] admin:  http://${host}:${port}/`);
    console.log(`[codex-switch] codex:  base_url http://${host}:${port}${getConfig().proxy?.mount_prefix || DEFAULT_MOUNT}`);
    // initial capability fetch (TTL-aware; errors only affect the catalog fallback, never forwarding)
    refreshAllCaps(false).catch((e) => console.warn(`[codex-switch] caps refresh failed: ${e.message}`));
  });
  const shutdown = (sig) => {
    console.log(`\n[codex-switch] ${sig} — shutting down`);
    server.close(() => { try { fs.unlinkSync(PID_FILE); } catch {} process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function stop() {
  if (!fs.existsSync(PID_FILE)) { console.log('[codex-switch] not running (no pid file)'); return 0; }
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  try { process.kill(pid, 'SIGTERM'); console.log(`[codex-switch] sent SIGTERM to pid ${pid}`); return 0; }
  catch (e) { console.log(`[codex-switch] kill failed: ${e.message}`); try { fs.unlinkSync(PID_FILE); } catch {} return 1; }
}

function status() {
  if (!fs.existsSync(PID_FILE)) { console.log('[codex-switch] not running'); return 0; }
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch {}
  console.log(`[codex-switch] pid ${pid} ${alive ? 'running' : 'stale (pid file exists but process gone)'}`);
  return alive ? 0 : 1;
}

const cmd = process.argv[2];
if (cmd === 'stop') process.exit(stop());
if (cmd === 'status') process.exit(status());
start();
