import axios from 'axios';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import config from '../config.js';

function endpoint(sessionId, key) {
    return `${config.PAIR_BACKEND_URL}/internal/session/${encodeURIComponent(sessionId)}/auth/${encodeURIComponent(key)}`;
}

function options() {
    return {
        headers: { 'x-internal-token': config.INTERNAL_API_TOKEN },
        timeout: 30000
    };
}

export async function useRemoteAuthState(sessionId) {
    if (!sessionId) throw new Error('sessionId is required.');
    if (!config.PAIR_BACKEND_URL || !config.INTERNAL_API_TOKEN) {
        throw new Error('PAIR_BACKEND_URL and INTERNAL_API_TOKEN are required.');
    }

    const readData = async key => {
        try {
            const res = await axios.get(endpoint(sessionId, key), options());
            const value = res.data?.value;
            return value == null ? null : JSON.parse(JSON.stringify(value), BufferJSON.reviver);
        } catch (err) {
            if (err.response?.status !== 404) {
                console.error(`[AUTH READ ${sessionId}] ${key}:`, err.message);
            }
            return null;
        }
    };

    const writeData = async (key, data) => {
        const value = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await axios.put(endpoint(sessionId, key), { value }, options());
    };

    const removeData = async key => {
        try {
            await axios.delete(endpoint(sessionId, key), options());
        } catch (err) {
            console.error(`[AUTH DELETE ${sessionId}] ${key}:`, err.message);
        }
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);

                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }

                        data[id] = value;
                    }));
                    return data;
                },
                set: async data => {
                    const tasks = [];

                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(key, value) : removeData(key));
                        }
                    }

                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData('creds', creds)
    };
}
