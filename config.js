import 'dotenv/config';

export default {
    PORT: Number(process.env.PORT || 3000),
    BOT_NAME: process.env.BOT_NAME || 'MrNobody',
    PREFIX: process.env.PREFIX || '.',
    PAIR_BACKEND_URL: String(process.env.PAIR_BACKEND_URL || '').replace(/\/+$/, ''),
    INTERNAL_API_TOKEN: process.env.INTERNAL_API_TOKEN || '',
    WATERMARK: process.env.WATERMARK || 'MrNobody Serenity',
    OWNER_NUMBER: process.env.OWNER_NUMBER || '947XXXXXXXX',
    MODE: process.env.MODE || 'public',
    SESSION_ID: process.env.SESSION_ID || ''
};
