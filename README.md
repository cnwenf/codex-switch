# codex-switch

为 Codex 提供多模型路由的**极薄本地代理**:一个 Codex provider → N 个上游 provider。

核心承诺:

- **零改写**:只读请求体里的 `model` 字段做路由,请求/响应字节级原样转发(流式 SSE 也是透传)。
- **纯配置**:路由全部来自 `config.toml`,一个 provider 可挂多个模型,无数据库、无状态。
- **自带 HTML 配置页**:页面上改配置、查模型能力,**一键写入 Codex 侧配置**(改动前自动备份,支持一键还原),重启 Codex 即用。

详细设计见 [DESIGN.md](DESIGN.md)。

## 一键安装

```sh
git clone https://github.com/cnwenf/codex-switch.git
cd codex-switch
./install.sh
```

`install.sh` 会:安装依赖 → 启动服务 → 在终端打印配置页链接:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  打开配置页面(浏览器):  http://127.0.0.1:8787/
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

打开页面 → 配置 providers(API key 填环境变量名)→ 保存 → 点「应用并备份」→ 重启 Codex,完事。

## 日常使用

| 命令 | 作用 |
|---|---|
| `./install.sh` | 升级/重启(幂等,已装过的重新跑即可) |
| `npm start` / `npm stop` / `npm status` | 启动 / 停止 / 状态 |
| `open http://127.0.0.1:8787/` | 配置页 |

## 安全说明(请读)

- **本地服务**:只监听 `127.0.0.1`,不对外网开放;无远程升级、无遥测、无日志上传。
- **不改写请求**:除按 provider 配置注入/剥离认证头外,任何请求体、路径、参数、响应一律原样转发。
- **凭证不落配置**:proxy 自己的 `config.toml` 不放任何明文密钥。上游 API key 走环境变量(如 `DASHSCOPE_API_KEY`)——把 key 写进 `~/.codex-switch/env`(已 gitignore,不进仓库):

  ```sh
  printf 'DASHSCOPE_API_KEY=sk-xxx\n' > ~/.codex-switch/env && chmod 600 ~/.codex-switch/env
  ```

- **官方订阅只读**:Codex 的 `~/.codex/auth.json`、`~/.codex/config.toml` 永远只读合并——「应用」只会手术式插入 `codex-switch` 自己的两段配置,**官方模型列表与其余配置绝对不覆盖**,且每次应用前自动备份到 `~/.codex-switch/backups/`,页面上一键还原。

## 工作原理(一张图)

```
Codex  ──▶  http://127.0.0.1:8787/v1  ──▶  codex-switch
                (唯一的 model_provider)          │  读 body.model 查路由表
                                                 ├─▶ gpt-5.6 ──▶ chatgpt.com(Codex OAuth 原样转发)
                                                 └─▶ qwen3.8-max ──▶ 阿里云百炼(Bearer 注入)
```

Codex 侧只需两行配置(配置页「应用并备份」自动写入 `~/.codex/`):

```toml
model_catalog_json = "~/.codex/catalog.json"
[model_providers.codexswitch]
name = "codex-switch"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = true
```

## 许可

MIT
