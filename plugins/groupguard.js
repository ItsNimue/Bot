import { Settings, getSettings } from '../lib/database.js';

export default {    pattern: 'groupguard',
    category: 'owner',
    desc: 'Kick/Promote/Demote/Mute/Unmute/Kickall/Add/SetDes/Warn Commands පාවිච්චි කරන්න පුළුවන් කවුද කියලා සකසනවා',
    function: async (sock, msg, { from, args, isMe }) => {
        try {
            // .groupguard command එක Bot Owner ට විතරයි
            if (!isMe) {
                return await sock.sendMessage(from, { text: '❌ *මෙම command එක භාවිතා කිරීමට Bot Owner ට පමණි අවසර ඇත්තේ!*' }, { quoted: msg });
            }

            const mode = args[0] ? args[0].toLowerCase() : '';

            if (mode !== 'admins' && mode !== 'self') {
                const settings = await getSettings();
                const current = settings.groupGuardMode || 'admins';
                return await sock.sendMessage(from, {
                    text: `🛡️ *GROUP GUARDIAN MODE*\n\nදැනට තියෙන Mode: \`${current}\`\n\n📌 *admins* — Group Admins + Bot Owner ට Kick/Promote/Demote/Mute/Unmute/Kickall/Add/SetDes/Warn/WarnLimit/ResetWarn Commands පාවිච්චි කරන්න පුළුවන්.\n📌 *self* — Bot Owner ට විතරක් පුළුවන් (Group Admins ලාටත් බැහැ).\n\n*Usage:* .groupguard admins / self`
                }, { quoted: msg });
            }

            await Settings.updateOne({ id: 'main_settings' }, { groupGuardMode: mode }, { upsert: true });
            await sock.sendMessage(from, {
                text: `🛡️ Group Guardian Mode: *${mode}* ලෙස සකසන ලදී.\n\n${mode === 'self'
                    ? 'දැන් Kick/Promote/Demote/Mute/Unmute/Kickall/Add/SetDes/Warn Commands ටික Bot Owner ට විතරයි.'
                    : 'දැන් Group Admins ලාටත් Kick/Promote/Demote/Mute/Unmute/Kickall/Add/SetDes/Warn Commands පාවිච්චි කරන්න පුළුවන්.'}`
            }, { quoted: msg });
        } catch (e) {
            console.error('GroupGuard Command Error:', e);
            await sock.sendMessage(from, { text: '❌ Error occurred while setting group guard mode.' }, { quoted: msg });
        }
    }
}
