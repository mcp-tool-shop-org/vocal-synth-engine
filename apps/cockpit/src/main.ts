  const DAEMON_URL = '';

  // --- State ---
  let score = {
    bpm: 120,
    notes: [
      { id: "n1", startSec: 0.0, durationSec: 0.5, midi: 60, velocity: 0.8, timbre: "AH" },
      { id: "n2", startSec: 0.5, durationSec: 0.5, midi: 64, velocity: 0.8 },
      { id: "n3", startSec: 1.0, durationSec: 1.0, midi: 67, velocity: 0.8, vibrato: { rateHz: 5.5, depthCents: 50, onsetSec: 0.2 } }
    ]
  };
  let selectedNoteId: string | null = null;
  let currentWavUrl: string | null = null;
  let currentDaemonCommit = '';
  let serverPresets: any[] = [];

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
  const inpPreset = document.getElementById('inp-preset') as HTMLSelectElement;
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
  const tilePeak = document.getElementById('tile-peak')!;
  const tileVoices = document.getElementById('tile-voices')!;
  const tileDuration = document.getElementById('tile-duration')!;
  const tileDurationSub = document.getElementById('tile-duration-sub')!;
  const telemetryOutput = document.getElementById('telemetry-output')!;
  const provCommit = document.getElementById('prov-commit')!;
  const provScore = document.getElementById('prov-score')!;
  const provWav = document.getElementById('prov-wav')!;
  const provConfig = document.getElementById('prov-config')!;
  const provenanceOutput = document.getElementById('provenance-output')!;

  // Banner
  const banner = document.getElementById('commit-mismatch-banner')!;
  const bannerText = document.getElementById('commit-mismatch-text')!;
  const btnBannerLoad = document.getElementById('btn-banner-load')!;
  const btnBannerRender = document.getElementById('btn-banner-render')!;
  const btnBannerDismiss = document.getElementById('btn-banner-dismiss')!;
  let pendingScoreToLoad: any = null;

  btnBannerDismiss.addEventListener('click', () => banner.style.display = 'none');
  btnBannerLoad.addEventListener('click', () => {
    if (pendingScoreToLoad) {
      score = pendingScoreToLoad;
      updateUI();
      showToast('Score loaded');
      pendingScoreToLoad = null;
    }
    banner.style.display = 'none';
  });
  btnBannerRender.addEventListener('click', async () => {
    if (pendingScoreToLoad) {
      score = pendingScoreToLoad;
      updateUI();
      pendingScoreToLoad = null;
      await doRender();
    }
    banner.style.display = 'none';
  });

  // Bank
  const bankList = document.getElementById('bank-list')!;
  const toastContainer = document.getElementById('toast-container')!;
  const btnCompare = document.getElementById('btn-compare') as HTMLButtonElement;
  const compareModal = document.getElementById('compare-modal')!;
  const btnCloseCompare = document.getElementById('btn-close-compare')!;
  const compareGrid = document.getElementById('compare-grid')!;
  let selectedForCompare: string[] = [];

  btnCloseCompare.addEventListener('click', () => compareModal.style.display = 'none');

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
        if (r.id === 'last') el.style.borderLeft = '3px solid var(--accent)';
        
        const dur = r.durationSec?.toFixed(2) || '0.00';
        const commit = r.commit?.substring(0,7) || 'unknown';
        const pinIcon = r.pinned ? '⭐' : '☆';
        const isChecked = selectedForCompare.includes(r.id) ? 'checked' : '';
        
        const nameInput = r.id === 'last' 
          ? `<span class="bank-item-name" style="display:inline-block; padding:2px 0;">${r.name}</span>`
          : `<input type="text" class="bank-item-name" value="${r.name}" data-id="${r.id}">`;

        const pinBtn = r.id === 'last' ? '' : `<button class="btn-bank-pin" data-id="${r.id}" data-pinned="${r.pinned ? 'true' : 'false'}" style="background:none;border:none;cursor:pointer;padding:0 0.5rem 0 0;">${pinIcon}</button>`;
        const delBtn = r.id === 'last' ? '' : `<button class="btn-bank-del" data-id="${r.id}">🗑</button>`;

        el.innerHTML = `
          <div class="bank-item-header">
            <input type="checkbox" class="bank-item-compare" data-id="${r.id}" ${isChecked} style="margin-right: 0.5rem;">
            ${pinBtn}
            ${nameInput}
          </div>
          <div class="bank-item-meta">
            <span>⏱ ${dur}s</span>
            <span class="hash">${commit}</span>
          </div>
          <div class="bank-item-actions">
            <button class="btn-bank-play" data-id="${r.id}">▶ Play</button>
            <button class="btn-bank-load" data-id="${r.id}" data-commit="${commit}">Load Score</button>
            ${delBtn}
          </div>
        `;
        bankList.appendChild(el);
      });

      // Bind events
      document.querySelectorAll('.bank-item-compare').forEach(cb => {
        cb.addEventListener('change', (e) => {
          const target = e.target as HTMLInputElement;
          const id = target.dataset.id!;
          if (target.checked) {
            if (selectedForCompare.length >= 2) {
              target.checked = false;
              showToast('Max 2 renders for compare');
              return;
            }
            selectedForCompare.push(id);
          } else {
            selectedForCompare = selectedForCompare.filter(x => x !== id);
          }
          btnCompare.textContent = `Compare (${selectedForCompare.length}/2)`;
          btnCompare.disabled = selectedForCompare.length !== 2;
        });
      });

      document.querySelectorAll('.btn-bank-pin').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const target = e.currentTarget as HTMLElement;
          const id = target.dataset.id;
          const pinned = target.dataset.pinned !== 'true';
          await fetch(`${DAEMON_URL}/api/renders/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned })
          });
          loadBank();
        });
      });

      document.querySelectorAll('input.bank-item-name').forEach(inp => {
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
          
          const res = await fetch(`${DAEMON_URL}/api/renders/${id}/score`);
          if (res.ok) {
            const loadedScore = await res.json();
            if (commit && currentDaemonCommit && commit !== currentDaemonCommit.substring(0,7)) {
              bannerText.textContent = `This render was created on commit ${commit}; you are on commit ${currentDaemonCommit.substring(0,7)}.`;
              banner.style.display = 'flex';
              pendingScoreToLoad = loadedScore;
            } else {
              score = loadedScore;
              updateUI();
              showToast('Score loaded');
            }
          }
        });
      });

      document.querySelectorAll('.btn-bank-del').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = (e.target as HTMLElement).dataset.id;
          await fetch(`${DAEMON_URL}/api/renders/${id}`, { method: 'DELETE' });
          selectedForCompare = selectedForCompare.filter(x => x !== id);
          btnCompare.textContent = `Compare (${selectedForCompare.length}/2)`;
          btnCompare.disabled = selectedForCompare.length !== 2;
          loadBank();
        });
      });

    } catch (e) {
      console.error('Failed to load bank', e);
    }
  }

  btnCompare.addEventListener('click', async () => {
    if (selectedForCompare.length !== 2) return;
    
    try {
      const [res1, res2] = await Promise.all([
        fetch(`${DAEMON_URL}/api/renders/${selectedForCompare[0]}/meta`),
        fetch(`${DAEMON_URL}/api/renders/${selectedForCompare[1]}/meta`)
      ]);
      
      const m1 = await res1.json();
      const m2 = await res2.json();
      
      // We need telemetry from the meta. Wait, is telemetry saved in meta?
      // Let's fetch telemetry.json
      const [t1Res, t2Res] = await Promise.all([
        fetch(`${DAEMON_URL}/api/renders/${selectedForCompare[0]}/telemetry`),
        fetch(`${DAEMON_URL}/api/renders/${selectedForCompare[1]}/telemetry`)
      ]);
      
      const t1 = t1Res.ok ? await t1Res.json() : {};
      const t2 = t2Res.ok ? await t2Res.json() : {};

      compareGrid.innerHTML = `
        <div class="compare-col">
          <h3>${m1.name}</h3>
          <div class="compare-stat"><span>Duration</span> <span>${m1.durationSec?.toFixed(2)}s</span></div>
          <div class="compare-stat"><span>Peak dBFS</span> <span>${t1.peakDbfs !== undefined ? t1.peakDbfs.toFixed(1) : '--'} dB</span></div>
          <div class="compare-stat"><span>Max Δ (Clicks)</span> <span>${t1.maxAbsDelta?.toFixed(4) || '--'}</span></div>
          <div class="compare-stat"><span>Max Voices</span> <span>${t1.voicesMax || '--'}</span></div>
          <div class="compare-stat"><span>Commit</span> <span class="hash">${m1.commit}</span></div>
          <button class="btn-bank-play" data-id="${m1.id}" style="margin-top: 1rem;">▶ Play A</button>
        </div>
        <div class="compare-col">
          <h3>${m2.name}</h3>
          <div class="compare-stat"><span>Duration</span> <span>${m2.durationSec?.toFixed(2)}s</span></div>
          <div class="compare-stat"><span>Peak dBFS</span> <span>${t2.peakDbfs !== undefined ? t2.peakDbfs.toFixed(1) : '--'} dB</span></div>
          <div class="compare-stat"><span>Max Δ (Clicks)</span> <span>${t2.maxAbsDelta?.toFixed(4) || '--'}</span></div>
          <div class="compare-stat"><span>Max Voices</span> <span>${t2.voicesMax || '--'}</span></div>
          <div class="compare-stat"><span>Commit</span> <span class="hash">${m2.commit}</span></div>
          <button class="btn-bank-play" data-id="${m2.id}" style="margin-top: 1rem;">▶ Play B</button>
        </div>
      `;
      
      compareGrid.querySelectorAll('.btn-bank-play').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = (e.target as HTMLElement).dataset.id;
          audioPlayer.src = `${DAEMON_URL}/api/renders/${id}/audio.wav`;
          audioPlayer.play();
        });
      });

      compareModal.style.display = 'flex';
    } catch (e) {
      console.error('Compare failed', e);
      showToast('Failed to load compare data');
    }
  });

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
      presetId: inpPreset.value,
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
      if (err.code === 'PRESET_NOT_FOUND') {
        const avail = err.available?.join(', ') || 'none';
        throw new Error(`Preset '${err.presetId}' not found on server. Available: [${avail}]`);
      }
      if (err.code === 'ASSET_NOT_FOUND') {
        throw new Error(`Preset asset missing on server: ${err.message}`);
      }
      throw new Error(err.error || err.message || 'Render failed');
    }
    
    const data = await res.json();
    
    // Telemetry
    const maxDelta = data.telemetry.maxAbsDelta || 0;
    tileClicks.querySelector('.value')!.textContent = maxDelta.toFixed(4);
    tileClicks.className = `tile ${maxDelta > 0.25 ? 'error' : (maxDelta > 0.15 ? 'warn' : 'ok')}`;
    
    const rtf = data.telemetry.rtf || 0;
    tileRtf.querySelector('.value')!.textContent = rtf > 0 ? rtf.toFixed(3) : '--';
    
    const peakDbfs = data.telemetry.peakDbfs ?? -Infinity;
    tilePeak.querySelector('.value')!.textContent = peakDbfs === -Infinity ? '-∞' : `${peakDbfs.toFixed(1)} dB`;
    tilePeak.className = `tile ${peakDbfs > -0.1 ? 'error' : (peakDbfs > -3 ? 'warn' : 'ok')}`;

    const voicesMax = data.telemetry.voicesMax || 0;
    tileVoices.querySelector('.value')!.textContent = voicesMax.toString();
    tileVoices.className = `tile ${voicesMax > config.maxPolyphony ? 'error' : (voicesMax === config.maxPolyphony ? 'warn' : 'ok')}`;

    const dur = data.telemetry.durationSec || 0;
    const notesEndSec = data.telemetry.notesEndSec || 0;
    const tail = data.telemetry.tailSec || 0;
    tileDuration.querySelector('.value')!.textContent = `${dur.toFixed(2)}s`;
    tileDurationSub.textContent = `(notes ${notesEndSec.toFixed(2)}s + tail ${tail.toFixed(2)}s)`;
    
    telemetryOutput.textContent = JSON.stringify(data.telemetry, null, 2);
    
    // Provenance
    provCommit.textContent = data.provenance.commit.substring(0, 7);
    provScore.textContent = data.provenance.scoreHash.substring(0, 8);
    provWav.textContent = data.provenance.wavHash.substring(0, 8);
    const c = data.provenance.config;
    provConfig.textContent = `SR: ${c.sampleRateHz} | Block: ${c.blockSize} | Poly: ${c.maxPolyphony} | Mode: ${c.deterministic}`;
    provenanceOutput.textContent = JSON.stringify(data.provenance, null, 2);
    
    // Audio
    if (currentWavUrl && currentWavUrl.startsWith('blob:')) URL.revokeObjectURL(currentWavUrl);
    
    // Add a cache-buster to the URL so the browser fetches the new last render
    currentWavUrl = `${DAEMON_URL}${data.audioUrl}?t=${Date.now()}`;
    audioPlayer.src = currentWavUrl;
    
    btnPlay.disabled = false;
    btnDownload.disabled = false;
    
    const renderTimeMs = data.telemetry.renderTimeMs || 0;
    statusStrip.textContent = `Rendered in ${renderTimeMs.toFixed(1)}ms | RTF: ${rtf.toFixed(3)}`;

    showToast(`Rendered ${dur.toFixed(2)}s`);
    loadBank(); // Refresh bank to show the updated "Last Render"
  }

  async function doSaveRender() {
    btnSaveRender.disabled = true;
    statusStrip.textContent = 'Saving render...';
    
    const name = prompt("Enter a name for this render:");
    if (name === null) {
      btnSaveRender.disabled = false;
      statusStrip.textContent = 'Ready';
      return;
    }

    const res = await fetch(`${DAEMON_URL}/api/renders/promote-last`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
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

  // --- Preset Loading ---
  async function loadPresets() {
    try {
      const res = await fetch(`${DAEMON_URL}/api/presets`);
      if (!res.ok) throw new Error('Failed to fetch presets');
      const data = await res.json();
      serverPresets = data.presets || [];

      const noVoicesBanner = document.getElementById('no-voices-banner');
      inpPreset.innerHTML = '';
      if (serverPresets.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(no voices on server)';
        inpPreset.appendChild(opt);
        if (noVoicesBanner) noVoicesBanner.style.display = '';
      } else {
        if (noVoicesBanner) noVoicesBanner.style.display = 'none';
        serverPresets.forEach((p: any) => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.name || p.id;
          inpPreset.appendChild(opt);
        });
        // Update timbre dropdown from first preset
        updateTimbreDropdown(serverPresets[0]);
      }
    } catch (e) {
      console.error('Failed to load presets', e);
    }
  }

  function updateTimbreDropdown(preset: any) {
    if (!preset?.timbres) return;
    // Update default timbre dropdown
    inpDefaultTimbre.innerHTML = '';
    preset.timbres.forEach((t: string) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      inpDefaultTimbre.appendChild(opt);
    });
    // Update inspector timbre dropdown
    inspTimbre.innerHTML = '<option value="">(Default)</option>';
    preset.timbres.forEach((t: string) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      inspTimbre.appendChild(opt);
    });
  }

  inpPreset.addEventListener('change', () => {
    const preset = serverPresets.find((p: any) => p.id === inpPreset.value);
    if (preset) {
      updateTimbreDropdown(preset);
      // Set timbre to voice's default
      if (preset.defaultTimbre && preset.timbres?.includes(preset.defaultTimbre)) {
        inpDefaultTimbre.value = preset.defaultTimbre;
      }
    }
  });

  // ============================================================
  // ── TAB SWITCHING ─────────────────────────────────────────
  // ============================================================

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = (btn as HTMLElement).dataset.tab!;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tabId}`)!.classList.add('active');
    });
  });

  // ============================================================
  // ── LIVE MODE ──────────────────────────────────────────────
  // ============================================================

  const btnLiveToggle = document.getElementById('btn-live-toggle') as HTMLButtonElement;
  const liveStatus = document.getElementById('live-status')!;
  const liveKeyboard = document.getElementById('live-keyboard')!;
  const liveTelemetry = document.getElementById('live-telemetry')!;
  const liveVoicesEl = document.getElementById('live-voices')!;
  const livePeakEl = document.getElementById('live-peak')!;
  const liveRtfEl = document.getElementById('live-rtf')!;
  const liveUnderrunsEl = document.getElementById('live-underruns')!;
  const liveClickDeltaEl = document.getElementById('live-click-delta')!;
  const liveJitterEl = document.getElementById('live-jitter')!;
  const liveAlerts = document.getElementById('live-alerts')!;
  const alertClipping = document.getElementById('alert-clipping')!;
  const alertClickRisk = document.getElementById('alert-click-risk')!;
  const alertBufferStarved = document.getElementById('alert-buffer-starved')!;

  // Live controls
  const livePresetSelect = document.getElementById('live-preset') as HTMLSelectElement;
  const liveTimbreSelect = document.getElementById('live-timbre') as HTMLSelectElement;
  const livePolyphonyInput = document.getElementById('live-polyphony') as HTMLInputElement;
  const liveVelocityInput = document.getElementById('live-velocity') as HTMLInputElement;
  const liveVelocityVal = document.getElementById('live-velocity-val')!;
  const liveBreathinessInput = document.getElementById('live-breathiness') as HTMLInputElement;
  const liveBreathinessVal = document.getElementById('live-breathiness-val')!;
  const liveVibratoInput = document.getElementById('live-vibrato') as HTMLInputElement;
  const liveVibratoVal = document.getElementById('live-vibrato-val')!;
  const livePortamentoInput = document.getElementById('live-portamento') as HTMLInputElement;
  const livePortamentoVal = document.getElementById('live-portamento-val')!;
  const liveLatencySelect = document.getElementById('live-latency') as HTMLSelectElement;
  const liveLimiterCheck = document.getElementById('live-limiter') as HTMLInputElement;

  // Action buttons
  const btnPanic = document.getElementById('btn-panic') as HTMLButtonElement;
  const btnRecord = document.getElementById('btn-record') as HTMLButtonElement;
  const btnHold = document.getElementById('btn-hold') as HTMLButtonElement;

  let liveWs: WebSocket | null = null;
  let liveAudioCtx: AudioContext | null = null;
  let liveWorkletNode: AudioWorkletNode | null = null;
  let liveConnected = false;
  let liveUnderrunCount = 0;
  let liveLastSeq = -1;
  let liveDroppedFrames = 0;
  let liveBlockSize = 512; // updated from hello_ack
  let liveLastFrameTime = 0; // for WS jitter calc
  let liveJitterSamples: number[] = []; // recent inter-arrival deltas
  let activeKeys = new Set<string>(); // noteIds currently held
  let holdActive = false;
  let heldNoteOffs: string[] = []; // queued note_off noteIds while Hold is active
  let isRecording = false;

  // MIDI input
  const midiInputSelect = document.getElementById('midi-input') as HTMLSelectElement;
  const midiStatus = document.getElementById('midi-status')!;
  const midiChannelInput = document.getElementById('midi-channel') as HTMLInputElement;
  let midiAccess: any = null; // WebMidi.MIDIAccess
  let activeMidiInput: any = null; // WebMidi.MIDIInput
  let midiFlashTimeout: number | null = null;

  // Metronome
  const metroToggle = document.getElementById('metro-toggle') as HTMLInputElement;
  const metroBpm = document.getElementById('metro-bpm') as HTMLInputElement;
  const metroBeats = document.getElementById('metro-beats') as HTMLSelectElement;
  const metroQuantize = document.getElementById('metro-quantize') as HTMLInputElement;
  const metroGrid = document.getElementById('metro-grid') as HTMLSelectElement;
  let metronomeOn = false;
  let metronomeTimerId: number | null = null;
  let metronomeNextBeatTime = 0;
  let metronomeCurrentBeat = 0;

  // XY Pad
  const xyPad = document.getElementById('xy-pad') as HTMLCanvasElement;
  const xyReadout = document.getElementById('xy-readout')!;
  let xyDragging = false;
  let xyTimbreNames: string[] = [];
  let xyX = 0; // 0..1
  let xyY = 0; // 0..1
  let xyLastSendTime = 0;

  // Latency
  const latencyBar = document.getElementById('latency-bar')!;
  const btnTapTest = document.getElementById('btn-tap-test') as HTMLButtonElement;
  const latRtt = document.getElementById('lat-rtt')!;
  const latAudio = document.getElementById('lat-audio')!;
  const latTotal = document.getElementById('lat-total')!;
  let pingRtts: number[] = [];
  let pingPending = 0;

  // ── Latency target ─────────────────────────────────────────

  function getLatencyTargetSamples(): number {
    // Target fill samples at 48kHz for the selected latency preset
    switch (liveLatencySelect.value) {
      case 'low': return 2880;       // ~60ms
      case 'balanced': return 4800;  // ~100ms
      case 'safe': return 7200;      // ~150ms
      default: return 4800;
    }
  }

  function getLatencyTargetMs(): number {
    switch (liveLatencySelect.value) {
      case 'low': return 60;
      case 'balanced': return 100;
      case 'safe': return 150;
      default: return 100;
    }
  }

  liveLatencySelect.addEventListener('change', () => {
    if (liveWorkletNode) {
      liveWorkletNode.port.postMessage({
        type: 'setTargetBuffer',
        samples: getLatencyTargetSamples(),
      });
    }
  });

  liveLimiterCheck.addEventListener('change', () => {
    if (liveWs && liveWs.readyState === WebSocket.OPEN) {
      liveWs.send(JSON.stringify({
        type: 'param_update',
        limiter: liveLimiterCheck.checked,
      }));
    }
  });

  // ── Slider value displays ──────────────────────────────────

  liveVelocityInput.addEventListener('input', () => {
    liveVelocityVal.textContent = parseFloat(liveVelocityInput.value).toFixed(2);
  });
  liveBreathinessInput.addEventListener('input', () => {
    liveBreathinessVal.textContent = parseFloat(liveBreathinessInput.value).toFixed(2);
  });
  liveVibratoInput.addEventListener('input', () => {
    liveVibratoVal.textContent = `${liveVibratoInput.value} ct`;
  });
  livePortamentoInput.addEventListener('input', () => {
    livePortamentoVal.textContent = `${livePortamentoInput.value} ms`;
  });

  // ── Live preset/timbre sync ────────────────────────────────

  const voiceInfo = document.getElementById('voice-info')!;

  function populateLivePresets() {
    livePresetSelect.innerHTML = '';
    if (serverPresets.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(none)';
      livePresetSelect.appendChild(opt);
      voiceInfo.textContent = '';
      return;
    }
    serverPresets.forEach((p: any) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name || p.id;
      livePresetSelect.appendChild(opt);
    });
    updateLiveTimbreDropdown(serverPresets[0]);
    updateVoiceInfo(serverPresets[0]);
  }

  function updateVoiceInfo(preset: any) {
    if (!preset) { voiceInfo.textContent = ''; return; }
    let html = preset.description || '';
    if (preset.tags && preset.tags.length > 0) {
      html += '<span class="voice-tags">';
      for (const tag of preset.tags) {
        html += `<span class="voice-tag">${tag}</span>`;
      }
      html += '</span>';
    }
    voiceInfo.innerHTML = html;
  }

  function updateLiveTimbreDropdown(preset: any) {
    if (!preset?.timbres) return;
    liveTimbreSelect.innerHTML = '';
    preset.timbres.forEach((t: string) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      liveTimbreSelect.appendChild(opt);
    });
  }

  livePresetSelect.addEventListener('change', () => {
    const preset = serverPresets.find((p: any) => p.id === livePresetSelect.value);
    if (preset) {
      updateLiveTimbreDropdown(preset);
      updateVoiceInfo(preset);
      // Set timbre to voice's default if current timbre not available
      const timbres: string[] = preset.timbres || [];
      if (timbres.length > 0 && !timbres.includes(liveTimbreSelect.value)) {
        liveTimbreSelect.value = preset.defaultTimbre || timbres[0];
      }
    }
    sendParamUpdate();
  });
  liveTimbreSelect.addEventListener('change', sendParamUpdate);
  livePolyphonyInput.addEventListener('change', sendParamUpdate);

  function sendParamUpdate() {
    if (!liveWs || !liveConnected) return;
    liveWs.send(JSON.stringify({
      type: 'param_update',
      presetId: livePresetSelect.value || undefined,
      defaultTimbre: liveTimbreSelect.value || undefined,
      maxPolyphony: parseInt(livePolyphonyInput.value, 10),
    }));
  }

  // ── DAW Keyboard mapping (Z/X row = C4-B4, Q/W row = C5-B5) ──

  // Bottom row: Z S X D C V G B H N J M  (C4 through B4, chromatic)
  // Top row:    Q 2 W 3 E R 5 T 6 Y 7 U  (C5 through B5, chromatic)
  const KEY_MAP: Record<string, number> = {
    // Lower octave (C4=60 to B4=71)
    'z': 60, 's': 61, 'x': 62, 'd': 63, 'c': 64, 'v': 65,
    'g': 66, 'b': 67, 'h': 68, 'n': 69, 'j': 70, 'm': 71,
    // Upper octave (C5=72 to B5=83)
    'q': 72, '2': 73, 'w': 74, '3': 75, 'e': 76, 'r': 77,
    '5': 78, 't': 79, '6': 80, 'y': 81, '7': 82, 'u': 83,
  };

  // Note names for display
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  function midiNoteName(midi: number) {
    return NOTE_NAMES[midi % 12] + Math.floor(midi / 12 - 1);
  }
  function isBlackKey(midi: number) {
    return [1,3,6,8,10].includes(midi % 12);
  }

  // Render keyboard
  function renderLiveKeyboard() {
    liveKeyboard.innerHTML = '';
    const keyEntries = Object.entries(KEY_MAP).sort((a,b) => a[1] - b[1]);

    for (const [key, midi] of keyEntries) {
      const el = document.createElement('div');
      const black = isBlackKey(midi);
      el.className = `key ${black ? 'black' : 'white'}`;
      el.dataset.midi = String(midi);
      el.dataset.key = key;
      el.innerHTML = `<span>${midiNoteName(midi)}<br><small>${key.toUpperCase()}</small></span>`;

      // Mouse events
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        triggerNoteOn(key, midi);
      });
      el.addEventListener('mouseup', () => triggerNoteOff(key));
      el.addEventListener('mouseleave', () => {
        if (activeKeys.has(`key-${key}`)) triggerNoteOff(key);
      });

      liveKeyboard.appendChild(el);
    }
  }
  renderLiveKeyboard();

  function triggerNoteOn(key: string, midi: number, velocityOverride?: number) {
    const noteId = `key-${key}`;
    if (activeKeys.has(noteId)) return;
    activeKeys.add(noteId);

    const el = liveKeyboard.querySelector(`[data-key="${key}"]`);
    if (el) el.classList.add('active');

    const sendNote = () => {
      if (liveWs && liveConnected) {
        liveWs.send(JSON.stringify({
          type: 'note_on',
          noteId,
          midi,
          velocity: velocityOverride ?? parseFloat(liveVelocityInput.value),
          breathiness: parseFloat(liveBreathinessInput.value) || undefined,
          vibrato: parseInt(liveVibratoInput.value, 10) > 0
            ? { depthCents: parseInt(liveVibratoInput.value, 10), rateHz: 5.5, onsetSec: 0.15 }
            : undefined,
          portamentoMs: parseInt(livePortamentoInput.value, 10) || undefined,
          timbre: liveTimbreSelect.value || undefined,
        }));
      }
    };

    // Quantize if metronome quantization is active
    if (metronomeOn && metroQuantize.checked && liveAudioCtx) {
      const bpm = parseInt(metroBpm.value, 10) || 120;
      const gridDiv = parseInt(metroGrid.value, 10) || 4;
      const gridSec = 60 / bpm / (gridDiv / 4);
      const now = liveAudioCtx.currentTime;
      const gridPos = now / gridSec;
      const nextGrid = Math.ceil(gridPos) * gridSec;
      const delayMs = (nextGrid - now) * 1000;
      if (delayMs > gridSec * 500) {
        // Close enough to current grid — send immediately
        sendNote();
      } else {
        setTimeout(sendNote, delayMs);
      }
    } else {
      sendNote();
    }
  }

  function triggerNoteOff(key: string) {
    const noteId = `key-${key}`;
    if (!activeKeys.has(noteId)) return;

    if (holdActive) {
      heldNoteOffs.push(noteId);
      return;
    }

    activeKeys.delete(noteId);
    const el = liveKeyboard.querySelector(`[data-key="${key}"]`);
    if (el) el.classList.remove('active');

    if (liveWs && liveConnected) {
      liveWs.send(JSON.stringify({ type: 'note_off', noteId }));
    }
  }

  function flushHeldNotes() {
    for (const noteId of heldNoteOffs) {
      activeKeys.delete(noteId);
      const key = noteId.replace('key-', '');
      const el = liveKeyboard.querySelector(`[data-key="${key}"]`);
      if (el) el.classList.remove('active');
      if (liveWs && liveConnected) {
        liveWs.send(JSON.stringify({ type: 'note_off', noteId }));
      }
    }
    heldNoteOffs = [];
  }

  // Keyboard events (only when not in inputs)
  function isLiveTabActive() {
    return document.getElementById('tab-live')?.classList.contains('active') ?? false;
  }

  window.addEventListener('keydown', (e) => {
    if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA' || document.activeElement?.tagName === 'SELECT') return;
    if (e.repeat) return;
    if (!isLiveTabActive()) return;

    const midi = KEY_MAP[e.key.toLowerCase()];
    if (midi !== undefined && liveConnected) {
      e.preventDefault();
      triggerNoteOn(e.key.toLowerCase(), midi);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (!isLiveTabActive()) return;
    const key = e.key.toLowerCase();
    if (KEY_MAP[key] !== undefined) {
      triggerNoteOff(key);
    }
  });

  // ── Action buttons ─────────────────────────────────────────

  btnPanic.addEventListener('click', () => {
    if (!liveWs || !liveConnected) return;
    liveWs.send(JSON.stringify({ type: 'transport', command: 'panic' }));
    for (const noteId of activeKeys) {
      const key = noteId.replace('key-', '');
      const el = liveKeyboard.querySelector(`[data-key="${key}"]`);
      if (el) el.classList.remove('active');
    }
    activeKeys.clear();
    heldNoteOffs = [];
    showToast('Panic sent — all notes off');
  });

  btnRecord.addEventListener('click', () => {
    if (!liveWs || !liveConnected) return;
    isRecording = !isRecording;
    if (isRecording) {
      liveWs.send(JSON.stringify({ type: 'record_start' }));
      btnRecord.textContent = 'Stop Rec';
      btnRecord.style.background = 'var(--error)';
      btnRecord.style.color = '#fff';
    } else {
      const name = prompt('Name this take (or leave blank for auto-name):');
      liveWs.send(JSON.stringify({
        type: 'record_stop',
        name: name?.trim() || undefined,
      }));
      btnRecord.textContent = 'Record';
      btnRecord.style.background = '';
      btnRecord.style.color = '';
    }
  });

  btnHold.addEventListener('click', () => {
    holdActive = !holdActive;
    if (holdActive) {
      btnHold.classList.add('held');
      btnHold.textContent = 'Hold ON';
    } else {
      btnHold.classList.remove('held');
      btnHold.textContent = 'Hold';
      flushHeldNotes();
    }
  });

  // ── MIDI Input ───────────────────────────────────────────────

  function populateMidiInputs() {
    if (!midiAccess) return;
    const prev = midiInputSelect.value;
    midiInputSelect.innerHTML = '<option value="">None</option>';
    for (const [id, input] of midiAccess.inputs) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = (input as any).name || id;
      midiInputSelect.appendChild(opt);
    }
    if (prev) midiInputSelect.value = prev;
  }

  function handleMidiMessage(e: any) {
    const data = e.data as Uint8Array;
    if (!data || data.length < 3) return;

    const status = data[0] & 0xF0;
    const channel = data[0] & 0x0F;
    const filterCh = parseInt(midiChannelInput.value, 10);
    if (filterCh > 0 && channel !== filterCh) return;

    const midi = data[1];
    const vel = data[2];

    if (status === 0x90 && vel > 0) {
      // Note On
      triggerNoteOn(`midi-${midi}`, midi, vel / 127);
      flashMidiBadge();
    } else if (status === 0x80 || (status === 0x90 && vel === 0)) {
      // Note Off
      triggerNoteOff(`midi-${midi}`);
    }
  }

  function flashMidiBadge() {
    midiStatus.className = 'midi-badge flash';
    if (midiFlashTimeout) clearTimeout(midiFlashTimeout);
    midiFlashTimeout = window.setTimeout(() => {
      midiStatus.className = activeMidiInput ? 'midi-badge on' : 'midi-badge off';
    }, 100);
  }

  midiInputSelect.addEventListener('change', () => {
    if (activeMidiInput) {
      activeMidiInput.onmidimessage = null;
      activeMidiInput = null;
    }
    const id = midiInputSelect.value;
    if (id && midiAccess) {
      activeMidiInput = midiAccess.inputs.get(id);
      if (activeMidiInput) {
        activeMidiInput.onmidimessage = handleMidiMessage;
        midiStatus.textContent = 'MIDI OK';
        midiStatus.className = 'midi-badge on';
      }
    } else {
      midiStatus.textContent = 'No MIDI';
      midiStatus.className = 'midi-badge off';
    }
  });

  // Init MIDI (independent of WS connection)
  if ((navigator as any).requestMIDIAccess) {
    (navigator as any).requestMIDIAccess().then((access: any) => {
      midiAccess = access;
      populateMidiInputs();
      access.onstatechange = () => populateMidiInputs();
    }).catch(() => {
      console.warn('[midi] Web MIDI not available');
    });
  }

  // ── Metronome ──────────────────────────────────────────────

  function scheduleMetronomeClick(time: number, isDownbeat: boolean) {
    if (!liveAudioCtx) return;
    const osc = liveAudioCtx.createOscillator();
    const gain = liveAudioCtx.createGain();
    osc.connect(gain).connect(liveAudioCtx.destination);
    osc.frequency.value = isDownbeat ? 1000 : 800;
    gain.gain.setValueAtTime(0.3, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    osc.start(time);
    osc.stop(time + 0.05);
  }

  function startMetronome() {
    if (!liveAudioCtx) return;
    metronomeCurrentBeat = 0;
    metronomeNextBeatTime = liveAudioCtx.currentTime + 0.05; // small initial delay
    metronomeScheduler();
  }

  function metronomeScheduler() {
    if (!metronomeOn || !liveAudioCtx) return;
    const bpm = parseInt(metroBpm.value, 10) || 120;
    const beatCount = parseInt(metroBeats.value, 10) || 4;
    const beatDuration = 60 / bpm;
    const lookahead = 0.1; // 100ms

    while (metronomeNextBeatTime < liveAudioCtx.currentTime + lookahead) {
      const isDownbeat = metronomeCurrentBeat % beatCount === 0;
      scheduleMetronomeClick(metronomeNextBeatTime, isDownbeat);
      metronomeNextBeatTime += beatDuration;
      metronomeCurrentBeat++;
    }

    metronomeTimerId = window.setTimeout(metronomeScheduler, 25);
  }

  function stopMetronome() {
    if (metronomeTimerId !== null) {
      clearTimeout(metronomeTimerId);
      metronomeTimerId = null;
    }
  }

  metroToggle.addEventListener('change', () => {
    metronomeOn = metroToggle.checked;
    if (metronomeOn && liveAudioCtx) {
      startMetronome();
    } else {
      stopMetronome();
    }
  });

  metroQuantize.addEventListener('change', () => {
    metroGrid.disabled = !metroQuantize.checked;
  });

  // ── XY Pad (Timbre Morph + Breathiness) ────────────────────

  function computeTimbreWeights(x: number): Record<string, number> {
    const names = xyTimbreNames;
    const n = names.length;
    const weights: Record<string, number> = {};
    if (n === 0) return weights;
    if (n === 1) { weights[names[0]] = 1; return weights; }

    // Map X across [0, n-1] range, blend two adjacent timbres
    const pos = x * (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, n - 1);
    const frac = pos - lo;

    for (let i = 0; i < n; i++) {
      if (i === lo && i === hi) weights[names[i]] = 1;
      else if (i === lo) weights[names[i]] = 1 - frac;
      else if (i === hi) weights[names[i]] = frac;
      else weights[names[i]] = 0;
    }
    return weights;
  }

  function drawXyPad() {
    const ctx = xyPad.getContext('2d')!;
    const w = xyPad.width;
    const h = xyPad.height;
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);

    // Grid lines at timbre boundaries
    const n = xyTimbreNames.length;
    if (n > 1) {
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
      for (let i = 1; i < n; i++) {
        const x = (i / (n - 1)) * w;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }

    // Timbre labels along bottom
    ctx.fillStyle = '#555';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? w / 2 : (i / (n - 1)) * w;
      ctx.fillText(xyTimbreNames[i], x, h - 4);
    }

    // Breathiness label
    ctx.fillStyle = '#444';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('breath', 4, 12);

    // Crosshair
    const cx = xyX * w;
    const cy = (1 - xyY) * h; // Y inverted (0=bottom)
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();

    // Dot
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'var(--accent)';
    ctx.fillStyle = '#e8a838';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function updateXyPad(clientX: number, clientY: number) {
    const rect = xyPad.getBoundingClientRect();
    xyX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    xyY = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height)); // invert

    // Update breathiness slider to match
    liveBreathinessInput.value = xyY.toFixed(2);
    liveBreathinessVal.textContent = xyY.toFixed(2);

    // Compute weights and update readout
    const weights = computeTimbreWeights(xyX);
    const readoutParts: string[] = [];
    for (const [name, w] of Object.entries(weights)) {
      if (w > 0.01) readoutParts.push(`${name}: ${w.toFixed(2)}`);
    }
    xyReadout.textContent = readoutParts.join(' | ') || '--';

    drawXyPad();

    // Send to server (throttle to 30 Hz)
    const now = performance.now();
    if (now - xyLastSendTime > 33 && liveWs && liveConnected) {
      xyLastSendTime = now;
      liveWs.send(JSON.stringify({ type: 'timbre_morph', weights }));
    }
  }

  xyPad.addEventListener('pointerdown', (e) => {
    xyDragging = true;
    xyPad.setPointerCapture(e.pointerId);
    updateXyPad(e.clientX, e.clientY);
  });
  xyPad.addEventListener('pointermove', (e) => {
    if (!xyDragging) return;
    updateXyPad(e.clientX, e.clientY);
  });
  xyPad.addEventListener('pointerup', () => { xyDragging = false; });
  xyPad.addEventListener('pointerleave', () => { xyDragging = false; });

  // Initial draw
  drawXyPad();

  // ── Latency Calibration ────────────────────────────────────

  function sendPingBurst(count: number) {
    pingRtts = [];
    pingPending = count;
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        if (liveWs && liveConnected) {
          liveWs.send(JSON.stringify({
            type: 'ping',
            clientTimestamp: performance.now(),
          }));
        }
      }, i * 200);
    }
  }

  function handlePong(msg: any) {
    const rtt = performance.now() - msg.clientTimestamp;
    pingRtts.push(rtt);
    pingPending--;

    if (pingPending <= 0) {
      const avgRtt = pingRtts.reduce((a, b) => a + b, 0) / pingRtts.length;
      latRtt.textContent = avgRtt.toFixed(1);

      // Audio pipeline latency: device + OS buffer + server block + ring buffer target
      let audioMs = 0;
      if (liveAudioCtx) {
        audioMs = (
          (liveAudioCtx.baseLatency || 0) +
          (liveAudioCtx.outputLatency || 0)
        ) * 1000
        + (liveBlockSize / 48000) * 1000  // server render block
        + getLatencyTargetMs();            // ring buffer fill target
      }
      latAudio.textContent = audioMs.toFixed(1);

      // Total = one-way network + ~1ms server render + audio pipeline
      const total = (avgRtt / 2) + 1 + audioMs;
      latTotal.textContent = total.toFixed(1);
    }
  }

  btnTapTest.addEventListener('click', () => {
    if (!liveWs || !liveConnected) return;
    sendPingBurst(5);
  });

  // ── Live connection ────────────────────────────────────────

  async function connectLive() {
    if (liveWs) disconnectLive();

    liveStatus.textContent = 'Connecting...';
    liveStatus.className = 'live-badge connecting';

    // Init AudioContext + AudioWorklet
    liveAudioCtx = new AudioContext({ sampleRate: 48000 });
    try {
      await liveAudioCtx.audioWorklet.addModule('/pcm-worklet.js');
    } catch (err) {
      console.error('Failed to load AudioWorklet:', err);
      showToast('Failed to load audio worklet');
      liveStatus.textContent = 'Error';
      liveStatus.className = 'live-badge off';
      return;
    }

    liveWorkletNode = new AudioWorkletNode(liveAudioCtx, 'pcm-worklet-processor');
    liveWorkletNode.connect(liveAudioCtx.destination);

    liveWorkletNode.port.onmessage = (e) => {
      if (e.data.type === 'underrun') {
        liveUnderrunCount = e.data.count;
        liveUnderrunsEl.textContent = String(liveUnderrunCount);
        // Flash underruns tile red briefly
        const tile = document.getElementById('lt-underruns');
        if (tile) {
          tile.style.borderColor = '#f44';
          setTimeout(() => { tile.style.borderColor = ''; }, 300);
        }
      }
    };

    // WebSocket
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    liveWs = new WebSocket(`${proto}//${location.host}/ws`);
    liveWs.binaryType = 'arraybuffer';

    liveWs.addEventListener('open', () => {
      liveWs!.send(JSON.stringify({ type: 'hello', protocolVersion: 1 }));
    });

    liveWs.addEventListener('message', (e) => {
      if (e.data instanceof ArrayBuffer) {
        // Binary = framed audio (16-byte header + PCM payload)
        const HEADER = 16;
        if (e.data.byteLength <= HEADER) return; // malformed

        const view = new DataView(e.data);
        const seq = view.getUint32(0, true);
        // channels (offset 4), sampleRate (offset 8), blockSize (offset 12)
        // available if needed; session params already in hello_ack

        // Gap detection
        if (liveLastSeq >= 0 && seq !== liveLastSeq + 1) {
          const gap = seq - liveLastSeq - 1;
          liveDroppedFrames += gap;
          console.warn(`[live] Dropped ${gap} frame(s) (seq ${liveLastSeq} → ${seq})`);
        }
        liveLastSeq = seq;

        // WS jitter: track inter-arrival time variance
        const now = performance.now();
        if (liveLastFrameTime > 0) {
          const delta = now - liveLastFrameTime;
          liveJitterSamples.push(delta);
          if (liveJitterSamples.length > 100) liveJitterSamples.shift();
        }
        liveLastFrameTime = now;

        // Extract PCM payload after header
        const pcm = new Float32Array(e.data, HEADER);
        if (liveWorkletNode) {
          liveWorkletNode.port.postMessage(pcm, [pcm.buffer]);
        }
        return;
      }

      // Text = JSON message
      try {
        const msg = JSON.parse(e.data);
        handleLiveMessage(msg);
      } catch (err) {
        console.error('[live] Bad message:', err);
      }
    });

    liveWs.addEventListener('close', () => {
      liveConnected = false;
      liveStatus.textContent = 'Disconnected';
      liveStatus.className = 'live-badge off';
      liveTelemetry.style.display = 'none';
      liveAlerts.style.display = 'none';
      btnLiveToggle.textContent = 'Connect Live';
      setLiveButtonsEnabled(false);
    });

    liveWs.addEventListener('error', () => {
      showToast('Live connection error');
    });
  }

  function disconnectLive() {
    for (const noteId of activeKeys) {
      const key = noteId.replace('key-', '');
      const el = liveKeyboard.querySelector(`[data-key="${key}"]`);
      if (el) el.classList.remove('active');
    }
    activeKeys.clear();
    heldNoteOffs = [];
    holdActive = false;
    btnHold.classList.remove('held');
    btnHold.textContent = 'Hold';
    isRecording = false;
    btnRecord.textContent = 'Record';
    btnRecord.style.background = '';
    btnRecord.style.color = '';

    // Stop metronome
    stopMetronome();
    metronomeOn = false;
    metroToggle.checked = false;

    if (liveWs) { liveWs.close(); liveWs = null; }
    if (liveWorkletNode) { liveWorkletNode.disconnect(); liveWorkletNode = null; }
    if (liveAudioCtx) { liveAudioCtx.close(); liveAudioCtx = null; }
    liveConnected = false;
    liveUnderrunCount = 0;
    liveLastSeq = -1;
    liveDroppedFrames = 0;
    liveLastFrameTime = 0;
    liveJitterSamples = [];
    liveStatus.textContent = 'Disconnected';
    liveStatus.className = 'live-badge off';
    liveTelemetry.style.display = 'none';
    liveAlerts.style.display = 'none';
    latencyBar.style.display = 'none';
    btnLiveToggle.textContent = 'Connect Live';
    setLiveButtonsEnabled(false);
  }

  function setLiveButtonsEnabled(on: boolean) {
    btnPanic.disabled = !on;
    btnRecord.disabled = !on;
    btnHold.disabled = !on;
  }

  function handleLiveMessage(msg: any) {
    switch (msg.type) {
      case 'hello_ack':
        liveConnected = true;
        liveBlockSize = msg.blockSize || 512;
        liveStatus.textContent = `Live (${msg.presetId})`;
        liveStatus.className = 'live-badge on';
        liveTelemetry.style.display = 'grid';
        latencyBar.style.display = 'flex';
        btnLiveToggle.textContent = 'Disconnect';
        setLiveButtonsEnabled(true);
        // Store timbres for XY pad
        xyTimbreNames = msg.timbres || [];
        drawXyPad();
        // Set ring buffer target from latency selector
        if (liveWorkletNode) {
          liveWorkletNode.port.postMessage({
            type: 'setTargetBuffer',
            samples: getLatencyTargetSamples(),
          });
        }
        // Auto-measure latency
        sendPingBurst(3);
        showToast(`Live connected: ${msg.timbres.join(', ')} @ ${msg.sampleRateHz}Hz, block=${liveBlockSize}`);
        break;

      case 'telemetry': {
        const peakDb = msg.peakDbfs;
        const peak = peakDb === -Infinity || peakDb === null
          ? '--' : `${peakDb.toFixed(1)}`;
        const clickDelta = msg.clickDeltaMaxRecent ?? 0;

        liveVoicesEl.textContent = `${msg.voicesActive}/${msg.voicesMax}`;
        livePeakEl.textContent = peak;
        liveRtfEl.textContent = msg.rtf?.toFixed(3) || '--';
        liveClickDeltaEl.textContent = clickDelta > 0 ? clickDelta.toFixed(4) : '--';

        // WS jitter: stddev of recent inter-arrival times
        if (liveJitterSamples.length > 2) {
          const mean = liveJitterSamples.reduce((a, b) => a + b, 0) / liveJitterSamples.length;
          const variance = liveJitterSamples.reduce((s, v) => s + (v - mean) ** 2, 0) / liveJitterSamples.length;
          liveJitterEl.textContent = `${Math.sqrt(variance).toFixed(1)}ms`;
        }

        // ── Alert badges ──
        liveAlerts.style.display = 'flex';

        // CLIPPING: peak > -0.1 dBFS
        const isClipping = typeof peakDb === 'number' && peakDb > -0.1;
        alertClipping.style.display = isClipping ? '' : 'none';

        // CLICK RISK: clickDelta > 0.3 (sample-to-sample jump threshold)
        const isClickRisk = clickDelta > 0.3;
        alertClickRisk.style.display = isClickRisk ? '' : 'none';

        // BUFFER STARVED: any underruns since connect
        alertBufferStarved.style.display = liveUnderrunCount > 0 ? '' : 'none';

        break;
      }

      case 'error':
        console.error('[live] Server error:', msg.code, msg.message);
        showToast(`Live error: ${msg.message}`);
        break;

      case 'note_ack':
        if (msg.stolen) {
          showToast(`Voice stolen for ${msg.noteId}`);
        }
        break;

      case 'record_status':
        if (!msg.recording && isRecording) {
          // Server auto-stopped recording (e.g. hit 60s cap)
          isRecording = false;
          btnRecord.textContent = 'Record';
          btnRecord.style.background = '';
          btnRecord.style.color = '';
        }
        break;

      case 'record_saved':
        showToast(`Saved: ${msg.name} (${msg.durationSec.toFixed(1)}s)`);
        loadBank(); // refresh render bank
        break;

      case 'pong':
        handlePong(msg);
        break;
    }
  }

  btnLiveToggle.addEventListener('click', () => {
    if (liveConnected || liveWs) {
      disconnectLive();
    } else {
      connectLive();
    }
  });

  // Init
  updateUI();
  loadPresets().then(() => populateLivePresets());
  loadBank();
