// codex-switch — 官方模型目录自动提取(auto-sync)。
//
// 官方模型目录内嵌在 codex 二进制里(Rust include_str!),不是外部文件:
// OpenAI 新增模型 → codex CLI / ChatGPT 桌面端升级 → 新目录随之而来。
// 本模块扫描本机所有 codex 二进制,字节级抠出内嵌 catalog 并按模型合并
// (同一 slug 以更新的二进制为准),于是:
//   官方新增模型 → 用户升级 codex → codex-switch 自动发现,零手工维护。
//
// 安全与性能:
//  - 只读,绝不写任何 codex 文件;
//  - 按 (mtime,size) 缓存:二进制不变时只做几次 stat,不重复读 250MB;
//  - 提取失败返回空,调用方回退到配置里的静态模型列表。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------- 二进制发现 ----------
function npmRoots() {
  const roots = [];
  const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  if (fs.existsSync(nvmDir)) {
    for (const v of fs.readdirSync(nvmDir)) {
      roots.push(path.join(nvmDir, v, 'lib', 'node_modules'));
    }
  }
  roots.push(
    '/opt/homebrew/lib/node_modules',
    '/usr/local/lib/node_modules',
    path.join(os.homedir(), '.volta', 'lib', 'node_modules'),
  );
  return roots;
}

// 候选二进制:桌面端(更新通常最快)+ npm 全局安装(含 nvm 多版本)
export function candidateBinaries() {
  const out = ['/Applications/ChatGPT.app/Contents/Resources/codex'];
  for (const root of npmRoots()) {
    const plats = path.join(root, '@openai', 'codex', 'node_modules', '@openai');
    if (fs.existsSync(plats)) {
      for (const plat of fs.readdirSync(plats)) {
        if (!plat.startsWith('codex-')) continue; // codex-darwin-arm64 等平台包
        const vendor = path.join(plats, plat, 'vendor');
        if (!fs.existsSync(vendor)) continue;
        for (const target of fs.readdirSync(vendor)) {
          const bin = path.join(vendor, target, 'bin', 'codex');
          if (fs.existsSync(bin)) out.push(bin);
        }
      }
    }
  }
  return [...new Set(out)];
}

// ---------- 字节级提取 ----------
// 内嵌 catalog 是带缩进的 JSON(含换行),在二进制里是连续字节。
// 从 '"models"' 标记向前找 '{',再做括号配对直到收敛,JSON.parse 校验。
function looksLikeCatalog(cat) {
  return !!cat && Array.isArray(cat.models) && cat.models.length > 0
    && cat.models.every((m) => m && typeof m.slug === 'string')
    && cat.models.some((m) => Array.isArray(m.supported_reasoning_levels));
}

function extractEmbeddedCatalog(binPath) {
  let data;
  try { data = fs.readFileSync(binPath); } catch { return null; }
  let from = 0;
  for (;;) {
    const idx = data.indexOf('"models"', from);
    if (idx < 0) return null;
    from = idx + 8;
    const start = data.lastIndexOf('{', idx);
    if (start < 0) continue;
    let depth = 0; let instr = false; let esc = false; let end = -1;
    for (let j = start; j < data.length; j++) {
      const c = data[j];
      if (instr) {
        if (esc) esc = false;
        else if (c === 0x5c) esc = true; // backslash
        else if (c === 0x22) instr = false; // quote
        continue;
      }
      if (c === 0x22) instr = true;
      else if (c === 0x7b) depth++; // {
      else if (c === 0x7d) { depth--; if (depth === 0) { end = j + 1; break; } } // }
    }
    if (end < 0) return null;
    let cat = null;
    try { cat = JSON.parse(data.toString('utf8', start, end)); } catch { cat = null; }
    if (looksLikeCatalog(cat)) return cat;
    // 不是 catalog(别的 JSON),继续找下一个 '"models"'
  }
}

// ---------- 缓存 + 合并 ----------
const binCache = new Map(); // binPath -> { mtimeMs, size, catalog|null }

function readBinaryCatalog(binPath) {
  let st;
  try { st = fs.statSync(binPath); } catch { binCache.delete(binPath); return null; }
  const hit = binCache.get(binPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.catalog;
  const catalog = extractEmbeddedCatalog(binPath); // 重操作,仅二进制变化时发生
  binCache.set(binPath, { mtimeMs: st.mtimeMs, size: st.size, catalog });
  if (catalog) console.log(`[codex-switch] official catalog extracted: ${binPath} (${catalog.models.length} models)`);
  return catalog;
}

// 合并所有二进制的 catalog:Map<slug, entry> + 来源信息。
// 同一 slug 以 mtime 最新的二进制条目为准(新客户端带来新模型/新字段)。
// 任何一步失败都不抛错:返回空 Map,调用方回退静态列表。
export function officialCatalog() {
  const bins = [];
  for (const bin of candidateBinaries()) {
    try {
      const catalog = readBinaryCatalog(bin);
      if (!catalog) continue;
      const st = fs.statSync(bin);
      bins.push({ bin, mtimeMs: st.mtimeMs, catalog });
    } catch { /* skip */ }
  }
  bins.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const models = new Map();
  for (const b of bins) {
    for (const m of b.catalog.models) {
      if (m && typeof m.slug === 'string' && !models.has(m.slug)) models.set(m.slug, m);
    }
  }
  return {
    models,
    sources: bins.map((b) => ({ bin: b.bin, mtimeMs: b.mtimeMs, modelCount: b.catalog.models.length })),
  };
}
