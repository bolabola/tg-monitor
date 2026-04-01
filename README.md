# TG Monitor

Telegram 频道/群组消息监控与转发服务。通过 MTProto 用户客户端监听指定频道的新消息，经 pipeline 处理后，通过 Bot API 转发到目标频道/群组。

## 架构

采用「实时推送 + 定时拉取」双通道架构，确保不漏消息：

- **实时推送**：通过 MTProto Raw Update Handler 监听 `UpdateNewChannelMessage`，对小型/自建频道提供亚秒级延迟
- **定时拉取**：每 5s 对所有频道调用 `getMessages()`，覆盖大型公共频道不推送更新的情况
- **去重队列**：两个通道的消息统一进入 `MessageQueue`，通过 `channelId:msgId` 去重，per-channel 串行处理保证顺序
- **Gap 检测**：实时推送收到非连续消息 ID 时自动触发即时拉取
- **Bot API 限流**：令牌桶算法（全局 25/s + 单聊天 18/min），超限自动等待
- **断线恢复**：心跳检测断线后自动重连并立即触发全频道拉取

## 快速开始

```bash
# 安装依赖
npm install

# 复制配置文件
cp .env.example .env
cp channels.config.example.json channels.config.json

# 按下文指引填写 .env 和 channels.config.json

# 获取 Telegram Session
node gen-session.js

# 启动（开发）
npm run dev

# 启动（PM2 生产）
npm start
```

---

## 配置获取指南

### 1. 获取 API ID 和 API Hash

这两个值用于 MTProto 用户客户端连接 Telegram，是监听频道消息的基础。

1. 用你的 Telegram 账号登录 [https://my.telegram.org](https://my.telegram.org)
2. 点击 **API development tools**
3. 如果是首次使用，填写表单：
   - **App title**：随便填，例如 `tg-monitor`
   - **Short name**：随便填，例如 `tgmon`
   - **Platform**：选择 `Desktop`
   - **Description**：可留空
4. 提交后会看到 **App api_id** 和 **App api_hash**
5. 将它们填入 `.env`：
   ```
   TELEGRAM_API_ID=12345678
   TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890
   ```

> **注意**：API ID 和 API Hash 绑定你的 Telegram 账号，不要泄露给他人。

### 2. 获取 Session 字符串

Session 用于免交互登录 MTProto 客户端。需要通过一次性脚本生成。

1. 确保 `.env` 中已填写 `TELEGRAM_API_ID` 和 `TELEGRAM_API_HASH`

2. 运行项目自带的脚本：
   ```bash
   node gen-session.js
   ```

3. 按提示输入手机号、验证码（和两步验证密码），成功后会输出 Session 字符串

4. 将字符串填入 `.env`：
   ```
   TELEGRAM_SESSION=1BVtsOH...（很长的一串）
   ```

> **注意**：Session 字符串等同于你的账号登录凭证，务必保密。

### 3. 获取 Bot Token

Bot Token 用于通过 Bot API 将消息转发到目标频道/群组。

1. 在 Telegram 中搜索 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`，按提示设置名称和用户名
3. 创建成功后，BotFather 会返回 Token，格式如 `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`
4. 填入 `.env`：
   ```
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
   ```
5. **重要**：将 Bot 添加为目标频道/群组的管理员（需要发送消息权限）

### 4. 获取频道/群组 ID

#### 方法一：通过 @userinfobot

1. 将消息从目标频道/群组转发给 [@userinfobot](https://t.me/userinfobot)
2. Bot 会回复消息来源的 Chat ID，格式如 `-1001234567890`

#### 方法二：通过 @RawDataBot

1. 将目标频道/群组的任意消息转发给 [@RawDataBot](https://t.me/RawDataBot)
2. 在回复的 JSON 中找到 `forward_from_chat.id` 字段

#### 方法三：通过 Telegram Web

1. 用浏览器打开 [https://web.telegram.org](https://web.telegram.org)
2. 进入目标频道/群组
3. 查看地址栏 URL，格式为 `https://web.telegram.org/k/#-1001234567890`
4. `#` 后面的数字（含负号）就是 Chat ID

#### 方法四：通过 Bot API

如果你的 Bot 已在目标群组中：
```bash
# 在群里给 Bot 发条消息，然后运行：
curl "https://api.telegram.org/bot你的TOKEN/getUpdates" | jq '.result[-1].message.chat.id'
```

> **提示**：
> - 超级群组和频道的 ID 以 `-100` 开头，如 `-1001234567890`
> - 如果是论坛群组中的特定话题，还需要获取 `topicId`（在话题 URL 中可找到）

### 5. 获取 DeepSeek API Key（可选）

仅在 pipeline 中使用 `translate` 处理器时需要。

1. 注册并登录 [https://platform.deepseek.com](https://platform.deepseek.com)
2. 进入控制台 → API Keys → 创建新 Key
3. 填入 `.env`：
   ```
   DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
   ```

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TELEGRAM_BOT_TOKEN` | Bot Token，用于转发消息 | 必填 |
| `TELEGRAM_API_ID` | MTProto API ID | 必填 |
| `TELEGRAM_API_HASH` | MTProto API Hash | 必填 |
| `TELEGRAM_SESSION` | MTProto Session 字符串 | 必填 |
| `FETCH_INTERVAL_MS` | 定时拉取间隔（毫秒） | `5000` |
| `FETCH_ON_START` | 启动时是否拉取离线期间的消息 | `true` |
| `DEEPSEEK_API_KEY` | DeepSeek API Key（翻译用） | 可选 |
| `DEEPSEEK_BASE_URL` | DeepSeek API 地址 | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | DeepSeek 模型 | `deepseek-chat` |

---

## 频道配置

编辑 `channels.config.json`，参考 `channels.config.example.json`。配置文件是一个**规则数组**：每条规则写一组共享的 `to`、规则级默认的 `enabled` / `pipeline`，以及一个或多个 `source`（各源可单独覆盖 `enabled` / `pipeline`）。

### 拓扑：1 转多 / 多转 1 / 多转多

| 模式 | 写法 |
|------|------|
| **1 转多** | 单个 `source` + `to` 为**多个**目标（用数组） |
| **多转 1** | `source` 为**数组**（多个源）+ `to` 为**一个**目标对象 |
| **多转多** | `source` 数组 + `to` 数组；每个源向全部目标各发一份 |

**`source` 与 `to` 约定：**

- 监听端、目标端的**每一项**都是含 `id` 的**非数组对象**；多个源或多个目标时，对应写 **`source` 数组** 或 **`to` 数组**。**不允许**用裸 Chat ID 字符串代替 `{ "id": "..." }`。
- **`source`** 写在规则里，可为单个对象或对象数组；项上可写 `note`、`username`，以及可选的 **`enabled` / `pipeline`**（覆盖本条规则顶层的默认值）。
- **`to` 只能写在规则顶层**（整条规则共用），可为单个目标对象或目标数组；目标项上可写 `note`、`topicId`。无 `telegram` 等渠道嵌套。

多源时，**`to` 只在规则顶层写一份**，该条规则里所有 `source` 共用同一组转发目标。**`enabled`、`pipeline` 以规则顶层为公共默认**；某个源需要不同行为时，在对应的 **`source` / `source[]` 对象**里写 `enabled` 或 `pipeline`，**有则覆盖，没有则用公共的**。

### 源与目标

- **每个源 Chat ID 全局只能出现一次**（含同一条规则里的 `source` 数组也不能写重复 id）；违反则启动时报错退出。每个源展开后有**唯一**的 `enabled` / `pipeline`（规则默认 + 源上可选覆盖）。
- **同一个转发目标 `to` 可以出现多次**：多个不同源可以在各自规则里写相同的 `to`（或复制相同目标对象），互不影响。

### 示例

```json
[
    {
        "source": { "id": "-1001234567890", "note": "我的频道" },
        "pipeline": ["translate"],
        "to": [
            { "id": "-1005555555555", "topicId": "123", "note": "群话题 A" },
            { "id": "-1006666666666", "note": "备份群" }
        ]
    },
    {
        "source": [
            { "id": "-1001111111111", "note": "源 A" },
            { "id": "-1002222222222", "note": "源 B", "pipeline": [] }
        ],
        "enabled": true,
        "pipeline": ["translate"],
        "to": { "id": "-1003333333333", "note": "汇总群" }
    }
]
```

上例中「源 B」写了 `pipeline: []`，覆盖公共的 `["translate"]`；未写 `enabled` 则用规则顶层的 `true`。

`enabled` 缺省为 `true`，`pipeline` 缺省为 `[]`；启动后会根据 Telegram 实体自动补全源链接（用于转发文末跳转），**不必**在配置里写 `link`。

### 字段说明

| 字段 | 说明 |
|------|------|
| `source` | **必填**。`{ "id", "username"?, "note"?, "enabled"?, "pipeline"? }` 或此类对象的**数组**（多源）。**不允许**顶层字符串 ID |
| `source.id` / `source[].id` | 源 Chat ID |
| `source.note` / `source[].note` | 源备注（日志、转发来源标题等），可选 |
| `source.username` / `source[].username` | 可选，用于 `@username` 映射 |
| `source.enabled` / `source[].enabled` | 可选，覆盖规则顶层的 `enabled` |
| `source.pipeline` / `source[].pipeline` | 可选，覆盖规则顶层的 `pipeline`（非数组则视为 `[]`） |
| `enabled` | 规则级**默认**；缺省 `true`；源未写 `enabled` 时用此项 |
| `pipeline` | 规则级**默认**，**须为数组**；缺省或非数组时视为 `[]`；源未写 `pipeline` 时用此项 |
| `to` | **必填**，整条规则共用。`{ "id", "topicId"?, "note"? }` 或此类对象的**数组**（多目标）。**不允许**顶层字符串 ID |
| `to.id` / `to[].id` | 目标 Chat ID |
| `to.topicId` / `to[].topicId` | 论坛话题 ID；普通群可省略 |
| `to.note` / `to[].note` | 目标备注（日志用），可选 |

## Pipeline 处理器

`pipeline` 是一个处理器名称数组，消息按顺序经过每个处理器。任意一步返回 `null` 则丢弃该消息。

可用处理器（位于 `handlers/` 目录）：

| 处理器 | 作用 |
|--------|------|
| `translate` | 检测语言，非中文自动翻译为中文（需配置 DeepSeek API Key） |
| `noMedia` | 仅转发文本，不转发图片/视频/文件 |
| `example` | 示例 — 只提取消息第一行 |

### 配置示例

```json
"pipeline": []                          // 原样转发（文本 + 媒体）
"pipeline": ["translate"]               // 转发并自动翻译
"pipeline": ["noMedia"]                 // 只转发文本
"pipeline": ["noMedia", "translate"]    // 只转发文本 + 翻译
```

### 自定义处理器

在 `handlers/` 目录下创建 `.js` 文件即可，文件名即处理器名称：

```javascript
// handlers/keyword.js — 只转发包含关键词的消息
const KEYWORDS = ['BTC', 'ETH', 'SOL'];

export default function (ctx) {
    const hasKeyword = KEYWORDS.some(kw =>
        ctx.text.toUpperCase().includes(kw)
    );
    return hasKeyword ? ctx : null;
}
```

处理器接口：
- **参数**：`ctx` 对象，包含 `text`（文本）、`forwardMedia`（是否转发媒体）、`channelConfig`（频道配置）、`message`（GramJS 原始消息）
- **返回**：修改后的 `ctx`（继续 pipeline）或 `null`（跳过此消息）

## 项目结构

```
tg-monitor/
├── app.js                  # 入口，进程管理
├── gen-session.js          # Session 获取脚本
├── ecosystem.config.cjs    # PM2 配置
├── channels.config.json    # 频道配置（gitignore）
├── .env                    # 环境变量（gitignore）
├── .state.json             # 运行状态（gitignore）
├── src/
│   ├── config.js           # 配置加载
│   ├── monitor.js          # 核心：双通道入口 + Pipeline
│   ├── queue.js            # 去重队列 + Gap 检测
│   ├── forwarder.js        # Bot API 转发
│   ├── rate-limiter.js     # 令牌桶限流
│   ├── state.js            # lastMessageId 持久化
│   ├── translator.js       # DeepSeek 翻译
│   └── utils.js            # 公共工具函数
└── handlers/
    ├── translate.js         # 翻译处理器
    ├── noMedia.js           # 过滤媒体处理器
    └── example.js           # 示例处理器
```
