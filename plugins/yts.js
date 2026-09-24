import yts from 'yt-search';

export default {    pattern: 'yts',
    category: 'download',
    desc: 'Search videos on YouTube',
    function: async (sock, msg, { from, args }) => {
        try {
            const query = args.join(' ');
            if (!query) {
                return await sock.sendMessage(from, { text: '⚠️ *කරුණාකර සෙවීමට අවශ්‍ය නම ලබාදෙන්න!* (උදා: `.yts Raghunandana`)' }, { quoted: msg });
            }

            // YouTube Search Execution
            const search = await yts(query);
            const videos = search.videos.slice(0, 10);

            if (!videos.length) {
                return await sock.sendMessage(from, { text: '❌ *කිසිදු YouTube ප්‍රතිඵලයක් හමු නොවීය.*' }, { quoted: msg });
            }

            let responseText = `🔍 *YOUTUBE SEARCH RESULTS* 🔍\n\n📌 *Query:* ${query}\n\n`;

            videos.forEach((video, index) => {
                responseText += `*${index + 1}.* ${video.title}\n`;
                responseText += `⏱️ *Duration:* ${video.timestamp} | 👤 *Channel:* ${video.author.name}\n`;
                responseText += `🔗 ${video.url}\n\n`;
            });

            await sock.sendMessage(from, { text: responseText.trim() }, { quoted: msg });

        } catch (error) {
            console.error('YTS Command Error:', error);
            await sock.sendMessage(from, { text: '❌ YouTube සෙවුම අතරතුර දෝෂයක් සිදු විය.' }, { quoted: msg });
        }
    }
}