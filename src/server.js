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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CODEXSWITCH_CONFIG || path.join(__dirname, '..', 'config.toml');
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
    for (const model of p.models || []) {
      if (m.has(model)) {
        console.warn(`[codex-switch] duplicate model '${model}': '${m.get(model).id}' shadowed by '${p.id}'`);
      }
      m.set(model, p);
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
function getRouteTable() {
  loadConfig();
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

// ---------- capability refresh (Bailian live model list, cached 30 min) ----------
// Fetches context_window / input modalities from the Bailian native /api/v1/models
// for providers that are DashScope endpoints; other providers are skipped (static
// table in caps.js covers them). Never touches request forwarding — catalog only.
async function refreshAllCaps(force) {
  const results = [];
  for (const provider of getConfig().providers || []) {
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

// ---------- admin ----------
function generateCodexConfig() {
  const c = getConfig();
  const { host, port } = getListenParts();
  const mountPrefix = (c.proxy?.mount_prefix || DEFAULT_MOUNT).replace(/\/+$/, '');
  const base_url = `http://${host}:${port}${mountPrefix}`;
  const configToml = `# --- codex-switch: add to ~/.codex/config.toml ---
model_catalog_json = "~/.codex/catalog.json"   # replaces the bundled model catalog

[model_providers.codexswitch]
name = "codex-switch"
base_url = "${base_url}"
wire_api = "responses"
requires_openai_auth = true   # Codex manages OAuth refresh + carries subscription headers
`;
  const catalog = { models: [] };
  for (const [id, prov] of getRouteTable().entries()) {
    const caps = resolveCaps(c, prov, id);
    catalog.models.push(buildCatalogEntry(id, caps, prov));
  }
  return { config_toml: configToml, catalog_json: JSON.stringify(catalog, null, 2) };
}

function renderAdminPage() {
  const c = getConfig();
  const rows = (c.providers || []).map((p) => `
    <tr><td>${esc(p.id)}</td><td>${esc(p.name)}</td><td>${esc(p.auth)}</td><td>${esc(p.base_url)}</td><td>${(p.models || []).map(esc).join(', ')}</td></tr>`).join('');
  const capsRows = [...getRouteTable().entries()].map(([id, prov]) => {
    const caps = resolveCaps(c, prov, id);
    return `<tr><td>${esc(id)}</td><td>${esc(prov.id)}</td><td>${caps.contextWindow ?? '?'}</td><td>${caps.vision ? 'text + image' : 'text'}</td><td>${caps.levels.length ? caps.levels.join(', ') : '—'}</td><td>${esc(caps.defaultLevel || '—')}</td><td>${esc(caps.source)}</td></tr>`;
  }).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>codex-switch</title>
<style>
body{font:14px/1.5 system-ui,-apple-system,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#1a1c1f}
h1{font-size:1.4rem;margin:0 0 .3rem}h2{font-size:1.05rem;margin-top:2rem}
table{border-collapse:collapse;width:100%;margin:.5rem 0}td,th{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;font-size:13px}
code{background:#f3f3f3;padding:.1rem .3rem;border-radius:3px}pre{background:#f5f5f5;padding:1rem;overflow:auto;border-radius:6px;font-size:12px}
.muted{color:#666;font-size:13px}button{cursor:pointer;border:1px solid #ccc;background:#fff;padding:.3rem .8rem;border-radius:4px}
button:hover{background:#f0f0f0}textarea{width:100%;box-sizing:border-box;font:12px/1.4 monospace}
.ok{color:#080}.err{color:#b00}
</style></head><body>
<h1>codex-switch</h1>
<p class="muted">listen <code>${esc(c.proxy?.listen || DEFAULT_LISTEN)}</code> · mount <code>${esc(c.proxy?.mount_prefix || DEFAULT_MOUNT)}</code> · ${getRouteTable().size} models</p>

<h2>Providers</h2>
<table><thead><tr><th>id</th><th>name</th><th>auth</th><th>base_url</th><th>models</th></tr></thead><tbody>${rows}</tbody></table>

<h2>Model capabilities <button onclick="refreshCaps()">refresh (fetch live)</button> <span id="capsStatus" class="muted"></span></h2>
<p class="muted">解析优先级:config.toml <code>[model_overrides]</code> > 百炼联网获取(仅 Bailian 且配了 API key,缓存 30 分钟)> 内置静态表 > 保守默认(128K·无视觉·不声明推理档位)。能力只影响生成的 catalog.json,不影响转发字节。</p>
<table><thead><tr><th>model</th><th>provider</th><th>context window</th><th>input modalities</th><th>reasoning efforts</th><th>default</th><th>source</th></tr></thead><tbody>${capsRows}</tbody></table>

<h2>Edit config.toml <span id="saveStatus" class="muted"></span></h2>
<textarea id="cfg" rows="22" cols="100"></textarea><br>
<button onclick="save()">save &amp; reload</button>

<h2>Codex config (paste into <code>~/.codex/config.toml</code>)</h2>
<pre id="codexCfg"></pre>
<h2>Codex catalog (<code>~/.codex/catalog.json</code>)</h2>
<pre id="codexCat"></pre>

<script>
fetch('/__admin/config').then(r=>r.text()).then(t=>document.getElementById('cfg').value=t);
fetch('/__admin/codex-config').then(r=>r.json()).then(d=>{document.getElementById('codexCfg').textContent=d.config_toml;document.getElementById('codexCat').textContent=d.catalog_json;});
async function refreshCaps(){
  const s=document.getElementById('capsStatus');
  s.className='muted';s.textContent=' fetching…';
  try{
    const r=await fetch('/__admin/fetch-capabilities',{method:'POST'});
    const j=await r.json();
    if(r.ok){s.className='ok';s.textContent=' ✓ '+(j.results||[]).map(x=>x.provider+'='+x.status+(x.detail?(' ('+x.detail+')'):'')).join(', ');setTimeout(()=>location.reload(),800);}
    else{s.className='err';s.textContent=' ✗ '+(j.error||'failed');}
  }catch(e){s.className='err';s.textContent=' ✗ '+e.message;}
}
async function save(){
  const t=document.getElementById('cfg').value;
  const s=document.getElementById('saveStatus');
  s.className='muted';s.textContent='saving…';
  try{
    const r=await fetch('/__admin/config',{method:'POST',headers:{'content-type':'text/plain'},body:t});
    const j=await r.json();
    if(r.ok){s.className='ok';s.textContent='saved ✓';setTimeout(()=>location.reload(),400);}
    else{s.className='err';s.textContent='✗ '+(j.error||'failed')+': '+(j.detail||'');}
  }catch(e){s.className='err';s.textContent='✗ '+e.message;}
}
</script>
</body></html>`;
}

async function handleAdmin(req, bodyBuf, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendHtml(res, 200, renderAdminPage());
  if (req.method === 'GET' && p === '/__admin/codex-config') return sendJson(res, 200, generateCodexConfig());
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
    fs.writeFileSync(CONFIG_PATH, text);
    cfgMtime = 0; loadConfig(); // force reload
    // fire-and-forget: re-fetch capabilities for the new config (provider list may have changed)
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
  loadConfig();
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
