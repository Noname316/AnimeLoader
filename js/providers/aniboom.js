/**
 * Плеер AniBoom (aniboom.one), встроен на AnimeGO.
 *
 * Страница плеера //aniboom.one/embed/{animeId}?episode=N&translation=T открывается
 * только с Referer сайта и содержит JSON в атрибуте data-parameters: в полях
 * hls и dash — ссылки на поток (сами тоже JSON-строки {"src": …}).
 * HLS — fMP4, звук отдельной дорожкой (сводится в один файл, см. fmp4-merge.js).
 */

import { setRequestHeaders } from '../net-rules.js';

const PLAYER_ORIGIN = 'https://aniboom.one';

function decodeEntities(s) {
    return s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Поле вида '{"src":"https://…","type":"…"}' или 'null' → адрес. */
function sourceUrl(value) {
    if (!value) return null;
    try {
        const v = typeof value === 'string' ? JSON.parse(value) : value;
        return v?.src || null;
    } catch {
        return null;
    }
}

/**
 * @param {string} html - Страница плеера.
 * @returns {{hls: ?string, dash: ?string, fallbackHls: ?string, quality: number, duration: number}}
 */
export function parseAniboomPage(html) {
    const m = /data-parameters="([^"]+)"/.exec(html);
    if (!m) throw new Error('AniBoom: на странице плеера нет data-parameters (видео удалено или ссылка устарела)');
    const p = JSON.parse(decodeEntities(m[1]));
    return {
        hls: sourceUrl(p.hls),
        dash: sourceUrl(p.dash),
        fallbackHls: sourceUrl(p.fallbackHls),
        quality: Number(p.qualityVideo) || 1080,
        duration: Number(p.duration) || 0
    };
}

/**
 * @param {string} iframeUrl
 * @param {{siteOrigin: string, signal: AbortSignal, log: Function}} ctx
 * @returns {Promise<import('../hls-download.js').Source>}
 */
export async function resolveAniboom(iframeUrl, { siteOrigin, signal }) {
    const url = new URL(iframeUrl, siteOrigin).href;
    await setRequestHeaders(new URL(url).hostname, { Referer: `${siteOrigin}/` });
    const res = await fetch(url, { signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`AniBoom: страница плеера: HTTP ${res.status}`);
    const p = parseAniboomPage(await res.text());
    const urls = [p.hls, p.fallbackHls].filter(Boolean);
    if (!urls.length) throw new Error(p.dash ? 'AniBoom: есть только DASH-поток, он пока не поддерживается' : 'AniBoom: нет ссылки на поток');
    return {
        variants: [{ quality: p.quality, urls, kind: 'hls' }],
        headers: { Origin: PLAYER_ORIGIN, Referer: `${PLAYER_ORIGIN}/` }
    };
}
