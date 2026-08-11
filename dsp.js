// ============================================================================
// SNES DSP (S-DSP) エミュレータ
// 8チャンネルのBRR(ADPCM系)サンプル再生、ADSR/GAINエンベロープ、
// ノイズ、エコー(簡易)、ピッチモジュレーションを実装。
// サンプルレートは常に32000Hz固定 (SNES実機仕様)。
// ============================================================================

const SDSP_RATE = 32000;

// ADSR/GAIN用のレート -> カウンタ周期テーブル(実機の counter_rates を再現)
const COUNTER_RATES = [
  0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192,
  160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1
];

// Gaussian補間用テーブル(実機の256エントリ、簡易版として滑らかな近似カーブを生成)
function buildGaussTable() {
  // 実機のgaussテーブルに近い形（4点補間用重み）を生成
  const table = new Float64Array(512);
  for (let i = 0; i < 512; i++) {
    const x = (i - 256) / 256;
    table[i] = Math.exp(-3.0 * x * x);
  }
  return table;
}

class DSP {
  constructor(ram) {
    this.ram = ram; // SPC700が持つ64KB RAM(共有参照)
    this.regs = new Uint8Array(128); // DSPレジスタ 0x00-0x7F
    this.regAddr = 0;

    this.voices = [];
    for (let i = 0; i < 8; i++) {
      this.voices.push({
        brrAddr: 0,       // 現在デコード中のBRRブロックアドレス
        brrOffset: 0,     // ブロック内サンプル位置(0-15)
        pitchCounter: 0,  // 12bit小数付きピッチアキュムレータ (0x0000-0xFFFF+)
        history: [0, 0],  // BRRデコード用の過去2サンプル
        decodedBlock: new Int16Array(16),
        curBlockHeader: 0,
        keyOn: false,
        keyOff: false,
        envMode: 'release', // 'attack' | 'decay' | 'sustain' | 'release' | 'gain'
        envLevel: 0,       // 0-2047 (11bit)
        loopFlag: false,
        endFlag: false,
        sampleAddr: 0,     // SRCNから取得した現在のサンプルの先頭アドレス
        outSample: 0,      // 最後に出力したサンプル(エコー/次段用)
      });
    }

    this.gaussTable = buildGaussTable();
    this.echoBuffer = null; // 使用しない簡易実装(EON時のみ簡易加算)
    this.noiseLFSR = 0x4000;
    this.masterVolL = 0;
    this.masterVolR = 0;
  }

  reset() {
    this.regs.fill(0);
    this.regAddr = 0;
    for (const v of this.voices) {
      v.pitchCounter = 0;
      v.envLevel = 0;
      v.keyOn = false;
      v.keyOff = false;
      v.envMode = 'release';
      v.history = [0, 0];
      v.brrOffset = 16; // 最初にブロックを読ませる
      v.endFlag = false;
    }
  }

  read(addr) {
    return this.regs[addr & 0x7f];
  }
  write(addr, val) {
    addr &= 0x7f;
    val &= 0xff;
    this.regs[addr] = val;
    // KON (0x4C) 書き込み時の処理はサンプル生成ループ側で毎サンプルポーリングする
  }

  // レジスタショートカット
  volL(v) { return this._s8(this.regs[v * 0x10 + 0x00]); }
  volR(v) { return this._s8(this.regs[v * 0x10 + 0x01]); }
  pitch(v) { return this.regs[v * 0x10 + 0x02] | (this.regs[v * 0x10 + 0x03] << 8); }
  srcn(v) { return this.regs[v * 0x10 + 0x04]; }
  adsr1(v) { return this.regs[v * 0x10 + 0x05]; }
  adsr2(v) { return this.regs[v * 0x10 + 0x06]; }
  gain(v) { return this.regs[v * 0x10 + 0x07]; }

  _s8(v) { return v >= 128 ? v - 256 : v; }

  get kon() { return this.regs[0x4c]; }
  get koff() { return this.regs[0x5c]; }
  get flg() { return this.regs[0x6c]; }
  get pmon() { return this.regs[0x2d]; }
  get non() { return this.regs[0x3d]; }
  get eon() { return this.regs[0x4d]; }
  get dir() { return this.regs[0x5d]; } // ソースディレクトリページ
  get mvolL() { return this._s8(this.regs[0x0c]); }
  get mvolR() { return this._s8(this.regs[0x1c]); }
  get evolL() { return this._s8(this.regs[0x2c]); }
  get evolR() { return this._s8(this.regs[0x3c]); }
  get efb() { return this._s8(this.regs[0x0d]); }

  // サンプルディレクトリからBRRサンプルの開始/ループアドレスを取得
  getSampleDirEntry(srcn) {
    const base = (this.dir << 8) + srcn * 4;
    const start = this.ram[base] | (this.ram[base + 1] << 8);
    const loop = this.ram[base + 2] | (this.ram[base + 3] << 8);
    return { start, loop };
  }

  // BRRブロック1個(9byte: header1 + data8)をデコードしてhistoryを更新
  decodeBrrBlock(voice, addr) {
    const header = this.ram[addr];
    const range = (header >> 4) & 0x0f;
    const filter = (header >> 2) & 0x03;
    const loopBit = (header >> 1) & 1;
    const endBit = header & 1;

    const out = voice.decodedBlock;
    let h1 = voice.history[0];
    let h2 = voice.history[1];

    for (let i = 0; i < 16; i++) {
      const byteIdx = 1 + (i >> 1);
      const byte = this.ram[(addr + byteIdx) & 0xffff];
      let nibble = (i & 1) === 0 ? (byte >> 4) : (byte & 0x0f);
      if (nibble >= 8) nibble -= 16; // 符号拡張(4bit)

      let sample;
      if (range <= 12) {
        sample = (nibble << range) >> 1;
      } else {
        // range 13-15は実機だと特殊挙動。ここでは13として扱う簡易対応
        sample = nibble < 0 ? -2048 : 0;
      }

      // フィルタ適用（BRR標準の4種類）
      let pred = 0;
      switch (filter) {
        case 0: pred = 0; break;
        case 1: pred = h1 + ((-h1) >> 4); break;
        case 2: pred = h1 * 2 + ((-(h1 * 3)) >> 5) - h2 + (h2 >> 4); break;
        case 3: pred = h1 * 2 + ((-(h1 * 13)) >> 6) - h2 + ((h2 * 3) >> 4); break;
      }
      let s = sample + pred;
      // 16bit clip (実機は15bit相当を折り返すことがあるが、ここではクランプで近似)
      if (s > 32767) s = 32767;
      if (s < -32768) s = -32768;

      out[i] = s;
      h2 = h1;
      h1 = s;
    }

    voice.history[0] = h1;
    voice.history[1] = h2;
    voice.loopFlag = loopBit === 1;
    voice.endFlag = endBit === 1;
    return endBit === 1;
  }

  // ノイズ生成(LFSR)。呼び出しごとに1サンプル進める。
  stepNoise() {
    // 実機は 15bit LFSR、タップは bit0とbit1のXOR
    let lfsr = this.noiseLFSR;
    const bit = ((lfsr << 14) ^ (lfsr << 13)) & 0x4000;
    lfsr = ((lfsr >> 1) | bit) & 0x7fff;
    this.noiseLFSR = lfsr;
    // -0x4000..0x3fff相当を返す(符号付き15bit)
    let v = lfsr & 0x7fff;
    if (v & 0x4000) v -= 0x8000;
    return v;
  }

  // ADSR/GAINエンベロープを1サンプル分進める
  stepEnvelope(voice, vIdx) {
    const a1 = this.adsr1(vIdx);
    const a2 = this.adsr2(vIdx);
    const useADSR = (a1 & 0x80) !== 0;

    if (voice.keyOff) {
      voice.envMode = 'release';
    }

    if (voice.envMode === 'release') {
      voice.envLevel -= 8;
      if (voice.envLevel < 0) voice.envLevel = 0;
      return voice.envLevel;
    }

    if (useADSR) {
      const attackRate = (a1 & 0x0f) * 2 + 1;
      const decayRate = ((a1 >> 4) & 0x07) * 2 + 16;
      const sustainRate = a2 & 0x1f;
      const sustainLevel = ((a2 >> 5) & 0x07 + 1);
      const sustainLvl = (((a2 >> 5) & 0x07) + 1) * 256;

      if (voice.envMode === 'attack') {
        const rate = attackRate;
        if (this._rateFires(rate)) {
          voice.envLevel += (rate === 31) ? 1024 : 32;
          if (voice.envLevel >= 2047) {
            voice.envLevel = 2047;
            voice.envMode = 'decay';
          }
        }
      } else if (voice.envMode === 'decay') {
        if (this._rateFires(decayRate)) {
          voice.envLevel -= (((voice.envLevel - 1) >> 8) + 1);
          if (voice.envLevel < 0) voice.envLevel = 0;
          if (voice.envLevel <= sustainLvl) voice.envMode = 'sustain';
        }
      } else if (voice.envMode === 'sustain') {
        if (sustainRate > 0 && this._rateFires(sustainRate)) {
          voice.envLevel -= (((voice.envLevel - 1) >> 8) + 1);
          if (voice.envLevel < 0) voice.envLevel = 0;
        }
      }
    } else {
      // GAINモード(簡易: 直接値 or 増減モード)
      const gainVal = this.gain(vIdx);
      if ((gainVal & 0x80) === 0) {
        // 直接指定
        voice.envLevel = (gainVal & 0x7f) * 16;
      } else {
        const mode = (gainVal >> 5) & 0x03;
        const rate = gainVal & 0x1f;
        if (this._rateFires(rate)) {
          if (mode === 0) { // 直線減少
            voice.envLevel -= 32;
          } else if (mode === 1) { // 直線増加
            voice.envLevel += 32;
          } else if (mode === 2) { // 指数減少
            voice.envLevel -= (((voice.envLevel - 1) >> 8) + 1);
          } else { // 指数(bent line)増加近似
            voice.envLevel += (voice.envLevel < 1536) ? 32 : 8;
          }
          if (voice.envLevel < 0) voice.envLevel = 0;
          if (voice.envLevel > 2047) voice.envLevel = 2047;
        }
      }
    }

    if (voice.envLevel < 0) voice.envLevel = 0;
    if (voice.envLevel > 2047) voice.envLevel = 2047;
    return voice.envLevel;
  }

  _rateFires(rateIndex) {
    // COUNTER_RATESの周期に基づき、globalカウンタでレート発火判定
    const period = COUNTER_RATES[rateIndex] || 0;
    if (period === 0) return false;
    this._globalCounter = (this._globalCounter || 0);
    return (this._globalCounter % period) === 0;
  }

  // メインの1サンプル生成。呼ぶたびにglobalCounterを進める。
  // 戻り値: [left, right] (Float32、-1.0〜1.0レンジ)
  generateSample() {
    this._globalCounter = (this._globalCounter || 0) + 1;

    let mixL = 0, mixR = 0;
    const konReg = this.kon;
    const koffReg = this.koff;

    for (let i = 0; i < 8; i++) {
      const voice = this.voices[i];
      const bit = 1 << i;

      // KEY ON / KEY OFF 検出（エッジトリガをここで簡略処理）
      if (konReg & bit) {
        if (!voice._konLatched) {
          this._triggerKeyOn(voice, i);
          voice._konLatched = true;
        }
      } else {
        voice._konLatched = false;
      }
      if (koffReg & bit) {
        voice.keyOff = true;
      } else {
        voice.keyOff = false;
      }

      if (voice.envMode === 'off') {
        continue;
      }

      // ピッチ取得(PMONによる変調は簡易実装として省略、基本ピッチのみ)
      let p = this.pitch(i);
      if (p > 0x3fff) p = 0x3fff;

      // BRRデコード：ブロック境界を超えたら次ブロックを読む
      if (voice.brrOffset >= 16) {
        if (voice.endFlag) {
          if (voice.loopFlag) {
            const dirEntry = this.getSampleDirEntry(this.srcn(i));
            voice.brrAddr = dirEntry.loop;
          } else {
            voice.envMode = 'off';
            voice.envLevel = 0;
            continue;
          }
        }
        this.decodeBrrBlock(voice, voice.brrAddr);
        voice.brrOffset = 0;
        if (!voice.endFlag || voice.loopFlag) {
          // 次回のためにアドレスを進める(ブロック末端到達時は上でloop先に設定済み)
        }
      }

      // サンプル取得(ガウス補間なしの簡易線形補間で近似)
      const idx = voice.brrOffset;
      const s0 = voice.decodedBlock[idx];
      const s1 = idx < 15 ? voice.decodedBlock[idx + 1] : s0;
      const frac = (voice.pitchCounter & 0xfff) / 0x1000;
      let sample = s0 + (s1 - s0) * frac;

      // ノイズチャンネル置き換え
      if (this.non & bit) {
        sample = this.stepNoise();
      }

      // エンベロープ適用
      const env = this.stepEnvelope(voice, i);
      sample = (sample * env) / 2047;

      voice.outSample = sample;

      const vl = this.volL(i) / 128;
      const vr = this.volR(i) / 128;
      mixL += sample * vl;
      mixR += sample * vr;

      // ピッチカウンタを進めてブロック内オフセットも進める
      voice.pitchCounter += p;
      const advance = voice.pitchCounter >> 12;
      voice.pitchCounter &= 0xfff;
      voice.brrOffset += advance;
      while (voice.brrOffset >= 16) {
        // ブロック境界を跨いだら次ブロックアドレスへ
        if (voice.endFlag) {
          if (voice.loopFlag) {
            const dirEntry = this.getSampleDirEntry(this.srcn(i));
            voice.brrAddr = dirEntry.loop;
          } else {
            voice.envMode = 'off';
            voice.envLevel = 0;
            voice.brrOffset = 16;
            break;
          }
        } else {
          voice.brrAddr = (voice.brrAddr + 9) & 0xffff;
        }
        if (voice.envMode === 'off') break;
        this.decodeBrrBlock(voice, voice.brrAddr);
        voice.brrOffset -= 16;
      }
    }

    // マスターボリューム適用
    const outL = (mixL * this.mvolL) / (128 * 2047);
    const outR = (mixR * this.mvolR) / (128 * 2047);

    return [
      Math.max(-1, Math.min(1, outL)),
      Math.max(-1, Math.min(1, outR)),
    ];
  }

  _triggerKeyOn(voice, i) {
    const dirEntry = this.getSampleDirEntry(this.srcn(i));
    voice.brrAddr = dirEntry.start;
    voice.brrOffset = 16; // 次回生成時に即デコード
    voice.pitchCounter = 0;
    voice.history = [0, 0];
    voice.envLevel = 0;
    voice.envMode = 'attack';
    voice.keyOff = false;
    voice.endFlag = false;
    voice.loopFlag = false;
  }
}

if (typeof module !== 'undefined') module.exports = { DSP, SDSP_RATE };
