import { getGroupAdmins, getGroupOwner, isAdmin, getTargetJid, getBotJids, isBotAdmin, canUseGroupGuard } from '../lib/groupUtils.js';

export default {    pattern: 'demote',
    category: 'group',
    desc: 'Group Admin කෙනෙකුගේ Admin බලය අයින් කරනවා',
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
                return await sock.sendMessage(from, { text: '⚠️ Demote කරන්න ඕනේ කෙනාව *Reply* කරන්න හෝ *Tag* කරන්න.\n\n*Example:* .demote @user' }, { quoted: msg });
            }

            if (!isAdmin(admins, target)) {
                return await sock.sendMessage(from, { text: 'ℹ️ මේ කෙනා Admin කෙනෙක් නෙවෙයි.' }, { quoted: msg });
            }

            const groupOwner = await getGroupOwner(sock, from);
            if (target === groupOwner) {
                return await sock.sendMessage(from, { text: '🚫 Group එක හදපු කෙනාව (Creator) Demote කරන්න බැහැ.' }, { quoted: msg });
            }

            await sock.groupParticipantsUpdate(from, [target], 'demote');
            await sock.sendMessage(from, {
                text: `⬇️ *@${target.split('@')[0]}* ගේ Admin බලය අයින් කරන ලදී.`,
                mentions: [target]
            }, { quoted: msg });
        } catch (e) {
            console.error('Demote Command Error:', e);
            await sock.sendMessage(from, { text: '❌ Error occurred while demoting user.' }, { quoted: msg });
        }
    }
}
