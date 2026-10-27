/**
 * Поддерживаемые сайты. У каждого:
 *   parseUrl(url) → контекст страницы тайтла или null;
 *   load(ctx, {signal, onProgress, log}) → {anime, players}, где
 *   players = [{id, name, dubs: [{name, episodes: [{number, iframeUrl, duration}]}]}],
 *   а id плеера — ключ в RESOLVERS окна загрузчика (kodik, alloha, cvh, aniboom).
 */

import { yummySite } from './yummy.js';
import { animegoSite } from './animego.js';

export const SITES = [yummySite, animegoSite];

/**
 * @param {string} url
 * @returns {?{site: typeof SITES[number], ctx: object}}
 */
export function detectSite(url) {
    for (const site of SITES) {
        const ctx = site.parseUrl(url);
        if (ctx) return { site, ctx };
    }
    return null;
}
