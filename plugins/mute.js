import { getGroupAdmins, isAdmin, getBotJids, isBotAdmin, canUseGroupGuard } from '../lib/groupUtils.js';

export default {    pattern: 'mute',
    category: 'group',
    desc: 'Group එක Mute කරනවා (Admins ලාට විතරක් Message යවන්න පුළුවන්)',
    function: async (sock, msg, { from, isGroup, isMe }) => {
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

            await sock.groupSettingUpdate(from, 'announcement');
            await sock.sendMessage(from, { text: '🔇 Group එක Mute කරන ලදී. දැන් Admins ලාට විතරයි Message යවන්න පුළුවන්.' }, { quoted: msg });
        } catch (e) {
            console.error('Mute Command Error:', e);
            await sock.sendMessage(from, { text: '❌ Error occurred while muting group.' }, { quoted: msg });
        }
    }
}
