import { getSettings } from './database.js';

const messageStore = new Map();

function storeKey(sessionId, id) {
    return `${sessionId}:${id}`;
}

function storeMessage(msg, sessionId) {
    if (!msg?.key?.id || !sessionId) return;
    if (msg.message?.protocolMessage || msg.message?.reactionMessage) return;

    const key = storeKey(sessionId, msg.key.id);
    messageStore.set(key, msg);

    setTimeout(() => messageStore.delete(key), 30 * 60 * 1000);
}

async function handleDeletedMessage(sock, msg, sessionId) {
    try {
        if (msg.message?.protocolMessage?.type !== 0) return;

        const deletedKey = msg.message.protocolMessage.key;
        const originalMsg = messageStore.get(storeKey(sessionId, deletedKey.id));
        if (!originalMsg) return;

        const settings = await getSettings(sessionId);
        if (!settings.antiDelete) return;

        const from = msg.key.remoteJid;
        const isGroup = from?.endsWith('@g.us');
        const isSelf = msg.key.fromMe;
        const sender = originalMsg.key.participant || originalMsg.key.remoteJid;
        const senderNumber = sender.split('@')[0];

        const mode = settings.antiDeleteMode || 'public';
        if (mode === 'inbox' && isGroup) return;
        if (mode === 'group' && !isGroup) return;
        if (mode === 'self' && !isSelf) return;

        let chatName = 'Private Inbox';

        if (isGroup) {
            try {
                const metadata = await sock.groupMetadata(from);
                chatName = metadata.subject || 'WhatsApp Group';
            } catch {
                chatName = 'WhatsApp Group';
            }
        }

        const deletedText =
            originalMsg.message?.conversation ||
            originalMsg.message?.extendedTextMessage?.text ||
            originalMsg.message?.imageMessage?.caption ||
            originalMsg.message?.videoMessage?.caption ||
            '*(Media File / Attachment)*';

        const destination =
            settings.antiDeleteSend === 'inbox'
                ? `${sock.user.id.split(':')[0]}@s.whatsapp.net`
                : from;

        await sock.sendMessage(destination, {
            text:
                `⚠️ *DELETED MESSAGE DETECTED* ⚠️\n\n` +
                `👤 *Sender:* @${senderNumber}\n` +
                `💬 *Chat:* ${chatName}\n\n` +
                `💬 *Deleted Content:*\n${deletedText}`,
            mentions: [sender]
        });

        if (
            originalMsg.message &&
            !originalMsg.message.conversation &&
            !originalMsg.message.extendedTextMessage
        ) {
            await sock.sendMessage(
                destination,
                { forward: originalMsg },
                { quoted: originalMsg }
            );
        }
    } catch (error) {
        console.error(`[${sessionId}] Anti-Delete Error:`, error.message);
    }
}

export { storeMessage, handleDeletedMessage };
