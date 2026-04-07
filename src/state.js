import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, '../.state.json');

let state = {};
let saveTimer = null;
const SAVE_DEBOUNCE_MS = 2000;

export function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        }
    } catch (e) {
        console.warn('⚠️ 状态文件加载失败:', e.message);
        state = {};
    }
    return state;
}

function debouncedSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        } catch (e) {
            console.error('❌ 状态保存失败:', e.message);
        }
    }, SAVE_DEBOUNCE_MS);
}

export function flushState() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
        console.error('❌ 状态保存失败:', e.message);
    }
}

export function getLastMessageId(channelId) {
    return state[channelId]?.lastMessageId || 0;
}

export function hasLastMessageId(channelId) {
    return Number.isInteger(state[channelId]?.lastMessageId);
}

export function setLastMessageId(channelId, messageId) {
    if (!state[channelId]) state[channelId] = {};
    state[channelId].lastMessageId = messageId;
    debouncedSave();
}
