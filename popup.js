// popup.js — SubLingo v3.0（实时生效，无需点“应用”）

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

const PRESETS = {
    cinema: { fontColor: '#FFFFFF', bgColor: '#0B0B0D', bgOpacity: 62, fontSize: 100, lineCount: 2, showOriginal: false },
    class: { fontColor: '#FFE7B3', bgColor: '#1A1512', bgOpacity: 76, fontSize: 105, lineCount: 3, showOriginal: true },
    minimal: { fontColor: '#FFFFFF', bgColor: '#000000', bgOpacity: 0, fontSize: 95, lineCount: 2, showOriginal: false },
    contrast: { fontColor: '#FFE45C', bgColor: '#000000', bgOpacity: 86, fontSize: 110, lineCount: 2, showOriginal: true }
};

const MODE_TEXT = {
    dom: '站内字幕已接管',
    track: '原生字幕轨道',
    file: '本地字幕文件',
    none: '暂未检测到字幕源',
    missing: '当前页面未运行',
    restricted: '浏览器内置页面不支持'
};

const $ = id => document.getElementById(id);

let settings = Object.assign({}, DEFAULTS);
let tabId = null;
let saveTimer = null;
let status = null;

/* ---------------- 存储 ---------------- */
function loadSettings() {
    return new Promise(resolve => {
        chrome.storage.sync.get(null, data => {
            const s = Object.assign({}, DEFAULTS);
            Object.keys(DEFAULTS).forEach(k => {
                if (data && data[k] !== undefined && data[k] !== null) s[k] = data[k];
            });
            resolve(s);
        });
    });
}

function persist(patch) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        chrome.storage.sync.set(patch);
        sendToTab({ action: 'SETTINGS', settings: patch });
    }, 120);
}

/* ---------------- 与页面通信 ---------------- */
async function getActiveTab() {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        return tabs[0] || null;
    } catch (e) {
        return null;
    }
}

async function sendToTab(msg) {
    if (!tabId) return null;
    try {
        return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
        return null;
    }
}

/* ---------------- 界面同步 ---------------- */
function updateFill(input) {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const val = Number(input.value);
    const p = max > min ? ((val - min) / (max - min)) * 100 : 50;
    input.style.setProperty('--p', p + '%');
}

function syncControls() {
    $('power').checked = !!settings.enabled;
    $('source-lang').value = settings.sourceLang;
    $('target-lang').value = settings.targetLang;
    $('font-size').value = settings.fontSize;
    $('line-count').value = settings.lineCount;
    $('bg-opacity').value = settings.bgOpacity;
    $('font-color').value = settings.fontColor;
    $('bg-color').value = settings.bgColor;
    $('show-original').checked = !!settings.showOriginal;

    $('font-size-value').textContent = settings.fontSize;
    $('line-count-value').textContent = settings.lineCount;
    $('bg-opacity-value').textContent = settings.bgOpacity;

    ['font-size', 'line-count', 'bg-opacity'].forEach(id => updateFill($(id)));
    markActivePreset();
}

function markActivePreset() {
    document.querySelectorAll('.chip').forEach(chip => {
        const p = PRESETS[chip.dataset.preset];
        const hit = p
            && p.fontColor.toLowerCase() === String(settings.fontColor).toLowerCase()
            && p.bgColor.toLowerCase() === String(settings.bgColor).toLowerCase()
            && Number(p.bgOpacity) === Number(settings.bgOpacity)
            && Number(p.fontSize) === Number(settings.fontSize);
        chip.classList.toggle('active', !!hit);
    });
}

function setStatus(st, mode) {
    const dot = $('dot');
    const nameEl = $('site-name');
    const textEl = $('engine-text');
    const enableBtn = $('btn-enable-site');

    dot.className = 'dot';
    enableBtn.hidden = true;

    if (st && st.ok) {
        nameEl.textContent = st.site || '当前页面';
        const label = MODE_TEXT[st.mode] || MODE_TEXT.none;
        const suffix = st.mode === 'file' && st.fileName ? ' · ' + st.fileName : '';
        textEl.textContent = st.enabled === false ? '字幕已关闭' : label + suffix;
        dot.classList.add(st.mode === 'none' ? 'warn' : 'ok');
        $('file-name').textContent = st.fileName || '未加载';
        $('file-name').classList.toggle('loaded', !!st.fileName);
        $('clear-file').hidden = !st.fileName;
        // 只有在没有字幕源时，才把「本地字幕」的说明展开，平时保持紧凑
        const fileCard = document.querySelector('.card.subtle');
        if (fileCard) fileCard.classList.toggle('need-hint', st.mode === 'none' && !st.fileName);
        return;
    }

    const fileCard = document.querySelector('.card.subtle');
    if (fileCard) fileCard.classList.add('need-hint');

    if (mode === 'restricted') {
        nameEl.textContent = '此页面不支持';
        textEl.textContent = '请在视频网站上使用';
    } else if (mode === 'missing') {
        nameEl.textContent = '此网站未启用';
        textEl.textContent = '点击右侧按钮授权后生效';
        enableBtn.hidden = false;
        dot.classList.add('warn');
    } else {
        nameEl.textContent = '未检测到页面';
        textEl.textContent = '请打开一个视频网站';
    }
}

/* ---------------- 状态拉取 ---------------- */
async function refreshStatus() {
    const st = await sendToTab({ action: 'GET_STATUS' });
    status = st;
    if (st && st.ok) {
        setStatus(st);
    } else {
        let mode = 'missing';
        try {
            const tab = await chrome.tabs.get(tabId);
            const url = new URL(tab.url || '');
            if (!/^https?:$/.test(url.protocol)) mode = 'restricted';
        } catch (e) { mode = 'restricted'; }
        setStatus(null, mode);
    }
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
    // 总开关
    $('power').addEventListener('change', e => {
        settings.enabled = e.target.checked;
        chrome.storage.sync.set({ enabled: settings.enabled });
        sendToTab({ action: 'SETTINGS', settings: { enabled: settings.enabled } });
        setTimeout(refreshStatus, 200);
    });

    // 语言
    ['source-lang', 'target-lang'].forEach(id => {
        $(id).addEventListener('change', () => {
            settings[id === 'source-lang' ? 'sourceLang' : 'targetLang'] = $(id).value;
            persist({
                sourceLang: settings.sourceLang,
                targetLang: settings.targetLang
            });
        });
    });

    $('swap').addEventListener('click', () => {
        const src = settings.sourceLang === 'auto' ? 'en' : settings.sourceLang;
        const tgt = settings.targetLang;
        settings.sourceLang = tgt;
        settings.targetLang = src === tgt ? 'zh' : src;
        if (settings.sourceLang === settings.targetLang) settings.targetLang = tgt === 'zh' ? 'en' : 'zh';
        syncControls();
        persist({ sourceLang: settings.sourceLang, targetLang: settings.targetLang });
    });

    // 预设
    document.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const p = PRESETS[chip.dataset.preset];
            if (!p) return;
            Object.assign(settings, p);
            syncControls();
            persist(Object.assign({}, p));
        });
    });

    // 滑块
    const ranges = [
        ['font-size', 'fontSize', v => v],
        ['line-count', 'lineCount', v => v],
        ['bg-opacity', 'bgOpacity', v => v]
    ];
    ranges.forEach(([id, key, map]) => {
        const el = $(id);
        el.addEventListener('input', () => {
            const v = map(parseInt(el.value, 10));
            settings[key] = v;
            const label = $(id + '-value');
            if (label) label.textContent = v;
            updateFill(el);
            markActivePreset();
            const patch = {};
            patch[key] = v;
            persist(patch);
        });
    });

    // 颜色
    $('font-color').addEventListener('input', e => {
        settings.fontColor = e.target.value;
        markActivePreset();
        persist({ fontColor: e.target.value });
    });
    $('bg-color').addEventListener('input', e => {
        settings.bgColor = e.target.value;
        markActivePreset();
        persist({ bgColor: e.target.value });
    });

    // 显示原文
    $('show-original').addEventListener('change', e => {
        settings.showOriginal = e.target.checked;
        persist({ showOriginal: e.target.checked });
    });

    // 本地字幕
    $('pick-file').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', async e => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const text = await file.text();
        const res = await sendToTab({ action: 'LOAD_SUBTITLE_FILE', name: file.name, text });
        if (res && res.ok) {
            $('file-name').textContent = res.name;
            $('file-name').classList.add('loaded');
            $('clear-file').hidden = false;
            $('engine-text').textContent = `本地字幕 · ${res.count} 条`;
            $('dot').className = 'dot ok';
        } else {
            $('file-name').textContent = res && res.error ? res.error : '解析失败';
            $('file-name').classList.remove('loaded');
        }
        e.target.value = '';
    });
    $('clear-file').addEventListener('click', async () => {
        await sendToTab({ action: 'CLEAR_SUBTITLE_FILE' });
        $('file-name').textContent = '未加载';
        $('file-name').classList.remove('loaded');
        $('clear-file').hidden = true;
        refreshStatus();
    });

    // 重新检测
    $('btn-refresh').addEventListener('click', async () => {
        const btn = $('btn-refresh');
        const old = btn.textContent;
        btn.textContent = '正在重新检测…';
        await sendToTab({ action: 'MANUAL_REFRESH' });
        setTimeout(async () => {
            await refreshStatus();
            btn.textContent = old;
        }, 900);
    });

    // 导出
    $('btn-export').addEventListener('click', async () => {
        const res = await sendToTab({ action: 'REQUEST_EXPORT_SUBTITLES' });
        const btn = $('btn-export');
        if (!res || !res.subtitles) {
            btn.textContent = '暂无字幕';
            setTimeout(() => { btn.textContent = '导出 SRT'; }, 1400);
            return;
        }
        const blob = new Blob([res.subtitles], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sublingo-${Date.now()}.srt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        btn.textContent = '已导出';
        setTimeout(() => { btn.textContent = '导出 SRT'; }, 1400);
    });

    // 恢复默认
    $('btn-reset').addEventListener('click', async () => {
        const keepEnabled = settings.enabled;
        settings = Object.assign({}, DEFAULTS, { enabled: keepEnabled });
        syncControls();
        chrome.storage.sync.set(Object.assign({}, DEFAULTS, { enabled: keepEnabled }));
        await sendToTab({ action: 'SETTINGS', resetPosition: true, settings: settings });
        const btn = $('btn-reset');
        btn.textContent = '已恢复';
        setTimeout(() => { btn.textContent = '恢复默认'; }, 1200);
    });

    // 未在名单内站点：按需授权 + 注入
    $('btn-enable-site').addEventListener('click', async () => {
        const tab = await getActiveTab();
        if (!tab || !tab.url) return;
        let origin;
        try {
            origin = new URL(tab.url).origin + '/*';
        } catch (e) { return; }

        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) return;

        try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
            const btn = $('btn-enable-site');
            btn.textContent = '已启用';
            setTimeout(() => location.reload(), 600);
        } catch (e) {
            $('engine-text').textContent = '注入失败，请刷新页面后重试';
        }
    });
}

/* ---------------- 启动 ---------------- */
document.addEventListener('DOMContentLoaded', async () => {
    const tab = await getActiveTab();
    tabId = tab ? tab.id : null;

    settings = await loadSettings();
    syncControls();
    bindEvents();

    if (!tabId) {
        setStatus(null, 'restricted');
        return;
    }
    await refreshStatus();
    setInterval(refreshStatus, 2000);
});
