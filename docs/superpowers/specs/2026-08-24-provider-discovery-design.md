# Provider Discovery and Capability Detection Design

## Goal

Make provider setup in codex-switch guided and self-validating: users choose a common model vendor, enter the vendor-specific connection fields and API key, and receive a searchable model picker populated from the vendor API where possible. Fresh installations must no longer include Alibaba Cloud Model Studio as a default provider.

The provider directory must be broad without advertising false compatibility. A vendor is routable only when its official API accepts the OpenAI Responses request and streaming protocol that Codex sends through this byte-preserving proxy.

## Scope

This change covers:

- the default provider configuration shipped in source and DMG builds;
- an extensible preset registry for popular direct, cloud, self-hosted, and unsupported providers;
- vendor-specific connection fields, API-key validation, and model discovery;
- normalized model capabilities with explicit provenance;
- a searchable multi-select model picker with a manual fallback;
- clear compatibility status for popular Chat-Completions-only vendors;
- local automated tests, browser verification, DMG packaging, and a `v0.5.0` GitHub Release.

It does not add a Responses-to-Chat-Completions translator. Routed Codex request and response bodies remain byte-for-byte passthrough, with only provider-specific authentication headers changed as before.

## Why Compatibility Is a First-Class Field

Codex sends `POST /responses` and consumes Responses SSE events. Many services advertise “OpenAI compatibility” but implement only `POST /chat/completions`. A successful API-key check or `GET /models` call therefore does not prove that the service can be used by codex-switch.

Each preset records one of these routing states:

- `supported`: official stable Responses API suitable for direct routing;
- `beta`: official Responses API exists but the vendor marks it beta;
- `limited`: official Responses API exists with documented field or model limitations;
- `unsupported`: no official direct Responses endpoint was verified.

Unsupported vendors stay searchable in the provider selector so users can understand why they are unavailable. Selecting one shows the official compatibility limitation and suggests an aggregation provider such as OpenRouter when appropriate. It cannot be saved as a routable preset. Custom remains available for private gateways or future endpoints the user has independently verified.

## Default Configuration and Upgrade Semantics

The repository `config.toml` and configuration bundled in new DMG builds contain only the ChatGPT subscription provider. Alibaba Cloud Model Studio is removed from the shipped default.

Existing installations are not migrated destructively. If a user's current configuration already contains a Bailian provider, it remains unchanged during source or DMG upgrades.

## Provider Directory

The searchable provider selector is grouped as follows, with Custom always last.

### Direct and Aggregated APIs

1. OpenAI API
2. xAI
3. OpenRouter
4. Groq — Responses Beta
5. Fireworks AI
6. Baidu Qianfan
7. Volcengine Ark
8. Tencent TokenHub
9. Alibaba Cloud Model Studio — limited compatibility

### Cloud and Self-Hosted APIs

10. AWS Bedrock
11. Azure OpenAI / Microsoft Foundry
12. Cloudflare Workers AI — limited model set
13. NVIDIA NIM — self-hosted URL

### Popular Vendors Without Direct Responses Support

These appear with an unavailable badge and an explanation instead of pretending to work:

- Kimi / Moonshot
- GLM / Zhipu
- DeepSeek
- Google Gemini
- Anthropic
- Mistral AI
- Together AI
- Cerebras
- SiliconFlow

### Custom

Custom is the last selector item. It accepts a user-supplied URL and attempts an OpenAI-compatible Models endpoint. The UI warns that successful discovery does not prove Responses compatibility; the endpoint remains unverified until an actual Codex request succeeds.

## Provider Registry

The backend owns the authoritative registry and returns only a safe public projection to the browser. A registry entry contains:

```js
{
  id,
  name,
  group,
  compatibility,
  compatibilityNote,
  auth,
  tokenEnv,
  connectionFields,
  buildBaseUrl,
  validationAdapter,
  discoveryAdapter,
  staticCatalog
}
```

The UI renders vendor-specific connection fields from a small supported field schema rather than hard-coding a form per vendor. Fields include:

- fixed base URL for OpenAI, xAI, OpenRouter, Groq, Fireworks, and Baidu;
- region and optional workspace ID for Alibaba Cloud Model Studio;
- China or international endpoint for Tencent TokenHub;
- region for AWS Bedrock;
- Azure resource endpoint;
- account ID for Cloudflare Workers AI;
- self-hosted URL for NVIDIA NIM;
- editable URL for Custom.

Choosing a preset fills the provider name, stable provider type, authentication type, default API-key environment-variable name, and derived URL. Fixed URLs are visible but read-only. Derived URLs update when region, workspace, resource, or account fields change.

Each saved provider includes optional `provider_type` and `provider_options` fields. Existing providers without them are recognized conservatively from known hostnames; otherwise they are treated as Custom. Export and import preserve these fields. The final derived `base_url` remains stored for backward compatibility and routing simplicity.

## Discovery Architecture

A focused provider-discovery module exposes:

```js
discoverProvider({ providerType, providerOptions, baseUrl, apiKey, signal })
  -> {
       validation: { status, message },
       compatibility,
       models: NormalizedModel[],
       modelSource: 'api' | 'static' | 'manual',
       warnings: string[]
     }
```

The loopback admin endpoint accepts a provider type, safe connection options, URL, and one-time API key. It resolves immutable preset URLs on the server, calls the upstream with a timeout and response-size bounds, normalizes the response, and returns only model metadata and sanitized errors. It never returns or logs the key.

The endpoint does not persist the key. Saving remains a separate explicit form action. When an existing provider is edited without entering a new key, discovery may use the key already stored in `~/.codex-switch/env` through the configured `token_env`; the value is never returned to the page.

## Vendor Adapters

### OpenAI API

- Base URL: `https://api.openai.com/v1`.
- Validate and discover with `GET /models`.
- Merge basic API identities with a small official static capability catalog.

### xAI

- Base URL: `https://api.x.ai/v1`.
- Validate with the official API-key endpoint and discover through the language-models endpoint.
- Normalize context, modalities, aliases, pricing, and model type where returned.

### OpenRouter

- Base URL: `https://openrouter.ai/api/v1`.
- Validate with `GET /key`.
- Discover the key-accessible catalog with `GET /models/user`, falling back to the public paginated models endpoint.
- Normalize modalities, context, maximum completion tokens, tools, and reasoning metadata.
- Keep models without text output out of the default Codex picker.

### Groq

- Base URL: `https://api.groq.com/openai/v1`.
- Validate and discover with `GET /models`.
- Normalize active state, context, and maximum completion tokens.
- Display a persistent Responses Beta badge.

### Fireworks AI

- Base URL: `https://api.fireworks.ai/inference/v1`.
- Validate and discover with the inference Models endpoint.
- Return basic API metadata and merge known capabilities from an official static catalog.
- Account-specific management metadata is out of scope because it requires additional account identifiers and permissions.

### Baidu Qianfan

- Base URL: `https://qianfan.baidubce.com/v2`.
- Validate and discover with `GET /models`.
- Normalize type, context, maximum input/output, modalities, and pricing metadata.

### Volcengine Ark

- Default base URL: `https://ark.cn-beijing.volces.com/api/v3`.
- The inference API key does not expose the control-plane model list.
- Do not issue a billable inference probe. Report the key as unverified and require a manually entered endpoint ID; actual validity is established by the first Codex request.
- Use an official static model catalog for display and require manual entry of the user's endpoint ID used in the request `model` field.

### Tencent TokenHub

- China and international base URLs are derived from an endpoint selector.
- Validate and discover with `GET /models`.
- Filter the returned online models against the official protocol matrix so the Codex list contains only native or explicitly compatible Responses models.

### Alibaba Cloud Model Studio

- Derive public or workspace-specific compatible-mode URLs from region and optional workspace ID.
- Convert the inference URL to the native same-region `GET /api/v1/models` endpoint.
- Follow bounded pagination and normalize context, token limits, modalities, reasoning, and function-calling metadata.
- Display the documented partial OpenAI parameter-compatibility warning.
- Explain that `401` may also mean a region, workspace, plan, or endpoint mismatch.

### AWS Bedrock

- Derive the OpenAI-compatible Responses base URL from an AWS region.
- Authenticate with a Bedrock API key using Bearer authentication.
- Discover through the compatible `GET /models` endpoint, which returns models available to the Responses API.
- Treat richer AWS control-plane metadata as unavailable because it requires a separate AWS credential flow.

### Azure OpenAI / Microsoft Foundry

- Require the user's Azure resource endpoint and derive its `/openai/v1` base URL.
- Use Bearer authentication, which Azure v1 supports, so the existing auth-header plan remains valid.
- Model inventory APIs return base models rather than necessarily usable deployment names. The UI therefore treats the user's deployment name as the routable model ID and uses discovered models only as reference metadata.

### Cloudflare Workers AI

- Require a Cloudflare account ID and derive `/client/v4/accounts/{account_id}/ai/v1`.
- Authenticate with a Bearer API token.
- Expose only the official static whitelist of models documented for the Responses endpoint.

### NVIDIA NIM

- Require the user's self-hosted NIM URL; default suggestion is loopback rather than NVIDIA's hosted Chat-Completions-only catalog.
- Discover with `GET /models` and optionally use deployment metadata when the local version exposes it.
- Clearly state that Responses support depends on the deployed NIM version and model.

### Custom

- Attempt Bearer-authenticated `GET /models`.
- Normalize standard identity fields and recognized optional capability fields.
- A missing or incompatible model endpoint produces a warning and enables manual entry.
- Protocol compatibility remains unverified until actual use when a non-billable Responses probe is unavailable.

## Validation States and Save Rules

Validation uses more than a boolean:

- `valid`: credentials and endpoint were accepted;
- `invalid`: the upstream clearly rejected credentials with `401`;
- `forbidden`: credentials may be recognized, but access, balance, region, or product activation prevents use;
- `rate_limited`: validation is temporarily unavailable;
- `unreachable`: timeout, DNS, TLS, or upstream `5xx` failure;
- `unsupported`: the discovery endpoint or Responses protocol is unsupported;
- `unverified`: the vendor requires a deployment or endpoint ID before a non-billable check is possible.

For routable presets, a missing key or confirmed invalid result blocks saving a new provider. Existing providers may be saved without re-entering their stored key. Other discovery failures permit saving only when at least one routable model or deployment ID is selected or entered manually. Unsupported presets cannot be saved; they direct users to a compatible aggregator or Custom.

Automatic validation starts after 700 milliseconds without API-key input; leaving the field triggers it immediately. It never runs once per keystroke. An explicit retry button remains available. Stale requests are aborted when provider type, connection options, URL, or key changes.

## Normalized Capabilities

Each discovered model uses:

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
  responses,
  source: 'api' | 'static' | 'unknown'
}
```

Capability flags are `true`, `false`, or `unknown`. Missing API fields are never interpreted as false. Resolution priority is:

1. explicit API metadata;
2. official static metadata for known models;
3. unknown.

The existing Codex catalog projection consumes only fields it supports: context window, image input, and reasoning levels. Richer normalized metadata is used by the management UI and kept behind a stable boundary for future catalog support.

## User Interface

The add/edit modal becomes a guided sequence:

1. search for and choose a vendor;
2. review compatibility status;
3. provide vendor-specific connection fields;
4. enter the API key;
5. see validation and model-discovery progress;
6. search and select one or more compatible models;
7. add a deployment or model ID manually when required;
8. save the provider.

The provider selector and model picker are accessible searchable comboboxes with keyboard navigation. The model picker supports multiple selection. Results show compact badges for Responses compatibility, Image, Video, Reasoning, Tools, and context size. Unknown values are shown as unknown rather than omitted or shown as unsupported.

Editing an existing provider preselects its saved models. Refreshing discovery merges results without silently removing manually configured IDs.

Selecting an unsupported vendor shows a focused explanation such as “The official direct API currently exposes Chat Completions but not Responses, so Codex cannot use it through the byte-preserving proxy.” When appropriate, an action switches the preset to OpenRouter and focuses model search for that vendor.

## Security

- Discovery runs only in the loopback-bound local backend.
- API keys are accepted only in POST bodies, held in memory for the request, never echoed, and never logged.
- Saved keys remain in `~/.codex-switch/env` with mode `0600`; `config.toml` stores only the environment-variable name.
- Upstream errors are sanitized and size-limited.
- Preset URLs are resolved again by provider type on the server.
- Custom and self-hosted discovery allow HTTPS plus loopback HTTP. Redirects are bounded and cannot change to a disallowed protocol or destination class.
- Requests have timeouts, response-size limits, and bounded pagination.

## Compatibility and Failure Handling

Discovery is advisory and never affects byte-level request forwarding. A saved provider remains routable when refresh later fails.

Existing manually configured providers continue to work. Existing model lists remain the fallback when edit-time discovery fails. Unknown fields are ignored, and malformed model entries are skipped with a warning rather than failing the entire list.

Unsupported provider metadata is informational and does not write an unusable route into `config.toml`.

## Testing and Verification

Automated tests use Node's built-in test runner and local stub HTTP servers. Coverage includes:

- preset metadata, grouping, URL derivation, connection options, and provider-type inference;
- supported, beta, limited, and unsupported save rules;
- every routable adapter's authentication, URL construction, pagination, parsing, capability normalization, filtering, and error mapping;
- keys never appearing in serialized responses or logs;
- custom URL safety and redirects;
- TOML round-tripping with `provider_type` and `provider_options`;
- default configuration excluding Bailian;
- admin discovery endpoint integration;
- searchable provider/model selection and preservation of manual IDs.

Release verification includes:

- clean automated test and syntax-check runs;
- local source deployment and real browser inspection at `http://127.0.0.1:8787/`;
- validation with locally available API keys without printing or recording their values;
- visual and interaction checks for search, keyboard selection, vendor-specific fields, unsupported warnings, error states, and responsive layout;
- `v0.5.0` DMG build, code-sign verification, mount/install smoke test, checksum generation, and GitHub Release asset verification.

Live vendor validation is limited by keys available on this machine. Vendors without a local key are verified with official documentation and deterministic stub-server tests and are reported separately from live-tested vendors.

## Official Compatibility Evidence

Primary references used for the routing boundary include:

- OpenAI Responses and Models: <https://developers.openai.com/api/docs/models>
- xAI Responses and model metadata: <https://docs.x.ai/developers/model-capabilities/text/comparison>
- OpenRouter Responses and Models: <https://openrouter.ai/docs/api/api-reference/responses/create-responses>
- AWS Bedrock Responses and Models: <https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html>
- Alibaba Cloud Model Studio Responses: <https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses>
- Google Gemini OpenAI compatibility: <https://ai.google.dev/gemini-api/docs/openai>
- Anthropic OpenAI compatibility limits: <https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk>
- Kimi Models API: <https://platform.kimi.com/docs/api/list-models>
- GLM OpenAI compatibility: <https://docs.bigmodel.cn/cn/guide/develop/openai/introduction>
- DeepSeek Models API: <https://api-docs.deepseek.com/api/list-models>
