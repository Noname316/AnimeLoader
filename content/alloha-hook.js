/**
 * Скрипт в странице плеера Alloha (мир MAIN, до скриптов страницы).
 *
 * Работает только во фрейме, который создал загрузчик (в адресе есть #animeloader),
 * обычный просмотр сайта не затрагивается.
 *
 * Плеер получает ссылки на поток запросом POST /bnsi/movies/{id} с одноразовой
 * подписью, которую вычисляет обфусцированный код, — повторить её снаружи
 * нельзя. Поэтому плеер работает как обычно (autoplay=1), а мы перехватываем
 * ответ и передаём его окну загрузчика. После этого запросы к видео блокируются:
 * плеер не должен тратить лимит скорости CDN, который нужен для загрузки.
 */
(() => {
    'use strict';

    if (!location.hash.includes('animeloader')) return;

    const TAG = 'animeloader:alloha';
    let captured = false;

    const post = payload => {
        try {
            window.parent.postMessage({ [TAG]: true, ...payload }, '*');
        } catch { /* родитель недоступен */ }
    };

    const isVideoRequest = url => /\.(m3u8|m4s|ts|mp4)(\?|$)|\/seg-\d+/i.test(url) && !url.includes('/bnsi/');

    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    const origSend = XHR.send;

    XHR.open = function(method, url) {
        this.__animeloaderUrl = String(url);
        return origOpen.apply(this, arguments);
    };

    XHR.send = function() {
        const url = this.__animeloaderUrl || '';
        if (captured && isVideoRequest(url)) return undefined; // запрос «зависает», фрейм скоро удалят

        if (url.includes('/bnsi/')) {
            this.addEventListener('loadend', () => {
                let data = null;
                try {
                    data = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
                } catch { /* не JSON */ }
                if (data?.hlsSource) {
                    captured = true;
                    post({ type: 'sources', data });
                } else {
                    post({
                        type: 'error',
                        status: this.status,
                        message: data?.error || `ответ плеера без ссылок (HTTP ${this.status})`
                    });
                }
            });
        }
        return origSend.apply(this, arguments);
    };

    const origFetch = window.fetch;
    window.fetch = function(input) {
        const url = String(input?.url ?? input ?? '');
        if (captured && isVideoRequest(url)) return new Promise(() => {});
        return origFetch.apply(this, arguments);
    };

    // Звук скрытого фрейма не нужен.
    document.addEventListener('play', e => {
        if (e.target instanceof HTMLMediaElement) e.target.muted = true;
    }, true);

    window.addEventListener('load', () => {
        // Страница-заглушка («Контент не найден…») не содержит списка серий.
        if (typeof fileList === 'undefined') { // eslint-disable-line no-undef
            const text = (document.body?.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200);
            post({ type: 'error', message: text || 'страница плеера не загрузилась' });
        } else {
            post({ type: 'loaded' });
        }
    });
})();
