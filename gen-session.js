import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'readline';
import dotenv from 'dotenv';

dotenv.config();

const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
    console.error('❌ 请先在 .env 中填写 TELEGRAM_API_ID 和 TELEGRAM_API_HASH');
    process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5
});

await client.start({
    phoneNumber: () => ask('📱 手机号 (如 +86xxx): '),
    password: () => ask('🔑 两步验证密码 (没有直接回车): '),
    phoneCode: () => ask('📨 验证码: '),
    onError: console.error
});

console.log('\n✅ 登录成功！请将以下 Session 字符串填入 .env 的 TELEGRAM_SESSION：\n');
console.log(client.session.save());
console.log();

rl.close();
await client.disconnect();
