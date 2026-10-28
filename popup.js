// popup.js — SubLingo v3.2（实时生效，无需点“应用”）

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
    aiModel: 'base'
};

const PRESETS = {
    cinema: { fontColor: '#FFFFFF', bgColor: '#0B0B0D', bgOpacity: 62, fontSize: 100, originalScale: 68, lineCount: 2, showOriginal: true },
    class: { fontColor: '#FFE7B3', bgColor: '#1A1512', bgOpacity: 76, fontSize: 105, originalScale: 64, lineCount: 3, showOriginal: true },
    minimal: { fontColor: '#FFFFFF', bgColor: '#000000', bgOpacity: 0, fontSize: 95, originalScale: 66, lineCount: 2, showOriginal: true },
    contrast: { fontColor: '#FFE45C', bgColor: '#000000', bgOpacity: 86, fontSize: 110, originalScale: 62, lineCount: 2, showOriginal: true }
};

const MODE_TEXT = {
    dom: '站内字幕已接管',
    track: '原生字幕轨道',
    file: '本地字幕文件',
    none: '暂未检测到字幕源',
    missing: '当前页面未运行',
    restricted: '浏览器内置页面不支持'
};

const SCHEMA_VERSION = 3.4;

const $ = id => document.getElementById(id);

let settings = Object.assign({}, DEFAULTS);
let tabId = null;
let saveTimer = null;
let status = null;

/* ---------------- 存储 ---------------- */
let migrated = false;

function loadSettings() {
    return new Promise(resolve => {
        chrome.storage.sync.get(null, data => {
            const s = Object.assign({}, DEFAULTS);
            Object.keys(DEFAULTS).forEach(k => {
                if (data && data[k] !== undefined && data[k] !== null) s[k] = data[k];
            });
            // 3.2 起统一双语：旧版"仅译文"一次性迁移为显示原文
            if (Number((data && data.schemaVersion) || 0) < SCHEMA_VERSION) {
                s.showOriginal = true;
                // 3.4：实测 tiny 在日语/韩语 + 背景音乐上只吐 (music)，认不出人声，
                // 统一升到 base；想省性能的用户可以自己切回「快速」。
                if (!data || !data.aiModel || data.aiModel === 'tiny') s.aiModel = 'base';
                migrated = true;
            }
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
    $('original-scale').value = settings.originalScale;
    $('line-count').value = settings.lineCount;
    $('bg-opacity').value = settings.bgOpacity;
    $('font-color').value = settings.fontColor;
    $('bg-color').value = settings.bgColor;
    $('show-original').checked = !!settings.showOriginal;

    $('font-size-value').textContent = settings.fontSize;
    $('original-scale-value').textContent = settings.originalScale;
    $('line-count-value').textContent = settings.lineCount;
    $('bg-opacity-value').textContent = settings.bgOpacity;

    ['font-size', 'original-scale', 'line-count', 'bg-opacity'].forEach(id => updateFill($(id)));
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
    /* 站点自己的字幕要是已经在出，就不该再跑识别了 ——
       两套文本会互相覆盖，而且识别每段都盯着前面几秒，读起来像重复字幕。
       click 处理里不能 await，所以这里先缓存下来。 */
    nativeCap = (st && st.ok && st.mode && st.mode !== 'none') ? st.mode : '';
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
        ['original-scale', 'originalScale', v => v],
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

/* ---------------- AI 语音识别 ---------------- */
let aiState = null;
let hasCapture = false;      // tabCapture 权限缓存：click 处理里不能 await，所以提前查好
let lastRawError = '';       // 最近一次取流的原始报错，诊断时要原样带出去
let nativeCap = '';          // 本页已有的字幕来源：dom / track / file；空 = 没有
let forceUntil = 0;          // 用户在"已有原生字幕"提示后再点一次，允许强制识别

/* Chrome 对 getMediaStreamId 有两道硬要求（官方 DevRel 明确过）：
 *   1) 必须在用户手势的同一个 click 处理里**同步发起**，中间不能插入 await
 *   2) 目标标签页必须"刚被扩展调用过"（activeTab 授权，页面一跳转就失效）
 * 所以取流 id 只能放在弹窗的点击里做。之前丢给后台服务算，
 * 中间隔了消息传递 + 建 offscreen + 轮询就绪，手势和 tab 授权都过期了，
 * 于是报 "Extension has not been invoked for the current page"。 */
const CAPTURE_ERR = [
    [/not been invoked|activeTab/i,
     '这次点击没被识别：关掉弹窗 → 点一下网页空白处 → 再点扩展图标 → 立刻点开启'],
    [/permission/i, '缺少「读取标签页音频」权限，请重新开启一次'],
    [/active stream|being captured/i, '该标签页还在被上一次捕获占用，等一秒再试'],
    [/not secure|scheme|Invalid tab/i, '当前页面不是 https，Chrome 不允许读取音频'],
    [/chrome:\/\/|chrome-extension:/i, 'Chrome 内置页面无法捕获音频']
];

function captureErrorText(e) {
    const raw = (e && e.message) || String(e);
    for (const [re, txt] of CAPTURE_ERR) if (re.test(raw)) return txt;
    return '无法获取标签页音频：' + raw;
}

const AI_TEXT = {
    idle: '无字幕时本地识别 · 建议「均衡」以上',
    requesting: '正在获取标签页音频…',
    downloading: '下载模型',
    loading: '准备识别引擎…',
    listening: '本地识别中',
    hint: '本页已有原生字幕',
    error: '出错了'
};

function renderAi(s) {
    if (s) aiState = s;
    const st = aiState || { running: false, status: 'idle', progress: 0, detail: '' };

    document.querySelectorAll('#ai-models button').forEach(b => {
        b.classList.toggle('on', b.dataset.model === (settings.aiModel || 'base'));
        b.disabled = !!st.running;      // 跑着的时候不让切模型，切了必须重启
    });

    const el = $('ai-state');
    let text = AI_TEXT[st.status] || '未启用';
    if (st.status === 'downloading') text = '下载模型 ' + (st.progress || 0) + '%';
    else if (st.status === 'listening') text = st.detail || '本地识别中';
    else if (st.status === 'hint') text = st.detail || AI_TEXT.hint;
    else if (st.status === 'error') text = st.detail || '识别出错';
    /* 一次只能捕获一个标签页，而且换标签必须重新点图标授权。
       在本页看到"监听中"却是别的标签在跑，很容易误判成没反应。 */
    if (st.running && st.tabId && tabId && st.tabId !== tabId) {
        text = '在另一个标签页识别 · ' + (st.tabTitle || '切回那个标签查看');
    }
    el.textContent = text;
    el.title = st.status === 'error' ? text : (st.running && st.tabId !== tabId ? text : '');
    el.className = 'ai-state' + (st.status === 'listening' ? ' on' : st.status === 'error' ? ' err' : '');

    const btn = $('ai-btn');
    btn.textContent = st.running ? '停止' : '开启';
    btn.classList.toggle('stop', !!st.running);
    btn.disabled = st.status === 'requesting';

    const diag = $('ai-diag');
    if (diag) diag.hidden = st.status !== 'error';

    const showBar = !!st.running && (st.status === 'downloading' || st.status === 'loading');
    $('ai-bar').classList.toggle('show', showBar);
    $('ai-bar-fill').style.width = (st.progress || 0) + '%';
}

function bindAi() {
    document.querySelectorAll('#ai-models button').forEach(b => {
        b.addEventListener('click', async () => {
            if (aiState && aiState.running) return;
            settings.aiModel = b.dataset.model;
            await chrome.storage.sync.set({ aiModel: settings.aiModel });
            renderAi();
        });
    });

    $('ai-btn').addEventListener('click', async () => {
        const btn = $('ai-btn');

        if (aiState && aiState.running) {
            btn.disabled = true;
            try { await chrome.runtime.sendMessage({ type: 'AI_STOP' }); } catch (e) {}
            btn.disabled = false;
            renderAi({ running: false, status: 'idle', progress: 0, detail: '' });
            return;
        }

        if (!tabId) return;

        /* 站内已经有字幕：直接用它，比识别准、也没有 8~10 秒延迟。
           但原生字幕要是不想要的语种，用户有权硬来 —— 再点一次即可。 */
        if (nativeCap && Date.now() > forceUntil) {
            forceUntil = Date.now() + 12000;
            return renderAi({
                running: false, status: 'hint',
                detail: '本页已有原生字幕，直接用它翻译就好（更快更准）。再点一次「开启」可强制启动语音识别'
            });
        }

        /* tabCapture 现在是 manifest 里的必需权限，不存在"先弹授权框"这一步了。
           这里唯一不能破的规矩：getMediaStreamId 必须是这次 click 里
           第一个异步调用。前面只要多一个 await，Chrome 就判定手势过期，
           报 "Extension has not been invoked for the current page"。 */
        let streamId = null;
        try {
            streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        } catch (e) {
            lastRawError = (e && e.message) || String(e);
            const granted = await chrome.permissions.contains({ permissions: ['tabCapture'] }).catch(() => true);
            return renderAi({
                running: false, status: 'error',
                detail: granted ? captureErrorText(e)
                    : '扩展缺少「读取标签页音频」权限：去 edge://extensions 重新加载一次扩展'
            });
        }
        renderAi({ running: true, status: 'requesting', progress: 0, detail: '' });

        let res = null;
        try {
            res = await chrome.runtime.sendMessage({
                type: 'AI_START', tabId, streamId,
                model: settings.aiModel || 'base'
            });
        } catch (e) {
            res = { ok: false, error: '后台无响应' };
        }
        btn.disabled = false;

        if (!res || !res.ok) {
            renderAi({ running: false, status: 'error', detail: (res && res.error) || '启动失败' });
        } else if (res.state) {
            renderAi(res.state);
        }
    });

    $('ai-diag').addEventListener('click', copyDiagnostics);
}

/* 一键收集「只跟本插件有关」的诊断信息，省得从几千行控制台里翻 */
async function copyDiagnostics() {
    const btn = $('ai-diag');
    const lines = ['## SubLingo v' + chrome.runtime.getManifest().version];
    lines.push('UA: ' + navigator.userAgent);

    try {
        const tab = await getActiveTab();
        lines.push('tab: id=' + (tab && tab.id) + ' url=' + (tab && tab.url));
    } catch (e) { lines.push('tab: 读取失败 ' + e.message); }
    lines.push('tabCapture 权限: ' + hasCapture);
    lines.push('最近一次取流报错: ' + (lastRawError || '(无)'));
    lines.push('AI 会话: ' + JSON.stringify(aiState));

    try {
        const page = await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' });
        lines.push('页面侧: ' + JSON.stringify(page));
    } catch (e) {
        lines.push('页面侧: 未注入（' + ((e && e.message) || e) + '）');
    }

    try {
        const logs = await chrome.runtime.sendMessage({ type: 'AI_LOG_GET' });
        lines.push('', '## 插件日志（最近若干条）');
        if (Array.isArray(logs) && logs.length) logs.forEach(l => lines.push(l));
        else lines.push('(空)');
    } catch (e) {
        lines.push('', '## 插件日志: 读取失败 ' + ((e && e.message) || e));
    }

    const text = lines.join('\n');
    if (btn) { btn.dataset.old = btn.textContent; }
    try {
        await navigator.clipboard.writeText(text);
        if (btn) { btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制诊断'; }, 1600); }
    } catch (e) {
        console.log(text);
        if (btn) { btn.textContent = '见控制台'; setTimeout(() => { btn.textContent = '复制诊断'; }, 1600); }
    }
}

chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'AI_STATE') renderAi(msg.state);
});

/* ---------------- 启动 ---------------- */
document.addEventListener('DOMContentLoaded', async () => {
    const tab = await getActiveTab();
    tabId = tab ? tab.id : null;
    try {
        hasCapture = await chrome.permissions.contains({ permissions: ['tabCapture'] });
    } catch (e) {
        hasCapture = false;
    }

    settings = await loadSettings();
    chrome.storage.sync.set({ schemaVersion: SCHEMA_VERSION });
    if (migrated) chrome.storage.sync.set({ showOriginal: true, aiModel: settings.aiModel });
    syncControls();
    bindEvents();
    bindAi();

    if (!tabId) {
        setStatus(null, 'restricted');
        renderAi();
        return;
    }

    try {
        const st = await chrome.runtime.sendMessage({ type: 'AI_GET_STATE' });
        renderAi(st || null);
    } catch (e) {
        renderAi();
    }

    await refreshStatus();
    setInterval(refreshStatus, 2000);
});
