import axios from 'axios';

import {
    getSettings,
    Settings,
    getCurrentSessionId,
    runWithSession
} from '../lib/database.js';

import { SessionManager } from '../lib/sessionManager.js';

const MAX_HISTORY_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 12000;
const MAX_REPLY_CHARS = 6000;
const MAX_SYSTEM_PROMPT_CHARS = 3000;

const DEFAULT_MODEL =
    process.env.AI_MODEL || 'gemini-3.5-flash-lite';

const AI_API_URL = (
    process.env.AI_API_URL ||
    'https://generativelanguage.googleapis.com/v1beta/models'
).replace(/\/+$/, '');

const sessionStates = new Map();
const patchedManagers = new WeakSet();


function getSessionState(sessionId) {
    let state = sessionStates.get(sessionId);

    if (!state) {
        state = {
            chats: new Map(),
            sockets: new WeakSet(),
            loading: null
        };

        sessionStates.set(sessionId, state);
    }

    return state;
}


function getText(msg) {
    return (
        msg?.message?.conversation ||
        msg?.message?.extendedTextMessage?.text ||
        msg?.message?.imageMessage?.caption ||
        msg?.message?.videoMessage?.caption ||
        ''
    ).trim();
}


function isGroup(jid) {
    return String(jid || '').endsWith('@g.us');
}


function getSender(msg, from) {
    if (!isGroup(from)) {
        return from;
    }

    return (
        msg?.key?.participant ||
        msg?.participant ||
        from
    );
}


function getChat(sessionId, chatId) {
    const state = getSessionState(sessionId);

    let chat = state.chats.get(chatId);

    if (!chat) {
        chat = {
            enabled: false,
            memory: true,
            model: DEFAULT_MODEL,
            systemPrompt: '',
            history: [],
            queue: Promise.resolve()
        };

        state.chats.set(chatId, chat);
    }

    return chat;
}


async function loadState(sessionId) {
    const state = getSessionState(sessionId);

    if (state.loading) {
        return state.loading;
    }

    state.loading = (async () => {
        const settings = await getSettings(sessionId);

        const modes = settings.aiModeChats || {};
        const histories = settings.aiHistories || {};

        state.chats.clear();

        for (const [chatId, raw] of Object.entries(modes)) {
            const chat = getChat(sessionId, chatId);

            chat.enabled =
                raw?.enabled === true;

            chat.memory =
                raw?.memory !== false;

            chat.model =
                raw?.model || DEFAULT_MODEL;

            chat.systemPrompt =
                String(
                    raw?.systemPrompt || ''
                ).slice(
                    0,
                    MAX_SYSTEM_PROMPT_CHARS
                );

            chat.history =
                Array.isArray(histories[chatId])
                    ? histories[chatId].slice(
                        -MAX_HISTORY_MESSAGES
                    )
                    : [];
        }
    })().finally(() => {
        state.loading = null;
    });

    return state.loading;
}


async function saveChat(sessionId, chatId) {
    const chat =
        getChat(sessionId, chatId);

    const settings =
        await getSettings(sessionId);

    const modes = {
        ...(settings.aiModeChats || {})
    };

    const histories = {
        ...(settings.aiHistories || {})
    };

    modes[chatId] = {
        enabled:
            Boolean(chat.enabled),

        memory:
            chat.memory !== false,

        model:
            chat.model || DEFAULT_MODEL,

        systemPrompt:
            String(
                chat.systemPrompt || ''
            ).slice(
                0,
                MAX_SYSTEM_PROMPT_CHARS
            )
    };

    if (
        chat.memory &&
        chat.history.length
    ) {
        histories[chatId] =
            chat.history.slice(
                -MAX_HISTORY_MESSAGES
            );
    } else {
        delete histories[chatId];
    }

    await Settings.updateOne(
        {},
        {
            aiModeChats: modes,
            aiHistories: histories
        }
    );
}


async function clearChatHistory(
    sessionId,
    chatId
) {
    const settings =
        await getSettings(sessionId);

    const histories = {
        ...(settings.aiHistories || {})
    };

    delete histories[chatId];

    const chat =
        getChat(
            sessionId,
            chatId
        );

    chat.history = [];

    await Settings.updateOne(
        {},
        {
            aiHistories: histories
        }
    );
}


/* =========================================================
 * GEMINI API
 * ========================================================= */

async function askAI({
    apiKey,
    model,
    systemPrompt,
    history,
    userText
}) {
    const contents = [];

    /*
     * Previous conversation
     */

    for (
        const item of
        history.slice(
            -MAX_HISTORY_MESSAGES
        )
    ) {
        if (
            !item ||
            ![
                'user',
                'assistant'
            ].includes(item.role) ||
            !item.text
        ) {
            continue;
        }

        contents.push({
            role:
                item.role === 'assistant'
                    ? 'model'
                    : 'user',

            parts: [
                {
                    text:
                        String(
                            item.text
                        )
                }
            ]
        });
    }


    /*
     * Current user message
     */

    contents.push({
        role: 'user',

        parts: [
            {
                text: userText
            }
        ]
    });


    /*
     * Gemini request body
     */

    const body = {
        contents
    };


    /*
     * System instruction
     */

    if (systemPrompt) {
        body.systemInstruction = {
            parts: [
                {
                    text:
                        String(
                            systemPrompt
                        )
                }
            ]
        };
    }


    const selectedModel =
        model || DEFAULT_MODEL;


    const response =
        await axios.post(
            `${AI_API_URL}/${encodeURIComponent(
                selectedModel
            )}:generateContent`,
            body,
            {
                headers: {
                    'x-goog-api-key':
                        apiKey,

                    'Content-Type':
                        'application/json'
                },

                timeout: 60000,

                validateStatus:
                    () => true
            }
        );


    /*
     * API error
     */

    if (
        response.status < 200 ||
        response.status >= 300
    ) {
        const apiError =
            response.data?.error;

        const message =
            apiError?.message ||
            `Gemini API returned HTTP ${response.status}`;

        throw new Error(
            message
        );
    }


    /*
     * Extract response text
     */

    const candidates =
        response.data?.candidates || [];

    const parts =
        candidates?.[0]?.content?.parts || [];

    const answer =
        parts
            .map(
                part =>
                    part?.text || ''
            )
            .join('')
            .trim();


    if (!answer) {
        const finishReason =
            candidates?.[0]?.finishReason;

        throw new Error(
            finishReason
                ? `Gemini returned no text. Finish reason: ${finishReason}`
                : 'Gemini API returned an empty response.'
        );
    }


    return answer.slice(
        0,
        MAX_REPLY_CHARS
    );
}


/* =========================================================
 * SEND REPLY
 * ========================================================= */

async function sendReply(
    sock,
    from,
    text,
    quoted
) {
    const chunks = [];

    let remaining =
        String(text);


    while (
        remaining.length > 3500
    ) {
        let cut =
            remaining.lastIndexOf(
                '\n',
                3500
            );

        if (cut < 1200) {
            cut =
                remaining.lastIndexOf(
                    ' ',
                    3500
                );
        }

        if (cut < 1200) {
            cut = 3500;
        }

        chunks.push(
            remaining.slice(
                0,
                cut
            )
        );

        remaining =
            remaining
                .slice(cut)
                .trimStart();
    }


    if (remaining) {
        chunks.push(
            remaining
        );
    }


    for (
        let i = 0;
        i < chunks.length;
        i++
    ) {
        await sock.sendMessage(
            from,
            {
                text:
                    chunks[i]
            },
            {
                quoted:
                    i === 0
                        ? quoted
                        : undefined
            }
        );
    }
}


/* =========================================================
 * IGNORE MESSAGE TYPES
 * ========================================================= */

function shouldIgnore(
    msg,
    from
) {
    if (!msg?.message) {
        return true;
    }

    if (msg.key?.fromMe) {
        return true;
    }

    if (!from) {
        return true;
    }

    if (
        msg.message.protocolMessage ||
        msg.message.reactionMessage ||
        msg.message.pollUpdateMessage ||
        msg.message.pollCreationMessage ||
        msg.message.senderKeyDistributionMessage
    ) {
        return true;
    }

    return false;
}


/* =========================================================
 * MESSAGE QUEUE
 * ========================================================= */

function queueChat(
    chat,
    task
) {
    const next =
        chat.queue
            .catch(() => {})
            .then(task);

    chat.queue =
        next.catch(
            () => {}
        );

    return next;
}


/* =========================================================
 * HANDLE MESSAGE
 * ========================================================= */

async function handleIncomingMessage(
    sock,
    msg,
    sessionId
) {
    const from =
        msg?.key?.remoteJid;


    if (
        shouldIgnore(
            msg,
            from
        )
    ) {
        return;
    }


    const text =
        getText(msg);


    if (!text) {
        return;
    }


    /*
     * Dot commands are handled
     * by the command system.
     */

    if (
        text.startsWith('.')
    ) {
        return;
    }


    await loadState(
        sessionId
    );


    const chat =
        getChat(
            sessionId,
            from
        );


    if (!chat.enabled) {
        return;
    }


    /*
     * Gemini API key
     */

    const apiKey =
        process.env.GEMINI_API_KEY;


    if (!apiKey) {
        await sock.sendMessage(
            from,
            {
                text:
                    '❌ GEMINI_API_KEY is not configured.\n\nAdd GEMINI_API_KEY to Railway Variables.'
            },
            {
                quoted:
                    msg
            }
        );

        return;
    }


    const userText =
        text.slice(
            0,
            MAX_MESSAGE_CHARS
        );


    await queueChat(
        chat,
        async () => {
            try {
                await sock
                    .sendPresenceUpdate(
                        'composing',
                        from
                    )
                    .catch(
                        () => {}
                    );


                const answer =
                    await askAI({
                        apiKey,

                        model:
                            chat.model,

                        systemPrompt:
                            chat.systemPrompt,

                        history:
                            chat.memory
                                ? chat.history
                                : [],

                        userText
                    });


                /*
                 * Save history
                 */

                if (
                    chat.memory
                ) {
                    chat.history = [
                        ...chat.history,

                        {
                            role:
                                'user',

                            text:
                                userText
                        },

                        {
                            role:
                                'assistant',

                            text:
                                answer
                        }
                    ].slice(
                        -MAX_HISTORY_MESSAGES
                    );


                    await saveChat(
                        sessionId,
                        from
                    );
                }


                await sendReply(
                    sock,
                    from,
                    answer,
                    msg
                );

            } catch (err) {
                console.error(
                    `[${sessionId}] Gemini AI error:`,
                    err
                );


                await sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ Gemini AI error: ${
                                err.message ||
                                'Unable to generate a response.'
                            }`
                    },
                    {
                        quoted:
                            msg
                    }
                );

            } finally {
                await sock
                    .sendPresenceUpdate(
                        'paused',
                        from
                    )
                    .catch(
                        () => {}
                    );
            }
        }
    );
}


/* =========================================================
 * ATTACH SOCKET
 * ========================================================= */

function attachSocket(
    sock,
    sessionId
) {
    if (
        !sock?.ev ||
        !sessionId
    ) {
        return;
    }


    const state =
        getSessionState(
            sessionId
        );


    if (
        state.sockets.has(
            sock
        )
    ) {
        return;
    }


    state.sockets.add(
        sock
    );


    loadState(
        sessionId
    ).catch(
        err => {
            console.error(
                `[${sessionId}] AI state load error:`,
                err
            );
        }
    );


    sock.ev.on(
        'messages.upsert',
        event => {

            /*
             * Restore bot session context
             */

            runWithSession(
                sessionId,
                async () => {
                    for (
                        const msg of
                        event?.messages || []
                    ) {
                        await handleIncomingMessage(
                            sock,
                            msg,
                            sessionId
                        );
                    }
                }
            ).catch(
                err => {
                    console.error(
                        `[${sessionId}] AI message handler error:`,
                        err
                    );
                }
            );
        }
    );
}


/* =========================================================
 * SESSION MANAGER PATCH
 * ========================================================= */

function patchSessionManager() {
    if (
        patchedManagers.has(
            SessionManager
        )
    ) {
        return;
    }


    const originalConnect =
        SessionManager.prototype.connect;


    if (
        typeof originalConnect !==
        'function'
    ) {
        throw new Error(
            'AI plugin could not find SessionManager.connect().'
        );
    }


    patchedManagers.add(
        SessionManager
    );


    SessionManager.prototype.connect =
        async function aiPluginConnect(
            sessionId,
            entry
        ) {
            const result =
                await originalConnect.call(
                    this,
                    sessionId,
                    entry
                );


            if (
                entry?.sock
            ) {
                attachSocket(
                    entry.sock,
                    sessionId
                );
            }


            return result;
        };
}


patchSessionManager();


/* =========================================================
 * COMMAND HELPERS
 * ========================================================= */

function getCommandFromText(
    text
) {
    const match =
        String(text || '')
            .trim()
            .match(
                /^\.([^\s]+)/
            );


    return match
        ? match[1].toLowerCase()
        : 'aimode';
}


function usage(chat) {
    return (
        '🤖 *AI Chat Mode*\n\n' +

        `Status: *${
            chat.enabled
                ? 'ON ✅'
                : 'OFF ❌'
        }*\n` +

        `Memory: *${
            chat.memory
                ? 'ON 🧠'
                : 'OFF ❌'
        }*\n` +

        `Model: \`${chat.model}\`\n\n` +

        '`.aimode on` — AI ON for this chat\n' +

        '`.aimode off` — AI OFF for this chat\n' +

        '`.aiclear` — clear AI history\n' +

        '`.aimemory on/off` — memory control\n' +

        '`.aimodel <model>` — change model\n' +

        '`.aisystem <prompt>` — set system prompt\n' +

        '`.aisystem reset` — reset system prompt\n' +

        '`.aistatus` — show status'
    );
}


/* =========================================================
 * EXPORT
 * ========================================================= */

export default {
    pattern: 'aimode',

    alias: [
        'aiclear',
        'aimemory',
        'aimodel',
        'aisystem',
        'aistatus'
    ],

    category: 'ai',

    desc: 'Gemini AI conversation mode',

    function: async (
        sock,
        msg,
        {
            from,
            args,
            config,
            text
        }
    ) => {

        const sessionId =
            config.SESSION_ID ||
            getCurrentSessionId();


        if (!sessionId) {
            return sock.sendMessage(
                from,
                {
                    text:
                        '❌ Bot session could not be identified.'
                },
                {
                    quoted:
                        msg
                }
            );
        }


        await loadState(
            sessionId
        );


        const chat =
            getChat(
                sessionId,
                from
            );


        const command =
            getCommandFromText(
                text
            );


        const sub =
            String(
                args[0] || ''
            )
                .trim()
                .toLowerCase();


        /* =================================================
         * .aimode
         * ================================================= */

        if (
            command === 'aimode'
        ) {

            if (
                sub === 'on' ||
                sub === 'off'
            ) {

                chat.enabled =
                    sub === 'on';


                await saveChat(
                    sessionId,
                    from
                );


                return sock.sendMessage(
                    from,
                    {
                        text:
                            chat.enabled

                                ? '🤖 *AI MODE ON* ✅\n\nදැන් මේ chat එකේ සාමාන්‍ය messages Gemini AI conversation එකට යනවා.\n\n`.aimode off` දාලා normal mode එකට යන්න.'

                                : '🤖 *AI MODE OFF* ❌\n\nමේ chat එකේ Gemini AI conversation mode එක off කළා.'
                    },
                    {
                        quoted:
                            msg
                    }
                );
            }


            return sock.sendMessage(
                from,
                {
                    text:
                        usage(chat)
                },
                {
                    quoted:
                        msg
                }
            );
        }


        /* =================================================
         * .aiclear
         * ================================================= */

        if (
            command === 'aiclear'
        ) {

            await clearChatHistory(
                sessionId,
                from
            );


            return sock.sendMessage(
                from,
                {
                    text:
                        '🧹 *AI chat history cleared.*'
                },
                {
                    quoted:
                        msg
                }
            );
        }


        /* =================================================
         * .aimemory
         * ================================================= */

        if (
            command === 'aimemory'
        ) {

            if (
                sub !== 'on' &&
                sub !== 'off'
            ) {

                return sock.sendMessage(
                    from,
                    {
                        text:
                            '⚠️ `.aimemory on` or `.aimemory off`'
                    },
                    {
                        quoted:
                            msg
                    }
                );
            }


            chat.memory =
                sub === 'on';


            if (
                !chat.memory
            ) {

                await clearChatHistory(
                    sessionId,
                    from
                );

            } else {

                await saveChat(
                    sessionId,
                    from
                );
            }


            return sock.sendMessage(
                from,
                {
                    text:
                        `🧠 AI memory *${
                            chat.memory
                                ? 'ON ✅'
                                : 'OFF ❌'
                        }*`
                },
                {
                    quoted:
                        msg
                }
            );
        }


        /* =================================================
         * .aimodel
         * ================================================= */

        if (
            command === 'aimodel'
        ) {

            const model =
                args
                    .join(' ')
                    .trim();


            if (!model) {
                return sock.sendMessage(
                    from,
                    {
                        text:
                            `🤖 Current model: \`${chat.model}\``
                    },
                    {
                        quoted:
                            msg
                    }
                );
            }


            if (
                model.length > 120 ||
                /[\r\n]/.test(
                    model
                )
            ) {

                return sock.sendMessage(
                    from,
                    {
                        text:
                            '❌ Invalid model name.'
                    },
                    {
                        quoted:
                            msg
                    }
                );
            }


            chat.model =
                model;


            await saveChat(
                sessionId,
                from
            );


            return sock.sendMessage(
                from,
                {
                    text:
                        `🤖 Model changed to \`${model}\``
                },
                {
                    quoted:
                        msg
                }
            );
        }


        /* =================================================
         * .aisystem
         * ================================================= */

        if (
            command === 'aisystem'
        ) {

            if (
                sub === 'reset'
            ) {

                chat.systemPrompt =
                    '';


                await saveChat(
                    sessionId,
                    from
                );


                return sock.sendMessage(
                    from,
                    {
                        text:
                            '🧠 System prompt reset.'
                    },
                    {
                        quoted:
                            msg
                    }
                );
            }


            const prompt =
                args
                    .join(' ')
                    .trim();


            if (!prompt) {

                return sock.sendMessage(
                    from,
                    {
                        text:
                            chat.systemPrompt

                                ? `🧠 Current system prompt:\n\n${chat.systemPrompt}`

                                : '🧠 No custom system prompt.'
                    },
                    {
                        quoted:
                            msg
                    }
                );
            }


            chat.systemPrompt =
                prompt.slice(
                    0,
                    MAX_SYSTEM_PROMPT_CHARS
                );


            await saveChat(
                sessionId,
                from
            );


            return sock.sendMessage(
                from,
                {
                    text:
                        '🧠 System prompt saved.'
                },
                {
                    quoted:
                        msg
                }
            );
        }


        /* =================================================
         * .aistatus
         * ================================================= */

        if (
            command === 'aistatus'
        ) {

            return sock.sendMessage(
                from,
                {
                    text:
                        usage(chat)
                },
                {
                    quoted:
                        msg
                }
            );
        }


        return sock.sendMessage(
            from,
            {
                text:
                    usage(chat)
            },
            {
                quoted:
                    msg
            }
        );
    }
};
