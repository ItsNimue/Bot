import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { getSettings } from '../lib/database.js';

export default {    pattern: 'vv',
    category: 'tools',
    desc: 'Extract quoted ViewOnce media',
    function: async (sock, msg, { from, isMe }) => {
        try {
            const settings = await getSettings();
            const vvMode = settings.vvMode || 'public';
            const vvSend = settings.vvSend || 'chat';

            // Self mode check
            if (vvMode === 'self' && !isMe) {
                return await sock.sendMessage(from, { text: '❌ *මෙම command එක භාවිතා කිරීමට Bot Owner ට පමණි අවසර ඇත්තේ!*' }, { quoted: msg });
            }

            // Quoted message check
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) {
                return await sock.sendMessage(from, { text: '⚠️ *කරුණාකර View Once message එකකට Reply කර .vv ලෙස ලබාදෙන්න!*' }, { quoted: msg });
            }

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

            if (!validTypes.includes(mediaType)) {
                return await sock.sendMessage(from, { text: '❌ *ඔයා Reply කළේ View Once Photo / Video / Audio එකකට නෙවෙයි!*' }, { quoted: msg });
            }

            const mediaMsg = targetMsg[mediaType];

            // Target destination selection (Current Chat vs Own Inbox)
            let destination = from;
            if (vvSend === 'inbox') {
                destination = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            }

            const buffer = await downloadMediaMessage(
                { message: targetMsg },
                'buffer',
                {}
            );

            const caption = `👁️ *VIEW-ONCE EXTRACTED* 👁️\n\n📝 *Caption:* ${mediaMsg.caption || 'No Caption'}`;

            if (mediaType === 'imageMessage') {
                await sock.sendMessage(destination, { image: buffer, caption }, { quoted: msg });
            } else if (mediaType === 'videoMessage') {
                await sock.sendMessage(destination, { video: buffer, caption }, { quoted: msg });
            } else if (mediaType === 'audioMessage') {
                await sock.sendMessage(destination, { audio: buffer, mimetype: 'audio/mp4', ptt: true }, { quoted: msg });
            }

            // Silent execution: Inbox එකට විතරක් යවන විට chat එකට කිසිම confirmation message එකක් යන්නේ නැත.

        } catch (error) {
            console.error('VV Command Error:', error);
            await sock.sendMessage(from, { text: '❌ View Once මාධ්‍ය සටහන ලබාගැනීමට නොහැකි විය.' }, { quoted: msg });
        }
    }
}