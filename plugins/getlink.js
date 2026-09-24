export default {
    pattern: 'getlink',
    category: 'tools',
    desc: 'Group එකේ Invite Link එක ගන්නවා (Bot Owner ට විතරයි)',
    function: async (sock, msg, { from, isGroup, isMe }) => {
        try {
            // Bot Owner ට විතරයි
            if (!isMe) {
                return await sock.sendMessage(from, { text: '❌ *මෙම command එක භාවිතා කිරීමට Bot Owner ට පමණි අවසර ඇත්තේ!*' }, { quoted: msg });
            }

            if (!isGroup) {
                return await sock.sendMessage(from, { text: '⚠️ මේ command එක Group එකක් තුළදී විතරක් වැඩ කරන්නේ.' }, { quoted: msg });
            }

            // Admin check එකක් නැහැ - ඕනම Group එකක Link එක ඉල්ලලා බලනවා.
            const code = await sock.groupInviteCode(from);
            if (!code) {
                return await sock.sendMessage(from, { text: '❌ Error While Getting' }, { quoted: msg });
            }

            // Link එක විතරයි යවන්නේ
            await sock.sendMessage(from, { text: `https://chat.whatsapp.com/${code}` }, { quoted: msg });
        } catch (e) {
            console.error('GetLink Command Error:', e?.message || e);
            // තාවකාලික (Debug): හරිම Error එක පෙන්නනවා. Test කරලා ඉවර උනාම පහල line එක ඉවත් කරලා ඊළඟ line එක දාන්න.
            await sock.sendMessage(from, { text: `❌ Error While Getting\n${e?.message || e}` }, { quoted: msg });
            // await sock.sendMessage(from, { text: '❌ Error While Getting' }, { quoted: msg });
        }
    }
}
