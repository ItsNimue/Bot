import yts from 'yt-search';
import yt from '@vreden/youtube_scraper';
import axios from 'axios';
import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';

ffmpeg.setFfmpegPath(ffmpegPath);

const MAX_FILE_SIZE = 80 * 1000 * 1000;

// Multi-session Storage with Auto TTL Expiry ( Memory Leak & Collision Prevent )
const songSessions = new Map();
let isListenerAttached = false;

// Cleanup sessions older than 5 minutes automatically
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of songSessions.entries()) {
        if (now - value.timestamp > 5 * 60 * 1000) {
            songSessions.delete(key);
        }
    }
}, 60 * 1000);

const ytUrlRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

function formatBytesDecimal(bytes) {
    if (!Number.isFinite(Number(bytes)) || Number(bytes) < 0) {
        return 'N/A';
    }

    let size = Number(bytes);
    const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    let index = 0;

    while (size >= 1000 && index < units.length - 1) {
        size /= 1000;
        index++;
    }

    return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function cleanFileName(name) {
    return String(name || 'YouTube Audio')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180) || 'YouTube Audio';
}

function formatViews(views) {
    if (
        views === undefined ||
        views === null ||
        views === '' ||
        views === 'N/A'
    ) {
        return 'N/A';
    }

    const numericViews = Number(String(views).replace(/,/g, ''));

    if (!Number.isFinite(numericViews)) {
        return String(views);
    }

    return new Intl.NumberFormat('en-US').format(numericViews);
}

function getChannelName(item) {
    return (
        item?.author?.name ||
        item?.author?.channelName ||
        item?.channel?.name ||
        item?.channelName ||
        item?.metadata?.author?.name ||
        item?.metadata?.channelName ||
        item?.uploader ||
        item?.metadata?.uploader ||
        'N/A'
    );
}

function getDuration(item) {
    return (
        item?.timestamp ||
        item?.duration?.timestamp ||
        item?.duration ||
        item?.metadata?.duration?.timestamp ||
        item?.metadata?.timestamp ||
        'N/A'
    );
}

function getViews(item) {
    return (
        item?.views ??
        item?.metadata?.views ??
        item?.viewCount ??
        item?.metadata?.viewCount ??
        'N/A'
    );
}

function getThumbnail(item) {
    return (
        item?.image ||
        item?.thumbnail ||
        item?.metadata?.image ||
        item?.thumbnails?.[0]?.url ||
        item?.thumbnailUrl
    );
}

function getTitle(item) {
    return item?.title || item?.metadata?.title || 'YouTube Audio';
}

function buildInfoCard({
    title,
    duration,
    views,
    channel,
    url,
    watermark
}) {
    return `🎵 *MRNOBODY AUDIO DOWNLOADER* 🎵

📌 *Title:* ${title}
📺 *Channel:* ${channel}
⏱️ *Duration:* ${duration}
👁️ *Views:* ${formatViews(views)}
🔗 *Link:* ${url}

👇 *Reply Number Below*

1️⃣ WhatsApp Audio
2️⃣ WhatsApp Voice (PTT)
3️⃣ MP3 Document

─── *${watermark}* ───`;
}

function buildSearchList(videos, watermark) {
    let text = `🔍 *YOUTUBE SONG RESULTS* 🔍\n\n`;

    videos.forEach((v, i) => {
        const title = getTitle(v);
        const channel = getChannelName(v);
        const duration = getDuration(v);
        const views = getViews(v);

        text += `*${i + 1}.* ${title}\n`;
        text += `📺 ${channel}\n`;
        text += `⏱️ ${duration}  •  👁️ ${formatViews(views)} views\n`;
        text += `🔗 ${v.url}\n\n`;
    });

    text += `👉 *අදාළ අංකය (1-${videos.length}) Reply කරන්න.*\n\n`;
    text += `─── *${watermark}* ───`;

    return text.trim();
}

// Helper: Convert MP3 Buffer to OGG Opus (Unique ID allocated for concurrency)
async function convertToVoice(inputBuffer) {
    return new Promise((resolve, reject) => {
        const uniqueId = `${Date.now()}_${Math.random()
            .toString(36)
            .substring(2, 7)}`;

        const tmpInput = path.join(
            __dirname,
            `../tmp_in_${uniqueId}.mp3`
        );

        const tmpOutput = path.join(
            __dirname,
            `../tmp_out_${uniqueId}.ogg`
        );

        fs.writeFileSync(tmpInput, inputBuffer);

        ffmpeg(tmpInput)
            .outputOptions([
                '-vn',
                '-ac',
                '1',
                '-codec:a',
                'libopus',
                '-b:a',
                '128k',
                '-vbr',
                'on'
            ])
            .toFormat('ogg')
            .save(tmpOutput)
            .on('end', () => {
                try {
                    const outputBuffer = fs.readFileSync(tmpOutput);

                    if (fs.existsSync(tmpInput)) {
                        fs.unlinkSync(tmpInput);
                    }

                    if (fs.existsSync(tmpOutput)) {
                        fs.unlinkSync(tmpOutput);
                    }

                    resolve(outputBuffer);
                } catch (err) {
                    if (fs.existsSync(tmpInput)) {
                        fs.unlinkSync(tmpInput);
                    }

                    if (fs.existsSync(tmpOutput)) {
                        fs.unlinkSync(tmpOutput);
                    }

                    reject(err);
                }
            })
            .on('error', (err) => {
                if (fs.existsSync(tmpInput)) {
                    fs.unlinkSync(tmpInput);
                }

                if (fs.existsSync(tmpOutput)) {
                    fs.unlinkSync(tmpOutput);
                }

                reject(err);
            });
    });
}

function extractDownloadUrl(res) {
    if (!res) return null;

    if (
        typeof res === 'string' &&
        res.startsWith('http')
    ) {
        return res;
    }

    if (res.download?.url) {
        return res.download.url;
    }

    if (
        res.download &&
        typeof res.download === 'string'
    ) {
        return res.download;
    }

    if (res.result?.download?.url) {
        return res.result.download.url;
    }

    if (
        res.result?.download &&
        typeof res.result.download === 'string'
    ) {
        return res.result.download;
    }

    if (res.url) {
        return res.url;
    }

    return null;
}

async function downloadHighestQuality(videoUrl) {
    let downloadUrl = null;

    try {
        const scraperRes = await yt.ytmp3(
            videoUrl,
            320
        );

        downloadUrl = extractDownloadUrl(scraperRes);
    } catch (e) {
        console.error(
            'Vreden Scraper Error:',
            e
        );
    }

    if (!downloadUrl) {
        try {
            const fallback = await axios.get(
                `https://api.vreden.my.id/api/ytmp3?url=${encodeURIComponent(
                    videoUrl
                )}`
            );

            downloadUrl = extractDownloadUrl(
                fallback.data
            );
        } catch (e) {
            console.error(
                'Fallback API Error:',
                e
            );
        }
    }

    if (!downloadUrl) {
        return null;
    }

    const response = await axios.get(
        downloadUrl,
        {
            responseType: 'arraybuffer',
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        }
    );

    return Buffer.from(response.data);
}

async function sendAudioWithLimit(
    sock,
    from,
    msg,
    session,
    audioBuffer,
    watermark
) {
    const fileName =
        `${cleanFileName(session.title)}.mp3`;

    if (audioBuffer.length <= MAX_FILE_SIZE) {
        await sock.sendMessage(
            from,
            {
                audio: audioBuffer,
                mimetype: 'audio/mpeg',
                fileName
            },
            { quoted: msg }
        );

        return;
    }

    await sock.sendMessage(
        from,
        {
            document: audioBuffer,
            mimetype: 'audio/mpeg',
            fileName,
            caption:
                `🎶 *${session.title}*\n\n` +
                `📦 *File Size:* ${formatBytesDecimal(
                    audioBuffer.length
                )}\n` +
                `⚠️ *80 MB limit නිසා Audio එක Document එකක් ලෙස එවනු ලැබේ.*\n\n` +
                `─── *${watermark}* ───`
        },
        { quoted: msg }
    );
}

async function sendVoice(
    sock,
    from,
    msg,
    session,
    audioBuffer,
    watermark
) {
    const voiceBuffer =
        await convertToVoice(audioBuffer);

    if (voiceBuffer.length <= MAX_FILE_SIZE) {
        await sock.sendMessage(
            from,
            {
                audio: voiceBuffer,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true
            },
            { quoted: msg }
        );

        return;
    }

    await sock.sendMessage(
        from,
        {
            document: voiceBuffer,
            mimetype: 'audio/ogg; codecs=opus',
            fileName:
                `${cleanFileName(session.title)}.ogg`,
            caption:
                `🎙️ *${session.title}*\n\n` +
                `📦 *File Size:* ${formatBytesDecimal(
                    voiceBuffer.length
                )}\n` +
                `⚠️ *80 MB limit නිසා Voice file එක Document එකක් ලෙස එවනු ලැබේ.*\n\n` +
                `─── *${watermark}* ───`
        },
        { quoted: msg }
    );
}

async function sendDocument(
    sock,
    from,
    msg,
    session,
    audioBuffer,
    watermark
) {
    await sock.sendMessage(
        from,
        {
            document: audioBuffer,
            mimetype: 'audio/mpeg',
            fileName:
                `${cleanFileName(session.title)}.mp3`,
            caption:
                `🎶 *${session.title}*\n\n` +
                `📦 *File Size:* ${formatBytesDecimal(
                    audioBuffer.length
                )}\n\n` +
                `─── *${watermark}* ───`
        },
        { quoted: msg }
    );
}

function attachSongListener(sock) {
    if (isListenerAttached) return;

    isListenerAttached = true;

    sock.ev.on(
        'messages.upsert',
        async (m) => {
            try {
                const msg = m.messages[0];

                if (!msg || !msg.message) {
                    return;
                }

                const from =
                    msg.key.remoteJid;

                const text = (
                    msg.message?.conversation ||
                    msg.message
                        ?.extendedTextMessage?.text ||
                    ''
                ).trim();

                const quotedStanzaId =
                    msg.message
                        ?.extendedTextMessage
                        ?.contextInfo
                        ?.stanzaId;

                if (!quotedStanzaId) {
                    return;
                }

                const session =
                    songSessions.get(
                        quotedStanzaId
                    );

                if (!session) {
                    return;
                }

                const watermark =
                    session.config?.WATERMARK ||
                    'MrNobody Serenity';

                (async () => {
                    try {
                        // STEP 2: Selection from Search Results (1-10)
                        if (
                            session.step ===
                            'select_search'
                        ) {
                            const choice =
                                parseInt(
                                    text,
                                    10
                                );

                            if (
                                isNaN(choice) ||
                                choice < 1 ||
                                choice >
                                    session.results
                                        .length
                            ) {
                                return await sock.sendMessage(
                                    from,
                                    {
                                        text:
                                            `⚠️ *කරුණාකර 1 සිට ${session.results.length} දක්වා අංකයක් Reply කරන්න!*`
                                    },
                                    {
                                        quoted:
                                            msg
                                    }
                                );
                            }

                            const selected =
                                session.results[
                                    choice - 1
                                ];

                            const infoCard =
                                buildInfoCard({
                                    title:
                                        getTitle(
                                            selected
                                        ),
                                    duration:
                                        getDuration(
                                            selected
                                        ),
                                    views:
                                        getViews(
                                            selected
                                        ),
                                    channel:
                                        getChannelName(
                                            selected
                                        ),
                                    url:
                                        selected.url,
                                    watermark
                                });

                            let sentMsg;

                            if (
                                getThumbnail(
                                    selected
                                )
                            ) {
                                sentMsg =
                                    await sock.sendMessage(
                                        from,
                                        {
                                            image: {
                                                url: getThumbnail(
                                                    selected
                                                )
                                            },
                                            caption:
                                                infoCard
                                        },
                                        {
                                            quoted:
                                                msg
                                        }
                                    );
                            } else {
                                sentMsg =
                                    await sock.sendMessage(
                                        from,
                                        {
                                            text:
                                                infoCard
                                        },
                                        {
                                            quoted:
                                                msg
                                        }
                                    );
                            }

                            songSessions.set(
                                sentMsg.key.id,
                                {
                                    step:
                                        'select_type',
                                    videoUrl:
                                        selected.url,
                                    title:
                                        getTitle(
                                            selected
                                        ),
                                    duration:
                                        getDuration(
                                            selected
                                        ),
                                    views:
                                        getViews(
                                            selected
                                        ),
                                    channel:
                                        getChannelName(
                                            selected
                                        ),
                                    config:
                                        session.config,
                                    timestamp:
                                        Date.now()
                                }
                            );
                        }

                        // STEP 3: Format Type Selection - directly download
                        else if (
                            session.step ===
                            'select_type'
                        ) {
                            const choice =
                                parseInt(
                                    text,
                                    10
                                );

                            if (
                                ![
                                    1,
                                    2,
                                    3
                                ].includes(
                                    choice
                                )
                            ) {
                                return await sock.sendMessage(
                                    from,
                                    {
                                        text:
                                            '⚠️ *කරුණාකර 1, 2 හෝ 3 අංකයක් Reply කරන්න!*\n\n' +
                                            '1️⃣ WhatsApp Audio\n' +
                                            '2️⃣ WhatsApp Voice (PTT)\n' +
                                            '3️⃣ MP3 Document'
                                    },
                                    {
                                        quoted:
                                            msg
                                    }
                                );
                            }

                            await sock.sendMessage(
                                from,
                                {
                                    text:
                                        `⏳ *Downloading:* ${session.title}\n` +
                                        `🎚️ *Quality:* Highest Available\n\n` +
                                        `_කරුණාකර මොහොතක් රැඳී සිටින්න..._`
                                },
                                {
                                    quoted:
                                        msg
                                }
                            );

                            let audioBuffer;

                            try {
                                audioBuffer =
                                    await downloadHighestQuality(
                                        session.videoUrl
                                    );
                            } catch (e) {
                                console.error(
                                    'Audio Download Error:',
                                    e
                                );

                                audioBuffer =
                                    null;
                            }

                            if (!audioBuffer) {
                                return await sock.sendMessage(
                                    from,
                                    {
                                        text:
                                            '❌ *ගීතය Download කරගැනීමට නොහැකි විය. පසුව නැවත උත්සාහ කරන්න.*'
                                    },
                                    {
                                        quoted:
                                            msg
                                    }
                                );
                            }

                            if (choice === 1) {
                                await sendAudioWithLimit(
                                    sock,
                                    from,
                                    msg,
                                    session,
                                    audioBuffer,
                                    watermark
                                );
                            } else if (
                                choice === 2
                            ) {
                                await sendVoice(
                                    sock,
                                    from,
                                    msg,
                                    session,
                                    audioBuffer,
                                    watermark
                                );
                            } else if (
                                choice === 3
                            ) {
                                await sendDocument(
                                    sock,
                                    from,
                                    msg,
                                    session,
                                    audioBuffer,
                                    watermark
                                );
                            }
                        }
                    } catch (err) {
                        console.error(
                            'Async Step Execution Error:',
                            err
                        );
                    }
                })();
            } catch (err) {
                console.error(
                    'Song interactive listener error:',
                    err
                );
            }
        }
    );
}

export default {    pattern: 'song',
    category: 'download',
    desc: 'Download YouTube Audio',

    function: async (
        sock,
        msg,
        { from, args, config }
    ) => {
        try {
            attachSongListener(sock);

            const watermark =
                config.WATERMARK ||
                'MrNobody Serenity';

            const query =
                args.join(' ');

            if (!query) {
                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `⚠️ *කරුණාකර සෙවීමට නමක් හෝ YouTube Link එකක් ලබාදෙන්න!*\n\n` +
                            `(උදා: \`.song Raghunandana\`)\n\n` +
                            `─── *${watermark}* ───`
                    },
                    {
                        quoted: msg
                    }
                );
            }

            const isUrl =
                ytUrlRegex.test(query);

            if (isUrl) {
                let meta = null;

                try {
                    meta =
                        await yt.metadata(
                            query
                        );
                } catch (e) {
                    try {
                        const searchRes =
                            await yts(query);

                        meta =
                            searchRes
                                .videos?.[0];
                    } catch (
                        searchError
                    ) {
                        console.error(
                            'Metadata fallback Error:',
                            searchError
                        );
                    }
                }

                const title =
                    getTitle(meta);

                const duration =
                    getDuration(meta);

                const views =
                    getViews(meta);

                const channel =
                    getChannelName(
                        meta
                    );

                const thumbnail =
                    getThumbnail(meta);

                const infoCard =
                    buildInfoCard({
                        title,
                        duration,
                        views,
                        channel,
                        url: query,
                        watermark
                    });

                let sentMsg;

                if (thumbnail) {
                    sentMsg =
                        await sock.sendMessage(
                            from,
                            {
                                image: {
                                    url: thumbnail
                                },
                                caption:
                                    infoCard
                            },
                            {
                                quoted: msg
                            }
                        );
                } else {
                    sentMsg =
                        await sock.sendMessage(
                            from,
                            {
                                text:
                                    infoCard
                            },
                            {
                                quoted: msg
                            }
                        );
                }

                songSessions.set(
                    sentMsg.key.id,
                    {
                        step:
                            'select_type',
                        videoUrl:
                            query,
                        title,
                        duration,
                        views,
                        channel,
                        config,
                        timestamp:
                            Date.now()
                    }
                );
            } else {
                const searchRes =
                    await yts(query);

                const videos =
                    (
                        searchRes
                            .videos || []
                    ).slice(0, 10);

                if (!videos.length) {
                    return await sock.sendMessage(
                        from,
                        {
                            text:
                                '❌ *කිසිදු YouTube ප්‍රතිඵලයක් හමු නොවීය.*'
                        },
                        {
                            quoted: msg
                        }
                    );
                }

                const searchListText =
                    buildSearchList(
                        videos,
                        watermark
                    );

                const sentMsg =
                    await sock.sendMessage(
                        from,
                        {
                            text:
                                searchListText
                        },
                        {
                            quoted: msg
                        }
                    );

                songSessions.set(
                    sentMsg.key.id,
                    {
                        step:
                            'select_search',
                        results:
                            videos,
                        config,
                        timestamp:
                            Date.now()
                    }
                );
            }
        } catch (error) {
            console.error(
                'Song Command Error:',
                error
            );

            await sock.sendMessage(
                from,
                {
                    text:
                        '❌ Song command එක අතරතුර දෝෂයක් සිදු විය.'
                },
                {
                    quoted: msg
                }
            );
        }
    }
}
