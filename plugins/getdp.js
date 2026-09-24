import { getSettings } from '../lib/database.js';

// Number එකක් වලංගුද බලනවා (Country code එකත් එක්ක, ඉලක්කම් විතරක්). Ex: 94771234567
function parseNumber(raw) {
    const num = (raw || '').replace(/[^0-9]/g, '');
    if (num.length < 8 || num.length > 15) return null;
    return num;
}

// DP එක ගන්නවා. Full Image එක බැරි උනොත් Preview (කුඩා) එක try කරනවා
async function fetchDp(sock, jid) {
    try {
        return await sock.profilePictureUrl(jid, 'image');
    } catch {
        try {
            return await sock.profilePictureUrl(jid, 'preview');
        } catch {
            return null;
        }
    }
}

export default {    pattern: 'getdp',
    category: 'tools',
    desc: 'User කෙනෙකුගේ හෝ Group එකේ Profile Picture එක ගන්නවා',
    function: async (sock, msg, { from, args, isGroup, isMe }) => {
        try {
            const settings = await getSettings();
            const dpMode = settings.getdpMode || 'public';
            const dpSend = settings.getdpSend || 'chat';

            // Self mode check (.settings getdpm self)
            if (dpMode === 'self' && !isMe) {
                return await sock.sendMessage(from, { text: '❌ *මෙම command එක භාවිතා කිරීමට Bot Owner ට පමණි අවසර ඇත්තේ!*' }, { quoted: msg });
            }

            const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
            let target = null;

            if (contextInfo?.mentionedJid?.length) {
                // 1) Tag කරපු කෙනා
                target = contextInfo.mentionedJid[0];
            } else if (args[0]) {
                // 2) Number එකක් දීලා නම් (.getdp 94771234567)
                const num = parseNumber(args[0]);
                if (!num) {
                    return await sock.sendMessage(from, {
                        text: '⚠️ Number එක වැරදියි. Country code එකත් එක්ක ඉලක්කම් විතරක් දෙන්න.\n\n*Example:* .getdp 94771234567'
                    }, { quoted: msg });
                }

                // Number එක WhatsApp එකේ තියෙනවද බලනවා
                target = `${num}@s.whatsapp.net`;
                try {
                    const check = await sock.onWhatsApp(target);
                    const found = (check || []).find(r => r.exists);
                    if (!found) {
                        return await sock.sendMessage(from, { text: `❌ *${num}* මේ Number එක WhatsApp එකේ නැහැ.` }, { quoted: msg });
                    }
                    target = found.jid || target;
                } catch (checkErr) {
                    // Check කරන්න බැරි උනොත් Number එකම පාවිච්චි කරලා ඉස්සරහට යනවා
                }
            } else if (contextInfo?.participant) {
                // 3) Reply කරපු කෙනා
                target = contextInfo.participant;
            } else {
                // 4) කිසිම දෙයක් නැත්නම් - Group එකේනම් Group DP එක, Private නම් Chat එකේ කෙනාගේ DP එක
                target = from;
            }

            const ppUrl = await fetchDp(sock, target);
            if (!ppUrl) {
                return await sock.sendMessage(from, {
                    text: '❌ Profile Picture එකක් සොයාගන්න බැරි උනා. (Set කරලා නැති එකක් හෝ Private කරලා තියෙන්න පුළුවන්)'
                }, { quoted: msg });
            }

            // Destination selection (Current Chat vs Own Inbox) - .settings getdps chat/inbox
            let destination = from;
            if (dpSend === 'inbox') {
                destination = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            }

            const isUser = !target.endsWith('@g.us');
            const caption = isUser
                ? `🖼️ *Profile Picture*\n👤 @${target.split('@')[0]}`
                : '🖼️ *Group Display Picture*';

            await sock.sendMessage(destination, {
                image: { url: ppUrl },
                caption,
                mentions: isUser ? [target] : []
            }, destination === from ? { quoted: msg } : {});

            // Inbox එකට විතරක් යවන විට chat එකට කිසිම confirmation message එකක් යන්නේ නැත.

        } catch (e) {
            console.error('GetDP Command Error:', e);
            await sock.sendMessage(from, { text: '❌ Error occurred while fetching profile picture.' }, { quoted: msg });
        }
    }
}
