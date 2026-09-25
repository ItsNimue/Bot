import yts from 'yt-search';
import youtubedl from 'youtube-dl-exec';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_FILE_SIZE = 80 * 1000 * 1000;
const SESSION_TTL = 5 * 60 * 1000;
const MAX_RESULTS = 10;

const QUALITY_OPTIONS = [
    144,
    360,
    480,
    720,
    1080
];

const YOUTUBE_HOSTS = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be'
]);

/*
|--------------------------------------------------------------------------
| SESSION STORAGE
|--------------------------------------------------------------------------
| One store per WhatsApp socket.
| This prevents different linked devices/users from sharing sessions.
|--------------------------------------------------------------------------
*/

const socketStores = new WeakMap();
const activeStores = new Set();

function getStore(sock) {
    let store = socketStores.get(sock);

    if (!store) {
        store = new Map();

        socketStores.set(sock, store);
        activeStores.add(store);
    }

    return store;
}

/*
|--------------------------------------------------------------------------
| SESSION CLEANUP
|--------------------------------------------------------------------------
*/

setInterval(() => {
    const now = Date.now();

    for (const store of activeStores) {
        for (const [id, session] of store.entries()) {
            if (
                session.createdAt &&
                now - session.createdAt > SESSION_TTL
            ) {
                store.delete(id);
            }
        }

        if (store.size === 0) {
            activeStores.delete(store);
        }
    }
}, 60 * 1000).unref?.();

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function isYouTubeUrl(value) {
    try {
        const url = new URL(value);

        return (
            (url.protocol === 'http:' ||
                url.protocol === 'https:') &&
            YOUTUBE_HOSTS.has(
                url.hostname.toLowerCase()
            )
        );
    } catch {
        return false;
    }
}

function cleanYouTubeUrl(value) {
    const url = new URL(value);

    if (
        !YOUTUBE_HOSTS.has(
            url.hostname.toLowerCase()
        )
    ) {
        throw new Error(
            'Invalid YouTube URL.'
        );
    }

    return url.toString();
}

function cleanFileName(name) {
    return String(
        name || 'YouTube Video'
    )
        .replace(
            /[<>:"/\\|?*\x00-\x1F]/g,
            ''
        )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180) ||
        'YouTube Video';
}

function formatBytes(bytes) {
    const n = Number(bytes);

    if (!Number.isFinite(n) || n < 0) {
        return 'N/A';
    }

    if (n < 1000) {
        return `${n} B`;
    }

    if (n < 1000 * 1000) {
        return `${(n / 1000).toFixed(2)} KB`;
    }

    if (n < 1000 * 1000 * 1000) {
        return `${(
            n /
            (1000 * 1000)
        ).toFixed(2)} MB`;
    }

    return `${(
        n /
        (1000 * 1000 * 1000)
    ).toFixed(2)} GB`;
}

function formatDuration(seconds) {
    const n = Number(seconds);

    if (!Number.isFinite(n) || n < 0) {
        return 'N/A';
    }

    const total = Math.floor(n);

    const hours = Math.floor(
        total / 3600
    );

    const minutes = Math.floor(
        (total % 3600) / 60
    );

    const secs = total % 60;

    if (hours > 0) {
        return (
            `${hours}:` +
            `${String(minutes).padStart(
                2,
                '0'
            )}:` +
            `${String(secs).padStart(
                2,
                '0'
            )}`
        );
    }

    return (
        `${minutes}:` +
        `${String(secs).padStart(2, '0')}`
    );
}

function getText(msg) {
    return String(
        msg?.message?.conversation ||
            msg?.message?.extendedTextMessage?.text ||
            msg?.message?.imageMessage?.caption ||
            msg?.message?.videoMessage?.caption ||
            ''
    ).trim();
}

function getQuotedStanzaId(msg) {
    return (
        msg?.message
            ?.extendedTextMessage
            ?.contextInfo
            ?.stanzaId ||
        msg?.message
            ?.imageMessage
            ?.contextInfo
            ?.stanzaId ||
        msg?.message
            ?.videoMessage
            ?.contextInfo
            ?.stanzaId ||
        null
    );
}

/*
|--------------------------------------------------------------------------
| QUALITY
|--------------------------------------------------------------------------
*/

function getFormats(info) {
    return Array.isArray(info?.formats)
        ? info.formats
        : [];
}

function getAvailableVideoHeights(info) {
    return [
        ...new Set(
            getFormats(info)
                .filter(
                    format =>
                        format?.vcodec &&
                        format.vcodec !== 'none' &&
                        Number.isFinite(
                            Number(format.height)
                        )
                )
                .map(format =>
                    Number(format.height)
                )
                .filter(height =>
                    height > 0
                )
        )
    ].sort((a, b) => a - b);
}

function findNearestQuality(
    availableHeights,
    requested
) {
    if (!availableHeights.length) {
        return null;
    }

    return availableHeights.reduce(
        (best, current) => {
            const currentDistance =
                Math.abs(
                    current - requested
                );

            const bestDistance =
                Math.abs(
                    best - requested
                );

            /*
             * If distance is equal,
             * use the lower resolution.
             */
            if (
                currentDistance <
                bestDistance
            ) {
                return current;
            }

            if (
                currentDistance ===
                    bestDistance &&
                current < best
            ) {
                return current;
            }

            return best;
        }
    );
}

function getActualQualities(info) {
    const available =
        getAvailableVideoHeights(info);

    return QUALITY_OPTIONS.map(
        requested =>
            findNearestQuality(
                available,
                requested
            )
    );
}

/*
|--------------------------------------------------------------------------
| QUALITY MENU
|--------------------------------------------------------------------------
*/

function buildQualityLines(
    prefix,
    actualQualities
) {
    return QUALITY_OPTIONS.map(
        (requested, index) => {
            const actual =
                actualQualities[index];

            if (!actual) {
                return (
                    `${prefix}.${index + 1} ` +
                    `${requested}p ❌`
                );
            }

            if (actual === requested) {
                return (
                    `${prefix}.${index + 1} ` +
                    `${requested}p`
                );
            }

            return (
                `${prefix}.${index + 1} ` +
                `${requested}p → ${actual}p`
            );
        }
    ).join('\n');
}

function buildQualityMenu(
    info,
    actualQualities,
    watermark
) {
    const title =
        cleanFileName(info?.title);

    return (
        `🎬 *MRNOBODY VIDEO DOWNLOADER* 🎬\n\n` +

        `📌 *Title:* ${title}\n` +

        `📺 *Channel:* ${
            info?.uploader ||
            info?.channel ||
            'N/A'
        }\n` +

        `⏱️ *Duration:* ${
            formatDuration(
                info?.duration
            )
        }\n\n` +

        `🎥 *VIDEO*\n` +

        `${buildQualityLines(
            '1',
            actualQualities
        )}\n\n` +

        `📄 *DOCUMENT*\n` +

        `${buildQualityLines(
            '2',
            actualQualities
        )}\n\n` +

        `📦 *80 MB ඉක්මවා ගියොත් automatically Document ලෙස යවයි.*\n` +

        `🔄 *අදාළ number එක මේ message එකට Reply කරන්න.*\n\n` +

        `─── *${watermark}* ───`
    );
}

/*
|--------------------------------------------------------------------------
| SEARCH RESULTS
|--------------------------------------------------------------------------
*/

function buildSearchResults(
    results,
    watermark
) {
    let text =
        `🔍 *YOUTUBE VIDEO RESULTS* 🔍\n\n`;

    results.forEach((video, index) => {
        const views =
            Number(video.views || 0);

        text +=
            `*${index + 1}.* ` +
            `${video.title}\n`;

        text +=
            `📺 ${
                video.author?.name ||
                'N/A'
            }\n`;

        text +=
            `⏱️ ${
                video.timestamp ||
                'N/A'
            }  •  👁️ ${
                views.toLocaleString(
                    'en-US'
                )
            } views\n`;

        text +=
            `🔗 ${video.url}\n\n`;
    });

    text +=
        `👉 *1-${results.length} අතර අංකයක් Reply කරන්න.*\n\n`;

    text +=
        `─── *${watermark}* ───`;

    return text;
}

/*
|--------------------------------------------------------------------------
| YT-DLP
|--------------------------------------------------------------------------
*/

async function runYtDlp(
    url,
    options,
    timeout
) {
    const runtime =
        process.env.YTDLP_JS_RUNTIMES ||
        'node';

    const finalOptions = {
        noWarnings: true,
        noPlaylist: true,

        ...options,

        ...(runtime
            ? {
                  jsRuntimes: runtime
              }
            : {})
    };

    /*
     * Optional cookies.
     *
     * If YTDLP_COOKIES is configured,
     * yt-dlp will use it.
     */
    if (process.env.YTDLP_COOKIES) {
        finalOptions.cookies =
            process.env.YTDLP_COOKIES;
    }

    if (process.env.YTDLP_PROXY) {
        finalOptions.proxy =
            process.env.YTDLP_PROXY;
    }

    if (
        process.env.YTDLP_USER_AGENT
    ) {
        finalOptions.userAgent =
            process.env.YTDLP_USER_AGENT;
    }

    return youtubedl(
        url,
        finalOptions,
        {
            timeout:
                timeout ||
                60 * 1000,

            maxBuffer:
                32 * 1024 * 1024
        }
    );
}

/*
|--------------------------------------------------------------------------
| VIDEO INFO
|--------------------------------------------------------------------------
*/

async function getVideoInfo(url) {
    return runYtDlp(
        url,
        {
            dumpSingleJson: true,
            skipDownload: true,
            format: 'bestvideo/best'
        },
        90 * 1000
    );
}

/*
|--------------------------------------------------------------------------
| FORMAT SELECTOR
|--------------------------------------------------------------------------
*/

function buildFormatSelector(
    info,
    actualHeight
) {
    const formats =
        getFormats(info);

    /*
     * First look for a progressive format
     * that already contains audio.
     */
    const progressiveFormats =
        formats
            .filter(format => {
                return (
                    format?.vcodec &&
                    format.vcodec !==
                        'none' &&
                    format?.acodec &&
                    format.acodec !==
                        'none' &&
                    Number(
                        format.height
                    ) === actualHeight
                );
            })
            .sort((a, b) => {
                const aBitrate =
                    Number(
                        a.tbr || 0
                    );

                const bBitrate =
                    Number(
                        b.tbr || 0
                    );

                return (
                    bBitrate -
                    aBitrate
                );
            });

    if (
        progressiveFormats.length
    ) {
        return String(
            progressiveFormats[0]
                .format_id
        );
    }

    /*
     * Otherwise use best video at the
     * selected real height + best audio.
     */
    const videoFormats =
        formats
            .filter(format => {
                return (
                    format?.vcodec &&
                    format.vcodec !==
                        'none' &&
                    Number(
                        format.height
                    ) === actualHeight
                );
            })
            .sort((a, b) => {
                const aBitrate =
                    Number(
                        a.tbr || 0
                    );

                const bBitrate =
                    Number(
                        b.tbr || 0
                    );

                return (
                    bBitrate -
                    aBitrate
                );
            });

    if (
        videoFormats.length &&
        videoFormats[0]?.format_id
    ) {
        return (
            `${videoFormats[0].format_id}` +
            `+bestaudio/best`
        );
    }

    /*
     * Final yt-dlp fallback.
     */
    return (
        `bestvideo[height=${actualHeight}]` +
        `+bestaudio/best[height=${actualHeight}]` +
        `/best`
    );
}

/*
|--------------------------------------------------------------------------
| DOWNLOAD
|--------------------------------------------------------------------------
*/

async function downloadVideo(
    url,
    info,
    actualHeight,
    outputFile
) {
    const format =
        buildFormatSelector(
            info,
            actualHeight
        );

    await runYtDlp(
        url,
        {
            format,

            output: outputFile,

            mergeOutputFormat:
                'mp4',

            remuxVideo:
                'mp4',

            noPart: true,

            preferFreeFormats:
                true,

            restrictFilenames:
                true,

            retries: 3,

            fragmentRetries: 3,

            concurrentFragments: 4
        },
        45 * 60 * 1000
    );

    /*
     * yt-dlp normally creates the requested
     * output path, but verify it before sending.
     */
    await fsp.access(outputFile);

    return outputFile;
}

/*
|--------------------------------------------------------------------------
| SEND VIDEO / DOCUMENT
|--------------------------------------------------------------------------
*/

async function sendDownloadedVideo(
    sock,
    from,
    msg,
    filePath,
    session,
    mode,
    requestedQuality,
    actualQuality
) {
    const stat =
        await fsp.stat(filePath);

    const title =
        cleanFileName(
            session.info?.title
        );

    const fileName =
        `${title}-${actualQuality}p.mp4`;

    /*
     * Document mode OR >80 MB
     * => Document.
     */
    const mustUseDocument =
        mode === 'document' ||
        stat.size > MAX_FILE_SIZE;

    let caption =
        `🎬 *${title}*\n\n` +

        `🎚️ Quality: *${actualQuality}p*`;

    if (
        actualQuality !==
        requestedQuality
    ) {
        caption +=
            `\n🔄 Requested: *${requestedQuality}p*`;
    }

    caption +=
        `\n📦 Size: *${formatBytes(
            stat.size
        )}*`;

    if (
        stat.size >
        MAX_FILE_SIZE
    ) {
        caption +=
            `\n⚠️ 80 MB limit නිසා Document ලෙස යවන ලදී.`;
    }

    caption +=
        `\n\n─── *${session.watermark}* ───`;

    /*
     * DOCUMENT
     */
    if (mustUseDocument) {
        await sock.sendMessage(
            from,
            {
                document: {
                    url: filePath
                },

                mimetype:
                    'video/mp4',

                fileName,

                caption
            },
            {
                quoted: msg
            }
        );

        return;
    }

    /*
     * VIDEO
     */
    try {
        await sock.sendMessage(
            from,
            {
                video: {
                    url: filePath
                },

                mimetype:
                    'video/mp4',

                fileName,

                caption
            },
            {
                quoted: msg
            }
        );
    } catch (videoError) {
        console.error(
            '[VIDEO] Video send failed, falling back to document:',
            videoError
        );

        await sock.sendMessage(
            from,
            {
                document: {
                    url: filePath
                },

                mimetype:
                    'video/mp4',

                fileName,

                caption:
                    `${caption}\n\n` +
                    `⚠️ Video ලෙස යැවීමට නොහැකි වූ නිසා Document ලෙස යවන ලදී.`
            },
            {
                quoted: msg
            }
        );
    }
}

/*
|--------------------------------------------------------------------------
| REPLY LISTENER
|--------------------------------------------------------------------------
*/

function attachListener(sock) {
    const store =
        getStore(sock);

    if (
        store.listenerAttached
    ) {
        return;
    }

    store.listenerAttached =
        true;

    sock.ev.on(
        'messages.upsert',
        async event => {
            try {
                const msg =
                    event?.messages?.[0];

                if (
                    !msg?.message
                ) {
                    return;
                }

                const quotedId =
                    getQuotedStanzaId(
                        msg
                    );

                if (!quotedId) {
                    return;
                }

                const session =
                    store.get(
                        quotedId
                    );

                if (!session) {
                    return;
                }

                const text =
                    getText(msg);

                if (!text) {
                    return;
                }

                const from =
                    msg.key.remoteJid;

                /*
                 * SEARCH RESULT SELECTION
                 */
                if (
                    session.step ===
                    'search'
                ) {
                    const choice =
                        Number.parseInt(
                            text,
                            10
                        );

                    if (
                        !Number.isInteger(
                            choice
                        ) ||
                        choice < 1 ||
                        choice >
                            session.results
                                .length
                    ) {
                        await sock.sendMessage(
                            from,
                            {
                                text:
                                    `⚠️ *1 සිට ${session.results.length} දක්වා අංකයක් Reply කරන්න.*`
                            },
                            {
                                quoted: msg
                            }
                        );

                        return;
                    }

                    const selected =
                        session.results[
                            choice - 1
                        ];

                    await sock.sendMessage(
                        from,
                        {
                            text:
                                `🔎 *Video details ලබාගනිමින්...*`
                        },
                        {
                            quoted: msg
                        }
                    );

                    const info =
                        await getVideoInfo(
                            selected.url
                        );

                    const actualQualities =
                        getActualQualities(
                            info
                        );

                    if (
                        !actualQualities.some(
                            Boolean
                        )
                    ) {
                        throw new Error(
                            'මෙම video එකේ downloadable quality එකක් හමු නොවීය.'
                        );
                    }

                    const sent =
                        await sock.sendMessage(
                            from,
                            {
                                text:
                                    buildQualityMenu(
                                        info,
                                        actualQualities,
                                        session.watermark
                                    )
                            },
                            {
                                quoted: msg
                            }
                        );

                    /*
                     * Remove old search session.
                     */
                    store.delete(
                        quotedId
                    );

                    /*
                     * Create quality session.
                     */
                    store.set(
                        sent.key.id,
                        {
                            step:
                                'quality',

                            url:
                                selected.url,

                            info,

                            actualQualities,

                            watermark:
                                session.watermark,

                            createdAt:
                                Date.now()
                        }
                    );

                    return;
                }

                /*
                 * QUALITY SELECTION
                 */
                if (
                    session.step ===
                    'quality'
                ) {
                    /*
                     * Accepted:
                     *
                     * 1.1
                     * 1.2
                     * 1.3
                     * 1.4
                     * 1.5
                     *
                     * 2.1
                     * 2.2
                     * 2.3
                     * 2.4
                     * 2.5
                     */
                    const match =
                        text.match(
                            /^([12])\.([1-5])$/
                        );

                    if (!match) {
                        return;
                    }

                    const mode =
                        match[1] === '1'
                            ? 'video'
                            : 'document';

                    const index =
                        Number(
                            match[2]
                        ) - 1;

                    const requestedQuality =
                        QUALITY_OPTIONS[
                            index
                        ];

                    const actualQuality =
                        session
                            .actualQualities[
                            index
                        ];

                    if (
                        !actualQuality
                    ) {
                        await sock.sendMessage(
                            from,
                            {
                                text:
                                    `❌ *${requestedQuality}p quality එක ලබාගත නොහැක.*`
                            },
                            {
                                quoted: msg
                            }
                        );

                        return;
                    }

                    await sock.sendMessage(
                        from,
                        {
                            text:
                                `⏳ *${actualQuality}p video එක download කරමින්...*\n\n` +
                                `📌 ${cleanFileName(
                                    session.info?.title
                                )}\n` +
                                `🎚️ Quality: *${actualQuality}p*` +
                                (
                                    actualQuality !==
                                    requestedQuality
                                        ? `\n🔄 Requested ${requestedQuality}p → Available ${actualQuality}p`
                                        : ''
                                ) +
                                `\n\n📦 80 MB ඉක්මවා ගියොත් Document ලෙස යවනු ලැබේ.`
                        },
                        {
                            quoted: msg
                        }
                    );

                    /*
                     * Unique temporary directory.
                     */
                    const tempDir =
                        await fsp.mkdtemp(
                            path.join(
                                os.tmpdir(),
                                'mrnobody-video-'
                            )
                        );

                    const outputFile =
                        path.join(
                            tempDir,
                            'video.mp4'
                        );

                    try {
                        await downloadVideo(
                            session.url,
                            session.info,
                            actualQuality,
                            outputFile
                        );

                        await sendDownloadedVideo(
                            sock,
                            from,
                            msg,
                            outputFile,
                            session,
                            mode,
                            requestedQuality,
                            actualQuality
                        );
                    } finally {
                        await fsp.rm(
                            tempDir,
                            {
                                recursive:
                                    true,
                                force:
                                    true
                            }
                        ).catch(
                            () => {}
                        );

                        store.delete(
                            quotedId
                        );
                    }
                }
            } catch (error) {
                console.error(
                    '[VIDEO] Reply handler error:',
                    error
                );

                const from =
                    msg?.key?.remoteJid;

                if (!from) {
                    return;
                }

                await sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ *Video download error!*\n\n` +
                            `${error?.message || 'Unknown error'}`
                    },
                    {
                        quoted: msg
                    }
                ).catch(
                    () => {}
                );
            }
        }
    );
}

/*
|--------------------------------------------------------------------------
| MAIN COMMAND
|--------------------------------------------------------------------------
*/

export default {
    pattern: 'video',

    alias: [
        'ytvideo',
        'ytv',
        'ytmp4'
    ],

    category: 'download',

    desc:
        'YouTube video downloader with quality selection',

    function: async (
        sock,
        msg,
        {
            from,
            args,
            config
        }
    ) => {
        const watermark =
            config?.WATERMARK ||
            'MrNobody Serenity';

        const input =
            args.join(' ').trim();

        /*
         * Make sure reply listener exists
         * for this WhatsApp socket.
         */
        attachListener(sock);

        /*
         * NO INPUT
         */
        if (!input) {
            return sock.sendMessage(
                from,
                {
                    text:
                        `🎬 *YOUTUBE VIDEO DOWNLOADER*\n\n` +

                        `🔎 Search:\n` +
                        `*.video Alan Walker Faded*\n\n` +

                        `🔗 Direct URL:\n` +
                        `*.video https://youtu.be/VIDEO_ID*\n\n` +

                        `🎥 1.1 - 1.5 = Video\n` +
                        `📄 2.1 - 2.5 = Document\n\n` +

                        `144p / 360p / 480p / 720p / 1080p\n\n` +

                        `─── *${watermark}* ───`
                },
                {
                    quoted: msg
                }
            );
        }

        const store =
            getStore(sock);

        try {
            /*
             * DIRECT URL
             */
            if (
                isYouTubeUrl(input)
            ) {
                const url =
                    cleanYouTubeUrl(
                        input
                    );

                await sock.sendMessage(
                    from,
                    {
                        text:
                            `🔎 *YouTube video එක check කරමින්...*`
                    },
                    {
                        quoted: msg
                    }
                );

                const info =
                    await getVideoInfo(
                        url
                    );

                const actualQualities =
                    getActualQualities(
                        info
                    );

                if (
                    !actualQualities.some(
                        Boolean
                    )
                ) {
                    throw new Error(
                        'මෙම video එකේ downloadable quality එකක් හමු නොවීය.'
                    );
                }

                const sent =
                    await sock.sendMessage(
                        from,
                        {
                            text:
                                buildQualityMenu(
                                    info,
                                    actualQualities,
                                    watermark
                                )
                        },
                        {
                            quoted: msg
                        }
                    );

                store.set(
                    sent.key.id,
                    {
                        step:
                            'quality',

                        url,

                        info,

                        actualQualities,

                        watermark,

                        createdAt:
                            Date.now()
                    }
                );

                return;
            }

            /*
             * SEARCH
             */
            await sock.sendMessage(
                from,
                {
                    text:
                        `🔍 *YouTube search කරමින්...*\n\n` +
                        `📌 ${input}`
                },
                {
                    quoted: msg
                }
            );

            const search =
                await yts(input);

            const results =
                (
                    search?.videos ||
                    []
                ).slice(
                    0,
                    MAX_RESULTS
                );

            if (
                !results.length
            ) {
                return sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ *YouTube search result එකක් හමු නොවීය.*`
                    },
                    {
                        quoted: msg
                    }
                );
            }

            const sent =
                await sock.sendMessage(
                    from,
                    {
                        text:
                            buildSearchResults(
                                results,
                                watermark
                            )
                    },
                    {
                        quoted: msg
                    }
                );

            store.set(
                sent.key.id,
                {
                    step:
                        'search',

                    results,

                    watermark,

                    createdAt:
                        Date.now()
                }
            );
        } catch (error) {
            console.error(
                '[VIDEO] Command error:',
                error
            );

            await sock.sendMessage(
                from,
                {
                    text:
                        `❌ *YouTube video ලබාගැනීමට නොහැකි විය.*\n\n` +
                        `${error?.message || 'Unknown error'}`
                },
                {
                    quoted: msg
                }
            ).catch(
                () => {}
            );
        }
    }
};
