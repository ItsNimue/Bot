import express from 'express';
import cors from 'cors';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import config from './config.js';
import { connectDB } from './lib/database.js';
import { SessionManager } from './lib/sessionManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commands = new Map();

async function loadPlugins() {
    const pluginsDir = path.join(__dirname, 'plugins');

    if (!fs.existsSync(pluginsDir)) {
        fs.mkdirSync(pluginsDir, { recursive: true });
    }

    const files = fs
        .readdirSync(pluginsDir)
        .filter(file => file.endsWith('.js'));

    for (const file of files) {
        try {
            const module = await import(
                pathToFileURL(
                    path.join(pluginsDir, file)
                ).href
            );

            const plugin = module.default;

            if (plugin?.pattern) {
                commands.set(plugin.pattern.toLowerCase(), plugin);

                const aliases = Array.isArray(plugin.alias)
                    ? plugin.alias
                    : (plugin.alias ? [plugin.alias] : []);

                for (const alias of aliases) {
                    if (!alias) continue;
                    const key = String(alias).toLowerCase();

                    if (commands.has(key)) {
                        console.warn(`⚠️ Alias "${key}" (from ${file}) conflicts and was skipped.`);
                        continue;
                    }

                    commands.set(key, plugin);
                }
            }
        } catch (err) {
            console.error(
                `❌ Plugin Load Error [${file}]:`,
                err.message
            );
        }
    }

    console.log(
        `✅ Loaded ${commands.size} plugins successfully.`
    );
}

function requireInternal(req, res, next) {
    if (
        !config.INTERNAL_API_TOKEN ||
        req.get('x-internal-token') !==
            config.INTERNAL_API_TOKEN
    ) {
        return res.status(401).json({
            error: 'Unauthorized.'
        });
    }

    next();
}

async function autoResumeSessions(manager) {
    if (!config.PAIR_BACKEND_URL || !config.INTERNAL_API_TOKEN) return;

    try {
        const res = await axios.get(
            `${config.PAIR_BACKEND_URL}/internal/sessions/active`,
            {
                headers: { 'x-internal-token': config.INTERNAL_API_TOKEN },
                timeout: 30000
            }
        );

        const sessionIds = res.data?.sessionIds || [];
        console.log(`🔄 Resuming ${sessionIds.length} previously linked session(s)...`);

        for (const sessionId of sessionIds) {
            manager.start(sessionId).catch(err => {
                console.error(`[${sessionId}] Auto-resume failed:`, err.message);
            });
        }
    } catch (err) {
        console.error('Auto-resume sessions fetch failed:', err.message);
    }
}

async function start() {
    await connectDB();
    await loadPlugins();

    const manager =
        new SessionManager(config, commands);

    const app = express();

    app.use(cors());
    app.use(express.json({ limit: '1mb' }));

    app.get('/', (_req, res) => {
        res.json({
            ok: true,
            service: 'MrNobody Bot Runtime',
            sessions: manager.sessions.size
        });
    });

    app.get('/health', (_req, res) => {
        res.json({
            ok: true,
            sessions: manager.sessions.size
        });
    });

    app.post(
        '/internal/sessions/start',
        requireInternal,
        async (req, res) => {
            try {
                const { sessionId } =
                    req.body || {};

                if (!sessionId) {
                    return res.status(400).json({
                        error:
                            'sessionId is required.'
                    });
                }

                const result =
                    await manager.start(
                        sessionId
                    );

                res.status(202).json(result);
            } catch (err) {
                console.error(
                    'Runtime Start Error:',
                    err
                );

                res.status(500).json({
                    error: err.message
                });
            }
        }
    );

    app.post(
        '/internal/sessions/stop',
        requireInternal,
        async (req, res) => {
            const { sessionId } =
                req.body || {};

            if (!sessionId) {
                return res.status(400).json({
                    error:
                        'sessionId is required.'
                });
            }

            await manager.stop(sessionId);

            res.json({ ok: true });
        }
    );

    app.get(
        '/internal/sessions',
        requireInternal,
        (_req, res) => {
            res.json({
                sessions:
                    [...manager.sessions.entries()]
                        .map(([sessionId, entry]) => ({
                            sessionId,
                            status: entry.sock
                                ? 'online_or_connecting'
                                : 'starting'
                        }))
            });
        }
    );

    app.listen(config.PORT, () => {
        console.log(
            `🚀 MrNobody Bot Runtime listening on ${config.PORT}`
        );
    });

    await autoResumeSessions(manager);

    // Backwards compatibility only.
    // New deployments should NOT set SESSION_ID.
    if (config.SESSION_ID) {
        manager.start(config.SESSION_ID)
            .catch(err => {
                console.error(
                    'Legacy SESSION_ID start failed:',
                    err.message
                );
            });
    }
}

process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM — shutting down gracefully.');
    process.exit(0);
});

start().catch(err => {
    console.error(
        '❌ Bot Runtime startup failed:',
        err
    );

    process.exit(1);
});
