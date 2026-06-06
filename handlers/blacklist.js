import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { labelNoteOrId } from '../src/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLACKLIST_PATH = path.resolve(__dirname, '../blacklist.txt');

let cachedMtime = 0;
let cachedKeywords = [];

function loadKeywords() {
    try {
        const stat = fs.statSync(BLACKLIST_PATH);
        if (stat.mtimeMs === cachedMtime) return cachedKeywords;

        cachedMtime = stat.mtimeMs;
        cachedKeywords = fs.readFileSync(BLACKLIST_PATH, 'utf-8')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`blacklist load failed: ${error.message}`);
        }
        cachedMtime = 0;
        cachedKeywords = [];
    }

    return cachedKeywords;
}

function findBlacklistedKeyword(text = '') {
    if (!text) return null;

    const haystack = String(text).toLowerCase();
    return loadKeywords().find(keyword => haystack.includes(keyword.toLowerCase())) || null;
}

/**
 * 黑名单处理器 — 消息原文包含 blacklist.txt 中任一关键词时跳过
 *
 * 使用方法：在 channels.config.json 的 pipeline 中加入 "blacklist"
 *   例如: "pipeline": ["blacklist", "translate"]
 */
export default function (ctx) {
    const matchedKeyword = findBlacklistedKeyword(ctx.text);
    if (!matchedKeyword) return ctx;

    console.log(`[${labelNoteOrId(ctx.channelConfig)}] skipped by blacklist keyword: ${matchedKeyword}`);
    return null;
}
