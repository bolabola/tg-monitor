import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const loadChannelConfig = () => {
    const configPath = path.resolve(__dirname, '../channels.config.json');
    try {
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        }
    } catch (error) {
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
