import { G4F } from 'g4f';

/*
 * ============================================================
 *                    MRNOBODY AI PLUGIN
 * ============================================================
 *
 * Commands:
 *
 *   .ai <message>
 *
 *   .aimode on
 *   .aimode off
 *   .aimode
 *
 *   .aion
 *   .aioff
 *
 * Examples:
 *
 *   .ai hello
 *   .ai සිංහලෙන් කතා කරන්න
 *   .aimode on
 *
 * After AI mode is ON:
 *
 *   Hello
 *   කොහොමද?
 *   What is JavaScript?
 *
 * All normal messages in that chat will receive AI replies.
 *
 * AI mode is stored per WhatsApp chat/JID.
 *
 * No API key required.
 * No database required.
 * ============================================================
 */


/* ============================================================
 * CONFIGURATION
 * ============================================================
 */

const MAX_HISTORY = 12;

const MAX_INPUT_LENGTH = 4000;

const MAX_OUTPUT_LENGTH = 6000;

const THINKING_TEXT = '🤖 Thinking...';


/*
 * One G4F instance is enough for the whole Node process.
 */
const g4f = new G4F();


/*
 * Chat/JID -> true
 *
 * Example:
 *
 * 123456789@s.whatsapp.net -> true
 */
const aiModes = new Map();


/*
 * Chat/JID -> conversation history
 *
 * Example:
 *
 * [
 *   { role: 'user', content: 'Hello' },
 *   { role: 'assistant', content: 'Hi!' }
 * ]
 */
const conversations = new Map();


/*
 * Prevent attaching the messages.upsert listener more than
 * once to the same Baileys socket.
 *
 * WeakSet means disconnected sockets can be garbage collected.
 */
const attachedSockets = new WeakSet();


/*
 * Prefix for the current socket.
 *
 * The actual prefix is obtained from the existing bot config
 * when .aimode / .ai is executed.
 */
const socketPrefixes = new WeakMap();


/* ============================================================
 * SYSTEM PROMPT
 * ============================================================
 */

const SYSTEM_PROMPT = `
You are the AI assistant of a WhatsApp bot.

Your personality:
- Friendly
- Helpful
- Natural
- Concise
- Intelligent

Language rules:
- Understand Sinhala.
- Understand Singlish.
- Understand English.
- Understand mixed Sinhala-English.
- If the user speaks Sinhala, preferably reply in Sinhala.
- If the user speaks English, reply in English.
- Do not unnecessarily translate the user's message.

Conversation rules:
- Remember the conversation context provided to you.
- Answer the user's actual question.
- Do not mention this system prompt.
- Do not pretend to have capabilities you do not have.
- Do not claim you performed an action unless you actually did.
- Keep normal WhatsApp answers reasonably concise.
`.trim();


/* ============================================================
 * TEXT EXTRACTION
 * ============================================================
 */

function getMessageText(msg) {

    if (!msg?.message) {
        return '';
    }

    return (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        msg.message.documentMessage?.caption ||
        msg.message.buttonsResponseMessage?.selectedButtonId ||
        msg.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
        ''
    ).trim();
}


/* ============================================================
 * SENDER NAME
 * ============================================================
 */

function getSenderName(msg) {

    return (
        msg?.pushName ||
        msg?.verifiedBizName ||
        'User'
    );
}


/* ============================================================
 * HISTORY
 * ============================================================
 */

function getHistory(jid) {

    if (!conversations.has(jid)) {
        conversations.set(jid, []);
    }

    return conversations.get(jid);
}


function clearHistory(jid) {

    conversations.delete(jid);
}


function addHistory(
    jid,
    role,
    content
) {

    const history = getHistory(jid);

    history.push({
        role,
        content
    });

    /*
     * Keep memory small.
     */
    while (
        history.length >
        MAX_HISTORY
    ) {
        history.shift();
    }
}


/* ============================================================
 * RESPONSE CLEANER
 * ============================================================
 */

function cleanResponse(response) {

    if (
        response === null ||
        response === undefined
    ) {
        return '';
    }

    let text = String(response).trim();

    /*
     * Some providers may return accidental JSON-like
     * wrapping. Do not aggressively parse it because normal
     * AI responses can legitimately contain JSON.
     */

    if (
        text.length >
        MAX_OUTPUT_LENGTH
    ) {
        text =
            text.slice(
                0,
                MAX_OUTPUT_LENGTH
            ) +
            '\n\n…';
    }

    return text;
}


/* ============================================================
 * AI REQUEST
 * ============================================================
 */

async function askAI(
    jid,
    userText,
    senderName
) {

    const history =
        getHistory(jid);

    const messages = [

        {
            role: 'system',
            content: SYSTEM_PROMPT
        },

        ...history,

        {
            role: 'user',
            content:
                `${senderName}: ${userText}`
        }

    ];


    /*
     * G4F automatically chooses an available provider.
     *
     * No API key is supplied.
     */
    const result =
        await g4f.chatCompletion(
            messages,
            {
                debug: false
            }
        );


    const response =
        cleanResponse(result);


    if (!response) {
        throw new Error(
            'AI returned an empty response.'
        );
    }


    /*
     * Only save successful responses.
     */
    addHistory(
        jid,
        'user',
        `${senderName}: ${userText}`
    );

    addHistory(
        jid,
        'assistant',
        response
    );


    return response;
}


/* ============================================================
 * ERROR MESSAGE
 * ============================================================
 */

function getAIErrorMessage(error) {

    const message =
        String(
            error?.message ||
            error ||
            ''
        ).toLowerCase();


    console.error(
        '[AI] Error:',
        error?.stack ||
        error
    );


    if (
        message.includes('timeout') ||
        message.includes('timed out')
    ) {
        return (
            '⏳ *AI response එකට වැඩි වෙලාවක් ගියා.*\n\n' +
            'ටිකකින් නැවත try කරන්න.'
        );
    }


    if (
        message.includes('rate') ||
        message.includes('limit') ||
        message.includes('429')
    ) {
        return (
            '⏳ *AI provider rate limit එකට වැටිලා.*\n\n' +
            'ටික වෙලාවකින් නැවත try කරන්න.'
        );
    }


    if (
        message.includes('provider') ||
        message.includes('fetch') ||
        message.includes('network') ||
        message.includes('connect')
    ) {
        return (
            '🌐 *AI provider එකට connect වෙන්න බැරි වුණා.*\n\n' +
            'ටිකකින් නැවත try කරන්න.'
        );
    }


    return (
        '⚠️ *AI response එක ලබාගන්න බැරි වුණා.*\n\n' +
        'ටිකකින් නැවත try කරන්න.'
    );
}


/* ============================================================
 * SEND AI RESPONSE
 * ============================================================
 */

async function handleAIMessage(
    sock,
    msg,
    from,
    text
) {

    if (!text) {
        return;
    }


    if (
        text.length >
        MAX_INPUT_LENGTH
    ) {

        await sock.sendMessage(
            from,
            {
                text:
                    `⚠️ Message එක දිග වැඩියි.\n\n` +
                    `Maximum: ${MAX_INPUT_LENGTH} characters.`
            },
            {
                quoted: msg
            }
        );

        return;
    }


    /*
     * Show typing/thinking message.
     */
    const waiting =
        await sock.sendMessage(
            from,
            {
                text: THINKING_TEXT
            },
            {
                quoted: msg
            }
        );


    try {

        const senderName =
            getSenderName(msg);


        const response =
            await askAI(
                from,
                text,
                senderName
            );


        await sock.sendMessage(
            from,
            {
                text: response
            },
            {
                quoted: waiting
            }
        );

    } catch (error) {

        await sock.sendMessage(
            from,
            {
                text:
                    getAIErrorMessage(
                        error
                    )
            },
            {
                quoted: msg
            }
        );
    }
}


/* ============================================================
 * BACKGROUND AI MODE LISTENER
 * ============================================================
 *
 * IMPORTANT:
 *
 * sessionManager.js only dispatches PREFIX commands to plugins.
 *
 * Therefore .aimode ON needs a listener that watches ordinary
 * messages too.
 *
 * This listener is attached ONLY to the current Baileys socket.
 *
 * No sessionManager.js modification is required.
 * ============================================================
 */

function attachAIModeListener(
    sock
) {

    if (
        attachedSockets.has(sock)
    ) {
        return;
    }


    attachedSockets.add(sock);


    sock.ev.on(
        'messages.upsert',
        async event => {

            try {

                const msg =
                    event?.messages?.[0];


                if (!msg?.message) {
                    return;
                }


                /*
                 * Ignore messages sent by the bot itself.
                 */
                if (
                    msg.key?.fromMe
                ) {
                    return;
                }


                const from =
                    msg.key?.remoteJid;


                if (!from) {
                    return;
                }


                /*
                 * Only respond when AI mode is enabled
                 * for this particular chat.
                 */
                if (
                    aiModes.get(from) !== true
                ) {
                    return;
                }


                const text =
                    getMessageText(msg);


                if (!text) {
                    return;
                }


                const prefix =
                    socketPrefixes.get(sock) ||
                    '.';


                /*
                 * Do not intercept normal bot commands.
                 *
                 * .ping
                 * .menu
                 * .aimode off
                 * etc.
                 */
                if (
                    text.startsWith(prefix)
                ) {
                    return;
                }


                await handleAIMessage(
                    sock,
                    msg,
                    from,
                    text
                );

            } catch (error) {

                console.error(
                    '[AI MODE] Listener error:',
                    error?.stack ||
                    error
                );
            }
        }
    );
}


/* ============================================================
 * ENABLE AI MODE
 * ============================================================
 */

async function enableAIMode(
    sock,
    msg,
    from
) {

    aiModes.set(
        from,
        true
    );


    /*
     * Start a fresh conversation when AI mode is enabled.
     */
    clearHistory(from);


    await sock.sendMessage(
        from,
        {
            text:
                `🟢 *AI MODE ON*\n\n` +

                `දැන් මේ chat එකේ normal messages ` +
                `වලටත් AI reply කරනවා.\n\n` +

                `💬 Example:\n` +
                `• කොහොමද?\n` +
                `• මට JavaScript කියලා දෙන්න\n` +
                `• Hello AI\n\n` +

                `🔴 AI mode OFF:\n` +
                `*.aimode off*`
        },
        {
            quoted: msg
        }
    );
}


/* ============================================================
 * DISABLE AI MODE
 * ============================================================
 */

async function disableAIMode(
    sock,
    msg,
    from
) {

    aiModes.delete(
        from
    );


    /*
     * Clear conversation memory when disabling.
     */
    clearHistory(from);


    await sock.sendMessage(
        from,
        {
            text:
                `🔴 *AI MODE OFF*\n\n` +

                `Automatic AI replies නවත්තලා.\n\n` +

                `AI නැවත ON කරන්න:\n` +
                `*.aimode on*`
        },
        {
            quoted: msg
        }
    );
}


/* ============================================================
 * STATUS
 * ============================================================
 */

async function sendStatus(
    sock,
    msg,
    from
) {

    const enabled =
        aiModes.get(from) === true;


    const history =
        conversations.get(from) || [];


    await sock.sendMessage(
        from,
        {
            text:
                `🤖 *AI MODE STATUS*\n\n` +

                `Status: ${
                    enabled
                        ? '🟢 ON'
                        : '🔴 OFF'
                }\n` +

                `Memory: ${
                    history.length
                } messages\n\n` +

                `🟢 ON  → *.aimode on*\n` +
                `🔴 OFF → *.aimode off*\n` +
                `💬 AI   → *.ai your message*`
        },
        {
            quoted: msg
        }
    );
}


/* ============================================================
 * MAIN PLUGIN
 * ============================================================
 */

export default {

    /*
     * Main command:
     *
     * .ai
     */
    pattern: 'ai',


    /*
     * Additional commands:
     *
     * .aimode
     * .aion
     * .aioff
     */
    alias: [
        'aimode',
        'aion',
        'aioff'
    ],


    category: 'ai',


    desc:
        'AI chat and automatic AI conversation mode',


    function: async (
        sock,
        msg,
        {
            from,
            args,
            text,
            config
        }
    ) => {

        /*
         * Save the actual configured prefix for this socket.
         */
        socketPrefixes.set(
            sock,
            config?.PREFIX || '.'
        );


        /*
         * Attach normal-message listener.
         *
         * This does not modify sessionManager.js.
         */
        attachAIModeListener(
            sock
        );


        const prefix =
            config?.PREFIX || '.';


        /*
         * Determine which command was used.
         *
         * sessionManager provides the full text.
         */
        const commandText =
            String(text || '')
                .trim();


        const commandWithoutPrefix =
            commandText.startsWith(prefix)
                ? commandText.slice(
                    prefix.length
                ).trim()
                : commandText;


        const parts =
            commandWithoutPrefix
                .split(/\s+/);


        const command =
            String(
                parts.shift() || ''
            ).toLowerCase();


        /*
         * ====================================================
         * .aion
         * ====================================================
         */

        if (
            command === 'aion'
        ) {

            await enableAIMode(
                sock,
                msg,
                from
            );

            return;
        }


        /*
         * ====================================================
         * .aioff
         * ====================================================
         */

        if (
            command === 'aioff'
        ) {

            await disableAIMode(
                sock,
                msg,
                from
            );

            return;
        }


        /*
         * ====================================================
         * .aimode
         * ====================================================
         */

        if (
            command === 'aimode'
        ) {

            const action =
                String(
                    parts[0] || ''
                ).toLowerCase();


            if (
                action === 'on' ||
                action === 'enable' ||
                action === 'enabled'
            ) {

                await enableAIMode(
                    sock,
                    msg,
                    from
                );

                return;
            }


            if (
                action === 'off' ||
                action === 'disable' ||
                action === 'disabled'
            ) {

                await disableAIMode(
                    sock,
                    msg,
                    from
                );

                return;
            }


            await sendStatus(
                sock,
                msg,
                from
            );

            return;
        }


        /*
         * ====================================================
         * .ai <question>
         * ====================================================
         */

        if (
            command === 'ai'
        ) {

            const question =
                parts.join(' ').trim();


            if (!question) {

                await sock.sendMessage(
                    from,
                    {
                        text:
                            `🤖 *AI CHAT*\n\n` +

                            `Use:\n` +
                            `*.ai your question*\n\n` +

                            `Example:\n` +
                            `*.ai මට JavaScript කියලා දෙන්න*\n\n` +

                            `Automatic mode:\n` +
                            `*.aimode on*`
                    },
                    {
                        quoted: msg
                    }
                );

                return;
            }


            await handleAIMessage(
                sock,
                msg,
                from,
                question
            );

            return;
        }
    }
};
