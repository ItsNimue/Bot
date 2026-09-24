import { getGroupAdmins, isAdmin, getTargetJid, getBotJids, isBotAdmin, canUseGroupGuard } from '../lib/groupUtils.js';

export default {    pattern: 'promote',
    category: 'group',
    desc: 'Group Member කෙනෙකුව Admin කරනවා',
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

            const botJids = getBotJids(sock);
            if (!isBotAdmin(admins, botJids)) {
                return await sock.sendMessage(from, { text: '⚠️ Bot ට Admin බලය නැහැ. කරුණාකර Bot ව Group Admin කරන්න.' }, { quoted: msg });
            }

            const target = getTargetJid(msg, args);
            if (!target) {
                return await sock.sendMessage(from, { text: '⚠️ Admin කරන්න ඕනේ කෙනාව *Reply* කරන්න හෝ *Tag* කරන්න.\n\n*Example:* .promote @user' }, { quoted: msg });
            }

            if (isAdmin(admins, target)) {
                return await sock.sendMessage(from, { text: 'ℹ️ මේ කෙනා දැනටමත් Admin කෙනෙක්.' }, { quoted: msg });
            }

            await sock.groupParticipantsUpdate(from, [target], 'promote');
            await sock.sendMessage(from, {
                text: `👑 *@${target.split('@')[0]}* Group Admin කරන ලදී!`,
                mentions: [target]
            }, { quoted: msg });
        } catch (e) {
            console.error('Promote Command Error:', e);
            await sock.sendMessage(from, { text: '❌ Error occurred while promoting user.' }, { quoted: msg });
        }
    }
}
