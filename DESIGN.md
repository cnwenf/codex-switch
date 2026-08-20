# codex-switch 设计

## 1. 目标

一个本地 HTTP 代理,放在 Codex 和多个模型 provider 之间。Codex 把**一个** `model_provider` 指向本代理;代理根据请求 `body.model` 里的 model id 路由到对应 provider,**原生转发**,不做任何 body 改写。配置走配置文件 + HTML 配置页。

## 2. 核心原则:纯转发,零 body 改写

代理**只做三件事**:读 `body.model` → 查路由表 → 转发。请求体逐字节透传,响应体(含 SSE 流)逐字节回传。**不删字段、不加字段、不改值、不缓冲**。

这个原则是安全的,已用官方 Codex 源码核实 Codex 自己发的包就是每个 Responses 兼容上游都能接受的 shape:

- `codex-rs/core/src/client.rs:845` `build_responses_request` 里 `store: false`、`stream: true` 是**硬编码**字面量;
- `ResponsesApiRequest` 结构体(`codex-rs/codex-api/src/common.rs`)**没有 `max_output_tokens` / `max_tokens` 字段**——Codex 从不发这个字段给任何 provider。

所以不需要第三方 proxy 那套 body 规范化(删 `max_output_tokens`、强制 `store/stream`)。那套是给非 Codex 客户端兜底的;我们的客户端就是 Codex,无需改写。

## 3. 唯一允许的 header 改动:认证

代理**必须**按 provider 注入认证 header,这是不可避免的:

- Codex 一个 `model_provider` 只能携带**一份**凭证(`env_key` 或 `requires_openai_auth` 二选一,或都不带);
- 但代理要路由到 N 个**凭证不同**的上游(订阅 OAuth token vs 百炼 API key)。

所以代理对 `Authorization`(以及个别 provider 专有 header,如订阅的 `ChatGPT-Account-ID`)**按 provider 配置替换/注入**,其余 header 原样转发,body 原样转发。这不算"改写 Codex 的请求"——Codex 在这个 provider 下不带凭证,代理是**补上**缺失的 auth。

设计上让 Codex 的 `codexswitch` provider **不带任何客户端凭证**(不设 `env_key`、不设 `requires_openai_auth`),Codex 发请求时不带 Authorization;代理按命中的 provider 注入正确凭证。

> 实现时需验证:Codex 对一个既没 `env_key` 又没 `requires_openai_auth` 的自定义 provider 是否会拒绝发包。若拒绝,退化为设一个 `env_key = "CODEXSWITCH_DUMMY"` 占位值,代理忽略 Codex 的 Authorization 并替换为 provider 凭证。

## 4. 架构

```
Codex Desktop
  │  model_provider = "codexswitch"
  │  base_url = http://127.0.0.1:8787/v1
  ▼
codex-switch proxy  (127.0.0.1:8787)
  │  读 body.model → 查路由表 (model id → provider)
  ├─ gpt-5.6 / codex-1 ... → chatgpt.com/backend-api/codex  (OAuth token from ~/.codex/auth.json, 只读)
  └─ qwen3.8-max / ...     → dashscope.aliyuncs.com/compatible-mode/v1  (DASHSCOPE_API_KEY)
```

## 5. 路由逻辑

- 代理监听 `http://{listen}`(默认 `127.0.0.1:8787`)。
- Codex `base_url = http://127.0.0.1:8787/v1`,Codex 会 POST `/v1/responses`(以及可能 GET `/v1/models`)。
- 代理对每个进来的请求:
  1. 读 body,解析出 `model` 字段(限制 body size,JSON parse;只取 `model`)。
  2. 在路由表里找 `model` 命中的 provider(路由表 = config 里所有 provider 的 `models` 反向索引,启动/配置变更时重建)。
  3. 去掉自己的挂载前缀 `/v1`,得到 suffix(如 `/responses`),拼到 provider `base_url` 后转发:`{provider.base_url}{suffix}`。
  4. 注入该 provider 的 auth header,**其余 header 透传,body 透传**。
  5. 响应(SSE 或普通)**逐字节回传给 Codex,不缓冲**。
- 命中不到:`502` + JSON error,告诉 Codex 该 model id 没有配置 provider。

> 约束:catalog 里的 model id **必须**和上游原生 model 名字一致(禁止改写 body,所以不能做 id 映射)。

## 6. 配置文件 `config.toml`

```toml
[proxy]
listen = "127.0.0.1:8787"
mount_prefix = "/v1"                      # Codex base_url 的 path 部分
auth_json_path = "~/.codex/auth.json"     # 只给 chatgpt_oauth 用,只读

[[providers]]
id = "chatgpt-sub"
name = "ChatGPT 订阅"
base_url = "https://chatgpt.com/backend-api/codex"
auth = "chatgpt_oauth"
models = ["gpt-5.6", "gpt-5.5", "gpt-5.6-sol", "codex-1"]

[[providers]]
id = "bailian"
name = "阿里云百炼"
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
auth = "bearer"
token_env = "DASHSCOPE_API_KEY"
models = ["qwen3.8-max", "qwen3.7-plus", "qwen3.7-flash"]
```

认证类型:

- `chatgpt_oauth`:每次请求**重读** `auth_json_path` 的 `access_token` + `account_id`(**只读,绝不写、绝不自己 refresh**——让 Codex 官方客户端自己刷,避免 refresh-token 复用冲突)。注入 `Authorization: Bearer {access_token}` + `ChatGPT-Account-ID: {account_id}`。token 过期就让 401 透传回 Codex,Codex 自己处理。
- `bearer`:`Authorization: Bearer {token}`,token 从 `token_env` 指定的环境变量读(或 `token` 明文,不推荐)。

配置热加载:代理每次请求 re-read config(或 file watch)。**改 provider / model / 上游地址 / 凭证都不需要重启 proxy**。

## 7. HTML 配置页

`GET /`(根路径,非 `/v1` 下的接口)返回 HTML:

- 列出所有 provider 及其 models。
- 增/删/改 provider 表单(POST 到 `/__admin/providers`,写回代理自己的 `config.toml`)。
- "生成 Codex 配置"按钮:展示要贴进 `~/.codex/config.toml` 的 snippet 和 `catalog.json` 内容,带复制按钮。
- 状态栏:proxy 是否在跑、当前 listen、路由表(可选 debug)。

HTML 页**只写代理自己的 `config.toml`**;对 `~/.codex/` 只读展示 + 复制,不直接写(避免动 Codex 配置)。可选"应用并备份"按钮:备份 `~/.codex/config.toml` + catalog 后写入,需二次确认。

## 8. 启动 / 停止 / 状态

- 启动:`node src/server.js` 或 `npm start`。读 config,listen,同时起 HTML 页。PID 写 `~/.codex-switch/run.pid`。
- 停止:`npm run stop`(读 PID 发 SIGTERM)或 Ctrl-C。
- 状态:`npm run status`(查 PID 是否存活 + listen 端口)。
- 可选:macOS launchd plist 开机自启(标为可选)。

## 9. 多 provider 同时启用 & Codex 重启语义

代理**始终**支持多 provider(这就是它的用途)。从代理侧,加 provider 是热加载,不用重启 proxy。

但 Codex 侧:

- Codex 在**启动时**读 `config.toml` 和 model catalog。
- 要让 Codex 的 picker 显示新加的 model,必须更新 catalog 并**重启 Codex**。
- "同时启用多个 provider"的完整动作:
  1. 代理 config 里加好 N 个 provider + 它们的 models(代理热加载,即时生效)。
  2. Codex `config.toml` 里有那**一个** `[model_providers.codexswitch]` 块(一次配好,基本不动)。
  3. Codex `catalog.json` 列出**所有**启用 provider 的**所有** model,每条 `provider = "codexswitch"`。
  4. **重启 Codex** 让它重新读 catalog + config。

> "这个就需要重启 codex 才能生效" 指 catalog 变了要重启 Codex;代理本身不用重启。

### 9.1 Codex `~/.codex/config.toml` 要加的部分(一次)

```toml
model_catalog_json = "~/.codex/catalog.json"   # 指向本地 catalog(字段名实现时确认)

[model_providers.codexswitch]
name = "codex-switch 聚合"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
# 不设 env_key、不设 requires_openai_auth —— 凭证由代理注入
```

### 9.2 `~/.codex/catalog.json` 示例(全量替换格式)

```json
{
  "models": [
    { "slug": "gpt-5.6",     "display_name": "GPT-5.6 (订阅)",    "model": "gpt-5.6",     "provider": "codexswitch" },
    { "slug": "codex-1",     "display_name": "Codex (订阅)",      "model": "codex-1",     "provider": "codexswitch" },
    { "slug": "qwen3.8-max", "display_name": "Qwen3.8-Max (百炼)","model": "qwen3.8-max", "provider": "codexswitch" },
    { "slug": "qwen3.7-plus","display_name": "Qwen3.7-Plus (百炼)","model": "qwen3.7-plus","provider": "codexswitch" }
  ]
}
```

## 10. Codex 侧配置变更清单(每次代理配置改动时)

两个 Codex 侧文件:`~/.codex/config.toml`(provider 定义,一次配好)、`~/.codex/catalog.json`(model 列表)。

| 代理配置改动 | Codex `config.toml` | Codex `catalog.json` | 需重启 Codex? |
|---|---|---|---|
| 新增一个 provider | 否 | 是(加该 provider 的 models) | 是 |
| 已有 provider 加 model | 否 | 是(加 model 条目) | 是 |
| 删 model | 否 | 是(删条目) | 是 |
| 改 model id | 否 | 是(改 slug/name) | 是 |
| 改 provider base_url / 上游地址 | 否 | 否 | 否(代理热加载) |
| 换 provider 凭证(轮换 key) | 否 | 否 | 否(代理热加载;Codex 不持凭证) |
| 改 proxy 监听端口 | 是(改 base_url 端口) | 否 | 是 |
| 改 proxy host | 是 | 否 | 是 |
| 改代理挂载前缀 mount_prefix | 是(改 base_url path) | 否 | 是 |

**一句话**:动了 model 集合或 Codex base_url → 改 catalog/config + 重启 Codex;只动 provider 的上游地址或凭证 → 代理热加载,Codex 不用重启。

## 11. 语言与依赖

- Node.js(本机 v20.20.0),ESM。
- 尽量零运行时依赖:内置 `http`/`https`/`fs`/`crypto`;上游转发用 Node 20 全局 `fetch`(支持流式 `ReadableStream` 透传)。
- 唯一依赖:TOML 解析(`@iarna/toml`)。HTML 用字符串模板,不引框架。

## 12. 待实现时验证的点

- [ ] Codex 对无 `env_key` 且无 `requires_openai_auth` 的自定义 provider 是否会发包(决定 auth 注入策略)。
- [ ] Codex 是否会查询自定义 provider 的 `/v1/models` 端点(若会,代理可动态返回 model 列表,省掉 catalog.json;若不会,走 catalog.json 静态文件)。
- [ ] `model_catalog_json` 这个 config 字段名的确切拼写(实现时翻 config.rs 确认)。
- [ ] `~/.codex/auth.json` 里 `account_id` 字段位置(已初查在 `.tokens.account_id`,实现时再 jq 确认)。
- [ ] 百炼 Responses 端点 path:兼容模式 `/compatible-mode/v1/responses`(已确认)。
