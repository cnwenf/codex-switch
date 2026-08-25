import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import TOML from '@iarna/toml';

test('fresh config contains only the ChatGPT subscription provider', () => {
  const config = TOML.parse(fs.readFileSync(new URL('../config.toml', import.meta.url), 'utf8'));
  assert.deepEqual(config.providers.map((provider) => provider.id), ['chatgpt-sub']);
  assert.equal(config.providers[0].provider_type, 'chatgpt-sub');
  assert.equal(config.providers.some((provider) => provider.id === 'bailian'), false);
});
