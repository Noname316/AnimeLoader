/**
 * Настройки и запомненный выбор пользователя.
 *   - обычные значения — chrome.storage.local;
 *   - выбранная папка (FileSystemDirectoryHandle) — IndexedDB: в storage её не сохранить.
 */

import { ext } from './util.js';

export const DEFAULTS = {
    player: 'kodik',
    dub: '',
    quality: 'max',
    tsFormat: 'mp4',
    createFolder: true,
    // folder — папка через File System Access, downloads — подпапка «Загрузок» (её можно открыть).
    saveMode: 'folder',
    subfolder: 'Anime',
    pace: {
        kodik: { concurrency: 4, delayMs: 0, perLink: 0 },
        // Alloha блокирует ссылку (403 session_blocked), если взять по ней больше ~40
        // сегментов быстрее, чем примерно один в 4 с. Поэтому ссылка меняется каждые
        // 30 сегментов — это быстрее и надёжнее, чем качать медленно.
        alloha: { concurrency: 2, delayMs: 200, perLink: 30 },
        // CVH отдаёт файл MP4: качается кусками по 8 МБ.
        cvh: { concurrency: 3, delayMs: 0, perLink: 0 },
        aniboom: { concurrency: 4, delayMs: 0, perLink: 0 }
    },
    episodePauseSec: { kodik: 1, alloha: 3, cvh: 1, aniboom: 1 },
    cooldownMin: [3, 6, 10, 15]
};

const KEY = 'settings';

/** @returns {Promise<typeof DEFAULTS>} */
export async function loadSettings() {
    try {
        const stored = (await ext.storage.local.get(KEY))?.[KEY] || {};
        return {
            ...DEFAULTS,
            ...stored,
            pace: Object.fromEntries(Object.entries(DEFAULTS.pace).map(([id, d]) => [id, { ...d, ...stored.pace?.[id] }])),
            episodePauseSec: { ...DEFAULTS.episodePauseSec, ...stored.episodePauseSec }
        };
    } catch {
        return structuredClone(DEFAULTS);
    }
}

/** @param {Partial<typeof DEFAULTS>} patch */
export async function saveSettings(patch) {
    const current = await loadSettings();
    await ext.storage.local.set({ [KEY]: { ...current, ...patch } });
}

// --- Папка назначения -------------------------------------------------------

const DB_NAME = 'animeloader';
const STORE = 'handles';

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idb(mode, fn) {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const req = fn(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(req?.result);
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

/** @returns {Promise<?FileSystemDirectoryHandle>} */
export async function loadDirectory() {
    try {
        return (await idb('readonly', s => s.get('directory'))) || null;
    } catch {
        return null;
    }
}

/** @param {FileSystemDirectoryHandle} handle */
export async function saveDirectory(handle) {
    await idb('readwrite', s => s.put(handle, 'directory'));
}

/** Поддерживает ли браузер выбор произвольной папки. */
export function supportsDirectoryPicker() {
    return typeof globalThis.showDirectoryPicker === 'function';
}

/**
 * Проверяет (и при необходимости запрашивает) право записи в папку.
 * Запрос разрешения должен идти из обработчика клика.
 * @param {FileSystemDirectoryHandle} handle
 * @param {boolean} request
 * @returns {Promise<boolean>}
 */
export async function ensureWritable(handle, request) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission?.(opts)) === 'granted') return true;
    if (!request) return false;
    return (await handle.requestPermission?.(opts)) === 'granted';
}
