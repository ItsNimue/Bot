import { getGroupAdmins, isAdmin, getTargetJid, canUseGroupGuard } from '../lib/groupUtils.js';
import { resetWarning } from '../lib/warnings.js';

export default {    pattern: 'resetwarn',
    category: 'group',
    desc: 'Group Member කෙනෙකුගේ Warnings සියල්ල Reset කරනවා',
    function: async (sock, msg, { from, args, isGroup, isMe }) => {
        try {
            if (!isGroup) {
                return await sock.sendMessage(from, { text: '⚠️ මේ command එක Group එකක් තුළදී විතරක් වැඩ කරන්නේ.' }, { quoted: msg });
            }

            const admins = await getGroupAdmins(sock, from);
            const sender = msg.key.participant || msg.key.remoteJid;

            if (!(await canUseGroupGuard(sender, isMe, admins))) {
                return await sock.sendMessage(from, { text: '🚫 මේ command එක පාවිච්චි කරන්න ඔයාට අවසර නැහැ.' }, { quoted: msg });
            }

            const target = getTargetJid(msg, args);
            if (!target) {
                return await sock.sendMessage(from, { text: '⚠️ Reset කරන්න ඕනේ කෙනාව *Reply* කරන්න හෝ *Tag* කරන්න.\n\n*Example:* .resetwarn @user' }, { quoted: msg });
            }

            await resetWarning(from, target);
            await sock.sendMessage(from, {
                text: `✅ *@${target.split('@')[0]}* ගේ Warnings සියල්ල Reset කරන ලදී.`,
                mentions: [target]
            }, { quoted: msg });
        } catch (e) {
            console.error('Reset Warn Error:', e);
            await sock.sendMessage(from, { text: '❌ Error occurred while resetting warnings.' }, { quoted: msg });
        }
    }
}
