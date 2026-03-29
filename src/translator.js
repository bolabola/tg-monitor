import axios from 'axios';
import config from './config.js';

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
const MIN_LENGTH = 2;
const CHINESE_RATIO_THRESHOLD = 0.3;

/**
 * 判断文本是否"主要是中文"。
 * 当 CJK 字符占非空白字符的比例 >= 30% 时视为中文。
 */
export function isChinese(text) {
    if (!text || text.length < MIN_LENGTH) return true;
    const stripped = text.replace(/\s/g, '');
    if (stripped.length === 0) return true;
    const cjkMatches = stripped.match(CJK_REGEX);
    return (cjkMatches?.length || 0) / stripped.length >= CHINESE_RATIO_THRESHOLD;
}

/**
 * 调用 DeepSeek API 将文本翻译为中文。
 * 返回翻译后的文本，失败时返回 null。
 */
export async function translateToChinese(text) {
    const { apiKey, baseUrl, model } = config.deepseek;
    if (!apiKey) {
        console.warn('⚠️ DEEPSEEK_API_KEY 未配置，跳过翻译');
        return null;
    }

    try {
        const res = await axios.post(
            `${baseUrl}/chat/completions`,
            {
                model,
                messages: [
                    {
                        role: 'system',
                        content:
                            '你是一个专业翻译。将用户发送的文本翻译为简体中文。' +
                            '只输出翻译结果，不要添加解释、注释或原文。' +
                            '保留原文中的链接、用户名、数字和代码片段。'
                    },
                    { role: 'user', content: text }
                ],
                temperature: 1.3
            },
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30_000
            }
        );

        const translated = res.data?.choices?.[0]?.message?.content?.trim();
        if (!translated) return null;

        console.log(`🌐 翻译完成 (${text.length} → ${translated.length} 字符)`);
        return translated;
    } catch (err) {
        console.error('❌ 翻译失败:', err.response?.data || err.message);
        return null;
    }
}

/**
 * 如果文本不是中文，自动翻译并拼接原文 + 译文。
 * 已经是中文或翻译失败时返回原文不变。
 */
export async function autoTranslate(text) {
    if (!text || isChinese(text)) return text;

    const translated = await translateToChinese(text);
    if (!translated) return text;

    return `${text}\n\n——— 🌐 自动翻译 ———\n${translated}`;
}
