// ============================================================================
// SPCPlayerProcessor: AudioWorkletProcessor
// メインスレッドからSPCデータを受け取り、SPCEngineでレンダリングして
// Web Audioの出力バッファに書き込む。
// ============================================================================

class SPCPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new SPCEngine();
    this.playing = false;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'load') {
        try {
          this.engine.loadSPC(msg.parsed);
          this.playing = true;
          this.port.postMessage({ type: 'loaded' });
        } catch (e) {
          this.port.postMessage({ type: 'error', message: String(e) });
        }
      } else if (msg.type === 'play') {
        this.playing = true;
      } else if (msg.type === 'stop') {
        this.playing = false;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];
    const n = left.length;

    if (!this.playing || !this.engine.loaded) {
      left.fill(0);
      if (right !== left) right.fill(0);
      return true;
    }

    // AudioWorkletの出力サンプルレートは通常48000Hz等だが、
    // SDSPは32000Hz固定生成なので、ここでは単純に毎コールバックごとに
    // n個分のサンプルを32000Hz相当としてそのまま埋める簡易実装とする。
    // (ブラウザ側でAudioContextのsampleRateを32000で作成することを推奨)
    this.engine.renderBlock(left, right, n);

    return true;
  }
}

registerProcessor('spc-player-processor', SPCPlayerProcessor);
