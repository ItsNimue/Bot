import { getGroupAdmins, isAdmin, getTargetJid, getBotJids, isBotAdmin, canUseGroupGuard } from '../lib/groupUtils.js';
import { addWarning, resetWarning } from '../lib/warnings.js';
import { getSettings } from '../lib/database.js';

export default {    pattern: 'warn',
    category: 'group',
    desc: 'Group Member කෙනෙකුට Warning එකක් දෙනවා. Limit එකට ගියොත් Auto Kick වෙනවා',
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
                return await sock.sendMessage(from, { text: '⚠️ Warn කරන්න ඕනේ කෙනාව *Reply* කරන්න හෝ *Tag* කරන්න.\n\n*Example:* .warn @user spam කරන එක' }, { quoted: msg });
            }

            if (isAdmin(admins, target)) {
                return await sock.sendMessage(from, { text: '🚫 Group Admin කෙනෙක්ට Warning දෙන්න බැහැ.' }, { quoted: msg });
            }

            const settings = await getSettings();
            const warnLimit = settings.warnLimit || 3;
            const reason = (args[0] && args[0].startsWith('@')) ? args.slice(1).join(' ') : args.slice(1).join(' ');
            const reasonText = reason || 'Reason සදහන් කර නැත';

            const count = await addWarning(from, target);

            if (count >= warnLimit) {
                await sock.sendMessage(from, {
                    text: `🔨 *@${target.split('@')[0]}* Warning Limit (${warnLimit}/${warnLimit}) එක පනිලා ඉවරයි!\n👉 Group එකෙන් ඉවත් කරනවා...`,
                    mentions: [target]
                });

                const botJids = getBotJids(sock);
                if (!isBotAdmin(admins, botJids)) {
                    return await sock.sendMessage(from, { text: '⚠️ Bot ට Admin බලය නැහැ නිසා Kick කරන්න බැරි උනා. කරුණාකර Bot ව Group Admin කරන්න.' }, { quoted: msg });
                }

                try {
                    await sock.groupParticipantsUpdate(from, [target], 'remove');
                    await resetWarning(from, target);
                    await sock.sendMessage(from, {
                        text: `✅ *@${target.split('@')[0]}* Group එකෙන් ඉවත් කරන ලදී.`,
                        mentions: [target]
                    });
                } catch (kickErr) {
                    console.error('Auto-Kick Error:', kickErr.message);
                    await sock.sendMessage(from, { text: '❌ Kick කරන්න බැරි උනා. Bot ට Admin බලය තියෙනවද කියලා බලන්න.' });
                }
            } else {
                await sock.sendMessage(from, {
                    text: `⚠️ *@${target.split('@')[0]}* ට Warning එකක් ලැබුනා!\n\n📝 *Reason:* ${reasonText}\n🔢 *Warnings:* ${count}/${warnLimit}\n\n_Warning ${warnLimit} ට ගියොත් Group එකෙන් Auto Kick වෙනවා._`,
                    mentions: [target]
                }, { quoted: msg });
            }
        } catch (e) {
            console.error('Warn Command Error:', e);
            await sock.sendMessage(from, { text: '❌ Error occurred while warning user.' }, { quoted: msg });
        }
    }
}
