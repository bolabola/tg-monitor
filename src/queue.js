import { getLastMessageId, setLastMessageId } from './state.js';
import { normalizeId } from './utils.js';

const MAX_SEEN_PER_CHANNEL = 1000;
const RETRY_DELAY_MS = 5_000;

export class MessageQueue {
    constructor({ onProcess, onGap }) {
        this.seen = new Map();
        this.queues = new Map();
        this.draining = new Set();
        this.retryTimers = new Map();
        this._gapPending = new Set();
        this.onProcess = onProcess;
        this.onGap = onGap;
    }

    enqueue(channelConfig, message, { fromFetch = false } = {}) {
        const channelId = normalizeId(channelConfig.id);
        const msgId = message.id;
        const lastId = getLastMessageId(channelId);

        if (msgId <= lastId) return false;

        let seenSet = this.seen.get(channelId);
        if (!seenSet) {
            seenSet = new Set();
            this.seen.set(channelId, seenSet);
        }
        if (seenSet.has(msgId)) return false;

        if (!fromFetch && lastId > 0 && msgId - lastId > 1
            && this.onGap && !this._gapPending.has(channelId)) {
            this._gapPending.add(channelId);
            this.onGap(channelConfig, lastId, msgId);
            setTimeout(() => this._gapPending.delete(channelId), 10_000);
        }

        seenSet.add(msgId);
        if (seenSet.size > MAX_SEEN_PER_CHANNEL) {
            const iter = seenSet.values();
            for (let i = 0; i < seenSet.size - MAX_SEEN_PER_CHANNEL; i++) {
                seenSet.delete(iter.next().value);
            }
        }

        let q = this.queues.get(channelId);
        if (!q) {
            q = [];
            this.queues.set(channelId, q);
        }
        q.push({ channelConfig, message });
        q.sort((a, b) => a.message.id - b.message.id);

        this._drain(channelId);
        return true;
    }

    _scheduleRetry(channelId) {
        if (this.retryTimers.has(channelId)) return;

        const timer = setTimeout(() => {
            this.retryTimers.delete(channelId);
            this._drain(channelId);
        }, RETRY_DELAY_MS);

        this.retryTimers.set(channelId, timer);
    }

    async _drain(channelId) {
        if (this.draining.has(channelId)) return;
        this.draining.add(channelId);

        try {
            const q = this.queues.get(channelId);
            while (q && q.length > 0) {
                const item = q.shift();
                const cid = normalizeId(item.channelConfig.id);

                if (item.message.id <= getLastMessageId(cid)) continue;

                try {
                    await this.onProcess(item.channelConfig, item.message);
                    setLastMessageId(cid, item.message.id);
                } catch (err) {
                    console.error(`处理消息失败 [${cid}] msgId=${item.message.id}:`, err.message);
                    q.unshift(item);
                    this._scheduleRetry(channelId);
                    break;
                }
            }
        } finally {
            this.draining.delete(channelId);
        }
    }
}
