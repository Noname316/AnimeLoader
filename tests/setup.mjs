// Окружение браузера для запуска модулей расширения в Node.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Загружает UMD-библиотеку из lib/ так же, как обычный <script> в браузере. */
function loadScript(file) {
    const code = fs.readFileSync(path.join(here, '../lib', file), 'utf8');
    vm.runInThisContext(`(function (exports, module, define) {\n${code}\n})()`, { filename: file });
}

globalThis.window ??= globalThis;
loadScript('m3u8-parser.min.js');
loadScript('mux.min.js');

// Заглушки API расширения. Сессионные правила declarativeNetRequest эмулируются:
// заголовки из правил подставляются в fetch, как это делает браузер.
const sessionRules = new Map();
globalThis.chrome = {
    declarativeNetRequest: {
        async getSessionRules() { return [...sessionRules.values()]; },
        async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
            for (const id of removeRuleIds) sessionRules.delete(id);
            for (const r of addRules) sessionRules.set(r.id, r);
        }
    },
    tabs: { getCurrent(cb) { cb({ id: 1 }); } }
};

const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init.headers || {});
    for (const rule of sessionRules.values()) {
        const domains = rule.condition?.requestDomains || [];
        if (!domains.some(d => url.hostname === d || url.hostname.endsWith(`.${d}`))) continue;
        for (const h of rule.action?.requestHeaders || []) {
            if (h.operation === 'set') headers.set(h.header, h.value);
            else if (h.operation === 'remove') headers.delete(h.header);
        }
    }
    return nativeFetch(input, { ...init, headers });
};
