import movieApi from '@sl-code-lords/movie-api';

const { SinhalaSub } = movieApi;

const MAX_VIDEO_SIZE = 80 * 1000 * 1000;

const sessions = new Map();
const attachedSockets = new WeakSet();


// ============================================================
// HELPERS
// ============================================================

function cleanText(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanFileName(name) {
    return String(name || 'SinhalaSub Movie')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180) || 'SinhalaSub Movie';
}

function normalizeUrl(input) {
    let url = cleanText(input);

    if (!url) {
        return null;
    }

    url = url
        .replace(/[<>()[\]{}]/g, '')
        .replace(/[.,!?;]+$/g, '');

    if (!/^https?:\/\//i.test(url)) {
        url = `https://${url}`;
    }

    return url;
}

function isSinhalaSubUrl(value) {
    try {
        const url = new URL(normalizeUrl(value));

        const host = url.hostname.toLowerCase();

        return (
            host === 'sinhalasub.lk' ||
            host === 'www.sinhalasub.lk'
        );
    } catch {
        return false;
    }
}

function parseSizeToBytes(size) {
    if (
        size === null ||
        size === undefined
    ) {
        return null;
    }

    const text = String(size)
        .trim()
        .replace(/,/g, '')
        .toUpperCase();

    if (!text) {
        return null;
    }

    const match = text.match(
        /^([\d.]+)\s*(B|KB|MB|GB|TB)$/
    );

    if (!match) {
        return null;
    }

    const number = Number(match[1]);

    if (!Number.isFinite(number)) {
        return null;
    }

    const units = {
        B: 1,
        KB: 1000,
        MB: 1000 ** 2,
        GB: 1000 ** 3,
        TB: 1000 ** 4
    };

    return number * units[match[2]];
}

function getTextFromMessage(msg) {
    return cleanText(
        msg?.message?.conversation ||
        msg?.message?.extendedTextMessage?.text ||
        msg?.message?.imageMessage?.caption ||
        msg?.message?.videoMessage?.caption ||
        msg?.message?.documentMessage?.caption ||
        ''
    );
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

        msg?.message
            ?.documentMessage
            ?.contextInfo
            ?.stanzaId
    );
}

function getResultTitle(item) {
    return (
        item?.title ||
        'Unknown Movie'
    );
}

function buildSearchList(results, query, watermark) {
    let text =
        `🎬 *SINHALASUB MOVIE SEARCH*\n\n` +
        `🔎 *Search:* ${query}\n\n`;

    results.forEach((item, index) => {
        text +=
            `*${index + 1}.* ${getResultTitle(item)}\n` +
            `📂 ${item?.type || 'movies'}\n\n`;
    });

    text +=
        `👉 *Reply 1-${results.length} to select a movie.*\n\n` +
        `─── *${watermark}* ───`;

    return text.trim();
}

function buildMovieInfo(movie, links, watermark) {
    let text =
        `🎬 *SINHALASUB MOVIE*\n\n` +
        `📌 *Title:* ${movie?.title || 'Unknown'}\n`;

    if (movie?.release_date) {
        text +=
            `📅 *Release:* ${movie.release_date}\n`;
    }

    if (movie?.duration) {
        text +=
            `⏱️ *Duration:* ${movie.duration}\n`;
    }

    if (movie?.country) {
        text +=
            `🌍 *Country:* ${movie.country}\n`;
    }

    if (movie?.IMDb_Rating) {
        text +=
            `⭐ *IMDb:* ${movie.IMDb_Rating}\n`;
    }

    if (movie?.TMDb_Rating) {
        text +=
            `⭐ *TMDb:* ${movie.TMDb_Rating}\n`;
    }

    text +=
        `\n📥 *AVAILABLE QUALITIES*\n\n`;

    links.forEach((item, index) => {
        text +=
            `*${index + 1}.* ${item.quality}\n` +
            `   📦 ${item.size || 'Unknown size'}\n\n`;
    });

    text +=
        `👉 *Reply the quality number to download.*\n\n` +
        `─── *${watermark}* ───`;

    return text.trim();
}

function normalizeDownloadLinks(rawLinks) {
    if (!Array.isArray(rawLinks)) {
        return [];
    }

    /*
     * SinhalaSub can sometimes expose multiple mirrors
     * with the same quality/size.
     *
     * Keep the actual quality and size shown by the API,
     * but group duplicate quality+size entries so we can
     * retry another mirror automatically if one fails.
     */

    const grouped = new Map();

    for (const item of rawLinks) {
        const quality =
            cleanText(item?.quality);

        const size =
            cleanText(item?.size);

        const link =
            cleanText(item?.link);

        if (
            !quality ||
            !link ||
            !/^https?:\/\//i.test(link)
        ) {
            continue;
        }

        const key =
            `${quality.toLowerCase()}|${size.toLowerCase()}`;

        if (!grouped.has(key)) {
            grouped.set(key, {
                quality,
                size: size || 'Unknown',
                links: []
            });
        }

        const entry =
            grouped.get(key);

        if (!entry.links.includes(link)) {
            entry.links.push(link);
        }
    }

    return [...grouped.values()];
}


// ============================================================
// GET MOVIE DETAILS
// ============================================================

async function getMovieDetails(url) {
    const response =
        await SinhalaSub.movie(url);

    if (!response?.status) {
        throw new Error(
            'SinhalaSub movie details unavailable.'
        );
    }

    if (!response?.result) {
        throw new Error(
            'Movie information was not found.'
        );
    }

    return response.result;
}


// ============================================================
// ATTACH REPLY LISTENER PER SOCKET
// ============================================================

function attachListener(sock) {
    if (attachedSockets.has(sock)) {
        return;
    }

    attachedSockets.add(sock);

    sock.ev.on(
        'messages.upsert',
        async event => {
            try {
                const msg =
                    event?.messages?.[0];

                if (
                    !msg?.message ||
                    msg?.key?.fromMe
                ) {
                    return;
                }

                const quotedStanzaId =
                    getQuotedStanzaId(msg);

                if (!quotedStanzaId) {
                    return;
                }

                const session =
                    sessions.get(
                        quotedStanzaId
                    );

                if (!session) {
                    return;
                }

                const from =
                    msg.key.remoteJid;

                if (!from) {
                    return;
                }

                const text =
                    getTextFromMessage(msg);

                if (!text) {
                    return;
                }

                // ====================================================
                // SEARCH RESULT SELECTION
                // ====================================================

                if (
                    session.step ===
                    'search_select'
                ) {
                    const choice =
                        Number.parseInt(
                            text,
                            10
                        );

                    if (
                        !Number.isInteger(choice) ||
                        choice < 1 ||
                        choice >
                            session.results.length
                    ) {
                        return await sock.sendMessage(
                            from,
                            {
                                text:
                                    `⚠️ *Reply a number from 1-${session.results.length}.*`
                            },
                            { quoted: msg }
                        );
                    }

                    const selected =
                        session.results[
                            choice - 1
                        ];

                    if (
                        !selected?.link
                    ) {
                        return await sock.sendMessage(
                            from,
                            {
                                text:
                                    '❌ මේ movie එකට link එකක් හමු වුණේ නැහැ.'
                            },
                            { quoted: msg }
                        );
                    }

                    await sock.sendMessage(
                        from,
                        {
                            text:
                                '⏳ *Movie details ලබාගන්නවා...*'
                        },
                        { quoted: msg }
                    );

                    let movie;

                    try {
                        movie =
                            await getMovieDetails(
                                selected.link
                            );
                    } catch (error) {
                        console.error(
                            '[SINHALASUB] Details Error:',
                            error
                        );

                        return await sock.sendMessage(
                            from,
                            {
                                text:
                                    '❌ *Movie details ලබාගැනීමට නොහැකි විය.*'
                            },
                            { quoted: msg }
                        );
                    }

                    const links =
                        normalizeDownloadLinks(
                            movie?.dl_links
                        );

                    if (!links.length) {
                        return await sock.sendMessage(
                            from,
                            {
                                text:
                                    '❌ *මේ movie එකට download links හමු වුණේ නැහැ.*'
                            },
                            { quoted: msg }
                        );
                    }

                    const watermark =
                        session.config
                            ?.WATERMARK ||
                        'MrNobody Serenity';

                    const infoText =
                        buildMovieInfo(
                            movie,
                            links,
                            watermark
                        );

                    let sentMsg;

                    const poster =
                        Array.isArray(
                            movie?.images
                        ) &&
                        movie.images.length
                            ? movie.images[0]
                            : null;

                    if (poster) {
                        try {
                            sentMsg =
                                await sock.sendMessage(
                                    from,
                                    {
                                        image: {
                                            url:
                                                poster
                                        },
                                        caption:
                                            infoText
                                    },
                                    {
                                        quoted:
                                            msg
                                    }
                                );
                        } catch {
                            sentMsg =
                                await sock.sendMessage(
                                    from,
                                    {
                                        text:
                                            infoText
                                    },
                                    {
                                        quoted:
                                            msg
                                    }
                                );
                        }
                    } else {
                        sentMsg =
                            await sock.sendMessage(
                                from,
                                {
                                    text:
                                        infoText
                                },
                                {
                                    quoted:
                                        msg
                                }
                            );
                    }

                    sessions.set(
                        sentMsg.key.id,
                        {
                            step:
                                'quality_select',
                            movie,
                            links,
                            config:
                                session.config,
                            timestamp:
                                Date.now()
                        }
                    );

                    sessions.delete(
                        quotedStanzaId
                    );

                    return;
                }


                // ====================================================
                // QUALITY SELECTION
                // ====================================================

                if (
                    session.step !==
                    'quality_select'
                ) {
                    return;
                }

                const choice =
                    Number.parseInt(
                        text,
                        10
                    );

                if (
                    !Number.isInteger(choice) ||
                    choice < 1 ||
                    choice > session.links.length
                ) {
                    return await sock.sendMessage(
                        from,
                        {
                            text:
                                `⚠️ *Reply a number from 1-${session.links.length}.*`
                        },
                        { quoted: msg }
                    );
                }

                const selected =
                    session.links[
                        choice - 1
                    ];

                if (
                    !selected?.links?.length
                ) {
                    return await sock.sendMessage(
                        from,
                        {
                            text:
                                '❌ *Download link එකක් හමු වුණේ නැහැ.*'
                        },
                        { quoted: msg }
                    );
                }

                const watermark =
                    session.config
                        ?.WATERMARK ||
                    'MrNobody Serenity';

                await sock.sendMessage(
                    from,
                    {
                        text:
                            `⏳ *Downloading...*\n\n` +
                            `🎬 ${session.movie?.title || 'Movie'}\n` +
                            `🎚️ *Quality:* ${selected.quality}\n` +
                            `📦 *Size:* ${selected.size}\n\n` +
                            `_Please wait..._`
                    },
                    { quoted: msg }
                );

                const reportedBytes =
                    parseSizeToBytes(
                        selected.size
                    );

                /*
                 * <= 80 MB  -> WhatsApp Video
                 * >  80 MB  -> WhatsApp Document
                 *
                 * Unknown size is sent as document
                 * so we don't falsely claim it is safe
                 * for video upload.
                 */

                const sendAsVideo =
                    Number.isFinite(
                        reportedBytes
                    ) &&
                    reportedBytes <=
                        MAX_VIDEO_SIZE;

                let sent = false;
                let lastError = null;

                for (
                    const downloadUrl
                    of selected.links
                ) {
                    try {
                        const fileName =
                            `${cleanFileName(
                                session.movie?.title ||
                                'SinhalaSub Movie'
                            )} - ${cleanFileName(
                                selected.quality
                            )}.mp4`;

                        if (sendAsVideo) {
                            await sock.sendMessage(
                                from,
                                {
                                    video: {
                                        url:
                                            downloadUrl
                                    },
                                    mimetype:
                                        'video/mp4',
                                    fileName,
                                    caption:
                                        `🎬 *${session.movie?.title || 'SinhalaSub Movie'}*\n\n` +
                                        `🎚️ *Quality:* ${selected.quality}\n` +
                                        `📦 *Size:* ${selected.size}\n\n` +
                                        `─── *${watermark}* ───`
                                },
                                {
                                    quoted:
                                        msg
                                }
                            );
                        } else {
                            await sock.sendMessage(
                                from,
                                {
                                    document: {
                                        url:
                                            downloadUrl
                                    },
                                    mimetype:
                                        'video/mp4',
                                    fileName,
                                    caption:
                                        `🎬 *${session.movie?.title || 'SinhalaSub Movie'}*\n\n` +
                                        `🎚️ *Quality:* ${selected.quality}\n` +
                                        `📦 *Size:* ${selected.size}\n\n` +
                                        `📁 *Sent as Document*\n\n` +
                                        `─── *${watermark}* ───`
                                },
                                {
                                    quoted:
                                        msg
                                }
                            );
                        }

                        sent = true;
                        break;
                    } catch (error) {
                        lastError =
                            error;

                        console.error(
                            '[SINHALASUB] Mirror failed:',
                            downloadUrl,
                            error?.message ||
                                error
                        );
                    }
                }

                if (!sent) {
                    console.error(
                        '[SINHALASUB] All mirrors failed:',
                        lastError
                    );

                    await sock.sendMessage(
                        from,
                        {
                            text:
                                '❌ *Movie එක Download කරන්න බැරි වුණා.*\n\n' +
                                'ඒ quality එකේ වෙනත් mirror එකක් තිබුණොත් ඒකත් automatically try කළා.'
                        },
                        { quoted: msg }
                    );
                }

                sessions.delete(
                    quotedStanzaId
                );

            } catch (error) {
                console.error(
                    '[SINHALASUB] Listener Error:',
                    error
                );
            }
        }
    );
}


// ============================================================
// PLUGIN
// ============================================================

export default {
    pattern: 'sinhalasub',
    alias: ['ssub', 'ss'],
    category: 'download',
    desc: 'Search and download SinhalaSub movies',

    function: async (
        sock,
        msg,
        {
            from,
            args,
            config
        }
    ) => {
        try {
            attachListener(sock);

            const query =
                args.join(' ').trim();

            const watermark =
                config.WATERMARK ||
                'MrNobody Serenity';

            if (!query) {
                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `🎬 *SINHALASUB MOVIE DOWNLOADER*\n\n` +
                            `භාවිතා කරන විදිහ:\n\n` +
                            `*.sinhalasub movie name*\n` +
                            `*.sinhalasub https://sinhalasub.lk/...*\n\n` +
                            `─── *${watermark}* ───`
                    },
                    { quoted: msg }
                );
            }


            // ========================================================
            // DIRECT URL
            // ========================================================

            if (
                isSinhalaSubUrl(query)
            ) {
                const url =
                    normalizeUrl(query);

                await sock.sendMessage(
                    from,
                    {
                        text:
                            '⏳ *Movie details ලබාගන්නවා...*'
                    },
                    { quoted: msg }
                );

                let movie;

                try {
                    movie =
                        await getMovieDetails(
                            url
                        );
                } catch (error) {
                    console.error(
                        '[SINHALASUB] Direct URL Error:',
                        error
                    );

                    return await sock.sendMessage(
                        from,
                        {
                            text:
                                '❌ *SinhalaSub movie එක හඳුනාගැනීමට නොහැකි විය.*'
                        },
                        { quoted: msg }
                    );
                }

                const links =
                    normalizeDownloadLinks(
                        movie?.dl_links
                    );

                if (!links.length) {
                    return await sock.sendMessage(
                        from,
                        {
                            text:
                                '❌ *මේ movie එකට download qualities හමු වුණේ නැහැ.*'
                        },
                        { quoted: msg }
                    );
                }

                const infoText =
                    buildMovieInfo(
                        movie,
                        links,
                        watermark
                    );

                let sentMsg;

                const poster =
                    Array.isArray(
                        movie?.images
                    ) &&
                    movie.images.length
                        ? movie.images[0]
                        : null;

                if (poster) {
                    try {
                        sentMsg =
                            await sock.sendMessage(
                                from,
                                {
                                    image: {
                                        url:
                                            poster
                                    },
                                    caption:
                                        infoText
                                },
                                {
                                    quoted:
                                        msg
                                }
                            );
                    } catch {
                        sentMsg =
                            await sock.sendMessage(
                                from,
                                {
                                    text:
                                        infoText
                                },
                                {
                                    quoted:
                                        msg
                                }
                            );
                    }
                } else {
                    sentMsg =
                        await sock.sendMessage(
                            from,
                            {
                                text:
                                    infoText
                            },
                            {
                                quoted:
                                    msg
                            }
                        );
                }

                sessions.set(
                    sentMsg.key.id,
                    {
                        step:
                            'quality_select',
                        movie,
                        links,
                        config,
                        timestamp:
                            Date.now()
                    }
                );

                return;
            }


            // ========================================================
            // SEARCH
            // ========================================================

            await sock.sendMessage(
                from,
                {
                    text:
                        `🔎 *Searching SinhalaSub...*\n\n` +
                        `🎬 *Query:* ${query}`
                },
                { quoted: msg }
            );

            const response =
                await SinhalaSub
                    .get_list
                    .by_search(query);

            if (
                !response?.status
            ) {
                return await sock.sendMessage(
                    from,
                    {
                        text:
                            '❌ *SinhalaSub search failed.*'
                    },
                    { quoted: msg }
                );
            }

            const allResults =
                Array.isArray(
                    response.results
                )
                    ? response.results
                    : [];

            /*
             * User asked for movies.
             * Filter out TV shows from the search result.
             */

            const movieResults =
                allResults
                    .filter(
                        item =>
                            String(
                                item?.type || ''
                            )
                                .toLowerCase() ===
                            'movies'
                    )
                    .slice(0, 10);

            if (!movieResults.length) {
                return await sock.sendMessage(
                    from,
                    {
                        text:
                            '❌ *මේ search එකට movies හමු වුණේ නැහැ.*'
                    },
                    { quoted: msg }
                );
            }

            const searchText =
                buildSearchList(
                    movieResults,
                    query,
                    watermark
                );

            const sentMsg =
                await sock.sendMessage(
                    from,
                    {
                        text:
                            searchText
                    },
                    {
                        quoted:
                            msg
                    }
                );

            sessions.set(
                sentMsg.key.id,
                {
                    step:
                        'search_select',
                    results:
                        movieResults,
                    config,
                    timestamp:
                        Date.now()
                }
            );

        } catch (error) {
            console.error(
                '[SINHALASUB] Command Error:',
                error
            );

            await sock.sendMessage(
                from,
                {
                    text:
                        `❌ *SinhalaSub command error.*\n\n` +
                        `${error?.message || 'Unknown error'}`
                },
                { quoted: msg }
            );
        }
    }
};


// ============================================================
// CLEAN OLD SESSIONS
// ============================================================

setInterval(() => {
    const now = Date.now();

    for (
        const [
            key,
            session
        ] of sessions.entries()
    ) {
        if (
            !session?.timestamp ||
            now - session.timestamp >
                5 * 60 * 1000
        ) {
            sessions.delete(key);
        }
    }
}, 60 * 1000);
