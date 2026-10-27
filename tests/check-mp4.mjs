// Проверка фрагментированного MP4: непрерывность времени по каждому треку.
// Запуск: node tests/check-mp4.mjs file.mp4
import './setup.mjs';
import fs from 'node:fs';

const bytes = new Uint8Array(fs.readFileSync(process.argv[2]));
const boxes = muxjs.mp4.tools.inspect(bytes);
const moov = boxes.find(b => b.type === 'moov');
const scales = {};
for (const trak of moov.boxes.filter(b => b.type === 'trak')) {
    const tkhd = trak.boxes.find(b => b.type === 'tkhd');
    const mdhd = trak.boxes.find(b => b.type === 'mdia').boxes.find(b => b.type === 'mdhd');
    scales[tkhd.trackId] = mdhd.timescale;
}
const tracks = {};
for (const moof of boxes.filter(b => b.type === 'moof')) {
    for (const traf of moof.boxes.filter(b => b.type === 'traf')) {
        const id = traf.boxes.find(b => b.type === 'tfhd').trackId;
        const tfhd = traf.boxes.find(b => b.type === 'tfhd');
        const start = Number(traf.boxes.find(b => b.type === 'tfdt').baseMediaDecodeTime);
        const trun = traf.boxes.find(b => b.type === 'trun');
        const dur = trun.samples.reduce((s, x) => s + (x.duration ?? tfhd.defaultSampleDuration ?? 0), 0);
        (tracks[id] ??= []).push({ start, dur, n: trun.samples.length });
    }
}
for (const [id, frags] of Object.entries(tracks)) {
    let gaps = 0, maxGap = 0;
    for (let i = 1; i < frags.length; i++) {
        const gap = frags[i].start - (frags[i - 1].start + frags[i - 1].dur);
        if (gap !== 0) { gaps++; maxGap = Math.max(maxGap, Math.abs(gap)); }
    }
    const last = frags[frags.length - 1];
    console.log(`track ${id}: ${frags.length} frags, end=${((last.start + last.dur) / scales[id]).toFixed(3)}s, ` +
        `discontinuities=${gaps} (max ${(maxGap / scales[id] * 1000).toFixed(1)} ms)`);
}
