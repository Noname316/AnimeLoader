/**
 * Фон расширения: по клику на значок открывает окно загрузчика для текущей
 * вкладки (или выводит вперёд уже открытое для неё).
 *
 * Загрузка идёт в отдельном окне, а не во всплывающем попапе: попап закрывается
 * при потере фокуса и обрывал бы скачивание.
 */

const api = globalThis.browser ?? globalThis.chrome;
const WINDOW_SIZE = { width: 400, height: 760 };
const STORAGE_KEY = 'openWindows';

/** @returns {Promise<Record<string, number>>} «вкладка|страница» → окно загрузчика */
async function getOpenWindows() {
    const data = await api.storage.session.get(STORAGE_KEY);
    return data?.[STORAGE_KEY] || {};
}

async function setOpenWindows(map) {
    await api.storage.session.set({ [STORAGE_KEY]: map });
}

/** Одно окно на пару «вкладка + страница»: на другой странице той же вкладки — новое окно. */
function windowKey(tab) {
    const page = (tab.url || '').replace(/[?#].*$/, '');
    return `${tab.id}|${page}`;
}

api.action.onClicked.addListener(async tab => {
    const windows = await getOpenWindows();
    const key = windowKey(tab);
    const existing = windows[key];
    if (existing != null) {
        try {
            await api.windows.update(existing, { focused: true });
            return;
        } catch {
            delete windows[key];
        }
    }

    const params = new URLSearchParams({ tabId: String(tab.id ?? ''), url: tab.url || '' });
    const win = await api.windows.create({
        url: api.runtime.getURL(`downloader.html?${params}`),
        type: 'popup',
        focused: true,
        ...WINDOW_SIZE
    });
    if (win?.id != null) {
        windows[key] = win.id;
        await setOpenWindows(windows);
    }
});

api.windows.onRemoved.addListener(async windowId => {
    const windows = await getOpenWindows();
    let changed = false;
    for (const [key, id] of Object.entries(windows)) {
        if (id === windowId) {
            delete windows[key];
            changed = true;
        }
    }
    if (changed) await setOpenWindows(windows);
});
