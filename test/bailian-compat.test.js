import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareBailianRequest } from '../src/bailian-compat.js';

const provider = { provider_type: 'bailian' };
const heartbeat = { type: 'function_call_output', name: 'automation_update', namespace: 'codex_app', id: 'fco_1', output: '<heartbeat>继续任务</heartbeat>' };
const encode = (input) => Buffer.from(JSON.stringify({ model: 'kimi-k3', prompt_cache_key: 'session', input }));

test('Bailian also converts unpaired cross-thread notifications and plain tool text', () => {
  for (const output of ['<codex_delegation>Reply OK</codex_delegation>', 'plain notification']) {
    const result = JSON.parse(prepareBailianRequest(provider, '/responses', encode([{ type: 'function_call_output', output }])));
    assert.deepEqual(result.input, [{ role: 'user', content: [{ type: 'input_text', text: output }] }]);
  }
});

test('previously repaired heartbeat messages drop their incompatible tool-result ID only', () => {
  const message = { type: 'message', role: 'user', id: 'fco_1', content: [{ type: 'input_text', text: '<heartbeat>继续任务</heartbeat>' }] };
  const result = JSON.parse(prepareBailianRequest(provider, '/responses', encode([message])));
  assert.deepEqual(result.input, [{ type: 'message', role: 'user', content: message.content }]);
  for (const item of [{ ...message, id: 'msg_1' }, { ...message, content: [{ type: 'input_text', text: 'ordinary message' }] }]) {
    const body = encode([item]);
    assert.equal(prepareBailianRequest(provider, '/responses', body), body);
  }
});

test('Bailian converts only heartbeat results without a usable call ID, preserving text and session', () => {
  for (const call_id of [undefined, null, '', '  ']) {
    const body = encode([{ ...heartbeat, call_id }]);
    const result = JSON.parse(prepareBailianRequest(provider, '/responses', body));
    assert.deepEqual(result.input, [{ role: 'user', content: [{ type: 'input_text', text: heartbeat.output }] }]);
    assert.equal(result.prompt_cache_key, 'session');
    assert.equal(result.model, 'kimi-k3');
  }
});

test('normal tools, other providers, other endpoints and unrelated malformed items remain byte-identical', () => {
  const inputs = [
    [{ ...heartbeat, call_id: 'call_1' }],
    [{ type: 'function_call_output', call_id: 'call_2', output: 'not a heartbeat' }],
    [{ ...heartbeat, output: { text: 'not a string' } }],
    [{ role: 'user', content: 'hello' }],
  ];
  for (const input of inputs) {
    const body = encode(input);
    assert.equal(prepareBailianRequest(provider, '/responses', body), body);
  }
  const body = encode([heartbeat]);
  assert.equal(prepareBailianRequest({ provider_type: 'openai' }, '/responses', body), body);
  assert.equal(prepareBailianRequest(provider, '/chat/completions', body), body);
  assert.equal(prepareBailianRequest(provider, '/responses', Buffer.from('not json')).toString(), 'not json');
});

test('legacy Bailian endpoint and query strings receive the same compatibility fix', () => {
  const body = encode([heartbeat]);
  assert.notEqual(prepareBailianRequest({ base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, '/responses?x=1', body), body);
});
