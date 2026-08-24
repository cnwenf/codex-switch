import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  combineCapability,
  deriveProviderBaseUrl,
  discoveryStatusCopy,
  filterOptions,
  getProviderSaveProblem,
  isModelToggleAllowed,
  markDiscoveredModels,
  mergeSelectedModels,
  nextOptionIndex,
  renderAdminPage,
  shouldCloseModalOnEscape,
} from '../src/admin-page.js';

function render() {
  return renderAdminPage({ host: '127.0.0.1', port: 8787, version: '0.5.0' });
}

function cssRule(html, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.match(new RegExp(`${escaped}\\{([^}]*)\\}`))?.[1] || '';
}

function cssSource(html) {
  return html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
}

function cssTokens(html) {
  return Object.fromEntries(
    [...cssRule(html, ':root').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/gi)]
      .map((match) => [match[1], match[2].trim()]),
  );
}

function cssAtRule(html, marker) {
  const css = cssSource(html);
  const start = css.indexOf(marker);
  if (start < 0) return '';
  const open = css.indexOf('{', start);
  if (open < 0) return '';
  let depth = 1;
  for (let index = open + 1; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(open + 1, index);
  }
  return '';
}

function cssPixels(value) {
  const match = String(value).match(/^([0-9.]+)(px|rem)$/);
  assert.ok(match, `expected a px/rem length, got ${value}`);
  return Number(match[1]) * (match[2] === 'rem' ? 16 : 1);
}

function relativeLuminance(color) {
  const match = String(color).match(/^oklch\(([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*[0-9.]+)?\)$/i);
  assert.ok(match, `expected an oklch color, got ${color}`);
  const lightness = Number(match[1]);
  const chroma = Number(match[2]);
  const hue = Number(match[3]) * Math.PI / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  const red = Math.min(1, Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s));
  const green = Math.min(1, Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s));
  const blue = Math.min(1, Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test('provider form exposes accessible searchable provider and multi-model comboboxes', () => {
  const html = render();
  assert.match(html, /id="providerSearch"[^>]*role="combobox"/);
  assert.match(html, /id="providerListbox"[^>]*role="listbox"/);
  assert.match(html, /id="modelSearch"[^>]*role="combobox"/);
  assert.match(html, /id="modelListbox"[^>]*role="listbox"[^>]*aria-multiselectable="true"/);
  assert.match(html, /id="selectedModels"/);
  assert.match(html, /id="providerCompatibility"[^>]*aria-live="polite"/);
  assert.match(html, /id="discoveryStatus"[^>]*aria-live="polite"/);
  assert.match(html, /id="connectionFields"/);
  assert.match(html, /id="manualModelId"/);
});

test('provider and model results use remaining-height scrolling inside the responsive sheet', () => {
  const html = render();
  assert.match(html, /id="providerListbox" class="listbox"[^>]*role="listbox"/);
  const rule = cssRule(html, '.listbox');
  assert.match(rule, /position:absolute/);
  assert.match(rule, /max-height:min\([^;]*calc\(100dvh\s*-/);
  assert.match(rule, /overflow:auto/);

  const mobile = cssAtRule(html, '@media(max-width:520px)');
  assert.match(mobile, /\.listbox\{[^}]*position:relative/);
  assert.match(mobile, /\.listbox\{[^}]*max-height:calc\(100dvh\s*-/);
});

test('light semantic color tokens keep text, accent, and statuses at WCAG AA contrast', () => {
  const html = render();
  const tokens = cssTokens(html);
  for (const token of [
    '--color-canvas',
    '--color-surface',
    '--color-surface-muted',
    '--color-text',
    '--color-text-secondary',
    '--color-accent',
    '--color-success',
    '--color-warning',
    '--color-error',
  ]) {
    assert.match(tokens[token] || '', /^oklch\(/, `missing semantic OKLCH token ${token}`);
  }
  assert.ok(relativeLuminance(tokens['--color-canvas']) >= 0.82, 'canvas must be visibly light');
  for (const foreground of [
    '--color-text',
    '--color-text-secondary',
    '--color-accent',
    '--color-success',
    '--color-warning',
    '--color-error',
  ]) {
    assert.ok(
      contrastRatio(tokens[foreground], tokens['--color-surface']) >= 4.5,
      `${foreground} must reach 4.5:1 on the primary surface`,
    );
  }
});

test('type, spacing, control, and radius tokens establish a readable product hierarchy', () => {
  const html = render();
  const tokens = cssTokens(html);
  assert.ok(cssPixels(tokens['--font-size-title']) >= 22);
  assert.ok(cssPixels(tokens['--font-size-section']) >= 16);
  assert.ok(cssPixels(tokens['--font-size-body']) >= 14);
  assert.ok(cssPixels(tokens['--font-size-metadata']) >= 12);
  assert.ok(cssPixels(tokens['--font-size-title']) / cssPixels(tokens['--font-size-section']) >= 1.25);
  assert.ok(cssPixels(tokens['--control-height']) >= 40);
  assert.ok(cssPixels(tokens['--control-height-touch']) >= 44);
  for (const token of ['--space-1', '--space-2', '--space-3', '--space-4', '--space-6', '--radius-sm', '--radius-md', '--radius-lg']) {
    assert.ok(cssPixels(tokens[token]) > 0, `missing scale token ${token}`);
  }
  assert.match(cssRule(html, 'body'), /font:[^;]*var\(--font-size-body\)/);
  assert.match(cssRule(html, '.note'), /font-size:var\(--font-size-body\)/);
  assert.match(cssRule(html, '.note'), /max-width:72ch/);
});

test('provider management is a single record list with shrink-safe long values', () => {
  const html = render();
  assert.match(html, /<div class="provider-summary"[^>]*>\s*<div id="unionBar"[\s\S]*?<div id="unionChips"/);
  assert.match(html, /id="providerGrid" class="provider-list" role="list"/);
  assert.match(html, /element\('article','pcard/);
  assert.match(cssRule(html, '.provider-list'), /display:flex/);
  assert.match(cssRule(html, '.provider-list'), /flex-direction:column/);
  assert.match(cssRule(html, '.pcard'), /min-width:0/);
  assert.doesNotMatch(cssRule(html, '.pcard'), /border-radius/);
  assert.match(cssRule(html, '.url,.cred,.warn-text'), /overflow-wrap:anywhere/);
  assert.match(cssRule(html, 'main'), /max-width:var\(--content-width\)/);
});

test('narrow screens have zero-overflow structure, touch targets, and a full-height dialog sheet', () => {
  const html = render();
  const mobile = cssAtRule(html, '@media(max-width:520px)');
  assert.match(mobile, /#modalWrap\{[^}]*padding:0/);
  assert.match(mobile, /#modal\{[^}]*height:100dvh/);
  assert.match(mobile, /#modal\{[^}]*max-height:100dvh/);
  assert.match(mobile, /\.btn,\.tabbtn,\.xbtn,\.list-option\{[^}]*min-height:var\(--control-height-touch\)/);
  assert.match(mobile, /\.switch\{[^}]*min-width:var\(--control-height-touch\)/);
  assert.match(cssRule(html, '.modal-body'), /min-height:0/);
  assert.match(cssRule(html, '.modal-body'), /overflow:auto/);
  assert.match(cssRule(html, '.modal-head'), /flex:none/);
  assert.match(cssRule(html, '.modal-foot'), /flex:none/);
});

test('tabs, panels, and import textarea expose complete programmatic semantics', () => {
  const html = render();
  assert.match(html, /<nav class="tabs" role="tablist" aria-label="管理页面">/);
  assert.match(html, /id="tabbtn-providers"[^>]*role="tab"[^>]*aria-selected="true"[^>]*aria-controls="tab-providers"/);
  assert.match(html, /id="tabbtn-history"[^>]*role="tab"[^>]*aria-selected="false"[^>]*aria-controls="tab-history"/);
  assert.match(html, /id="tabbtn-providers"[^>]*tabindex="0"/);
  assert.match(html, /id="tabbtn-history"[^>]*tabindex="-1"/);
  assert.match(html, /id="tab-providers"[^>]*role="tabpanel"[^>]*aria-labelledby="tabbtn-providers"/);
  assert.match(html, /id="tab-history"[^>]*role="tabpanel"[^>]*aria-labelledby="tabbtn-history"/);
  assert.match(html, /<label for="f-import">配置 JSON<\/label>/);
  assert.match(html, /btn\.setAttribute\('aria-selected',tabs\[i\]===name\?'true':'false'\)/);
});

test('rendered theme excludes decorative AI-console patterns and layout-property motion', () => {
  const html = render();
  const css = cssSource(html);
  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient\(/i);
  assert.doesNotMatch(css, /backdrop-filter/i);
  assert.doesNotMatch(css, /::-webkit-scrollbar/i);
  assert.doesNotMatch(css, /background-clip\s*:\s*text/i);
  assert.doesNotMatch(html, /class="bar"/);
  assert.doesNotMatch(css, /border-(?:left|right)\s*:\s*(?:[2-9]|[1-9][0-9])px/i);
  assert.doesNotMatch(css, /transition\s*:[^;}]*(?:width|height|top|right|bottom|left|margin|padding)/i);
  assert.match(cssRule(html, '.upd-fill'), /transform:scaleX\(0\)/);
  assert.match(cssRule(html, '.upd-fill'), /transition:transform/);
  assert.doesNotMatch(html, /fill\.style\.width/);
  assert.match(html, /fill\.style\.transform='scaleX\('/);
  assert.match(cssAtRule(html, '@media(prefers-reduced-motion:reduce)'), /transition:none!important/);
});

test('interactive controls define hover, focus, active, disabled, loading, and error states', () => {
  const html = render();
  assert.ok(cssRule(html, '.btn:hover'));
  assert.ok(cssRule(html, '.btn:active'));
  assert.ok(cssRule(html, '.btn:focus-visible'));
  assert.ok(cssRule(html, '.btn:disabled'));
  assert.ok(cssRule(html, '.btn[aria-busy="true"]'));
  assert.ok(cssRule(html, '.frow input[aria-invalid="true"]'));
  assert.ok(cssRule(html, '.status.err'));
});

test('disabled provider cards and reference options do not fade their text through ancestor opacity', () => {
  const html = render();
  const disabledCard = cssRule(html, '.pcard.off');
  const referenceOption = cssRule(html, '.list-option[aria-disabled="true"]');

  assert.doesNotMatch(disabledCard, /(?:^|;)\s*opacity\s*:/);
  assert.match(disabledCard, /background:/);
  assert.match(disabledCard, /border-color:/);
  assert.doesNotMatch(referenceOption, /(?:^|;)\s*opacity\s*:/);
  assert.match(referenceOption, /background:/);
  assert.match(referenceOption, /border-color:/);
  assert.match(html, /仅供参考 · 不可路由/);
});

test('API key stays password-only and is never embedded as a JavaScript value', () => {
  const html = render();
  assert.match(html, /id="f-apikey" type="password"/);
  assert.doesNotMatch(html, /api[_-]?key\s*[:=]\s*['"][^'"]+/i);
});

test('renderer safely displays its explicit host, port, and version inputs', () => {
  const html = renderAdminPage({
    host: '<script>alert(1)</script>',
    port: '</span><script>alert(2)</script>',
    version: '0.5.0&dev',
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<script>alert\(2\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;:&lt;\/span&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.match(html, /v0\.5\.0&amp;dev/);
});

test('typing and arrow navigation reopen closed combobox result lists', () => {
  const html = render();
  assert.match(
    html,
    /function moveProviderActive\(delta\)\{\s*if\(\$\('providerListbox'\)\.hidden\)renderProviderOptions\(\);\s*var options=/,
  );
  assert.match(
    html,
    /\$\('modelSearch'\)\.addEventListener\('input',function\(\)\{\s*\$\('modelListbox'\)\.hidden=false;\s*\$\('modelSearch'\)\.setAttribute\('aria-expanded','true'\);/,
  );
});

test('renderer preserves provider CRUD, history, apply, restore, update, and launch-at-login controls', async () => {
  const html = render();
  for (const marker of [
    'id="providerGrid"',
    'id="historyList"',
    'onclick="applyCodex()"',
    'onclick="restoreCodex()"',
    'id="autostartChk"',
    'id="updArea"',
    'function copyProvider(',
    'function importJson(',
  ]) {
    assert.ok(html.includes(marker), `missing preserved management marker: ${marker}`);
  }
  for (const endpoint of [
    '/__admin/providers',
    '/__admin/provider-presets',
    '/__admin/providers/export',
    '/__admin/providers/toggle',
    '/__admin/providers/delete',
    '/__admin/provider-discover',
    '/__admin/providers/update',
    '/__admin/env-keys/delete',
    '/__admin/env-keys/save',
    '/__admin/fetch-capabilities',
    '/__admin/history',
    '/__admin/history/restore',
    '/__admin/codex-apply',
    '/__admin/codex-restore',
    '/__admin/autostart',
    '/__admin/update/check',
    '/__admin/update/run',
    '/__admin/update/status',
  ]) {
    assert.ok(html.includes(endpoint), `missing preserved endpoint: ${endpoint}`);
  }

  const exports = await import('../src/admin-page.js');
  for (const helper of [
    'filterOptions',
    'mergeSelectedModels',
    'getProviderSaveProblem',
    'deriveProviderBaseUrl',
    'nextOptionIndex',
    'combineCapability',
    'discoveryStatusCopy',
    'shouldCloseModalOnEscape',
    'shouldConsumeComboboxEscape',
    'clearSensitiveModalFields',
    'markDiscoveredModels',
    'resolveDiscoveryModelSource',
    'isModelToggleAllowed',
  ]) {
    assert.equal(typeof exports[helper], 'function', `missing preserved public helper: ${helper}`);
  }
});

test('provider search matches Chinese and English while preserving Custom last when unfiltered', () => {
  const providers = [
    { id: 'openai', name: 'OpenAI API' },
    { id: 'bailian', name: '阿里云百炼' },
    { id: 'custom', name: '自定义' },
  ];
  assert.deepEqual(filterOptions(providers, '百炼').map((item) => item.id), ['bailian']);
  assert.deepEqual(filterOptions(providers, 'OPEN').map((item) => item.id), ['openai']);
  assert.equal(filterOptions(providers, '').at(-1).id, 'custom');
  assert.notEqual(filterOptions(providers, ''), providers);
});

test('model refresh deduplicates selections and preserves missing manual IDs', () => {
  const merged = mergeSelectedModels(
    ['manual-model', 'found-model', 'manual-model'],
    [{ id: 'found-model', name: 'Found Model', source: 'api' }],
  );
  assert.deepEqual(merged, [
    { id: 'manual-model', name: 'manual-model', source: 'manual' },
    { id: 'found-model', name: 'Found Model', source: 'api' },
  ]);
});

test('save rules block unroutable or invalid setups but allow explained unverified flows', () => {
  const ready = {
    routable: true,
    compatibility: 'supported',
    auth: 'bearer',
    hasKey: true,
    hasSavedKey: false,
    modelIds: ['model-1'],
    validationStatus: 'valid',
    allowUnverified: false,
  };
  assert.equal(getProviderSaveProblem(ready), '');
  assert.match(getProviderSaveProblem({ ...ready, routable: false, compatibility: 'unsupported' }), /Responses/);
  assert.match(getProviderSaveProblem({ ...ready, hasKey: false }), /API Key/);
  assert.match(getProviderSaveProblem({ ...ready, validationStatus: 'invalid' }), /API Key/);
  assert.match(getProviderSaveProblem({ ...ready, modelIds: [] }), /模型/);
  assert.match(getProviderSaveProblem({ ...ready, validationStatus: 'loading' }), /等待/);
  assert.match(getProviderSaveProblem({ ...ready, validationStatus: 'unverified' }), /检测/);
  assert.equal(getProviderSaveProblem({ ...ready, validationStatus: 'unverified', allowUnverified: true }), '');
  assert.equal(getProviderSaveProblem({ ...ready, validationStatus: 'unreachable' }), '');
  assert.equal(getProviderSaveProblem({ ...ready, validationStatus: 'forbidden' }), '');
  assert.equal(getProviderSaveProblem({ ...ready, validationStatus: 'rate_limited' }), '');
  assert.equal(getProviderSaveProblem({ ...ready, validationStatus: 'unsupported' }), '');
});

test('manual-only preset references require a user-configured endpoint or deployment ID', () => {
  const [reference] = markDiscoveredModels(
    [{ id: 'doubao-reference', responses: true, source: 'static' }],
    'manual',
    true,
  );
  assert.equal(reference.referenceOnly, true);
  assert.equal(isModelToggleAllowed(reference, false), false);
  const [apiModel] = markDiscoveredModels([{ id: 'api-model', responses: true }], 'api', false);
  const [staticModel] = markDiscoveredModels([{ id: 'static-model', responses: true }], 'static', false);
  assert.equal(apiModel.referenceOnly, false);
  assert.equal(staticModel.referenceOnly, false);
  assert.equal(isModelToggleAllowed(apiModel, false), true);
  assert.equal(isModelToggleAllowed(staticModel, false), true);

  const state = {
    routable: true,
    compatibility: 'supported',
    auth: 'bearer',
    hasKey: true,
    hasSavedKey: false,
    modelIds: ['doubao-reference'],
    validationStatus: 'unverified',
    allowUnverified: true,
    modelSource: 'manual',
    requiresManualModel: true,
    manualModelIds: [],
  };
  assert.match(getProviderSaveProblem(state), /Endpoint|Deployment/);
  assert.equal(getProviderSaveProblem({ ...state, modelIds: ['ep-user-configured'], manualModelIds: ['ep-user-configured'] }), '');

  const html = render();
  assert.match(html, /modelSource:DISCOVERY_MODEL_SOURCE/);
  assert.match(html, /requiresManualModel:SELECTED_PRESET\.requiresManualModel===true/);
  assert.match(html, /manualModelIds:Array\.from\(MANUAL_MODEL_IDS\)/);
});

test('transient manual discovery fallback does not turn an ordinary provider into a deployment-only preset', () => {
  const preservedModels = mergeSelectedModels(['gpt-api-model'], []);
  assert.deepEqual(preservedModels, [{
    id: 'gpt-api-model',
    name: 'gpt-api-model',
    source: 'manual',
  }]);
  const ordinaryProvider = {
    routable: true,
    compatibility: 'supported',
    auth: 'bearer',
    hasKey: true,
    hasSavedKey: false,
    modelIds: preservedModels.map((model) => model.id),
    validationStatus: 'unreachable',
    allowUnverified: false,
    modelSource: 'manual',
    requiresManualModel: false,
    manualModelIds: [],
  };

  assert.equal(getProviderSaveProblem(ordinaryProvider), '');
  const [preservedApiModel] = markDiscoveredModels(
    [{ id: 'gpt-api-model', responses: true, source: 'api' }],
    'manual',
    false,
  );
  assert.equal(preservedApiModel.referenceOnly, false);
  assert.equal(isModelToggleAllowed(preservedApiModel, false), true);
});

test('browser URL derivation mirrors fixed, parameterized, NIM, and Custom presets', () => {
  assert.equal(
    deriveProviderBaseUrl({ id: 'xai', baseUrl: 'https://api.x.ai/v1' }, {}, 'https://evil.test/v1'),
    'https://api.x.ai/v1',
  );
  assert.equal(
    deriveProviderBaseUrl({ id: 'bailian' }, { region: 'us-east-1', workspace_id: 'workspace123' }),
    'https://workspace123.us-east-1.maas.aliyuncs.com/compatible-mode/v1',
  );
  assert.equal(
    deriveProviderBaseUrl({ id: 'aws-bedrock' }, { region: 'eu-west-1' }),
    'https://bedrock-mantle.eu-west-1.api.aws/v1',
  );
  assert.equal(
    deriveProviderBaseUrl({ id: 'azure-openai' }, { resource_endpoint: 'https://demo.openai.azure.com/openai/v1/' }),
    'https://demo.openai.azure.com/openai/v1',
  );
  assert.equal(
    deriveProviderBaseUrl({ id: 'cloudflare-workers-ai' }, { account_id: 'account123' }),
    'https://api.cloudflare.com/client/v4/accounts/account123/ai/v1',
  );
  assert.equal(
    deriveProviderBaseUrl({ id: 'nvidia-nim' }, { base_url: 'http://127.0.0.1:8000/v1' }),
    'http://127.0.0.1:8000/v1',
  );
  assert.equal(
    deriveProviderBaseUrl({ id: 'custom' }, { base_url: 'ignored' }, 'https://gateway.example.test/v1'),
    'https://gateway.example.test/v1',
  );
});

test('combobox navigation wraps predictably and capability aggregation remains tri-state', () => {
  assert.equal(nextOptionIndex(-1, 3, 1), 0);
  assert.equal(nextOptionIndex(0, 3, -1), 2);
  assert.equal(nextOptionIndex(2, 3, 1), 0);
  assert.equal(nextOptionIndex(0, 0, 1), -1);
  assert.equal(combineCapability(true, 'unknown'), true);
  assert.equal(combineCapability(false, false), false);
  assert.equal(combineCapability(false, 'unknown'), 'unknown');
});

test('all validation states have visible icon and text labels', () => {
  for (const status of ['loading', 'valid', 'invalid', 'forbidden', 'rate_limited', 'unreachable', 'unverified', 'unsupported']) {
    const copy = discoveryStatusCopy(status);
    assert.ok(copy.icon, status);
    assert.ok(copy.label, status);
  }
});

test('rendered browser script parses as JavaScript', () => {
  const script = render().match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
});

test('combobox Escape is consumed before the modal Escape handler', () => {
  assert.equal(shouldCloseModalOnEscape({ key: 'Escape', defaultPrevented: true, modalOpen: true, providerOpen: false, modelOpen: false }), false);
  assert.equal(shouldCloseModalOnEscape({ key: 'Escape', defaultPrevented: false, modalOpen: true, providerOpen: true, modelOpen: false }), false);
  assert.equal(shouldCloseModalOnEscape({ key: 'Escape', defaultPrevented: false, modalOpen: true, providerOpen: false, modelOpen: false }), true);
  assert.equal(shouldCloseModalOnEscape({ key: 'Enter', defaultPrevented: false, modalOpen: true, providerOpen: false, modelOpen: false }), false);
});

test('combobox consumes only the first Escape while its popup is open', async () => {
  const page = await import('../src/admin-page.js');
  assert.equal(typeof page.shouldConsumeComboboxEscape, 'function');
  assert.equal(page.shouldConsumeComboboxEscape('Escape', true), true);
  assert.equal(page.shouldConsumeComboboxEscape('Escape', false), false);
  assert.equal(page.shouldConsumeComboboxEscape('Enter', true), false);
  assert.equal(
    shouldCloseModalOnEscape({ key: 'Escape', defaultPrevented: false, modalOpen: true, providerOpen: false, modelOpen: false }),
    true,
  );
  const html = render();
  assert.match(html, /shouldConsumeComboboxEscape\(event\.key,!\$\('providerListbox'\)\.hidden\)/);
  assert.match(html, /shouldConsumeComboboxEscape\(event\.key,!\$\('modelListbox'\)\.hidden\)/);
});

test('closing the modal clears both key-bearing form fields', async () => {
  const page = await import('../src/admin-page.js');
  assert.equal(typeof page.clearSensitiveModalFields, 'function');
  const keyInput = { value: 'fixture-secret' };
  const importInput = { value: '{"api_key":"fixture-secret"}' };
  page.clearSensitiveModalFields(keyInput, importInput);
  assert.equal(keyInput.value, '');
  assert.equal(importInput.value, '');
  assert.match(render(), /clearSensitiveModalFields\(\$\('f-apikey'\),\$\('f-import'\)\)/);
});

test('explicitly non-Responses models cannot be newly selected but existing selections can be removed', () => {
  assert.equal(isModelToggleAllowed({ id: 'chat-only', responses: false }, false), false);
  assert.equal(isModelToggleAllowed({ id: 'chat-only', responses: false }, true), true);
  assert.equal(isModelToggleAllowed({ id: 'unknown', responses: 'unknown' }, false), true);
  assert.equal(isModelToggleAllowed({ id: 'responses', responses: true }, false), true);
});
