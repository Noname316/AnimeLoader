/**
 * Плеер CVH (cdnvideohub.com): видео лежит на CDN ok.ru/VK обычными файлами MP4.
 *
 * Сайты встраивают веб-компонент <video-player> с атрибутами
 * data-title-id (id тайтла у «агрегатора», обычно MyAnimeList), data-aggregator,
 * data-publisher-id (id сайта у CVH), эпизодом и озвучкой. Сам компонент берёт:
 *   GET plapi.cdnvideohub.com/api/v1/player/sv/playlist?pub=…&id=…&aggr=… — все серии и озвучки
 *   GET plapi.cdnvideohub.com/api/v1/player/sv/video/{vkId}             — ссылки на файлы (до 4K)
 * Ссылки привязаны к IP, поэтому получать их надо из браузера пользователя.
 * CDN проверяет Origin: c Origin расширения отвечает 400, с Origin плеера — нормально.
 */

import { setRequestHeaders } from '../net-rules.js';

const API = 'https://plapi.cdnvideohub.com/api/v1';
const PLAYER_ORIGIN = 'https://player.cdnvideohub.com';
const CDN_HEADERS = { Origin: PLAYER_ORIGIN, Referer: `${PLAYER_ORIGIN}/` };

/** Ключи ссылок в ответе video/{vkId} → высота кадра. */
const QUALITY_KEYS = [
    ['mpeg4kUrl', 2160], ['mpeg2kUrl', 1440], ['mpegQhdUrl', 1440], ['mpegFullHdUrl', 1080],
    ['mpegHighUrl', 720], ['mpegMediumUrl', 480], ['mpegLowUrl', 360], ['mpegLowestUrl', 240], ['mpegTinyUrl', 144]
];

/** Известные сайты: publisher-id из их собственного кода встраивания. */
const KNOWN_PUBLISHERS = [
    { host: /(^|\.)yummy-?ani(me)?\.[a-z]+$|(^|\.)yani\.tv$/i, publisher: 745, aggregator: 'mali' },
    { host: /(^|\.)animego\.[a-z]+$/i, publisher: 747, aggregator: 'mali' }
];

/**
 * @typedef {object} CvhTarget
 * @property {string} titleId
 * @property {?number} publisher
 * @property {?string} aggregator
 * @property {?number} season
 * @property {string} episode
 * @property {string} voice - Название студии озвучки как у CVH («AnilibriaTV», «SHIZA Project»…).
 */

/**
 * Разбирает адрес iframe с плеером CVH.
 *   YummyAnime: //ru.yummyani.me/iframeCVH.html?dubbing_code=AnilibriaTV&anime_id=55644&episode=1
 *   AnimeGO:    //animego.me/cdn-iframe/64534/2/1?dubbing=AniLiberty
 *   фильм:      //animego.me/cdn-iframe/35851?dubbing=Reanimedia — без сезона и серии
 * @param {string} iframeUrl
 * @returns {CvhTarget}
 */
export function parseCvhIframe(iframeUrl) {
    const u = new URL(iframeUrl, 'https://localhost');
    const known = KNOWN_PUBLISHERS.find(k => k.host.test(u.hostname));
    const q = u.searchParams;
    const path = /\/cdn-iframe\/([^/?#]+)(?:\/(\d+)\/([^/?#]+))?/.exec(u.pathname);
    const target = path
        ? { titleId: path[1], season: path[2] ? Number(path[2]) : null, episode: path[3] ? decodeURIComponent(path[3]) : '', voice: q.get('dubbing') || '' }
        : { titleId: q.get('anime_id') || q.get('id') || '', season: Number(q.get('season')) || null, episode: q.get('episode') || '', voice: q.get('dubbing_code') || q.get('dubbing') || '' };
    if (!target.titleId) throw new Error(`CVH: не удалось разобрать адрес плеера ${iframeUrl}`);
    // У фильма серия не указана, а в плейлисте CVH у видео нет поля episode — это «серия 1».
    target.episode ||= '1';
    return { ...target, publisher: known?.publisher ?? null, aggregator: known?.aggregator ?? null };
}

/** Параметры компонента со страницы iframe (если сайт неизвестен или они поменялись). */
export function parseCvhPage(html) {
    const attr = name => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1] || null;
    const publisher = Number(attr('data-publisher-id'));
    return {
        titleId: attr('data-title-id'),
        publisher: Number.isFinite(publisher) && publisher > 0 ? publisher : null,
        aggregator: attr('data-aggregator')
    };
}

const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');

/**
 * Находит видео нужной серии и озвучки в плейлисте CVH.
 * @param {Array<{vkId: string, voiceStudio?: string, voiceType?: string, season?: number, episode?: number}>} items
 * @param {{episode: string, season?: ?number, voice: string}} want
 */
export function findCvhVideo(items, { episode, season, voice }) {
    const ep = String(episode);
    let list = items.filter(i => i.vkId && String(i.episode ?? '1') === ep);
    if (season != null) {
        const inSeason = list.filter(i => i.season == null || Number(i.season) === season);
        if (inSeason.length) list = inSeason;
    }
    const v = norm(voice);
    const name = i => norm(i.voiceStudio || i.voiceType);
    return list.find(i => name(i) === v)
        || list.find(i => v && (name(i).includes(v) || v.includes(name(i))))
        // «Субтитры» без студии.
        || (/субтитр/.test(v) ? list.find(i => !i.voiceStudio && /субтитр/i.test(i.voiceType || '')) : null)
        || null;
}

/** @param {object} sources - Поле sources ответа video/{vkId}. */
export function parseCvhSources(sources) {
    const seen = new Set();
    const variants = [];
    for (const [key, quality] of QUALITY_KEYS) {
        const url = sources?.[key];
        if (!url || seen.has(quality)) continue;
        seen.add(quality);
        variants.push({ quality, urls: [url], kind: 'file' });
    }
    return variants;
}

/** @type {Map<string, Promise<object>>} плейлисты тайтлов (одинаковы для всех серий) */
const playlists = new Map();
/** @type {Map<string, Promise<object>>} параметры со страниц iframe */
const pages = new Map();

async function getJson(url, signal) {
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' }, credentials: 'omit' });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`CVH: ${new URL(url).pathname}: HTTP ${res.status}`);
    return res.json();
}

/**
 * @param {string} iframeUrl
 * @param {{siteOrigin: string, signal: AbortSignal, log: Function}} ctx
 * @returns {Promise<import('../hls-download.js').Source>}
 */
export async function resolveCvh(iframeUrl, { siteOrigin, signal, log }) {
    const target = parseCvhIframe(new URL(iframeUrl, siteOrigin).href);
    if (!target.publisher || !target.aggregator) {
        const pageUrl = new URL(iframeUrl, siteOrigin).href;
        const key = pageUrl.replace(/[?#].*$/, '').replace(/\/[^/]+\/[^/]+$/, '');
        if (!pages.has(key)) {
            pages.set(key, (async () => {
                await setRequestHeaders(new URL(pageUrl).hostname, { Referer: `${siteOrigin}/` });
                const res = await fetch(pageUrl, { signal });
                if (!res.ok) throw new Error(`CVH: страница плеера: HTTP ${res.status}`);
                return parseCvhPage(await res.text());
            })().catch(e => { pages.delete(key); throw e; }));
        }
        const page = await pages.get(key);
        target.publisher ??= page.publisher;
        target.aggregator ??= page.aggregator;
        if (page.titleId) target.titleId = page.titleId;
        if (!target.publisher) throw new Error('CVH: на странице плеера нет data-publisher-id');
    }

    const plKey = `${target.publisher}|${target.aggregator}|${target.titleId}`;
    if (!playlists.has(plKey)) {
        const q = new URLSearchParams({ pub: String(target.publisher), id: target.titleId, aggr: target.aggregator || 'mali' });
        playlists.set(plKey, getJson(`${API}/player/sv/playlist?${q}`, signal).catch(e => { playlists.delete(plKey); throw e; }));
    }
    const playlist = await playlists.get(plKey);
    if (!playlist?.items?.length) throw new Error('CVH: у плеера нет серий этого тайтла');

    const item = findCvhVideo(playlist.items, target);
    if (!item) {
        const voices = [...new Set(playlist.items.map(i => i.voiceStudio || i.voiceType).filter(Boolean))].join(', ');
        throw new Error(`CVH: нет серии ${target.episode} в озвучке «${target.voice}» (есть: ${voices})`);
    }
    const where = item.episode != null ? `, сезон ${item.season ?? '—'}, серия ${item.episode}` : '';
    log?.(`CVH: видео ${item.vkId} (${item.voiceStudio || item.voiceType}${where})`);

    const video = await getJson(`${API}/player/sv/video/${item.vkId}`, signal);
    const variants = parseCvhSources(video?.sources);
    if (!variants.length) {
        // Бывает только HLS (обычно у свежих серий, пока файлы не готовы).
        if (video?.sources?.hlsUrl) return { variants: [{ quality: 1080, urls: [video.sources.hlsUrl], kind: 'hls' }], headers: CDN_HEADERS };
        throw new Error('CVH: у видео нет ссылок на файлы (возможно, оно недоступно в вашем регионе)');
    }
    return { variants, headers: CDN_HEADERS };
}
