/* =========================================================
 * ASR Worker：本地 Whisper 语音识别
 *
 * 输入是 16kHz 单声道 Float32 帧（100ms 一批），输出是带
 * 时间戳的文本片段。
 *
 * 三个必须处理的问题：
 *   1. Whisper 的声学编码器固定按 30 秒窗口计算 —— 再短的音频
 *      成本也一样。所以不能每 100ms 就推理，必须按"句"聚合。
 *      代价就是首字延迟，这是模型本身的物理限制，不是实现问题。
 *   2. 静音/纯音乐上 Whisper 会产生幻觉（凭空写出"谢谢观看"
 *      "请订阅频道"），必须过滤，否则用户会看到莫名其妙的字幕。
 *   3. 推理必须串行。同时跑两次会瞬间吃掉几百 MB 内存。
 * =======================================================*/

import { env, pipeline } from './vendor/transformers.min.js';

const SR = 16000;
const FRAME_MS = 100;          // Worklet 每批 100ms
const SILENCE_CUT_MS = 500;    // 静音超过这个长度判定一句话结束
const MIN_SPEECH_MS = 1100;    // 太短的片段不值得推理（编码器成本固定）
const MAX_SEG_MS = 5000;       // 单段上限：窗口越短越容易只框住一句人声，
                               // 否则直播间的 BGM 会和人声混在一起被当成音乐。
                               // 但也不能低于一次推理的耗时，否则会排队积压。
const HARD_CAP_MS = 15000;     // 推理跟不上时丢前半段，避免延迟和内存无限增长

/* 实测：Whisper 的声学编码器固定按 30 秒窗口计算，所以单次推理
   耗时与音频长短基本无关（tiny+q8+单线程 WASM 约 2.5–4 秒）。
   机器跑得慢时就不出"中间结果"，只在句末算一次，避免 CPU 一直满载。 */
const INTERIM_GAP_FAST = 2800;
const INTERIM_GAP_SLOW = 999999;

const MODELS = {
    tiny: 'onnx-community/whisper-tiny',
    base: 'onnx-community/whisper-base',
    small: 'onnx-community/whisper-small'
};

let asr = null;
let ready = false;
let busy = false;

let cfg = { model: 'base', sourceLang: 'auto', baseUrl: '' };

let speech = [];               // 当前语音段的 PCM 分片
let speechSamples = 0;
let silentMs = 0;
let sinceInterimMs = 0;
let segRmsSum = 0;
let segFrames = 0;
let lastFrameAt = 0;

let lastSentText = '';
let lastFinalAt = 0;
let noiseFloor = 0.004;
let lastCost = 0;              // 上一次推理耗时，用来判断这台机器跟不跟得上
let langHint = '';             // 从成功识别里沉淀下来的语种，auto 模式下降噪明显
/* 页面切换（换直播间 / 换视频）时递增。推理是异步的，等结果回来时
   音频早就换成下一个主播了——用它把过期结果整段丢掉，不然上一场的话
   会飘到新画面上。 */
let gen = 0;
let hostName = '';
let silentStreak = 0;          // 连续多少段只有音乐/噪音（没有任何人声）
let reportedQuiet = false;     // 「未捕获到人声」的提示是否已经发过

/* ---------------- 幻觉过滤 ---------------- */

// Whisper 在静音、片头片尾、纯 BGM 上最容易吐出的固定句式
const JUNK_PATTERNS = [
    /^(谢谢(大家)?观看|感谢(您的|您的)?观看|感谢收看|请不吝|請不吝|订阅|訂閱|转发|轉發|打赏|打賞|点赞)/,
    /^(字幕(由|提供|制作|製作)|中文字幕|本字幕|翻译[:：]|翻譯)/,
    /^(thanks?\s*(you)?\s*(for)?\s*watching|thank\s*you|please\s*subscribe|subscribe|like\s*and\s*subscribe)/i,
    /(ご視聴ありがとうございました|チャンネル登録|高評価|最後までご視聴)/,
    /^(시청해\s*주셔서\s*감사|구독과\s*좋아요)/
];

const PUNCT_ONLY = /^[\s.。,，!！?？、~～\-—…·"'“”‘’()（）\[\]【】《》♪♫☆★]*$/;

/* Whisper 在没有语音（或人声被 BGM 盖住）时，不会什么都不说，
   而是输出一串"声音标签"：(music)、[Music]、（音乐）、(laughs)、♪。
   这些不是字幕，上屏只会挡住画面、让用户以为识别坏了。
   做法：先把标签和音符符号剥掉，看还剩下多少实质文字。 */
/* 括号里几乎总是带修饰词：(soft music)、(upbeat background music)、
   [Music playing]、(audience laughing)，所以不能只匹配单个词——
   只要整段括注里出现声音/音乐类关键词，就连括号一起剥掉。 */
const TAG_TOKEN = /[\(\（\[\【][^\)\）\]\】]{0,40}?(?:music|bgm|musique|musik|音楽|音乐|音樂|laugh|laughter|笑|applause|cheering|鼓掌|掌声|silence|blank[_\s]?audio|no[_\s]?speech|静音|noise|噪音|inaudible|unintelligible|indistinct|foreign\s*language|non-english|外語|外语|sigh|cough|咳|ゴホン|beep|wind|rain|ending|エンディング|結末|结束|終わり|拍手|無音|沈黙|♪)[^\)\）\]\】]{0,40}?[\)\）\]\】]/gi;
const MUSIC_NOTE = /[♪♫♬♩]/g;

function stripSoundTags(text) {
    return normalize(String(text || '').replace(TAG_TOKEN, ' ').replace(MUSIC_NOTE, ' '));
}

/* Whisper 在 BGM、回声或人声断断续续时会陷入"复读"：同一句被反复输出
   几十遍（"人就是这个人 who is the man who is the man …"），一屏全糊在一起，
   比不出字幕更糟。这里两道闸：

     1) 周期性压缩：同一个片段连续出现 ≥3 次就只留一次
     2) 4-gram 重复率：超过阈值说明整段是复读幻觉，直接丢弃

   正常说话的重复率通常在 0.1 以下，复读能到 0.5 以上，区分度足够。 */
function collapseRepeat(text) {
    let t = normalize(text);
    for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        for (let len = Math.min(40, Math.floor(t.length / 3)); len >= 1 && !changed; len--) {
            let out = '';
            let i = 0;
            while (i < t.length) {
                const unit = t.substr(i, len);
                let reps = 1;
                while (unit.length === len && t.substr(i + reps * len, len) === unit) reps++;
                /* 纯标点的重复不能压：省略号 "……" 、破折号 "——" 都是正常写法 */
                if (reps >= 3 && !/^[\s\p{P}]+$/u.test(unit)) {
                    out += unit;
                    i += reps * len;
                    changed = true;
                } else {
                    out += t[i];
                    i++;
                }
            }
            if (changed) t = out;
        }
        if (!changed) break;
    }
    return normalize(t);
}

function repeatRatio(text) {
    const s = String(text || '').replace(/\s+/g, '');
    if (s.length < 24) return 0;
    const grams = new Map();
    let dup = 0;
    let total = 0;
    for (let i = 0; i + 4 <= s.length; i++) {
        const g = s.slice(i, i + 4);
        total++;
        const c = (grams.get(g) || 0) + 1;
        grams.set(g, c);
        if (c > 1) dup++;
    }
    return total ? dup / total : 0;
}

/* 单条字幕不该比一屏还长：优先在句末断开，其次在空格断开 */
const MAX_TEXT_CHARS = 190;

function clampText(text, limit) {
    const t = String(text || '');
    if (t.length <= limit) return t;
    const head = t.slice(0, limit);
    let cut = -1;
    for (const ch of ['。', '.', '!', '?', '！', '？', '；', ';']) {
        cut = Math.max(cut, head.lastIndexOf(ch));
    }
    if (cut > limit * 0.45) return normalize(head.slice(0, cut + 1));
    const sp = head.lastIndexOf(' ');
    if (sp > limit * 0.6) return normalize(head.slice(0, sp));
    return normalize(head);
}

function isJunk(text) {
    if (!text || PUNCT_ONLY.test(text)) return true;
    if (stripSoundTags(text).length === 0) return true;   // 只有声音标签
    return JUNK_PATTERNS.some(re => re.test(text));
}

/* 从识别结果反推语种，用来锁死后续的 language 参数。
   只锁字符集明确的语种（韩/日/中），拉丁语系不锁——
   英文、西语、法语互相猜错的代价比收益大。 */
function langOfScript(text) {
    const s = String(text || '');
    if (/[\uAC00-\uD7AF]/.test(s)) return 'ko';
    if (/[\u3040-\u30FF]/.test(s)) return 'ja';
    if (/[\u4E00-\u9FFF]/.test(s)) return 'zh';
    return '';
}

function normalize(text) {
    return String(text || '')
        .replace(/\u200b/g, '')
        .replace(/\s*\n+\s*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/* ---------------- 音频工具 ---------------- */

function rmsOf(f32) {
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    return Math.sqrt(sum / f32.length);
}

function concatSpeech() {
    if (speechSamples === 0) return null;
    const out = new Float32Array(speechSamples);
    let offset = 0;
    for (const c of speech) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

function resetSpeech() {
    speech = [];
    speechSamples = 0;
    silentMs = 0;
    sinceInterimMs = 0;
    segRmsSum = 0;
    segFrames = 0;
}

/* 推理跟不上时（busy 中）帧还在源源不断进来，段落会无限变长。
   丢掉前半段只留最近 8 秒——更早的内容反正也来不及上屏了。 */
function trimSpeech(keep) {
    let total = 0;
    const kept = [];
    for (let i = speech.length - 1; i >= 0; i--) {
        total += speech[i].length;
        kept.unshift(speech[i]);
        if (total >= keep) break;
    }
    speech = kept;
    speechSamples = total;
}

/* 噪声底跟踪：只让它缓慢下降，遇到响度则极慢上升，避免把人声当噪声底 */
function updateNoiseFloor(rms) {
    if (rms < noiseFloor) noiseFloor = noiseFloor * 0.9 + rms * 0.1;
    else noiseFloor = noiseFloor * 0.9995 + rms * 0.0005;
}

/* 门限不能定太高：直播间里 BGM 是持续声，噪声底会被它一路推高，
   等人声进来时反而被挡在门外。宁可让模型多看几段噪音，
   也不要漏掉人声——噪音段有 isJunk 兜底。 */
function voiceThreshold() {
    return Math.max(0.006, noiseFloor * 1.8);
}

/* ---------------- 推理 ---------------- */

async function transcribe(audio) {
    /* Whisper 的声学编码器固定吃 30 秒（3000 帧 mel）。短音频如果靠内部
       补零，补出来的静音会参与注意力计算，模型很容易把整段判成"没有语音"，
       于是输出 (music)/(♪)。显式补齐到 30 秒，让补零方式可控。 */
    const target = SR * 30;
    let input = audio;
    if (audio.length < target) {
        input = new Float32Array(target);
        input.set(audio, 0);
    }
    const opts = { task: 'transcribe', return_timestamps: false };
    const explicit = cfg.sourceLang && cfg.sourceLang !== 'auto' ? cfg.sourceLang : '';
    const lang = explicit || langHint;
    if (lang) opts.language = lang;

    const t0 = performance.now();
    const out = await asr(input, opts);
    const cost = Math.round(performance.now() - t0);
    const text = normalize(out && out.text);
    return { text, cost, explicit: !!explicit, lang: lang || 'auto' };
}

/* 连续几段都只有音乐/噪音时，把原因告诉用户，
   而不是让他对着空画面猜"是不是坏了" */
function noteQuiet() {
    silentStreak++;
    if (silentStreak >= 3 && !reportedQuiet) {
        reportedQuiet = true;
        post('STATUS', {
            status: 'listening',
            detail: '只听到音乐/噪音 · 试试指定源语言',
            progress: 100
        });
    }
}

async function flush(final) {
    if (!ready || busy) return;                 // 忙的时候让音频继续累积，下次一起算
    if (speechSamples < SR * 0.35) {            // 太短，直接丢掉
        if (final) resetSpeech();
        return;
    }

    const audio = concatSpeech();
    const avgRms = segFrames ? segRmsSum / segFrames : 0;
    const segMs = Math.round((speechSamples / SR) * 1000);
    const myGen = gen;                          // 这一段的"归属"，回来时对一遍

    if (final) resetSpeech();
    else sinceInterimMs = 0;

    busy = true;
    let result;
    try {
        result = await transcribe(audio);
    } catch (e) {
        busy = false;
        post('ERROR', { fatal: false, detail: '识别失败：' + (e.message || e) });
        return;
    }
    busy = false;

    // 推理期间用户换了直播间/视频：这段结果是上一场的，直接扔掉
    if (myGen !== gen) {
        post('LOG', { line: 'drop stale segMs=' + segMs });
        return;
    }
    lastCost = result.cost;

    let text = result.text;

    // 能量极低却输出了长句 —— 几乎一定是幻觉
    if (avgRms < voiceThreshold() * 0.75 && text.length > 12) return;

    // 剥掉 (music)/(laughs)/♪ 这类声音标签；剥完什么都不剩就说明这段没人说话
    text = stripSoundTags(text);
    if (!text || isJunk(text)) {
        post('LOG', { line: 'skip segMs=' + segMs + ' rms=' + avgRms.toFixed(3) + ' raw=' + result.text.slice(0, 40) });
        noteQuiet();
        return;
    }
    /* 复读幻觉判定要用"压缩前"的原文 —— 先压缩会把证据抹掉，
       24 遍的复读被压成 2 遍后重复率刚好掉到阈值以下，就漏过去了。 */
    const rr = repeatRatio(text);
    if (rr > 0.45) {
        post('LOG', { line: 'skip repeat segMs=' + segMs + ' ratio=' + rr.toFixed(2) + ' raw=' + text.slice(0, 40) });
        return;
    }
    // 轻度重复（同一句说两遍）压缩成一遍，不算幻觉
    text = collapseRepeat(text);
    text = clampText(text, MAX_TEXT_CHARS);
    if (!text) return;

    // 同一句重复输出（Whisper 在长静音里的典型症状）
    const now = Date.now();
    if (final && text === lastSentText && now - lastFinalAt < 4000) return;
    if (!final && text === lastSentText) return;
    /* 滑窗重叠：这次的结果把上一句原样带上了，新增内容又少得可怜。
       再上屏一次，用户就会觉得"刚看过的那句又重复了一遍"——
       显示层是替换不是追加，但读起来的重复感是一样的。 */
    if (lastSentText && text.startsWith(lastSentText) && text.length - lastSentText.length <= 6) return;

    // 语种锁定：auto 模式下第一次认对人声之后就不再让它自己猜了
    if (!result.explicit && !langHint) {
        const g = langOfScript(text);
        if (g) {
            langHint = g;
            post('LOG', { line: 'lang locked=' + g });
        }
    }

    silentStreak = 0;
    if (reportedQuiet) {
        reportedQuiet = false;
        post('STATUS', { status: 'listening', detail: '监听中 · ' + hostName, progress: 100 });
    }

    lastSentText = text;
    if (final) lastFinalAt = now;

    /* 直播场景用户没法判断"字幕是不是刚才那句话"，所以直接把实测
       延迟写进状态栏：段内时长 + 本次推理耗时。看着数字比猜靠谱。 */
    if (final) {
        post('STATUS', {
            status: 'listening',
            detail: '监听中 · 延迟约 ' + Math.round((segMs + result.cost) / 1000) + ' 秒',
            progress: 100
        });
    }

    post('CAPTION', {
        text,
        startAt: now,
        final: !!final,
        cost: result.cost,
        rms: Math.round(avgRms * 1000) / 1000,
        segMs
    });
}

function post(type, payload) {
    self.postMessage(Object.assign({ type }, payload || {}));
}

/* ---------------- 分帧调度 ---------------- */

function onFrame(f32) {
    lastFrameAt = performance.now();
    if (!ready) return;                          // 模型还没好，音频直接丢，避免积压

    const rms = rmsOf(f32);
    updateNoiseFloor(rms);
    const voiced = rms >= voiceThreshold();

    if (voiced) silentMs = 0;
    else silentMs += FRAME_MS;

    // 已经开始累积、或当前有声音，都要收进来（保留句子前后的短静音，识别更准）
    if (speechSamples > 0 || voiced) {
        speech.push(f32);
        speechSamples += f32.length;
        segRmsSum += rms;
        segFrames++;
        sinceInterimMs += FRAME_MS;
    }

    if (speechSamples === 0) return;

    if (speechSamples > SR * (HARD_CAP_MS / 1000)) trimSpeech(SR * 8);

    // 句尾静音足够长 → 出最终结果
    if (silentMs >= SILENCE_CUT_MS && speechSamples >= SR * (MIN_SPEECH_MS / 1000)) {
        flush(true);
        return;
    }

    // 单段过长 → 强制断句，否则延迟会一路堆高
    if (speechSamples >= SR * (MAX_SEG_MS / 1000)) {
        flush(true);
        return;
    }

    // 还在说，出一版中间结果让字幕跟上；机器慢（单次超过 2 秒）就不做中间结果
    const gap = lastCost > 2000 ? INTERIM_GAP_SLOW : INTERIM_GAP_FAST;
    if (speechSamples >= SR * (MIN_SPEECH_MS / 1000) && sinceInterimMs >= gap) {
        flush(false);
    }
}

/* 视频卡住/暂停后不再有新帧，靠定时器兜底把残留的语音段落定 */
setInterval(() => {
    if (!ready || speechSamples === 0) return;
    if (performance.now() - lastFrameAt < 700) return;
    if (speechSamples >= SR * 0.5) flush(true);
    else resetSpeech();
}, 400);

/* ---------------- 启动 ---------------- */

async function init() {
    post('STATUS', { status: 'loading', detail: '正在载入运行环境', progress: 0 });

    // WASM 二进制必须从扩展自身目录加载（MV3 禁止远程脚本）
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    env.backends.onnx.wasm.wasmPaths = cfg.baseUrl + 'vendor/';
    env.backends.onnx.wasm.numThreads = 1;      // 多线程需要跨源隔离，扩展页拿不到
    env.backends.onnx.wasm.proxy = false;

    // 国内直连 huggingface.co 通常不通，默认走镜像；镜像也失败再回退官方
    const hosts = ['https://hf-mirror.com', 'https://huggingface.co'];

    let lastErr = null;
    for (const host of hosts) {
        try {
            env.remoteHost = host;
            asr = await pipeline('automatic-speech-recognition', MODELS[cfg.model] || MODELS.base, {
                dtype: 'q8',
                device: 'wasm',
                progress_callback: onProgress
            });
            ready = true;
            hostName = host.replace('https://', '');
            post('LOG', { line: 'model ready ' + cfg.model + ' lang=' + (cfg.sourceLang || 'auto') });
            post('STATUS', { status: 'listening', detail: '监听中 · ' + hostName, progress: 100 });
            return;
        } catch (e) {
            lastErr = e;
        }
    }

    post('ERROR', {
        fatal: true,
        detail: '模型载入失败：' + ((lastErr && lastErr.message) || '网络不可达')
    });
}

const downloading = new Map();

function onProgress(p) {
    if (!p) return;
    if (p.status === 'progress' && p.file) {
        downloading.set(p.file, p.progress || 0);
        let sum = 0;
        for (const v of downloading.values()) sum += v;
        const avg = Math.round(sum / downloading.size);
        post('STATUS', {
            status: 'downloading',
            detail: '下载模型 ' + p.file.replace(/^.*\//, ''),
            progress: avg
        });
    } else if (p.status === 'done' && p.file) {
        downloading.set(p.file, 100);
    } else if (p.status === 'ready') {
        post('STATUS', { status: 'loading', detail: '初始化推理引擎', progress: 100 });
    }
}

/* ---------------- 消息 ---------------- */

self.onmessage = ev => {
    const m = ev.data || {};
    if (m.type === 'INIT') {
        cfg = {
            model: m.model || 'base',
            sourceLang: m.sourceLang || 'auto',
            baseUrl: m.baseUrl || ''
        };
        init();
        return;
    }
    if (m.type === 'AUDIO' && m.buf) {
        onFrame(new Float32Array(m.buf));
        return;
    }
    if (m.type === 'FLUSH') {
        flush(true);
        return;
    }
    /* 换页面了：把缓冲里的旧音频、语种锁定、判重状态全部作废。
       少了这一步，切换直播后会先冒出 1~2 条上一个主播的话。 */
    if (m.type === 'RESET') {
        gen++;
        resetSpeech();
        lastSentText = '';
        lastFinalAt = 0;
        langHint = '';
        silentStreak = 0;
        reportedQuiet = false;
        noiseFloor = 0.004;
        post('LOG', { line: 'reset gen=' + gen });
        return;
    }
};
