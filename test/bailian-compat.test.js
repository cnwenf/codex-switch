import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareBailianRequest } from '../src/bailian-compat.js';

const provider = { provider_type: 'bailian' };
const heartbeat = { type: 'function_call_output', name: 'automation_update', namespace: 'codex_app', id: 'fco_1', output: '<heartbeat>继续任务</heartbeat>' };
const encode = (input) => Buffer.from(JSON.stringify({ model: 'kimi-k3', prompt_cache_key: 'session', input }));

test('Bailian expands local tool schema references and cuts recursive edges only', () => {
  const parameters = { type: 'object', properties: {
    first: { $ref: '#/$defs/node' }, second: { $ref: '#/$defs/node' },
  }, $defs: { node: { type: 'object', properties: {
    value: { type: 'string' }, next: { $ref: '#/$defs/node' },
  } } } };
  const fn = { type: 'function', name: 'example', parameters, strict: false };
  const body = Buffer.from(JSON.stringify({ input: [], tools: [fn, { type: 'namespace', name: 'app', tools: [fn] }], prompt_cache_key: 'same' }));
  const result = JSON.parse(prepareBailianRequest(provider, '/responses', body));
  const node = { type: 'object', properties: { value: { type: 'string' }, next: {} } };
  const expected = { type: 'object', properties: { first: node, second: node } };
  assert.deepEqual(result.tools[0], { ...fn, parameters: expected });
  assert.deepEqual(result.tools[1].tools[0].parameters, expected);
  assert.equal(result.prompt_cache_key, 'same');
  assert.equal(prepareBailianRequest({ provider_type: 'openai' }, '/responses', body), body);
  assert.equal(prepareBailianRequest(provider, '/chat/completions', body), body);
});

test('tool schemas without references or with unresolved references stay byte-identical', () => {
  for (const parameters of [{ type: 'object', properties: {} }, { $ref: '#/$defs/missing' }, { $ref: 'https://example.com/schema' }]) {
    const body = Buffer.from(JSON.stringify({ input: [], tools: [{ type: 'function', name: 'example', parameters }] }));
    assert.equal(prepareBailianRequest(provider, '/responses', body), body);
  }
});

test('schema property names and literal values are not interpreted as schema keywords', () => {
  const literal = { $ref: 'literal data' };
  const parameters = { type: 'object', properties: {
    $ref: { $ref: '#/$defs/a~1b~0c', description: 'keep sibling constraints' },
    enum: { $ref: '#/$defs/a~1b~0c' },
  }, default: literal, $defs: { 'a/b~c': { type: 'string' } } };
  const body = Buffer.from(JSON.stringify({ input: [], tools: [{ type: 'function', parameters }] }));
  const result = JSON.parse(prepareBailianRequest(provider, '/responses', body)).tools[0].parameters;
  assert.deepEqual(result.properties.$ref, { allOf: [{ type: 'string' }, { description: 'keep sibling constraints' }] });
  assert.deepEqual(result.properties.enum, { type: 'string' });
  assert.deepEqual(result.default, literal);
});

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
