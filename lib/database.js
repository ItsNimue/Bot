import axios from 'axios';
import { AsyncLocalStorage } from 'node:async_hooks';
import config from '../config.js';

const sessionContext = new AsyncLocalStorage();

const DEFAULT_SETTINGS = {
    antiDelete: false,
    antiDeleteSend: 'inbox',
    antiDeleteMode: 'public',
    vvMode: 'public',
    vvSend: 'chat',
    vvEmoji: false,
    vvEmojiSend: 'chat',
    getdpMode: 'public',
    getdpSend: 'chat',
    antiLink: false,
    antiCall: false,
    warnLimit: 3,
    groupGuardMode: 'admins',
    warnings: {}
};

function requireSession(id = sessionContext.getStore()) {
    if (!id) throw new Error('No active bot session.');
    return id;
}

function settingsUrl(sessionId) {
    return `${config.PAIR_BACKEND_URL}/internal/session/${encodeURIComponent(sessionId)}/settings`;
}

const requestOptions = () => ({
    headers: { 'x-internal-token': config.INTERNAL_API_TOKEN },
    timeout: 30000
});

export function getCurrentSessionId() {
    return sessionContext.getStore() || null;
}

export function runWithSession(sessionId, fn) {
    return sessionContext.run(sessionId, fn);
}

export async function connectDB() {
    if (!config.PAIR_BACKEND_URL || !config.INTERNAL_API_TOKEN) {
        throw new Error('PAIR_BACKEND_URL and INTERNAL_API_TOKEN are required.');
    }
}

export async function getSettings(sessionId = sessionContext.getStore()) {
    const id = requireSession(sessionId);

    const res = await axios.get(settingsUrl(id), requestOptions());

    return {
        ...DEFAULT_SETTINGS,
        ...(res.data?.data || {})
    };
}

export const Settings = {
    updateOne: async (_filter, updateFields = {}) => {
        const id = requireSession();
        const current = await getSettings(id);
        const next = { ...current, ...updateFields };

        await axios.put(
            settingsUrl(id),
            { data: next },
            requestOptions()
        );

        return { acknowledged: true };
    }
};
