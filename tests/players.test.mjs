// Тесты CVH, AniBoom, AnimeGO, сведения дорожек fMP4 и загрузки файлов по частям.
import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { findCvhVideo, parseCvhIframe, parseCvhPage, parseCvhSources } from '../js/providers/cvh.js';
import { parseAniboomPage } from '../js/providers/aniboom.js';
import {
    groupAnimego, parseAnimegoEpisodes, parseAnimegoTitle, parseAnimegoUrl, parseAnimegoVideos, parseEpisodePages
} from '../js/sites/animego.js';
import { detectSite } from '../js/sites/index.js';
import { interleaveTracks, loadFileAsSegments, loadMediaPlaylist } from '../js/playlist.js';
import { mergeInits, TrackMerger } from '../js/fmp4-merge.js';
import { downloadHls } from '../js/hls-download.js';
import { Pacer } from '../js/pacer.js';
import { Mp4DurationFixer } from '../js/mp4-fix.js';

// --- CVH ----------------------------------------------------------------------

test('CVH: адреса iframe YummyAnime и AnimeGO', () => {
    assert.deepEqual(parseCvhIframe('https://ru.yummyani.me/iframeCVH.html?dubbing_code=AnilibriaTV&anime_id=55644&episode=3&dubbing=x'),
        { titleId: '55644', season: null, episode: '3', voice: 'AnilibriaTV', publisher: 745, aggregator: 'mali' });
    assert.deepEqual(parseCvhIframe('https://animego.me/cdn-iframe/64534/2/1?dubbing=SHIZA%20Project'),
        { titleId: '64534', season: 2, episode: '1', voice: 'SHIZA Project', publisher: 747, aggregator: 'mali' });
    // Фильм: ни сезона, ни серии.
    assert.deepEqual(parseCvhIframe('https://animego.me/cdn-iframe/35851?dubbing=Reanimedia'),
        { titleId: '35851', season: null, episode: '1', voice: 'Reanimedia', publisher: 747, aggregator: 'mali' });
    assert.equal(findCvhVideo([{ vkId: '9', voiceStudio: 'Reanimedia', voiceType: 'Дубляж' }], { episode: '1', season: null, voice: 'Reanimedia' }).vkId, '9');
    // Неизвестный сайт — параметры берутся со страницы iframe.
    assert.equal(parseCvhIframe('https://other.site/cdn-iframe/1/1/1').publisher, null);
    assert.deepEqual(parseCvhPage('<video-player id="p" data-title-id="64534" data-publisher-id="747" data-aggregator="mali">'),
        { titleId: '64534', publisher: 747, aggregator: 'mali' });
    assert.throws(() => parseCvhIframe('https://ru.yummyani.me/iframeCVH.html?dubbing_code=x'));
});

test('CVH: поиск серии и озвучки в плейлисте, качества', () => {
    const items = [
        { vkId: '1', voiceStudio: 'AnilibriaTV', voiceType: 'Многоголосый', season: 3, episode: 1 },
        { vkId: '2', voiceStudio: 'SHIZA Project', voiceType: 'Многоголосый', season: 3, episode: 1 },
        { vkId: '3', voiceType: 'Субтитры', season: 3, episode: 1 },
        { vkId: '4', voiceStudio: 'AnilibriaTV', season: 3, episode: 2 },
        { vkId: '5', voiceStudio: 'AnilibriaTV', season: 1, episode: 2 }
    ];
    assert.equal(findCvhVideo(items, { episode: '1', voice: 'AnilibriaTV' }).vkId, '1');
    assert.equal(findCvhVideo(items, { episode: '1', voice: 'shiza project' }).vkId, '2');
    assert.equal(findCvhVideo(items, { episode: '1', voice: 'Субтитры' }).vkId, '3');
    assert.equal(findCvhVideo(items, { episode: '2', season: 1, voice: 'AnilibriaTV' }).vkId, '5');
    assert.equal(findCvhVideo(items, { episode: '2', voice: 'AniDub' }), null);

    const variants = parseCvhSources({ mpegFullHdUrl: 'https://c/1080', mpegHighUrl: 'https://c/720', mpegQhdUrl: '', mpegLowUrl: 'https://c/360' });
    assert.deepEqual(variants.map(v => [v.quality, v.kind]), [[1080, 'file'], [720, 'file'], [360, 'file']]);
});

// --- AniBoom ------------------------------------------------------------------

test('AniBoom: ссылки из data-parameters', () => {
    const params = {
        id: 'X', hls: JSON.stringify({ src: 'https://cdn.test/er/X/master.m3u8', type: 'application/x-mpegURL' }),
        dash: JSON.stringify({ src: 'https://cdn.test/er/X/a.mpd' }), fallbackHls: 'null', qualityVideo: 1080, duration: 1488
    };
    const html = `<div id="video" data-parameters="${JSON.stringify(params).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div>`;
    assert.deepEqual(parseAniboomPage(html), {
        hls: 'https://cdn.test/er/X/master.m3u8', dash: 'https://cdn.test/er/X/a.mpd', fallbackHls: null, quality: 1080, duration: 1488
    });
    assert.throws(() => parseAniboomPage('<html>Not found</html>'), /data-parameters/);
});

// --- AnimeGO ------------------------------------------------------------------

test('AnimeGO: адрес, карточка, серии и плееры', () => {
    assert.deepEqual(parseAnimegoUrl('https://animego.me/anime/ledyanaya-stena-2-3814?x=1'),
        { origin: 'https://animego.me', slug: 'ledyanaya-stena-2', id: '3814', url: 'https://animego.me/anime/ledyanaya-stena-2-3814' });
    assert.equal(parseAnimegoUrl('https://animego.me/anime'), null);
    assert.equal(detectSite('https://animego.me/anime/x-1').site.id, 'animego');
    assert.equal(detectSite('https://old.yummyani.me/catalog/item/x').site.id, 'yummy');
    assert.equal(detectSite('https://example.com/'), null);

    const page = `<script type="application/ld+json">{"@type":"TVSeries","name":"Ледяная стена 2","image":"https://img/p.jpg","description":"Описание"}</script><h1>Другое</h1>`;
    assert.deepEqual(parseAnimegoTitle(page, 'slug'), {
        title: 'Ледяная стена 2', description: 'Описание', poster: 'https://img/p.jpg', year: null,
        typeName: 'Сериал', isSeries: true, episodesTotal: null
    });

    const player = `<div class="player-video" data-anime-player-episodes-pages-value="&#x5B;&#x7B;&quot;page&quot;&#x3A;0,&quot;count&quot;&#x3A;2&#x7D;,&#x7B;&quot;page&quot;&#x3A;1,&quot;count&quot;&#x3A;1&#x7D;&#x5D;">
        <div class="item"
             data-episode-number="1"
             data-episode="48832" data-anime-player-episodes-target="episode">1</div>
        <div class="item" data-episode-number="2" data-episode="54510">2</div>
        <div class="item" data-episode-number="2" data-episode="54510">дубль</div></div>`;
    assert.deepEqual(parseAnimegoEpisodes(player), [{ number: '1', id: '48832' }, { number: '2', id: '54510' }]);
    assert.deepEqual(parseEpisodePages(player).map(p => p.page), [0, 1]);

    const videos = `<button type="button"
        data-player="//animego.me/cdn-iframe/64534/2/2?dubbing=AniLiberty"
        data-provider="26" data-provider-slug="cvh" data-translation-title="AniLiberty">CVH</button>
        <button data-player="//kodikplayer.com/seria/1/a/720p?translations=false&amp;min_age=16" data-provider-slug="kodik" data-translation-title="ТО Дубляжная">Kodik</button>
        <button data-player="//vk.example/x" data-provider-slug="vk" data-translation-title="X">VK</button>`;
    const list = parseAnimegoVideos(videos);
    assert.deepEqual(list[1], { player: 'kodik', dub: 'ТО Дубляжная', iframeUrl: 'https://kodikplayer.com/seria/1/a/720p?translations=false&min_age=16' });

    const grouped = groupAnimego([{ number: '2', videos: list }, { number: '1', videos: list.slice(0, 1) }]);
    assert.deepEqual(grouped.map(p => p.id), ['kodik', 'cvh']);
    assert.deepEqual(grouped[1].dubs[0].episodes.map(e => e.number), ['1', '2']);
});

// --- Плейлисты: отдельный звук и файлы по частям -------------------------------

test('HLS: отдельная аудиодорожка и общий порядок сегментов', async () => {
    const files = {
        'https://c.test/master.m3u8': '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="ru",DEFAULT=YES,URI="audio.m3u8"\n' +
            '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,AUDIO="a"\nv720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1920x1080,AUDIO="a"\nv1080.m3u8\n',
        'https://c.test/v720.m3u8': '#EXTM3U\n#EXT-X-MAP:URI="vi.mp4"\n#EXTINF:4,\nv1.m4s\n#EXTINF:4,\nv2.m4s\n#EXT-X-ENDLIST\n',
        'https://c.test/audio.m3u8': '#EXTM3U\n#EXT-X-MAP:URI="ai.mp4"\n#EXTINF:3.9,\na1.m4s\n#EXTINF:4.1,\na2.m4s\n#EXT-X-ENDLIST\n'
    };
    const pl = await loadMediaPlaylist('https://c.test/master.m3u8', async u => files[u], { maxHeight: 720 });
    assert.equal(pl.resolution, '1280x720');
    assert.equal(pl.audio.init.url, 'https://c.test/ai.mp4');
    const order = interleaveTracks(pl.segments, pl.audio.segments);
    assert.deepEqual(order.map(s => `${s.track[0]}${s.url.slice(-6, -4)}`), ['vv1', 'aa1', 'aa2', 'vv2']);
    assert.deepEqual(order.map(s => s.index), [0, 1, 2, 3]);

    // TS со звуком отдельно не сводим — понятная ошибка.
    files['https://c.test/v720.m3u8'] = '#EXTM3U\n#EXTINF:4,\nv1.ts\n#EXT-X-ENDLIST\n';
    await assert.rejects(loadMediaPlaylist('https://c.test/master.m3u8', async u => files[u], { maxHeight: 720 }), /fMP4/);
});

test('Файл по частям: размер из Content-Range, сервер без Range', async () => {
    const ok = await loadFileAsSegments('https://c.test/v.mp4', async () =>
        new Response('x', { status: 206, headers: { 'Content-Range': 'bytes 0-0/25' } }), 10);
    assert.equal(ok.container, 'mp4');
    assert.equal(ok.size, 25);
    assert.deepEqual(ok.segments.map(s => [s.byterange.offset, s.byterange.length]), [[0, 10], [10, 10], [20, 5]]);

    const whole = await loadFileAsSegments('https://c.test/v.mp4', async () =>
        new Response('abc', { status: 200, headers: { 'Content-Length': '3' } }), 10);
    assert.equal(whole.segments.length, 1);
    assert.equal(whole.segments[0].byterange, null);
});

test('Загрузка файла по частям: порядок, обновление устаревшей ссылки', async () => {
    const data = Uint8Array.from({ length: 50 }, (_, i) => i);
    let session = 0;
    const requests = [];
    globalThis.fetch = async (url, init = {}) => {
        const s = Number(/s(\d+)/.exec(String(url))[1]);
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(new Headers(init.headers).get('range'));
        requests.push(`${s}:${a}`);
        // Первая ссылка «протухает» с 30-го байта.
        if (s === 1 && Number(a) >= 30) return new Response('', { status: 403 });
        const body = data.slice(Number(a), Math.min(Number(b), data.length - 1) + 1);
        return new Response(body, { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${data.length}` } });
    };
    const chunks = [];
    const result = await downloadHls({
        resolve: async () => ({ variants: [{ quality: 720, urls: [`https://c.test/s${++session}/v.mp4`], kind: 'file' }], headers: {} }),
        maxHeight: Infinity,
        openOutput: async ({ container }) => {
            assert.equal(container, 'mp4');
            return { async write(c) { chunks.push(...c); }, async close() {}, async abort() {} };
        },
        pacer: new Pacer({ concurrency: 1, delayMs: 0 }),
        policy: { maxResolves: 3, cooldownsMs: [10] },
        signal: new AbortController().signal,
        log: () => {},
        onProgress: () => {},
        onWait: () => {},
        fileChunk: 10
    });
    assert.deepEqual(chunks, [...data]);
    assert.equal(result.segments, 5);
    assert.equal(session, 2);
    // По второй ссылке — только недокачанные части.
    assert.deepEqual(requests.filter(r => r.startsWith('2:') && r !== '2:0'), ['2:30', '2:40']);
});

// --- Сведение дорожек fMP4 ------------------------------------------------------

function box(type, ...parts) {
    const body = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(8 + body);
    new DataView(out.buffer).setUint32(0, 8 + body);
    out.set([...type].map(c => c.charCodeAt(0)), 4);
    let pos = 8;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
}
const u32 = (...v) => { const b = new Uint8Array(v.length * 4); v.forEach((x, i) => new DataView(b.buffer).setUint32(i * 4, x)); return b; };
const full = (type, version, flags, ...rest) => box(type, u32((version << 24) | flags), ...rest);

/** init-сегмент одной дорожки (track_ID = 1) с заданным timescale и обработчиком. */
function makeInit(scale, handler) {
    const mvhd = full('mvhd', 0, 0, u32(0, 0, 1000, 0), new Uint8Array(76), u32(2));
    const tkhd = full('tkhd', 0, 3, u32(0, 0, 1, 0, 0), new Uint8Array(60));
    const mdhd = full('mdhd', 0, 0, u32(0, 0, scale, 0), new Uint8Array(4));
    const hdlr = full('hdlr', 0, 0, u32(0), new Uint8Array([...handler].map(c => c.charCodeAt(0))), new Uint8Array(13));
    const trak = box('trak', tkhd, box('mdia', mdhd, hdlr));
    const trex = full('trex', 0, 0, u32(1, 1, 0, 0, 0));
    return new Uint8Array([...box('ftyp', new Uint8Array(8)), ...box('moov', mvhd, trak, box('mvex', trex))]);
}

/** Фрагмент: moof (mfhd, traf: tfhd + tfdt + trun с длительностями) + mdat. */
function makeFragment(seq, base, durations) {
    const tfhd = full('tfhd', 0, 0x20000, u32(1));
    const tfdt = full('tfdt', 0, 0, u32(base));
    const trun = full('trun', 0, 0x100, u32(durations.length, ...durations));
    const moof = box('moof', full('mfhd', 0, 0, u32(seq)), box('traf', tfhd, tfdt, trun));
    return new Uint8Array([...box('styp', new Uint8Array(8)), ...box('sidx', new Uint8Array(24)), ...moof, ...box('mdat', new Uint8Array([seq]))]);
}

function topBoxes(buf) {
    const out = [];
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let p = 0; p < buf.length; p += v.getUint32(p)) out.push(String.fromCharCode(...buf.subarray(p + 4, p + 8)));
    return out;
}

test('fMP4: сведение видео и звука в один файл', async () => {
    const merged = mergeInits(makeInit(90000, 'vide'), makeInit(48000, 'soun'));
    const mp4 = muxjs.mp4.tools.inspect(merged);
    const moov = mp4.find(b => b.type === 'moov');
    assert.deepEqual(moov.boxes.filter(b => b.type === 'trak').map(t => t.boxes[0].trackId), [1, 2]);
    assert.deepEqual(moov.boxes.find(b => b.type === 'mvex').boxes.map(b => b.trackId), [1, 2]);
    assert.equal(moov.boxes.find(b => b.type === 'mvhd').nextTrackId, 3);

    const chunks = [];
    const file = {
        async write(c) { chunks.push(c); },
        async writeAt(pos, c) { chunks.push({ pos, c }); },
        async close() {}, async abort() {}
    };
    const merger = new TrackMerger(new Mp4DurationFixer(file));
    await merger.writeInits(makeInit(90000, 'vide'), makeInit(48000, 'soun'));
    await merger.write(makeFragment(1, 0, [3600, 3600]), 'video');
    await merger.write(makeFragment(1, 0, [1024, 1024, 1024]), 'audio');
    await merger.write(makeFragment(2, 7200, [3600]), 'video');
    await merger.close();

    const frag = chunks[1];
    assert.deepEqual(topBoxes(frag), ['moof', 'mdat']); // styp и sidx выброшены
    const frags = chunks.slice(1, 4).map(c => muxjs.mp4.tools.inspect(c)[0]);
    assert.deepEqual(frags.map(m => m.boxes[0].sequenceNumber), [1, 2, 3]);
    assert.deepEqual(frags.map(m => m.boxes[1].boxes[0].trackId), [1, 2, 1]);

    // Длительность дописана в общий init: видео 10800/90000 = 0,12 с, звук 3072/48000 = 0,064 с.
    const patch = chunks.find(c => c.pos === 0);
    const patched = muxjs.mp4.tools.inspect(patch.c).find(b => b.type === 'moov');
    assert.equal(patched.boxes.find(b => b.type === 'mvhd').duration, 120);
    assert.throws(() => mergeInits(makeInit(1, 'vide'), new Uint8Array(box('ftyp'))), /moov/);
});
