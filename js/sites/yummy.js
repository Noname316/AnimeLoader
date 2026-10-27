/**
 * Данные тайтла с YummyAnime: метаданные и список видео по плеерам и озвучкам.
 *
 * Сайт отдаёт всё через собственный JSON API:
 *   GET {origin}/api/anime/{slug}        — карточка тайтла (anime_id, название, постер…)
 *   GET {origin}/api/anime/{id}/videos   — все серии во всех плеерах и озвучках
 * Тот же API доступен на api.yani.tv — он используется, если основной адрес не ответил.
 */

import { absUrl } from '../util.js';

const API_FALLBACK = 'https://api.yani.tv';

/** Плееры, которые расширение умеет скачивать (порядок — порядок в списке). */
export const PLAYERS = {
    kodik: { id: 'kodik', name: 'Kodik', match: /kodik/i },
    alloha: { id: 'alloha', name: 'Alloha', match: /alloha/i },
    cvh: { id: 'cvh', name: 'CVH', match: /cvh/i }
};

/**
 * Разбирает адрес страницы тайтла.
 * @param {string} url
 * @returns {?{origin: string, slug: string}}
 */
export function parseAnimeUrl(url) {
    try {
        const u = new URL(url);
        if (!/(^|\.)yummy-?ani(me)?\.[a-z]+$/i.test(u.hostname) && !/(^|\.)yani\.tv$/i.test(u.hostname)) return null;
        const m = /\/catalog\/item\/([^/?#]+)/.exec(u.pathname);
        return m ? { origin: u.origin, slug: decodeURIComponent(m[1]) } : null;
    } catch {
        return null;
    }
}

/**
 * GET-запрос к API с запасным адресом.
 * @param {string} origin - Сайт, на котором открыт тайтл.
 * @param {string} path - Путь без префикса /api.
 * @returns {Promise<any>} Поле response ответа.
 */
async function apiGet(origin, path) {
    const urls = [`${origin}/api${path}`, `${API_FALLBACK}${path}`];
    let lastError;
    for (const url of urls) {
        try {
            const res = await fetch(url, { headers: { Accept: 'application/json' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (json?.response === undefined) throw new Error('неожиданный ответ API');
            return json.response;
        } catch (e) {
            lastError = new Error(`${url}: ${e.message}`);
        }
    }
    throw lastError;
}

/**
 * Карточка тайтла.
 * @param {string} origin
 * @param {string} slug
 * @returns {Promise<{id: number, title: string, description: string, poster: ?string, year: ?number,
 *   typeName: string, isSeries: boolean, episodesTotal: ?number}>}
 */
export async function fetchAnime(origin, slug) {
    const a = await apiGet(origin, `/anime/${encodeURIComponent(slug)}`);
    const poster = a.poster?.big || a.poster?.medium || a.poster?.fullsize || null;
    return {
        id: a.anime_id,
        title: a.title || slug,
        description: a.description || '',
        poster: poster ? absUrl(poster) : null,
        year: a.year ?? null,
        typeName: a.type?.name || '',
        // Фильм/спешл — одна серия; сериал — диапазон. Окончательно решает число серий в списке видео.
        isSeries: (a.type?.alias || '') !== 'movie',
        episodesTotal: a.episodes?.count || null
    };
}

/**
 * Список видео тайтла, сгруппированный по плееру и озвучке.
 * @param {string} origin
 * @param {number} animeId
 * @returns {Promise<Array<{id: string, name: string, dubs: Array<{name: string, episodes: Array<Episode>}>}>>}
 *
 * @typedef {{number: string, iframeUrl: string, videoId: number, duration: number}} Episode
 */
export async function fetchPlayers(origin, animeId) {
    const list = await apiGet(origin, `/anime/${animeId}/videos`);
    return groupVideos(Array.isArray(list) ? list : []);
}

/**
 * Группирует сырой список видео (выделено для тестов).
 * @param {Array<object>} list
 * @returns {ReturnType<typeof fetchPlayers> extends Promise<infer T> ? T : never}
 */
export function groupVideos(list) {
    /** @type {Map<string, Map<string, Map<string, Episode>>>} */
    const byPlayer = new Map();

    for (const v of list) {
        const playerName = v?.data?.player || '';
        const player = Object.values(PLAYERS).find(p => p.match.test(playerName));
        if (!player || !v.iframe_url) continue;

        const dub = cleanDubName(v.data?.dubbing);
        if (!byPlayer.has(player.id)) byPlayer.set(player.id, new Map());
        const dubs = byPlayer.get(player.id);
        if (!dubs.has(dub)) dubs.set(dub, new Map());
        // Одна и та же серия иногда встречается дважды — оставляем первую.
        const episodes = dubs.get(dub);
        const number = String(v.number ?? '').trim() || '1';
        if (!episodes.has(number)) {
            episodes.set(number, {
                number,
                iframeUrl: absUrl(v.iframe_url),
                videoId: v.video_id,
                duration: v.duration || 0
            });
        }
    }

    return Object.values(PLAYERS)
        .filter(p => byPlayer.has(p.id))
        .map(p => ({
            id: p.id,
            name: p.name,
            dubs: [...byPlayer.get(p.id)]
                .map(([name, eps]) => ({ name, episodes: [...eps.values()].sort(compareEpisodes) }))
                .sort((a, b) => b.episodes.length - a.episodes.length || a.name.localeCompare(b.name, 'ru'))
        }));
}

/** «Озвучка AniLibria» → «AniLibria», «Субтитры» остаются как есть. */
function cleanDubName(raw) {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    return s.replace(/^Озвучка\s+/i, '') || 'Без названия';
}

function compareEpisodes(a, b) {
    return (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0);
}

/** Описание сайта для окна загрузчика (см. sites/index.js). */
export const yummySite = {
    id: 'yummy',
    name: 'YummyAnime',
    parseUrl: parseAnimeUrl,
    /** @param {{origin: string, slug: string}} ctx */
    async load(ctx) {
        const anime = await fetchAnime(ctx.origin, ctx.slug);
        const players = await fetchPlayers(ctx.origin, anime.id);
        return { anime, players };
    }
};
