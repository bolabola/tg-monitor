import { autoTranslate } from '../src/translator.js';

/**
 * 翻译处理器 — 自动检测语言，非中文则调用 DeepSeek API 翻译
 *
 * 需要在 .env 中配置 DEEPSEEK_API_KEY
 */
export default async function (ctx) {
    if (ctx.text) ctx.text = await autoTranslate(ctx.text);
    return ctx;
}
