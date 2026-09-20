import { inferProviderType } from './provider-registry.js';

function expandToolSchema(root) {
  let remaining = 10000;
  function visit(value, refs = []) {
    if (--remaining < 0) throw new Error('Schema expansion limit');
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => visit(item, refs));
    const { $ref, $defs, ...fields } = value;
    const result = Object.fromEntries(Object.entries(fields).map(([key, item]) => [key,
      ['default', 'const', 'enum', 'examples'].includes(key) ? item
        : ['properties', 'patternProperties', 'dependentSchemas'].includes(key)
          ? Object.fromEntries(Object.entries(item).map(([name, schema]) => [name, visit(schema, refs)]))
          : visit(item, refs)]));
    if ($ref === undefined) return result;
    if (typeof $ref !== 'string' || !$ref.startsWith('#/')) throw new Error('Unsupported schema reference');
    let target = root;
    for (const part of $ref.slice(2).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!target || !Object.hasOwn(target, key)) throw new Error('Unresolved schema reference');
      target = target[key];
    }
    // ponytail: allow arbitrary JSON at recursive edges; runtime tools still validate arguments.
    const expanded = refs.includes($ref) ? {} : visit(target, [...refs, $ref]);
    return Object.keys(result).length ? { allOf: [expanded, result] } : expanded;
  }
  return visit(root);
}

export function prepareBailianRequest(provider, suffix, body) {
  if ((provider.provider_type || inferProviderType(provider.base_url)) !== 'bailian'
      || !/^\/responses\/?(?:\?|$)/.test(suffix)) return body;
  try {
    const request = JSON.parse(body.toString('utf8'));
    if (!Array.isArray(request.input)) return body;
    let changed = false;
    for (const tool of request.tools || []) {
      for (const fn of tool.type === 'namespace' ? tool.tools || [] : [tool]) {
        if (fn.type !== 'function' || !JSON.stringify(fn.parameters || {}).includes('"$ref"')) continue;
        try {
          fn.parameters = expandToolSchema(fn.parameters);
          changed = true;
        } catch { /* Preserve unsupported schemas rather than partially rewriting them. */ }
      }
    }
    request.input = request.input.map((item) => {
      // Earlier local history repairs retained the old tool-result ID on a user message.
      if (item?.type === 'message' && item.role === 'user' && typeof item.id === 'string'
          && item.id.startsWith('fco_') && Array.isArray(item.content)
          && item.content.some((part) => part?.type === 'input_text'
            && typeof part.text === 'string' && part.text.trimStart().startsWith('<heartbeat>'))) {
        const { id, ...message } = item;
        changed = true;
        return message;
      }
      if (item?.type !== 'function_call_output'
          || (typeof item.call_id === 'string' && item.call_id.trim())
          || typeof item.output !== 'string') return item;
      changed = true;
      // Unpaired Codex notifications cannot be represented as tool results on Bailian.
      return { role: 'user', content: [{ type: 'input_text', text: item.output }] };
    });
    return changed ? Buffer.from(JSON.stringify(request)) : body;
  } catch { return body; }
}
