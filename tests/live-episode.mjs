// Живая загрузка серии тем же конвейером, что и в расширении (заголовки — через эмуляцию DNR из setup.mjs).
// Запуск: node tests/live-episode.mjs <адрес тайтла> <плеер kodik|cvh|aniboom> <номер серии> <out-файл без расширения> [озвучка] [качество] [частей/сегментов]
// Alloha в Node не работает: ссылку отдаёт только настоящий плеер в iframe (проверяется в e2e.mjs).
import './setup.mjs';
import fs from 'node:fs';
import { detectSite } from '../js/sites/index.js';
import { RESOLVERS } from '../js/providers/index.js';
import { downloadHls } from '../js/hls-download.js';
import { Pacer } from '../js/pacer.js';
import { TsToMp4Writer } from '../js/output.js';
import { DEFAULTS } from '../js/settings.js';
import { Mp4DurationFixer } from '../js/mp4-fix.js';

const [pageUrl = 'https://old.yummyani.me/catalog/item/cugai-zagrobnogo-mira', playerId = 'kodik', number = '1', out = 'episode', dubName, quality = 'max', limit] = process.argv.slice(2);
const found = detectSite(pageUrl);
if (!found) throw new Error(`сайт не поддерживается: ${pageUrl}`);
const { anime, players } = await found.site.load(found.ctx, { log: console.log });
const player = players.find(p => p.id === playerId);
if (!player) throw new Error(`нет плеера ${playerId}; есть: ${players.map(p => p.id).join(', ')}`);
const dub = dubName ? player.dubs.find(d => d.name === dubName) : player.dubs[0];
if (!dub) throw new Error(`нет озвучки ${dubName}; есть: ${player.dubs.map(d => d.name).join(', ')}`);
const ep = dub.episodes.find(e => e.number === number);
if (!ep) throw new Error(`нет серии ${number}; есть: ${dub.episodes.map(e => e.number).join(', ')}`);
console.log(`${anime.title}: ${player.name} / ${dub.name} / серия ${ep.number}`);
const siteOrigin = new URL(pageUrl).origin;

// Ограничение числа сегментов — для быстрых проверок: прерываем загрузку и закрываем файл как есть.
const controller = new AbortController();
const started = Date.now();
let lastPct = -1;
let file = '';
let writer = null;
try {
    const result = await downloadHls({
        resolve: () => RESOLVERS[playerId](ep.iframeUrl, { siteOrigin, signal: controller.signal, log: console.log }),
        maxHeight: quality === 'max' ? Infinity : Number(quality),
        pacer: new Pacer(DEFAULTS.pace[playerId] || DEFAULTS.pace.kodik),
        segmentsPerLink: DEFAULTS.pace[playerId]?.perLink || 0,
        policy: { maxResolves: 6, cooldownsMs: [5000, 10000] },
        signal: controller.signal,
        log: (m, l) => console.log(l ? `[${l}] ${m}` : m),
        onProgress: ({ done, total }) => {
            const pct = Math.floor(done / total * 10) * 10;
            if (pct !== lastPct) { lastPct = pct; console.log(`  ${done}/${total}`); }
            if (limit && done >= Number(limit)) controller.abort();
        },
        onWait: ms => console.log(`  wait ${ms} ms`),
        openOutput: async ({ container }) => {
            file = `${out}.mp4`;
            const fd = fs.openSync(file, 'w');
            const w = {
                async write(c) { fs.writeSync(fd, c); },
                async writeAt(pos, c) { fs.writeSync(fd, c, 0, c.byteLength, pos); },
                async close() { fs.closeSync(fd); },
                async abort() { fs.closeSync(fd); }
            };
            if (container === 'mp4') return w;
            const mp4 = new Mp4DurationFixer(w);
            return writer = container === 'ts' ? new TsToMp4Writer(mp4) : mp4;
        }
    });
    console.log(`OK: ${file}, ${(result.bytes / 1048576).toFixed(1)} MB, ${result.quality}p, ${result.segments} частей/сегм., ` +
        `${((Date.now() - started) / 1000).toFixed(0)} s, rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
} catch (e) {
    if (!controller.signal.aborted) throw e;
    console.log(`Остановлено после ${limit} частей/сегм. (${((Date.now() - started) / 1000).toFixed(0)} s); файл ${file} неполный`);
    void writer;
}
