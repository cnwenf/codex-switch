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

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255);
    const linear = channels.map((channel) => (
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const first = luminance(foreground);
  const second = luminance(background);
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

test('provider results render as a bounded scrolling overlay on narrow screens', () => {
  const html = render();
  assert.match(html, /id="providerListbox" class="listbox"[^>]*role="listbox"/);
  const rule = cssRule(html, '.listbox');
  assert.match(rule, /position:absolute/);
  assert.match(rule, /max-height:280px/);
  assert.match(rule, /overflow:auto/);
});

test('small secondary text meets WCAG AA contrast on every page surface', () => {
  const html = render();
  const root = cssRule(html, ':root');
  const faint = root.match(/--faint:(#[0-9a-f]{6})/i)?.[1];
  assert.ok(faint, 'missing --faint token');
  for (const background of ['#0a0c10', '#0e1117', '#12161f', '#171c28', '#0b0e14']) {
    assert.ok(
      contrastRatio(faint, background) >= 4.5,
      `${faint} must reach 4.5:1 on ${background}`,
    );
  }
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

test('renderer preserves provider CRUD, history, apply, restore, update, and launch-at-login controls', () => {
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

test('manual discovery references require a user-configured endpoint or deployment ID', async () => {
  const page = await import('../src/admin-page.js');
  assert.equal(typeof page.markDiscoveredModels, 'function');
  const [reference] = page.markDiscoveredModels(
    [{ id: 'doubao-reference', responses: true, source: 'static' }],
    'manual',
  );
  assert.equal(reference.referenceOnly, true);
  assert.equal(isModelToggleAllowed(reference, false), false);
  const [apiModel] = page.markDiscoveredModels([{ id: 'api-model', responses: true }], 'api');
  const [staticModel] = page.markDiscoveredModels([{ id: 'static-model', responses: true }], 'static');
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
    manualModelIds: [],
  };
  assert.match(getProviderSaveProblem(state), /Endpoint|Deployment/);
  assert.equal(getProviderSaveProblem({ ...state, modelIds: ['ep-user-configured'], manualModelIds: ['ep-user-configured'] }), '');

  const html = render();
  assert.match(html, /modelSource:DISCOVERY_MODEL_SOURCE/);
  assert.match(html, /manualModelIds:Array\.from\(MANUAL_MODEL_IDS\)/);
});

test('manual-only providers keep the manual save gate when discovery has no usable source', async () => {
  const page = await import('../src/admin-page.js');
  assert.equal(typeof page.resolveDiscoveryModelSource, 'function');
  assert.equal(page.resolveDiscoveryModelSource('manual', false), 'manual');
  assert.equal(page.resolveDiscoveryModelSource('api', true), 'api');
  assert.equal(page.resolveDiscoveryModelSource(undefined, true), 'manual');
  assert.equal(page.resolveDiscoveryModelSource(undefined, false), 'unknown');
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
