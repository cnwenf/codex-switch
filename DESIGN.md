# codex-switch 设计

## 1. 目标与非目标

codex-switch 是 Codex 与多个上游模型 provider 之间的本地薄代理。Codex 只配置一个 `model_provider`，代理读取请求体中的原始 `model` ID，选择对应上游，并原样转发请求体、响应体和 SSE。

v0.5.0 在转发路径之外增加通用 provider registry、发现 adapter、能力缓存和引导式管理页，使用户可以判断厂商是否支持 Responses、检测连接、搜索模型，并安全地持久化连接选项。

非目标：

- 不把 Responses 请求转换成 Chat Completions。
- 不改写 model ID、请求字段、SSE event 或响应正文。
- 不把“Key 有效”或“能列出模型”当作 Responses 可路由的证明。
- 不迁移或删除已有第三方 provider；全新配置只包含 ChatGPT 订阅。

## 2. 不变量：零 body 改写

代理只执行：读取 `body.model` → 查反向路由表 → 选择上游 → 透传。请求体在解析路由字段后仍使用收到的原始字节发送；普通响应和 SSE 以流方式逐字节回传，不增加、删除、重命名或规范化字段。

模型 ID 必须等于上游实际接受的原始 ID。火山方舟的 Endpoint ID 和 Azure 的 Deployment ID 也直接作为 request `model`，不能在代理里做别名映射。

## 3. 唯一允许的 header 变化：认证

Codex 的 `codexswitch` provider 使用 `requires_openai_auth = true`，由 Codex 管理 OAuth 刷新。代理按目标 provider 处理认证：

- `chatgpt_subscription`：保留 Codex OAuth `Authorization`；缺少时只补 `ChatGPT-Account-ID`。
- `bearer`：移除 Codex OAuth 和 `ChatGPT-Account-ID`，注入 `Authorization: Bearer {$token_env}`。
- `chatgpt_oauth`：使用环境变量中的 OAuth 值。
- `passthrough`：保留客户端认证 header。

除了目标上游必需的认证变化，其余 header 和所有 body 字节不变。上游 401/403 等状态原样回到客户端；发现 API 的错误则走单独的脱敏状态模型。

## 4. 总体架构

```text
Codex Desktop
  │ model_provider = codexswitch
  │ POST http://127.0.0.1:8787/v1/responses
  ▼
server.js
  ├─ routing: body.model -> provider -> byte-preserving proxy
  ├─ admin API: providers / history / apply / discovery
  ├─ provider-registry.js: authoritative metadata + URL derivation
  ├─ provider-discovery.js: bounded vendor adapters + normalization
  ├─ provider-config.js: provider_type/options TOML persistence
  ├─ caps.js: override/cache/static/default capability resolution
  └─ admin-page.js: server-rendered management UI
```

发现与能力只影响管理页和生成的 `catalog.json`，不会进入转发 body 路径。发现失败不会让已经保存的 provider 停止路由。

## 5. Responses 兼容性边界

Codex 发送 `POST /responses` 并消费 Responses SSE。很多厂商所称的“OpenAI compatible”只实现 `/chat/completions`，因此 registry 把兼容性作为保存门禁，而不是展示标签。

- `supported`：存在可用于直连的 Responses API。
- `beta`：存在 Responses API，但厂商标记为 Beta。
- `limited`：存在 Responses 路径，但模型、字段或部署有已知限制。
- `unsupported`：没有确认官方直连 Responses API，不能写入路由配置。

`supported`、`beta`、`limited` 可路由；`unsupported` 只作为可搜索说明项。Kimi、GLM、DeepSeek、Gemini、Anthropic、Mistral、Together、Cerebras 和 SiliconFlow 当前属于 unsupported。UI 可把用户切换到 OpenRouter 并保留厂商关键词；Custom 则留给用户已经自行验证的 Responses 网关。

## 6. Provider registry

`src/provider-registry.js` 是厂商元数据和 URL 计算的唯一权威来源。每个不可变条目包含：

```js
{
  id,
  name,
  group,
  compatibility,
  compatibilityNote,
  auth,
  tokenEnv,
  options,
  baseUrl | buildBaseUrl,
  requiresManualModel,
  routable,
  public
}
```

浏览器只接收去掉可执行函数的 `public` projection。服务端在保存和发现时重新执行 `resolveProviderConnection()`：固定 URL 不信任前端值；Bailian region/workspace、Tencent site、Bedrock region、Azure resource endpoint、Cloudflare account ID 等动态连接也重新派生。

Custom 和 NVIDIA NIM 允许用户输入 URL。它们只接受 HTTPS，或 `localhost` / `127.0.0.0/8` / IPv6 loopback 的 HTTP；URL 不能包含 userinfo、query 或 fragment。Azure endpoint 还必须属于 Azure OpenAI / AI Foundry 官方域名。

已有配置没有 `provider_type` 时按严格 hostname 规则推断，无法精确匹配则保守归入 Custom。Custom 永远是搜索列表最后一项。

## 7. 持久化与升级兼容

每个新 provider 保存：

```toml
[[providers]]
id = "example"
name = "Example"
provider_type = "aws-bedrock"
provider_options = { region = "us-east-1" }
base_url = "https://bedrock-mantle.us-east-1.api.aws/v1"
auth = "bearer"
token_env = "AWS_BEDROCK_API_KEY"
models = ["model-id"]
enabled = true
```

`provider_type` 是稳定 adapter 身份，`provider_options` 保存厂商连接参数，`base_url` 保留给旧代码和转发路径。写入时 base URL 必须由 registry 重新派生，不能使用浏览器伪造值。

`provider_options` 只接受字符串、布尔值和有限数字。旧 provider 若没有新字段仍可加载；已存在的 Bailian 配置不会因升级被删除。仓库和新 DMG 的 `config.toml` 默认只有 ChatGPT 订阅 provider。

## 8. Discovery adapter 架构

`src/provider-discovery.js` 对外提供：

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

adapter table 隔离异构 API：

- 通用 Models：OpenAI、Groq、Fireworks、Baidu Qianfan、AWS Bedrock、NVIDIA NIM、Custom。
- xAI：先检验 API key endpoint，再读取 language-models。
- OpenRouter：先 `GET /key`，再优先 `GET /models/user`，404 时退到公共 `/models`。
- Tencent TokenHub：将 Key 可见在线模型与官方 Responses 协议矩阵求交集。
- Bailian：把兼容模式 URL 转成同 host 的原生 `/api/v1/models`，执行有界分页。
- Volcengine Ark：不做可能计费的推理探测，只返回静态底座参考，要求手工 Endpoint ID。
- Azure OpenAI：底座 inventory 不等于部署名，要求手工 Deployment ID。
- Cloudflare Workers AI：返回官方静态 Responses 白名单，不探测 Token。

只有 Volcengine Ark 和 Azure OpenAI 设置稳定的 `requiresManualModel`。普通 provider 即使临时发现失败并回退到 manual source，也不会被误判成 deployment-only。

## 9. Validation states 与保存门禁

发现结果不是布尔值：

- `valid`：凭证与发现 endpoint 被接受。
- `invalid`：上游明确以 401 拒绝凭证。
- `forbidden`：403/402，可能是权限、余额、region 或产品开通问题。
- `rate_limited`：429，当前无法验证。
- `unreachable`：超时、DNS、TLS、5xx、响应解析或安全限制失败。
- `unsupported`：缺少所需发现 endpoint，或厂商不可直连。
- `unverified`：无需/无法做非计费验证，必须由首次真实请求确认。

浏览器在 Key 输入停止 700 ms 后自动检测，blur 立即检测，显式按钮可重试。provider、连接选项、URL、Key 或 token env 改变时会 abort 旧请求并使结果失效。

保存规则：

- unsupported 不能保存。
- 新 bearer provider 必须有新 Key 或已保存 Key；confirmed invalid 不能保存。
- 至少选择或手工输入一个可路由 model ID。
- Ark/Azure 必须选择用户手工输入的 Endpoint/Deployment ID；静态参考模型不可选择成路由。
- Custom、静态目录和已有 provider 可在明确的 unverified 状态下保存；UI 会说明首次调用为准。

已有 Key 只在编辑同一已保存 provider、`provider_type` 和 `token_env` 均匹配时由本地后端使用。发现缓存也只写入同 ID、同类型且仍启用的 provider，避免跨 provider 或未保存表单污染 catalog。

## 10. 能力规范化与缓存优先级

发现模型统一成：

```js
{
  id,
  name,
  contextWindow,
  maxOutputTokens,
  input: { text, image, audio, video, file },
  output: { text, image, audio, video },
  tools,
  reasoning,
  responses,
  source: 'api' | 'static' | 'unknown'
}
```

能力字段是 `true` / `false` / `unknown` 三态。完整 modality 数组明确表示缺失项为 false；API 根本没返回字段时保持 unknown。API metadata 优先，已知模型可补官方静态 metadata，任何缺失都不能自动推断为 false。

`caps.js` 生成 Codex catalog 时的优先级：

1. `config.toml` 的 `model_overrides`；
2. provider discovery cache；
3. 内置静态表；
4. 保守默认（128K、无视觉、不声明 reasoning effort）。

缓存以 provider ID 保存发现时间和模型能力。发现的 unknown image 不覆盖静态值，明确 false 可以覆盖；明确 reasoning false 会清空静态 reasoning levels。能力只改变 `catalog.json`，不改变路由请求。

## 11. 安全限制

发现服务与管理 API 只绑定 loopback。安全边界包括：

- Key 只从 POST body 进入内存和上游 `Authorization`；不写 URL、不进日志，不拼入错误信息。
- 编辑页不回填已保存 Key；发现结果、warning 和错误正文均脱敏。包含完整 Key 的模型 ID/name/metadata 会整条丢弃。
- 持久 Key 位于 `~/.codex-switch/env`，mode `0600`；`config.toml` 仅保存 `token_env` 名称。
- “复制为 JSON”是用户明确触发的敏感导出，可能把 Key 放入剪贴板；它不属于自动发现或普通编辑回显。
- preset URL 由服务端重算；Custom/NIM 仅允许 HTTPS 或 loopback HTTP。
- 跳转最多 3 次，必须保持同 origin 和同 destination class；公网不能跳到 loopback，凭证不能跨 origin。
- 初始 URL、redirect、pagination link、cursor/path/query/fragment 都检查原始及最多三层 percent decoding，畸形或过深编码 fail closed。
- 单请求超时 10 秒；JSON response 最多 4 MiB；最多 5 页、2,000 个模型。越界时立即取消 reader 并返回稳定错误。
- 上游错误正文和内部 stack 不返回浏览器；HTTP 状态映射成固定 validation state/message。

这些限制降低 SSRF、Bearer 跨域转发、无限分页、内存放大和错误正文泄密风险。它们不把未验证的 Custom endpoint 升级成可信厂商。

## 12. 管理页结构（Task 6）

`src/admin-page.js` 渲染一个克制的浅色本地开发工具：冷灰 canvas、不透明 surface、一个蓝色 accent 和语义状态色；没有渐变、玻璃、光晕或自定义滚动条。

信息结构：

- sticky 顶栏：产品、供应商/配置历史 tabs、运行地址和版本。
- 供应商页：启用模型并集摘要、单列 provider record list、CRUD/启停动作。
- 配置历史页：备份记录、Codex 应用/还原、LaunchAgent 开关。
- 添加/编辑：厂商搜索 → Responses 兼容性 → 动态连接字段 → Key 检测 → 多选模型 → 手工 ID → 保存。

桌面端使用有界 dialog；窄屏使用占满 viewport 的全屏 sheet，header/footer 固定，body 独立滚动。移动交互目标至少 44×44 px。厂商和模型控件使用 combobox/listbox semantics，支持 Arrow/Enter/Escape；tabs 支持 Arrow/Home/End；modal 有焦点循环和焦点恢复。状态同时包含图标与文字，支持 reduced motion。

Task 6 只重组视觉和交互表达，保留 provider CRUD、toggle/copy/import、history/restore、Codex apply/restore、autostart、update、discovery、validation 和保存 payload/state machine。

## 13. 配置热加载与 Codex 重启语义

provider URL、凭证、启停和路由映射由本地服务热加载。Codex 在启动时读取 `config.toml` 和 model catalog：

| 改动 | 代理重启 | 更新 Codex catalog/config | 重启 Codex |
|---|---:|---:|---:|
| 新增/删除/改 model ID | 否 | catalog | 是 |
| 改 provider URL/options | 否 | 否 | 否 |
| 轮换 API Key | 否 | 否 | 否 |
| 改 proxy listen/mount | 是 | config | 是 |

管理页“应用并备份”以手术式方式合并 `[model_providers.codexswitch]` 和 catalog 条目；应用前备份，一键还原只移除本工具注入部分，保留 Codex 其他 section。

## 14. 测试与证据边界

Node 内置 test runner 和本地 stub HTTP server 覆盖 registry、URL 派生、所有 adapter 分支、三态规范化、错误映射、Key 脱敏、重定向/分页/大小限制、TOML round-trip、cache priority、admin API、可搜索 UI、键盘与响应式结构。

自动化/stub 证据、官方文档兼容性证据和真实厂商 Key live 验证必须分开报告。没有本机可用 Key 时，只能声称确定性 adapter 测试和文档边界通过，不能声称厂商账号、权限、region 或 endpoint 已 live 验证。

同样，`package.json` 版本、README 或设计文档更新不代表 GitHub Release workflow、DMG asset、checksum 或一键安装 E2E 已完成；这些属于后续发布任务，需要独立运行与验收证据。
