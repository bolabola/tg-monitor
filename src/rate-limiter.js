export class RateLimiter {
    constructor({ globalPerSec = 25, perChatPerMin = 18 } = {}) {
        this.globalPerSec = globalPerSec;
        this.perChatPerMin = perChatPerMin;

        this.globalTokens = globalPerSec;
        this.globalLastRefill = Date.now();

        this.chatBuckets = new Map();
    }

    async acquire(chatId) {
        await this._waitForGlobal();
        await this._waitForChat(chatId);
    }

    async _waitForGlobal() {
        this._refillGlobal();
        while (this.globalTokens < 1) {
            const waitMs = Math.ceil(1000 / this.globalPerSec);
            await sleep(waitMs);
            this._refillGlobal();
        }
        this.globalTokens -= 1;
    }

    _refillGlobal() {
        const now = Date.now();
        const elapsed = now - this.globalLastRefill;
        const refill = (elapsed / 1000) * this.globalPerSec;
        this.globalTokens = Math.min(this.globalPerSec, this.globalTokens + refill);
        this.globalLastRefill = now;
    }

    async _waitForChat(chatId) {
        const key = chatId.toString();
        let bucket = this.chatBuckets.get(key);
        if (!bucket) {
            bucket = { tokens: this.perChatPerMin, lastRefill: Date.now() };
            this.chatBuckets.set(key, bucket);
        }

        this._refillChat(bucket);
        while (bucket.tokens < 1) {
            const waitMs = Math.ceil(60000 / this.perChatPerMin);
            await sleep(waitMs);
            this._refillChat(bucket);
        }
        bucket.tokens -= 1;
    }

    _refillChat(bucket) {
        const now = Date.now();
        const elapsed = now - bucket.lastRefill;
        const refill = (elapsed / 60000) * this.perChatPerMin;
        bucket.tokens = Math.min(this.perChatPerMin, bucket.tokens + refill);
        bucket.lastRefill = now;
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

export const rateLimiter = new RateLimiter();
