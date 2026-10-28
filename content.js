/* ============================================================
 * SubLingo · 双语字幕   content.js   v3.0
 * ------------------------------------------------------------
 * 字幕来源（按优先级自动降级）：
 *   1) 站点 DOM 字幕（YouTube / Bilibili / Twitch / Kick / TikTok …）
 *   2) 通用探测（video.js、shaka、plyr、各站 caption 容器）
 *   3) <video>.textTracks 原生字幕轨道
 *   4) 本地 .srt / .vtt 字幕文件，按 currentTime 对齐
 * ============================================================ */
(() => {
    'use strict';
    if (window.__sublingoV3) return;
    window.__sublingoV3 = true;

    /* =========================================================
     * 1. 站点适配表
     * =======================================================*/
    const SITES = [
        {
            id: 'youtube', name: 'YouTube',
            re: /(^|\.)(youtube\.com|youtube-nocookie\.com)$/,
            roots: ['.ytp-caption-window-container'],
            segs: ['.ytp-caption-segment'],
            hide: ['.ytp-caption-window-container']
        },
        {
            id: 'bilibili', name: '哔哩哔哩',
            re: /(^|\.)(bilibili\.com|b23\.tv)$/,
            roots: ['.bpx-player-subtitle-panel', '.bilibili-player-video-subtitle', '.bpx-player-subtitle'],
            segs: ['.bpx-player-subtitle-panel-text', '.bilibili-player-video-subtitle span', '.bpx-player-subtitle-inner-text'],
            hide: ['.bpx-player-subtitle-panel', '.bilibili-player-video-subtitle']
        },
        {
            id: 'twitch', name: 'Twitch',
            re: /(^|\.)twitch\.tv$/,
            roots: ['.captions-container', '[data-a-target="player-overlay-captions"]', '.player-overlays .captions'],
            segs: ['.captions-text', '.Text-fragment'],
            hide: ['.captions-container']
        },
        {
            id: 'kick', name: 'Kick',
            re: /(^|\.)kick\.com$/,
            roots: ['.vjs-text-track-display', '.caption-window', '#video-player [class*="caption"]'],
            segs: ['.vjs-text-track-cue div', '.vjs-text-track-cue'],
            hide: ['.vjs-text-track-display']
        },
        {
            id: 'tiktok', name: 'TikTok',
            re: /(^|\.)tiktok\.com$/,
            roots: ['[class*="CaptionText"]', '[class*="caption-wrapper"]', '[class*="DivCaption"]'],
            segs: ['[class*="CaptionText"] span', '[class*="CaptionText"]'],
            hide: []
        },
        {
            id: 'vimeo', name: 'Vimeo', re: /(^|\.)vimeo\.com$/,
            roots: ['.vp-captions', '[class*="captions"]'], segs: ['[class*="caption"] span'], hide: ['.vp-captions']
        },
        {
            id: 'dailymotion', name: 'Dailymotion', re: /(^|\.)dailymotion\.com$/,
            roots: ['.dmp_Captions', '.dmp-Captions'], segs: ['.dmp_Captions span'], hide: ['.dmp_Captions']
        },
        {
            id: 'nicovideo', name: 'niconico', re: /(^|\.)(nicovideo\.jp|nico\.ms)$/,
            roots: ['.___video-layer___', '[class*="caption"]'], segs: [], hide: []
        },
        {
            id: 'iqiyi', name: '爱奇艺', re: /(^|\.)iqiyi\.com$/,
            roots: ['.iqp-player-subtitle', '[class*="subtitle"]'], segs: ['span'], hide: ['.iqp-player-subtitle']
        },
        {
            id: 'youku', name: '优酷', re: /(^|\.)youku\.com$/,
            roots: ['.youku-subtitle', '[class*="subtitle"]'], segs: [], hide: ['.youku-subtitle']
        },
        {
            id: 'x', name: 'X', re: /(^|\.)(twitter\.com|x\.com)$/,
            roots: ['[data-testid="caption"]', '[class*="caption"]'], segs: [], hide: []
        },
        {
            id: 'facebook', name: 'Facebook', re: /(^|\.)facebook\.com$/,
            roots: ['[class*="caption"]'], segs: [], hide: []
        },
        {
            id: 'coursera', name: 'Coursera', re: /(^|\.)coursera\.org$/, roots: ['.rc-VideoCaption'], segs: [], hide: ['.rc-VideoCaption']
        }
    ];

    const GENERIC_ROOTS = [
        '.vjs-text-track-display',
        '.shaka-text-container',
        '.plyr__captions',
        '[class*="caption-window"]',
        '[class*="captionWindow"]',
        '[class*="subtitle-panel"]',
        '[class*="subtitlePanel"]',
        '[class*="CaptionText"]',
        '[class*="subtitle-text"]',
        '[class*="subtitleText"]'
    ];

    const hostName = location.hostname.replace(/^www\./, '');
    const SITE = SITES.find(s => s.re.test(hostName)) || null;
    const ROOTS = SITE ? SITE.roots.concat(GENERIC_ROOTS) : GENERIC_ROOTS.slice();
    const SEGS = SITE ? (SITE.segs || []) : [];

    /* =========================================================
     * 2. 设置
     * =======================================================*/
    const DEFAULTS = {
        enabled: true,
        sourceLang: 'auto',
        targetLang: 'zh',
        fontSize: 100,
        lineCount: 2,
        debounceDelay: 420,
        fontColor: '#FFFFFF',
        bgColor: '#0B0B0D',
        bgOpacity: 62,
        showOriginal: true,
        position: null
    };

    let S = Object.assign({}, DEFAULTS);

    function normalize(raw) {
        const o = Object.assign({}, DEFAULTS);
        Object.keys(DEFAULTS).forEach(k => {
            if (raw && raw[k] !== undefined && raw[k] !== null) o[k] = raw[k];
        });
        // 兼容 v1 的旧键名
        if (raw && raw.isSubtitleEnabled !== undefined && raw.enabled === undefined) {
            o.enabled = !!raw.isSubtitleEnabled;
        }
        o.fontSize = clampNum(o.fontSize, 40, 300, 100);
        o.lineCount = clampNum(o.lineCount, 1, 6, 2);
        o.bgOpacity = clampNum(o.bgOpacity, 0, 100, 62);
        o.debounceDelay = clampNum(o.debounceDelay, 100, 2000, 420);
        o.enabled = !!o.enabled;
        o.showOriginal = !!o.showOriginal;
        if (o.position && (typeof o.position.x !== 'number' || typeof o.position.y !== 'number')) o.position = null;
        return o;
    }

    function clampNum(v, min, max, dft) {
        const n = Number(v);
        if (!isFinite(n)) return dft;
        return Math.min(max, Math.max(min, n));
    }

    function hexToRgba(hex, alpha) {
        let h = String(hex || '#000000').replace('#', '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        const r = parseInt(h.slice(0, 2), 16) || 0;
        const g = parseInt(h.slice(2, 4), 16) || 0;
        const b = parseInt(h.slice(4, 6), 16) || 0;
        return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
    }

    function getStorage() {
        return new Promise(resolve => {
            try {
                chrome.storage.sync.get(null, d => resolve(d || {}));
            } catch (e) { resolve({}); }
        });
    }

    function saveStorage(obj) {
        try { chrome.storage.sync.set(obj); } catch (e) { /* 忽略未知上下文 */ }
    }

    /* =========================================================
     * 3. 字幕浮层（Shadow DOM 隔离站点样式）
     * =======================================================*/
    const OVERLAY_CSS = `
        :host {
            --fg: #ffffff;
            --bg: rgba(0,0,0,.62);
            --bd: rgba(255,255,255,.12);
            --fs: 24px;
        }
        .card {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: .12em;
            padding: .34em .72em .38em;
            border-radius: .52em;
            background: var(--bg);
            border: 1px solid var(--bd);
            -webkit-backdrop-filter: blur(9px) saturate(1.15);
            backdrop-filter: blur(9px) saturate(1.15);
            box-shadow: 0 10px 30px -12px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
            box-sizing: border-box;
            max-width: 100%;
        }
        .main {
            width: 100%;
            text-align: center;
            color: var(--fg);
            font-size: var(--fs);
            font-weight: 650;
            line-height: 1.34;
            letter-spacing: .012em;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                         "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
            text-shadow: 0 1px 2px rgba(0,0,0,.55);
            white-space: pre-wrap;
            word-break: break-word;
            transition: opacity .18s ease;
        }
        .sub {
            width: 100%;
            text-align: center;
            color: var(--fg);
            opacity: .7;
            font-size: calc(var(--fs) * .68);
            font-weight: 500;
            line-height: 1.32;
            letter-spacing: .008em;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                         "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
            text-shadow: 0 1px 2px rgba(0,0,0,.5);
            white-space: pre-wrap;
            word-break: break-word;
        }
        .sub[hidden] { display: none; }
        .card.loading .main { opacity: .55; }
        .grip {
            position: absolute;
            top: .16em;
            right: .3em;
            font-size: 11px;
            line-height: 1;
            letter-spacing: -1px;
            color: var(--fg);
            opacity: 0;
            transition: opacity .18s ease;
            pointer-events: none;
            user-select: none;
        }
        .card { position: relative; }
        :host(.alt) .grip { opacity: .5; }
        :host(.alt) .card { outline: 1px dashed var(--bd); outline-offset: 2px; }
        .card.pop { animation: sl-pop .22s cubic-bezier(.2,.8,.3,1); }
        @keyframes sl-pop {
            from { opacity: .3; transform: translateY(4px) scale(.99); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
        }
    `;

    let hostEl = null;
    let shadow = null;
    let cardEl = null;
    let mainEl = null;
    let subEl = null;
    let hideStyleEl = null;

    function ensureOverlay() {
        if (hostEl && hostEl.isConnected) return;
        hostEl = document.createElement('div');
        hostEl.id = 'sublingo-root';
        hostEl.style.cssText =
            'all:initial;position:fixed;left:0;top:0;z-index:2147483647;' +
            'width:max-content;transform:translate(-50%,-50%);display:none;pointer-events:none;margin:0;';

        shadow = hostEl.attachShadow({ mode: 'open' });
        shadow.innerHTML =
            '<style>' + OVERLAY_CSS + '</style>' +
            '<div class="card" id="card">' +
            '<div class="main" id="main"></div>' +
            '<div class="sub" id="sub" hidden></div>' +
            '<div class="grip" aria-hidden="true">⋮⋮</div>' +
            '</div>';

        cardEl = shadow.getElementById('card');
        mainEl = shadow.getElementById('main');
        subEl = shadow.getElementById('sub');
        mountOverlay();
    }

    function mountOverlay() {
        if (!hostEl) return;
        const parent = document.fullscreenElement || document.body;
        if (parent && hostEl.parentNode !== parent) {
            parent.appendChild(hostEl);
            refreshMountBase();
            mountCalibrated = false;   // 等浮层可见后再精确校准一次
        }
    }

    /* 全屏容器可能带 transform，此时 fixed 的参考系不再是视口。
       这里探测一次：若父容器就是定位基准，用 absolute + 容器内坐标；否则退回 fixed。 */
    let mountBase = { left: 0, top: 0 };
    let mountCalibrated = true;

    function refreshMountBase() {
        if (!hostEl) return;
        mountCalibrated = true;
        const parent = hostEl.parentNode;
        if (!parent || parent === document.body) {
            mountBase = { left: 0, top: 0 };
            hostEl.style.position = 'fixed';
            return;
        }
        const pr = parent.getBoundingClientRect();
        const originX = pr.left + parent.clientLeft;
        const originY = pr.top + parent.clientTop;

        const prevL = hostEl.style.left;
        const prevT = hostEl.style.top;
        hostEl.style.position = 'absolute';
        hostEl.style.left = '0px';
        hostEl.style.top = '0px';

        const hr = hostEl.getBoundingClientRect();
        const cx = hr.left + hr.width / 2;
        const cy = hr.top + hr.height / 2;
        const aligned = Math.abs(cx - originX) < 2 && Math.abs(cy - originY) < 2;

        hostEl.style.left = prevL;
        hostEl.style.top = prevT;

        if (aligned) {
            mountBase = { left: originX, top: originY };
        } else {
            hostEl.style.position = 'fixed';
            mountBase = { left: 0, top: 0 };
        }
    }

    function applyVisualStyle() {
        if (!hostEl) return;
        const op = S.bgOpacity / 100;
        hostEl.style.setProperty('--fg', S.fontColor);
        hostEl.style.setProperty('--bg', hexToRgba(S.bgColor, op));
        hostEl.style.setProperty('--bd', hexToRgba(S.fontColor, op > 0.02 ? 0.14 : 0.22));
    }

    function showOverlay() {
        if (!hostEl) return;
        hostEl.style.display = 'block';
    }

    function clearOverlay() {
        if (!hostEl) return;
        if (mainEl) mainEl.textContent = '';
        if (subEl) { subEl.textContent = ''; subEl.hidden = true; }
        hostEl.style.display = 'none';
    }

    /* =========================================================
     * 4. 原生字幕隐藏（注入 !important 样式，避免站点内联样式覆盖）
     * =======================================================*/
    let nativeHidden = false;

    function hideNative() {
        if (nativeHidden || !SITE || !SITE.hide || !SITE.hide.length) return;
        if (!hideStyleEl) {
            hideStyleEl = document.createElement('style');
            hideStyleEl.id = 'sublingo-hide-native';
            hideStyleEl.textContent = SITE.hide
                .map(sel => `${sel}{opacity:0 !important;}`)
                .join('\n');
        }
        if (!hideStyleEl.isConnected) (document.head || document.documentElement).appendChild(hideStyleEl);
        nativeHidden = true;
    }

    function restoreNative() {
        if (hideStyleEl && hideStyleEl.isConnected) hideStyleEl.remove();
        nativeHidden = false;
    }

    /* =========================================================
     * 5. 翻译
     * =======================================================*/
    const trCache = new Map();

    function cacheKey(t) {
        return S.sourceLang + '|' + S.targetLang + '|' + t;
    }

    function isAlreadyTarget(text) {
        const cjk = (text.match(/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g) || []).length;
        const latin = (text.match(/[A-Za-z\u00c0-\u024f]/g) || []).length;
        if (!cjk && !latin) return true;
        if (S.targetLang === 'zh' || S.targetLang === 'ja') return cjk > latin * 0.8 && cjk > 0;
        if (S.targetLang === 'en') return latin > cjk * 4;
        return false;
    }

    async function translate(text) {
        const sl = S.sourceLang === 'auto' ? 'auto' : S.sourceLang;
        const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
            + '&sl=' + encodeURIComponent(sl)
            + '&tl=' + encodeURIComponent(S.targetLang)
            + '&q=' + encodeURIComponent(text);

        for (let attempt = 0; attempt < 2; attempt++) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 9000);
            try {
                const res = await fetch(url, { signal: ctrl.signal });
                clearTimeout(timer);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                const seg = Array.isArray(data && data[0]) ? data[0] : [];
                return seg.map(x => (x && x[0]) || '').join('').trim();
            } catch (e) {
                clearTimeout(timer);
                if (attempt === 0) await new Promise(r => setTimeout(r, 600));
            }
        }
        return '';
    }

    /* =========================================================
     * 6. 渲染
     * =======================================================*/
    const recent = [];
    let lastCaptionAt = 0;
    let seq = 0;

    function render(original, translated) {
        ensureOverlay();
        const out = (translated || '').trim();
        const same = !out || out === original;

        const lines = (out || original)
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean)
            .slice(0, Math.max(1, S.lineCount));

        mainEl.textContent = lines.join('\n');

        const showSub = S.showOriginal && !same && !!original;
        if (showSub) {
            subEl.textContent = original;
            subEl.hidden = false;
        } else {
            subEl.textContent = '';
            subEl.hidden = true;
        }

        showOverlay();
        hideNative();
        cardEl.classList.remove('pop');
        void cardEl.offsetWidth;
        cardEl.classList.add('pop');
        positionOverlay(true);
        lastCaptionAt = Date.now();
    }

    function record(original, translated) {
        const t = videoEl && isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
        const last = recent[recent.length - 1];
        if (last && last.text === original) { last.tr = translated || last.tr; return; }
        recent.push({ t, text: original, tr: translated || '' });
        if (recent.length > 3000) recent.shift();
    }

    function fmtTime(sec) {
        const s = Math.max(0, sec);
        const hh = String(Math.floor(s / 3600)).padStart(2, '0');
        const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
        const ss = String(Math.floor(s % 60)).padStart(2, '0');
        const ms = String(Math.floor((s - Math.floor(s)) * 1000)).padStart(3, '0');
        return `${hh}:${mm}:${ss},${ms}`;
    }

    function buildSrt() {
        if (!recent.length) return '';
        return recent.map((it, i) => {
            const next = recent[i + 1];
            const end = next ? Math.max(next.t, it.t + 0.6) : it.t + 2.4;
            const body = it.tr && it.tr !== it.text ? it.tr + '\n' + it.text : it.text;
            return `${i + 1}\n${fmtTime(it.t)} --> ${fmtTime(end)}\n${body}\n`;
        }).join('\n');
    }

    /* =========================================================
     * 7. 字幕采集引擎
     * =======================================================*/
    let videoEl = null;
    let lastVideoScan = 0;
    let rootEl = null;
    let lastText = '';
    let fileCues = null;
    let fileCueIndex = -1;
    let fileName = '';

    function pickVideo() {
        const list = document.querySelectorAll('video');
        let best = null;
        let bestArea = 0;
        for (const v of list) {
            const r = v.getBoundingClientRect();
            const a = r.width * r.height;
            if (a > bestArea && a > 12000) { bestArea = a; best = v; }
        }
        return best;
    }

    function ensureVideo() {
        const now = Date.now();
        if (videoEl && videoEl.isConnected && now - lastVideoScan < 1200) return;
        lastVideoScan = now;
        const v = pickVideo();
        if (v !== videoEl) {
            videoEl = v;
            lastText = '';
            rootEl = null;
            fileCueIndex = -1;
            if (v) nativeCaptionsSynced = false;
        }
    }

    function videoRect() {
        if (videoEl && videoEl.isConnected) {
            const r = videoEl.getBoundingClientRect();
            if (r.width > 80 && r.height > 60) return r;
        }
        return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    }

    let lastPosKey = '';

    function positionOverlay(force) {
        if (!hostEl || hostEl.style.display === 'none') return;
        if (!mountCalibrated) refreshMountBase();
        const r = videoRect();
        const p = S.position || { x: 0.5, y: 0.86 };
        const key = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height),
            p.x.toFixed(3), p.y.toFixed(3), S.fontSize, window.innerWidth, window.innerHeight].join('|');
        if (!force && key === lastPosKey) return;
        lastPosKey = key;

        hostEl.style.maxWidth = Math.round(Math.min(r.width * 0.92, 1240)) + 'px';
        hostEl.style.left = Math.round(r.left - mountBase.left + p.x * r.width) + 'px';
        hostEl.style.top = Math.round(r.top - mountBase.top + p.y * r.height) + 'px';

        const fs = Math.max(13, Math.min(46, r.height * 0.034)) * (S.fontSize / 100);
        hostEl.style.setProperty('--fs', fs.toFixed(1) + 'px');
    }

    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        return r.width > 8 && r.height > 8;
    }

    function resolveRoot() {
        if (rootEl && rootEl.isConnected) return rootEl;
        rootEl = null;
        for (const sel of ROOTS) {
            const nodes = document.querySelectorAll(sel);
            for (const el of nodes) {
                if (hostEl && (el === hostEl || hostEl.contains(el))) continue;
                if (!isVisible(el)) continue;
                rootEl = el;
                return el;
            }
        }
        return null;
    }

    function cleanText(t) {
        return String(t || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t\u200b]+/g, ' ')
            .replace(/\s*\n\s*/g, ' ')
            .trim()
            .slice(0, 420);
    }

    function readCaption(root) {
        let raw = '';
        for (const sel of SEGS) {
            const segs = root.querySelectorAll(sel);
            if (segs.length) {
                raw = Array.from(segs)
                    .map(n => (n.innerText || n.textContent || '').trim())
                    .filter(Boolean)
                    .join(' ');
                if (raw) break;
            }
        }
        if (!raw) raw = root.innerText || root.textContent || '';
        return cleanText(raw);
    }

    function trackText() {
        const v = videoEl;
        if (!v || !v.textTracks) return '';
        const parts = [];
        for (const track of v.textTracks) {
            if (track.mode === 'disabled') continue;
            const cues = track.activeCues;
            if (cues && cues.length) {
                parts.push(Array.from(cues).map(c => c.text).join(' '));
            }
        }
        return cleanText(parts.join(' '));
    }

    let nativeCaptionsSynced = false;

    function ensureTrackReadable() {
        const v = videoEl;
        if (!v || !v.textTracks || nativeCaptionsSynced) return;
        try {
            let changed = false;
            for (let i = 0; i < v.textTracks.length; i++) {
                const t = v.textTracks[i];
                // showing 的轨道说明站点在用，保留；被禁用但有 cue 的轨道转 hidden 以读取
                if (t.mode === 'disabled' && t.cues && t.cues.length) {
                    t.mode = 'hidden';
                    changed = true;
                }
            }
            if (changed) nativeCaptionsSynced = true;
        } catch (e) { /* ignore */ }
    }

    /* ---- 本地字幕文件 ---- */
    function parseSubs(raw) {
        const text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
        const blocks = text.split(/\n{2,}/);
        const cues = [];
        for (const block of blocks) {
            const lines = block.split('\n').filter(l => l.trim() !== '');
            if (!lines.length) continue;
            let i = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
            const tl = lines[i];
            if (!tl || tl.indexOf('-->') === -1) continue;
            const m = tl.match(/(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/);
            if (!m) continue;
            const body = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
            if (!body) continue;
            const start = toSec(m[1]);
            const end = toSec(m[2]);
            if (end > start) cues.push({ start, end, text: body });
        }
        cues.sort((a, b) => a.start - b.start);
        return cues;
    }

    function toSec(str) {
        const p = String(str).replace(',', '.').split(':').map(Number);
        if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
        if (p.length === 2) return p[0] * 60 + p[1];
        return p[0] || 0;
    }

    function findCue(t, prev) {
        // 顺序播放走线性推进，跳转时二分兜底
        const n = fileCues.length;
        if (prev >= 0 && prev < n) {
            const c = fileCues[prev];
            if (t >= c.start && t < c.end) return prev;
            const nx = fileCues[prev + 1];
            if (nx && t >= nx.start && t < nx.end) return prev + 1;
        }
        let lo = 0, hi = n - 1, ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (fileCues[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (ans >= 0 && t < fileCues[ans].end) return ans;
        return -1;
    }

    /* ---- 主循环 ---- */
    function tick() {
        if (document.hidden) return;
        ensureOverlay();
        mountOverlay();
        ensureVideo();
        applyPositionTick();

        if (!S.enabled) return;

        // 本地字幕文件优先
        if (fileCues && fileCues.length && videoEl) {
            const t = videoEl.currentTime || 0;
            const idx = findCue(t, fileCueIndex);
            fileCueIndex = idx >= 0 ? idx : fileCueIndex;
            const text = idx >= 0 ? fileCues[idx].text : '';
            if (text !== lastText) {
                lastText = text;
                if (text) runTranslate(text);
                else clearOverlay();
            }
            return;
        }

        const root = resolveRoot();
        if (root) {
            const text = readCaption(root);
            if (text && text !== lastText) {
                lastText = text;
                queueTranslate(text);
            } else if (!text && lastText) {
                lastText = '';
            }
            return;
        }

        // 退到原生字幕轨道
        ensureTrackReadable();
        const tText = trackText();
        if (tText && tText !== lastText) {
            lastText = tText;
            queueTranslate(tText);
        }
    }

    let posTick = 0;
    function applyPositionTick() {
        if (hostEl && hostEl.style.display !== 'none' && (posTick++ % 2 === 0)) positionOverlay(false);
    }

    /* =========================================================
     * 8. 翻译调度
     * =======================================================*/
    let debounceTimer = null;

    function queueTranslate(text) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => runTranslate(text), S.debounceDelay);
    }

    async function runTranslate(text) {
        const my = ++seq;
        if (isAlreadyTarget(text)) {
            render(text, '');
            record(text, '');
            return;
        }
        const key = cacheKey(text);
        const cached = trCache.get(key);
        if (cached) {
            render(text, cached);
            record(text, cached);
            return;
        }
        if (cardEl) cardEl.classList.add('loading');
        const out = await translate(text);
        if (cardEl) cardEl.classList.remove('loading');
        if (my !== seq) return;

        if (!out) { render(text, ''); return; }
        trCache.set(key, out);
        if (trCache.size > 400) trCache.delete(trCache.keys().next().value);
        render(text, out);
        record(text, out);
    }

    /* =========================================================
     * 9. 拖拽（Alt + 鼠标 / 触控笔）
     * =======================================================*/
    let dragging = false;
    let grabOffset = { x: 0, y: 0 };
    let dragPos = null;

    function onAltDown(e) {
        if (e.key !== 'Alt' || !hostEl) return;
        hostEl.classList.add('alt');
        hostEl.style.pointerEvents = 'auto';
        hostEl.style.cursor = 'grab';
    }

    function onAltUp(e) {
        if (e.key !== 'Alt' || !hostEl) return;
        hostEl.classList.remove('alt');
        if (!dragging) {
            hostEl.style.pointerEvents = 'none';
            hostEl.style.cursor = 'default';
        }
    }

    function onPointerDown(e) {
        if (!e.altKey || !hostEl || hostEl.style.display === 'none') return;
        // 只有按在字幕面板上才允许拖动，避免页面任意位置 Alt+点击都触发
        const box = hostEl.getBoundingClientRect();
        const pad = 6;
        if (e.clientX < box.left - pad || e.clientX > box.right + pad ||
            e.clientY < box.top - pad || e.clientY > box.bottom + pad) return;

        const r = videoRect();
        const p = S.position || { x: 0.5, y: 0.86 };
        const cx = r.left + p.x * r.width;
        const cy = r.top + p.y * r.height;
        dragging = true;
        grabOffset = { x: e.clientX - cx, y: e.clientY - cy };
        dragPos = { x: p.x, y: p.y };
        hostEl.style.cursor = 'grabbing';
        hostEl.style.pointerEvents = 'auto';
        e.preventDefault();
        e.stopPropagation();
    }

    function onPointerMove(e) {
        if (!dragging || !hostEl) return;
        const r = videoRect();
        const x = (e.clientX - grabOffset.x - r.left) / r.width;
        const y = (e.clientY - grabOffset.y - r.top) / r.height;
        dragPos = { x: Math.min(0.95, Math.max(0.05, x)), y: Math.min(0.95, Math.max(0.05, y)) };
        S.position = dragPos;
        positionOverlay(true);
        e.preventDefault();
    }

    function onPointerUp() {
        if (!dragging) return;
        dragging = false;
        if (hostEl) {
            hostEl.style.cursor = 'grab';
            if (!hostEl.classList.contains('alt')) {
                hostEl.style.pointerEvents = 'none';
                hostEl.style.cursor = 'default';
            }
        }
        if (dragPos) saveStorage({ position: dragPos });
    }

    document.addEventListener('keydown', onAltDown, true);
    document.addEventListener('keyup', onAltUp, true);
    window.addEventListener('blur', () => {
        if (hostEl) {
            hostEl.classList.remove('alt');
            hostEl.style.pointerEvents = 'none';
        }
    });
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('mousemove', onPointerMove, true);
    document.addEventListener('mouseup', onPointerUp, true);

    /* =========================================================
     * 10. 应用设置
     * =======================================================*/
    function applySettings() {
        ensureOverlay();
        applyVisualStyle();

        if (!S.enabled) {
            clearOverlay();
            restoreNative();
            lastText = '';
            if (hostEl) hostEl.style.pointerEvents = 'none';
            return;
        }
        positionOverlay(true);
        if (lastText) {
            // 样式变化后立即重绘当前字幕
            const key = cacheKey(lastText);
            render(lastText, trCache.get(key) || '');
        }
    }

    function patch(payload) {
        if (!payload) return;
        const next = Object.assign({}, S);
        if (payload.enabled !== undefined) next.enabled = !!payload.enabled;
        if (payload.isSubtitleEnabled !== undefined) next.enabled = !!payload.isSubtitleEnabled;
        ['sourceLang', 'targetLang', 'fontColor', 'bgColor', 'showOriginal'].forEach(k => {
            if (payload[k] !== undefined) next[k] = payload[k];
        });
        ['fontSize', 'lineCount', 'bgOpacity', 'debounceDelay'].forEach(k => {
            if (payload[k] !== undefined) next[k] = Number(payload[k]);
        });
        if (payload.position !== undefined) next.position = payload.position;
        S = normalize(next);
        applySettings();
    }

    function resetEngine() {
        lastText = '';
        rootEl = null;
        fileCueIndex = -1;
        trCache.clear();
        clearOverlay();
        ensureVideo();
    }

    function loadFile(name, text) {
        const cues = parseSubs(text);
        if (!cues.length) return { ok: false, error: '未能解析出字幕条目，请确认文件为 .srt 或 .vtt' };
        fileCues = cues;
        fileName = name || '本地字幕';
        fileCueIndex = -1;
        lastText = '';
        clearOverlay();
        return { ok: true, count: cues.length, name: fileName };
    }

    function buildStatus() {
        let mode = 'none';
        if (fileCues && fileCues.length) mode = 'file';
        else if (rootEl && rootEl.isConnected) mode = 'dom';
        else if (videoEl && videoEl.textTracks) {
            for (const t of videoEl.textTracks) {
                if (t.mode !== 'disabled' && t.cues && t.cues.length) { mode = 'track'; break; }
            }
        }
        return {
            ok: true,
            site: SITE ? SITE.name : hostName,
            siteId: SITE ? SITE.id : 'generic',
            mode,
            enabled: S.enabled,
            fileName: fileName,
            cueCount: fileCues ? fileCues.length : 0,
            captured: recent.length,
            title: (document.title || '').slice(0, 80)
        };
    }

    /* =========================================================
     * 11. 消息
     * =======================================================*/
    chrome.runtime.onMessage.addListener((req, _sender, respond) => {
        if (!req || typeof req !== 'object' || !req.action) return;
        try {
            switch (req.action) {
                case 'GET_STATUS':
                    respond(buildStatus());
                    break;
                case 'SETTINGS':
                    patch(req.settings || {});
                    if (req.resetPosition) { S.position = null; saveStorage({ position: null }); positionOverlay(true); }
                    respond({ ok: true });
                    break;
                case 'APPLY_TRANSLATION_SETTINGS':
                    patch(req);
                    respond({ ok: true });
                    break;
                case 'MANUAL_REFRESH':
                    resetEngine();
                    respond({ ok: true });
                    break;
                case 'REQUEST_EXPORT_SUBTITLES':
                    respond({ subtitles: buildSrt(), count: recent.length });
                    break;
                case 'LOAD_SUBTITLE_FILE':
                    respond(loadFile(req.name, req.text));
                    break;
                case 'CLEAR_SUBTITLE_FILE':
                    fileCues = null;
                    fileName = '';
                    lastText = '';
                    clearOverlay();
                    respond({ ok: true });
                    break;
                case 'RESET_POSITION':
                    S.position = null;
                    saveStorage({ position: null });
                    positionOverlay(true);
                    respond({ ok: true });
                    break;
                default:
                    break;
            }
        } catch (err) {
            try { respond({ ok: false, error: String(err && err.message || err) }); } catch (e) { }
        }
    });

    /* 设置实时同步（替代旧的 200ms 轮询） */
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'sync') return;
            const flat = {};
            let touched = false;
            Object.keys(changes).forEach(k => {
                if (k === 'position') return;
                if (DEFAULTS[k] !== undefined) { flat[k] = changes[k].newValue; touched = true; }
            });
            if (touched) patch(flat);
        });
    } catch (e) { /* ignore */ }

    /* =========================================================
     * 12. 事件与启动
     * =======================================================*/
    document.addEventListener('fullscreenchange', () => {
        mountOverlay();
        refreshMountBase();
        positionOverlay(true);
    });
    window.addEventListener('resize', () => positionOverlay(true), { passive: true });
    window.addEventListener('scroll', () => positionOverlay(false), { passive: true, capture: true });

    (async function init() {
        const raw = await getStorage();
        S = normalize(raw);
        ensureOverlay();
        applySettings();
        setInterval(tick, 250);
        tick();
        console.log('[SubLingo] 已就绪 ·', SITE ? SITE.name : hostName);
    })();
})();
