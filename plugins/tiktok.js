import axios from 'axios';

// ============================================================
// MRNOBODY TIKTOK VIDEO DOWNLOADER
// ============================================================

// ============================================================
// CONFIG
// ============================================================

// 80 MB DECIMAL
const MAX_FILE_SIZE = 80 * 1000 * 1000;


// ============================================================
// HELPERS
// ============================================================

function cleanFileName(name) {
    return String(name || 'TikTok Video')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 150) || 'TikTok Video';
}


// ============================================================
// FORMAT SIZE
// ============================================================

function formatBytes(bytes) {
    if (
        !Number.isFinite(bytes) ||
        bytes <= 0
    ) {
        return 'Unknown';
    }

    const units = [
        'B',
        'KB',
        'MB',
        'GB'
    ];

    let size = bytes;
    let index = 0;

    while (
        size >= 1000 &&
        index < units.length - 1
    ) {
        size /= 1000;
        index++;
    }

    return `${size.toFixed(
        index === 0 ? 0 : 2
    )} ${units[index]}`;
}


// ============================================================
// FORMAT DURATION
// ============================================================

function formatDuration(duration) {
    const totalSeconds = Number(duration);

    if (
        !Number.isFinite(totalSeconds) ||
        totalSeconds < 0
    ) {
        return '00:00:00';
    }

    const hours =
        Math.floor(totalSeconds / 3600);

    const minutes =
        Math.floor(
            (totalSeconds % 3600) / 60
        );

    const seconds =
        Math.floor(
            totalSeconds % 60
        );

    return [
        hours,
        minutes,
        seconds
    ]
        .map(
            value =>
                String(value).padStart(2, '0')
        )
        .join(':');
}


// ============================================================
// NORMALIZE URL
// ============================================================

function normalizeTikTokUrl(input) {
    let url = String(input || '').trim();

    if (!url) {
        return null;
    }

    url = url
        .replace(/[<>()[\]{}]/g, '')
        .replace(/[.,!?;]+$/g, '');

    if (
        !/^https?:\/\//i.test(url)
    ) {
        url = `https://${url}`;
    }

    return url;
}


// ============================================================
// TIKTOK URL VALIDATION
// ============================================================

function isTikTokUrl(url) {
    try {
        const parsed = new URL(url);

        const hostname =
            parsed.hostname.toLowerCase();

        return (
            hostname === 'tiktok.com' ||
            hostname === 'www.tiktok.com' ||
            hostname === 'm.tiktok.com' ||
            hostname === 'vm.tiktok.com' ||
            hostname === 'vt.tiktok.com'
        );

    } catch {
        return false;
    }
}


// ============================================================
// GET REMOTE FILE SIZE
// ============================================================

async function getRemoteFileSize(url) {
    if (!url) {
        return null;
    }

    try {
        const response =
            await axios.head(url, {
                timeout: 15000,
                maxRedirects: 5,

                validateStatus:
                    status =>
                        status >= 200 &&
                        status < 400
            });

        const contentLength =
            response.headers[
                'content-length'
            ];

        const size =
            Number(contentLength);

        if (
            Number.isFinite(size) &&
            size > 0
        ) {
            return size;
        }

    } catch (error) {
        console.log(
            '[TIKTOK] HEAD size check failed:',
            error.message
        );
    }

    return null;
}


// ============================================================
// TIKTOK API
// ============================================================

async function getTikTokVideo(url) {

    console.log(
        '[TIKTOK] Resolving:',
        url
    );

    const apiUrl =
        `https://www.tikwm.com/api/?url=${encodeURIComponent(
            url
        )}&hd=1`;

    const response =
        await axios.get(
            apiUrl,
            {
                timeout: 30000,

                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                        'AppleWebKit/537.36 ' +
                        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

                    'Accept':
                        'application/json'
                }
            }
        );

    const result =
        response.data;

    if (!result) {
        throw new Error(
            'TikTok API returned empty response.'
        );
    }

    if (
        Number(result.code) !== 0 ||
        !result.data
    ) {
        throw new Error(
            result.msg ||
            'TikTok video information not found.'
        );
    }

    const data =
        result.data;


    // ========================================================
    // REAL HD URL
    // ========================================================

    const hdUrl =
        typeof data.hdplay === 'string' &&
        data.hdplay.trim()
            ? data.hdplay.trim()
            : null;


    // ========================================================
    // REAL NORMAL URL
    // ========================================================

    const sdUrl =
        typeof data.play === 'string' &&
        data.play.trim()
            ? data.play.trim()
            : null;


    // ========================================================
    // HIGHEST QUALITY SELECTION
    // ========================================================

    let downloadUrl = null;
    let quality = null;
    let apiSize = null;

    if (hdUrl) {

        downloadUrl =
            hdUrl;

        quality =
            'HD';

        const hdSize =
            Number(data.hd_size);

        if (
            Number.isFinite(hdSize) &&
            hdSize > 0
        ) {
            apiSize =
                hdSize;
        }

    } else if (sdUrl) {

        downloadUrl =
            sdUrl;

        quality =
            'SD';

        const sdSize =
            Number(data.size);

        if (
            Number.isFinite(sdSize) &&
            sdSize > 0
        ) {
            apiSize =
                sdSize;
        }
    }


    // ========================================================
    // NO VIDEO
    // ========================================================

    if (!downloadUrl) {
        throw new Error(
            'No downloadable TikTok video URL found.'
        );
    }


    console.log(
        `[TIKTOK] Selected quality: ${quality}`
    );

    console.log(
        `[TIKTOK] HD available: ${Boolean(hdUrl)}`
    );

    console.log(
        `[TIKTOK] SD available: ${Boolean(sdUrl)}`
    );


    return {
        title:
            data.title ||
            'TikTok Video',

        duration:
            formatDuration(
                data.duration
            ),

        thumbnail:
            data.cover ||
            data.origin_cover ||
            null,

        downloadUrl,

        quality,

        apiSize,

        hdAvailable:
            Boolean(hdUrl),

        sdAvailable:
            Boolean(sdUrl)
    };
}


// ============================================================
// DOWNLOAD INFO
// ============================================================

async function prepareTikTokVideo(video) {

    let fileSize =
        video.apiSize || null;

    if (!fileSize) {

        fileSize =
            await getRemoteFileSize(
                video.downloadUrl
            );
    }

    const isOverLimit =
        Number.isFinite(fileSize) &&
        fileSize > MAX_FILE_SIZE;

    console.log(
        `[TIKTOK] Quality: ${video.quality}`
    );

    console.log(
        `[TIKTOK] Size: ${
            fileSize
                ? formatBytes(fileSize)
                : 'Unknown'
        }`
    );

    console.log(
        `[TIKTOK] Delivery: ${
            isOverLimit
                ? 'DOCUMENT'
                : 'VIDEO'
        }`
    );

    return {
        ...video,

        fileSize,

        isOverLimit
    };
}


// ============================================================
// SEND VIDEO / DOCUMENT
// ============================================================

async function sendTikTokVideo(
    sock,
    from,
    msg,
    video,
    config
) {

    const watermark =
        config?.WATERMARK ||
        'MrNobody Serenity';

    const prepared =
        await prepareTikTokVideo(
            video
        );

    const fileName =
        `${cleanFileName(
            video.title
        )}.mp4`;

    const qualityText =
        video.quality === 'HD'
            ? 'HD'
            : 'SD';

    let caption =
        `🎬 *MRNOBODY TIKTOK VIDEO*\n\n`;

    caption +=
        `📥 *Downloaded In Available Highest Quality*\n`;

    caption +=
        `🎥 *Quality: ${qualityText}*\n`;

    if (
        prepared.fileSize
    ) {
        caption +=
            `💾 *Size: ${formatBytes(
                prepared.fileSize
            )}*\n`;
    }

    if (
        video.duration
    ) {
        caption +=
            `⏱️ *Duration: ${video.duration}*\n`;
    }

    caption +=
        `\n─── *${watermark}* ───`;


    if (
        prepared.isOverLimit
    ) {

        await sock.sendMessage(
            from,
            {
                document: {
                    url:
                        video.downloadUrl
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
            '[TIKTOK] >80MB -> Document'
        );

        return true;
    }


    try {

        await sock.sendMessage(
            from,
            {
                video: {
                    url:
                        video.downloadUrl
                },

                mimetype:
                    'video/mp4',

                fileName,

                caption,

                hd:
                    video.quality === 'HD'
            },
            {
                quoted: msg
            }
        );

        console.log(
            `[TIKTOK] ${qualityText} -> Video`
        );

        return true;

    } catch (videoError) {

        console.error(
            '[TIKTOK] Video send failed:',
            videoError.message
        );

        await sock.sendMessage(
            from,
            {
                document: {
                    url:
                        video.downloadUrl
                },

                mimetype:
                    'video/mp4',

                fileName,

                caption:
                    caption +
                    `\n📄 *Sent as Document because Video delivery failed.*`
            },
            {
                quoted: msg
            }
        );

        console.log(
            '[TIKTOK] Video failed -> Document fallback'
        );

        return true;
    }
}


// ============================================================
// COMMAND
// ============================================================

export default {
    pattern:
        'tiktok',

    category:
        'download',

    desc:
        'Download TikTok Videos in Highest Available Quality',

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

            const watermark =
                config?.WATERMARK ||
                'MrNobody Serenity';

            const input =
                args
                    .join(' ')
                    .trim();

            if (!input) {

                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `⚠️ *TikTok Video link එකක් ලබාදෙන්න!*\n\n` +
                            `උදා:\n` +
                            `*.tiktok https://www.tiktok.com/@user/video/XXXXXXXX*\n\n` +
                            `🎬 *Video එක link එක දුන්න ගමන් available highest quality එකෙන් download වේ.*\n\n` +
                            `📦 *80MB ට වැඩි නම් Document ලෙස ලැබේ.*`
                    },
                    {
                        quoted: msg
                    }
                );
            }

            const tiktokUrl =
                normalizeTikTokUrl(
                    input
                );

            if (!tiktokUrl) {

                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ *TikTok URL එකක් හමු වුණේ නැහැ.*`
                    },
                    {
                        quoted: msg
                    }
                );
            }

            if (
                !isTikTokUrl(
                    tiktokUrl
                )
            ) {

                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ *Invalid TikTok URL!*\n\n` +
                            `කරුණාකර valid TikTok Video link එකක් ලබාදෙන්න.`
                    },
                    {
                        quoted: msg
                    }
                );
            }

            await sock.sendMessage(
                from,
                {
                    text:
                        `🔎 *TikTok Video එක සොයමින්...*\n\n` +
                        `⏳ _Available highest quality එක check කරමින්..._`
                },
                {
                    quoted: msg
                }
            );

            let video;

            try {

                video =
                    await getTikTokVideo(
                        tiktokUrl
                    );

            } catch (error) {

                console.error(
                    '[TIKTOK] Resolve failed:',
                    error
                );

                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ *TikTok Video එක ලබාගැනීමට නොහැකි විය.*\n\n` +
                            `මෙය private/restricted video එකක් විය හැකිය, ` +
                            `link එක expire වී තිබිය හැකිය, හෝ TikTok downloader access නොදෙන video එකක් විය හැකිය.\n\n` +
                            `කරුණාකර public TikTok Video link එකක් උත්සාහ කරන්න.`
                    },
                    {
                        quoted: msg
                    }
                );
            }

            await sock.sendMessage(
                from,
                {
                    text:
                        `🎬 *MRNOBODY TIKTOK VIDEO DOWNLOADER* 🎬\n\n` +
                        `📌 *Title:* ${video.title}\n` +
                        `⏱️ *Duration:* ${video.duration}\n` +
                        `🎥 *Quality:* ${video.quality}\n\n` +
                        `⬇️ *Downloading In Available Highest Quality...*\n\n` +
                        `📌 *80MB ට අඩු නම් Video ලෙසත්,*\n` +
                        `📌 *80MB ට වැඩි නම් Document ලෙසත් ලැබේ.*\n\n` +
                        `─── *${watermark}* ───`
                },
                {
                    quoted: msg
                }
            );

            await sendTikTokVideo(
                sock,
                from,
                msg,
                video,
                config
            );

            console.log(
                '[TIKTOK] Completed successfully.'
            );

        } catch (error) {

            console.error(
                '[TIKTOK] Fatal error:',
                error
            );

            try {

                await sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ *TikTok command error!*\n\n` +
                            `${error.message}`
                    },
                    {
                        quoted: msg
                    }
                );

            } catch (sendError) {

                console.error(
                    '[TIKTOK] Error message failed:',
                    sendError.message
                );
            }
        }
    }
}
