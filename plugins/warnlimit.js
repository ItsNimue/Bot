import { getGroupAdmins, isAdmin, canUseGroupGuard } from '../lib/groupUtils.js';
import { Settings } from '../lib/database.js';

export default {    pattern: 'warnlimit',
    category: 'group',
    desc: 'Auto-Kick වෙන්න ඕනේ Warning Limit එක Set කරනවා',
    function: async (sock, msg, { from, args, isGroup, isMe }) => {
        try {
            if (isGroup) {
                const admins = await getGroupAdmins(sock, from);
                const sender = msg.key.participant || msg.key.remoteJid;
                if (!(await canUseGroupGuard(sender, isMe, admins))) {
                    return await sock.sendMessage(from, { text: '🚫 මේ command එක පාවිච්චි කරන්න ඔයාට අවසර නැහැ.' }, { quoted: msg });
                }
            } else if (!isMe) {
                return await sock.sendMessage(from, { text: '🚫 මේ command එක Bot Owner ට විතරයි.' }, { quoted: msg });
            }

            const num = parseInt(args[0]);
            if (!num || num < 1) {
                return await sock.sendMessage(from, { text: '⚠️ *Usage:* .warnlimit <number>\n*Example:* .warnlimit 3' }, { quoted: msg });
            }

            await Settings.updateOne({ id: 'main_settings' }, { warnLimit: num });
            await sock.sendMessage(from, { text: `✅ Warning Limit *${num}* ලෙස සකසන ලදී.` }, { quoted: msg });
        } catch (e) {
            console.error('Warn Limit Error:', e);
            await sock.sendMessage(from, { text: '❌ Error occurred while setting warn limit.' }, { quoted: msg });
        }
    }
}
