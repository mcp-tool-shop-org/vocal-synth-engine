  const DAEMON_URL = '';
  
  // --- State ---
  let score = {
    bpm: 120,
    notes: [
      { id: "n1", startSec: 0.0, durationSec: 0.5, midi: 60, velocity: 0.8, timbre: "ah" },
      { id: "n2", startSec: 0.5, durationSec: 0.5, midi: 64, velocity: 0.8, timbre: "oo" },
      { id: "n3", startSec: 1.0, durationSec: 1.0, midi: 67, velocity: 0.8, vibrato: { rateHz: 5.5, depthCents: 50, onsetSec: 0.2 } }
    ]
  };
  let selectedNoteId: string | null = null;
  let currentWavUrl: string | null = null;
  let currentDaemonCommit = '';

  // --- DOM Elements ---
  const statusBadge = document.getElementById('health-status')!;
  const scoreInput = document.getElementById('score-input') as HTMLTextAreaElement;
  
  // Transport
  const btnRenderPlay = document.getElementById('btn-render-play') as HTMLButtonElement;
  const btnRender = document.getElementById('btn-render') as HTMLButtonElement;
  const btnSaveRender = document.getElementById('btn-save-render') as HTMLButtonElement;
  const btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
  const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
  const btnDownload = document.getElementById('btn-download') as HTMLButtonElement;
  const toggleLoop = document.getElementById('toggle-loop') as HTMLInputElement;
  const audioPlayer = document.getElementById('audio-player') as HTMLAudioElement;
  const statusStrip = document.getElementById('status-strip')!;
  
  // Config
  const inpPolyphony = document.getElementById('inp-polyphony') as HTMLInputElement;
  const inpDeterminism = document.getElementById('inp-determinism') as HTMLSelectElement;
  const inpSeed = document.getElementById('inp-seed') as HTMLInputElement;
  const inpBpm = document.getElementById('inp-bpm') as HTMLInputElement;
  const inpDefaultTimbre = document.getElementById('inp-default-timbre') as HTMLSelectElement;

  // Piano Roll
  const prContainer = document.getElementById('pr-container')!;
  const prContent = document.getElementById('pr-content')!;
  
  // Inspector
  const noteInspector = document.getElementById('note-inspector')!;
  const inspTimbre = document.getElementById('insp-timbre') as HTMLSelectElement;
  const inspVel = document.getElementById('insp-vel') as HTMLInputElement;
  const inspPorta = document.getElementById('insp-porta') as HTMLInputElement;
  const inspBreath = document.getElementById('insp-breath') as HTMLInputElement;
  const inspVibToggle = document.getElementById('insp-vib-toggle') as HTMLInputElement;
  const inspVibRate = document.getElementById('insp-vib-rate') as HTMLInputElement;
  const inspVibDepth = document.getElementById('insp-vib-depth') as HTMLInputElement;
  const inspVibOnset = document.getElementById('insp-vib-onset') as HTMLInputElement;

  // Telemetry & Provenance
  const tileClicks = document.getElementById('tile-clicks')!;
  const tileRtf = document.getElementById('tile-rtf')!;
  const tileDuration = document.getElementById('tile-duration')!;
  const tileDurationSub = document.getElementById('tile-duration-sub')!;
  const telemetryOutput = document.getElementById('telemetry-output')!;
  const provCommit = document.getElementById('prov-commit')!;
  const provScore = document.getElementById('prov-score')!;
  const provWav = document.getElementById('prov-wav')!;
  const provConfig = document.getElementById('prov-config')!;
  const provenanceOutput = document.getElementById('provenance-output')!;

  // Bank
  const bankList = document.getElementById('bank-list')!;
  const toastContainer = document.getElementById('toast-container')!;

  // --- Toasts ---
  function showToast(msg: string) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // --- Piano Roll Logic ---
  let timeScale = 100; // px per sec
  const pitchScale = 14; // px per semitone
  const minMidi = 36; // C2
  const maxMidi = 84; // C6
  const numKeys = maxMidi - minMidi + 1;

  function updateUI() {
    renderPianoRoll();
    updateInspector();
    scoreInput.value = JSON.stringify(score, null, 2);
  }

  function renderPianoRoll() {
    prContent.innerHTML = '';
    
    let maxSec = 10;
    score.notes.forEach(n => {
      if (n.startSec + n.durationSec > maxSec) maxSec = n.startSec + n.durationSec;
    });
    prContent.style.width = `${(maxSec + 2) * timeScale}px`;
    prContent.style.height = `${numKeys * pitchScale}px`;

    for (let i = 0; i <= numKeys; i++) {
      const midi = maxMidi - i;
      if (midi % 12 === 0) {
        const line = document.createElement('div');
        line.className = 'pr-grid-line-h c-note';
        line.style.top = `${i * pitchScale}px`;
        prContent.appendChild(line);
      }
    }

    score.notes.forEach(note => {
      const el = document.createElement('div');
      el.className = `pr-note ${note.id === selectedNoteId ? 'selected' : ''}`;
      el.style.left = `${note.startSec * timeScale}px`;
      el.style.width = `${note.durationSec * timeScale}px`;
      el.style.top = `${(maxMidi - note.midi) * pitchScale}px`;
      el.style.height = `${pitchScale}px`;
      el.dataset.id = note.id;

      const handle = document.createElement('div');
      handle.className = 'pr-resize-handle';
      el.appendChild(handle);

      prContent.appendChild(el);
    });
  }

  let dragState: any = null;

  prContent.addEventListener('mousedown', (e) => {
    const target = e.target as HTMLElement;
    const noteEl = target.closest('.pr-note') as HTMLElement;
    
    if (noteEl) {
      const id = noteEl.dataset.id!;
      selectedNoteId = id;
      const note = score.notes.find(n => n.id === id)!;
      
      if (target.classList.contains('pr-resize-handle')) {
        dragState = { type: 'resize', note, startX: e.clientX, startDur: note.durationSec };
      } else {
        dragState = { type: 'move', note, startX: e.clientX, startY: e.clientY, startSec: note.startSec, startMidi: note.midi };
      }
      e.stopPropagation();
    } else {
      const rect = prContent.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const startSec = Math.max(0, Math.round((x / timeScale) * 10) / 10);
      const midi = Math.max(minMidi, Math.min(maxMidi, maxMidi - Math.floor(y / pitchScale)));
      
      const newNote = {
        id: 'n' + Date.now(),
        startSec,
        durationSec: 0.5,
        midi,
        velocity: 0.8
      };
      score.notes.push(newNote);
      selectedNoteId = newNote.id;
    }
    updateUI();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    
    if (dragState.type === 'move') {
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      
      let newSec = dragState.startSec + (dx / timeScale);
      newSec = Math.max(0, Math.round(newSec * 10) / 10);
      
      let newMidi = dragState.startMidi - Math.round(dy / pitchScale);
      newMidi = Math.max(minMidi, Math.min(maxMidi, newMidi));
      
      dragState.note.startSec = newSec;
      dragState.note.midi = newMidi;
      renderPianoRoll();
    } else if (dragState.type === 'resize') {
      const dx = e.clientX - dragState.startX;
      let newDur = dragState.startDur + (dx / timeScale);
      newDur = Math.max(0.1, Math.round(newDur * 10) / 10);
      dragState.note.durationSec = newDur;
      renderPianoRoll();
    }
  });

  window.addEventListener('mouseup', () => {
    if (dragState) {
      dragState = null;
      updateUI();
    }
  });

  window.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNoteId) {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      score.notes = score.notes.filter(n => n.id !== selectedNoteId);
      selectedNoteId = null;
      updateUI();
    }
  });

  prContainer.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const zoom = e.deltaY > 0 ? 0.9 : 1.1;
      timeScale = Math.max(20, Math.min(300, timeScale * zoom));
      renderPianoRoll();
    }
  }, { passive: false });

  // --- Inspector Logic ---
  function updateInspector() {
    const note = score.notes.find(n => n.id === selectedNoteId);
    if (!note) {
      noteInspector.style.display = 'none';
      return;
    }
    noteInspector.style.display = 'block';
    
    inspTimbre.value = note.timbre || '';
    inspVel.value = (note.velocity ?? 0.8).toString();
    inspPorta.value = (note.portamentoSec ?? 0).toString();
    inspBreath.value = (note.breathiness ?? 0).toString();
    
    if (note.vibrato) {
      inspVibToggle.checked = true;
      inspVibRate.value = (note.vibrato.rateHz ?? 5.5).toString();
      inspVibDepth.value = (note.vibrato.depthCents ?? 50).toString();
      inspVibOnset.value = (note.vibrato.onsetSec ?? 0.2).toString();
    } else {
      inspVibToggle.checked = false;
    }
  }

  function applyInspectorChanges() {
    if (!selectedNoteId) return;
    const note = score.notes.find(n => n.id === selectedNoteId);
    if (!note) return;

    if (inspTimbre.value) note.timbre = inspTimbre.value;
    else delete note.timbre;
    
    note.velocity = parseFloat(inspVel.value);
    
    const porta = parseFloat(inspPorta.value);
    if (porta > 0) note.portamentoSec = porta;
    else delete note.portamentoSec;

    const breath = parseFloat(inspBreath.value);
    if (breath > 0) note.breathiness = breath;
    else delete note.breathiness;

    if (inspVibToggle.checked) {
      note.vibrato = {
        rateHz: parseFloat(inspVibRate.value),
        depthCents: parseFloat(inspVibDepth.value),
        onsetSec: parseFloat(inspVibOnset.value)
      };
    } else {
      delete note.vibrato;
    }
    
    updateUI();
  }

  [inspTimbre, inspVel, inspPorta, inspBreath, inspVibToggle, inspVibRate, inspVibDepth, inspVibOnset].forEach(el => {
    el.addEventListener('input', applyInspectorChanges);
  });

  scoreInput.addEventListener('input', () => {
    try {
      score = JSON.parse(scoreInput.value);
      updateUI();
    } catch (e) {}
  });

  // --- Render Bank Logic ---
  async function loadBank() {
    try {
      const res = await fetch(`${DAEMON_URL}/api/renders`);
      const data = await res.json();
      const renders = data.renders || [];
      
      bankList.innerHTML = '';
      renders.forEach((r: any) => {
        const el = document.createElement('div');
        el.className = 'bank-item';
        
        const dur = r.durationSec?.toFixed(2) || '0.00';
        const commit = r.commit?.substring(0,7) || 'unknown';
        
        el.innerHTML = `
          <div class="bank-item-header">
            <input type="text" class="bank-item-name" value="${r.name}" data-id="${r.id}">
          </div>
          <div class="bank-item-meta">
            <span>⏱ ${dur}s</span>
            <span class="hash">${commit}</span>
          </div>
          <div class="bank-item-actions">
            <button class="btn-bank-play" data-id="${r.id}">▶ Play</button>
            <button class="btn-bank-load" data-id="${r.id}" data-commit="${commit}">Load Score</button>
            <button class="btn-bank-del" data-id="${r.id}">🗑</button>
          </div>
        `;
        bankList.appendChild(el);
      });

      // Bind events
      document.querySelectorAll('.bank-item-name').forEach(inp => {
        inp.addEventListener('change', async (e) => {
          const target = e.target as HTMLInputElement;
          await fetch(`${DAEMON_URL}/api/renders/${target.dataset.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: target.value })
          });
          showToast('Renamed render');
        });
      });

      document.querySelectorAll('.btn-bank-play').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = (e.target as HTMLElement).dataset.id;
          audioPlayer.src = `${DAEMON_URL}/api/renders/${id}/audio.wav`;
          audioPlayer.play();
        });
      });

      document.querySelectorAll('.btn-bank-load').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const target = e.target as HTMLElement;
          const id = target.dataset.id;
          const commit = target.dataset.commit;
          
          if (commit !== currentDaemonCommit.substring(0,7)) {
            alert(`Warning: This render was created on commit ${commit}. Your daemon is on ${currentDaemonCommit.substring(0,7)}. Re-render to compare apples-to-apples.`);
          }

          const res = await fetch(`${DAEMON_URL}/api/renders/${id}/score`);
          if (res.ok) {
            score = await res.json();
            updateUI();
            showToast('Score loaded');
          }
        });
      });

      document.querySelectorAll('.btn-bank-del').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = (e.target as HTMLElement).dataset.id;
          await fetch(`${DAEMON_URL}/api/renders/${id}`, { method: 'DELETE' });
          loadBank();
        });
      });

    } catch (e) {
      console.error('Failed to load bank', e);
    }
  }

  // --- Daemon Communication ---
  async function checkHealth() {
    try {
      const res = await fetch(`${DAEMON_URL}/api/health`);
      if (res.ok) {
        const data = await res.json();
        currentDaemonCommit = data.commit;
        statusBadge.textContent = `Daemon OK (v${data.engineVersion} | ${data.commit.substring(0,7)})`;
        statusBadge.className = 'status-badge ok';
      } else throw new Error();
    } catch (e) {
      statusBadge.textContent = 'Daemon Offline';
      statusBadge.className = 'status-badge error';
    }
  }
  checkHealth();
  setInterval(checkHealth, 5000);

  async function doRender() {
    btnRender.disabled = true;
    btnRenderPlay.disabled = true;
    statusStrip.textContent = 'Rendering...';
    
    score.bpm = parseInt(inpBpm.value, 10);

    const config = {
      maxPolyphony: parseInt(inpPolyphony.value, 10),
      deterministic: inpDeterminism.value,
      rngSeed: parseInt(inpSeed.value, 10),
      defaultTimbre: inpDefaultTimbre.value
    };
    
    const res = await fetch(`${DAEMON_URL}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score, config })
    });
    
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Render failed');
    }
    
    const data = await res.json();
    
    // Telemetry
    const maxDelta = data.telemetry.maxAbsDelta || 0;
    tileClicks.querySelector('.value')!.textContent = maxDelta.toFixed(4);
    tileClicks.className = `tile ${maxDelta > 0.25 ? 'error' : (maxDelta > 0.15 ? 'warn' : 'ok')}`;
    
    const rtf = data.telemetry.rtf || 0;
    tileRtf.querySelector('.value')!.textContent = rtf > 0 ? rtf.toFixed(3) : '--';
    
    const dur = data.telemetry.durationSec || 0;
    const scoreDur = data.telemetry.scoreDurationSec || 0;
    const tail = data.telemetry.tailSec || 0;
    tileDuration.querySelector('.value')!.textContent = `${dur.toFixed(2)}s`;
    tileDurationSub.textContent = `(notes ${scoreDur.toFixed(2)}s + tail ${tail.toFixed(2)}s)`;
    
    telemetryOutput.textContent = JSON.stringify(data.telemetry, null, 2);
    
    // Provenance
    provCommit.textContent = data.provenance.commit.substring(0, 7);
    provScore.textContent = data.provenance.scoreHash.substring(0, 8);
    provWav.textContent = data.provenance.wavHash.substring(0, 8);
    const c = data.provenance.config;
    provConfig.textContent = `SR: ${c.sampleRateHz} | Block: ${c.blockSize} | Poly: ${c.maxPolyphony} | Mode: ${c.deterministic}`;
    provenanceOutput.textContent = JSON.stringify(data.provenance, null, 2);
    
    // Audio
    if (currentWavUrl) URL.revokeObjectURL(currentWavUrl);
    const binaryString = atob(data.wavBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    
    const blob = new Blob([bytes], { type: 'audio/wav' });
    currentWavUrl = URL.createObjectURL(blob);
    audioPlayer.src = currentWavUrl;
    
    btnPlay.disabled = false;
    btnDownload.disabled = false;
    
    const renderTimeMs = data.telemetry.renderTimeMs || 0;
    statusStrip.textContent = `Rendered in ${renderTimeMs.toFixed(1)}ms | RTF: ${rtf.toFixed(3)}`;

    showToast(`Rendered ${dur.toFixed(2)}s`);
  }

  async function doSaveRender() {
    btnSaveRender.disabled = true;
    statusStrip.textContent = 'Saving render...';
    
    score.bpm = parseInt(inpBpm.value, 10);

    const config = {
      maxPolyphony: parseInt(inpPolyphony.value, 10),
      deterministic: inpDeterminism.value,
      rngSeed: parseInt(inpSeed.value, 10),
      defaultTimbre: inpDefaultTimbre.value
    };
    
    const name = prompt("Enter a name for this render:");
    if (name === null) {
      btnSaveRender.disabled = false;
      statusStrip.textContent = 'Ready';
      return;
    }

    const res = await fetch(`${DAEMON_URL}/api/renders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, score, config })
    });
    
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Save failed');
    }
    
    const data = await res.json();
    showToast(`Saved as ${data.meta.name}`);
    loadBank(); // Refresh bank
  }

  btnRender.addEventListener('click', async () => {
    try { await doRender(); } 
    catch (e: any) { alert(e.message); statusStrip.textContent = `Error: ${e.message}`; }
    finally { btnRender.disabled = false; btnRenderPlay.disabled = false; }
  });

  btnRenderPlay.addEventListener('click', async () => {
    try { 
      await doRender(); 
      audioPlayer.play();
    } 
    catch (e: any) { alert(e.message); statusStrip.textContent = `Error: ${e.message}`; }
    finally { btnRender.disabled = false; btnRenderPlay.disabled = false; }
  });

  btnSaveRender.addEventListener('click', async () => {
    try { await doSaveRender(); } 
    catch (e: any) { alert(e.message); statusStrip.textContent = `Error: ${e.message}`; }
    finally { btnSaveRender.disabled = false; }
  });

  // Audio events
  audioPlayer.addEventListener('ended', () => {
    if (toggleLoop.checked) { audioPlayer.currentTime = 0; audioPlayer.play(); } 
    else { btnPlay.disabled = false; btnStop.disabled = true; statusStrip.textContent = 'Ready'; }
  });
  audioPlayer.addEventListener('play', () => { btnPlay.disabled = true; btnStop.disabled = false; statusStrip.textContent = 'Playing...'; });
  audioPlayer.addEventListener('pause', () => { btnPlay.disabled = false; btnStop.disabled = true; if (audioPlayer.currentTime > 0 && audioPlayer.currentTime < audioPlayer.duration) statusStrip.textContent = 'Paused'; });

  btnPlay.addEventListener('click', () => { if (currentWavUrl) audioPlayer.play(); });
  btnStop.addEventListener('click', () => { audioPlayer.pause(); audioPlayer.currentTime = 0; statusStrip.textContent = 'Stopped'; });
  btnDownload.addEventListener('click', () => {
    if (currentWavUrl) {
      const a = document.createElement('a');
      a.href = currentWavUrl;
      a.download = `render-${Date.now()}.wav`;
      a.click();
    }
  });

  // Init
  updateUI();
  loadBank();
