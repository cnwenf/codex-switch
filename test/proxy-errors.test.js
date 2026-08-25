import assert from 'node:assert/strict';
import test from 'node:test';

import { safeUpstreamCauseCode } from '../src/proxy-errors.js';

test('upstream diagnostics expose only allowlisted stable cause codes', () => {
  const secret = 'secret-token-in-error-message';
  const cases = [
    ['EMFILE', 'EMFILE'],
    ['ECONNRESET', 'ECONNRESET'],
    ['ETIMEDOUT', 'ETIMEDOUT'],
    ['ENOTFOUND', 'ENOTFOUND'],
    ['EAI_AGAIN', 'EAI_AGAIN'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'TLS_CERT'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'TLS_CERT'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS_CERT'],
    ['ATTACKER_CONTROLLED', 'UNKNOWN'],
  ];

  for (const [causeCode, expected] of cases) {
    const error = new TypeError(`fetch failed ${secret} https://example.invalid/?token=${secret}`, {
      cause: Object.assign(new Error(`socket detail ${secret}`), { code: causeCode }),
    });
    const actual = safeUpstreamCauseCode(error);
    assert.equal(actual, expected);
    assert.equal(actual.includes(secret), false);
  }
});

test('upstream diagnostics bound hostile cause chains and never stringify them', () => {
  const secret = 'nested-secret-bearing-message';
  const first = { code: 'ATTACKER_CONTROLLED', message: secret };
  let current = first;
  for (let i = 0; i < 50; i += 1) {
    current.cause = { code: 'ATTACKER_CONTROLLED', message: `${secret}-${i}` };
    current = current.cause;
  }
  current.cause = first;

  assert.equal(safeUpstreamCauseCode(first), 'UNKNOWN');
});
