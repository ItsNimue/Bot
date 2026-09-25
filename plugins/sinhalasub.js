import movieApi from '@sl-code-lords/movie-api';

const { SinhalaSub } = movieApi;

const SESSION_TTL = 10 * 60 * 1000;
const MAX_RESULTS = 10;

// One interactive store per WhatsApp socket.
const socketStores = new WeakMap();
const activeStores = new Set();

function getStore(sock) {
    let store = socketStores.get(sock);

    if (!store) {
        store = new Map();
        socketStores.set(sock, store);
        activeStores.add(store);
    }

    cleanupStore(store);
    return store;
}

function cleanupStore(store) {
    const now = Date.now();

    for (const [id, session] of store.entries()) {
        if (
            !session ||
            now - session.createdAt > SESSION_TTL
        ) {
            store.delete(id);
        }
    }
}

setInterval(() => {
    for (const store of activeStores) {
        cleanupStore(store);

        if (store.size === 0) {
            activeStores.delete(store);
        }
    }
}, 60 * 1000).unref?.();

function getText(msg) {
    return String(
        msg?.message?.conversation ||
        msg?.message?.extendedTextMessage?.text ||
        ''
    ).trim();
}

function getQuotedStanzaId(msg) {
    return (
        msg?.message?.extendedTextMessage?.contextInfo?.stanzaId ||
        msg?.message?.imageMessage?.contextInfo?.stanzaId ||
        msg?.message?.videoMessage?.contextInfo?.stanzaId ||
        null
    );
}

function clean(value) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getTitle(item) {
    return clean(
        item?.title ||
        item?.name ||
        'Unknown Movie'
    );
}

function getDownloadLink(item) {
    return (
        item?.link ||
        item?.url ||
        item?.download ||
        item?.download_url ||
        null
    );
}

function getQuality(item) {
    return clean(
        item?.quality ||
        item?.resolution ||
        item?.name ||
        'Unknown'
    );
}

function getSize(item) {
    return clean(
        item?.size ||
        item?.filesize ||
        'Unknown'
    );
}

function isHttpUrl(value) {
    return /^https?:\/\//i.test(
        String(value || '').trim()
    );
}

function makeSearchText(results, query) {
    let text =
        `🔎 *SINHALASUB SEARCH RESULTS*\n\n` +
        `📌 *Query:* ${query}\n\n`;

    results.forEach((movie, index) => {
        text +=
            `*${index + 1}.* ${getTitle(movie)}\n`;
    });

    text +=
        `\n━━━━━━━━━━━━━━━━━━\n` +
        `👉 *Reply 1-${results.length} to select a movie.*`;

    return text;
}

function makeMovieInfo(movie) {
    const lines = [
        `🎬 *${getTitle(movie)}*`
    ];

    if (movie?.release_date) {
        lines.push(
            `📅 Release: ${clean(movie.release_date)}`
        );
    }

    if (movie?.country) {
        lines.push(
            `🌍 Country: ${clean(movie.country)}`
        );
    }

    if (movie?.duration) {
        lines.push(
            `⏱️ Duration: ${clean(movie.duration)}`
        );
    }

    if (movie?.IMDb_Rating) {
        lines.push(
            `⭐ IMDb: ${clean(movie.IMDb_Rating)}`
        );
    }

    if (movie?.TMDb_Rating) {
        lines.push(
            `⭐ TMDb: ${clean(movie.TMDb_Rating)}`
        );
    }

    if (
        Array.isArray(movie?.categories) &&
        movie.categories.length
    ) {
        lines.push(
            `🏷️ Genres: ${movie.categories.join(', ')}`
        );
    }

    return lines.join('\n');
}

function makeQualityMenu(movie, links) {
    let text =
        `${makeMovieInfo(movie)}\n\n` +
        `📥 *AVAILABLE DOWNLOADS*\n\n`;

    links.forEach((item, index) => {
        text +=
            `*${index + 1}.* ` +
            `🎞️ ${getQuality(item)}` +
            ` | 📦 ${getSize(item)}\n`;
    });

    text +=
        `\n━━━━━━━━━━━━━━━━━━\n` +
        `👉 *Reply the number to download.*`;

    return text;
}

async function getMovie(url) {
    if (
        !SinhalaSub ||
        typeof SinhalaSub.movie !== 'function'
    ) {
        throw new Error(
            '@sl-code-lords/movie-api SinhalaSub.movie() unavailable.'
        );
    }

    const response =
        await SinhalaSub.movie(url);

    if (
        !response?.status ||
        !response?.result
    ) {
        throw new Error(
            'SinhalaSub movie details unavailable.'
        );
    }

    return response.result;
}

async function sendQualityMenu(
    sock,
    from,
    msg,
    movie
) {
    const links =
        Array.isArray(movie?.dl_links)
            ? movie.dl_links.filter(
                item => getDownloadLink(item)
            )
            : [];

    if (!links.length) {
        await sock.sendMessage(
            from,
            {
                text:
                    `${makeMovieInfo(movie)}\n\n` +
                    `❌ *Download qualities හමු වුණේ නැහැ.*`
            },
            {
                quoted: msg
            }
        );

        return;
    }

    const text =
        makeQualityMenu(
            movie,
            links
        );

    const poster =
        movie?.images?.[0] ||
        movie?.image ||
        movie?.poster ||
        null;

    let sent = null;

    if (poster) {
        try {
            sent =
                await sock.sendMessage(
                    from,
                    {
                        image: {
                            url: poster
                        },
                        caption: text
                    },
                    {
                        quoted: msg
                    }
                );
        } catch {
            sent = null;
        }
    }

    if (!sent) {
        sent =
            await sock.sendMessage(
                from,
                {
                    text
                },
                {
                    quoted: msg
                }
            );
    }

    getStore(sock).set(
        sent.key.id,
        {
            type: 'quality',
            title: getTitle(movie),
            links,
            createdAt: Date.now()
        }
    );
}

function attachReplyListener(sock) {
    const store =
        getStore(sock);

    if (store.listenerAttached) {
        return;
    }

    store.listenerAttached = true;

    sock.ev.on(
        'messages.upsert',
        async event => {
            const msg =
                event?.messages?.[0];

            if (!msg?.message) {
                return;
            }

            const from =
                msg?.key?.remoteJid;

            if (!from) {
                return;
            }

            const quotedId =
                getQuotedStanzaId(msg);

            if (!quotedId) {
                return;
            }

            const session =
                store.get(quotedId);

            if (!session) {
                return;
            }

            const input =
                getText(msg);

            if (!input) {
                return;
            }

            try {
                /*
                 * SEARCH RESULT SELECTION
                 */
                if (
                    session.type ===
                    'search'
                ) {
                    const number =
                        Number.parseInt(
                            input,
                            10
                        );

                    if (
                        !Number.isInteger(
                            number
                        ) ||
                        number < 1 ||
                        number >
                            session.results
                                .length
                    ) {
                        await sock.sendMessage(
                            from,
                            {
                                text:
                                    `⚠️ *Reply 1-${session.results.length} කරන්න.*`
                            },
                            {
                                quoted: msg
                            }
                        );

                        return;
                    }

                    const selected =
                        session.results[
                            number - 1
                        ];

                    if (
                        !selected?.link
                    ) {
                        throw new Error(
                            'Selected movie URL unavailable.'
                        );
                    }

                    await sock.sendMessage(
                        from,
                        {
                            text:
                                `⏳ *Movie details ලබාගනිමින්...*`
                        },
                        {
                            quoted: msg
                        }
                    );

                    const movie =
                        await getMovie(
                            selected.link
                        );

                    store.delete(
                        quotedId
                    );

                    await sendQualityMenu(
                        sock,
                        from,
                        msg,
                        movie
                    );

                    return;
                }

                /*
                 * QUALITY SELECTION
                 */
                if (
                    session.type ===
                    'quality'
                ) {
                    const number =
                        Number.parseInt(
                            input,
                            10
                        );

                    if (
                        !Number.isInteger(
                            number
                        ) ||
                        number < 1 ||
                        number >
                            session.links
                                .length
                    ) {
                        await sock.sendMessage(
                            from,
                            {
                                text:
                                    `⚠️ *Reply 1-${session.links.length} කරන්න.*`
                            },
                            {
                                quoted: msg
                            }
                        );

                        return;
                    }

                    const selected =
                        session.links[
                            number - 1
                        ];

                    const url =
                        getDownloadLink(
                            selected
                        );

                    if (!url) {
                        throw new Error(
                            'Selected download link unavailable.'
                        );
                    }

                    const quality =
                        getQuality(
                            selected
                        );

                    const size =
                        getSize(
                            selected
                        );

                    /*
                     * Consume the session before
                     * starting the transfer.
                     */
                    store.delete(
                        quotedId
                    );

                    await sock.sendMessage(
                        from,
                        {
                            text:
                                `⬇️ *Download starting...*\n\n` +
                                `🎬 ${session.title}\n` +
                                `🎞️ Quality: *${quality}*\n` +
                                `📦 Size: *${size}*`
                        },
                        {
                            quoted: msg
                        }
                    );

                    /*
                     * The npm API provides the actual
                     * download URL, so Baileys receives
                     * it directly as a document.
                     */
                    await sock.sendMessage(
                        from,
                        {
                            document: {
                                url
                            },

                            mimetype:
                                'video/mp4',

                            fileName:
                                `${clean(
                                    session.title
                                )} - ${quality}`
                                    .replace(
                                        /[\\/:*?"<>|]/g,
                                        ''
                                    )
                                    .slice(
                                        0,
                                        180
                                    ) +
                                '.mp4',

                            caption:
                                `🎬 *${session.title}*\n` +
                                `🎞️ Quality: *${quality}*\n` +
                                `📦 Size: *${size}*`
                        },
                        {
                            quoted: msg
                        }
                    );
                }
            } catch (error) {
                console.error(
                    '[SINHALASUB] Reply Error:',
                    error
                );

                store.delete(
                    quotedId
                );

                await sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ *SinhalaSub error!*\n\n` +
                            `${error?.message || 'Unknown error'}`
                    },
                    {
                        quoted: msg
                    }
                ).catch(() => {});
            }
        }
    );
}

export default {
    pattern: 'sinhalasub',

    alias: [
        'ss',
        'ssub'
    ],

    category:
        'download',

    desc:
        'Search and download SinhalaSub movies',

    function:
        async (
            sock,
            msg,
            {
                from,
                args
            }
        ) => {
            attachReplyListener(
                sock
            );

            const input =
                args.join(' ').trim();

            /*
             * HELP
             */
            if (!input) {
                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `🎬 *SINHALASUB MOVIE DOWNLOADER*\n\n` +
                            `🔎 Search:\n` +
                            `*.sinhalasub Avatar*\n\n` +
                            `🔗 Direct URL:\n` +
                            `*.sinhalasub https://sinhalasub.lk/movies/...*`
                    },
                    {
                        quoted: msg
                    }
                );
            }

            try {
                /*
                 * DIRECT MOVIE URL
                 */
                if (
                    isHttpUrl(
                        input
                    )
                ) {
                    await sock.sendMessage(
                        from,
                        {
                            text:
                                `⏳ *Movie details ලබාගනිමින්...*`
                        },
                        {
                            quoted: msg
                        }
                    );

                    const movie =
                        await getMovie(
                            input
                        );

                    await sendQualityMenu(
                        sock,
                        from,
                        msg,
                        movie
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
                            `🔎 *SinhalaSub search කරනවා...*\n\n` +
                            `🎬 ${input}`
                    },
                    {
                        quoted: msg
                    }
                );

                if (
                    !SinhalaSub ||
                    !SinhalaSub.get_list ||
                    !SinhalaSub.get_list.by_search
                ) {
                    throw new Error(
                        '@sl-code-lords/movie-api search API unavailable.'
                    );
                }

                const response =
                    await SinhalaSub
                        .get_list
                        .by_search(
                            input
                        );

                if (
                    !response?.status
                ) {
                    throw new Error(
                        'SinhalaSub search failed.'
                    );
                }

                const results =
                    Array.isArray(
                        response.results
                    )
                        ? response.results
                            .filter(
                                item =>
                                    item?.link &&
                                    (
                                        !item?.type ||
                                        item.type ===
                                            'movies'
                                    )
                            )
                            .slice(
                                0,
                                MAX_RESULTS
                            )
                        : [];

                if (!results.length) {
                    return await sock.sendMessage(
                        from,
                        {
                            text:
                                `❌ *${input}* සඳහා movies හමු වුණේ නැහැ.`
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
                                makeSearchText(
                                    results,
                                    input
                                )
                        },
                        {
                            quoted: msg
                        }
                    );

                /*
                 * The reply to this exact message
                 * selects the movie.
                 */
                getStore(sock).set(
                    sent.key.id,
                    {
                        type:
                            'search',

                        results,

                        createdAt:
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
                            `❌ *SinhalaSub error!*\n\n` +
                            `${error?.message || 'Unknown error'}`
                    },
                    {
                        quoted: msg
                    }
                ).catch(() => {});
            }
        }
};
