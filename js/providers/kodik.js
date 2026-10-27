/**
 * Плеер Kodik: получение ссылок на HLS-потоки серии.
 *
 * 1. Страница плеера (iframe_url) содержит параметры видео:
 *      vInfo.type / vInfo.hash / vInfo.id и подписанные urlParams (d, d_sign, pd, …).
 * 2. POST этих параметров на служебный адрес (сейчас «/ftor», он периодически
 *    меняется — берём актуальный из JS плеера) возвращает
 *      { links: { "360": [{src}], "480": [...], "720": [...] } }.
 * 3. src — base64 после сдвига латинских букв (шифр Цезаря, сдвиг тоже меняется),
 *    поэтому перебираем все 26 сдвигов и берём тот, что даёт адрес.
 */

import { absUrl } from '../util.js';
import { ruleDomain, setRequestHeaders } from '../net-rules.js';

const DEFAULT_ENDPOINT = '/ftor';
/** @type {Map<string, string>} хост плеера → адрес выдачи ссылок */
const endpointCache = new Map();

/**
 * Расшифровывает поле src из ответа Kodik.
 * @param {string} src
 * @returns {?string} Адрес (https://…) или null.
 */
export function decodeKodikSrc(src) {
    if (!src) return null;
    if (/^(https?:)?\/\//.test(src)) return absUrl(src);
    for (let shift = 0; shift < 26; shift++) {
        const rotated = src.replace(/[a-zA-Z]/g, c => {
            const base = c <= 'Z' ? 65 : 97;
            return String.fromCharCode(((c.charCodeAt(0) - base + shift) % 26) + base);
        });
        let decoded;
        try {
            decoded = atob(padBase64(rotated));
        } catch {
            continue;
        }
        if (/^(https?:)?\/\/[\w.-]+\//.test(decoded) && /m3u8|\.mp4/.test(decoded)) return absUrl(decoded);
    }
    return null;
}

function padBase64(s) {
    const rem = s.length % 4;
    return rem ? s + '='.repeat(4 - rem) : s;
}

/**
 * Достаёт параметры видео со страницы плеера.
 * @param {string} html
 * @returns {{type: string, hash: string, id: string, params: Record<string, string>, playerJs: ?string}}
 */
export function parseKodikPage(html) {
    const pick = name => {
        const m = new RegExp(`vInfo\\.${name}\\s*=\\s*['"]([^'"]+)['"]`).exec(html)
            || new RegExp(`var\\s+${name === 'id' ? 'videoId' : name}\\s*=\\s*['"]([^'"]+)['"]`).exec(html);
        return m ? m[1] : null;
    };
    const type = pick('type');
    const hash = pick('hash');
    const id = pick('id');
    if (!type || !hash || !id) throw new Error('Kodik: не найдены параметры видео на странице плеера');

    // Плеер отправляет значения из переменных `var domain/d_sign/…`. В urlParams то же
    // самое, но ref там URL-кодирован — отправленный как есть, он даёт HTTP 500.
    let urlParams = {};
    const up = /urlParams\s*=\s*'([^']+)'/.exec(html);
    if (up) {
        try {
            urlParams = JSON.parse(up[1]);
        } catch { /* остаются переменные */ }
    }
    const params = {};
    for (const name of ['d', 'd_sign', 'pd', 'pd_sign', 'ref', 'ref_sign']) {
        const varName = name === 'd' ? 'domain' : name;
        const m = new RegExp(`var\\s+${varName}\\s*=\\s*"([^"]*)"`).exec(html);
        if (m) params[name] = m[1];
        else if (urlParams[name] !== undefined) params[name] = name === 'ref' ? safeDecode(urlParams[name]) : String(urlParams[name]);
    }

    const js = /src="([^"]*app\.player_single[^"]*\.js)"/.exec(html);
    return { type, hash, id, params, playerJs: js ? js[1] : null };
}

function safeDecode(s) {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

/**
 * Находит в JS плеера адрес выдачи ссылок: `$.ajax({type:"POST",url:atob("L2Z0b3I=")…`.
 * @param {string} js
 * @returns {?string}
 */
export function findEndpoint(js) {
    const re = /type:\s*"POST"\s*,\s*url:\s*atob\("([A-Za-z0-9+/=]+)"\)/g;
    let m;
    while ((m = re.exec(js))) {
        try {
            const path = atob(m[1]);
            if (/^\/[\w-]+$/.test(path)) return path;
        } catch { /* следующий */ }
    }
    return null;
}

/**
 * Получает ссылки на потоки серии.
 * @param {string} iframeUrl - Адрес плеера из API сайта.
 * @param {{siteOrigin: string, signal?: AbortSignal, log?: Function}} ctx
 * @returns {Promise<{variants: Array<{quality: number, urls: string[]}>, headers: Record<string, string>}>}
 */
export async function resolveKodik(iframeUrl, { siteOrigin, signal, log = () => {} }) {
    const pageUrl = new URL(absUrl(iframeUrl));
    const playerOrigin = pageUrl.origin;
    // Плеер открывается сайтом во фрейме — повторяем Referer сайта.
    await setRequestHeaders(ruleDomain(pageUrl.href), { Referer: `${siteOrigin}/`, Origin: playerOrigin });

    const pageRes = await fetch(pageUrl, { signal, credentials: 'omit' });
    if (!pageRes.ok) throw new Error(`Kodik: страница плеера ответила HTTP ${pageRes.status}`);
    const info = parseKodikPage(await pageRes.text());

    const endpoint = await getEndpoint(playerOrigin, info.playerJs, signal, log);
    const body = new URLSearchParams({
        ...info.params,
        bad_user: 'false',
        cdn_is_working: 'true',
        type: info.type,
        hash: info.hash,
        id: info.id,
        info: '{}'
    });

    const res = await fetch(playerOrigin + endpoint, {
        method: 'POST',
        body,
        signal,
        credentials: 'omit',
        headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' }
    });
    if (!res.ok) {
        endpointCache.delete(playerOrigin);
        throw new Error(`Kodik: выдача ссылок (${endpoint}) ответила HTTP ${res.status}`);
    }
    const json = await res.json();
    const variants = Object.entries(json?.links || {})
        .map(([q, arr]) => ({
            quality: parseInt(q, 10) || 0,
            urls: (Array.isArray(arr) ? arr : []).map(x => decodeKodikSrc(x?.src)).filter(Boolean)
        }))
        .filter(v => v.urls.length)
        .sort((a, b) => b.quality - a.quality);
    if (!variants.length) throw new Error('Kodik: не удалось расшифровать ссылки на видео');

    const cdnDomains = new Set(variants.flatMap(v => v.urls.map(ruleDomain)));
    log(`Kodik: видео ${info.type}/${info.id}, качества ${variants.map(v => v.quality).join('/')}, CDN ${[...cdnDomains].join(', ')}`);
    return { variants, headers: {} };
}

async function getEndpoint(playerOrigin, playerJs, signal, log) {
    if (endpointCache.has(playerOrigin)) return endpointCache.get(playerOrigin);
    let endpoint = null;
    if (playerJs) {
        try {
            const res = await fetch(new URL(playerJs, playerOrigin), { signal });
            if (res.ok) endpoint = findEndpoint(await res.text());
        } catch (e) {
            if (e?.name === 'AbortError') throw e;
        }
    }
    if (!endpoint) {
        log(`Kodik: адрес выдачи ссылок не найден в JS плеера, пробую ${DEFAULT_ENDPOINT}`, 'warn');
        endpoint = DEFAULT_ENDPOINT;
    }
    endpointCache.set(playerOrigin, endpoint);
    return endpoint;
}
