import { inferProviderType } from './provider-registry.js';

export function prepareBailianRequest(provider, suffix, body) {
  if ((provider.provider_type || inferProviderType(provider.base_url)) !== 'bailian'
      || !/^\/responses\/?(?:\?|$)/.test(suffix)) return body;
  try {
    const request = JSON.parse(body.toString('utf8'));
    if (!Array.isArray(request.input)) return body;
    let changed = false;
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
