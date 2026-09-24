import os from 'os';

function runtime(seconds) {
    seconds = Number(seconds);
    var d = Math.floor(seconds / (3600 * 24));
    var h = Math.floor((seconds % (3600 * 24)) / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = Math.floor(seconds % 60);
    var dDisplay = d > 0 ? d + (d == 1 ? " day, " : " days, ") : "";
    var hDisplay = h > 0 ? h + (h == 1 ? " hour, " : " hours, ") : "";
    var mDisplay = m > 0 ? m + (m == 1 ? " min, " : " mins, ") : "";
    var sDisplay = s > 0 ? s + (s == 1 ? " sec" : " secs") : "";
    return dDisplay + hDisplay + mDisplay + sDisplay;
}

export default {    pattern: 'ping',
    category: 'main',
    desc: 'Check bot speed, system uptime and RAM status',
    function: async (sock, msg, { from, config }) => {
        const start = Date.now();
        
        // Initial Message
        const sentMsg = await sock.sendMessage(from, { text: '⚡ *Measuring performance...*' }, { quoted: msg });
        const latency = Date.now() - start;

        // System Details
        const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
        const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
        const usedMem = (totalMem - freeMem).toFixed(2);
        const uptime = runtime(process.uptime());

        const responseText = `━━━━━━━ 🍃 *${config.BOT_NAME}* 🍃 ━━━━━━━

🚀 *Speed:* \`${latency} ms\`
⏱️ *Uptime:* \`${uptime}\`
💾 *RAM Usage:* \`${usedMem} GB / ${totalMem} GB\`
🖥️ *Platform:* \`${os.platform()} (${os.arch()})\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

        await sock.sendMessage(from, { text: responseText }, { quoted: sentMsg });
    }
}
