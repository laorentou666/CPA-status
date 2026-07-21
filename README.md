# CPA Status

面向 CLIProxyAPI 的独立账号监测服务。后台调度器随进程启动，不依赖浏览器页面；SSE 只用于把后台已经同步并写入 SQLite 的结果实时推送到前端。

已按以下版本接口实现和测试：

- CLI Proxy API Management Center `v1.18.5`
- CLIProxyAPI `v7.2.29`
- Management API：`GET /v0/management/auth-files`、`POST /v0/management/api-call`

## 功能

- 定时同步 CPA 账号数量、运行状态、成功/失败计数和最近请求健康度。
- Codex：5 小时/周等额度窗口、计划、Credits 余额和重置时间。
- Claude：5 小时、7 天、模型级和 scoped limits。
- Kimi：Coding usage 与 limits。
- Antigravity：Quota Summary 与 Available Models 配额。
- xAI/Grok：CLI billing 周/月数据；付费 API OAuth 在 billing 不可用时退回只读身份检查。
- Gemini、AI Studio、Vertex、API Key 和未知 Provider：持续监测 CPA 状态和请求表现，但不虚构不存在的统一余额接口。
- Telegram 与 PushPlus 可同时启用，通知模块可继续扩展。
- 状态变化、额度耗尽、账号移除、CPA 失联与恢复告警。
- SQLite 历史记录、SSE 页面更新、可选管理密码。

## 本地运行

需要 Node.js `22.5+`，项目没有第三方运行时依赖。

```bash
cp .env.example .env
```

本项目不自动加载 `.env`。本地运行前请在 shell 中设置环境变量，或使用 Docker Compose 的 `.env` 注入：

```bash
npm start
```

默认访问：`http://127.0.0.1:8080`

## 必需配置

| 变量 | 说明 |
| --- | --- |
| `CPA_MANAGEMENT_URL` | CPA 管理 API 地址，例如 `https://cpa.example.com/v0/management`。只填写站点根地址时也会自动补全路径。 |
| `CPA_MANAGEMENT_KEY` | CLIProxyAPI Management Key。仅保存在后端环境变量中。 |
| `APP_ADMIN_PASSWORD` | 页面管理密码。公网部署时必须设置。 |

主要可选项见 [.env.example](.env.example)。

## 通知

同时启用 Telegram 与 PushPlus：

```env
NOTIFY_CHANNELS=telegram,pushplus
TELEGRAM_BOT_TOKEN=123456:token
TELEGRAM_CHAT_IDS=10001,10002
PUSHPLUS_TOKEN=pushplus-token
```

通知默认发送 `warning`、`critical`，并始终发送账号和 CPA 恢复事件。若还要发送账号增加等普通信息事件，可设置：

```env
NOTIFY_MIN_SEVERITY=info
```

## 测试

```bash
npm test
npm run smoke
```

Smoke test 会启动一个模拟 CLIProxyAPI 和真实 CPA Status HTTP 服务，等待后台调度器在没有浏览器连接的情况下完成账号及 Codex 额度同步，然后验证：

- `/api/health`
- `/api/dashboard`
- 管理页面静态资源
- 手动刷新接口
- SQLite 中的账号和额度结果

## Docker

```bash
docker compose up -d --build
```

SQLite 数据保存在 Docker 命名卷 `cpa-status-data` 中。容器启动时会检查并修正数据目录权限，然后以非 root UID/GID 运行服务。容器使用 Node.js 22 内置 SQLite，不需要额外数据库服务。

若自行使用宿主机绑定目录，例如 `-v /opt/cpa-status/data:/data`，启动器也会尝试将目录调整为 `DATA_UID`/`DATA_GID`，默认均为 `1000`。受限文件系统不允许 `chown` 时，可在宿主机执行：

```bash
sudo mkdir -p /opt/cpa-status/data
sudo chown -R 1000:1000 /opt/cpa-status/data
```

遇到旧容器反复输出 `unable to open database file` 时，重新构建并创建容器：

```bash
docker compose down
docker compose up -d --build
```

## 安全边界

- 前端和 API 不返回 Management Key、OAuth Token 或认证文件内容。
- Provider 查询只能通过代码中的 HTTPS 域名白名单，未暴露通用 `/api-call` 转发接口。
- 对没有可靠只读额度接口的 Provider，仅使用 CPA 状态和请求数据，不发送模型推理请求。
- 公网部署应设置 `APP_ADMIN_PASSWORD`，并由反向代理提供 HTTPS。

## Provider 数据来源

- CLIProxyAPI Management API：<https://help.router-for.me/management/api>
- CLIProxyAPI：<https://github.com/router-for-me/CLIProxyAPI>
- CPA Manager Plus：<https://github.com/seakee/CPA-Manager-Plus>
- Telegram Bot API：<https://core.telegram.org/bots/api>
- PushPlus：<https://www.pushplus.plus/doc/>
