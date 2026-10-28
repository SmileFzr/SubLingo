/* =========================================================
 * SubLingo · 背景服务（Service Worker）
 *
 * 职责：AI 字幕的会话编排
 *   1. 权限申请（tabCapture 是可选项，用户点了才要）
 *   2. offscreen 文档的创建 / 探活 / 销毁
 *   3. 向标签页申请音频流 id，交给 offscreen 消费
 *   4. 把识别出的文本路由回对应标签页的 content script
 *
 * 注意：MV3 的 Service Worker 随时会被休眠，所以会话状态一律
 * 存在 chrome.storage.session 里，而不是内存变量。
 * =======================================================*/

const OFFSCREEN_URL = 'offscreen.html';
const SESSION_KEY = 'aiSession';
const LOG_KEY = 'aiLogs';
const LOG_MAX = 120;

const IDLE_SESSION = {
    running: false,
    tabId: null,
    tabTitle: '',        // 会话所在标签的标题：用户切走后要明确告诉他在哪个标签
    tabUrl: '',          // 用来判断整页跳转是否真的换了页面（忽略锚点）
    model: 'base',
    status: 'idle',      // idle | requesting | downloading | loading | listening | error
    detail: '',
    progress: 0,
    since: 0
};

let creatingOffscreen = null;
let lastStatusKey = '';        // 状态去重，避免日志被重复事件刷满
let lastProgressBucket = -1;

/* ---------------- 诊断日志（环形缓冲，存在 session 里不受休眠影响） ---------------- */

async function log(line) {
    try {
        const box = await chrome.storage.session.get(LOG_KEY);
        const arr = box[LOG_KEY] || [];
        const t = new Date().toISOString().slice(11, 23);
        arr.push(t + ' ' + line);
        while (arr.length > LOG_MAX) arr.shift();
        await chrome.storage.session.set({ [LOG_KEY]: arr });
    } catch (e) { /* 存储配额或会话失效，忽略 */ }
}

/* ---------------- 会话状态 ---------------- */

async function getSession() {
    const box = await chrome.storage.session.get(SESSION_KEY);
    return Object.assign({}, IDLE_SESSION, box[SESSION_KEY] || {});
}

async function setSession(patch) {
    const next = Object.assign({}, await getSession(), patch);
    await chrome.storage.session.set({ [SESSION_KEY]: next });
    // popup 可能没开，消息发不出去是常态，静默忽略
    chrome.runtime.sendMessage({ type: 'AI_STATE', state: next }).catch(() => {});
    return next;
}

/* ---------------- offscreen 文档 ---------------- */

async function hasOffscreen() {
    try {
        const ctxs = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
        });
        return ctxs.length > 0;
    } catch (e) {
        return false;
    }
}

async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    if (creatingOffscreen) { await creatingOffscreen; return; }
    creatingOffscreen = chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: '捕获当前标签页音频，在本地设备上做语音识别以生成字幕'
    });
    try {
        await creatingOffscreen;
    } finally {
        creatingOffscreen = null;
    }
}

/* offscreen 文档刚创建时监听器可能还没注册好，用短轮询等它就绪 */
async function waitOffscreenReady(tries = 40) {
    for (let i = 0; i < tries; i++) {
        try {
            const r = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING', target: 'offscreen' });
            if (r && r.ok) return true;
        } catch (e) { /* 接收端还不存在，继续等 */ }
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

async function closeOffscreen() {
    try { await chrome.offscreen.closeDocument(); } catch (e) { /* 已经没了 */ }
}

/* ---------------- 启停 ---------------- */

async function startAI(tabId, model, streamId) {
    const s = await getSession();
    if (s.running) {
        if (s.tabId === tabId) return s;
        await stopAI();          // 一次只服务一个标签页，切站先停旧的
    }

    const granted = await chrome.permissions.contains({ permissions: ['tabCapture'] });
    if (!granted) {
        const err = new Error('NEED_PERMISSION');
        err.code = 'NEED_PERMISSION';
        throw err;
    }

    await log('START tab=' + tabId + ' model=' + model + ' streamId=' + (streamId ? 'from-popup' : 'MISSING'));
    await setSession({ status: 'requesting', tabId, model, detail: '', progress: 0 });
    await ensureOffscreen();

    if (!await waitOffscreenReady()) {
        await closeOffscreen();
        await log('ERR offscreen 未就绪');
        await setSession({ status: 'error', detail: '音频模块启动失败', running: false, tabId: null });
        const err = new Error('OFFSCREEN_NOT_READY');
        err.code = 'OFFSCREEN_NOT_READY';
        throw err;
    }
    await log('offscreen ready');

    /* 正常路径：streamId 由弹窗在点击手势里取好传进来。
       只有绕过弹窗直接调后台时才会走到兜底——那时没有用户手势，
       Chrome 会拒绝（Extension has not been invoked…），所以只作保底。 */
    if (!streamId) {
        try {
            streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        } catch (e) {
            await closeOffscreen();
            await log('ERR getMediaStreamId(sw) ' + (e.message || e));
            await setSession({ status: 'error', detail: '无法获取标签页音频：' + (e.message || e), running: false, tabId: null });
            throw e;
        }
    }

    const cfg = await chrome.storage.sync.get(['sourceLang', 'targetLang']);

    const res = await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_START',
        target: 'offscreen',
        streamId,
        tabId,
        model: model || 'base',
        sourceLang: cfg.sourceLang || 'auto'
    });

    if (!res || !res.ok) {
        await closeOffscreen();
        await log('ERR offscreen start ' + ((res && res.error) || 'no response'));
        await setSession({ status: 'error', detail: (res && res.error) || '启动失败', running: false, tabId: null });
        const err = new Error((res && res.error) || 'START_FAILED');
        err.code = 'START_FAILED';
        throw err;
    }

    await log('offscreen started');
    let tabTitle = '';
    let tabUrl = '';
    try {
        const tab = await chrome.tabs.get(tabId);
        tabTitle = (tab && tab.title) || '';
        tabUrl = (tab && tab.url) || '';
    } catch (e) { /* 标签可能已关 */ }
    return setSession({
        running: true, tabId, tabTitle, tabUrl, model: model || 'base', status: 'loading', since: Date.now()
    });
}

/* 关闭 offscreen 后 Chrome 是异步释放捕获的，立刻重启会撞
   "Cannot capture a tab with an active stream"，所以等一下再返回。 */
async function waitCaptureReleased(tabId, tries = 20) {
    if (!tabId) return true;
    for (let i = 0; i < tries; i++) {
        try {
            const tabs = await chrome.tabCapture.getCapturedTabs();
            const busy = (tabs || []).some(t => t.tabId === tabId && t.status === 'active');
            if (!busy) return true;
        } catch (e) {
            return true;                 // 拿不到就当已释放，别把流程卡死
        }
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
}

async function stopAI() {
    const prev = await getSession();
    try {
        await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP', target: 'offscreen' });
    } catch (e) { /* offscreen 可能已销毁 */ }
    await closeOffscreen();
    await waitCaptureReleased(prev && prev.tabId);
    await log('STOP tab=' + (prev && prev.tabId));
    // 让页面立刻收起字幕层，不用等 9 秒的静默超时
    if (prev && prev.tabId) {
        chrome.tabs.sendMessage(prev.tabId, { type: 'AI_STATE', state: { running: false } },
            { frameId: 0 }).catch(() => {});
    }
    return setSession({ running: false, tabId: null, tabTitle: '', tabUrl: '', status: 'idle', detail: '', progress: 0 });
}

/* ---------------- 消息路由 ---------------- */

/* 页面换了（同标签页内换直播间 / 换视频 / 整页跳转）：
   音频流本身不用重建，但缓冲里还留着上一场的几秒音频，
   在途的那次推理也会带着旧内容回来——两者都必须作废。 */
async function resetAsr(reason) {
    const s = await getSession();
    if (!s.running) return;
    let ok = false;
    try {
        const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_RESET', target: 'offscreen' });
        ok = !!(res && res.ok);
    } catch (e) { ok = false; }
    await log('RESET ' + reason + ' ok=' + ok);
}

const fromOffscreen = sender =>
    typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL('offscreen'));

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg && msg.target === 'offscreen') return;          // 不是给我的

    switch (msg && msg.type) {
        case 'AI_GET_STATE':
            getSession().then(respond);
            return true;

        case 'AI_START':
            (async () => {
                try {
                    const tabId = msg.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
                    const s = await startAI(tabId, msg.model, msg.streamId);
                    respond({ ok: true, state: s });
                } catch (e) {
                    respond({ ok: false, code: e.code || 'ERROR', error: e.message });
                }
            })();
            return true;

        case 'AI_STOP':
            (async () => respond({ ok: true, state: await stopAI() }))();
            return true;

        /* 内容脚本发现路由变了（换直播间 / 换视频）——这是 SPA 导航，
           tabs.onUpdated 不会触发，必须由页面自己报上来。 */
        case 'AI_NAV':
            (async () => {
                const s = await getSession();
                if (!s.running || !sender.tab || sender.tab.id !== s.tabId) {
                    respond({ ok: false });
                    return;
                }
                await resetAsr('nav ' + String(msg.key || '').slice(0, 60));
                respond({ ok: true });
            })();
            return true;

        /* 页面发现站内本来就有字幕 —— AI 让位。
           两套字幕叠在一起既互相覆盖，又会因为滑窗把刚看过的那句再带出来一次。 */
        case 'AI_AUTO_OFF':
            (async () => {
                const s = await getSession();
                if (!s.running || !sender.tab || sender.tab.id !== s.tabId) {
                    respond({ ok: false });
                    return;
                }
                await log('AUTO_OFF 站内已有字幕（' + (msg.reason || '') + '），停用 AI 识别');
                await stopAI();
                respond({ ok: true });
            })();
            return true;

        case 'AI_LOG_GET':
            (async () => {
                const box = await chrome.storage.session.get(LOG_KEY);
                respond(box[LOG_KEY] || []);
            })();
            return true;

        // ---- 以下来自 offscreen ----
        case 'AI_LOG':
            if (!fromOffscreen(sender)) return;
            log(String(msg.line || '').slice(0, 300));
            return;

        case 'AI_STATUS':
            if (!fromOffscreen(sender)) return;
            (async () => {
                await setSession({ status: msg.status, detail: msg.detail || '', progress: msg.progress || 0 });
                // 下载进度每秒会推十几次，全写日志会把环形缓冲刷满、
                // 把真正有用的诊断信息挤掉。这里只记录"状态变化"。
                const key = msg.status + '|' + (msg.detail || '');
                if (msg.status === 'downloading') {
                    const bucket = Math.floor((msg.progress || 0) / 20) * 20;
                    if (bucket === lastProgressBucket) return;
                    lastProgressBucket = bucket;
                } else {
                    if (key === lastStatusKey) return;
                    lastStatusKey = key;
                }
                // listening 每段都会带上新的延迟数字，写日志只会刷屏
                if (msg.status === 'listening') return;
                log('status=' + msg.status + (msg.detail ? ' ' + msg.detail : '')
                    + (msg.status === 'downloading' ? ' ' + (msg.progress || 0) + '%' : ''));
            })();
            return;

        case 'AI_CAPTION':
            if (!fromOffscreen(sender)) return;
            (async () => {
                const s = await getSession();
                if (!s.running || !s.tabId) return;
                log('caption rms=' + msg.rms + ' seg=' + msg.segMs + 'ms cost=' + msg.cost
                    + 'ms | ' + String(msg.text || '').slice(0, 50));
                chrome.tabs.sendMessage(
                    s.tabId,
                    {
                        type: 'AI_CAPTION',
                        text: msg.text,
                        startAt: msg.startAt,
                        final: msg.final !== false,
                        segMs: msg.segMs,
                        cost: msg.cost
                    },
                    { frameId: 0 }
                ).catch(() => { /* 页面可能已经关了 */ });
            })();
            return;

        case 'AI_FAILED':
            if (!fromOffscreen(sender)) return;
            (async () => {
                log('FAILED fatal=' + !!msg.fatal + ' ' + (msg.detail || ''));
                if (msg.fatal) await stopAI();
                await setSession({ status: 'error', detail: msg.detail || '识别中断' });
            })();
            return;
    }
});

/* ---------------- 页面生命周期 ---------------- */

chrome.tabs.onRemoved.addListener(async id => {
    const s = await getSession();
    if (s.running && s.tabId === id) stopAI();
});

/* 整页跳转（不是 SPA）时新页面里的脚本把当前地址当初始状态，
   不会自己报「导航了」，所以这里兜一层。
   只比 # 之前的部分：同一页加锚点（YouTube 的 #t=30）不算换视频，
   否则会白白丢掉一整段缓冲。 */
chrome.tabs.onUpdated.addListener(async (id, info) => {
    if (!info.url) return;
    const s = await getSession();
    if (!s.running || s.tabId !== id) return;
    const strip = u => String(u || '').split('#')[0];
    if (strip(info.url) === strip(s.tabUrl)) return;
    await setSession({ tabUrl: info.url });
    await resetAsr('url ' + info.url.slice(0, 60));
});

/* 一次只能捕获一个标签页的音频，且换了标签就没法迁移（Chrome 要求
   重新由用户点击授权）。所以用户切到另一个视频页时，直接告诉他
   「字幕还在原来那个标签」，而不是让他在新页面上干等。 */
const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|tiktok\.com|bilibili\.com|twitch\.tv|kick\.com)$/;
const noticeAt = new Map();

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    const s = await getSession();
    if (!s.running || !s.tabId || s.tabId === tabId) return;
    const last = noticeAt.get(tabId) || 0;
    if (Date.now() - last < 20000) return;      // 来回切标签不要反复弹
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { return; }
    let host = '';
    try { host = new URL(tab.url || '').hostname; } catch (e) { return; }
    if (!VIDEO_HOSTS.test(host)) return;
    noticeAt.set(tabId, Date.now());
    chrome.tabs.sendMessage(tabId, {
        type: 'AI_ELSEWHERE',
        title: s.tabTitle || '另一个标签页'
    }, { frameId: 0 }).catch(() => { /* 页面里没脚本就算了 */ });
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.session.set({ [SESSION_KEY]: IDLE_SESSION });
});

chrome.runtime.onStartup.addListener(() => {
    chrome.storage.session.set({ [SESSION_KEY]: IDLE_SESSION });
});
