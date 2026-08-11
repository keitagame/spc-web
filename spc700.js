// ============================================================================
// SPC700 CPU Emulator
// SNES(SFC)の音源プロセッサ SPC700 のエミュレータ。
// 64KB RAM, 8bit A/X/Y レジスタ, 16bit SP/PC, PSWフラグを持つ。
// DSPレジスタへのアクセスは 0x00F2/0x00F3 経由で行う。
// ============================================================================

class SPC700 {
  constructor(dsp) {
    this.dsp = dsp; // DSPインスタンス（音源合成担当）
    this.ram = new Uint8Array(0x10000);

    // レジスタ
    this.A = 0;
    this.X = 0;
    this.Y = 0;
    this.SP = 0;
    this.PC = 0;

    // PSW (Program Status Word) フラグ
    this.flagN = 0; // Negative
    this.flagV = 0; // Overflow
    this.flagP = 0; // Direct Page (0 or 1 -> DP base 0x00 or 0x100)
    this.flagB = 0; // Break
    this.flagH = 0; // Half carry
    this.flagI = 0; // Interrupt enable (SPC700では使用されない事が多い)
    this.flagZ = 0; // Zero
    this.flagC = 0; // Carry

    // I/O ポート $F4-$F7 (CPU<->DSP/メインCPU通信用。ここでは自己ループのみ実装)
    this.ioPortIn = new Uint8Array(4);  // メインCPUから見た入力（今回は使わない）
    this.ioPortOut = new Uint8Array(4); // SPC700から見た出力

    // タイマー (0,1,2)
    this.timerEnable = [0, 0, 0];
    this.timerTarget = [0, 0, 0];
    this.timerCounter = [0, 0, 0]; // 内部分周カウンタ
    this.timerOut = [0, 0, 0];     // 読み出し用4bitカウンタ

    this.cycles = 0; // 実行済みサイクル数（タイミング管理用）

    this._buildOpTable();
  }

  // -------------------------------------------------------------------
  // メモリアクセス（I/Oレジスタのマッピングを含む）
  // -------------------------------------------------------------------
  read(addr) {
    addr &= 0xffff;
    switch (addr) {
      case 0xf2: return this.dsp.regAddr;
      case 0xf3: return this.dsp.read(this.dsp.regAddr);
      case 0xf4: case 0xf5: case 0xf6: case 0xf7:
        return this.ioPortIn[addr - 0xf4];
      case 0xfd: return this.readTimerOut(0);
      case 0xfe: return this.readTimerOut(1);
      case 0xff: return this.readTimerOut(2);
      default:
        return this.ram[addr];
    }
  }

  write(addr, val) {
    addr &= 0xffff;
    val &= 0xff;
    switch (addr) {
      case 0xf1: // CONTROL
        if (val & 0x10) { this.ioPortIn[0] = 0; this.ioPortIn[1] = 0; }
        if (val & 0x20) { this.ioPortIn[2] = 0; this.ioPortIn[3] = 0; }
        for (let t = 0; t < 3; t++) {
          const en = (val >> t) & 1;
          if (en && !this.timerEnable[t]) {
            this.timerCounter[t] = 0;
            this.timerOut[t] = 0;
          }
          this.timerEnable[t] = en;
        }
        this.ram[addr] = val;
        break;
      case 0xf2:
        this.dsp.regAddr = val;
        this.ram[addr] = val;
        break;
      case 0xf3:
        this.dsp.write(this.dsp.regAddr, val);
        this.ram[addr] = val;
        break;
      case 0xf4: case 0xf5: case 0xf6: case 0xf7:
        this.ioPortOut[addr - 0xf4] = val;
        this.ram[addr] = val;
        break;
      case 0xfa: this.timerTarget[0] = val === 0 ? 256 : val; this.ram[addr] = val; break;
      case 0xfb: this.timerTarget[1] = val === 0 ? 256 : val; this.ram[addr] = val; break;
      case 0xfc: this.timerTarget[2] = val === 0 ? 256 : val; this.ram[addr] = val; break;
      default:
        this.ram[addr] = val;
    }
  }

  readTimerOut(t) {
    const v = this.timerOut[t] & 0x0f;
    this.timerOut[t] = 0;
    return v;
  }

  // タイマー更新: SPC700の1マシンサイクル毎に呼ばれる想定（クロックは約1.024MHz、
  // タイマ0/1は8kHz分周=128サイクル毎、タイマ2は64kHz分周=16サイクル毎）
  tickTimers(cyc) {
    // Timer 0,1: 8000Hz (period 128 cycles at ~1.024MHz)
    // Timer 2: 64000Hz (period 16 cycles)
    this._tAccum = this._tAccum || [0, 0, 0];
    const periods = [128, 128, 16];
    for (let t = 0; t < 3; t++) {
      if (!this.timerEnable[t]) continue;
      this._tAccum[t] += cyc;
      while (this._tAccum[t] >= periods[t]) {
        this._tAccum[t] -= periods[t];
        this.timerCounter[t]++;
        if (this.timerCounter[t] >= this.timerTarget[t]) {
          this.timerCounter[t] = 0;
          this.timerOut[t] = (this.timerOut[t] + 1) & 0x0f;
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // PSW <-> 8bit変換
  // -------------------------------------------------------------------
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
  setNZ16(v) {
    v &= 0xffff;
    this.flagZ = v === 0 ? 1 : 0;
    this.flagN = (v & 0x8000) ? 1 : 0;
    return v;
  }

  push8(v) { this.ram[0x100 + this.SP] = v & 0xff; this.SP = (this.SP - 1) & 0xff; }
  pop8() { this.SP = (this.SP + 1) & 0xff; return this.ram[0x100 + this.SP]; }
  push16(v) { this.push8((v >> 8) & 0xff); this.push8(v & 0xff); }
  pop16() { const lo = this.pop8(); const hi = this.pop8(); return (hi << 8) | lo; }

  fetch8() { const v = this.read(this.PC); this.PC = (this.PC + 1) & 0xffff; return v; }
  fetch16() { const lo = this.fetch8(); const hi = this.fetch8(); return (hi << 8) | lo; }

  // -------------------------------------------------------------------
  // アドレッシングモード ヘルパー
  // -------------------------------------------------------------------
  dp(off) { return (this.dpBase() + off) & 0xffff; }

  // -------------------------------------------------------------------
  // 加算/減算ロジック
  // -------------------------------------------------------------------
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

  // -------------------------------------------------------------------
  // 1命令実行。実行したサイクル数を返す。
  // -------------------------------------------------------------------
  step() {
    const startPC = this.PC;
    const op = this.fetch8();
    const cyc = this._exec(op);
    this.cycles += cyc;
    this.tickTimers(cyc);
    return cyc;
  }

  _exec(op) {
    const fn = this.opTable[op];
    if (!fn) {
      // 未定義命令は NOP 相当として扱う（安全のため）
      return 2;
    }
    return fn.call(this);
  }

  _branch(cond, disp) {
    // dispは符号付き8bit
    if (cond) {
      const s = disp & 0x80 ? disp - 256 : disp;
      this.PC = (this.PC + s) & 0xffff;
      return 2;
    }
    return 0;
  }

  // =====================================================================
  // オペコードテーブル構築
  // =====================================================================
  _buildOpTable() {
    const T = new Array(256).fill(null);
    const self = this;

    // --- MOV系ヘルパー ---
    const rd = (addr) => this.read(addr);
    const wr = (addr, v) => this.write(addr, v);

    // 1byte NOP
    T[0x00] = function () { return 2; }; // NOP

    // MOV A,#imm
    T[0xE8] = function () { const v = this.fetch8(); this.A = this.setNZ8(v); return 2; };
    // MOV X,#imm
    T[0xCD] = function () { const v = this.fetch8(); this.X = this.setNZ8(v); return 2; };
    // MOV Y,#imm
    T[0x8D] = function () { const v = this.fetch8(); this.Y = this.setNZ8(v); return 2; };

    // MOV A,X / MOV A,Y / MOV X,A / MOV Y,A / MOV X,SP / MOV SP,X
    T[0x7D] = function () { this.A = this.setNZ8(this.X); return 2; }; // MOV A,X
    T[0xDD] = function () { this.A = this.setNZ8(this.Y); return 2; }; // MOV A,Y
    T[0x5D] = function () { this.X = this.setNZ8(this.A); return 2; }; // MOV X,A
    T[0xFD] = function () { this.Y = this.setNZ8(this.A); return 2; }; // MOV Y,A
    T[0x9D] = function () { this.X = this.setNZ8(this.SP); return 2; }; // MOV X,SP
    T[0xBD] = function () { this.SP = this.X; return 2; }; // MOV SP,X (flags not affected)

    // MOV dp,A / MOV A,dp
    T[0xC4] = function () { const a = this.dp(this.fetch8()); wr(a, this.A); return 4; };
    T[0xE4] = function () { const a = this.dp(this.fetch8()); this.A = this.setNZ8(rd(a)); return 3; };
    // MOV dp,X / MOV X,dp
    T[0xD8] = function () { const a = this.dp(this.fetch8()); wr(a, this.X); return 4; };
    T[0xF8] = function () { const a = this.dp(this.fetch8()); this.X = this.setNZ8(rd(a)); return 3; };
    // MOV dp,Y / MOV Y,dp
    T[0xCB] = function () { const a = this.dp(this.fetch8()); wr(a, this.Y); return 4; };
    T[0xEB] = function () { const a = this.dp(this.fetch8()); this.Y = this.setNZ8(rd(a)); return 3; };

    // MOV dp+X,A / MOV A,dp+X
    T[0xD4] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); wr(a, this.A); return 5; };
    T[0xF4] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); this.A = this.setNZ8(rd(a)); return 4; };
    // MOV dp+Y,X
    T[0xD9] = function () { const a = this.dp((this.fetch8() + this.Y) & 0xff); wr(a, this.X); return 5; };
    T[0xF9] = function () { const a = this.dp((this.fetch8() + this.Y) & 0xff); this.X = this.setNZ8(rd(a)); return 4; };
    // MOV dp+X,Y
    T[0xDB] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); wr(a, this.Y); return 5; };
    T[0xFB] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); this.Y = this.setNZ8(rd(a)); return 4; };

    // MOV !abs,A / MOV A,!abs
    T[0xC5] = function () { const a = this.fetch16(); wr(a, this.A); return 5; };
    T[0xE5] = function () { const a = this.fetch16(); this.A = this.setNZ8(rd(a)); return 4; };
    // MOV !abs,X / MOV X,!abs
    T[0xC9] = function () { const a = this.fetch16(); wr(a, this.X); return 5; };
    T[0xE9] = function () { const a = this.fetch16(); this.X = this.setNZ8(rd(a)); return 4; };
    // MOV !abs,Y / MOV Y,!abs
    T[0xCC] = function () { const a = this.fetch16(); wr(a, this.Y); return 5; };
    T[0xEC] = function () { const a = this.fetch16(); this.Y = this.setNZ8(rd(a)); return 4; };

    // MOV !abs+X,A / MOV !abs+Y,A / MOV A,!abs+X / MOV A,!abs+Y
    T[0xD5] = function () { const a = (this.fetch16() + this.X) & 0xffff; wr(a, this.A); return 6; };
    T[0xD6] = function () { const a = (this.fetch16() + this.Y) & 0xffff; wr(a, this.A); return 6; };
    T[0xF5] = function () { const a = (this.fetch16() + this.X) & 0xffff; this.A = this.setNZ8(rd(a)); return 5; };
    T[0xF6] = function () { const a = (this.fetch16() + this.Y) & 0xffff; this.A = this.setNZ8(rd(a)); return 5; };

    // MOV (X),A / MOV A,(X) / MOV (X)+,A / MOV A,(X)+
    T[0xC6] = function () { wr(this.dp(this.X), this.A); return 4; };
    T[0xE6] = function () { this.A = this.setNZ8(rd(this.dp(this.X))); return 3; };
    T[0xAF] = function () { wr(this.dp(this.X), this.A); this.X = (this.X + 1) & 0xff; return 4; }; // MOV (X)+,A
    T[0xBF] = function () { this.A = this.setNZ8(rd(this.dp(this.X))); this.X = (this.X + 1) & 0xff; return 4; }; // MOV A,(X)+

    // MOV [dp+X],A / MOV A,[dp+X]  (indexed indirect)
    T[0xC7] = function () {
      const ptr = this.dp((this.fetch8() + this.X) & 0xff);
      const a = rd(ptr) | (rd((ptr + 1) & 0xffff) << 8);
      wr(a, this.A); return 7;
    };
    T[0xE7] = function () {
      const ptr = this.dp((this.fetch8() + this.X) & 0xff);
      const a = rd(ptr) | (rd((ptr + 1) & 0xffff) << 8);
      this.A = this.setNZ8(rd(a)); return 6;
    };
    // MOV [dp]+Y,A / MOV A,[dp]+Y (indirect indexed)
    T[0xD7] = function () {
      const ptr = this.dp(this.fetch8());
      const base = rd(ptr) | (rd((ptr + 1) & 0xffff) << 8);
      const a = (base + this.Y) & 0xffff;
      wr(a, this.A); return 7;
    };
    T[0xF7] = function () {
      const ptr = this.dp(this.fetch8());
      const base = rd(ptr) | (rd((ptr + 1) & 0xffff) << 8);
      const a = (base + this.Y) & 0xffff;
      this.A = this.setNZ8(rd(a)); return 6;
    };

    // MOV dp,dp (dp destination, dp source) -- opcode FA: MOV dp,dp
    T[0xFA] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, rd(src)); return 5; };
    // MOV dp,#imm  -- opcode 8F: MOV dp,#imm
    T[0x8F] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, v); return 5; };

    // MOV SP<->X handled above. MOV A,SP / MOV SP,A not standard on SPC700 (only X<->SP).

    // MOVW YA,dp / MOVW dp,YA
    T[0xBA] = function () {
      const a = this.dp(this.fetch8());
      const lo = rd(a); const hi = rd((a + 1) & 0xffff);
      this.A = lo; this.Y = hi;
      const w = (hi << 8) | lo;
      this.flagZ = w === 0 ? 1 : 0;
      this.flagN = (hi & 0x80) ? 1 : 0;
      return 5;
    };
    T[0xDA] = function () {
      const a = this.dp(this.fetch8());
      wr(a, this.A); wr((a + 1) & 0xffff, this.Y);
      return 5;
    };
    // MOVW YA,X-like doesn't exist; INCW/DECW dp
    T[0x3A] = function () { // INCW dp
      const a = this.dp(this.fetch8());
      let w = (rd(a) | (rd((a + 1) & 0xffff) << 8));
      w = (w + 1) & 0xffff;
      wr(a, w & 0xff); wr((a + 1) & 0xffff, (w >> 8) & 0xff);
      this.flagZ = w === 0 ? 1 : 0; this.flagN = (w & 0x8000) ? 1 : 0;
      return 6;
    };
    T[0x1A] = function () { // DECW dp
      const a = this.dp(this.fetch8());
      let w = (rd(a) | (rd((a + 1) & 0xffff) << 8));
      w = (w - 1) & 0xffff;
      wr(a, w & 0xff); wr((a + 1) & 0xffff, (w >> 8) & 0xff);
      this.flagZ = w === 0 ? 1 : 0; this.flagN = (w & 0x8000) ? 1 : 0;
      return 6;
    };
    // ADDW YA,dp / SUBW YA,dp / CMPW YA,dp
    T[0x7A] = function () {
      const a = this.dp(this.fetch8());
      const ya = (this.Y << 8) | this.A;
      const m = (rd(a) | (rd((a + 1) & 0xffff) << 8));
      const result = ya + m;
      this.flagC = result > 0xffff ? 1 : 0;
      const r16 = result & 0xffff;
      this.flagV = (~(ya ^ m) & (ya ^ r16) & 0x8000) ? 1 : 0;
      this.flagH = (((ya & 0xfff) + (m & 0xfff)) > 0xfff) ? 1 : 0;
      this.Y = (r16 >> 8) & 0xff; this.A = r16 & 0xff;
      this.flagZ = r16 === 0 ? 1 : 0; this.flagN = (r16 & 0x8000) ? 1 : 0;
      return 5;
    };
    T[0x9A] = function () {
      const a = this.dp(this.fetch8());
      const ya = (this.Y << 8) | this.A;
      const m = (rd(a) | (rd((a + 1) & 0xffff) << 8));
      const mInv = (~m) & 0xffff;
      const result = ya + mInv + 1;
      this.flagC = result > 0xffff ? 1 : 0;
      const r16 = result & 0xffff;
      this.flagV = (~(ya ^ mInv) & (ya ^ r16) & 0x8000) ? 1 : 0;
      this.flagH = (((ya & 0xfff) + (mInv & 0xfff) + 1) > 0xfff) ? 1 : 0;
      this.Y = (r16 >> 8) & 0xff; this.A = r16 & 0xff;
      this.flagZ = r16 === 0 ? 1 : 0; this.flagN = (r16 & 0x8000) ? 1 : 0;
      return 5;
    };
    T[0x5A] = function () {
      const a = this.dp(this.fetch8());
      const ya = (this.Y << 8) | this.A;
      const m = (rd(a) | (rd((a + 1) & 0xffff) << 8));
      const result = (ya - m) & 0xffff;
      this.flagC = ya >= m ? 1 : 0;
      this.flagZ = result === 0 ? 1 : 0;
      this.flagN = (result & 0x8000) ? 1 : 0;
      return 4;
    };

    // --- ALU: OR/AND/EOR/CMP/ADC/SBC 各アドレッシング ---
    const aluGroup = (name, opFn) => {
      // opFn(a,b) => 演算結果を返し、フラグはopFn内かここで処理
    };

    // 汎用: A op= (value) の形の命令群を生成
    const makeAluA = (baseOp, exec) => {
      // exec(this,b) -> 何もしない。各命令個別定義の方が明快なので下記で直接記述。
    };

    // OR A,#imm / AND / EOR / CMP / ADC / SBC の imm 系
    T[0x08] = function () { const v = this.fetch8(); this.A = this.setNZ8(this.A | v); return 2; }; // OR A,#imm
    T[0x28] = function () { const v = this.fetch8(); this.A = this.setNZ8(this.A & v); return 2; }; // AND A,#imm
    T[0x48] = function () { const v = this.fetch8(); this.A = this.setNZ8(this.A ^ v); return 2; }; // EOR A,#imm
    T[0x68] = function () { const v = this.fetch8(); const r = (this.A - v) & 0x1ff; this.flagC = this.A >= v ? 1 : 0; this.setNZ8(r); return 2; }; // CMP A,#imm
    T[0x88] = function () { const v = this.fetch8(); this.A = this.adc(this.A, v, this.flagC); return 2; }; // ADC A,#imm
    T[0xA8] = function () { const v = this.fetch8(); this.A = this.sbc(this.A, v, this.flagC); return 2; }; // SBC A,#imm

    // dp
    T[0x04] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.setNZ8(this.A | v); return 3; };
    T[0x24] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.setNZ8(this.A & v); return 3; };
    T[0x44] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.setNZ8(this.A ^ v); return 3; };
    T[0x64] = function () { const v = rd(this.dp(this.fetch8())); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 3; };
    T[0x84] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.adc(this.A, v, this.flagC); return 3; };
    T[0xA4] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.sbc(this.A, v, this.flagC); return 3; };

    // dp+X
    T[0x14] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.setNZ8(this.A | v); return 4; };
    T[0x34] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.setNZ8(this.A & v); return 4; };
    T[0x54] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.setNZ8(this.A ^ v); return 4; };
    T[0x74] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 4; };
    T[0x94] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.adc(this.A, v, this.flagC); return 4; };
    T[0xB4] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.sbc(this.A, v, this.flagC); return 4; };

    // !abs
    T[0x05] = function () { const v = rd(this.fetch16()); this.A = this.setNZ8(this.A | v); return 4; };
    T[0x25] = function () { const v = rd(this.fetch16()); this.A = this.setNZ8(this.A & v); return 4; };
    T[0x45] = function () { const v = rd(this.fetch16()); this.A = this.setNZ8(this.A ^ v); return 4; };
    T[0x65] = function () { const v = rd(this.fetch16()); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 4; };
    T[0x85] = function () { const v = rd(this.fetch16()); this.A = this.adc(this.A, v, this.flagC); return 4; };
    T[0xA5] = function () { const v = rd(this.fetch16()); this.A = this.sbc(this.A, v, this.flagC); return 4; };

    // !abs+X / !abs+Y
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

    // (X) / (X)+ / [dp+X] / [dp]+Y
    T[0x06] = function () { const v = rd(this.dp(this.X)); this.A = this.setNZ8(this.A | v); return 3; };
    T[0x26] = function () { const v = rd(this.dp(this.X)); this.A = this.setNZ8(this.A & v); return 3; };
    T[0x46] = function () { const v = rd(this.dp(this.X)); this.A = this.setNZ8(this.A ^ v); return 3; };
    T[0x66] = function () { const v = rd(this.dp(this.X)); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 3; };
    T[0x86] = function () { const v = rd(this.dp(this.X)); this.A = this.adc(this.A, v, this.flagC); return 3; };
    T[0xA6] = function () { const v = rd(this.dp(this.X)); this.A = this.sbc(this.A, v, this.flagC); return 3; };

    T[0x07] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd(a); this.A = this.setNZ8(this.A | v); return 6; };
    T[0x27] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd(a); this.A = this.setNZ8(this.A & v); return 6; };
    T[0x47] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd(a); this.A = this.setNZ8(this.A ^ v); return 6; };
    T[0x67] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd(a); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 6; };
    T[0x87] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd(a); this.A = this.adc(this.A, v, this.flagC); return 6; };
    T[0xA7] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd(a); this.A = this.sbc(this.A, v, this.flagC); return 6; };

    T[0x17] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd((base+this.Y)&0xffff); this.A = this.setNZ8(this.A | v); return 6; };
    T[0x37] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd((base+this.Y)&0xffff); this.A = this.setNZ8(this.A & v); return 6; };
    T[0x57] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd((base+this.Y)&0xffff); this.A = this.setNZ8(this.A ^ v); return 6; };
    T[0x77] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd((base+this.Y)&0xffff); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 6; };
    T[0x97] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd((base+this.Y)&0xffff); this.A = this.adc(this.A, v, this.flagC); return 6; };
    T[0xB7] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd((base+this.Y)&0xffff); this.A = this.sbc(this.A, v, this.flagC); return 6; };

    // dp,dp / dp,#imm (メモリ間演算) OR/AND/EOR/CMP/ADC/SBC
    // opcode形式: 0x_9 = dp,dp ; 0x_8 = dp,#imm （ADC/SBC等では別パターンなので個別実装）
    T[0x09] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.setNZ8(rd(dst) | rd(src))); return 6; }; // OR dp,dp
    T[0x29] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.setNZ8(rd(dst) & rd(src))); return 6; }; // AND dp,dp
    T[0x49] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.setNZ8(rd(dst) ^ rd(src))); return 6; }; // EOR dp,dp
    T[0x69] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); const a=rd(dst), b=rd(src); this.flagC = a>=b?1:0; this.setNZ8((a-b)&0x1ff); return 6; }; // CMP dp,dp
    T[0x89] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.adc(rd(dst), rd(src), this.flagC)); return 6; }; // ADC dp,dp
    T[0xA9] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.sbc(rd(dst), rd(src), this.flagC)); return 6; }; // SBC dp,dp

    T[0x18] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) | v)); return 5; }; // OR dp,#imm
    T[0x38] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) & v)); return 5; }; // AND dp,#imm
    T[0x58] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) ^ v)); return 5; }; // EOR dp,#imm
    T[0x78] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); const m = rd(a); this.flagC = m>=v?1:0; this.setNZ8((m-v)&0x1ff); return 5; }; // CMP dp,#imm
    T[0x98] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.adc(rd(a), v, this.flagC)); return 5; }; // ADC dp,#imm
    T[0xB8] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.sbc(rd(a), v, this.flagC)); return 5; }; // SBC dp,#imm

    // (X),(Y) 間演算: OR/AND/EOR/CMP/ADC/SBC (X),(Y)
    // (X)を宛先、(Y)をソースとしてメモリ同士で演算する
    T[0x19] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.setNZ8(rd(dstA) | rd(srcA))); return 5; }; // OR (X),(Y)
    T[0x39] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.setNZ8(rd(dstA) & rd(srcA))); return 5; }; // AND (X),(Y)
    T[0x59] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.setNZ8(rd(dstA) ^ rd(srcA))); return 5; }; // EOR (X),(Y)
    T[0x79] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); const a=rd(dstA), b=rd(srcA); this.flagC=a>=b?1:0; this.setNZ8((a-b)&0x1ff); return 5; }; // CMP (X),(Y)
    T[0x99] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.adc(rd(dstA), rd(srcA), this.flagC)); return 5; }; // ADC (X),(Y)
    T[0xB9] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.sbc(rd(dstA), rd(srcA), this.flagC)); return 5; }; // SBC (X),(Y)

    // CMP X,#imm / CMP Y,#imm / CMP X,dp / CMP Y,dp / CMP X,!abs / CMP Y,!abs
    T[0xC8] = function () { const v = this.fetch8(); this.flagC = this.X>=v?1:0; this.setNZ8((this.X-v)&0x1ff); return 2; };
    T[0xAD] = function () { const v = this.fetch8(); this.flagC = this.Y>=v?1:0; this.setNZ8((this.Y-v)&0x1ff); return 2; };
    T[0x3E] = function () { const v = rd(this.dp(this.fetch8())); this.flagC = this.X>=v?1:0; this.setNZ8((this.X-v)&0x1ff); return 3; };
    T[0x7E] = function () { const v = rd(this.dp(this.fetch8())); this.flagC = this.Y>=v?1:0; this.setNZ8((this.Y-v)&0x1ff); return 3; };
    T[0x1E] = function () { const v = rd(this.fetch16()); this.flagC = this.X>=v?1:0; this.setNZ8((this.X-v)&0x1ff); return 4; };
    T[0x5E] = function () { const v = rd(this.fetch16()); this.flagC = this.Y>=v?1:0; this.setNZ8((this.Y-v)&0x1ff); return 4; };

    // INC/DEC A,X,Y
    T[0xBC] = function () { this.A = this.setNZ8(this.A + 1); return 2; }; // INC A
    T[0x9C] = function () { this.A = this.setNZ8(this.A - 1); return 2; }; // DEC A
    T[0x3D] = function () { this.X = this.setNZ8(this.X + 1); return 2; }; // INC X
    T[0x1D] = function () { this.X = this.setNZ8(this.X - 1); return 2; }; // DEC X
    T[0xFC] = function () { this.Y = this.setNZ8(this.Y + 1); return 2; }; // INC Y
    T[0xDC] = function () { this.Y = this.setNZ8(this.Y - 1); return 2; }; // DEC Y
    // INC/DEC dp, dp+X, !abs
    T[0xAB] = function () { const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) + 1)); return 4; };
    T[0x8B] = function () { const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) - 1)); return 4; };
    T[0xBB] = function () { const a = this.dp((this.fetch8()+this.X)&0xff); wr(a, this.setNZ8(rd(a) + 1)); return 5; };
    T[0x9B] = function () { const a = this.dp((this.fetch8()+this.X)&0xff); wr(a, this.setNZ8(rd(a) - 1)); return 5; };
    T[0xAC] = function () { const a = this.fetch16(); wr(a, this.setNZ8(rd(a) + 1)); return 5; };
    T[0x8C] = function () { const a = this.fetch16(); wr(a, this.setNZ8(rd(a) - 1)); return 5; };

    // ASL/LSR/ROL/ROR A, dp, dp+X, !abs
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

    // XCN A (nibble swap)
    T[0x9F] = function () { this.A = this.setNZ8(((this.A << 4) | (this.A >> 4)) & 0xff); return 5; };

    // MUL YA, DIV YA,X
    T[0xCF] = function () { // MUL YA = Y*A -> YA
      const r = (this.Y & 0xff) * (this.A & 0xff);
      this.A = r & 0xff; this.Y = (r >> 8) & 0xff;
      this.setNZ8(this.Y);
      return 9;
    };
    T[0x9E] = function () { // DIV YA,X
      let ya = (this.Y << 8) | this.A;
      const x = this.X;
      if (x === 0) {
        this.A = 0xff; this.Y = 0xff; // 実機挙動の簡易近似
        this.flagV = 1; this.flagH = 1;
        this.setNZ8(this.A);
        return 12;
      }
      this.flagH = ((this.Y & 0xf) >= (x & 0xf)) ? 1 : 0;
      const quotient = Math.floor(ya / x);
      const remainder = ya % x;
      this.flagV = quotient > 0xff ? 1 : 0;
      this.A = quotient & 0xff;
      this.Y = remainder & 0xff;
      this.setNZ8(this.A);
      return 12;
    };

    // DAA / DAS
    T[0xDF] = function () { // DAA
      let a = this.A;
      if (this.flagC || a > 0x99) { a = (a + 0x60) & 0xff; this.flagC = 1; }
      if (this.flagH || (a & 0x0f) > 9) { a = (a + 0x06) & 0xff; }
      this.A = this.setNZ8(a);
      return 3;
    };
    T[0xBE] = function () { // DAS
      let a = this.A;
      if (!this.flagC || a > 0x99) { a = (a - 0x60) & 0xff; this.flagC = 0; }
      if (!this.flagH || (a & 0x0f) > 9) { a = (a - 0x06) & 0xff; }
      this.A = this.setNZ8(a);
      return 3;
    };

    // CLR/SET carry, flags
    T[0x60] = function () { this.flagC = 0; return 2; }; // CLRC
    T[0x80] = function () { this.flagC = 1; return 2; }; // SETC
    T[0xED] = function () { this.flagC = this.flagC ^ 1; return 3; }; // NOTC
    T[0x20] = function () { this.flagP = 0; return 2; }; // CLRP
    T[0x40] = function () { this.flagP = 1; return 2; }; // SETP
    T[0xE0] = function () { this.flagV = 0; this.flagH = 0; return 2; }; // CLRV
    T[0xA0] = function () { this.flagI = 1; return 3; }; // EI (未使用扱い)
    T[0xC0] = function () { this.flagI = 0; return 3; }; // DI

    // PUSH/POP
    T[0x2D] = function () { this.push8(this.A); return 4; }; // PUSH A
    T[0x4D] = function () { this.push8(this.X); return 4; }; // PUSH X
    T[0x6D] = function () { this.push8(this.Y); return 4; }; // PUSH Y
    T[0x0D] = function () { this.push8(this.getPSW()); return 4; }; // PUSH PSW
    T[0xAE] = function () { this.A = this.pop8(); return 4; }; // POP A
    T[0xCE] = function () { this.X = this.pop8(); return 4; }; // POP X
    T[0xEE] = function () { this.Y = this.pop8(); return 4; }; // POP Y
    T[0x8E] = function () { this.setPSW(this.pop8()); return 4; }; // POP PSW

    // ブランチ命令
    T[0x2F] = function () { const d = this.fetch8(); const s=d&0x80?d-256:d; this.PC=(this.PC+s)&0xffff; return 4; }; // BRA
    T[0xF0] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagZ===1, d); }; // BEQ
    T[0xD0] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagZ===0, d); }; // BNE
    T[0xB0] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagC===1, d); }; // BCS
    T[0x90] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagC===0, d); }; // BCC
    T[0x70] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagV===1, d); }; // BVS
    T[0x50] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagV===0, d); }; // BVC
    T[0x30] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagN===1, d); }; // BMI
    T[0x10] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagN===0, d); }; // BPL

    // BBS/BBC (dp.bit, rel) -- ビットテスト分岐。opcodeの上位3bitがビット番号
    for (let bit = 0; bit < 8; bit++) {
      const opSet = 0x03 | (bit << 5);   // BBS
      const opClr = 0x13 | (bit << 5);   // BBC
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

    // CBNE dp, rel / CBNE dp+X, rel
    T[0x2E] = function () { const a=this.dp(this.fetch8()); const d=this.fetch8(); const v=rd(a); return 5 + this._branch(this.A!==v, d); };
    T[0xDE] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); const d=this.fetch8(); const v=rd(a); return 6 + this._branch(this.A!==v, d); };

    // DBNZ Y / DBNZ dp
    T[0xFE] = function () { const d=this.fetch8(); this.Y=(this.Y-1)&0xff; return 4 + this._branch(this.Y!==0, d); };
    T[0x6E] = function () { const a=this.dp(this.fetch8()); const d=this.fetch8(); let v=rd(a); v=(v-1)&0xff; wr(a,v); return 5 + this._branch(v!==0, d); };

    // JMP !abs / JMP [!abs+X]
    T[0x5F] = function () { this.PC = this.fetch16(); return 3; };
    T[0x1F] = function () { const base = this.fetch16(); const ptr=(base+this.X)&0xffff; this.PC = rd(ptr) | (rd((ptr+1)&0xffff)<<8); return 6; };

    // CALL !abs / PCALL up / TCALL n
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

    // RET / RETI
    T[0x6F] = function () { this.PC = this.pop16(); return 5; };
    T[0x7F] = function () { this.setPSW(this.pop8()); this.PC = this.pop16(); return 6; };

    // BRK
    T[0x0F] = function () {
      this.push16(this.PC);
      this.push8(this.getPSW());
      this.flagB = 1; this.flagI = 0;
      this.PC = rd(0xFFDE) | (rd(0xFFDF) << 8);
      return 8;
    };

    // SLEEP/STOP
    T[0xEF] = function () { this._stopped = true; return 3; };
    T[0xFF] = function () { this._stopped = true; return 3; };

    // MOV1 (1bit転送) C,mem.bit / mem.bit,C
    T[0xAA] = function () { // MOV1 C, mem.bit
      const w = this.fetch16(); const addr = w & 0x1fff; const bit = (w >> 13) & 7;
      const v = rd(addr);
      this.flagC = (v >> bit) & 1;
      return 4;
    };
    T[0xCA] = function () { // MOV1 mem.bit, C
      const w = this.fetch16(); const addr = w & 0x1fff; const bit = (w >> 13) & 7;
      let v = rd(addr);
      if (this.flagC) v |= (1 << bit); else v &= ~(1 << bit);
      wr(addr, v & 0xff);
      return 6;
    };
    // AND1/OR1/EOR1/NOT1 C,mem.bit
    T[0x4A] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; const v=(rd(addr)>>bit)&1; this.flagC = this.flagC & v; return 4; };
    T[0x6A] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; const v=(rd(addr)>>bit)&1; this.flagC = this.flagC & (v^1); return 4; };
    T[0x0A] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; const v=(rd(addr)>>bit)&1; this.flagC = this.flagC | v; return 5; };
    T[0x2A] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; const v=(rd(addr)>>bit)&1; this.flagC = this.flagC | (v^1); return 5; };
    T[0x8A] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; const v=(rd(addr)>>bit)&1; this.flagC = this.flagC ^ v; return 5; };
    T[0xEA] = function () { const a=this.fetch8(); const bit=(this.ram[(this.PC-1)&0xffff]); return 5; }; // 未使用フォールバック(placeholder)

    // NOT1 mem.bit (直接ビット反転)
    T[0xEA] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; let v=rd(addr); v ^= (1<<bit); wr(addr, v&0xff); return 5; };

    // SET1/CLR1 dp.bit (opcode 0x02 + bit<<5 系: SET1, 0x12+bit<<5: CLR1)
    for (let bit = 0; bit < 8; bit++) {
      const opSet = 0x02 | (bit << 5);
      const opClr = 0x12 | (bit << 5);
      T[opSet] = function () { const a=this.dp(this.fetch8()); let v=rd(a); v |= (1<<bit); wr(a, v&0xff); return 4; };
      T[opClr] = function () { const a=this.dp(this.fetch8()); let v=rd(a); v &= ~(1<<bit); wr(a, v&0xff); return 4; };
    }

    // TSET1/TCLR1 !abs
    T[0x0E] = function () { const a=this.fetch16(); const v=rd(a); this.setNZ8((this.A - v) & 0x1ff); wr(a, v | this.A); return 6; }; // TSET1
    T[0x4E] = function () { const a=this.fetch16(); const v=rd(a); this.setNZ8((this.A - v) & 0x1ff); wr(a, v & (~this.A & 0xff)); return 6; }; // TCLR1

    // XCN, TCALL済み。 SETP/CLRP 済み

    // MOV X,dp+Y はSPC700に存在しないため省略。MOV dp,X系は既出。

    T.subroutineMarker = true;
    this.opTable = T;
  }
}

if (typeof module !== 'undefined') module.exports = { SPC700 };
