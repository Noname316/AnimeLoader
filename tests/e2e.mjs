// Сквозная проверка в настоящем Chrome: расширение загружается распакованным,
// окно загрузчика скачивает серию в OPFS (вместо системного диалога выбора папки).
//
// Запуск: node tests/e2e.mjs --player alloha --dub AniLibria --from 8 --to 8 --quality 720
// Нужны: puppeteer-core (npm i puppeteer-core) и установленный Chrome
// (путь можно задать переменной CHROME_PATH).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
    options: {
        url: { type: 'string', default: 'https://old.yummyani.me/catalog/item/cugai-zagrobnogo-mira' },
        player: { type: 'string', default: 'kodik' },
        dub: { type: 'string', default: '' },
        from: { type: 'string', default: '1' },
        to: { type: 'string', default: '1' },
        quality: { type: 'string', default: '720' },
        out: { type: 'string', default: '' },
        headful: { type: 'boolean', default: false },
        puppeteer: { type: 'string', default: process.env.PUPPETEER_PATH || 'puppeteer-core' },
        timeout: { type: 'string', default: '1800' },
        screenshots: { type: 'string', default: '' },
        // folder — выбранная папка (в тесте — OPFS), downloads — «Загрузки» браузера.
        save: { type: 'string', default: 'folder' }
    }
});

const { default: puppeteer } = await import(args.puppeteer);
const extPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'animeloader-e2e-'));
// «Загрузки» временного профиля — внутри него, а не в настоящей папке пользователя.
const downloadsDir = path.join(profile, 'downloads');
fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true }
}));

const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: !args.headful,
    userDataDir: profile,
    pipe: true,
    enableExtensions: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check']
});

try {
    const extId = await browser.installExtension(extPath);
    console.log('extension id:', extId);

    const page = await browser.newPage();
    await page.setViewport({ width: 400, height: 900 });
    if (args.screenshots) fs.mkdirSync(args.screenshots, { recursive: true });
    const shot = async name => {
        if (args.screenshots) await page.screenshot({ path: path.join(args.screenshots, `${name}.png`), fullPage: true });
    };
    page.on('console', m => { if (/AnimeLoader/.test(m.text())) console.log('  ', m.text()); });
    page.on('pageerror', e => console.log('PAGE ERROR', e.message));
    // Системный диалог выбора папки не автоматизировать — подменяем папкой OPFS.
    await page.evaluateOnNewDocument(() => {
        window.showDirectoryPicker = async () => navigator.storage.getDirectory();
    });

    const params = new URLSearchParams({ tabId: '0', url: args.url });
    await page.goto(`chrome-extension://${extId}/downloader.html?${params}`);
    await page.waitForSelector('#form:not(.hidden)', { timeout: 60000 });

    await page.select('#playerSelect', args.player);
    if (args.dub) {
        const idx = await page.$$eval('#dubSelect option', (opts, dub) => {
            const o = opts.find(x => x.textContent.startsWith(`${dub} —`));
            return o ? o.value : null;
        }, args.dub);
        if (idx == null) throw new Error(`озвучка «${args.dub}» не найдена`);
        await page.select('#dubSelect', idx);
    }
    const epIndex = n => page.$$eval('#fromSelect option', (opts, num) => opts.find(o => o.textContent === `Серия ${num}`)?.value, n);
    await page.select('#fromSelect', await epIndex(args.from));
    await page.select('#toSelect', await epIndex(args.to));
    await page.select('#qualitySelect', args.quality);
    await page.select('#saveModeSelect', args.save);
    console.log('info:', await page.$eval('#infoPanel', el => el.innerText.replace(/\n/g, ' | ')));
    // Постер грузится отдельно — ждём его (или ошибку), чтобы он попал на скриншот.
    const poster = await page.waitForFunction(() => {
        const img = document.getElementById('poster');
        return img.classList.contains('hidden') || (img.complete && img.src) ? { src: img.src, width: img.naturalWidth } : null;
    }, { timeout: 15000 }).then(h => h.jsonValue()).catch(() => ({ error: 'постер не загрузился за 15 с' }));
    console.log('постер:', poster);
    await shot('1-form');

    const runJob = async (shots = true) => {
        await page.click('#downloadBtn');
        const started = Date.now();
        let lastStatus = '';
        let shotTaken = !shots;
        for (;;) {
            await new Promise(r => setTimeout(r, 2000));
            const s = await page.evaluate(() => ({
                status: document.getElementById('status').textContent,
                running: document.getElementById('downloadBtn').disabled
            }));
            if (s.status !== lastStatus) { console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${s.status}`); lastStatus = s.status; }
            if (Date.now() - started > 6000 && !shotTaken) { shotTaken = true; await shot('2-progress'); }
            if (!s.running) {
                const message = await page.$eval('#message', m => m.textContent);
                if (message) console.log('сообщение:', message);
                return s.status;
            }
            if (Date.now() - started > Number(args.timeout) * 1000) throw new Error('таймаут');
        }
    };
    await runJob();

    await shot('3-done');
    await page.click('#settingsBtn');
    await shot('4-settings');
    await page.click('#settingsBtn');
    const log = await page.$$eval('#log .log-row', rows => rows.map(r => r.textContent));
    console.log('--- журнал ---\n' + log.join('\n'));

    if (args.save === 'downloads') await checkDownloads(page, runJob);
    else await checkFolder(page);
} finally {
    await browser.close();
    fs.rmSync(profile, { recursive: true, force: true });
}

/** Режим «Загрузки»: файлы в истории загрузок, кнопка «Открыть папку», воспроизведение, пропуск уже скачанного. */
async function checkDownloads(page, runJob) {
    const items = await page.evaluate(() => chrome.downloads.search({ state: 'complete' })
        .then(list => list.map(d => ({ id: d.id, filename: d.filename, size: d.fileSize, exists: d.exists }))));
    console.log('загрузки:', items);
    if (!items.length) throw new Error('в истории загрузок нет файлов');
    for (const d of items) if (!d.filename.startsWith(downloadsDir)) throw new Error(`файл сохранён не во временную папку: ${d.filename}`);
    const button = await page.$eval('#openFolderBtn', b => !b.classList.contains('hidden'));
    console.log('кнопка «Открыть папку» видна:', button);
    if (!button) throw new Error('кнопка «Открыть папку» не появилась');

    // Chrome сам открывает MP4 по file:// — проверяем воспроизведение там.
    const tab = await page.browser().newPage();
    for (const d of items) {
        await tab.goto(`file:///${d.filename.replace(/\\/g, '/')}`);
        const check = await tab.evaluate(async () => {
            const video = document.querySelector('video');
            video.muted = true;
            if (video.readyState < 1) await new Promise((resolve, reject) => {
                video.addEventListener('loadedmetadata', resolve, { once: true });
                video.addEventListener('error', () => reject(new Error(`video error ${video.error?.code}`)), { once: true });
                setTimeout(() => reject(new Error('timeout')), 20000);
            });
            video.currentTime = video.duration * 0.6;
            await new Promise(r => video.addEventListener('seeked', r, { once: true }));
            await video.play();
            await new Promise(r => setTimeout(r, 1500));
            return { duration: video.duration, height: video.videoHeight, playedTo: video.currentTime, audioBytes: video.webkitAudioDecodedByteCount };
        }).catch(e => ({ error: e.message }));
        console.log('проверка', path.basename(d.filename), check);
    }
    await tab.close();

    // Повторный запуск: серии уже есть в «Загрузках» — должны пропуститься.
    const status = await runJob(false);
    const skipped = await page.$$eval('#log .log-row', rows => rows.filter(r => /уже есть — пропускаю/.test(r.textContent)).length);
    console.log(`повторный запуск: ${status}; пропущено: ${skipped}`);
    if (!skipped) throw new Error('уже скачанные серии не пропущены');
}

/** Режим папки (в тесте — OPFS): файлы, воспроизведение, копия первого файла в --out. */
async function checkFolder(page) {
    // Файлы из OPFS → на диск для проверки.
    const files = await page.evaluate(async () => {
        const out = [];
        async function walk(dir, prefix) {
            for await (const [name, h] of dir.entries()) {
                if (h.kind === 'directory') await walk(h, `${prefix}${name}/`);
                else {
                    const f = await h.getFile();
                    out.push({ name: prefix + name, size: f.size });
                }
            }
        }
        await walk(await navigator.storage.getDirectory(), '');
        return out;
    });
    console.log('файлы:', files);

    // Проверка, что файлы — рабочее видео: Chrome читает длительность, размер кадра и перематывает.
    for (const f of files) {
        const check = await page.evaluate(async name => {
            let dir = await navigator.storage.getDirectory();
            const parts = name.split('/');
            for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
            const file = await (await dir.getFileHandle(parts.at(-1))).getFile();
            const video = document.createElement('video');
            video.muted = true;
            video.src = URL.createObjectURL(file);
            const wait = ev => new Promise((resolve, reject) => {
                video.addEventListener(ev, resolve, { once: true });
                video.addEventListener('error', () => reject(new Error(`video error ${video.error?.code}: ${video.error?.message}`)), { once: true });
                setTimeout(() => reject(new Error(`timeout waiting ${ev}`)), 20000);
            });
            await wait('loadedmetadata');
            const res = { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
            video.currentTime = video.duration * 0.6;
            await wait('seeked');
            await video.play();
            await new Promise(r => setTimeout(r, 1500));
            res.playedTo = video.currentTime;
            res.decodedFrames = video.getVideoPlaybackQuality?.().totalVideoFrames;
            // Звук тоже декодируется (важно для сведённых дорожек AniBoom).
            res.audioBytes = video.webkitAudioDecodedByteCount;
            video.pause();
            URL.revokeObjectURL(video.src);
            return res;
        }, f.name).catch(e => ({ error: e.message }));
        console.log('проверка', f.name, check);
    }
    if (args.out && files.length) {
        const target = files[0].name;
        const b64 = await page.evaluate(async name => {
            let dir = await navigator.storage.getDirectory();
            const parts = name.split('/');
            for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
            const f = await (await dir.getFileHandle(parts.at(-1))).getFile();
            const buf = new Uint8Array(await f.arrayBuffer());
            let s = '';
            for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            return btoa(s);
        }, target);
        fs.writeFileSync(args.out, Buffer.from(b64, 'base64'));
        console.log('сохранено в', args.out);
    }
}
