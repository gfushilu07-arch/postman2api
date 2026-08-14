> **仅供学习研究使用。** 本项目按现状提供，仅用于研究和教育目的。请只连接你本人拥有或已获授权使用的 Postman 账号，并妥善保管密码、会话 Token 与 API Key。使用自动化注册或试用功能前，请自行确认符合相关服务条款和适用政策。

# postman2api

`postman2api` 是一个基于 Bun 的自托管服务，将 Postman AI 对话能力转换为 OpenAI 兼容和 Anthropic 兼容 API，并提供本地管理面板、账号池、会话路由、故障转移和流式响应。

仓库同时包含 `packages/postman-register`：一个基于 Camoufox/Playwright 的 Postman 账号注册与 Token 导出工具。本 README 集中说明主服务和注册工具的安装、配置与使用方式；仓库内不再维护其他 README。

## 目录

- [功能特性](#功能特性)
- [环境要求](#环境要求)
- [主服务：快速开始](#主服务快速开始)
- [主服务：连接账号](#主服务连接账号)
- [主服务：API 使用](#主服务api-使用)
- [主服务：配置](#主服务配置)
- [注册工具：使用方式](#注册工具使用方式)
- [开发与验证](#开发与验证)
- [项目结构](#项目结构)
- [相关文档](#相关文档)

## 功能特性

### 主服务

- OpenAI 兼容的 `POST /v1/chat/completions`
- Anthropic 兼容的 `POST /v1/messages`
- OpenAI 风格的 `GET /v1/models` 模型发现
- Postman 账号的浏览器登录与 JSON 导入
- 多账号池、会话粘性和最少在途请求路由
- 额度耗尽、限流和上游故障时的账号切换
- 额度安全流式输出、SQLite 状态存储和 WebSocket 面板更新

### 注册工具

- 使用临时邮箱完成 Postman 注册和邮箱验证
- 自动完成资料、团队、Enterprise 试用和 Postman AI 引导
- 支持有界面、无界面、单次和批量运行
- 将账号信息及会话 Token 导出为可供主服务导入的 JSON
- 支持代理、GeoIP 同步、固定密码和自定义输出目录

## 环境要求

- [Bun](https://bun.sh/)
- Node.js 22 或更高版本（Camoufox 运行时需要）
- 浏览器登录或有界面注册时需要桌面显示环境
- 可访问 Postman；注册工具还需要访问 temp-mail.org 及相关验证服务

根目录执行 `bun install` 时，`postinstall` 会安装 Camoufox。首次下载浏览器运行时可能需要较长时间。

## 主服务：快速开始

### 1. 安装依赖

```bash
bun install
cd dashboard
bun install
cd ..
```

如需跳过构建环境中的浏览器下载：

```bash
CAMOUFOX_SKIP_BROWSER_DOWNLOAD=1 bun install
```

之后可在需要浏览器登录时补充安装：

```bash
bun run browser:camoufox:fetch
```

### 2. 创建配置

```bash
cp .env.example .env
```

至少需要修改：

- `API_KEY`：访问 `/v1/*` API 使用的密钥。
- `ENCRYPTION_KEY`：加密本地账号敏感信息的强随机密钥。

不要将 `.env`、账号 Token 或数据库文件提交到版本库，也不要把管理面板直接暴露到不受信任的网络。

### 3. 构建并启动

正式运行使用 `PORT`（默认 `1930`），只读取已经构建好的 `dashboard/dist`：

```bash
bun run build
bun run migrate
bun start
```

默认地址：

| 用途 | URL |
| --- | --- |
| 管理面板 | `http://localhost:1930/` |
| 健康检查 | `http://localhost:1930/health` |
| 模型列表 | `http://localhost:1930/v1/models` |
| OpenAI 聊天补全 | `http://localhost:1930/v1/chat/completions` |
| Anthropic 消息 | `http://localhost:1930/v1/messages` |

### 开发模式

开发模式和正式运行使用不同端口，避免开发时占用或修改正式运行的面板：

```bash
bun run dev
```

开发模式会同时启动：

- 开发面板：`http://localhost:1931/`（Vite，不会写入 `dashboard/dist`）
- 开发 API：`http://localhost:1932/`
- 正式运行：`http://localhost:1930/`，由构建后的 `dashboard/dist` 提供

修改前端代码后直接访问 `1931` 查看效果；需要测试正式版本时执行 `bun run build && bun start`，访问 `1930`。

## 主服务：连接账号

主服务至少需要一个可用的 Postman 账号才能处理聊天请求。

### 方法一：浏览器登录已有账号，不推荐

1. 打开管理面板并进入账号页面。
2. 输入已有账号邮箱，选择登录流程。
3. 点击 **打开登录浏览器**。
4. 在可见浏览器窗口中完成登录，并保持窗口打开，直到服务完成会话与工作区信息采集。

服务不会读取或保存账号密码。该方式用于登录已有账号，不负责完成注册引导。

### 方法二：通过 JSON 导入账号

管理面板支持导入单个账号或带版本号的批量账号对象：

```json
{
  "version": 1,
  "accounts": [
    {
      "email": "name@example.com",
      "enabled": true,
      "tokens": {
        "postman_sid": "SESSION_VALUE",
        "user_id": "USER_ID",
        "workspace_id": "WORKSPACE_ID",
        "workspace_subdomain": "TEAM_SUBDOMAIN"
      }
    }
  ]
}
```

邮箱相同的已有记录会被更新。字段获取方式见 [Postman 账号 Token 获取与 JSON 导入](docs/postman-account-token.md)。也可以使用本仓库的 [`packages/postman-register`](#注册工具使用方式) 生成导入文件。

`postman_sid` 等同账号凭据，禁止写入日志、分享给他人或提交到版本库。

## 主服务：API 使用

所有 `/v1/*` 接口都需要面板设置中配置的 Key 或 `.env` 中的 `API_KEY`。OpenAI 兼容接口使用 `Authorization: Bearer ...`；Anthropic 兼容接口也接受 `x-api-key`。

### OpenAI 兼容聊天

```bash
curl http://localhost:1930/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Anthropic 兼容消息

```bash
curl http://localhost:1930/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

Anthropic 模型别名会尽可能归一化，例如 `claude-sonnet-4-20250514` 会映射为 `claude-sonnet-4-5`。

### 模型列表

```bash
curl http://localhost:1930/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

可用模型最终取决于所连接的 Postman 账号与工作区，请以 `/v1/models` 的实时返回结果为准。

### 会话与负载均衡

账号池使用最少在途请求策略。稳定的会话标识会让同一段对话尽量固定到同一个 Postman 账号，从而保留上游对话状态。

- OpenAI/Codex 客户端：请求体使用 `session_id`，或发送 `x-session-id` 请求头。
- Anthropic 兼容客户端：使用原生会话元数据或会话请求头。
- 其他客户端：为每段独立对话发送唯一的 `x-session-id`。

不要为所有终端用户复用同一个会话 ID。没有可识别会话标识的请求会按请求均衡分配。

账号被限流时，服务会根据上游 `Retry-After` 进入账号级冷却，并尝试其他可用账号。额度安全流式响应会先缓冲上游输出；如果流中途报告额度耗尽，服务会在内容到达客户端前丢弃不完整结果并切换账号重试。

## 主服务：配置

复制根目录 `.env.example` 为 `.env` 后按需修改：

| 变量 | 示例/默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `1930` | HTTP 服务与管理面板端口。 |
| `DASHBOARD_PORT` | `1931` | 开发面板端口；生产资源由 `PORT` 提供。 |
| `DEV_API_PORT` | `1932` | 开发模式后端 API 端口，与正式运行的 `PORT` 分离。 |
| `API_KEY` | 示例值 | `/v1/*` 接口鉴权密钥。 |
| `ENCRYPTION_KEY` | 示例值 | 敏感账号信息加密密钥，必须替换为强随机值。 |
| `DATABASE_PATH` | `./data/postman2api.db` | SQLite 数据库路径。 |
| `TTFB_TIMEOUT_MS` | `45000` | 等待上游响应头的最长时间。 |
| `STREAM_READ_TIMEOUT_MS` | `300000` | 流式响应分块之间的最大空闲时间。 |
| `PROVIDER_REQUEST_TIMEOUT_MS` | `120000` | 未单独设置首包超时时的提供商请求兜底超时。 |
| `QUOTA_SAFE_STREAM_BUFFER_BYTES` | `16777216` | 额度安全流式响应的最大缓冲字节数。 |
| `STREAM_KEEPALIVE_INTERVAL_MS` | `10000` | 缓冲或重试期间发送 SSE 注释心跳的间隔。 |
| `POSTMAN_FETCH_VERBOSE` | `false` | 输出不含鉴权头和正文的 Postman 请求生命周期日志。 |
| `BATCHER_PROXY_URL` | 未设置 | 主服务浏览器自动化使用的可选代理。 |
| `LOGIN_BROWSER_BACKEND` | `camoufox` | 登录后端，可选 `camoufox` 或 `playwright`。 |

管理面板中的设置会存储在 SQLite 中，并覆盖对应环境变量的默认值。

如需使用 Playwright Chromium 登录：

```bash
bunx playwright install chromium
LOGIN_BROWSER_BACKEND=playwright bun start
```

浏览器后端选择是显式的：Camoufox 不可用时不会自动切换到 Playwright。

## 注册工具：使用方式

`packages/postman-register` 是独立的 Bun 包。它会通过浏览器自动完成临时邮箱获取、Postman 注册、邮箱验证、资料与团队引导、Enterprise 试用、Postman AI 启用，最后导出账号和会话 Token。

> **稳定性说明**
>
> 该流程依赖第三方线上页面、Cloudflare 校验和浏览器行为，页面改版、网络延迟、验证码超时或浏览器断连都可能导致失败。批量模式会尽量记录失败并继续后续轮次，但不能保证完成全部轮数。欢迎针对 `packages/postman-register/src/selectors/` 和流程编排提交修复。

### 1. 安装

从仓库根目录执行：

```bash
cd packages/postman-register
bun install
bunx camoufox-js fetch
```

如果根目录已经安装过 Camoufox，通常无需重复执行 `fetch`。

### 2. 创建配置

```bash
cp .env.example .env
```

Bun 会自动读取当前目录的 `.env`，无需额外安装 `dotenv`。默认配置可以直接运行；需要代理、批量注册或固定密码时再修改。

### 3. 运行

有界面单次注册，适合首次运行和排错：

```bash
bun run start
```

无界面运行：

```bash
bun run start:headless
```

无界面模式不利于观察或处理 Cloudflare 人机校验，首次排错建议使用有界面模式。

批量运行：

```bash
bun run start --count 5
```

`--count` 的优先级高于 `.env` 中的 `POSTMAN_COUNT`。每轮使用新的 BrowserContext、新邮箱和密码；单轮失败时批量任务会尽量继续下一轮。如果任意轮次失败，进程最终退出码为 `1`。

不访问外部网站的本地演示：

```bash
bun run start:demo
```

类型检查：

```bash
bun run typecheck
```

### 注册工具配置

| 变量/参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--count N` | `1` | 当前命令的注册轮数，优先级最高。 |
| `POSTMAN_COUNT` | `1` | 未传 `--count` 时使用的注册轮数。 |
| `POSTMAN_PASSWORD` | 每轮随机生成 | 固定注册密码；留空时每个账号生成独立的 12 位密码。 |
| `POSTMAN_TOKENS_DIR` | `tokens` | Token JSON 输出目录，支持绝对路径或相对当前目录的路径。 |
| `POSTMAN_CF_TIMEOUT` | `600000` | Cloudflare 校验总等待时间，单位毫秒。 |
| `POSTMAN_PROXY` | 未设置 | 浏览器代理，支持 HTTP、HTTPS 和 SOCKS5，可包含用户名与密码。 |
| `POSTMAN_GEOIP` | `0` | 设为 `1` 时通过代理同步出口 IP、WebRTC 和地理位置；仅在设置代理时有意义。 |
| `--headless` | 关闭 | 使用无界面浏览器；`start:headless` 已包含该参数。 |

示例：通过代理注册三个账号，并将 Token 写入指定目录：

```bash
POSTMAN_PROXY='http://user:pass@host:port' \
POSTMAN_GEOIP=1 \
POSTMAN_TOKENS_DIR='./private-tokens' \
bun run start --count 3
```

不要将真实代理凭据、固定密码或 Token 写入 Git 已跟踪文件。

### 注册流程与输出

一次成功运行依次完成：

1. 从 temp-mail.org 获取临时邮箱。
2. 填写 Postman 注册信息并等待 Cloudflare 校验。
3. 读取六位邮件验证码并完成验证。
4. 完善个人资料和 AI 引导。
5. 开通 Enterprise 试用并进入团队设置。
6. 启用 Postman AI。
7. 收集登录会话并保存账号 Token。

每个成功账号默认生成一个文件：

```text
packages/postman-register/tokens/postman-token-YYYYMMDD-HHMMSS-SSS.json
```

文件结构：

```json
{
  "email": "name@example.com",
  "password": "GENERATED_PASSWORD",
  "tokens": {
    "postman_sid": "...",
    "user_id": "...",
    "workspace_id": "...",
    "workspace_subdomain": "team-subdomain"
  }
}
```

该文件可直接用于主服务管理面板的账号导入。文件同时包含密码和会话 Token，应视作敏感凭据；导入后请妥善保存或删除。

### 注册工具常见问题

| 现象 | 建议处理 |
| --- | --- |
| Cloudflare 校验超时 | 使用有界面模式检查挑战页，确认网络与浏览器运行时正常；必要时增大 `POSTMAN_CF_TIMEOUT`。 |
| 未收到验证码邮件 | 脚本会自动轮询；超时后稍后使用新邮箱重试，并检查临时邮箱页面是否被拦截。 |
| 提示“创建了太多的邮箱” | 这是出口 IP 限流，可配置 `POSTMAN_PROXY` 更换出口，或等待限流窗口结束。 |
| 页面元素找不到 | 第三方页面可能已改版，更新 `packages/postman-register/src/selectors/` 中的候选定位器。 |
| Token 字段不完整 | 使用有界面单次模式，确认流程已进入 Postman 工作区并保持登录。 |
| Camoufox 无法启动 | 重新执行 `bunx camoufox-js fetch`，并确认环境支持当前浏览器模式。 |

每次运行都从头开始，不支持从失败阶段断点续跑。单次模式失败时会输出失败阶段与标签页 URL，并保持浏览器打开供排查；按 `Ctrl+C` 后脚本会关闭浏览器退出。

## 开发与验证

主服务命令均在仓库根目录执行：

```bash
# 启动开发面板和开发 API（面板 1931，API 1932）
bun run dev

# 仅启动开发 API
bun run dev:api

# 仅启动开发面板
bun run dev:dashboard

# 构建管理面板（正式运行使用 1930）
bun run build

# 执行数据库迁移
bun run migrate

# TypeScript 检查
bun run typecheck

# 运行测试
bun test

# 仅运行流式取消测试
bun run test:stream
```

Camoufox 冒烟检查：

```bash
bun run browser:camoufox:smoke
bun run browser:camoufox:smoke:node
bun run browser:camoufox:smoke:postman
```

## 项目结构

```text
.
├── src/                         # 主服务：API、账号池、Postman Provider、数据库和 WebSocket
├── dashboard/                   # React/Vite 管理面板
├── packages/postman-register/   # Postman 注册与 Token 导出工具
│   ├── src/core/                # 浏览器、日志、等待、监测、快照和 Token 导出
│   ├── src/selectors/           # temp-mail.org 与 Postman 页面定位器
│   └── src/steps/               # 注册流程的独立自动化阶段
├── scripts/                     # Camoufox 安装与冒烟检查脚本
├── tests/                       # 主服务测试
├── docs/                        # 补充设计与操作文档
└── examples/                    # 独立示例
```

主服务技术栈为 Bun、TypeScript、Hono、Drizzle/SQLite、React/Vite，以及 Camoufox 或 Playwright。

## 相关文档

- [Postman 账号 Token 获取与 JSON 导入](docs/postman-account-token.md)
- [Postman 注册工具设计](packages/postman-register/docs/DESIGN.md)
- [Postman 账号注册技能说明](docs/postman-register-skill.md)
