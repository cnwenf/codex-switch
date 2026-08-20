# codex-switch

> 本地薄代理:让 Codex 一个 provider 转发到 N 个上游 provider,按 `model id` 路由,**零 body 改写**。

Codex Desktop / CLI 的一个 `model_provider` 只能携带**一份**凭证(一个 API key,或一个 ChatGPT 订阅 OAuth)。如果你想在一个 Codex 里同时用**订阅版 GPT** 和**第三方 API key 模型**(如阿里云百炼 Qwen),原生配置做不到。`codex-switch` 解决这个:把 Codex 的那一个 provider 指向本代理,代理读请求体里的 `model` 字段,路由到配置好的上游,凭证按上游替换,请求体和响应体(含 SSE 流)逐字节透传。

## 它是"薄"代理,不是"改写"代理

代理**只做三件事**:读 `body.model` → 查路由表 → 转发。不删字段、不加字段、不改值、不缓冲。

这点用官方 Codex 源码核实过,Codex 自己发的包就是任何 Responses 兼容上游都能接受的 shape:

- `codex-rs/core/src/client.rs` 的 `build_responses_request` 里 `store: false` / `stream: true` 是硬编码字面量;
- `ResponsesApiRequest` 结构体**没有 `max_output_tokens` / `max_tokens` 字段**——Codex 从不发这些。

所以不需要第三方 proxy 常见的 body 规范化。那套是给非 Codex 客户端兜底的;本代理的客户端就是 Codex,无需改写。

唯一被代理碰的只有**认证 header**(不可避免:Codex 一个 provider 只能带一份凭证,但代理要路由到凭证不同的多个上游)。详见下文[认证](#认证)。

## 特性

- 纯转发,零 body 改写;SSE 流式响应逐字节回传(Node 20 全局 `fetch` + `Readable.fromWeb` 管道)。
- 按 `body.model` 路由;一个 provider 可挂多个 model。
- 配置文件驱动(`config.toml`),**热加载**(改 provider / model / 上游 / 凭证都不用重启代理)。
- HTML 配置页(`GET /`):看路由表、在线编辑 `config.toml`、一键生成 Codex 侧配置片段。
- 认证策略:`passthrough` / `chatgpt_subscription` / `bearer`,凭证不落盘、不写日志。
- **模型能力自动获取**:配好 API key 和 URL 后,自动从百炼原生 `GET /api/v1/models` 抓取上下文窗口、是否支持图片(缓存 30 分钟),推理强度档位由 config 覆盖 / 静态表补齐;全部写进生成的 `catalog.json`(schema 对齐 codex-rs `ModelInfo`)。见[模型能力](#模型能力)。
- 仅一个运行时依赖(TOML 解析 `@iarna/toml`)。
- 启停:`npm start` / `npm run stop` / `npm run status`(PID 文件管理)。
- macOS 企业网络自愈:`npm start` 自动导出系统钥匙串 CA(Node 内置 Mozilla CA 列表不含企业根证书时也能验 TLS)。

## 要求

- Node.js ≥ 20(用全局 `fetch` 的流式 `ReadableStream`)。
- 已装 Codex(Desktop 或 CLI),并有以下至少一种凭证:
  - ChatGPT 订阅(Codex OAuth,`~/.codex/auth.json` 自动管理);
  - 或第三方 API key(走环境变量,如 `DASHSCOPE_API_KEY`)。

## 安装

```bash
git clone <this-repo> codex-switch
cd codex-switch
npm install
```

## 配置

编辑 `config.toml`(代理自己的配置,和 Codex 的 `~/.codex/config.toml` 是两份):

```toml
[proxy]
listen = "127.0.0.1:8787"           # 只监听本地
mount_prefix = "/v1"                # Codex base_url 的 path 部分
auth_json_path = "~/.codex/auth.json"  # 只给 chatgpt_subscription 补 account_id 用,只读

[[providers]]
id = "chatgpt-sub"
name = "ChatGPT 订阅"
base_url = "https://chatgpt.com/backend-api/codex"
auth = "chatgpt_subscription"
models = ["gpt-5.6", "gpt-5.5", "gpt-5.6-sol", "codex-1"]

[[providers]]
id = "bailian"
name = "阿里云百炼"
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
auth = "bearer"
token_env = "DASHSCOPE_API_KEY"      # 从环境变量读,不写进配置文件
models = ["qwen3.8-max", "qwen3.7-plus", "qwen3.7-flash"]
```

### 认证

每个 provider 一个 `auth` 策略:

| `auth` | 行为 | 适用 |
|---|---|---|
| `chatgpt_subscription` | **原样转发** Codex 的 OAuth `Authorization`(Codex 用 `requires_openai_auth=true` 自带新鲜 token);仅在缺失时从 `~/.codex/auth.json`(只读)补 `ChatGPT-Account-ID`。token 过期 401 透传回 Codex 自刷。 | ChatGPT 订阅上游 |
| `bearer` | **剥离** Codex 的 OAuth `Authorization` + `ChatGPT-Account-ID`,注入 `Authorization: Bearer {$token_env}`。 | API key 上游(百炼、OpenAI 兼容等) |
| `passthrough` | 原样转发所有 header。 | 同源 / 自带凭证的上游 |

`bearer` 的 token 优先从 `token_env` 指定的环境变量读;也可用 `token = "..."` 明文(不推荐,会落盘到 `config.toml`)。

## 运行

```bash
npm start     # 启动,前台跑,PID 写入 ~/.codex-switch/run.pid
npm run stop  # 读 PID 发 SIGTERM
npm run status# 查 PID 是否存活
```

启动后:

- 配置页:`http://127.0.0.1:8787/`
- Codex 入口:`http://127.0.0.1:8787/v1`

### 企业网络(透明代理 / 自签 CA)

公司内网常有 HTTPS 拦截:上游证书链由企业 CA 签发,只有系统钥匙串信任它。此时 curl 正常,但 Node 自带的 Mozilla CA 列表验证失败,转发报 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`。

- **macOS**:`npm start` 已通过 `scripts/start.sh` 把「已有 `NODE_EXTRA_CA_CERTS` 文件内容 + 系统/登录钥匙串证书」合并成一个 bundle 再导出,一般无需处理。
- **其他平台 / 自定义 CA**:手动导出,`NODE_EXTRA_CA_CERTS=/path/to/ca.pem npm start`。

## Codex 侧配置(一次性)

打开配置页 `http://127.0.0.1:8787/`,`/__admin/codex-config` 会给出生成好的两段内容,贴进 Codex:

**`~/.codex/config.toml`** 加:

```toml
model_catalog_json = "~/.codex/catalog.json"

[model_providers.codexswitch]
name = "codex-switch 聚合"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = true   # Codex 管 token 刷新 + 带订阅 header;代理订阅路由原样转发
```

> `requires_openai_auth = true` 让 Codex 自己管 OAuth token 刷新(代理绝不碰 refresh-token,避免和 Codex 抢)、并自带订阅所需 header。代理的订阅路由**原样转发**这对 header;bearer 路由才剥离并换成 API key。

**`~/.codex/catalog.json`** 全量替换:内容由配置页 `/__admin/codex-config` 的 `catalog_json` 生成(完整 `ModelInfo` schema,含能力元数据)。

```json
{
  "models": [
    {
      "slug": "gpt-5.6",
      "display_name": "GPT-5.6 (ChatGPT 订阅)",
      "supported_reasoning_levels": [
        { "effort": "none", "description": "Non-reasoning" },
        { "effort": "low",  "description": "Low reasoning" },
        { "effort": "medium", "description": "Medium reasoning (default)" },
        { "effort": "high", "description": "High reasoning" },
        { "effort": "xhigh", "description": "Extra high reasoning" },
        { "effort": "max",   "description": "Maximum reasoning" },
        { "effort": "ultra", "description": "Ultra (multi-agent)" }
      ],
      "default_reasoning_level": "medium",
      "shell_type": "shell_command",
      "visibility": "list",
      "supported_in_api": true,
      "context_window": 1000000,
      "input_modalities": ["text", "image"]
    }
  ]
}
```

(每条还有 `truncation_policy`、`effective_context_window_percent` 等字段,以配置页输出为准。)

然后在 Codex 里把 `model_provider = "codexswitch"` 设为默认(或按线程选)。**改 catalog 必须重启 Codex** 让它重读。

> 约束:catalog 里的 `model` id **必须**和上游原生 model 名字一致(禁止改写 body,所以不能做 id 映射)。

## Codex 侧配置变更清单

| 代理配置改动 | Codex `config.toml` | Codex `catalog.json` | 需重启 Codex? |
|---|---|---|---|
| 新增一个 provider | 否 | 是 | 是 |
| 已有 provider 加 model | 否 | 是 | 是 |
| 删 / 改 model id | 否 | 是 | 是 |
| 改 provider 上游地址 / 换 API key | 否 | 否 | 否(代理热加载) |
| 改 proxy 监听端口 / host / mount_prefix | 是 | 否 | 是 |

**一句话**:动了 model 集合或 Codex base_url → 改 catalog/config + 重启 Codex;只动上游地址或凭证 → 代理热加载,Codex 不用重启。

## 模型能力

Codex 需要每个模型的上下文窗口、是否支持图片、支持的推理强度档位,这些元数据全部由代理写入 `catalog.json`(请求转发不涉及,零改写原则不变)。

解析优先级:**config 覆盖 > 百炼联网 > 内置静态表(7 个默认模型)> 保守默认**

- **百炼联网(自动)**:provider 的 `base_url` 命中 DashScope 域(`dashscope.aliyuncs.com` / `dashscope-intl.aliyuncs.com` / `*.maas.aliyuncs.com`)且配了 API key 时,代理在启动时与保存配置后自动调用原生 `GET /api/v1/models`,取 `model_info.context_window` 和 `inference_metadata.request_modality`,缓存 30 分钟。打开配置页 `http://127.0.0.1:8787/`,「Model capabilities」区会展示每个模型的窗口/模态/推理档位与数据来源,可点 `refresh (fetch live)` 强制刷新。
- **config 覆盖**:在 `config.toml` 里手工指定(如新模型或对自动数据不满意):

  ```toml
  [model_overrides."qwen3.8-max"]
  context_window = 1000000
  vision = true
  reasoning_efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
  default_reasoning_effort = "medium"
  ```

- **内置静态表**:gpt-5.6 / gpt-5.6-sol / gpt-5.5 / codex-1 / qwen3.8-max / qwen3.7-plus / qwen3.7-flash 的能力已硬编码在 `src/caps.js`(带来源注释)。
- **保守默认**:未命中任何来源的模型按 128K、无视觉、不声明推理档位处理(Codex 不发 effort 参数,用上游默认)。

改完能力(尤其是换了 catalog)后记得**重启 Codex**。

## 安全

- **只监听 `127.0.0.1`**,不对外暴露。
- **无明文 secret**:`bearer` 走 `token_env` 环境变量;`chatgpt_subscription` 走 Codex 自己管的 `~/.codex/auth.json`。`config.toml` 里不存任何 token。
- **`auth.json` 只读**:代理绝不写、绝不自己 refresh OAuth token(避免和 Codex 抢 refresh-token);token 过期让 401 透传回 Codex 自刷。
- 代理只转发到 `config.toml` 里登记的上游;命中不到的 model id 返回 `502`。
- `config.local.toml`(若你用它放本地覆盖)已在 `.gitignore`,不会被推送上仓库。

## 架构

```
Codex Desktop / CLI
  │  model_provider = "codexswitch"   base_url = http://127.0.0.1:8787/v1
  ▼
codex-switch proxy  (127.0.0.1:8787)
  │  读 body.model → 查路由表 (model id → provider)
  ├─ gpt-5.6 / codex-1 ... → chatgpt.com/backend-api/codex  (chatgpt_subscription: 原样转发 Codex OAuth)
  └─ qwen3.8-max / ...     → dashscope.aliyuncs.com/...      (bearer: 换成 DASHSCOPE_API_KEY)
```

实现:`src/server.js`(代理 + 管理页)+ `src/caps.js`(模型能力:静态表 / 百炼联网 / 覆盖解析)。HTML 用字符串模板,不引框架。

## 开发

```bash
node --check src/server.js src/caps.js   # 语法检查
npm start                                # 前台跑,改 config.toml 自动热加载
```

## 许可

MIT。欢迎 PR、issue、复用。开源精神:能帮到同样想在 Codex 里混用订阅 + API key 的人就好。