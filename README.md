# CPA Status

面向 CLIProxyAPI 的独立账号监测服务。后台调度器随进程启动，不依赖浏览器页面；SSE 只负责把已经同步并写入 SQLite 的结果实时推送到前端。

已按以下版本接口实现和测试：

- CLI Proxy API Management Center `v1.18.5`
- CLIProxyAPI `v7.2.29`
- Management API：账号读取/上传/删除、Codex OAuth、OAuth 状态查询、`POST /v0/management/api-call`

## 功能

- 定时同步 CPA 账号数量、状态、成功/失败计数和最近请求健康度。
- Codex、Claude、Kimi、Antigravity、xAI/Grok 主动额度查询。
- Gemini、AI Studio、Vertex、API Key 和未知 Provider 持续监测 CPA 状态和请求表现，但不虚构不存在的统一余额接口。
- Telegram、PushPlus、Server酱通知，可同时启用。
- 状态变化、额度耗尽、账号移除、CPA 失联与恢复告警。
- SQLite 历史记录和 SSE 页面更新。
- `.env` 自动加载及热更新，大部分参数修改后不需要重启容器。
- 游客页与管理员页分离，监控和账号管理合并在同一张账号表中。
- 游客和管理员都可以通过 Codex OAuth 或 JSON 文件添加账号，游客不能删除账号或覆盖同名认证文件。
- OAuth、上传和登录接口内置按客户端/IP 的频率限制、请求体限制与并发保护。

## 页面权限

| 地址 | 权限 | 功能 |
| --- | --- | --- |
| `http://127.0.0.1:8080/` | 游客 | 查看监控数据，通过 Codex OAuth 或 JSON 文件新增账号；不能删除账号或覆盖同名认证文件 |
| `http://127.0.0.1:8080/admin` | 管理员 | 游客页全部内容，以及立即同步、通知测试、上传覆盖、单个/批量删除账号 |

游客只放行受限的 OAuth 和认证文件新增 API，其他修改类 API 都要求管理员会话。公网部署必须设置：

```env
APP_ADMIN_PASSWORD=replace-with-a-strong-password
```

未设置管理密码时，管理员页不要求登录，仅适合可信内网或本机使用。

## 本地运行

需要 Node.js `22.5+`，项目没有第三方运行时依赖。

```bash
cp .env.example .env
npm start
```

应用会自动读取项目目录下的 `.env`。也可以用 `CONFIG_FILE` 指定其他文件：

```bash
CONFIG_FILE=/etc/cpa-status.env npm start
```

## 必需配置

| 变量 | 说明 |
| --- | --- |
| `CPA_MANAGEMENT_URL` | CPA 管理 API 地址，例如 `https://cpa.example.com/v0/management`。只填写站点根地址时会自动补全路径。 |
| `CPA_MANAGEMENT_KEY` | CLIProxyAPI Management Key。只在后端使用，不会返回网页。 |
| `APP_ADMIN_PASSWORD` | 管理员页密码。公网部署时必须设置。 |

完整配置见 [.env.example](.env.example)。

## 配置热更新

程序每秒检查一次 `.env`。文件发生变化时，先完整解析和校验，再一次性应用新配置。配置格式错误时会保留上一份有效配置，并在日志中说明原因。

以下配置支持热更新：

- `CPA_MANAGEMENT_URL`、`CPA_MANAGEMENT_KEY`
- `ACCOUNT_SYNC_INTERVAL_SECONDS`、`QUOTA_SYNC_INTERVAL_SECONDS`
- `QUOTA_CONCURRENCY`、`QUOTA_WARNING_PERCENT`
- `REQUEST_TIMEOUT_SECONDS`、`HISTORY_RETENTION_DAYS`
- `APP_ADMIN_PASSWORD`、`SESSION_TTL_HOURS`
- OAuth、上传、登录限流与上传大小限制
- 全部通知渠道、通知事件列表和通知凭证

具体行为：

- CPA 地址或 Key 变化后会更新客户端并立即触发一次同步。
- 同步周期变化后会重新安排定时器，不会重启进程。
- 管理密码或会话时长变化后，已有管理员会话会失效，需要重新登录。
- 通知配置变化后，渠道状态和测试按钮会实时更新。
- 多个已打开页面会通过 SSE 收到配置变化。

以下启动参数不能热更新：`HOST`、`PORT`、`DATABASE_PATH`。修改后日志会提示需要重启。端口还受到 Docker 端口映射限制，数据库路径则涉及正在使用的 SQLite 连接。

显式设置的进程环境变量优先于 `.env`。因此若通过 `docker run -e` 或 shell 导出了同名变量，该变量不会被 `.env` 覆盖，也无法通过修改文件热更新。仓库提供的 Docker Compose 已改为直接挂载 `.env`，不会重复注入这些运行参数。

## 通知配置

### 基本规则

`NOTIFY_CHANNELS` 决定启用哪些渠道，多个渠道使用英文逗号分隔：

```env
NOTIFY_CHANNELS=telegram,pushplus,serverchan
```

通知不再使用 `info`、`warning`、`critical` 等等级过滤。`NOTIFY_EVENTS` 直接指定允许发送的事件，多个事件使用英文逗号分隔；设置为 `all` 会发送全部事件，设置为 `none` 或留空会关闭所有自动事件通知。通知测试不受该列表限制。

```env
NOTIFY_EVENTS=account_auth_invalid,account_disabled,account_quota_exhausted,cpa_unreachable
```

未配置 `NOTIFY_EVENTS` 时会使用兼容默认值：明确认证/封禁/额度异常、明确异常恢复、账号移除、启动异常快照、CPA 失联/恢复及删除失败。`.env.example` 已显式列出这个默认集合。

| 事件键 | 触发条件 |
| --- | --- |
| `account_auth_invalid` | HTTP 401 或结构化错误明确表示认证失效 |
| `account_disabled` | 响应明确表示账号、团队或服务被禁用/封禁 |
| `account_quota_exhausted` | 额度达到 100% 或 Provider 明确报告额度耗尽 |
| `account_rate_limited` | 上游返回 HTTP 429 |
| `account_unavailable` | CPA 将账号标记为不可用 |
| `account_warning` | 最近请求失败率进入警告状态 |
| `account_unknown` | 账号状态变为未知 |
| `account_healthy` | 普通未知、不可用或警告状态恢复正常 |
| `account_recovered` | 认证失效、禁用、额度耗尽或限流恢复正常 |
| `account_removed` | 单个账号从 CPA `/auth-files` 列表消失 |
| `account_count_increased` / `account_count_decreased` | CPA 账号数量增加/减少 |
| `initial_unhealthy_accounts` | 启动检查发现明确异常账号 |
| `cpa_unreachable` / `cpa_recovered` | CPA 管理接口失联/恢复 |
| `account_deleted` | 主动删除账号成功 |
| `account_delete_partial` / `account_delete_failed` | 主动删除部分失败/完全失败 |

额度检查只会把明确的认证、停用和额度错误升级为账号异常。`context canceled`、超时、连接重置、CPA HTTP 502、上游 408/500/502/503/504、普通 403、空响应和非法 JSON 都按临时探测失败处理：保留上一次账号状态，仅记录检查错误，不生成账号状态变化通知。兼容默认事件集合不包含普通 `account_unavailable`、`account_unknown`、`account_warning` 和账号数量增加；需要这些通知时可自行加入 `NOTIFY_EVENTS`。

CLIProxyAPI v7.2.29 的 `/api-call` 使用 HTTP 200 包装真实上游状态，实际状态位于响应的 `status_code` 字段。项目不会把所有 403 视为认证失效；只有 401、结构化 `account_deactivated`/`unauthorized`/`invalid_grant` 等错误，或响应明确包含账号停用/服务禁用信息时，才会判定账号异常。429 按 CLIProxyAPI 语义记录为额度耗尽/限流。

### 多接收人和多凭证

三个通知渠道都支持多个凭证。第一个凭证继续使用原变量名，更多凭证添加相同数字后缀，例如 `_2`、`_3`。修改后同样支持热加载。

页面会显示每个渠道当前有效的目标数量。管理员页的“测试”按钮会向该渠道配置的全部接收目标发送测试消息。只要其中一个目标发送失败，该渠道测试会显示失败，但其他成功目标仍可能已经收到消息。

### Telegram

```env
NOTIFY_CHANNELS=telegram
TELEGRAM_BOT_TOKEN=123456:bot-token
TELEGRAM_CHAT_IDS=10001,10002

TELEGRAM_BOT_TOKEN_2=654321:another-bot-token
TELEGRAM_CHAT_IDS_2=20001,20002
```

- `TELEGRAM_BOT_TOKEN`：从 [@BotFather](https://t.me/BotFather) 创建机器人后获得。
- `TELEGRAM_CHAT_IDS`：接收人的 Chat ID，多个 ID 使用英文逗号分隔。
- 同一个机器人推给多人时，只需在同一个 `TELEGRAM_CHAT_IDS` 中填写多个 ID。
- 使用多个机器人时，Token 和 Chat ID 必须使用相同后缀配对，例如 `TELEGRAM_BOT_TOKEN_2` 对应 `TELEGRAM_CHAT_IDS_2`。
- 发送接口采用 Telegram 官方 `sendMessage`，同一事件会发送给全部已配置目标。

官方文档：<https://core.telegram.org/bots/api#sendmessage>

### PushPlus

```env
NOTIFY_CHANNELS=pushplus
PUSHPLUS_TOKEN=your-token
PUSHPLUS_TOPIC=
PUSHPLUS_CHANNEL=wechat

PUSHPLUS_TOKEN_2=another-token
PUSHPLUS_TOPIC_2=
PUSHPLUS_CHANNEL_2=wechat
```

- `PUSHPLUS_TOKEN`：PushPlus 用户 Token。
- `PUSHPLUS_TOPIC`：群组编码，可选；留空时发送给 Token 所属用户。
- `PUSHPLUS_CHANNEL`：发送渠道，默认 `wechat`。
- 更多用户使用 `PUSHPLUS_TOKEN_2`、`PUSHPLUS_TOKEN_3`，对应的 Topic 和 Channel 使用相同后缀。
- 消息使用官方 `/send` 接口和 `html` 模板。

官方文档：<https://www.pushplus.plus/doc/>

### Server酱

```env
NOTIFY_CHANNELS=serverchan
SERVERCHAN_SENDKEY=SCTxxxxxxxx
SERVERCHAN_SENDKEY_2=sctp123tyyyyyyyy
```

`SERVERCHAN_SENDKEY` 支持两种官方格式：

- Server酱 Turbo：以 `SCT` 开头，调用 `https://sctapi.ftqq.com/{SendKey}.send`。
- Server酱³：格式为 `sctp{uid}t...`，调用 `https://{uid}.push.ft07.com/send/{SendKey}.send`。
- 更多接收人使用 `SERVERCHAN_SENDKEY_2`、`SERVERCHAN_SENDKEY_3`，Turbo 和 Server酱³ Key 可以混合配置。

请求使用官方文档规定的 `title` 和 Markdown `desp` 参数，只有返回 JSON 的 `code` 为 `0` 才记录为发送成功。SendKey 不会写入日志或返回前端。

官方文档：

- Node.js 接入：<https://sct.ftqq.com/docs/integrations/nodejs/>
- SendKey 格式与获取：<https://sct.ftqq.com/docs/getting-started/sendkey/>
- 额度与排查：<https://sct.ftqq.com/docs/getting-started/faq/>

### 同时启用多个渠道

```env
NOTIFY_CHANNELS=telegram,pushplus,serverchan
NOTIFY_EVENTS=account_auth_invalid,account_disabled,account_quota_exhausted,cpa_unreachable

TELEGRAM_BOT_TOKEN=123456:bot-token
TELEGRAM_CHAT_IDS=10001,10002
TELEGRAM_BOT_TOKEN_2=654321:another-bot-token
TELEGRAM_CHAT_IDS_2=20001

PUSHPLUS_TOKEN=your-token
PUSHPLUS_TOPIC=
PUSHPLUS_CHANNEL=wechat
PUSHPLUS_TOKEN_2=another-token
PUSHPLUS_TOPIC_2=
PUSHPLUS_CHANNEL_2=wechat

SERVERCHAN_SENDKEY=SCTxxxxxxxx
SERVERCHAN_SENDKEY_2=sctp123tyyyyyyyy
```

修改并保存 `.env` 后无需重启。进入 `/admin`，可在“通知渠道”区域分别发送测试消息。

## Codex OAuth 与认证文件上传

游客页和管理员页的“添加账号”入口支持两种方式：

- Codex OAuth：由 CPA 生成授权链接。远程浏览器授权完成后，把浏览器地址栏中的完整回调 URL 粘贴回来；CPA 负责校验 state、交换 Token 并保存认证文件。
- JSON 上传：只接受扩展名为 `.json`、顶层为 JSON 对象的认证文件。文件内容只在内存中校验并转发给 CPA，不写入本项目的 SQLite，也不会返回到前端。

游客上传前会重新读取 CPA 认证文件列表并阻止同名覆盖。管理员会话允许上传替换已有文件。OAuth 完成或文件上传成功后，监控服务会立即重新同步账号列表。

默认保护参数如下，均支持 `.env` 热更新：

| 变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `APP_TRUST_PROXY` | `false` | 仅在可信反向代理覆盖客户端来源地址时设为 `true` |
| `OAUTH_START_RATE_LIMIT` | `3` | 每个限流窗口允许发起的 OAuth 次数 |
| `OAUTH_CALLBACK_RATE_LIMIT` | `6` | 每个限流窗口允许提交的回调次数 |
| `OAUTH_STATUS_RATE_LIMIT` | `180` | 每个限流窗口允许查询的 OAuth 状态次数 |
| `OAUTH_RATE_LIMIT_WINDOW_SECONDS` | `600` | OAuth 限流窗口秒数 |
| `OAUTH_MAX_ACTIVE_FLOWS` | `8` | 当前进程允许同时存在的 OAuth 流程总数 |
| `OAUTH_MAX_ACTIVE_FLOWS_PER_CLIENT` | `2` | 单个客户端允许同时存在的 OAuth 流程数 |
| `OAUTH_STATUS_MIN_INTERVAL_SECONDS` | `2` | 同一流程向 CPA 查询状态的最短间隔 |
| `UPLOAD_RATE_LIMIT` | `5` | 每个上传限流窗口允许的请求数 |
| `UPLOAD_RATE_LIMIT_WINDOW_SECONDS` | `600` | 上传限流窗口秒数 |
| `UPLOAD_MAX_FILE_BYTES` | `1048576` | 单个 JSON 文件最大字节数 |
| `UPLOAD_MAX_REQUEST_BYTES` | `5242880` | 单次 multipart 请求最大字节数 |
| `UPLOAD_MAX_FILES` | `5` | 单次最大文件数 |
| `LOGIN_RATE_LIMIT` | `10` | 每个登录限流窗口允许的尝试次数 |
| `LOGIN_RATE_LIMIT_WINDOW_SECONDS` | `900` | 登录限流窗口秒数 |

频率超限返回 HTTP `429` 和 `Retry-After`。限流状态保存在当前进程内，适用于本项目默认的单实例部署。

## 账号删除

账号删除调用 CLIProxyAPI `v7.2.29` 提供的 `DELETE /v0/management/auth-files`，批量请求体使用 `{ "names": [...] }`。CPA 删除成功后，监控服务会立即重新读取 `/auth-files`，不会只删除本地 SQLite 数据。

`runtime_only=true` 或 `source=memory` 的凭据没有磁盘认证文件，CLIProxyAPI 不支持通过该端点删除，因此管理员页会禁用操作。批量“异常账号”只包含 `auth_invalid` 与 `unavailable`，不会自动删除临时额度耗尽、警告或人工禁用账号。

## Docker

首次部署或升级到支持热加载的版本时，需要重新构建一次：

```bash
cp .env.example .env
docker compose up -d --build
```

Compose 会把宿主机 `.env` 只读挂载到容器 `/app/.env`。此后修改宿主机 `.env` 即可热更新，不需要反复执行 `docker compose down/up`。

SQLite 数据保存在命名卷 `cpa-status-data`。容器启动时会检查数据目录权限，然后以非 root UID/GID 运行。若使用宿主机绑定目录，请保证容器用户对目录可读写。

## 测试

```bash
npm test
npm run smoke
```

测试覆盖配置文件监听、热更新应用、游客/管理员权限、Codex OAuth、认证文件上传、覆盖保护、请求限流、账号删除、Provider 解析和三种通知渠道。Smoke test 会启动模拟 CLIProxyAPI 与真实 CPA Status HTTP 服务，验证后台调度、SQLite、页面、删除和手动同步接口。

## 安全边界

- 前端和 API 不返回 Management Key、OAuth Token、SendKey 或认证文件内容。
- 游客只能调用绑定匿名客户端会话并经过限流的 OAuth/上传新增接口；删除、同步、通知测试等修改操作仍要求管理员会话。
- 前端只使用随机 flow ID 关联流程，不单独提交 CPA state；state 仅随 CPA 生成的授权链接出现，回调 URL 不写入日志或数据库。
- JSON 上传限制文件名、数量、单文件大小、总请求大小和 JSON 结构，游客不能覆盖同名认证文件。
- Provider 查询只能访问代码中的 HTTPS 域名白名单，不暴露通用 `/api-call` 转发接口。
- 对没有可靠只读额度接口的 Provider，只使用 CPA 状态和请求数据，不发送模型推理请求。
- 公网部署应设置 `APP_ADMIN_PASSWORD`，并由反向代理提供 HTTPS。

## 数据与接口来源

- CLIProxyAPI Management API：<https://help.router-for.me/management/api>
- CLIProxyAPI：<https://github.com/router-for-me/CLIProxyAPI>
- CPA Manager Plus：<https://github.com/seakee/CPA-Manager-Plus>
- Telegram Bot API：<https://core.telegram.org/bots/api>
- PushPlus：<https://www.pushplus.plus/doc/>
- Server酱：<https://sct.ftqq.com/docs/>
