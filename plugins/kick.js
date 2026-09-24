import { getGroupAdmins, getGroupOwner, isAdmin, getTargetJid, getBotJids, isBotAdmin, canUseGroupGuard } from '../lib/groupUtils.js';

export default {    pattern: 'kick',
    category: 'group',
    desc: 'Group Member කෙනෙකුව Kick කරනවා',
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
                return await sock.sendMessage(from, { text: '⚠️ Kick කරන්න ඕනේ කෙනාව *Reply* කරන්න හෝ *Tag* කරන්න.\n\n*Example:* .kick @user' }, { quoted: msg });
            }

            const groupOwner = await getGroupOwner(sock, from);

            if (target === groupOwner) {
                return await sock.sendMessage(from, { text: '🚫 Group එක හදපු කෙනාව (Creator) Kick කරන්න බැහැ.' }, { quoted: msg });
            }

            // Group එක හදපු කෙනාට (Creator) ඕනම Admin කෙනෙක්ව කෙලින්ම Kick කරන්න පුළුවන්.
            // අනිත් Admin ලා නම් මුලින් Demote කරලා තමයි Kick කරන්න ඕනේ.
            if (isAdmin(admins, target) && sender !== groupOwner) {
                return await sock.sendMessage(from, { text: '🚫 Group Admin කෙනෙක්ව Kick කරන්න බැහැ. මුලින් Demote කරන්න.' }, { quoted: msg });
            }

            await sock.groupParticipantsUpdate(from, [target], 'remove');
            await sock.sendMessage(from, {
                text: `✅ *@${target.split('@')[0]}* Group එකෙන් ඉවත් කරන ලදී.`,
                mentions: [target]
            }, { quoted: msg });
        } catch (e) {
            console.error('Kick Command Error:', e);
            await sock.sendMessage(from, { text: '❌ Error occurred while kicking user. Bot ට Admin බලය තියෙනවද කියලා බලන්න.' }, { quoted: msg });
        }
    }
}
