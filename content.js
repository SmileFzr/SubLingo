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

    /* 站点路由守卫 ----------------------------------------------------
     * YouTube / B站 / TikTok 这类 SPA 的「非播放页」里同样存在 <video> 和字幕容器
     * （搜索结果页、首页信息流里的悬停预览播放器）。若不排除，离开播放页后
     * 字幕会浮在列表页甚至整页中央。这里只允许真正的播放页参与采集。 */
    const ROUTE = {
        youtube: {
            // /watch?v=、/shorts/、/embed/、/live/、/clip/，
            // 以及直播间的 /@频道名/live（YouTube 直播的主流入口，少了它
            // 直播页会被判成"非播放页"，AI 字幕算出来也直接丢掉）
            allow: /\/(watch|shorts|embed|live|clip)(\/|$)|\/@[^/]+\/live/,
            // 结果页的迷你播放器（画中画）例外
            extra: () => !!document.querySelector('ytd-miniplayer[active] video')
        },
        bilibili: { allow: /\/(video|bangumi|cheese|live|medialist|festival|blackboard)(\/|$)/ },
        // TikTok：视频页 /@user/video/ID、直播间 /@user/live、列表页
        tiktok: { allow: /^\/(@[^/]+\/(video|live)\/?|live(\/|$)|foryou|following|explore|\/?$)/ },
        // Twitch：频道页、/videos/ID、/user/clip/xxx 与 clips.twitch.tv 的落地页
        twitch: { allow: /^\/(videos\/[\w-]+|[\w-]+\/(clip|videos?)\/[\w-]+|[\w-]+\/?$)/ },
        kick: { allow: /^\/(video\/|[\w-]+\/?$)/ }
    };

    function routeAllowsVideo() {
        const rule = SITE && ROUTE[SITE.id];
        if (!rule) return true;                       // 未登记站点不做限制
        if (rule.allow && rule.allow.test(location.pathname)) return true;
        if (rule.extra) {
            try { if (rule.extra()) return true; } catch (e) { /* ignore */ }
        }
        return false;
    }

    /* =========================================================
     * 2. 设置
     * =======================================================*/
    const DEFAULTS = {
        enabled: true,
        sourceLang: 'auto',
        targetLang: 'zh',
        fontSize: 100,
        originalScale: 68,
        lineCount: 2,
        debounceDelay: 420,
        fontColor: '#FFFFFF',
        bgColor: '#0B0B0D',
        bgOpacity: 62,
        showOriginal: true,
        position: null,
        /* 字幕框宽度（px）。null = 跟随视频宽度自动；
           Alt + 拖动浮层左右边缘后写入具体值 */
        width: null
    };

    let S = Object.assign({}, DEFAULTS);

    /* 手动调宽时的下限：再窄就装不下一句中文了 */
    const MIN_WIDTH = 140;

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
        o.originalScale = clampNum(o.originalScale, 30, 130, 68);
        o.lineCount = clampNum(o.lineCount, 1, 6, 2);
        o.bgOpacity = clampNum(o.bgOpacity, 0, 100, 62);
        o.debounceDelay = clampNum(o.debounceDelay, 100, 2000, 420);
        o.enabled = !!o.enabled;
        o.showOriginal = !!o.showOriginal;
        if (o.position && (typeof o.position.x !== 'number' || typeof o.position.y !== 'number')) o.position = null;
        const w = Number(o.width);
        o.width = (o.width === null || o.width === undefined || !isFinite(w) || w <= 0)
            ? null
            : Math.min(4000, Math.max(MIN_WIDTH, w));
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
            /* 兜底：识别偶尔吐出一条超长文本，也不能让它糊满整个画面 */
            max-height: min(42vh, 340px);
            overflow: hidden;
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
            font-size: var(--sub-fs, calc(var(--fs) * .68));
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

    /* 按字符集统计，而不是笼统地算「CJK」——
       旧版把韩文谚文、日文假名和汉字混为一谈，导致 targetLang=zh 时
       韩语/日语字幕被误判成「已经是中文」而跳过翻译。 */
    function scriptStats(text) {
        const s = { han: 0, kana: 0, hangul: 0, latin: 0 };
        for (const ch of String(text)) {
            const c = ch.codePointAt(0);
            if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) ||
                (c >= 0xf900 && c <= 0xfaff)) s.han++;
            else if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff) ||
                (c >= 0xff66 && c <= 0xff9f)) s.kana++;
            else if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff) ||
                (c >= 0x3130 && c <= 0x318f)) s.hangul++;
            else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ||
                (c >= 0xc0 && c <= 0x24f)) s.latin++;
        }
        return s;
    }

    function isAlreadyTarget(text) {
        const s = scriptStats(text);
        const cjk = s.han + s.kana + s.hangul;
        if (cjk + s.latin === 0) return true;          // 纯数字 / 标点 / emoji，没什么可翻
        const t = String(S.targetLang || 'zh').split('-')[0];

        if (t === 'zh') {
            // 出现谚文或假名 → 一定是韩/日文，必须翻
            if (s.hangul > 0 || s.kana > 0) return false;
            return s.han > 0 && s.han >= s.latin;
        }
        if (t === 'ja') {
            if (s.hangul > 0) return false;
            // 必须出现假名才算日文：纯汉字无法与中文区分，宁可多翻一次
            return s.kana > 0 && s.han + s.kana >= s.latin;
        }
        if (t === 'ko') {
            if (s.kana > 0) return false;
            return s.hangul > 0 && s.hangul >= s.latin;
        }
        // 拉丁语系（en / fr / de / es / pt / id / vi …）
        return s.latin > 0 && cjk === 0;
    }

    /* 自动检测偶尔会把短句判错（尤其韩/日短句），这里用字符集给一个兜底提示 */
    function guessSourceLang(text) {
        const s = scriptStats(text);
        if (s.hangul > 0) return 'ko';
        if (s.kana > 0) return 'ja';
        if (s.han > 0 && s.han >= s.latin) return 'zh-CN';
        if (s.latin > 0) return 'en';
        return '';
    }

    function normalizeText(t) {
        return String(t || '').replace(/[\s\p{P}]/gu, '').toLowerCase();
    }

    async function translate(text, slOverride) {
        const sl = slOverride || (S.sourceLang === 'auto' ? 'auto' : S.sourceLang);
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
        // 翻译是异步的，回来时可能已经换了页面 —— 这里再确认一次场景是否还成立
        if (!S.enabled || !routeAllowsVideo() || !activeVideoRect()) { clearOverlay(); return; }
        const out = (translated || '').trim();
        const same = !out || out === original;

        /* 一条字幕不该比一屏还长。识别端已经截过一次，这里按行数再兜一层，
           防止极端情况下（整段复读）把画面糊住。 */
        const maxChars = 90 * Math.max(1, S.lineCount);
        let body = (out || original).replace(/\s*\n\s*/g, ' ').trim();
        if (body.length > maxChars) body = body.slice(0, maxChars).replace(/[\s,，、.。]+$/, '') + '…';

        const lines = body
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
        if (aiInterim) return;          // 识别的中间结果不进导出记录，等最终版
        const t = videoEl && isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
        const last = recent[recent.length - 1];
        if (last && last.text === original) { last.tr = translated || last.tr; }
        else {
            recent.push({ t, text: original, tr: translated || '' });
            if (recent.length > 3000) recent.shift();
        }
        /* 识别出来的字幕同时进时间轴缓存：句中时间用 aiCueAt
           （已经减掉识别延迟），而不是现在这个渲染时刻 */
        if (aiActive && !replayCues) tlPush(aiCueAt || t, original, translated || '');
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

    /* ---- AI 语音识别（ASR）通道 ----
       ASR 的字幕文本由后台的本地 Whisper 识别产生，不来自页面 DOM。
       这条通道运行时，浮层由它独占，不再去读站内 CC，否则两套文本会互相覆盖。 */
    let aiActive = false;       // 本轮识别是否已产出过字幕
    let aiLastAt = 0;           // 最后一次拿到识别结果的时间
    let aiLastText = '';        // 判重：识别结果常常一字不差地重复
    let aiInterim = false;      // 当前这次渲染是不是"中间结果"（不进导出记录）
    let aiStatus = null;        // 后台同步过来的运行状态

    /* ---- SPA 页面切换：整段状态重置，避免把上一页的字幕带过去 ---- */
    let lastNavKey = location.pathname + location.search;

    function onNavigate() {
        lastNavKey = location.pathname + location.search;
        seq++;                              // 作废所有在途翻译结果
        clearTimeout(debounceTimer);
        lastText = '';
        rootEl = null;
        videoEl = null;
        lastVideoScan = 0;
        lastPosKey = '';
        fileCueIndex = -1;
        nativeCaptionsSynced = false;
        if (cardEl) cardEl.classList.remove('loading');
        clearOverlay();
        restoreNative();                    // 离开播放页后，站点自己的字幕该显示就显示

        /* 换了播放场景：让识别端把缓冲里的旧音频和在途结果一起作废。
           不做这一步，切到下一个直播间后会先冒出 1~2 条上一个主播的话。 */
        aiActive = false;
        aiLastText = '';
        aiInterim = false;
        aiLastAt = 0;
        /* 换了视频，二刷缓存也要跟着换（syncTimeline 会在下一帧重新载入） */
        replayKey = '';
        replayCues = null;
        replayIdx = -2;
        tlCues = [];
        tlSavedKey = '';
        notifyNav();
    }

    /* SPA 换页不会触发 tabs.onUpdated，只能由页面自己告诉后台。
       失败是正常的（没在识别 / 扩展刚重载），静默即可。 */
    function notifyNav() {
        const key = location.pathname + location.search;
        try { document.documentElement.dataset.slnav = key; } catch (e) { /* 只为排查可见 */ }
        try {
            chrome.runtime.sendMessage({ type: 'AI_NAV', key: key }, () => { void chrome.runtime.lastError; });
        } catch (e) { /* 上下文失效 */ }
    }

    /* 播放器最小尺寸（随窗口自适应，避免小窗口下的正常视频被误杀）*/
    function minPlayerSize() {
        return {
            w: Math.min(320, window.innerWidth * 0.55),
            h: Math.min(180, window.innerHeight * 0.35)
        };
    }

    function pickVideo() {
        const list = document.querySelectorAll('video');
        const min = minPlayerSize();
        let best = null;
        let bestArea = 0;
        for (const v of list) {
            const r = v.getBoundingClientRect();
            // 排除缩略图预览、广告小窗这类「不像播放器」的画面
            if (r.width < min.w || r.height < min.h) continue;
            const a = r.width * r.height;
            if (a > bestArea) { bestArea = a; best = v; }
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

    /* 只认「真的在画面里的播放器」。没有可用画面时返回 null —— 绝不能退回整页坐标，
       否则字幕会浮在搜索列表、文章页这类根本没有播放器的页面上。 */
    function activeVideoRect() {
        if (!videoEl || !videoEl.isConnected) return null;
        const r = videoEl.getBoundingClientRect();
        const min = minPlayerSize();
        if (r.width < min.w || r.height < min.h) return null;
        if (r.bottom < 24 || r.top > window.innerHeight - 24) return null;
        return r;
    }

    let lastPosKey = '';

    function positionOverlay(force) {
        if (!hostEl || hostEl.style.display === 'none') return;
        if (!mountCalibrated) refreshMountBase();
        const r = activeVideoRect();
        if (!r) { hostEl.style.display = 'none'; return; }
        const p = S.position || { x: 0.5, y: 0.86 };
        const key = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height),
            p.x.toFixed(3), p.y.toFixed(3), S.fontSize, S.originalScale,
            S.width || 0, window.innerWidth, window.innerHeight].join('|');
        if (!force && key === lastPosKey) return;
        lastPosKey = key;

        hostEl.style.maxWidth = Math.round(Math.min(r.width * 0.98, 1240)) + 'px';
        hostEl.style.width = S.width
            ? Math.round(Math.min(r.width * 0.98, Math.max(MIN_WIDTH, S.width))) + 'px'
            : 'max-content';
        hostEl.style.left = Math.round(r.left - mountBase.left + p.x * r.width) + 'px';
        hostEl.style.top = Math.round(r.top - mountBase.top + p.y * r.height) + 'px';

        const base = Math.max(13, Math.min(46, r.height * 0.034));
        hostEl.style.setProperty('--fs', (base * (S.fontSize / 100)).toFixed(1) + 'px');
        hostEl.style.setProperty('--sub-fs', (base * (S.originalScale / 100)).toFixed(1) + 'px');
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

    /* 页面此刻有没有"现成的"字幕：站内 CC / 原生字幕轨道 / 本地文件。
       有就不该再跑 AI —— 两套文本叠在一起会互相覆盖，而且 AI 的滑窗
       会把刚看过的那句再带出来一次，读起来就是"同一句重复了一遍"。 */
    function nativeCaptionNow() {
        if (fileCues && fileCues.length) return 'file';
        const root = resolveRoot();
        if (root && readCaption(root)) return 'dom';
        if (videoEl) {
            try {
                const tracks = videoEl.textTracks;
                for (let i = 0; i < tracks.length; i++) {
                    const t = tracks[i];
                    if (t.mode !== 'disabled' && t.activeCues && t.activeCues.length) return 'track';
                }
            } catch (e) { /* ignore */ }
        }
        return '';
    }

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
        if (location.pathname + location.search !== lastNavKey) onNavigate();
        ensureOverlay();
        mountOverlay();
        ensureVideo();
        applyPositionTick();

        if (!S.enabled) return;

        /* 不在播放页（搜索结果 / 首页 / 频道页 / 番剧列表…），或画面已消失、已滚出视口：
           立即收起浮层，并让站点原生字幕恢复显示 */
        if (!routeAllowsVideo() || !activeVideoRect()) {
            lastText = '';
            rootEl = null;
            fileCueIndex = -1;
            if (hostEl && hostEl.style.display !== 'none') clearOverlay();
            restoreNative();
            return;
        }

        syncTimeline();

        /* 二刷：缓存时间轴优先。已经翻好的字幕按 currentTime 取，
           零延迟，也不会再触发识别。 */
        if (replayCues && replayCues.length && videoEl) {
            const t = videoEl.currentTime || 0;
            const i = findReplay(t);
            if (i !== replayIdx) {
                replayIdx = i;
                if (i < 0) clearOverlay();
                else render(replayCues[i].text, replayCues[i].tr || '');
            }
            return;
        }

        /* AI 识别运行中：文本从后台来，这里只负责"保持还是收起"。
           这里的时间阈值必须大于"两次识别结果之间最长可能间隔"，
           否则字幕刚上屏就被自己收掉——本地识别一段要 5~10 秒，
           设 9 秒会让字幕永远闪一下就消失。 */
        if (aiActive) {
            const idleLimit = 30000;
            if (aiLastAt && Date.now() - aiLastAt > idleLimit) {
                aiActive = false;
                aiLastText = '';
                lastText = '';
                clearOverlay();
            }
            return;
        }

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
        let out = await translate(text);

        // 自动检测返回空 / 原样返回时，用我们自己的字符集判断再试一次
        if (S.sourceLang === 'auto' && (!out || normalizeText(out) === normalizeText(text))) {
            const guess = guessSourceLang(text);
            if (guess) {
                const retry = await translate(text, guess);
                if (retry && normalizeText(retry) !== normalizeText(text)) out = retry;
                else if (!out) out = retry;
            }
        }

        if (cardEl) cardEl.classList.remove('loading');
        if (my !== seq) return;

        if (!out) { render(text, ''); return; }
        trCache.set(key, out);
        if (trCache.size > 400) trCache.delete(trCache.keys().next().value);
        render(text, out);
        record(text, out);
    }

    /* =========================================================
     * 8b. AI 语音识别字幕
     * =======================================================*/
    function handleAiCaption(text, final, meta) {
        const t = String(text || '').trim();
        if (!t) return;
        /* 已经不在播放页了（比如刚跳回列表页），识别结果直接丢，
           否则字幕会挂在没有视频的页面上 */
        const allow = routeAllowsVideo();
        const rect = !!(videoEl && activeVideoRect());
        if (!allow || !rect) return;

        /* 二刷：有缓存时间轴就按时间轴走，实时识别结果不再需要 */
        if (replayCues && replayCues.length) return;

        /* 站内本来就有字幕 —— 交给它，AI 让位。
           这既避免了重复字幕，也省掉了 8~10 秒的延迟。 */
        if (nativeCaptionNow()) { autoOffForNative(); return; }

        if (t === aiLastText) return;           // 识别结果常一字不差地重复返回
        aiLastText = t;
        aiLastAt = Date.now();
        aiActive = true;
        aiInterim = final === false;

        /* 记录这条字幕在片中的位置：识别结果比画面晚 segMs + cost 秒，
           减掉它才是这句话真正被说出来的时间点，二刷回放才对得上。 */
        const m = meta || {};
        const lag = Number(m.segMs || 0) + Number(m.cost || 0);
        if (lag > 1000) aiLagMs = Math.min(20000, Math.max(1500, lag));
        aiCueAt = Math.max(0, (videoEl && videoEl.currentTime || 0) - aiLagMs / 1000);

        // 这段文本没有页面 DOM 可依附，直接送入既有的翻译 → 渲染 → 导出管线
        runTranslate(t);
    }

    /* 发现站内字幕就把 AI 关掉。同一个页面只提示一次，免得反复弹。 */
    let aiAutoOffAt = 0;
    function autoOffForNative() {
        if (Date.now() - aiAutoOffAt < 15000) return;
        aiAutoOffAt = Date.now();
        aiActive = false;
        aiLastText = '';
        aiInterim = false;
        clearOverlay();
        try {
            chrome.runtime.sendMessage({ type: 'AI_AUTO_OFF', reason: 'native' }, () => { void chrome.runtime.lastError; });
        } catch (e) { /* 后台不在 */ }
        showNotice('这个页面本来就有字幕',
            '已自动切回原生字幕（更准、无延迟）· 想强行用语音识别，先关掉站内 CC 再点开启');
    }

    /* =========================================================
     * 8c. 二次观看：按时间轴回放已经翻好的字幕
     * ---------------------------------------------------------
     * 本地识别一条要 8~10 秒，看完一遍再回头看某句特别别扭。
     * 第一遍播完时把 (片中时间, 原文, 译文) 存下来，下次打开同一
     * 集直接按 currentTime 取——零延迟，也不用再烧 CPU。
     * =======================================================*/
    const TL_PREFIX = 'tl:';
    const TL_KEEP = 24;              // 最多留 24 部片子，超了按时间淘汰
    const TL_MAX_CUES = 800;

    let replayCues = null;           // 已缓存的时间轴：[{t, text, tr}]
    let replayIdx = -2;              // 当前显示的是第几条（-1 = 空隙）
    let replayKey = '';              // 当前视频的缓存键，换片时比对
    let tlCues = [];                 // 本轮识别累积下来的时间轴
    let tlSavedKey = '';
    let aiCueAt = 0;                 // 当前这句话在片中的时间点
    let aiLagMs = 8000;              // 识别结果比画面晚多少

    /* 用视频自身 id 做键：YouTube 的 v=、B站的 BV 号、TikTok 的 /video/ID。
       直播间没有稳定 id，落到 host+path，也不会被误当成"看完的片子"。 */
    function videoKey() {
        if (SITE) {
            if (SITE.id === 'youtube') {
                const v = new URLSearchParams(location.search).get('v');
                if (v) return 'yt:' + v;
                const m = location.pathname.match(/\/(?:live|shorts|embed)\/([\w-]{6,})/);
                if (m) return 'yt:' + m[1];
            } else if (SITE.id === 'bilibili') {
                const m = location.pathname.match(/(BV[0-9A-Za-z]{8,}|av\d+)/);
                if (m) return 'bl:' + m[1].toLowerCase();
            } else if (SITE.id === 'tiktok') {
                const m = location.pathname.match(/\/video\/(\d+)/);
                if (m) return 'tt:' + m[1];
            }
        }
        return 'gen:' + location.hostname + location.pathname;
    }

    function syncTimeline() {
        const key = videoKey();
        if (key === replayKey) return;
        replayKey = key;
        replayCues = null;
        replayIdx = -2;
        tlCues = [];
        tlSavedKey = '';
        loadTimeline(key);
    }

    function loadTimeline(key) {
        try {
            chrome.storage.local.get(TL_PREFIX + key, box => {
                const rec = box && box[TL_PREFIX + key];
                if (!rec || !Array.isArray(rec.cues) || rec.cues.length < 6) return;
                if (videoKey() !== key) return;              // 期间又换片了
                /* 时长对不上就不认：同一条链接可能被换成别的视频，
                   对错轴比没有字幕更糟 */
                const dur = (videoEl && isFinite(videoEl.duration)) ? videoEl.duration : 0;
                if (rec.duration && dur && Math.abs(dur - rec.duration) > Math.max(15, rec.duration * 0.15)) return;
                replayCues = rec.cues.slice().sort((a, b) => a.t - b.t);
                replayIdx = -2;
                showNotice('已载入上次的字幕',
                    rec.cues.length + ' 条 · 按时间轴直接播放，不再走语音识别');
                console.log('[SubLingo] 载入缓存字幕', key, rec.cues.length);
            });
        } catch (e) { /* 存储不可用就退回实时识别 */ }
    }

    /* 二分找当前时间对应的那条，找不到就返回 -1（留白） */
    function findReplay(t) {
        const cues = replayCues;
        let lo = 0, hi = cues.length - 1, ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (cues[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (ans < 0) return -1;
        const cur = cues[ans];
        const next = cues[ans + 1];
        const until = next ? Math.min(next.t + 1.5, cur.t + 14) : cur.t + 12;
        return t <= until ? ans : -1;
    }

    function tlPush(t, text, tr) {
        const last = tlCues[tlCues.length - 1];
        if (last) {
            if (last.text === text) { last.tr = tr || last.tr; return; }
            /* 滑窗把上一句带进了这一句：合并成一条，别存两条重复的 */
            if (text.startsWith(last.text) && text.length - last.text.length < 40) {
                last.text = text;
                last.tr = tr || last.tr;
                return;
            }
            if (Math.abs(t - last.t) < 0.3) { last.text = text; last.tr = tr || last.tr; return; }
        }
        tlCues.push({ t: Math.round(t * 10) / 10, text: text, tr: tr || '' });
        if (tlCues.length > TL_MAX_CUES) tlCues.shift();
    }

    /* 播完才存：只有覆盖到全片大半，才算"这一集翻译完了"。
       存早了，下次回放会出现"前半有字幕、后半没有"的割裂感。 */
    function saveTimeline() {
        const v = videoEl;
        if (!v || !isFinite(v.duration) || v.duration < 30) return;
        if (tlCues.length < 6) return;
        const key = videoKey();
        if (tlSavedKey === key) return;
        const lastT = tlCues[tlCues.length - 1].t;
        if (lastT < v.duration * 0.6) return;
        tlSavedKey = key;
        /* 用户中途来回拖进度条时，时间轴是乱序的。回放靠二分查找，
           必须先按时间排好，否则会一直取到错的那一条。 */
        const sorted = tlCues.slice().sort((a, b) => a.t - b.t);
        const rec = {
            key: key,
            duration: Math.round(v.duration),
            title: (document.title || '').slice(0, 80),
            at: Date.now(),
            cues: sorted.slice(0, TL_MAX_CUES)
        };
        try {
            chrome.storage.local.set({ [TL_PREFIX + key]: rec }, () => {
                void chrome.runtime.lastError;
                trimTimelines();
            });
            console.log('[SubLingo] 已缓存字幕时间轴', key, rec.cues.length);
        } catch (e) { /* 配额满就放弃，不影响当前播放 */ }
    }

    function trimTimelines() {
        try {
            chrome.storage.local.get(null, all => {
                const items = Object.keys(all || {})
                    .filter(k => k.indexOf(TL_PREFIX) === 0)
                    .map(k => ({ k: k, at: (all[k] && all[k].at) || 0 }))
                    .sort((a, b) => b.at - a.at);
                const drop = items.slice(TL_KEEP).map(x => x.k);
                if (drop.length) chrome.storage.local.remove(drop);
            });
        } catch (e) { /* ignore */ }
    }

    /* =========================================================
     * 9. 拖拽（Alt + 鼠标 / 触控笔）
     * =======================================================*/
    let dragging = false;
    let grabOffset = { x: 0, y: 0 };
    let dragPos = null;
    /* 边缘拖拽调宽：命中左右 9px 的边缘带就进入 resize 而不是 move */
    let resizing = '';
    let resizeCenter = 0;
    const EDGE_HIT = 9;

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

        const r = activeVideoRect();
        if (!r) return;

        /* 按在左右边缘 → 调宽度。面板是 translate(-50%) 居中的，
           中心点不动，宽度就是"中心到指针距离 × 2"。 */
        const onLeft = Math.abs(e.clientX - box.left) <= EDGE_HIT;
        const onRight = Math.abs(e.clientX - box.right) <= EDGE_HIT;
        if (onLeft || onRight) {
            resizing = onLeft ? 'left' : 'right';
            resizeCenter = box.left + box.width / 2;
            hostEl.style.cursor = 'ew-resize';
            hostEl.style.pointerEvents = 'auto';
            e.preventDefault();
            e.stopPropagation();
            return;
        }

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
        if (resizing && hostEl) {
            const r = activeVideoRect();
            const maxW = r ? Math.min(r.width * 0.98, 1240) : 1240;
            const raw = resizing === 'right'
                ? (e.clientX - resizeCenter) * 2
                : (resizeCenter - e.clientX) * 2;
            S.width = Math.round(Math.min(maxW, Math.max(MIN_WIDTH, raw)));
            positionOverlay(true);
            e.preventDefault();
            return;
        }
        if (!dragging || !hostEl) return;
        const r = activeVideoRect();
        if (!r) return;
        const x = (e.clientX - grabOffset.x - r.left) / r.width;
        const y = (e.clientY - grabOffset.y - r.top) / r.height;
        dragPos = { x: Math.min(0.95, Math.max(0.05, x)), y: Math.min(0.95, Math.max(0.05, y)) };
        S.position = dragPos;
        positionOverlay(true);
        e.preventDefault();
    }

    /* 按住 Alt 悬停在边缘时给个左右箭头的鼠标，让人知道这里能拉 */
    function hoverCursor(e) {
        if (!e.altKey || dragging || resizing || !hostEl || hostEl.style.display === 'none') return;
        const box = hostEl.getBoundingClientRect();
        const inY = e.clientY >= box.top - 6 && e.clientY <= box.bottom + 6;
        const nearEdge = Math.abs(e.clientX - box.left) <= EDGE_HIT || Math.abs(e.clientX - box.right) <= EDGE_HIT;
        hostEl.style.cursor = (inY && nearEdge) ? 'ew-resize' : 'grab';
    }

    function onPointerUp() {
        if (resizing) {
            resizing = '';
            if (hostEl) {
                const alt = hostEl.classList.contains('alt');
                hostEl.style.cursor = alt ? 'grab' : 'default';
                if (!alt) hostEl.style.pointerEvents = 'none';
            }
            saveStorage({ width: S.width });
            return;
        }
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
        resizing = '';
    });

    /* 播完一次就把时间轴存下来，下次再看同一集直接按轴回放。
       ended 事件不冒泡，所以挂在捕获阶段。 */
    document.addEventListener('ended', () => {
        try { saveTimeline(); } catch (e) { /* ignore */ }
    }, true);
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('mousemove', e => { onPointerMove(e); hoverCursor(e); }, true);
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
        ['fontSize', 'originalScale', 'lineCount', 'bgOpacity', 'debounceDelay'].forEach(k => {
            if (payload[k] !== undefined) next[k] = Number(payload[k]);
        });
        if (payload.position !== undefined) next.position = payload.position;
        if (payload.width !== undefined) next.width = payload.width;
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
        /* 直接现查一次，而不是看 rootEl —— 回放模式下主循环不会走 DOM 采集，
           rootEl 永远是空的，弹窗据此判断就会漏掉"本页其实有原生字幕"。 */
        let mode = nativeCaptionNow() || 'none';
        if (mode === 'none' && videoEl && videoEl.textTracks) {
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
            aiRunning: !!(aiStatus && aiStatus.running),
            aiActive: aiActive,
            aiStatus: aiStatus ? aiStatus.status : 'idle',
            aiDetail: aiStatus ? aiStatus.detail : '',
            aiProgress: aiStatus ? aiStatus.progress : 0,
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
                    if (req.resetPosition) {
                        S.position = null;
                        S.width = null;
                        saveStorage({ position: null, width: null });
                        positionOverlay(true);
                    }
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
                    S.width = null;
                    saveStorage({ position: null, width: null });
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
    /* SPA 路由监听：YouTube 用自己的 yt-navigate-* 事件，其余站点靠
       pushState / replaceState / popstate 补丁；tick 里还有一层兜底比对。 */
    (function hookNavigation() {
        const fire = () => { try { onNavigate(); } catch (e) { /* ignore */ } };

        ['pushState', 'replaceState'].forEach(name => {
            const orig = history[name];
            if (typeof orig !== 'function') return;
            history[name] = function () {
                const ret = orig.apply(this, arguments);
                fire();
                return ret;
            };
        });

        window.addEventListener('popstate', fire);
        window.addEventListener('hashchange', fire);
        ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated', 'spfdone']
            .forEach(ev => window.addEventListener(ev, fire, true));
    })();

    document.addEventListener('fullscreenchange', () => {
        mountOverlay();
        refreshMountBase();
        positionOverlay(true);
    });
    window.addEventListener('resize', () => positionOverlay(true), { passive: true });
    window.addEventListener('scroll', () => positionOverlay(false), { passive: true, capture: true });

    /* AI 识别的文本由后台推过来（不走 action 通道，避免和站点操作混在一起） */
    chrome.runtime.onMessage.addListener(msg => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'AI_CAPTION') {
            handleAiCaption(msg.text, msg.final, msg);
            return;
        }
        if (msg.type === 'AI_ELSEWHERE') {
            showNotice('AI 字幕正在另一个标签页识别',
                '「' + String(msg.title || '') + '」· 想在本页使用，请点扩展图标重新开启');
            return;
        }
        if (msg.type === 'AI_STATE') {
            aiStatus = msg.state || null;
            if (aiStatus && !aiStatus.running) {       // 后台已经停了，这里立刻清场
                aiActive = false;
                aiLastText = '';
                if (hostEl && hostEl.style.display !== 'none') clearOverlay();
            }
        }
    });

    /* 一次只能捕获一个标签页，切到别的视频页时说明字幕在哪儿，
       免得用户在新页面上等一个永远不会来的字幕 */
    let noticeEl = null;
    let noticeBox = null;
    let noticeTimer = 0;

    function showNotice(title, sub) {
        if (!noticeEl) {
            noticeEl = document.createElement('div');
            noticeEl.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;' +
                'z-index:2147483647;pointer-events:none;';
            const sh = noticeEl.attachShadow({ mode: 'open' });
            sh.innerHTML = '<style>' +
                '.n{font:500 13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
                'color:#3b2f24;background:rgba(252,247,238,.97);border:1px solid rgba(160,130,95,.35);' +
                'border-radius:12px;padding:10px 14px;max-width:320px;' +
                'box-shadow:0 8px 24px rgba(80,60,40,.18);opacity:0;' +
                'transform:translateY(8px);transition:opacity .22s ease,transform .22s ease}' +
                '.n.on{opacity:1;transform:none}' +
                '.k{margin-top:4px;font-weight:400;font-size:12px;color:#6b5a48}' +
                '</style><div class="n" id="n"><div id="t"></div><div class="k" id="k"></div></div>';
            noticeBox = sh.getElementById('n');
            noticeEl.__t = sh.getElementById('t');
            noticeEl.__k = sh.getElementById('k');
        }
        noticeEl.__t.textContent = title || 'AI 字幕正在另一个标签页识别';
        noticeEl.__k.textContent = sub || '';
        noticeEl.__k.style.display = sub ? '' : 'none';
        const parent = document.fullscreenElement || document.body;
        if (parent && noticeEl.parentNode !== parent) parent.appendChild(noticeEl);
        clearTimeout(noticeTimer);
        requestAnimationFrame(() => noticeBox.classList.add('on'));
        noticeTimer = setTimeout(() => {
            noticeBox.classList.remove('on');
            setTimeout(() => { if (noticeEl && noticeEl.parentNode) noticeEl.remove(); }, 300);
        }, 8000);
    }

    /* 3.2 起所有语种统一为双语（译文大 + 原文小）。
       旧版本点过「影院 / 极简」会把 showOriginal 存成 false，这里做一次性迁移。 */
    const SCHEMA_VERSION = 3.4;

    (async function init() {
        const raw = await getStorage();
        S = normalize(raw);
        if (Number(raw.schemaVersion || 0) < SCHEMA_VERSION) {
            S.showOriginal = true;
            saveStorage({ showOriginal: true, schemaVersion: SCHEMA_VERSION });
        }
        ensureOverlay();
        applySettings();
        setInterval(tick, 250);

        // 整页刷新后 content script 是全新的，若后台的识别还在跑，这里要接回去
        try {
            chrome.runtime.sendMessage({ type: 'AI_GET_STATE' }, st => {
                if (chrome.runtime.lastError) return;
                if (st && st.running) aiStatus = st;
            });
        } catch (e) { /* ignore */ }
        tick();
        console.log('[SubLingo] 已就绪 ·', SITE ? SITE.name : hostName);
    })();
})();
