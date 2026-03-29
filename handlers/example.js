/**
 * 示例处理器 — 提取消息的第一行
 *
 * 使用方法：在 channels.config.json 的 pipeline 中加入 "example"
 *   例如: "pipeline": ["example"] 或 "pipeline": ["example", "translate"]
 *
 * 处理器接口：
 *   参数：ctx 对象
 *     - ctx.text          消息文本
 *     - ctx.forwardMedia   是否转发媒体（可修改）
 *     - ctx.channelConfig  当前频道配置对象
 *     - ctx.message        GramJS 原始 Message 对象
 *
 *   返回值：
 *     - ctx    修改后的上下文（继续 pipeline）
 *     - null   跳过此消息，不转发
 */
export default function (ctx) {
    const firstLine = ctx.text.split('\n')[0].trim();
    if (!firstLine) return null;
    ctx.text = firstLine;
    return ctx;
}
