/**
 * Запись скачанного видео на диск.
 *
 * Папка назначения:
 *   - DirectoryTarget — папка, выбранная через File System Access API
 *     (Chrome/Edge/Opera); сегменты пишутся в файл потоком, память не растёт;
 *   - DownloadsTarget — подпапка «Загрузок» через downloads API (и запасной вариант
 *     для Firefox). Файл собирается в Blob и сохраняется в конце; зато браузер умеет
 *     показать его в папке (downloads.show) — для выбранной папки такого API нет.
 *
 * Контейнер:
 *   - fMP4-сегменты (Alloha) склеиваются как есть: init + фрагменты = готовый .mp4;
 *   - MPEG-TS (Kodik) либо пишется как .ts, либо после загрузки серии
 *     перепаковывается в MP4 библиотекой mux.js (без перекодирования).
 */

import { ext, sanitizeFileName } from './util.js';

/**
 * @typedef {object} FileWriter
 * @property {(chunk: Uint8Array) => Promise<void>} write - Дописать в конец.
 * @property {(position: number, data: Uint8Array) => Promise<void>} [writeAt] - Перезаписать уже записанные байты.
 * @property {() => Promise<void>} close
 * @property {() => Promise<void>} abort
 */

export class DirectoryTarget {
    /** @param {FileSystemDirectoryHandle} handle @param {string} [path] */
    constructor(handle, path) {
        this.handle = handle;
        this.path = path || handle.name;
    }

    describe() {
        return this.path;
    }

    /** @param {string} name @returns {Promise<DirectoryTarget>} */
    async subfolder(name) {
        const safe = sanitizeFileName(name, 'anime');
        const handle = await this.handle.getDirectoryHandle(safe, { create: true });
        return new DirectoryTarget(handle, `${this.path}/${safe}`);
    }

    /** @param {string} name @returns {Promise<boolean>} */
    async exists(name) {
        try {
            const file = await (await this.handle.getFileHandle(name)).getFile();
            return file.size > 0;
        } catch {
            return false;
        }
    }

    /**
     * Файл пишется во временный файл браузера и появляется под своим именем
     * только после close() — недокачанных файлов в папке не остаётся.
     * @param {string} name
     * @returns {Promise<FileWriter>}
     */
    async createFile(name) {
        const fileHandle = await this.handle.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable({ keepExistingData: false });
        let bytes = 0;
        return {
            async write(chunk) {
                await writable.write(chunk);
                bytes += chunk.byteLength;
            },
            async writeAt(position, data) {
                await writable.write({ type: 'write', position, data });
            },
            async close() {
                await writable.close();
            },
            abort: async () => {
                try {
                    await writable.abort();
                } catch { /* уже закрыт */ }
                // Пустой файл, созданный getFileHandle, тоже убираем.
                if (!bytes) await this.handle.removeEntry(name).catch(() => {});
            }
        };
    }
}

/** Сколько байт копить в массивах, прежде чем сбросить их в Blob (Blob браузер может держать на диске). */
const BLOB_FLUSH = 32 * 1024 * 1024;
/** Начало файла держится отдельно: туда в конце дописывается длительность (writeAt). */
const HEAD_BYTES = 4 * 1024 * 1024;

export class DownloadsTarget {
    /** @param {string} [subfolder] - Путь внутри «Загрузок». */
    constructor(subfolder = '') {
        // Путь хранится в path: имя subfolder занято методом.
        this.path = String(subfolder)
            .split(/[\\/]+/)
            .map(p => sanitizeFileName(p, ''))
            .filter(p => p && p !== '.' && p !== '..')
            .join('/');
        /** id последнего сохранённого (или найденного) файла — для «Открыть папку». */
        this.lastDownloadId = null;
    }

    describe() {
        return this.path ? `Загрузки/${this.path}` : 'Загрузки';
    }

    async subfolder(name) {
        const safe = sanitizeFileName(name, 'anime');
        return new DownloadsTarget(this.path ? `${this.path}/${safe}` : safe);
    }

    /**
     * Файл уже скачан, если он есть в истории загрузок и на диске.
     * @param {string} name
     */
    async exists(name) {
        // В Windows путь в истории загрузок — с обратными слешами.
        const path = [...this.path.split('/').filter(Boolean), name].map(escapeRegex).join('[\\\\/]');
        try {
            const [item] = await ext.downloads.search({ filenameRegex: `(^|[\\\\/])${path}$`, state: 'complete', exists: true, limit: 1 });
            if (!item) return false;
            this.lastDownloadId = item.id;
            return true;
        } catch {
            return false;
        }
    }

    async createFile(name) {
        const filename = this.path ? `${this.path}/${name}` : name;
        /** @type {Uint8Array[]} начало файла (до HEAD_BYTES) — его можно исправлять */
        const head = [];
        let headBytes = 0;
        /** @type {Uint8Array[]} */
        let pending = [];
        let pendingBytes = 0;
        /** @type {Blob[]} */
        const blobs = [];
        const flush = () => {
            if (!pending.length) return;
            blobs.push(new Blob(pending));
            pending = [];
            pendingBytes = 0;
        };
        return {
            write: async chunk => {
                if (headBytes < HEAD_BYTES) {
                    head.push(chunk);
                    headBytes += chunk.byteLength;
                    return;
                }
                pending.push(chunk);
                pendingBytes += chunk.byteLength;
                if (pendingBytes >= BLOB_FLUSH) flush();
            },
            writeAt: async (position, data) => {
                // Исправляются только первые мегабайты (init-сегмент); дальше — уже в Blob.
                if (position + data.byteLength > headBytes) return;
                let offset = 0;
                for (const part of head) {
                    const from = Math.max(position, offset);
                    const to = Math.min(position + data.byteLength, offset + part.byteLength);
                    if (from < to) part.set(data.subarray(from - position, to - position), from - offset);
                    offset += part.byteLength;
                }
            },
            close: async () => {
                flush();
                const url = URL.createObjectURL(new Blob([...head, ...blobs], { type: 'video/mp4' }));
                head.length = 0;
                blobs.length = 0;
                try {
                    const id = await ext.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
                    await waitForDownload(id);
                    this.lastDownloadId = id;
                } finally {
                    setTimeout(() => URL.revokeObjectURL(url), 10000);
                }
            },
            abort: async () => {
                head.length = 0;
                pending = [];
                blobs.length = 0;
            }
        };
    }
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Показывает сохранённый файл в папке (Проводник, Finder). */
export function showDownload(id) {
    return ext.downloads.show(id);
}

function waitForDownload(id) {
    return new Promise((resolve, reject) => {
        const listener = delta => {
            if (delta.id !== id || !delta.state) return;
            if (delta.state.current === 'complete') done();
            else if (delta.state.current === 'interrupted') done(new Error(`сохранение прервано: ${delta.error?.current || 'неизвестная ошибка'}`));
        };
        const done = err => {
            ext.downloads.onChanged.removeListener(listener);
            if (err) reject(err);
            else resolve();
        };
        ext.downloads.onChanged.addListener(listener);
    });
}

/**
 * Обёртка над FileWriter, перепаковывающая MPEG-TS в фрагментированный MP4.
 * Каждый TS-сегмент — отдельный фрагмент; init-сегмент пишется один раз.
 */
export class TsToMp4Writer {
    /** @param {FileWriter} out */
    constructor(out) {
        const muxjs = globalThis.muxjs;
        if (!muxjs?.mp4?.Transmuxer) throw new Error('Библиотека mux.js не загружена');
        this.out = out;
        /** @type {Uint8Array[]} */
        this.pending = [];
        this.transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
        this.transmuxer.on('data', seg => {
            if (!this.pending.length && seg.initSegment?.byteLength) this.pending.push(seg.initSegment);
            if (seg.data?.byteLength) this.pending.push(seg.data);
        });
    }

    /**
     * Сегменты только накапливаются в mux.js, перепаковка — одним проходом в close().
     * Сброс после каждого сегмента давал бы рывки: сегменты Kodik начинаются не с
     * ключевого кадра, и mux.js на стыках дублирует или растягивает кадры.
     * Цена — в памяти держится вся серия (для 720p это ~150–400 МБ).
     * @param {Uint8Array} chunk - Целый TS-сегмент.
     */
    async write(chunk) {
        this.transmuxer.push(chunk);
    }

    async close() {
        this.transmuxer.flush();
        const parts = this.pending.splice(0);
        if (!parts.length) throw new Error('mux.js не смог разобрать TS-поток — попробуйте формат TS');
        for (const p of parts) await this.out.write(p);
        await this.out.close();
    }

    abort() {
        return this.out.abort();
    }
}
