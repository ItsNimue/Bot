import axios from 'axios';
import config from '../config.js';

export async function reportRuntimeStatus(sessionId, status, error = null) {
    try {
        await axios.post(
            `${config.PAIR_BACKEND_URL}/internal/runtime/status`,
            { sessionId, status, error },
            {
                headers: { 'x-internal-token': config.INTERNAL_API_TOKEN },
                timeout: 15000
            }
        );
    } catch (err) {
        console.error(`[RUNTIME STATUS ${sessionId}]`, err.message);
    }
}
