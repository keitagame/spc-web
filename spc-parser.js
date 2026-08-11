// ============================================================================
// SPCファイルパーサー
// .spc フォーマット (v0.30, ヘッダ256byte + RAM 64KB + DSPレジスタ128byte + ...)
// 参考: SPC700 File Format specification
// ============================================================================

function parseSPC(arrayBuffer) {
  const buf = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);

  // ヘッダチェック "SNES-SPC700 Sound File Data"
  const headerText = String.fromCharCode(...buf.slice(0, 33));
  if (!headerText.startsWith('SNES-SPC700')) {
    throw new Error('SPCファイルのヘッダが不正です（SNES-SPC700シグネチャが見つかりません）');
  }

  const hasID666 = buf[0x23] === 26 || buf[0x23] === 27; // 0x1A(26)=タグあり, 0x1B(27)=タグなし版もある実装差異に対応
  // 実際の仕様: offset 0x23 が 0x1A固定でヘッダ終端マーカー、0x24がID666タグの有無(1=あり,0=なし)
  const id666Flag = buf[0x24];

  // レジスタ情報 (offset 0x25-0x2D)
  const pc = dv.getUint16(0x25, true);
  const a = buf[0x27];
  const x = buf[0x28];
  const y = buf[0x29];
  const psw = buf[0x2a];
  const sp = buf[0x2b];

  // ID666タグ (offset 0x2E - 0xD0) 曲情報
  let songTitle = '', gameTitle = '', dumperName = '', comments = '', dateDumped = '';
  let artist = '';
  try {
    songTitle = readTagString(buf, 0x2e, 32);
    gameTitle = readTagString(buf, 0x4e, 32);
    dumperName = readTagString(buf, 0x6e, 16);
    comments = readTagString(buf, 0x7e, 32);
    artist = readTagString(buf, 0xb1, 32);
  } catch (e) {
    // タグが壊れていても再生自体は継続する
  }

  // RAMデータ: offset 0x100 から 65536 byte
  const ramStart = 0x100;
  const ram = buf.slice(ramStart, ramStart + 0x10000);

  // DSPレジスタ: offset 0x10100 から 128 byte
  const dspStart = 0x10100;
  const dspRegs = buf.slice(dspStart, dspStart + 0x80);

  return {
    pc, a, x, y, psw, sp,
    ram,
    dspRegs,
    tags: { songTitle, gameTitle, artist, dumperName, comments },
  };
}

function readTagString(buf, offset, length) {
  let end = offset;
  const max = offset + length;
  while (end < max && buf[end] !== 0) end++;
  const bytes = buf.slice(offset, end);
  // Shift-JISの可能性もあるが、まずUTF-8/ASCIIとしてデコードを試みる
  try {
    return new TextDecoder('shift-jis', { fatal: false }).decode(bytes).trim();
  } catch (e) {
    return String.fromCharCode(...bytes).trim();
  }
}

if (typeof module !== 'undefined') module.exports = { parseSPC };
