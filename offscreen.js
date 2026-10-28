/* =========================================================
 * Offscreen 文档：音频采集 + 推理编排
 *
 * 为什么需要它：MV3 的 Service Worker 里没有 DOM，拿不到
 * getUserMedia / AudioContext。offscreen 文档是扩展自己的
 * 页面（不受站点 CSP 限制），在这里做音频重采样最稳。
 *
 * 音频链路：
 *   标签页流 ──┬─→ 回接扬声器（不回接的话标签页会被捕获后静音）
 *              └─→ AudioContext(16kHz) ─→ Worklet ─→ 100ms PCM ─→ Worker
 * =======================================================*/

const cleanups = [];
const track = fn => cleanups.push(fn);

let worker = null;
let workletNode = null;
let captureCtx = null;
let outputCtx = null;
let mediaStream = null;
let running = false;

function post(type, payload) {
    return chrome.runtime.sendMessage(Object.assign({ type }, payload)).catch(() => {});
}

/* 只上报本插件自己的关键事件，攒到后台的环形缓冲里，供「复制诊断」取用 */
function report(line) {
    post('AI_LOG', { line: line });
}

async function teardown() {
    running = false;
    while (cleanups.length) {
        const fn = cleanups.pop();
        try { fn(); } catch (e) { /* 资源可能已失效 */ }
    }
    workletNode = null;
    captureCtx = null;
    outputCtx = null;
    mediaStream = null;
    worker = null;
}

async function start(cfg) {
    await teardown();
    report('start streamId=' + (cfg.streamId ? cfg.streamId.slice(0, 6) + '…' : 'MISSING'));

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: cfg.streamId
                }
            },
            video: false
        });
    } catch (e) {
        report('getUserMedia 失败: ' + (e && e.name) + ' ' + ((e && e.message) || ''));
        throw e;
    }
    mediaStream = stream;
    track(() => stream.getTracks().forEach(t => t.stop()));
    report('stream ok, audioTracks=' + stream.getAudioTracks().length);

    // ① 把捕获到的声音送回扬声器。tabCapture 会把原标签页静音，
    //    不回接的话用户一开字幕视频就没声音了。
    const outCtx = new AudioContext();
    outputCtx = outCtx;
    track(() => outCtx.close());
    outCtx.createMediaStreamSource(stream).connect(outCtx.destination);
    if (outCtx.state === 'suspended') outCtx.resume().catch(() => {});

    // ② 独立的 16kHz 上下文，让浏览器替我们做重采样
    const capCtx = new AudioContext({ sampleRate: 16000 });
    captureCtx = capCtx;
    track(() => capCtx.close());
    if (capCtx.state === 'suspended') capCtx.resume().catch(() => {});

    const srMismatch = Math.abs(capCtx.sampleRate - 16000) > 1;
    report('audioCtx=' + capCtx.sampleRate + 'Hz' + (srMismatch ? '（浏览器未按 16k 重采样）' : ''));

    await capCtx.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));

    const node = new AudioWorkletNode(capCtx, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        // 必须让双声道原样进来，由 worklet 自己挑一路。
        // 设成 1 会让浏览器先做 (L+R)/2 下混，相位差直接抵消掉一半能量。
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers'
    });
    workletNode = node;
    track(() => { try { node.port.postMessage('stop'); node.disconnect(); } catch (e) {} });

    // 输出接一个静音增益再进 destination：有些实现下不接输出端
    // 就不会驱动 process()
    const mute = capCtx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(capCtx.destination);

    node.port.onmessage = ev => {
        if (!worker || !running) return;
        worker.postMessage({ type: 'AUDIO', buf: ev.data }, [ev.data]);
    };

    capCtx.createMediaStreamSource(stream).connect(node);

    // ③ 推理 Worker（module worker，内部 import transformers.js）
    const w = new Worker(chrome.runtime.getURL('asr-worker.js'), { type: 'module' });
    worker = w;
    track(() => w.terminate());

    w.onmessage = ev => {
        const m = ev.data || {};
        if (m.type === 'CAPTION') {
            post('AI_CAPTION', {
                text: m.text, startAt: m.startAt, final: m.final,
                rms: m.rms, cost: m.cost, segMs: m.segMs
            });
        } else if (m.type === 'LOG') {
            report('asr ' + String(m.line || '').slice(0, 200));
        } else if (m.type === 'STATUS') {
            post('AI_STATUS', { status: m.status, detail: m.detail, progress: m.progress });
        } else if (m.type === 'ERROR') {
            post('AI_FAILED', { fatal: !!m.fatal, detail: m.detail });
        }
    };
    w.onerror = e => {
        post('AI_FAILED', { fatal: true, detail: '推理模块异常：' + (e.message || '未知错误') });
    };

    w.postMessage({
        type: 'INIT',
        baseUrl: chrome.runtime.getURL(''),
        model: cfg.model || 'base',
        sourceLang: cfg.sourceLang || 'auto',
        sampleRate: capCtx.sampleRate,
        resampled: srMismatch
    });

    running = true;
    report('worklet+worker 就绪，等待模型');
    post('AI_STATUS', { status: 'loading', detail: '正在准备模型', progress: 0 });
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || msg.target !== 'offscreen') return;

    if (msg.type === 'OFFSCREEN_PING') {
        respond({ ok: true });
        return;
    }

    if (msg.type === 'OFFSCREEN_START') {
        start(msg).then(
            () => respond({ ok: true }),
            err => {
                teardown();
                respond({ ok: false, error: err && err.message ? err.message : String(err) });
            }
        );
        return true;
    }

    if (msg.type === 'OFFSCREEN_STOP') {
        teardown().then(() => respond({ ok: true }));
        return true;
    }

    /* 页面切换：音频流不用重建（tabCapture 绑的是标签页），
       只需要让 worker 丢掉上一场的缓冲和在途结果。 */
    if (msg.type === 'OFFSCREEN_RESET') {
        if (worker && running) {
            worker.postMessage({ type: 'RESET' });
            respond({ ok: true });
        } else {
            respond({ ok: false });
        }
        return;
    }
});

window.addEventListener('pagehide', () => { teardown(); });
