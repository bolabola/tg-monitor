function isVideoMessage(message) {
    const media = message?.media;
    if (media?.className !== 'MessageMediaDocument') return false;

    const doc = media.document;
    if (!doc) return false;

    const mime = doc.mimeType || '';
    const attrs = doc.attributes || [];

    return mime.startsWith('video/') || attrs.some(attr => attr.className === 'DocumentAttributeVideo');
}

/**
 * 禁止视频处理器 — 视频消息只转发文本/说明，不转发视频文件
 */
export default function (ctx) {
    if (isVideoMessage(ctx.message)) {
        ctx.forwardMedia = false;
    }

    return ctx;
}
