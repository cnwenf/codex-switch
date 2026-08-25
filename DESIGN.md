# codex-switch 设计

## 1. 目标与非目标

codex-switch 是 Codex 与多个上游模型 provider 之间的本地薄代理。Codex 只配置一个 `model_provider`，代理读取请求 JSON 中的原始 `model` ID，选择对应上游，并且不改写应用层 JSON 或 SSE event/data。它仍遵循正常 HTTP 代理语义处理 header、认证和传输编码，不能承诺网络层每个字节都不变化。

v0.5.0 在转发路径之外增加通用 provider registry、发现 adapter、能力缓存和引导式管理页，使用户可以判断厂商是否支持 Responses、检测连接、搜索模型，并安全地持久化连接选项。

非目标：

- 不把 Responses 请求转换成 Chat Completions。
- 不改写 model ID、请求字段、SSE event 或响应正文。
- 不把“Key 有效”或“能列出模型”当作 Responses 可路由的证明。
- 不迁移或删除已有第三方 provider；全新配置只包含 ChatGPT 订阅。

## 2. 不变量：不改应用层 JSON / SSE payload

代理只执行：读取 `body.model` → 查反向路由表 → 选择上游 → 透传。请求 JSON 在解析路由字段后仍使用收到的 body buffer 发送；响应 body 以流方式转发，不增加、删除、重命名或规范化应用层 JSON 字段和 SSE event/data。这里保证的是应用层 payload 语义，不是包含 HTTP framing、压缩编码在内的线缆字节恒等。

模型 ID 必须等于上游实际接受的原始 ID。火山方舟的 Endpoint ID 和 Azure 的 Deployment ID 也直接作为 request `model`，不能在代理里做别名映射。

## 3. HTTP proxy header 与认证处理

Codex 的 `codexswitch` provider 使用 `requires_openai_auth = true`，由 Codex 管理 OAuth 刷新。代理按目标 provider 处理认证：

- `chatgpt_subscription`：保留 Codex OAuth `Authorization`；缺少时只补 `ChatGPT-Account-ID`。
- `bearer`：移除 Codex OAuth 和 `ChatGPT-Account-ID`，注入 `Authorization: Bearer {$token_env}`。
- `chatgpt_oauth`：fallback 模式从 `~/.codex/auth.json` 只读取得 `tokens.access_token`，并读取 `tokens.account_id`（兼容顶层 `account_id`）设置 account header；不从 provider 环境变量取 OAuth。
- `passthrough`：保留客户端认证 header。

作为正常 HTTP 代理，请求侧会剥离 `host`、`content-length`、`connection`、`keep-alive`、`transfer-encoding`、`upgrade`、`proxy-connection`、`te`、`trailer`、`expect` 等 hop-by-hop / 重算 header，再由 `fetch` 为目标请求生成需要的传输 header。响应侧同样剥离 hop-by-hop header；由于 `fetch` 可能自动解压，代理还会移除原上游 `content-length` 和 `content-encoding`，由下游连接重新 framing。其他 end-to-end header 在没有认证冲突时继续转发。

因此准确承诺是“不改应用层 JSON / SSE payload”，而不是“除认证外所有 header 和线缆字节不变”。上游 401/403 等状态原样回到客户端；发现 API 的错误则走单独的脱敏状态模型。

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

`provider_options` 只接受字符串、布尔值和有限数字。管理页新增或轮换的 Key 写入 `~/.codex-switch/env`（mode `0600`），新 provider 在 `config.toml` 中只引用 `token_env`。为向后兼容，legacy / 旧版 inline `token` 仍可解析、序列化，并在缺少 env 值时作为 bearer fallback；显式导出也能带出它以便迁移。inline token 会让明文留在配置和备份中，应迁移到 env 文件后移除，不能把兼容能力理解为推荐存储方式。

旧 provider 若没有新字段仍可加载；已存在的 Bailian 配置不会因升级被删除。仓库和新 DMG 的 `config.toml` 默认只有 ChatGPT 订阅 provider。

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
- 新 bearer provider 必须在保存请求中携带新 Key；confirmed invalid 不能保存。
- 至少选择或手工输入一个可路由 model ID。
- Ark/Azure 必须选择用户手工输入的 Endpoint/Deployment ID；静态参考模型不可选择成路由。
- Custom、静态目录和已有 provider 可在明确的 unverified 状态下保存；UI 会说明首次调用为准。

新增 bearer provider 必须在同一次 JSON 保存请求中提交新的 `api_key`；即使请求给出的 `token_env` 在当前进程中已有值，服务端也不会借用或重新绑定它。编辑只有在规范化后的完整连接身份（`provider_type`、authoritative `base_url`、`provider_options`）、实际持久化的 runtime `base_url` 和原 `token_env` 均未改变时，才可沿用已保存 Key。连接、`token_env` 或 legacy inline `token` 变化必须原子携带新 Key；拒绝或持久化失败会恢复原 config、env 文件、受影响的 `process.env` 值，以及 capability cache 原有 metadata 和 TTL。

`POST /__admin/config` 是 `text/plain`，配置历史恢复也只有 TOML 快照，两者都没有同请求 `api_key` 字段。因此这两个入口允许修改名称、模型、启停等非凭据字段，但对新增 bearer、把现有 provider 改成 bearer、改 bearer runtime/规范化连接、重绑 `token_env` 或修改 inline `token` 一律 fail closed 为 400；需要这些变化时必须走 provider JSON 保存入口。`GET /__admin/config`、非凭据 raw import 和安全的历史恢复保持兼容。

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

缓存以 provider ID 索引，但每条记录同时绑定不含 Key/token 的完整规范化连接身份和 30 分钟 TTL。provider CRUD、toggle/delete、允许的 raw config 写入、配置历史恢复和 env Key 保存/删除全部进入同一套 mutation 失效语义：先对所有语义发生变化的 provider 推进内存 generation、撤销 refresh lease 并删除 identity-bound cache，然后才让新 config/credential 可见。`refreshAllCaps` 只是写入后的能力补充，不承担安全失效。每个异步发现完成时再次核对当前 ID、启用状态、连接身份、generation 和最新 lease，旧请求因此不能在删除/重建、改 URL、换 Key、raw import、历史恢复或并发刷新后覆盖新缓存；即使新一轮刷新被前一个 provider 阻塞也一样。`resolveCaps` 在读取时再次核对 TTL 与连接身份，过期、ID 复用或不匹配均 fail closed 到静态/默认能力。generation/lease 只存在于当前进程，重启后缓存本来也为空。发现的 unknown image 不覆盖静态值，明确 false 可以覆盖；明确 reasoning false 会清空静态 reasoning levels。能力只改变 `catalog.json`，不改变路由请求。

## 11. 安全限制

默认配置将整个 server 绑定到 `127.0.0.1:8787`，发现服务与管理 API 因此只在本机可达。`proxy.listen` 是可手工修改的配置，server 当前不会强制 loopback，管理 API 是无认证管理面：若改到非 loopback / 非回环地址，provider CRUD、Codex 配置操作和显式 Key 导出都会暴露给该网络，存在远程配置篡改和凭据泄露风险，强烈禁止这样部署。以下安全边界均以保留默认 loopback bind 为前提：

- Key 只从 POST body 进入内存和上游 `Authorization`；不写 URL、不进日志，不拼入错误信息。
- 编辑页不回填已保存 Key；发现结果、warning 和错误正文均脱敏。包含完整 Key 的模型 ID/name/metadata 会整条丢弃。
- 管理页新写入的持久 Key 位于 `~/.codex-switch/env`，mode `0600`；新配置只保存 `token_env` 名称。legacy inline `token` 仍为向后兼容可解析/序列化，必须迁移，不能视为安全默认值。
- “复制为 JSON”是用户明确触发的敏感导出，可能把 Key 放入剪贴板；它不属于自动发现或普通编辑回显。
- preset URL 由服务端重算；Custom/NIM 仅允许 HTTPS 或 loopback HTTP。
- 跳转最多 3 次，必须保持同 origin 和同 destination class；公网不能跳到 loopback，凭证不能跨 origin。
- 初始 URL、redirect、pagination link、cursor/path/query/fragment 都检查原始及最多三层 percent decoding，畸形或过深编码 fail closed。
- 单请求超时 10 秒；JSON response 最多 4 MiB；最多 5 页、2,000 个模型。越界时立即取消 reader 并返回稳定错误。
- 上游错误正文和内部 stack 不返回浏览器；HTTP 状态映射成固定 validation state/message。
- DMG 安装先把应用复制到已规范化 Applications 父目录内的随机 staging，再用 DMG 内置 Node 的 `rename(2)` 将旧目标移到同目录随机 backup、把 staging 原子改名为最终 `.app`；最终路径若在校验后被换成 symlink，只移动/替换链接本身，不跟随到链接目标。清理只作用于安装器自己在该父目录创建的随机 staging/backup 和下载临时目录。断电或恶意并发导致第二次 rename 失败时安装会 fail closed，并可能保留随机 backup 供手工恢复；这里不宣称跨断电事务。

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

Task 9 已实现并通过本地自动化验收：GitHub Actions 从精确 release tag 构建 arm64 DMG 和 `.sha256`，发布前校验版本、架构、签名、DMG 与 checksum；安装器对同一精确 tag 执行有界轮询、严格资产元数据匹配和 checksum 校验。它不等于线上 Release 已发布：真实 Actions run、GitHub 资产回读和 latest 一键安装属于 Task 10，必须在发布后单独验收。
