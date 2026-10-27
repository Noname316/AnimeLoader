/**
 * Плеер Alloha: получение ссылок на HLS-потоки серии.
 *
 * Ссылки выдаёт сам плеер после проверок в обфусцированном JS, поэтому плеер
 * загружается в скрытом фрейме окна загрузчика, а content/alloha-hook.js
 * перехватывает ответ /bnsi/movies/{id}:
 *   { hlsSource: [{ label: "(Russian) AniLiberty", default, quality: { "1080": "url1 or url2", … } }, …] }
 *
 * Особенности CDN (vkvideo.cloud):
 *   - без заголовка Origin: https://alloha.yani.tv — 403, X-VD: origin_mismatch;
 *   - при слишком частых запросах — 403, X-VD: session_blocked, и блокировка
 *     держится несколько минут (в том числе для новых ссылок).
 */

import { absUrl } from '../util.js';
import { setRequestHeaders } from '../net-rules.js';

const MESSAGE_TAG = 'animeloader:alloha';

/**
 * Превращает ответ плеера в список качеств.
 * @param {object} data - Ответ /bnsi.
 * @param {{preferOriginal?: boolean}} [opts]
 * @returns {{label: string, variants: Array<{quality: number, urls: string[]}>}}
 */
export function parseAllohaSources(data, { preferOriginal = false } = {}) {
    const sources = Array.isArray(data?.hlsSource) ? data.hlsSource : [];
    if (!sources.length) throw new Error('Alloha: в ответе плеера нет потоков');

    const isOriginal = s => /original|оригинал/i.test(s.label || '');
    const source = (preferOriginal ? sources.find(isOriginal) : null)
        || sources.find(s => s.default && !isOriginal(s))
        || sources.find(s => !isOriginal(s))
        || sources[0];

    const variants = Object.entries(source.quality || {})
        .map(([q, value]) => ({
            quality: parseInt(q, 10) || 0,
            urls: String(value).split(/\s+or\s+/).map(s => s.trim()).filter(Boolean).map(absUrl)
        }))
        .filter(v => v.urls.length)
        .sort((a, b) => b.quality - a.quality);
    if (!variants.length) throw new Error('Alloha: у выбранной дорожки нет ссылок');
    return { label: source.label || '', variants };
}

/**
 * Получает ссылки на потоки серии через скрытый фрейм плеера.
 * @param {string} iframeUrl - Адрес плеера из API сайта.
 * @param {{siteOrigin: string, signal?: AbortSignal, log?: Function, timeoutMs?: number, preferOriginal?: boolean}} ctx
 * @returns {Promise<{variants: Array<{quality: number, urls: string[]}>, headers: Record<string, string>, label: string}>}
 */
export async function resolveAlloha(iframeUrl, { siteOrigin, signal, log = () => {}, timeoutMs = 30000, preferOriginal = false }) {
    const url = new URL(absUrl(iframeUrl));
    url.searchParams.set('autoplay', '1');
    url.hash = 'animeloader';
    const playerOrigin = url.origin;

    // Без Referer сайт плеера отдаёт заглушку «контент не найден».
    await setRequestHeaders(url.hostname, { Referer: `${siteOrigin}/` }, ['sub_frame']);

    const data = await loadInFrame(url.href, { signal, timeoutMs, log });
    const { label, variants } = parseAllohaSources(data, { preferOriginal });

    log(`Alloha: дорожка «${label}», качества ${variants.map(v => v.quality).join('/')}`);
    return { variants, label, headers: { Origin: playerOrigin, Referer: `${playerOrigin}/` } };
}

/**
 * Открывает плеер в скрытом фрейме и ждёт перехваченный ответ.
 * @returns {Promise<object>}
 */
function loadInFrame(src, { signal, timeoutMs, log }) {
    return new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.allow = 'autoplay; encrypted-media';
        frame.setAttribute('aria-hidden', 'true');
        // Не display:none — иначе плеер может не инициализироваться.
        frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:640px;height:360px;border:0;opacity:0;pointer-events:none';

        const timer = setTimeout(() => finish(new Error(
            'Alloha: плеер не выдал ссылку за отведённое время (возможно, сайт изменил плеер или временно ограничил доступ)'
        )), timeoutMs);

        function onMessage(e) {
            if (e.source !== frame.contentWindow || !e.data?.[MESSAGE_TAG]) return;
            if (e.data.type === 'sources') finish(null, e.data.data);
            else if (e.data.type === 'error') finish(new Error(`Alloha: ${e.data.message}`));
            else if (e.data.type === 'loaded') log('Alloha: плеер загружен, жду ссылку…');
        }

        function onAbort() {
            finish(signal.reason instanceof Error ? signal.reason : new DOMException('Загрузка остановлена', 'AbortError'));
        }

        function finish(err, data) {
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            signal?.removeEventListener('abort', onAbort);
            frame.src = 'about:blank';
            frame.remove();
            if (err) reject(err);
            else resolve(data);
        }

        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        window.addEventListener('message', onMessage);
        frame.src = src;
        document.body.appendChild(frame);
    });
}
