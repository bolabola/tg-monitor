import axios from 'axios';
import FormData from 'form-data';
import config from './config.js';
import { rateLimiter } from './rate-limiter.js';
import { labelNoteOrId } from './utils.js';

const BOT_TOKEN = config.telegram.bot_token;
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

const MEDIA_METHODS = {
    photo: 'sendPhoto',
    video: 'sendVideo',
    document: 'sendDocument',
    audio: 'sendAudio',
    voice: 'sendVoice',
    animation: 'sendAnimation',
    sticker: 'sendSticker',
    video_note: 'sendVideoNote'
};

const MAX_CAPTION = 1024;
const MAX_TEXT = 4096;

function truncate(text, max) {
    if (!text || text.length <= max) return text;
    return text.substring(0, max - 3) + '...';
}

async function apiCall(method, body, isMultipart = false) {
    const axiosConfig = isMultipart ? { headers: body.getHeaders() } : {};

    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            const res = await axios.post(`${BASE_URL}/${method}`, body, axiosConfig);
            return res.data;
        } catch (err) {
            if (attempt === 5) {
                console.error(`[tg] ❌ ${method} 失败:`, err.response?.data || err.message);
                throw err;
            }
            const retryAfter = err.response?.data?.parameters?.retry_after || attempt;
            console.log(`[tg] ⚠️ 第${attempt}次重试 (${retryAfter}s)...`);
            await new Promise(r => setTimeout(r, retryAfter * 1000));
        }
    }
}

async function sendText(text, chatId, threadId = null) {
    const body = {
        chat_id: chatId,
        text: truncate(text, MAX_TEXT),
        parse_mode: 'HTML',
        disable_web_page_preview: true
    };
    if (threadId) body.message_thread_id = threadId;
    return apiCall('sendMessage', body);
}

async function sendMedia(type, buffer, chatId, caption = '', threadId = null, fileName = 'file') {
    const method = MEDIA_METHODS[type];
    if (!method) {
        console.warn(`[tg] ⚠️ 不支持的媒体类型: ${type}`);
        return null;
    }

    const form = new FormData();
    form.append('chat_id', chatId.toString());
    form.append(type, buffer, { filename: fileName });
    if (caption && type !== 'sticker') {
        form.append('caption', truncate(caption, MAX_CAPTION));
        form.append('parse_mode', 'HTML');
    }
    if (threadId) form.append('message_thread_id', threadId.toString());

    return apiCall(method, form, true);
}

async function forwardToTelegram(target, { text, mediaBuffer, mediaType, fileName, sourceLink }, sourceTitle) {
    try {
        await rateLimiter.acquire(target.id);
        const topicId = target.topicId ? parseInt(target.topicId) : null;

        const footer = sourceLink
            ? ` — <a href="${sourceLink}">${sourceTitle}</a>`
            : ` — ${sourceTitle}`;

        if (mediaBuffer && mediaType) {
            const caption = text ? `${text}${footer}` : sourceTitle;
            await sendMedia(mediaType, mediaBuffer, target.id, caption, topicId, fileName);
        } else if (text) {
            await sendText(`${text}${footer}`, target.id, topicId);
        }

        console.log(`✅ 已转发到 [${labelNoteOrId(target)}]`);
    } catch (error) {
        console.error(`❌ 转发到 [${labelNoteOrId(target)}] 失败:`, error.message);
    }
}

export const forwardToAllTargets = async (channelConfig, payload, sourceTitle) => {
    const targets = channelConfig.to;
    if (!targets?.length) return;

    await Promise.allSettled(
        targets.map(target => forwardToTelegram(target, payload, sourceTitle))
    );
};
