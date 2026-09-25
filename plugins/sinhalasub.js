
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'node:fs';

const MAX_RESULTS = 10;
const SESSION_TTL = 5 * 60 * 1000;
const REQUEST_TIMEOUT = 30000;

const stores = new WeakMap();
const activeStores = new Set();

function getStore(sock) {
    let store = stores.get(sock);
    if (!store) {
        store = new Map();
        stores.set(sock, store);
        activeStores.add(store);
    }
    return store;
}

setInterval(() => {
    const now = Date.now();
    for (const store of activeStores) {
        for (const [id, item] of store) {
            if (now - item.createdAt > SESSION_TTL) {
                store.delete(id);
            }
        }
        if (!store.size) activeStores.delete(store);
    }
}, 60000).unref?.();

function getText(msg) {
    return String(
        msg?.message?.conversation ||
        msg?.message?.extendedTextMessage?.text ||
        ''
    ).trim();
}

function quotedId(msg) {
    return (
        msg?.message?.extendedTextMessage?.contextInfo?.stanzaId ||
        null
    );
}

function cleanName(value) {
    return String(value || 'Movie')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180) || 'Movie';
}

function absUrl(href, base) {
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

function normaliseHost(url) {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return '';
    }
}

function isHttp(url) {
    return /^https?:\/\//i.test(String(url || ''));
}

function sizeText(value) {
    const s = String(value || '').trim();
    return s || 'Size N/A';
}

function unique(items) {
    const seen = new Set();
    return items.filter(item => {
        const key = `${item.url}|${item.quality}|${item.server}`;
        if (!item.url || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function getHtml(url) {
    const res = await axios.get(url, {
        timeout: REQUEST_TIMEOUT,
        maxRedirects: 8,
        responseType: 'text',
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
            Accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        validateStatus: s => s >= 200 && s < 400
    });
    return { html: String(res.data || ''), url: res.request?.res?.responseUrl || url };
}

function extractTitle($, fallback) {
    return cleanName(
        $('h1').first().text().trim() ||
        $('meta[property="og:title"]').attr('content') ||
        $('title').first().text().trim() ||
        fallback
    );
}

function findMovieLinks($, baseUrl, allowedHost) {
    const out = [];
    $('a[href]').each((_, el) => {
        const href = absUrl($(el).attr('href'), baseUrl);
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (!href || !isHttp(href)) return;

        const host = normaliseHost(href);
        if (allowedHost && host !== allowedHost) return;

        const path = new URL(href).pathname.toLowerCase();
        if (!/\/(movies|movie|tvshows|tv-show)\//.test(path)) return;

        if (!text || text.length < 2) return;
        out.push({
            title: cleanName(text),
            url: href
        });
    });

    const seen = new Set();
    return out.filter(x => {
        if (seen.has(x.url)) return false;
        seen.add(x.url);
        return true;
    }).slice(0, MAX_RESULTS);
}

function qualityFrom(text) {
    const s = String(text || '').toLowerCase();

    const m = s.match(
        /(?:^|\b)(2160p|1440p|1080p|720p|480p|360p|240p|144p)(?:\b|$)/
    );
    if (m) return m[1].toUpperCase();

    if (/\bfhd\b/.test(s)) return 'FHD';
    if (/\bhd\b/.test(s)) return 'HD';
    if (/\bsd\b/.test(s)) return 'SD';
    if (/\b4k\b/.test(s)) return '4K';

    return 'Quality N/A';
}

function parseSize(text) {
    const m = String(text || '').match(
        /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB|TB)\b/i
    );
    return m ? m[0] : 'Size N/A';
}

function looksLikeDownload(url, text = '') {
    const s = `${url} ${text}`.toLowerCase();
    return (
        /\.(?:mp4|mkv|avi|mov|webm)(?:$|[?#])/i.test(url) ||
        /(download|direct|dlserver|pixeldrain|dotflix|telegram|telegr)/i.test(s)
    );
}

async function resolveRedirectPage(url, depth = 0, seen = new Set()) {
    if (!url || depth > 4 || seen.has(url)) return url;
    seen.add(url);

    try {
        const { html, url: finalUrl } = await getHtml(url);
        const $ = cheerio.load(html);

        const candidates = [];

        $('a[href]').each((_, el) => {
            const href = absUrl($(el).attr('href'), finalUrl);
            const text = $(el).text().replace(/\s+/g, ' ').trim();
            if (href && isHttp(href) && looksLikeDownload(href, text)) {
                candidates.push(href);
            }
        });

        $('meta[http-equiv="refresh"]').each((_, el) => {
            const content = $(el).attr('content') || '';
            const m = content.match(/url\s*=\s*(.+)$/i);
            if (m) {
                const href = absUrl(m[1].trim().replace(/^['"]|['"]$/g, ''), finalUrl);
                if (href) candidates.push(href);
            }
        });

        const scripts = $('script').map((_, el) => $(el).html() || '').get().join('\n');

        const patterns = [
            /(?:location(?:\.href)?|window\.location)\s*=\s*['"]([^'"]+)['"]/gi,
            /(?:window\.open|location\.replace)\s*\(\s*['"]([^'"]+)['"]/gi,
            /['"]((?:https?:)?\/\/[^'"]+)['"]/gi
        ];

        for (const re of patterns) {
            let m;
            while ((m = re.exec(scripts))) {
                const href = absUrl(m[1], finalUrl);
                if (href && looksLikeDownload(href)) candidates.push(href);
            }
        }

        const direct = candidates.find(isHttp);
        if (direct && direct !== finalUrl) {
            return resolveRedirectPage(direct, depth + 1, seen);
        }

        return finalUrl;
    } catch {
        return url;
    }
}

function buildResults(title, results, watermark) {
    let text = `🎬 *${title} MOVIE SEARCH* 🎬\n\n`;

    results.forEach((item, i) => {
        text += `*${i + 1}.* ${item.title}\n`;
        text += `🔗 ${item.url}\n\n`;
    });

    text += `👉 *1-${results.length} අතර අංකයක් Reply කරන්න.*\n\n`;
    text += `─── *${watermark}* ───`;
    return text;
}

function buildLinks(title, links, watermark) {
    let text = `🎬 *${title} DOWNLOAD OPTIONS* 🎬\n\n`;
    text += `📌 *${cleanName(title)}*\n\n`;

    links.forEach((item, i) => {
        text += `*${i + 1}.* `;
        if (item.server) text += `📡 ${item.server} | `;
        text += `🎞️ ${item.quality}`;
        if (item.size && item.size !== 'Size N/A') {
            text += ` | 📦 ${item.size}`;
        }
        text += `\n`;
    });

    text += `\n👉 *අදාළ number එක Reply කරන්න.*\n\n`;
    text += `⚠️ *Site එකේ තියෙන actual quality/size එකම පෙන්වයි.*\n\n`;
    text += `─── *${watermark}* ───`;

    return text;
}

async function downloadToTemp(url, filePath) {
    const response = await axios.get(url, {
        timeout: 120000,
        maxRedirects: 10,
        responseType: 'stream',
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36'
        },
        validateStatus: s => s >= 200 && s < 400
    });

    await new Promise((resolve, reject) => {
        const stream = response.data;
        const output = fs.createWriteStream(filePath);

        stream.pipe(output);
        stream.on('error', reject);
        output.on('finish', resolve);
        output.on('error', reject);
    });

    return filePath;
}

function attachReplyListener(sock, provider) {
    const store = getStore(sock);
    if (store.listenerAttached) return;
    store.listenerAttached = true;

    sock.ev.on('messages.upsert', async event => {
        const msg = event?.messages?.[0];
        if (!msg?.message) return;

        const qid = quotedId(msg);
        if (!qid) return;

        const session = store.get(qid);
        if (!session) return;

        const input = getText(msg);
        if (!input) return;

        const from = msg.key.remoteJid;

        try {
            const choice = Number.parseInt(input, 10);

            if (!Number.isInteger(choice)) return;

            if (session.step === 'search') {
                if (choice < 1 || choice > session.results.length) {
                    return sock.sendMessage(
                        from,
                        { text: `⚠️ *1-${session.results.length} අතර අංකයක් Reply කරන්න.*` },
                        { quoted: msg }
                    );
                }

                const selected = session.results[choice - 1];

                await sock.sendMessage(
                    from,
                    { text: `🔎 *${provider.name} movie details ලබාගනිමින්...*` },
                    { quoted: msg }
                );

                const details = await provider.getDetails(selected.url);

                if (!details.links.length) {
                    throw new Error('මෙම movie එකට download options හමු නොවීය.');
                }

                const sent = await sock.sendMessage(
                    from,
                    {
                        text: buildLinks(
                            provider.name,
                            details.links,
                            session.watermark
                        )
                    },
                    { quoted: msg }
                );

                store.delete(qid);

                store.set(sent.key.id, {
                    step: 'download',
                    title: details.title || selected.title,
                    links: details.links,
                    watermark: session.watermark,
                    createdAt: Date.now()
                });

                return;
            }

            if (session.step === 'download') {
                if (choice < 1 || choice > session.links.length) {
                    return sock.sendMessage(
                        from,
                        { text: `⚠️ *1-${session.links.length} අතර අංකයක් Reply කරන්න.*` },
                        { quoted: msg }
                    );
                }

                const selected = session.links[choice - 1];

                await sock.sendMessage(
                    from,
                    {
                        text:
                            `⏳ *Download link එක resolve කරමින්...*\n\n` +
                            `🎞️ ${selected.quality}\n` +
                            `📡 ${selected.server || provider.name}`
                    },
                    { quoted: msg }
                );

                const finalUrl = await resolveRedirectPage(selected.url);

                if (!isHttp(finalUrl)) {
                    throw new Error('Valid download URL එකක් හමු නොවීය.');
                }

                const isDirect =
                    looksLikeDownload(finalUrl) ||
                    /\.(?:mp4|mkv|avi|mov|webm)(?:$|[?#])/i.test(finalUrl);

                if (!isDirect) {
                    return sock.sendMessage(
                        from,
                        {
                            text:
                                `🔗 *Direct download server එක redirect එකක් භාවිතා කරනවා.*\n\n` +
                                `${finalUrl}`
                        },
                        { quoted: msg }
                    );
                }

                const os = await import('node:os');
                const path = await import('node:path');
                const fs = await import('node:fs/promises');

                const tempDir = await fs.mkdtemp(
                    path.join(os.tmpdir(), 'mrnobody-movie-')
                );

                const ext =
                    /\.([a-z0-9]{2,5})(?:[?#].*)?$/i.exec(finalUrl)?.[1] ||
                    'mp4';

                const filePath =
                    path.join(tempDir, `movie.${ext}`);

                try {
                    await sock.sendMessage(
                        from,
                        { text: `⬇️ *${selected.quality} ${selected.size !== 'Size N/A' ? `(${selected.size})` : ''} download කරමින්...*` },
                        { quoted: msg }
                    );

                    await downloadToTemp(finalUrl, filePath);

                    const stat = await fs.stat(filePath);

                    const caption =
                        `🎬 *${cleanName(session.title)}*\n\n` +
                        `🎞️ Quality: *${selected.quality}*\n` +
                        `📦 Size: *${formatBytes(stat.size)}*\n` +
                        `📡 Server: *${selected.server || provider.name}*\n\n` +
                        `─── *${session.watermark}* ───`;

                    await sock.sendMessage(
                        from,
                        {
                            document: { url: filePath },
                            mimetype:
                                ext.toLowerCase() === 'mkv'
                                    ? 'video/x-matroska'
                                    : 'video/mp4',
                            fileName:
                                `${cleanName(session.title)}-${selected.quality}.${ext}`,
                            caption
                        },
                        { quoted: msg }
                    );
                } finally {
                    await fs.rm(tempDir, {
                        recursive: true,
                        force: true
                    }).catch(() => {});
                    store.delete(qid);
                }
            }
        } catch (error) {
            console.error(`[${provider.name}] Reply Error:`, error);
            store.delete(qid);

            await sock.sendMessage(
                from,
                {
                    text:
                        `❌ *${provider.name} error!*\n\n` +
                        `${error?.message || 'Unknown error'}`
                },
                { quoted: msg }
            ).catch(() => {});
        }
    });
}

function formatBytes(bytes) {
    let size = Number(bytes);
    if (!Number.isFinite(size) || size < 0) return 'N/A';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;

    while (size >= 1000 && i < units.length - 1) {
        size /= 1000;
        i++;
    }

    return `${size.toFixed(i ? 2 : 0)} ${units[i]}`;
}


const PROVIDER = {
    name: 'SINHALASUB',
    host: 'sinhalasub.lk',

    async search(query) {
        const url =
            `https://sinhalasub.lk/?s=${encodeURIComponent(query)}`;

        const { html, url: finalUrl } = await getHtml(url);
        const $ = cheerio.load(html);

        return findMovieLinks($, finalUrl, 'sinhalasub.lk');
    },

    async getDetails(movieUrl) {
        const { html, url: finalUrl } = await getHtml(movieUrl);
        const $ = cheerio.load(html);

        const title = extractTitle($, 'SinhalaSub Movie');
        const links = [];

        /*
         * SinhalaSub currently exposes a server/quality/size
         * table. We intentionally read what is present instead
         * of inventing 480p/720p/1080p options.
         */
        $('a[href]').each((_, el) => {
            const href = absUrl($(el).attr('href'), finalUrl);
            if (!href) return;

            const text = $(el).text().replace(/\s+/g, ' ').trim();
            const row = $(el).closest('tr');

            const rowText = row.length
                ? row.text().replace(/\s+/g, ' ').trim()
                : $(el).parent().text().replace(/\s+/g, ' ').trim();

            const combined = `${text} ${rowText}`;

            const quality = qualityFrom(combined);
            const size = parseSize(combined);

            /*
             * Server name comes from the row / nearest block.
             */
            let server = text;

            if (
                !server ||
                /^(download|click|here|link)$/i.test(server)
            ) {
                server = 'Direct';
            }

            if (
                /pixeldrain/i.test(combined)
            ) {
                server = 'Pixeldrain';
            } else if (
                /dotflix/i.test(combined)
            ) {
                server = 'Dotflix';
            } else if (
                /dlserver-?01/i.test(combined)
            ) {
                server = 'DLServer-01';
            } else if (
                /dlserver-?02/i.test(combined)
            ) {
                server = 'DLServer-02';
            } else if (
                /telegram|telagram/i.test(combined)
            ) {
                server = 'Telegram';
            }

            if (
                quality === 'Quality N/A' &&
                size === 'Size N/A' &&
                !looksLikeDownload(href, combined)
            ) {
                return;
            }

            links.push({
                quality,
                size,
                server: server.slice(0, 60),
                url: href
            });
        });

        /*
         * If the page structure changes and the table is no
         * longer represented by normal <a> elements, this
         * fallback still catches labelled download buttons.
         */
        if (!links.length) {
            $('a[href]').each((_, el) => {
                const href = absUrl($(el).attr('href'), finalUrl);
                const text = $(el).text().replace(/\s+/g, ' ').trim();

                if (
                    href &&
                    looksLikeDownload(href, text)
                ) {
                    links.push({
                        quality: qualityFrom(text),
                        size: parseSize(text),
                        server: text || 'Direct',
                        url: href
                    });
                }
            });
        }

        return {
            title,
            links: unique(links)
        };
    }
};

export default {
    pattern: 'sinhalasub',
    alias: ['ssub', 'sinhalasubdl'],
    category: 'download',
    desc: 'Search SinhalaSub movies and show available download qualities',

    function: async (sock, msg, { from, args, config }) => {
        attachReplyListener(sock, PROVIDER);

        const input = args.join(' ').trim();
        const watermark =
            config?.WATERMARK || 'MrNobody Serenity';

        if (!input) {
            return sock.sendMessage(
                from,
                {
                    text:
                        `🎬 *SINHALASUB MOVIE DOWNLOADER*\n\n` +
                        `Usage:\n` +
                        `*.sinhalasub Avatar*\n\n` +
                        `🔗 Direct movie URL එකක් දුන්නත් වැඩ කරයි.\n\n` +
                        `─── *${watermark}* ───`
                },
                { quoted: msg }
            );
        }

        const store = getStore(sock);

        try {
            let results;

            if (isHttp(input)) {
                results = [{
                    title: input,
                    url: input
                }];
            } else {
                await sock.sendMessage(
                    from,
                    { text: `🔎 *SinhalaSub search කරමින්...*\n\n📌 ${input}` },
                    { quoted: msg }
                );

                results = await PROVIDER.search(input);
            }

            if (!results.length) {
                throw new Error('Movie results හමු නොවීය.');
            }

            const sent = await sock.sendMessage(
                from,
                {
                    text: buildResults(
                        PROVIDER.name,
                        results,
                        watermark
                    )
                },
                { quoted: msg }
            );

            store.set(sent.key.id, {
                step: 'search',
                results,
                watermark,
                createdAt: Date.now()
            });
        } catch (error) {
            console.error('[SINHALASUB] Command Error:', error);

            await sock.sendMessage(
                from,
                {
                    text:
                        `❌ *SinhalaSub search error!*\n\n` +
                        `${error?.message || 'Unknown error'}`
                },
                { quoted: msg }
            );
        }
    }
};
