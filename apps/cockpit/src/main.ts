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

      inpPreset.innerHTML = '';
      if (serverPresets.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(no presets on server)';
        inpPreset.appendChild(opt);
        showToast('⚠ No presets found on server');
      } else {
        serverPresets.forEach((p: any) => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = `${p.id} (${(p.timbres || []).join(', ')})`;
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
    if (preset) updateTimbreDropdown(preset);
  });

  // Init
  updateUI();
  loadPresets();
  loadBank();
