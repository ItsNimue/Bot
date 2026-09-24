import ytdl from '@hiudyy/ytdl';
const { downloadInstagram, isValidInstagramURL } = ytdl;

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ============================================================
// MRNOBODY INSTAGRAM VIDEO DOWNLOADER
//
// Reel / Reels / TV only
// Photo / /p/ links blocked
//
// <= 80 MB  -> WhatsApp Video
// > 80 MB   -> WhatsApp Document
//
// No FFmpeg
// ============================================================

const MAX_FILE_SIZE = 80 * 1000 * 1000;

// ============================================================
// HELPERS
// ============================================================

function cleanFileName(name) {
    return String(name || 'Instagram Video')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 150) || 'Instagram Video';
}

function normalizeInstagramUrl(input) {
    let url = String(input || '').trim();

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

function isVideoInstagramUrl(url) {
    try {
        const parsed = new URL(url);

        if (
            !/^(www\.)?instagram\.com$/i.test(
                parsed.hostname
            )
        ) {
            return false;
        }

        const pathname =
            parsed.pathname.toLowerCase();

        return (
            pathname.startsWith('/reel/') ||
            pathname.startsWith('/reels/') ||
            pathname.startsWith('/tv/')
        );
    } catch {
        return false;
    }
}

// ============================================================
// MP4 BASIC HELPERS
// ============================================================

function readUInt32(buffer, offset) {
    if (
        offset < 0 ||
        offset + 4 > buffer.length
    ) {
        return null;
    }

    return buffer.readUInt32BE(offset);
}

function readUInt16(buffer, offset) {
    if (
        offset < 0 ||
        offset + 2 > buffer.length
    ) {
        return null;
    }

    return buffer.readUInt16BE(offset);
}

function getBoxType(buffer, offset) {
    if (
        offset < 0 ||
        offset + 8 > buffer.length
    ) {
        return null;
    }

    return buffer.toString(
        'ascii',
        offset + 4,
        offset + 8
    );
}

function getBoxSize(buffer, offset, end) {
    if (
        offset < 0 ||
        offset + 8 > end ||
        offset + 8 > buffer.length
    ) {
        return null;
    }

    let size =
        readUInt32(
            buffer,
            offset
        );

    if (size === 1) {
        if (
            offset + 16 > end ||
            offset + 16 > buffer.length
        ) {
            return null;
        }

        const high =
            buffer.readUInt32BE(
                offset + 8
            );

        const low =
            buffer.readUInt32BE(
                offset + 12
            );

        if (high !== 0) {
            return null;
        }

        size = low;
    }

    if (size === 0) {
        size =
            end -
            offset;
    }

    if (
        size < 8 ||
        offset + size > end ||
        offset + size > buffer.length
    ) {
        return null;
    }

    return size;
}

function findChildBoxes(
    buffer,
    start,
    end,
    wantedType
) {
    const boxes = [];

    let offset =
        start;

    while (
        offset + 8 <= end &&
        offset + 8 <= buffer.length
    ) {
        const size =
            getBoxSize(
                buffer,
                offset,
                end
            );

        if (!size) {
            break;
        }

        const type =
            getBoxType(
                buffer,
                offset
            );

        if (
            type === wantedType
        ) {
            boxes.push({
                offset,
                size,
                end:
                    offset + size,
                type
            });
        }

        offset += size;
    }

    return boxes;
}

// ============================================================
// FORMAT DURATION
// ============================================================

function formatDuration(duration) {
    const totalSeconds =
        Number(duration);

    if (
        !Number.isFinite(totalSeconds) ||
        totalSeconds < 0
    ) {
        return '00:00:00';
    }

    const hours =
        Math.floor(
            totalSeconds / 3600
        );

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
                String(value).padStart(
                    2,
                    '0'
                )
        )
        .join(':');
}

// ============================================================
// FIND VIDEO RESOLUTION
// ============================================================

function findVideoResolution(buffer) {
    const moovBoxes =
        findChildBoxes(
            buffer,
            0,
            buffer.length,
            'moov'
        );

    for (const moov of moovBoxes) {
        const traks =
            findChildBoxes(
                buffer,
                moov.offset + 8,
                moov.end,
                'trak'
            );

        for (const trak of traks) {
            const mdiaBoxes =
                findChildBoxes(
                    buffer,
                    trak.offset + 8,
                    trak.end,
                    'mdia'
                );

            let isVideoTrack = false;

            for (const mdia of mdiaBoxes) {
                const hdlrBoxes =
                    findChildBoxes(
                        buffer,
                        mdia.offset + 8,
                        mdia.end,
                        'hdlr'
                    );

                for (const hdlr of hdlrBoxes) {
                    const handlerTypeOffset =
                        hdlr.offset + 16;

                    if (
                        handlerTypeOffset + 4 <=
                        buffer.length
                    ) {
                        const handlerType =
                            buffer.toString(
                                'ascii',
                                handlerTypeOffset,
                                handlerTypeOffset + 4
                            );

                        if (
                            handlerType === 'vide'
                        ) {
                            isVideoTrack = true;
                            break;
                        }
                    }
                }

                if (isVideoTrack) {
                    break;
                }
            }

            if (!isVideoTrack) {
                continue;
            }

            for (const mdia of mdiaBoxes) {
                const minfBoxes =
                    findChildBoxes(
                        buffer,
                        mdia.offset + 8,
                        mdia.end,
                        'minf'
                    );

                for (const minf of minfBoxes) {
                    const stblBoxes =
                        findChildBoxes(
                            buffer,
                            minf.offset + 8,
                            minf.end,
                            'stbl'
                        );

                    for (const stbl of stblBoxes) {
                        const stsdBoxes =
                            findChildBoxes(
                                buffer,
                                stbl.offset + 8,
                                stbl.end,
                                'stsd'
                            );

                        for (const stsd of stsdBoxes) {
                            const entryCount =
                                readUInt32(
                                    buffer,
                                    stsd.offset + 12
                                );

                            if (
                                !entryCount ||
                                entryCount < 1
                            ) {
                                continue;
                            }

                            let entryOffset =
                                stsd.offset + 16;

                            for (
                                let i = 0;
                                i < entryCount;
                                i++
                            ) {
                                if (
                                    entryOffset + 8 >
                                    stsd.end
                                ) {
                                    break;
                                }

                                const entrySize =
                                    readUInt32(
                                        buffer,
                                        entryOffset
                                    );

                                if (
                                    !entrySize ||
                                    entryOffset +
                                        entrySize >
                                        stsd.end
                                ) {
                                    break;
                                }

                                const entryType =
                                    buffer.toString(
                                        'ascii',
                                        entryOffset + 4,
                                        entryOffset + 8
                                    );

                                if (
                                    [
                                        'avc1',
                                        'avc2',
                                        'avc3',
                                        'avc4',
                                        'hvc1',
                                        'hev1',
                                        'av01'
                                    ].includes(
                                        entryType
                                    )
                                ) {
                                    const width =
                                        readUInt16(
                                            buffer,
                                            entryOffset + 24
                                        );

                                    const height =
                                        readUInt16(
                                            buffer,
                                            entryOffset + 26
                                        );

                                    if (
                                        width &&
                                        height
                                    ) {
                                        return {
                                            width,
                                            height,
                                            source:
                                                'stsd'
                                        };
                                    }
                                }

                                entryOffset +=
                                    entrySize;
                            }
                        }
                    }
                }
            }
        }
    }

    return null;
}

// ============================================================
// QUALITY
// ============================================================

function getQualityInfo(
    width,
    height
) {
    const pixels =
        width *
        height;

    if (
        pixels >=
        1920 * 1080
    ) {
        return {
            label:
                'FULL HD',
            display:
                'Full HD 1080p'
        };
    }

    if (
        pixels >=
        1280 * 720
    ) {
        return {
            label:
                'HD',
            display:
                'HD 720p'
        };
    }

    if (
        pixels >=
        854 * 480
    ) {
        return {
            label:
                'SD',
            display:
                'SD 480p'
        };
    }

    return {
        label:
            'LOW',
        display:
            `${width}x${height}`
    };
}

// ============================================================
// FIND VIDEO DURATION
// ============================================================

function findVideoDuration(buffer) {
    const moovBoxes =
        findChildBoxes(
            buffer,
            0,
            buffer.length,
            'moov'
        );

    for (const moov of moovBoxes) {
        const traks =
            findChildBoxes(
                buffer,
                moov.offset + 8,
                moov.end,
                'trak'
            );

        for (const trak of traks) {
            const mdiaBoxes =
                findChildBoxes(
                    buffer,
                    trak.offset + 8,
                    trak.end,
                    'mdia'
                );

            let isVideoTrack = false;

            for (const mdia of mdiaBoxes) {
                const hdlrBoxes =
                    findChildBoxes(
                        buffer,
                        mdia.offset + 8,
                        mdia.end,
                        'hdlr'
                    );

                for (const hdlr of hdlrBoxes) {
                    const handlerTypeOffset =
                        hdlr.offset + 16;

                    if (
                        handlerTypeOffset + 4 <=
                        buffer.length
                    ) {
                        const handlerType =
                            buffer.toString(
                                'ascii',
                                handlerTypeOffset,
                                handlerTypeOffset + 4
                            );

                        if (
                            handlerType === 'vide'
                        ) {
                            isVideoTrack = true;
                            break;
                        }
                    }
                }

                if (isVideoTrack) {
                    break;
                }
            }

            if (!isVideoTrack) {
                continue;
            }

            for (const mdia of mdiaBoxes) {
                const mdhdBoxes =
                    findChildBoxes(
                        buffer,
                        mdia.offset + 8,
                        mdia.end,
                        'mdhd'
                    );

                for (const mdhd of mdhdBoxes) {
                    const version =
                        buffer[
                            mdhd.offset + 8
                        ];

                    let timescale;
                    let duration;

                    if (version === 0) {
                        timescale =
                            readUInt32(
                                buffer,
                                mdhd.offset + 20
                            );

                        duration =
                            readUInt32(
                                buffer,
                                mdhd.offset + 24
                            );
                    } else {
                        timescale =
                            readUInt32(
                                buffer,
                                mdhd.offset + 28
                            );

                        if (
                            mdhd.offset + 40 >
                            mdhd.end
                        ) {
                            continue;
                        }

                        const high =
                            readUInt32(
                                buffer,
                                mdhd.offset + 32
                            );

                        const low =
                            readUInt32(
                                buffer,
                                mdhd.offset + 36
                            );

                        if (
                            high === null ||
                            low === null
                        ) {
                            continue;
                        }

                        if (high !== 0) {
                            continue;
                        }

                        duration =
                            low;
                    }

                    if (
                        timescale &&
                        duration !== null &&
                        duration >= 0
                    ) {
                        return formatDuration(
                            duration /
                            timescale
                        );
                    }
                }
            }
        }
    }

    return '00:00:00';
}

// ============================================================
// DOWNLOAD VIDEO
// ============================================================

async function downloadVideoToTemp(url) {
    const tempDir =
        await fs.mkdtemp(
            path.join(
                os.tmpdir(),
                'mrnobody-insta-'
            )
        );

    const filePath =
        path.join(
            tempDir,
            `${crypto.randomBytes(8).toString('hex')}.mp4`
        );

    let response;

    try {
        response =
            await fetch(
                url,
                {
                    headers: {
                        'User-Agent':
                            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
                        'Accept':
                            '*/*'
                    },
                    redirect:
                        'follow'
                }
            );
    } catch (error) {
        await fs.rm(
            tempDir,
            {
                recursive: true,
                force: true
            }
        );

        throw error;
    }

    if (
        !response.ok ||
        !response.body
    ) {
        await fs.rm(
            tempDir,
            {
                recursive: true,
                force: true
            }
        );

        throw new Error(
            `Instagram video download failed: HTTP ${response.status}`
        );
    }

    const fileHandle =
        await fs.open(
            filePath,
            'w'
        );

    let totalBytes = 0;

    try {
        const reader =
            response.body.getReader();

        while (true) {
            const {
                done,
                value
            } = await reader.read();

            if (done) {
                break;
            }

            if (!value) {
                continue;
            }

            totalBytes +=
                value.byteLength;

            await fileHandle.write(
                Buffer.from(value)
            );
        }

        await fileHandle.close();

        return {
            path: filePath,
            size: totalBytes,

            cleanup: async () => {
                try {
                    await fs.rm(
                        tempDir,
                        {
                            recursive: true,
                            force: true
                        }
                    );
                } catch {}
            }
        };
    } catch (error) {
        try {
            await fileHandle.close();
        } catch {}

        try {
            await fs.rm(
                tempDir,
                {
                    recursive: true,
                    force: true
                }
            );
        } catch {}

        throw error;
    }
}

// ============================================================
// GET INSTAGRAM VIDEOS
// ============================================================

async function getInstagramVideos(url) {
    console.log(
        '[INSTA] Resolving:',
        url
    );

    const result =
        await downloadInstagram(
            url
        );

    if (!result) {
        throw new Error(
            'Instagram provider returned no response.'
        );
    }

    if (
        !Array.isArray(
            result.medias
        ) ||
        result.medias.length === 0
    ) {
        throw new Error(
            'No Instagram media was returned.'
        );
    }

    console.log(
        '[INSTA] Media count:',
        result.medias.length
    );

    result.medias.forEach(
        (media, index) => {
            console.log(
                `[INSTA] Media ${index + 1}:`,
                media?.type,
                media?.url
                    ? 'URL available'
                    : 'No URL'
            );
        }
    );

    const videos =
        result.medias
            .filter(media => {
                return (
                    String(
                        media?.type || ''
                    ).toLowerCase() ===
                    'video'
                );
            })
            .map(
                (media, index) => ({
                    index:
                        index + 1,
                    url:
                        media.url
                })
            )
            .filter(media => {
                return (
                    typeof media.url ===
                        'string' &&
                    media.url.length > 0
                );
            });

    return videos;
}

// ============================================================
// DOWNLOAD + INSPECT
// ============================================================

async function downloadAndInspectVideo(
    url
) {
    console.log(
        '[INSTA] Downloading highest available video...'
    );

    const media =
        await downloadVideoToTemp(
            url
        );

    if (
        !media ||
        !media.path
    ) {
        throw new Error(
            'Video download failed.'
        );
    }

    const fileBuffer =
        await fs.readFile(
            media.path
        );

    const resolution =
        findVideoResolution(
            fileBuffer
        );

    const qualityInfo =
        resolution
            ? getQualityInfo(
                  resolution.width,
                  resolution.height
              )
            : {
                  label: 'Unknown',
                  display:
                      'Highest Available Quality'
              };

    const size =
        fileBuffer.length;

    const duration =
        findVideoDuration(
            fileBuffer
        );

    const isOverLimit =
        size >
        MAX_FILE_SIZE;

    console.log(
        `[INSTA] Bytes: ${size}`
    );

    console.log(
        `[INSTA] Size: ${(size / 1000000).toFixed(2)} MB`
    );

    console.log(
        `[INSTA] Resolution: ${
            resolution
                ? `${resolution.width}x${resolution.height}`
                : 'Unknown'
        }`
    );

    console.log(
        `[INSTA] Quality: ${
            qualityInfo.display
        }`
    );

    console.log(
        `[INSTA] Resolution source: ${
            resolution?.source ||
            'none'
        }`
    );

    console.log(
        `[INSTA] Duration: ${
            duration
        }`
    );

    console.log(
        `[INSTA] Delivery: ${
            isOverLimit
                ? 'DOCUMENT'
                : 'VIDEO'
        }`
    );

    return {
        ...media,

        size,

        resolution,

        duration,

        quality:
            qualityInfo.label,

        qualityDisplay:
            qualityInfo.display,

        isOverLimit
    };
}

// ============================================================
// SEND VIDEO / DOCUMENT
// ============================================================

async function sendInstagramVideo(
    sock,
    from,
    msg,
    video,
    index,
    total,
    watermark
) {
    let tempMedia = null;

    try {
        tempMedia =
            await downloadAndInspectVideo(
                video.url
            );

        const fileName =
            `${cleanFileName(
                `Instagram Video ${index}`
            )}.mp4`;

        const sizeMB =
            tempMedia.size /
            1000000;

        let caption =
            `🎬 *MRNOBODY INSTAGRAM VIDEO*\n\n`;

        if (total > 1) {
            caption +=
                `🎥 *Video ${index}/${total}*\n\n`;
        }

        caption +=
            `📥 *Downloaded In Available Highest Quality*\n`;

        if (
            tempMedia.resolution
        ) {
            caption +=
                `💎 *Quality: ${tempMedia.qualityDisplay}*\n`;

            caption +=
                `📐 *Resolution: ${tempMedia.resolution.width}x${tempMedia.resolution.height}*\n`;
        } else {
            caption +=
                `💎 *Quality: Highest Available Quality*\n`;
        }

        // ====================================================
        // DURATION
        // ====================================================

        caption +=
            `⏱️ *Duration: ${tempMedia.duration}*\n`;

        caption +=
            `💾 *Size: ${sizeMB.toFixed(2)} MB*\n`;

        if (
            tempMedia.isOverLimit
        ) {
            caption +=
                `📦 *Size > 80MB → Sent as Document*\n`;
        } else {
            caption +=
                `🎬 *Sent as Video*\n`;
        }

        caption +=
            `\n─── *${watermark}* ───`;

        // ====================================================
        // >80MB -> DOCUMENT
        // ====================================================

        if (
            tempMedia.isOverLimit
        ) {
            await sock.sendMessage(
                from,
                {
                    document: {
                        url:
                            tempMedia.path
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
                `[INSTA] ${index}: >80MB -> Document`
            );

            return true;
        }

        // ====================================================
        // <=80MB -> VIDEO
        // ====================================================

        try {
            await sock.sendMessage(
                from,
                {
                    video: {
                        url:
                            tempMedia.path
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
                `[INSTA] ${index}: <=80MB -> Video`
            );

            return true;
        } catch (videoError) {
            console.error(
                '[INSTA] Video send failed:',
                videoError.message
            );
        }

        // ====================================================
        // FALLBACK -> DOCUMENT
        // ====================================================

        await sock.sendMessage(
            from,
            {
                document: {
                    url:
                        tempMedia.path
                },

                mimetype:
                    'video/mp4',

                fileName,

                caption:
                    caption +
                    `\n📄 *Sent as Document fallback.*`
            },
            {
                quoted: msg
            }
        );

        console.log(
            `[INSTA] Video failed -> Document fallback`
        );

        return true;

    } finally {
        if (
            tempMedia?.cleanup
        ) {
            try {
                await tempMedia.cleanup();
            } catch (error) {
                console.error(
                    '[INSTA] Cleanup failed:',
                    error.message
                );
            }
        }
    }
}

// ============================================================
// COMMAND
// ============================================================

export default {    pattern: 'insta',

    category: 'download',

    desc:
        'Download Instagram Videos and Reels',

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
                            `⚠️ *Instagram Video/Reel link එකක් ලබාදෙන්න!*\n\n` +
                            `උදා:\n` +
                            `*.insta https://www.instagram.com/reel/XXXXXXXX/*\n\n` +
                            `🎬 *Reel / Video links පමණක් support කරයි.*\n` +
                            `📸 *Photo / Post links support නොකරයි.*`
                    },
                    {
                        quoted: msg
                    }
                );
            }

            const instagramUrl =
                normalizeInstagramUrl(
                    input
                );

            if (!instagramUrl) {
                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ *Instagram URL එකක් හමු වුණේ නැහැ.*`
                    },
                    {
                        quoted: msg
                    }
                );
            }

            let valid = false;

            try {
                valid =
                    isValidInstagramURL(
                        instagramUrl
                    );
            } catch (error) {
                console.error(
                    '[INSTA] URL validation error:',
                    error.message
                );
            }

            if (!valid) {
                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ *Invalid Instagram URL!*\n\n` +
                            `Instagram Reel / Video link එකක් ලබාදෙන්න.`
                    },
                    {
                        quoted: msg
                    }
                );
            }

            if (
                !isVideoInstagramUrl(
                    instagramUrl
                )
            ) {
                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `📸 *මේ link එක Video/Reel link එකක් නෙමෙයි.*\n\n` +
                            `❌ *Photo / Post links download කරන්නේ නැහැ.*\n\n` +
                            `🎬 කරුණාකර Instagram *Reel / Video* link එකක් දෙන්න.`
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
                        `🔎 *Instagram Video එක සොයමින්...*\n\n` +
                        `⏳ _Highest available quality එක ලබාගනිමින්..._`
                },
                {
                    quoted: msg
                }
            );

            let videos;

            try {
                videos =
                    await getInstagramVideos(
                        instagramUrl
                    );
            } catch (error) {
                console.error(
                    '[INSTA] Resolve failed:',
                    error
                );

                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ *Instagram Video එක ලබාගැනීමට නොහැකි විය.*\n\n` +
                            `මෙය private Reel එකක්, deleted Reel එකක්, හෝ Instagram access block කර ඇති link එකක් විය හැකිය.\n\n` +
                            `Public Instagram Reel/Video link එකක් උත්සාහ කරන්න.`
                    },
                    {
                        quoted: msg
                    }
                );
            }

            if (!videos.length) {
                return await sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ *මේ link එකෙන් Video එකක් හමු වුණේ නැහැ.*\n\n` +
                            `🎬 කරුණාකර Instagram Reel / Video link එකක් ලබාදෙන්න.`
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
                        `🎬 *MRNOBODY INSTAGRAM VIDEO DOWNLOADER* 🎬\n\n` +
                        `🎥 *Videos found:* ${videos.length}\n\n` +
                        `⬇️ *Downloading in highest available quality...*\n\n` +
                        `💎 *HD / Full HD quality preserved*\n` +
                        `📦 *>80MB → Document*\n\n` +
                        `─── *${watermark}* ───`
                },
                {
                    quoted: msg
                }
            );

            let successful = 0;

            for (
                let i = 0;
                i < videos.length;
                i++
            ) {
                try {
                    const sent =
                        await sendInstagramVideo(
                            sock,
                            from,
                            msg,
                            videos[i],
                            i + 1,
                            videos.length,
                            watermark
                        );

                    if (sent) {
                        successful++;
                    }
                } catch (error) {
                    console.error(
                        `[INSTA] Video ${i + 1} failed:`,
                        error
                    );

                    await sock.sendMessage(
                        from,
                        {
                            text:
                                `⚠️ *Video ${i + 1}/${videos.length} යැවීමට නොහැකි විය.*\n\n` +
                                `${error.message}`
                        },
                        {
                            quoted: msg
                        }
                    );
                }

                if (
                    i <
                    videos.length - 1
                ) {
                    await new Promise(
                        resolve =>
                            setTimeout(
                                resolve,
                                700
                            )
                    );
                }
            }

            console.log(
                `[INSTA] Completed: ${successful}/${videos.length}`
            );

        } catch (error) {
            console.error(
                '[INSTA] Fatal error:',
                error
            );

            try {
                await sock.sendMessage(
                    from,
                    {
                        text:
                            `❌ *Instagram command error!*\n\n` +
                            `${error.message}`
                    },
                    {
                        quoted: msg
                    }
                );
            } catch (sendError) {
                console.error(
                    '[INSTA] Error message failed:',
                    sendError.message
                );
            }
        }
    }
}
