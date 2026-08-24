# codex-switch

为 Codex 提供多模型路由的**极薄本地代理**:一个 Codex provider → N 个上游 provider。

核心承诺:

- **零改写**:只读请求体里的 `model` 字段做路由,请求/响应字节级原样转发(流式 SSE 也是透传)。
- **纯配置**:路由全部来自 `config.toml`,一个 provider 可挂多个模型,无数据库、无状态。
- **自带 HTML 配置页**:页面上改配置、查模型能力,**一键写入 Codex 侧配置**(改动前自动备份,支持一键还原),重启 Codex 即用。

详细设计见 [DESIGN.md](DESIGN.md)。

## 效果

Codex 的模型选择器里,**官方订阅模型**(ChatGPT 订阅)与**自有供应商模型**(阿里云百炼等)同列展示,随手切换:

![Codex 模型选择器:ChatGPT 订阅模型与阿里云百炼模型同列,一屏切换](assets/screenshot-model-picker.png)

选中哪个模型,codex-switch 就把该请求原样路由到对应上游——官方模型走 Codex OAuth 透传,自有模型注入 Bearer 认证;除认证头外,请求/响应一律字节级不改写。

## 安装

两种方式,任选其一。

### 方式一:macOS App(DMG,推荐)

适用于 Apple Silicon(arm64)的 Mac。无需 Node、无需 git,下载即用,自带开机自启。

**1)下载** — 从 [Releases](https://github.com/cnwenf/codex-switch/releases/latest) 下载最新的
`CodexSwitch-<版本>-macos-arm64.dmg`(当前为 `CodexSwitch-0.2.0-macos-arm64.dmg`,约 40 MB)。

**2)安装** — 双击挂载 `.dmg`,把 **Codex Switch** 图标拖进旁边的 `Applications` 文件夹即可。

**3)首次打开** — App 采用本地 ad-hoc 签名,且从网络下载会附带系统隔离属性,首次启动可能被
Gatekeeper 拦截。二选一:

- 在「应用程序」里 **右键(或 ⌃ 点按)Codex Switch → 打开**,在弹窗中再点一次「打开」;或
- 在终端执行一次:

  ```sh
  xattr -cr "/Applications/Codex Switch.app"
  ```

**4)使用** — 启动后服务常驻后台,并默认随**开机 / 登录自动启动**(macOS LaunchAgent)。浏览器打开配置页:

```
http://127.0.0.1:8787/
```

在页面配置供应商(名称 / URL / API-Key / 模型列表,API Key 直接填写、服务端安全存储)→ 保存 →
切到「配置历史」,在「Codex 注入配置」卡片点「**应用并备份**」→ 重启 Codex,完事。

### 方式二:源码一键安装

适合想看源码、自行改造,或需要随系统服务方式部署的场景。

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

打开页面 → 配置供应商(API Key 直接填写)→ 保存 → 「配置历史」里点「应用并备份」→ 重启 Codex,完事。

## 日常使用

配置页 `http://127.0.0.1:8787/` 是统一入口:增删供应商、填 API Key、看模型能力、开关开机自启、
「应用并备份」/「一键还原」都在页面上完成。

**App(DMG)方式** —— 服务由 macOS LaunchAgent 托管:

- 开机 / 登录自动启动(默认开启),配置页「配置历史」里可随时勾选开关(取消勾选会移除登录项);
- 停掉当前服务:`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cnwenf.codex-switch.plist`;
- 再次手动启动:直接打开「Codex Switch」App 即可;
- 升级:下载新 DMG → 拖到「应用程序」覆盖 → 重新打开 App。

**源码方式** —— 常用命令:

| 命令 | 作用 |
|---|---|
| `./install.sh` | 升级/重启(幂等,已装过的重新跑即可) |
| `npm start` / `npm stop` / `npm status` | 启动 / 停止 / 状态 |
| `open http://127.0.0.1:8787/` | 配置页 |

## 安全说明(请读)

- **本地服务**:只监听 `127.0.0.1`,不对外网开放;无远程升级、无遥测、无日志上传。
- **不改写请求**:除按 provider 配置注入/剥离认证头外,任何请求体、路径、参数、响应一律原样转发。
- **凭证不落配置**:proxy 自己的 `config.toml` 不放任何明文密钥。上游 API key 统一存 `~/.codex-switch/env`(chmod 600,已 gitignore 不进仓库,值绝不回传前端)——正常在供应商模态框的「API-Key」栏直接填写即可;如需手工维护:

  ```sh
  printf 'DASHSCOPE_API_KEY=sk-xxx\n' >> ~/.codex-switch/env && chmod 600 ~/.codex-switch/env
  ```

- **官方订阅只读**:Codex 的 `~/.codex/auth.json`、`~/.codex/config.toml` 永远只读合并——「应用」只会手术式插入 `codex-switch` 自己的两段配置,**官方模型列表与其余配置绝对不覆盖**,且每次应用前自动备份,页面上一键还原。

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
