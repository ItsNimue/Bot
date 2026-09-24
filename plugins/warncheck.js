import { getTargetJid } from '../lib/groupUtils.js';
import { getWarningCount } from '../lib/warnings.js';
import { getSettings } from '../lib/database.js';

export default {    pattern: 'warnings',
    category: 'group',
    desc: 'Group Member කෙනෙකුගේ Warning ගණන බලනවා',
    function: async (sock, msg, { from, args, isGroup }) => {
        try {
            if (!isGroup) {
                return await sock.sendMessage(from, { text: '⚠️ මේ command එක Group එකක් තුළදී විතරක් වැඩ කරන්නේ.' }, { quoted: msg });
            }

            const sender = msg.key.participant || msg.key.remoteJid;
            const target = getTargetJid(msg, args) || sender;

            const settings = await getSettings();
            const warnLimit = settings.warnLimit || 3;
            const count = await getWarningCount(from, target);

            await sock.sendMessage(from, {
                text: `⚠️ *@${target.split('@')[0]}* ගේ Warnings: *${count}/${warnLimit}*`,
                mentions: [target]
            }, { quoted: msg });
        } catch (e) {
            console.error('Warnings Check Error:', e);
            await sock.sendMessage(from, { text: '❌ Error occurred while checking warnings.' }, { quoted: msg });
        }
    }
}
