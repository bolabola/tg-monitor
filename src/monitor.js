import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { pathToFileURL, fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import config from './config.js';
import { forwardToAllTargets } from './forwarder.js';
import { loadState, getLastMessageId, setLastMessageId, flushState } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let client = null;
let heartbeatTimer = null;

// ─── Chat 缓存 ───────────────────────────────────────────────

const chatCache = new Map();
const CHAT_CACHE_TTL = 10 * 60 * 1000;

async function getCachedChat(message) {
    const chatId = message.chatId?.toString();
    if (chatId) {
        const cached = chatCache.get(chatId);
        if (cached && Date.now() - cached.ts < CHAT_CACHE_TTL) {
            return cached.chat;
        }
    }
    const chat = await message.getChat();
    if (chatId) chatCache.set(chatId, { chat, ts: Date.now() });
    return chat;
}

// ─── 频道匹配 ─────────────────────────────────────────────────

function normalizeId(id) {
    return id.toString().replace(/^-100/, '');
}

function buildChannelMap(channels) {
    const map = new Map();
    for (const ch of channels) {
        map.set(normalizeId(ch.id), ch);
        if (ch.username) map.set(ch.username.toLowerCase(), ch);
    }
    return map;
}

function matchChannel(channelMap, chat) {
    return channelMap.get(normalizeId(chat.id?.toString() || ''))
        || (chat.username && channelMap.get(chat.username.toLowerCase()))
        || null;
}

// ─── 媒体检测 ─────────────────────────────────────────────────

const MAX_MEDIA_BYTES = 50 * 1024 * 1024; // Bot API 上传上限

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
//
// 所有处理器均从 handlers/ 目录动态加载
// 每个处理器接收 ctx 对象，返回修改后的 ctx 或 null（跳过消息）
//   ctx = { text, forwardMedia, channelConfig, message }

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

// ─── 心跳重连 ─────────────────────────────────────────────────

function startHeartbeat() {
    heartbeatTimer = setInterval(async () => {
        try {
            if (client && !client.connected) {
                console.warn('⚠️ 连接断开，尝试重连...');
                await client.connect();
                console.log('✅ 重连成功');
            }
        } catch (err) {
            console.error('❌ 重连失败:', err.message);
        }
    }, 30_000);
}

// ─── 启动 / 停止 ─────────────────────────────────────────────

export const startMonitor = async () => {
    const { apiId, apiHash, session } = config.telegram.client;
    const channelConfig = config.telegram.channelConfig;

    if (!apiId || !apiHash || !session) {
        console.error('❌ 缺少 TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION');
        process.exit(1);
    }

    if (!config.telegram.bot_token) {
        console.error('❌ 缺少 TELEGRAM_BOT_TOKEN，无法转发消息');
        process.exit(1);
    }

    if (!channelConfig?.enabled) {
        console.warn('⚠️ channels.config.json 未启用，退出');
        return;
    }

    const enabledChannels = channelConfig.channels.filter(ch => ch.enabled);
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
        console.log(`   - ${ch.nickname || ch.id} (${ch.id})  [${pipe}]`);
    });

    const stringSession = new StringSession(session);
    client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: Infinity
    });

    await client.start({
        onError: err => console.error('Telegram Client Error:', err)
    });

    console.log('✅ Telegram Client 已连接');
    startHeartbeat();

    const channelMap = buildChannelMap(enabledChannels);

    client.addEventHandler(async event => {
        try {
            const message = event.message;
            const chat = await getCachedChat(message);
            const matched = matchChannel(channelMap, chat);
            if (!matched) return;

            const channelId = normalizeId(matched.id);
            const msgId = message.id;
            if (msgId <= getLastMessageId(channelId)) return;

            const text = message.text || '';
            const sourceTitle = chat.title || chat.username || matched.nickname || 'Unknown';

            console.log(
                `📩 [${matched.nickname || matched.id}]: ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`
            );

            const pipeline = matched.pipeline || [];
            const ctx = await runPipeline(pipeline, processors, text, matched, message);
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
                await forwardToAllTargets(matched, {
                    text: ctx.text,
                    mediaBuffer,
                    mediaType: mediaInfo?.type,
                    fileName: mediaInfo?.fileName
                }, sourceTitle);
            }

            setLastMessageId(channelId, msgId);
        } catch (error) {
            console.error('处理消息出错:', error);
        }
    }, new NewMessage({}));

    console.log('🟢 TG Monitor 运行中，等待消息...');
};

export const stopMonitor = async () => {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    flushState();
    if (client) {
        await client.disconnect();
        console.log('🔴 Telegram Client 已断开');
    }
};
