import yts from 'yt-search';
import yt from '@vreden/youtube_scraper';
import axios from 'axios';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ============================================================
// MRNOBODY YOUTUBE VIDEO DOWNLOADER
// Video → 1.1 / 1.2 / 1.3 ...   Document → 2.1 / 2.2 / 2.3 ...
// Only qualities that actually exist for THIS video are shown.
// Tier 1: ytdlp-nodejs (real per-video formats, up to 4K)
// Tier 2/3: @vreden/youtube_scraper + api.vreden.my.id fallback
// ============================================================

// Direct-video-message limit (safe inline playback size)
const VIDEO_INLINE_LIMIT = 100 * 1000 * 1000; // 100 MB
// Absolute cap — beyond this we refuse (too big for WhatsApp)
const DOCUMENT_LIMIT = 2 * 1000 * 1000 * 1000; // 2 GB

// Fixed fallback ladder used only when the ytdlp-nodejs tier fails
const FALLBACK_LADDER = [144, 240, 360, 480, 720, 1080];

const ytUrlRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
const choiceRegex = /^([12])\.(\d+)$/;

// Multi-session storage with TTL (same pattern as song.js)
const videoSessions = new Map();
let isListenerAttached = false;

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of videoSessions.entries()) {
        if (now - value.timestamp > 5 * 60 * 1000) {
            videoSessions.delete(key);
        }
    }
}, 60 * 1000);

// ============================================================
// HELPERS
// ============================================================

function cleanFileName(name) {
    return String(name || 'YouTube Video')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180) || 'YouTube Video';
}

function formatBytesDecimal(bytes) {
    if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) {
        return null;
    }
    let size = Number(bytes);
    const units = ['Bytes', 'KB', 'MB', 'GB'];
    let index = 0;
    while (size >= 1000 && index < units.length - 1) {
        size /= 1000;
        index++;
    }
    return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatViews(views) {
    if (views === undefined || views === null || views === '' || views === 'N/A') return 'N/A';
    const n = Number(String(views).replace(/,/g, ''));
    if (!Number.isFinite(n)) return String(views);
    return new Intl.NumberFormat('en-US').format(n);
}

function getChannelName(item) {
    return item?.author?.name || item?.author?.channelName || item?.channel?.name ||
        item?.channelName || item?.metadata?.author?.name || item?.metadata?.channelName ||
        item?.uploader || item?.metadata?.uploader || 'N/A';
}

function getDuration(item) {
    return item?.timestamp || item?.duration?.timestamp || item?.duration ||
        item?.metadata?.duration?.timestamp || item?.metadata?.timestamp || 'N/A';
}

function getViews(item) {
    return item?.views ?? item?.metadata?.views ?? item?.viewCount ?? item?.metadata?.viewCount ?? 'N/A';
}

function getThumbnail(item) {
    return item?.image || item?.thumbnail || item?.metadata?.image ||
        item?.thumbnails?.[0]?.url || item?.thumbnailUrl;
}

function getTitle(item) {
    return item?.title || item?.metadata?.title || 'YouTube Video';
}

function extractDownloadUrl(res) {
    if (!res) return null;
    if (typeof res === 'string' && res.startsWith('http')) return res;
    if (res.download?.url) return res.download.url;
    if (res.download && typeof res.download === 'string') return res.download;
    if (res.result?.download?.url) return res.result.download.url;
    if (res.result?.download && typeof res.result.download === 'string') return res.result.download;
    if (res.url) return res.url;
    return null;
}

function qualityLabel(height) {
    if (height >= 2160) return '4K (2160p)';
    if (height >= 1440) return '2K (1440p)';
    return `${height}p`;
}

// ============================================================
// QUALITY DISCOVERY
// ============================================================

// Tier 1: ytdlp-nodejs — real per-video formats, can reach 4K.
// If the binary can't be used on this host (blocked spawn/download),
// this simply fails and we drop to the fallback ladder below.
async function getQualitiesViaYtdlp(url) {
    try {
        const { YtDlp } = await import('ytdlp-nodejs');
        const ytdlp = new YtDlp();

        const info = await ytdlp.getInfoAsync(url);
        const formats = info?.formats || [];

        const heightMap = new Map();

        for (const f of formats) {
            const height = Number(f.height);
            if (!height || f.vcodec === 'none') continue;

            const hasAudio = !!(f.acodec && f.acodec !== 'none');
            const score = (f.ext === 'mp4' ? 2 : 0) + (hasAudio ? 1 : 0);
            const existing = heightMap.get(height);

            if (!existing || score > existing.score) {
                heightMap.set(height, {
                    height,
                    formatId: f.format_id,
                    hasAudio,
                    filesize: f.filesize || f.filesize_approx || null,
                    score
                });
            }
        }

        const qualities = [...heightMap.values()]
            .sort((a, b) => a.height - b.height)
            .map(q => ({
                label: qualityLabel(q.height),
                height: q.height,
                formatId: q.formatId,
                hasAudio: q.hasAudio,
                filesize: q.filesize,
                tier: 'ytdlp'
            }));

        return qualities.length ? qualities : null;
    } catch (err) {
        console.log('[VIDEO] ytdlp-nodejs quality detection failed, using fallback ladder:', err.message);
        return null;
    }
}

// Tier fallback: fixed common ladder (used only if Tier 1 fails).
// We can't cheaply confirm exact availability without downloading,
// so scraper-tier downloads are attempted per selection and the
// user is told clearly if a specific quality isn't available.
function getFallbackQualities() {
    return FALLBACK_LADDER.map(height => ({
        label: qualityLabel(height),
        height,
        formatId: null,
        hasAudio: true,
        filesize: null,
        tier: 'scraper'
    }));
}

async function getQualities(url) {
    const real = await getQualitiesViaYtdlp(url);
    return real || getFallbackQualities();
}

// ============================================================
// DOWNLOAD
// ============================================================

async function downloadWithYtdlp(url, quality) {
    const { YtDlp } = await import('ytdlp-nodejs');
    const ytdlp = new YtDlp();

    const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const outPath = path.join(os.tmpdir(), `ytv_${uniqueId}.mp4`);

    const formatStr = quality.hasAudio
        ? quality.formatId
        : `${quality.formatId}+bestaudio/best`;

    await ytdlp.downloadAsync(url, {
        format: formatStr,
        output: outPath,
        mergeOutputFormat: 'mp4',
        ffmpegLocation: ffmpegPath
    });

    const buffer = fs.readFileSync(outPath);
    fs.unlink(outPath, () => {});
    return buffer;
}

async function downloadWithScraper(url, quality) {
    const notes = [];

    // Tier 2: @vreden/youtube_scraper (same package song.js already uses)
    try {
        const res = await yt.ytmp4(url, quality.height);
        const downloadUrl = extractDownloadUrl(res);

        if (downloadUrl) {
            const response = await axios.get(downloadUrl, {
                responseType: 'arraybuffer',
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });
            console.log(`[VIDEO] Tier2 (vreden scraper) success for ${quality.height}p`);
            return { buffer: Buffer.from(response.data), notes };
        }
        notes.push(`vreden-scraper: no download url (${JSON.stringify(res).slice(0, 150)})`);
    } catch (e) {
        notes.push(`vreden-scraper: ${e.message}`);
        console.log('[VIDEO] Vreden ytmp4 Error:', e.message);
    }

    // Tier 3: direct public API fallback
    try {
        const fallback = await axios.get(
            `https://api.vreden.my.id/api/ytmp4?url=${encodeURIComponent(url)}&quality=${quality.height}`,
            { timeout: 30000 }
        );
        const downloadUrl = extractDownloadUrl(fallback.data);

        if (downloadUrl) {
            const response = await axios.get(downloadUrl, {
                responseType: 'arraybuffer',
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });
            console.log(`[VIDEO] Tier3 (vreden api) success for ${quality.height}p`);
            return { buffer: Buffer.from(response.data), notes };
        }
        notes.push(`vreden-api: no download url (${JSON.stringify(fallback.data).slice(0, 150)})`);
    } catch (e) {
        notes.push(`vreden-api: ${e.message}`);
        console.log('[VIDEO] Vreden API Fallback Error:', e.message);
    }

    return { buffer: null, notes };
}

async function downloadQuality(url, quality) {
    if (quality.tier === 'ytdlp') {
        try {
            return await downloadWithYtdlp(url, quality);
        } catch (e) {
            console.error('ytdlp-nodejs download failed, falling back to scraper tier:', e.message);
        }
    }
    return await downloadWithScraper(url, quality);
}

// ============================================================
// UI CARDS
// ============================================================

function buildQualityCard({ title, duration, views, channel, url, qualities, watermark }) {
    let text = `🎬 *MRNOBODY VIDEO DOWNLOADER* 🎬\n\n`;
    text += `📌 *Title:* ${title}\n`;
    text += `📺 *Channel:* ${channel}\n`;
    text += `⏱️ *Duration:* ${duration}\n`;
    text += `👁️ *Views:* ${formatViews(views)}\n`;
    text += `🔗 *Link:* ${url}\n\n`;
    text += `👇 *Reply the number below*\n\n`;

    text += `🎥 *VIDEO — Send as Video*\n`;
    qualities.forEach((q, i) => {
        const size = formatBytesDecimal(q.filesize);
        text += `*1.${i + 1}* — ${q.label}${size ? `  •  ${size}` : ''}\n`;
    });

    text += `\n📄 *DOCUMENT — Send as File*\n`;
    qualities.forEach((q, i) => {
        const size = formatBytesDecimal(q.filesize);
        text += `*2.${i + 1}* — ${q.label}${size ? `  •  ${size}` : ''}\n`;
    });

    text += `\n─── *${watermark}* ───`;
    return text;
}

function buildSearchList(videos, watermark) {
    let text = `🔍 *YOUTUBE VIDEO SEARCH RESULTS* 🔍\n\n`;

    videos.forEach((v, i) => {
        text += `*${i + 1}.* ${getTitle(v)}\n`;
        text += `📺 ${getChannelName(v)}\n`;
        text += `⏱️ ${getDuration(v)}  •  👁️ ${formatViews(getViews(v))} views\n`;
        text += `🔗 ${v.url}\n\n`;
    });

    text += `👉 *අදාළ අංකය (1-${videos.length}) Reply කරන්න.*\n\n`;
    text += `─── *${watermark}* ───`;
    return text.trim();
}

// ============================================================
// SENDERS
// ============================================================

async function sendAsVideo(sock, from, msg, session, buffer, watermark) {
    if (buffer.length > VIDEO_INLINE_LIMIT) {
        // Too big to send inline as a video message — fall back to document
        return await sendAsDocument(sock, from, msg, session, buffer, watermark, true);
    }

    await sock.sendMessage(
        from,
        {
            video: buffer,
            mimetype: 'video/mp4',
            caption: `🎬 *${session.title}*\n📶 *Quality:* ${session.selectedLabel}\n\n─── *${watermark}* ───`
        },
        { quoted: msg }
    );
}

async function sendAsDocument(sock, from, msg, session, buffer, watermark, autoSwitched = false) {
    const fileName = `${cleanFileName(session.title)}_${session.selectedLabel.replace(/\s+/g, '')}.mp4`;

    await sock.sendMessage(
        from,
        {
            document: buffer,
            mimetype: 'video/mp4',
            fileName,
            caption:
                `📄 *${session.title}*\n` +
                `📶 *Quality:* ${session.selectedLabel}\n` +
                `📦 *Size:* ${formatBytesDecimal(buffer.length) || 'N/A'}\n` +
                (autoSwitched ? `⚠️ *100 MB ට වඩා විශාල නිසා Document එකක් ලෙස එවනු ලැබේ.*\n\n` : `\n`) +
                `─── *${watermark}* ───`
        },
        { quoted: msg }
    );
}

// ============================================================
// REPLY LISTENER (quoted-message session flow)
// ============================================================

function attachVideoListener(sock) {
    if (isListenerAttached) return;
    isListenerAttached = true;

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            const from = msg.key.remoteJid;
            const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();

            const quotedStanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
            if (!quotedStanzaId) return;

            const session = videoSessions.get(quotedStanzaId);
            if (!session) return;

            const watermark = session.config?.WATERMARK || 'MrNobody Serenity';

            (async () => {
                try {
                    // STEP 1: Selection from search results (1-10)
                    if (session.step === 'select_search') {
                        const choice = parseInt(text, 10);

                        if (isNaN(choice) || choice < 1 || choice > session.results.length) {
                            return await sock.sendMessage(
                                from,
                                { text: `⚠️ *කරුණාකර 1 සිට ${session.results.length} දක්වා අංකයක් Reply කරන්න!*` },
                                { quoted: msg }
                            );
                        }

                        const selected = session.results[choice - 1];
                        videoSessions.delete(quotedStanzaId);
                        await presentQualities(sock, from, msg, selected.url, selected, session.config, watermark);
                        return;
                    }

                    // STEP 2: Quality selection (1.x = video, 2.x = document)
                    if (session.step === 'select_quality') {
                        const match = text.match(choiceRegex);

                        if (!match) {
                            return await sock.sendMessage(
                                from,
                                { text: `⚠️ *කරුණාකර 1.1, 1.2... (Video) හෝ 2.1, 2.2... (Document) විදිහට Reply කරන්න!*` },
                                { quoted: msg }
                            );
                        }

                        const mode = match[1]; // '1' video, '2' document
                        const idx = parseInt(match[2], 10) - 1;
                        const quality = session.qualities[idx];

                        if (!quality) {
                            return await sock.sendMessage(
                                from,
                                { text: `⚠️ *එම Quality එක නොපවතී. ලැයිස්තුවේ ඇති අංකයක් Reply කරන්න.*` },
                                { quoted: msg }
                            );
                        }

                        const sentMsg = await sock.sendMessage(
                            from,
                            { text: `⏳ *${quality.label} Download කරමින්... මඳක් රැඳී සිටින්න.*` },
                            { quoted: msg }
                        );

                        let buffer = null;
                        try {
                            buffer = await downloadQuality(session.videoUrl, quality);
                        } catch (e) {
                            console.error('Video Download Error:', e);
                        }

                        if (!buffer) {
                            videoSessions.delete(quotedStanzaId);
                            return await sock.sendMessage(
                                from,
                                {
                                    text:
                                        `❌ *${quality.label} Download කරගැනීමට නොහැකි විය.*\n` +
                                        `වෙනත් Quality එකක් උත්සාහ කරන්න.\n\n─── *${watermark}* ───`
                                },
                                { quoted: sentMsg }
                            );
                        }

                        if (buffer.length > DOCUMENT_LIMIT) {
                            videoSessions.delete(quotedStanzaId);
                            return await sock.sendMessage(
                                from,
                                { text: `❌ *File එක ඉතා විශාලයි (${formatBytesDecimal(buffer.length)}). අඩු Quality එකක් උත්සාහ කරන්න.*` },
                                { quoted: sentMsg }
                            );
                        }

                        session.selectedLabel = quality.label;

                        if (mode === '1') {
                            await sendAsVideo(sock, from, sentMsg, session, buffer, watermark);
                        } else {
                            await sendAsDocument(sock, from, sentMsg, session, buffer, watermark);
                        }

                        videoSessions.delete(quotedStanzaId);
                    }
                } catch (err) {
                    console.error('Video interactive listener error:', err);
                }
            })();
        } catch (err) {
            console.error('Video listener error:', err);
        }
    });
}

async function presentQualities(sock, from, msg, videoUrl, meta, config, watermark) {
    const title = getTitle(meta);
    const duration = getDuration(meta);
    const views = getViews(meta);
    const channel = getChannelName(meta);
    const thumbnail = getThumbnail(meta);

    const loadingMsg = await sock.sendMessage(
        from,
        { text: `🔎 *Available Qualities සොයමින්...*` },
        { quoted: msg }
    );

    const qualities = await getQualities(videoUrl);

    const card = buildQualityCard({ title, duration, views, channel, url: videoUrl, qualities, watermark });

    let sentMsg;
    if (thumbnail) {
        sentMsg = await sock.sendMessage(from, { image: { url: thumbnail }, caption: card }, { quoted: loadingMsg });
    } else {
        sentMsg = await sock.sendMessage(from, { text: card }, { quoted: loadingMsg });
    }

    videoSessions.set(sentMsg.key.id, {
        step: 'select_quality',
        videoUrl,
        title,
        qualities,
        config,
        timestamp: Date.now()
    });
}

// ============================================================
// COMMAND
// ============================================================

export default {
    pattern: 'video',
    alias: ['mp4', 'ytmp4', 'ytv', 'videodl'],
    category: 'download',
    desc: 'Download YouTube Video — quality selection up to 4K (Video/Document)',

    function: async (sock, msg, { from, args, config }) => {
        try {
            attachVideoListener(sock);

            const watermark = config.WATERMARK || 'MrNobody Serenity';
            const query = args.join(' ');

            if (!query) {
                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `⚠️ *කරුණාකර සෙවීමට නමක් හෝ YouTube Link එකක් ලබාදෙන්න!*\n\n` +
                            `(උදා: \`.video Raghunandana\`)\n\n` +
                            `─── *${watermark}* ───`
                    },
                    { quoted: msg }
                );
            }

            const isUrl = ytUrlRegex.test(query);

            if (isUrl) {
                let meta = null;

                try {
                    meta = await yt.metadata(query);
                } catch (e) {
                    try {
                        const searchRes = await yts(query);
                        meta = searchRes.videos?.[0];
                    } catch (searchError) {
                        console.error('Metadata fallback Error:', searchError);
                    }
                }

                await presentQualities(sock, from, msg, query, meta || {}, config, watermark);
            } else {
                const searchRes = await yts(query);
                const videos = (searchRes.videos || []).slice(0, 10);

                if (!videos.length) {
                    return await sock.sendMessage(
                        from,
                        { text: '❌ *කිසිදු YouTube ප්‍රතිඵලයක් හමු නොවීය.*' },
                        { quoted: msg }
                    );
                }

                const searchListText = buildSearchList(videos, watermark);
                const sentMsg = await sock.sendMessage(from, { text: searchListText }, { quoted: msg });

                videoSessions.set(sentMsg.key.id, {
                    step: 'select_search',
                    results: videos,
                    config,
                    timestamp: Date.now()
                });
            }
        } catch (error) {
            console.error('Video Command Error:', error);
            await sock.sendMessage(
                from,
                { text: '❌ Video command එක අතරතුර දෝෂයක් සිදු විය.' },
                { quoted: msg }
            );
        }
    }
};
