import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { getGroupAdmins, isAdmin, getBotJids, isBotAdmin, canUseGroupGuard } from '../lib/groupUtils.js';

// එකවර Add කරන්න පුළුවන් උපරිම Numbers ගණන (WhatsApp Ban වෙන Risk එක අඩු කරන්න)
const MAX_ADD = 10;

export default {    pattern: 'add',
    category: 'group',
    desc: 'Group එකට Member කෙනෙක් හෝ Members ලා Add කරනවා',
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

            // Numbers ටික වෙන් කරගැනීම (space හෝ comma වලින් වෙන් කරලා දෙන්න පුළුවන්)
            const numbers = [...new Set(
                args.join(' ')
                    .split(/[\s,]+/)
                    .map(n => n.replace(/[^0-9]/g, ''))
                    .filter(n => n.length >= 8 && n.length <= 15)
            )];

            if (numbers.length === 0) {
                return await sock.sendMessage(from, {
                    text: '⚠️ Add කරන්න ඕනේ Number එක (හෝ Numbers) දෙන්න. Country code එකත් එක්ක, space නැතුව ලියන්න.\n\n*Example:*\n.add 94771234567\n.add 94771234567 94712345678'
                }, { quoted: msg });
            }

            if (numbers.length > MAX_ADD) {
                return await sock.sendMessage(from, { text: `⚠️ එකවර Add කරන්න පුළුවන් උපරිම Numbers ${MAX_ADD} යි.` }, { quoted: msg });
            }

            // Numbers WhatsApp එකේ තියෙනවද බලනවා
            let jids = numbers.map(n => `${n}@s.whatsapp.net`);
            let notOnWhatsApp = [];
            try {
                const check = await sock.onWhatsApp(...jids);
                const found = (check || []).filter(r => r.exists);
                notOnWhatsApp = numbers.filter(n => !found.some(r => r.jid.startsWith(n)));
                jids = found.map(r => jidNormalizedUser(r.jid));
            } catch (checkErr) {
                console.error('Add - onWhatsApp Check Error:', checkErr.message);
                // Check කරන්න බැරි උනොත් දීපු Numbers ම පාවිච්චි කරනවා
            }

            // දැනටමත් Group එකේ ඉන්න අය අයින් කරනවා
            const metadata = await sock.groupMetadata(from);
            const members = metadata.participants.map(p => jidNormalizedUser(p.id));
            const already = jids.filter(j => members.includes(j));
            const toAdd = jids.filter(j => !members.includes(j));

            const added = [];
            const privacy = [];
            const recentlyLeft = [];
            const failed = [];

            if (toAdd.length > 0) {
                const results = await sock.groupParticipantsUpdate(from, toAdd, 'add');

                for (const r of results || []) {
                    const jid = r.jid;
                    if (!jid) continue;
                    switch (String(r.status)) {
                        case '200': added.push(jid); break;
                        case '403': privacy.push(jid); break;
                        case '408': recentlyLeft.push(jid); break;
                        case '409': already.push(jid); break;
                        default: failed.push(jid);
                    }
                }
            }

            // Result Message එක හදනවා (තියෙන Sections විතරක් පෙන්නනවා)
            const tag = j => `@${j.split('@')[0]}`;
            const sections = [];

            if (added.length) sections.push(`✅ *Add කරන ලදී:*\n${added.map(tag).join('\n')}`);
            if (already.length) sections.push(`ℹ️ *දැනටමත් Group එකේ ඉන්නවා:*\n${already.map(tag).join('\n')}`);
            if (privacy.length) sections.push(`🔒 *Privacy Settings නිසා Add කරන්න බැරි උනා (Group Link එකෙන් Join වෙන්න කියන්න):*\n${privacy.map(tag).join('\n')}`);
            if (recentlyLeft.length) sections.push(`⏳ *මෑතදී Group එකෙන් ඉවත් වෙලා තියෙනවා (පස්සේ Add කරන්න):*\n${recentlyLeft.map(tag).join('\n')}`);
            if (failed.length) sections.push(`❌ *Add කරන්න බැරි උනා:*\n${failed.map(tag).join('\n')}`);
            if (notOnWhatsApp.length) sections.push(`📵 *WhatsApp එකේ නැහැ:*\n${notOnWhatsApp.join('\n')}`);

            if (sections.length === 0) sections.push('ℹ️ කිසිම Member කෙනෙක් Add කරන්න බැරි උනා.');

            await sock.sendMessage(from, {
                text: `👥 *ADD RESULT*\n\n${sections.join('\n\n')}`,
                mentions: [...added, ...already, ...privacy, ...recentlyLeft, ...failed]
            }, { quoted: msg });
        } catch (e) {
            console.error('Add Command Error:', e);
            await sock.sendMessage(from, { text: '❌ Error occurred while adding members. Bot ට Admin බලය තියෙනවද කියලා බලන්න.' }, { quoted: msg });
        }
    }
}
