// ============================================================================
// メインスレッド制御スクリプト
// ファイル選択/ドロップ -> SPCパース -> AudioWorkletへ転送 -> 再生制御
// ============================================================================

(() => {
  
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const playBtn = document.getElementById('playBtn');
  const statusEl = document.getElementById('status');
  const trackInfo = document.getElementById('trackInfo');
  const trackTitle = document.getElementById('trackTitle');
  const trackGame = document.getElementById('trackGame');
  const trackArtist = document.getElementById('trackArtist');
  const trackDumper = document.getElementById('trackDumper');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumeLabel = document.getElementById('volumeLabel');
const voiceTable = document.getElementById("voiceTable");
function pitchToNote(pitch) {
    if (!pitch) return "-";

    // SPC700のピッチ値から周波数を概算
    const freq = 32000 * pitch / 4096;

    if (!isFinite(freq) || freq <= 0) {
        return "-";
    }

    const noteNames = [
        "C", "C#", "D", "D#", "E", "F",
        "F#", "G", "G#", "A", "A#", "B"
    ];

    const midi = Math.round(
        69 + 12 * Math.log2(freq / 440)
    );

    const octave = Math.floor(midi / 12) - 1;
    const name = noteNames[((midi % 12) + 12) % 12];

    return `${name}${octave}`;
}
function updateVoiceInfo(voices) {
    voiceTable.innerHTML = voices.map(v => `
        <tr>
            <td>${v.voice}</td>
            <td>${v.active ? "ON" : "OFF"}</td>
            <td>${v.volumeL}</td>
            <td>${v.volumeR}</td>
            <td>${v.active ? pitchToNote(v.pitch) : "-"}</td>
            <td>0x${v.pitch.toString(16).padStart(4, "0").toUpperCase()}</td>
        </tr>
    `).join("");
}

  let audioContext = null;
  let workletNode = null;
  let gainNode = null;
  let isPlaying = false;
  let isLoaded = false;
  let currentParsed = null;

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  // --------------------------------------------------------------------
  // AudioContext / AudioWorklet 初期化
  // SDSPは32000Hz固定でサンプルを生成する仕様のため、AudioContextの
  // サンプルレートも32000Hzで作成し、リサンプリングなしで直結する。
  // --------------------------------------------------------------------
  async function ensureAudioContext() {
    if (audioContext) return;

const audioOptions = {
  // サンプルレートを 48000Hz (または 44100Hz) に固定
  sampleRate: 48000, 
  
  // 音質最優先（再生の滑らかさ重視）に設定
  latencyHint: 'playback' 
};

// レガシーブラウザ（フォールバック）対応を含めた初期化
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
audioContext = new AudioContextClass(audioOptions);

    // audioContext = new (window.AudioContext || window.webkitAudioContext);
    await audioContext.audioWorklet.addModule('dist/spc-worklet-bundle.js');

    workletNode = new AudioWorkletNode(audioContext, 'spc-player-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    gainNode = audioContext.createGain();
    gainNode.gain.value = Number(volumeSlider.value) / 100;

    workletNode.connect(gainNode);
    gainNode.connect(audioContext.destination);

    workletNode.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'loaded') {
        isLoaded = true;
        setStatus('読み込み完了。再生できます。', 'ok');
        playBtn.disabled = false;
      } else if (msg.type === 'error') {
        setStatus('エラー: ' + msg.message, 'error');
      }
      if (msg.type === "voiceInfo") {
        updateVoiceInfo(msg.voices);
        return;
    }

    if (msg.type === "loaded") {
        console.log("SPC loaded");
        return;
    }

    if (msg.type === "error") {
        console.error(msg.message);
        return;
    }
    };
  }

  // --------------------------------------------------------------------
  // ファイル処理
  // --------------------------------------------------------------------
  async function handleFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.spc')) {
      setStatus('拡張子が .spc のファイルを選択してください', 'error');
      return;
    }

    setStatus('ファイルを読み込み中...');
    playBtn.disabled = true;
    isLoaded = false;

    try {
      const buf = await file.arrayBuffer();
      const parsed = parseSPC(buf);
      currentParsed = parsed;

      // UI更新: 曲情報表示
      const tags = parsed.tags;
      trackTitle.textContent = tags.songTitle || file.name;
      trackGame.textContent = tags.gameTitle || '';
      trackArtist.textContent = tags.artist ? ('作曲: ' + tags.artist) : '';
      trackDumper.textContent = tags.dumperName ? ('Dump: ' + tags.dumperName) : '';
      trackInfo.classList.add('visible');

      setStatus('オーディオエンジンを初期化中...');
      await ensureAudioContext();

      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      // RAM/DSPレジスタはTransferableではないコピーとして送る
      // (Uint8Arrayはstructured cloneで問題なく転送できる)
      workletNode.port.postMessage({
        type: 'load',
        parsed: {
          pc: parsed.pc,
          a: parsed.a,
          x: parsed.x,
          y: parsed.y,
          psw: parsed.psw,
          sp: parsed.sp,
          ram: parsed.ram,
          dspRegs: parsed.dspRegs,
        },
      });

      setStatus('読み込み中...');
    } catch (e) {
      console.error(e);
      setStatus('読み込みエラー: ' + e.message, 'error');
    }
  }

  // --------------------------------------------------------------------
  // 再生/停止トグル
  // --------------------------------------------------------------------
  async function togglePlay() {
    if (!isLoaded || !workletNode) return;

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    if (isPlaying) {
      workletNode.port.postMessage({ type: 'stop' });
      isPlaying = false;
      playBtn.textContent = '▶ 再生';
      playBtn.classList.remove('playing');
      setStatus('停止しました');
    } else {
      workletNode.port.postMessage({ type: 'play' });
      isPlaying = true;
      playBtn.textContent = '⏸ 停止';
      playBtn.classList.add('playing');
      setStatus('再生中...', 'ok');
    }
  }

  // --------------------------------------------------------------------
  // イベントバインド
  // --------------------------------------------------------------------
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    handleFile(file);
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
  });

  playBtn.addEventListener('click', togglePlay);

  volumeSlider.addEventListener('input', () => {
    const v = Number(volumeSlider.value);
    volumeLabel.textContent = v + '%';
    if (gainNode) {
      gainNode.gain.value = v / 100;
    }
  });
})();
