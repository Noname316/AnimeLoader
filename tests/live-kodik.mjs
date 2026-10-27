// Живая проверка Kodik: ссылки → плейлист → N сегментов → MP4 через mux.js.
// Запуск: node tests/live-kodik.mjs [iframeUrl] [segments] [out.mp4]
import './setup.mjs';
import fs from 'node:fs';
import { resolveKodik } from '../js/providers/kodik.js';
import { loadMediaPlaylist } from '../js/playlist.js';
import { TsToMp4Writer } from '../js/output.js';

const iframe = process.argv[2] || '//kodikplayer.com/season/118101/92dab1925ec6360204780702aa772d42/720p?translations=false&only_episode=true&only_season=true&episode=1';
const count = Number(process.argv[3] || 15);
const outFile = process.argv[4] || 'kodik-test.mp4';

const src = await resolveKodik(iframe, { siteOrigin: 'https://old.yummyani.me', log: console.log });
console.log('variants:', src.variants.map(v => `${v.quality}: ${v.urls[0].slice(0, 90)}…`));
const pl = await loadMediaPlaylist(src.variants[0].urls[0], async u => (await fetch(u)).text());
console.log(`playlist: ${pl.segments.length} segs, ${pl.duration.toFixed(1)}s, container=${pl.container}`);

const fd = fs.openSync(outFile, 'w');
const writer = new TsToMp4Writer({
    async write(c) { fs.writeSync(fd, c); },
    async close() { fs.closeSync(fd); },
    async abort() { fs.closeSync(fd); }
});
for (const seg of pl.segments.slice(0, count)) {
    const res = await fetch(seg.url);
    if (!res.ok) throw new Error(`seg ${seg.index}: HTTP ${res.status}`);
    await writer.write(new Uint8Array(await res.arrayBuffer()));
}
await writer.close();

const bytes = new Uint8Array(fs.readFileSync(outFile));
const boxes = muxjs.mp4.tools.inspect(bytes);
console.log('top boxes:', boxes.map(b => b.type).join(' ').slice(0, 300));
const moov = boxes.find(b => b.type === 'moov');
const traks = moov.boxes.filter(b => b.type === 'trak');
console.log('tracks:', traks.map(t => {
    const hdlr = JSON.stringify(t).match(/"handlerType":"(\w+)"/)?.[1];
    return hdlr;
}).join(', '));
// Непрерывность времени: baseMediaDecodeTime по фрагментам для каждого трека
const tfdts = {};
for (const moof of boxes.filter(b => b.type === 'moof')) {
    for (const traf of moof.boxes.filter(b => b.type === 'traf')) {
        const tfhd = traf.boxes.find(b => b.type === 'tfhd');
        const tfdt = traf.boxes.find(b => b.type === 'tfdt');
        (tfdts[tfhd.trackId] ??= []).push(Number(tfdt.baseMediaDecodeTime));
    }
}
console.log('tfdt per track (first 6):', Object.fromEntries(Object.entries(tfdts).map(([k, v]) => [k, v.slice(0, 6)])));
console.log('size:', bytes.length);
