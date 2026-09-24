import { getSettings, Settings } from './database.js';

function warningKey(groupId, userId) {
    return `${groupId}:${userId}`;
}

async function getWarningCount(groupId, userId) {
    const settings = await getSettings();
    return Number(settings.warnings?.[warningKey(groupId, userId)] || 0);
}

async function addWarning(groupId, userId) {
    const settings = await getSettings();
    const warnings = { ...(settings.warnings || {}) };
    const key = warningKey(groupId, userId);

    warnings[key] = Number(warnings[key] || 0) + 1;

    await Settings.updateOne({}, { warnings });

    return warnings[key];
}

async function resetWarning(groupId, userId) {
    const settings = await getSettings();
    const warnings = { ...(settings.warnings || {}) };
    delete warnings[warningKey(groupId, userId)];

    await Settings.updateOne({}, { warnings });
}

export { getWarningCount, addWarning, resetWarning };
