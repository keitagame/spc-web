// ============================================================================
// SPC再生エンジン
// SPC700 CPUとDSPを組み合わせ、実機クロックに従ってCPUを回しながら
// DSPが32000Hzでサンプルを生成するタイミングを管理する。
// AudioWorkletProcessor内で動作させる想定。
// ============================================================================

// SPC700のクロックは約1.024MHz (24.576MHz / 24)
// DSPは32000Hzでサンプル生成 -> 1サンプルあたり約32サイクル (1024000/32000=32)
const CPU_CYCLES_PER_SAMPLE = 32;

class SPCEngine {
  constructor() {
    this.dsp = new DSP();
    this.cpu = new SPC700(this.dsp);
    this.dsp.ram = this.cpu.ram; // RAMを共有
    this.loaded = false;
    this._cycleAccum = 0;
  }

  loadSPC(parsed) {
    this.cpu.ram.set(parsed.ram);
    this.cpu.A = parsed.a;
    this.cpu.X = parsed.x;
    this.cpu.Y = parsed.y;
    this.cpu.SP = parsed.sp;
    this.cpu.PC = parsed.pc;
    this.cpu.setPSW(parsed.psw);

    this.dsp.reset();
    this.dsp.regs.set(parsed.dspRegs);
    // KON/KOFFはロード直後は発火させない(実機のIPLROM挙動を模倣する簡易対応)
    this.dsp.regs[0x4c] = 0;

    this.loaded = true;
    this._cycleAccum = 0;
  }

  // 1サンプル分(=CPU_CYCLES_PER_SAMPLE分)CPUを実行し、DSPから1サンプル取得する
  renderSample() {
    if (!this.loaded) return [0, 0];

    let budget = CPU_CYCLES_PER_SAMPLE + this._cycleAccum;
    let guard = 0;
    while (budget > 0 && guard < 64) {
      const used = this.cpu.step();
      budget -= used;
      guard++;
    }
    this._cycleAccum = budget; // 余剰/不足を次回に繰り越し

    return this.dsp.generateSample();
  }

  // 指定サンプル数だけレンダリングしてFloat32Arrayに書き込む
  renderBlock(outL, outR, numSamples) {
    for (let i = 0; i < numSamples; i++) {
      const [l, r] = this.renderSample();
      outL[i] = l;
      outR[i] = r;
    }
  }
}
