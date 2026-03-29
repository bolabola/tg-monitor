/**
 * 禁止媒体处理器 — 仅转发文本，不转发图片/视频/文件等
 *
 * 设置 ctx.forwardMedia = false，后续流程将跳过媒体下载与转发
 */
export default function (ctx) {
    ctx.forwardMedia = false;
    return ctx;
}
