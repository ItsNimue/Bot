import { getSettings } from './database.js';

async function handleAntiLink(sock, msg) {
    try {
        if (!msg || !msg.message) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        if (!isGroup) return; // Group වලට පමණි

        const settings = await getSettings();
        if (!settings.antiLink) return;

        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     msg.message.imageMessage?.caption || 
                     msg.message.videoMessage?.caption || '';

        // WhatsApp Group Links / HTTP Links Regex
        const linkRegex = /(chat\.whatsapp\.com\/[a-zA-Z0-9]|https?:\/\/[^\s]+)/gi;

        if (linkRegex.test(text)) {
            // Admin Check (Sender Admin ද බලයි)
            const groupMetadata = await sock.groupMetadata(from);
            const participants = groupMetadata.participants;
            const sender = msg.key.participant || msg.key.remoteJid;
            const isAdmin = participants.find(p => p.id === sender)?.admin !== null;

            if (isAdmin) return; // Admin ලාට Links යැවිය හැක

            // Link Message එක Delete කිරීම
            await sock.sendMessage(from, { delete: msg.key });

            // Warning Alert
            await sock.sendMessage(from, { 
                text: `⚠️ *@${sender.split('@')[0]} Links යැවීම තහනම් කර ඇත!*`,
                mentions: [sender]
            });
        }
    } catch (error) {
        console.error('AntiLink Error:', error);
    }
}

export { handleAntiLink }