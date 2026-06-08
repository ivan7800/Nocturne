<div align="center">

# Nocturne Studio

**Procedural sound architecture for writers, storytellers and worldbuilders**

*173 sounds · 22 categories · 102 synthesis engines · Zero audio files · Zero dependencies*

[![MIT License](https://img.shields.io/badge/license-MIT-c8a96e?style=flat-square)](LICENSE)
[![No dependencies](https://img.shields.io/badge/dependencies-0-5a9e6f?style=flat-square)]()
[![Single file](https://img.shields.io/badge/single%20file-214KB-534AB7?style=flat-square)]()
[![Sounds](https://img.shields.io/badge/sounds-173-A32D2D?style=flat-square)]()
[![PWA](https://img.shields.io/badge/PWA-offline%20ready-185FA5?style=flat-square)]()

[**→ Open Studio**](https://ivanroig.github.io/nocturne/index.html) · [Landing page](https://ivanroig.github.io/nocturne/landing.html)

---

<!-- Add a screenshot or GIF here: drag and drop an image into this editor -->
<!-- Recommended: record 4-5s showing the emotional axis moving + layers reacting -->
<!-- Save as screenshot.png or demo.gif in the repo root -->

</div>

---

## What is Nocturne?

Nocturne is **not** a white noise player.

It's a **sound atmosphere design studio** where you build independent layers — each with its own volume, rhythm, and *shadow* slider that gradually corrupts any sound toward its darker equivalent. Everything is generated in real time with the Web Audio API. No audio files. No server. No dependencies. A single 214 KB HTML file that works offline.

**For horror writers:** layer Cthulhu's call over a corrupted thunderstorm while the Director mode slowly cranks up the tension.  
**For thriller writers:** put a Carpenter synth pulse under rain on glass and a distant siren, then let the emotional axis drift toward terror.  
**For fantasy writers:** dawn birds, forest wind, a distant accordion — and the corruption slider reveals what's wrong with this particular morning.

---

## Features

| | |
|---|---|
| **173 sounds** in 22 categories | From forest dawn to the Call of Cthulhu |
| **30 preset scenes** | Storm, R'lyeh, Giallo, Slasher, Meditation, Black Mass… |
| **102 synthesis engines** | Noise, oscillators, binaural, Risset & Shepard illusions |
| **Interactive emotional axis** | Calm↔Tension / Pleasure↔Terror on a 2D canvas |
| **Shadow (corruption) slider** | Degrades any sound toward its dark equivalent |
| **Narration mode** (Director) | Automatic dramatic arcs over time |
| **Surprise events** | Randomizer fires event layers at unpredictable moments |
| **Master convolution reverb** | Procedural reverb + global hi/lo filters |
| **Immersion mode** | Full-screen with spectrum-reactive visualizer |
| **Share by URL** | Entire scene encoded in the link, no server needed |
| **Scene crossfade** | Smooth fade out/in between saved scenes |
| **Writing session timer** | Pomodoro timer integrated with the scene |
| **Library export/import** | Save your scene library as a portable JSON file |
| **Light/dark theme** | Persisted preference |
| **Installable PWA** | Works fully offline |
| **214 KB · zero dependencies** | One HTML file, open and run |

---

## Sound categories

**Natural environments:** Rain & water · Wind & air · Fire & heat · Forest & nature · Interior & domestic · Urban & social · Sea & ships

**Horror & cinema:** Music & atmosphere · Underground & terror · Horror cinema · Tension & suspense · Percussion & hits · Visceral horror · Sinister industrial · Genre synth

**What makes Nocturne unique:**

- **Lovecraft & mythology** — Cthulhu, R'lyeh, Azathoth, Shoggoth, Nyarlathotep, Dagon, Hastur, Yog-Sothoth, Mi-Go, the Sleeping God
- **Special frequencies** — 19 Hz presence effect, binaural alpha/theta/delta, Shepard tones, Schumann resonance 7.83 Hz, 111 Hz megalithic, Arabic microtonality
- **Pleasure & wellness** — 528 Hz, Tibetan bowls in just intonation, Nada Brahma 136.1 Hz, whale song, didgeridoo, brainwave entrainment
- **Cults & occultism** — Dark Gregorian in real Phrygian mode, glossolalia, corrupted om, black mass, whirling dervish, drums in 5/4 and 7/8
- **Dark atmospheres** — Sinister circus, submarine abyss, forbidden library, desecrated church, the doctor's laboratory, night train
- **Experimental synthesis** — Controlled feedback, granular silence, inverted spectrum

---

## Quick start

**No installation required.** Download and open `index.html` in any modern browser.

```bash
git clone https://github.com/ivanroig/nocturne.git
cd nocturne
python3 -m http.server 8000
# Open http://localhost:8000
```

Or just open `index.html` directly — binaural effects require a local server or HTTPS, but everything else works from the filesystem.

**Deploy to GitHub Pages:** Settings → Pages → Branch: main → Save. Your instance will be live at `https://YOUR-USERNAME.github.io/nocturne/`

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `C` | Immersion mode (full-screen visualizer) |
| `D` | Narration mode (Director) |
| `R` | Surprise events (Randomizer) |
| `Esc` | Exit immersion mode |
| `?` | Show help |

---

## How it works technically

Every sound in Nocturne is synthesized in real time using the [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API). There are **102 distinct synthesis engines**:

- **Filtered noise** (brown, white) for rain, wind, crowds, fire
- **Oscillator chains** with LFO modulation for drones, pads, tones
- **Binaural beats** with stereo channel splitting for brainwave entrainment
- **Shepard/Risset tones** for infinite ascending/descending illusions
- **Event-based synthesis** with randomized timing for footsteps, drips, heartbeats
- **Formant filters** for voice-like textures without any recorded audio
- **Procedural convolution reverb** generated mathematically at runtime

The entire audio graph is managed through a single `AudioContext` with a master gain, analyser, and reverb wet/dry bus. Each layer gets its own output `GainNode` so volume, mute and corruption can be adjusted independently without interrupting other layers.

---

## Adding new sounds

See [CONTRIBUTING.md](CONTRIBUTING.md) for a step-by-step guide to adding synthesis engines, registering them in the catalog, assigning emotional axis coordinates, and connecting corruption pairs.

---

## Browser support

Chrome, Firefox, Safari and Edge (modern versions). For full binaural effect, use headphones.

---

## License

MIT · [Ivan Roig](https://github.com/ivanroig) · 2026

---

<div align="center">

*"The sound you can't name is the one that frightens you most."*  
— Nocturne design principle

</div>
