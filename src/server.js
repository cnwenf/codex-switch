// codex-switch — thin model-id-routing proxy for Codex.
// Pure passthrough: zero body rewriting. Only auth headers are injected/swapped per provider.
//
// Codex points ONE model_provider at this proxy; the proxy routes each request to
// the correct upstream by reading body.model. Body + SSE responses are forwarded byte-for-byte.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execFile, spawn } from 'node:child_process';
import https from 'node:https';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';
import { renderAdminPage } from './admin-page.js';
import {
  buildCatalogEntry,
  cacheDiscoveredModels,
  capsCache,
  inspectDiscoveredCache,
  invalidateDiscoveredModels,
  resolveCaps,
} from './caps.js';
import { officialCatalog } from './official.js';
import { discoverProvider } from './provider-discovery.js';
import {
  buildProvidersRegion,
  normalizeProvider,
  providerConnectionIdentity,
  replaceProvidersRegion,
} from './provider-config.js';
import {
  getProviderPreset,
  inferProviderType,
  listProviderPresets,
} from './provider-registry.js';

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
const MAX_ADMIN_BODY_BYTES = 64 * 1024;

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

// ---------- API 凭证:管理页直接填写 → 写入 ~/.codex-switch/env ----------
// scripts/start.sh 启动时 source 该文件;server.js 启动时再装载一遍(直接 node 启动也生效);
// 页面保存后同时 set process.env,当前进程立即生效(authPlan 每请求读 process.env)。
// 安全约束:只接受供应商 token_env 引用过的变量名(白名单);值绝不写日志、绝不回传前端,
// GET 只返回 {name, configured};文件 chmod 600,原子写入(tmp+rename)。
const ENV_FILE = path.join(os.homedir(), '.codex-switch', 'env');
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function allowedEnvNames() {
  const names = new Set();
  for (const p of getConfig().providers || []) {
    if (p.token_env) names.add(String(p.token_env));
  }
  return names;
}

function shellQuote(v) {
  // 被 POSIX sh source 时单引号最稳;内嵌单引号写成 '\''
  return "'" + String(v).replace(/'/g, "'\\''") + "'";
}

function parseEnvFile(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
      v = v.slice(1, -1);
    }
    if (ENV_NAME_RE.test(k)) out.set(k, v);
  }
  return out;
}

function readEnvFileEntries() {
  return fs.existsSync(ENV_FILE) ? parseEnvFile(fs.readFileSync(ENV_FILE, 'utf8')) : new Map();
}

function writeEnvFile(entries) {
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
  const lines = ['# codex-switch API 凭证(管理页生成;scripts/start.sh 启动时 source;chmod 600)'];
  for (const [k, v] of entries) lines.push(`${k}=${shellQuote(v)}`);
  const tmp = `${ENV_FILE}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, ENV_FILE);
  try { fs.chmodSync(ENV_FILE, 0o600); } catch { /* 个别文件系统不支持 chmod,忽略 */ }
}

// 启动时装载:文件值优先(与 start.sh 里 source 覆盖 shell 环境的语义一致)。只报数量,不报值。
function loadEnvFileIntoProcess() {
  const entries = readEnvFileEntries();
  for (const [k, v] of entries) process.env[k] = v;
  return entries.size;
}

function envKeyStatus() {
  const fileKeys = readEnvFileEntries();
  return [...allowedEnvNames()].sort().map((name) => ({
    name,
    configured: Boolean(process.env[name]) || Boolean(fileKeys.get(name)),
  }));
}

function discoveryConnectionProvider(input) {
  return normalizeProvider({
    id: 'discovery-connection',
    name: 'Discovery connection',
    provider_type: input.providerType,
    provider_options: input.providerOptions,
    base_url: input.baseUrl,
    auth: 'bearer',
    token_env: 'DISCOVERY_CONNECTION_KEY',
    models: [],
  });
}

function providerMatchesDiscoveryConnection(provider, input) {
  try {
    return providerConnectionIdentity(provider) === providerConnectionIdentity(discoveryConnectionProvider(input));
  } catch {
    return false;
  }
}

function resolveSavedProviderKey(input) {
  if (typeof input.providerId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(input.providerId)) return '';
  const provider = (getConfig().providers || []).find((entry) => entry?.id === input.providerId);
  if (!providerMatchesDiscoveryConnection(provider, input)) return '';
  const envName = typeof provider?.token_env === 'string' ? provider.token_env : '';
  if (!ENV_NAME_RE.test(envName)) return '';
  const value = process.env[envName];
  return typeof value === 'string' && value.length <= 4096 ? value.trim() : '';
}

function resolveDiscoveryCacheProvider(input) {
  if (typeof input.providerId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(input.providerId)) return null;
  const provider = (getConfig().providers || []).find((entry) => entry?.id === input.providerId);
  if (!provider || provider.enabled === false) return null;
  return providerMatchesDiscoveryConnection(provider, input) ? provider : null;
}

function saveEnvKey(name, value) {
  if (!ENV_NAME_RE.test(name)) throw new Error('非法的环境变量名');
  if (!allowedEnvNames().has(name)) throw new Error(`环境变量 '${name}' 未被任何供应商的 token_env 引用,拒绝写入`);
  if (typeof value !== 'string' || !value.trim()) throw new Error('Key 值不能为空(要移除请用「清除」)');
  if (value.length > 4096) throw new Error('Key 值过长');
  const entries = readEnvFileEntries();
  entries.set(name, value);
  writeEnvFile(entries);
  process.env[name] = value; // 当前进程立即生效
  console.log(`[codex-switch] env key saved: ${name} (value never logged)`);
  return { ok: true, name };
}

function deleteEnvKey(name) {
  if (!ENV_NAME_RE.test(name)) throw new Error('非法的环境变量名');
  const entries = readEnvFileEntries();
  const removed = entries.delete(name);
  writeEnvFile(entries);
  delete process.env[name];
  console.log(`[codex-switch] env key removed: ${name}`);
  return { ok: true, name, removed };
}

// ---------- 开机自动启动 (macOS LaunchAgent) ----------
// 登录项 = ~/Library/LaunchAgents/com.cnwenf.codex-switch.plist(RunAtLoad=true)。
// 入口按运行形态自适应:.app 打包 → bundle 内 launcher;源码安装 → scripts/start.sh。
// KeepAlive=false 是刻意的:只管「登录时拉起」,不做进程守护,避免干扰手动停止/开发重启。
// 默认开启:首次启动(无 plist 且无显式关闭标记)自动写入;写文件不 bootstrap,下次登录生效。
const AUTOSTART_LABEL = 'com.cnwenf.codex-switch';
const AUTOSTART_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`);
const AUTOSTART_OFF_MARKER = path.join(os.homedir(), '.codex-switch', '.autostart-off');

function autostartSupported() { return process.platform === 'darwin'; }

function autostartProgramArgs() {
  if (process.execPath.includes(`.app${path.sep}Contents${path.sep}`)) {
    // .app 打包模式:execPath = .../Codex Switch.app/Contents/MacOS/node
    return [path.join(path.dirname(process.execPath), 'codex-switch-launcher')];
  }
  return ['/bin/sh', path.resolve(__dirname, '..', 'scripts', 'start.sh')];
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildAutostartPlist() {
  const args = autostartProgramArgs().map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  const logDir = path.join(os.homedir(), '.codex-switch');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTOSTART_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'launchd.err.log'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

function autostartStatus() {
  return {
    supported: autostartSupported(),
    enabled: autostartSupported() && fs.existsSync(AUTOSTART_PLIST),
    plist: AUTOSTART_PLIST,
    entry: autostartProgramArgs().join(' '),
  };
}

function setAutostart(enabled) {
  if (!autostartSupported()) throw new Error('开机自动启动仅支持 macOS');
  if (enabled) {
    fs.mkdirSync(path.dirname(AUTOSTART_PLIST), { recursive: true });
    fs.writeFileSync(AUTOSTART_PLIST, buildAutostartPlist(), { mode: 0o644 });
    try { fs.unlinkSync(AUTOSTART_OFF_MARKER); } catch {}
    console.log(`[codex-switch] autostart enabled: ${AUTOSTART_PLIST}`);
  } else {
    try { fs.unlinkSync(AUTOSTART_PLIST); } catch {}
    fs.mkdirSync(path.dirname(AUTOSTART_OFF_MARKER), { recursive: true });
    fs.writeFileSync(AUTOSTART_OFF_MARKER, new Date().toISOString() + '\n', { mode: 0o600 });
    console.log('[codex-switch] autostart disabled (plist removed, off-marker written)');
  }
  return { ok: true, ...autostartStatus() };
}

function ensureDefaultAutostart() {
  // 默认开启 + 入口自愈:未显式关闭(无 off 标记)时,每次启动按当前运行形态重写 plist。
  // 这样在 源码 ↔ .app 之间切换、或程序路径变化后,登录项永远指向正确的入口。
  // 只写文件、不 bootstrap:当前进程已在监听,登录项下次登录生效。
  if (!autostartSupported()) return;
  if (fs.existsSync(AUTOSTART_OFF_MARKER)) return;
  try {
    fs.mkdirSync(path.dirname(AUTOSTART_PLIST), { recursive: true });
    fs.writeFileSync(AUTOSTART_PLIST, buildAutostartPlist(), { mode: 0o644 });
    console.log(`[codex-switch] autostart ensured: ${AUTOSTART_PLIST} → ${autostartProgramArgs().join(' ')} (RunAtLoad, 下次登录生效)`);
  } catch (e) {
    console.warn(`[codex-switch] autostart setup failed: ${e.message}`);
  }
}

// ---------- codex 侧配置:官方订阅检测 + 一键应用/备份/还原 ----------
// 只做管理页展示 + ~/.codex 文件的手术式合并。官方自有配置与模型条目绝对不覆盖:
// 合并时只增删 codex-switch 自己的两段内容,其余字节原样保留。
const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_CFG = path.join(CODEX_DIR, 'config.toml');
const CODEX_CATALOG = path.join(CODEX_DIR, 'catalog.json');
const BACKUP_DIR = path.join(os.homedir(), '.codex-switch', 'backups');
// 注入前官方形态记录(退出/一键还原时精确还原用):注入时替换掉了哪条顶层行、
// 注入前 catalog.json 是否存在。只在「未注入 → 注入」时写入,重复注入不覆盖。
const APPLY_STATE = path.join(os.homedir(), '.codex-switch', 'apply-state.json');
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

// 展示排序:官方订阅模型在前,其他供应商在后;组内按名称倒排(qwen3.8 在 qwen3.7 前)。
// 非路由保留条目(纯官方内容)视同官方订阅组。
function modelDisplayGroup(slug) {
  const p = getRouteTable().get(slug);
  return (!p || p.auth === 'chatgpt_subscription') ? 0 : 1;
}
function sortModelsForDisplay(entries) {
  return entries.sort((a, b) => {
    const g = modelDisplayGroup(a.slug) - modelDisplayGroup(b.slug);
    if (g !== 0) return g;
    return b.slug.localeCompare(a.slug); // 名称倒排
  });
}
// slug 列表版同一规则(管理页并集模型展示用;路由 id 本身不受影响)。
function sortSlugsForDisplay(slugs) {
  return slugs.slice().sort((a, b) => {
    const g = modelDisplayGroup(a) - modelDisplayGroup(b);
    if (g !== 0) return g;
    return b.localeCompare(a); // 名称倒排
  });
}

// 合并 ~/.codex/catalog.json:保留所有官方条目(其 slug 不在本代理路由表内的
// 全部原样保留),追加 codex-switch 代理的模型条目。官方 slug 用镜像条目
// (百分百精确),非官方模型(qwen 等)用合成条目。
// 顺序与 priority:官方订阅在前、其他供应商在后、组内名称倒排;
// Codex 选择器按 priority 升序展示,这里按最终顺序重写 priority=1..N
// (镜像条目的官方 priority 是排序元数据,能力字段仍逐字节保留)。
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
  sortModelsForDisplay(kept);
  kept.forEach((m, i) => { m.priority = i + 1; });
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

function readApplyState() {
  try { return JSON.parse(fs.readFileSync(APPLY_STATE, 'utf8')); } catch { return {}; }
}
function writeApplyState(patch) {
  const s = { ...readApplyState(), ...patch };
  fs.mkdirSync(path.dirname(APPLY_STATE), { recursive: true });
  fs.writeFileSync(APPLY_STATE, JSON.stringify(s, null, 2) + '\n');
}

// 一键还原 / 退出自动还原:回滚「注入 codex-switch」之前的官方形态。
// config.toml —— 手术式剥离(绝不用备份整体覆盖,否则会丢掉注入期间官方
// codex CLI 自己写入的内容,如 [projects]):只移除我们注入的 model_provider /
// model_catalog_json 行与 [model_providers.codexswitch] 段;注入时被替换掉的
// 用户原有行按 apply-state.json 原样放回。
// catalog.json —— 优先还原最近一份「未污染备份」(未注入状态下做的备份);
// 注入前本不存在则直接删除;实在没有备份时兜底从当前文件过滤掉我们的条目。
function restoreCodexOfficial() {
  const actions = [];
  const state = readApplyState();
  if (fs.existsSync(CODEX_CFG)) {
    const lines = fs.readFileSync(CODEX_CFG, 'utf8').split('\n');
    const out = [];
    let i = 0;
    let touched = false;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*model_provider\s*=\s*"codexswitch"(\s|#|$)/.test(l)) {
        if (state.modelProviderLine) out.push(state.modelProviderLine);
        touched = true; i += 1; continue;
      }
      if (/^\s*model_catalog_json\s*=\s*"~\/\.codex\/catalog\.json"(\s|#|$)/.test(l)) {
        if (state.catalogLine) out.push(state.catalogLine);
        touched = true; i += 1; continue;
      }
      if (l.trim() === '[model_providers.codexswitch]') {
        i += 1;
        while (i < lines.length && !/^\s*\[/.test(lines[i])) i += 1;
        touched = true; continue;
      }
      out.push(l); i += 1;
    }
    if (touched) {
      fs.writeFileSync(CODEX_CFG, out.join('\n'));
      actions.push({ file: 'config.toml', action: 'stripped', from: null });
    } else {
      actions.push({ file: 'config.toml', action: 'unchanged', from: null });
    }
  }
  const cleanBackup = listBackups().find((x) => {
    if (x.original !== path.basename(CODEX_CATALOG)) return false;
    try { return !fs.readFileSync(path.join(BACKUP_DIR, x.file), 'utf8').includes('via codex-switch'); } catch { return false; }
  });
  if (cleanBackup) {
    fs.copyFileSync(path.join(BACKUP_DIR, cleanBackup.file), CODEX_CATALOG);
    actions.push({ file: 'catalog.json', action: 'restored', from: cleanBackup.file });
  } else if (state.catalogExisted === false) {
    if (fs.existsSync(CODEX_CATALOG)) {
      fs.unlinkSync(CODEX_CATALOG);
      actions.push({ file: 'catalog.json', action: 'removed', from: null });
    } else {
      actions.push({ file: 'catalog.json', action: 'unchanged', from: null });
    }
  } else if (fs.existsSync(CODEX_CATALOG)) {
    try {
      const cat = JSON.parse(fs.readFileSync(CODEX_CATALOG, 'utf8'));
      const models = Array.isArray(cat.models) ? cat.models : [];
      const kept = models.filter((m) => !String(m?.description || '').includes('via codex-switch'));
      if (models.length > 0 && kept.length === 0) {
        // 条目全部来自代理注入 → 该文件从无官方内容,直接删除,
        // Codex 回退使用官方二进制内嵌目录(官方模型不受影响)。
        fs.unlinkSync(CODEX_CATALOG);
        actions.push({ file: 'catalog.json', action: 'removed', from: '条目均为代理注入,回退官方内嵌目录' });
      } else {
        cat.models = kept;
        fs.writeFileSync(CODEX_CATALOG, JSON.stringify(cat, null, 2) + '\n');
        actions.push({ file: 'catalog.json', action: 'filtered', from: `过滤掉 ${models.length - kept.length} 条代理模型条目` });
      }
    } catch (e) {
      actions.push({ file: 'catalog.json', action: 'error', from: String(e.message) });
    }
  }
  return actions;
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
  const cfgText = cfgExisted ? fs.readFileSync(CODEX_CFG, 'utf8') : '';
  const mergedCfg = mergeCodexConfigToml(cfgText);
  try { TOML.parse(mergedCfg); } catch (e) {
    return { ok: false, error: '合并后的 ~/.codex/config.toml 不是合法 TOML,未写入任何文件', detail: String(e.message) };
  }
  const catExisted = fs.existsSync(CODEX_CATALOG);
  const existingCat = catExisted ? fs.readFileSync(CODEX_CATALOG, 'utf8') : '';
  const mergedCat = mergeCatalog(existingCat);
  // 严格校验只针对我们合成的条目(qwen 等);官方镜像条目逐字节来自官方二进制,
  // 结构天然合法,绝不因我们的校验规则拒绝官方内容。
  const oc = officialCatalog();
  const officialSynced = [...getRouteTable().keys()].filter((s) => oc.models.has(s));
  const strictMine = new Set([...getRouteTable().keys()].filter((s) => !oc.models.has(s)));
  const v = validateCatalogJson(mergedCat, strictMine);
  if (!v.ok) return { ok: false, error: '合并后的 catalog.json 校验失败,未写入任何文件', detail: v.error };

  // 手术式备份:只备份「当前未注入」的文件。已注入时当前内容就是代理配置本身,
  // 备份它会让还原回到代理态(空操作),确保「最新备份 = 注入前官方形态」。
  // 同时写 apply-state.json:记下注入前被替换的行,还原时原样放回;剥离式还原
  // 不会丢失注入期间官方 codex CLI 写入的内容(见 restoreCodexOfficial)。
  const cfgInjected = /model_provider\s*=\s*"codexswitch"/.test(cfgText);
  const catInjected = existingCat.includes('via codex-switch');
  const backups = [];
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  if (!cfgInjected) {
    const b1 = backupFile(CODEX_CFG);
    if (b1) backups.push({ file: path.basename(CODEX_CFG), backup: path.basename(b1) });
    const cfgLines = cfgText.split('\n');
    writeApplyState({
      at: backupTimestamp(),
      modelProviderLine: cfgLines.find((l) => /^\s*model_provider\s*=/.test(l)) || null,
      catalogLine: cfgLines.find((l) => /^\s*model_catalog_json\s*=/.test(l)) || null,
    });
  }
  fs.writeFileSync(CODEX_CFG, mergedCfg);
  if (!catInjected) {
    const b2 = backupFile(CODEX_CATALOG);
    if (b2) backups.push({ file: path.basename(CODEX_CATALOG), backup: path.basename(b2) });
    writeApplyState({ catalogExisted: catExisted });
  }
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

// ---------- capability refresh (provider discovery, cached 30 min) ----------
// Discovery is advisory and only affects the generated catalog. A failed refresh
// keeps any valid previous cache entry and never affects request forwarding.
async function refreshProviderCaps(provider, force) {
  if (!provider || provider.enabled === false) return { provider: provider?.id || '', status: 'skipped' };
  let normalized;
  try { normalized = normalizeProvider(provider); } catch {
    invalidateDiscoveredModels(provider.id);
    return { provider: provider.id, status: 'error' };
  }
  if (!force) {
    const cacheState = inspectDiscoveredCache(normalized);
    if (cacheState.status === 'fresh') {
      return { provider: provider.id, status: 'cached', models: cacheState.cached.models.size };
    }
  }
  if (normalized.auth !== 'bearer') return { provider: provider.id, status: 'skipped' };
  try {
      const apiKey = (provider.token_env && process.env[provider.token_env]) || provider.token || '';
      const discovered = await discoverProvider({
        providerType: normalized.provider_type,
        providerOptions: normalized.provider_options,
        baseUrl: normalized.base_url,
        apiKey,
      });
      const discoveryStatus = discovered.validation.status;
      if (discovered.models.length || discoveryStatus === 'valid') {
        cacheDiscoveredModels(normalized, discovered.models);
        return {
          provider: provider.id,
          status: discoveryStatus === 'valid' ? 'ok' : discoveryStatus,
          models: discovered.models.length,
        };
      }
      return { provider: provider.id, status: discoveryStatus };
  } catch {
    return { provider: provider.id, status: 'error' };
  }
}

async function refreshAllCaps(force) {
  const results = [];
  for (const provider of getConfig().providers || []) {
    if (provider.enabled === false) continue; // 停用的供应商不联网拉能力
    results.push(await refreshProviderCaps(provider, force));
  }
  console.log(`[codex-switch] caps refresh: ${results.map((r) => `${r.provider}=${r.status}`).join(', ')}`);
  return results;
}

async function refreshProviderCapsById(providerId, force = true) {
  const provider = (getConfig().providers || []).find((entry) => entry?.id === providerId);
  const result = await refreshProviderCaps(provider, force);
  console.log(`[codex-switch] caps refresh: ${result.provider || providerId}=${result.status}`);
  return result;
}

async function refreshCapsForTokenEnv(tokenEnv) {
  const providers = (getConfig().providers || []).filter((provider) => provider?.token_env === tokenEnv);
  const results = [];
  for (const provider of providers) results.push(await refreshProviderCaps(provider, true));
  console.log(`[codex-switch] caps refresh: ${results.map((r) => `${r.provider}=${r.status}`).join(', ')}`);
  return results;
}

// ---------- helpers ----------
const HOP_BY_HOP = new Set([
  'host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding',
  'upgrade', 'proxy-connection', 'te', 'trailer', 'expect',
]);

function sendJson(res, status, obj) {
  if (res.destroyed || res.writableEnded) return;
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

// 所有 provider 变更的统一通道:解析 → 变更 → 重组 TOML → 校验 → 快照 → 写盘 → 热重载
function mutateProviders(fn) {
  loadConfig();
  const previousProviders = (cfg.providers || []).map((provider) => ({ ...provider }));
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
  const nextProviders = new Map((cfg.providers || []).map((provider) => [provider.id, provider]));
  for (const previous of previousProviders) {
    const next = nextProviders.get(previous.id);
    let sameConnection = false;
    try {
      sameConnection = Boolean(next)
        && providerConnectionIdentity(previous) === providerConnectionIdentity(next);
    } catch { /* Malformed or deleted providers invalidate cache fail closed. */ }
    if (!sameConnection || next?.enabled === false) invalidateDiscoveredModels(previous.id);
  }
  return result;
}

function requireBearerCred(np) {
  if (np.auth === 'bearer' && !np.token_env && !np.token) {
    throw new Error(`provider '${np.id}': bearer 认证需要填写 token_env(环境变量名)`);
  }
}

function submittedApiKey(input) {
  if (input.api_key === undefined) return '';
  if (typeof input.api_key !== 'string' || input.api_key.length > 4096) throw new Error('API Key 格式无效');
  return input.api_key.trim();
}

function captureProviderPersistenceState(tokenEnv) {
  return {
    config: fs.readFileSync(CONFIG_PATH, 'utf8'),
    envExists: fs.existsSync(ENV_FILE),
    envText: fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '',
    processHadKey: Object.prototype.hasOwnProperty.call(process.env, tokenEnv),
    processValue: process.env[tokenEnv],
  };
}

function restoreProviderPersistenceState(state, tokenEnv) {
  fs.writeFileSync(CONFIG_PATH, state.config);
  cfgMtime = 0;
  loadConfig();
  if (state.envExists) {
    fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
    fs.writeFileSync(ENV_FILE, state.envText, { mode: 0o600 });
  } else {
    try { fs.unlinkSync(ENV_FILE); } catch {}
  }
  if (state.processHadKey) process.env[tokenEnv] = state.processValue;
  else delete process.env[tokenEnv];
}

async function addProvider(p) {
  const np = normalizeProvider(p);
  requireBearerCred(np);
  const apiKey = submittedApiKey(p);
  if (apiKey && !ENV_NAME_RE.test(np.token_env || '')) throw new Error('保存 API Key 需要合法 token_env');
  const state = captureProviderPersistenceState(np.token_env || '');
  let result;
  try {
    result = mutateProviders((providers) => {
      if (providers.some((x) => x.id === np.id)) throw new Error(`provider '${np.id}' 已存在`);
      providers.push(np);
      return { ok: true, id: np.id };
    });
    if (apiKey) saveEnvKey(np.token_env, apiKey);
  } catch (error) {
    if (result) restoreProviderPersistenceState(state, np.token_env || '');
    throw error;
  }
  const capabilityRefresh = await refreshProviderCapsById(np.id, true);
  return { ...result, capability_refresh: capabilityRefresh };
}

async function updateProvider(origId, p) {
  const np = normalizeProvider(p);
  const apiKey = submittedApiKey(p);
  const original = (getConfig().providers || []).find((provider) => provider.id === origId);
  if (!original) throw new Error(`未找到 provider '${origId}'`);
  let connectionChanged = true;
  try { connectionChanged = providerConnectionIdentity(original) !== providerConnectionIdentity(np); } catch {}
  const hasNewInlineToken = Boolean(np.token && np.token !== original.token);
  if (np.auth === 'bearer' && connectionChanged && !apiKey && !hasNewInlineToken) {
    throw new Error('连接信息已变化，必须同时填写新的 API Key');
  }
  if (apiKey && !ENV_NAME_RE.test(np.token_env || '')) throw new Error('保存 API Key 需要合法 token_env');
  const state = captureProviderPersistenceState(np.token_env || original.token_env || '');
  let result;
  try {
    result = mutateProviders((providers) => {
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
    if (apiKey) saveEnvKey(np.token_env, apiKey);
    else if (p.delete_key === true && np.token_env) deleteEnvKey(np.token_env);
  } catch (error) {
    if (result) restoreProviderPersistenceState(state, np.token_env || original.token_env || '');
    throw error;
  }
  const capabilityRefresh = await refreshProviderCapsById(np.id, true);
  return { ...result, capability_refresh: capabilityRefresh };
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
  return { providers: enabled.length, total: (c.providers || []).length, models: sortSlugsForDisplay([...getRouteTable().keys()]) };
}

function capabilityCacheSummary(provider) {
  const cached = capsCache.get(provider.id);
  if (!cached) return { status: 'missing', model_count: 0, updated_at: null };
  const inspected = inspectDiscoveredCache(provider);
  if (inspected.status === 'identity_mismatch') return { status: 'missing', model_count: 0, updated_at: null };
  return {
    status: inspected.status,
    model_count: cached.models.size,
    updated_at: new Date(cached.at).toISOString(),
  };
}

function safeProviderOptions(providerType, value) {
  const preset = getProviderPreset(providerType);
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = {};
  for (const field of preset?.options || []) {
    const option = input[field.name];
    if (typeof option === 'string' || typeof option === 'boolean' || (typeof option === 'number' && Number.isFinite(option))) {
      output[field.name] = option;
    }
  }
  return output;
}

function projectProviderForAdmin(provider) {
  const inferredType = String(provider.provider_type || '').trim() || inferProviderType(provider.base_url);
  let normalized = null;
  try { normalized = normalizeProvider(provider); } catch { /* Existing malformed entries remain visible but are not trusted. */ }
  const providerType = normalized?.provider_type || inferredType;
  const output = {
    id: String(provider.id || ''),
    name: String(provider.name || provider.id || ''),
    provider_type: providerType,
    provider_options: normalized?.provider_options || safeProviderOptions(providerType, provider.provider_options),
    base_url: normalized?.base_url || String(provider.base_url || ''),
    auth: String(provider.auth || 'bearer'),
    models: Array.isArray(provider.models) ? provider.models.map(String) : [],
    enabled: provider.enabled !== false,
    capability_cache: capabilityCacheSummary(provider),
  };
  if (provider.token_env) output.token_env = String(provider.token_env);
  return output;
}

function parseDiscoveryInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid request');
  const providerType = typeof body.provider_type === 'string' ? body.provider_type.trim() : '';
  const preset = getProviderPreset(providerType);
  if (!preset || providerType.length > 64) throw new Error('invalid provider type');

  const providerId = body.provider_id === undefined ? '' : String(body.provider_id).trim();
  if (providerId && !/^[A-Za-z0-9_.-]{1,128}$/.test(providerId)) throw new Error('invalid provider id');

  const rawOptions = body.provider_options === undefined ? {} : body.provider_options;
  if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    throw new Error('invalid provider options');
  }
  const providerOptions = {};
  for (const field of preset.options) {
    const value = rawOptions[field.name];
    if (value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('invalid provider option');
    }
    providerOptions[field.name] = value;
  }

  const baseUrl = body.base_url === undefined ? '' : body.base_url;
  if (typeof baseUrl !== 'string' || baseUrl.length > 4096) throw new Error('invalid base URL');
  const apiKey = body.api_key === undefined ? '' : body.api_key;
  if (typeof apiKey !== 'string' || apiKey.length > 4096) throw new Error('invalid API key');
  return { providerType, providerId, providerOptions, baseUrl, apiKey: apiKey.trim() };
}

async function discoverProviderForAdmin(req, res, body) {
  let input;
  try { input = parseDiscoveryInput(body); } catch {
    return sendJson(res, 400, { error: 'invalid provider discovery request' });
  }
  const explicitKey = input.apiKey;
  const apiKey = explicitKey || resolveSavedProviderKey(input);
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('admin discovery request closed'));
  const abortOnClose = () => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort);
  res.once('close', abortOnClose);
  try {
    const result = await discoverProvider({
      providerType: input.providerType,
      providerOptions: input.providerOptions,
      baseUrl: input.baseUrl,
      apiKey,
      signal: controller.signal,
    });
    const cacheProvider = resolveDiscoveryCacheProvider(input);
    if (cacheProvider && result.models.length) cacheDiscoveredModels(cacheProvider, result.models);
    return sendJson(res, 200, result);
  } catch {
    return sendJson(res, 500, { error: 'provider discovery failed' });
  } finally {
    req.off('aborted', abort);
    res.off('close', abortOnClose);
  }
}

// ---------- admin ----------
function generateCodexConfig() {
  const c = getConfig();
  const configToml = `# --- codex-switch: managed by codex-switch (127.0.0.1 admin API) ---
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
  // 与 mergeCatalog 落盘结果保持一致:官方订阅在前、其余按名称倒排,priority 重排 1..N
  sortModelsForDisplay(catalog.models);
  catalog.models.forEach((m, i) => { m.priority = i + 1; });
  return { config_toml: configToml, catalog_json: JSON.stringify(catalog, null, 2) };
}



// ---------- 检查更新 / 自动安装(仅本机 127.0.0.1 管理页可触发) ----------
const PKG_VERSION = (() => {
  try { return String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '0.0.0'); } catch { return '0.0.0'; }
})();
const GITHUB_REPO = 'cnwenf/codex-switch';
const IS_APP_MODE = process.execPath.includes('.app/Contents/');
const REPO_ROOT = path.resolve(__dirname, '..');

function updateMode() {
  if (IS_APP_MODE) return 'app';
  return fs.existsSync(path.join(REPO_ROOT, '.git')) ? 'source' : 'unknown';
}

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// DoH(阿里 223.5.5.5)解析真实 IP,用于绕过本地 DNS 污染
function dohResolve(host) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: '223.5.5.5', path: '/resolve?name=' + encodeURIComponent(host) + '&type=A',
      headers: { accept: 'application/dns-json' }, timeout: 5000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          const ans = (JSON.parse(d).Answer || []).find((x) => x.type === 1);
          if (ans) resolve(ans.data); else reject(new Error('no A record: ' + host));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('DoH timeout')));
  });
}

function httpsGetUrl(urlStr, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const headers = { 'user-agent': 'codex-switch/' + PKG_VERSION, accept: opts.accept || '*/*' };
    if (opts.ip) headers.host = u.hostname;
    const req = https.request({
      host: opts.ip || u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
      servername: opts.ip ? u.hostname : undefined,
      headers, timeout: opts.timeout || 10000,
    }, resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout: ' + u.hostname)));
    req.end();
  });
}

// 先直连;失败或遭遇 DNS 污染特征(403)时,用 DoH 解析真实 IP 并以 SNI 方式重试;自动跟随重定向。
async function ghFetch(urlStr, opts) {
  opts = opts || {};
  let res = null, directErr = null;
  try { res = await httpsGetUrl(urlStr, opts); } catch (e) { directErr = e; }
  if (!res || res.statusCode === 403) {
    if (res) res.resume();
    const u = new URL(urlStr);
    if (!opts.ip) {
      const ip = await dohResolve(u.hostname).catch(() => null);
      if (!ip) throw directErr || new Error('resolve failed: ' + u.hostname);
      return ghFetch(urlStr, { ...opts, ip });
    }
    throw directErr || new Error('HTTP 403 via pinned ip for ' + u.hostname);
  }
  if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
    const loc = res.headers.location;
    res.resume();
    if (!loc) throw new Error('redirect without location');
    if ((opts.redirects || 0) >= 5) throw new Error('too many redirects');
    return ghFetch(new URL(loc, urlStr).toString(), { ...opts, redirects: (opts.redirects || 0) + 1, ip: undefined });
  }
  return res;
}

async function ghFetchJson(urlStr) {
  const res = await ghFetch(urlStr, { accept: 'application/vnd.github+json' });
  const chunks = [];
  for await (const c of res) chunks.push(c);
  if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function updateCheck() {
  try {
    const rel = await ghFetchJson('https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest');
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const asset = (rel.assets || []).find((a) => /\.dmg$/i.test(a.name || '')) || null;
    return {
      ok: true, mode: updateMode(), current: PKG_VERSION, latest,
      newer: cmpVersion(latest, PKG_VERSION) > 0,
      assetName: asset ? asset.name : null,
      assetUrl: asset ? asset.browser_download_url : null,
      assetSize: asset ? (asset.size || 0) : 0,
      releaseUrl: rel.html_url || '',
    };
  } catch (e) {
    return { ok: false, error: '检查更新失败: ' + e.message, current: PKG_VERSION, mode: updateMode() };
  }
}

const updateState = { phase: 'idle', pct: 0, downloaded: 0, total: 0, detail: '' };

function execFileP(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 180000, maxBuffer: 16 * 1024 * 1024, ...(opts || {}) }, (err, stdout, stderr) => {
      if (err) reject(new Error(file + ' 失败: ' + String(stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

function startUpdate() {
  if (updateState.phase === 'checking' || updateState.phase === 'downloading' || updateState.phase === 'installing') {
    return { ok: false, error: '更新正在进行中' };
  }
  const mode = updateMode();
  if (mode === 'unknown') return { ok: false, error: '无法识别安装方式(既非 .app 也非 git 源码目录),请手动更新' };
  runUpdatePipeline(mode).catch((e) => {
    updateState.phase = 'error';
    updateState.detail = String(e.message);
  });
  return { ok: true, mode };
}

async function runUpdatePipeline(mode) {
  updateState.phase = 'checking'; updateState.pct = 0; updateState.downloaded = 0; updateState.total = 0;
  updateState.detail = '正在查询最新版本…';
  const chk = await updateCheck();
  if (chk.ok === false) throw new Error(chk.error);
  if (!chk.newer) { updateState.phase = 'idle'; updateState.detail = ''; throw new Error('当前已是最新版本 v' + chk.current); }
  if (mode === 'source') return runSourceUpdate();
  if (!chk.assetUrl) throw new Error('该 Release 未附带 DMG 安装包');

  updateState.phase = 'downloading';
  updateState.detail = '正在下载 ' + chk.assetName + ' …';
  const dlDir = path.join(os.homedir(), '.codex-switch', 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  const dest = path.join(dlDir, chk.assetName);
  const tmp = dest + '.part';
  const res = await ghFetch(chk.assetUrl, { timeout: 20000 });
  if (res.statusCode !== 200) { res.resume(); throw new Error('下载失败: HTTP ' + res.statusCode); }
  updateState.total = parseInt(res.headers['content-length'] || '0', 10) || chk.assetSize || 0;
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    res.on('data', (c) => {
      updateState.downloaded += c.length;
      if (updateState.total > 0) updateState.pct = Math.min(99, Math.floor((updateState.downloaded / updateState.total) * 100));
    });
    res.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    res.pipe(ws);
  });
  fs.renameSync(tmp, dest);
  updateState.pct = 100;

  updateState.phase = 'installing';
  updateState.detail = '正在安装到 /Applications…';
  await installDmg(dest);

  updateState.phase = 'done';
  updateState.detail = '更新完成,正在重启应用…';
  const child = spawn('/bin/sh', ['-c', 'sleep 1; kill ' + process.pid + ' 2>/dev/null; sleep 1; open "/Applications/Codex Switch.app"'], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function installDmg(dmgPath) {
  const APP = 'Codex Switch';
  const out = await execFileP('hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-plist']);
  const m = out.match(/<string>(\/Volumes\/[^<]+)<\/string>/);
  if (!m) throw new Error('无法解析 DMG 挂载点');
  const mount = m[1];
  try {
    const src = path.join(mount, APP + '.app');
    if (!fs.existsSync(src)) throw new Error('DMG 内未找到 ' + APP + '.app');
    const dst = '/Applications/' + APP + '.app';
    fs.rmSync(dst, { recursive: true, force: true });
    await execFileP('cp', ['-R', src, '/Applications/']);
    await execFileP('xattr', ['-cr', dst]).catch(() => {});
  } finally {
    await execFileP('hdiutil', ['detach', mount]).catch(() => {});
  }
}

async function runSourceUpdate() {
  updateState.phase = 'downloading';
  updateState.total = 0; updateState.pct = 0;
  updateState.detail = '正在 git pull 拉取最新代码…';
  const dirty = await execFileP('git', ['-C', REPO_ROOT, 'status', '--porcelain']);
  if (dirty.trim()) {
    throw new Error('源码目录存在未提交改动,请先提交或 stash 后再更新:' + dirty.trim().split('\n').slice(0, 3).join(', '));
  }
  await execFileP('git', ['-C', REPO_ROOT, 'pull', '--ff-only', 'origin', 'main']);
  updateState.phase = 'installing';
  updateState.pct = 100;
  updateState.detail = '正在重启服务…';
  const startSh = path.join(REPO_ROOT, 'scripts', 'start.sh');
  const logFile = path.join(os.homedir(), '.codex-switch', 'run.log');
  const cmd = 'sleep 1; kill ' + process.pid + ' 2>/dev/null; sleep 1; nohup sh "' + startSh + '" >> "' + logFile + '" 2>&1 &';
  const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore' });
  child.unref();
  updateState.phase = 'done';
  updateState.detail = '更新完成,正在重启…';
}

async function handleAdmin(req, bodyBuf, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const { host, port } = getListenParts();
    return sendHtml(res, 200, renderAdminPage({ host, port, version: PKG_VERSION }));
  }

  if (req.method === 'GET' && p === '/__admin/provider-presets') {
    return sendJson(res, 200, { ok: true, presets: listProviderPresets() });
  }

  if (req.method === 'POST' && p === '/__admin/provider-discover'
    && !String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
    return sendJson(res, 415, { error: 'content type must be application/json' });
  }

  let body = {};
  if (bodyBuf.length && String(req.headers['content-type'] || '').includes('application/json')) {
    try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {
      return sendJson(res, 400, { error: 'invalid JSON body' });
    }
  }

  if (req.method === 'POST' && p === '/__admin/provider-discover') {
    return discoverProviderForAdmin(req, res, body);
  }

  // ---------- providers CRUD ----------
  if (p.startsWith('/__admin/providers')) {
    try {
      if (req.method === 'GET' && p === '/__admin/providers/export') {
        const c = getConfig();
        const id = String(url.searchParams.get('id') || '');
        const prov = (c.providers || []).find((x) => x.id === id);
        if (!prov) return sendJson(res, 404, { error: 'not found', id });
        const out = { ...prov };
        let apiKey = '';
        if (prov.token_env) apiKey = readEnvFileEntries().get(prov.token_env) || process.env[prov.token_env] || '';
        else if (prov.token) apiKey = prov.token; // 旧版内联 token:导出以便迁移到 env
        delete out.token; // 常规字段永不带明文;api_key 仅此显式导出端点返回
        return sendJson(res, 200, { ok: true, provider: { ...out, api_key: apiKey } });
      }
      if (req.method === 'GET' && p === '/__admin/providers') {
        const c = getConfig();
        const providers = (c.providers || []).map(projectProviderForAdmin);
        let officialSync = { modelCount: 0, sources: [] };
        try {
          const oc = officialCatalog();
          officialSync = { modelCount: oc.models.size, sources: oc.sources.map((s) => ({ bin: s.bin, models: s.modelCount })) };
        } catch { /* 提取失败不影响供应商列表 */ }
        return sendJson(res, 200, { ok: true, providers, union: enabledUnion(), officialSync, envKeys: envKeyStatus() });
      }
      if (req.method === 'POST' && p === '/__admin/providers') {
        return sendJson(res, 200, await addProvider(body));
      }
      if (req.method === 'POST' && p === '/__admin/providers/update') {
        const providerInput = body.provider || body;
        if (body.api_key !== undefined && providerInput.api_key === undefined) providerInput.api_key = body.api_key;
        if (body.delete_key === true) providerInput.delete_key = true;
        return sendJson(res, 200, await updateProvider(String(body.origId || ''), providerInput));
      }
      if (req.method === 'POST' && p === '/__admin/providers/toggle') {
        const toggled = toggleProvider(String(body.id || ''), body.enabled);
        const capabilityRefresh = toggled.enabled
          ? await refreshProviderCapsById(toggled.id, true)
          : { provider: toggled.id, status: 'skipped' };
        return sendJson(res, 200, { ...toggled, capability_refresh: capabilityRefresh });
      }
      if (req.method === 'POST' && p === '/__admin/providers/delete') {
        return sendJson(res, 200, deleteProvider(String(body.id || '')));
      }
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message) });
    }
    return sendJson(res, 404, { error: 'not found', path: p });
  }

  // ---------- API 凭证(页面填写 → ~/.codex-switch/env,值只进文件与 process.env) ----------
  if (p.startsWith('/__admin/env-keys')) {
    try {
      if (req.method === 'GET' && p === '/__admin/env-keys') {
        return sendJson(res, 200, { ok: true, keys: envKeyStatus() }); // 只有 name+configured,绝不回传值
      }
      if (req.method === 'POST' && p === '/__admin/env-keys/save') {
        const saved = saveEnvKey(String(body.name || ''), body.value);
        const capabilityRefresh = await refreshCapsForTokenEnv(saved.name);
        return sendJson(res, 200, { ...saved, capability_refresh: capabilityRefresh });
      }
      if (req.method === 'POST' && p === '/__admin/env-keys/delete') {
        return sendJson(res, 200, deleteEnvKey(String(body.name || '')));
      }
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message) });
    }
    return sendJson(res, 404, { error: 'not found', path: p });
  }

  // ---------- 检查更新 / 自动安装 ----------
  if (p.startsWith('/__admin/update')) {
    try {
      if (req.method === 'GET' && p === '/__admin/update/check') {
        return sendJson(res, 200, await updateCheck());
      }
      if (req.method === 'POST' && p === '/__admin/update/run') {
        const j = startUpdate();
        return sendJson(res, j.ok === false ? 400 : 200, j);
      }
      if (req.method === 'GET' && p === '/__admin/update/status') {
        return sendJson(res, 200, { ok: true, state: updateState, mode: updateMode() });
      }
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message) });
    }
    return sendJson(res, 404, { error: 'not found', path: p });
  }

  // ---------- 开机自动启动 (macOS LaunchAgent) ----------
  if (p.startsWith('/__admin/autostart')) {
    try {
      if (req.method === 'GET' && p === '/__admin/autostart') {
        return sendJson(res, 200, { ok: true, ...autostartStatus() });
      }
      if (req.method === 'POST' && p === '/__admin/autostart') {
        return sendJson(res, 200, setAutostart(Boolean(body.enabled)));
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

  // ---------- health(macOS 菜单栏小程序每 5s 轮询的轻量端点) ----------
  if (req.method === 'GET' && p === '/__admin/health') {
    const c = getConfig();
    const providers = (c.providers || []).filter((x) => x && x.enabled !== false).length;
    const phase = updateState?.phase;
    const updating = (phase && phase !== 'idle' && phase !== 'error') ? phase : null;
    return sendJson(res, 200, {
      ok: true, version: PKG_VERSION, mode: updateMode(),
      uptime: Math.round(process.uptime()), providers, models: getRouteTable().size, updating,
    });
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
    const restored = restoreCodexOfficial();
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
  const isAdmin = url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/__admin');
  const isProxy = url.pathname.startsWith(mountPrefix);
  const chunks = [];
  let bodyBytes = 0;
  let adminBodyTooLarge = false;
  req.on('data', (c) => {
    bodyBytes += c.length;
    if (isAdmin && bodyBytes > MAX_ADMIN_BODY_BYTES) {
      adminBodyTooLarge = true;
      chunks.length = 0;
      return;
    }
    if (!adminBodyTooLarge) chunks.push(c);
  });
  req.on('end', () => {
    if (adminBodyTooLarge) return sendJson(res, 413, { error: 'request body too large' });
    const bodyBuf = Buffer.concat(chunks);
    if (isAdmin) handleAdmin(req, bodyBuf, res).catch(() => {
      console.warn('[codex-switch] admin request failed');
      sendJson(res, 500, { error: 'internal server error' });
    });
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
  const envLoaded = loadEnvFileIntoProcess();
  if (envLoaded) console.log(`[codex-switch] env file loaded: ${envLoaded} key(s) from ${ENV_FILE}`);
  ensureDefaultAutostart();
  const off = detectOfficial();
  console.log(off.loggedIn
    ? `[codex-switch] official subscription: logged in (${off.identity || 'account'}), preserving ${off.configSections.length} config sections + ${off.officialModels.length} official models`
    : '[codex-switch] official subscription: not detected (auth.json missing or no access_token)');
  const { host, port } = getListenParts();
  const server = http.createServer(handle);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[codex-switch] 端口 ${port} 已被占用 — 可能已有实例在运行(管理页: http://${host}:${port}/),本实例退出。`);
    } else {
      console.error(`[codex-switch] listen error: ${e.message}`);
    }
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
