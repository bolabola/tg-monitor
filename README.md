# TG Monitor

Telegram 频道/群组消息监控与转发服务。通过 MTProto 用户客户端监听指定频道的新消息，经 pipeline 处理后，通过 Bot API 转发到目标频道/群组。

## 快速开始

```bash
# 安装依赖
npm install

# 复制配置文件
cp .env.example .env
cp channels.config.example.json channels.config.json

# 按下文指引填写 .env 和 channels.config.json

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

## 频道配置

编辑 `channels.config.json`，参考 `channels.config.example.json`：

```json
{
    "enabled": true,
    "channels": [
        {
            "id": "-1001234567890",
            "nickname": "我的频道",
            "link": "https://t.me/my_channel",
            "enabled": true,
            "pipeline": ["translate"],
            "forwardTo": {
                "telegram": [
                    {
                        "type": "group",
                        "id": "-1005555555555",
                        "topicId": "123",
                        "nickname": "目标群组"
                    }
                ]
            }
        }
    ]
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `id` | 源频道/群组的 Chat ID |
| `nickname` | 显示名称（仅用于日志） |
| `link` | 频道链接，方便查找 |
| `enabled` | 是否启用监听 |
| `pipeline` | 处理器管道，按顺序执行。`[]` 表示原样转发 |
| `forwardTo.telegram` | 转发目标列表 |
| `forwardTo.telegram[].type` | `channel` 或 `group` |
| `forwardTo.telegram[].id` | 目标 Chat ID |
| `forwardTo.telegram[].topicId` | 论坛话题 ID（非论坛群组填 `null`） |
| `forwardTo.telegram[].nickname` | 目标显示名称（仅用于日志） |

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
