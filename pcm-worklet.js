/* =========================================================
 * 音频采集 Worklet
 *
 * 每个 process 回调拿到的是 128 个采样点，直接转发会让消息通道
 * 每秒被冲击 125 次。这里在音频线程内累积到 100ms（1600 点）
 * 再一次性 transfer 出去，主线程只承担搬运。
 * =======================================================*/

const FRAME_SAMPLES = 1600;   // 100ms @ 16kHz

class PcmCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.chunks = [];
        this.count = 0;
        this.closed = false;
        this.port.onmessage = e => {
            if (e.data === 'stop') this.closed = true;
        };
    }

    process(inputs) {
        if (this.closed) return false;
        const input = inputs[0];
        if (!input || !input.length || !input[0]) return true;

        // Whisper 只吃 mono，但**不能简单平均**：直播流的左右声道常带
        // 相位差（音乐/混响做立体声处理），(L+R)/2 会互相抵消，能量掉一半，
        // 声音发闷，模型直接判成 "music"。这里挑能量大的那一路。
        let mono = input[0];
        if (input.length > 1) {
            const n = mono.length;
            let e0 = 0, e1 = 0;
            const L = input[0], R = input[1];
            for (let i = 0; i < n; i++) {
                e0 += L[i] * L[i];
                e1 += R[i] * R[i];
            }
            const src = e0 >= e1 ? L : R;
            mono = new Float32Array(n);
            mono.set(src);
        }

        this.chunks.push(mono);
        this.count += mono.length;

        if (this.count >= FRAME_SAMPLES) {
            const out = new Float32Array(this.count);
            let offset = 0;
            for (const c of this.chunks) {
                out.set(c, offset);
                offset += c.length;
            }
            this.port.postMessage(out.buffer, [out.buffer]);
            this.chunks = [];
            this.count = 0;
        }
        return true;
    }
}

registerProcessor('pcm-capture', PcmCapture);
