// ============================================================================
// SPC Player - Main Thread Version (ScriptProcessorNode)
// ============================================================================

// ============================================================================
// SPC700 CPU Emulator
// ============================================================================
class SPC700 {
  constructor(dsp) {
    this.dsp = dsp;
    this.ram = new Uint8Array(0x10000);

    this.A = 0;
    this.X = 0;
    this.Y = 0;
    this.SP = 0;
    this.PC = 0;

    this.flagN = 0;
    this.flagV = 0;
    this.flagP = 0;
    this.flagB = 0;
    this.flagH = 0;
    this.flagI = 0;
    this.flagZ = 0;
    this.flagC = 0;

    this.ioIn = new Uint8Array(4);  // 65816 → SPC ($F4-$F7 を SPC が読んだとき返る値)
    this.ioOut = new Uint8Array(4); // SPC → 65816 ($F4-$F7 に SPC が書いた値)
    this.timerEnable = [0, 0, 0];
    this.timerTarget = [0, 0, 0];       // 生の値。8bit カウンタと == 比較(0 は 256 分周になる)
    this.timerCounter = [0, 0, 0];      // 内部の分周カウンタ (target と比較)
    this.timerOut = [0, 0, 0];          // 4bit 出力カウンタ ($FD-$FF)
    this._tAccum = [0, 0, 0];           // CPUサイクルの蓄積
    this.romEnable = true;              // $F1 bit7: $FFC0-$FFFF にブートROMを見せる
    this.cycles = 0;

    // SPC700 ブートROM (64 bytes)
    this.bootRom = new Uint8Array([
      0xcd, 0xef, 0xbd, 0xe8, 0x00, 0xc6, 0x1d, 0xd0, 0xfc, 0x8f, 0xaa, 0xf4, 0x8f, 0xbb, 0xf5, 0x78,
      0xcc, 0xf4, 0xd0, 0xfb, 0x2f, 0x19, 0xeb, 0xf4, 0xd0, 0xfc, 0x7e, 0xf4, 0xd0, 0x0b, 0xe4, 0xf5,
      0xcb, 0xf4, 0xd7, 0x00, 0xfc, 0xd0, 0xf3, 0xab, 0x01, 0x10, 0xef, 0x7e, 0xf4, 0x10, 0xeb, 0xba,
      0xf6, 0xda, 0x00, 0xba, 0xf4, 0xc4, 0xf4, 0xdd, 0x5d, 0xd0, 0xdb, 0x1f, 0x00, 0x00, 0xc0, 0xff
    ]);
    
    this._buildOpTable();
  }

  read(addr) {
    addr &= 0xffff;
    if (addr >= 0xf0 && addr <= 0xff) {
      switch (addr) {
        case 0xf2: return this.dsp.regAddr;
        case 0xf3: return this.dsp.read(this.dsp.regAddr & 0x7f);
        case 0xf4: case 0xf5: case 0xf6: case 0xf7:
          return this.ioIn[addr - 0xf4];
        case 0xf8: case 0xf9:
          return this.ram[addr];          // 普通のRAMとして読み書きできる
        case 0xfd: return this.readTimerOut(0);
        case 0xfe: return this.readTimerOut(1);
        case 0xff: return this.readTimerOut(2);
        default:
          return 0;                       // $F0,$F1,$FA-$FC は読み出し不可(0)
      }
    }
    if (addr >= 0xffc0 && this.romEnable) {
      return this.bootRom[addr & 0x3f];
    }
    return this.ram[addr];
  }

  write(addr, val) {
    addr &= 0xffff;
    val &= 0xff;
    switch (addr) {
      case 0xf0:
        break;                            // TEST レジスタ(未実装)
      case 0xf1: {
        // タイマーは 0→1 になった瞬間に内部/出力カウンタをリセット
        for (let t = 0; t < 3; t++) {
          const en = (val >> t) & 1;
          if (en && !this.timerEnable[t]) {
            this.timerCounter[t] = 0;
            this.timerOut[t] = 0;
            this._tAccum[t] = 0;
          }
          this.timerEnable[t] = en;
        }
        // 入力ポートのクリア: 65816 → SPC 方向(=SPCが読む側)の値を消す
        if (val & 0x10) { this.ioIn[0] = 0; this.ioIn[1] = 0; }
        if (val & 0x20) { this.ioIn[2] = 0; this.ioIn[3] = 0; }
        this.romEnable = (val & 0x80) !== 0;
        break;
      }
      case 0xf2:
        this.dsp.regAddr = val;
        break;
      case 0xf3:
        // $F2 の bit7 が立っているときは書き込み不可(読み出し専用ミラー)
        if (!(this.dsp.regAddr & 0x80)) this.dsp.write(this.dsp.regAddr & 0x7f, val);
        break;
      case 0xf4: case 0xf5: case 0xf6: case 0xf7:
        this.ioOut[addr - 0xf4] = val;
        break;
      case 0xfa: this.timerTarget[0] = val; break;
      case 0xfb: this.timerTarget[1] = val; break;
      case 0xfc: this.timerTarget[2] = val; break;
    }
    // 実機では書き込みは常にRAMにも届く(ROMが見えていても RAM へ書ける)
    this.ram[addr] = val;
  }

  readTimerOut(t) {
    const v = this.timerOut[t] & 0x0f;
    this.timerOut[t] = 0;                 // 読むとクリア
    return v;
  }

  tickTimers(cyc) {
    // タイマー0/1: 8kHz (1.024MHz/128)、タイマー2: 64kHz (1.024MHz/16)
    const periods = [128, 128, 16];
    for (let t = 0; t < 3; t++) {
      // 無効時もサイクルは蓄積しない(有効化時にリセットされる)
      if (!this.timerEnable[t]) continue;
      this._tAccum[t] += cyc;
      while (this._tAccum[t] >= periods[t]) {
        this._tAccum[t] -= periods[t];
        this.timerCounter[t] = (this.timerCounter[t] + 1) & 0xff;
        // 実機は「==」比較。target を飛び越した場合は 8bit を一周するまで出力しない。
        // target=0 のときは 256 回目(8bit が 0 に戻った時)に一致する。
        if (this.timerCounter[t] === this.timerTarget[t]) {
          this.timerCounter[t] = 0;
          this.timerOut[t] = (this.timerOut[t] + 1) & 0x0f;
        }
      }
    }
  }

  getPSW() {
    return (this.flagN << 7) | (this.flagV << 6) | (this.flagP << 5) |
           (this.flagB << 4) | (this.flagH << 3) | (this.flagI << 2) |
           (this.flagZ << 1) | (this.flagC);
  }

  setPSW(v) {
    this.flagN = (v >> 7) & 1;
    this.flagV = (v >> 6) & 1;
    this.flagP = (v >> 5) & 1;
    this.flagB = (v >> 4) & 1;
    this.flagH = (v >> 3) & 1;
    this.flagI = (v >> 2) & 1;
    this.flagZ = (v >> 1) & 1;
    this.flagC = v & 1;
  }

  dpBase() { return this.flagP ? 0x100 : 0x000; }

  setNZ8(v) {
    v &= 0xff;
    this.flagZ = v === 0 ? 1 : 0;
    this.flagN = (v & 0x80) ? 1 : 0;
    return v;
  }

  push8(v) { this.ram[0x100 + this.SP] = v & 0xff; this.SP = (this.SP - 1) & 0xff; }
  pop8() { this.SP = (this.SP + 1) & 0xff; return this.ram[0x100 + this.SP]; }
  push16(v) { this.push8((v >> 8) & 0xff); this.push8(v & 0xff); }
  pop16() { const lo = this.pop8(); const hi = this.pop8(); return (hi << 8) | lo; }

  fetch8() { const v = this.read(this.PC); this.PC = (this.PC + 1) & 0xffff; return v; }
  fetch16() { const lo = this.fetch8(); const hi = this.fetch8(); return (hi << 8) | lo; }

  // ダイレクトページのアドレス。オフセットは 8bit で、ページ内に収まる。
  dp(off) { return (this.dpBase() | (off & 0xff)); }

  // ダイレクトページ内の 16bit 読み書き。上位バイトは (off+1)&0xff = ページ内で折り返す
  // ($FF の次は $00。$100 ではない)。
  dpNext(a) { return (a & 0x100) | ((a + 1) & 0xff); }
  rd16dp(a) { return this.read(a) | (this.read(this.dpNext(a)) << 8); }
  wr16dp(a, w) { this.write(a, w & 0xff); this.write(this.dpNext(a), (w >> 8) & 0xff); }

  adc(a, b, carryIn) {
    const result = a + b + carryIn;
    this.flagH = ((a & 0xf) + (b & 0xf) + carryIn) > 0xf ? 1 : 0;
    this.flagC = result > 0xff ? 1 : 0;
    const r8 = result & 0xff;
    this.flagV = (~(a ^ b) & (a ^ r8) & 0x80) ? 1 : 0;
    this.setNZ8(r8);
    return r8;
  }

  sbc(a, b, carryIn) {
    return this.adc(a, (~b) & 0xff, carryIn);
  }

  step() {
    const op = this.fetch8();
    const cyc = this._exec(op);
    this.cycles += cyc;
    this.tickTimers(cyc);
    return cyc;
  }

  _exec(op) {
    const fn = this.opTable[op];
    if (!fn) {
        console.error("UNKNOWN OPCODE", op.toString(16).padStart(2, "0"));
        return 2;
    }
    return fn.call(this);
  }

  _branch(cond, disp) {
    if (cond) {
      const s = disp & 0x80 ? disp - 256 : disp;
      this.PC = (this.PC + s) & 0xffff;
      return 2;
    }
    return 0;
  }

  _buildOpTable() {
    const T = new Array(256).fill(null);
    const rd = (addr) => this.read(addr);
    const wr = (addr, v) => this.write(addr, v);

    T[0x00] = function () { return 2; };
    T[0xE8] = function () { const v = this.fetch8(); this.A = this.setNZ8(v); return 2; };
    T[0xCD] = function () { const v = this.fetch8(); this.X = this.setNZ8(v); return 2; };
    T[0x8D] = function () { const v = this.fetch8(); this.Y = this.setNZ8(v); return 2; };

    T[0x7D] = function () { this.A = this.setNZ8(this.X); return 2; };
    T[0xDD] = function () { this.A = this.setNZ8(this.Y); return 2; };
    T[0x5D] = function () { this.X = this.setNZ8(this.A); return 2; };
    T[0xFD] = function () { this.Y = this.setNZ8(this.A); return 2; };
    T[0x9D] = function () { this.X = this.setNZ8(this.SP); return 2; };
    T[0xBD] = function () { this.SP = this.X; return 2; };

    T[0xC4] = function () { const a = this.dp(this.fetch8()); wr(a, this.A); return 4; };
    T[0xE4] = function () { const a = this.dp(this.fetch8()); this.A = this.setNZ8(rd(a)); return 3; };
    T[0xD8] = function () { const a = this.dp(this.fetch8()); wr(a, this.X); return 4; };
    T[0xF8] = function () { const a = this.dp(this.fetch8()); this.X = this.setNZ8(rd(a)); return 3; };
    T[0xCB] = function () { const a = this.dp(this.fetch8()); wr(a, this.Y); return 4; };
    T[0xEB] = function () { const a = this.dp(this.fetch8()); this.Y = this.setNZ8(rd(a)); return 3; };

    T[0xD4] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); wr(a, this.A); return 5; };
    T[0xF4] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); this.A = this.setNZ8(rd(a)); return 4; };
    T[0xD9] = function () { const a = this.dp((this.fetch8() + this.Y) & 0xff); wr(a, this.X); return 5; };
    T[0xF9] = function () { const a = this.dp((this.fetch8() + this.Y) & 0xff); this.X = this.setNZ8(rd(a)); return 4; };
    T[0xDB] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); wr(a, this.Y); return 5; };
    T[0xFB] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); this.Y = this.setNZ8(rd(a)); return 4; };

    T[0xC5] = function () { const a = this.fetch16(); wr(a, this.A); return 5; };
    T[0xE5] = function () { const a = this.fetch16(); this.A = this.setNZ8(rd(a)); return 4; };
    T[0xC9] = function () { const a = this.fetch16(); wr(a, this.X); return 5; };
    T[0xE9] = function () { const a = this.fetch16(); this.X = this.setNZ8(rd(a)); return 4; };
    T[0xCC] = function () { const a = this.fetch16(); wr(a, this.Y); return 5; };
    T[0xEC] = function () { const a = this.fetch16(); this.Y = this.setNZ8(rd(a)); return 4; };

    T[0xD5] = function () { const a = (this.fetch16() + this.X) & 0xffff; wr(a, this.A); return 6; };
    T[0xD6] = function () { const a = (this.fetch16() + this.Y) & 0xffff; wr(a, this.A); return 6; };
    T[0xF5] = function () { const a = (this.fetch16() + this.X) & 0xffff; this.A = this.setNZ8(rd(a)); return 5; };
    T[0xF6] = function () { const a = (this.fetch16() + this.Y) & 0xffff; this.A = this.setNZ8(rd(a)); return 5; };

    T[0xC6] = function () { wr(this.dp(this.X), this.A); return 4; };
    T[0xE6] = function () { this.A = this.setNZ8(rd(this.dp(this.X))); return 3; };
    T[0xAF] = function () { wr(this.dp(this.X), this.A); this.X = (this.X + 1) & 0xff; return 4; };
    T[0xBF] = function () { this.A = this.setNZ8(rd(this.dp(this.X))); this.X = (this.X + 1) & 0xff; return 4; };

    T[0xC7] = function () {
      const ptr = this.dp((this.fetch8() + this.X) & 0xff);
      const a = this.rd16dp(ptr);
      wr(a, this.A); return 7;
    };
    T[0xE7] = function () {
      const ptr = this.dp((this.fetch8() + this.X) & 0xff);
      const a = this.rd16dp(ptr);
      this.A = this.setNZ8(rd(a)); return 6;
    };
    T[0xD7] = function () {
      const ptr = this.dp(this.fetch8());
      const base = this.rd16dp(ptr);
      const a = (base + this.Y) & 0xffff;
      wr(a, this.A); return 7;
    };
    T[0xF7] = function () {
      const ptr = this.dp(this.fetch8());
      const base = this.rd16dp(ptr);
      const a = (base + this.Y) & 0xffff;
      this.A = this.setNZ8(rd(a)); return 6;
    };

    T[0xFA] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, rd(src)); return 5; };
    T[0x8F] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, v); return 5; };

    // ---- 16bit 命令(すべてダイレクトページ内で折り返す) ----
    // MOVW YA,dp
    T[0xBA] = function () {
      const a = this.dp(this.fetch8());
      const lo = rd(a); const hi = rd(this.dpNext(a));
      this.A = lo; this.Y = hi;
      this.flagZ = (lo | hi) === 0 ? 1 : 0;
      this.flagN = (hi & 0x80) ? 1 : 0;
      return 5;
    };
    // MOVW dp,YA  (実機: 下位バイトを書く前にダミーリードがある)
    T[0xDA] = function () {
      const a = this.dp(this.fetch8());
      rd(a);
      wr(a, this.A); wr(this.dpNext(a), this.Y);
      return 5;
    };
    // INCW dp
    T[0x3A] = function () {
      const a = this.dp(this.fetch8());
      const w = (this.rd16dp(a) + 1) & 0xffff;
      this.wr16dp(a, w);
      this.flagZ = w === 0 ? 1 : 0; this.flagN = (w & 0x8000) ? 1 : 0;
      return 6;
    };
    // DECW dp
    T[0x1A] = function () {
      const a = this.dp(this.fetch8());
      const w = (this.rd16dp(a) - 1) & 0xffff;
      this.wr16dp(a, w);
      this.flagZ = w === 0 ? 1 : 0; this.flagN = (w & 0x8000) ? 1 : 0;
      return 6;
    };
    // ADDW YA,dp   (C は最初のバイトの繰り上がりを含めた 16bit 加算。H は bit11 からの繰り上がり)
    T[0x7A] = function () {
      const a = this.dp(this.fetch8());
      const ya = (this.Y << 8) | this.A;
      const m = this.rd16dp(a);
      const result = ya + m;
      const r16 = result & 0xffff;
      this.flagC = result > 0xffff ? 1 : 0;
      this.flagV = (~(ya ^ m) & (ya ^ r16) & 0x8000) ? 1 : 0;
      this.flagH = (((ya & 0xfff) + (m & 0xfff)) > 0xfff) ? 1 : 0;
      this.Y = (r16 >> 8) & 0xff; this.A = r16 & 0xff;
      this.flagZ = r16 === 0 ? 1 : 0; this.flagN = (r16 & 0x8000) ? 1 : 0;
      return 5;
    };
    // SUBW YA,dp
    T[0x9A] = function () {
      const a = this.dp(this.fetch8());
      const ya = (this.Y << 8) | this.A;
      const m = this.rd16dp(a);
      const mInv = (~m) & 0xffff;
      const result = ya + mInv + 1;
      const r16 = result & 0xffff;
      this.flagC = result > 0xffff ? 1 : 0;
      this.flagV = (~(ya ^ mInv) & (ya ^ r16) & 0x8000) ? 1 : 0;
      this.flagH = (((ya & 0xfff) + (mInv & 0xfff) + 1) > 0xfff) ? 1 : 0;
      this.Y = (r16 >> 8) & 0xff; this.A = r16 & 0xff;
      this.flagZ = r16 === 0 ? 1 : 0; this.flagN = (r16 & 0x8000) ? 1 : 0;
      return 5;
    };
    // CMPW YA,dp
    T[0x5A] = function () {
      const a = this.dp(this.fetch8());
      const ya = (this.Y << 8) | this.A;
      const m = this.rd16dp(a);
      const result = (ya - m) & 0xffff;
      this.flagC = ya >= m ? 1 : 0;
      this.flagZ = result === 0 ? 1 : 0;
      this.flagN = (result & 0x8000) ? 1 : 0;
      return 4;
    };

    T[0x08] = function () { const v = this.fetch8(); this.A = this.setNZ8(this.A | v); return 2; };
    T[0x28] = function () { const v = this.fetch8(); this.A = this.setNZ8(this.A & v); return 2; };
    T[0x48] = function () { const v = this.fetch8(); this.A = this.setNZ8(this.A ^ v); return 2; };
    T[0x68] = function () { const v = this.fetch8(); const r = (this.A - v) & 0x1ff; this.flagC = this.A >= v ? 1 : 0; this.setNZ8(r); return 2; };
    T[0x88] = function () { const v = this.fetch8(); this.A = this.adc(this.A, v, this.flagC); return 2; };
    T[0xA8] = function () { const v = this.fetch8(); this.A = this.sbc(this.A, v, this.flagC); return 2; };

    T[0x04] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.setNZ8(this.A | v); return 3; };
    T[0x24] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.setNZ8(this.A & v); return 3; };
    T[0x44] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.setNZ8(this.A ^ v); return 3; };
    T[0x64] = function () { const v = rd(this.dp(this.fetch8())); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 3; };
    T[0x84] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.adc(this.A, v, this.flagC); return 3; };
    T[0xA4] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.sbc(this.A, v, this.flagC); return 3; };

    T[0x14] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.setNZ8(this.A | v); return 4; };
    T[0x34] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.setNZ8(this.A & v); return 4; };
    T[0x54] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.setNZ8(this.A ^ v); return 4; };
    T[0x74] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 4; };
    T[0x94] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.adc(this.A, v, this.flagC); return 4; };
    T[0xB4] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.sbc(this.A, v, this.flagC); return 4; };

    T[0x05] = function () { const v = rd(this.fetch16()); this.A = this.setNZ8(this.A | v); return 4; };
    T[0x25] = function () { const v = rd(this.fetch16()); this.A = this.setNZ8(this.A & v); return 4; };
    T[0x45] = function () { const v = rd(this.fetch16()); this.A = this.setNZ8(this.A ^ v); return 4; };
    T[0x65] = function () { const v = rd(this.fetch16()); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 4; };
    T[0x85] = function () { const v = rd(this.fetch16()); this.A = this.adc(this.A, v, this.flagC); return 4; };
    T[0xA5] = function () { const v = rd(this.fetch16()); this.A = this.sbc(this.A, v, this.flagC); return 4; };

    T[0x15] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.A = this.setNZ8(this.A | v); return 5; };
    T[0x16] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.A = this.setNZ8(this.A | v); return 5; };
    T[0x35] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.A = this.setNZ8(this.A & v); return 5; };
    T[0x36] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.A = this.setNZ8(this.A & v); return 5; };
    T[0x55] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.A = this.setNZ8(this.A ^ v); return 5; };
    T[0x56] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.A = this.setNZ8(this.A ^ v); return 5; };
    T[0x75] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 5; };
    T[0x76] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 5; };
    T[0x95] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.A = this.adc(this.A, v, this.flagC); return 5; };
    T[0x96] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.A = this.adc(this.A, v, this.flagC); return 5; };
    T[0xB5] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.A = this.sbc(this.A, v, this.flagC); return 5; };
    T[0xB6] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.A = this.sbc(this.A, v, this.flagC); return 5; };

    T[0x06] = function () { const v = rd(this.dp(this.X)); this.A = this.setNZ8(this.A | v); return 3; };
    T[0x26] = function () { const v = rd(this.dp(this.X)); this.A = this.setNZ8(this.A & v); return 3; };
    T[0x46] = function () { const v = rd(this.dp(this.X)); this.A = this.setNZ8(this.A ^ v); return 3; };
    T[0x66] = function () { const v = rd(this.dp(this.X)); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 3; };
    T[0x86] = function () { const v = rd(this.dp(this.X)); this.A = this.adc(this.A, v, this.flagC); return 3; };
    T[0xA6] = function () { const v = rd(this.dp(this.X)); this.A = this.sbc(this.A, v, this.flagC); return 3; };

    T[0x07] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = this.rd16dp(ptr); const v = rd(a); this.A = this.setNZ8(this.A | v); return 6; };
    T[0x27] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = this.rd16dp(ptr); const v = rd(a); this.A = this.setNZ8(this.A & v); return 6; };
    T[0x47] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = this.rd16dp(ptr); const v = rd(a); this.A = this.setNZ8(this.A ^ v); return 6; };
    T[0x67] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = this.rd16dp(ptr); const v = rd(a); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 6; };
    T[0x87] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = this.rd16dp(ptr); const v = rd(a); this.A = this.adc(this.A, v, this.flagC); return 6; };
    T[0xA7] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = this.rd16dp(ptr); const v = rd(a); this.A = this.sbc(this.A, v, this.flagC); return 6; };

    T[0x17] = function () { const ptr = this.dp(this.fetch8()); const base = this.rd16dp(ptr); const v = rd((base+this.Y)&0xffff); this.A = this.setNZ8(this.A | v); return 6; };
    T[0x37] = function () { const ptr = this.dp(this.fetch8()); const base = this.rd16dp(ptr); const v = rd((base+this.Y)&0xffff); this.A = this.setNZ8(this.A & v); return 6; };
    T[0x57] = function () { const ptr = this.dp(this.fetch8()); const base = this.rd16dp(ptr); const v = rd((base+this.Y)&0xffff); this.A = this.setNZ8(this.A ^ v); return 6; };
    T[0x77] = function () { const ptr = this.dp(this.fetch8()); const base = this.rd16dp(ptr); const v = rd((base+this.Y)&0xffff); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 6; };
    T[0x97] = function () { const ptr = this.dp(this.fetch8()); const base = this.rd16dp(ptr); const v = rd((base+this.Y)&0xffff); this.A = this.adc(this.A, v, this.flagC); return 6; };
    T[0xB7] = function () { const ptr = this.dp(this.fetch8()); const base = this.rd16dp(ptr); const v = rd((base+this.Y)&0xffff); this.A = this.sbc(this.A, v, this.flagC); return 6; };

    T[0x09] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.setNZ8(rd(dst) | rd(src))); return 6; };
    T[0x29] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.setNZ8(rd(dst) & rd(src))); return 6; };
    T[0x49] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.setNZ8(rd(dst) ^ rd(src))); return 6; };
    T[0x69] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); const a=rd(dst), b=rd(src); this.flagC = a>=b?1:0; this.setNZ8((a-b)&0x1ff); return 6; };
    T[0x89] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.adc(rd(dst), rd(src), this.flagC)); return 6; };
    T[0xA9] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.sbc(rd(dst), rd(src), this.flagC)); return 6; };

    T[0x18] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) | v)); return 5; };
    T[0x38] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) & v)); return 5; };
    T[0x58] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) ^ v)); return 5; };
    T[0x78] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); const m = rd(a); this.flagC = m>=v?1:0; this.setNZ8((m-v)&0x1ff); return 5; };
    T[0x98] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.adc(rd(a), v, this.flagC)); return 5; };
    T[0xB8] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.sbc(rd(a), v, this.flagC)); return 5; };

    T[0x19] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.setNZ8(rd(dstA) | rd(srcA))); return 5; };
    T[0x39] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.setNZ8(rd(dstA) & rd(srcA))); return 5; };
    T[0x59] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.setNZ8(rd(dstA) ^ rd(srcA))); return 5; };
    T[0x79] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); const a=rd(dstA), b=rd(srcA); this.flagC=a>=b?1:0; this.setNZ8((a-b)&0x1ff); return 5; };
    T[0x99] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.adc(rd(dstA), rd(srcA), this.flagC)); return 5; };
    T[0xB9] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.sbc(rd(dstA), rd(srcA), this.flagC)); return 5; };

    T[0xC8] = function () { const v = this.fetch8(); this.flagC = this.X>=v?1:0; this.setNZ8((this.X-v)&0x1ff); return 2; };
    T[0xAD] = function () { const v = this.fetch8(); this.flagC = this.Y>=v?1:0; this.setNZ8((this.Y-v)&0x1ff); return 2; };
    T[0x3E] = function () { const v = rd(this.dp(this.fetch8())); this.flagC = this.X>=v?1:0; this.setNZ8((this.X-v)&0x1ff); return 3; };
    T[0x7E] = function () { const v = rd(this.dp(this.fetch8())); this.flagC = this.Y>=v?1:0; this.setNZ8((this.Y-v)&0x1ff); return 3; };
    T[0x1E] = function () { const v = rd(this.fetch16()); this.flagC = this.X>=v?1:0; this.setNZ8((this.X-v)&0x1ff); return 4; };
    T[0x5E] = function () { const v = rd(this.fetch16()); this.flagC = this.Y>=v?1:0; this.setNZ8((this.Y-v)&0x1ff); return 4; };

    T[0xBC] = function () { this.A = this.setNZ8(this.A + 1); return 2; };
    T[0x9C] = function () { this.A = this.setNZ8(this.A - 1); return 2; };
    T[0x3D] = function () { this.X = this.setNZ8(this.X + 1); return 2; };
    T[0x1D] = function () { this.X = this.setNZ8(this.X - 1); return 2; };
    T[0xFC] = function () { this.Y = this.setNZ8(this.Y + 1); return 2; };
    T[0xDC] = function () { this.Y = this.setNZ8(this.Y - 1); return 2; };

    T[0xAB] = function () { const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) + 1)); return 4; };
    T[0x8B] = function () { const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) - 1)); return 4; };
    T[0xBB] = function () { const a = this.dp((this.fetch8()+this.X)&0xff); wr(a, this.setNZ8(rd(a) + 1)); return 5; };
    T[0x9B] = function () { const a = this.dp((this.fetch8()+this.X)&0xff); wr(a, this.setNZ8(rd(a) - 1)); return 5; };
    T[0xAC] = function () { const a = this.fetch16(); wr(a, this.setNZ8(rd(a) + 1)); return 5; };
    T[0x8C] = function () { const a = this.fetch16(); wr(a, this.setNZ8(rd(a) - 1)); return 5; };

    const asl = (v) => { const c = (v & 0x80) ? 1 : 0; const r = (v << 1) & 0xff; this.flagC = c; return this.setNZ8(r); };
    const lsr = (v) => { const c = v & 1; const r = (v >> 1) & 0xff; this.flagC = c; return this.setNZ8(r); };
    const rol = (v) => { const c = (v & 0x80) ? 1 : 0; const r = ((v << 1) | this.flagC) & 0xff; this.flagC = c; return this.setNZ8(r); };
    const ror = (v) => { const c = v & 1; const r = ((v >> 1) | (this.flagC << 7)) & 0xff; this.flagC = c; return this.setNZ8(r); };

    T[0x1C] = function () { this.A = asl(this.A); return 2; };
    T[0x0B] = function () { const a=this.dp(this.fetch8()); wr(a, asl(rd(a))); return 4; };
    T[0x1B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, asl(rd(a))); return 5; };
    T[0x0C] = function () { const a=this.fetch16(); wr(a, asl(rd(a))); return 5; };

    T[0x5C] = function () { this.A = lsr(this.A); return 2; };
    T[0x4B] = function () { const a=this.dp(this.fetch8()); wr(a, lsr(rd(a))); return 4; };
    T[0x5B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, lsr(rd(a))); return 5; };
    T[0x4C] = function () { const a=this.fetch16(); wr(a, lsr(rd(a))); return 5; };

    T[0x3C] = function () { this.A = rol(this.A); return 2; };
    T[0x2B] = function () { const a=this.dp(this.fetch8()); wr(a, rol(rd(a))); return 4; };
    T[0x3B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, rol(rd(a))); return 5; };
    T[0x2C] = function () { const a=this.fetch16(); wr(a, rol(rd(a))); return 5; };

    T[0x7C] = function () { this.A = ror(this.A); return 2; };
    T[0x6B] = function () { const a=this.dp(this.fetch8()); wr(a, ror(rd(a))); return 4; };
    T[0x7B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, ror(rd(a))); return 5; };
    T[0x6C] = function () { const a=this.fetch16(); wr(a, ror(rd(a))); return 5; };

    T[0x9F] = function () { this.A = this.setNZ8(((this.A << 4) | (this.A >> 4)) & 0xff); return 5; };

    T[0xCF] = function () {
      const r = (this.Y & 0xff) * (this.A & 0xff);
      this.A = r & 0xff; this.Y = (r >> 8) & 0xff;
      this.setNZ8(this.Y);
      return 9;
    };
    // DIV YA,X  (実機準拠: bsnes/higan と同じ式。商が 9bit を超える場合の特殊結果も再現)
    T[0x9E] = function () {
      const ya = (this.Y << 8) | this.A;
      const x = this.X;
      this.flagH = ((this.Y & 0xf) >= (x & 0xf)) ? 1 : 0;   // (X&15) <= (Y&15)
      this.flagV = (this.Y >= x) ? 1 : 0;
      if (this.Y < (x << 1)) {
        // 通常の除算 (x=0 の場合 Y<0 は偽なので下の式へ入る)
        this.A = Math.floor(ya / x) & 0xff;
        this.Y = (ya % x) & 0xff;
      } else {
        // オーバーフロー時の実機挙動
        const d = 256 - x;
        this.A = (255 - Math.floor((ya - (x << 9)) / d)) & 0xff;
        this.Y = (x + ((ya - (x << 9)) % d)) & 0xff;
      }
      this.setNZ8(this.A);
      return 12;
    };

    T[0xDF] = function () {
      let a = this.A;
      if (this.flagC || a > 0x99) { a = (a + 0x60) & 0xff; this.flagC = 1; }
      if (this.flagH || (a & 0x0f) > 9) { a = (a + 0x06) & 0xff; }
      this.A = this.setNZ8(a);
      return 3;
    };
    T[0xBE] = function () {
      let a = this.A;
      if (!this.flagC || a > 0x99) { a = (a - 0x60) & 0xff; this.flagC = 0; }
      if (!this.flagH || (a & 0x0f) > 9) { a = (a - 0x06) & 0xff; }
      this.A = this.setNZ8(a);
      return 3;
    };

    T[0x60] = function () { this.flagC = 0; return 2; };
    T[0x80] = function () { this.flagC = 1; return 2; };
    T[0xED] = function () { this.flagC = this.flagC ^ 1; return 3; };
    T[0x20] = function () { this.flagP = 0; return 2; };
    T[0x40] = function () { this.flagP = 1; return 2; };
    T[0xE0] = function () { this.flagV = 0; this.flagH = 0; return 2; };
    T[0xA0] = function () { this.flagI = 1; return 2; };
    T[0xC0] = function () { this.flagI = 0; return 2; };

    T[0x2D] = function () { this.push8(this.A); return 4; };
    T[0x4D] = function () { this.push8(this.X); return 4; };
    T[0x6D] = function () { this.push8(this.Y); return 4; };
    T[0x0D] = function () { this.push8(this.getPSW()); return 4; };
    T[0xAE] = function () { this.A = this.pop8(); return 4; };
    T[0xCE] = function () { this.X = this.pop8(); return 4; };
    T[0xEE] = function () { this.Y = this.pop8(); return 4; };
    T[0x8E] = function () { this.setPSW(this.pop8()); return 4; };

    T[0x2F] = function () { const d = this.fetch8(); const s=d&0x80?d-256:d; this.PC=(this.PC+s)&0xffff; return 4; };
    T[0xF0] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagZ===1, d); };
    T[0xD0] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagZ===0, d); };
    T[0xB0] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagC===1, d); };
    T[0x90] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagC===0, d); };
    T[0x70] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagV===1, d); };
    T[0x50] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagV===0, d); };
    T[0x30] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagN===1, d); };
    T[0x10] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagN===0, d); };

    for (let bit = 0; bit < 8; bit++) {
      const opSet = 0x03 | (bit << 5);
      const opClr = 0x13 | (bit << 5);
      T[opSet] = function () {
        const a = this.dp(this.fetch8()); const d = this.fetch8();
        const v = rd(a);
        return 5 + this._branch(((v >> bit) & 1) === 1, d);
      };
      T[opClr] = function () {
        const a = this.dp(this.fetch8()); const d = this.fetch8();
        const v = rd(a);
        return 5 + this._branch(((v >> bit) & 1) === 0, d);
      };
    }

    T[0x2E] = function () { const a=this.dp(this.fetch8()); const d=this.fetch8(); const v=rd(a); return 5 + this._branch(this.A!==v, d); };
    T[0xDE] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); const d=this.fetch8(); const v=rd(a); return 6 + this._branch(this.A!==v, d); };

    T[0xFE] = function () { const d=this.fetch8(); this.Y=(this.Y-1)&0xff; return 4 + this._branch(this.Y!==0, d); };
    T[0x6E] = function () { const a=this.dp(this.fetch8()); const d=this.fetch8(); let v=rd(a); v=(v-1)&0xff; wr(a,v); return 5 + this._branch(v!==0, d); };

    T[0x5F] = function () { this.PC = this.fetch16(); return 3; };
    T[0x1F] = function () { const base = this.fetch16(); const ptr=(base+this.X)&0xffff; this.PC = rd(ptr) | (rd((ptr+1)&0xffff)<<8); return 6; };

    T[0x3F] = function () { const a = this.fetch16(); this.push16(this.PC); this.PC = a; return 8; };
    T[0x4F] = function () { const a = 0xFF00 | this.fetch8(); this.push16(this.PC); this.PC = a; return 6; };
    for (let n = 0; n < 16; n++) {
      const op = 0x01 | (n << 4);
      T[op] = function () {
        const vecAddr = 0xFFDE - n * 2;
        const target = rd(vecAddr) | (rd((vecAddr + 1) & 0xffff) << 8);
        this.push16(this.PC);
        this.PC = target;
        return 8;
      };
    }

    T[0x6F] = function () { this.PC = this.pop16(); return 5; };
    T[0x7F] = function () { this.setPSW(this.pop8()); this.PC = this.pop16(); return 6; };

    T[0x0F] = function () {
      this.push16(this.PC);
      this.push8(this.getPSW());
      this.flagB = 1; this.flagI = 0;
      this.PC = rd(0xFFDE) | (rd(0xFFDF) << 8);
      return 8;
    };

    T[0xEF] = function () { this.PC = (this.PC - 1) & 0xffff; return 3; };   // SLEEP
    T[0xFF] = function () { this.PC = (this.PC - 1) & 0xffff; return 3; };   // STOP

    T[0xAA] = function () {
      const w = this.fetch16(); const addr = w & 0x1fff; const bit = (w >> 13) & 7;
      const v = rd(addr);
      this.flagC = (v >> bit) & 1;
      return 4;
    };
    T[0xCA] = function () {
      const w = this.fetch16(); const addr = w & 0x1fff; const bit = (w >> 13) & 7;
      let v = rd(addr);
      if (this.flagC) v |= (1 << bit); else v &= ~(1 << bit);
      wr(addr, v & 0xff);
      return 6;
    };

    T[0x4A] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; const v=(rd(addr)>>bit)&1; this.flagC = this.flagC & v; return 4; };
    T[0x6A] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; const v=(rd(addr)>>bit)&1; this.flagC = this.flagC & (v^1); return 4; };
    T[0x0A] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; const v=(rd(addr)>>bit)&1; this.flagC = this.flagC | v; return 5; };
    T[0x2A] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; const v=(rd(addr)>>bit)&1; this.flagC = this.flagC | (v^1); return 5; };
    T[0x8A] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; const v=(rd(addr)>>bit)&1; this.flagC = this.flagC ^ v; return 5; };

    T[0xEA] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; let v=rd(addr); v ^= (1<<bit); wr(addr, v&0xff); return 5; };

    for (let bit = 0; bit < 8; bit++) {
      const opSet = 0x02 | (bit << 5);
      const opClr = 0x12 | (bit << 5);
      T[opSet] = function () { const a=this.dp(this.fetch8()); let v=rd(a); v |= (1<<bit); wr(a, v&0xff); return 4; };
      T[opClr] = function () { const a=this.dp(this.fetch8()); let v=rd(a); v &= ~(1<<bit); wr(a, v&0xff); return 4; };
    }

    T[0x0E] = function () { const a=this.fetch16(); const v=rd(a); this.setNZ8((this.A - v) & 0x1ff); wr(a, v | this.A); return 6; };
    T[0x4E] = function () { const a=this.fetch16(); const v=rd(a); this.setNZ8((this.A - v) & 0x1ff); wr(a, v & (~this.A & 0xff)); return 6; };

    T.subroutineMarker = true;
    this.opTable = T;
  }
}

if (typeof module !== 'undefined') module.exports = { SPC700 };

// ============================================================================
// SNES DSP (S-DSP) エミュレータ
// ============================================================================
const SDSP_RATE = 32000;

// ---- 出力の耳あたり調整用パラメータ ---------------------------------------
// OUTPUT_HEADROOM: 1より大きいほど全体の音量が下がり、softClipで潰れにくくなる。
//   ミックスを実機と同じ 16bit 整数スケール(±32768 = ±1.0)に揃えたので、
//   1.0 で実機と同じ音量。大音量の曲でピークが気になる場合のみ 1 より大きくする。
const OUTPUT_HEADROOM = 1.0;
// ローパスのカットオフ(Hz)。低いほどまろやか、高いほど明るい。
const LP_CUTOFF_HZ = 6000;
const LP_ALPHA = 1 - Math.exp(-2 * Math.PI * LP_CUTOFF_HZ / SDSP_RATE);

// 穏やかなソフトクリップ。小さい音はほぼそのまま、大きい音だけ滑らかに丸める。
// tanhより「膝」がゆるやかで、常用しても歪み感が出にくい。
function softClip(x) {
  const t = 0.6;                       // ここまでは素通し
  const ax = Math.abs(x);
  if (ax <= t) return x;
  const over = (ax - t) / (1 - t);     // 0以上
  const y = t + (1 - t) * Math.tanh(over);
  return x < 0 ? -y : y;
}


// 実機のレートカウンタ用オフセット(bsnes/higan: counterOffset)
const COUNTER_OFFSETS = [
  0, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536,
  0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 0, 0
];
const COUNTER_RATES = [
  0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192,
  160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1
];

// 実機S-DSPのガウス補間表 (512エントリ, fullsnes より)。4タップ合計は ≒ 0x800。
const GAUSS_TABLE = new Int16Array([
  0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000,
  0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x002, 0x002, 0x002, 0x002, 0x002,
  0x002, 0x002, 0x003, 0x003, 0x003, 0x003, 0x003, 0x004, 0x004, 0x004, 0x004, 0x004, 0x005, 0x005, 0x005, 0x005,
  0x006, 0x006, 0x006, 0x006, 0x007, 0x007, 0x007, 0x008, 0x008, 0x008, 0x009, 0x009, 0x009, 0x00A, 0x00A, 0x00A,
  0x00B, 0x00B, 0x00B, 0x00C, 0x00C, 0x00D, 0x00D, 0x00E, 0x00E, 0x00F, 0x00F, 0x00F, 0x010, 0x010, 0x011, 0x011,
  0x012, 0x013, 0x013, 0x014, 0x014, 0x015, 0x015, 0x016, 0x017, 0x017, 0x018, 0x018, 0x019, 0x01A, 0x01B, 0x01B,
  0x01C, 0x01D, 0x01D, 0x01E, 0x01F, 0x020, 0x020, 0x021, 0x022, 0x023, 0x024, 0x024, 0x025, 0x026, 0x027, 0x028,
  0x029, 0x02A, 0x02B, 0x02C, 0x02D, 0x02E, 0x02F, 0x030, 0x031, 0x032, 0x033, 0x034, 0x035, 0x036, 0x037, 0x038,
  0x03A, 0x03B, 0x03C, 0x03D, 0x03E, 0x040, 0x041, 0x042, 0x043, 0x045, 0x046, 0x047, 0x049, 0x04A, 0x04C, 0x04D,
  0x04E, 0x050, 0x051, 0x053, 0x054, 0x056, 0x057, 0x059, 0x05A, 0x05C, 0x05E, 0x05F, 0x061, 0x063, 0x064, 0x066,
  0x068, 0x06A, 0x06B, 0x06D, 0x06F, 0x071, 0x073, 0x075, 0x076, 0x078, 0x07A, 0x07C, 0x07E, 0x080, 0x082, 0x084,
  0x086, 0x089, 0x08B, 0x08D, 0x08F, 0x091, 0x093, 0x096, 0x098, 0x09A, 0x09C, 0x09F, 0x0A1, 0x0A3, 0x0A6, 0x0A8,
  0x0AB, 0x0AD, 0x0AF, 0x0B2, 0x0B4, 0x0B7, 0x0BA, 0x0BC, 0x0BF, 0x0C1, 0x0C4, 0x0C7, 0x0C9, 0x0CC, 0x0CF, 0x0D2,
  0x0D4, 0x0D7, 0x0DA, 0x0DD, 0x0E0, 0x0E3, 0x0E6, 0x0E9, 0x0EC, 0x0EF, 0x0F2, 0x0F5, 0x0F8, 0x0FB, 0x0FE, 0x101,
  0x104, 0x107, 0x10B, 0x10E, 0x111, 0x114, 0x118, 0x11B, 0x11E, 0x122, 0x125, 0x129, 0x12C, 0x130, 0x133, 0x137,
  0x13A, 0x13E, 0x141, 0x145, 0x148, 0x14C, 0x150, 0x153, 0x157, 0x15B, 0x15F, 0x162, 0x166, 0x16A, 0x16E, 0x172,
  0x176, 0x17A, 0x17D, 0x181, 0x185, 0x189, 0x18D, 0x191, 0x195, 0x19A, 0x19E, 0x1A2, 0x1A6, 0x1AA, 0x1AE, 0x1B2,
  0x1B7, 0x1BB, 0x1BF, 0x1C3, 0x1C8, 0x1CC, 0x1D0, 0x1D5, 0x1D9, 0x1DD, 0x1E2, 0x1E6, 0x1EB, 0x1EF, 0x1F3, 0x1F8,
  0x1FC, 0x201, 0x205, 0x20A, 0x20F, 0x213, 0x218, 0x21C, 0x221, 0x226, 0x22A, 0x22F, 0x233, 0x238, 0x23D, 0x241,
  0x246, 0x24B, 0x250, 0x254, 0x259, 0x25E, 0x263, 0x267, 0x26C, 0x271, 0x276, 0x27B, 0x280, 0x284, 0x289, 0x28E,
  0x293, 0x298, 0x29D, 0x2A2, 0x2A6, 0x2AB, 0x2B0, 0x2B5, 0x2BA, 0x2BF, 0x2C4, 0x2C9, 0x2CE, 0x2D3, 0x2D8, 0x2DC,
  0x2E1, 0x2E6, 0x2EB, 0x2F0, 0x2F5, 0x2FA, 0x2FF, 0x304, 0x309, 0x30E, 0x313, 0x318, 0x31D, 0x322, 0x326, 0x32B,
  0x330, 0x335, 0x33A, 0x33F, 0x344, 0x349, 0x34E, 0x353, 0x357, 0x35C, 0x361, 0x366, 0x36B, 0x370, 0x374, 0x379,
  0x37E, 0x383, 0x388, 0x38C, 0x391, 0x396, 0x39B, 0x39F, 0x3A4, 0x3A9, 0x3AD, 0x3B2, 0x3B7, 0x3BB, 0x3C0, 0x3C5,
  0x3C9, 0x3CE, 0x3D2, 0x3D7, 0x3DC, 0x3E0, 0x3E5, 0x3E9, 0x3ED, 0x3F2, 0x3F6, 0x3FB, 0x3FF, 0x403, 0x408, 0x40C,
  0x410, 0x415, 0x419, 0x41D, 0x421, 0x425, 0x42A, 0x42E, 0x432, 0x436, 0x43A, 0x43E, 0x442, 0x446, 0x44A, 0x44E,
  0x452, 0x455, 0x459, 0x45D, 0x461, 0x465, 0x468, 0x46C, 0x470, 0x473, 0x477, 0x47A, 0x47E, 0x481, 0x485, 0x488,
  0x48C, 0x48F, 0x492, 0x496, 0x499, 0x49C, 0x49F, 0x4A2, 0x4A6, 0x4A9, 0x4AC, 0x4AF, 0x4B2, 0x4B5, 0x4B7, 0x4BA,
  0x4BD, 0x4C0, 0x4C3, 0x4C5, 0x4C8, 0x4CB, 0x4CD, 0x4D0, 0x4D2, 0x4D5, 0x4D7, 0x4D9, 0x4DC, 0x4DE, 0x4E0, 0x4E3,
  0x4E5, 0x4E7, 0x4E9, 0x4EB, 0x4ED, 0x4EF, 0x4F1, 0x4F3, 0x4F5, 0x4F6, 0x4F8, 0x4FA, 0x4FB, 0x4FD, 0x4FF, 0x500,
  0x502, 0x503, 0x504, 0x506, 0x507, 0x508, 0x50A, 0x50B, 0x50C, 0x50D, 0x50E, 0x50F, 0x510, 0x511, 0x511, 0x512,
  0x513, 0x514, 0x514, 0x515, 0x516, 0x516, 0x517, 0x517, 0x517, 0x518, 0x518, 0x518, 0x518, 0x518, 0x519, 0x519,
]);

class DSP {
  constructor(ram) {
    this.ram = ram;
    this.regs = new Uint8Array(128);
    this.regAddr = 0;

    this.voices = [];
    for (let i = 0; i < 8; i++) {
      this.voices.push({
        brrAddr: 0,
        brrOffset: 0,
        pitchCounter: 0,
        history: [0, 0],
        decodedBlock: new Int16Array(16),
        // Gauss補間用: 直近4サンプル(古→新)。ブロック境界をまたいでも連続になる
        interp: new Float64Array(4),
        curBlockHeader: 0,
        keyOn: false,
        keyOff: false,
        envMode: 'off',
        envLevel: 0,
        loopFlag: false,
        endFlag: false,
        sampleAddr: 0,
        outSample: 0,
        konDelay: 0,
      });
    }

    this.gaussTable = GAUSS_TABLE;
    this.noiseLFSR = 0x4000;
    this.masterVolL = 0;
    this.masterVolR = 0;

    // --- エコー(残響) ---
    // 実機同様、エコーバッファはSPC RAM上(ESA/EDLで指定)に置く。
    // 8タップFIRの履歴と書き込み位置を保持する。
    this.echoOffset = 0;
    this.echoLength = 4;
    this.firHistL = new Int32Array(8);
    this.firHistR = new Int32Array(8);
    this.firPos = 0;

    // --- 出力段(耳に優しくするための後処理) ---
    // DC除去(ハイパス ~ 8Hz)と、高域を穏やかに落とすローパス。
    this.dcPrevInL = 0; this.dcPrevOutL = 0;
    this.dcPrevInR = 0; this.dcPrevOutR = 0;
    this.lpL = 0; this.lpR = 0;
  }

  reset() {
    this.regs.fill(0);
    this.regAddr = 0;
    this._globalCounter = 0x77ff;
    this._pendingKon = 0; // このサンプル期間中にKONへ書き込まれたビットの蓄積
    this.echoOffset = 0;
    this.echoLength = 4;
    this.firHistL.fill(0); this.firHistR.fill(0); this.firPos = 0;
    this.dcPrevInL = this.dcPrevOutL = this.dcPrevInR = this.dcPrevOutR = 0;
    this.lpL = this.lpR = 0;
    for (const v of this.voices) {
      v.interp.fill(0);
      v.pitchCounter = 0;
      v.envLevel = 0;
      v.keyOn = false;
      v.keyOff = false;
      v.envMode = 'off';
      v.history = [0, 0];
      v.brrOffset = 16;
      v.endFlag = false;
      v._konLatched = false;
    }
  }

  read(addr) { return this.regs[addr & 0x7f]; }
  write(addr, val) {
    addr &= 0x7f;
    val &= 0xff;
    if (addr === 0x7c) {
      this.regs[0x7c] = 0; // ENDXへの書き込みは値を問わず全ビットクリア
      return;
    }
    if (addr === 0x4c) {
      // KONへの書き込みは「新たに1になったビット」を確実に拾うため、
      // 次のサンプル生成までのビットを蓄積しておく(見逃し防止)。
      this._pendingKon = (this._pendingKon || 0) | val;
    }
    this.regs[addr] = val;
  }

  volL(v) { return this._s8(this.regs[v * 0x10 + 0x00]); }
  volR(v) { return this._s8(this.regs[v * 0x10 + 0x01]); }
  pitch(v) { return this.regs[v * 0x10 + 0x02] | ((this.regs[v * 0x10 + 0x03] & 0x3f) << 8); }
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
  get dir() { return this.regs[0x5d]; }
  get mvolL() { return this._s8(this.regs[0x0c]); }
  get mvolR() { return this._s8(this.regs[0x1c]); }
  get evolL() { return this._s8(this.regs[0x2c]); }
  get evolR() { return this._s8(this.regs[0x3c]); }
  get efb() { return this._s8(this.regs[0x0d]); }
  get esa() { return this.regs[0x6d]; }
  get edl() { return this.regs[0x7d] & 0x0f; }
  fir(i) { return this._s8(this.regs[(i << 4) | 0x0f]); }

  getSampleDirEntry(srcn) {
    const base = (this.dir << 8) + srcn * 4;
    const start = this.ram[base] | (this.ram[base + 1] << 8);
    const loop = this.ram[base + 2] | (this.ram[base + 3] << 8);
    return { start, loop };
  }

  decodeBrrBlock(voice, addr, voiceIdx) {
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
      if (nibble >= 8) nibble -= 16;

      let sample;
      if (range <= 12) {
        sample = (nibble << range) >> 1;
      } else {
        // range 13-15 は不正値: 実機は符号だけを反映する
        sample = nibble < 0 ? -2048 : 0;
      }

      switch (filter) {
        case 1: sample += h1 + ((-h1) >> 4); break;
        case 2: sample += h1 * 2 + ((-(h1 * 3)) >> 5) - h2 + (h2 >> 4); break;
        case 3: sample += h1 * 2 + ((-(h1 * 13)) >> 6) - h2 + ((h2 * 3) >> 4); break;
      }
      // 16bit にクランプし、その後 15bit へ折り返す(実機の挙動)。
      // クランプだけだと大振幅で符号が反転すべき所が 32767 に張り付いてしまう。
      if (sample > 32767) sample = 32767;
      else if (sample < -32768) sample = -32768;
      sample = (sample << 17) >> 17;

      out[i] = sample;
      h2 = h1;
      h1 = sample;
    }

    voice.history[0] = h1;
    voice.history[1] = h2;
    voice.loopFlag = loopBit === 1;
    voice.endFlag = endBit === 1;
    if (endBit === 1 && voiceIdx !== undefined) {
      this.regs[0x7c] |= (1 << voiceIdx); // 波形終了時にENDXビットを立てる
    }
    return endBit === 1;
  }

  // ノイズ発生器は全ボイス共通。FLG bit0-4 のレートで「1サンプルにつき高々1回」クロックされる。
  clockNoise() {
    const rate = this.flg & 0x1f;
    if (this._rateFires(rate)) {
      const lfsr = this.noiseLFSR;
      const fb = (lfsr ^ (lfsr >> 1)) & 1;
      this.noiseLFSR = ((lfsr >> 1) & 0x3fff) | (fb << 14);
    }
  }
  // 現在のノイズ値(15bitを16bitに左詰めした符号付き値 = (int16)(lfsr<<1))を、
  // ボイスの15bitサンプルスケールに合わせて返す。
  noiseSample() {
    return ((this.noiseLFSR << 17) >> 17);
  }

  stepEnvelope(voice, vIdx) {
    const a1 = this.adsr1(vIdx);
    const a2 = this.adsr2(vIdx);
    const useADSR = (a1 & 0x80) !== 0;

    if (voice.keyOff) {
      voice.envMode = 'release';
    }

    if (voice.envMode === 'release') {
      voice.envLevel -= 8;
      if (voice.envLevel <= 0) {
        voice.envLevel = 0;
        voice.envMode = 'off';
      }
      return voice.envLevel;
    }

    if (useADSR) {
      const attackRate = (a1 & 0x0f) * 2 + 1;
      const decayRate = ((a1 >> 4) & 0x07) * 2 + 16;
      const sustainRate = a2 & 0x1f;
      const sustainLvl = (((a2 >> 5) & 0x07) + 1) * 256;

      if (voice.envMode === 'attack') {
        const rate = attackRate;
        if (this._rateFires(rate)) {
          voice.envLevel += (rate === 31) ? 1024 : 32;
          // 実機: 0x7E0 以上でディケイへ移行。エンベロープ自体は 0x7FF でクランプ。
          if (voice.envLevel >= 0x7e0) voice.envMode = 'decay';
          if (voice.envLevel > 0x7ff) voice.envLevel = 0x7ff;
        }
      } else if (voice.envMode === 'decay') {
        if (this._rateFires(decayRate)) {
          voice.envLevel -= (((voice.envLevel - 1) >> 8) + 1);
          if (voice.envLevel < 0) voice.envLevel = 0;
          // 実機: (env >> 8) == SL で移行 → env が sustainLvl(=(SL+1)*256) 未満になったら。
          if (voice.envLevel < sustainLvl) voice.envMode = 'sustain';
        }
      } else if (voice.envMode === 'sustain') {
        if (sustainRate > 0 && this._rateFires(sustainRate)) {
          voice.envLevel -= (((voice.envLevel - 1) >> 8) + 1);
          if (voice.envLevel < 0) voice.envLevel = 0;
        }
      }
    } else {
      const gainVal = this.gain(vIdx);
      if ((gainVal & 0x80) === 0) {
        voice.envLevel = (gainVal & 0x7f) * 16;
      } else {
        const mode = (gainVal >> 5) & 0x03;
        const rate = gainVal & 0x1f;
        if (this._rateFires(rate)) {
          if (mode === 0) {
            voice.envLevel -= 32;                                   // 直線減少
          } else if (mode === 1) {
            voice.envLevel -= (((voice.envLevel - 1) >> 8) + 1);    // 指数減少
          } else if (mode === 2) {
            voice.envLevel += 32;                                   // 直線増加
          } else {
            voice.envLevel += (voice.envLevel < 0x600) ? 32 : 8;    // 折れ線増加
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

  // 実機: カウンタは 0x77FF から毎サンプル1ずつ減り、0 の次は 0x77FF に戻る。
  // レート r は ((counter + offset[r]) % period[r]) === 0 のときに発火する。
  _rateFires(rateIndex) {
    const period = COUNTER_RATES[rateIndex] || 0;
    if (period === 0) return false;
    return ((this._globalCounter + COUNTER_OFFSETS[rateIndex]) % period) === 0;
  }

  // エコー段。EON ボイスの合計(eMixL/R)を受け取り、FIR 出力 [L, R] を返す。
  // 副作用として SPC RAM 上のエコーバッファを更新する(FLG bit5=1 のときは書かない)。
  _echoStep(eMixL, eMixR) {
    const ram = this.ram;
    const base = ((this.esa << 8) + this.echoOffset) & 0xffff;

    // (1) RAM から読む(16bit LE, 符号付き)。履歴は 15bit へ落とす(>>1)。
    let inL = ram[base] | (ram[(base + 1) & 0xffff] << 8); inL = (inL << 16) >> 16;
    let inR = ram[(base + 2) & 0xffff] | (ram[(base + 3) & 0xffff] << 8); inR = (inR << 16) >> 16;

    const hl = this.firHistL, hr = this.firHistR, fp = this.firPos;
    hl[fp] = inL >> 1; hr[fp] = inR >> 1;
    this.firPos = (fp + 1) & 7;

    // (2) FIR: t=0 が最古、t=7 が最新。実機は先頭7タップの合計を int16 で保持する
    //     (=16bit にラップ)。最後のタップを足した後に 16bit クランプする。
    let fl = 0, fr = 0;
    for (let t = 0; t < 7; t++) {
      const idx = (this.firPos + t) & 7;      // firPos は「次に書く位置」= 最古
      const c = this.fir(t);
      fl += (hl[idx] * c) >> 6;
      fr += (hr[idx] * c) >> 6;
    }
    {
      const idx = (this.firPos + 7) & 7;
      const c = this.fir(7);
      // 先頭7項の合計を int16 にラップ
      fl = (fl << 16) >> 16; fr = (fr << 16) >> 16;
      fl += (hl[idx] * c) >> 6;
      fr += (hr[idx] * c) >> 6;
    }
    if (fl > 32767) fl = 32767; else if (fl < -32768) fl = -32768;
    if (fr > 32767) fr = 32767; else if (fr < -32768) fr = -32768;
    fl &= ~1; fr &= ~1;                       // 実機は最下位ビットを落とす

    // (3) 書き戻し。FLG bit5(ECEN)=1 のときは書き込み禁止。
    if (!(this.flg & 0x20)) {
      let wl = eMixL + ((fl * this.efb) >> 7);
      let wr = eMixR + ((fr * this.efb) >> 7);
      if (wl > 32767) wl = 32767; else if (wl < -32768) wl = -32768;
      if (wr > 32767) wr = 32767; else if (wr < -32768) wr = -32768;
      wl &= ~1; wr &= ~1;
      ram[base]                = wl & 0xff;
      ram[(base + 1) & 0xffff] = (wl >> 8) & 0xff;
      ram[(base + 2) & 0xffff] = wr & 0xff;
      ram[(base + 3) & 0xffff] = (wr >> 8) & 0xff;
    }

    // バッファ位置を進める。長さに達したら 0 へ戻し、その時点の EDL を反映する。
    this.echoOffset += 4;
    if (this.echoOffset >= this.echoLength) {
      this.echoOffset = 0;
      this.echoLength = this.edl * 2048;
      if (this.echoLength === 0) this.echoLength = 4;   // EDL=0 でも 1 組
    }

    return [fl, fr];
  }

  generateSample() {
    // カウンタは毎サンプル1減算(0 の次は 0x77FF)
    this._globalCounter = (this._globalCounter === 0) ? 0x77ff : this._globalCounter - 1;
    this.clockNoise();

    let mixL = 0, mixR = 0;
    let eMixL = 0, eMixR = 0; // EONが立っているボイスだけをエコーへ送る
    // 通常のKONレジスタ値に加えて、この期間中に書き込まれたビットも
    // 必ず拾う(CPUが同一サンプル期間内にKONへ複数回書き込んでも
    // トリガーを取りこぼさないようにするため)。
    const konReg = this.kon | (this._pendingKon || 0);
    const koffReg = this.koff;
    const resetFlag = (this.flg & 0x80) !== 0;   // FLG bit7: ソフトリセット
    this._pendingKon = 0;

    for (let i = 0; i < 8; i++) {
      const voice = this.voices[i];
      const bit = 1 << i;

      if (konReg & bit) {
        if (!voice._konLatched) {
          this._triggerKeyOn(voice, i);
          voice._konLatched = true;
        }
      } else {
        voice._konLatched = false;
      }
      // KOFF、または FLG bit7(RESET) でリリースへ。RESET 中はエンベロープも即 0。
      voice.keyOff = ((koffReg & bit) !== 0) || resetFlag;
      if (resetFlag) {
        voice.envLevel = 0;
        voice.envMode = 'off';
      }

      if (voice.envMode === 'off') {
        voice.outSample = 0;   // PMON が次のボイスで参照するので、停止中は 0
        continue;
      }

      if (voice.envMode === 'kon-delay') {
        // KON検出直後の無音準備期間。ボイスは出力を持たないが、
        // 実機同様に最初のBRRブロックのデコードだけ先行して行っておく。
        if (voice.brrOffset >= 16) {
          this.decodeBrrBlock(voice, voice.brrAddr, i);
          // 補間履歴は「無音3つ + 先頭サンプル」で開始(立ち上がりのクリック防止)
          voice.interp[0] = 0; voice.interp[1] = 0; voice.interp[2] = 0;
          voice.interp[3] = voice.decodedBlock[0];
          voice.brrOffset = 1;
        }
        voice.outSample = 0;
        voice.konDelay--;
        if (voice.konDelay <= 0) {
          voice.envMode = 'attack';
        }
        continue;
      }

      let p = this.pitch(i) & 0x3fff;
      if (i > 0 && (this.pmon & bit)) {
        // 直前ボイスの出力(エンベロープ後・15bit値)。実機は factor = (out >> 4) + 0x400。
        const prevOut = this.voices[i - 1].outSample | 0;
        p = (p * ((prevOut >> 4) + 0x400)) >> 10;
      }
      if (p > 0x3fff) p = 0x3fff;

      // --- ガウス補間(実機式) ------------------------------------------------
      // ピッチカウンタ bit4-11 で表を引き、直近4サンプル(ip: 古→新)を畳み込む。
      // 最初の3項を足した時点で16bitにラップし、最後の項を足した後にクランプ、>>1。
      const gi = (voice.pitchCounter >> 4) & 0xff; // 0..255
      const gt = this.gaussTable;
      const ip = voice.interp;
      let gs = (gt[255 - gi] * ip[0]) >> 10;
      gs += (gt[511 - gi] * ip[1]) >> 10;
      gs += (gt[256 + gi] * ip[2]) >> 10;
      gs = (gs << 16) >> 16;                        // 16bitラップ
      gs += (gt[gi] * ip[3]) >> 10;
      if (gs > 32767) gs = 32767; else if (gs < -32768) gs = -32768;
      let sample = gs >> 1;                          // 15bit

      if (this.non & bit) {
        sample = this.noiseSample();
      }

      const env = this.stepEnvelope(voice, i);
      // 実機: サンプル(15bit) × エンベロープ(11bit) >> 11
      sample = (sample * env) >> 11;

      voice.outSample = sample;

      // 音量(符号付き8bit): sample * vol >> 7。左右それぞれ 16bit にクランプしながら加算。
      const vl = (sample * this.volL(i)) >> 7;
      const vr = (sample * this.volR(i)) >> 7;
      mixL += vl;
      mixR += vr;
      if (mixL > 32767) mixL = 32767; else if (mixL < -32768) mixL = -32768;
      if (mixR > 32767) mixR = 32767; else if (mixR < -32768) mixR = -32768;
      if (this.eon & bit) {
        eMixL += vl;
        eMixR += vr;
        if (eMixL > 32767) eMixL = 32767; else if (eMixL < -32768) eMixL = -32768;
        if (eMixR > 32767) eMixR = 32767; else if (eMixR < -32768) eMixR = -32768;
      }

      voice.pitchCounter += p;
      let advance = voice.pitchCounter >> 12;
      voice.pitchCounter &= 0xfff;

      // 1サンプル進むたびに、そのサンプルを補間履歴へ押し込む。
      // これでBRRブロックの境界をまたいでも4タップが連続する。
      while (advance-- > 0) {
        if (voice.brrOffset >= 16) {
          if (voice.endFlag) {
            if (voice.loopFlag) {
              const dirEntry = this.getSampleDirEntry(this.srcn(i));
              voice.brrAddr = dirEntry.loop;
            } else {
              voice.envMode = 'off';
              voice.envLevel = 0;
              break;
            }
          } else {
            voice.brrAddr = (voice.brrAddr + 9) & 0xffff;
          }
          this.decodeBrrBlock(voice, voice.brrAddr, i);
          voice.brrOffset = 0;
        }
        const ip2 = voice.interp;
        ip2[0] = ip2[1]; ip2[1] = ip2[2]; ip2[2] = ip2[3];
        ip2[3] = voice.decodedBlock[voice.brrOffset];
        voice.brrOffset++;
      }
    }
//this.regs[0x4c] = 0;
    // ---- エコー(残響) --------------------------------------------------
    const [echoOutL, echoOutR] = this._echoStep(eMixL, eMixR);

    // ---- ミックス --------------------------------------------------------
    // 実機: out = clamp16( (dry * MVOL >> 7) + (echo * EVOL >> 7) )。
    // 最終値は 16bit(±32768)なので、/32768 で ±1.0 に正規化し、余裕(HEADROOM)で割る。
    let dl = ((mixL * this.mvolL) >> 7) + ((echoOutL * this.evolL) >> 7);
    let dr = ((mixR * this.mvolR) >> 7) + ((echoOutR * this.evolR) >> 7);
    if (dl > 32767) dl = 32767; else if (dl < -32768) dl = -32768;
    if (dr > 32767) dr = 32767; else if (dr < -32768) dr = -32768;
    let outL = dl / (32768 * OUTPUT_HEADROOM);
    let outR = dr / (32768 * OUTPUT_HEADROOM);

    // FLG bit6(MUTE): 出力を無音化(内部状態は進め続ける)
    if (this.flg & 0x40) { outL = 0; outR = 0; }

    // ---- 出力の後処理(耳に優しくする) ----------------------------------
    // 1) 穏やかなソフトクリップ: 歪ませずにピークだけ丸める
    outL = softClip(outL);
    outR = softClip(outR);

    // 2) DC除去(ハイパス ~8Hz): 低域のボコボコしたオフセットやポップ音を防ぐ
    {
      const R_DC = 0.99843; // 1 - 2π*8/32000
      const yl = outL - this.dcPrevInL + R_DC * this.dcPrevOutL;
      this.dcPrevInL = outL; this.dcPrevOutL = yl; outL = yl;
      const yr = outR - this.dcPrevInR + R_DC * this.dcPrevOutR;
      this.dcPrevInR = outR; this.dcPrevOutR = yr; outR = yr;
    }

    // 3) 1極ローパス(約 7.5kHz): シャリシャリ/キンキンした高域を穏やかに落とす
    {
      this.lpL += LP_ALPHA * (outL - this.lpL); outL = this.lpL;
      this.lpR += LP_ALPHA * (outR - this.lpR); outR = this.lpR;
    }

    return [outL, outR];
  }

  _triggerKeyOn(voice, i) {
    this.regs[0x7c] &= ~(1 << i); // KEY ON時にENDXビットをクリア
    const dirEntry = this.getSampleDirEntry(this.srcn(i));
    voice.brrAddr = dirEntry.start;
    voice.brrOffset = 16;
    voice.pitchCounter = 0;
    voice.history = [0, 0];
    voice.envLevel = 0;
    // 実機のS-DSPはKEY ON検出後、実際に音を出し始めるまで
    // 数サンプル分の準備期間(BRRプリフェッチ・フィルタ履歴初期化)がある。
    // この間 envMode は 'kon-delay' として無音を維持する。
    voice.envMode = 'kon-delay';
    voice.konDelay = 5;
    voice.keyOff = false;
    voice.endFlag = false;
    voice.loopFlag = false;
    voice.outSample = 0;
  }
}

if (typeof module !== 'undefined') module.exports = { DSP, SDSP_RATE };

// ============================================================================
// SPC再生エンジン
// ============================================================================
const CPU_CYCLES_PER_SAMPLE = 32;

class SPCEngine {
  constructor() {
    this.cpu = new SPC700(null);
    this.dsp = new DSP(this.cpu.ram);
    this.cpu.dsp = this.dsp;
    this.loaded = false;
    this._cycleAccum = 0;
  }

  loadSPC(parsed) {
    const cpu = this.cpu, dsp = this.dsp;

    // ---- CPU レジスタ / RAM ----
    cpu.ram.set(parsed.ram);
    cpu.A = parsed.a & 0xff;
    cpu.X = parsed.x & 0xff;
    cpu.Y = parsed.y & 0xff;
    cpu.SP = parsed.sp & 0xff;
    cpu.PC = parsed.pc & 0xffff;
    cpu.setPSW(parsed.psw);
    cpu.cycles = 0;

    // ---- I/O レジスタの復元 ----
    // cpu.write() は「$F1 のポートクリア」などの副作用を起こすので使わず、状態を直接復元する。
    const f1 = parsed.ram[0xf1];
    cpu.romEnable = (f1 & 0x80) !== 0;              // ブートROMの可視/不可視
    for (let t = 0; t < 3; t++) {
      cpu.timerEnable[t] = (f1 >> t) & 1;
      cpu.timerTarget[t] = parsed.ram[0xfa + t];    // 生の値(0 は 256 分周)
      cpu.timerCounter[t] = 0;
      cpu.timerOut[t] = 0;
      cpu._tAccum[t] = 0;
    }
    for (let i = 0; i < 4; i++) {
      cpu.ioIn[i] = parsed.ram[0xf4 + i];           // 65816 → SPC 方向の値
      cpu.ioOut[i] = parsed.ram[0xf4 + i];          // SPC → 65816 方向の値
    }
    dsp.regAddr = parsed.ram[0xf2];                 // $F2 (DSPアドレス) も復元

    // ---- DSP レジスタ ----
    dsp.reset();
    dsp.regs.set(parsed.dspRegs);
    dsp.regs[0x7c] = parsed.dspRegs[0x7c];           // ENDX はそのまま保持

    // ボイスの現在状態の復元:
    //  * KON は「過去の書き込み値」であって新規のキーオンではないので、再トリガーしない。
    //    (_konLatched を立てて、KON が一度 0 になるまで無視する)
    //  * SPC ファイルにはボイスの内部位置が保存されていないので、
    //    ENVX($x8) が非0 のボイスは「発音中」とみなして、envLevel を復元し
    //    サスティン状態から続ける。KOFF が立っていればリリース。
    const konSnapshot = parsed.dspRegs[0x4c];
    for (let i = 0; i < 8; i++) {
      const v = dsp.voices[i];
      v._konLatched = ((konSnapshot >> i) & 1) === 1;
      const envx = parsed.dspRegs[i * 0x10 + 0x08];
      if (envx > 0) {
        v.envLevel = Math.min(2047, envx << 4);
        v.envMode = 'sustain';
        // BRR の位置は不明なので、サンプルの先頭から続ける。
        // 最初のブロックをここで明示的にデコードし、補間履歴を先頭サンプルで初期化する
        // (デコードしないと decodedBlock が空のまま読まれて無音になる)。
        const dirEntry = dsp.getSampleDirEntry(dsp.srcn(i));
        v.brrAddr = dirEntry.start;
        v.pitchCounter = 0;
        v.history = [0, 0];
        v.endFlag = false;
        v.loopFlag = false;
        dsp.decodeBrrBlock(v, v.brrAddr, i);
        dsp.regs[0x7c] = parsed.dspRegs[0x7c];        // decode が ENDX を触るので元へ戻す
        v.interp[0] = 0; v.interp[1] = 0; v.interp[2] = 0;
        v.interp[3] = v.decodedBlock[0];
        v.brrOffset = 1;
      }
    }

    this.loaded = true;
    this._cycleAccum = 0;
  }

  renderSample() {
    if (!this.loaded) return [0, 0];

    let budget = CPU_CYCLES_PER_SAMPLE + this._cycleAccum;
    let guard = 0;
    while (budget > 0 && guard < 64) {
      const used = this.cpu.step();
      budget -= used;
      guard++;
    }
    this._cycleAccum = budget;

    return this.dsp.generateSample();
  }

  renderBlock(outL, outR, numSamples) {
    for (let i = 0; i < numSamples; i++) {
      const [l, r] = this.renderSample();
      outL[i] = l;
      outR[i] = r;
    }
  }
}

// ============================================================================
// SPCPlayer: メインスレッド対応 Player クラス (ScriptProcessorNode 使用)
// ============================================================================
const SDSP_SAMPLE_RATE = 32000;

class SPCPlayer {
  // audioCtx : 既存のAudioContext(省略時は内部で作成)
  // destination : 出力先ノード(省略時は audioCtx.destination)。
  //   index.html の gainNode を渡すと、音量スライダーが効くようになる。
  constructor(audioCtx, destination) {
    this.audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    this.destination = destination || this.audioCtx.destination;
    this.engine = new SPCEngine();
    this.playing = false;

    this.resampleRatio = SDSP_SAMPLE_RATE / this.audioCtx.sampleRate;
    this.srcPos = 0;

    // 3次補間(Catmull-Rom)用に、DSP出力の直近4サンプル(古→新)を保持
    this.hL = new Float64Array(4);
    this.hR = new Float64Array(4);
    this.haveSample = false;

    // 再生開始/停止時のフェード(プチッというクリック音の防止)
    this.fade = 0;             // 現在のフェードゲイン 0..1
    this.fadeTarget = 0;       // 目標
    this.fadeStep = 1 / (this.audioCtx.sampleRate * 0.05); // 約50msでフェード

    // ボイス情報コールバック。オーディオ処理の外(描画タイミング)で呼ぶ。
    this.onVoiceInfo = null;
    this._voiceTimer = null;

    // ScriptProcessorNode (8192: 少し大きめにして、処理落ちによるプチプチを防ぐ)
    this.scriptNode = this.audioCtx.createScriptProcessor(8192, 0, 2);
    this.scriptNode.onaudioprocess = (e) => this._process(e);
    this._connected = false;
  }

  load(parsed) {
    this.engine.loadSPC(parsed);
    this.srcPos = 0;
    this.haveSample = false;
    this.hL.fill(0); this.hR.fill(0);
    this.fade = 0;
  }

  play() {
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    if (!this._connected) {
      this.scriptNode.connect(this.destination);
      this._connected = true;
    }
    this.playing = true;
    this.fadeTarget = 1;
    this._startVoiceTimer();
  }

  stop() {
    // すぐ切らずにフェードアウトしてから停止する
    this.fadeTarget = 0;
    this._stopVoiceTimer();
    setTimeout(() => {
      if (this.fadeTarget === 0) {
        this.playing = false;
        if (this._connected) {
          try { this.scriptNode.disconnect(); } catch (e) {}
          this._connected = false;
        }
      }
    }, 80);
  }

  // ボイス情報は ~30fps でメインスレッド側から取得(オーディオコールバック内では呼ばない)
  _startVoiceTimer() {
    if (this._voiceTimer) return;
    this._voiceTimer = setInterval(() => {
      if (typeof this.onVoiceInfo === 'function' && this.engine.loaded) {
        this.onVoiceInfo(this._getVoiceInfo());
      }
    }, 33);
  }
  _stopVoiceTimer() {
    if (this._voiceTimer) { clearInterval(this._voiceTimer); this._voiceTimer = null; }
  }

  _advanceDspSample() {
    const hL = this.hL, hR = this.hR;
    hL[0] = hL[1]; hL[1] = hL[2]; hL[2] = hL[3];
    hR[0] = hR[1]; hR[1] = hR[2]; hR[2] = hR[3];
    const [l, r] = this.engine.renderSample();
    hL[3] = l; hR[3] = r;
  }

  _getVoiceInfo() {
    const dsp = this.engine.dsp;
    const voices = [];
    for (let i = 0; i < 8; i++) {
      const voice = dsp.voices[i];
      voices.push({
        voice: i + 1,
        volumeL: dsp.volL(i),
        volumeR: dsp.volR(i),
        pitch: dsp.pitch(i),
        envelope: voice.envLevel,
        active: voice.envMode !== "off"
      });
    }
    return voices;
  }

  // Catmull-Rom 3次補間: y0,y1,y2,y3 のうち y1-y2 の間を t(0..1) で補間
  static _cubic(y0, y1, y2, y3, t) {
    const a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    const b =        y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    const c = -0.5 * y0            + 0.5 * y2;
    return ((a * t + b) * t + c) * t + y1;
  }

  _process(e) {
    const output = e.outputBuffer;
    const left = output.getChannelData(0);
    const right = output.getChannelData(1);
    const n = left.length;

    if (!this.playing || !this.engine.loaded) {
      left.fill(0);
      right.fill(0);
      return;
    }

    if (!this.haveSample) {
      for (let k = 0; k < 4; k++) this._advanceDspSample();
      this.haveSample = true;
    }

    const hL = this.hL, hR = this.hR;
    const ratio = this.resampleRatio;
    let fade = this.fade;
    const fadeTarget = this.fadeTarget, fadeStep = this.fadeStep;

    for (let i = 0; i < n; i++) {
      while (this.srcPos >= 1) {
        this._advanceDspSample();
        this.srcPos -= 1;
      }
      const t = this.srcPos;
      // hL[1]-hL[2] の間を補間(hL[0],hL[3] は両隣)
      let l = SPCPlayer._cubic(hL[0], hL[1], hL[2], hL[3], t);
      let r = SPCPlayer._cubic(hR[0], hR[1], hR[2], hR[3], t);

      // フェード(イン/アウト)
      if (fade < fadeTarget) { fade = Math.min(fadeTarget, fade + fadeStep); }
      else if (fade > fadeTarget) { fade = Math.max(fadeTarget, fade - fadeStep); }
      // 滑らかな曲線(コサイン)でゲインを掛ける
      const g = 0.5 - 0.5 * Math.cos(Math.PI * fade);
      left[i] = l * g;
      right[i] = r * g;

      this.srcPos += ratio;
    }
    this.fade = fade;
  }
}

// ----------------------------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------------------------
function pitchToNote(pitch) {
    if (!pitch) return "-";
    const freq = 32000 * pitch / 4096;
    if (!isFinite(freq) || freq <= 0) return "-";

    const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    const octave = Math.floor(midi / 12) - 1;
    const name = noteNames[((midi % 12) + 12) % 12];

    return `${name}${octave}`;
}