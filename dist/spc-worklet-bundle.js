// SPC Player - Combined AudioWorklet Bundle
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
    const op = this.fetch8();
    const cyc = this._exec(op);
    this.cycles += cyc;
    this.tickTimers(cyc);
    return cyc;
  }

  _exec(op) {
   
    const fn = this.opTable[op];

    if (!fn) {
        console.error(
            "UNKNOWN OPCODE",
            op.toString(16).padStart(2, "0")
        );
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
// 各レートに対応する「オフセット」テーブル(実機のグローバルタイマーは32768カウンタを
// 継続的にデクリメントしており、各レートは固有の位相でトリガする)。
// この位相込みの判定により、複数ボイスが同時刻に一斉発火してエンベロープが
// 不自然に揃う(実機と異なるビート感が出る)問題を避ける。
const COUNTER_OFFSETS = [
  0, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040,
  536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040,
  536, 0, 1040, 0, 536, 0, 1040, 0
];

// Gaussian補間用テーブル(実機のGAUSSテーブル、512エントリ)
// S-DSPは4点(過去2点+現在2点)のガウス窓補間でBRRサンプル間を補間する。
// 実機のROM内テーブルは非対称(前後で異なるカーブ)であり、
// pitchCounterの上位8bitをインデックスとして使う。
// 値は公開されている実機吸い出しテーブル(bsnes/snes9x等で使用されるもの)と同一。
const GAUSS_TABLE = new Int16Array([
    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    1,
    1,    1,    1,    1,    1,    1,    1,    1,    1,    1,    1,    1,    2,    2,    2,    2,
    2,    2,    2,    2,    3,    3,    3,    3,    3,    3,    4,    4,    4,    4,    4,    5,
    5,    5,    5,    6,    6,    6,    6,    7,    7,    7,    8,    8,    8,    9,    9,    9,
   10,   10,   10,   11,   11,   11,   12,   12,   13,   13,   14,   14,   15,   15,   15,   16,
   16,   17,   17,   18,   19,   19,   20,   20,   21,   21,   22,   23,   23,   24,   24,   25,
   26,   27,   27,   28,   29,   29,   30,   31,   32,   32,   33,   34,   35,   36,   36,   37,
   38,   39,   40,   41,   42,   43,   44,   45,   46,   47,   48,   49,   50,   51,   52,   53,
   54,   55,   56,   58,   59,   60,   61,   63,   64,   65,   67,   68,   69,   71,   72,   74,
   75,   76,   78,   79,   81,   82,   84,   85,   87,   89,   90,   92,   94,   95,   97,   99,
  100,  102,  104,  106,  107,  109,  111,  113,  115,  117,  118,  120,  122,  124,  126,  128,
  130,  132,  134,  137,  139,  141,  143,  145,  147,  150,  152,  154,  156,  159,  161,  163,
  166,  168,  171,  173,  175,  178,  180,  183,  186,  188,  191,  193,  196,  199,  201,  204,
  207,  210,  212,  215,  218,  221,  224,  227,  230,  233,  236,  239,  242,  245,  248,  251,
  254,  257,  260,  263,  267,  270,  273,  276,  280,  283,  286,  290,  293,  297,  300,  304,
  307,  311,  314,  318,  321,  325,  328,  332,  336,  339,  343,  347,  351,  354,  358,  362,
  366,  370,  374,  378,  381,  385,  389,  393,  397,  401,  405,  410,  414,  418,  422,  426,
  430,  434,  439,  443,  447,  451,  456,  460,  464,  469,  473,  477,  482,  486,  491,  495,
  499,  504,  508,  513,  517,  522,  526,  531,  535,  540,  544,  549,  553,  558,  562,  567,
  571,  576,  580,  585,  589,  594,  598,  603,  607,  612,  616,  621,  625,  630,  634,  639,
  643,  648,  652,  656,  661,  665,  670,  674,  678,  683,  687,  691,  696,  700,  704,  708,
  713,  717,  721,  725,  729,  732,  736,  740,  744,  748,  752,  756,  759,  763,  767,  770,
  774,  777,  781,  784,  788,  791,  795,  798,  801,  804,  808,  811,  814,  817,  820,  823,
  826,  829,  832,  835,  838,  840,  843,  846,  848,  851,  854,  856,  858,  861,  863,  866,
  868,  870,  872,  874,  876,  878,  880,  882,  884,  886,  888,  890,  891,  893,  895,  896,
  898,  899,  901,  902,  903,  905,  906,  907,  908,  909,  910,  911,  912,  913,  914,  915,
  915,  916,  917,  917,  918,  918,  919,  919,  920,  920,  920,  921,  921,  921,  921,  921,
  922,  922,  922,  922,  922,  921,  921,  921,  921,  921,  920,  920,  920,  919,  919,  918,
  918,  917,  917,  916,  915,  915,  914,  913,  912,  911,  910,  909,  908,  907,  906,  905,
  903,  902,  901,  899,  898,  896,  895,  893,  891,  890,  888,  886,  884,  882,  880,  878,
  876,  874,  872,  870,  868,  866,  863,  861,  858,  856,  854,  851,  848,  846,  843,  840,
  838,  835,  832,  829,  826,  823,  820,  817,  814,  811,  808,  804,  801,  798,  795,  791,
]);

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
        pitchCounter: 0,  // 16bit(うち上位が整数ブロック送り、下位15bitが小数)ピッチアキュムレータ
        // ガウス補間用の4サンプル直近履歴リングバッファ(新しい順ではなく古い→新しい順に更新)
        ring: new Int16Array(4),
        ringPos: 0,
        history: [0, 0],  // BRRデコード用フィルタの過去2サンプル(h1,h2)
        decodedBlock: new Int16Array(16),
        curBlockHeader: 0,
        keyOn: false,
        keyOff: false,
        envMode: 'off', // 'attack' | 'decay' | 'sustain' | 'release' | 'off'
        envLevel: 0,       // 0-2047 (11bit)
        loopFlag: false,
        endFlag: false,
        sampleAddr: 0,     // SRCNから取得した現在のサンプルの先頭アドレス
        outSample: 0,      // 最後に出力したサンプル(エコーFIRの入力用)
        _konLatched: false,
      });
    }

    // エコーバッファ: EDL(0x7D)レジスタの4bit値 × 2048byte を上限として
    // RAM上のリングバッファとして扱う（実機のFIRディレイライン）。
    // ここではリングバッファへの書き込み位置(サンプル単位)のみ管理し、
    // 実データはCPU RAM(ESA起点)へ直接読み書きする。
    this.echoPos = 0;       // エコーバッファ内の現在位置(サンプル単位, 0..echoLenSamples-1)
    this.firHistoryL = new Int16Array(8); // FIR用の直近8サンプル(L)
    this.firHistoryR = new Int16Array(8); // FIR用の直近8サンプル(R)
    this.firPos = 0;

    this.noiseLFSR = 0x4000; // 実機初期値相当(非0であれば良い)
    this._globalCounter = 0;
  }

  reset() {
    this.regs.fill(0);
    this.regAddr = 0;
    for (const v of this.voices) {
      v.pitchCounter = 0;
      v.envLevel = 0;
      v.keyOn = false;
      v.keyOff = false;
      v.envMode = 'off';
      v.history = [0, 0];
      v.ring.fill(0);
      v.ringPos = 0;
      v.brrOffset = 16; // 最初にブロックを読ませる
      v.endFlag = false;
      v.loopFlag = false;
      v._konLatched = false;
    }
    this.echoPos = 0;
    this.firHistoryL.fill(0);
    this.firHistoryR.fill(0);
    this.firPos = 0;
    this.noiseLFSR = 0x4000;
    this._globalCounter = 0;
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
  get esa() { return this.regs[0x6d]; }   // エコー開始アドレス上位byte (実アドレス = esa<<8)
  get edl() { return this.regs[0x7d] & 0x0f; } // エコーディレイ(0-15, 各0で16byte単位=1サンプル分の16byte区切り、実際は0=固定64byte)
  firCoef(tap) { return this._s8(this.regs[tap * 0x10 + 0x0f]); } // FIR係数 c0..c7
  get echoDisabled() { return (this.flg & 0x20) !== 0; }   // FLGのbit5: エコー出力ミュート
  get echoWriteDisabled() { return (this.flg & 0x20) !== 0; } // 実機ではFLGのbit5がエコーバッファ書き込みも止める
  get noiseFreqIdx() { return this.flg & 0x1f; }
  get muteAll() { return (this.flg & 0x40) !== 0; }
  get softReset() { return (this.flg & 0x80) !== 0; }

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

      // range 0-12: 通常どおり nibble << range を1bit分右シフト(>>1)して16bit化。
      // range 13-15: 実機では nibble<<range が正しく機能せず、実機の既知の挙動として
      //   range13: 通常のnibbleそのまま(符号拡張後の値、シフトなし相当)を(-2048/0系ではなく)
      //            nibbleを4bit左シフトしたビット演算がオーバーフローし、常に0扱いになる。
      //   range14,15: nibbleの符号ビット(bit3)に応じて -2048 または 0 に固定される。
      // ここでは実機ハードウェアの既知挙動(BRR range 13-15の特殊クランプ)を再現する。
      let sample;
      if (range <= 12) {
        sample = (nibble << range) >> 1;
      } else if (range === 13) {
        // 実機では12bitシフトレジスタの範囲を超えるため結果は常に0になる
        sample = 0;
      } else {
        // range 14,15: nibbleの符号で-2048/0に飽和(実機のシフタオーバーフロー挙動の近似)
        sample = nibble < 0 ? -2048 : 0;
      }

      // フィルタ適用（BRR標準の4種類、実機の整数演算に忠実な式）
      let pred = 0;
      switch (filter) {
        case 0: pred = 0; break;
        case 1: pred = h1 + ((-h1) >> 4); break;
        case 2: pred = h1 * 2 + ((-(h1 * 3)) >> 5) - h2 + (h2 >> 4); break;
        case 3: pred = h1 * 2 + ((-(h1 * 13)) >> 6) - h2 + ((h2 * 3) >> 4); break;
      }
      let s = sample + pred;
      // 実機は16bit加算後、15bitでクランプ(clip to -0x8000..0x7FFF相当だが実際は
      // 内部的に16bit符号付きにラップしてから最終的に-32768..32767でクランプする)
      // ここでは一般的なエミュレータ実装同様、16bit符号付き範囲へラップしてからクランプする。
      s = ((s << 16) >> 16); // 16bit符号付きにラップ
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

  // ノイズ生成(LFSR)。ノイズ周期(FLGのbit0-4で指定されたレート)が
  // 発火したサンプルでのみLFSRを1ステップ進める。
  // 実機: 15bit LFSR。新しいbit14 = bit0 XOR bit1。右シフトしてbit14に格納。
  stepNoiseLFSR() {
    let lfsr = this.noiseLFSR;
    const newBit = ((lfsr & 1) ^ ((lfsr >> 1) & 1)) & 1;
    lfsr = (lfsr >> 1) | (newBit << 14);
    this.noiseLFSR = lfsr & 0x7fff;
  }

  // 現在のLFSR値を符号付き15bitサンプルとして返す(-0x4000..0x3FFF)
  get noiseSample() {
    let v = this.noiseLFSR & 0x7fff;
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
          } else { // bent line増加: 0x600未満は+32、以降は+8(実機仕様どおり)
            voice.envLevel += (voice.envLevel < 0x600) ? 32 : 8;
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
    // COUNTER_RATESの周期と位相オフセットに基づき、globalカウンタでレート発火判定
    const period = COUNTER_RATES[rateIndex] || 0;
    if (period === 0) return false;
    const offset = COUNTER_OFFSETS[rateIndex] || 0;
    return ((this._globalCounter + offset) % period) === 0;
  }

  // ボイスの4点履歴リングバッファに新しいデコード済みサンプルを1つ積む
  _pushRing(voice, sample) {
    voice.ring[voice.ringPos & 3] = sample;
    voice.ringPos++;
  }

  // ガウス補間: ring[]に積まれた直近4サンプル(古い→新しい)と
  // pitchCounterの上位8bit(小数部)を使い、実機のGAUSS_TABLEで4点補間する。
  // 実機の重み付けは "out = (g[255-frac+off]*s[-3] + g[frac+off... ]...)" のような
  // 非対称カーブを4分割して使う方式だが、ここでは一般的なエミュレータ実装に倣い
  // フラクション値をインデックスとして0..255の範囲にマップして使用する。
  _gaussInterp(voice, fracIdx) {
    // fracIdx: 0..255 (pitchCounterの下位から得た補間位置)
    const idx = fracIdx & 0xff;
    const p0 = voice.ring[(voice.ringPos - 4) & 3]; // 最も古い(3つ前)
    const p1 = voice.ring[(voice.ringPos - 3) & 3];
    const p2 = voice.ring[(voice.ringPos - 2) & 3];
    const p3 = voice.ring[(voice.ringPos - 1) & 3]; // 最新
    let out = (GAUSS_TABLE[255 - idx] * p0) >> 11;
    out += (GAUSS_TABLE[511 - idx] * p1) >> 11;
    out += (GAUSS_TABLE[256 + idx] * p2) >> 11;
    out += (GAUSS_TABLE[idx] * p3) >> 11;
    if (out > 32767) out = 32767;
    if (out < -32768) out = -32768;
    return out;
  }

  // メインの1サンプル生成。呼ぶたびにglobalCounterを進める。
  // 戻り値: [left, right] (Float32、-1.0〜1.0レンジ)
  generateSample() {
    this._globalCounter = (this._globalCounter + 1) >>> 0;

    let mixL = 0, mixR = 0;
    const konReg = this.kon;
    const koffReg = this.koff;
    const pmonReg = this.pmon;
    const nonReg = this.non;
    const eonReg = this.eon;

    // ノイズLFSRはFLGで指定されたノイズ周波数レートでのみ進める(全ボイス共通の1個のLFSR)
    if (this._rateFires(this.noiseFreqIdx)) {
      this.stepNoiseLFSR();
    }

    let prevVoiceOutput = 0; // 直前ボイスの出力(PMON用、KON直後は0扱い)

    for (let i = 0; i < 8; i++) {
      const voice = this.voices[i];
      const bit = 1 << i;

      // KEY ON / KEY OFF 検出（エッジトリガ）
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
      }

      if (voice.envMode === 'off') {
        voice.outSample = 0;
        prevVoiceOutput = 0;
        continue;
      }

      // ピッチ取得。PMON(bit i)が立っていれば直前ボイス(i-1)の出力で変調する。
      // ボイス0はPMONの対象外(直前ボイスが存在しないため常に無変調)。
      let p = this.pitch(i);
      if (i > 0 && (pmonReg & bit)) {
        // 実機のピッチ変調式: pitch += (pitch * prevOutput) >> 15  (prevOutputは-32768..32767相当を14bit精度で使用)
        const factor = prevVoiceOutput >> 4; // 大まかなスケール近似(直前サンプルのエンベロープ適用後出力を使用)
        p = p + ((p * factor) >> 10);
      }
      if (p < 0) p = 0;
      if (p > 0x3fff) p = 0x3fff;

      // BRRデコード：ブロック境界を超えたら次ブロックを読む(初回 or ループ後)
      if (voice.brrOffset >= 16) {
        if (!this._advanceBrrBlock(voice, i)) {
          voice.outSample = 0;
          prevVoiceOutput = 0;
          continue;
        }
        // 新ブロックデコード直後、リングバッファに先頭サンプルを積んでおく
        // (これがないとガウス補間の初回が無音履歴のまま計算されてしまう)
        this._pushRing(voice, voice.decodedBlock[0]);
      }

      // ガウス補間でサンプル取得。pitchCounterの上位ビット(0..0x7FFF範囲の下位12bitを
      // 8bit精度に丸めたもの)を補間フラクションとして使う。
      const fracIdx = (voice.pitchCounter >> 4) & 0xff;
      let sample = this._gaussInterp(voice, fracIdx);

      // ノイズチャンネル置き換え(NONビットが立っていればBRR/補間結果をLFSR値に差し替え)
      if (nonReg & bit) {
        sample = this.noiseSample;
      }

      // エンベロープ適用 (0-2047 -> 0.0-1.0相当のスケール)
      const env = this.stepEnvelope(voice, i);
      sample = (sample * env) >> 11;
      if (sample > 32767) sample = 32767;
      if (sample < -32768) sample = -32768;

      voice.outSample = sample;
      prevVoiceOutput = sample;

      const vl = this.volL(i) / 128;
      const vr = this.volR(i) / 128;
      mixL += sample * vl;
      mixR += sample * vr;

      // エコーに送る信号(EONビットが立っているボイスのみ)は後段でまとめて処理
      if (eonReg & bit) {
        this._echoAccumL = (this._echoAccumL || 0) + sample * vl;
        this._echoAccumR = (this._echoAccumR || 0) + sample * vr;
      }

      // ピッチカウンタを進める。16bit中、上位1bitがブロック送り、
      // 残り15bit(実質12bit精度)を小数部として扱う簡易固定小数点方式。
      // ここでは brrOffset の整数部を 12bit(0x1000=1sample分)刻みで管理する。
      voice.pitchCounter += p;
      const advanceBlocks = voice.pitchCounter >> 12; // 何サンプル分進めるか
      voice.pitchCounter &= 0xfff;

      for (let s = 0; s < advanceBlocks; s++) {
        voice.brrOffset++;
        // 新しいデコード済みサンプルをリングバッファに積む
        if (voice.brrOffset < 16) {
          this._pushRing(voice, voice.decodedBlock[voice.brrOffset]);
        } else {
          if (!this._advanceBrrBlock(voice, i)) break;
          this._pushRing(voice, voice.decodedBlock[voice.brrOffset]);
        }
      }
    }

    // --- エコー処理 ---
    // ESA(0x6D)を先頭アドレスとするRAM上のリングバッファ(長さ = edl*2048byte、
    // 1サンプルあたりL/R各2byte=4byte)にFIRディレイラインを構築し、
    // 8タップFIRフィルタ(係数c0..c7)でエコー出力を計算後、
    // フィードバック(EFB)をミックスして再度バッファへ書き込む。
    const edl = this.edl;
    const echoLenSamples = edl === 0 ? 1 : edl * 512; // 実機: 各1が2048byte=512サンプル(L/R各2byte*2)
    const esaBase = (this.esa << 8) & 0xffff;

    const rawEchoInL = this._echoAccumL || 0;
    const rawEchoInR = this._echoAccumR || 0;
    this._echoAccumL = 0;
    this._echoAccumR = 0;

    // FIRディレイラインへ新規サンプルを追加(直近8サンプルの巡回バッファ)
    this.firHistoryL[this.firPos & 7] = 0; // placeholder, actual push happens after reading buffer below
    // エコーバッファからの読み出し位置(現在のechoPos)
    const readAddr = (esaBase + this.echoPos * 4) & 0xffff;
    let echoRawL = (this.ram[readAddr] | (this.ram[(readAddr + 1) & 0xffff] << 8));
    let echoRawR = (this.ram[(readAddr + 2) & 0xffff] | (this.ram[(readAddr + 3) & 0xffff] << 8));
    if (echoRawL & 0x8000) echoRawL -= 0x10000;
    if (echoRawR & 0x8000) echoRawR -= 0x10000;

    // FIR履歴に今回読み出した値を追加
    this.firHistoryL[this.firPos & 7] = echoRawL;
    this.firHistoryR[this.firPos & 7] = echoRawR;

    // 8タップFIR畳み込み(タップ0が最新、タップ7が最も古い)
    let firOutL = 0, firOutR = 0;
    for (let t = 0; t < 8; t++) {
      const c = this.firCoef(t);
      const hIdx = (this.firPos - t) & 7;
      firOutL += c * this.firHistoryL[hIdx];
      firOutR += c * this.firHistoryR[hIdx];
    }
    firOutL = firOutL >> 6;
    firOutR = firOutR >> 6;
    if (firOutL > 32767) firOutL = 32767; if (firOutL < -32768) firOutL = -32768;
    if (firOutR > 32767) firOutR = 32767; if (firOutR < -32768) firOutR = -32768;
    this.firPos = (this.firPos + 1) & 7;

    // エコー出力をメインミックスへ加算(EVOL L/R、FLGのエコーミュートも考慮)
    if (!this.echoDisabled) {
      mixL += firOutL * (this.evolL / 128);
      mixR += firOutR * (this.evolR / 128);
    }

    // 新たにバッファへ書き込む値 = 入力ミックス + フィードバック(EFB)
    let newEchoL = rawEchoInL + ((firOutL * this.efb) >> 7);
    let newEchoR = rawEchoInR + ((firOutR * this.efb) >> 7);
    if (newEchoL > 32767) newEchoL = 32767; if (newEchoL < -32768) newEchoL = -32768;
    if (newEchoR > 32767) newEchoR = 32767; if (newEchoR < -32768) newEchoR = -32768;

    if (!this.echoWriteDisabled) {
      this.ram[readAddr] = newEchoL & 0xff;
      this.ram[(readAddr + 1) & 0xffff] = (newEchoL >> 8) & 0xff;
      this.ram[(readAddr + 2) & 0xffff] = newEchoR & 0xff;
      this.ram[(readAddr + 3) & 0xffff] = (newEchoR >> 8) & 0xff;
    }

    this.echoPos++;
    if (this.echoPos >= echoLenSamples) this.echoPos = 0;

    // マスターボリューム適用 (voice出力は±32767スケール、mvolは±128フル)
    const outL = (mixL * this.mvolL) / (128 * 32768);
    const outR = (mixR * this.mvolR) / (128 * 32768);

    return [
      Math.max(-1, Math.min(1, outL)),
      Math.max(-1, Math.min(1, outR)),
    ];
  }

  // ブロック末端に達したボイスを次ブロック(または終了/ループ)へ進める。
  // KeyOn直後(_decodedOnce===false)はvoice.brrAddrが既にサンプル先頭を指しているため
  // アドレスを送らずそのままデコードする。それ以外はまず「直前ブロックが終端だったか」を
  // 見て、終端ならloop/off処理、そうでなければ+9byte進めてからデコードする。
  // 戻り値: 続行可能ならtrue、ボイスをoffにした場合はfalse。
  _advanceBrrBlock(voice, i) {
    if (voice._decodedOnce) {
      if (voice.endFlag) {
        if (voice.loopFlag) {
          const dirEntry = this.getSampleDirEntry(this.srcn(i));
          voice.brrAddr = dirEntry.loop;
        } else {
          voice.envMode = 'off';
          voice.envLevel = 0;
          voice.brrOffset = 16;
          return false;
        }
      } else {
        voice.brrAddr = (voice.brrAddr + 9) & 0xffff;
      }
    }
    this.decodeBrrBlock(voice, voice.brrAddr);
    voice._decodedOnce = true;
    voice.brrOffset = 0;
    return true;
  }

  _triggerKeyOn(voice, i) {
    const dirEntry = this.getSampleDirEntry(this.srcn(i));
    voice.brrAddr = dirEntry.start;
    voice.brrOffset = 16; // 次回生成時に即デコード
    voice.pitchCounter = 0;
    voice.history = [0, 0];
    voice.ring.fill(0);
    voice.ringPos = 0;
    voice.envLevel = 0;
    voice.envMode = 'attack';
    voice.keyOff = false;
    voice.endFlag = false;
    voice.loopFlag = false;
    voice._decodedOnce = false;
  }
}

if (typeof module !== 'undefined') module.exports = { DSP, SDSP_RATE };

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

    // --- I/Oレジスタ内部状態の復元 ---
    // RAMダンプ上の 0xF0-0xFF にはCONTROLやタイマーターゲット等の値が
    // そのまま焼き込まれているが、cpu.ram.set()による直接コピーでは
    // cpu.write()内で行われる特殊処理(timerTarget[]への反映、
    // timerEnable[]の設定など)が一切実行されないため、
    // CPU内部状態(timerEnable/timerTarget/timerCounter等)が
    // 初期値のまま(target=0など)になってしまう。
    // これを放置するとタイマーが本来より極端に高頻度で発火し、
    // 曲のテンポが実機の何十倍にもなる重大な不具合につながるため、
    // ロード直後に該当アドレスへ改めてcpu.write()経由で書き戻し、
    // 内部状態を正しく同期させる。
    const ioRegs = [0xfa, 0xfb, 0xfc, 0xf1]; // タイマーターゲット3つ + CONTROL
    for (const addr of ioRegs) {
      this.cpu.write(addr, parsed.ram[addr]);
    }
    // タイマーのカウンタ/出力は曲頭では0から始めるのが自然なため明示的にクリアする
    this.cpu.timerCounter = [0, 0, 0];
    this.cpu.timerOut = new Uint8Array(3);
    this.cpu._tAccum = [0, 0, 0];

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

// ============================================================================
// SPCPlayerProcessor: AudioWorkletProcessor
// メインスレッドからSPCデータを受け取り、SPCEngineでレンダリングして
// Web Audioの出力バッファに書き込む。
//
// S-DSPは実機同様32000Hz固定でサンプルを生成するが、AudioContextの
// 実際のサンプルレート(sampleRateグローバル変数、48000Hz等になることが多い)
// はブラウザ/OS依存で指定通りにならない場合があるため、
// ここで32000Hz -> 実際のサンプルレートへ線形補間リサンプリングを行う。
// これを怠ると「サンプルレート指定が無視され、DSPの1サンプルがそのまま
// 出力の1サンプルとして再生される」ため、再生速度が実機と異なってしまう
// (例: 実際が48000Hzなのに32000Hz想定で詰めると 48000/32000=1.5倍速になる)。
// ============================================================================

const SDSP_SAMPLE_RATE = 32000;

class SPCPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new SPCEngine();
    this.playing = false;

    // リサンプリング用の状態
    // sampleRate は AudioWorkletGlobalScope が提供するグローバル変数で、
    // このコンテキストの実際の出力サンプルレート(Hz)が入っている。
    this.resampleRatio = SDSP_SAMPLE_RATE / sampleRate; // 1コンテキストサンプル進める毎に進めるDSPサンプル数
    this.srcPos = 0;       // DSPサンプル列上の現在位置(小数)
    this.prevL = 0;        // 直前に生成したDSPサンプル(補間の左端)
    this.prevR = 0;
    this.nextL = 0;        // 次に生成したDSPサンプル(補間の右端)
    this.nextR = 0;
    this.haveSample = false;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'load') {
        try {
          this.engine.loadSPC(msg.parsed);
          this.playing = true;
          // 新規ロード時にリサンプラーの状態もリセットする
          this.srcPos = 0;
          this.haveSample = false;
          this.prevL = this.prevR = this.nextL = this.nextR = 0;
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

  // DSPを1サンプル分進めてprev/nextを更新する
  _advanceDspSample() {
    this.prevL = this.nextL;
    this.prevR = this.nextR;
    const [l, r] = this.engine.renderSample();
    this.nextL = l;
    this.nextR = r;
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

    if (!this.haveSample) {
      // 最初の2点を用意する
      this._advanceDspSample();
      this._advanceDspSample();
      this.haveSample = true;
    }

    for (let i = 0; i < n; i++) {
      // srcPosが1.0を超えるたびにDSPサンプルを1つ進める
      while (this.srcPos >= 1) {
        this._advanceDspSample();
        this.srcPos -= 1;
      }
      const frac = this.srcPos;
      left[i] = this.prevL + (this.nextL - this.prevL) * frac;
      right[i] = this.prevR + (this.nextR - this.prevR) * frac;
      this.srcPos += this.resampleRatio;
    }

    return true;
  }
}

registerProcessor('spc-player-processor', SPCPlayerProcessor);