import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { getGroupAdmins, isAdmin, getBotJids, isBotAdmin, canUseGroupGuard } from '../lib/groupUtils.js';

export default {    pattern: 'kickall',
    category: 'group',
    desc: 'Group එකේ Admin නොවන සියලුම Members ලා Kick කරනවා (භයානකයි!)',
    function: async (sock, msg, { from, args, isGroup, isMe }) => {
        try {
            if (!isGroup) {
                return await sock.sendMessage(from, { text: '⚠️ මේ command එක Group එකක් තුළදී විතරක් වැඩ කරන්නේ.' }, { quoted: msg });
            }

            const admins = await getGroupAdmins(sock, from);
            const sender = msg.key.participant || msg.key.remoteJid;

            // kickall ට Owner (isMe) හෝ Group Admin විතරයි - Safety සදහා
            if (!(await canUseGroupGuard(sender, isMe, admins))) {
                return await sock.sendMessage(from, { text: '🚫 මේ command එක පාවිච්චි කරන්න ඔයාට අවසර නැහැ.' }, { quoted: msg });
            }

            const botJids = getBotJids(sock);
            if (!isBotAdmin(admins, botJids)) {
                return await sock.sendMessage(from, { text: '⚠️ Bot ට Admin බලය නැහැ. කරුණාකර Bot ව Group Admin කරන්න.' }, { quoted: msg });
            }

            // Accidental Kick වළක්වන්න Confirmation Step එකක්
            if (!args[0] || args[0].toLowerCase() !== 'confirm') {
                return await sock.sendMessage(from, {
                    text: `⚠️ *භයානක Command එකක්!*\n\nමේකෙන් Group එකේ Admin නොවන සියලුම Members ලා Kick වෙනවා. මේක *පසුව අස් කරන්න බැහැ.*\n\nහරියටම කරන්න ඕනේනම් type කරන්න:\n👉 *.kickall confirm*`
                }, { quoted: msg });
            }

            const metadata = await sock.groupMetadata(from);
            const targets = metadata.participants
                .map(p => jidNormalizedUser(p.id))
                .filter(id => !botJids.includes(id) && !admins.includes(id));

            if (targets.length === 0) {
                return await sock.sendMessage(from, { text: 'ℹ️ Kick කරන්න Members නැහැ (හැමෝම Admins).' }, { quoted: msg });
            }

            await sock.sendMessage(from, { text: `🔨 Members ${targets.length} ක් Kick කරනවා... මදක් ඉන්න.` }, { quoted: msg });

            let successCount = 0;
            for (const jid of targets) {
                try {
                    await sock.groupParticipantsUpdate(from, [jid], 'remove');
                    successCount++;
                    await new Promise(r => setTimeout(r, 1000)); // WhatsApp Rate-Limit / Ban වළක්වන්න Delay එකක්
                } catch (err) {
                    console.error(`KickAll - ${jid} Kick Error:`, err.message);
                }
            }

            await sock.sendMessage(from, { text: `✅ Members ${successCount}/${targets.length} ක් Kick කරන ලදී.` });
        } catch (e) {
            console.error('KickAll Command Error:', e);
            await sock.sendMessage(from, { text: '❌ Error occurred while running kickall.' }, { quoted: msg });
        }
    }
}
