/**
 * Сведение отдельных дорожек видео и звука (fMP4/CMAF) в один MP4.
 *
 * Некоторые плееры (AniBoom) отдают HLS, где звук — отдельный плейлист со своим
 * init-сегментом. Обе дорожки там обычно с track_ID = 1, поэтому:
 *   - из двух init-сегментов собирается один moov с двумя trak (видео — 1, звук — 2)
 *     и общим mvex;
 *   - во фрагментах (moof) переписывается track_ID в tfhd и сквозная нумерация mfhd;
 *   - styp/sidx/prft выбрасываются: в файле они не нужны и сбивают часть плееров.
 * Фрагменты дорожек идут вперемешку по времени, данные moof+mdat не меняются
 * (смещения в trun считаются от начала moof).
 */

const VIDEO_ID = 1;
const AUDIO_ID = 2;
const DROP_TOP = new Set(['styp', 'sidx', 'prft', 'free', 'skip']);

/** @returns {Array<{type: string, start: number, end: number, body: number}>} */
function boxes(buf, start = 0, end = buf.byteLength) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const out = [];
    let pos = start;
    while (pos + 8 <= end) {
        let size = view.getUint32(pos);
        const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
        let body = pos + 8;
        if (size === 1) {
            size = Number(view.getBigUint64(pos + 8));
            body = pos + 16;
        } else if (size === 0) {
            size = end - pos;
        }
        if (size < 8 || pos + size > end) throw new Error(`повреждённый MP4: бокс ${type} выходит за границы`);
        out.push({ type, start: pos, end: pos + size, body });
        pos += size;
    }
    return out;
}

function box(type, ...parts) {
    const size = 8 + parts.reduce((s, p) => s + p.byteLength, 0);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let pos = 8;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.byteLength;
    }
    return out;
}

function find(list, type) {
    return list.find(b => b.type === type) || null;
}

/** Разбор init-сегмента одной дорожки. */
function parseInit(buf, label) {
    const top = boxes(buf);
    const ftyp = find(top, 'ftyp');
    const moov = find(top, 'moov');
    if (!moov) throw new Error(`${label}: в init-сегменте нет moov`);
    const inner = boxes(buf, moov.body, moov.end);
    const traks = inner.filter(b => b.type === 'trak');
    if (traks.length !== 1) throw new Error(`${label}: ожидалась одна дорожка, найдено ${traks.length}`);
    const mvex = find(inner, 'mvex');
    const trex = mvex && find(boxes(buf, mvex.body, mvex.end), 'trex');
    if (!trex) throw new Error(`${label}: в init-сегменте нет mvex/trex`);
    const mvhd = find(inner, 'mvhd');
    return {
        buf,
        ftyp: ftyp && buf.slice(ftyp.start, ftyp.end),
        mvhd: mvhd && buf.slice(mvhd.start, mvhd.end),
        trak: buf.slice(traks[0].start, traks[0].end),
        trex: buf.slice(trex.start, trex.end),
        // Остальное содержимое moov (udta, pssh…) берём только у видео.
        rest: inner.filter(b => !['mvhd', 'trak', 'mvex'].includes(b.type)).map(b => buf.slice(b.start, b.end))
    };
}

function fullBoxVersion(b) {
    return b[8];
}

/** Ставит track_ID в tkhd копии trak. */
function setTrakId(trak, id) {
    const out = trak.slice();
    const view = new DataView(out.buffer);
    const tkhd = find(boxes(out, 8), 'tkhd');
    if (!tkhd) throw new Error('в дорожке нет tkhd');
    view.setUint32(tkhd.body + (out[tkhd.body] === 1 ? 20 : 12), id);
    return out;
}

function setTrexId(trex, id) {
    const out = trex.slice();
    new DataView(out.buffer).setUint32(12, id);
    return out;
}

/** Timescale фильма из mvhd (для пересчёта edit list звука). */
function movieScale(mvhd) {
    const view = new DataView(mvhd.buffer, mvhd.byteOffset);
    return view.getUint32(8 + (fullBoxVersion(mvhd) === 1 ? 20 : 12));
}

/** Пересчитывает segment_duration в elst звука на timescale фильма видео. */
function rescaleEdits(trak, from, to) {
    if (from === to || !from) return trak;
    const out = trak.slice();
    const view = new DataView(out.buffer);
    const edts = find(boxes(out, 8), 'edts');
    const elst = edts && find(boxes(out, edts.body, edts.end), 'elst');
    if (!elst) return out;
    const v = out[elst.body];
    const count = view.getUint32(elst.body + 4);
    let p = elst.body + 8;
    for (let i = 0; i < count; i++) {
        if (v === 1) {
            view.setBigUint64(p, BigInt(Math.round(Number(view.getBigUint64(p)) * to / from)));
            p += 20;
        } else {
            view.setUint32(p, Math.round(view.getUint32(p) * to / from));
            p += 12;
        }
    }
    return out;
}

/**
 * Собирает общий init-сегмент из init-сегментов видео и звука.
 * @param {Uint8Array} videoInit
 * @param {Uint8Array} audioInit
 * @returns {Uint8Array}
 */
export function mergeInits(videoInit, audioInit) {
    const v = parseInit(videoInit, 'видео');
    const a = parseInit(audioInit, 'звук');
    if (!v.mvhd) throw new Error('видео: в init-сегменте нет mvhd');

    const mvhd = v.mvhd.slice();
    // next_track_ID — последнее поле mvhd.
    new DataView(mvhd.buffer).setUint32(mvhd.byteLength - 4, AUDIO_ID + 1);
    const audioTrak = rescaleEdits(setTrakId(a.trak, AUDIO_ID), a.mvhd ? movieScale(a.mvhd) : 0, movieScale(v.mvhd));

    const moov = box('moov',
        mvhd,
        setTrakId(v.trak, VIDEO_ID),
        audioTrak,
        box('mvex', setTrexId(v.trex, VIDEO_ID), setTrexId(a.trex, AUDIO_ID)),
        ...v.rest);
    return v.ftyp ? concat([v.ftyp, moov]) : moov;
}

function concat(parts) {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.byteLength, 0));
    let pos = 0;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.byteLength;
    }
    return out;
}

/**
 * FileWriter-обёртка: принимает init-сегменты и фрагменты двух дорожек и пишет
 * в out единый MP4.
 */
export class TrackMerger {
    /** @param {import('./output.js').FileWriter} out */
    constructor(out) {
        this.out = out;
        this.sequence = 0;
        this.writeAt = out.writeAt ? (pos, data) => out.writeAt(pos, data) : undefined;
    }

    /** @param {Uint8Array} videoInit @param {Uint8Array} audioInit */
    async writeInits(videoInit, audioInit) {
        await this.out.write(mergeInits(videoInit, audioInit));
    }

    /**
     * @param {Uint8Array} chunk - Медиасегмент (один или несколько moof+mdat).
     * @param {'video'|'audio'} track
     */
    async write(chunk, track = 'video') {
        await this.out.write(this.rewrite(chunk, track === 'audio' ? AUDIO_ID : VIDEO_ID));
    }

    /** Копия сегмента с новым track_ID и номерами фрагментов, без styp/sidx. */
    rewrite(chunk, trackId) {
        const parts = [];
        for (const b of boxes(chunk)) {
            if (DROP_TOP.has(b.type)) continue;
            const part = chunk.slice(b.start, b.end);
            if (b.type === 'moof') {
                const view = new DataView(part.buffer);
                const shift = -b.start;
                for (const c of boxes(chunk, b.body, b.end)) {
                    if (c.type === 'mfhd') view.setUint32(c.body + shift + 4, ++this.sequence);
                    if (c.type !== 'traf') continue;
                    const tfhd = find(boxes(chunk, c.body, c.end), 'tfhd');
                    if (!tfhd) continue;
                    if (view.getUint32(tfhd.body + shift) & 0x1)
                        throw new Error('фрагмент с base-data-offset: сведение дорожек не поддерживается');
                    view.setUint32(tfhd.body + shift + 4, trackId);
                }
            }
            parts.push(part);
        }
        return concat(parts);
    }

    close() {
        return this.out.close();
    }

    abort() {
        return this.out.abort();
    }
}
