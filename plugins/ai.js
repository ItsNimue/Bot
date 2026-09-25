import axios from 'axios';
import { getSettings, Settings, getCurrentSessionId, runWithSession } from '../lib/database.js';
import { SessionManager } from '../lib/sessionManager.js';

const MAX_HISTORY_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 12000;
const MAX_REPLY_CHARS = 6000;
const MAX_SYSTEM_PROMPT_CHARS = 3000;
const MAX_STORED_CHATS = 200;
const DEFAULT_MODEL = process.env.AI_MODEL || 'gpt-5.6-luna';
const DEFAULT_SCOPE = process.env.AI_SCOPE || 'chat';
const AI_API_URL = String(
    process.env.AI_API_URL || 'https://api.openai.com/v1/responses'
).replace(/\/+$/, '');

const sessions = new Map();
const patchedManagers = new WeakSet();

function isGroup(jid) {
    return String(jid || '').endsWith('@g.us');
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

function getSender(msg, from) {
    if (!isGroup(from)) return from;
    return (
        msg?.key?.participant ||
        msg?.participant ||
        from
    );
}

function normalizeJid(jid) {
    return String(jid || '').trim();
}

function getSession(sessionId) {
    let state = sessions.get(sessionId);

    if (!state) {
        state = {
            chats: new Map(),
            attachedSockets: new WeakSet(),
            loading: null
        };

        sessions.set(sessionId, state);
    }

    return state;
}

function getChatState(state, chatId) {
    let chat = state.chats.get(chatId);

    if (!chat) {
        chat = {
            enabled: false,
            memory: true,
            ownerOnly: false,
            scope: DEFAULT_SCOPE === 'user' ? 'user' : 'chat',
            model: DEFAULT_MODEL,
            systemPrompt: '',
            history: [],
            queue: Promise.resolve()
        };

        state.chats.set(chatId, chat);
    }

    return chat;
}

function historyKey(chatId, scope, senderId) {
    if (scope === 'user') {
        return `${chatId}::${senderId || 'unknown'}`;
    }

    return chatId;
}

async function loadState(sessionId) {
    const state = getSession(sessionId);

    if (state.loading) return state.loading;

    state.loading = (async () => {
        const settings = await getSettings(sessionId);
        const modes = settings.aiModeChats || {};
        const histories = settings.aiHistories || {};

        state.chats.clear();

        for (const [chatId, raw] of Object.entries(modes)) {
            const chat = getChatState(state, chatId);

            chat.enabled = raw?.enabled === true;
            chat.memory = raw?.memory !== false;
            chat.ownerOnly = raw?.ownerOnly === true;
            chat.scope = raw?.scope === 'user' ? 'user' : 'chat';
            chat.model = raw?.model || DEFAULT_MODEL;
            chat.systemPrompt = String(raw?.systemPrompt || '').slice(
                0,
                MAX_SYSTEM_PROMPT_CHARS
            );

            const storedHistory = histories[chatId];

            chat.history =
                Array.isArray(storedHistory)
                    ? storedHistory.slice(-MAX_HISTORY_MESSAGES)
                    : [];
        }
    })().finally(() => {
        state.loading = null;
    });

    return state.loading;
}

async function saveAllState(sessionId) {
    const state = getSession(sessionId);
    const settings = await getSettings(sessionId);

    const modes = {};
    const histories = {};

    const entries = [...state.chats.entries()]
        .slice(-MAX_STORED_CHATS);

    for (const [chatId, chat] of entries) {
        modes[chatId] = {
            enabled: Boolean(chat.enabled),
            memory: chat.memory !== false,
            ownerOnly: Boolean(chat.ownerOnly),
            scope: chat.scope === 'user' ? 'user' : 'chat',
            model: chat.model || DEFAULT_MODEL,
            systemPrompt: String(chat.systemPrompt || '').slice(
                0,
                MAX_SYSTEM_PROMPT_CHARS
            )
        };

        if (chat.memory !== false && chat.history.length) {
            histories[chatId] = chat.history.slice(
                -MAX_HISTORY_MESSAGES
            );
        }
    }

    await Settings.updateOne(
        { id: 'main_settings' },
        {
            aiModeChats: {
                ...(settings.aiModeChats || {}),
                ...modes
            },
            aiHistories: {
                ...(settings.aiHistories || {}),
                ...histories
            }
        }
    );
}

async function clearHistory(sessionId, chatId, userId, scope) {
    const state = getSession(sessionId);
    const key = historyKey(chatId, scope, userId);

    const settings = await getSettings(sessionId);
    const histories = { ...(settings.aiHistories || {}) };

    delete histories[key];

    const chat = getChatState(state, chatId);

    if (scope === 'chat') {
        chat.history = [];
    }

    await Settings.updateOne(
        { id: 'main_settings' },
        { aiHistories: histories }
    );
}

function isOwnerMessage(sock, msg, from) {
    const sender = normalizeJid(getSender(msg, from));
    const bot = normalizeJid(sock?.user?.id);

    if (!sender || !bot) return false;

    const clean = value =>
        value
            .split(':')[0]
            .replace(/@s\.whatsapp\.net$/, '')
            .replace(/@lid$/, '');

    return clean(sender) === clean(bot);
}

function extractResponseText(data) {
    if (
        typeof data?.output_text === 'string' &&
        data.output_text.trim()
    ) {
        return data.output_text.trim();
    }

    const parts = [];

    for (const item of data?.output || []) {
        for (const content of item?.content || []) {
            if (
                content?.type === 'output_text' &&
                content?.text
            ) {
                parts.push(content.text);
            }
        }
    }

    return parts.join('\n').trim();
}

async function askAI({
    apiKey,
    model,
    systemPrompt,
    history,
    userText
}) {
    const input = [];

    if (systemPrompt) {
        input.push({
            role: 'developer',
            content: [
                {
                    type: 'input_text',
                    text: systemPrompt
                }
            ]
        });
    }

    for (const item of history.slice(-MAX_HISTORY_MESSAGES)) {
        if (!item?.role || !item?.text) continue;

        input.push({
            role: item.role,
            content: [
                {
                    type: 'input_text',
                    text: String(item.text)
                }
            ]
        });
    }

    input.push({
        role: 'user',
        content: [
            {
                type: 'input_text',
                text: userText
            }
        ]
    });

    const response = await axios.post(
        AI_API_URL,
        {
            model: model || DEFAULT_MODEL,
            input,
            max_output_tokens: 1800
        },
        {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 60000,
            validateStatus: () => true
        }
    );

    if (
        response.status < 200 ||
        response.status >= 300
    ) {
        const providerError =
            response.data?.error?.message ||
            `AI provider returned HTTP ${response.status}`;

        throw new Error(providerError);
    }

    const answer = extractResponseText(response.data);

    if (!answer) {
        throw new Error(
            'AI provider returned an empty response.'
        );
    }

    return answer.slice(0, MAX_REPLY_CHARS);
}

async function sendChunked(sock, from, text, quoted) {
    const chunks = [];
    let remaining = String(text);

    while (remaining.length > 3500) {
        let cut = remaining.lastIndexOf('\n', 3500);

        if (cut < 1200) {
            cut = remaining.lastIndexOf(' ', 3500);
        }

        if (cut < 1200) {
            cut = 3500;
        }

        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).trimStart();
    }

    if (remaining) chunks.push(remaining);

    for (let index = 0; index < chunks.length; index++) {
        await sock.sendMessage(
            from,
            { text: chunks[index] },
            {
                quoted:
                    index === 0
                        ? quoted
                        : undefined
            }
        );
    }
}

function shouldIgnoreMessage(msg, from) {
    if (!msg?.message || msg.key?.fromMe) return true;
    if (!from) return true;

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

function queueForChat(chat, task) {
    const next = chat.queue
        .catch(() => {})
        .then(task);

    chat.queue = next.catch(() => {});

    return next;
}

async function processAIMessage(sock, msg, sessionId) {
    const from = msg?.key?.remoteJid;

    if (shouldIgnoreMessage(msg, from)) return;

    const text = getText(msg);

    if (!text) return;

    // Prefix commands must remain normal bot commands.
    if (text.startsWith('.')) return;

    const state = getSession(sessionId);

    await loadState(sessionId);

    const baseChat = getChatState(state, from);

    if (!baseChat.enabled) return;

    const senderId = getSender(msg, from);

    if (
        baseChat.ownerOnly &&
        !isOwnerMessage(sock, msg, from)
    ) {
        return;
    }

    const apiKey = process.env.AI_API_KEY;

    if (!apiKey) {
        await sock.sendMessage(
            from,
            {
                text:
                    '❌ AI_API_KEY is not configured.\n' +
                    'Add your AI API key to the bot runtime environment.'
            },
            { quoted: msg }
        );

        return;
    }

    const key = historyKey(
        from,
        baseChat.scope,
        senderId
    );

    await queueForChat(baseChat, async () => {
        try {
            const settings = await getSettings(sessionId);
            const histories = settings.aiHistories || {};

            const history =
                baseChat.memory
                    ? (
                        baseChat.scope === 'user'
                            ? (
                                Array.isArray(histories[key])
                                    ? histories[key]
                                    : []
                            )
                            : baseChat.history
                    )
                    : [];

            await sock
                .sendPresenceUpdate('composing', from)
                .catch(() => {});

            const answer = await askAI({
                apiKey,
                model: baseChat.model,
                systemPrompt: baseChat.systemPrompt,
                history,
                userText: text.slice(
                    0,
                    MAX_MESSAGE_CHARS
                )
            });

            if (baseChat.memory) {
                const updated = [
                    ...history,
                    {
                        role: 'user',
                        text: text.slice(
                            0,
                            MAX_MESSAGE_CHARS
                        )
                    },
                    {
                        role: 'assistant',
                        text: answer
                    }
                ].slice(-MAX_HISTORY_MESSAGES);

                if (baseChat.scope === 'user') {
                    const currentSettings =
                        await getSettings(sessionId);

                    const allHistories = {
                        ...(currentSettings.aiHistories || {})
                    };

                    allHistories[key] = updated;

                    await Settings.updateOne(
                        { id: 'main_settings' },
                        {
                            aiHistories: allHistories
                        }
                    );
                } else {
                    baseChat.history = updated;
                    await saveAllState(sessionId);
                }
            }

            await sendChunked(
                sock,
                from,
                answer,
                msg
            );
        } catch (err) {
            console.error(
                `[${sessionId}] AI Chat Error:`,
                err.message
            );

            await sock.sendMessage(
                from,
                {
                    text:
                        `❌ AI error: ${err.message || 'Unable to generate a response.'}`
                },
                { quoted: msg }
            );
        } finally {
            await sock
                .sendPresenceUpdate('paused', from)
                .catch(() => {});
        }
    });
}

function attachSocket(sock, sessionId) {
    if (!sock?.ev || !sessionId) return;

    const state = getSession(sessionId);

    if (state.attachedSockets.has(sock)) return;

    state.attachedSockets.add(sock);

    loadState(sessionId).catch(err => {
        console.error(
            `[${sessionId}] AI state load error:`,
            err.message
        );
    });

    sock.ev.on('messages.upsert', event => {
        for (const message of event?.messages || []) {
            runWithSession(
                sessionId,
                () => processAIMessage(
                    sock,
                    message,
                    sessionId
                )
            ).catch(err => {
                console.error(
                    `[${sessionId}] AI message handler error:`,
                    err.message
                );
            });
        }
    });
}

function patchSessionManager() {
    if (patchedManagers.has(SessionManager)) return;

    const originalConnect =
        SessionManager.prototype.connect;

    if (
        typeof originalConnect !== 'function'
    ) {
        return;
    }

    patchedManagers.add(SessionManager);

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

            if (entry?.sock) {
                attachSocket(
                    entry.sock,
                    sessionId
                );
            }

            return result;
        };
}

function commandName(text) {
    const match =
        String(text || '')
            .trim()
            .match(/^\.([^\s]+)/);

    return match
        ? match[1].toLowerCase()
        : 'aimode';
}

function helpText(chat) {
    return (
        '🤖 *AI Chat Controls*\n\n' +
        `Status: *${chat.enabled ? 'ON ✅' : 'OFF ❌'}*\n` +
        `Memory: *${chat.memory ? 'ON 🧠' : 'OFF 🗑️'}*\n` +
        `Scope: *${chat.scope}*\n` +
        `Owner only: *${chat.ownerOnly ? 'ON 🔒' : 'OFF 🌐'}*\n` +
        `Model: \`${chat.model}\`\n` +
        `System prompt: *${chat.systemPrompt ? 'Custom' : 'Default'}*\n\n` +
        '• `.aimode on` — enable full-chat AI\n' +
        '• `.aimode off` — disable full-chat AI\n' +
        '• `.aiclear` — clear this chat/user history\n' +
        '• `.aimemory on/off` — conversation memory\n' +
        '• `.aiscope chat/user` — shared chat or per-user memory\n' +
        '• `.aiowner on/off` — owner-only replies\n' +
        '• `.aimodel <model>` — select model\n' +
        '• `.aisystem <prompt>` — set system prompt\n' +
        '• `.aisystem reset` — reset system prompt\n' +
        '• `.aistatus` — show current settings'
    );
}

export default {
    pattern: 'aimode',
    alias: [
        'aichat',
        'aiclear',
        'aimemory',
        'aiscope',
        'aiowner',
        'aimodel',
        'aisystem',
        'aistatus'
    ],
    category: 'ai',
    desc: 'Full-chat AI mode and conversation controls',

    function: async (
        sock,
        msg,
        {
            from,
            args,
            config,
            isMe,
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
                        '❌ Unable to identify this bot session.'
                },
                { quoted: msg }
            );
        }

        const state = getSession(sessionId);

        await loadState(sessionId);

        const chat = getChatState(
            state,
            from
        );

        const command =
            commandName(text);

        const sub =
            String(args[0] || '')
                .trim()
                .toLowerCase();

        if (command === 'aimode') {
            if (
                sub === 'on' ||
                sub === 'off'
            ) {
                chat.enabled = sub === 'on';

                await saveAllState(
                    sessionId
                );

                return sock.sendMessage(
                    from,
                    {
                        text:
                            chat.enabled
                                ? '🤖 *AI Mode ON* ✅\n\nදැන් මේ chat එකේ `.` command එකක් නොවන සියලු messages AI conversation එකට යනවා.\n\n`.aimode off` දාලා normal mode එකට යන්න.'
                                : '🤖 *AI Mode OFF* ❌\n\nදැන් chat එක සාමාන්‍ය bot mode එකට ආවා.'
                    },
                    { quoted: msg }
                );
            }

            return sock.sendMessage(
                from,
                {
                    text: helpText(chat)
                },
                { quoted: msg }
            );
        }

        if (command === 'aiclear') {
            await clearHistory(
                sessionId,
                from,
                getSender(msg, from),
                chat.scope
            );

            if (chat.scope === 'chat') {
                chat.history = [];
            }

            return sock.sendMessage(
                from,
                {
                    text:
                        '🧹 *AI history cleared.*\n\nදැන් අලුත් conversation එකක් වගේ AI එකට කතා කරන්න පුළුවන්.'
                },
                { quoted: msg }
            );
        }

        if (command === 'aimemory') {
            if (
                sub !== 'on' &&
                sub !== 'off'
            ) {
                return sock.sendMessage(
                    from,
                    {
                        text:
                            '⚠️ Usage: `.aimemory on` / `.aimemory off`'
                    },
                    { quoted: msg }
                );
            }

            chat.memory = sub === 'on';

            if (!chat.memory) {
                await clearHistory(
                    sessionId,
                    from,
                    getSender(msg, from),
                    chat.scope
                );
            }

            await saveAllState(
                sessionId
            );

            return sock.sendMessage(
                from,
                {
                    text:
                        `🧠 AI Memory: *${chat.memory ? 'ON ✅' : 'OFF ❌'}*`
                },
                { quoted: msg }
            );
        }

        if (command === 'aiscope') {
            if (
                sub !== 'chat' &&
                sub !== 'user'
            ) {
                return sock.sendMessage(
                    from,
                    {
                        text:
                            '⚠️ Usage: `.aiscope chat` or `.aiscope user`\n\nchat = one shared conversation\nuser = separate memory for each user in a group'
                    },
                    { quoted: msg }
                );
            }

            chat.scope = sub;

            await saveAllState(
                sessionId
            );

            return sock.sendMessage(
                from,
                {
                    text:
                        `🧩 AI memory scope set to *${sub}*.\n\n${sub === 'chat' ? 'Everyone in this chat shares one conversation.' : 'Each user gets a separate conversation history.'}`
                },
                { quoted: msg }
            );
        }

        if (command === 'aiowner') {
            if (!isMe) {
                return sock.sendMessage(
                    from,
                    {
                        text:
                            '❌ `.aiowner` can only be changed by the bot owner.'
                    },
                    { quoted: msg }
                );
            }

            if (
                sub !== 'on' &&
                sub !== 'off'
            ) {
                return sock.sendMessage(
                    from,
                    {
                        text:
                            '⚠️ Usage: `.aiowner on` / `.aiowner off`'
                    },
                    { quoted: msg }
                );
            }

            chat.ownerOnly = sub === 'on';

            await saveAllState(
                sessionId
            );

            return sock.sendMessage(
                from,
                {
                    text:
                        `🔒 AI Owner-only mode: *${chat.ownerOnly ? 'ON' : 'OFF'}*`
                },
                { quoted: msg }
            );
        }

        if (command === 'aimodel') {
            const model =
                String(args.join(' ') || '')
                    .trim();

            if (!model) {
                return sock.sendMessage(
                    from,
                    {
                        text:
                            `🤖 Current model: \`${chat.model}\`\n\nUsage: \`.aimodel <model-id>\``
                    },
                    { quoted: msg }
                );
            }

            if (
                model.length > 120 ||
                /[\r\n]/.test(model)
            ) {
                return sock.sendMessage(
                    from,
                    {
                        text:
                            '❌ Invalid model id.'
                    },
                    { quoted: msg }
                );
            }

            chat.model = model;

            await saveAllState(
                sessionId
            );

            return sock.sendMessage(
                from,
                {
                    text:
                        `🤖 AI model set to \`${model}\``
                },
                { quoted: msg }
            );
        }

        if (command === 'aisystem') {
            if (
                sub === 'reset' ||
                !args.length
            ) {
                if (
                    sub === 'reset'
                ) {
                    chat.systemPrompt = '';

                    await saveAllState(
                        sessionId
                    );

                    return sock.sendMessage(
                        from,
                        {
                            text:
                                '🧠 AI system prompt reset to default.'
                        },
                        { quoted: msg }
                    );
                }

                return sock.sendMessage(
                    from,
                    {
                        text:
                            chat.systemPrompt
                                ? `🧠 Current system prompt:\n\n${chat.systemPrompt}`
                                : '🧠 No custom system prompt is set.\n\nUsage: `.aisystem <prompt>`'
                    },
                    { quoted: msg }
                );
            }

            const prompt =
                String(args.join(' '))
                    .trim()
                    .slice(
                        0,
                        MAX_SYSTEM_PROMPT_CHARS
                    );

            chat.systemPrompt = prompt;

            await saveAllState(
                sessionId
            );

            return sock.sendMessage(
                from,
                {
                    text:
                        '🧠 Custom AI system prompt saved.'
                },
                { quoted: msg }
            );
        }

        if (command === 'aistatus') {
            return sock.sendMessage(
                from,
                {
                    text: helpText(chat)
                },
                { quoted: msg }
            );
        }

        return sock.sendMessage(
            from,
            {
                text: helpText(chat)
            },
            { quoted: msg }
        );
    }
};
