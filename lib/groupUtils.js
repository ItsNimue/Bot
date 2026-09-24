// lib/groupUtils.js
// Group Guardian features (warn, antilink, welcome ආදිය) වලට පොදුවේ 
// පාවිච්චි කරන Helper Functions මෙතන තියෙන්නේ.

import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { getSettings } from './database.js';

// Group එකේ Admins ලාගේ JID List එක ලබාගැනීම
async function getGroupAdmins(sock, groupId) {
    const metadata = await sock.groupMetadata(groupId);
    return metadata.participants
        .filter(p => p.admin !== null && p.admin !== undefined)
        .map(p => jidNormalizedUser(p.id));
}

// Group එක හදපු කෙනා (Creator) ගේ JID එක ලබාගැනීම.
// WhatsApp එකේදී 'superadmin' කියන Admin Type එක තියෙන්නේ Creator ට විතරයි.
// Creator ව කවුරුත් (Bot එකෙන් හෝ) Demote/Kick කරන්න බෑ - WhatsApp එකෙන්ම ඒක Block කරනවා.
async function getGroupOwner(sock, groupId) {
    const metadata = await sock.groupMetadata(groupId);
    const owner = metadata.participants.find(p => p.admin === 'superadmin');
    if (owner) return jidNormalizedUser(owner.id);
    return metadata.owner ? jidNormalizedUser(metadata.owner) : null;
}

// Admin ලයිස්ට් එකේ මේ userId එක තියෙනවද කියලා බලනවා
function isAdmin(admins, userId) {
    if (!userId) return false;
    return admins.includes(userId);
}

// Reply කරපු කෙනා / Tag කරපු කෙනා / Number එක arg එකෙන් - Target JID එක සොයාගැනීම
function getTargetJid(msg, args) {
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;

    if (contextInfo?.mentionedJid?.length) {
        return jidNormalizedUser(contextInfo.mentionedJid[0]);
    }
    if (contextInfo?.participant) {
        return jidNormalizedUser(contextInfo.participant);
    }
    if (args[0]) {
        const num = args[0].replace(/[^0-9]/g, '');
        if (num.length > 5) return `${num}@s.whatsapp.net`;
    }
    return null;
}

// Bot එකේම JID (Baileys 6.7+ වල WhatsApp @lid format එකත් පාවිච්චි කරන නිසා,
// @s.whatsapp.net සහ @lid දෙකම check කරන්න ඕනේ - නැත්නම් Bot Admin කරලා තිබුනත්
// "Bot ට Admin බලය නැහැ" කියලා වැරදි විදිහට එනවා)
function getBotJids(sock) {
    const ids = [];
    if (sock.user?.id) ids.push(jidNormalizedUser(sock.user.id));
    if (sock.user?.lid) ids.push(jidNormalizedUser(sock.user.lid));
    return ids;
}

// admins ලයිස්ට් එකේ Bot එකේ JID (දෙකෙන් එකක් හරි) තියෙනවද කියලා බලනවා
function isBotAdmin(admins, botJids) {
    return botJids.some(jid => admins.includes(jid));
}

// Group Guardian Commands (kick/promote/demote/mute/unmute/kickall/add/setdes/warn ආදිය)
// පාවිච්චි කරන්න පුළුවන්ද කියලා .groupguard setting එක අනුව බලනවා.
// Bot Owner ට හැම විටම පුළුවන්. "admins" Mode නම් Group Admins ලාටත් පුළුවන්.
// "self" Mode නම් Bot Owner ට විතරයි.
async function canUseGroupGuard(sender, isMe, admins) {
    if (isMe) return true;
    const settings = await getSettings();
    const mode = settings.groupGuardMode || 'admins';
    if (mode === 'self') return false;
    return isAdmin(admins, sender);
}

export { getGroupAdmins, getGroupOwner, isAdmin, getTargetJid, getBotJids, isBotAdmin, canUseGroupGuard }
