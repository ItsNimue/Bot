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

/*
 * Gemini models
 */

const DEFAULT_MODEL =
    process.env.AI_MODEL || 'gemini-3.5-flash-lite';

const IMAGE_MODEL =
    process.env.AI_IMAGE_MODEL || 'gemini-3.1-flash-image';

const AI_API_URL = (
    process.env.AI_API_URL ||
    'https://generativelanguage.googleapis.com/v1beta/models'
).replace(/\/+$/, '');

/*
 * Gemini inline media should be kept reasonably small.
 * Video inline input is documented for requests under 20MB.
 */

const MAX_INLINE_MEDIA_BYTES =
    18 * 1024 * 1024;

const MAX_MEDIA_DOWNLOAD_BYTES =
    25 * 1024 * 1024;

const sessionStates = new Map();
const patchedManagers = new WeakSet();


/* =========================================================
 * SESSION STATE
 * ========================================================= */

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


/* =========================================================
 * MESSAGE HELPERS
 * ========================================================= */

function unwrapMessage(message) {
    let current = message;

    for (let i = 0; i < 5; i++) {
        if (!current) {
            break;
        }

        if (current.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;
            continue;
        }

        if (current.viewOnceMessage?.message) {
            current = current.viewOnceMessage.message;
            continue;
        }

        if (current.viewOnceMessageV2?.message) {
            current = current.viewOnceMessageV2.message;
            continue;
        }

        if (current.viewOnceMessageV2Extension?.message) {
            current = current.viewOnceMessageV2Extension.message;
            continue;
        }

        break;
    }

    return current || message;
}


function getMessageContent(msg) {
    return unwrapMessage(
        msg?.message || {}
    );
}


function getText(msg) {
    const message =
        getMessageContent(msg);

    return (
        message?.conversation ||
        message?.extendedTextMessage?.text ||
        message?.imageMessage?.caption ||
        message?.videoMessage?.caption ||
        message?.documentMessage?.caption ||
        message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        ''
    ).trim();
}


function getMediaInfo(msg) {
    const message =
        getMessageContent(msg);

    if (message?.imageMessage) {
        return {
            type: 'image',
            message: message.imageMessage,
            mimeType:
                message.imageMessage.mimetype ||
                'image/jpeg'
        };
    }

    if (message?.videoMessage) {
        return {
            type: 'video',
            message: message.videoMessage,
            mimeType:
                message.videoMessage.mimetype ||
                'video/mp4'
        };
    }

    if (message?.audioMessage) {
        return {
            type: 'audio',
            message: message.audioMessage,
            mimeType:
                message.audioMessage.mimetype ||
                'audio/ogg'
        };
    }

    if (message?.documentMessage) {
        const mime =
            message.documentMessage.mimetype || '';

        if (
            mime.startsWith('image/') ||
            mime.startsWith('video/') ||
            mime.startsWith('audio/')
        ) {
            return {
                type:
                    mime.startsWith('image/')
                        ? 'image'
                        : mime.startsWith('video/')
                            ? 'video'
                            : 'audio',

                message:
                    message.documentMessage,

                mimeType:
                    mime
            };
        }
    }

    return null;
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


/* =========================================================
 * CHAT STATE
 * ========================================================= */

function getChat(sessionId, chatId) {
    const state =
        getSessionState(sessionId);

    let chat =
        state.chats.get(chatId);

    if (!chat) {
        chat = {
            enabled: false,
            memory: true,
            model: DEFAULT_MODEL,
            systemPrompt: '',
            history: [],
            queue: Promise.resolve()
        };

        state.chats.set(
            chatId,
            chat
        );
    }

    return chat;
}


async function loadState(sessionId) {
    const state =
        getSessionState(sessionId);

    if (state.loading) {
        return state.loading;
    }

    state.loading = (async () => {
        const settings =
            await getSettings(sessionId);

        const modes =
            settings.aiModeChats || {};

        const histories =
            settings.aiHistories || {};

        state.chats.clear();

        for (
            const [chatId, raw]
            of Object.entries(modes)
        ) {
            const chat =
                getChat(
                    sessionId,
                    chatId
                );

            chat.enabled =
                raw?.enabled === true;

            chat.memory =
                raw?.memory !== false;

            chat.model =
                raw?.model ||
                DEFAULT_MODEL;

            chat.systemPrompt =
                String(
                    raw?.systemPrompt || ''
                ).slice(
                    0,
                    MAX_SYSTEM_PROMPT_CHARS
                );

            chat.history =
                Array.isArray(
                    histories[chatId]
                )
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


async function saveChat(
    sessionId,
    chatId
) {
    const chat =
        getChat(
            sessionId,
            chatId
        );

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
            chat.model ||
            DEFAULT_MODEL,

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
 * MEDIA DOWNLOAD
 * ========================================================= */

async function downloadWhatsAppMedia(
    sock,
    msg
) {
    /*
     * Prefer Baileys downloadMediaMessage.
     * It is dynamically imported so this plugin remains
     * self-contained.
     */

    try {
        const baileys =
            await import(
                '@whiskeysockets/baileys'
            );

        if (
            typeof baileys.downloadMediaMessage ===
            'function'
        ) {
            const buffer =
                await baileys.downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    {
                        logger: undefined,
                        reuploadRequest:
                            sock?.updateMediaMessage
                                ? sock.updateMediaMessage.bind(sock)
                                : undefined
                    }
                );

            if (Buffer.isBuffer(buffer)) {
                return buffer;
            }

            if (buffer) {
                return Buffer.from(buffer);
            }
        }
    } catch (err) {
        console.error(
            'AI media download via Baileys failed:',
            err?.message || err
        );
    }


    /*
     * Some WhatsApp wrappers expose the method directly
     * on the socket.
     */

    if (
        typeof sock?.downloadMediaMessage ===
        'function'
    ) {
        const buffer =
            await sock.downloadMediaMessage(
                msg
            );

        if (Buffer.isBuffer(buffer)) {
            return buffer;
        }

        if (buffer) {
            return Buffer.from(buffer);
        }
    }


    throw new Error(
        'Could not download WhatsApp media.'
    );
}


/* =========================================================
 * MEDIA SAFETY
 * ========================================================= */

function validateMediaSize(
    buffer,
    mediaInfo
) {
    if (!buffer) {
        throw new Error(
            'Media download returned empty data.'
        );
    }

    const size =
        buffer.length;

    if (
        size >
        MAX_INLINE_MEDIA_BYTES
    ) {
        throw new Error(
            `${mediaInfo.type} is too large for inline Gemini processing. Please send a smaller file (under 18MB).`
        );
    }

    if (
        size >
        MAX_MEDIA_DOWNLOAD_BYTES
    ) {
        throw new Error(
            'Media file is too large.'
        );
    }
}


/* =========================================================
 * IMAGE GENERATION DETECTION
 * ========================================================= */

function isImageGenerationRequest(
    text,
    hasImage
) {
    const value =
        String(text || '')
            .toLowerCase()
            .trim();

    if (!value) {
        return false;
    }


    /*
     * English
     */

    const englishPatterns = [
        /\bgenerate\b.*\bimage\b/,
        /\bgenerate\b.*\bpicture\b/,
        /\bcreate\b.*\bimage\b/,
        /\bcreate\b.*\bpicture\b/,
        /\bmake\b.*\bimage\b/,
        /\bmake\b.*\bpicture\b/,
        /\bdraw\b/,
        /\bpaint\b/,
        /\bdesign\b.*\bimage\b/,
        /\bcreate\b.*\bart\b/,
        /\bgenerate\b.*\bart\b/,
        /\bturn\b.*\binto\b.*\bimage\b/,
        /\bedit\b.*\bimage\b/,
        /\bedit\b.*\bphoto\b/,
        /\bmodify\b.*\bimage\b/,
        /\btransform\b.*\bimage\b/,
        /\bchange\b.*\bbackground\b/
    ];

    if (
        englishPatterns.some(
            pattern =>
                pattern.test(value)
        )
    ) {
        return true;
    }


    /*
     * Sinhala / Singlish patterns
     */

    const sinhalaPatterns = [
        /පින්තූරයක්.*හද/,
        /පින්තූර.*හද/,
        /image.*හද/,
        /image.*කර/,
        /photo.*හද/,
        /photo.*කර/,
        /පින්තූරයක්.*දෙන්න/,
        /පින්තූර.*දෙන්න/,
        /රූපයක්.*හද/,
        /රූප.*හද/,
        /generate.*කර/,
        /create.*කර/,
        /draw.*කර/,
        /background.*change.*කර/
    ];

    if (
        sinhalaPatterns.some(
            pattern =>
                pattern.test(value)
        )
    ) {
        return true;
    }


    /*
     * If an image was supplied and the user clearly
     * asks for an edit/change, generate an image.
     */

    if (hasImage) {
        const editPatterns = [
            /\bedit\b/,
            /\bmodify\b/,
            /\bchange\b/,
            /\bremove\b/,
            /\badd\b/,
            /\breplace\b/,
            /\btransform\b/,
            /\bmake\b/,
            /\bturn\b/,
            /වෙනස්/,
            /මාරු/,
            /අයින්/,
            /දාන්න/,
            /එකතු/
        ];

        if (
            editPatterns.some(
                pattern =>
                    pattern.test(value)
            )
        ) {
            return true;
        }
    }


    return false;
}


/* =========================================================
 * GEMINI CONTENT PARTS
 * ========================================================= */

function historyToContents(
    history
) {
    const contents = [];

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
            ].includes(
                item.role
            ) ||
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

    return contents;
}


/* =========================================================
 * GEMINI TEXT / MULTIMODAL REQUEST
 * ========================================================= */

async function askAI({
    apiKey,
    model,
    systemPrompt,
    history,
    userText,
    media
}) {
    const contents =
        historyToContents(
            history
        );


    const currentParts = [];


    /*
     * Media first.
     */

    if (media?.buffer) {
        currentParts.push({
            inlineData: {
                mimeType:
                    media.mimeType,

                data:
                    media.buffer.toString(
                        'base64'
                    )
            }
        });
    }


    /*
     * Current text.
     */

    let prompt =
        String(
            userText || ''
        ).trim();


    if (!prompt) {
        if (
            media?.type === 'image'
        ) {
            prompt =
                'Analyze this image carefully and describe what you see. Answer naturally and helpfully.';
        } else if (
            media?.type === 'video'
        ) {
            prompt =
                'Analyze this video carefully and explain what happens in it. Answer naturally and helpfully.';
        } else if (
            media?.type === 'audio'
        ) {
            prompt =
                'Listen to this audio carefully, understand what is being said, and respond naturally to it.';
        } else {
            prompt =
                'Respond naturally and helpfully.';
        }
    }


    currentParts.push({
        text:
            prompt.slice(
                0,
                MAX_MESSAGE_CHARS
            )
    });


    contents.push({
        role: 'user',
        parts: currentParts
    });


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
        model ||
        DEFAULT_MODEL;


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

                timeout:
                    media?.type === 'video'
                        ? 120000
                        : 60000,

                maxContentLength:
                    Infinity,

                maxBodyLength:
                    Infinity,

                validateStatus:
                    () => true
            }
        );


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


    const candidates =
        response.data?.candidates ||
        [];

    const parts =
        candidates?.[0]?.content?.parts ||
        [];


    const answer =
        parts
            .filter(
                part =>
                    !part?.thought
            )
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


    return {
        text:
            answer.slice(
                0,
                MAX_REPLY_CHARS
            ),

        image:
            null
    };
}


/* =========================================================
 * GEMINI IMAGE GENERATION
 * ========================================================= */

async function generateImage({
    apiKey,
    systemPrompt,
    history,
    userText,
    media
}) {
    const contents = [];


    /*
     * Keep text history, but avoid sending too much.
     */

    for (
        const item of
        history.slice(
            -8
        )
    ) {
        if (
            !item ||
            !item.text ||
            ![
                'user',
                'assistant'
            ].includes(
                item.role
            )
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


    const currentParts = [];


    /*
     * Existing image for image editing.
     */

    if (
        media?.type === 'image' &&
        media?.buffer
    ) {
        currentParts.push({
            inlineData: {
                mimeType:
                    media.mimeType ||
                    'image/jpeg',

                data:
                    media.buffer.toString(
                        'base64'
                    )
            }
        });
    }


    let prompt =
        String(
            userText || ''
        ).trim();


    if (!prompt) {
        prompt =
            'Create a high quality image based on the provided image.';
    }


    currentParts.push({
        text:
            prompt
    });


    contents.push({
        role: 'user',
        parts: currentParts
    });


    const body = {
        contents,

        generationConfig: {
            responseModalities: [
                'IMAGE',
                'TEXT'
            ]
        }
    };


    /*
     * System prompt
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


    const response =
        await axios.post(
            `${AI_API_URL}/${encodeURIComponent(
                IMAGE_MODEL
            )}:generateContent`,
            body,
            {
                headers: {
                    'x-goog-api-key':
                        apiKey,

                    'Content-Type':
                        'application/json'
                },

                timeout:
                    180000,

                maxContentLength:
                    Infinity,

                maxBodyLength:
                    Infinity,

                validateStatus:
                    () => true
            }
        );


    if (
        response.status < 200 ||
        response.status >= 300
    ) {
        const apiError =
            response.data?.error;

        const message =
            apiError?.message ||
            `Gemini image API returned HTTP ${response.status}`;

        throw new Error(
            message
        );
    }


    const candidates =
        response.data?.candidates ||
        [];

    const parts =
        candidates?.[0]?.content?.parts ||
        [];


    let image = null;
    let text = '';


    for (
        const part of parts
    ) {
        if (
            part?.inlineData?.data
        ) {
            const mimeType =
                part.inlineData.mimeType ||
                'image/png';

            if (
                mimeType.startsWith(
                    'image/'
                )
            ) {
                image = {
                    buffer:
                        Buffer.from(
                            part.inlineData.data,
                            'base64'
                        ),

                    mimeType
                };
            }
        }


        if (
            part?.text &&
            !part?.thought
        ) {
            text +=
                part.text;
        }
    }


    if (!image) {
        throw new Error(
            'Gemini did not return a generated image.'
        );
    }


    return {
        text:
            text.trim(),

        image
    };
}


/* =========================================================
 * SEND TEXT REPLY
 * ========================================================= */

async function sendReply(
    sock,
    from,
    text,
    quoted
) {
    const chunks = [];

    let remaining =
        String(text || '');


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
 * SEND GENERATED IMAGE
 * ========================================================= */

async function sendGeneratedImage(
    sock,
    from,
    image,
    caption,
    quoted
) {
    if (
        !image?.buffer
    ) {
        return;
    }


    const message = {
        image:
            image.buffer
    };


    if (caption) {
        message.caption =
            caption.slice(
                0,
                1000
            );
    }


    await sock.sendMessage(
        from,
        message,
        {
            quoted
        }
    );
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
 * MEDIA HISTORY TEXT
 * ========================================================= */

function getHistoryUserText(
    text,
    media
) {
    const clean =
        String(
            text || ''
        ).trim();


    if (clean) {
        if (media?.type) {
            return (
                `[User sent ${media.type}]\n` +
                clean
            );
        }

        return clean;
    }


    if (
        media?.type === 'image'
    ) {
        return (
            '[User sent an image and asked the AI to analyze it.]'
        );
    }

    if (
        media?.type === 'video'
    ) {
        return (
            '[User sent a video and asked the AI to analyze it.]'
        );
    }

    if (
        media?.type === 'audio'
    ) {
        return (
            '[User sent an audio message and asked the AI to understand it.]'
        );
    }


    return '';
}


/* =========================================================
 * HANDLE INCOMING MESSAGE
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

    const mediaInfo =
        getMediaInfo(msg);


    /*
     * Ignore completely unsupported messages.
     */

    if (
        !text &&
        !mediaInfo
    ) {
        return;
    }


    /*
     * Dot commands are handled by the
     * command system.
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


                /*
                 * Download media if present.
                 */

                let media = null;


                if (mediaInfo) {
                    const buffer =
                        await downloadWhatsAppMedia(
                            sock,
                            msg
                        );


                    validateMediaSize(
                        buffer,
                        mediaInfo
                    );


                    media = {
                        type:
                            mediaInfo.type,

                        mimeType:
                            mediaInfo.mimeType,

                        buffer
                    };
                }


                /*
                 * Image generation / editing
                 */

                const shouldGenerateImage =
                    isImageGenerationRequest(
                        userText,
                        media?.type ===
                            'image'
                    );


                let result;


                if (
                    shouldGenerateImage
                ) {
                    result =
                        await generateImage({
                            apiKey,

                            systemPrompt:
                                chat.systemPrompt,

                            history:
                                chat.memory
                                    ? chat.history
                                    : [],

                            userText,

                            media
                        });

                } else {
                    result =
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

                            userText,

                            media
                        });
                }


                /*
                 * Save conversation history.
                 */

                if (
                    chat.memory
                ) {
                    const historyUserText =
                        getHistoryUserText(
                            userText,
                            media
                        );


                    if (
                        historyUserText
                    ) {
                        const historyItems = [
                            {
                                role:
                                    'user',

                                text:
                                    historyUserText
                            }
                        ];


                        if (
                            result.text
                        ) {
                            historyItems.push({
                                role:
                                    'assistant',

                                text:
                                    result.text
                            });
                        } else if (
                            result.image
                        ) {
                            historyItems.push({
                                role:
                                    'assistant',

                                text:
                                    '[AI generated an image.]'
                            });
                        }


                        chat.history = [
                            ...chat.history,
                            ...historyItems
                        ].slice(
                            -MAX_HISTORY_MESSAGES
                        );


                        await saveChat(
                            sessionId,
                            from
                        );
                    }
                }


                /*
                 * If Gemini generated an image,
                 * send it first.
                 */

                if (
                    result.image
                ) {
                    await sendGeneratedImage(
                        sock,
                        from,
                        result.image,
                        result.text,
                        msg
                    );


                    return;
                }


                /*
                 * Normal text response.
                 */

                if (
                    result.text
                ) {
                    await sendReply(
                        sock,
                        from,
                        result.text,
                        msg
                    );
                }

            } catch (err) {
                console.error(
                    `[${sessionId}] Gemini AI error:`,
                    err
                );


                let errorText =
                    err?.message ||
                    'Unable to generate a response.';


                /*
                 * Keep API error messages useful
                 * but don't expose giant JSON payloads.
                 */

                if (
                    errorText.length > 1200
                ) {
                    errorText =
                        errorText.slice(
                            0,
                            1200
                        );
                }


                await sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ Gemini AI error:\n${errorText}`
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

        `Model: \`${chat.model}\`\n` +

        `Image Model: \`${IMAGE_MODEL}\`\n\n` +

        '`.aimode on` — AI ON for this chat\n' +

        '`.aimode off` — AI OFF for this chat\n' +

        '`.aiclear` — clear AI history\n' +

        '`.aimemory on/off` — memory control\n' +

        '`.aimodel <model>` — change model\n' +

        '`.aisystem <prompt>` — set system prompt\n' +

        '`.aisystem reset` — reset system prompt\n' +

        '`.aistatus` — show status\n\n' +

        '🖼️ Images • 🎥 Videos • 🎤 Voice • 🎨 Image generation supported'
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

    desc: 'Gemini AI multimodal conversation mode',

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

                                ? '🤖 *AI MODE ON* ✅\n\nදැන් මේ chat එකේ text, images, videos සහ voice messages Gemini AI conversation එකට යනවා.\n\n🎨 Image generate/edit requests වලට image reply එකකුත් එනවා.\n\n`.aimode off` දාලා normal mode එකට යන්න.'

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
                            `🤖 Current model: \`${chat.model}\`\n🎨 Image model: \`${IMAGE_MODEL}\``
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
