// Модульные тесты: node --test tests/
import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeKodikSrc, findEndpoint, parseKodikPage } from '../js/providers/kodik.js';
import { parseAllohaSources } from '../js/providers/alloha.js';
import { groupVideos, parseAnimeUrl } from '../js/sites/yummy.js';
import { loadMediaPlaylist } from '../js/playlist.js';
import { downloadHls, pickQuality } from '../js/hls-download.js';
import { Pacer } from '../js/pacer.js';
import { padEpisode, sanitizeFileName } from '../js/util.js';

test('Kodik: расшифровка src (реальный ответ, сдвиг 18)', () => {
    const src = 'Tg9rjO91HK5hj2fdHOVsjq5rj20dlFVtkvDejO9pHPUdUBJqWBI1UOUbUOY3WA00ULseTERsV2UbUrChUOG0Grk4UhNtT2UhHBkhVLIhVLo4WLlqVhtsHBseUrCfHOUeWLoeVuQeWrQeUrGfULMhULkdUhGeTu1eVLxwjPU6jENciEHtk3YcjBV1WI';
    const url = decodeKodikSrc(src);
    assert.match(url, /^https:\/\/cloud\.solodcdn\.com\/useruploads\/10b9050c-.*\/360\.mp4:hls:manifest\.m3u8$/);
});

test('Kodik: src с другим сдвигом и уже готовый адрес', () => {
    const plain = '//cdn.example.com/video/720.mp4:hls:manifest.m3u8';
    const b64 = Buffer.from(plain).toString('base64').replace(/=+$/, '');
    const shifted = b64.replace(/[a-zA-Z]/g, c => {
        const base = c <= 'Z' ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 5) % 26) + base);
    });
    assert.equal(decodeKodikSrc(shifted), `https:${plain}`);
    assert.equal(decodeKodikSrc(plain), `https:${plain}`);
    assert.equal(decodeKodikSrc('мусор'), null);
});

test('Kodik: параметры со страницы плеера и адрес выдачи из JS', () => {
    const html = `
        <script src="https://kodikplayer.com/assets/js/app.player_single.abc.js"></script>
        var urlParams = '{"d":"old.yummyani.me","d_sign":"s1","pd":"kodikplayer.com","pd_sign":"s2","ref":"https%3A%2F%2Fold.yummyani.me%2F","ref_sign":"s3","translations":false}';
        vInfo.type = 'seria'; vInfo.hash = '92dab'; vInfo.id = '1588790';`;
    const info = parseKodikPage(html);
    assert.deepEqual([info.type, info.hash, info.id], ['seria', '92dab', '1588790']);
    assert.deepEqual(info.params, {
        d: 'old.yummyani.me', d_sign: 's1', pd: 'kodikplayer.com', pd_sign: 's2',
        ref: 'https://old.yummyani.me/', ref_sign: 's3'
    });
    // Переменные страницы важнее urlParams.
    assert.equal(parseKodikPage(`${html} var ref = "https://x/";`).params.ref, 'https://x/');
    assert.equal(info.playerJs, 'https://kodikplayer.com/assets/js/app.player_single.abc.js');
    assert.equal(findEndpoint('foo;$.ajax({type:"POST",url:atob("L2Z0b3I="),cache:!1})'), '/ftor');
    assert.equal(findEndpoint('nothing here'), null);
});

test('YummyAnime: адрес страницы и группировка видео', () => {
    assert.deepEqual(parseAnimeUrl('https://old.yummyani.me/catalog/item/cugai-zagrobnogo-mira?x=1'),
        { origin: 'https://old.yummyani.me', slug: 'cugai-zagrobnogo-mira' });
    assert.equal(parseAnimeUrl('https://example.com/catalog/item/x'), null);
    assert.equal(parseAnimeUrl('https://old.yummyani.me/'), null);

    const v = (player, dubbing, number, url) => ({ data: { player, dubbing }, number, iframe_url: url, video_id: 1, duration: 1400 });
    const players = groupVideos([
        v('Плеер Kodik', 'Озвучка AniLibria', '2', '//kodik/2'),
        v('Плеер Kodik', 'Озвучка AniLibria', '10', '//kodik/10'),
        v('Плеер Kodik', 'Озвучка AniLibria', '1', '//kodik/1'),
        v('Плеер Kodik', 'Озвучка  G-Dub', '1', '//kodik/g1'),
        v('Плеер Alloha', 'Озвучка AniLibria', '1', '//alloha/1'),
        v('Плеер CVH', 'Озвучка AniLibria', '1', '//cvh/1'),
        v('Плеер Aksor', 'Озвучка AniLibria', '1', 'https://player.aksor.tv/video/x')
    ]);
    assert.deepEqual(players.map(p => p.id), ['kodik', 'alloha', 'cvh']);
    const kodik = players[0];
    assert.deepEqual(kodik.dubs.map(d => d.name), ['AniLibria', 'G-Dub']);
    assert.deepEqual(kodik.dubs[0].episodes.map(e => e.number), ['1', '2', '10']);
    assert.equal(kodik.dubs[0].episodes[0].iframeUrl, 'https://kodik/1');
});

test('Alloha: выбор дорожки и качеств', () => {
    const data = {
        hlsSource: [
            { label: '(Russian) AniLiberty', default: true, quality: { 360: 'https://a/360/master.m3u8 or https://b/360/master.m3u8', 1080: 'https://a/1080/master.m3u8' } },
            { label: '(Japanese) Original', quality: { 720: 'https://a/jp/master.m3u8' } }
        ]
    };
    const dub = parseAllohaSources(data);
    assert.equal(dub.label, '(Russian) AniLiberty');
    assert.deepEqual(dub.variants.map(v => v.quality), [1080, 360]);
    assert.deepEqual(dub.variants[1].urls, ['https://a/360/master.m3u8', 'https://b/360/master.m3u8']);
    assert.equal(parseAllohaSources(data, { preferOriginal: true }).label, '(Japanese) Original');
    assert.throws(() => parseAllohaSources({}), /нет потоков/);
});

test('Выбор качества', () => {
    const vs = [{ quality: 360 }, { quality: 1080 }, { quality: 720 }];
    assert.equal(pickQuality(vs, Infinity).quality, 1080);
    assert.equal(pickQuality(vs, 720).quality, 720);
    assert.equal(pickQuality(vs, 480).quality, 360);
    assert.equal(pickQuality(vs, 240).quality, 360);
});

test('Плейлисты: мастер → вариант, TS (Kodik) и fMP4 (Alloha)', async () => {
    const files = {
        'https://cdn/a/master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5,RESOLUTION=1920x1080\nhigh.m3u8\n',
        'https://cdn/a/high.m3u8': '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-MAP:URI="init-c1.mp4"\n#EXTINF:6.0,\nseg-1.m4s\n#EXTINF:5.5,\nseg-2.m4s\n#EXT-X-ENDLIST\n',
        'https://cdn/a/low.m3u8': '#EXTM3U\n#EXTINF:6.0,\nseg-1.m4s\n#EXT-X-ENDLIST\n',
        'https://cdn/k/720.mp4:hls:manifest.m3u8': '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:6.000,\n./720.mp4:hls:seg-1-v1-a1.ts\n#EXTINF:6.000,\n./720.mp4:hls:seg-2-v1-a1.ts\n#EXT-X-ENDLIST\n'
    };
    const fetchText = async u => {
        if (!(u in files)) throw new Error(`404 ${u}`);
        return files[u];
    };

    const a = await loadMediaPlaylist('https://cdn/a/master.m3u8', fetchText);
    assert.equal(a.container, 'fmp4');
    assert.equal(a.resolution, '1920x1080');
    assert.equal(a.init.url, 'https://cdn/a/init-c1.mp4');
    assert.deepEqual(a.segments.map(s => s.url), ['https://cdn/a/seg-1.m4s', 'https://cdn/a/seg-2.m4s']);
    assert.equal(a.duration, 11.5);

    const low = await loadMediaPlaylist('https://cdn/a/master.m3u8', fetchText, { maxHeight: 720 });
    assert.equal(low.resolution, '640x360');

    const k = await loadMediaPlaylist('https://cdn/k/720.mp4:hls:manifest.m3u8', fetchText);
    assert.equal(k.container, 'ts');
    assert.equal(k.segments[1].url, 'https://cdn/k/720.mp4:hls:seg-2-v1-a1.ts');

    await assert.rejects(loadMediaPlaylist('https://cdn/live.m3u8', async () => '#EXTM3U\n#EXTINF:6,\na.ts\n'), /трансляция/);
    await assert.rejects(loadMediaPlaylist('https://cdn/x.m3u8', async () => '<html>'), /не является HLS/);
});

test('Pacer: не больше N одновременно, замедление и восстановление', async () => {
    const pacer = new Pacer({ concurrency: 2, delayMs: 0 });
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
        await pacer.acquire();
        peak = Math.max(peak, ++active);
        await new Promise(r => setTimeout(r, 5));
        active--;
        pacer.release();
    }));
    assert.equal(peak, 2);

    pacer.slowDown();
    assert.equal(pacer.concurrency, 1);
    assert.equal(pacer.delayMs, 500);
    for (let i = 0; i < 40; i++) pacer.success();
    assert.equal(pacer.delayMs, 375);

    const ctrl = new AbortController();
    pacer.pause();
    const waiting = pacer.acquire(ctrl.signal);
    ctrl.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
});

/** Имитация CDN: сегменты seg-N.ts с содержимым [N], сценарий ошибок задаётся функцией. */
function mockCdn({ segments = 12, onSegment = () => null } = {}) {
    let session = 0;
    const log = [];
    globalThis.fetch = async url => {
        url = String(url);
        const m = /\/s(\d+)\/(.*)$/.exec(url);
        const [, sess, path] = m;
        if (path === 'index.m3u8') {
            let body = '#EXTM3U\n';
            for (let i = 1; i <= segments; i++) body += `#EXTINF:6,\nseg-${i}.ts\n`;
            return new Response(`${body}#EXT-X-ENDLIST\n`);
        }
        const n = Number(/seg-(\d+)/.exec(path)[1]);
        log.push(`${sess}:${n}`);
        const override = onSegment(Number(sess), n);
        if (override) return override;
        return new Response(new Uint8Array([n]));
    };
    return {
        log,
        resolve: async () => {
            session++;
            return { variants: [{ quality: 720, urls: [`https://cdn.test/s${session}/index.m3u8`] }], headers: {} };
        },
        get sessions() { return session; }
    };
}

function memoryWriter() {
    const chunks = [];
    return {
        chunks,
        closed: false,
        async write(c) { chunks.push(...c); },
        async close() { this.closed = true; },
        async abort() { this.aborted = true; }
    };
}

function runDownload(cdn, writer, extra = {}) {
    const waits = [];
    return downloadHls({
        resolve: cdn.resolve,
        maxHeight: Infinity,
        openOutput: async () => writer,
        pacer: new Pacer({ concurrency: 3, delayMs: 0 }),
        policy: { maxResolves: 5, cooldownsMs: [10, 10] },
        signal: new AbortController().signal,
        log: () => {},
        onProgress: () => {},
        onWait: ms => waits.push(ms),
        ...extra
    }).then(r => ({ ...r, waits }));
}

test('HLS: сегменты пишутся строго по порядку', async () => {
    const cdn = mockCdn({ onSegment: (s, n) => (n % 3 === 0 ? new Promise(r => setTimeout(() => r(new Response(new Uint8Array([n]))), 20)) : null) });
    const w = memoryWriter();
    const r = await runDownload(cdn, w);
    assert.deepEqual(w.chunks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(r.segments, 12);
    assert.ok(w.closed);
});

test('HLS: устаревшая ссылка — новые ссылки и продолжение с того же места', async () => {
    const cdn = mockCdn({ onSegment: (s, n) => (s === 1 && n >= 5 ? new Response('gone', { status: 410 }) : null) });
    const w = memoryWriter();
    await runDownload(cdn, w);
    assert.deepEqual(w.chunks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(cdn.sessions, 2);
    // Во второй сессии первые 4 сегмента повторно не качались.
    assert.ok(!cdn.log.some(x => /^2:[1-4]$/.test(x)));
});

test('HLS: блокировка (403 session_blocked) — пауза, замедление, продолжение', async () => {
    const blocked = () => new Response('', { status: 403, headers: { 'X-VD': 'session_blocked' } });
    const cdn = mockCdn({ onSegment: (s, n) => (s === 1 && n >= 7 ? blocked() : null) });
    const w = memoryWriter();
    const pacer = new Pacer({ concurrency: 4, delayMs: 0 });
    const r = await runDownload(cdn, w, { pacer });
    assert.deepEqual(w.chunks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.deepEqual(r.waits, [10]);
    assert.equal(pacer.concurrency, 2);
});

test('HLS: блокировка не снимается — ошибка, файл не сохраняется', async () => {
    const cdn = mockCdn({ onSegment: (s, n) => (n >= 3 ? new Response('', { status: 403, headers: { 'X-VD': 'session_blocked' } }) : null) });
    const w = memoryWriter();
    await assert.rejects(runDownload(cdn, w), /блокировка не снимается/);
    assert.ok(w.aborted);
    assert.ok(!w.closed);
});

test('HLS: 403 origin_mismatch — сразу понятная ошибка', async () => {
    const cdn = mockCdn({ onSegment: () => new Response('', { status: 403, headers: { 'X-VD': 'origin_mismatch' } }) });
    await assert.rejects(runDownload(cdn, memoryWriter()), /Origin/);
});

test('HLS: остановка пользователем', async () => {
    const ctrl = new AbortController();
    const cdn = mockCdn({ onSegment: (s, n) => { if (n === 4) ctrl.abort(); return null; } });
    const w = memoryWriter();
    await assert.rejects(runDownload(cdn, w, { signal: ctrl.signal }), { name: 'AbortError' });
    assert.ok(w.aborted);
});

test('Имена файлов', () => {
    assert.equal(sanitizeFileName('Re:Zero / Часть 2?'), 'Re_Zero _ Часть 2_');
    assert.equal(sanitizeFileName('  ...  '), 'video');
    assert.equal(padEpisode('1'), '01');
    assert.equal(padEpisode('12.5'), '12.5');
    assert.equal(padEpisode('123'), '123');
});

test('MP4: длительность прописывается в init-сегмент', async () => {
    const fs = await import('node:fs');
    // Фикстура — несколько склеенных TS-сегментов (например, из tests/live-kodik.mjs);
    // видео в репозиторий не кладём, поэтому путь задаётся переменной окружения.
    const raw = process.env.ANIMELOADER_TS_FIXTURE;
    if (!raw || !fs.existsSync(raw)) return;
    const { TsToMp4Writer } = await import('../js/output.js');
    const { Mp4DurationFixer } = await import('../js/mp4-fix.js');
    const parts = [];
    const sink = {
        async write(c) { parts.push(c.slice()); },
        async writeAt(pos, data) { let off = 0; for (const p of parts) { if (pos >= off && pos < off + p.byteLength) p.set(data, pos - off); off += p.byteLength; } },
        async close() {},
        async abort() {}
    };
    const w = new TsToMp4Writer(new Mp4DurationFixer(sink));
    await w.write(new Uint8Array(fs.readFileSync(raw)));
    await w.close();
    const boxes = muxjs.mp4.tools.inspect(parts[0]);
    const moov = boxes.find(b => b.type === 'moov');
    const mvhd = moov.boxes.find(b => b.type === 'mvhd');
    const seconds = mvhd.duration / mvhd.timescale;
    assert.ok(seconds > 1 && mvhd.duration < 0xfffffffe, `mvhd ${seconds}`);
    for (const trak of moov.boxes.filter(b => b.type === 'trak')) {
        const mdhd = trak.boxes.find(b => b.type === 'mdia').boxes.find(b => b.type === 'mdhd');
        assert.ok(Math.abs(mdhd.duration / mdhd.timescale - seconds) < 0.5);
    }
});

test('HLS: смена ссылки каждые N сегментов (Alloha)', async () => {
    const cdn = mockCdn({ segments: 25 });
    const w = memoryWriter();
    const r = await runDownload(cdn, w, { segmentsPerLink: 10 });
    assert.deepEqual(w.chunks, Array.from({ length: 25 }, (_, i) => i + 1));
    assert.equal(cdn.sessions, 3);
    assert.equal(r.rotations, 2);
    // По каждой ссылке — не больше 10 сегментов.
    for (const s of [1, 2, 3]) assert.ok(cdn.log.filter(x => x.startsWith(`${s}:`)).length <= 10);
});
