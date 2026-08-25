const NETWORK_CODES = new Set([
  'EMFILE',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

const TLS_CERT_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

export function safeUpstreamCauseCode(error) {
  let current = error;
  const seen = new Set();
  for (let depth = 0; current && depth < 8; depth += 1) {
    if ((typeof current !== 'object' && typeof current !== 'function') || seen.has(current)) break;
    seen.add(current);
    let code;
    let cause;
    try {
      code = typeof current.code === 'string' ? current.code : '';
      cause = current.cause;
    } catch {
      return 'UNKNOWN';
    }
    if (NETWORK_CODES.has(code)) return code;
    if (TLS_CERT_CODES.has(code)) return 'TLS_CERT';
    current = cause;
  }
  return 'UNKNOWN';
}
