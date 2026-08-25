import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

async function unusedPort() {
  const server = net.createServer();
  const address = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitUntil(predicate, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function countProcessFds(pid) {
  const procFd = `/proc/${pid}/fd`;
  if (fs.existsSync(procFd)) return fs.readdirSync(procFd).length;
  try {
    const output = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-Fn'], { encoding: 'utf8' });
    return output.split('\n').filter((line) => line.startsWith('f')).length;
  } catch {
    return null;
  }
}

async function startProxyFixture(t, upstreamHandler, { baseUrl } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-proxy-'));
  const upstream = http.createServer(upstreamHandler);
  const upstreamAddress = await listen(upstream);
  const upstreamOrigin = `http://127.0.0.1:${upstreamAddress.port}`;
  const port = await unusedPort();
  const configPath = path.join(home, 'config.toml');
  fs.writeFileSync(configPath, [
    '[proxy]',
    `listen = "127.0.0.1:${port}"`,
    'mount_prefix = "/v1"',
    `auth_json_path = ${JSON.stringify(path.join(home, '.codex', 'auth.json'))}`,
    '',
    '[[providers]]',
    'id = "subscription"',
    'name = "ChatGPT Subscription"',
    `base_url = ${JSON.stringify(baseUrl || upstreamOrigin + '/backend-api/codex')}`,
    'auth = "chatgpt_subscription"',
    'models = ["fixture-subscription-model"]',
    'enabled = true',
    '',
  ].join('\n'));

  let output = '';
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: REPO_ROOT,
    env: {
      HOME: home,
      PATH: '/usr/bin:/bin',
      TMPDIR: os.tmpdir(),
      CODEXSWITCH_CONFIG: configPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`codex-switch exited with ${child.exitCode}: ${output}`);
    try {
      const response = await fetch(`${origin}/__admin/health`);
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!healthy) throw new Error(`codex-switch fixture did not become healthy: ${output}`);

  t.after(async () => {
    await stopChild(child);
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { child, origin, home, configPath, output: () => output };
}

function postAndCancelAfterFirstChunk(origin) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    request.on('error', (error) => {
      if (['ECONNRESET', 'EPIPE'].includes(error.code)) resolve();
      else reject(error);
    });
    request.on('response', (response) => {
      response.once('data', () => {
        response.destroy();
        resolve();
      });
    });
    request.end(JSON.stringify({ model: 'fixture-subscription-model', input: 'cancel' }));
  });
}

test('downstream cancellation after the first SSE chunk closes upstream within 250ms', async (t) => {
  let postCount = 0;
  let upstreamClosedAt = 0;
  let clientCancelledAt = 0;
  let timer;
  const app = await startProxyFixture(t, (req, res) => {
    if (req.method !== 'POST') return res.end('{"data":[]}');
    postCount += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.output_text.delta\ndata: {"delta":"one"}\n\n');
    timer = setInterval(() => res.write(': keepalive\n\n'), 25);
    res.once('close', () => {
      clearInterval(timer);
      upstreamClosedAt = Date.now();
    });
  });

  await postAndCancelAfterFirstChunk(app.origin);
  clientCancelledAt = Date.now();
  await waitUntil(() => upstreamClosedAt > 0, 'upstream stayed open after downstream cancelled', 250);
  assert.equal(postCount, 1);
  assert.ok(upstreamClosedAt - clientCancelledAt < 250);
});

test('downstream cancellation before upstream headers aborts the one in-flight POST', async (t) => {
  let postCount = 0;
  let started = false;
  let closed = false;
  const app = await startProxyFixture(t, (req, res) => {
    if (req.method !== 'POST') return res.end('{"data":[]}');
    postCount += 1;
    started = true;
    req.once('close', () => { closed = true; });
    setTimeout(() => {
      if (!res.destroyed) res.end('late headers');
    }, 2_000).unref();
  });

  const request = http.request(`${app.origin}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  request.on('error', () => {});
  request.end(JSON.stringify({ model: 'fixture-subscription-model', input: 'cancel-before-headers' }));
  await waitUntil(() => started, 'upstream POST did not start');
  request.destroy();
  await waitUntil(() => closed, 'headers-before cancellation did not close upstream', 250);
  assert.equal(postCount, 1);
});

test('300 cancelled SSE requests leave no active upstreams or growing FD count', async (t) => {
  let active = 0;
  let postCount = 0;
  const timers = new Set();
  const app = await startProxyFixture(t, (req, res) => {
    if (req.method !== 'POST') return res.end('{"data":[]}');
    postCount += 1;
    active += 1;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      active -= 1;
      clearInterval(timer);
      timers.delete(timer);
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    const timer = setInterval(() => res.write(': ping\n\n'), 20);
    timers.add(timer);
    res.once('close', close);
  });
  t.after(() => {
    for (const timer of timers) clearInterval(timer);
  });

  const beforeFds = countProcessFds(app.child.pid);
  for (let i = 0; i < 300; i += 1) await postAndCancelAfterFirstChunk(app.origin);
  await waitUntil(() => active === 0, `active upstream requests remained: ${active}`, 2_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const afterFds = countProcessFds(app.child.pid);
  assert.equal(postCount, 300);
  assert.equal(active, 0);
  if (beforeFds !== null && afterFds !== null) assert.ok(afterFds <= beforeFds + 6, `FD count grew ${beforeFds} -> ${afterFds}`);

  const response = await fetch(`${app.origin}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture-subscription-model', input: 'still healthy' }),
    signal: AbortSignal.timeout(1_000),
  });
  assert.notEqual(response.status, 502);
  await response.body.cancel();
});

test('normal SSE completes byte-for-byte and does not abort its upstream', async (t) => {
  const chunks = [
    Buffer.from('event: response.created\ndata: {"id":"one"}\n\n'),
    Buffer.from([0x65, 0x76, 0x65, 0x6e, 0x74, 0x3a, 0x20, 0x64, 0x6f, 0x6e, 0x65, 0x0a, 0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0x7b, 0x7d, 0x0a, 0x0a]),
  ];
  let postCount = 0;
  let upstreamClosed = false;
  const app = await startProxyFixture(t, (req, res) => {
    if (req.method !== 'POST') return res.end('{"data":[]}');
    postCount += 1;
    req.once('aborted', () => { upstreamClosed = true; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunks[0]);
    res.end(chunks[1]);
  });

  const response = await fetch(`${app.origin}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture-subscription-model', input: 'complete' }),
  });
  assert.equal(response.status, 200);
  const actual = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(actual, Buffer.concat(chunks));
  assert.equal(postCount, 1);
  assert.equal(upstreamClosed, false);
});

test('a connect failure returns and logs only a safe code, never the upstream URL', async (t) => {
  const closedPort = await unusedPort();
  const secret = 'secret-bearing-path-fragment';
  const secretUrl = `http://127.0.0.1:${closedPort}/${secret}`;
  const app = await startProxyFixture(t, (_req, res) => res.end(), { baseUrl: secretUrl });

  const response = await fetch(`${app.origin}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture-subscription-model', input: 'fail safely' }),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'upstream connect failed', code: 'UNKNOWN' });
  await waitUntil(() => app.output().includes('upstream request failed'), 'safe failure was not logged');
  assert.equal(app.output().includes(secret), false);
  assert.equal(app.output().includes(secretUrl), false);
});
