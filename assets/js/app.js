'use strict';

// Tablet portrait widths were too cramped for the three-column desktop shell.
// Treat phones and tablets as the touch-first UI until there is enough room.
const MOBILE_TABLET_QUERY = '(max-width: 1024px)';
function isMobileTabletUI() {
  return window.matchMedia ? window.matchMedia(MOBILE_TABLET_QUERY).matches : window.innerWidth <= 1024;
}

// ─── AUDIO ENGINE ───────────────────────────────────────────────────────────
let audioCtx = null;
let masterGain = null;
let playing = false;
let audioNodes = {};   // id -> { source, gainNode, lfoNode, filter, ... }
let previewAudioActive = false;
let previewSavedCtx = null;
let previewSavedMaster = null;
let currentMasterProfile = 'cinematic';

function isAudioEngineActive() {
  return playing || previewAudioActive;
}

// v4.3: optional real local samples. AudioBuffers live only in the current session
// so the app remains offline-first, privacy-safe and GitHub Pages compatible.
const sampleOverrides = new Map(); // soundId -> AudioBuffer
const sampleFileNames = new Map(); // soundId -> original filename
let hybridBlend = 0.55; // 0 = sample limpio, 1 = sample + textura procedural cinematica

// Overrideable synth families upgraded by the realistic engine below.
let synthRain, synthWind, synthFire, synthWaves, synthThunder, synthDrip, synthSteps, synthCreak, synthHeartbeat, synthCrowd, synthBirds, synthCricket;


let reverbNode = null, reverbWet = null, reverbDry = null, lpMaster = null, hpMaster = null, analyser = null;

function getHybridBlend() {
  const el = document.getElementById('hybrid-blend-slider') || document.getElementById('hybrid-blend-slider-m');
  const raw = el ? Number(el.value) : Math.round(hybridBlend * 100);
  return Math.max(0, Math.min(1, (Number.isFinite(raw) ? raw : 55) / 100));
}

function setHybridBlend(value) {
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  hybridBlend = n / 100;
  ['hybrid-blend-slider', 'hybrid-blend-slider-m'].forEach(id => {
    const el = document.getElementById(id);
    if (el && Number(el.value) !== n) el.value = String(n);
  });
  ['hybrid-blend-val', 'hybrid-blend-val-m'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(n);
  });
  Object.values(audioNodes).forEach(nodes => {
    if (!nodes || !nodes._hybrid) return;
    const now = audioCtx ? audioCtx.currentTime : 0;
    if (nodes.sampleBus) nodes.sampleBus.gain.setTargetAtTime(0.78 + hybridBlend * 0.22, now, 0.08);
    if (nodes.textureBus) nodes.textureBus.gain.setTargetAtTime(hybridBlend * 0.28, now, 0.08);
    if (nodes.airBus) nodes.airBus.gain.setTargetAtTime(hybridBlend * 0.12, now, 0.08);
  });
}


function makeImpulseResponse(seconds, decay) {
  const rate = audioCtx.sampleRate;
  const len = Math.floor(rate * seconds);
  const impulse = audioCtx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return impulse;
}

function ensureAudio() {
  if (audioCtx) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    showToast('Tu navegador no soporta Web Audio API');
    return false;
  }
  try {
    audioCtx = new AC();

    // Master chain: [layers] -> masterGain -> hpMaster -> lpMaster -> {dry + reverb} -> compressor -> analyser -> destination
    masterGain = audioCtx.createGain();
    const sliderVal = +document.getElementById('master-slider').value;
    masterGain.gain.value = sliderVal / 100;

    hpMaster = audioCtx.createBiquadFilter();
    hpMaster.type = 'highpass';
    hpMaster.frequency.value = 20;

    lpMaster = audioCtx.createBiquadFilter();
    lpMaster.type = 'lowpass';
    lpMaster.frequency.value = 20000;

    reverbNode = audioCtx.createConvolver();
    reverbNode.buffer = makeImpulseResponse(3.5, 3);
    reverbWet = audioCtx.createGain();
    reverbWet.gain.value = 0.0;
    reverbDry = audioCtx.createGain();
    reverbDry.gain.value = 1.0;

    // Dynamics compressor to prevent clipping with many layers
    const compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 6;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;

    masterGain.connect(hpMaster);
    hpMaster.connect(lpMaster);
    lpMaster.connect(reverbDry);
    lpMaster.connect(reverbNode);
    reverbNode.connect(reverbWet);
    reverbDry.connect(compressor);
    reverbWet.connect(compressor);
    compressor.connect(analyser);
    analyser.connect(audioCtx.destination);

    // Apply UI/master-profile values after nodes exist. Without this, a saved
    // profile selected before the first Play would only update the sliders.
    setReverb(document.getElementById('reverb-slider')?.value ?? 0);
    setLowpass(document.getElementById('lp-slider')?.value ?? 100);
    setHighpass(document.getElementById('hp-slider')?.value ?? 0);
    return true;
  } catch (err) {
    showToast('Error al iniciar el audio: ' + err.message);
    return false;
  }
}

// Synthesis strategies per sound type
// ─── PREVIEW AUDITIVO ────────────────────────────────────────────────────────

let previewCtx = null;
let previewNodes = null;
let previewTimeout = null;
let previewingId = null;

function previewSound(id, btnEl, e) {
  if (e) e.stopPropagation();

  if (previewingId === id) {
    stopPreview();
    return;
  }

  stopPreview();

  const def = SOUND_DEFS[id];
  if (!def) return;

  previewingId = id;
  previewAudioActive = true;
  if (btnEl) {
    btnEl.classList.add('previewing');
    btnEl.textContent = '■';
  }

  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      showToast('Tu navegador no soporta Web Audio API');
      stopPreview();
      return;
    }

    // If the main scene is already playing, preview through the existing context
    // so scheduled event sounds keep working without crossing AudioContexts.
    let ctxForPreview;
    let masterOut;
    let restoreMasterOnly = false;

    if (playing && audioCtx && masterGain) {
      ctxForPreview = audioCtx;
      masterOut = ctxForPreview.createGain();
      masterOut.gain.value = 0;
      masterOut.connect(masterGain);
      restoreMasterOnly = true;
    } else {
      previewSavedCtx = audioCtx;
      previewSavedMaster = masterGain;
      previewCtx = new AC();
      ctxForPreview = previewCtx;
      if (previewCtx.state === 'suspended' && previewCtx.resume) {
        previewCtx.resume().catch(() => showToast('Toca de nuevo para activar el audio en este navegador'));
      }
      masterOut = ctxForPreview.createGain();
      masterOut.gain.value = 0;
      masterOut.connect(ctxForPreview.destination);
      audioCtx = previewCtx;
    }

    masterOut.gain.setTargetAtTime(0.72, ctxForPreview.currentTime, 0.12);

    const savedMaster = masterGain;
    masterGain = masterOut;
    const nodes = createSoundNode(id, 80, 30);
    if (restoreMasterOnly) masterGain = savedMaster;

    if (nodes) {
      previewNodes = nodes;
    }

    previewTimeout = setTimeout(() => {
      if (masterOut && ctxForPreview) {
        masterOut.gain.setTargetAtTime(0, ctxForPreview.currentTime, 0.22);
      }
      setTimeout(stopPreview, 650);
    }, 2600);

  } catch(err) {
    stopPreview();
  }
}

function stopPreview() {
  clearTimeout(previewTimeout);
  previewTimeout = null;

  if (previewNodes) {
    try { stopNodes(previewNodes); } catch(ex) {}
    previewNodes = null;
  }

  if (previewCtx) {
    try { previewCtx.close(); } catch(ex) {}
    previewCtx = null;
    audioCtx = previewSavedCtx;
    masterGain = previewSavedMaster;
    previewSavedCtx = null;
    previewSavedMaster = null;
  }
  previewAudioActive = false;

  if (previewingId) {
    const btn = document.querySelector(`.s-preview[data-id="${previewingId}"]`);
    if (btn) {
      btn.classList.remove('previewing');
      btn.textContent = '▶';
    }
    previewingId = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function createProceduralNodes(def, rate, out) {
  let nodes = {};
  switch (def.synth) {
    case 'noise-rain':       nodes = { ...nodes, ...synthRain(def, rate, out) }; break;
    case 'noise-wind':       nodes = { ...nodes, ...synthWind(def, rate, out) }; break;
    case 'fire':             nodes = { ...nodes, ...synthFire(def, rate, out) }; break;
    case 'noise-rumble':     nodes = { ...nodes, ...synthRumble(def, rate, out) }; break;
    case 'noise-low':        nodes = { ...nodes, ...synthLowNoise(def, rate, out) }; break;
    case 'birds':            nodes = { ...nodes, ...synthBirds(def, rate, out) }; break;
    case 'cricket':          nodes = { ...nodes, ...synthCricket(def, rate, out) }; break;
    case 'water-drip':       nodes = { ...nodes, ...synthDrip(def, rate, out) }; break;
    case 'ticking':          nodes = { ...nodes, ...synthTick(def, rate, out) }; break;
    case 'heartbeat':        nodes = { ...nodes, ...synthHeartbeat(def, rate, out) }; break;
    case 'drone':            nodes = { ...nodes, ...synthDrone(def, rate, out) }; break;
    case 'chime':            nodes = { ...nodes, ...synthChime(def, rate, out) }; break;
    case 'creak':            nodes = { ...nodes, ...synthCreak(def, rate, out) }; break;
    case 'steps':            nodes = { ...nodes, ...synthSteps(def, rate, out) }; break;
    case 'crowd':            nodes = { ...nodes, ...synthCrowd(def, rate, out) }; break;
    case 'waves':            nodes = { ...nodes, ...synthWaves(def, rate, out) }; break;
    case 'thunder':          nodes = { ...nodes, ...synthThunder(def, rate, out) }; break;
    case 'pad':              nodes = { ...nodes, ...synthPad(def, rate, out) }; break;
    case 'arpeggio':         nodes = { ...nodes, ...synthArpeggio(def, rate, out) }; break;
    case 'dissonant-pad':    nodes = { ...nodes, ...synthDissonantPad(def, rate, out) }; break;
    case 'music-box':        nodes = { ...nodes, ...synthMusicBox(def, rate, out) }; break;
    case 'harpsichord':      nodes = { ...nodes, ...synthHarpsichord(def, rate, out) }; break;
    case 'stinger':          nodes = { ...nodes, ...synthStinger(def, rate, out) }; break;
    case 'pulse-bass':       nodes = { ...nodes, ...synthPulseBass(def, rate, out) }; break;
    case 'whisper-choir':    nodes = { ...nodes, ...synthWhisperChoir(def, rate, out) }; break;
    case 'cthulhu-call':     nodes = { ...nodes, ...synthCthulhuCall(def, rate, out) }; break;
    case 'rlyeh-choir':      nodes = { ...nodes, ...synthRlyehChoir(def, rate, out) }; break;
    case 'azathoth-beat':    nodes = { ...nodes, ...synthAzathothBeat(def, rate, out) }; break;
    case 'yuggoth-signal':   nodes = { ...nodes, ...synthYuggothSignal(def, rate, out) }; break;
    case 'nyarlathotep':     nodes = { ...nodes, ...synthNyarlathotep(def, rate, out) }; break;
    case 'innsmouth-deep':   nodes = { ...nodes, ...synthInnsmouthDeep(def, rate, out) }; break;
    case 'azathoth-flutes':  nodes = { ...nodes, ...synthAzathothFlutes(def, rate, out) }; break;
    case 'shoggoth':         nodes = { ...nodes, ...synthShoggoth(def, rate, out) }; break;
    case 'mi-go':            nodes = { ...nodes, ...synthMiGo(def, rate, out) }; break;
    case 'yog-sothoth':      nodes = { ...nodes, ...synthYogSothoth(def, rate, out) }; break;
    case 'dagon-depth':      nodes = { ...nodes, ...synthDagonDepth(def, rate, out) }; break;
    case 'hastur-wind':      nodes = { ...nodes, ...synthHasturWind(def, rate, out) }; break;
    case 'sleeping-god':     nodes = { ...nodes, ...synthSleepingGodBreath(def, rate, out) }; break;
    case 'non-euclidean':    nodes = { ...nodes, ...synthNonEuclideanEcho(def, rate, out) }; break;
    case 'infrasound-19':    nodes = { ...nodes, ...synthInfrasound19(def, rate, out) }; break;
    case 'binaural':         nodes = { ...nodes, ...synthBinaural(def, rate, out) }; break;
    case 'shepard':          nodes = { ...nodes, ...synthShepardTone(def, rate, out) }; break;
    case 'schumann':         nodes = { ...nodes, ...synthSchumann(def, rate, out) }; break;
    case 'microtonal':       nodes = { ...nodes, ...synthMicrotonal(def, rate, out) }; break;
    case 'whole-tone':       nodes = { ...nodes, ...synthWholeTone(def, rate, out) }; break;
    case '111hz':            nodes = { ...nodes, ...synth111Hz(def, rate, out) }; break;
    case 'formant-void':     nodes = { ...nodes, ...synthFormantVoid(def, rate, out) }; break;
    case 'purr':             nodes = { ...nodes, ...synthPurr(def, rate, out) }; break;
    case '528hz':            nodes = { ...nodes, ...synth528Hz(def, rate, out) }; break;
    case 'alpha-wave':       nodes = { ...nodes, ...synthAlphaWave(def, rate, out) }; break;
    case 'theta-wave':       nodes = { ...nodes, ...synthThetaWave(def, rate, out) }; break;
    case 'perfect-fifth':    nodes = { ...nodes, ...synthPerfectFifth(def, rate, out) }; break;
    case 'harmonic-series':  nodes = { ...nodes, ...synthHarmonicSeries(def, rate, out) }; break;
    case 'tibetan-bowl':     nodes = { ...nodes, ...synthTibetanBowl(def, rate, out) }; break;
    case 'shaman-drum':      nodes = { ...nodes, ...synthShamandrum(def, rate, out) }; break;
    case 'nada-brahma':      nodes = { ...nodes, ...synthNadaBrahma(def, rate, out) }; break;
    case 'whale-call':       nodes = { ...nodes, ...synthWhaleCall(def, rate, out) }; break;
    case 'didgeridoo':       nodes = { ...nodes, ...synthDidgeridoo(def, rate, out) }; break;
    case 'resolving-pad':    nodes = { ...nodes, ...synthResolvingPad(def, rate, out) }; break;
    case 'cult-chant':       nodes = { ...nodes, ...synthCultChant(def, rate, out) }; break;
    case 'ritual-drums':     nodes = { ...nodes, ...synthRitualDrums(def, rate, out) }; break;
    case 'dark-gregory':     nodes = { ...nodes, ...synthDarkGregory(def, rate, out) }; break;
    case 'glossolalia':      nodes = { ...nodes, ...synthGlossolalia(def, rate, out) }; break;
    case 'om-corrupted':     nodes = { ...nodes, ...synthOmCorrupted(def, rate, out) }; break;
    case 'black-mass':       nodes = { ...nodes, ...synthBlackMass(def, rate, out) }; break;
    case 'dervish-spin':     nodes = { ...nodes, ...synthDervishSpin(def, rate, out) }; break;
    case 'swamp':            nodes = { ...nodes, ...synthSwamp(def, rate, out) }; break;
    case 'circus-dark':      nodes = { ...nodes, ...synthCircusDark(def, rate, out) }; break;
    case 'submarine':        nodes = { ...nodes, ...synthSubmarineDepth(def, rate, out) }; break;
    case 'prohibited-lib':   nodes = { ...nodes, ...synthProhibitedLibrary(def, rate, out) }; break;
    case 'sacred-ruins':     nodes = { ...nodes, ...synthSacredRuins(def, rate, out) }; break;
    case 'electric-lab':     nodes = { ...nodes, ...synthElectricLab(def, rate, out) }; break;
    case 'night-train':      nodes = { ...nodes, ...synthNightTrain(def, rate, out) }; break;
    case 'feedback':         nodes = { ...nodes, ...synthFeedback(def, rate, out) }; break;
    case 'granular-silence': nodes = { ...nodes, ...synthGranularSilence(def, rate, out) }; break;
    case 'spectral-invert':  nodes = { ...nodes, ...synthSpectralInvert(def, rate, out) }; break;
    case 'risset':           nodes = { ...nodes, ...synthRisset(def, rate, out) }; break;
    case 'tremolo-strings':  nodes = { ...nodes, ...synthTremoloStrings(def, rate, out) }; break;
    case 'high-tension':     nodes = { ...nodes, ...synthHighTension(def, rate, out) }; break;
    case 'swell':            nodes = { ...nodes, ...synthSwell(def, rate, out) }; break;
    case 'brass-cluster':    nodes = { ...nodes, ...synthBrassCluster(def, rate, out) }; break;
    case 'braam':            nodes = { ...nodes, ...synthBraam(def, rate, out) }; break;
    case 'boom':             nodes = { ...nodes, ...synthBoom(def, rate, out) }; break;
    case 'roll':             nodes = { ...nodes, ...synthRoll(def, rate, out) }; break;
    case 'racing-heart':     nodes = { ...nodes, ...synthRacingHeart(def, rate, out) }; break;
    case 'breathing':        nodes = { ...nodes, ...synthBreathing(def, rate, out) }; break;
    case 'scratch':          nodes = { ...nodes, ...synthScratch(def, rate, out) }; break;
    case 'flies':            nodes = { ...nodes, ...synthFlies(def, rate, out) }; break;
    case 'child-laugh':      nodes = { ...nodes, ...synthChildLaugh(def, rate, out) }; break;
    case 'bone-crack':       nodes = { ...nodes, ...synthBoneCrack(def, rate, out) }; break;
    case 'prepared-piano':   nodes = { ...nodes, ...synthPreparedPiano(def, rate, out) }; break;
    case 'theremin':         nodes = { ...nodes, ...synthTheremin(def, rate, out) }; break;
    case 'bowed-string':     nodes = { ...nodes, ...synthBowedString(def, rate, out) }; break;
    case 'inverted-bell':    nodes = { ...nodes, ...synthInvertedBell(def, rate, out) }; break;
    case 'machinery':        nodes = { ...nodes, ...synthMachinery(def, rate, out) }; break;
    case 'chain-drag':       nodes = { ...nodes, ...synthChainDrag(def, rate, out) }; break;
    case 'static':           nodes = { ...nodes, ...synthStatic(def, rate, out) }; break;
    case 'failing-gen':      nodes = { ...nodes, ...synthFailingGenerator(def, rate, out) }; break;
    case 'synthwave':        nodes = { ...nodes, ...synthSynthwave(def, rate, out) }; break;
    case 'frozen-chord':     nodes = { ...nodes, ...synthFrozenChord(def, rate, out) }; break;
    case 'filter-sweep':     nodes = { ...nodes, ...synthFilterSweep(def, rate, out) }; break;
    default:                 nodes = { ...nodes, ...synthNoise(def, rate, out) }; break;
  }

  return nodes;
}

function createHybridSampleNode(id, def, rate, out) {
  const buffer = sampleOverrides.get(id);
  const sampleBus = audioCtx.createGain();
  const textureBus = audioCtx.createGain();
  const airBus = audioCtx.createGain();
  const pan = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : null;

  const blend = getHybridBlend();
  // Real sample remains dominant; synthesis becomes moving air, sub, grit and transient life.
  sampleBus.gain.value = 0.78 + blend * 0.22;
  textureBus.gain.value = blend * 0.28;
  airBus.gain.value = blend * 0.12;

  if (pan) pan.pan.value = rnd(-0.18, 0.18);
  sampleBus.connect(pan || out);
  textureBus.connect(pan || out);
  airBus.connect(pan || out);
  if (pan) pan.connect(out);

  const sample = synthImportedSample(buffer, rate, sampleBus);
  const procedural = createProceduralNodes(def, rate, textureBus);
  const air = synthHybridAirBed(def, rate, airBus);

  return {
    sampleBus,
    textureBus,
    airBus,
    pan,
    _hybrid: true,
    sample,
    procedural,
    air,
    _stopFn: () => {
      stopHybridPart(sample);
      stopHybridPart(procedural);
      stopHybridPart(air);
    }
  };
}

function stopHybridPart(part) {
  if (!part) return;
  if (part._stopFn) { try { part._stopFn(); } catch(e) {} }
  if (part.src) { try { part.src.stop(); } catch(e) {} }
  if (part.osc) { try { part.osc.stop(); } catch(e) {} }
  if (part.lfo) { try { part.lfo.stop(); } catch(e) {} }
  if (Array.isArray(part.oscs)) {
    part.oscs.forEach(item => {
      if (item && item.o) { try { item.o.stop(); } catch(e) {} }
      if (item && item.lfo) { try { item.lfo.stop(); } catch(e) {} }
      if (item && item.stop) { try { item.stop(); } catch(e) {} }
    });
  }
}

function inferSoundPolish(id, def) {
  const synth = String(def?.synth || '');
  const text = `${id} ${synth}`;
  const cfg = { hp: 24, lp: 18500, low: 0, high: 0, pan: rnd(-0.045, 0.045) };

  if (/rain|lluvia|arroyo|rio|cascada|waves|mar|olas|water/.test(text)) {
    cfg.hp = 38; cfg.lp = 15500; cfg.low = -0.5; cfg.high = 1.0; cfg.pan = rnd(-0.10, 0.10);
  }
  if (/wind|viento|brisa|silbido/.test(text)) {
    cfg.hp = 42; cfg.lp = 12500; cfg.low = -1.0; cfg.high = 0.8; cfg.pan = rnd(-0.16, 0.16);
  }
  if (/fire|hoguera|chimenea/.test(text)) {
    cfg.hp = 45; cfg.lp = 10000; cfg.low = -0.5; cfg.high = 1.2; cfg.pan = rnd(-0.08, 0.08);
  }
  if (/drone|pad|rumble|low|bajo|infrasound|19hz|frecuencias-bajas|silencio-pesado|cosmico|abismo|dagon|innsmouth/.test(text)) {
    cfg.hp = /infrasound|19hz|frecuencias-bajas/.test(text) ? 10 : 18;
    cfg.lp = 7200; cfg.low = 1.1; cfg.high = -1.8; cfg.pan = rnd(-0.035, 0.035);
  }
  if (/chime|campana|caja-musica|clavecin|harpsichord|tintinean|piano|theremin|violin|cuerda/.test(text)) {
    cfg.hp = 95; cfg.lp = 14800; cfg.low = -1.2; cfg.high = 1.4; cfg.pan = rnd(-0.13, 0.13);
  }
  if (/ticking|reloj|maquina|drip|goteo|pasos|steps|creak|crujido|scratch|aranazos|huesos|cadena|metal/.test(text)) {
    cfg.hp = 62; cfg.lp = 13200; cfg.low = -0.7; cfg.high = 1.1; cfg.pan = rnd(-0.18, 0.18);
  }
  if (/crowd|gente|cafe|mercado|taberna|plaza|chant|choir|coro|susurro|voz|glosolalia|misa|gregoriano/.test(text)) {
    cfg.hp = 78; cfg.lp = 8800; cfg.low = -0.7; cfg.high = -0.8; cfg.pan = rnd(-0.08, 0.08);
  }
  if (/static|radio|transmision|zumbido-agudo|feedback|interferencia/.test(text)) {
    cfg.hp = 120; cfg.lp = 11800; cfg.low = -2.0; cfg.high = 0.8; cfg.pan = rnd(-0.05, 0.05);
  }

  return cfg;
}

function createLayerPolishChain(id, def, rate, out) {
  const cfg = inferSoundPolish(id, def);
  const layerIn = audioCtx.createGain();

  const layerHp = audioCtx.createBiquadFilter();
  layerHp.type = 'highpass';
  layerHp.frequency.value = cfg.hp;
  layerHp.Q.value = 0.55;

  const layerLp = audioCtx.createBiquadFilter();
  layerLp.type = 'lowpass';
  layerLp.frequency.value = cfg.lp;
  layerLp.Q.value = 0.45;

  const layerLowShelf = audioCtx.createBiquadFilter();
  layerLowShelf.type = 'lowshelf';
  layerLowShelf.frequency.value = 135;
  layerLowShelf.gain.value = cfg.low;

  const layerHighShelf = audioCtx.createBiquadFilter();
  layerHighShelf.type = 'highshelf';
  layerHighShelf.frequency.value = 5200;
  layerHighShelf.gain.value = cfg.high;

  const layerPan = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : null;
  if (layerPan) layerPan.pan.value = cfg.pan;

  layerIn.connect(layerHp);
  layerHp.connect(layerLp);
  layerLp.connect(layerLowShelf);
  layerLowShelf.connect(layerHighShelf);
  layerHighShelf.connect(layerPan || out);
  if (layerPan) layerPan.connect(out);

  return { layerIn, layerHp, layerLp, layerLowShelf, layerHighShelf, layerPan };
}

function createSoundNode(id, vol, rate) {
  const def = SOUND_DEFS[id];
  if (!def) return null;
  const out = audioCtx.createGain();
  out.gain.value = vol / 100;
  out.connect(masterGain);

  // v4.6: every layer now has its own subtle polish chain before the master.
  // This removes mud, gives event sounds a small stereo position and keeps
  // drones from swallowing rain, voices or transients.
  const polish = createLayerPolishChain(id, def, rate, out);
  const soundInput = polish.layerIn;
  let nodes = { out, ...polish };

  // v4.4+: Hybrid mode. A real local WAV/MP3 named like the sound ID becomes
  // the body of the layer, while the procedural engine adds movement, air,
  // psychoacoustic depth and dynamic variation on top.
  if (sampleOverrides.has(id)) {
    return { ...nodes, ...createHybridSampleNode(id, def, rate, soundInput) };
  }

  nodes = { ...nodes, ...createProceduralNodes(def, rate, soundInput) };
  return nodes;
}

// ── White / Brown noise buffer factory ──
function makeNoiseBuffer(type = 'white', sec = 4) {
  const len = audioCtx.sampleRate * sec;
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  if (type === 'brown') {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      data[i] = last * 8;
    }
  } else {
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  return buf;
}

function loopNoise(buf) {
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.start();
  return src;
}

// ── SYNTH FUNCTIONS ──

function synthNoise(def, rate, out) {
  const buf = makeNoiseBuffer('white', 3);
  const src = loopNoise(buf);
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = def.freq || 800;
  filter.Q.value = def.Q || 1;
  src.connect(filter);
  filter.connect(out);
  return { src, filter };
}

synthRain = function synthRainReal(def, rate, out) {
  // Brown noise + highpass for rain hiss + bandpass for heavy drops
  const buf = makeNoiseBuffer('brown', 4);
  const src = loopNoise(buf);
  const hp = audioCtx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = def.hpFreq || 300;
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = def.lpFreq || 8000;

  // LFO for intensity variation — modulate a dedicated mix gain, not out.gain
  const mixGain = audioCtx.createGain();
  mixGain.gain.value = 1.0;
  const lfo = audioCtx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.08 + (rate / 60) * 0.15;
  const lfoGain = audioCtx.createGain();
  lfoGain.gain.value = 0.06; // ±6% modulation, always positive
  lfo.connect(lfoGain);
  lfoGain.connect(mixGain.gain);
  lfo.start();

  src.connect(hp); hp.connect(lp); lp.connect(mixGain); mixGain.connect(out);
  return { src, hp, lp, mixGain, lfo, lfoGain };
}

synthWind = function synthWindReal(def, rate, out) {
  const buf = makeNoiseBuffer('brown', 6);
  const src = loopNoise(buf);
  const bp = audioCtx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = def.freq || 400;
  bp.Q.value = 0.5;

  const lfo = audioCtx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.05 + (rate / 60) * 0.2;
  const lfoGain = audioCtx.createGain();
  lfoGain.gain.value = 0.25;
  lfo.connect(lfoGain);
  lfoGain.connect(bp.frequency);
  lfo.start();

  // Use a dedicated mix gain for amplitude modulation — do NOT modulate out.gain
  const mixGain = audioCtx.createGain();
  mixGain.gain.value = 1.0;
  const lfo2 = audioCtx.createOscillator();
  lfo2.type = 'sine';
  lfo2.frequency.value = 0.03;
  const lfo2Gain = audioCtx.createGain();
  lfo2Gain.gain.value = 0.12; // ±12%, always positive
  lfo2.connect(lfo2Gain);
  lfo2Gain.connect(mixGain.gain);
  lfo2.start();

  src.connect(bp); bp.connect(mixGain); mixGain.connect(out);
  return { src, bp, lfo, lfoGain, lfo2, lfo2Gain, mixGain };
}

synthFire = function synthFireReal(def, rate, out) {
  const buf = makeNoiseBuffer('brown', 4);
  const src = loopNoise(buf);
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 600;

  // crackle LFO
  const lfo = audioCtx.createOscillator();
  lfo.type = 'sawtooth';
  lfo.frequency.value = 3 + (rate / 60) * 12;
  const lfoGain = audioCtx.createGain();
  lfoGain.gain.value = 0.12;
  lfo.connect(lfoGain);
  lfoGain.connect(lp.frequency);
  lfo.start();

  src.connect(lp); lp.connect(out);
  return { src, lp, lfo, lfoGain };
}

function synthRumble(def, rate, out) {
  const buf = makeNoiseBuffer('brown', 8);
  const src = loopNoise(buf);
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 80 + (rate / 60) * 60;
  src.connect(lp); lp.connect(out);
  return { src, lp };
}

function synthLowNoise(def, rate, out) {
  const osc = audioCtx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = def.freq || 60;
  const lfo = audioCtx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.04;
  const lfoG = audioCtx.createGain();
  lfoG.gain.value = 8;
  lfo.connect(lfoG);
  lfoG.connect(osc.frequency);
  lfo.start(); osc.start();
  osc.connect(out);
  return { osc, lfo, lfoG };
}

function synthDrone(def, rate, out) {
  const freqs = def.freqs || [55, 110, 165];
  const oscs = freqs.map(f => {
    const o = audioCtx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const g = audioCtx.createGain();
    g.gain.value = 0.08;
    o.connect(g); g.connect(out);
    o.start();
    return { o, g };
  });
  // slow tremolo via dedicated mixGain
  const mixGain = audioCtx.createGain();
  mixGain.gain.value = 1.0;
  const lfo = audioCtx.createOscillator();
  lfo.frequency.value = 0.06;
  const lfoG = audioCtx.createGain();
  lfoG.gain.value = 0.04;
  lfo.connect(lfoG);
  lfoG.connect(mixGain.gain);
  lfo.start();
  // reconnect oscs through mixGain
  oscs.forEach(({ g }) => { g.disconnect(out); g.connect(mixGain); });
  mixGain.connect(out);
  return { oscs, lfo, lfoG, mixGain };
}

function synthPad(def, rate, out) {
  const freqs = def.freqs || [220, 330, 440];
  const oscs = freqs.map((f, i) => {
    const o = audioCtx.createOscillator();
    o.type = i === 0 ? 'sine' : 'triangle';
    o.frequency.value = f + Math.random() * 2;
    const g = audioCtx.createGain();
    g.gain.value = 0.06;
    o.connect(g); g.connect(out);
    o.start();
    return { o, g };
  });
  return { oscs };
}

synthBirds = function synthBirdsReal(def, rate, out) {
  // Scheduled random chirps
  const interval = Math.max(0.4, 3 - (rate / 60) * 2.5);
  let timer;
  function chirp() {
    if (!isAudioEngineActive()) return;
    const o = audioCtx.createOscillator();
    o.type = 'sine';
    const baseFreq = 1200 + Math.random() * 2400;
    o.frequency.value = baseFreq;
    o.frequency.setTargetAtTime(baseFreq * 1.3, audioCtx.currentTime, 0.05);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0, audioCtx.currentTime);
    g.gain.linearRampToValueAtTime(0.15, audioCtx.currentTime + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15 + Math.random() * 0.2);
    o.connect(g); g.connect(out);
    o.start(); o.stop(audioCtx.currentTime + 0.4);
    timer = setTimeout(chirp, (interval + Math.random() * interval) * 1000);
  }
  chirp();
  return { _timer: timer, _chirpFn: chirp, _stopFn: () => clearTimeout(timer) };
}

synthCricket = function synthCricketReal(def, rate, out) {
  const freq = def.freq || 4200;
  const osc = audioCtx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = freq;
  const lfo = audioCtx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = 20 + (rate / 60) * 10;
  const lfoG = audioCtx.createGain();
  lfoG.gain.value = 0.5;
  lfo.connect(lfoG);
  const envGain = audioCtx.createGain();
  envGain.gain.value = 0;
  lfoG.connect(envGain.gain);
  osc.connect(envGain); envGain.connect(out);
  osc.start(); lfo.start();
  return { osc, lfo, lfoG, envGain };
}

synthDrip = function synthDripReal(def, rate, out) {
  const interval = Math.max(0.3, 4 - (rate / 60) * 3.5);
  let timer;
  function drip() {
    if (!isAudioEngineActive()) return;
    const o = audioCtx.createOscillator();
    o.type = 'sine';
    const f = 600 + Math.random() * 800;
    o.frequency.value = f;
    o.frequency.exponentialRampToValueAtTime(f * 0.4, audioCtx.currentTime + 0.25);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.2, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    o.connect(g); g.connect(out);
    o.start(); o.stop(audioCtx.currentTime + 0.35);
    timer = setTimeout(drip, (interval + Math.random() * interval) * 1000);
  }
  drip();
  return { _stopFn: () => clearTimeout(timer) };
}

function synthTick(def, rate, out) {
  const bpm = 20 + rate * 0.6;
  const interval = 60 / bpm;
  let timer;
  function tick() {
    if (!isAudioEngineActive()) return;
    const buf = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * 0.02), audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / 100);
    const src2 = audioCtx.createBufferSource();
    src2.buffer = buf;
    const g = audioCtx.createGain();
    g.gain.value = 0.4;
    src2.connect(g); g.connect(out);
    src2.start();
    timer = setTimeout(tick, interval * 1000);
  }
  tick();
  return { _stopFn: () => clearTimeout(timer) };
}

synthHeartbeat = function synthHeartbeatReal(def, rate, out) {
  const bpm = 40 + (rate / 60) * 80;
  const interval = 60 / bpm;
  let timer;
  function beat() {
    if (!isAudioEngineActive()) return;
    [0, 0.12].forEach(offset => {
      setTimeout(() => {
        const o = audioCtx.createOscillator();
        o.type = 'sine';
        o.frequency.value = 60;
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(0, audioCtx.currentTime);
        g.gain.linearRampToValueAtTime(0.4, audioCtx.currentTime + 0.04);
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
        o.connect(g); g.connect(out);
        o.start(); o.stop(audioCtx.currentTime + 0.25);
      }, offset * 1000);
    });
    timer = setTimeout(beat, interval * 1000);
  }
  beat();
  return { _stopFn: () => clearTimeout(timer) };
}

function synthChime(def, rate, out) {
  const freqs = def.freqs || [523, 659, 784, 1047];
  const interval = Math.max(0.8, 6 - (rate / 60) * 5);
  let timer;
  function chime() {
    if (!isAudioEngineActive()) return;
    const f = freqs[Math.floor(Math.random() * freqs.length)];
    const o = audioCtx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.2, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.5 + Math.random());
    o.connect(g); g.connect(out);
    o.start(); o.stop(audioCtx.currentTime + 2);
    timer = setTimeout(chime, (interval + Math.random() * interval) * 1000);
  }
  chime();
  return { _stopFn: () => clearTimeout(timer) };
}

synthCreak = function synthCreakReal(def, rate, out) {
  const interval = Math.max(1, 8 - (rate / 60) * 7);
  let timer;
  function creak() {
    if (!isAudioEngineActive()) return;
    const buf = makeNoiseBuffer('brown', 1);
    const src2 = audioCtx.createBufferSource();
    src2.buffer = buf;
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 150 + Math.random() * 100;
    bp.Q.value = 5;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0, audioCtx.currentTime);
    g.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4 + Math.random() * 0.3);
    src2.connect(bp); bp.connect(g); g.connect(out);
    src2.start(); src2.stop(audioCtx.currentTime + 0.8);
    timer = setTimeout(creak, (interval + Math.random() * interval) * 1000);
  }
  creak();
  return { _stopFn: () => clearTimeout(timer) };
}

synthSteps = function synthStepsReal(def, rate, out) {
  const bpm = 40 + (rate / 60) * 60;
  const interval = (60 / bpm) * 2;
  let timer;
  function step() {
    if (!isAudioEngineActive()) return;
    const buf = makeNoiseBuffer('brown', 0.5);
    const src2 = audioCtx.createBufferSource();
    src2.buffer = buf;
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 300 + Math.random() * 100;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0, audioCtx.currentTime);
    g.gain.linearRampToValueAtTime(0.5, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
    src2.connect(lp); lp.connect(g); g.connect(out);
    src2.start(); src2.stop(audioCtx.currentTime + 0.2);
    timer = setTimeout(step, (interval + (Math.random() - 0.5) * 0.1) * 1000);
  }
  step();
  return { _stopFn: () => clearTimeout(timer) };
}

synthCrowd = function synthCrowdReal(def, rate, out) {
  // multiple detuned oscillators
  const voices = 8;
  const oscList = [];
  for (let i = 0; i < voices; i++) {
    const o = audioCtx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 150 + Math.random() * 300;
    const lfo = audioCtx.createOscillator();
    lfo.frequency.value = 0.5 + Math.random() * 2;
    const lfoG = audioCtx.createGain();
    lfoG.gain.value = 20 + Math.random() * 40;
    lfo.connect(lfoG); lfoG.connect(o.frequency);
    const g = audioCtx.createGain();
    g.gain.value = 0.02;
    o.connect(g); g.connect(out);
    o.start(); lfo.start();
    oscList.push({ o, lfo, lfoG, g });
  }
  const buf = makeNoiseBuffer('brown', 4);
  const src = loopNoise(buf);
  const bp = audioCtx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 400;
  bp.Q.value = 0.3;
  const ng = audioCtx.createGain();
  ng.gain.value = 0.15;
  src.connect(bp); bp.connect(ng); ng.connect(out);
  return { oscList, src, bp, ng };
}

synthWaves = function synthWavesReal(def, rate, out) {
  const buf = makeNoiseBuffer('brown', 6);
  const src = loopNoise(buf);
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 800;
  const mixGain = audioCtx.createGain();
  mixGain.gain.value = 1.0;
  const lfo = audioCtx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.1 + (rate / 60) * 0.15;
  const lfoG = audioCtx.createGain();
  lfoG.gain.value = 0.25; // kept positive range
  lfo.connect(lfoG);
  lfoG.connect(mixGain.gain);
  lfo.start();
  src.connect(lp); lp.connect(mixGain); mixGain.connect(out);
  return { src, lp, mixGain, lfo, lfoG };
}

synthThunder = function synthThunderReal(def, rate, out) {
  const interval = Math.max(4, 20 - (rate / 60) * 16);
  let timer;
  function boom() {
    if (!isAudioEngineActive()) return;
    const buf = makeNoiseBuffer('brown', 3);
    const src2 = audioCtx.createBufferSource();
    src2.buffer = buf;
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 120;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0, audioCtx.currentTime);
    g.gain.linearRampToValueAtTime(0.8, audioCtx.currentTime + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 2.5 + Math.random());
    src2.connect(lp); lp.connect(g); g.connect(out);
    src2.start(); src2.stop(audioCtx.currentTime + 4);
    timer = setTimeout(boom, (interval + Math.random() * interval) * 1000);
  }
  boom();
  return { _stopFn: () => clearTimeout(timer) };
}

// ── CINE DE TERROR (homenaje, síntesis original) ──

// Arpegio sintético hipnótico repetitivo (pulsación tipo Carpenter)
function synthArpeggio(def, rate, out) {
  const notes = def.notes || [55, 82.4, 110, 82.4];
  const wave = def.wave || 'sawtooth';
  const bpm = 80 + (rate / 60) * 90;
  const stepTime = 60 / bpm / 2;
  let i = 0;
  let timer;
  function step() {
    if (!isAudioEngineActive()) return;
    const o = audioCtx.createOscillator();
    o.type = wave;
    o.frequency.value = notes[i % notes.length];
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = def.cutoff || 1400;
    lp.Q.value = def.reso || 6;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0, audioCtx.currentTime);
    g.gain.linearRampToValueAtTime(0.28, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + stepTime * 0.95);
    o.connect(lp); lp.connect(g); g.connect(out);
    o.start(); o.stop(audioCtx.currentTime + stepTime);
    i++;
    timer = setTimeout(step, stepTime * 1000);
  }
  step();
  return { _stopFn: () => clearTimeout(timer) };
}

// Pad disonante de tensión (cluster de semitonos)
function synthDissonantPad(def, rate, out) {
  const base = def.base || 110;
  const ratios = def.ratios || [1, 1.06, 1.41, 1.49];
  const oscs = ratios.map(r => {
    const o = audioCtx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = base * r + (Math.random() * 2 - 1);
    const g = audioCtx.createGain();
    g.gain.value = 0.05;
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 600;
    o.connect(lp); lp.connect(g); g.connect(out);
    o.start();
    return { o, g, lp };
  });
  const mixGainD = audioCtx.createGain();
  mixGainD.gain.value = 1.0;
  oscs.forEach(({ g }) => { g.disconnect(out); g.connect(mixGainD); });
  mixGainD.connect(out);
  const lfo = audioCtx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.05 + (rate / 60) * 0.15;
  const lfoG = audioCtx.createGain();
  lfoG.gain.value = 0.04;
  lfo.connect(lfoG); lfoG.connect(mixGainD.gain);
  lfo.start();
  return { oscs, lfo, lfoG, mixGainD };
}

// Caja de música desafinada (muy giallo / Argento)
function synthMusicBox(def, rate, out) {
  const scale = def.scale || [1047, 1175, 1319, 1397, 1568, 1760];
  const interval = Math.max(0.45, 2.2 - (rate / 60) * 1.7);
  let timer;
  function pluck() {
    if (!isAudioEngineActive()) return;
    const detune = 1 + (Math.random() * 0.03 - 0.015);
    const f = scale[Math.floor(Math.random() * scale.length)] * detune;
    [1, 2.01, 3.03].forEach((mult, k) => {
      const o = audioCtx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mult;
      const g = audioCtx.createGain();
      const amp = 0.18 / (k + 1);
      g.gain.setValueAtTime(amp, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.2 + Math.random() * 0.6);
      o.connect(g); g.connect(out);
      o.start(); o.stop(audioCtx.currentTime + 2);
    });
    timer = setTimeout(pluck, (interval + Math.random() * interval) * 1000);
  }
  pluck();
  return { _stopFn: () => clearTimeout(timer) };
}

// Clavecín espectral (Goblin / prog italiano)
function synthHarpsichord(def, rate, out) {
  const scale = def.scale || [220, 262, 311, 349, 415];
  const bpm = 90 + (rate / 60) * 80;
  const stepTime = 60 / bpm;
  let timer, i = 0;
  function note() {
    if (!isAudioEngineActive()) return;
    const f = scale[(i * 3) % scale.length] * (i % 8 < 4 ? 1 : 2);
    const o = audioCtx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f * 2;
    bp.Q.value = 3;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.16, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + stepTime * 1.5);
    o.connect(bp); bp.connect(g); g.connect(out);
    o.start(); o.stop(audioCtx.currentTime + stepTime * 2);
    i++;
    timer = setTimeout(note, stepTime * 1000);
  }
  note();
  return { _stopFn: () => clearTimeout(timer) };
}

// Stinger de cuerdas (el golpe agudo del susto, intervalo largo)
function synthStinger(def, rate, out) {
  const interval = Math.max(6, 30 - (rate / 60) * 24);
  let timer;
  function hit() {
    if (!isAudioEngineActive()) return;
    const base = 1400 + Math.random() * 800;
    const voices = 6;
    for (let v = 0; v < voices; v++) {
      const o = audioCtx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = base + v * 4 + (Math.random() * 8 - 4);
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0, audioCtx.currentTime);
      g.gain.linearRampToValueAtTime(0.06, audioCtx.currentTime + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.6 + Math.random() * 0.4);
      o.connect(g); g.connect(out);
      o.start(); o.stop(audioCtx.currentTime + 1.2);
    }
    timer = setTimeout(hit, (interval + Math.random() * interval) * 1000);
  }
  hit();
  return { _stopFn: () => clearTimeout(timer) };
}

// Sintetizador de pulso analógico grave (bajo carpenteriano)
function synthPulseBass(def, rate, out) {
  const note = def.note || 41.2;
  const bpm = 90 + (rate / 60) * 70;
  const stepTime = 60 / bpm;
  let timer;
  function pulse() {
    if (!isAudioEngineActive()) return;
    const o = audioCtx.createOscillator();
    o.type = 'square';
    o.frequency.value = note;
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    lp.Q.value = 8;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0, audioCtx.currentTime);
    g.gain.linearRampToValueAtTime(0.34, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + stepTime * 0.7);
    o.connect(lp); lp.connect(g); g.connect(out);
    o.start(); o.stop(audioCtx.currentTime + stepTime);
    timer = setTimeout(pulse, stepTime * 1000);
  }
  pulse();
  return { _stopFn: () => clearTimeout(timer) };
}

// Coro de susurros procesados (estilo Goblin "Suspiria")
function synthWhisperChoir(def, rate, out) {
  const buf = makeNoiseBuffer('white', 4);
  const src = loopNoise(buf);
  const bp = audioCtx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1600;
  bp.Q.value = 4;
  const lfo = audioCtx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.3 + (rate / 60) * 1.2;
  const lfoG = audioCtx.createGain();
  lfoG.gain.value = 900;
  lfo.connect(lfoG); lfoG.connect(bp.frequency);
  lfo.start();
  const ampLfo = audioCtx.createOscillator();
  ampLfo.frequency.value = 0.4;
  const ampG = audioCtx.createGain();
  ampG.gain.value = 0.13;
  const mixGainWC = audioCtx.createGain(); mixGainWC.gain.value = 1.0;
  src.connect(bp); bp.connect(mixGainWC); mixGainWC.connect(out);
  ampLfo.connect(ampG); ampG.connect(mixGainWC.gain);
  ampLfo.start();
  return { src, lfo, lfoG, mixGainWC, _stopFn: () => { try { ampLfo.stop(); } catch(e){} } };
}

// ═══ TENSIÓN & SUSPENSE ═══

// Risset glissando — ilusión de tono que sube/baja infinitamente
function synthRisset(def, rate, out) {
  const dir = def.dir || 1; // 1 sube, -1 baja
  const voices = 6;
  const dur = Math.max(4, 14 - (rate / 60) * 9);
  const oscs = [];
  for (let v = 0; v < voices; v++) {
    const o = audioCtx.createOscillator();
    o.type = 'sine';
    const g = audioCtx.createGain();
    g.gain.value = 0;
    o.connect(g); g.connect(out);
    o.start();
    oscs.push({ o, g, phase: v / voices });
  }
  let raf;
  const t0 = audioCtx.currentTime;
  function tick() {
    if (!isAudioEngineActive()) return;
    const t = (audioCtx.currentTime - t0) / dur;
    oscs.forEach(v => {
      let p = (v.phase + (dir > 0 ? t : -t)) % 1;
      if (p < 0) p += 1;
      const freq = 55 * Math.pow(2, p * 5);
      v.o.frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.02);
      const amp = Math.sin(p * Math.PI) * 0.12;
      v.g.gain.setTargetAtTime(amp, audioCtx.currentTime, 0.02);
    });
    raf = setTimeout(tick, 40);
  }
  tick();
  return { oscs, _stopFn: () => clearTimeout(raf) };
}

// Tremolo de cuerdas (sul ponticello, tipo Herrmann/Psycho)
function synthTremoloStrings(def, rate, out) {
  const base = def.base || 220;
  const ratios = def.ratios || [1, 1.19, 1.5];
  const oscs = ratios.map(r => {
    const o = audioCtx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = base * r;
    const g = audioCtx.createGain();
    g.gain.value = 0.05;
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = base * r * 3;
    bp.Q.value = 2;
    o.connect(bp); bp.connect(g); g.connect(out);
    o.start();
    return { o, g, bp };
  });
  const trem = audioCtx.createOscillator();
  trem.type = 'sine';
  trem.frequency.value = 8 + (rate / 60) * 14;
  const tremG = audioCtx.createGain();
  tremG.gain.value = 0.5;
  const mixGainTS = audioCtx.createGain(); mixGainTS.gain.value = 1.0;
  oscs.forEach(({ g }) => { g.disconnect(out); g.connect(mixGainTS); });
  mixGainTS.connect(out);
  trem.connect(tremG); tremG.connect(mixGainTS.gain);
  trem.start();
  return { oscs, mixGainTS, _stopFn: () => { try { trem.stop(); } catch(e){} } };
}

// Zumbido de alta frecuencia (tinnitus inquietante)
function synthHighTension(def, rate, out) {
  const o = audioCtx.createOscillator();
  o.type = 'sine';
  o.frequency.value = def.freq || 5200;
  const g = audioCtx.createGain();
  g.gain.value = 0.04;
  const lfo = audioCtx.createOscillator();
  lfo.frequency.value = 0.1;
  const lfoG = audioCtx.createGain();
  lfoG.gain.value = 30;
  lfo.connect(lfoG); lfoG.connect(o.frequency);
  o.connect(g); g.connect(out);
  o.start(); lfo.start();
  return { osc: o, lfo, lfoG, g };
}

// Bordón grave creciente
function synthSwell(def, rate, out) {
  const freqs = def.freqs || [40, 60, 80];
  const oscs = freqs.map(f => {
    const o = audioCtx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const g = audioCtx.createGain();
    g.gain.value = 0.06;
    o.connect(g); g.connect(out);
    o.start();
    return { o, g };
  });
  const period = Math.max(6, 18 - (rate / 60) * 12);
  const lfo = audioCtx.createOscillator();
  lfo.type = 'sawtooth';
  lfo.frequency.value = 1 / period;
  const lfoG = audioCtx.createGain();
  lfoG.gain.value = 0.5;
  const mixGainS = audioCtx.createGain();
  mixGainS.gain.value = 1.0;
  oscs.forEach(({ g }) => { g.disconnect(out); g.connect(mixGainS); });
  mixGainS.connect(out);
  lfo.connect(lfoG); lfoG.connect(mixGainS.gain);
  lfo.start();
  return { oscs, mixGainS, _stopFn: () => { try { lfo.stop(); } catch(e){} } };
}

// Cluster de metales disonante
function synthBrassCluster(def, rate, out) {
  const base = def.base || 110;
  const semis = [0, 1, 6, 7];
  const oscs = semis.map(s => {
    const o = audioCtx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = base * Math.pow(2, s / 12);
    const g = audioCtx.createGain();
    g.gain.value = 0.05;
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1200;
    o.connect(lp); lp.connect(g); g.connect(out);
    o.start();
    return { o, g, lp };
  });
  return { oscs };
}

// ═══ PERCUSIÓN & GOLPES ═══

// Braam — el "BWAAAM" de tráiler
function synthBraam(def, rate, out) {
  const interval = Math.max(8, 36 - (rate / 60) * 28);
  let timer;
  function hit() {
    if (!isAudioEngineActive()) return;
    const base = 55;
    [1, 1.5, 2, 0.5].forEach(mult => {
      const o = audioCtx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = base * mult;
      const lp = audioCtx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(300, audioCtx.currentTime);
      lp.frequency.exponentialRampToValueAtTime(1800, audioCtx.currentTime + 0.6);
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0, audioCtx.currentTime);
      g.gain.linearRampToValueAtTime(0.12, audioCtx.currentTime + 0.15);
      g.gain.setValueAtTime(0.12, audioCtx.currentTime + 1.2);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 2.2);
      o.connect(lp); lp.connect(g); g.connect(out);
      o.start(); o.stop(audioCtx.currentTime + 2.5);
    });
    timer = setTimeout(hit, (interval + Math.random() * interval * 0.5) * 1000);
  }
  hit();
  return { _stopFn: () => clearTimeout(timer) };
}

// Impacto de tambor profundo (boom)
function synthBoom(def, rate, out) {
  const bpm = 20 + (rate / 60) * 60;
  const interval = 60 / bpm;
  let timer;
  function boom() {
    if (!isAudioEngineActive()) return;
    const o = audioCtx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, audioCtx.currentTime);
    o.frequency.exponentialRampToValueAtTime(35, audioCtx.currentTime + 0.4);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.6, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.8);
    o.connect(g); g.connect(out);
    o.start(); o.stop(audioCtx.currentTime + 1);
    timer = setTimeout(boom, interval * 1000);
  }
  boom();
  return { _stopFn: () => clearTimeout(timer) };
}

// Redoble creciente de timbales
function synthRoll(def, rate, out) {
  const buf = makeNoiseBuffer('brown', 2);
  const src = loopNoise(buf);
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 200;
  const g = audioCtx.createGain();
  g.gain.value = 0.2;
  const trem = audioCtx.createOscillator();
  trem.type = 'square';
  trem.frequency.value = 14 + (rate / 60) * 16;
  const tremG = audioCtx.createGain();
  tremG.gain.value = 0.5;
  trem.connect(tremG); tremG.connect(g.gain);
  src.connect(lp); lp.connect(g); g.connect(out);
  trem.start();
  return { src, _stopFn: () => { try { trem.stop(); } catch(e){} } };
}

// Latido acelerándose
function synthRacingHeart(def, rate, out) {
  let bpm = 60 + (rate / 60) * 80;
  let timer;
  function beat() {
    if (!isAudioEngineActive()) return;
    [0, 0.14].forEach(off => {
      setTimeout(() => {
        if (!isAudioEngineActive()) return;
        const o = audioCtx.createOscillator();
        o.type = 'sine';
        o.frequency.value = 55;
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(0, audioCtx.currentTime);
        g.gain.linearRampToValueAtTime(0.45, audioCtx.currentTime + 0.03);
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);
        o.connect(g); g.connect(out);
        o.start(); o.stop(audioCtx.currentTime + 0.22);
      }, off * 1000);
    });
    timer = setTimeout(beat, (60 / bpm) * 1000);
  }
  beat();
  return { _stopFn: () => clearTimeout(timer) };
}

// ═══ TEXTURAS ORGÁNICAS PERTURBADORAS ═══

function synthBreathing(def, rate, out) {
  const buf = makeNoiseBuffer('white', 4);
  const src = loopNoise(buf);
  const bp = audioCtx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 500;
  bp.Q.value = 1.5;
  const g = audioCtx.createGain();
  g.gain.value = 0;
  const breath = audioCtx.createOscillator();
  breath.type = 'sine';
  breath.frequency.value = 0.2 + (rate / 60) * 0.4;
  const breathG = audioCtx.createGain();
  breathG.gain.value = 0.3;
  breath.connect(breathG); breathG.connect(g.gain);
  src.connect(bp); bp.connect(g); g.connect(out);
  breath.start();
  return { src, _stopFn: () => { try { breath.stop(); } catch(e){} } };
}

function synthScratch(def, rate, out) {
  const interval = Math.max(0.8, 5 - (rate / 60) * 4);
  let timer;
  function scratch() {
    if (!isAudioEngineActive()) return;
    const buf = makeNoiseBuffer('white', 0.4);
    const s = audioCtx.createBufferSource();
    s.buffer = buf;
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2500 + Math.random() * 2000;
    bp.Q.value = 6;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.18, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
    s.connect(bp); bp.connect(g); g.connect(out);
    s.start(); s.stop(audioCtx.currentTime + 0.3);
    timer = setTimeout(scratch, (interval + Math.random() * interval) * 1000);
  }
  scratch();
  return { _stopFn: () => clearTimeout(timer) };
}

function synthFlies(def, rate, out) {
  const o = audioCtx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = 140;
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  const lfo = audioCtx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 7 + (rate / 60) * 8;
  const lfoG = audioCtx.createGain();
  lfoG.gain.value = 40;
  lfo.connect(lfoG); lfoG.connect(o.frequency);
  const g = audioCtx.createGain();
  g.gain.value = 0.07;
  o.connect(lp); lp.connect(g); g.connect(out);
  o.start(); lfo.start();
  return { osc: o, lfo, lfoG, g };
}

// Risa infantil distorsionada (textura, no muestra real)
function synthChildLaugh(def, rate, out) {
  const interval = Math.max(4, 18 - (rate / 60) * 12);
  let timer;
  function laugh() {
    if (!isAudioEngineActive()) return;
    const reps = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < reps; i++) {
      setTimeout(() => {
        if (!isAudioEngineActive()) return;
        const o = audioCtx.createOscillator();
        o.type = 'triangle';
        const base = 500 + Math.random() * 300;
        o.frequency.setValueAtTime(base, audioCtx.currentTime);
        o.frequency.linearRampToValueAtTime(base * 1.4, audioCtx.currentTime + 0.08);
        o.frequency.linearRampToValueAtTime(base, audioCtx.currentTime + 0.16);
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(0, audioCtx.currentTime);
        g.gain.linearRampToValueAtTime(0.1, audioCtx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
        o.connect(g); g.connect(out);
        o.start(); o.stop(audioCtx.currentTime + 0.25);
      }, i * 180);
    }
    timer = setTimeout(laugh, (interval + Math.random() * interval) * 1000);
  }
  laugh();
  return { _stopFn: () => clearTimeout(timer) };
}

function synthBoneCrack(def, rate, out) {
  const interval = Math.max(3, 16 - (rate / 60) * 12);
  let timer;
  function crack() {
    if (!isAudioEngineActive()) return;
    const reps = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < reps; i++) {
      setTimeout(() => {
        if (!isAudioEngineActive()) return;
        const buf = makeNoiseBuffer('white', 0.1);
        const s = audioCtx.createBufferSource();
        s.buffer = buf;
        const bp = audioCtx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 800 + Math.random() * 600;
        bp.Q.value = 8;
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(0.3, audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.06);
        s.connect(bp); bp.connect(g); g.connect(out);
        s.start(); s.stop(audioCtx.currentTime + 0.08);
      }, i * (60 + Math.random() * 80));
    }
    timer = setTimeout(crack, (interval + Math.random() * interval) * 1000);
  }
  crack();
  return { _stopFn: () => clearTimeout(timer) };
}

// ═══ INSTRUMENTOS EMBRUJADOS ═══

function synthPreparedPiano(def, rate, out) {
  const scale = def.scale || [110, 146.8, 164.8, 220, 246.9];
  const interval = Math.max(1.5, 6 - (rate / 60) * 4);
  let timer;
  function note() {
    if (!isAudioEngineActive()) return;
    const f = scale[Math.floor(Math.random() * scale.length)];
    [1, 2.76, 5.4].forEach((mult, k) => {
      const o = audioCtx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mult;
      const g = audioCtx.createGain();
      const amp = 0.16 / (k + 1);
      g.gain.setValueAtTime(amp, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 2.5 + Math.random());
      o.connect(g); g.connect(out);
      o.start(); o.stop(audioCtx.currentTime + 3.5);
    });
    timer = setTimeout(note, (interval + Math.random() * interval) * 1000);
  }
  note();
  return { _stopFn: () => clearTimeout(timer) };
}

function synthTheremin(def, rate, out) {
  const o = audioCtx.createOscillator();
  o.type = 'sine';
  o.frequency.value = def.freq || 440;
  const g = audioCtx.createGain();
  g.gain.value = 0.08;
  const lfo = audioCtx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.15 + (rate / 60) * 0.5;
  const lfoG = audioCtx.createGain();
  lfoG.gain.value = 120;
  lfo.connect(lfoG); lfoG.connect(o.frequency);
  const vib = audioCtx.createOscillator();
  vib.frequency.value = 6;
  const vibG = audioCtx.createGain();
  vibG.gain.value = 8;
  vib.connect(vibG); vibG.connect(o.frequency);
  o.connect(g); g.connect(out);
  o.start(); lfo.start(); vib.start();
  return { osc: o, lfo, lfoG, _stopFn: () => { try { vib.stop(); } catch(e){} } };
}

function synthBowedString(def, rate, out) {
  const o = audioCtx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = def.freq || 196;
  const bp = audioCtx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = (def.freq || 196) * 4;
  bp.Q.value = 4;
  const g = audioCtx.createGain();
  g.gain.value = 0.07;
  const scratch = audioCtx.createOscillator();
  scratch.type = 'sine';
  scratch.frequency.value = 11 + (rate / 60) * 10;
  const scratchG = audioCtx.createGain();
  scratchG.gain.value = 0.3;
  scratch.connect(scratchG); scratchG.connect(g.gain);
  o.connect(bp); bp.connect(g); g.connect(out);
  o.start(); scratch.start();
  return { osc: o, _stopFn: () => { try { scratch.stop(); } catch(e){} } };
}

function synthInvertedBell(def, rate, out) {
  const interval = Math.max(3, 14 - (rate / 60) * 10);
  let timer;
  function bell() {
    if (!isAudioEngineActive()) return;
    const f = def.freq || 200;
    [1, 2.4, 3.1, 4.7].forEach((mult, k) => {
      const o = audioCtx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mult;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.12 / (k + 1), audioCtx.currentTime + 1.8);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 2.2);
      o.connect(g); g.connect(out);
      o.start(); o.stop(audioCtx.currentTime + 2.4);
    });
    timer = setTimeout(bell, (interval + Math.random() * interval) * 1000);
  }
  bell();
  return { _stopFn: () => clearTimeout(timer) };
}

// ═══ INDUSTRIAL SINIESTRO ═══

function synthMachinery(def, rate, out) {
  const o = audioCtx.createOscillator();
  o.type = 'square';
  o.frequency.value = 45;
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 400;
  const clank = audioCtx.createOscillator();
  clank.type = 'square';
  clank.frequency.value = 2 + (rate / 60) * 4;
  const clankG = audioCtx.createGain();
  clankG.gain.value = 0.4;
  const mixGainMC = audioCtx.createGain(); mixGainMC.gain.value = 1.0; mixGainMC.connect(out);
  clank.connect(clankG); clankG.connect(mixGainMC.gain);
  const g = audioCtx.createGain();
  g.gain.value = 0.12;
  o.connect(lp); lp.connect(g); g.connect(mixGainMC);
  o.start(); clank.start();
  return { osc: o, mixGainMC, _stopFn: () => { try { clank.stop(); } catch(e){} } };
}

function synthChainDrag(def, rate, out) {
  const interval = Math.max(2, 10 - (rate / 60) * 7);
  let timer;
  function drag() {
    if (!isAudioEngineActive()) return;
    const buf = makeNoiseBuffer('white', 1);
    const s = audioCtx.createBufferSource();
    s.buffer = buf;
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 3;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0, audioCtx.currentTime);
    g.gain.linearRampToValueAtTime(0.12, audioCtx.currentTime + 0.1);
    g.gain.linearRampToValueAtTime(0.001, audioCtx.currentTime + 0.7 + Math.random() * 0.5);
    const trem = audioCtx.createOscillator();
    trem.type = 'square';
    trem.frequency.value = 18;
    const tremG = audioCtx.createGain();
    tremG.gain.value = 0.5;
    trem.connect(tremG); tremG.connect(g.gain);
    s.connect(bp); bp.connect(g); g.connect(out);
    s.start(); s.stop(audioCtx.currentTime + 1.3);
    trem.start(); trem.stop(audioCtx.currentTime + 1.3);
    timer = setTimeout(drag, (interval + Math.random() * interval) * 1000);
  }
  drag();
  return { _stopFn: () => clearTimeout(timer) };
}

function synthStatic(def, rate, out) {
  const buf = makeNoiseBuffer('white', 3);
  const src = loopNoise(buf);
  const hp = audioCtx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2000;
  const g = audioCtx.createGain();
  g.gain.value = 0.1;
  const crackle = audioCtx.createOscillator();
  crackle.type = 'square';
  crackle.frequency.value = 3 + (rate / 60) * 20;
  const crackleG = audioCtx.createGain();
  crackleG.gain.value = 0.4;
  crackle.connect(crackleG); crackleG.connect(g.gain);
  src.connect(hp); hp.connect(g); g.connect(out);
  crackle.start();
  return { src, _stopFn: () => { try { crackle.stop(); } catch(e){} } };
}

function synthFailingGenerator(def, rate, out) {
  const o = audioCtx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = 80;
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 600;
  const dip = audioCtx.createOscillator();
  dip.type = 'sine';
  dip.frequency.value = 0.2 + (rate / 60) * 0.6;
  const dipG = audioCtx.createGain();
  dipG.gain.value = 25;
  dip.connect(dipG); dipG.connect(o.frequency);
  const g = audioCtx.createGain();
  g.gain.value = 0.1;
  o.connect(lp); lp.connect(g); g.connect(out);
  o.start(); dip.start();
  return { osc: o, _stopFn: () => { try { dip.stop(); } catch(e){} } };
}

// ═══ SYNTH DE GÉNERO ═══

function synthSynthwave(def, rate, out) {
  const seq = def.seq || [55, 55, 65.4, 55, 73.4, 65.4, 55, 49];
  const bpm = 100 + (rate / 60) * 80;
  const stepTime = 60 / bpm / 2;
  let i = 0, timer;
  function step() {
    if (!isAudioEngineActive()) return;
    const o = audioCtx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = seq[i % seq.length];
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 800 + (i % 4) * 300;
    lp.Q.value = 8;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.22, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + stepTime * 0.9);
    o.connect(lp); lp.connect(g); g.connect(out);
    o.start(); o.stop(audioCtx.currentTime + stepTime);
    i++;
    timer = setTimeout(step, stepTime * 1000);
  }
  step();
  return { _stopFn: () => clearTimeout(timer) };
}

function synthFrozenChord(def, rate, out) {
  const base = def.base || 110;
  const intervals = def.intervals || [0, 3, 6, 10];
  const oscs = intervals.map(s => {
    const o = audioCtx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = base * Math.pow(2, s / 12);
    const g = audioCtx.createGain();
    g.gain.value = 0.05;
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    o.connect(lp); lp.connect(g); g.connect(out);
    o.start();
    return { o, g, lp };
  });
  return { oscs };
}

function synthFilterSweep(def, rate, out) {
  const buf = makeNoiseBuffer('white', 4);
  const src = loopNoise(buf);
  const bp = audioCtx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 400;
  bp.Q.value = 5;
  const sweep = audioCtx.createOscillator();
  sweep.type = 'sine';
  sweep.frequency.value = 0.05 + (rate / 60) * 0.2;
  const sweepG = audioCtx.createGain();
  sweepG.gain.value = 1500;
  sweep.connect(sweepG); sweepG.connect(bp.frequency);
  const g = audioCtx.createGain();
  g.gain.value = 0.14;
  src.connect(bp); bp.connect(g); g.connect(out);
  sweep.start();
  return { src, _stopFn: () => { try { sweep.stop(); } catch(e){} } };
}


// ═══ LOVECRAFT & MITOLOGÍA ═══

function synthCthulhuCall(def, rate, out) {
  const baseFreqs = [36.7, 38.9, 41.2, 43.7, 46.2];
  const oscs = baseFreqs.map((f, i) => {
    const o = audioCtx.createOscillator();
    o.type = i % 2 === 0 ? 'sawtooth' : 'triangle';
    o.frequency.value = f;
    const lfo = audioCtx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 0.03 + i * 0.011;
    const lfoG = audioCtx.createGain(); lfoG.gain.value = 3 + i;
    lfo.connect(lfoG); lfoG.connect(o.frequency);
    const g = audioCtx.createGain(); g.gain.value = 0.06;
    o.connect(g); g.connect(out); o.start(); lfo.start();
    return { o, lfo, lfoG, g };
  });
  const infra = audioCtx.createOscillator();
  infra.frequency.value = 19;
  const infraG = audioCtx.createGain(); infraG.gain.value = 0.08;
  const mixGainCC = audioCtx.createGain(); mixGainCC.gain.value = 1.0; mixGainCC.connect(out);
  oscs.forEach(({ g }) => { g.disconnect(out); g.connect(mixGainCC); });
  infra.connect(infraG); infraG.connect(mixGainCC.gain); infra.start();
  return { oscs, mixGainCC, _stopFn: () => { try { infra.stop(); } catch(e){} } };
}

function synthRlyehChoir(def, rate, out) {
  const buf = makeNoiseBuffer('brown', 5);
  const src = loopNoise(buf);
  const oscs = [0,1,2,3].map(i => {
    const o = audioCtx.createOscillator(); o.type = 'sine';
    o.frequency.value = 110 * Math.pow(2, i * 0.5 / 12);
    const g = audioCtx.createGain(); g.gain.value = 0.06;
    const lfo = audioCtx.createOscillator(); lfo.type = 'sine';
    lfo.frequency.value = 0.07 + i * 0.031;
    const lfoG = audioCtx.createGain(); lfoG.gain.value = 4;
    lfo.connect(lfoG); lfoG.connect(o.frequency);
    o.connect(g); g.connect(out); o.start(); lfo.start();
    return { o, lfo, lfoG, g };
  });
  const bp = audioCtx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 300; bp.Q.value = 0.5;
  src.connect(bp); bp.connect(out);
  return { src, oscs };
}

function synthAzathothBeat(def, rate, out) {
  const primes = [2, 3, 5, 7, 11];
  const timers = [];
  primes.forEach((p, i) => {
    const interval = (p * 0.18) + (rate / 60) * 0.08;
    let t;
    function hit() {
      if (!isAudioEngineActive()) return;
      const o = audioCtx.createOscillator(); o.type = 'sine';
      o.frequency.value = 30 + p * 8;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.18, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
      o.connect(g); g.connect(out); o.start(); o.stop(audioCtx.currentTime + 0.35);
      t = setTimeout(hit, interval * 1000 * (1 + Math.sin(audioCtx.currentTime * 0.1) * 0.3));
    }
    hit(); timers.push({ _stopFn: () => clearTimeout(t) });
  });
  return { _stopFn: () => timers.forEach(x => x._stopFn()) };
}

function synthYuggothSignal(def, rate, out) {
  const buf = makeNoiseBuffer('white', 4); const src = loopNoise(buf);
  const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 800; bp.Q.value = 12;
  const lfo = audioCtx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 3 + (rate/60)*5;
  const lfoG = audioCtx.createGain(); lfoG.gain.value = 600;
  lfo.connect(lfoG); lfoG.connect(bp.frequency);
  const g = audioCtx.createGain(); g.gain.value = 0.12;
  const ampLfo = audioCtx.createOscillator(); ampLfo.type = 'square'; ampLfo.frequency.value = 1.7;
  const ampG = audioCtx.createGain(); ampG.gain.value = 0.35;
  ampLfo.connect(ampG); ampG.connect(g.gain);
  src.connect(bp); bp.connect(g); g.connect(out); lfo.start(); ampLfo.start();
  return { src, lfo, lfoG, _stopFn: () => { try { ampLfo.stop(); } catch(e){} } };
}

function synthNyarlathotep(def, rate, out) {
  const freqs = [200, 280, 390, 540];
  const oscs = freqs.map((f, i) => {
    const o = audioCtx.createOscillator(); o.type = i < 2 ? 'sawtooth' : 'sine'; o.frequency.value = f;
    const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f*2; bp.Q.value = 6;
    const lfo = audioCtx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.1 + i*0.07;
    const lfoG = audioCtx.createGain(); lfoG.gain.value = f*0.15;
    lfo.connect(lfoG); lfoG.connect(o.frequency);
    const g = audioCtx.createGain(); g.gain.value = 0.05;
    o.connect(bp); bp.connect(g); g.connect(out); o.start(); lfo.start();
    return { o, lfo, lfoG, g, bp };
  });
  return { oscs };
}

function synthInnsmouthDeep(def, rate, out) {
  const buf = makeNoiseBuffer('brown', 6); const src = loopNoise(buf);
  const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300;
  const mixGainID = audioCtx.createGain(); mixGainID.gain.value = 1.0; mixGainID.connect(out);
  const waveLfo = audioCtx.createOscillator(); waveLfo.frequency.value = 0.08;
  const waveG = audioCtx.createGain(); waveG.gain.value = 0.35;
  waveLfo.connect(waveG); waveG.connect(mixGainID.gain);
  const toneOscs = [55, 82, 110].map(f => {
    const o = audioCtx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const g = audioCtx.createGain(); g.gain.value = 0.04;
    const lp2 = audioCtx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 200;
    o.connect(lp2); lp2.connect(g); g.connect(mixGainID); o.start();
    return o;
  });
  src.connect(lp); lp.connect(mixGainID); waveLfo.start();
  return { src, lp, mixGainID, _stopFn: () => {
    try { waveLfo.stop(); } catch(e){}
    toneOscs.forEach(o => { try { o.stop(); } catch(e){} });
  }};
}

function synthAzathothFlutes(def, rate, out) {
  const buf = makeNoiseBuffer('white', 3); const src = loopNoise(buf);
  const interval = Math.max(0.3, 2 - (rate/60)*1.6);
  let timer;
  function pipe() {
    if (!isAudioEngineActive()) return;
    const f = 400 + Math.random()*1600;
    const o = audioCtx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    o.frequency.setTargetAtTime(f*(0.7+Math.random()*0.6), audioCtx.currentTime, 0.1);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0, audioCtx.currentTime);
    g.gain.linearRampToValueAtTime(0.1, audioCtx.currentTime+0.05);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+0.3+Math.random()*0.4);
    o.connect(g); g.connect(out); o.start(); o.stop(audioCtx.currentTime+0.8);
    timer = setTimeout(pipe, (interval+Math.random()*interval)*1000);
  }
  const hp = audioCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
  const ng = audioCtx.createGain(); ng.gain.value = 0.04;
  src.connect(hp); hp.connect(ng); ng.connect(out); pipe();
  return { src, _stopFn: () => clearTimeout(timer) };
}

function synthShoggoth(def, rate, out) {
  const buf = makeNoiseBuffer('brown', 4); const src = loopNoise(buf);
  const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400;
  const g = audioCtx.createGain(); g.gain.value = 0.14;
  const lfo = audioCtx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 4+(rate/60)*6;
  const lfoG = audioCtx.createGain(); lfoG.gain.value = 300;
  lfo.connect(lfoG); lfoG.connect(lp.frequency);
  const interval = Math.max(0.5, 3-(rate/60)*2.5);
  let timer;
  function tekeli() {
    if (!isAudioEngineActive()) return;
    const o = audioCtx.createOscillator(); o.type = 'sawtooth';
    o.frequency.value = 800+Math.random()*1200;
    o.frequency.exponentialRampToValueAtTime(200+Math.random()*400, audioCtx.currentTime+0.15);
    const og = audioCtx.createGain();
    og.gain.setValueAtTime(0.08, audioCtx.currentTime);
    og.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+0.2);
    o.connect(og); og.connect(out); o.start(); o.stop(audioCtx.currentTime+0.25);
    timer = setTimeout(tekeli, (interval+Math.random()*interval)*1000);
  }
  src.connect(lp); lp.connect(g); g.connect(out); lfo.start(); tekeli();
  return { src, lfo, lfoG, _stopFn: () => clearTimeout(timer) };
}

function synthMiGo(def, rate, out) {
  const o = audioCtx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 180;
  const lfo = audioCtx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 40+(rate/60)*30;
  const lfoG = audioCtx.createGain(); lfoG.gain.value = 60;
  lfo.connect(lfoG); lfoG.connect(o.frequency);
  const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 3;
  const g = audioCtx.createGain(); g.gain.value = 0.08;
  o.connect(bp); bp.connect(g); g.connect(out); o.start(); lfo.start();
  return { osc: o, lfo, lfoG, g };
}

function synthYogSothoth(def, rate, out) {
  const freqs = [55, 82.4, 110, 164.8, 220, 329.6];
  const oscs = freqs.map(f => {
    const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const g = audioCtx.createGain(); g.gain.value = 0.03;
    const lfo = audioCtx.createOscillator(); lfo.frequency.value = 0.02+Math.random()*0.05;
    const lfoG = audioCtx.createGain(); lfoG.gain.value = f*0.05;
    lfo.connect(lfoG); lfoG.connect(o.frequency);
    o.connect(g); g.connect(out); o.start(); lfo.start();
    return { o, lfo, lfoG, g };
  });
  return { oscs };
}

function synthDagonDepth(def, rate, out) {
  const buf = makeNoiseBuffer('brown', 8); const src = loopNoise(buf);
  const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 80;
  const g = audioCtx.createGain(); g.gain.value = 0.2;
  const pulse = audioCtx.createOscillator(); pulse.type = 'sine'; pulse.frequency.value = 0.015;
  const pulseG = audioCtx.createGain(); pulseG.gain.value = 0.6;
  pulse.connect(pulseG); pulseG.connect(g.gain);
  src.connect(lp); lp.connect(g); g.connect(out); pulse.start();
  return { src, lp, _stopFn: () => { try { pulse.stop(); } catch(e){} } };
}

function synthHasturWind(def, rate, out) {
  const buf = makeNoiseBuffer('brown', 5); const src = loopNoise(buf);
  const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.8;
  const g = audioCtx.createGain(); g.gain.value = 0.1;
  const lfo = audioCtx.createOscillator(); lfo.type = 'sawtooth'; lfo.frequency.value = 0.04;
  const lfoG = audioCtx.createGain(); lfoG.gain.value = 400;
  lfo.connect(lfoG); lfoG.connect(bp.frequency);
  const wrong = audioCtx.createOscillator(); wrong.type = 'sine'; wrong.frequency.value = 311.1;
  const wg = audioCtx.createGain(); wg.gain.value = 0.02;
  wrong.connect(wg); wg.connect(out);
  src.connect(bp); bp.connect(g); g.connect(out); lfo.start(); wrong.start();
  return { src, lfo, lfoG, _stopFn: () => { try { wrong.stop(); } catch(e){} } };
}

function synthSleepingGodBreath(def, rate, out) {
  const buf = makeNoiseBuffer('brown', 4); const src = loopNoise(buf);
  const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 200;
  const g = audioCtx.createGain(); g.gain.value = 0.1;
  const lfo = audioCtx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 1/35;
  const lfoG = audioCtx.createGain(); lfoG.gain.value = 0.7;
  lfo.connect(lfoG); lfoG.connect(g.gain);
  src.connect(lp); lp.connect(g); g.connect(out); lfo.start();
  return { src, lfo, lfoG };
}

function synthNonEuclideanEcho(def, rate, out) {
  const buf = makeNoiseBuffer('white', 2); const src = loopNoise(buf);
  const hp = audioCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1500;
  const g = audioCtx.createGain(); g.gain.value = 0.06;
  const lfos = [0.137, 0.271, 0.414, 0.618].map(ratio => {
    const lfo = audioCtx.createOscillator(); lfo.type = 'sine';
    lfo.frequency.value = ratio*(1+(rate/60)*0.5);
    const lfoG = audioCtx.createGain(); lfoG.gain.value = 200;
    lfo.connect(lfoG); lfoG.connect(hp.frequency); lfo.start();
    return { lfo, lfoG };
  });
  src.connect(hp); hp.connect(g); g.connect(out);
  return { src, _stopFn: () => lfos.forEach(({ lfo }) => { try { lfo.stop(); } catch(e){} }) };
}

// ═══ PSICOACÚSTICA ═══

function synthInfrasound19(def, rate, out) {
  const buf = makeNoiseBuffer('brown', 4); const src = loopNoise(buf);
  const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 120;
  const g = audioCtx.createGain(); g.gain.value = 0.15;
  const infra = audioCtx.createOscillator(); infra.type = 'sine'; infra.frequency.value = 19;
  const infraG = audioCtx.createGain(); infraG.gain.value = 0.5;
  infra.connect(infraG); infraG.connect(g.gain);
  src.connect(lp); lp.connect(g); g.connect(out); infra.start();
  return { src, lp, _stopFn: () => { try { infra.stop(); } catch(e){} } };
}

function synthBinaural(def, rate, out) {
  const carrier = def.carrier || 200; const beat = def.beat || 10;
  const oL = audioCtx.createOscillator(); oL.type = 'sine'; oL.frequency.value = carrier;
  const oR = audioCtx.createOscillator(); oR.type = 'sine'; oR.frequency.value = carrier + beat;
  const merger = audioCtx.createChannelMerger(2);
  const gL = audioCtx.createGain(); gL.gain.value = 0.12;
  const gR = audioCtx.createGain(); gR.gain.value = 0.12;
  oL.connect(gL); gL.connect(merger, 0, 0);
  oR.connect(gR); gR.connect(merger, 0, 1);
  merger.connect(out); oL.start(); oR.start();
  return { _stopFn: () => { try { oL.stop(); oR.stop(); } catch(e){} } };
}

function synthShepardTone(def, rate, out) {
  const dir = def.dir || -1; const n = 8;
  const dur = Math.max(3, 10-(rate/60)*7);
  const oscs = [];
  for (let v = 0; v < n; v++) {
    const o = audioCtx.createOscillator(); o.type = 'sine';
    const g = audioCtx.createGain(); g.gain.value = 0;
    o.connect(g); g.connect(out); o.start();
    oscs.push({ o, g, phase: v/n });
  }
  let raf; const t0 = audioCtx.currentTime;
  function tick() {
    if (!isAudioEngineActive()) return;
    const t = (audioCtx.currentTime-t0)/dur;
    oscs.forEach(v => {
      let p = (v.phase+(dir>0?t:-t))%1; if(p<0)p+=1;
      v.o.frequency.setTargetAtTime(55*Math.pow(2,p*5), audioCtx.currentTime, 0.05);
      v.g.gain.setTargetAtTime(Math.sin(p*Math.PI)*0.1, audioCtx.currentTime, 0.05);
    });
    raf = setTimeout(tick, 50);
  }
  tick();
  return { oscs, _stopFn: () => clearTimeout(raf) };
}

function synthSchumann(def, rate, out) {
  const buf = makeNoiseBuffer('brown', 4); const src = loopNoise(buf);
  const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 200; bp.Q.value = 0.5;
  const g = audioCtx.createGain(); g.gain.value = 0.12;
  const schumann = audioCtx.createOscillator(); schumann.type = 'sine'; schumann.frequency.value = 7.83;
  const schumannG = audioCtx.createGain(); schumannG.gain.value = 0.25;
  schumann.connect(schumannG); schumannG.connect(g.gain);
  src.connect(bp); bp.connect(g); g.connect(out); schumann.start();
  return { src, _stopFn: () => { try { schumann.stop(); } catch(e){} } };
}

function synthMicrotonal(def, rate, out) {
  const root = def.root || 220;
  const intervals = [0, 1, 1.5, 3.5, 5, 6, 7];
  const oscs = intervals.map(s => {
    const o = audioCtx.createOscillator(); o.type = 'sine';
    o.frequency.value = root*Math.pow(2,s/12);
    const g = audioCtx.createGain(); g.gain.value = 0.04;
    o.connect(g); g.connect(out); o.start();
    return { o, g };
  });
  return { oscs };
}

function synthWholeTone(def, rate, out) {
  const root = def.root || 110;
  const oscs = [0,2,4,6,8,10].map(s => {
    const o = audioCtx.createOscillator(); o.type = 'sine';
    o.frequency.value = root*Math.pow(2,s/12);
    const g = audioCtx.createGain(); g.gain.value = 0.035;
    o.connect(g); g.connect(out); o.start();
    return { o, g };
  });
  return { oscs };
}

function synth111Hz(def, rate, out) {
  const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = 111;
  const g = audioCtx.createGain(); g.gain.value = 0.12;
  const lfo = audioCtx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.1;
  const lfoG = audioCtx.createGain(); lfoG.gain.value = 0.08;
  lfo.connect(lfoG); lfoG.connect(g.gain);
  o.connect(g); g.connect(out); o.start(); lfo.start();
  return { osc: o, lfo, lfoG };
}

function synthFormantVoid(def, rate, out) {
  const formants = [700, 1220, 2600];
  const buf = makeNoiseBuffer('white', 3); const src = loopNoise(buf);
  const lfos = [];
  formants.forEach((f, i) => {
    const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 8+i*3;
    const g = audioCtx.createGain(); g.gain.value = 0.04/(i+1);
    const lfo = audioCtx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.08+i*0.04;
    const lfoG = audioCtx.createGain(); lfoG.gain.value = f*0.1;
    lfo.connect(lfoG); lfoG.connect(bp.frequency);
    src.connect(bp); bp.connect(g); g.connect(out); lfo.start();
    lfos.push(lfo);
  });
  return { src, _stopFn: () => lfos.forEach(lfo => { try { lfo.stop(); } catch(e){} }) };
}

// ═══ PLACER & BIENESTAR ═══

function synthPurr(def, rate, out) {
  const o = audioCtx.createOscillator(); o.type = 'square'; o.frequency.value = 30;
  const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 180;
  const g = audioCtx.createGain(); g.gain.value = 0.08;
  const purrLfo = audioCtx.createOscillator(); purrLfo.type = 'sine'; purrLfo.frequency.value = 0.35;
  const purrG = audioCtx.createGain(); purrG.gain.value = 0.5;
  purrLfo.connect(purrG); purrG.connect(g.gain);
  o.connect(lp); lp.connect(g); g.connect(out); o.start(); purrLfo.start();
  return { osc: o, _stopFn: () => { try { purrLfo.stop(); } catch(e){} } };
}

function synth528Hz(def, rate, out) {
  const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = 528;
  const g = audioCtx.createGain(); g.gain.value = 0.1;
  const harmonics = [];
  [1056, 1584].forEach((f, i) => {
    const oh = audioCtx.createOscillator(); oh.type = 'sine'; oh.frequency.value = f;
    const gh = audioCtx.createGain(); gh.gain.value = 0.03/(i+1);
    oh.connect(gh); gh.connect(out); oh.start();
    harmonics.push(oh);
  });
  o.connect(g); g.connect(out); o.start();
  return { osc: o, _stopFn: () => harmonics.forEach(h => { try { h.stop(); } catch(e){} }) };
}

function synthAlphaWave(def, rate, out) {
  return synthBinaural({ carrier:200, beat:10 }, rate, out);
}

function synthThetaWave(def, rate, out) {
  return synthBinaural({ carrier:180, beat:6 }, rate, out);
}

function synthPerfectFifth(def, rate, out) {
  const root = def.root || 110;
  const oscs = [root, root*1.5, root*2, root*3].map((f, i) => {
    const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const g = audioCtx.createGain(); g.gain.value = 0.08/(i+1);
    o.connect(g); g.connect(out); o.start();
    return o;
  });
  return { _stopFn: () => oscs.forEach(o => { try { o.stop(); } catch(e){} }) };
}

function synthHarmonicSeries(def, rate, out) {
  const root = def.root || 55;
  const oscs = [1,2,3,4,5,6,7,8].map(n => {
    const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = root*n;
    const g = audioCtx.createGain(); g.gain.value = 0.1/n;
    o.connect(g); g.connect(out); o.start();
    return { o, g };
  });
  return { oscs };
}

function synthTibetanBowl(def, rate, out) {
  const f = def.freq || 396;
  const ratios = [1, 2.756, 5.404, 8.933];
  const oscs = ratios.map((r, i) => {
    const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = f*r;
    const g = audioCtx.createGain(); g.gain.value = 0.1/(i+1);
    const lfo = audioCtx.createOscillator(); lfo.frequency.value = 0.5+i*0.3;
    const lfoG = audioCtx.createGain(); lfoG.gain.value = 0.02;
    lfo.connect(lfoG); lfoG.connect(g.gain);
    o.connect(g); g.connect(out); o.start(); lfo.start();
    return { o, lfo, lfoG, g };
  });
  return { oscs };
}

function synthShamandrum(def, rate, out) {
  const bpm = 270+(rate/60)*150; const interval = 60/bpm;
  let timer;
  function drum() {
    if (!isAudioEngineActive()) return;
    const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = 100;
    o.frequency.exponentialRampToValueAtTime(45, audioCtx.currentTime+0.06);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.35, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+0.12);
    o.connect(g); g.connect(out); o.start(); o.stop(audioCtx.currentTime+0.14);
    timer = setTimeout(drum, interval*1000);
  }
  drum();
  return { _stopFn: () => clearTimeout(timer) };
}

function synthNadaBrahma(def, rate, out) {
  const o = audioCtx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 136.1;
  const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 800;
  const g = audioCtx.createGain(); g.gain.value = 0.1;
  const lfo = audioCtx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.05;
  const lfoG = audioCtx.createGain(); lfoG.gain.value = 0.15;
  lfo.connect(lfoG); lfoG.connect(g.gain);
  o.connect(lp); lp.connect(g); g.connect(out); o.start(); lfo.start();
  return { osc: o, lfo, lfoG };
}

function synthWhaleCall(def, rate, out) {
  const interval = Math.max(2, 8-(rate/60)*6);
  let timer;
  function phrase() {
    if (!isAudioEngineActive()) return;
    const segs = 3+Math.floor(Math.random()*3);
    let offset = 0;
    for (let i = 0; i < segs; i++) {
      const dur = 1.5+Math.random()*2;
      const sf = 100+Math.random()*400; const ef = sf*(0.4+Math.random()*1.2);
      setTimeout(() => {
        if (!isAudioEngineActive()) return;
        const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = sf;
        o.frequency.exponentialRampToValueAtTime(ef, audioCtx.currentTime+dur);
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(0, audioCtx.currentTime);
        g.gain.linearRampToValueAtTime(0.12, audioCtx.currentTime+dur*0.15);
        g.gain.setValueAtTime(0.12, audioCtx.currentTime+dur*0.8);
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+dur);
        o.connect(g); g.connect(out); o.start(); o.stop(audioCtx.currentTime+dur+0.1);
      }, offset*1000);
      offset += dur*0.7;
    }
    timer = setTimeout(phrase, (interval+offset+Math.random()*3)*1000);
  }
  phrase();
  return { _stopFn: () => clearTimeout(timer) };
}

function synthDidgeridoo(def, rate, out) {
  const o = audioCtx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 73.4;
  const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400;
  const g = audioCtx.createGain(); g.gain.value = 0.12;
  const circular = audioCtx.createOscillator(); circular.type = 'sine'; circular.frequency.value = 3.5+(rate/60)*2;
  const circG = audioCtx.createGain(); circG.gain.value = 0.3;
  circular.connect(circG); circG.connect(g.gain);
  o.connect(lp); lp.connect(g); g.connect(out); o.start(); circular.start();
  return { osc: o, _stopFn: () => { try { circular.stop(); } catch(e){} } };
}

function synthResolvingPad(def, rate, out) {
  const root = def.root || 220;
  const oscs = [1, 1.25, 1.5, 1.875].map(r => {
    const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = root*r;
    const g = audioCtx.createGain(); g.gain.value = 0.06;
    o.connect(g); g.connect(out); o.start();
    return { o, g };
  });
  return { oscs };
}

// ═══ SECTAS & OCULTISMO ═══

function synthCultChant(def, rate, out) {
  const base = def.base || 110;
  const oscs = [];
  for (let v = 0; v < 6; v++) {
    const o = audioCtx.createOscillator(); o.type = 'triangle';
    o.frequency.value = base*(1+v*0.003);
    const lfo = audioCtx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 4.5+v*0.3;
    const lfoG = audioCtx.createGain(); lfoG.gain.value = 1.5;
    lfo.connect(lfoG); lfoG.connect(o.frequency);
    const g = audioCtx.createGain(); g.gain.value = 0.06;
    o.connect(g); g.connect(out); o.start(); lfo.start();
    oscs.push({ o, lfo, lfoG, g });
  }
  return { oscs };
}

function synthRitualDrums(def, rate, out) {
  const patterns = [
    [0,0.24,0.48,0.72,1.0],
    [0,0.21,0.43,0.64,0.86,1.07,1.29]
  ];
  let pIdx=0, nIdx=0;
  const cycleDur = 1.4+(rate/60)*0.6;
  let timer;
  function beat() {
    if (!isAudioEngineActive()) return;
    const pat = patterns[pIdx%2];
    const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = 70;
    o.frequency.exponentialRampToValueAtTime(30, audioCtx.currentTime+0.08);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.4, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+0.2);
    o.connect(g); g.connect(out); o.start(); o.stop(audioCtx.currentTime+0.25);
    nIdx++;
    if (nIdx>=pat.length) { nIdx=0; pIdx++; }
    const nextDelay = nIdx===0 ? 200 : (pat[nIdx]-(pat[nIdx-1]||0))*cycleDur*1000;
    timer = setTimeout(beat, Math.max(50, nextDelay));
  }
  beat();
  return { _stopFn: () => clearTimeout(timer) };
}

function synthDarkGregory(def, rate, out) {
  const seq = [329.63,293.66,261.63,246.94,220.0,246.94,261.63,329.63]; // E4 D4 C4 B3 A3 B3 C4 E4 — modo frigio real desde E
  const bpm = 30+(rate/60)*20; const dur = 60/bpm;
  let i=0, timer;
  function note() {
    if (!isAudioEngineActive()) return;
    const f = seq[i%seq.length];
    for (let v=0; v<4; v++) {
      const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = f*(1+v*0.002);
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0, audioCtx.currentTime);
      g.gain.linearRampToValueAtTime(0.06, audioCtx.currentTime+dur*0.2);
      g.gain.setValueAtTime(0.06, audioCtx.currentTime+dur*0.7);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+dur*1.05);
      o.connect(g); g.connect(out); o.start(); o.stop(audioCtx.currentTime+dur*1.1);
    }
    i++; timer = setTimeout(note, dur*1000);
  }
  note();
  return { _stopFn: () => clearTimeout(timer) };
}

function synthGlossolalia(def, rate, out) {
  const buf = makeNoiseBuffer('white', 3); const src = loopNoise(buf);
  const g = audioCtx.createGain(); g.gain.value = 0.08;
  const lfos = [];
  [700,1200,2500].forEach((f, i) => {
    const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 8;
    const lfo = audioCtx.createOscillator(); lfo.type = i===0?'sine':'square';
    lfo.frequency.value = 2+(rate/60)*4+i*1.3;
    const lfoG = audioCtx.createGain(); lfoG.gain.value = f*0.4;
    lfo.connect(lfoG); lfoG.connect(bp.frequency);
    src.connect(bp); bp.connect(g); g.connect(out); lfo.start();
    lfos.push(lfo);
  });
  return { src, _stopFn: () => lfos.forEach(lfo => { try { lfo.stop(); } catch(e){} }) };
}

function synthOmCorrupted(def, rate, out) {
  const o = audioCtx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 139;
  const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
  const g = audioCtx.createGain(); g.gain.value = 0.1;
  const lfo = audioCtx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.07;
  const lfoG = audioCtx.createGain(); lfoG.gain.value = 0.2;
  lfo.connect(lfoG); lfoG.connect(g.gain);
  o.connect(lp); lp.connect(g); g.connect(out); o.start(); lfo.start();
  return { osc: o, lfo, lfoG };
}

function synthBlackMass(def, rate, out) {
  const freqs = [65.4,87.3,109.9,138.6];
  const mixGainBM = audioCtx.createGain(); mixGainBM.gain.value = 1.0; mixGainBM.connect(out);
  const oscs = freqs.map((f, i) => {
    const o = audioCtx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300+i*80;
    const g = audioCtx.createGain(); g.gain.value = 0.06;
    o.connect(lp); lp.connect(g); g.connect(mixGainBM); o.start();
    return { o, g, lp };
  });
  const lfo = audioCtx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.03;
  const lfoG = audioCtx.createGain(); lfoG.gain.value = 0.18;
  lfo.connect(lfoG); lfoG.connect(mixGainBM.gain); lfo.start();
  return { oscs, mixGainBM, _stopFn: () => { try { lfo.stop(); } catch(e){} } };
}

function synthDervishSpin(def, rate, out) {
  const buf = makeNoiseBuffer('white', 3); const src = loopNoise(buf);
  const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 800; bp.Q.value = 6;
  const g = audioCtx.createGain(); g.gain.value = 0.1;
  const spin = audioCtx.createOscillator(); spin.type = 'sine'; spin.frequency.value = 0.5+(rate/60)*4;
  const spinG = audioCtx.createGain(); spinG.gain.value = 1500;
  spin.connect(spinG); spinG.connect(bp.frequency);
  src.connect(bp); bp.connect(g); g.connect(out); spin.start();
  return { src, _stopFn: () => { try { spin.stop(); } catch(e){} } };
}

// ═══ AMBIENTES NUEVOS ═══

function synthSwamp(def, rate, out) {
  const buf = makeNoiseBuffer('brown', 5); const src = loopNoise(buf);
  const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 300; bp.Q.value = 0.4;
  const g = audioCtx.createGain(); g.gain.value = 0.1;
  const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = 440;
  const og = audioCtx.createGain(); og.gain.value = 0.02;
  const lfo = audioCtx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 200;
  const lfoG = audioCtx.createGain(); lfoG.gain.value = 0.4;
  lfo.connect(lfoG); lfoG.connect(og.gain);
  o.connect(og); og.connect(out); src.connect(bp); bp.connect(g); g.connect(out);
  o.start(); lfo.start();
  return { src, osc: o, _stopFn: () => { try { lfo.stop(); } catch(e){} } };
}

function synthCircusDark(def, rate, out) {
  const seq = [523,659,784,659,523,659,784,1047];
  const bpm = 40+(rate/60)*30; const stepTime = 60/bpm;
  let i=0, timer;
  function note() {
    if (!isAudioEngineActive()) return;
    const f = seq[i%seq.length]*0.5;
    const o = audioCtx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0, audioCtx.currentTime);
    g.gain.linearRampToValueAtTime(0.12, audioCtx.currentTime+0.02);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+stepTime*1.2);
    o.connect(g); g.connect(out); o.start(); o.stop(audioCtx.currentTime+stepTime*1.3);
    i++; timer = setTimeout(note, stepTime*1000);
  }
  note();
  return { _stopFn: () => clearTimeout(timer) };
}

function synthSubmarineDepth(def, rate, out) {
  const buf = makeNoiseBuffer('brown', 6); const src = loopNoise(buf);
  const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 120;
  const g = audioCtx.createGain(); g.gain.value = 0.12;
  const interval = Math.max(3, 12-(rate/60)*8);
  let timer;
  function ping() {
    if (!isAudioEngineActive()) return;
    const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = 800;
    o.frequency.exponentialRampToValueAtTime(200, audioCtx.currentTime+0.8);
    const pg = audioCtx.createGain();
    pg.gain.setValueAtTime(0.15, audioCtx.currentTime);
    pg.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+1.2);
    o.connect(pg); pg.connect(out); o.start(); o.stop(audioCtx.currentTime+1.3);
    timer = setTimeout(ping, (interval+Math.random()*interval)*1000);
  }
  src.connect(lp); lp.connect(g); g.connect(out); ping();
  return { src, _stopFn: () => clearTimeout(timer) };
}

function synthProhibitedLibrary(def, rate, out) {
  const interval = Math.max(3, 14-(rate/60)*10);
  let timer;
  function page() {
    if (!isAudioEngineActive()) return;
    const buf = makeNoiseBuffer('white', 0.3);
    const s = audioCtx.createBufferSource(); s.buffer = buf;
    const hp = audioCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.08, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+0.2);
    s.connect(hp); hp.connect(g); g.connect(out); s.start(); s.stop(audioCtx.currentTime+0.25);
    timer = setTimeout(page, (interval+Math.random()*interval)*1000);
  }
  const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = 47;
  const og = audioCtx.createGain(); og.gain.value = 0.02;
  o.connect(og); og.connect(out); o.start(); page();
  return { osc: o, _stopFn: () => clearTimeout(timer) };
}

function synthSacredRuins(def, rate, out) {
  const interval = Math.max(5, 20-(rate/60)*14);
  let timer;
  function toll() {
    if (!isAudioEngineActive()) return;
    const f = 220*Math.pow(2,(Math.random()*3-1)/12);
    [1,2.3,3.7,5.1].forEach((mult, k) => {
      const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = f*mult;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.1/(k+1), audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+4+Math.random()*2);
      o.connect(g); g.connect(out); o.start(); o.stop(audioCtx.currentTime+6);
    });
    timer = setTimeout(toll, (interval+Math.random()*interval)*1000);
  }
  toll();
  return { _stopFn: () => clearTimeout(timer) };
}

function synthElectricLab(def, rate, out) {
  const buf = makeNoiseBuffer('white', 3); const src = loopNoise(buf);
  const hp = audioCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
  const g = audioCtx.createGain(); g.gain.value = 0.06;
  const arc = audioCtx.createOscillator(); arc.type = 'square'; arc.frequency.value = 60;
  const arcG = audioCtx.createGain(); arcG.gain.value = 0.04;
  const zap = audioCtx.createOscillator(); zap.type = 'sawtooth'; zap.frequency.value = 7+(rate/60)*5;
  const zapG = audioCtx.createGain(); zapG.gain.value = 0.4;
  zap.connect(zapG); zapG.connect(arcG.gain);
  src.connect(hp); hp.connect(g); g.connect(out);
  arc.connect(arcG); arcG.connect(out); arc.start(); zap.start();
  return { src, _stopFn: () => { try { arc.stop(); zap.stop(); } catch(e){} } };
}

function synthNightTrain(def, rate, out) {
  const bpm = 240+(rate/60)*120; const interval = 60/bpm;
  let tick=0, timer;
  function clack() {
    if (!isAudioEngineActive()) return;
    if (tick%4===0) {
      const o = audioCtx.createOscillator(); o.type = 'square'; o.frequency.value = 80;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.2, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+0.04);
      o.connect(g); g.connect(out); o.start(); o.stop(audioCtx.currentTime+0.06);
    }
    const buf2 = makeNoiseBuffer('white', 0.05);
    const s = audioCtx.createBufferSource(); s.buffer = buf2;
    const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 4;
    const g2 = audioCtx.createGain(); g2.gain.value = tick%2===0?0.1:0.06;
    s.connect(bp); bp.connect(g2); g2.connect(out); s.start(); s.stop(audioCtx.currentTime+0.06);
    tick++; timer = setTimeout(clack, interval*1000);
  }
  const wBuf = makeNoiseBuffer('brown', 4); const wSrc = loopNoise(wBuf);
  const hp = audioCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1000;
  const wg = audioCtx.createGain(); wg.gain.value = 0.08;
  wSrc.connect(hp); hp.connect(wg); wg.connect(out); clack();
  return { src: wSrc, _stopFn: () => clearTimeout(timer) };
}

// ═══ EXPERIMENTAL ═══

function synthFeedback(def, rate, out) {
  const freq = def.freq || 440;
  const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
  const g = audioCtx.createGain(); g.gain.value = 0.5;
  const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 30;
  const lfo = audioCtx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.04+(rate/60)*0.2;
  const lfoG = audioCtx.createGain(); lfoG.gain.value = freq*0.3;
  lfo.connect(lfoG); lfoG.connect(bp.frequency);
  o.connect(bp); bp.connect(g); g.connect(out); o.start(); lfo.start();
  return { osc: o, lfo, lfoG };
}

function synthGranularSilence(def, rate, out) {
  const buf = makeNoiseBuffer('white', 4); const src = loopNoise(buf);
  const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 60;
  const g = audioCtx.createGain(); g.gain.value = 0.015;
  const lfo = audioCtx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.03;
  const lfoG = audioCtx.createGain(); lfoG.gain.value = 0.012;
  lfo.connect(lfoG); lfoG.connect(g.gain);
  src.connect(lp); lp.connect(g); g.connect(out); lfo.start();
  return { src, _stopFn: () => { try { lfo.stop(); } catch(e){} } };
}

function synthSpectralInvert(def, rate, out) {
  const freqs = [3500,2800,2100,1400,700];
  const buf = makeNoiseBuffer('white', 3); const src = loopNoise(buf);
  const lfos = [];
  freqs.forEach((f, i) => {
    const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 6;
    const g = audioCtx.createGain(); g.gain.value = 0.03;
    const lfo = audioCtx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.1+i*0.07;
    const lfoG = audioCtx.createGain(); lfoG.gain.value = f*0.12;
    lfo.connect(lfoG); lfoG.connect(bp.frequency);
    src.connect(bp); bp.connect(g); g.connect(out); lfo.start();
    lfos.push(lfo);
  });
  return { src, _stopFn: () => lfos.forEach(lfo => { try { lfo.stop(); } catch(e){} }) };
}


// ─── v4.3 REALISTIC AUDIO ENGINE ─────────────────────────────────────────────
// These overrides replace the older toy-like procedural textures for the most
// exposed sound families. They remain 100% offline and copyright-safe, while
// allowing local recorded samples to take priority when provided by the user.

function shouldKeepScheduling() {
  return isAudioEngineActive() && (!previewCtx || previewCtx.state !== 'closed');
}

function rnd(min, max) { return min + Math.random() * (max - min); }

function setGainEnv(gainParam, peak, attack, decay, sustain = 0.001) {
  const t = audioCtx.currentTime;
  gainParam.cancelScheduledValues(t);
  gainParam.setValueAtTime(0.0001, t);
  gainParam.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t + Math.max(attack, 0.002));
  gainParam.exponentialRampToValueAtTime(Math.max(sustain, 0.0001), t + Math.max(attack + decay, 0.02));
}

function makeRealNoise(type = 'brown', sec = 4, channels = 2) {
  const len = Math.max(1, Math.floor(audioCtx.sampleRate * sec));
  const buf = audioCtx.createBuffer(channels, len, audioCtx.sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const data = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let brown = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      if (type === 'pink') {
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      } else if (type === 'brown') {
        brown = (brown + 0.02 * white) / 1.02;
        data[i] = brown * 5.5;
      } else {
        data[i] = white;
      }
    }
  }
  return buf;
}

function loopBuffer(buffer, rateValue = 1) {
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.playbackRate.value = rateValue;
  src.start();
  return src;
}

function makeFilter(type, freq, q = 1) {
  const f = audioCtx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function connectChain(first, ...nodes) {
  let current = first;
  for (const node of nodes) {
    if (!node) continue;
    current.connect(node);
    current = node;
  }
  return current;
}

function startOsc(freq, type = 'sine') {
  const osc = audioCtx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  osc.start();
  return osc;
}

function oneShotFilteredNoise({ type = 'white', dur = 0.18, filter = 'bandpass', freq = 800, q = 1, gain = 0.2, attack = 0.005, decay = 0.15, out }) {
  const src = audioCtx.createBufferSource();
  src.buffer = makeRealNoise(type, Math.max(dur + 0.05, 0.1), 1);
  const f = makeFilter(filter, freq, q);
  const g = audioCtx.createGain();
  setGainEnv(g.gain, gain, attack, decay);
  src.connect(f); f.connect(g); g.connect(out);
  src.start();
  src.stop(audioCtx.currentTime + dur + 0.06);
  return src;
}

function synthHybridAirBed(def, rate, out) {
  const blend = getHybridBlend();
  const src = loopBuffer(makeRealNoise('pink', 5, 2), rnd(0.92, 1.08));
  const hp = makeFilter('highpass', Math.max(25, def.hpFreq || 80), 0.55);
  const lp = makeFilter('lowpass', Math.min(16000, def.lpFreq || 9000), 0.6);
  const g = audioCtx.createGain();
  g.gain.value = 0.08 + blend * 0.16;
  const lfo = startOsc(rnd(0.025, 0.11));
  const lfoGain = audioCtx.createGain();
  lfoGain.gain.value = 0.045 + blend * 0.06;
  lfo.connect(lfoGain);
  lfoGain.connect(g.gain);
  connectChain(src, hp, lp, g, out);
  return { src, hp, lp, g, lfo, lfoGain, _hybridAir: true, _stopFn: () => { try { src.stop(); } catch(e){} try { lfo.stop(); } catch(e){} } };
}

function synthImportedSample(buffer, rate, out) {
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.loopStart = Math.min(0.02, Math.max(0, buffer.duration - 0.05));
  src.loopEnd = Math.max(src.loopStart + 0.05, buffer.duration - 0.02);
  src.playbackRate.value = Math.max(0.55, Math.min(1.45, 0.82 + (rate / 100) * 0.48));
  const fade = audioCtx.createGain();
  fade.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  fade.gain.exponentialRampToValueAtTime(1, audioCtx.currentTime + 0.35);
  const hp = makeFilter('highpass', 18, 0.7);
  const lp = makeFilter('lowpass', 18000, 0.7);
  const pan = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : null;
  if (pan) pan.pan.value = rnd(-0.08, 0.08);
  connectChain(src, fade, hp, lp, pan, out);
  src.start();
  return { src, fade, hp, lp, pan, _sample: true };
}

synthRain = function synthRainReal(def, rate, out) {
  const src = loopBuffer(makeRealNoise('pink', 6, 2), rnd(0.96, 1.04));
  const hp = makeFilter('highpass', def.hpFreq || 450, 0.7);
  const lp = makeFilter('lowpass', def.lpFreq || 11000, 0.7);
  const bedGain = audioCtx.createGain();
  bedGain.gain.value = 0.58;
  const lfo = startOsc(0.035 + (rate / 100) * 0.09);
  const lfoGain = audioCtx.createGain();
  lfoGain.gain.value = 0.08;
  lfo.connect(lfoGain); lfoGain.connect(bedGain.gain);
  connectChain(src, hp, lp, bedGain, out);

  const timers = [];
  function scheduleDropStream(multiplier, baseFreq, gain) {
    const tick = () => {
      if (!shouldKeepScheduling()) return;
      const density = 900 - rate * 6;
      oneShotFilteredNoise({ type:'white', dur:rnd(0.025, 0.09), filter:'bandpass', freq:rnd(baseFreq * 0.7, baseFreq * 1.5), q:rnd(4, 12), gain:rnd(gain * 0.4, gain), attack:0.002, decay:rnd(0.03, 0.11), out });
      timers.push(setTimeout(tick, Math.max(38, rnd(density * 0.18, density) / multiplier)));
    };
    timers.push(setTimeout(tick, rnd(40, 240)));
  }
  scheduleDropStream(1.7, 1800, 0.10);
  scheduleDropStream(0.75, 520, 0.16);
  return { src, hp, lp, bedGain, lfo, lfoGain, _stopFn: () => { timers.forEach(clearTimeout); try { src.stop(); lfo.stop(); } catch(e){} } };
}

synthWind = function synthWindReal(def, rate, out) {
  const nodes = [];
  const base = def.freq || 420;
  const master = audioCtx.createGain();
  master.gain.value = 0.82;
  master.connect(out);
  [0.45, 1.0, 2.3].forEach((mul, i) => {
    const src = loopBuffer(makeRealNoise(i === 0 ? 'brown' : 'pink', 7, 2), rnd(0.88, 1.08));
    const bp = makeFilter('bandpass', base * mul, i === 1 ? 0.45 : 0.8);
    const g = audioCtx.createGain();
    g.gain.value = i === 0 ? 0.45 : i === 1 ? 0.55 : 0.18;
    const lfo = startOsc(0.025 + i * 0.017 + (rate / 100) * 0.08);
    const lfoG = audioCtx.createGain();
    lfoG.gain.value = base * mul * (0.28 + i * 0.1);
    lfo.connect(lfoG); lfoG.connect(bp.frequency);
    connectChain(src, bp, g, master);
    nodes.push(src, bp, g, lfo, lfoG);
  });
  return { nodes, master, _stopFn: () => nodes.forEach(n => { try { n.stop && n.stop(); n.disconnect && n.disconnect(); } catch(e){} }) };
}

synthFire = function synthFireReal(def, rate, out) {
  const bed = loopBuffer(makeRealNoise('brown', 5, 2), rnd(0.95, 1.05));
  const lp = makeFilter('lowpass', def.small ? 420 : 760, 0.4);
  const g = audioCtx.createGain();
  g.gain.value = def.small ? 0.28 : 0.46;
  connectChain(bed, lp, g, out);
  const timers = [];
  function crackle() {
    if (!shouldKeepScheduling()) return;
    const hot = Math.random() > 0.55;
    oneShotFilteredNoise({ type:'white', dur:rnd(0.018, hot ? 0.065 : 0.12), filter:'bandpass', freq:rnd(hot ? 2200 : 350, hot ? 7200 : 1400), q:rnd(3, 14), gain:rnd(0.04, hot ? 0.22 : 0.10), attack:0.001, decay:rnd(0.025, 0.12), out });
    timers.push(setTimeout(crackle, rnd(50, Math.max(90, 520 - rate * 3.8))));
  }
  timers.push(setTimeout(crackle, rnd(40, 180)));
  return { src: bed, lp, g, _stopFn: () => { timers.forEach(clearTimeout); try { bed.stop(); } catch(e){} } };
}

synthWaves = function synthWavesReal(def, rate, out) {
  const surf = loopBuffer(makeRealNoise('pink', 8, 2), rnd(0.92, 1.03));
  const body = loopBuffer(makeRealNoise('brown', 8, 2), rnd(0.88, 0.98));
  const surfBp = makeFilter('bandpass', 1100, 0.55);
  const bodyLp = makeFilter('lowpass', 320, 0.6);
  const surfGain = audioCtx.createGain(); surfGain.gain.value = 0.28;
  const bodyGain = audioCtx.createGain(); bodyGain.gain.value = 0.62;
  const swell = startOsc(0.055 + (rate / 100) * 0.08);
  const swellGain = audioCtx.createGain(); swellGain.gain.value = 0.28;
  swell.connect(swellGain); swellGain.connect(bodyGain.gain); swellGain.connect(surfGain.gain);
  connectChain(surf, surfBp, surfGain, out);
  connectChain(body, bodyLp, bodyGain, out);
  return { surf, body, surfBp, bodyLp, surfGain, bodyGain, swell, swellGain, _stopFn: () => { try { surf.stop(); body.stop(); swell.stop(); } catch(e){} } };
}

synthThunder = function synthThunderReal(def, rate, out) {
  const timers = [];
  function boom() {
    if (!shouldKeepScheduling()) return;
    const t = audioCtx.currentTime;
    const osc = startOsc(rnd(32, 58), 'sine');
    osc.frequency.exponentialRampToValueAtTime(rnd(18, 30), t + rnd(1.2, 2.7));
    const og = audioCtx.createGain();
    og.gain.setValueAtTime(0.001, t);
    og.gain.exponentialRampToValueAtTime(rnd(0.35, 0.75), t + 0.04);
    og.gain.exponentialRampToValueAtTime(0.001, t + rnd(1.8, 3.6));
    osc.connect(og); og.connect(out);
    osc.stop(t + 4);
    oneShotFilteredNoise({ type:'brown', dur:rnd(2.2, 4.5), filter:'lowpass', freq:rnd(80, 180), q:0.7, gain:rnd(0.45, 0.95), attack:0.025, decay:rnd(2.2, 4.2), out });
    if (Math.random() > 0.45) oneShotFilteredNoise({ type:'white', dur:0.12, filter:'highpass', freq:rnd(1300, 3200), q:0.7, gain:0.16, attack:0.001, decay:0.08, out });
    timers.push(setTimeout(boom, rnd(Math.max(3500, 18000 - rate * 120), Math.max(7000, 32000 - rate * 130))));
  }
  timers.push(setTimeout(boom, rnd(500, 2600)));
  return { _stopFn: () => timers.forEach(clearTimeout) };
}

synthDrip = function synthDripReal(def, rate, out) {
  const timers = [];
  function drip() {
    if (!shouldKeepScheduling()) return;
    const t = audioCtx.currentTime;
    const f = rnd(420, 1150);
    const o = startOsc(f, 'sine');
    o.frequency.exponentialRampToValueAtTime(f * rnd(0.35, 0.62), t + rnd(0.10, 0.28));
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(rnd(0.11, 0.28), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.001, t + rnd(0.18, 0.48));
    const bp = makeFilter('bandpass', f, rnd(4, 10));
    o.connect(bp); bp.connect(g); g.connect(out);
    o.stop(t + 0.55);
    if (Math.random() > 0.5) oneShotFilteredNoise({ type:'white', dur:0.04, filter:'bandpass', freq:f * 1.8, q:8, gain:0.035, attack:0.001, decay:0.05, out });
    const interval = Math.max(240, 4200 - rate * 34);
    timers.push(setTimeout(drip, rnd(interval * 0.45, interval * 1.6)));
  }
  timers.push(setTimeout(drip, rnd(120, 900)));
  return { _stopFn: () => timers.forEach(clearTimeout) };
}

synthSteps = function synthStepsReal(def, rate, out) {
  const timers = [];
  let side = -1;
  function step() {
    if (!shouldKeepScheduling()) return;
    side *= -1;
    const pan = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : null;
    if (pan) { pan.pan.value = side * rnd(0.06, 0.22); pan.connect(out); }
    const target = pan || out;
    oneShotFilteredNoise({ type:'brown', dur:rnd(0.10, 0.22), filter:'lowpass', freq:rnd(170, 520), q:0.8, gain:rnd(0.18, 0.40), attack:0.004, decay:rnd(0.10, 0.22), out: target });
    if (Math.random() > 0.65) oneShotFilteredNoise({ type:'white', dur:0.045, filter:'bandpass', freq:rnd(700, 1800), q:5, gain:0.035, attack:0.001, decay:0.04, out: target });
    const pace = Math.max(260, 1400 - rate * 9.5);
    timers.push(setTimeout(step, rnd(pace * 0.82, pace * 1.18)));
  }
  timers.push(setTimeout(step, rnd(80, 360)));
  return { _stopFn: () => timers.forEach(clearTimeout) };
}

synthCreak = function synthCreakReal(def, rate, out) {
  const timers = [];
  function creak() {
    if (!shouldKeepScheduling()) return;
    const dur = rnd(0.35, 1.25);
    const src = audioCtx.createBufferSource();
    src.buffer = makeRealNoise('brown', dur + 0.1, 1);
    const bp = makeFilter('bandpass', rnd(120, 420), rnd(6, 18));
    bp.frequency.exponentialRampToValueAtTime(rnd(90, 260), audioCtx.currentTime + dur);
    const g = audioCtx.createGain();
    setGainEnv(g.gain, rnd(0.09, 0.26), rnd(0.025, 0.12), dur, 0.001);
    src.connect(bp); bp.connect(g); g.connect(out);
    src.start(); src.stop(audioCtx.currentTime + dur + 0.12);
    const interval = Math.max(800, 7600 - rate * 55);
    timers.push(setTimeout(creak, rnd(interval * 0.55, interval * 1.7)));
  }
  timers.push(setTimeout(creak, rnd(300, 1600)));
  return { _stopFn: () => timers.forEach(clearTimeout) };
}

synthHeartbeat = function synthHeartbeatReal(def, rate, out) {
  const timers = [];
  const bpm = 42 + (rate / 100) * 86;
  const interval = 60000 / bpm;
  function thump(offset, freq, gain, decay) {
    setTimeout(() => {
      if (!shouldKeepScheduling()) return;
      const t = audioCtx.currentTime;
      const o = startOsc(freq, 'sine');
      o.frequency.exponentialRampToValueAtTime(freq * 0.55, t + decay);
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, t + decay);
      o.connect(g); g.connect(out); o.stop(t + decay + 0.05);
    }, offset);
  }
  function beat() {
    if (!shouldKeepScheduling()) return;
    thump(0, rnd(46, 64), rnd(0.22, 0.42), rnd(0.16, 0.26));
    thump(rnd(95, 145), rnd(58, 82), rnd(0.12, 0.27), rnd(0.12, 0.20));
    timers.push(setTimeout(beat, rnd(interval * 0.88, interval * 1.12)));
  }
  timers.push(setTimeout(beat, 40));
  return { _stopFn: () => timers.forEach(clearTimeout) };
}

synthCrowd = function synthCrowdReal(def, rate, out) {
  const bed = loopBuffer(makeRealNoise('pink', 6, 2), 1);
  const bp = makeFilter('bandpass', 720, 0.55);
  const g = audioCtx.createGain(); g.gain.value = 0.22;
  connectChain(bed, bp, g, out);
  const oscs = [];
  for (let i = 0; i < 12; i++) {
    const o = startOsc(rnd(90, 260), i % 3 ? 'sine' : 'triangle');
    const v = audioCtx.createGain(); v.gain.value = rnd(0.006, 0.018);
    const lfo = startOsc(rnd(0.12, 1.4));
    const lfoG = audioCtx.createGain(); lfoG.gain.value = rnd(12, 55);
    lfo.connect(lfoG); lfoG.connect(o.frequency);
    o.connect(v); v.connect(out);
    oscs.push({ o, lfo });
  }
  return { src: bed, bp, g, oscs, _stopFn: () => { try { bed.stop(); } catch(e){} oscs.forEach(({o,lfo}) => { try { o.stop(); lfo.stop(); } catch(e){} }); } };
}

synthBirds = function synthBirdsReal(def, rate, out) {
  const timers = [];
  function chirp() {
    if (!shouldKeepScheduling()) return;
    const t = audioCtx.currentTime;
    const f = rnd(900, 3800);
    const o = startOsc(f, Math.random() > 0.7 ? 'triangle' : 'sine');
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * rnd(1.08, 1.9), t + rnd(0.035, 0.13));
    o.frequency.exponentialRampToValueAtTime(f * rnd(0.75, 1.05), t + rnd(0.16, 0.33));
    const g = audioCtx.createGain();
    setGainEnv(g.gain, rnd(0.035, 0.12), 0.006, rnd(0.12, 0.32), 0.001);
    const hp = makeFilter('highpass', 650, 0.7);
    o.connect(hp); hp.connect(g); g.connect(out); o.stop(t + 0.42);
    const interval = Math.max(240, 3300 - rate * 26);
    timers.push(setTimeout(chirp, rnd(interval * 0.35, interval * 1.4)));
  }
  timers.push(setTimeout(chirp, rnd(60, 700)));
  return { _stopFn: () => timers.forEach(clearTimeout) };
}

synthCricket = function synthCricketReal(def, rate, out) {
  const timers = [];
  function burst() {
    if (!shouldKeepScheduling()) return;
    const repeats = Math.floor(rnd(3, 8));
    for (let i = 0; i < repeats; i++) {
      setTimeout(() => {
        if (!shouldKeepScheduling()) return;
        const o = startOsc((def.freq || 4200) * rnd(0.94, 1.08), 'square');
        const bp = makeFilter('bandpass', def.freq || 4200, 18);
        const g = audioCtx.createGain();
        setGainEnv(g.gain, rnd(0.025, 0.075), 0.002, 0.045, 0.001);
        o.connect(bp); bp.connect(g); g.connect(out); o.stop(audioCtx.currentTime + 0.07);
      }, i * rnd(55, 95));
    }
    const interval = Math.max(260, 2200 - rate * 16);
    timers.push(setTimeout(burst, rnd(interval * 0.7, interval * 1.5)));
  }
  timers.push(setTimeout(burst, rnd(100, 900)));
  return { _stopFn: () => timers.forEach(clearTimeout) };
}

function normalizeSampleFileId(filename) {
  const base = filename.replace(/\.[^.]+$/, '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (SOUND_DEFS[base]) return base;
  const found = Object.keys(SOUND_DEFS).find(id => base === id || base.includes(id));
  return found || '';
}

async function importSamplePack(event) {
  const input = event && event.target;
  const files = Array.from(input?.files || []).filter(file => file.type.startsWith('audio/') || /\.(wav|mp3|m4a|ogg|flac|aac|webm)$/i.test(file.name));
  if (!files.length) { showToast('No se han seleccionado archivos de audio'); return; }
  if (!ensureAudio()) return;
  if (audioCtx.state === 'suspended' && audioCtx.resume) {
    try { await audioCtx.resume(); } catch(e) {}
  }
  let loaded = 0;
  const unmatched = [];
  for (const file of files) {
    const id = normalizeSampleFileId(file.name);
    if (!id) { unmatched.push(file.name); continue; }
    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      sampleOverrides.set(id, audioBuffer);
      sampleFileNames.set(id, file.name);
      loaded++;
      if (audioNodes[id]) {
        stopLayerAudio(id);
        startLayerAudio(id);
      }
    } catch (err) {
      unmatched.push(file.name);
    }
  }
  renderSampleBankStatus();
  if (input) input.value = '';
  if (loaded) showToast(`${loaded} sample${loaded === 1 ? '' : 's'} real${loaded === 1 ? '' : 'es'} cargado${loaded === 1 ? '' : 's'}` + (unmatched.length ? `. ${unmatched.length} no coincidieron con ningún ID.` : ''));
  else showToast('No se pudo cargar ningún sample. Nombra los archivos como el ID del sonido, por ejemplo lluvia-pesada.wav');
}

function clearSamplePack() {
  sampleOverrides.clear();
  sampleFileNames.clear();
  renderSampleBankStatus();
  Object.keys(audioNodes).forEach(id => { stopLayerAudio(id); startLayerAudio(id); });
  showToast('Samples reales eliminados. Vuelve el motor procedural.');
}

function renderSampleBankStatus() {
  const count = sampleOverrides.size;
  const label = count ? `${count} sample${count === 1 ? '' : 's'} real${count === 1 ? '' : 'es'} activo${count === 1 ? '' : 's'}` : 'Sin samples reales cargados';
  ['sample-bank-status', 'sample-bank-status-m'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = label;
  });
}


function stopNodes(nodes) {
  if (!nodes) return;
  if (nodes._stopFn) nodes._stopFn();
  if (nodes.src) { try { nodes.src.stop(); } catch(e){} }
  if (nodes.osc) { try { nodes.osc.stop(); } catch(e){} }
  if (nodes.lfo) { try { nodes.lfo.stop(); } catch(e){} }
  if (nodes.lfo2) { try { nodes.lfo2.stop(); } catch(e){} }
  if (nodes.oscs) nodes.oscs.forEach(({o, lfo}) => { try { o.stop(); lfo && lfo.stop(); } catch(e){} });
  if (nodes.oscList) nodes.oscList.forEach(({o, lfo}) => { try { o.stop(); lfo && lfo.stop(); } catch(e){} });
  // Disconnect all mixGain intermediaries and v4.6 layer polish nodes
  const mixKeys = Object.keys(nodes).filter(k => k.startsWith('mixGain'));
  mixKeys.forEach(k => { try { nodes[k].disconnect(); } catch(e){} });
  ['layerIn','layerHp','layerLp','layerLowShelf','layerHighShelf','layerPan'].forEach(k => {
    if (nodes[k]) { try { nodes[k].disconnect(); } catch(e){} }
  });
  if (nodes.out) { try { nodes.out.disconnect(); } catch(e){} }
}

// ─── DATA ──────────────────────────────────────────────────────────────────

const SOUND_DEFS = {
  // RAIN & WATER
  'lluvia-pesada':      { synth:'noise-rain', hpFreq:400, lpFreq:9000 },
  'lluvia-fina':        { synth:'noise-rain', hpFreq:900, lpFreq:16000 },
  'tormenta-electrica': { synth:'noise-rain', hpFreq:200, lpFreq:9000 },
  'gotas-cristal':      { synth:'water-drip', freq:700 },
  'arroyo':             { synth:'noise-rain', hpFreq:600, lpFreq:12000 },
  'rio':                { synth:'noise-rain', hpFreq:200, lpFreq:8000 },
  'cascada':            { synth:'noise-rain', hpFreq:300, lpFreq:10000 },
  'olas-orilla':        { synth:'waves' },
  'lluvia-tejado':      { synth:'noise-rain', hpFreq:250, lpFreq:7000 },
  'charco-pasos':       { synth:'steps' },
  // WIND
  'viento-fuerte':      { synth:'noise-wind', freq:350 },
  'brisa-suave':        { synth:'noise-wind', freq:600 },
  'viento-chimenea':    { synth:'noise-wind', freq:200 },
  'hojas-viento':       { synth:'noise-wind', freq:900 },
  'silbido-grietas':    { synth:'noise-wind', freq:1200 },
  'eco-cueva':          { synth:'noise-wind', freq:120 },
  // FIRE
  'chimenea':           { synth:'fire' },
  'vela':               { synth:'fire' },
  'hoguera':            { synth:'fire' },
  'brasas':             { synth:'fire' },
  'incendio-lejano':    { synth:'noise-rumble', freq:150 },
  // NATURE
  'pajaros-amanecer':   { synth:'birds' },
  'grillos-nocturnos':  { synth:'cricket', freq:4200 },
  'buho-lejano':        { synth:'birds' },
  'ranas':              { synth:'cricket', freq:800 },
  'ramas-crujido':      { synth:'creak' },
  'hojas-pisadas':      { synth:'steps' },
  'insectos-dia':       { synth:'cricket', freq:6000 },
  'viento-arboles':     { synth:'noise-wind', freq:500 },
  // INTERIOR
  'reloj-pared':        { synth:'ticking' },
  'paginas':            { synth:'creak' },
  'pasos-madera':       { synth:'steps' },
  'pasos-piedra':       { synth:'steps' },
  'puerta-crujido':     { synth:'creak' },
  'escaleras-lejanas':  { synth:'steps' },
  'radiador':           { synth:'ticking' },
  'pluma-papel':        { synth:'creak' },
  'maquina-escribir':   { synth:'ticking' },
  'zumbido-electrico':  { synth:'noise-low', freq:60 },
  // URBAN
  'trafico-lejano':     { synth:'crowd' },
  'murmullo-gente':     { synth:'crowd' },
  'cafe-bullicioso':    { synth:'crowd' },
  'metro-subterraneo':  { synth:'noise-rumble' },
  'sirena-distante':    { synth:'drone', freqs:[440, 466] },
  'campanada-iglesia':  { synth:'chime', freqs:[220, 293, 349, 440] },
  'mercado-exterior':   { synth:'crowd' },
  'taberna-medieval':   { synth:'crowd' },
  'plaza-atardecer':    { synth:'crowd' },
  // MUSIC
  'violin-lejano':      { synth:'drone', freqs:[196, 293, 392] },
  'organo-iglesia':     { synth:'pad', freqs:[65, 87, 131, 174] },
  'acordeon-distante':  { synth:'drone', freqs:[233, 311, 466] },
  'drone-tension':      { synth:'drone', freqs:[55.0, 77.78, 110.0] }, // A1 + Eb2 + A2 — tritono (diabolus in musica)
  'drones-misterio':    { synth:'drone', freqs:[50, 75, 112] },
  'coros-lejanos':      { synth:'pad', freqs:[220, 277, 330, 415] },
  'campanas-viento':    { synth:'chime', freqs:[880, 1100, 1320, 1760] },
  'tambor-tribal':      { synth:'steps' },
  // UNDERGROUND
  'goteo-caverna':      { synth:'water-drip' },
  'eco-profundo':       { synth:'noise-wind', freq:80 },
  'crujido-madera':     { synth:'creak' },
  'pasos-barro':        { synth:'steps' },
  'respiracion':        { synth:'noise-wind', freq:300 },
  'metal-arrastre':     { synth:'creak' },
  'silencio-pesado':    { synth:'noise-low', freq:40 },
  'voz-ininteligible':  { synth:'drone', freqs:[180, 220, 270] },
  // SPACE
  'zumbido-cosmico':    { synth:'drone', freqs:[40, 60, 90] },
  'frecuencias-bajas':  { synth:'noise-low', freq:30 },
  'viento-sintetico':   { synth:'noise-wind', freq:150 },
  'pulso-cardiaco':     { synth:'heartbeat' },
  'eco-vacio':          { synth:'noise-wind', freq:100 },
  'cristales-tintinean':{ synth:'chime', freqs:[1200, 1800, 2400, 3200] },
  // SEA
  'mar-abierto':        { synth:'waves' },
  'madera-barco':       { synth:'creak' },
  'velas-viento':       { synth:'noise-wind', freq:400 },
  'gaviotas':           { synth:'birds' },
  'cuadernas-crujido':  { synth:'creak' },
  'mar-tempestad':      { synth:'waves' },
  // CINE DE TERROR
  'pulso-carpenter':    { synth:'arpeggio', notes:[55, 55, 65.4, 55, 73.4, 55], wave:'sawtooth', cutoff:1200, reso:7 },
  'arpegio-sintetico':  { synth:'arpeggio', notes:[110, 130.8, 164.8, 130.8], wave:'square', cutoff:1800, reso:5 },
  'bajo-pulsante':      { synth:'pulse-bass', note:41.2 },
  'pad-tension':        { synth:'dissonant-pad', base:98, ratios:[1, 1.06, 1.41] },
  'pad-creciente':      { synth:'dissonant-pad', base:73.4, ratios:[1, 1.12, 1.5, 2.06] },
  'caja-musica':        { synth:'music-box', scale:[1047, 1175, 1319, 1397, 1568] },
  'caja-musica-rota':   { synth:'music-box', scale:[1047, 1109, 1245, 1397, 1480] },
  'clavecin-espectral': { synth:'harpsichord', scale:[220, 262, 311, 349, 415] },
  'clavecin-goblin':    { synth:'harpsichord', scale:[185.0, 220.0, 261.63, 311.13, 369.99] }, // F#3 A3 C4 D#4 F#4 — F# disminuido + tritono
  'stinger-cuerdas':    { synth:'stinger' },
  'coro-susurros':      { synth:'whisper-choir' },
  'drone-suspiria':     { synth:'dissonant-pad', base:55, ratios:[1, 1.07, 1.5, 1.89] },
  // TENSIÓN & SUSPENSE
  'glissando-ascendente':{ synth:'risset', dir:1 },
  'glissando-descendente':{ synth:'risset', dir:-1 },
  'cuerdas-tremolo':    { synth:'tremolo-strings', base:233, ratios:[1, 1.19, 1.5] },
  'zumbido-agudo':      { synth:'high-tension', freq:5200 },
  'bordon-creciente':   { synth:'swell', freqs:[41, 55, 62] },
  'metales-disonantes': { synth:'brass-cluster', base:110 },
  'tension-cuerdas':    { synth:'tremolo-strings', base:165, ratios:[1, 1.26, 1.68] },
  // PERCUSIÓN & GOLPES
  'braam-trailer':      { synth:'braam' },
  'tambor-profundo':    { synth:'boom' },
  'redoble-creciente':  { synth:'roll' },
  'corazon-acelerado':  { synth:'racing-heart' },
  // ORGÁNICO PERTURBADOR
  'respiracion-jadeo':  { synth:'breathing' },
  'aranazos':           { synth:'scratch' },
  'zumbido-moscas':     { synth:'flies' },
  'risa-infantil':      { synth:'child-laugh' },
  'crujido-huesos':     { synth:'bone-crack' },
  // INSTRUMENTOS EMBRUJADOS
  'piano-preparado':    { synth:'prepared-piano', scale:[110, 146.8, 164.8, 220, 246.9] },
  'theremin-fantasmal': { synth:'theremin', freq:440 },
  'violin-chirriante':  { synth:'bowed-string', freq:294 },
  'cuerda-frotada':     { synth:'bowed-string', freq:147 },
  'campana-invertida':  { synth:'inverted-bell', freq:180 },
  // INDUSTRIAL SINIESTRO
  'maquinaria-oxidada': { synth:'machinery' },
  'cadena-arrastre':    { synth:'chain-drag' },
  'radio-interferencia':{ synth:'static' },
  'generador-fallando': { synth:'failing-gen' },
  'transmision-perdida':{ synth:'static' },
  // SYNTH DE GÉNERO
  'secuencia-synthwave':{ synth:'synthwave', seq:[55, 55, 65.4, 55, 73.4, 65.4, 55, 49] },
  'acorde-congelado':   { synth:'frozen-chord', base:98, intervals:[0, 3, 6, 10] },
  'barrido-filtro':     { synth:'filter-sweep' },
  'arpegio-panico':     { synth:'synthwave', seq:[110, 130.8, 164.8, 196, 164.8, 130.8] },
  // LOVECRAFT & MITOLOGÍA
  'llamada-cthulhu':    { synth:'cthulhu-call' },
  'coros-rlyeh':        { synth:'rlyeh-choir' },
  'latido-azathoth':    { synth:'azathoth-beat' },
  'senal-yuggoth':      { synth:'yuggoth-signal' },
  'susurro-nyarla':     { synth:'nyarlathotep' },
  'profundidades-innsmouth':{ synth:'innsmouth-deep' },
  'flautas-azathoth':   { synth:'azathoth-flutes' },
  'shoggoth-masa':      { synth:'shoggoth' },
  'zumbido-mi-go':      { synth:'mi-go' },
  'puertas-yog':        { synth:'yog-sothoth' },
  'abismo-dagon':       { synth:'dagon-depth' },
  'viento-hastur':      { synth:'hastur-wind' },
  'respiracion-dios':   { synth:'sleeping-god' },
  'eco-no-euclidiano':  { synth:'non-euclidean' },
  // FRECUENCIAS ESPECIALES
  'infrasound-19hz':    { synth:'infrasound-19' },
  'binaural-alpha':     { synth:'binaural', carrier:200, beat:10 },
  'binaural-theta':     { synth:'binaural', carrier:180, beat:6 },
  'binaural-delta':     { synth:'binaural', carrier:160, beat:2 },
  'shepard-desc':       { synth:'shepard', dir:-1 },
  'shepard-asc':        { synth:'shepard', dir:1 },
  'resonancia-schumann':{ synth:'schumann' },
  'escala-microtonal':  { synth:'microtonal', root:220 },
  'escala-tonos-enteros':{ synth:'whole-tone', root:110 },
  'frecuencia-111hz':   { synth:'111hz' },
  'formante-vacio':     { synth:'formant-void' },
  // PLACER & BIENESTAR
  'ronroneo-gato':      { synth:'purr' },
  'frecuencia-528hz':   { synth:'528hz' },
  'onda-alpha':         { synth:'alpha-wave' },
  'onda-theta':         { synth:'theta-wave' },
  'quinta-perfecta':    { synth:'perfect-fifth', root:110 },
  'serie-armonica':     { synth:'harmonic-series', root:55 },
  'cuenco-tibetano-396':{ synth:'tibetan-bowl', freq:396 },
  'cuenco-tibetano-528':{ synth:'tibetan-bowl', freq:528 },
  'tambor-chamanes':    { synth:'shaman-drum' },
  'nada-brahma-om':     { synth:'nada-brahma' },
  'canto-ballenas':     { synth:'whale-call' },
  'didgeridoo-drone':   { synth:'didgeridoo' },
  'acorde-resolucion':  { synth:'resolving-pad', root:220 },
  // SECTAS & OCULTISMO
  'canto-culto':        { synth:'cult-chant', base:110 },
  'tambores-ritual':    { synth:'ritual-drums' },
  'canto-gregoriano-oscuro':{ synth:'dark-gregory' },
  'glosolalia':         { synth:'glossolalia' },
  'om-corrompido':      { synth:'om-corrupted' },
  'misa-negra':         { synth:'black-mass' },
  'derviche-giro':      { synth:'dervish-spin' },
  // AMBIENTES OSCUROS
  'pantano-nocturno':   { synth:'swamp' },
  'circo-siniestro':    { synth:'circus-dark' },
  'submarino-abismo':   { synth:'submarine' },
  'biblioteca-prohibida':{ synth:'prohibited-lib' },
  'iglesia-profanada':  { synth:'sacred-ruins' },
  'laboratorio-doctor': { synth:'electric-lab' },
  'tren-nocturno':      { synth:'night-train' },
  // EXPERIMENTAL
  'retroalimentacion':  { synth:'feedback', freq:440 },
  'silencio-granular':  { synth:'granular-silence' },
  'espectro-invertido': { synth:'spectral-invert' },
};

const CATALOG = [
  { cat: 'Lluvia & agua', color: '#378ADD', sounds: [
    { id:'lluvia-pesada', name:'Lluvia pesada', tag:'clima' },
    { id:'lluvia-fina', name:'Lluvia fina', tag:'clima' },
    { id:'tormenta-electrica', name:'Tormenta eléctrica', tag:'clima' },
    { id:'gotas-cristal', name:'Gotas en cristal', tag:'detalle' },
    { id:'arroyo', name:'Arroyo entre piedras', tag:'naturaleza' },
    { id:'rio', name:'Río caudaloso', tag:'naturaleza' },
    { id:'cascada', name:'Cascada distante', tag:'naturaleza' },
    { id:'olas-orilla', name:'Olas en la orilla', tag:'naturaleza' },
    { id:'lluvia-tejado', name:'Lluvia en tejado', tag:'interior' },
    { id:'charco-pasos', name:'Pasos en charco', tag:'detalle' },
  ]},
  { cat: 'Viento & aire', color: '#B4B2A9', sounds: [
    { id:'viento-fuerte', name:'Viento fuerte', tag:'clima' },
    { id:'brisa-suave', name:'Brisa suave', tag:'clima' },
    { id:'viento-chimenea', name:'Viento en chimenea', tag:'interior' },
    { id:'hojas-viento', name:'Hojas en el viento', tag:'naturaleza' },
    { id:'silbido-grietas', name:'Silbido entre grietas', tag:'detalle' },
    { id:'eco-cueva', name:'Eco de caverna', tag:'subterráneo' },
  ]},
  { cat: 'Fuego & calor', color: '#D85A30', sounds: [
    { id:'chimenea', name:'Chimenea crepitando', tag:'interior' },
    { id:'vela', name:'Vela crepitando', tag:'detalle' },
    { id:'hoguera', name:'Hoguera al aire libre', tag:'exterior' },
    { id:'brasas', name:'Brasas moribundas', tag:'detalle' },
    { id:'incendio-lejano', name:'Incendio lejano', tag:'evento' },
  ]},
  { cat: 'Bosque & naturaleza', color: '#5a9e6f', sounds: [
    { id:'pajaros-amanecer', name:'Pájaros al amanecer', tag:'naturaleza' },
    { id:'grillos-nocturnos', name:'Grillos nocturnos', tag:'naturaleza' },
    { id:'buho-lejano', name:'Búho lejano', tag:'evento' },
    { id:'ranas', name:'Ranas y anfibios', tag:'naturaleza' },
    { id:'ramas-crujido', name:'Ramas al crujir', tag:'detalle' },
    { id:'hojas-pisadas', name:'Hojas bajo los pies', tag:'detalle' },
    { id:'insectos-dia', name:'Insectos de día', tag:'naturaleza' },
    { id:'viento-arboles', name:'Viento entre árboles', tag:'naturaleza' },
  ]},
  { cat: 'Interior & doméstico', color: '#c8a96e', sounds: [
    { id:'reloj-pared', name:'Reloj de pared', tag:'interior' },
    { id:'paginas', name:'Páginas pasándose', tag:'detalle' },
    { id:'pasos-madera', name:'Pasos en madera', tag:'detalle' },
    { id:'pasos-piedra', name:'Pasos en piedra', tag:'detalle' },
    { id:'puerta-crujido', name:'Puerta al crujir', tag:'evento' },
    { id:'escaleras-lejanas', name:'Escaleras lejanas', tag:'detalle' },
    { id:'radiador', name:'Radiador metálico', tag:'interior' },
    { id:'pluma-papel', name:'Pluma sobre papel', tag:'detalle' },
    { id:'maquina-escribir', name:'Máquina de escribir', tag:'detalle' },
    { id:'zumbido-electrico', name:'Zumbido eléctrico', tag:'interior' },
  ]},
  { cat: 'Urbano & social', color: '#888780', sounds: [
    { id:'trafico-lejano', name:'Tráfico lejano', tag:'ciudad' },
    { id:'murmullo-gente', name:'Murmullo de gente', tag:'social' },
    { id:'cafe-bullicioso', name:'Café bullicioso', tag:'social' },
    { id:'metro-subterraneo', name:'Metro subterráneo', tag:'ciudad' },
    { id:'sirena-distante', name:'Sirena distante', tag:'evento' },
    { id:'campanada-iglesia', name:'Campanada de iglesia', tag:'evento' },
    { id:'mercado-exterior', name:'Mercado exterior', tag:'social' },
    { id:'taberna-medieval', name:'Taberna medieval', tag:'social' },
    { id:'plaza-atardecer', name:'Plaza al atardecer', tag:'ciudad' },
  ]},
  { cat: 'Música & atmósfera', color: '#7F77DD', sounds: [
    { id:'violin-lejano', name:'Violín lejano', tag:'música' },
    { id:'organo-iglesia', name:'Órgano de iglesia', tag:'música' },
    { id:'acordeon-distante', name:'Acordeón distante', tag:'música' },
    { id:'drone-tension', name:'Drone de tensión', tag:'atmósfera' },
    { id:'drones-misterio', name:'Drones de misterio', tag:'atmósfera' },
    { id:'coros-lejanos', name:'Coros lejanos', tag:'música' },
    { id:'campanas-viento', name:'Campanas de viento', tag:'detalle' },
    { id:'tambor-tribal', name:'Tambor tribal', tag:'música' },
  ]},
  { cat: 'Subterráneo & terror', color: '#791F1F', sounds: [
    { id:'goteo-caverna', name:'Goteo en caverna', tag:'subterráneo' },
    { id:'eco-profundo', name:'Eco profundo', tag:'subterráneo' },
    { id:'crujido-madera', name:'Crujido de madera', tag:'detalle' },
    { id:'pasos-barro', name:'Pasos en barro', tag:'detalle' },
    { id:'respiracion', name:'Respiración distante', tag:'terror' },
    { id:'metal-arrastre', name:'Metal arrastrándose', tag:'terror' },
    { id:'silencio-pesado', name:'Silencio pesado', tag:'atmósfera' },
    { id:'voz-ininteligible', name:'Voz ininteligible', tag:'terror' },
  ]},
  { cat: 'Espacial & onírico', color: '#534AB7', sounds: [
    { id:'zumbido-cosmico', name:'Zumbido cósmico', tag:'espacial' },
    { id:'frecuencias-bajas', name:'Frecuencias bajas', tag:'espacial' },
    { id:'viento-sintetico', name:'Viento sintético', tag:'onírico' },
    { id:'pulso-cardiaco', name:'Pulso cardíaco', tag:'cuerpo' },
    { id:'eco-vacio', name:'Eco en el vacío', tag:'espacial' },
    { id:'cristales-tintinean', name:'Cristales tintineando', tag:'onírico' },
  ]},
  { cat: 'Mar & barcos', color: '#185FA5', sounds: [
    { id:'mar-abierto', name:'Mar abierto', tag:'exterior' },
    { id:'madera-barco', name:'Madera de barco', tag:'detalle' },
    { id:'velas-viento', name:'Velas al viento', tag:'detalle' },
    { id:'gaviotas', name:'Gaviotas', tag:'naturaleza' },
    { id:'cuadernas-crujido', name:'Cuadernas crujiendo', tag:'detalle' },
    { id:'mar-tempestad', name:'Mar en tempestad', tag:'clima' },
  ]},
  { cat: 'Cine de terror', color: '#A32D2D', sounds: [
    { id:'pulso-carpenter', name:'Pulso de sintetizador', tag:'carpenter' },
    { id:'arpegio-sintetico', name:'Arpegio hipnótico', tag:'carpenter' },
    { id:'bajo-pulsante', name:'Bajo analógico grave', tag:'carpenter' },
    { id:'pad-tension', name:'Pad de tensión', tag:'atmósfera' },
    { id:'pad-creciente', name:'Tensión creciente', tag:'atmósfera' },
    { id:'caja-musica', name:'Caja de música', tag:'giallo' },
    { id:'caja-musica-rota', name:'Caja de música rota', tag:'giallo' },
    { id:'clavecin-espectral', name:'Clavecín espectral', tag:'goblin' },
    { id:'clavecin-goblin', name:'Clavecín disonante', tag:'goblin' },
    { id:'drone-suspiria', name:'Drone embrujado', tag:'goblin' },
    { id:'coro-susurros', name:'Coro de susurros', tag:'terror' },
    { id:'stinger-cuerdas', name:'Golpe de cuerdas', tag:'evento' },
  ]},
  { cat: 'Tensión & suspense', color: '#993C1D', sounds: [
    { id:'glissando-ascendente', name:'Glissando ascendente', tag:'ilusión' },
    { id:'glissando-descendente', name:'Glissando descendente', tag:'ilusión' },
    { id:'cuerdas-tremolo', name:'Cuerdas en trémolo', tag:'orquesta' },
    { id:'tension-cuerdas', name:'Tensión de cuerdas', tag:'orquesta' },
    { id:'zumbido-agudo', name:'Zumbido agudo', tag:'atmósfera' },
    { id:'bordon-creciente', name:'Bordón creciente', tag:'atmósfera' },
    { id:'metales-disonantes', name:'Metales disonantes', tag:'orquesta' },
  ]},
  { cat: 'Percusión & golpes', color: '#854F0B', sounds: [
    { id:'braam-trailer', name:'Braam de tráiler', tag:'impacto' },
    { id:'tambor-profundo', name:'Tambor profundo', tag:'ritmo' },
    { id:'redoble-creciente', name:'Redoble creciente', tag:'ritmo' },
    { id:'corazon-acelerado', name:'Corazón acelerado', tag:'cuerpo' },
  ]},
  { cat: 'Horror visceral', color: '#501313', sounds: [
    { id:'respiracion-jadeo', name:'Respiración jadeante', tag:'orgánico' },
    { id:'aranazos', name:'Arañazos', tag:'orgánico' },
    { id:'zumbido-moscas', name:'Zumbido de moscas', tag:'orgánico' },
    { id:'risa-infantil', name:'Risa infantil', tag:'terror' },
    { id:'crujido-huesos', name:'Crujido de huesos', tag:'orgánico' },
    { id:'piano-preparado', name:'Piano preparado', tag:'embrujado' },
    { id:'theremin-fantasmal', name:'Theremín fantasmal', tag:'embrujado' },
    { id:'violin-chirriante', name:'Violín chirriante', tag:'embrujado' },
    { id:'cuerda-frotada', name:'Cuerda frotada', tag:'embrujado' },
    { id:'campana-invertida', name:'Campana invertida', tag:'embrujado' },
  ]},
  { cat: 'Industrial siniestro', color: '#5F5E5A', sounds: [
    { id:'maquinaria-oxidada', name:'Maquinaria oxidada', tag:'mecánico' },
    { id:'cadena-arrastre', name:'Cadena arrastrándose', tag:'mecánico' },
    { id:'radio-interferencia', name:'Radio con interferencias', tag:'eléctrico' },
    { id:'generador-fallando', name:'Generador fallando', tag:'eléctrico' },
    { id:'transmision-perdida', name:'Transmisión perdida', tag:'eléctrico' },
  ]},
  { cat: 'Synth de género', color: '#534AB7', sounds: [
    { id:'secuencia-synthwave', name:'Secuencia synthwave', tag:'synth' },
    { id:'arpegio-panico', name:'Arpegio de pánico', tag:'synth' },
    { id:'acorde-congelado', name:'Acorde congelado', tag:'synth' },
    { id:'barrido-filtro', name:'Barrido de filtro', tag:'synth' },
  ]},
  { cat: 'Lovecraft & mitología', color: '#4a0f0f', sounds: [
    { id:'llamada-cthulhu', name:'Llamada de Cthulhu', tag:'entidad' },
    { id:'coros-rlyeh', name:'Coros de Rlyeh', tag:'entidad' },
    { id:'latido-azathoth', name:'Latido de Azathoth', tag:'caos' },
    { id:'senal-yuggoth', name:'Señal de Yuggoth', tag:'cósmico' },
    { id:'susurro-nyarla', name:'Susurro de Nyarlathotep', tag:'entidad' },
    { id:'profundidades-innsmouth', name:'Profundidades de Innsmouth', tag:'entidad' },
    { id:'flautas-azathoth', name:'Flautas de Azathoth', tag:'caos' },
    { id:'shoggoth-masa', name:'Shoggoth en movimiento', tag:'entidad' },
    { id:'zumbido-mi-go', name:'Zumbido de los Mi-Go', tag:'entidad' },
    { id:'puertas-yog', name:'Puertas de Yog-Sothoth', tag:'entidad' },
    { id:'abismo-dagon', name:'Abismo de Dagon', tag:'entidad' },
    { id:'viento-hastur', name:'Viento de Hastur', tag:'entidad' },
    { id:'respiracion-dios', name:'Respiración del dios durmiente', tag:'cósmico' },
    { id:'eco-no-euclidiano', name:'Eco no euclidiano', tag:'geometría' },
  ]},
  { cat: 'Frecuencias especiales', color: '#533AB7', sounds: [
    { id:'infrasound-19hz', name:'Infrasonido 19 Hz', tag:'psicoacústica' },
    { id:'binaural-alpha', name:'Binaural alpha (10 Hz)', tag:'binaural' },
    { id:'binaural-theta', name:'Binaural theta (6 Hz)', tag:'binaural' },
    { id:'binaural-delta', name:'Binaural delta (2 Hz)', tag:'binaural' },
    { id:'shepard-desc', name:'Shepard descendente', tag:'ilusión' },
    { id:'shepard-asc', name:'Shepard ascendente', tag:'ilusión' },
    { id:'resonancia-schumann', name:'Resonancia de Schumann', tag:'tierra' },
    { id:'escala-microtonal', name:'Escala microtonal árabe', tag:'microtonos' },
    { id:'escala-tonos-enteros', name:'Escala de tonos enteros', tag:'flotación' },
    { id:'frecuencia-111hz', name:'111 Hz megalítico', tag:'arqueoacústica' },
    { id:'formante-vacio', name:'Formante sin vocal', tag:'experimental' },
  ]},
  { cat: 'Placer & bienestar', color: '#3B6D11', sounds: [
    { id:'ronroneo-gato', name:'Ronroneo de gato', tag:'bienestar' },
    { id:'frecuencia-528hz', name:'528 Hz (frecuencia del amor)', tag:'solfeggio' },
    { id:'onda-alpha', name:'Onda alpha', tag:'binaural' },
    { id:'onda-theta', name:'Onda theta', tag:'binaural' },
    { id:'quinta-perfecta', name:'Quinta perfecta', tag:'armonía' },
    { id:'serie-armonica', name:'Serie armónica natural', tag:'física' },
    { id:'cuenco-tibetano-396', name:'Cuenco tibetano 396 Hz', tag:'cuenco' },
    { id:'cuenco-tibetano-528', name:'Cuenco tibetano 528 Hz', tag:'cuenco' },
    { id:'tambor-chamanes', name:'Tambor chamánico', tag:'theta' },
    { id:'nada-brahma-om', name:'Nada Brahma (136.1 Hz)', tag:'tierra' },
    { id:'canto-ballenas', name:'Canto de ballenas', tag:'naturaleza' },
    { id:'didgeridoo-drone', name:'Didgeridoo', tag:'ancestral' },
    { id:'acorde-resolucion', name:'Acorde de resolución', tag:'armonía' },
  ]},
  { cat: 'Sectas & ocultismo', color: '#712B13', sounds: [
    { id:'canto-culto', name:'Canto de culto', tag:'ritual' },
    { id:'tambores-ritual', name:'Tambores del ritual', tag:'ritual' },
    { id:'canto-gregoriano-oscuro', name:'Gregoriano oscuro', tag:'misa' },
    { id:'glosolalia', name:'Glosolalia', tag:'lenguas' },
    { id:'om-corrompido', name:'Om corrompido', tag:'ritual' },
    { id:'misa-negra', name:'Misa negra', tag:'misa' },
    { id:'derviche-giro', name:'Derviche en giro', tag:'éxtasis' },
  ]},
  { cat: 'Ambientes oscuros', color: '#085041', sounds: [
    { id:'pantano-nocturno', name:'Pantano nocturno', tag:'naturaleza' },
    { id:'circo-siniestro', name:'Circo siniestro', tag:'evento' },
    { id:'submarino-abismo', name:'Submarino en el abismo', tag:'mecánico' },
    { id:'biblioteca-prohibida', name:'Biblioteca prohibida', tag:'interior' },
    { id:'iglesia-profanada', name:'Iglesia profanada', tag:'sagrado' },
    { id:'laboratorio-doctor', name:'Laboratorio del doctor', tag:'mecánico' },
    { id:'tren-nocturno', name:'Tren nocturno', tag:'viaje' },
  ]},
  { cat: 'Síntesis experimental', color: '#2C2C2A', sounds: [
    { id:'retroalimentacion', name:'Retroalimentación', tag:'feedback' },
    { id:'silencio-granular', name:'Silencio granular', tag:'textura' },
    { id:'espectro-invertido', name:'Espectro invertido', tag:'voz' },
  ]},
];

const PRESETS = {
  'Tormenta':    { name:'Noche de tormenta',    ids:[{id:'lluvia-pesada',vol:72,rate:30},{id:'tormenta-electrica',vol:35,rate:6},{id:'gotas-cristal',vol:48,rate:40},{id:'viento-fuerte',vol:30,rate:25},{id:'chimenea',vol:55,rate:20}] },
  'Biblioteca':  { name:'Sala de lectura',       ids:[{id:'paginas',vol:30,rate:14},{id:'pasos-piedra',vol:18,rate:8},{id:'reloj-pared',vol:42,rate:60},{id:'lluvia-fina',vol:24,rate:35},{id:'silencio-pesado',vol:35,rate:0}] },
  'Taberna':     { name:'Posada oscura',          ids:[{id:'taberna-medieval',vol:62,rate:40},{id:'chimenea',vol:68,rate:25},{id:'lluvia-pesada',vol:28,rate:30},{id:'acordeon-distante',vol:22,rate:18},{id:'pasos-madera',vol:18,rate:12}] },
  'Bosque':      { name:'Bosque al amanecer',    ids:[{id:'pajaros-amanecer',vol:58,rate:20},{id:'hojas-viento',vol:48,rate:30},{id:'arroyo',vol:42,rate:50},{id:'grillos-nocturnos',vol:18,rate:40},{id:'hojas-pisadas',vol:14,rate:8}] },
  'Alta Mar':    { name:'Alta mar, noche cerrada',ids:[{id:'mar-abierto',vol:68,rate:20},{id:'madera-barco',vol:32,rate:14},{id:'velas-viento',vol:28,rate:25},{id:'viento-fuerte',vol:38,rate:30},{id:'cuadernas-crujido',vol:18,rate:10}] },
  'Cripta':      { name:'Cripta abandonada',      ids:[{id:'goteo-caverna',vol:42,rate:12},{id:'eco-profundo',vol:28,rate:5},{id:'silencio-pesado',vol:52,rate:0},{id:'metal-arrastre',vol:18,rate:4},{id:'respiracion',vol:14,rate:8}] },
  'Ciudad':      { name:'Ciudad bajo la lluvia',  ids:[{id:'trafico-lejano',vol:48,rate:40},{id:'lluvia-fina',vol:32,rate:30},{id:'sirena-distante',vol:14,rate:5},{id:'metro-subterraneo',vol:18,rate:8},{id:'campanada-iglesia',vol:9,rate:3}] },
  'Onírico':     { name:'Limbo etéreo',            ids:[{id:'zumbido-cosmico',vol:58,rate:10},{id:'drones-misterio',vol:48,rate:5},{id:'cristales-tintinean',vol:32,rate:14},{id:'coros-lejanos',vol:24,rate:8},{id:'eco-vacio',vol:38,rate:6}] },
  'Desierto':    { name:'Desierto, medianoche',   ids:[{id:'brisa-suave',vol:45,rate:20},{id:'grillos-nocturnos',vol:38,rate:45},{id:'silbido-grietas',vol:22,rate:15},{id:'hojas-viento',vol:15,rate:10}] },
  'Iglesia':     { name:'Iglesia en silencio',    ids:[{id:'organo-iglesia',vol:38,rate:5},{id:'eco-profundo',vol:45,rate:3},{id:'campanada-iglesia',vol:28,rate:4},{id:'pasos-piedra',vol:15,rate:8},{id:'silencio-pesado',vol:40,rate:0}] },
  'Barco Pirata':{ name:'Galeón en tempestad',    ids:[{id:'mar-tempestad',vol:72,rate:28},{id:'cuadernas-crujido',vol:48,rate:18},{id:'viento-fuerte',vol:55,rate:35},{id:'lluvia-pesada',vol:42,rate:32},{id:'tambor-tribal',vol:18,rate:25}] },
  'Calabozo':    { name:'Calabozo medieval',       ids:[{id:'goteo-caverna',vol:50,rate:10},{id:'metal-arrastre',vol:30,rate:6},{id:'crujido-madera',vol:22,rate:8},{id:'respiracion',vol:20,rate:12},{id:'pasos-piedra',vol:18,rate:5}] },
  'Slasher':     { name:'Acecho nocturno',          ids:[{id:'pulso-carpenter',vol:55,rate:30},{id:'bajo-pulsante',vol:48,rate:25},{id:'pad-tension',vol:35,rate:10},{id:'stinger-cuerdas',vol:40,rate:8},{id:'viento-fuerte',vol:22,rate:20}] },
  'Giallo':      { name:'Pesadilla en rojo',         ids:[{id:'caja-musica-rota',vol:52,rate:25},{id:'clavecin-goblin',vol:40,rate:35},{id:'coro-susurros',vol:30,rate:15},{id:'pad-creciente',vol:35,rate:8},{id:'silencio-pesado',vol:25,rate:0}] },
  'Suspiria':    { name:'Academia maldita',          ids:[{id:'drone-suspiria',vol:50,rate:8},{id:'coro-susurros',vol:42,rate:20},{id:'caja-musica',vol:35,rate:18},{id:'campanas-viento',vol:24,rate:12},{id:'respiracion',vol:18,rate:10}] },
  'Synth Noir':  { name:'Noche sintética',           ids:[{id:'arpegio-sintetico',vol:48,rate:40},{id:'bajo-pulsante',vol:45,rate:35},{id:'lluvia-fina',vol:32,rate:30},{id:'trafico-lejano',vol:25,rate:35},{id:'pad-tension',vol:28,rate:10}] },
  'Persecución':{ name:'Persecución a medianoche',  ids:[{id:'secuencia-synthwave',vol:50,rate:55},{id:'corazon-acelerado',vol:42,rate:50},{id:'glissando-ascendente',vol:30,rate:30},{id:'bajo-pulsante',vol:38,rate:45},{id:'zumbido-agudo',vol:18,rate:5}] },
  'Posesión':   { name:'Casa poseída',               ids:[{id:'respiracion-jadeo',vol:40,rate:25},{id:'risa-infantil',vol:28,rate:12},{id:'piano-preparado',vol:35,rate:15},{id:'aranazos',vol:25,rate:20},{id:'bordon-creciente',vol:38,rate:8}] },
  'Carnicería': { name:'Matadero abandonado',        ids:[{id:'maquinaria-oxidada',vol:45,rate:20},{id:'cadena-arrastre',vol:35,rate:15},{id:'crujido-huesos',vol:28,rate:10},{id:'zumbido-moscas',vol:30,rate:25},{id:'goteo-caverna',vol:22,rate:14}] },
  'Apertura':   { name:'Tráiler de apertura',        ids:[{id:'braam-trailer',vol:55,rate:15},{id:'tambor-profundo',vol:42,rate:30},{id:'metales-disonantes',vol:35,rate:10},{id:'redoble-creciente',vol:30,rate:40},{id:'bordon-creciente',vol:32,rate:6}] },
  'Asilo':      { name:'Asilo en ruinas',            ids:[{id:'radio-interferencia',vol:35,rate:30},{id:'generador-fallando',vol:30,rate:15},{id:'theremin-fantasmal',vol:28,rate:10},{id:'campana-invertida',vol:25,rate:8},{id:'respiracion-jadeo',vol:20,rate:18}] },
  'R\'lyeh':    { name:'R\'lyeh despierta',           ids:[{id:'llamada-cthulhu',vol:55,rate:20},{id:'coros-rlyeh',vol:48,rate:12},{id:'respiracion-dios',vol:42,rate:5},{id:'eco-no-euclidiano',vol:35,rate:18},{id:'profundidades-innsmouth',vol:30,rate:15}] },
  'Culto':      { name:'El culto en el bosque',       ids:[{id:'tambores-ritual',vol:58,rate:45},{id:'canto-culto',vol:48,rate:30},{id:'hoguera',vol:40,rate:22},{id:'glosolalia',vol:32,rate:25},{id:'viento-arboles',vol:25,rate:20}] },
  'Innsmouth':  { name:'Innsmouth de noche',          ids:[{id:'profundidades-innsmouth',vol:60,rate:20},{id:'olas-orilla',vol:45,rate:30},{id:'viento-hastur',vol:35,rate:15},{id:'susurro-nyarla',vol:28,rate:10},{id:'goteo-caverna',vol:20,rate:12}] },
  'Azathoth':   { name:'Las flautas de Azathoth',     ids:[{id:'flautas-azathoth',vol:55,rate:40},{id:'latido-azathoth',vol:50,rate:35},{id:'coros-rlyeh',vol:38,rate:15},{id:'zumbido-cosmico',vol:32,rate:8},{id:'eco-no-euclidiano',vol:28,rate:20}] },
  'Meditacion': { name:'Meditación profunda',         ids:[{id:'cuenco-tibetano-396',vol:55,rate:18},{id:'onda-theta',vol:45,rate:10},{id:'nada-brahma-om',vol:40,rate:5},{id:'tambor-chamanes',vol:35,rate:30},{id:'canto-ballenas',vol:28,rate:12}] },
  'Bienestar':  { name:'Calma absoluta',              ids:[{id:'ronroneo-gato',vol:50,rate:15},{id:'onda-alpha',vol:45,rate:10},{id:'quinta-perfecta',vol:40,rate:8},{id:'acorde-resolucion',vol:35,rate:5},{id:'arroyo',vol:30,rate:40}] },
  'Nyarla':     { name:'El Mensajero se acerca',      ids:[{id:'susurro-nyarla',vol:52,rate:15},{id:'senal-yuggoth',vol:40,rate:20},{id:'shepard-desc',vol:38,rate:18},{id:'infrasound-19hz',vol:32,rate:8},{id:'formante-vacio',vol:28,rate:12}] },
  'MisaNegra':  { name:'Ritual de medianoche',        ids:[{id:'misa-negra',vol:55,rate:8},{id:'tambores-ritual',vol:48,rate:40},{id:'om-corrompido',vol:40,rate:10},{id:'canto-gregoriano-oscuro',vol:35,rate:15},{id:'glosolalia',vol:28,rate:20}] },
  'CircoInf':   { name:'Circo infernal',              ids:[{id:'circo-siniestro',vol:55,rate:30},{id:'risa-infantil',vol:35,rate:12},{id:'acordeon-distante',vol:28,rate:18},{id:'drone-suspiria',vol:32,rate:8},{id:'zumbido-moscas',vol:22,rate:25}] },
};


// ─── INTENCIÓN NARRATIVA DE ESCENAS ──────────────────────────────────────────
const PRESET_INTENT = {
  'Tormenta':     'Para escenas de refugio, persecución bajo la lluvia o confesiones junto al fuego.',
  'Biblioteca':   'Estudio nocturno, investigación secreta, descubrimiento de un manuscrito antiguo.',
  'Taberna':      'Encuentros en lugares oscuros, información que se compra con monedas o secretos.',
  'Bosque':       'Amanecer antes de la batalla, huida al alba, un mundo que todavía no sabe lo que viene.',
  'Alta Mar':     'Travesía sin retorno, el horizonte como única respuesta, la tormenta que no cesa.',
  'Cripta':       'Lo que yace bajo la ciudad. Lo que lleva siglos esperando ser encontrado.',
  'Ciudad':       'La calle como testigo mudo. Alguien te sigue. La lluvia borra las huellas.',
  'Onírico':      'Entre el sueño y la vigilia. Donde las reglas del mundo no aplican todavía.',
  'Desierto':     'Soledad absoluta. El silencio como personaje. La noche que dura demasiado.',
  'Iglesia':      'Fe que vacila. Confesión imposible. Un dios que escucha pero no responde.',
  'Barco Pirata': 'El mar como enemigo. La madera como único hogar. La tempestad como prueba.',
  'Calabozo':     'Cautiverio. El tiempo que se deshace. La esperanza que llega por las rendijas.',
  'Slasher':      'Alguien está en la casa. Los pasos se acercan. El teléfono no tiene señal.',
  'Giallo':       'El asesino tiene guantes negros. La música avisa antes que los ojos.',
  'Suspiria':     'La academia tiene un secreto. Las paredes recuerdan lo que los vivos callan.',
  'Synth Noir':   'Ciudad de neón y lluvia. Un caso que no debiste aceptar. Ya es tarde.',
  'Persecución':  'El corazón no para. Las calles se confunden. No mires atrás.',
  'Posesión':     'La casa respira. Algo lleva tu nombre en la voz equivocada.',
  'Carnicería':   'Lo que quedó después. El olor que no se va. El silencio que pesa demasiado.',
  'Apertura':     'El tráiler antes de que todo empiece. La promesa de lo que está por venir.',
  'Asilo':        'Los pasillos no llevan a ningún lado conocido. Alguien apuntó tu nombre en la pared.',
  "R'lyeh":       'Ph\'nglui mglw\'nafh Cthulhu R\'lyeh wgah\'nagl fhtagn. Ha despertado.',
  'Culto':        'El fuego en el bosque. Los que danzan no son del todo humanos ya.',
  'Innsmouth':    'El pueblo que huele a mar podrido. Los ojos que no parpadean del todo.',
  'Azathoth':     'En el centro del caos. Las flautas idiotas. El trono que no debería existir.',
  'Meditacion':   'El cuerpo se asienta. La mente se abre. Lo que eras hace un momento ya no importa.',
  'Bienestar':    'Calma sin esfuerzo. El ronroneo del universo. Todo está, por ahora, bien.',
  'Nyarla':       'El Mensajero de los Dioses Exteriores. Toma muchas formas. Ya está aquí.',
  'MisaNegra':    'La liturgia invertida. Lo que se invoca no siempre obedece.',
  'CircoInf':     'La carpa que no estaba ayer. La música que no debería sonar así.',
};

// ─── STATE ────────────────────────────────────────────────────────────────
let layers = [];
let savedScenes = (function() {
  try { return JSON.parse(localStorage.getItem('nocturne-scenes') || '{}'); } catch(e) { return {}; }
})();
let timerMin = 25, timerSec = 0, timerRunning = false, timerInterval = null;
let animFrame = null;
let waveData = {};

// ─── SAFETY / DATA NORMALIZATION ───────────────────────────────────────────
function cleanText(value, fallback = '', maxLen = 120) {
  const raw = value == null ? '' : String(value);
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, maxLen);
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeLayerInput(layer) {
  if (!layer || typeof layer !== 'object') return null;
  const id = cleanText(layer.id, '', 80);
  if (!id || !findSoundDef(id)) return null;
  return {
    id,
    vol: clampNum(layer.vol, 0, 100, 50),
    rate: clampNum(layer.rate, 0, 60, 30),
    muted: !!layer.muted,
    corruption: clampNum(layer.corruption || 0, 0, 100, 0)
  };
}

function sanitizeSceneInput(scene, fallbackName = 'Sin nombre') {
  const src = scene && typeof scene === 'object' ? scene : {};
  const name = cleanText(src.name, fallbackName, 80) || 'Sin nombre';
  const safeLayers = Array.isArray(src.layers)
    ? src.layers.map(sanitizeLayerInput).filter(Boolean).slice(0, 12)
    : [];
  const moods = Array.isArray(src.moods)
    ? src.moods.map(m => cleanText(m, '', 40)).filter(Boolean).slice(0, 12)
    : [];
  const rawProfile = cleanText(src.profile, 'cinematic', 24);
  const profile = ['cinematic','natural','dark','cosmic','vhs'].includes(rawProfile) ? rawProfile : 'cinematic';
  return {
    name,
    layers: safeLayers,
    notes: cleanText(src.notes, '', 4000),
    moods,
    master: clampNum(src.master, 0, 100, 70),
    reverb: clampNum(src.reverb, 0, 100, 20),
    lp: clampNum(src.lp, 0, 100, 100),
    hp: clampNum(src.hp, 0, 100, 0),
    profile,
    savedAt: Number.isFinite(Number(src.savedAt)) ? Number(src.savedAt) : Date.now()
  };
}

function sanitizeSceneLibrary(source) {
  const out = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  Object.entries(source).forEach(([key, scene]) => {
    const safe = sanitizeSceneInput(scene, cleanText(key, 'Sin nombre', 80));
    if (safe.layers.length || safe.name) out[safe.name] = safe;
  });
  return out;
}

function saveStorageScenes() {
  try { localStorage.setItem('nocturne-scenes', JSON.stringify(savedScenes)); } catch(e) {}
}

savedScenes = sanitizeSceneLibrary(savedScenes);

// ─── LAYER MANAGEMENT ────────────────────────────────────────────────────


function toggleSound(id) {
  const existing = layers.findIndex(l => l.id === id);
  if (existing >= 0) {
    removeLayer(id);
  } else {
    if (layers.length >= 12) { showToast('Máximo 12 capas simultáneas'); return; }
    addLayer(id, 50, 30);
  }
}

function addLayer(id, vol = 50, rate = 30) {
  const def = findSoundDef(id);
  if (!def) return;
  if (layers.find(l => l.id === id)) return;
  vol = clampNum(vol, 0, 100, 50);
  rate = clampNum(rate, 0, 60, 30);
  layers.push({ id, name: def.name, color: def.color, tag: def.tag, vol, rate, muted: false });
  if (playing) startLayerAudio(id);
  renderLayers();
  syncSidebar();
  updateIntensity();
}

function removeLayer(id) {
  stopLayerAudio(id);
  layers = layers.filter(l => l.id !== id);
  delete waveData[id];
  renderLayers();
  syncSidebar();
  updateIntensity();
}

function clearAll() {
  [...layers].forEach(l => stopLayerAudio(l.id));
  layers = [];
  waveData = {};
  renderLayers();
  syncSidebar();
  updateIntensity();
  document.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('on'));
}

function updateLayer(id, prop, val) {
  const l = layers.find(x => x.id === id);
  if (!l) return;
  const max = prop === 'rate' ? 60 : 100;
  const safeVal = clampNum(val, 0, max, prop === 'rate' ? 30 : 50);
  l[prop] = safeVal;
  if (prop === 'vol' && audioNodes[id]) {
    audioNodes[id].out.gain.value = (safeVal / 100) * (l.muted ? 0 : 1);
  }
  updateIntensity();
}

function toggleMute(id) {
  const l = layers.find(x => x.id === id);
  if (!l) return;
  l.muted = !l.muted;
  if (audioNodes[id]) {
    audioNodes[id].out.gain.value = l.muted ? 0 : l.vol / 100;
  }
  const card = document.getElementById('lc-' + id);
  if (card) card.classList.toggle('muted', l.muted);
  const muteBtn = document.getElementById('mb-' + id);
  if (muteBtn) {
    muteBtn.classList.toggle('on-danger', l.muted);
    muteBtn.innerHTML = l.muted ? svgVolOff() : svgVol();
  }
  updateIntensity();
}

// ─── AUDIO CONTROL ───────────────────────────────────────────────────────

function startLayerAudio(id) {
  if (audioNodes[id]) return;
  ensureAudio();
  const l = layers.find(x => x.id === id);
  if (!l || !audioCtx) return;
  const nodes = createSoundNode(id, l.muted ? 0 : l.vol, l.rate);
  if (nodes) {
    // Fade in to avoid clicks
    const targetGain = l.muted ? 0 : l.vol / 100;
    nodes.out.gain.setValueAtTime(0, audioCtx.currentTime);
    nodes.out.gain.setTargetAtTime(targetGain, audioCtx.currentTime, 0.02);
    audioNodes[id] = nodes;
  }
}

function stopLayerAudio(id) {
  if (!audioNodes[id]) return;
  const nodes = audioNodes[id];
  // Fade out before stopping to avoid clicks
  if (nodes.out && audioCtx) {
    try {
      nodes.out.gain.setTargetAtTime(0, audioCtx.currentTime, 0.015);
      setTimeout(() => { stopNodes(nodes); }, 80);
    } catch(e) { stopNodes(nodes); }
  } else {
    stopNodes(nodes);
  }
  delete audioNodes[id];
}

function setMaster(val) {
  val = clampNum(val, 0, 100, 80);
  if (masterGain) masterGain.gain.value = val / 100;
  const slider = document.getElementById('master-slider');
  if (slider && Number(slider.value) !== val) slider.value = String(val);
  document.getElementById('master-val').textContent = val;
}

function togglePlay() {
  if (!ensureAudio() || !audioCtx) {
    playing = false;
    return;
  }
  playing = !playing;

  if (playing) {
    const startAll = () => {
      layers.forEach(l => startLayerAudio(l.id));
    };
    if (audioCtx.state === 'suspended') {
      audioCtx.resume()
        .then(startAll)
        .catch(() => {
          playing = false;
          showToast('Toca de nuevo para activar el audio en este navegador');
        });
    } else {
      startAll();
    }
    document.getElementById('play-icon').innerHTML = '<rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/>';
    document.getElementById('live-dot').classList.add('on');
    document.getElementById('live-label').textContent = 'reproduciendo';
    startWaveAnim();
  } else {
    Object.keys(audioNodes).forEach(stopLayerAudio);
    document.getElementById('play-icon').innerHTML = '<path d="M6 4l7 4-7 4V4z"/>';
    document.getElementById('live-dot').classList.remove('on');
    document.getElementById('live-label').textContent = 'detenido';
    stopWaveAnim();
  }
}

// ─── WAVEFORM ANIMATION ──────────────────────────────────────────────────

function startWaveAnim() {
  function frame() {
    layers.forEach(l => {
      const container = document.getElementById('wave-' + l.id);
      if (!container) return;
      const bars = container.querySelectorAll('.wv-bar');
      bars.forEach(bar => {
        const h = l.muted ? 2 : Math.round(2 + Math.random() * (l.vol / 100) * 16);
        bar.style.height = h + 'px';
        bar.style.opacity = l.muted ? '0.15' : (0.3 + (l.vol / 100) * 0.55).toFixed(2);
      });
    });
    animFrame = requestAnimationFrame(frame);
  }
  animFrame = requestAnimationFrame(frame);
}

function stopWaveAnim() {
  cancelAnimationFrame(animFrame);
  document.querySelectorAll('.wv-bar').forEach(b => { b.style.height = '2px'; b.style.opacity = '0.2'; });
}

// ─── RENDER ──────────────────────────────────────────────────────────────


// SVG icons inline


// ─── CATALOG RENDER ──────────────────────────────────────────────────────



// ─── PRESETS ────────────────────────────────────────────────────────────



// ─── SAVE / EXPORT / IMPORT ──────────────────────────────────────────────







// ─── TIMER ───────────────────────────────────────────────────────────────

function setTimer(min) {
  timerMin = min; timerSec = 0;
  if (timerRunning) stopTimer();
  renderTimer();
}

function toggleTimer() {
  timerRunning ? stopTimer() : startTimer();
}

// startTimer defined later with mobile sync and alarm

// stopTimer defined later with mobile sync

function renderTimer() {
  const m = String(timerMin).padStart(2,'0');
  const s = String(timerSec).padStart(2,'0');
  const text = `${m}:${s}`;
  document.getElementById('timer-display').textContent = text;
  const mDisp = document.getElementById('timer-display-m');
  if (mDisp) mDisp.textContent = text;
}

// ─── INTENSITY METER ─────────────────────────────────────────────────────

function updateIntensity() {
  const bars = document.getElementById('intensity-bars');
  if (!bars.children.length) {
    for (let i = 0; i < 20; i++) {
      const b = document.createElement('div');
      b.className = 'int-bar';
      bars.appendChild(b);
    }
  }

  const total = layers.reduce((acc, l) => acc + (l.muted ? 0 : l.vol), 0);
  const max = 12 * 100;
  const intensity = total / max;
  const filled = Math.round(intensity * 20);

  Array.from(bars.children).forEach((b, i) => {
    const active = i < filled;
    b.style.height = active ? (10 + (i / 20) * 28) + 'px' : '3px';
    b.style.background = active
      ? `hsl(${40 - i * 2}, ${60 + i * 2}%, ${55 - i}%)`
      : 'var(--bg4)';
  });

  const labels = ['silencio','susurro','íntima','media','intensa','dramática','caótica'];
  const li = Math.min(Math.floor(intensity * labels.length), labels.length - 1);
  document.getElementById('intensity-label').textContent = labels[li];
}

// ─── MOODS ───────────────────────────────────────────────────────────────



// ─── TOAST ───────────────────────────────────────────────────────────────



// ─── EMOTIONAL AXIS ──────────────────────────────────────────────────────────

// Each sound has [x, y] coords: x = calm(0) to tension(1), y = pleasure(0) to terror(1)
const SOUND_EMOTIONS = {
  'lluvia-pesada':[-1],       // filled dynamically below
};
// Emotion map: [tensionX 0-1, terrorY 0-1]
const EMO_MAP = {
  'lluvia-pesada':[0.3,0.4],'lluvia-fina':[0.1,0.2],'tormenta-electrica':[0.7,0.6],
  'gotas-cristal':[0.2,0.3],'arroyo':[0.05,0.05],'rio':[0.15,0.1],'cascada':[0.2,0.15],
  'olas-orilla':[0.1,0.1],'lluvia-tejado':[0.25,0.3],'charco-pasos':[0.3,0.35],
  'viento-fuerte':[0.5,0.45],'brisa-suave':[0.05,0.05],'viento-chimenea':[0.3,0.35],
  'hojas-viento':[0.1,0.1],'silbido-grietas':[0.6,0.55],'eco-cueva':[0.65,0.65],
  'chimenea':[0.1,0.05],'vela':[0.1,0.04],'hoguera':[0.2,0.1],'brasas':[0.15,0.12],
  'incendio-lejano':[0.7,0.7],'pajaros-amanecer':[0.05,0.0],'grillos-nocturnos':[0.2,0.2],
  'buho-lejano':[0.5,0.5],'ranas':[0.15,0.15],'ramas-crujido':[0.6,0.6],
  'hojas-pisadas':[0.35,0.4],'insectos-dia':[0.1,0.08],'viento-arboles':[0.15,0.15],
  'reloj-pared':[0.3,0.25],'paginas':[0.1,0.08],'pasos-madera':[0.4,0.4],
  'pasos-piedra':[0.45,0.5],'puerta-crujido':[0.65,0.65],'escaleras-lejanas':[0.5,0.5],
  'radiador':[0.2,0.2],'pluma-papel':[0.05,0.02],'maquina-escribir':[0.15,0.1],
  'zumbido-electrico':[0.3,0.3],'trafico-lejano':[0.25,0.2],'murmullo-gente':[0.15,0.1],
  'cafe-bullicioso':[0.1,0.02],'metro-subterraneo':[0.4,0.4],'sirena-distante':[0.65,0.55],
  'campanada-iglesia':[0.35,0.35],'mercado-exterior':[0.1,0.05],'taberna-medieval':[0.15,0.08],
  'plaza-atardecer':[0.1,0.05],'violin-lejano':[0.3,0.35],'organo-iglesia':[0.4,0.45],
  'acordeon-distante':[0.2,0.15],'drone-tension':[0.8,0.8],'drones-misterio':[0.7,0.75],
  'coros-lejanos':[0.35,0.4],'campanas-viento':[0.25,0.3],'tambor-tribal':[0.6,0.6],
  'goteo-caverna':[0.55,0.65],'eco-profundo':[0.65,0.7],'crujido-madera':[0.65,0.7],
  'pasos-barro':[0.55,0.6],'respiracion':[0.7,0.75],'metal-arrastre':[0.75,0.78],
  'silencio-pesado':[0.5,0.55],'voz-ininteligible':[0.8,0.82],'zumbido-cosmico':[0.55,0.6],
  'frecuencias-bajas':[0.6,0.65],'viento-sintetico':[0.5,0.55],'pulso-cardiaco':[0.7,0.7],
  'eco-vacio':[0.65,0.68],'cristales-tintinean':[0.3,0.35],'mar-abierto':[0.2,0.2],
  'madera-barco':[0.3,0.3],'velas-viento':[0.2,0.2],'gaviotas':[0.1,0.08],
  'cuadernas-crujido':[0.5,0.5],'mar-tempestad':[0.75,0.7],
  'pulso-carpenter':[0.7,0.7],'arpegio-sintetico':[0.65,0.65],'bajo-pulsante':[0.65,0.65],
  'pad-tension':[0.75,0.75],'pad-creciente':[0.8,0.78],'caja-musica':[0.5,0.6],
  'caja-musica-rota':[0.6,0.7],'clavecin-espectral':[0.55,0.65],'clavecin-goblin':[0.65,0.72],
  'drone-suspiria':[0.78,0.82],'coro-susurros':[0.7,0.75],'stinger-cuerdas':[0.9,0.9],
  'glissando-ascendente':[0.8,0.7],'glissando-descendente':[0.75,0.8],
  'cuerdas-tremolo':[0.75,0.72],'tension-cuerdas':[0.8,0.78],'zumbido-agudo':[0.7,0.65],
  'bordon-creciente':[0.75,0.72],'metales-disonantes':[0.85,0.82],'braam-trailer':[0.9,0.85],
  'tambor-profundo':[0.7,0.65],'redoble-creciente':[0.78,0.72],'corazon-acelerado':[0.82,0.75],
  'respiracion-jadeo':[0.7,0.8],'aranazos':[0.75,0.82],'zumbido-moscas':[0.6,0.75],
  'risa-infantil':[0.72,0.88],'crujido-huesos':[0.68,0.85],'piano-preparado':[0.55,0.65],
  'theremin-fantasmal':[0.6,0.68],'violin-chirriante':[0.7,0.72],'cuerda-frotada':[0.65,0.7],
  'campana-invertida':[0.55,0.65],'maquinaria-oxidada':[0.6,0.55],'cadena-arrastre':[0.68,0.72],
  'radio-interferencia':[0.55,0.5],'generador-fallando':[0.5,0.5],'transmision-perdida':[0.55,0.52],
  'secuencia-synthwave':[0.65,0.55],'acorde-congelado':[0.7,0.65],'barrido-filtro':[0.5,0.5],
  'arpegio-panico':[0.8,0.72],'llamada-cthulhu':[0.88,0.95],'coros-rlyeh':[0.85,0.92],
  'latido-azathoth':[0.92,0.95],'senal-yuggoth':[0.75,0.85],'susurro-nyarla':[0.82,0.9],
  'profundidades-innsmouth':[0.7,0.88],'flautas-azathoth':[0.88,0.92],'shoggoth-masa':[0.85,0.95],
  'zumbido-mi-go':[0.72,0.8],'puertas-yog':[0.9,0.9],'abismo-dagon':[0.78,0.92],
  'viento-hastur':[0.82,0.88],'respiracion-dios':[0.65,0.8],'eco-no-euclidiano':[0.8,0.85],
  'infrasound-19hz':[0.75,0.8],'binaural-alpha':[0.1,0.02],'binaural-theta':[0.05,0.02],
  'binaural-delta':[0.02,0.0],'shepard-desc':[0.72,0.72],'shepard-asc':[0.68,0.65],
  'resonancia-schumann':[0.15,0.1],'escala-microtonal':[0.45,0.5],'escala-tonos-enteros':[0.35,0.4],
  'frecuencia-111hz':[0.3,0.2],'formante-vacio':[0.6,0.68],'ronroneo-gato':[0.02,0.0],
  'frecuencia-528hz':[0.05,0.0],'onda-alpha':[0.08,0.0],'onda-theta':[0.05,0.0],
  'quinta-perfecta':[0.02,0.0],'serie-armonica':[0.05,0.0],'cuenco-tibetano-396':[0.04,0.0],
  'cuenco-tibetano-528':[0.04,0.0],'tambor-chamanes':[0.08,0.02],'nada-brahma-om':[0.04,0.0],
  'canto-ballenas':[0.06,0.0],'didgeridoo-drone':[0.08,0.02],'acorde-resolucion':[0.02,0.0],
  'canto-culto':[0.6,0.65],'tambores-ritual':[0.65,0.7],'canto-gregoriano-oscuro':[0.55,0.6],
  'glosolalia':[0.62,0.68],'om-corrompido':[0.58,0.65],'misa-negra':[0.7,0.75],
  'derviche-giro':[0.5,0.55],'pantano-nocturno':[0.4,0.45],'circo-siniestro':[0.65,0.75],
  'submarino-abismo':[0.55,0.55],'biblioteca-prohibida':[0.5,0.5],'iglesia-profanada':[0.65,0.7],
  'laboratorio-doctor':[0.6,0.55],'tren-nocturno':[0.3,0.3],'retroalimentacion':[0.65,0.6],
  'silencio-granular':[0.4,0.35],'espectro-invertido':[0.65,0.68],
};

let emoX = 0.5, emoY = 0.5, emoDragging = false;

function initEmoAxis() {
  const canvas = document.getElementById('emo-canvas');
  if (!canvas) return;
  const size = canvas.parentElement.offsetWidth;
  canvas.width = size; canvas.height = size;
  drawEmoAxis();

  canvas.addEventListener('mousedown', e => { emoDragging = true; updateEmoFromEvent(canvas, e); });
  canvas.addEventListener('mousemove', e => { if (emoDragging) updateEmoFromEvent(canvas, e); });
  canvas.addEventListener('mouseup', () => emoDragging = false);
  canvas.addEventListener('mouseleave', () => emoDragging = false);
  canvas.addEventListener('touchstart', e => { emoDragging = true; updateEmoFromEvent(canvas, e.touches[0]); e.preventDefault(); }, {passive:false});
  canvas.addEventListener('touchmove', e => { if (emoDragging) updateEmoFromEvent(canvas, e.touches[0]); e.preventDefault(); }, {passive:false});
  canvas.addEventListener('touchend', () => emoDragging = false);
}

function updateEmoFromEvent(canvas, e) {
  const r = canvas.getBoundingClientRect();
  emoX = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  emoY = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
  drawEmoAxis();
}

function drawEmoAxis() {
  const canvas = document.getElementById('emo-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Background gradient
  const grad = ctx.createRadialGradient(W*emoX, H*emoY, 0, W*emoX, H*emoY, Math.max(W,H)*0.8);
  grad.addColorStop(0, emoY > 0.5
    ? `rgba(80,10,10,${0.4 + emoX*0.3})`
    : `rgba(10,60,10,${0.3 + (1-emoY)*0.3})`);
  grad.addColorStop(1, 'rgba(14,13,11,0.95)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(W/2,0); ctx.lineTo(W/2,H); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke();

  // Sound dots
  Object.entries(EMO_MAP).forEach(([id, [tx, ty]]) => {
    const active = layers.some(l => l.id === id);
    const px = tx * W, py = ty * H;
    ctx.beginPath();
    ctx.arc(px, py, active ? 4 : 2, 0, Math.PI*2);
    ctx.fillStyle = active ? '#c8a96e' : 'rgba(255,255,255,0.15)';
    ctx.fill();
  });

  // Cursor
  const cx = emoX * W, cy = emoY * H;
  ctx.beginPath();
  ctx.arc(cx, cy, 8, 0, Math.PI*2);
  ctx.strokeStyle = '#c8a96e';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 2.5, 0, Math.PI*2);
  ctx.fillStyle = '#c8a96e';
  ctx.fill();

  // Sync mobile canvas if open
  const mCanvas = document.getElementById('emo-canvas-m');
  if (mCanvas && mCanvas.width > 0) drawEmoAxisOnCanvas(mCanvas);
}

function applyEmotionalAxis() {
  // Score each sound by proximity to emo point — lower distance = higher score
  const tx = emoX, ty = emoY;
  const scored = Object.entries(EMO_MAP).map(([id, [sx, sy]]) => {
    const dist = Math.sqrt((sx-tx)**2 + (sy-ty)**2);
    return { id, dist, score: 1 - dist };
  }).sort((a,b) => a.dist - b.dist);

  // Take top 6 closest sounds
  const top = scored.slice(0, 6);
  clearAll();
  top.forEach(({ id, score }) => {
    const vol = Math.round(30 + score * 50);
    addLayer(id, vol, 25);
  });
  renderLayers(); syncSidebar(); updateIntensity();
  drawEmoAxis();
  showToast('Mezcla generada desde el eje emocional');
}

// ─── CORRUPTION SYSTEM ───────────────────────────────────────────────────────

const CORRUPTION_PAIRS = {
  // pure -> corrupted version
  'cuenco-tibetano-396': 'drone-suspiria',
  'cuenco-tibetano-528': 'pad-creciente',
  'nada-brahma-om':      'om-corrompido',
  'tambor-chamanes':     'tambores-ritual',
  'quinta-perfecta':     'metales-disonantes',
  'serie-armonica':      'drone-tension',
  'acorde-resolucion':   'acorde-congelado',
  'onda-alpha':          'infrasound-19hz',
  'onda-theta':          'binaural-delta',
  'coro-susurros':       'glosolalia',
  'canto-culto':         'misa-negra',
  'ronroneo-gato':       'zumbido-moscas',
  'lluvia-fina':         'lluvia-pesada',
  'arroyo':              'profundidades-innsmouth',
  'pajaros-amanecer':    'buho-lejano',
  'chimenea':            'hoguera',
};

function setCorruption(id, val) {
  const l = layers.find(x => x.id === id);
  if (!l) return;
  l.corruption = val;

  const targetId = CORRUPTION_PAIRS[l.id];
  if (!targetId) return; // no corruption pair defined

  if (val === 0) {
    // Remove the corruption layer if it was added
    if (layers.find(x => x.id === targetId + '-crp')) {
      removeLayer(targetId + '-crp');
    }
    return;
  }

  // Adjust the original layer volume down proportionally
  const newVol = Math.round(l.vol * (1 - val/100));
  if (audioNodes[l.id]) audioNodes[l.id].out.gain.value = newVol / 100;

  // Add or update a corruption layer (tagged as corruption)
  const existingCorruption = layers.find(x => x._corruptionFor === id);
  const corruptVol = Math.round((val / 100) * l.vol);
  if (existingCorruption) {
    existingCorruption.vol = corruptVol;
    if (audioNodes[existingCorruption.id]) audioNodes[existingCorruption.id].out.gain.value = corruptVol / 100;
  } else if (corruptVol > 0 && !layers.find(x => x.id === targetId)) {
    const def = findSoundDef(targetId);
    if (def) {
      layers.push({ id: targetId, name: def.name + ' ⟨corrupto⟩', color: '#A32D2D', tag: 'corrupción', vol: corruptVol, rate: l.rate, muted: false, _corruptionFor: id });
      if (playing) startLayerAudio(targetId);
    }
  }
}

// ─── MASTER FX ───────────────────────────────────────────────────────────

const MASTER_PROFILES = {
  cinematic: { label: 'Cine', master: 80, reverb: 28, lp: 92, hp: 3, hybrid: 62 },
  natural:   { label: 'Natural', master: 78, reverb: 12, lp: 100, hp: 0, hybrid: 45 },
  dark:      { label: 'Oscuro', master: 76, reverb: 36, lp: 74, hp: 8, hybrid: 70 },
  cosmic:    { label: 'Cósmico', master: 74, reverb: 48, lp: 82, hp: 2, hybrid: 76 },
  vhs:       { label: 'VHS 80s', master: 77, reverb: 18, lp: 68, hp: 12, hybrid: 58 }
};

function setControlPair(baseId, mobileId, value) {
  [baseId, mobileId].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = String(value);
  });
}

function updateMasterProfileButtons() {
  document.querySelectorAll('.master-profile-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.profile === currentMasterProfile);
  });
}

function applyMasterProfile(profileKey, silent = false) {
  const key = MASTER_PROFILES[profileKey] ? profileKey : 'cinematic';
  const p = MASTER_PROFILES[key];
  currentMasterProfile = key;
  try { localStorage.setItem('nocturne-master-profile', key); } catch(e) {}

  setControlPair('master-slider', null, p.master);
  setControlPair('reverb-slider', 'reverb-slider-m', p.reverb);
  setControlPair('lp-slider', 'lp-slider-m', p.lp);
  setControlPair('hp-slider', 'hp-slider-m', p.hp);
  setMaster(p.master);
  setReverb(p.reverb);
  setLowpass(p.lp);
  setHighpass(p.hp);
  setHybridBlend(p.hybrid);
  updateMasterProfileButtons();
  if (!silent) showToast(`Masterización: ${p.label}`);
}

function loadMasterProfile() {
  let saved = 'cinematic';
  try { saved = localStorage.getItem('nocturne-master-profile') || 'cinematic'; } catch(e) {}
  applyMasterProfile(saved, true);
}

function setReverb(val) {
  val = clampNum(val, 0, 100, 0);
  document.getElementById('reverb-val').textContent = val;
  const mVal = document.getElementById('reverb-val-m');
  if (mVal) mVal.textContent = val;
  if (!reverbWet) return;
  const w = val / 100;
  reverbWet.gain.value = w;
  reverbDry.gain.value = 1 - w * 0.5;
}

function setLowpass(val) {
  val = clampNum(val, 0, 100, 100);
  document.getElementById('lp-val').textContent = val;
  if (!lpMaster) return;
  // 0 -> 300 Hz (muffled), 100 -> 20000 Hz (open)
  const freq = 300 * Math.pow(20000 / 300, val / 100);
  lpMaster.frequency.value = freq;
}

function setHighpass(val) {
  val = clampNum(val, 0, 100, 0);
  document.getElementById('hp-val').textContent = val;
  if (!hpMaster) return;
  // 0 -> 20 Hz (full), 100 -> 2000 Hz (thin)
  const freq = 20 * Math.pow(2000 / 20, val / 100);
  hpMaster.frequency.value = freq;
}

// ─── DIRECTOR MODE ─────────────────────────────────────────────────────────

let directorActive = false;
let directorRAF = null;
let directorStart = 0;
let directorBaseVols = {};

function toggleDirector() {
  directorActive ? stopDirector() : startDirector();
}

function setButtonState(ids, text, active) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('active', !!active);
  });
}

function getDirectorArc() {
  const mobileArc = document.getElementById('director-arc-m');
  const desktopArc = document.getElementById('director-arc');
  if (isMobileTabletUI() && mobileArc) return mobileArc.value;
  return desktopArc ? desktopArc.value : 'build';
}

function startDirector() {
  if (!layers.length) { showToast('Añade capas antes de dirigir'); return; }
  if (!playing) togglePlay();
  directorActive = true;
  directorStart = performance.now();
  directorBaseVols = {};
  layers.forEach(l => { directorBaseVols[l.id] = l.vol; });
  setButtonState(['director-toggle', 'director-toggle-m'], '■ Detener evolución', true);
  directorLoop();
}

function stopDirector() {
  directorActive = false;
  cancelAnimationFrame(directorRAF);
  setButtonState(['director-toggle', 'director-toggle-m'], '▶ Iniciar evolución', false);
  // restore base volumes
  layers.forEach(l => {
    if (directorBaseVols[l.id] != null) {
      l.vol = directorBaseVols[l.id];
      if (audioNodes[l.id] && !l.muted) audioNodes[l.id].out.gain.value = l.vol / 100;
      const slider = document.querySelector(`#lc-${l.id} input[type=range]`);
      if (slider) { slider.value = l.vol; const v = document.getElementById('vlv-' + l.id); if (v) v.textContent = Math.round(l.vol); }
    }
  });
}

function directorLoop() {
  if (!directorActive) return;
  const arc = getDirectorArc();
  const durMs = +document.getElementById('director-dur').value * 60000;
  const t = Math.min(1, (performance.now() - directorStart) / durMs);

  layers.forEach((l, i) => {
    const base = directorBaseVols[l.id] != null ? directorBaseVols[l.id] : l.vol;
    let factor = 1;
    const stagger = i / Math.max(1, layers.length);
    if (arc === 'build') {
      factor = 0.15 + 0.85 * Math.min(1, t / (0.4 + stagger * 0.5));
    } else if (arc === 'fade') {
      factor = 1 - 0.9 * t;
    } else if (arc === 'wave') {
      factor = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 + stagger * 4));
    } else if (arc === 'random') {
      factor = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(performance.now() / (800 + i * 230) + i));
    }
    const newVol = Math.max(0, Math.min(100, base * factor));
    l.vol = newVol;
    if (audioNodes[l.id] && !l.muted) audioNodes[l.id].out.gain.value = newVol / 100;
    const slider = document.querySelector(`#lc-${l.id} input[type=range]`);
    if (slider) { slider.value = newVol; const v = document.getElementById('vlv-' + l.id); if (v) v.textContent = Math.round(newVol); }
  });
  updateIntensity();

  if (t >= 1 && arc !== 'wave' && arc !== 'random') { stopDirector(); showToast('Dirección completada'); return; }
  directorRAF = requestAnimationFrame(directorLoop);
}

// ─── EVENT RANDOMIZER ──────────────────────────────────────────────────────

let randomizerActive = false;
let randomizerTimer = null;
const EVENT_TAGS = ['evento','terror','impacto','giallo'];

function toggleRandomizer() {
  randomizerActive ? stopRandomizer() : startRandomizer();
}

function startRandomizer() {
  randomizerActive = true;
  setButtonState(['randomizer-toggle', 'randomizer-toggle-m'], '■ Desactivar', true);
  scheduleRandomEvent();
}

function stopRandomizer() {
  randomizerActive = false;
  clearTimeout(randomizerTimer);
  setButtonState(['randomizer-toggle', 'randomizer-toggle-m'], '▶ Activar', false);
}

function scheduleRandomEvent() {
  if (!randomizerActive) return;
  const delay = 4000 + Math.random() * 12000;
  randomizerTimer = setTimeout(() => {
    const eventLayers = layers.filter(l => EVENT_TAGS.includes(l.tag) && !l.muted);
    if (eventLayers.length && playing) {
      const l = eventLayers[Math.floor(Math.random() * eventLayers.length)];
      if (audioNodes[l.id]) {
        const g = audioNodes[l.id].out.gain;
        const orig = l.vol / 100;
        g.value = Math.min(1, orig * 2.2);
        setTimeout(() => { if (audioNodes[l.id]) audioNodes[l.id].out.gain.value = orig; }, 1500);
      }
      const card = document.getElementById('lc-' + l.id);
      if (card) { card.style.transition = 'border-color .2s'; card.style.borderColor = 'var(--danger)'; setTimeout(() => { card.style.borderColor = ''; }, 800); }
    }
    scheduleRandomEvent();
  }, delay);
}

// ─── CINEMA MODE ───────────────────────────────────────────────────────────

let cinemaOn = false;
let vizRAF = null;

function toggleCinema() {
  cinemaOn = !cinemaOn;
  document.body.classList.toggle('cinema', cinemaOn);
  document.getElementById('btn-cinema').classList.toggle('active', cinemaOn);
  if (cinemaOn) {
    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    startViz();
  } else {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    stopViz();
  }
}

function startViz() {
  const canvas = document.getElementById('bg-viz');
  const ctx = canvas.getContext('2d');
  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  resize();
  window.addEventListener('resize', resize);

  const freqData = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;

  function draw() {
    if (!cinemaOn) return;
    ctx.fillStyle = 'rgba(14,13,11,0.18)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (analyser && freqData) {
      analyser.getByteFrequencyData(freqData);
      const cx = canvas.width / 2, cy = canvas.height / 2;
      const bins = freqData.length;
      for (let i = 0; i < bins; i += 2) {
        const amp = freqData[i] / 255;
        if (amp < 0.04) continue;
        const angle = (i / bins) * Math.PI * 2;
        const radius = 80 + amp * Math.min(canvas.width, canvas.height) * 0.4;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        const hue = 28 + amp * 12;
        ctx.fillStyle = `hsla(${hue}, ${40 + amp * 30}%, ${40 + amp * 30}%, ${amp * 0.6})`;
        ctx.beginPath();
        ctx.arc(x, y, 1.5 + amp * 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    vizRAF = requestAnimationFrame(draw);
  }
  draw();
}

function stopViz() {
  cancelAnimationFrame(vizRAF);
  const canvas = document.getElementById('bg-viz');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && cinemaOn) {
    cinemaOn = false;
    document.body.classList.remove('cinema');
    document.getElementById('btn-cinema').classList.remove('active');
    stopViz();
  }
});

// ─── SHARE BY URL ──────────────────────────────────────────────────────────

function shareScene() {
  const data = {
    n: cleanText(document.getElementById('scene-name').value, 'Escena compartida', 80),
    l: layers.map(l => [l.id, l.vol, l.rate, l.muted ? 1 : 0]),
    m: document.getElementById('master-slider').value,
    r: document.getElementById('reverb-slider').value,
    p: currentMasterProfile
  };
  try {
    const encoded = btoa(encodeURIComponent(JSON.stringify(data)));
    const url = location.origin + location.pathname + '#s=' + encoded;
    navigator.clipboard.writeText(url).then(
      () => showToast('Enlace copiado al portapapeles'),
      () => { prompt('Copia este enlace:', url); }
    );
  } catch (e) { showToast('No se pudo generar el enlace'); }
}

function loadFromURL() {
  const hash = location.hash;
  if (!hash.startsWith('#s=')) return false;
  try {
    const data = JSON.parse(decodeURIComponent(atob(hash.slice(3))));
    clearAll();
    if (data.n) document.getElementById('scene-name').value = cleanText(data.n, 'Escena compartida', 80);
    const safeLayers = Array.isArray(data.l)
      ? data.l.map(row => Array.isArray(row) ? sanitizeLayerInput({ id: row[0], vol: row[1], rate: row[2], muted: row[3] === 1 }) : null).filter(Boolean).slice(0, 12)
      : [];
    safeLayers.forEach(layer => {
      addLayer(layer.id, layer.vol, layer.rate);
      if (layer.muted) { const l = layers.find(x => x.id === layer.id); if (l) l.muted = true; }
    });
    if (data.m != null) { setMaster(data.m); }
    if (data.r != null) { setReverb(data.r); }
    if (data.p && ['cinematic','natural','dark','cosmic','vhs'].includes(data.p)) { currentMasterProfile = data.p; updateMasterProfileButtons(); }
    renderLayers(); syncSidebar(); updateIntensity();
    showToast('Escena cargada desde enlace');
    return true;
  } catch (e) { return false; }
}

// ─── KEYBOARD SHORTCUTS ──────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'c' || e.key === 'C') { toggleCinema(); }
  else if (e.key === 'd' || e.key === 'D') { toggleDirector(); }
  else if (e.key === 'r' || e.key === 'R') { toggleRandomizer(); }
  else if (e.key === 'Escape' && cinemaOn) { toggleCinema(); }
  else if (e.key === '?') { showOnboard(); }
});

// ── UI LAYER ──
// ─── UI: TABS ────────────────────────────────────────────────────────────────
function switchTab(id, btn) {
  const root = btn?.closest('.sidebar-right') || document;
  root.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  root.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById('tab-' + id);
  if (panel) panel.classList.add('active');
  if (btn) btn.classList.add('active');
  if (id === 'mezcla') { setTimeout(initEmoAxis, 50); }
}

// ─── UI: VISUAL SKINS ───────────────────────────────────────────────────────
const VISUAL_SKINS = [
  { id:'nocturne', name:'Nocturne', icon:'♭', desc:'Dorado oscuro, sobrio y literario.', themeColor:'#0e0d0b', preview:['#0e0d0b','#242018','#c8a96e','#f0ead8','rgba(200,169,110,.35)'] },
  { id:'vhs', name:'VHS 1987', icon:'▣', desc:'Neón, scanlines y terror analógico.', themeColor:'#09070b', preview:['#09070b','#2d1b36','#ff4d7d','#fff2e5','rgba(43,231,255,.35)'] },
  { id:'rlyeh', name:"R'lyeh", icon:'◌', desc:'Abismo verdoso, ritual y cósmico.', themeColor:'#061012', preview:['#061012','#17343a','#48d597','#e7fff3','rgba(72,213,151,.32)'] },
  { id:'giallo', name:'Giallo Rojo', icon:'◆', desc:'Amarillo sucio y rojo de pesadilla.', themeColor:'#13080a', preview:['#13080a','#3b1b16','#ffb000','#fff0d9','rgba(192,24,45,.36)'] },
  { id:'biblioteca', name:'Biblioteca Oculta', icon:'✦', desc:'Violeta, archivo prohibido y grimorio.', themeColor:'#0b0a12', preview:['#0b0a12','#27223a','#bca7ff','#f2edff','rgba(188,167,255,.34)'] },
  { id:'lluvia', name:'Ciudad Lluvia', icon:'☔', desc:'Azul nocturno, cristal y asfalto mojado.', themeColor:'#071019', preview:['#071019','#21364d','#7dc7ff','#e9f5ff','rgba(125,199,255,.32)'] },
  { id:'inferno', name:'Inferno', icon:'▲', desc:'Carbón, naranja y calor ritual.', themeColor:'#120705', preview:['#120705','#441b0e','#ff7a2f','#fff0df','rgba(255,122,47,.36)'] },
  { id:'papel', name:'Manuscrito', icon:'☰', desc:'Papel cálido para escribir muchas horas.', themeColor:'#f4ead8', preview:['#f4ead8','#d9bd90','#8a4f19','#24170d','rgba(138,79,25,.24)'] }
];

function getVisualSkin(id) {
  return VISUAL_SKINS.find(s => s.id === id) || VISUAL_SKINS[0];
}

function updateThemeColor() {
  const active = getVisualSkin(document.documentElement.dataset.skin || 'nocturne');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  meta.setAttribute('content', document.documentElement.dataset.theme === 'light' && active.id !== 'papel' ? '#f5f0e8' : active.themeColor);
}

function applyVisualSkin(id, quiet = false) {
  const skin = getVisualSkin(id);
  const html = document.documentElement;
  html.dataset.skin = skin.id;
  html.dataset.theme = skin.id === 'papel' ? 'light' : 'dark';
  try {
    localStorage.setItem('nocturne-skin', skin.id);
    localStorage.setItem('nocturne-theme', html.dataset.theme);
  } catch(e) {}
  document.querySelectorAll('.skin-card').forEach(card => card.classList.toggle('on', card.dataset.skin === skin.id));
  const btn = document.getElementById('btn-skins');
  if (btn) btn.classList.add('active');
  updateThemeColor();
  if (!quiet) showToast(`Skin aplicada: ${skin.name}`);
}

function loadVisualSkin() {
  let saved = 'nocturne';
  try { saved = localStorage.getItem('nocturne-skin') || 'nocturne'; } catch(e) {}
  applyVisualSkin(saved, true);
}

function cycleVisualSkin() {
  const current = document.documentElement.dataset.skin || 'nocturne';
  const idx = Math.max(0, VISUAL_SKINS.findIndex(s => s.id === current));
  applyVisualSkin(VISUAL_SKINS[(idx + 1) % VISUAL_SKINS.length].id);
}

function renderSkinPicker() {
  ['skin-picker', 'skin-picker-m'].forEach(targetId => {
    const wrap = document.getElementById(targetId);
    if (!wrap) return;
    wrap.innerHTML = '';
    VISUAL_SKINS.forEach(skin => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'skin-card';
      btn.dataset.skin = skin.id;
      btn.setAttribute('aria-label', `Aplicar skin ${skin.name}`);
      btn.style.setProperty('--skin-preview-bg1', skin.preview[0]);
      btn.style.setProperty('--skin-preview-bg2', skin.preview[1]);
      btn.style.setProperty('--skin-preview-accent', skin.preview[2]);
      btn.style.setProperty('--skin-preview-text', skin.preview[3]);
      btn.style.setProperty('--skin-preview-a', skin.preview[4]);
      const icon = document.createElement('div');
      icon.className = 'skin-icon';
      icon.textContent = skin.icon;
      const name = document.createElement('div');
      name.className = 'skin-name';
      name.textContent = skin.name;
      const desc = document.createElement('div');
      desc.className = 'skin-desc';
      desc.textContent = skin.desc;
      btn.append(icon, name, desc);
      btn.addEventListener('click', () => applyVisualSkin(skin.id));
      wrap.appendChild(btn);
    });
  });
  applyVisualSkin(document.documentElement.dataset.skin || 'nocturne', true);
}

function openSkinPanel() {
  if (isMobileTabletUI()) {
    openMobilePanel('tools');
    const mobileBtn = document.querySelector('.mobile-tools-skins-tab');
    if (mobileBtn) switchMobileTab('skins', mobileBtn);
    return;
  }
  const btn = document.querySelector('.sidebar-right .tab-btn[data-tab="skins"]');
  if (btn) switchTab('skins', btn);
}

// ─── UI: THEME ───────────────────────────────────────────────────────────────
function toggleTheme() {
  const nextSkin = document.documentElement.dataset.theme === 'dark' ? 'papel' : 'nocturne';
  applyVisualSkin(nextSkin);
}
function loadTheme() {
  try {
    const saved = localStorage.getItem('nocturne-theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch(e) {}
  updateThemeColor();
}

// ─── UI: ONBOARDING ──────────────────────────────────────────────────────────
function showOnboard() {
  document.getElementById('onboard-modal').classList.remove('hidden');
}
function dismissOnboard(never) {
  document.getElementById('onboard-modal').classList.add('hidden');
  if (never) localStorage.setItem('nocturne-onboard', '1');

  // Cargar la escena demo seleccionada y arrancar audio
  const selected = document.querySelector('#onboard-demo-picks input[name="demo"]:checked');
  const presetName = selected ? selected.value : 'Tormenta';

  // Limpiar escena actual si está vacía o es la de inicio
  if (layers.length === 0 || (layers.length > 0 && !playing)) {
    layers = [];
    const p = PRESETS[presetName];
    if (p) {
      document.getElementById('scene-name').value = p.name;
      p.ids.forEach(({ id, vol, rate }) => addLayer(id, vol, rate));
      renderLayers();
      syncSidebar();
      updateIntensity();
    }
  }

  // Iniciar audio con fade in suave
  if (!playing) {
    initAudio();
    // Silenciar master temporalmente y hacer fade in
    if (masterGain) {
      masterGain.gain.setValueAtTime(0, audioCtx.currentTime);
      masterGain.gain.linearRampToValueAtTime(
        document.getElementById('master-slider').value / 100,
        audioCtx.currentTime + 1.5
      );
    }
    togglePlay();
  }

  showToast('🎧 Usa auriculares para la experiencia completa');
}
function checkOnboard() {
  if (!localStorage.getItem('nocturne-onboard')) showOnboard();
}

// ─── UI: CATALOG WITH CHIPS + TOOLTIPS ───────────────────────────────────────
const SOUND_TOOLTIPS = {
  'lluvia-pesada':'Lluvia intensa, ruido marrón filtrado con modulación de intensidad',
  'lluvia-fina':'Llovizna suave, espectro de alta frecuencia y densidad baja',
  'tormenta-electrica':'Tormenta completa con variaciones de intensidad dramáticas',
  'gotas-cristal':'Impacto de gotas individuales sobre superficie de vidrio',
  'arroyo':'Corriente de agua sobre piedras, textura rica en medios',
  'rio':'Caudal continuo y grave, más potente que el arroyo',
  'cascada':'Caída de agua a distancia, ruido blanco denso',
  'olas-orilla':'Olas que llegan y retroceden, ciclo de 8-10 segundos',
  'lluvia-tejado':'Lluvia filtrada por la estructura, más suave y envolvente',
  'charco-pasos':'Pasos irregulares sobre charcos, impactos húmedos',
  'viento-fuerte':'Viento de tormenta, modulación lenta y potente',
  'brisa-suave':'Aire apenas perceptible, movimiento de hojas ligeras',
  'viento-chimenea':'Corriente de aire ascendente por tubo, sonido hueco',
  'hojas-viento':'Hojas en movimiento, espectro brillante y cambiante',
  'silbido-grietas':'Viento filtrándose por rendijas, tono afinado inquietante',
  'eco-cueva':'Resonancia grave en espacio cavernoso y húmedo',
  'chimenea':'Crepitar de leña, ruido marrón con modulación de llama',
  'vela':'Chisporroteo fino de llama pequeña, muy íntimo',
  'hoguera':'Fuego al aire libre, más voluminoso y variable que la chimenea',
  'brasas':'Fuego casi extinto, crujidos esporádicos y calor residual',
  'incendio-lejano':'Rumble grave de un gran incendio a distancia',
  'pajaros-amanecer':'Coros de pájaros al amanecer, ritmo orgánico e irregular',
  'grillos-nocturnos':'Canto continuo de grillos, oscilador de onda cuadrada modulada',
  'buho-lejano':'Llamadas esporádicas de búho, espaciado irregular',
  'ranas':'Anfibios nocturnos, frecuencia grave con cadencia irregular',
  'ramas-crujido':'Madera viva bajo tensión, crujidos de frecuencia baja',
  'hojas-pisadas':'Hojas secas bajo los pies, textura crujiente densa',
  'insectos-dia':'Zumbido colectivo de insectos diurnos, alta frecuencia',
  'viento-arboles':'Viento filtrado por follaje, timbre más suave que viento directo',
  'reloj-pared':'Mecanismo de reloj, tick regular y limpio',
  'paginas':'Hojas de papel pasándose, textura seca y ligera',
  'pasos-madera':'Pasos sobre tablones, impacto grave con resonancia',
  'pasos-piedra':'Pasos sobre piedra, más secos y sin resonancia',
  'puerta-crujido':'Bisagras en movimiento, frecuencia media variable',
  'escaleras-lejanas':'Pasos en otro piso, muy atenuados y espaciados',
  'radiador':'Golpes metálicos del radiador al calentarse',
  'pluma-papel':'Roce de pluma sobre papel, textura muy sutil',
  'maquina-escribir':'Teclas mecánicas con cadencia de mecanógrafo',
  'zumbido-electrico':'Zumbido de red eléctrica a 60 Hz, constante',
  'trafico-lejano':'Flujo de tráfico urbano a distancia, textura densa',
  'murmullo-gente':'Conversaciones simultáneas, masa vocal procesada',
  'cafe-bullicioso':'Ambiente de cafetería, mezcla de voces y objetos',
  'metro-subterraneo':'Rumble grave de metro, vibraciones de túnel',
  'sirena-distante':'Sirena de emergencias alejándose, efecto Doppler sintético',
  'campanada-iglesia':'Campana con resonancia larga y armónicos reales',
  'mercado-exterior':'Bullicio de mercado, crowd procesado y dinámico',
  'taberna-medieval':'Posada con voces, madera y fuego de fondo',
  'plaza-atardecer':'Espacio urbano tranquilo al final del día',
  'violin-lejano':'Cuerdas a distancia, drone de múltiples osciladores',
  'organo-iglesia':'Registro bajo de órgano de tubos, muy resonante',
  'acordeon-distante':'Acordeón filtrado por distancia, armónicos comprimidos',
  'drone-tension':'Tritono A-Eb: el diabolus in musica, el intervalo más tenso de la física acústica',
  'drones-misterio':'Masa de graves misteriosos, múltiples capas desintonizadas',
  'coros-lejanos':'Voces corales a distancia, pad de osciladores suave',
  'campanas-viento':'Campanillas metálicas, chimes generados por síntesis',
  'tambor-tribal':'Percusión de cuero grave, patrón rítmico irregular',
  'goteo-caverna':'Gotas en espacio subterráneo, reverb natural larga',
  'eco-profundo':'Reverb extrema en caverna profunda, casi sin señal seca',
  'crujido-madera':'Madera estructural bajo tensión, frecuencia media-baja',
  'pasos-barro':'Pasos en terreno húmedo, sonido sordo y viscoso',
  'respiracion':'Respiración distante, casi inaudible y perturbadora',
  'metal-arrastre':'Metal pesado sobre suelo de piedra, muy grave',
  'silencio-pesado':'El silencio tiene textura: ruido muy bajo y opresivo',
  'voz-ininteligible':'Articulación sin palabras, formantes procesados',
  'zumbido-cosmico':'Resonancias de frecuencias primas bajas, escala galáctica',
  'frecuencias-bajas':'Bajas puras, infrasonido audibilizado como modulador',
  'viento-sintetico':'Viento generado por síntesis, no por ruido filtrado',
  'pulso-cardiaco':'Latido cardíaco sintetizado, entre 60-90 BPM',
  'eco-vacio':'Reverb en espacio sin referencias, desorientador',
  'cristales-tintinean':'Cristal tintineando, chimes de alta frecuencia',
  'mar-abierto':'Mar abierto con oleaje largo y grave',
  'madera-barco':'Casco de madera bajo tensión, crujidos estructurales',
  'velas-viento':'Lonas de vela agitadas, viento filtrado por tela',
  'gaviotas':'Graznidos de gaviota, síntesis de aves marinas',
  'cuadernas-crujido':'Estructura naval bajo presión del agua',
  'mar-tempestad':'Mar en tempestad, oleaje violento y caótico',
  'pulso-carpenter':'Arpegio minimalista de sintetizador, 5 notas en bucle',
  'arpegio-sintetico':'Arpegio hipnótico de onda cuadrada filtrada',
  'bajo-pulsante':'Bajo analógico pulsante con filtro resonante',
  'pad-tension':'Pad disonante de cluster de semitonos',
  'pad-creciente':'Tensión creciente, clusters más densos',
  'caja-musica':'Caja de música con armónicos naturales',
  'caja-musica-rota':'Caja de música ligeramente desafinada, inquietante',
  'clavecin-espectral':'Clavecín de onda cuadrada con bandpass, prog italiano',
  'clavecin-goblin':'F# disminuido + tritono — el cluster de Goblin para Suspiria: F# A C D# F#',
  'drone-suspiria':'Drone embrujado, intervalos imposibles de resolver',
  'coro-susurros':'Susurros corales procesados, ruido filtrado modulado',
  'stinger-cuerdas':'Golpe agudo de cuerdas, cluster de sawtooths',
  'glissando-ascendente':'Ilusión de Risset: tono que sube infinitamente',
  'glissando-descendente':'Ilusión de Risset: tono que desciende sin fin',
  'cuerdas-tremolo':'Sul ponticello, trémolo de cuerdas tipo Herrmann',
  'tension-cuerdas':'Cuerdas de tensión, ratios disonantes sostenidos',
  'zumbido-agudo':'5200 Hz modulado, el tinnitus de la ansiedad',
  'bordon-creciente':'Bordón grave que crece lentamente con LFO de sierra',
  'metales-disonantes':'Cluster de metales en semitonos 0,1,6,7',
  'braam-trailer':'El BWAAM de tráiler, filtro que abre en 2 segundos',
  'tambor-profundo':'Bombo sintetizado con descenso de frecuencia rápido',
  'redoble-creciente':'Ruido marrón modulado en cuadrada, redoble de timbal',
  'corazon-acelerado':'Latido doble entre 60-140 BPM según ritmo',
  'respiracion-jadeo':'Respiración entrecortada, ciclo de 0.2-0.6 Hz',
  'aranazos':'Arañazos sobre superficie, bandpass de alta frecuencia',
  'zumbido-moscas':'Moscas: oscilador de diente de sierra con LFO rápido',
  'risa-infantil':'Risa sintética de múltiples pulsos ascendentes',
  'crujido-huesos':'Crujido orgánico, ruido blanco con resonancia aguda',
  'piano-preparado':'Piano con objetos sobre las cuerdas, armónicos alterados',
  'theremin-fantasmal':'Theremín: sinusoide con vibrato lento y LFO de frecuencia',
  'violin-chirriante':'Arco sobre cuerda con presión excesiva, chirriante',
  'cuerda-frotada':'Cuerda grave frotada, bordón bajo con trémolo lento',
  'campana-invertida':'Campana con envolvente invertida: ataque lento, decay nulo',
  'maquinaria-oxidada':'Motor de baja frecuencia con clank irregular',
  'cadena-arrastre':'Cadena metálica arrastrada, ruido con trémolo de cuadrada',
  'radio-interferencia':'Interferencia de radio AM, ruido blanco con modulación',
  'generador-fallando':'Generador inestable, oscilador con frecuencia variable',
  'transmision-perdida':'Señal de radio perdida, static puro',
  'secuencia-synthwave':'Secuencia de bajo synthwave, LFO de filtro resonante',
  'acorde-congelado':'Acorde disminuido sostenido indefinidamente',
  'barrido-filtro':'Barrido de filtro bandpass sobre ruido blanco',
  'arpegio-panico':'Arpegio ascendente de pánico, tempo creciente',
  'llamada-cthulhu':'El llamado cósmico: cluster de bajos con infrasonido de 19 Hz',
  'coros-rlyeh':'Coros de la ciudad sumergida, cuartos de tono disonantes',
  'latido-azathoth':'Pulso del caos, percusión en frecuencias primas aperiódicas',
  'senal-yuggoth':'Transmisión corrupta de los hongos de Yuggoth',
  'susurro-nyarla':'El mensajero: formantes vocales sin articulación',
  'profundidades-innsmouth':'El mar de Innsmouth y lo que hay debajo',
  'flautas-azathoth':'Las flautas idiotas del caos ciego, atonal',
  'shoggoth-masa':'La masa proteica en movimiento, borboteos y tekeli-li',
  'zumbido-mi-go':'Los hongos de Yuggoth, zumbido metálico de insecto enorme',
  'puertas-yog':'Yog-Sothoth: las puertas entre dimensiones, espectro completo',
  'abismo-dagon':'Presión extrema del fondo oceánico, algo moviéndose',
  'viento-hastur':'El viento amarillo de Hastur, nota incorrecta en el aire',
  'respiracion-dios':'Ciclo de 35 segundos, algo de tamaño inhumano respira',
  'eco-no-euclidiano':'Reflexiones que no siguen la física, ángulos imposibles',
  'infrasound-19hz':'19 Hz como modulador AM: sensación de presencia documentada',
  'binaural-alpha':'Diferencia de 10 Hz entre canales: estado alpha (relajación creativa)',
  'binaural-theta':'Diferencia de 6 Hz: estado theta (meditación profunda)',
  'binaural-delta':'Diferencia de 2 Hz: estado delta (sueño profundo)',
  'shepard-desc':'Escala cromática de Shepard: desciende infinitamente',
  'shepard-asc':'Escala cromática de Shepard: asciende infinitamente',
  'resonancia-schumann':'7.83 Hz: la frecuencia natural de la ionosfera terrestre',
  'escala-microtonal':'Maqam árabe Rast con cuartos de tono, sin resolución occidental',
  'escala-tonos-enteros':'Escala de tonos enteros (Debussy): flotación sin ancla tonal',
  'frecuencia-111hz':'111 Hz hallado en cámaras megalíticas, efecto frontal lóbulo',
  'formante-vacio':'Formantes vocales sin articulación, casi humano',
  'ronroneo-gato':'Sinusoide de 30 Hz con modulación de 0.35 Hz, reduce cortisol',
  'frecuencia-528hz':'528 Hz: MI de Solfeggio, ligeramente agudo del estándar',
  'onda-alpha':'Binaural a 10 Hz: relajación alerta y creatividad',
  'onda-theta':'Binaural a 6 Hz: meditación y estado hipnagógico',
  'quinta-perfecta':'Ratio 3:2, el intervalo más consonante de la física acústica',
  'serie-armonica':'Los primeros 8 armónicos de una fundamental: la física del placer',
  'cuenco-tibetano-396':'Cuenco en afinación justa a 396 Hz, parciales reales',
  'cuenco-tibetano-528':'Cuenco en afinación justa a 528 Hz, frecuencia Solfeggio',
  'tambor-chamanes':'270 BPM (4.5 Hz), frecuencia theta descubierta hace 40.000 años',
  'nada-brahma-om':'136.1 Hz: frecuencia orbital de la Tierra convertida a audio',
  'canto-ballenas':'Frases descendentes de ballena jorobada, 2-4 segundos cada una',
  'didgeridoo-drone':'73.4 Hz con respiración circular sintética, 40.000 años de historia',
  'acorde-resolucion':'Acorde de séptima mayor en afinación justa, resolución química',
  'canto-culto':'6 voces en unísono con microdetuning, canto de culto hipnótico',
  'tambores-ritual':'Alternancia de 5/4 y 7/8, métricas que impiden la predictibilidad',
  'canto-gregoriano-oscuro':'Modo frigio real desde E: E D C B A G F E — el half-step E→D característico del frigio',
  'glosolalia':'Habla en lenguas: formantes moduladas sin articulación reconocible',
  'om-corrompido':'Om a 139 Hz en lugar de 136.1 Hz, 3 Hz de desvío perturbador',
  'misa-negra':'Registros graves de órgano con LFO muy lento, inversión ritual',
  'derviche-giro':'Auto-wah giratorio, el filtro literalmente rota',
  'pantano-nocturno':'Agua estancada con mosquitos y ranas distantes',
  'circo-siniestro':'Música de circo a la mitad de velocidad, una octava abajo',
  'submarino-abismo':'Presión estructural con sonar ping cada 3-12 segundos',
  'biblioteca-prohibida':'Silencio de 47 Hz con páginas ocasionales y algo que observa',
  'iglesia-profanada':'Campanas desafinadas con armónicos irregulares y larga reverb',
  'laboratorio-doctor':'Arcos eléctricos de 60 Hz con modulación de zap rápida',
  'tren-nocturno':'Ritmo de vías a 240+ BPM con rush de viento exterior',
  'retroalimentacion':'Feedback controlado: bandpass resonante sobre sí mismo',
  'silencio-granular':'La textura del silencio real: ruido a 15 milisegundos',
  'espectro-invertido':'Formantes de voz invertidas: graves donde van agudos',
};

let activeCatFilter = null;

function buildCatFilterBar() {
  const bar = document.getElementById('cat-filter-bar');
  bar.innerHTML = '';
  const allChip = document.createElement('button');
  allChip.className = 'cat-chip on'; allChip.textContent = 'Todo';
  allChip.id = 'chip-all';
  allChip.onclick = () => setCatFilter(null);
  bar.appendChild(allChip);

  CATALOG.forEach(g => {
    const chip = document.createElement('button');
    chip.className = 'cat-chip';
    chip.textContent = g.cat.split(' ')[0]; // first word only
    chip.id = 'chip-' + g.cat;
    chip.title = g.cat;
    chip.onclick = () => setCatFilter(g.cat);
    bar.appendChild(chip);
  });
}

function setCatFilter(cat) {
  activeCatFilter = cat;
  document.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('on'));
  const target = cat ? document.getElementById('chip-' + cat) : document.getElementById('chip-all');
  if (target) target.classList.add('on');
  buildCatalog(document.getElementById('search-input').value);
}

function buildCatalog(filter = '') {
  const list = document.getElementById('catalog-list');
  list.innerHTML = '';
  const q = filter.toLowerCase();

  CATALOG.forEach(group => {
    if (activeCatFilter && group.cat !== activeCatFilter) return;
    const sounds = q ? group.sounds.filter(s => s.name.toLowerCase().includes(q) || s.tag.toLowerCase().includes(q) || group.cat.toLowerCase().includes(q)) : group.sounds;
    if (!sounds.length) return;

    const sec = document.createElement('div');
    sec.className = 'cat-section';
    sec.id = 'cat-sec-' + group.cat.replace(/\s/g,'_');

    const activeInCat = sounds.filter(s => layers.some(l => l.id === s.id)).length;
    sec.innerHTML = `<div class="cat-header" onclick="toggleCatCollapse(this.parentElement)">
      <div class="cat-header-dot" style="background:${group.color}"></div>
      <span class="cat-header-name" style="color:${group.color}aa">${group.cat}</span>
      ${activeInCat ? `<span class="cat-count">${activeInCat}✓</span>` : ''}
      <span class="cat-header-chevron">▾</span>
    </div>
    <div class="cat-sounds"></div>`;

    const soundsDiv = sec.querySelector('.cat-sounds');
    sounds.forEach(s => {
      const active = layers.some(l => l.id === s.id);
      const item = document.createElement('div');
      item.className = 'sound-item' + (active ? ' active' : '');
      item.dataset.id = s.id;
      item.onclick = () => toggleSound(s.id);
      const tooltip = SOUND_TOOLTIPS[s.id] || '';
      item.innerHTML = `
        <div class="s-dot" style="background:${active ? group.color : ''}"></div>
        <span class="s-name">${s.name}</span>
        <span class="s-tag">${s.tag}</span>
        <button class="s-preview" data-id="${s.id}" title="Previsualizar 3s">▶</button>
        ${tooltip ? `<span class="s-tooltip">${tooltip}</span>` : ''}
      `;
      const prevBtn = item.querySelector('.s-preview');
      prevBtn.addEventListener('click', (e) => previewSound(s.id, prevBtn, e));
      soundsDiv.appendChild(item);
    });
    list.appendChild(sec);
  });
}

function toggleCatCollapse(sec) {
  sec.classList.toggle('collapsed');
}

function filterCatalog(q) {
  buildCatalog(q);
}

// ─── LAYER CARD RENDER ───────────────────────────────────────────────────────
function renderLayers() {
  const area = document.getElementById('layers-area');
  area.innerHTML = '';

  if (!layers.length) {
    area.innerHTML = `<div class="empty-stage">
      <div class="big-char">♭</div>
      <p>Elige sonidos del catálogo para construir la atmósfera de tu escena. Empieza con uno — ya verás adónde lleva.</p>
    </div>`;
    document.getElementById('layer-count').textContent = '0 capas';
    updateIntensity(); drawEmoAxis();
    return;
  }

  layers.forEach(l => {
    const corruptVal = l.corruption || 0;
    const isCorrupted = corruptVal > 20;
    const div = document.createElement('div');
    div.className = 'layer-card' + (l.muted ? ' muted' : '') + (isCorrupted ? ' corrupted' : '');
    div.id = 'lc-' + l.id;
    div.style.setProperty('--layer-color', l.color);
    div.innerHTML = `
      <div class="layer-head">
        <span class="layer-title" title="${l.name}">${l.name}</span>
        <span class="layer-tag">${l.tag}</span>
        <div class="layer-btns">
          <button class="lb ${l.muted ? 'on-danger' : ''}" id="mb-${l.id}" onclick="toggleMute('${l.id}')" title="Silenciar/activar">${l.muted ? svgVolOff() : svgVol()}</button>
          <button class="lb" onclick="removeLayer('${l.id}')" title="Eliminar capa">${svgX()}</button>
        </div>
      </div>
      <div class="layer-sliders">
        <div class="sl">
          <span class="sl-lbl">Nivel</span>
          <input type="range" min="0" max="100" value="${l.vol}" step="1"
            style="accent-color:${l.color}"
            oninput="updateLayer('${l.id}','vol',+this.value);document.getElementById('vlv-${l.id}').textContent=this.value">
          <span class="sl-val" id="vlv-${l.id}">${l.vol}</span>
        </div>
        <div class="sl">
          <span class="sl-lbl">Ritmo</span>
          <input type="range" min="0" max="60" value="${l.rate}" step="1"
            style="accent-color:${l.color}"
            oninput="updateLayer('${l.id}','rate',+this.value);document.getElementById('rte-${l.id}').textContent=this.value">
          <span class="sl-val" id="rte-${l.id}">${l.rate}</span>
        </div>
        <div class="sl corrupt">
          <span class="sl-lbl">Sombra</span>
          <input type="range" min="0" max="100" value="${corruptVal}" step="1"
            oninput="setCorruption('${l.id}',+this.value);document.getElementById('crp-${l.id}').textContent=this.value;document.getElementById('lc-${l.id}').classList.toggle('corrupted',+this.value>20)">
          <span class="sl-val" id="crp-${l.id}" style="color:${corruptVal>20?'var(--danger)':'var(--text3)'}">${corruptVal}</span>
        </div>
      </div>
      <div class="waveform" id="wave-${l.id}"></div>
    `;
    area.appendChild(div);
    buildWave(l);
  });

  const active = layers.filter(l => !l.muted).length;
  document.getElementById('layer-count').textContent = `${layers.length} capa${layers.length !== 1 ? 's' : ''} · ${active} activa${active !== 1 ? 's' : ''}`;
  updateIntensity();
  drawEmoAxis();
}

function buildWave(l) {
  const w = document.getElementById('wave-' + l.id);
  if (!w) return;
  w.innerHTML = '';
  for (let i = 0; i < 40; i++) {
    const b = document.createElement('div');
    b.className = 'wv-bar';
    b.style.cssText = `height:2px;background:${l.color};opacity:0.2;`;
    w.appendChild(b);
  }
}

// ─── PRESETS BAR ─────────────────────────────────────────────────────────────
function buildPresetsBar() {
  const bar = document.getElementById('presets-bar');
  if (!bar) return;
  bar.innerHTML = '<span class="presets-bar-label">Escenas</span>';
  Object.keys(PRESETS).forEach(name => {
    const btn = document.createElement('button');
    btn.className = 'preset-chip'; btn.id = 'pc-' + name;
    btn.textContent = name;
    btn.onclick = () => loadPreset(name);
    const intent = PRESET_INTENT[name];
    if (intent) btn.title = intent;
    bar.appendChild(btn);
  });
  buildPresetsMobile();
}

function buildPresetsMobile() {
  const bar = document.getElementById('presets-bar-mobile');
  if (!bar) return;
  bar.innerHTML = '';
  Object.keys(PRESETS).forEach(name => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn preset-chip mobile-preset-chip';
    btn.dataset.preset = name;
    const label = document.createElement('span');
    label.textContent = name;
    btn.appendChild(label);
    const intent = PRESET_INTENT[name];
    if (intent) {
      btn.title = intent;
      const small = document.createElement('small');
      small.textContent = intent;
      btn.appendChild(small);
    }
    btn.onclick = () => {
      const loaded = loadPreset(name);
      if (loaded !== false) closeMobilePanels();
    };
    bar.appendChild(btn);
  });
}

// loadPreset defined later with confirmation guard

// ─── SCENE MANAGEMENT ────────────────────────────────────────────────────────
function saveScene() {
  const nameEl = document.getElementById('scene-name');
  const name = cleanText(nameEl.value, 'Sin nombre', 80);
  nameEl.value = name;
  const scene = sanitizeSceneInput({
    name,
    layers: layers.map(l => ({ id: l.id, vol: l.vol, rate: l.rate, muted: l.muted, corruption: l.corruption || 0 })),
    notes: document.getElementById('notes-area').value,
    moods: [...activeMoods],
    master: document.getElementById('master-slider').value,
    reverb: document.getElementById('reverb-slider').value,
    lp: document.getElementById('lp-slider').value,
    hp: document.getElementById('hp-slider').value,
    profile: currentMasterProfile,
    savedAt: Date.now()
  }, name);
  savedScenes[scene.name] = scene;
  saveStorageScenes();
  renderSavedScenes();
  updateCrossfadeTargets();
  saveHistory({ name: scene.name, layerCount: scene.layers.length });
  showToast(`"${scene.name}" guardada`);
}

function applyLayerState(savedLayer) {
  addLayer(savedLayer.id, savedLayer.vol, savedLayer.rate);
  const layer = layers.find(x => x.id === savedLayer.id);
  if (!layer) return;
  layer.muted = !!savedLayer.muted;
  layer.corruption = savedLayer.corruption || 0;
  if (layer.muted && audioNodes[layer.id]) audioNodes[layer.id].out.gain.value = 0;
}

function loadSavedScene(name) {
  const raw = savedScenes[name];
  if (!raw) return;
  const sc = sanitizeSceneInput(raw, name);
  savedScenes[sc.name] = sc;
  clearAll();
  document.getElementById('scene-name').value = sc.name;
  document.getElementById('notes-area').value = sc.notes || '';
  activeMoods = new Set(sc.moods || []);
  renderMoods();
  if (sc.master != null) { document.getElementById('master-slider').value = sc.master; setMaster(sc.master); document.getElementById('master-val').textContent = sc.master; }
  if (sc.reverb != null) { document.getElementById('reverb-slider').value = sc.reverb; setReverb(sc.reverb); }
  if (sc.lp != null) { document.getElementById('lp-slider').value = sc.lp; setLowpass(sc.lp); }
  if (sc.hp != null) { document.getElementById('hp-slider').value = sc.hp; setHighpass(sc.hp); }
  currentMasterProfile = sc.profile || currentMasterProfile;
  updateMasterProfileButtons();
  sc.layers.forEach(applyLayerState);
  renderLayers(); syncSidebar(); updateIntensity(); saveStorageScenes();
  showToast(`"${sc.name}" cargada`);
}

function deleteSavedScene(name) {
  delete savedScenes[name];
  saveStorageScenes();
  renderSavedScenes();
  updateCrossfadeTargets();
}

function renderSavedScenes() {
  const list = document.getElementById('saved-list');
  const empty = document.getElementById('saved-empty');
  const count = Object.keys(savedScenes).length;
  document.getElementById('saved-count').textContent = `(${count})`;
  if (list) list.innerHTML = '';
  if (!count) { if (empty) empty.style.display = 'block'; renderSavedScenesMobile(); return; }
  if (empty) empty.style.display = 'none';
  if (!list) return;
  Object.values(savedScenes).sort((a,b) => (b.savedAt||0)-(a.savedAt||0)).forEach(scRaw => {
    const sc = sanitizeSceneInput(scRaw, scRaw.name || 'Sin nombre');
    const item = document.createElement('div');
    item.className = 'saved-scene-item';
    item.onclick = () => loadSavedScene(sc.name);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'saved-scene-name';
    nameSpan.title = sc.name;
    nameSpan.textContent = sc.name;

    const countSpan = document.createElement('span');
    countSpan.className = 'saved-scene-count';
    countSpan.textContent = sc.layers.length;

    const del = document.createElement('button');
    del.className = 'lb';
    del.title = 'Borrar';
    del.innerHTML = svgX();
    del.addEventListener('click', event => { event.stopPropagation(); deleteSavedScene(sc.name); });

    item.append(nameSpan, countSpan, del);
    list.appendChild(item);
  });
  renderSavedScenesMobile();
}

// ─── HISTORY ─────────────────────────────────────────────────────────────────
let sessionHistory = (function() {
  try {
    const parsed = JSON.parse(localStorage.getItem('nocturne-history') || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
  } catch(e) { return []; }
})();

function saveHistory(entry) {
  sessionHistory.unshift({ ...entry, ts: Date.now() });
  sessionHistory = sessionHistory.slice(0, 8);
  localStorage.setItem('nocturne-history', JSON.stringify(sessionHistory));
  renderHistory();
}

function renderHistory() {
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  if (!sessionHistory.length) { empty.style.display = 'block'; list.innerHTML = ''; return; }
  empty.style.display = 'none';
  list.innerHTML = '';
  sessionHistory.forEach(h => {
    const d = new Date(h.ts);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const item = document.createElement('div');
    item.className = 'saved-scene-item';
    item.addEventListener('click', () => loadHistoryEntry(h.ts));

    const nameSpan = document.createElement('span');
    nameSpan.className = 'saved-scene-name';
    nameSpan.textContent = cleanText(h.name, 'Sin nombre', 80);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'saved-scene-count';
    timeSpan.style.fontSize = '9px';
    timeSpan.textContent = time;

    item.append(nameSpan, timeSpan);
    list.appendChild(item);
  });
}
function loadHistoryEntry(ts) {
  const entry = sessionHistory.find(h => h.ts === ts);
  if (entry && savedScenes[entry.name]) loadSavedScene(entry.name);
  else showToast('Escena no encontrada en guardados');
}

// ─── CROSSFADE ────────────────────────────────────────────────────────────────
function updateCrossfadeTargetsBase() {
  const sel = document.getElementById('crossfade-target');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— selecciona escena destino —</option>';
  Object.keys(savedScenes).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    if (name === current) opt.selected = true;
    sel.appendChild(opt);
  });
}

function startCrossfade() {
  const targetName = document.getElementById('crossfade-target').value;
  const dur = +document.getElementById('crossfade-dur').value * 1000;
  if (!targetName || !savedScenes[targetName]) { showToast('Selecciona una escena destino'); return; }
  const target = savedScenes[targetName];
  const startVols = {};
  layers.forEach(l => startVols[l.id] = l.vol);
  const t0 = performance.now();
  if (!playing) togglePlay();

  function step() {
    const progress = Math.min(1, (performance.now() - t0) / dur);
    // fade out current
    layers.forEach(l => {
      const newVol = Math.round(startVols[l.id] * (1 - progress));
      l.vol = newVol;
      if (audioNodes[l.id] && !l.muted) audioNodes[l.id].out.gain.value = newVol / 100;
    });
    if (progress < 1) { requestAnimationFrame(step); return; }
    // load target
    clearAll();
    document.getElementById('scene-name').value = target.name;
    target.layers.forEach(l => addLayer(l.id, 0, l.rate));
    renderLayers(); syncSidebar();
    // fade in
    const t1 = performance.now();
    function fadeIn() {
      const p = Math.min(1, (performance.now() - t1) / (dur * 0.7));
      layers.forEach((l, i) => {
        const targetVol = target.layers[i]?.vol || 50;
        l.vol = Math.round(targetVol * p);
        if (audioNodes[l.id] && !l.muted) audioNodes[l.id].out.gain.value = l.vol / 100;
      });
      if (p < 1) requestAnimationFrame(fadeIn);
      else showToast(`Transición a "${target.name}" completada`);
    }
    fadeIn();
  }
  requestAnimationFrame(step);
  showToast(`Crossfade hacia "${targetName}" iniciado…`);
}

// ─── RANDOMIZER ──────────────────────────────────────────────────────────────
function randomizeScene() {
  const activeMoodArr = [...activeMoods];
  clearAll();

  // Pick a coherent mood zone from EMO_MAP
  const tx = 0.2 + Math.random() * 0.8;
  const ty = 0.2 + Math.random() * 0.8;

  // Score all sounds by proximity to random point
  const scored = Object.entries(EMO_MAP)
    .map(([id, [sx, sy]]) => ({ id, dist: Math.sqrt((sx-tx)**2 + (sy-ty)**2) }))
    .sort((a, b) => a.dist - b.dist);

  const count = 4 + Math.floor(Math.random() * 4);
  // Take from top 12, randomly shuffle to avoid always picking the same
  const pool = scored.slice(0, 12);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picks = pool.slice(0, count);

  picks.forEach(({ id }) => {
    const vol = 25 + Math.floor(Math.random() * 50);
    const rate = 5 + Math.floor(Math.random() * 40);
    addLayer(id, vol, rate);
  });

  const tonos = ['oscura', 'tensa', 'misteriosa', 'etérea', 'cósmica', 'íntima'];
  const name = 'Escena ' + tonos[Math.floor(Math.random() * tonos.length)];
  document.getElementById('scene-name').value = name;
  renderLayers(); syncSidebar(); updateIntensity();
  showToast('Escena aleatoria generada');
}

// ─── EXPORT / IMPORT ─────────────────────────────────────────────────────────
function exportScene() {
  const data = {
    name: document.getElementById('scene-name').value,
    layers: layers.map(l => ({ id: l.id, vol: l.vol, rate: l.rate, muted: l.muted, corruption: l.corruption || 0 })),
    notes: document.getElementById('notes-area').value,
    moods: [...activeMoods],
    master: document.getElementById('master-slider').value,
    reverb: document.getElementById('reverb-slider').value,
    lp: document.getElementById('lp-slider').value,
    hp: document.getElementById('hp-slider').value,
    profile: currentMasterProfile,
    savedScenes,
    version: '4.7-mobile-tablet'
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (data.name || 'escena').replace(/\s+/g, '-').toLowerCase() + '.json';
  a.click();
  showToast('Escena exportada');
}

// importScene defined later with proper catch(err)

// ─── BIBLIOTECA: EXPORT / IMPORT ─────────────────────────────────────────────

function exportLibrary() {
  const count = Object.keys(savedScenes).length;
  if (!count) { showToast('No hay escenas guardadas que exportar'); return; }

  const data = {
    _nocturne: true,
    _type: 'library',
    _version: '1.0',
    _exportedAt: new Date().toISOString(),
    _count: count,
    scenes: savedScenes
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const dateStr = new Date().toISOString().slice(0,10);
  a.download = `nocturne-biblioteca-${dateStr}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`${count} escena${count !== 1 ? 's' : ''} exportada${count !== 1 ? 's' : ''}`);
}

function importLibrary(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);

      // Detectar si es biblioteca o escena individual
      let incoming = {};
      if (data._nocturne && data._type === 'library' && data.scenes) {
        incoming = data.scenes;
      } else if (data.name && data.layers) {
        // Es una escena individual — importarla como entrada única
        incoming[data.name] = {
          name: data.name,
          layers: data.layers || [],
          notes: data.notes || '',
          moods: data.moods || [],
          reverb: data.reverb,
          lp: data.lp,
          hp: data.hp,
          savedAt: data.savedAt || Date.now()
        };
      } else if (typeof data === 'object' && !Array.isArray(data)) {
        // Puede ser un objeto de escenas sin wrapper
        const firstVal = Object.values(data)[0];
        if (firstVal && firstVal.layers) incoming = data;
      }

      incoming = sanitizeSceneLibrary(incoming);
      const importCount = Object.keys(incoming).length;
      if (!importCount) { showToast('Archivo no reconocido'); return; }

      // Fusionar: las escenas importadas NO sobreescriben las existentes con el mismo nombre
      // salvo que sean más recientes
      let added = 0, updated = 0;
      Object.values(incoming).forEach(scene => {
        const existing = savedScenes[scene.name];
        if (!existing) {
          savedScenes[scene.name] = scene;
          added++;
        } else if ((scene.savedAt || 0) > (existing.savedAt || 0)) {
          savedScenes[scene.name] = scene;
          updated++;
        }
      });

      saveStorageScenes();
      renderSavedScenes();
      updateCrossfadeTargets();

      const msg = added && updated ? `+${added} nuevas, ${updated} actualizadas`
                : added ? `${added} escena${added !== 1 ? 's' : ''} importada${added !== 1 ? 's' : ''}`
                : updated ? `${updated} escena${updated !== 1 ? 's' : ''} actualizada${updated !== 1 ? 's' : ''}`
                : 'Ya tenías todas estas escenas';
      showToast(msg);
    } catch(err) {
      showToast('Error al leer el archivo');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ─── MODO CAPÍTULO ────────────────────────────────────────────────────────────

let chapterSteps = [];       // [{sceneName, duration}]  duration en minutos
let chapterActive = false;
let chapterStepIndex = 0;
let chapterStepTimer = null;
let chapterProgressTimer = null;
let chapterStepStart = 0;

function addChapterStep() {
  const sceneNames = Object.keys(savedScenes);
  if (!sceneNames.length) {
    showToast('Guarda al menos una escena primero');
    return;
  }
  chapterSteps.push({ sceneName: sceneNames[0], duration: 10 });
  renderChapterSteps();
}

function removeChapterStep(idx) {
  chapterSteps.splice(idx, 1);
  renderChapterSteps();
}

function clearChapter() {
  stopChapter();
  chapterSteps = [];
  renderChapterSteps();
}

function renderChapterSteps() {
  const container = document.getElementById('chapter-steps');
  if (!container) return;
  container.innerHTML = '';

  const sceneNames = Object.keys(savedScenes);

  if (!chapterSteps.length) {
    container.innerHTML = `<div style="font-size:10px;color:var(--text3);text-align:center;padding:8px 0">
      Añade escenas para construir el arco de tu capítulo
    </div>`;
    return;
  }

  chapterSteps.forEach((step, i) => {
    const div = document.createElement('div');
    div.className = 'chapter-step' + (chapterActive && i === chapterStepIndex ? ' active-step' : '');
    div.id = 'cs-' + i;

    // Scene selector
    const opts = sceneNames.map(n =>
      `<option value="${n}" ${n === step.sceneName ? 'selected' : ''}>${n}</option>`
    ).join('');

    div.innerHTML = `
      <span class="chapter-step-num">${i + 1}</span>
      <select onchange="chapterSteps[${i}].sceneName=this.value">${opts}</select>
      <input class="chapter-step-dur" type="number" min="1" max="180" value="${step.duration}"
        onchange="chapterSteps[${i}].duration=Math.max(1,+this.value);this.value=chapterSteps[${i}].duration">
      <span class="chapter-step-unit">min</span>
      <button class="lb" onclick="removeChapterStep(${i})" title="Eliminar paso">${svgX()}</button>
    `;
    container.appendChild(div);
  });

  // Total duration
  const total = chapterSteps.reduce((s, x) => s + x.duration, 0);
  const totalEl = document.createElement('div');
  totalEl.style.cssText = 'font-size:9px;color:var(--text3);text-align:right;padding-top:2px';
  totalEl.textContent = `Total: ${total} min`;
  container.appendChild(totalEl);
}

function toggleChapter() {
  chapterActive ? stopChapter() : startChapter();
}

function startChapter() {
  if (!chapterSteps.length) { showToast('Añade escenas al capítulo primero'); return; }

  // Validate all scenes exist
  const missing = chapterSteps.find(s => !savedScenes[s.sceneName]);
  if (missing) { showToast(`Escena "${missing.sceneName}" no encontrada`); return; }

  if (!playing) togglePlay();

  chapterActive = true;
  chapterStepIndex = 0;
  document.getElementById('chapter-play-btn').textContent = '■ Detener capítulo';
  document.getElementById('chapter-play-btn').classList.add('active');
  document.getElementById('chapter-progress').style.display = 'block';
  document.getElementById('chapter-total-label').textContent = chapterSteps.length;

  executeChapterStep(0);
}

function executeChapterStep(idx) {
  if (!chapterActive || idx >= chapterSteps.length) {
    stopChapter();
    showToast('Capítulo completado', 4000);
    return;
  }

  chapterStepIndex = idx;
  const step = chapterSteps[idx];
  const durationMs = step.duration * 60 * 1000;

  // Update UI
  renderChapterSteps();
  document.getElementById('chapter-step-label').textContent = idx + 1;
  document.getElementById('chapter-scene-label').textContent = step.sceneName;
  document.getElementById('chapter-progress-bar').style.width = '0%';

  // Load scene
  loadSavedScene(step.sceneName);
  showToast(`Capítulo · Escena ${idx + 1}/${chapterSteps.length}: ${step.sceneName}`, 3500);

  // Progress bar animation
  chapterStepStart = performance.now();
  clearInterval(chapterProgressTimer);
  chapterProgressTimer = setInterval(() => {
    if (!chapterActive) { clearInterval(chapterProgressTimer); return; }
    const elapsed = performance.now() - chapterStepStart;
    const pct = Math.min(100, (elapsed / durationMs) * 100);
    const bar = document.getElementById('chapter-progress-bar');
    if (bar) bar.style.width = pct + '%';
  }, 500);

  // Schedule next step
  clearTimeout(chapterStepTimer);

  // Crossfade 8s before end if there's a next step
  const crossfadeDur = Math.min(8000, durationMs * 0.15);
  const nextStepDelay = durationMs - crossfadeDur;

  if (idx + 1 < chapterSteps.length) {
    chapterStepTimer = setTimeout(() => {
      if (!chapterActive) return;
      // Fade out current scene
      const startVols = {};
      layers.forEach(l => startVols[l.id] = l.vol);
      const t0 = performance.now();

      function fadeOut() {
        if (!chapterActive) return;
        const p = Math.min(1, (performance.now() - t0) / crossfadeDur);
        layers.forEach(l => {
          const v = Math.round(startVols[l.id] * (1 - p));
          l.vol = v;
          if (audioNodes[l.id] && !l.muted) audioNodes[l.id].out.gain.value = v / 100;
        });
        if (p < 1) requestAnimationFrame(fadeOut);
        else executeChapterStep(idx + 1);
      }
      requestAnimationFrame(fadeOut);
    }, nextStepDelay);
  } else {
    // Last step — just wait full duration then stop
    chapterStepTimer = setTimeout(() => {
      stopChapter();
      showToast('Capítulo completado', 4000);
    }, durationMs);
  }
}

function stopChapter() {
  chapterActive = false;
  clearTimeout(chapterStepTimer);
  clearInterval(chapterProgressTimer);
  chapterStepIndex = 0;

  const btn = document.getElementById('chapter-play-btn');
  if (btn) { btn.textContent = '▶ Ejecutar capítulo'; btn.classList.remove('active'); }
  const progress = document.getElementById('chapter-progress');
  if (progress) progress.style.display = 'none';

  renderChapterSteps();
}

// Hook into updateCrossfadeTargets to also refresh chapter selects
function updateCrossfadeTargets() {
  updateCrossfadeTargetsBase();
  renderChapterSteps();
}
function syncSidebar() {
  const activeIds = new Set(layers.map(l => l.id));
  document.querySelectorAll('.sound-item').forEach(item => {
    const id = item.dataset.id;
    const active = activeIds.has(id);
    item.classList.toggle('active', active);
    const dot = item.querySelector('.s-dot');
    if (dot) {
      // find color from catalog
      const group = CATALOG.find(g => g.sounds.some(s => s.id === id));
      dot.style.background = active && group ? group.color : '';
    }
  });
  // refresh cat header counts
  CATALOG.forEach(group => {
    const sec = document.getElementById('cat-sec-' + group.cat.replace(/\s/g,'_'));
    if (!sec) return;
    const activeInCat = group.sounds.filter(s => activeIds.has(s.id)).length;
    const countEl = sec.querySelector('.cat-count');
    if (activeInCat && !countEl) {
      const h = sec.querySelector('.cat-header-name');
      if (h) { const span = document.createElement('span'); span.className = 'cat-count'; span.textContent = activeInCat + '✓'; h.after(span); }
    } else if (countEl) {
      countEl.textContent = activeInCat ? activeInCat + '✓' : '';
    }
  });
}

// ─── SVG ICONS ───────────────────────────────────────────────────────────────
function svgVol() { return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 6H1v4h2l4 3V3L3 6z"/><path d="M11 5a4 4 0 010 6"/></svg>'; }
function svgVolOff() { return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 6H1v4h2l4 3V3L3 6z"/><path d="M13 6l-4 4M9 6l4 4"/></svg>'; }
function svgX() { return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>'; }

// ─── MOODS ───────────────────────────────────────────────────────────────────
const MOODS = ['tensión','misterio','melancolía','peligro','romance','soledad','esperanza','terror','maravilla','acción','pérdida','descubrimiento','nostalgia','calma','urgencia','horror cósmico','éxtasis','desolación'];
let activeMoods = new Set();

function buildMoods() {
  const grid = document.getElementById('mood-grid');
  MOODS.forEach(m => {
    const btn = document.createElement('button');
    btn.className = 'mood-tag'; btn.textContent = m;
    btn.onclick = () => { activeMoods.has(m) ? activeMoods.delete(m) : activeMoods.add(m); btn.classList.toggle('on', activeMoods.has(m)); };
    grid.appendChild(btn);
  });
}

function renderMoods() {
  document.querySelectorAll('.mood-tag').forEach(btn => btn.classList.toggle('on', activeMoods.has(btn.textContent)));
}

// ─── TOAST & UTILS ───────────────────────────────────────────────────────────
function showToast(msg, duration) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), duration || 2600);
}

function findSoundDef(id) {
  for (const g of CATALOG) { const s = g.sounds.find(x => x.id === id); if (s) return { ...s, color: g.color }; }
  return null;
}

// ─── MOBILE PANELS ───────────────────────────────────────────────────────────

let activeMobilePanel = 'layers'; // 'catalog' | 'layers' | 'presets' | 'tools'

function openMobilePanel(name) {
  // If clicking the active one, close panels and show stage
  if (activeMobilePanel === name && name !== 'layers') {
    closeMobilePanels();
    return;
  }
  activeMobilePanel = name;

  // Update nav buttons
  document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
  const navBtn = document.getElementById('mnav-' + name);
  if (navBtn) navBtn.classList.add('active');

  // Close all panels
  document.querySelectorAll('.mobile-panel').forEach(p => p.classList.remove('open'));

  if (name === 'catalog') {
    const panel = document.getElementById('mpanel-catalog');
    if (panel) panel.classList.add('open');
    buildCatalogMobile();
  } else if (name === 'presets') {
    const panel = document.getElementById('mpanel-presets');
    if (panel) panel.classList.add('open');
    buildPresetsMobile();
  } else if (name === 'tools') {
    const panel = document.getElementById('mpanel-tools');
    if (panel) panel.classList.add('open');
    // Init mobile emo axis when tools panel opens
    setTimeout(initEmoAxisMobile, 60);
    // Sync saved scenes list
    renderSavedScenesMobile();
  }
  // 'layers' = default stage, no overlay panel
}

function closeMobilePanels() {
  activeMobilePanel = 'layers';
  document.querySelectorAll('.mobile-panel').forEach(p => p.classList.remove('open'));
  document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
  const layersNav = document.getElementById('mnav-layers');
  if (layersNav) layersNav.classList.add('active');
}

function switchMobileTab(id, btn) {
  document.querySelectorAll('#mpanel-tools .tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('#mpanel-tools .tab-btn').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById('mtab-' + id);
  if (panel) panel.classList.add('active');
  if (btn) btn.classList.add('active');
  if (id === 'mezcla') setTimeout(initEmoAxisMobile, 60);
}

function handleResponsiveNavigation() {
  if (!isMobileTabletUI()) closeMobilePanels();
  if (isMobileTabletUI()) {
    buildPresetsMobile();
    buildCatalogMobile(document.getElementById('search-input-mobile')?.value || '');
  }
}

window.addEventListener('resize', () => {
  clearTimeout(window.__nocturneResizeTimer);
  window.__nocturneResizeTimer = setTimeout(handleResponsiveNavigation, 120);
});

// ── Mobile Catalog (mirrors desktop catalog, same interaction) ──

let activeCatFilterMobile = null;

function buildCatalogMobile(filter = '') {
  const list = document.getElementById('catalog-list-mobile');
  if (!list) return;
  list.innerHTML = '';
  const q = filter.toLowerCase();

  // Build filter bar if empty
  const bar = document.getElementById('cat-filter-bar-mobile');
  if (bar && !bar.children.length) {
    const allChip = document.createElement('button');
    allChip.className = 'cat-chip on'; allChip.textContent = 'Todo';
    allChip.onclick = () => setCatFilterMobile(null);
    bar.appendChild(allChip);
    CATALOG.forEach(g => {
      const chip = document.createElement('button');
      chip.className = 'cat-chip';
      chip.textContent = g.cat.split(' ')[0];
      chip.title = g.cat;
      chip.onclick = () => setCatFilterMobile(g.cat);
      bar.appendChild(chip);
    });
  }

  CATALOG.forEach(group => {
    if (activeCatFilterMobile && group.cat !== activeCatFilterMobile) return;
    const sounds = q
      ? group.sounds.filter(s => s.name.toLowerCase().includes(q) || s.tag.toLowerCase().includes(q) || group.cat.toLowerCase().includes(q))
      : group.sounds;
    if (!sounds.length) return;

    const sec = document.createElement('div');
    sec.className = 'cat-section';
    const activeInCat = sounds.filter(s => layers.some(l => l.id === s.id)).length;
    sec.innerHTML = `<div class="cat-header" onclick="this.parentElement.classList.toggle('collapsed')">
      <div class="cat-header-dot" style="background:${group.color}"></div>
      <span class="cat-header-name" style="color:${group.color}aa">${group.cat}</span>
      ${activeInCat ? `<span class="cat-count">${activeInCat}✓</span>` : ''}
      <span class="cat-header-chevron">▾</span>
    </div>
    <div class="cat-sounds"></div>`;

    const soundsDiv = sec.querySelector('.cat-sounds');
    sounds.forEach(s => {
      const active = layers.some(l => l.id === s.id);
      const item = document.createElement('div');
      item.className = 'sound-item' + (active ? ' active' : '');
      item.dataset.id = s.id;
      item.onclick = () => {
        toggleSound(s.id);
        // Close catalog panel, go back to layers view
        closeMobilePanels();
      };
      item.innerHTML = `
        <div class="s-dot" style="background:${active ? group.color : ''}"></div>
        <span class="s-name">${s.name}</span>
        <span class="s-tag">${s.tag}</span>
        <button class="s-preview" data-id="${s.id}" title="Previsualizar 3s">▶</button>
      `;
      const prevBtn = item.querySelector('.s-preview');
      prevBtn.style.opacity = '1';
      prevBtn.style.pointerEvents = 'auto';
      prevBtn.addEventListener('click', (e) => previewSound(s.id, prevBtn, e));
      soundsDiv.appendChild(item);
    });
    list.appendChild(sec);
  });
}

function setCatFilterMobile(cat) {
  activeCatFilterMobile = cat;
  const bar = document.getElementById('cat-filter-bar-mobile');
  if (bar) bar.querySelectorAll('.cat-chip').forEach(c => {
    c.classList.toggle('on', cat ? c.title === cat : c.textContent === 'Todo');
  });
  buildCatalogMobile(document.getElementById('search-input-mobile')?.value || '');
}

function filterCatalogMobile(q) {
  buildCatalogMobile(q);
}

// ── Sync saved scenes to mobile panel ──
function renderSavedScenesMobile() {
  const list = document.getElementById('saved-list-m');
  const countEl = document.getElementById('saved-count-m');
  if (!list) return;
  const count = Object.keys(savedScenes).length;
  if (countEl) countEl.textContent = `(${count})`;
  list.innerHTML = '';
  if (!count) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--text3);text-align:center;padding:6px 0';
    empty.textContent = 'Ninguna guardada aún';
    list.appendChild(empty);
    return;
  }
  Object.values(savedScenes).sort((a,b) => (b.savedAt||0)-(a.savedAt||0)).forEach(scRaw => {
    const sc = sanitizeSceneInput(scRaw, scRaw.name || 'Sin nombre');
    const item = document.createElement('div');
    item.className = 'saved-scene-item';
    item.onclick = () => { loadSavedScene(sc.name); closeMobilePanels(); };

    const nameSpan = document.createElement('span');
    nameSpan.className = 'saved-scene-name';
    nameSpan.textContent = sc.name;

    const countSpan = document.createElement('span');
    countSpan.className = 'saved-scene-count';
    countSpan.textContent = sc.layers.length;

    const del = document.createElement('button');
    del.className = 'lb';
    del.title = 'Borrar';
    del.innerHTML = svgX();
    del.addEventListener('click', event => { event.stopPropagation(); deleteSavedScene(sc.name); renderSavedScenesMobile(); });

    item.append(nameSpan, countSpan, del);
    list.appendChild(item);
  });
}

// ── Sync paired sliders (desktop <-> mobile) ──
function syncSliderPair(desktopId, mobileId, val) {
  const d = document.getElementById(desktopId);
  const m = document.getElementById(mobileId);
  if (d && d.value !== String(val)) d.value = val;
  if (m && m.value !== String(val)) m.value = val;
}

// ── Mobile emotional axis ──
let emoMobileDragging = false;
function initEmoAxisMobile() {
  const canvas = document.getElementById('emo-canvas-m');
  if (!canvas) return;
  const size = canvas.parentElement.offsetWidth;
  if (size < 10) return;
  canvas.width = size; canvas.height = size;
  // Draw same state as desktop
  drawEmoAxisOnCanvas(canvas);

  canvas.addEventListener('mousedown', e => { emoMobileDragging = true; updateEmoFromEventM(canvas, e); });
  canvas.addEventListener('mousemove', e => { if (emoMobileDragging) updateEmoFromEventM(canvas, e); });
  canvas.addEventListener('mouseup', () => emoMobileDragging = false);
  canvas.addEventListener('touchstart', e => { emoMobileDragging = true; updateEmoFromEventM(canvas, e.touches[0]); e.preventDefault(); }, {passive:false});
  canvas.addEventListener('touchmove', e => { if (emoMobileDragging) updateEmoFromEventM(canvas, e.touches[0]); e.preventDefault(); }, {passive:false});
  canvas.addEventListener('touchend', () => emoMobileDragging = false);
}

function updateEmoFromEventM(canvas, e) {
  const r = canvas.getBoundingClientRect();
  emoX = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  emoY = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
  drawEmoAxis();
  drawEmoAxisOnCanvas(canvas);
}

function drawEmoAxisOnCanvas(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const grad = ctx.createRadialGradient(W*emoX, H*emoY, 0, W*emoX, H*emoY, Math.max(W,H)*0.8);
  grad.addColorStop(0, emoY > 0.5 ? `rgba(80,10,10,${0.4 + emoX*0.3})` : `rgba(10,60,10,${0.3 + (1-emoY)*0.3})`);
  grad.addColorStop(1, 'rgba(14,13,11,0.95)');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(W/2,0); ctx.lineTo(W/2,H); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke();
  Object.entries(EMO_MAP).forEach(([id, [tx, ty]]) => {
    const active = layers.some(l => l.id === id);
    ctx.beginPath(); ctx.arc(tx*W, ty*H, active ? 4 : 2, 0, Math.PI*2);
    ctx.fillStyle = active ? '#c8a96e' : 'rgba(255,255,255,0.15)'; ctx.fill();
  });
  const cx = emoX*W, cy = emoY*H;
  ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI*2);
  ctx.strokeStyle = '#c8a96e'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI*2);
  ctx.fillStyle = '#c8a96e'; ctx.fill();
}

// ─── RESIZE OBSERVER for emo canvas (Fix M4) ─────────────────────────────────
(function() {
  const wrap = document.getElementById('emo-canvas')?.parentElement;
  if (wrap && window.ResizeObserver) {
    new ResizeObserver(() => { initEmoAxis(); }).observe(wrap);
  }
})();

// ─── TIMER ALARM (Fix M6) ────────────────────────────────────────────────────
function timerAlarm() {
  try {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.28, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.4);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 1.5);
    // Second tone after 0.6s
    setTimeout(() => {
      if (!audioCtx) return;
      const o2 = audioCtx.createOscillator();
      const g2 = audioCtx.createGain();
      o2.type = 'sine'; o2.frequency.value = 1100;
      g2.gain.setValueAtTime(0.22, audioCtx.currentTime);
      g2.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.0);
      o2.connect(g2); g2.connect(audioCtx.destination);
      o2.start(); o2.stop(audioCtx.currentTime + 1.1);
    }, 600);
  } catch(e) {}
}

// ─── FIX I7: PRESET LOAD CONFIRMATION ────────────────────────────────────────
function startTimer() {
  timerRunning = true;
  document.getElementById('timer-toggle').textContent = '⏸ Pausar';
  document.getElementById('timer-display').classList.add('running');
  const mDisp = document.getElementById('timer-display-m');
  if (mDisp) mDisp.classList.add('running');
  timerInterval = setInterval(() => {
    if (timerSec === 0) {
      if (timerMin === 0) {
        stopTimer();
        showToast('⏰ Tiempo de escritura completado');
        timerAlarm();
        return;
      }
      timerMin--; timerSec = 59;
    } else { timerSec--; }
    renderTimer();
    // sync mobile display handled in renderTimer
  }, 1000);
}

function stopTimer() {
  timerRunning = false;
  clearInterval(timerInterval);
  document.getElementById('timer-toggle').textContent = '▶ Iniciar';
  document.getElementById('timer-display').classList.remove('running');
  const mDisp = document.getElementById('timer-display-m');
  if (mDisp) { mDisp.classList.remove('running'); mDisp.textContent = document.getElementById('timer-display').textContent; }
}

// ─── FIX I7: PRESET LOAD CONFIRMATION ────────────────────────────────────────
function loadPreset(name) {
  if (layers.length > 0) {
    if (!confirm(`¿Reemplazar la escena actual con "${name}"?`)) return false;
  }
  clearAll();
  const p = PRESETS[name];
  if (!p) return false;
  document.getElementById('scene-name').value = p.name;
  p.ids.forEach(({ id, vol, rate }) => addLayer(id, vol, rate));
  document.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('on'));
  const chip = document.getElementById('pc-' + name);
  if (chip) chip.classList.add('on');
  document.querySelectorAll('.mobile-preset-chip').forEach(c => c.classList.toggle('on', c.dataset.preset === name));
  renderLayers(); syncSidebar();
  const intent = PRESET_INTENT[name];
  if (intent) showToast(intent, 4000);
  return true;
}

// ─── FIX I6: catch(e) on importScene ────────────────────────────────────────
function importScene(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const rawData = JSON.parse(e.target.result);
      const data = sanitizeSceneInput(rawData);
      clearAll();
      document.getElementById('scene-name').value = data.name || '';
      document.getElementById('notes-area').value = data.notes || '';
      activeMoods = new Set(data.moods || []);
      renderMoods();
      const sliders = [
        ['master-slider','master-val',data.master,setMaster],
        ['reverb-slider','reverb-val',data.reverb,setReverb],
        ['lp-slider','lp-val',data.lp,setLowpass],
        ['hp-slider','hp-val',data.hp,setHighpass]
      ];
      sliders.forEach(([sid, vid, val, fn]) => {
        if (val != null) {
          document.getElementById(sid).value = val;
          const vEl = document.getElementById(vid);
          if (vEl) vEl.textContent = val;
          fn(val);
        }
      });
      currentMasterProfile = data.profile || currentMasterProfile;
      updateMasterProfileButtons();
      (data.layers || []).forEach(applyLayerState);
      if (rawData.savedScenes) {
        savedScenes = { ...savedScenes, ...sanitizeSceneLibrary(rawData.savedScenes) };
        saveStorageScenes();
      }
      renderSavedScenes(); renderSavedScenesMobile();
      renderLayers(); syncSidebar(); updateIntensity(); updateCrossfadeTargets();
      showToast('Escena importada correctamente');
    } catch(err) { showToast('Error al importar: JSON inválido'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// renderSavedScenes already syncs mobile inline

// ─── INIT ────────────────────────────────────────────────────────────────────
loadTheme();
loadVisualSkin();
renderSkinPicker();
loadMasterProfile();
buildCatFilterBar();
buildCatalog();
buildPresetsBar();
buildMoods();
renderHistory();
updateIntensity();
if (!loadFromURL()) {
  // Don't trigger confirm on initial load — override loadPreset temporarily
  const savedLayers = layers.length;
  layers = []; // ensure empty so no confirm fires
  loadPreset('Tormenta');
}
updateCrossfadeTargets();
renderSavedScenes();
setTimeout(() => { initEmoAxis(); checkOnboard(); }, 150);

// Demo card click selection
document.querySelectorAll('.onboard-demo-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    const radio = opt.querySelector('input[type="radio"]');
    if (radio) radio.checked = true;
  });
});

// Restore saved scenes panel counts
document.getElementById('saved-count').textContent = `(${Object.keys(savedScenes).length})`;

// Master slider webkit fix
const ms = document.getElementById('master-slider');
if (ms) ms.style.cssText += ';-webkit-appearance:none;cursor:pointer';

// Mobile nav: set initial active state
document.getElementById('mnav-layers')?.classList.add('active');

// PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
