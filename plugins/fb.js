import Facebook from 'facebook-dl';
import axios from 'axios';

const fb = new Facebook();
const fbSessions = new Map();
let isListenerAttached = false;

const SESSION_TTL = 5 * 60 * 1000;

// Decimal:
// 1 MB = 1,000,000 bytes
const MAX_FILE_SIZE = 80 * 1000 * 1000;

const facebookUrlRegex =
    /https?:\/\/(?:www\.|web\.|m\.)?(?:facebook\.com|fb\.watch)\/[^\s]+/i;


// ==============================
// SESSION TIMER
// ==============================

function startSessionTimer(sessionId) {
    const session = fbSessions.get(sessionId);
    if (!session) return;

    if (session.timeout) {
        clearTimeout(session.timeout);
    }

    session.timeout = setTimeout(() => {
        const currentSession = fbSessions.get(sessionId);

        if (!currentSession) return;

        console.log(`[FB] Session expired: ${sessionId}`);

        fbSessions.delete(sessionId);
    }, SESSION_TTL);

    session.expiresAt = Date.now() + SESSION_TTL;
}


function touchSession(sessionId) {
    const session = fbSessions.get(sessionId);

    if (!session) return false;

    session.timestamp = Date.now();

    startSessionTimer(sessionId);

    console.log(`[FB] Session extended: ${sessionId}`);

    return true;
}


function deleteSession(sessionId) {
    const session = fbSessions.get(sessionId);

    if (!session) return;

    if (session.timeout) {
        clearTimeout(session.timeout);
    }

    fbSessions.delete(sessionId);

    console.log(`[FB] Session deleted: ${sessionId}`);
}


// ==============================
// DECIMAL FILE SIZE FORMAT
// ==============================

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return 'Unknown';
    }

    const units = ['B', 'KB', 'MB', 'GB'];

    let size = bytes;
    let index = 0;

    while (
        size >= 1000 &&
        index < units.length - 1
    ) {
        size /= 1000;
        index++;
    }

    return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}


// ==============================
// FILE NAME CLEANER
// ==============================

function cleanFileName(name) {
    return String(name || 'Facebook Video')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 150) || 'Facebook Video';
}


// ==============================
// FACEBOOK URL CLEANER
// ==============================

function cleanFacebookUrl(url) {
    return String(url || '')
        .trim()
        .replace(/[)\],}>]+$/g, '')
        .replace(/[.,!?]+$/g, '');
}


// ==============================
// FACEBOOK URL TYPE
// ==============================

function getFacebookUrlType(url) {
    const value = String(url || '').toLowerCase();

    if (/facebook\.com\/share\/r\//i.test(value)) {
        return 'share_reel';
    }

    if (/facebook\.com\/share\/v\//i.test(value)) {
        return 'share_video';
    }

    if (/facebook\.com\/reel\//i.test(value)) {
        return 'reel';
    }

    if (/facebook\.com\/watch/i.test(value)) {
        return 'watch';
    }

    if (/facebook\.com\/videos?\//i.test(value)) {
        return 'video';
    }

    if (/fb\.watch\//i.test(value)) {
        return 'fb_watch';
    }

    return 'facebook';
}


// ==============================
// RESOLVE FACEBOOK SHARE URL
// ==============================

async function resolveFacebookUrl(url) {
    const originalUrl = cleanFacebookUrl(url);

    const type = getFacebookUrlType(originalUrl);

    console.log(
        `[FB] URL type: ${type}`
    );

    // Direct URLs do not need redirect resolution.
    if (
        type !== 'share_reel' &&
        type !== 'share_video'
    ) {
        return originalUrl;
    }

    console.log(
        `[FB] Resolving Facebook share URL: ${originalUrl}`
    );

    try {
        const response = await axios.get(
            originalUrl,
            {
                timeout: 20000,

                maxRedirects: 10,

                validateStatus: status =>
                    status >= 200 &&
                    status < 400,

                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                        'Chrome/131.0.0.0 Safari/537.36',

                    'Accept':
                        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

                    'Accept-Language':
                        'en-US,en;q=0.9'
                }
            }
        );

        const finalUrl =
            cleanFacebookUrl(
                response.request?.res?.responseUrl ||
                response.request?.res?.request?.uri?.href ||
                response.config?.url ||
                originalUrl
            );

        console.log(
            `[FB] Share URL resolved to: ${finalUrl}`
        );

        if (
            finalUrl &&
            finalUrl !== originalUrl
        ) {
            return finalUrl;
        }

        // Axios may expose the final URL differently
        // depending on the Node.js version / adapter.
        const locationHeader =
            response.headers?.location;

        if (locationHeader) {

            let redirectedUrl;

            try {
                redirectedUrl =
                    new URL(
                        locationHeader,
                        originalUrl
                    ).toString();
            } catch (_) {
                redirectedUrl =
                    locationHeader;
            }

            redirectedUrl =
                cleanFacebookUrl(
                    redirectedUrl
                );

            console.log(
                `[FB] Location header resolved to: ${redirectedUrl}`
            );

            if (redirectedUrl) {
                return redirectedUrl;
            }
        }

    } catch (error) {

        console.error(
            '[FB] Share URL resolution failed:',
            error.message
        );
    }

    /*
     * IMPORTANT:
     *
     * Facebook share/r URLs sometimes do not expose the
     * final URL through a normal HTTP redirect.
     *
     * In that case, pass the original URL to facebook-dl
     * as a final attempt.
     */

    console.log(
        '[FB] Could not determine final redirect URL. ' +
        'Trying original share URL with facebook-dl.'
    );

    return originalUrl;
}


// ==============================
// GET REMOTE FILE SIZE
// ==============================

async function getRemoteFileSize(url) {
    if (!url) return null;

    try {
        const response = await axios.head(
            url,
            {
                timeout: 15000,

                maxRedirects: 10,

                validateStatus: status =>
                    status >= 200 &&
                    status < 400
            }
        );

        const size =
            Number(
                response.headers['content-length']
            );

        if (
            Number.isFinite(size) &&
            size > 0
        ) {
            return size;
        }

    } catch (error) {

        console.log(
            '[FB] HEAD request failed:',
            error.message
        );
    }

    return null;
}


// ==============================
// FACEBOOK VIDEO RESOLVER
// ==============================

async function getFacebookVideo(url) {

    const inputUrl =
        cleanFacebookUrl(url);

    console.log(
        '[FB] Resolving:',
        inputUrl
    );

    /*
     * First resolve share/r and share/v links.
     */
    const resolvedUrl =
        await resolveFacebookUrl(
            inputUrl
        );

    console.log(
        '[FB] Downloader URL:',
        resolvedUrl
    );


    let result;

    try {

        result =
            await fb.fbdl(
                resolvedUrl
            );

    } catch (firstError) {

        console.error(
            '[FB] First downloader attempt failed:',
            firstError.message
        );

        /*
         * If the URL was a share URL and redirect resolution
         * produced a different URL, retry the original share
         * URL. Some Facebook downloader implementations
         * specifically understand share URLs.
         */

        if (
            resolvedUrl !== inputUrl
        ) {

            console.log(
                '[FB] Retrying original Facebook share URL...'
            );

            try {

                result =
                    await fb.fbdl(
                        inputUrl
                    );

            } catch (secondError) {

                console.error(
                    '[FB] Original share URL retry failed:',
                    secondError.message
                );

                throw secondError;
            }

        } else {

            throw firstError;
        }
    }


    if (!result) {
        throw new Error(
            'Facebook downloader returned empty response.'
        );
    }


    if (
        result.code &&
        Number(result.code) !== 200
    ) {
        throw new Error(
            `Facebook downloader error: ${result.code}`
        );
    }


    const data =
        result.results;


    if (!data) {
        throw new Error(
            'Facebook video information not found.'
        );
    }


    const quality =
        data.quality || {};


    const hdUrl =
        typeof quality.hd === 'string' &&
        quality.hd.trim()
            ? quality.hd.trim()
            : null;


    const sdUrl =
        typeof quality.sd === 'string' &&
        quality.sd.trim()
            ? quality.sd.trim()
            : null;


    if (!hdUrl && !sdUrl) {
        throw new Error(
            'No downloadable Facebook video URL found.'
        );
    }


    return {
        title:
            data.title ||
            'Facebook Video',

        thumbnail:
            data.thumbnail ||
            null,

        duration:
            data.duration ||
            'N/A',

        originalUrl:
            data.url ||
            resolvedUrl ||
            inputUrl,

        resolvedUrl:
            resolvedUrl,

        hd:
            hdUrl,

        sd:
            sdUrl
    };
}


// ==============================
// QUALITY SELECTOR
// ==============================

function selectQuality(video, requested) {

    if (requested === 'hd') {

        if (video.hd) {

            return {
                requested: 'hd',
                actual: 'hd',
                url: video.hd
            };
        }

        if (video.sd) {

            return {
                requested: 'hd',
                actual: 'sd',
                url: video.sd
            };
        }
    }


    if (requested === 'sd') {

        if (video.sd) {

            return {
                requested: 'sd',
                actual: 'sd',
                url: video.sd
            };
        }

        if (video.hd) {

            return {
                requested: 'sd',
                actual: 'hd',
                url: video.hd
            };
        }
    }

    return null;
}


// ==============================
// FALLBACK MESSAGE
// ==============================

function getFallbackMessage(
    requested,
    actual
) {

    if (requested === actual) {
        return null;
    }

    return (
        `⚠️ *ඔබ ඉල්ලූ ${requested.toUpperCase()} quality එක Facebook එකේ නොමැත.*\n\n` +
        `📥 එම නිසා *${actual.toUpperCase()} quality එකෙන්* download කරමි.`
    );
}


// ==============================
// SEND FACEBOOK VIDEO
// ==============================

async function sendFacebookVideo(
    sock,
    from,
    msg,
    session
) {

    console.log(
        '[FB] Checking file size...'
    );


    const fileSize =
        await getRemoteFileSize(
            session.downloadUrl
        );


    let deliveryType =
        'video';


    // Decimal 80MB check
    if (
        fileSize &&
        fileSize > MAX_FILE_SIZE
    ) {

        deliveryType =
            'document';


        await sock.sendMessage(
            from,
            {
                text:
                    `⚠️ *ඔබ ඉල්ලූ වීඩියෝව 80MB වලට වඩා වැඩියි.*\n\n` +
                    `📦 Size: *${formatBytes(fileSize)}*\n\n` +
                    `📄 ඒ නිසා Video එක *Document* ලෙස ලබාදෙමි.`
            },
            {
                quoted: msg
            }
        );
    }


    const fileName =
        `${cleanFileName(session.title)}.mp4`;


    let caption =
        `🎬 *MRNOBODY FACEBOOK DOWNLOADER*\n\n`;


    caption +=
        `📌 *Title:* ${session.title}\n`;


    caption +=
        `⏱️ *Duration:* ${session.duration}\n`;


    caption +=
        `🎚️ *Quality:* ${session.actualQuality.toUpperCase()}\n`;


    if (fileSize) {

        caption +=
            `📦 *Size:* ${formatBytes(fileSize)}\n`;
    }


    if (
        deliveryType === 'document'
    ) {

        caption +=
            `📄 *Sent as Document — Size > 80MB*\n`;

    } else {

        caption +=
            `🎥 *Sent as Video*\n`;
    }


    caption +=
        `\n─── *${session.config?.WATERMARK || 'MrNobody Serenity'}* ───`;


    // ==========================
    // DOCUMENT
    // ==========================

    if (
        deliveryType === 'document'
    ) {

        await sock.sendMessage(
            from,
            {
                document: {
                    url: session.downloadUrl
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


        console.log(
            '[FB] Sent as Document.'
        );

        return;
    }


    // ==========================
    // VIDEO
    // ==========================

    try {

        await sock.sendMessage(
            from,
            {
                video: {
                    url: session.downloadUrl
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


        console.log(
            '[FB] Sent as Video.'
        );

    } catch (videoError) {

        console.error(
            '[FB] Video send failed:',
            videoError.message
        );


        // ==========================
        // VIDEO -> DOCUMENT FALLBACK
        // ==========================

        await sock.sendMessage(
            from,
            {
                document: {
                    url: session.downloadUrl
                },

                mimetype:
                    'video/mp4',

                fileName,

                caption:
                    caption +
                    `\n📄 *Video delivery failed, so sent as Document.*`
            },
            {
                quoted: msg
            }
        );


        console.log(
            '[FB] Video failed -> Document fallback.'
        );
    }
}


// ==============================
// MESSAGE LISTENER
// ==============================

function attachFacebookListener(sock) {

    if (isListenerAttached) {
        return;
    }

    isListenerAttached = true;


    sock.ev.on(
        'messages.upsert',
        async m => {

            try {

                const msg =
                    m.messages?.[0];


                if (!msg?.message) {
                    return;
                }


                const from =
                    msg.key.remoteJid;


                const text =
                    (
                        msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        ''
                    ).trim();


                const quotedId =
                    msg.message
                        ?.extendedTextMessage
                        ?.contextInfo
                        ?.stanzaId;


                if (!quotedId) {
                    return;
                }


                const session =
                    fbSessions.get(
                        quotedId
                    );


                if (!session) {
                    return;
                }


                // Extend session
                touchSession(
                    quotedId
                );


                if (
                    session.step !==
                    'select_quality'
                ) {
                    return;
                }


                const choice =
                    parseInt(
                        text,
                        10
                    );


                if (
                    ![1, 2].includes(choice)
                ) {

                    return await sock.sendMessage(
                        from,
                        {
                            text:
                                `⚠️ *1 හෝ 2 Reply කරන්න!*\n\n` +
                                `1️⃣ HD Quality\n` +
                                `2️⃣ SD Quality\n\n` +
                                `⏳ *Session එක තවත් විනාඩි 5ක් active.*`
                        },
                        {
                            quoted: msg
                        }
                    );
                }


                const requestedQuality =
                    choice === 1
                        ? 'hd'
                        : 'sd';


                const selected =
                    selectQuality(
                        session.video,
                        requestedQuality
                    );


                if (!selected) {

                    return await sock.sendMessage(
                        from,
                        {
                            text:
                                `❌ *Facebook video එකේ downloadable quality එකක් හමු වුණේ නැහැ.*\n\n` +
                                `⏳ *Session එක තවත් විනාඩි 5ක් active.*`
                        },
                        {
                            quoted: msg
                        }
                    );
                }


                // ==========================
                // FALLBACK NOTICE
                // ==========================

                const fallbackMessage =
                    getFallbackMessage(
                        requestedQuality,
                        selected.actual
                    );


                if (fallbackMessage) {

                    await sock.sendMessage(
                        from,
                        {
                            text:
                                fallbackMessage
                        },
                        {
                            quoted: msg
                        }
                    );
                }


                // ==========================
                // DOWNLOAD NOTICE
                // ==========================

                await sock.sendMessage(
                    from,
                    {
                        text:
                            `⏳ *Downloading Facebook Video...*\n\n` +
                            `📌 ${session.title}\n` +
                            `🎚️ Quality: *${selected.actual.toUpperCase()}*\n\n` +
                            `📦 *80MB ට වැඩි නම් Document ලෙස ලැබේ.*\n\n` +
                            `_කරුණාකර මොහොතක් රැඳී සිටින්න..._`
                    },
                    {
                        quoted: msg
                    }
                );


                try {

                    await sendFacebookVideo(
                        sock,
                        from,
                        msg,
                        {
                            ...session,

                            requestedQuality,

                            actualQuality:
                                selected.actual,

                            downloadUrl:
                                selected.url
                        }
                    );


                    touchSession(
                        quotedId
                    );


                    console.log(
                        `[FB] ${selected.actual} completed. Session remains active.`
                    );

                } catch (error) {

                    console.error(
                        '[FB] Send error:',
                        error
                    );


                    await sock.sendMessage(
                        from,
                        {
                            text:
                                `❌ *Facebook video එක යැවීමට නොහැකි විය.*\n\n` +
                                `Error: ${error.message}\n\n` +
                                `⏳ *ඔබට තවත් විනාඩි 5ක් ඇතුළත quality එකක් තෝරාගත හැක.*`
                        },
                        {
                            quoted: msg
                        }
                    );


                    touchSession(
                        quotedId
                    );
                }

            } catch (error) {

                console.error(
                    '[FB] Listener error:',
                    error
                );
            }
        }
    );
}


// ==============================
// MAIN COMMAND
// ==============================

export default {
    pattern: 'fb',

    category: 'download',

    desc:
        'Download Facebook Videos / Reels',


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

            attachFacebookListener(
                sock
            );


            const watermark =
                config?.WATERMARK ||
                'MrNobody Serenity';


            const query =
                args.join(' ').trim();


            // ==========================
            // NO URL
            // ==========================

            if (!query) {

                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `⚠️ *Facebook Video Link එකක් ලබාදෙන්න!*\n\n` +
                            `උදාහරණ:\n` +
                            `*.fb https://www.facebook.com/...*\n\n` +
                            `🎬 Facebook Videos සහ Reels support කරයි.\n\n` +
                            `─── *${watermark}* ───`
                    },
                    {
                        quoted: msg
                    }
                );
            }


            // ==========================
            // URL VALIDATION
            // ==========================

            const urlMatch =
                query.match(
                    facebookUrlRegex
                );


            if (!urlMatch) {

                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ *Valid Facebook URL එකක් ලබාදෙන්න.*\n\n` +
                            `උදා:\n` +
                            `*.fb https://www.facebook.com/reel/...*`
                    },
                    {
                        quoted: msg
                    }
                );
            }


            const facebookUrl =
                cleanFacebookUrl(
                    urlMatch[0]
                );


            // ==========================
            // CHECKING
            // ==========================

            await sock.sendMessage(
                from,
                {
                    text:
                        `🔎 *Facebook Video එක check කරමින්...*\n\n` +
                        `_මොහොතක් රැඳී සිටින්න..._`
                },
                {
                    quoted: msg
                }
            );


            // ==========================
            // RESOLVE VIDEO
            // ==========================

            let video;


            try {

                video =
                    await getFacebookVideo(
                        facebookUrl
                    );

            } catch (error) {

                console.error(
                    '[FB] Downloader error:',
                    error
                );


                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ *Facebook Video එක ලබාගැනීමට නොහැකි විය.*\n\n` +
                            `මෙය private video එකක් විය හැකිය, link එක expire වී තිබිය හැකිය, හෝ Facebook එකෙන් download access ලබා නොදෙන video එකක් විය හැකිය.\n\n` +
                            `කරුණාකර public Facebook video/reel link එකක් උත්සාහ කරන්න.`
                    },
                    {
                        quoted: msg
                    }
                );
            }


            const hasHD =
                Boolean(video.hd);


            const hasSD =
                Boolean(video.sd);


            // ==========================
            // QUALITY CARD
            // ==========================

            let infoCard =
                `🎬 *MRNOBODY FACEBOOK DOWNLOADER* 🎬\n\n`;


            infoCard +=
                `📌 *Title:* ${video.title}\n`;


            infoCard +=
                `⏱️ *Duration:* ${video.duration}\n\n`;


            infoCard +=
                `👇 *SELECT VIDEO QUALITY*\n\n`;


            infoCard +=
                `1️⃣ HD Quality${hasHD ? ' ✅' : ' ❌'}\n`;


            infoCard +=
                `2️⃣ SD Quality${hasSD ? ' ✅' : ' ❌'}\n\n`;


            infoCard +=
                `📦 *80MB ට වැඩි නම් automatically Document ලෙස යවනු ලැබේ.*\n`;


            infoCard +=
                `🔄 *Quality එක නැවත තෝරාගැනීමට විනාඩි 5ක් ඇතුළත Reply කරන්න.*\n\n`;


            infoCard +=
                `_Reply 1 or 2_`;


            infoCard +=
                `\n\n─── *${watermark}* ───`;


            // ==========================
            // SEND CARD
            // ==========================

            let sentMsg;


            if (video.thumbnail) {

                sentMsg =
                    await sock.sendMessage(
                        from,
                        {
                            image: {
                                url:
                                    video.thumbnail
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


            // ==========================
            // CREATE SESSION
            // ==========================

            const sessionId =
                sentMsg.key.id;


            fbSessions.set(
                sessionId,
                {
                    step:
                        'select_quality',

                    video,

                    title:
                        video.title,

                    duration:
                        video.duration,

                    thumbnail:
                        video.thumbnail,

                    config,

                    timestamp:
                        Date.now(),

                    timeout:
                        null,

                    expiresAt:
                        Date.now() +
                        SESSION_TTL
                }
            );


            startSessionTimer(
                sessionId
            );


            console.log(
                `[FB] New HD/SD session created: ${sessionId}`
            );

        } catch (error) {

            console.error(
                '[FB] Command error:',
                error
            );


            await sock.sendMessage(
                from,
                {
                    text:
                        `❌ *Facebook command error!*\n\n` +
                        `${error.message}`
                },
                {
                    quoted: msg
                }
            );
        }
    }
}
