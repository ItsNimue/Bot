import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { getSettings } from './database.js';

// Unicode Emoji Detector Regex
const emojiRegex = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Component})+$/u;

async function handleVvEmoji(sock, msg) {
    try {
        const isMe = msg.key.fromMe;
        if (!isMe) return;

        const settings = await getSettings();
        if (!settings.vvEmoji) return; // .vve on කර ඇත්නම් පමණක් වැඩ කරයි

        const from = msg.key.remoteJid;
        const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();

        if (!text || !emojiRegex.test(text)) return;

        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quoted) return;

        // ViewOnce Structure Extractor (Direct and Wrapped structures)
        let targetMsg = quoted;
        if (quoted.viewOnceMessage?.message) {
            targetMsg = quoted.viewOnceMessage.message;
        } else if (quoted.viewOnceMessageV2?.message) {
            targetMsg = quoted.viewOnceMessageV2.message;
        } else if (quoted.viewOnceMessageV2Extension?.message) {
            targetMsg = quoted.viewOnceMessageV2Extension.message;
        }

        const mediaType = Object.keys(targetMsg)[0];
        const validTypes = ['imageMessage', 'videoMessage', 'audioMessage'];
        if (!validTypes.includes(mediaType)) return;

        const mediaMsg = targetMsg[mediaType];

        // Destination Selection (chat / inbox)
        let destination = from;
        if (settings.vvEmojiSend === 'inbox') {
            destination = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        }

        const buffer = await downloadMediaMessage(
            { message: targetMsg },
            'buffer',
            {}
        );

        const caption = `👁️ *VIEW-ONCE EXTRACTED (EMOJI)* 👁️\n\n📝 *Caption:* ${mediaMsg.caption || 'No Caption'}`;

        if (mediaType === 'imageMessage') {
            await sock.sendMessage(destination, { image: buffer, caption }, { quoted: msg });
        } else if (mediaType === 'videoMessage') {
            await sock.sendMessage(destination, { video: buffer, caption }, { quoted: msg });
        } else if (mediaType === 'audioMessage') {
            await sock.sendMessage(destination, { audio: buffer, mimetype: 'audio/mp4', ptt: true }, { quoted: msg });
        }

    } catch (error) {
        console.error('VV Emoji Handler Error:', error);
    }
}

export { handleVvEmoji }