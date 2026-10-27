/**
 * Окно загрузчика: выбор серий, озвучки, качества и папки, запуск загрузки,
 * прогресс и отладочная информация.
 */

import { detectSite, SITES } from './sites/index.js';
import { RESOLVERS } from './providers/index.js';
import { downloadHls } from './hls-download.js';
import { Pacer } from './pacer.js';
import { resetRules } from './net-rules.js';
import { DirectoryTarget, DownloadsTarget, showDownload, TsToMp4Writer } from './output.js';
import { Mp4DurationFixer } from './mp4-fix.js';
import {
    DEFAULTS, ensureWritable, loadDirectory, loadSettings, saveDirectory, saveSettings, supportsDirectoryPicker
} from './settings.js';
import { formatBytes, formatDuration, isAbort, padEpisode, sanitizeFileName, sleep } from './util.js';

const $ = id => document.getElementById(id);

const state = {
    site: null,          // { site, ctx } — сайт и разобранный адрес тайтла (ctx.origin — адрес сайта)
    anime: null,
    players: [],
    settings: null,
    dirHandle: null,
    lastDownloadId: null, // последний файл в «Загрузках» — для кнопки «Открыть папку»
    job: null            // текущая загрузка
};

// --- Журнал -------------------------------------------------------------------

const logLines = [];
let warnings = 0;

function log(text, level = 'info') {
    const time = new Date().toLocaleTimeString('ru-RU');
    logLines.push(`[${time}] ${level === 'info' ? '' : `${level.toUpperCase()}: `}${text}`);
    if (level === 'warn' || level === 'error') $('stWarnings').textContent = String(++warnings);

    const row = document.createElement('div');
    row.className = `log-row ${level}`;
    const t = document.createElement('time');
    t.textContent = time;
    row.append(t, text);
    const box = $('log');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 20;
    box.append(row);
    while (box.childElementCount > 500) box.firstElementChild.remove();
    if (atBottom) box.scrollTop = box.scrollHeight;
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)('[AnimeLoader]', text);
}

function showMessage(text, kind = '') {
    const el = $('message');
    el.textContent = text;
    el.className = `message ${kind}`;
    el.classList.toggle('hidden', !text);
}

function setStatus(text, kind = '') {
    const el = $('status');
    el.textContent = text;
    el.className = kind;
}

// --- Загрузка данных тайтла ----------------------------------------------------

async function init() {
    state.settings = await loadSettings();
    bindUi();

    const params = new URLSearchParams(location.search);
    const pageUrl = params.get('url') || '';
    state.site = detectSite(pageUrl);
    if (!state.site) {
        showMessage(`Откройте страницу аниме на ${SITES.map(s => s.name).join(' или ')} ` +
            '(например, …/catalog/item/название или …/anime/название-123) и нажмите на значок расширения ещё раз.');
        log(`Страница не поддерживается: ${pageUrl || '(нет адреса)'}`, 'warn');
        return;
    }

    await resetRules().catch(e => log(`Не удалось сбросить правила заголовков: ${e.message}`, 'warn'));
    setupDirectoryUi();

    setStatus('Загружаю данные тайтла…');
    try {
        const { anime, players } = await state.site.site.load(state.site.ctx, { onProgress: setStatus, log });
        state.anime = anime;
        state.players = players;
        renderTitle();
    } catch (e) {
        setStatus('');
        showMessage(`Не удалось получить данные с сайта: ${e.message}`, 'error');
        log(e.message, 'error');
        return;
    }
    setStatus('');

    if (!state.players.length) {
        showMessage(`На ${state.site.site.name} у этого тайтла нет серий в поддерживаемых плеерах (${supportedPlayers()}).`, 'error');
        return;
    }
    const counts = state.players.map(p => `${p.name}: ${p.dubs.length} озв.`).join(', ');
    log(`${state.site.site.name}: «${state.anime.title}» (id ${state.anime.id}); ${counts}`);

    fillPlayers();
    $('form').classList.remove('hidden');
}

function renderTitle() {
    const a = state.anime;
    document.title = `${a.title} — AnimeLoader`;
    $('title').textContent = a.title;
    $('meta').textContent = [a.typeName, a.year, a.episodesTotal ? `${a.episodesTotal} сер.` : ''].filter(Boolean).join(' · ');
    if (a.poster) $('poster').src = a.poster;
    else $('poster').classList.add('hidden');
    $('titleCard').classList.remove('hidden');
}

// --- Форма ---------------------------------------------------------------------

function fillPlayers() {
    const sel = $('playerSelect');
    sel.replaceChildren(...state.players.map(p => new Option(
        `${p.name} (${p.dubs.length} ${plural(p.dubs.length, 'озвучка', 'озвучки', 'озвучек')})`, p.id
    )));
    sel.value = state.players.some(p => p.id === state.settings.player) ? state.settings.player : state.players[0].id;
    $('qualitySelect').value = state.settings.quality;
    $('folderCheckbox').checked = state.settings.createFolder;
    fillDubs();
}

function currentPlayer() {
    return state.players.find(p => p.id === $('playerSelect').value) || state.players[0];
}

function currentDub() {
    const player = currentPlayer();
    return player.dubs[Number($('dubSelect').value)] || player.dubs[0];
}

function fillDubs() {
    const player = currentPlayer();
    const sel = $('dubSelect');
    sel.replaceChildren(...player.dubs.map((d, i) => new Option(`${d.name} — ${d.episodes.length} сер.`, String(i))));
    const remembered = player.dubs.findIndex(d => d.name === state.settings.dub);
    sel.value = String(Math.max(0, remembered));
    fillEpisodes();
}

function fillEpisodes() {
    const eps = currentDub().episodes;
    const from = $('fromSelect');
    const to = $('toSelect');
    const options = () => eps.map((e, i) => new Option(`Серия ${e.number}`, String(i)));
    from.replaceChildren(...options());
    to.replaceChildren(...options());
    from.value = '0';
    to.value = String(eps.length - 1);
    $('rangeBox').classList.toggle('hidden', eps.length < 2);
    updateInfo();
}

function selectedEpisodes() {
    const eps = currentDub().episodes;
    let a = Number($('fromSelect').value) || 0;
    let b = Number($('toSelect').value) || 0;
    if (a > b) [a, b] = [b, a];
    return eps.slice(a, b + 1);
}

function updateInfo() {
    if (!state.anime || !state.players.length) return;
    const eps = selectedEpisodes();
    const panel = $('infoPanel');
    const rows = [
        ['Будет скачано', eps.length === 1 ? `серия ${eps[0].number}` : `${eps.length} ${plural(eps.length, 'серия', 'серии', 'серий')}`],
        ['Озвучка', `${currentDub().name} (${currentPlayer().name})`],
        ['Папка', describeTarget()]
    ];
    const duration = eps.reduce((s, e) => s + (e.duration || 0), 0);
    if (duration) rows.push(['Длительность', formatDuration(duration)]);
    panel.replaceChildren(...rows.map(([k, v]) => {
        const row = document.createElement('div');
        row.className = 'info-row';
        const a = document.createElement('span');
        a.textContent = k;
        const b = document.createElement('span');
        b.textContent = v;
        row.append(a, b);
        return row;
    }));
}

/** Сохранять в папку, выбранную через File System Access (иначе — в «Загрузки»). */
function useFolderPicker() {
    return supportsDirectoryPicker() && $('saveModeSelect').value === 'folder';
}

function describeTarget() {
    const folder = $('folderCheckbox').checked ? `/${sanitizeFileName(state.anime?.title || '', 'anime')}` : '';
    if (useFolderPicker()) return state.dirHandle ? `${state.dirHandle.name}${folder}` : 'не выбрана';
    const sub = $('subfolderInput').value.trim();
    return `Загрузки${sub ? `/${sub}` : ''}${folder}`;
}

// --- Папка ---------------------------------------------------------------------

async function setupDirectoryUi() {
    $('subfolderInput').value = state.settings.subfolder || '';
    if (!supportsDirectoryPicker()) {
        // Без File System Access (Firefox) — только «Загрузки».
        $('saveModeRow').classList.add('hidden');
        $('saveModeSelect').value = 'downloads';
    } else {
        $('saveModeSelect').value = state.settings.saveMode === 'downloads' ? 'downloads' : 'folder';
        state.dirHandle = await loadDirectory();
    }
    renderSaveMode();
}

function renderSaveMode() {
    const folder = useFolderPicker();
    $('dirPicker').classList.toggle('hidden', !folder);
    $('dirFallback').classList.toggle('hidden', folder);
    renderDirName();
}

function renderDirName() {
    const el = $('dirName');
    el.textContent = state.dirHandle ? state.dirHandle.name : 'не выбрана';
    el.title = state.dirHandle ? state.dirHandle.name : '';
    el.classList.toggle('unset', !state.dirHandle);
    updateInfo();
}

async function pickDirectory() {
    try {
        const handle = await globalThis.showDirectoryPicker({ id: 'animeloader', mode: 'readwrite' });
        state.dirHandle = handle;
        await saveDirectory(handle);
        renderDirName();
        log(`Папка назначения: ${handle.name}`);
        return true;
    } catch (e) {
        if (e?.name !== 'AbortError') showMessage(`Не удалось выбрать папку: ${e.message}`, 'error');
        return false;
    }
}

/** Папка для сохранения; вызывается из обработчика клика (нужен жест пользователя). */
async function prepareTarget() {
    let target;
    if (useFolderPicker()) {
        if (!state.dirHandle && !(await pickDirectory())) return null;
        if (!(await ensureWritable(state.dirHandle, true))) {
            showMessage('Нет разрешения на запись в выбранную папку. Выберите папку заново.', 'error');
            return null;
        }
        target = new DirectoryTarget(state.dirHandle);
    } else {
        target = new DownloadsTarget($('subfolderInput').value.trim());
    }
    if ($('folderCheckbox').checked) target = await target.subfolder(state.anime.title);
    return target;
}

// --- Загрузка ------------------------------------------------------------------

async function startDownload() {
    if (state.job) return;
    showMessage('');
    const player = currentPlayer();
    const dub = currentDub();
    const episodes = selectedEpisodes();
    if (!episodes.length) return;

    let target;
    try {
        target = await prepareTarget();
    } catch (e) {
        showMessage(`Не удалось подготовить папку: ${e.message}`, 'error');
        return;
    }
    if (!target) return;

    const quality = $('qualitySelect').value;
    await saveSettings({
        player: player.id,
        dub: dub.name,
        quality,
        createFolder: $('folderCheckbox').checked,
        saveMode: $('saveModeSelect').value,
        subfolder: $('subfolderInput').value.trim()
    });
    state.settings = await loadSettings();

    const pace = state.settings.pace[player.id];
    const job = {
        controller: new AbortController(),
        pacer: new Pacer(pace),
        startedAt: Date.now(),
        total: episodes.length,
        done: 0,
        failed: [],
        skipped: 0,
        bytes: 0,
        episodeBytes: 0,
        seg: { done: 0, total: 0 },
        speedSamples: [],
        waitUntil: 0,
        paused: false
    };
    state.job = job;
    setRunning(true);
    const ticker = setInterval(renderStats, 500);
    log(`Старт: ${episodes.length} сер., ${player.name} / ${dub.name}, качество ${quality === 'max' ? 'макс.' : `${quality}p`}, ` +
        `папка «${target.describe()}», темп ${pace.concurrency} потока(ов) / ${pace.delayMs} мс` +
        (pace.perLink ? ` / новая ссылка каждые ${pace.perLink} сегм.` : ''));

    const single = currentDub().episodes.length < 2;
    try {
        let loadedPrevious = false;
        for (const [i, ep] of episodes.entries()) {
            if (job.controller.signal.aborted) break;
            // Пауза между сериями — чтобы не идти к CDN сплошным потоком (важно для Alloha).
            const pause = state.settings.episodePauseSec[player.id] || 0;
            if (loadedPrevious && pause) {
                setStatus(`Пауза между сериями: ${pause} с`);
                await sleep(pause * 1000, job.controller.signal);
            }
            loadedPrevious = await downloadEpisode({ job, ep, index: i, player, dub, target, quality, single });
        }
    } catch (e) {
        if (!isAbort(e)) log(e.message, 'error');
    } finally {
        clearInterval(ticker);
        renderStats(true);
        finishJob(job);
    }
}

/** @returns {Promise<boolean>} Была ли работа с сервером (false — серия уже скачана). */
async function downloadEpisode({ job, ep, index, player, dub, target, quality, single }) {
    const { signal } = job.controller;
    const baseName = single
        ? `${state.anime.title} [${dub.name}]`
        : `${state.anime.title} - ${padEpisode(ep.number)} [${dub.name}]`;
    const safeBase = sanitizeFileName(baseName);
    const label = single ? state.anime.title : `Серия ${ep.number}`;

    for (const ext of ['mp4', 'ts']) {
        if (await target.exists(`${safeBase}.${ext}`)) {
            log(`${label}: файл «${safeBase}.${ext}» уже есть — пропускаю`);
            rememberDownload(target);
            job.skipped++;
            job.done++;
            renderTotalProgress();
            return false;
        }
    }

    $('epLabel').textContent = `${label} (${index + 1} из ${job.total})`;
    setEpisodeProgress(0, 0);
    job.seg = { done: 0, total: 0 };
    job.episodeBytes = 0;
    setStatus(`${label}: получаю ссылку на видео…`);
    log(`${label}: начинаю`);

    const resolve = () => {
        setStatus(`${label}: получаю ссылку на видео…`);
        return RESOLVERS[player.id](ep.iframeUrl, { siteOrigin: state.site.ctx.origin, signal, log: m => log(`${label}: ${m}`) });
    };

    let fileName = '';
    let remux = false;
    let unit = 'сегментов';
    const started = Date.now();
    try {
        const result = await downloadHls({
            resolve,
            maxHeight: quality === 'max' ? Infinity : Number(quality),
            pacer: job.pacer,
            segmentsPerLink: state.settings.pace[player.id].perLink,
            signal,
            log: (m, level) => log(`${label}: ${m}`, level),
            policy: { maxResolves: 6, cooldownsMs: state.settings.cooldownMin.map(m => m * 60000) },
            openOutput: async ({ container }) => {
                const asTs = container === 'ts' && state.settings.tsFormat === 'ts';
                fileName = `${safeBase}.${asTs ? 'ts' : 'mp4'}`;
                remux = container === 'ts' && !asTs;
                const file = await target.createFile(fileName);
                // Готовый MP4-файл (CVH) пишется как есть.
                if (container === 'mp4') unit = 'частей';
                if (asTs || container === 'mp4') return file;
                const mp4 = new Mp4DurationFixer(file);
                return remux ? new TsToMp4Writer(mp4) : mp4;
            },
            onProgress: ({ done, total, bytes }) => {
                job.seg = { done, total };
                job.bytes += bytes - job.episodeBytes;
                job.episodeBytes = bytes;
                job.speedSamples.push([Date.now(), job.bytes]);
                setEpisodeProgress(done, total);
                if (done === total && remux) setStatus(`${label}: перепаковываю в MP4…`);
                else if (!job.paused && Date.now() >= job.waitUntil) setStatus(`${label}: ${done} из ${total} ${unit}`);
            },
            onWait: (ms, reason) => {
                job.waitUntil = Date.now() + ms;
                job.waitReason = reason;
            }
        });
        job.done++;
        rememberDownload(target);
        const links = result.rotations ? `, ссылок: ${result.rotations + 1}` : '';
        log(`${label}: готово — «${fileName}», ${formatBytes(result.bytes)}, ${result.quality}p, ${formatDuration((Date.now() - started) / 1000)}${links}`, 'ok');
    } catch (e) {
        if (isAbort(e)) throw e;
        job.failed.push(ep.number);
        job.done++;
        log(`${label}: ошибка — ${e.message}`, 'error');
    }
    renderTotalProgress();
    return true;
}

/** Запоминает файл, сохранённый через «Загрузки», и показывает «Открыть папку». */
function rememberDownload(target) {
    if (target.lastDownloadId == null) return;
    state.lastDownloadId = target.lastDownloadId;
    $('openFolderBtn').classList.remove('hidden');
}

async function openFolder() {
    if (state.lastDownloadId == null) return;
    try {
        await showDownload(state.lastDownloadId);
    } catch (e) {
        showMessage(`Не удалось открыть папку: ${e.message}`, 'error');
    }
}

function finishJob(job) {
    state.job = null;
    setRunning(false);
    const ok = job.done - job.failed.length - job.skipped;
    const elapsed = formatDuration((Date.now() - job.startedAt) / 1000);
    if (job.controller.signal.aborted) {
        setStatus(`Остановлено. Скачано: ${ok} из ${job.total}`, 'warn');
        log(`Загрузка остановлена пользователем (${elapsed})`, 'warn');
    } else if (job.failed.length) {
        setStatus(`Готово с ошибками: скачано ${ok}, не удалось ${job.failed.length} (серии ${job.failed.join(', ')})`, 'error');
        log(`Завершено с ошибками за ${elapsed}`, 'warn');
    } else {
        const skipped = job.skipped ? `, пропущено (уже были): ${job.skipped}` : '';
        setStatus(`Готово: скачано ${ok} из ${job.total}${skipped}, ${formatBytes(job.bytes)} за ${elapsed}`, 'ok');
        log(`Всё скачано за ${elapsed}`, 'ok');
    }
}

function setRunning(running) {
    for (const id of ['downloadBtn', 'playerSelect', 'dubSelect', 'qualitySelect', 'fromSelect', 'toSelect',
        'folderCheckbox', 'saveModeSelect', 'dirBtn', 'subfolderInput', 'settingsBtn']) $(id).disabled = running;
    $('progressBox').classList.toggle('hidden', !running && !$('totalProgress').value);
    $('controls').classList.toggle('hidden', !running);
    $('pauseBtn').textContent = 'Пауза';
    if (running) {
        $('totalProgress').value = 0;
        $('totalPercent').textContent = '';
        $('debug').open = true;
    }
}

function setEpisodeProgress(done, total) {
    const pct = total ? Math.floor((done / total) * 100) : 0;
    $('epProgress').value = pct;
    $('epPercent').textContent = total ? `${pct}%` : '';
    renderTotalProgress();
}

function renderTotalProgress() {
    const job = state.job;
    if (!job) return;
    const partial = job.seg.total ? job.seg.done / job.seg.total : 0;
    const pct = Math.min(100, Math.floor(((job.done + (job.done < job.total ? partial : 0)) / job.total) * 100));
    $('totalProgress').value = pct;
    $('totalPercent').textContent = `${job.done} из ${job.total} · ${pct}%`;
}

/** @param {boolean} [final] - Итог: скорость считается средней за всю загрузку. */
function renderStats(final = false) {
    const job = state.job;
    if (!job) return;
    const now = Date.now();
    $('stElapsed').textContent = formatDuration((now - job.startedAt) / 1000);
    $('stEpisodes').textContent = `${job.done} из ${job.total}${job.failed.length ? `, ошибок ${job.failed.length}` : ''}`;
    $('stSegments').textContent = job.seg.total ? `${job.seg.done} из ${job.seg.total}` : '—';
    $('stBytes').textContent = formatBytes(job.bytes);

    job.speedSamples = job.speedSamples.filter(([t]) => now - t < 8000);
    const [first] = job.speedSamples;
    const last = job.speedSamples[job.speedSamples.length - 1];
    const speed = final
        ? job.bytes / Math.max(1, (now - job.startedAt) / 1000)
        : first && last && last[0] > first[0] ? (last[1] - first[1]) / ((last[0] - first[0]) / 1000) : 0;
    $('stSpeed').textContent = speed ? `${formatBytes(speed)}/с${final ? ' (в среднем)' : ''}` : '—';
    $('stPace').textContent = job.pacer.describe();
    $('debugSummary').textContent = `${job.done}/${job.total} · ${formatBytes(job.bytes)}`;

    if (job.waitUntil > now && !job.paused) {
        setStatus(`${job.waitReason || 'Пауза'}: продолжу через ${formatDuration((job.waitUntil - now) / 1000)}`, 'warn');
    }
}

function togglePause() {
    const job = state.job;
    if (!job) return;
    job.paused = !job.paused;
    if (job.paused) {
        job.pacer.pause();
        setStatus('Пауза: текущие запросы завершатся, новые не начнутся');
        log('Пауза');
    } else {
        job.pacer.resume();
        setStatus('Продолжаю…');
        log('Продолжение');
    }
    $('pauseBtn').textContent = job.paused ? 'Продолжить' : 'Пауза';
}

function stop() {
    const job = state.job;
    if (!job) return;
    job.pacer.resume();
    job.controller.abort();
    setStatus('Останавливаю…');
}

// --- Настройки -----------------------------------------------------------------

/** Поле формы → [чтение из настроек плеера, запись с ограничениями]. */
const PLAYER_FIELDS = [
    ['setConc', (s, id) => s.pace[id].concurrency, (s, id, v) => { s.pace[id].concurrency = clamp(v, 1, 16); }],
    ['setDelay', (s, id) => s.pace[id].delayMs, (s, id, v) => { s.pace[id].delayMs = clamp(v, 0, 10000); }],
    ['setPerLink', (s, id) => s.pace[id].perLink, (s, id, v) => { s.pace[id].perLink = clamp(v, 0, 10000); }],
    ['setEpPause', (s, id) => s.episodePauseSec[id] ?? 0, (s, id, v) => { s.episodePauseSec[id] = clamp(v, 0, 600); }]
];

/** Черновик настроек, пока открыт экран настроек (переключение плеера не теряет правки). */
let draft = null;
let draftPlayer = 'kodik';

function readPlayerFields() {
    for (const [id, , set] of PLAYER_FIELDS) set(draft, draftPlayer, Number($(id).value));
}

function fillPlayerFields() {
    draftPlayer = $('setPlayer').value;
    for (const [id, get] of PLAYER_FIELDS) $(id).value = get(draft, draftPlayer);
}

function fillSettings(s) {
    draft = structuredClone(s);
    const current = currentPlayerId();
    if (current && draft.pace[current]) $('setPlayer').value = current;
    fillPlayerFields();
    $('setTsFormat').value = draft.tsFormat;
}

function currentPlayerId() {
    return state.players.length ? currentPlayer().id : null;
}

function toggleSettings(show = $('settingsView').classList.contains('hidden')) {
    if (show) fillSettings(state.settings);
    $('settingsView').classList.toggle('hidden', !show);
    $('mainView').classList.toggle('hidden', show);
    $('settingsBtn').classList.toggle('active', show);
}

async function saveSettingsForm(fromDefaults = false) {
    if (fromDefaults) {
        draft = structuredClone(DEFAULTS);
    } else {
        readPlayerFields();
        draft.tsFormat = $('setTsFormat').value;
    }
    await saveSettings({ pace: draft.pace, episodePauseSec: draft.episodePauseSec, tsFormat: draft.tsFormat });
    state.settings = await loadSettings();
    if (fromDefaults) fillSettings(state.settings);
    else toggleSettings(false);
    log('Настройки сохранены');
}

function supportedPlayers() {
    return [...$('setPlayer').options].map(o => o.textContent).join(', ');
}

// --- Связка с разметкой ------------------------------------------------------

function bindUi() {
    $('playerSelect').addEventListener('change', fillDubs);
    $('dubSelect').addEventListener('change', fillEpisodes);
    $('fromSelect').addEventListener('change', updateInfo);
    $('toSelect').addEventListener('change', updateInfo);
    $('folderCheckbox').addEventListener('change', updateInfo);
    $('subfolderInput').addEventListener('input', updateInfo);
    $('dirBtn').addEventListener('click', pickDirectory);
    $('saveModeSelect').addEventListener('change', renderSaveMode);
    $('openFolderBtn').addEventListener('click', openFolder);
    $('downloadBtn').addEventListener('click', startDownload);
    $('pauseBtn').addEventListener('click', togglePause);
    $('stopBtn').addEventListener('click', stop);
    $('settingsBtn').addEventListener('click', () => toggleSettings());
    $('setPlayer').addEventListener('change', () => {
        readPlayerFields();
        fillPlayerFields();
    });
    $('settingsSave').addEventListener('click', () => saveSettingsForm(false));
    $('settingsReset').addEventListener('click', () => saveSettingsForm(true));
    $('copyLogBtn').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(logLines.join('\n'));
            $('copyLogBtn').textContent = 'Скопировано';
            setTimeout(() => { $('copyLogBtn').textContent = 'Копировать'; }, 1500);
        } catch (e) {
            log(`Не удалось скопировать журнал: ${e.message}`, 'warn');
        }
    });
    window.addEventListener('beforeunload', e => {
        if (state.job) e.preventDefault();
    });
}

// --- Мелочи --------------------------------------------------------------------

function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
}

function clamp(v, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(v) ? Math.round(v) : min));
}

init().catch(e => {
    showMessage(`Ошибка инициализации: ${e.message}`, 'error');
    log(e.stack || e.message, 'error');
});
