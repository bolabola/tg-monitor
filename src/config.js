import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeId } from './utils.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** `to` 项须为非数组对象且含 `id`，与 `source` 项规则一致（可选 `note`；目标另可选 `topicId`） */
function normalizeTargetSpec(t) {
    if (t && typeof t === 'object' && !Array.isArray(t) && t.id != null) {
        const out = { id: String(t.id) };
        if (t.topicId != null && t.topicId !== '') out.topicId = t.topicId;
        if (t.note != null) out.note = t.note;
        return out;
    }
    return null;
}

/** `source` 项须为对象且含 `id`；可选 `note`、`username`、以及覆盖规则级的 `enabled` / `pipeline`。 */
function normalizeSourceSpec(s) {
    if (s && typeof s === 'object' && !Array.isArray(s) && s.id != null) {
        const out = { id: String(s.id) };
        if (s.username) out.username = String(s.username).toLowerCase();
        if (s.note != null) out.note = s.note;
        if (s.enabled !== undefined) out.enabled = s.enabled;
        if (s.pipeline !== undefined) {
            out.pipeline = Array.isArray(s.pipeline) ? [...s.pipeline] : [];
        }
        return out;
    }
    return null;
}

function collectSources(raw) {
    const src = raw.source;
    if (src == null) return [];
    if (Array.isArray(src)) {
        return src.map(normalizeSourceSpec).filter(Boolean);
    }
    if (typeof src === 'object') {
        const one = normalizeSourceSpec(src);
        return one ? [one] : [];
    }
    return [];
}

function collectTargets(raw) {
    const to = raw.to;
    if (to == null) return [];
    if (Array.isArray(to)) {
        return to.map(normalizeTargetSpec).filter(Boolean);
    }
    if (typeof to === 'object') {
        const one = normalizeTargetSpec(to);
        return one ? [one] : [];
    }
    return [];
}

/** 单条规则内 `source` 列表不得含重复 Chat ID */
function assertUniqueSourcesInRule(sources, ruleIndex) {
    const seen = new Set();
    for (const src of sources) {
        const key = normalizeId(src.id);
        if (seen.has(key)) {
            throw new Error(`CONFIG: 第 ${ruleIndex} 条规则的 source 中，Chat ID ${src.id} 重复。每个源全局只能出现一次`);
        }
        seen.add(key);
    }
}

/** 全文展开后每个源 Chat ID 只能有一条配置（`to` 可被多个源共用） */
function assertUniqueSourcesGlobal(rows) {
    const seen = new Set();
    for (const ch of rows) {
        const key = normalizeId(ch.id);
        if (seen.has(key)) {
            throw new Error(
                `CONFIG: 源 Chat ID ${ch.id} 在配置中出现多次。每个源全局只能写一次；多个源可指向同一个 to`
            );
        }
        seen.add(key);
    }
}

/**
 * 一条规则 → 多个监听项（每源一条）。
 * `to` 整条规则共用；`enabled` / `pipeline` 以规则顶层为默认，源对象上写了则覆盖。
 */
function expandRuleToChannels(raw, ruleIndex = 0) {
    if (!raw || typeof raw !== 'object') return [];
    const sources = collectSources(raw);
    if (sources.length === 0) {
        if (ruleIndex && raw.source != null) {
            console.warn(
                `⚠️ channels.config.json 第 ${ruleIndex} 条规则已跳过：source 须为 { "id": "..." } 或对象数组`
            );
        }
        return [];
    }

    assertUniqueSourcesInRule(sources, ruleIndex || 1);

    const to = collectTargets(raw);
    if (to.length === 0 && ruleIndex) {
        if (raw.to != null) {
            console.warn(
                `⚠️ channels.config.json 第 ${ruleIndex} 条规则：to 无效或为空（须为 { "id": "..." } 或对象数组），对应源将无法转发`
            );
        } else {
            console.warn(`⚠️ channels.config.json 第 ${ruleIndex} 条规则：缺少 to，对应源将无法转发`);
        }
    }
    const ruleEnabled = raw.enabled !== false;
    const rulePipeline = Array.isArray(raw.pipeline) ? raw.pipeline : [];

    return sources.map(src => ({
        id: src.id,
        username: src.username,
        note: src.note,
        enabled: src.enabled !== undefined ? src.enabled !== false : ruleEnabled,
        pipeline: src.pipeline !== undefined ? [...src.pipeline] : [...rulePipeline],
        to: to.map(t => ({ ...t }))
    }));
}

const loadChannelConfig = () => {
    const configPath = path.resolve(__dirname, '../channels.config.json');
    try {
        if (fs.existsSync(configPath)) {
            const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            if (!Array.isArray(raw)) return [];
            const expanded = [];
            for (let i = 0; i < raw.length; i++) {
                expanded.push(...expandRuleToChannels(raw[i], i + 1));
            }
            assertUniqueSourcesGlobal(expanded);
            return expanded;
        }
    } catch (error) {
        if (error.message?.startsWith('CONFIG:')) {
            console.error('❌', error.message.replace(/^CONFIG:\s*/, ''));
            process.exit(1);
        }
        console.warn('⚠️ Failed to load channels.config.json:', error.message);
    }
    return [];
};

const config = {
    telegram: {
        bot_token: process.env.TELEGRAM_BOT_TOKEN,
        client: {
            apiId: parseInt(process.env.TELEGRAM_API_ID),
            apiHash: process.env.TELEGRAM_API_HASH,
            session: process.env.TELEGRAM_SESSION
        },
        channels: loadChannelConfig()
    },
    deepseek: {
        apiKey: process.env.DEEPSEEK_API_KEY || '',
        baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
    }
};

export default config;
