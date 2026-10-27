/**
 * Разбор HLS-плейлистов (библиотека m3u8-parser из lib/).
 */

/**
 * @typedef {object} Segment
 * @property {number} index - Порядковый номер (0…).
 * @property {string} url
 * @property {number} duration - Секунды.
 * @property {?{offset: number, length: number}} byterange
 * @property {?{method: string, url: string, iv: ?Uint8Array}} key
 * @property {number} sequence - Media sequence number (для IV по умолчанию).
 */

/**
 * @typedef {object} MediaPlaylist
 * @property {string} url - Адрес медиаплейлиста.
 * @property {Segment[]} segments
 * @property {?{url: string, byterange: ?{offset: number, length: number}}} init - EXT-X-MAP (fMP4).
 * @property {'ts'|'fmp4'} container
 * @property {number} duration - Секунды.
 * @property {?string} resolution - «1920x1080», если известно.
 * @property {?MediaPlaylist} [audio] - Отдельная аудиодорожка (EXT-X-MEDIA TYPE=AUDIO с URI).
 */

function parse(text) {
    const lib = globalThis.m3u8Parser;
    if (!lib?.Parser) throw new Error('Библиотека m3u8-parser не загружена');
    if (!/^\s*#EXTM3U/.test(text)) throw new Error('ответ не является HLS-плейлистом');
    const parser = new lib.Parser();
    parser.push(text);
    parser.end();
    return parser.manifest;
}

function toByterange(br) {
    return br && Number.isFinite(br.length) ? { offset: br.offset || 0, length: br.length } : null;
}

function ivToBytes(iv) {
    if (!iv) return null;
    const out = new Uint8Array(16);
    const view = new DataView(out.buffer);
    for (let i = 0; i < 4; i++) view.setUint32(i * 4, iv[i] >>> 0);
    return out;
}

/**
 * Выбирает вариант из мастер-плейлиста: самый высокий, не выше maxHeight.
 * @param {Array<object>} playlists - manifest.playlists.
 * @param {number} [maxHeight=Infinity]
 * @returns {object}
 */
export function pickVariant(playlists, maxHeight = Infinity) {
    const height = p => p.attributes?.RESOLUTION?.height || 0;
    const bw = p => p.attributes?.BANDWIDTH || 0;
    const sorted = [...playlists].sort((a, b) => height(b) - height(a) || bw(b) - bw(a));
    return sorted.find(p => !height(p) || height(p) <= maxHeight) || sorted[sorted.length - 1];
}

/**
 * Загружает медиаплейлист (если по адресу мастер-плейлист — переходит к варианту).
 * Если у варианта звук идёт отдельным плейлистом, он загружается в поле audio.
 * @param {string} url
 * @param {(url: string) => Promise<string>} fetchText
 * @param {{maxHeight?: number}} [opts]
 * @returns {Promise<MediaPlaylist>}
 */
export async function loadMediaPlaylist(url, fetchText, { maxHeight = Infinity } = {}) {
    let manifest = parse(await fetchText(url));
    let resolution = null;
    let audioUrl = null;

    for (let depth = 0; manifest.playlists?.length; depth++) {
        if (depth > 3) throw new Error('слишком глубокая вложенность плейлистов');
        const variant = pickVariant(manifest.playlists, maxHeight);
        const r = variant.attributes?.RESOLUTION;
        if (r) resolution = `${r.width}x${r.height}`;
        const audio = pickAudio(manifest, variant);
        if (audio) audioUrl = new URL(audio, url).href;
        url = new URL(variant.uri, url).href;
        manifest = parse(await fetchText(url));
    }

    const video = toMediaPlaylist(manifest, url, resolution);
    if (!audioUrl) return video;
    const audioManifest = parse(await fetchText(audioUrl));
    if (audioManifest.playlists?.length) throw new Error('аудиодорожка оказалась мастер-плейлистом');
    const audio = toMediaPlaylist(audioManifest, audioUrl, null);
    if (video.container !== 'fmp4' || audio.container !== 'fmp4' || !video.init || !audio.init)
        throw new Error('отдельная аудиодорожка поддерживается только для потоков fMP4');
    return { ...video, audio };
}

/**
 * Адрес отдельной аудиодорожки варианта: из группы AUDIO — по умолчанию, иначе первая.
 * @returns {?string}
 */
function pickAudio(manifest, variant) {
    const groupId = variant.attributes?.AUDIO;
    const group = groupId && manifest.mediaGroups?.AUDIO?.[groupId];
    if (!group) return null;
    const tracks = Object.values(group).filter(t => t.uri);
    const track = tracks.find(t => t.default) || tracks.find(t => t.autoselect) || tracks[0];
    return track?.uri || null;
}

function toMediaPlaylist(manifest, url, resolution) {
    const segs = manifest.segments || [];
    if (!segs.length) throw new Error('в плейлисте нет сегментов');
    if (!manifest.endList && manifest.playlistType !== 'VOD') throw new Error('это трансляция (плейлист без EXT-X-ENDLIST), а не запись');

    const firstSeq = manifest.mediaSequence || 0;
    let init = null;
    const segments = segs.map((s, index) => {
        if (s.map && !init) init = { url: new URL(s.map.uri, url).href, byterange: toByterange(s.map.byterange) };
        const method = s.key?.method;
        if (method && method !== 'NONE' && method !== 'AES-128')
            throw new Error(`шифрование ${method} не поддерживается`);
        return {
            index,
            url: new URL(s.uri, url).href,
            duration: s.duration || 0,
            byterange: toByterange(s.byterange),
            key: method === 'AES-128' ? { method, url: new URL(s.key.uri, url).href, iv: ivToBytes(s.key.iv) } : null,
            sequence: firstSeq + index
        };
    });

    const looksFmp4 = init || segments.some(s => /\.(m4s|mp4|m4v|cmfv)(\?|$)/i.test(s.url));
    return {
        url,
        segments,
        init,
        container: looksFmp4 ? 'fmp4' : 'ts',
        duration: segments.reduce((sum, s) => sum + s.duration, 0),
        resolution
    };
}

/**
 * Общий порядок загрузки сегментов видео и звука: по времени начала, при равенстве — видео первым.
 * @param {Segment[]} video
 * @param {Segment[]} audio
 * @returns {Array<Segment & {track: 'video'|'audio'}>} Сегменты с новыми index 0…
 */
export function interleaveTracks(video, audio) {
    const timed = (segs, track) => {
        let t = 0;
        return segs.map(s => {
            const item = { ...s, track, start: t };
            t += s.duration;
            return item;
        });
    };
    const v = timed(video, 'video');
    const a = timed(audio, 'audio');
    const out = [];
    let i = 0;
    let j = 0;
    while (i < v.length || j < a.length) {
        const takeVideo = j >= a.length || (i < v.length && v[i].start <= a[j].start);
        out.push(takeVideo ? v[i++] : a[j++]);
    }
    return out.map((s, index) => ({ ...s, index }));
}

/** Размер куска при загрузке обычного файла (MP4) по частям. */
export const FILE_CHUNK = 8 * 1024 * 1024;

/**
 * Обычный файл как «плейлист» из кусков по Range: так его качает тот же загрузчик,
 * что и HLS (параллельно, с повторами и обновлением ссылки).
 * @param {string} url
 * @param {(url: string, init: RequestInit) => Promise<Response>} fetchFn
 * @param {number} [chunk]
 * @returns {Promise<MediaPlaylist>}
 */
export async function loadFileAsSegments(url, fetchFn, chunk = FILE_CHUNK) {
    const res = await fetchFn(url, { headers: { Range: 'bytes=0-0' } });
    if (!res.ok) {
        const err = new Error(`файл: HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')?.[1]) || 0;
    await res.body?.cancel().catch(() => {});
    if (res.status !== 206 || !total) {
        // Сервер не умеет Range — один «сегмент» на весь файл.
        return { url, segments: [{ index: 0, url, duration: 0, byterange: null, key: null, sequence: 0 }], init: null, container: 'mp4', duration: 0, resolution: null, size: Number(res.headers.get('content-length')) || 0 };
    }
    const segments = [];
    for (let offset = 0, index = 0; offset < total; offset += chunk, index++) {
        segments.push({ index, url, duration: 0, byterange: { offset, length: Math.min(chunk, total - offset) }, key: null, sequence: index });
    }
    return { url, segments, init: null, container: 'mp4', duration: 0, resolution: null, size: total };
}
