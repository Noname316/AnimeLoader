/**
 * Получение ссылок на серию по id плеера: resolve(iframeUrl, {siteOrigin, signal, log}) → Source.
 */

import { resolveKodik } from './kodik.js';
import { resolveAlloha } from './alloha.js';
import { resolveCvh } from './cvh.js';
import { resolveAniboom } from './aniboom.js';

export const RESOLVERS = {
    kodik: resolveKodik,
    alloha: resolveAlloha,
    cvh: resolveCvh,
    aniboom: resolveAniboom
};
