// Генерирует значки расширения icons/icon{16,32,48,128}.png (сейчас стоит вариант letter).
// Запуск: node tests/make-icons.mjs [вариант] [папка]   (по умолчанию — вариант letter, папка icons/)
// node tests/make-icons.mjs --preview <файл.png> — лист сравнения всех вариантов.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// --- PNG ----------------------------------------------------------------------

function crc32(buf) {
    let crc = 0xffffffff;
    for (const b of buf) {
        let c = (crc ^ b) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

/** @param {number} w @param {number} h @param {Uint8Array} rgba */
function encodePng(w, h, rgba) {
    const raw = Buffer.alloc(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0;
        rgba.subarray(y * w * 4, (y + 1) * w * 4).forEach((v, i) => { raw[y * (w * 4 + 1) + 1 + i] = v; });
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
    ]);
}

/** Рисует значок size×size: shade(u, v) → [r, g, b, a] в координатах 0…1, сглаживание 4×4. */
function render(size, shade) {
    const out = new Uint8Array(size * size * 4);
    const S = 4;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let sy = 0; sy < S; sy++) {
                for (let sx = 0; sx < S; sx++) {
                    const p = shade((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size, size);
                    r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
                }
            }
            const o = (y * size + x) * 4;
            out[o] = a ? Math.round(r / a) : 0;
            out[o + 1] = a ? Math.round(g / a) : 0;
            out[o + 2] = a ? Math.round(b / a) : 0;
            out[o + 3] = Math.round((a / (S * S)) * 255);
        }
    }
    return out;
}

// --- Фигуры -------------------------------------------------------------------

const rgb = hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 1];
const mix = (c1, c2, t) => c1.map((v, i) => v + (c2[i] - v) * Math.min(1, Math.max(0, t)));
const NONE = [0, 0, 0, 0];

function inRoundRect(u, v, x0, y0, x1, y1, r) {
    if (u < x0 || u > x1 || v < y0 || v > y1) return false;
    const dx = Math.max(x0 + r - u, 0, u - (x1 - r));
    const dy = Math.max(y0 + r - v, 0, v - (y1 - r));
    return dx * dx + dy * dy <= r * r;
}

function inCircle(u, v, cx, cy, r) {
    return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
}

/** Точка внутри многоугольника (чётность пересечений). */
function inPolygon(u, v, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/** Стрелка вниз с «полкой» (значок загрузки) в квадрате cx±s. */
function inDownload(u, v, cx, cy, s, { tray = true } = {}) {
    const stem = Math.abs(u - cx) < s * 0.17 && v > cy - s * 0.85 && v < cy + 0.1 * s;
    const head = inPolygon(u, v, [[cx - s * 0.55, cy - s * 0.1], [cx + s * 0.55, cy - s * 0.1], [cx, cy + s * 0.5]]);
    const bar = tray && inRoundRect(u, v, cx - s * 0.7, cy + s * 0.68, cx + s * 0.7, cy + s * 0.9, s * 0.1);
    return stem || head || bar;
}

// --- Варианты -----------------------------------------------------------------

const ORANGE_TOP = rgb('#ffad33');
const ORANGE_BOTTOM = rgb('#f07400');
const DARK_TOP = rgb('#3a3a3e');
const DARK_BOTTOM = rgb('#1b1b1d');
const WHITE = rgb('#ffffff');
const ORANGE = rgb('#ff9100');
const RED_TOP = rgb('#ff5a4a');
const RED_BOTTOM = rgb('#b3001b');

/**
 * Буква «А»: силуэт с вырезом под перекладиной и треугольное окно над ней.
 * Ножки толщиной ~0.13, внутренние края параллельны внешним.
 */
const LETTER_A = [[0.43, 0.2], [0.57, 0.2], [0.76, 0.8], [0.62, 0.8], [0.58, 0.67], [0.42, 0.67], [0.38, 0.8], [0.24, 0.8]];
const LETTER_A_HOLE = [[0.5, 0.405], [0.551, 0.565], [0.449, 0.565]];

/** Штриховая рамка: сплошные углы, по сторонам — штрихи (на 16 px — по два узких разрыва). */
function inDashedFrame(u, v, size) {
    const w = size >= 48 ? 0.06 : size >= 32 ? 0.08 : 0.1;
    const [x0, y0, x1, y1, r] = [0.06, 0.06, 0.94, 0.94, 0.16];
    if (!inRoundRect(u, v, x0, y0, x1, y1, r) || inRoundRect(u, v, x0 + w, y0 + w, x1 - w, y1 - w, Math.max(0, r - w))) return false;
    // Координата вдоль стороны: для верхней/нижней — u, для боковых — v.
    const nearHorizontal = Math.min(v - y0, y1 - v) < Math.min(u - x0, x1 - u);
    const t = nearHorizontal ? u : v;
    if (t < 0.27 || t > 0.73) return true;
    if (size < 32) {
        const d = Math.abs(t - 0.5);
        return d < 0.08 || d > 0.15;
    }
    // Штрихи 0.07 через 0.05, симметрично от центра стороны.
    const k = ((Math.abs(t - 0.5) + 0.035) % 0.12);
    return k < 0.07;
}

const VARIANTS = {
    /** Белый квадрат, красная штриховая рамка и красная буква «А» с градиентом. */
    letter(u, v, size) {
        if (!inRoundRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.2)) return NONE;
        if (inDashedFrame(u, v, size)) return mix(RED_TOP, RED_BOTTOM, (u + v) / 2);
        // На 16 px буква чуть меньше — иначе сливается с рамкой.
        const k = size >= 32 ? 1 : 0.92;
        const lu = 0.5 + (u - 0.5) / k, lv = 0.5 + (v - 0.5) / k;
        if (inPolygon(lu, lv, LETTER_A) && !inPolygon(lu, lv, LETTER_A_HOLE)) return mix(RED_TOP, RED_BOTTOM, (lv - 0.2) / 0.6);
        return WHITE;
    },

    /** Тёмный квадрат с кадрами плёнки по бокам и оранжевой стрелкой загрузки. */
    film(u, v, size) {
        if (!inRoundRect(u, v, 0.03, 0.03, 0.97, 0.97, 0.2)) return NONE;
        const bg = mix(DARK_TOP, DARK_BOTTOM, v);
        // Перфорация плёнки: на 16 px её не видно — там только стрелка.
        if (size >= 32) {
            for (const x of [0.12, 0.88]) {
                for (let i = 0; i < 4; i++) {
                    const y = 0.22 + i * 0.19;
                    if (inRoundRect(u, v, x - 0.045, y - 0.045, x + 0.045, y + 0.045, 0.018)) return mix(ORANGE_TOP, ORANGE_BOTTOM, v);
                }
            }
        }
        const s = size >= 32 ? 0.3 : 0.38;
        if (inDownload(u, v, 0.5, 0.48, s)) return mix(ORANGE_TOP, ORANGE_BOTTOM, v);
        return bg;
    },

    /** Оранжевый круг: белый «плей», под ним — полка загрузки. */
    play(u, v) {
        if (!inCircle(u, v, 0.5, 0.5, 0.47)) return NONE;
        const bg = mix(ORANGE_TOP, ORANGE_BOTTOM, v);
        if (inPolygon(u, v, [[0.38, 0.24], [0.38, 0.64], [0.7, 0.44]])) return WHITE;
        if (inRoundRect(u, v, 0.28, 0.72, 0.72, 0.8, 0.04)) return WHITE;
        return bg;
    },

    /** Тёмный квадрат, оранжевый «плей» и белый значок загрузки в углу. */
    badge(u, v, size) {
        if (!inRoundRect(u, v, 0.03, 0.03, 0.97, 0.97, 0.22)) return NONE;
        const bg = mix(DARK_TOP, DARK_BOTTOM, v);
        // Значок загрузки на оранжевом кружке (с тёмной обводкой).
        const bx = 0.7, by = 0.7, br = size >= 32 ? 0.24 : 0.27;
        if (inCircle(u, v, bx, by, br + 0.04)) {
            if (!inCircle(u, v, bx, by, br)) return bg;
            if (inDownload(u, v, bx, by - 0.01, br * 0.62)) return WHITE;
            return mix(ORANGE_TOP, ORANGE_BOTTOM, (v - (by - br)) / (2 * br));
        }
        if (inPolygon(u, v, [[0.2, 0.16], [0.2, 0.62], [0.6, 0.39]])) return mix(ORANGE_TOP, ORANGE_BOTTOM, v);
        return bg;
    }
};

// --- Запуск -------------------------------------------------------------------

const SIZES = [16, 32, 48, 128];
const args = process.argv.slice(2);

if (args[0] === '--preview') {
    // Лист сравнения: строка на вариант, значки 128/48/32/16 на тёмном и светлом фоне.
    const names = Object.keys(VARIANTS);
    const cell = 150, W = cell * 2 + 260, H = names.length * cell;
    const sheet = new Uint8Array(W * H * 4);
    const fill = (x0, y0, w, h, c) => {
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) sheet.set(c, (y * W + x) * 4);
    };
    fill(0, 0, W / 2, H, [37, 37, 39, 255]);
    fill(W / 2, 0, W / 2, H, [240, 240, 240, 255]);
    const blit = (img, size, x0, y0) => {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const s = (y * size + x) * 4, d = ((y0 + y) * W + x0 + x) * 4, a = img[s + 3] / 255;
                for (let i = 0; i < 3; i++) sheet[d + i] = Math.round(img[s + i] * a + sheet[d + i] * (1 - a));
            }
        }
    };
    names.forEach((name, row) => {
        const y = row * cell + 11;
        for (const half of [0, W / 2]) {
            let x = half + 10;
            for (const size of [128, 48, 32, 16]) {
                blit(render(size, VARIANTS[name]), size, x, y + (128 - size) / 2);
                x += size + 14;
            }
        }
    });
    fs.writeFileSync(args[1], encodePng(W, H, sheet));
    console.log(`варианты (сверху вниз): ${names.join(', ')}`);
} else {
    const name = args[0] || 'letter';
    const shade = VARIANTS[name];
    if (!shade) throw new Error(`нет варианта ${name}; есть: ${Object.keys(VARIANTS).join(', ')}`);
    const dir = args[1] || new URL('../icons/', import.meta.url);
    for (const size of SIZES) fs.writeFileSync(path.join(fileURLToPathSafe(dir), `icon${size}.png`), encodePng(size, size, render(size, shade)));
    console.log(`значки «${name}» записаны`);
}

function fileURLToPathSafe(p) {
    return p instanceof URL ? decodeURIComponent(p.pathname.replace(/^\/([A-Za-z]:)/, '$1')) : p;
}
