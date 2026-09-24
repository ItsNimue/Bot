import makeWASocket, {
    DisconnectReason,
    fetchLatestWaWebVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { runWithSession, getSettings } from './database.js';
import { useRemoteAuthState } from './remoteAuthState.js';
import { reportRuntimeStatus } from './runtimeClient.js';
import { storeMessage, handleDeletedMessage } from './antidelete.js';
import { handleAntiLink } from './antilink.js';
import { handleAntiCall } from './anticall.js';
import { handleVvEmoji } from './vvemoji.js';

export class SessionManager {
    constructor(config, commands) {
        this.config = config;
        this.commands = commands;
        this.sessions = new Map();
    }

    async start(sessionId) {
        if (!sessionId) throw new Error('sessionId is required.');

        const existing = this.sessions.get(sessionId);

        if (existing?.sock || existing?.starting) {
            return { ok: true, status: 'already_running' };
        }

        const entry = {
            sock: null,
            starting: true,
            stopping: false,
            reconnectTimer: null
        };

        this.sessions.set(sessionId, entry);

        await reportRuntimeStatus(sessionId, 'starting');

        this.connect(sessionId, entry).catch(async err => {
            console.error(`[${sessionId}] Start Error:`, err);
            await reportRuntimeStatus(sessionId, 'failed', err.message);
        });

        return { ok: true, status: 'starting' };
    }

    async stop(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry) return;

        entry.stopping = true;

        if (entry.reconnectTimer) {
            clearTimeout(entry.reconnectTimer);
        }

        try {
            entry.sock?.end(undefined);
        } catch {}

        this.sessions.delete(sessionId);
    }

    async connect(sessionId, entry) {
        await runWithSession(sessionId, async () => {
            const { state, saveCreds } =
                await useRemoteAuthState(sessionId);

            if (!state.creds.registered) {
                throw new Error(
                    'WhatsApp auth state is not registered.'
                );
            }

            const { version } =
                await fetchLatestWaWebVersion();

            const sock = makeWASocket({
                version,
                logger: pino({ level: 'silent' }),
                auth: state,
                browser: ['Ubuntu', 'Chrome', '20.0.0.4']
            });

            entry.sock = sock;
            entry.starting = false;

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('call', async calls => {
                try {
                    await runWithSession(
                        sessionId,
                        () => handleAntiCall(sock, calls)
                    );
                } catch (err) {
                    console.error(
                        `[${sessionId}] AntiCall Error:`,
                        err.message
                    );
                }
            });

            sock.ev.on('connection.update', async update => {
                const { connection, lastDisconnect } = update;

                if (connection === 'open') {
                    await reportRuntimeStatus(
                        sessionId,
                        'online'
                    );

                    console.log(
                        `[${sessionId}] ✅ Bot online.`
                    );

                    return;
                }

                if (connection === 'close') {
                    entry.sock = null;

                    if (entry.stopping) return;

                    const statusCode =
                        lastDisconnect?.error?.output?.statusCode;

                    if (
                        statusCode === DisconnectReason.loggedOut
                    ) {
                        await reportRuntimeStatus(
                            sessionId,
                            'logged_out'
                        );

                        this.sessions.delete(sessionId);
                        return;
                    }

                    await reportRuntimeStatus(
                        sessionId,
                        'offline'
                    );

                    entry.reconnectTimer = setTimeout(() => {
                        this.connect(sessionId, entry)
                            .catch(async err => {
                                console.error(
                                    `[${sessionId}] Reconnect Error:`,
                                    err.message
                                );

                                await reportRuntimeStatus(
                                    sessionId,
                                    'failed',
                                    err.message
                                );
                            });
                    }, 5000);
                }
            });

            sock.ev.on('messages.upsert', async event => {
                try {
                    const msg = event.messages?.[0];

                    if (!msg?.message) return;

                    await runWithSession(
                        sessionId,
                        async () => {
                            storeMessage(msg, sessionId);

                            await handleDeletedMessage(
                                sock,
                                msg,
                                sessionId
                            );

                            await handleAntiLink(
                                sock,
                                msg
                            );

                            await handleVvEmoji(
                                sock,
                                msg
                            );

                            const from =
                                msg.key.remoteJid;

                            if (!from) return;

                            const isGroup =
                                from.endsWith('@g.us');

                            const isMe =
                                msg.key.fromMe;

                            const text =
                                msg.message.conversation ||
                                msg.message.extendedTextMessage?.text ||
                                msg.message.imageMessage?.caption ||
                                msg.message.videoMessage?.caption ||
                                '';

                            if (
                                !text.startsWith(
                                    this.config.PREFIX
                                )
                            ) {
                                return;
                            }

                            const args = text
                                .slice(
                                    this.config.PREFIX.length
                                )
                                .trim()
                                .split(/ +/);

                            const cmdName =
                                args.shift()?.toLowerCase();

                            if (!cmdName) return;

                            const cmd =
                                this.commands.get(cmdName);

                            if (!cmd) return;

                            const sessionConfig = {
                                ...this.config,
                                SESSION_ID: sessionId,
                                getSettings: () =>
                                    getSettings(sessionId)
                            };

                            await cmd.function(
                                sock,
                                msg,
                                {
                                    from,
                                    args,
                                    text,
                                    config: sessionConfig,
                                    isMe,
                                    isGroup
                                }
                            );
                        }
                    );
                } catch (err) {
                    console.error(
                        `[${sessionId}] Message Error:`,
                        err
                    );
                }
            });
        });
    }
}
