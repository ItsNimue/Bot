import { Settings, getSettings } from '../lib/database.js';

export default {    pattern: 'settings',
    category: 'owner',
    desc: 'Manage bot configurations',
    function: async (sock, msg, { from, args, config, isMe }) => {
        try {
            if (!isMe) {
                return await sock.sendMessage(from, { text: '❌ *මෙම command එක භාවිතා කිරීමට Bot Owner ට පමණි අවසර ඇත්තේ!*' }, { quoted: msg });
            }

            const subCmd = args[0] ? args[0].toLowerCase() : '';
            const value = args[1] ? args[1].toLowerCase() : '';

            let settings = await getSettings();

            if (!subCmd) {
                const statusText = `⚙️ *${config.BOT_NAME} SETTINGS* ⚙️

🗑️ *Anti Delete:* \`${settings.antiDelete ? 'ON ✅' : 'OFF ❌'}\`
  • Send: \`${settings.antiDeleteSend}\` | Mode: \`${settings.antiDeleteMode}\`

👁️ *VV Command (.vv):*
  • Mode: \`${settings.vvMode}\` | Send: \`${settings.vvSend || 'chat'}\`

😀 *VV Emoji React/Reply:* \`${settings.vvEmoji ? 'ON ✅' : 'OFF ❌'}\`
  • Send: \`${settings.vvEmojiSend || 'chat'}\` _(chat / inbox)_

🖼️ *GetDP Command (.getdp):*
  • Mode: \`${settings.getdpMode || 'public'}\` | Send: \`${settings.getdpSend || 'chat'}\`

🔗 *Anti Link:* \`${settings.antiLink ? 'ON ✅' : 'OFF ❌'}\`
📞 *Anti Call:* \`${settings.antiCall ? 'ON ✅' : 'OFF ❌'}\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 *VV Emoji Controls:*
• \`.vve on / off\`
• \`.vves chat / inbox\`

💡 *Manual VV Controls:*
• \`.vvm public / self\`
• \`.vvs chat / inbox\`

💡 *GetDP Controls:*
• \`.settings getdpm public / self\`
• \`.settings getdps chat / inbox\`

💡 *Anti Delete Controls:*
• \`.antid on / off\`
• \`.antids chat / inbox\`
• \`.antidm public / inbox / group / self\`

💡 *Other Controls:*
• \`.antilink on / off\`
• \`.anticall on / off\``;

                return await sock.sendMessage(from, { text: statusText }, { quoted: msg });
            }

            // VV Emoji Controls (.vve on/off & .vves chat/inbox)
            if (subCmd === 'vve') {
                await Settings.updateOne({ id: 'main_settings' }, { vvEmoji: value === 'on' });
                return await sock.sendMessage(from, { text: `😀 VV Emoji Extraction: *${value === 'on' ? 'ON ✅' : 'OFF ❌'}*` }, { quoted: msg });
            }
            if (subCmd === 'vves') {
                const targetSend = value === 'inbox' ? 'inbox' : 'chat';
                await Settings.updateOne({ id: 'main_settings' }, { vvEmojiSend: targetSend });
                return await sock.sendMessage(from, { text: `📍 VV Emoji Send destination: *${targetSend === 'inbox' ? 'Own Inbox' : 'Current Chat'}*` }, { quoted: msg });
            }

            // Manual VV Controls
            if (subCmd === 'vvs') {
                const targetSend = value === 'inbox' ? 'inbox' : 'chat';
                await Settings.updateOne({ id: 'main_settings' }, { vvSend: targetSend });
                return await sock.sendMessage(from, { text: `📍 VV Send destination: *${targetSend === 'inbox' ? 'Own Inbox' : 'Current Chat'}*` }, { quoted: msg });
            }
            if (subCmd === 'vvm') {
                if (value === 'public' || value === 'self') {
                    await Settings.updateOne({ id: 'main_settings' }, { vvMode: value });
                    return await sock.sendMessage(from, { text: `👁️ VV Mode set to: *${value}*` }, { quoted: msg });
                }
            }

            // GetDP Controls (getdpm public/self & getdps chat/inbox)
            if (subCmd === 'getdpm') {
                if (value === 'public' || value === 'self') {
                    await Settings.updateOne({ id: 'main_settings' }, { getdpMode: value });
                    return await sock.sendMessage(from, { text: `🖼️ GetDP Mode set to: *${value === 'self' ? 'self (Owner only)' : 'public (Everyone)'}*` }, { quoted: msg });
                }
                return await sock.sendMessage(from, { text: '⚠️ *Usage:* .settings getdpm public / self' }, { quoted: msg });
            }
            if (subCmd === 'getdps') {
                if (value === 'chat' || value === 'inbox') {
                    await Settings.updateOne({ id: 'main_settings' }, { getdpSend: value });
                    return await sock.sendMessage(from, { text: `📍 GetDP Send destination: *${value === 'inbox' ? 'Own Inbox' : 'Current Chat'}*` }, { quoted: msg });
                }
                return await sock.sendMessage(from, { text: '⚠️ *Usage:* .settings getdps chat / inbox' }, { quoted: msg });
            }
            
            // Anti Delete Controls
            if (subCmd === 'antid') {
                await Settings.updateOne({ id: 'main_settings' }, { antiDelete: value === 'on' });
                return await sock.sendMessage(from, { text: `🗑️ Anti-Delete: *${value === 'on' ? 'ON' : 'OFF'}*` }, { quoted: msg });
            }
            if (subCmd === 'antids') {
                await Settings.updateOne({ id: 'main_settings' }, { antiDeleteSend: value === 'chat' ? 'chat' : 'inbox' });
                return await sock.sendMessage(from, { text: `📍 Anti-Delete Send: *${value === 'chat' ? 'Current Chat' : 'Own Inbox'}*` }, { quoted: msg });
            }
            if (subCmd === 'antidm') {
                await Settings.updateOne({ id: 'main_settings' }, { antiDeleteMode: value });
                return await sock.sendMessage(from, { text: `🎯 Anti-Delete Mode: *${value}*` }, { quoted: msg });
            }

            // Anti Link & Call Controls
            if (subCmd === 'antilink') {
                await Settings.updateOne({ id: 'main_settings' }, { antiLink: value === 'on' });
                return await sock.sendMessage(from, { text: `🔗 Anti-Link: *${value === 'on' ? 'ON ✅' : 'OFF ❌'}*` }, { quoted: msg });
            }
            if (subCmd === 'anticall') {
                await Settings.updateOne({ id: 'main_settings' }, { antiCall: value === 'on' });
                return await sock.sendMessage(from, { text: `📞 Anti-Call: *${value === 'on' ? 'ON ✅' : 'OFF ❌'}*` }, { quoted: msg });
            }

        } catch (e) {
            console.error('Settings Command Error:', e);
            await sock.sendMessage(from, { text: '❌ Error updating settings.' }, { quoted: msg });
        }
    }
}
