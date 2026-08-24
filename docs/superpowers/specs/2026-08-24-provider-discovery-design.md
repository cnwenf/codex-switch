# Provider Discovery and Capability Detection Design

## Goal

Make provider setup in codex-switch guided and self-validating: users choose a common model vendor, enter an API key, and receive a searchable model picker populated from the vendor API where possible. Fresh installations must no longer include Alibaba Cloud Model Studio as a default provider.

## Scope

This change covers:

- the default provider configuration shipped in source and DMG builds;
- preset provider metadata for Kimi, GLM, DeepSeek, Alibaba Cloud Model Studio, OpenRouter, and Custom;
- API-key validation and model discovery through the local admin backend;
- normalized model capabilities with explicit provenance;
- a searchable multi-select model picker with a manual fallback;
- local automated tests, browser verification, DMG packaging, and a `v0.5.0` GitHub Release.

It does not change the proxy's request-routing contract. Routed Codex request and response bodies remain byte-for-byte passthrough, with only provider-specific authentication headers changed as before.

## Default Configuration and Upgrade Semantics

The repository `config.toml` and the configuration bundled in new DMG builds contain only the ChatGPT subscription provider. Alibaba Cloud Model Studio is removed from the shipped default.

Existing installations are not migrated destructively. If a user's current configuration already contains a Bailian provider, it remains unchanged during source or DMG upgrades.

## Provider Presets

The provider form starts with a vendor selector in this order:

1. Kimi
2. GLM
3. DeepSeek
4. Alibaba Cloud Model Studio
5. OpenRouter
6. Custom

Choosing a preset fills the provider name, stable provider type, default base URL, authentication type, and default API-key environment-variable name. The URL is shown as read-only for presets so users can see the target. Choosing Custom makes the URL editable and retains the existing free-form provider behavior.

Initial preset URLs are:

- Kimi China: `https://api.moonshot.cn/v1`
- GLM: `https://open.bigmodel.cn/api/paas/v4`
- DeepSeek: `https://api.deepseek.com`
- Alibaba Cloud Model Studio Beijing public endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- OpenRouter: `https://openrouter.ai/api/v1`

The backend, not the browser, owns the authoritative preset registry. The admin API returns a safe public projection so UI behavior and discovery adapters cannot drift.

Each saved provider includes an optional `provider_type` field. Existing providers without it are recognized conservatively from known hostnames; otherwise they are treated as Custom. Export and import preserve this field.

## Discovery Architecture

A focused provider-discovery module defines adapters with a common interface:

```js
discoverProvider({ providerType, baseUrl, apiKey, signal })
  -> {
       validation: { status, message },
       models: NormalizedModel[],
       modelSource: 'api' | 'static' | 'manual',
       warnings: string[]
     }
```

The local admin endpoint accepts a provider type, URL, and one-time API key. It validates the URL and selects an adapter, calls the upstream with a timeout, normalizes the response, and returns only model metadata and sanitized errors. It never returns or logs the key.

The endpoint does not persist the key. Saving remains a separate explicit form action. When an existing provider is edited without entering a new key, discovery may use the key already stored in `~/.codex-switch/env` by referring to the provider's configured `token_env`; the value is never returned to the page.

## Vendor-Specific Behavior

### Kimi

- Discover and validate with `GET /models`.
- Normalize the returned model ID, context length, input image/video flags, and reasoning flag.
- Mark fields not supplied by the API as unknown.

### GLM

- The official API does not expose a model-list endpoint.
- Validate with a minimal authenticated `GET /batches?limit=1` request that does not invoke inference.
- Return a maintained static catalog derived from the official GLM model overview.
- Mark its capability source as static and allow manual model IDs for newly released models.

### DeepSeek

- Discover and validate with `GET /models`.
- The API response supplies model identity only. Merge known current model capabilities from a small official static catalog.
- Unknown models remain selectable with unknown capabilities.

### Alibaba Cloud Model Studio

- Convert the compatible-mode base URL to the native same-region `GET /api/v1/models` endpoint.
- Follow `page_no` and `page_size` pagination with bounded pages and records.
- Normalize context window, maximum token fields, input/output modalities, reasoning, and function-calling metadata when present.
- Explain that `401` can also mean a region, workspace, or endpoint mismatch.

### OpenRouter

- Validate with `GET /key`.
- Discover the key-accessible catalog with `GET /models/user`; fall back to the documented public `GET /models` endpoint when the user endpoint is unsupported.
- Normalize architecture modalities, context length, maximum completion tokens, tools, and reasoning metadata.
- Keep models with non-text output out of the default Codex picker unless they also support text output.

### Custom

- Attempt OpenAI-compatible `GET /models` using Bearer authentication.
- Normalize standard identity fields and any recognized optional capability fields.
- A missing or incompatible model endpoint produces a warning and enables manual model entry; it does not make the provider unsavable.

## Validation States and Save Rules

Validation uses more than a boolean:

- `valid`: credentials and endpoint were accepted;
- `invalid`: the upstream clearly rejected credentials with `401`;
- `forbidden`: credentials may be recognized, but access, balance, region, or product activation prevents use;
- `rate_limited`: validation is temporarily unavailable;
- `unreachable`: timeout, DNS, TLS, or upstream `5xx` failure;
- `unsupported`: the discovery endpoint is absent or its response is not recognized.

For presets, a missing key or confirmed `invalid` result blocks saving a newly entered provider. Existing providers may be saved without re-entering their already stored key. Other discovery failures show a clear warning and permit saving only when at least one model is selected or entered manually. Custom follows the same manual-model fallback when discovery is unsupported.

Automatic validation starts after 700 milliseconds without API-key input; leaving the field triggers it immediately. It never runs once per keystroke. An explicit retry button remains available. Stale requests are aborted when provider type, URL, or key changes.

## Normalized Capabilities

Each discovered model uses the following logical structure:

```js
{
  id,
  name,
  contextWindow,
  maxOutputTokens,
  input: { text, image, audio, video, file },
  output: { text, image, audio },
  tools,
  reasoning,
  source: 'api' | 'static' | 'unknown'
}
```

Capability flags are `true`, `false`, or `unknown`. Missing API fields are never interpreted as `false`. Resolution priority is:

1. explicit API metadata;
2. official static metadata for known models;
3. unknown.

The existing Codex catalog projection continues to consume only the fields it supports: context window, image input, and reasoning levels. Richer normalized metadata is used by the management UI and retained behind a stable boundary for future catalog support.

## User Interface

The add/edit modal becomes a guided sequence:

1. choose vendor;
2. review the automatically configured URL or enter a Custom URL;
3. enter the API key;
4. see validation status and model-discovery progress;
5. search and select one or more models;
6. optionally add a model ID manually when discovery is unavailable or incomplete;
7. save the provider.

The model picker is an accessible searchable multi-select combobox with keyboard navigation. Results show the model name and compact capability badges such as Image, Video, Reasoning, Tools, and context size. Unknown capability values are displayed as unknown rather than omitted or shown as unsupported.

Editing an existing provider preselects its saved models. Refreshing discovery merges results without silently removing manually configured models.

## Security

- Provider discovery runs only in the loopback-bound local backend.
- API keys are accepted only in POST bodies, kept in memory for the request, never echoed, and never written to logs.
- Saved keys remain in `~/.codex-switch/env` with mode `0600`; `config.toml` stores only the variable name.
- Upstream errors are sanitized and size-limited before returning to the UI.
- Preset URLs are immutable on the client and re-resolved by provider type on the server.
- Custom discovery accepts HTTPS by default. Loopback HTTP is allowed for local OpenAI-compatible servers. Redirects are bounded and must not change to a disallowed protocol or destination class.
- Requests have timeouts and response-size limits. Model pagination is bounded.

## Compatibility and Failure Handling

Discovery is advisory and never affects byte-level request forwarding. A provider that was already saved remains routable when model refresh later fails.

Existing manually configured providers continue to work. Existing model lists remain the fallback when an edit-time discovery request fails. Unknown response fields are ignored, and malformed entries are skipped with a warning rather than failing the entire model list.

## Testing and Verification

Automated tests use Node's built-in test runner and local stub HTTP servers. Coverage includes:

- preset metadata and provider-type inference;
- each adapter's URL construction, authentication, pagination, parsing, capability normalization, and error mapping;
- API keys never appearing in serialized responses or logs;
- custom URL safety and redirects;
- provider TOML round-tripping with `provider_type`;
- default configuration excluding Bailian;
- admin discovery endpoint integration;
- searchable model selection and preservation of manual models through browser-level behavior where practical.

Release verification includes:

- clean automated test and syntax-check runs;
- local source deployment and real browser inspection at `http://127.0.0.1:8787/`;
- validation with locally available API keys without printing or recording their values;
- visual and interaction checks for add, edit, search, keyboard selection, error states, and responsive layout;
- `v0.5.0` DMG build, code-sign verification, mount/install smoke test, checksum generation, and GitHub Release asset verification.

Live vendor validation is evidence-limited by the keys available on this machine. Vendors without an available key are verified against official documentation and deterministic stub-server tests and are reported separately from live-tested vendors.
