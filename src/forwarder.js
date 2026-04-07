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

function escapeHtml(text = '') {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function apiCall(method, body, isMultipart = false) {
    const axiosConfig = isMultipart ? { headers: body.getHeaders() } : {};

    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            const res = await axios.post(`${BASE_URL}/${method}`, body, axiosConfig);
            return res.data;
        } catch (err) {
            if (attempt === 5) {
                console.error(`[tg] ${method} failed:`, err.response?.data || err.message);
                throw err;
            }
            const retryAfter = err.response?.data?.parameters?.retry_after || attempt;
            console.log(`[tg] retry ${attempt}/${5} in ${retryAfter}s`);
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
        console.warn(`[tg] unsupported media type: ${type}`);
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

function buildFooter(sourceLink, sourceTitle) {
    const sourceLabel = buildSourceLabel(sourceLink, sourceTitle);
    return ` - ${sourceLabel}`;
}

function buildSourceLabel(sourceLink, sourceTitle) {
    const safeTitle = escapeHtml(sourceTitle);
    if (!sourceLink) return safeTitle;
    return `<a href="${escapeHtml(sourceLink)}">${safeTitle}</a>`;
}

async function forwardToTelegram(target, { text, mediaBuffer, mediaType, fileName, sourceLink }, sourceTitle) {
    try {
        await rateLimiter.acquire(target.id);
        const topicId = target.topicId ? parseInt(target.topicId, 10) : null;
        const safeText = escapeHtml(text || '');
        const footer = buildFooter(sourceLink, sourceTitle);

        if (mediaBuffer && mediaType) {
            const caption = safeText ? `${safeText}${footer}` : buildSourceLabel(sourceLink, sourceTitle);
            await sendMedia(mediaType, mediaBuffer, target.id, caption, topicId, fileName);
        } else if (safeText) {
            await sendText(`${safeText}${footer}`, target.id, topicId);
        }

        console.log(`forwarded to [${labelNoteOrId(target)}]`);
    } catch (error) {
        console.error(`forward to [${labelNoteOrId(target)}] failed:`, error.message);
        throw error;
    }
}

export const forwardToAllTargets = async (channelConfig, payload, sourceTitle) => {
    const targets = channelConfig.to;
    if (!targets?.length) return;

    const results = await Promise.allSettled(
        targets.map(target => forwardToTelegram(target, payload, sourceTitle))
    );

    const failedTargets = results
        .map((result, index) => ({ result, target: targets[index] }))
        .filter(({ result }) => result.status === 'rejected')
        .map(({ target }) => labelNoteOrId(target));

    if (failedTargets.length > 0) {
        throw new Error(`forward failed for targets: ${failedTargets.join(', ')}`);
    }
};
