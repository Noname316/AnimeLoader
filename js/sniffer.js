/**
 * Распознавание видео в сетевых запросах страницы (используется фоном расширения).
 *
 * Плеер любого сайта рано или поздно запрашивает либо HLS-плейлист (.m3u8),
 * либо DASH-манифест (.mpd), либо файл целиком (.mp4/.webm…). Сегменты потоков
 * (.ts/.m4s) и мелкие файлы (init-сегменты, превью, реклама-заглушки) отбрасываются.
 */

/** Файлы меньше этого размера (если он известен) видео не считаются. */
export const MIN_FILE_SIZE = 1024 * 1024;

const SEGMENT_EXT = /\.(ts|m4s|m4a|aac|mp3|cmfv|cmfa|vtt|webvtt|key)$/;
const FILE_EXT = /\.(mp4|m4v|webm|mkv|mov|flv|ogv)$/;
/** Сегменты потоков, названные как обычные файлы: seg-12.mp4, chunk_3.mp4, fragment5.webm… */
const SEGMENT_NAME = /(^|\/)[^/]*(seg|segment|chunk|frag|fragment)[-_]?\d+[^/]*$/;

/**
 * @param {string} url
 * @param {string} [contentType]
 * @returns {?'hls'|'dash'|'file'}
 */
export function classifyMedia(url, contentType = '') {
    let path;
    try {
        path = decodeURIComponent(new URL(url).pathname).toLowerCase();
    } catch {
        return null;
    }
    const ct = contentType.toLowerCase().split(';')[0].trim();

    if (/mpegurl/.test(ct) || path.endsWith('.m3u8')) return 'hls';
    if (ct === 'application/dash+xml' || path.endsWith('.mpd')) return 'dash';
    if (ct === 'video/mp2t' || ct === 'video/iso.segment' || SEGMENT_EXT.test(path)) return null;
    // init-сегменты fMP4 приходят как video/mp4, но по имени их видно.
    if (/(^|\/)init[-_.][^/]*$/.test(path) || SEGMENT_NAME.test(path)) return null;
    if (/^video\//.test(ct) || FILE_EXT.test(path)) return 'file';
    return null;
}

/**
 * Полный размер файла по заголовкам ответа (для ответов 206 — из Content-Range).
 * @param {Array<{name: string, value?: string}>} headers
 * @returns {?number}
 */
export function responseSize(headers = []) {
    const get = name => headers.find(h => h.name.toLowerCase() === name)?.value;
    const range = /\/(\d+)\s*$/.exec(get('content-range') || '');
    if (range) return Number(range[1]);
    const len = Number(get('content-length'));
    return Number.isFinite(len) && len > 0 ? len : null;
}

/** @param {Array<{name: string, value?: string}>} headers @param {string} name */
export function headerValue(headers = [], name) {
    return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}
