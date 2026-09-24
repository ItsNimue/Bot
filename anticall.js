import { getSettings } from './database.js';

async function handleAntiCall(sock, callEvents) {
    try {
        const settings = await getSettings();
        if (!settings.antiCall) return;

        for (const call of callEvents) {
            // Call එකක් එන අවස්ථාවේදී (Incoming Call)
            if (call.status === 'offer') {
                // Call එක Reject/Decline කිරීම
                await sock.rejectCall(call.id, call.from);

                // Call එක දුන් කෙනාට පණිවිඩයක් යැවීම
                await sock.sendMessage(call.from, {
                    text: '⚠️ *ස්වයන්ක්‍රීය පණිවිඩයයි:* මෙම Bot අංකයට WhatsApp Calls ලබාගැනීම තහනම් කර ඇත. (WhatsApp calls are not allowed!)'
                });
            }
        }
    } catch (error) {
        console.error('Anti Call Handler Error:', error);
    }
}

export { handleAntiCall }
