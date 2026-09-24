import { getGroupAdmins, isAdmin, getBotJids, isBotAdmin, canUseGroupGuard } from '../lib/groupUtils.js';

// WhatsApp Group Description එකට අකුරු 2048 ක් දක්වා දාන්න පුළුවන්
const MAX_DESC_LENGTH = 2048;

export default {    pattern: 'setdes',
    category: 'group',
    desc: 'Group එකේ Description එක වෙනස් කරනවා',
    function: async (sock, msg, { from, text, config, isGroup, isMe }) => {
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

            // Command එකට පස්සේ තියෙන Text එක (Line breaks / spaces ඒ විදිහටම තියාගන්නවා)
            let description = text.slice(config.PREFIX.length).trim().replace(/^\S+\s*/, '').trim();

            // Text එකක් නැත්නම් Reply කරපු Message එකේ Text එක පාවිච්චි කරනවා
            if (!description) {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                description = (quoted?.conversation || quoted?.extendedTextMessage?.text || '').trim();
            }

            if (!description) {
                return await sock.sendMessage(from, {
                    text: '⚠️ අලුත් Description එක ලියන්න, නැත්නම් Text Message එකකට *Reply* කරන්න.\n\n*Example:* .setdes අපේ Group එකට සාදරයෙන් පිළිගන්නවා!'
                }, { quoted: msg });
            }

            if (description.length > MAX_DESC_LENGTH) {
                return await sock.sendMessage(from, {
                    text: `⚠️ Description එක දිග වැඩියි. උපරිම අකුරු ${MAX_DESC_LENGTH} යි. (දැන් ${description.length})`
                }, { quoted: msg });
            }

            await sock.groupUpdateDescription(from, description);
            await sock.sendMessage(from, { text: '✅ Group Description එක අලුත් කරන ලදී.' }, { quoted: msg });
        } catch (e) {
            console.error('SetDes Command Error:', e);
            await sock.sendMessage(from, { text: '❌ Error occurred while updating group description. Bot ට Admin බලය තියෙනවද කියලා බලන්න.' }, { quoted: msg });
        }
    }
}
