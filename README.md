<div align="center">

# Nocturne Studio v4.8

**Procedural sound architecture for writers, storytellers and worldbuilders**

*173 sounds · 22 categories · per-layer audio polish · master profiles · optional local samples · 8 cinematic skins · zero runtime dependencies*

[![MIT License](https://img.shields.io/badge/license-MIT-c8a96e?style=flat-square)](LICENSE)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-5a9e6f?style=flat-square)]()
[![Static app](https://img.shields.io/badge/static%20app-GitHub%20Pages%20ready-534AB7?style=flat-square)]()
[![Sounds](https://img.shields.io/badge/sounds-173-A32D2D?style=flat-square)]()
[![PWA](https://img.shields.io/badge/PWA-offline%20ready-185FA5?style=flat-square)]()

[**→ Open Studio**](https://ivanroig.github.io/nocturne/index.html) · [Landing page](https://ivanroig.github.io/nocturne/landing.html)

> Nota de publicación: la app ya no muestra un botón externo de GitHub en la interfaz pública. Si el repositorio todavía es privado, está mal nombrado o no existe, GitHub devuelve 404 a los visitantes. La navegación visible usa enlaces internos seguros hasta que publiques el repo.

---

<!-- Add a screenshot or GIF here: drag and drop an image into this editor -->
<!-- Recommended: record 4-5s showing the emotional axis moving + layers reacting -->
<!-- Save as screenshot.png or demo.gif in the repo root -->

</div>

---

## What is Nocturne?

Nocturne is **not** a white noise player.

It's a **sound atmosphere design studio** where you build independent layers — each with its own volume, rhythm, and *shadow* slider that gradually corrupts any sound toward its darker equivalent. By default, everything is generated in real time with the Web Audio API. For truly recorded realism, users can also load their own local WAV/MP3 samples named after Nocturne sound IDs. No server. No paid API. No tracking.

**For horror writers:** layer Cthulhu's call over a corrupted thunderstorm while the Director mode slowly cranks up the tension.  
**For thriller writers:** put a Carpenter synth pulse under rain on glass and a distant siren, then let the emotional axis drift toward terror.  
**For fantasy writers:** dawn birds, forest wind, a distant accordion — and the corruption slider reveals what's wrong with this particular morning.

---

## Features

| | |
|---|---|
| **173 sounds** in 22 categories | From forest dawn to the Call of Cthulhu |
| **30 preset scenes** | Storm, R'lyeh, Giallo, Slasher, Meditation, Black Mass… |
| **Realistic procedural engine** | Layered pink/brown noise, random micro-events, envelopes, filters and stereo drift |
| **Per-layer audio polish** | Each layer gets subtle filtering, tonal balance and stereo placement before the master bus |
| **Quick master profiles** | Cine, Natural, Oscuro, Cósmico and VHS 80s instantly tune master volume, reverb, body, brightness and hybrid blend |
| **Optional local sample pack** | Load your own WAV/MP3 files named like `lluvia-pesada.wav` for recorded realism |
| **Interactive emotional axis** | Calm↔Tension / Pleasure↔Terror on a 2D canvas |
| **Shadow slider** | Degrades any sound toward its dark equivalent |
| **Narration mode** | Automatic dramatic arcs over time |
| **Surprise events** | Randomizer fires event layers at unpredictable moments |
| **Master convolution reverb** | Procedural reverb + global hi/lo filters, profile-aware on first playback |
| **Immersion mode** | Full-screen with spectrum-reactive visualizer |
| **Share by URL** | Entire scene encoded in the link, no server needed |
| **Scene crossfade** | Smooth fade out/in between saved scenes |
| **Writing session timer** | Pomodoro timer integrated with the scene |
| **Library export/import** | Save your scene library as a portable JSON file |
| **8 visual skins** | Nocturne, VHS 1987, R'lyeh, Giallo, Biblioteca, Ciudad Lluvia, Inferno and Manuscript |
| **Light/dark mode** | Integrated with the Manuscript skin for long writing sessions |
| **Installable PWA** | Works fully offline after first load |
| **Modular static architecture** | `index.html` + `assets/css` + `assets/js` |

---

## Project structure

```txt
nocturne/
├── index.html
├── landing.html
├── assets/
│   ├── css/
│   │   ├── app.css
│   │   └── landing.css
│   └── js/
│       └── app.js
├── docs/
│   ├── MOBILE_QA.md
│   ├── PRODUCT_LIMITS.md
│   ├── SAAS_ROADMAP.md
│   └── SAMPLE_PACKS.md
├── tests/
│   └── static-check.mjs
├── sw.js
├── manifest.json
├── SECURITY.md
├── AUDIT_REPORT.md
└── package.json
```

---

## Quick start

**No build step required.** Download and open `index.html` in any modern browser.

```bash
git clone <URL-DE-TU-REPOSITORIO>.git
cd nocturne
python3 -m http.server 8000
# Open http://localhost:8000
```

For installable PWA/offline cache behavior, use HTTPS or a local server.

**Deploy to GitHub Pages:** Settings → Pages → Branch: main → Save. Your instance will be live at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

---

## Verification

```bash
npm test
```

The static check validates:

- Main JS syntax.
- Service worker syntax.
- Required files.
- Offline assets referenced by `sw.js`.
- Absence of remote runtime dependencies.
- Basic security headers/meta policy.

For mobile release QA, follow [`docs/MOBILE_QA.md`](docs/MOBILE_QA.md). For recorded sound packs, follow [`docs/SAMPLE_PACKS.md`](docs/SAMPLE_PACKS.md).

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `C` | Immersion mode |
| `D` | Narration mode |
| `R` | Surprise events |
| `Esc` | Exit immersion mode |
| `?` | Show help |

---

## How it works technically

Every sound in Nocturne is synthesized in real time using the Web Audio API, with optional local recorded samples taking priority when loaded. The hybrid audio engine focuses on less synthetic, more organic textures:

- **Layered pink/brown noise** for rain, wind, crowds, waves and fire.
- **Oscillator chains** with LFO modulation for drones, pads and tones.
- **Binaural beats** with stereo channel splitting for brainwave entrainment.
- **Shepard/Risset tones** for infinite ascending/descending illusions.
- **Event-based synthesis** with randomized timing, envelopes and stereo drift for footsteps, drips, crackles, birds, crickets and heartbeats.
- **Formant filters** for voice-like textures without any recorded audio.
- **Procedural convolution reverb** generated mathematically at runtime.
- **Optional sample override system** for user-owned audio files, kept in memory for the current session and never uploaded.

The entire audio graph is managed through a single `AudioContext` with master gain, analyser and reverb wet/dry bus. Each layer gets its own output `GainNode` so volume, mute and corruption can be adjusted independently without interrupting other layers.

---

## Product boundaries

Nocturne is intentionally a static, privacy-first studio. It does not include accounts, cloud sync, billing or analytics. Those are mapped in [`docs/SAAS_ROADMAP.md`](docs/SAAS_ROADMAP.md) for a future commercial SaaS version.

See [`docs/PRODUCT_LIMITS.md`](docs/PRODUCT_LIMITS.md) for browser/audio limitations and mitigations.

---

## Browser support

Chrome, Firefox, Safari and Edge, modern versions. For full binaural effect, use headphones. On iOS/Safari, audio starts only after a user gesture; the app handles this with explicit play/tap controls.

---

## License

MIT · Ivan Roig · 2026

---

<div align="center">

*"The sound you can't name is the one that frightens you most."*  
— Nocturne design principle

</div>


## Hybrid Audio Engine

Nocturne ahora permite mezcla híbrida: sample real local + motor procedural + aire + paneo + reverb. Consulta `docs/HYBRID_AUDIO_ENGINE.md`.
