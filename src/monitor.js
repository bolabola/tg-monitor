import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { pathToFileURL, fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import config from './config.js';
import { forwardToAllTargets } from './forwarder.js';
import { loadState, getLastMessageId, hasLastMessageId, setLastMessageId, flushState } from './state.js';
import { MessageQueue } from './queue.js';
import { normalizeId, labelNoteOrId } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let client = null;
let heartbeatTimer = null;
let fetchTimer = null;

const FETCH_INTERVAL = parseInt(process.env.FETCH_INTERVAL_MS || process.env.CATCHUP_INTERVAL_MS, 10) || 5_000;
const FETCH_STAGGER = 500;
const FETCH_ON_START = (process.env.FETCH_ON_START || process.env.CATCHUP_ON_START) !== 'false';
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

function buildChannelBaseLink(channel) {
    if (channel.link) return channel.link;

    const username = channel.username?.replace(/^@/, '').trim();
    if (username) return `https://t.me/${username}`;

    if (channel.id != null) return `https://t.me/c/${normalizeId(channel.id)}`;
    return null;
}

function buildChannelMap(channels) {
    const map = new Map();
    for (const ch of channels) {
        map.set(normalizeId(ch.id), ch);
        if (ch.username) map.set(ch.username.toLowerCase(), ch);
    }
    return map;
}

function detectMedia(message) {
    const media = message.media;
    if (!media) return null;

    if (media.className === 'MessageMediaPhoto') {
        return { type: 'photo', fileName: 'photo.jpg' };
    }

    if (media.className !== 'MessageMediaDocument') return null;

    const doc = media.document;
    if (!doc) return null;

    const mime = doc.mimeType || '';
    const attrs = doc.attributes || [];
    const nameAttr = attrs.find(a => a.className === 'DocumentAttributeFilename');
    const fileName = nameAttr?.fileName || 'file';

    if (attrs.some(a => a.className === 'DocumentAttributeSticker')) {
        return { type: 'sticker', fileName: fileName || 'sticker.webp' };
    }

    if (attrs.some(a => a.className === 'DocumentAttributeAnimated') || mime === 'image/gif') {
        return { type: 'animation', fileName };
    }

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
            console.log(`processor loaded: ${name}`);
        } catch (e) {
            console.warn(`processor load failed: ${file}`, e.message);
        }
    }

    return processors;
}

async function runPipeline(pipeline, processors, text, channelConfig, message) {
    let ctx = { text, forwardMedia: true, channelConfig, message };

    for (const step of pipeline) {
        const proc = processors[step];
        if (!proc) {
            console.warn(`processor not found: ${step}`);
            continue;
        }
        ctx = await proc(ctx, channelConfig, message);
        if (ctx === null) return null;
    }

    return ctx;
}

let fetching = false;

async function fetchNewMessages(ch, messageQueue, reason) {
    const channelId = normalizeId(ch.id);
    let cursor = getLastMessageId(channelId);
    let count = 0;
    const pageSize = 100;

    while (true) {
        const msgs = await client.getMessages(ch.id, {
            limit: pageSize,
            minId: cursor
        });

        if (!msgs.length) break;

        const ordered = [...msgs].reverse();
        for (const msg of ordered) {
            if (messageQueue.enqueue(ch, msg, { fromFetch: true })) count++;
        }

        const latestId = ordered[ordered.length - 1]?.id;
        if (!latestId || latestId <= cursor) break;
        cursor = latestId;

        if (msgs.length < pageSize) break;
    }

    if (count > 0) {
        console.log(`[${reason}] ${labelNoteOrId(ch)}: fetched ${count} new messages`);
    }
}

async function fetchAll(enabledChannels, messageQueue) {
    if (fetching) return;
    fetching = true;
    try {
        for (const ch of enabledChannels) {
            try {
                await fetchNewMessages(ch, messageQueue, 'periodic fetch');
            } catch (e) {
                console.error(`[periodic fetch] ${labelNoteOrId(ch)} failed:`, e.message);
            }

            await new Promise(r => setTimeout(r, FETCH_STAGGER));
        }
    } finally {
        fetching = false;
    }
}

async function fetchChannel(ch, messageQueue) {
    try {
        await fetchNewMessages(ch, messageQueue, 'gap fetch');
    } catch (e) {
        console.error(`[gap fetch] ${labelNoteOrId(ch)} failed:`, e.message);
    }
}

function startHeartbeat(enabledChannels, messageQueue) {
    heartbeatTimer = setInterval(async () => {
        try {
            if (client && !client.connected) {
                console.warn('telegram connection lost, reconnecting...');
                await client.connect();
                console.log('telegram reconnected, starting catch-up fetch');
                await fetchAll(enabledChannels, messageQueue);
            }
        } catch (err) {
            console.error('telegram reconnect failed:', err.message);
        }
    }, 30_000);
}

export const startMonitor = async () => {
    const { apiId, apiHash, session } = config.telegram.client;

    if (!apiId || !apiHash || !session) {
        console.error('missing TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION');
        process.exit(1);
    }

    if (!config.telegram.bot_token) {
        console.error('missing TELEGRAM_BOT_TOKEN');
        process.exit(1);
    }

    const enabledChannels = config.telegram.channels.filter(ch => ch.enabled);
    if (enabledChannels.length === 0) {
        console.warn('no enabled channels configured');
        return;
    }

    loadState();
    const processors = await loadProcessors();

    console.log('starting TG Monitor...');
    console.log(`watching ${enabledChannels.length} channel(s)`);
    enabledChannels.forEach(ch => {
        const pipe = ch.pipeline?.length ? ch.pipeline.join(' -> ') : '(direct forward)';
        console.log(` - ${labelNoteOrId(ch)} (${ch.id}) [${pipe}]`);
    });

    const stringSession = new StringSession(session);
    client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: Infinity
    });

    await client.start({
        onError: err => console.error('Telegram Client Error:', err)
    });

    console.log('telegram client connected');

    await client.getDialogs();
    console.log('dialog cache synced');

    for (const ch of enabledChannels) {
        ch.link = buildChannelBaseLink(ch);

        try {
            const entity = await client.getEntity(ch.id);
            ch.link = entity.username
                ? `https://t.me/${entity.username}`
                : buildChannelBaseLink(ch);

            const msgs = await client.getMessages(ch.id, { limit: 1 });
            const head = msgs[0];
            const latest = head?.message || '(non-text or media message)';
            console.log(`subscribed: ${entity.title || ch.id} (${entity.id}) latest: ${latest.substring(0, 50)}`);

            const channelId = normalizeId(ch.id);

            if (!FETCH_ON_START && head?.id != null) {
                setLastMessageId(channelId, head.id);
            } else if (FETCH_ON_START && head?.id != null && !hasLastMessageId(channelId)) {
                const bootstrapCursor = Math.max(head.id - 1, 0);
                setLastMessageId(channelId, bootstrapCursor);
                console.log(
                    `[startup] ${labelNoteOrId(ch)} has no cursor, bootstrapping to latest-only mode at ${bootstrapCursor}`
                );
            }
        } catch (e) {
            console.error(`subscribe failed: ${labelNoteOrId(ch)} - ${e.message}`);
            console.error('make sure the account has joined this channel/group');
        }
    }

    if (!FETCH_ON_START) {
        flushState();
        console.log('FETCH_ON_START=false, aligned cursors to latest messages');
    }

    async function processMessage(channelConfig, message) {
        const text = message.message || '';

        console.log(
            `[${labelNoteOrId(channelConfig)}] ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`
        );

        const pipeline = channelConfig.pipeline || [];
        const ctx = await runPipeline(pipeline, processors, text, channelConfig, message);
        if (!ctx) return;

        const mediaInfo = detectMedia(message);
        let mediaBuffer = null;

        if (mediaInfo && ctx.forwardMedia) {
            const docSize = message.media?.document?.size;
            if (docSize && Number(docSize) > MAX_MEDIA_BYTES) {
                console.warn(`media skipped because file is too large: ${(Number(docSize) / 1024 / 1024).toFixed(1)}MB`);
            } else {
                try {
                    mediaBuffer = await client.downloadMedia(message);
                } catch (e) {
                    console.warn('media download failed:', e.message);
                }
            }
        }

        if (ctx.text || mediaBuffer) {
            const sourceTitle = labelNoteOrId(channelConfig);
            const sourceBaseLink = buildChannelBaseLink(channelConfig);
            const sourceLink = sourceBaseLink && message.id
                ? `${sourceBaseLink}/${message.id}`
                : null;

            await forwardToAllTargets(channelConfig, {
                text: ctx.text,
                mediaBuffer,
                mediaType: mediaInfo?.type,
                fileName: mediaInfo?.fileName,
                sourceLink
            }, sourceTitle);
        }
    }

    const channelMap = buildChannelMap(enabledChannels);

    const messageQueue = new MessageQueue({
        onProcess: processMessage,
        onGap: (channelConfig, lastId, newId) => {
            console.warn(`[${labelNoteOrId(channelConfig)}] detected message gap (${lastId} -> ${newId}), fetching history`);
            fetchChannel(channelConfig, messageQueue);
        }
    });

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
            console.error('failed to process pushed update:', error.message);
        }
    });

    startHeartbeat(enabledChannels, messageQueue);

    if (FETCH_ON_START) {
        console.log('running startup catch-up fetch...');
        await fetchAll(enabledChannels, messageQueue);
    }

    fetchTimer = setInterval(
        () => fetchAll(enabledChannels, messageQueue),
        FETCH_INTERVAL
    );

    console.log(`TG Monitor running (push + ${FETCH_INTERVAL / 1000}s fetch)`);
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
        console.log('telegram client disconnected');
    }
};
