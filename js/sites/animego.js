/**
 * AnimeGO (animego.me): тайтл и серии по плеерам и озвучкам.
 *
 * Адрес тайтла — /anime/{slug}-{id}. Данные плеера сайт подгружает сам:
 *   GET /player/{id}                    — разметка плеера: список серий (первые 100) и плееры текущей серии
 *   GET /player/{id}/episodes?page=N    — следующие страницы списка серий
 *   GET /player/videos/{episodeId}      — плееры серии: кнопки с data-player (адрес iframe),
 *                                         data-provider-slug (kodik/cvh/aniboom) и data-translation-title
 * Ответы — JSON {status, data: {content: HTML}}. Без X-Requested-With сервер отвечает 404.
 */

const PLAYER_NAMES = { kodik: 'Kodik', cvh: 'CVH', aniboom: 'AniBoom' };
const EPISODE_CONCURRENCY = 4;

/**
 * @param {string} url
 * @returns {?{origin: string, slug: string, id: string, url: string}}
 */
export function parseAnimegoUrl(url) {
    try {
        const u = new URL(url);
        if (!/(^|\.)animego\.[a-z]+$/i.test(u.hostname)) return null;
        const m = /^\/anime\/([^/?#]+)-(\d+)\/?$/.exec(u.pathname);
        return m ? { origin: u.origin, slug: decodeURIComponent(m[1]), id: m[2], url: `${u.origin}${u.pathname}` } : null;
    } catch {
        return null;
    }
}

function decodeEntities(s) {
    return String(s ?? '')
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/** Атрибуты открывающего тега. */
function attrs(tag) {
    const out = {};
    for (const m of tag.matchAll(/([a-z][\w-]*)="([^"]*)"/gi)) out[m[1]] = decodeEntities(m[2]);
    return out;
}

/** Все открывающие теги, у которых есть атрибут name. */
function tagsWith(html, name) {
    return [...html.matchAll(new RegExp(`<[a-z]+\\b[^>]*\\b${name}="[^"]*"[^>]*>`, 'gi'))].map(m => attrs(m[0]));
}

/**
 * Карточка тайтла со страницы.
 * @param {string} html
 * @param {string} fallbackTitle
 */
export function parseAnimegoTitle(html, fallbackTitle) {
    let ld = null;
    for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
        try {
            const j = JSON.parse(m[1]);
            if (j && /TVSeries|Movie|CreativeWork/i.test(j['@type'])) {
                ld = j;
                break;
            }
        } catch { /* не JSON — пропускаем */ }
    }
    const h1 = /<h1[^>]*>([^<]+)/.exec(html)?.[1];
    const og = name => decodeEntities(new RegExp(`<meta property="og:${name}" content="([^"]*)"`).exec(html)?.[1] || '');
    const title = decodeEntities(ld?.name || h1 || '').trim() || fallbackTitle;
    const year = Number(/(\d{4})/.exec(ld?.datePublished || ld?.startDate || '')?.[1]) || null;
    const isMovie = /Movie/i.test(ld?.['@type'] || '');
    return {
        title,
        description: decodeEntities(ld?.description || og('description')),
        poster: ld?.image || og('image') || null,
        year,
        typeName: isMovie ? 'Фильм' : 'Сериал',
        isSeries: !isMovie,
        episodesTotal: Number(ld?.numberOfEpisodes) || null
    };
}

/**
 * Список серий из разметки плеера или страницы /episodes.
 * @param {string} html
 * @returns {Array<{number: string, id: string}>}
 */
export function parseAnimegoEpisodes(html) {
    const seen = new Set();
    const out = [];
    for (const a of tagsWith(html, 'data-episode-number')) {
        const id = a['data-episode'];
        const number = (a['data-episode-number'] || '').trim();
        if (!id || !number || seen.has(id)) continue;
        seen.add(id);
        out.push({ number, id });
    }
    return out;
}

/** Страницы списка серий: [{page, firstNumber, lastNumber, count}]. */
export function parseEpisodePages(html) {
    const raw = tagsWith(html, 'data-anime-player-episodes-pages-value')[0]?.['data-anime-player-episodes-pages-value'];
    try {
        const pages = JSON.parse(raw || '[]');
        return Array.isArray(pages) ? pages : [];
    } catch {
        return [];
    }
}

/**
 * Плееры одной серии.
 * @param {string} html
 * @returns {Array<{player: string, dub: string, iframeUrl: string}>}
 */
export function parseAnimegoVideos(html) {
    return tagsWith(html, 'data-player')
        .filter(a => a['data-provider-slug'] && a['data-player'])
        .map(a => ({
            player: a['data-provider-slug'].toLowerCase(),
            dub: (a['data-translation-title'] || '').replace(/\s+/g, ' ').trim() || 'Без названия',
            iframeUrl: absolute(a['data-player'])
        }));
}

function absolute(url) {
    return url.startsWith('//') ? `https:${url}` : url;
}

/**
 * Группирует плееры серий как на YummyAnime: плеер → озвучка → серии.
 * @param {Array<{number: string, videos: ReturnType<typeof parseAnimegoVideos>}>} episodes
 */
export function groupAnimego(episodes) {
    /** @type {Map<string, Map<string, Array<object>>>} */
    const byPlayer = new Map();
    for (const ep of episodes) {
        for (const v of ep.videos) {
            if (!PLAYER_NAMES[v.player]) continue;
            if (!byPlayer.has(v.player)) byPlayer.set(v.player, new Map());
            const dubs = byPlayer.get(v.player);
            if (!dubs.has(v.dub)) dubs.set(v.dub, []);
            const list = dubs.get(v.dub);
            if (!list.some(e => e.number === ep.number)) list.push({ number: ep.number, iframeUrl: v.iframeUrl, duration: 0 });
        }
    }
    return Object.keys(PLAYER_NAMES)
        .filter(id => byPlayer.has(id))
        .map(id => ({
            id,
            name: PLAYER_NAMES[id],
            dubs: [...byPlayer.get(id)]
                .map(([name, eps]) => ({ name, episodes: eps.sort((a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0)) }))
                .sort((a, b) => b.episodes.length - a.episodes.length || a.name.localeCompare(b.name, 'ru'))
        }));
}

async function getContent(url, signal) {
    const res = await fetch(url, { signal, headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
    if (!res.ok) throw new Error(`${new URL(url).pathname}: HTTP ${res.status}`);
    const json = await res.json();
    if (json?.status !== 'success' || typeof json.data?.content !== 'string') throw new Error(`${new URL(url).pathname}: неожиданный ответ`);
    return json.data;
}

/** Выполняет задачи с ограничением параллельности. */
async function pool(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    }));
    return out;
}

export const animegoSite = {
    id: 'animego',
    name: 'AnimeGO',
    parseUrl: parseAnimegoUrl,
    /**
     * @param {NonNullable<ReturnType<typeof parseAnimegoUrl>>} ctx
     * @param {{signal?: AbortSignal, onProgress?: (text: string) => void, log?: Function}} [opts]
     */
    async load(ctx, { signal, onProgress, log } = {}) {
        const page = await fetch(ctx.url, { signal });
        if (!page.ok) throw new Error(`страница тайтла: HTTP ${page.status}`);
        const anime = { id: ctx.id, ...parseAnimegoTitle(await page.text(), ctx.slug) };

        const player = await getContent(`${ctx.origin}/player/${ctx.id}`, signal);
        let episodes = parseAnimegoEpisodes(player.content);
        for (const p of parseEpisodePages(player.content)) {
            if (!p.page) continue;
            const more = await getContent(`${ctx.origin}/player/${ctx.id}/episodes?page=${p.page}`, signal);
            episodes.push(...parseAnimegoEpisodes(more.content).filter(e => !episodes.some(x => x.id === e.id)));
        }

        let withVideos;
        if (!episodes.length) {
            // Фильм: серий нет, плееры сразу в разметке.
            withVideos = [{ number: '1', videos: parseAnimegoVideos(player.content) }];
        } else {
            let done = 0;
            withVideos = await pool(episodes, EPISODE_CONCURRENCY, async ep => {
                let videos = [];
                try {
                    videos = parseAnimegoVideos((await getContent(`${ctx.origin}/player/videos/${ep.id}`, signal)).content);
                } catch (e) {
                    log?.(`Серия ${ep.number}: не удалось получить плееры (${e.message})`, 'warn');
                }
                onProgress?.(`Загружаю список серий: ${++done} из ${episodes.length}`);
                return { number: ep.number, videos };
            });
        }
        if (!anime.episodesTotal && episodes.length) anime.episodesTotal = episodes.length;
        if (episodes.length > 1) anime.isSeries = true;
        return { anime, players: groupAnimego(withVideos) };
    }
};
