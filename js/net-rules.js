/**
 * Подстановка заголовков (Referer, Origin) в запросы окна загрузчика через
 * declarativeNetRequest. fetch() не даёт выставить эти заголовки вручную, а CDN
 * плееров их проверяют: Alloha отвечает 403 «origin_mismatch» без
 * Origin: https://alloha.yani.tv, а сама страница плеера без Referer не открывается.
 *
 * Правила сессионные и ограничены вкладкой этого окна, поэтому не влияют на
 * обычный просмотр сайтов.
 */

import { ext } from './util.js';

const dnr = ext.declarativeNetRequest;
const FIRST_RULE_ID = 1000;

/** @type {Map<string, number>} ключ правила → id */
const ruleIds = new Map();
let nextId = FIRST_RULE_ID;
let tabIdPromise = null;

/** @returns {Promise<?number>} id вкладки окна загрузчика. */
function currentTabId() {
    tabIdPromise ??= new Promise(resolve => {
        try {
            const r = ext.tabs.getCurrent(tab => resolve(tab?.id ?? null));
            if (r?.then) r.then(tab => resolve(tab?.id ?? null), () => resolve(null));
        } catch {
            resolve(null);
        }
    });
    return tabIdPromise;
}

/**
 * Удаляет сессионные правила, оставшиеся от прошлых окон этой вкладки.
 * @returns {Promise<void>}
 */
export async function resetRules() {
    const tabId = await currentTabId();
    const rules = await dnr.getSessionRules();
    const stale = rules
        .filter(r => r.id >= FIRST_RULE_ID && (tabId == null || r.condition?.tabIds?.includes(tabId)))
        .map(r => r.id);
    if (stale.length) await dnr.updateSessionRules({ removeRuleIds: stale });
    // id должны быть уникальны среди всех окон: продолжаем после максимального.
    const maxId = Math.max(FIRST_RULE_ID - 1, ...rules.map(r => r.id));
    nextId = maxId + 1;
    ruleIds.clear();
}

/**
 * Регистрирует (или обновляет) подстановку заголовков для домена.
 * @param {string} domain - Домен запроса (поддомены тоже подходят).
 * @param {Record<string, string>} headers - Заголовки для установки.
 * @param {string[]} [resourceTypes] - Типы запросов.
 * @returns {Promise<void>}
 */
export async function setRequestHeaders(domain, headers, resourceTypes = ['xmlhttprequest']) {
    const key = `${domain}|${resourceTypes.join(',')}`;
    const tabId = await currentTabId();
    const existing = ruleIds.get(key);
    const id = existing ?? nextId++;
    ruleIds.set(key, id);

    const condition = { requestDomains: [domain], resourceTypes };
    if (tabId != null) condition.tabIds = [tabId];

    await dnr.updateSessionRules({
        removeRuleIds: [id],
        addRules: [{
            id,
            priority: 1,
            action: {
                type: 'modifyHeaders',
                requestHeaders: Object.entries(headers).map(([header, value]) => ({ header, operation: 'set', value }))
            },
            condition
        }]
    });
}

/**
 * Домен второго уровня для правила: «4c-2f-63-r505.vkvideo.cloud» → «vkvideo.cloud»,
 * чтобы одно правило покрывало все зеркала CDN.
 * @param {string} url
 * @returns {string}
 */
export function ruleDomain(url) {
    const host = new URL(url).hostname;
    const parts = host.split('.');
    return parts.length > 2 ? parts.slice(-2).join('.') : host;
}
