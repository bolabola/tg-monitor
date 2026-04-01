import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { pathToFileURL, fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import config from './config.js';
import { forwardToAllTargets } from './forwarder.js';
import { loadState, getLastMessageId, setLastMessageId, flushState } from './state.js';
import { MessageQueue } from './queue.js';
import { normalizeId, labelNoteOrId } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let client = null;
let heartbeatTimer = null;
let fetchTimer = null;

const FETCH_INTERVAL = parseInt(process.env.FETCH_INTERVAL_MS || process.env.CATCHUP_INTERVAL_MS) || 5_000;
const FETCH_STAGGER = 500;
const FETCH_ON_START = (process.env.FETCH_ON_START || process.env.CATCHUP_ON_START) !== 'false';

// ─── 频道匹配 ─────────────────────────────────────────────────

function buildChannelMap(channels) {
    const map = new Map();
    for (const ch of channels) {
        map.set(normalizeId(ch.id), ch);
        if (ch.username) map.set(ch.username.toLowerCase(), ch);
    }
    return map;
}

// ─── 媒体检测 ─────────────────────────────────────────────────

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

function detectMedia(message) {
    const media = message.media;
    if (!media) return null;

    if (media.className === 'MessageMediaPhoto') {
        return { type: 'photo', fileName: 'photo.jpg' };
    }

    if (media.className === 'MessageMediaDocument') {
        const doc = media.document;
        if (!doc) return null;

        const mime = doc.mimeType || '';
        const attrs = doc.attributes || [];
        const nameAttr = attrs.find(a => a.className === 'DocumentAttributeFilename');
        const fileName = nameAttr?.fileName || 'file';

        if (attrs.some(a => a.className === 'DocumentAttributeSticker'))
            return { type: 'sticker', fileName: fileName || 'sticker.webp' };

        if (attrs.some(a => a.className === 'DocumentAttributeAnimated') || mime === 'image/gif')
            return { type: 'animation', fileName };

        if (mime.startsWith('video/')) {
            const isRound = attrs.some(a => a.className === 'DocumentAttributeVideo' && a.roundMessage);
            return { type: isRound ? 'video_note' : 'video', fileName };
        }

        if (mime.startsWith('audio/') || attrs.some(a => a.className === 'DocumentAttributeAudio')) {
            const isVoice = attrs.some(a => a.className === 'DocumentAttributeAudio' && a.voice);
            return { type: isVoice ? 'voice' : 'audio', fileName };
        }

        return { type: 'document', fileName };
    }

    return null;
}

// ─── Pipeline 处理器 ──────────────────────────────────────────

async function loadProcessors() {
    const processors = {};
    const handlersDir = path.resolve(__dirname, '../handlers');

    if (!fs.existsSync(handlersDir)) {
        fs.mkdirSync(handlersDir, { recursive: true });
        return processors;
    }

    const files = fs.readdirSync(handlersDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
        try {
            const filePath = path.resolve(handlersDir, file);
            const mod = await import(pathToFileURL(filePath).href);
            const name = file.replace('.js', '');
            processors[name] = mod.default || mod.handler;
            console.log(`  📦 处理器已加载: ${name}`);
        } catch (e) {
            console.warn(`  ⚠️ 处理器 ${file} 加载失败:`, e.message);
        }
    }

    return processors;
}

async function runPipeline(pipeline, processors, text, channelConfig, message) {
    let ctx = { text, forwardMedia: true, channelConfig, message };

    for (const step of pipeline) {
        const proc = processors[step];
        if (!proc) {
            console.warn(`⚠️ 未找到处理器: ${step}，跳过该步骤`);
            continue;
        }
        ctx = await proc(ctx, channelConfig, message);
        if (ctx === null) return null;
    }

    return ctx;
}

// ─── 定时拉取 ────────────────────────────────────────────────

let fetching = false;

async function fetchAll(enabledChannels, messageQueue) {
    if (fetching) return;
    fetching = true;
    try {
        for (const ch of enabledChannels) {
            try {
                const channelId = normalizeId(ch.id);
                const lastId = getLastMessageId(channelId);
                const msgs = await client.getMessages(ch.id, {
                    limit: 20,
                    minId: lastId
                });

                let count = 0;
                for (const msg of [...msgs].reverse()) {
                    if (messageQueue.enqueue(ch, msg, { fromFetch: true })) count++;
                }
                if (count > 0) {
                    console.log(`🔄 [定时拉取] ${labelNoteOrId(ch)}: 拉取 ${count} 条新消息`);
                }
            } catch (e) {
                console.error(`❌ [定时拉取] ${labelNoteOrId(ch)} 失败:`, e.message);
            }

            await new Promise(r => setTimeout(r, FETCH_STAGGER));
        }
    } finally {
        fetching = false;
    }
}

async function fetchChannel(ch, messageQueue) {
    try {
        const channelId = normalizeId(ch.id);
        const lastId = getLastMessageId(channelId);
        const msgs = await client.getMessages(ch.id, {
            limit: 20,
            minId: lastId
        });

        let count = 0;
        for (const msg of [...msgs].reverse()) {
            if (messageQueue.enqueue(ch, msg, { fromFetch: true })) count++;
        }
        if (count > 0) {
            console.log(`🔄 [gap 拉取] ${labelNoteOrId(ch)}: 拉取 ${count} 条消息`);
        }
    } catch (e) {
        console.error(`❌ [gap 拉取] ${labelNoteOrId(ch)} 失败:`, e.message);
    }
}

// ─── 心跳重连 ─────────────────────────────────────────────────

function startHeartbeat(enabledChannels, messageQueue) {
    heartbeatTimer = setInterval(async () => {
        try {
            if (client && !client.connected) {
                console.warn('⚠️ 连接断开，尝试重连...');
                await client.connect();
                console.log('✅ 重连成功，立即触发全频道拉取...');
                fetchAll(enabledChannels, messageQueue);
            }
        } catch (err) {
            console.error('❌ 重连失败:', err.message);
        }
    }, 30_000);
}

// ─── 启动 / 停止 ─────────────────────────────────────────────

export const startMonitor = async () => {
    const { apiId, apiHash, session } = config.telegram.client;

    if (!apiId || !apiHash || !session) {
        console.error('❌ 缺少 TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION');
        process.exit(1);
    }

    if (!config.telegram.bot_token) {
        console.error('❌ 缺少 TELEGRAM_BOT_TOKEN，无法转发消息');
        process.exit(1);
    }

    const enabledChannels = config.telegram.channels.filter(ch => ch.enabled);
    if (enabledChannels.length === 0) {
        console.warn('⚠️ 没有已启用的频道配置，退出');
        return;
    }

    loadState();
    const processors = await loadProcessors();

    console.log('🚀 TG Monitor 启动中...');
    console.log(`📡 监听 ${enabledChannels.length} 个频道:`);
    enabledChannels.forEach(ch => {
        const pipe = ch.pipeline?.length ? ch.pipeline.join(' → ') : '(直接转发)';
        console.log(`   - ${labelNoteOrId(ch)} (${ch.id})  [${pipe}]`);
    });

    const stringSession = new StringSession(session);
    client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: Infinity
    });

    await client.start({
        onError: err => console.error('Telegram Client Error:', err)
    });

    console.log('✅ Telegram Client 已连接');

    await client.getDialogs();
    console.log('✅ 会话列表已同步');

    for (const ch of enabledChannels) {
        try {
            const entity = await client.getEntity(ch.id);
            if (entity.username) {
                ch.link = `https://t.me/${entity.username}`;
            } else {
                ch.link = `https://t.me/c/${entity.id}`;
            }
            const msgs = await client.getMessages(ch.id, { limit: 1 });
            const latest = msgs[0]?.message || '(无文本/媒体消息)';
            console.log(`  ✅ 已订阅: ${entity.title || ch.id} (${entity.id}) 最新消息: ${latest.substring(0, 50)}`);
        } catch (e) {
            console.error(`  ❌ 订阅失败: ${labelNoteOrId(ch)} — ${e.message}`);
            console.error(`     请确认该账号已加入此频道/群组`);
        }
    }

    // ─── 消息处理回调 ─────────────────────────────────────────

    async function processMessage(channelConfig, message) {
        const text = message.message || '';

        console.log(
            `📩 [${labelNoteOrId(channelConfig)}]: ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`
        );

        const pipeline = channelConfig.pipeline || [];
        const ctx = await runPipeline(pipeline, processors, text, channelConfig, message);
        if (!ctx) return;

        const mediaInfo = detectMedia(message);
        let mediaBuffer = null;

        if (mediaInfo && ctx.forwardMedia) {
            const docSize = message.media?.document?.size;
            if (docSize && Number(docSize) > MAX_MEDIA_BYTES) {
                console.warn(`⚠️ 文件过大 (${(Number(docSize) / 1024 / 1024).toFixed(1)}MB)，跳过下载`);
            } else {
                try {
                    mediaBuffer = await client.downloadMedia(message);
                } catch (e) {
                    console.warn('⚠️ 媒体下载失败:', e.message);
                }
            }
        }

        if (ctx.text || mediaBuffer) {
            const sourceTitle = labelNoteOrId(channelConfig);
            const sourceLink = channelConfig.link && message.id
                ? `${channelConfig.link}/${message.id}` : null;
            await forwardToAllTargets(channelConfig, {
                text: ctx.text,
                mediaBuffer,
                mediaType: mediaInfo?.type,
                fileName: mediaInfo?.fileName,
                sourceLink
            }, sourceTitle);
        }
    }

    // ─── MessageQueue 初始化 ──────────────────────────────────

    const channelMap = buildChannelMap(enabledChannels);

    const messageQueue = new MessageQueue({
        onProcess: processMessage,
        onGap: (channelConfig, lastId, newId) => {
            console.warn(`⚠️ [${labelNoteOrId(channelConfig)}] 检测到消息 gap (${lastId} → ${newId})，触发拉取`);
            fetchChannel(channelConfig, messageQueue);
        }
    });

    // ─── 通道 1: Raw Update Handler（实时推送）─────────────────

    client.addEventHandler(async (update) => {
        try {
            if (!(update instanceof Api.UpdateNewChannelMessage) &&
                !(update instanceof Api.UpdateNewMessage)) {
                return;
            }

            const message = update.message;
            if (!message || message.className === 'MessageEmpty') return;

            const peerId = message.peerId;
            let rawChatId;

            if (peerId?.className === 'PeerChannel') {
                rawChatId = peerId.channelId.toString();
            } else if (peerId?.className === 'PeerChat') {
                rawChatId = peerId.chatId.toString();
            } else {
                return;
            }

            const matched = channelMap.get(normalizeId(rawChatId));
            if (!matched) return;

            messageQueue.enqueue(matched, message);
        } catch (error) {
            console.error('处理推送更新出错:', error.message);
        }
    });

    // ─── 通道 2: 定时拉取 ──────────────────────────────────────

    startHeartbeat(enabledChannels, messageQueue);

    if (FETCH_ON_START) {
        console.log(`🔄 首次启动拉取...`);
        await fetchAll(enabledChannels, messageQueue);
    } else {
        console.log('⏭️ 跳过首次拉取 (FETCH_ON_START=false)');
    }

    fetchTimer = setInterval(
        () => fetchAll(enabledChannels, messageQueue),
        FETCH_INTERVAL
    );

    console.log(`🟢 TG Monitor 运行中 (实时推送 + ${FETCH_INTERVAL / 1000}s 定时拉取)`);
};

export const stopMonitor = async () => {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (fetchTimer) {
        clearInterval(fetchTimer);
        fetchTimer = null;
    }
    flushState();
    if (client) {
        await client.disconnect();
        console.log('🔴 Telegram Client 已断开');
    }
};
