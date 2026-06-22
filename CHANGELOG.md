# Changelog

## v4.9.0 — Publication Final QA

- Corrected landing deployment copy: upload the internal files to the repository root, not the container folder.
- Updated README deployment instructions to prevent GitHub Pages from serving an old root `index.html`.
- Updated visible landing version to v4.9.
- Updated service worker cache to `nocturne-v4.9-publication-final` so browsers refresh this final build.
- Added static checks to block misleading “upload the whole folder” wording.

## v4.8.0 — Safe Links & Final Mobile QA

- Removed visible public GitHub buttons that could send users to a 404 when the repository is private, renamed or not yet published.
- Replaced the app header GitHub button with an internal `Guía` button pointing to the publication guide.
- Replaced landing GitHub CTAs with internal installation/publication links.
- Updated the landing version card from the old v4.3 label to v4.8.
- Updated service worker cache to `nocturne-v4.8-linkfix-mobile-qa` so browsers refresh the corrected UI.
- Added static checks that prevent reintroducing broken public GitHub links in runtime pages.

## v4.7.0 — Mobile & Tablet Navigation

- Touch-first navigation up to 1024px.
- Mobile/tablet bottom tabs for catálogo, capas, escenas and ajustes.
- Mobile/tablet quick scenes panel.
- Safe-area viewport support for iOS/tablets.
- Better scroll behavior in compact screens.


## v4.6.0 — Audio Master & Final GitHub Edition

- Added quick master profiles: Cine, Natural, Oscuro, Cósmico and VHS 80s.
- Added per-layer audio polish chain: subtle high-pass/low-pass cleanup, tonal shelf balance and stereo placement before the master bus.
- Fixed first-play profile application so saved reverb/filter values now affect the Web Audio graph after the context is created.
- Improved preview reliability for event-based sounds such as drops, steps, birds, crickets, creaks and random hits.
- Extended export/save data with the selected master profile.
- Updated package version, manifest description, service worker cache and static checks.

## v4.5.0 — Visual Skins & Mobile Polish

- Added 8 complete visual skins: Nocturne, VHS 1987, R'lyeh, Giallo Rojo, Biblioteca Oculta, Ciudad Lluvia, Inferno and Manuscrito.
- Added desktop and mobile skin picker panels.
- Added persistent skin selection with localStorage and dynamic theme-color updates.
- Improved visual depth with skin-aware gradients, card surfaces, panel glow and VHS scanline layer.
- Fixed mobile header overflow by hiding text labels and non-critical actions on very small screens.
- Hardened shared URL loading by sanitizing scene name and layer payloads before rendering.
- Clamped layer/master/filter values at runtime to avoid malformed imported/shared values.
- Updated static checks to verify the skin engine, mobile skin picker and URL sanitization.

## v4.4 — Hybrid Audio Engine

- Añadido motor híbrido: sample real local + capa procedural + aire/textura + paneo.
- Añadido control de intensidad híbrida en escritorio y móvil.
- Añadida carpeta `assets/samples/` con instrucciones para packs propios sin copyright.
- Añadida documentación `docs/HYBRID_AUDIO_ENGINE.md`.

## v4.3.0 — Realistic audio edition

### Added

- Optional local real sample pack loader for WAV/MP3/M4A/OGG/FLAC/AAC/WebM files.
- `docs/SAMPLE_PACKS.md` with naming rules and licensing guidance.
- Sample status indicators on desktop and mobile.

### Changed

- Upgraded the most exposed procedural sound families: rain, wind, fire, waves, thunder, drops, footsteps, creaks, heartbeats, crowds, birds and crickets.
- Added layered pink/brown noise, randomized micro-events, envelopes and stereo variation for more organic sound.
- Samples named like a sound ID now override procedural synthesis during the current session.

### Fixed

- Preview scheduling now works for event-based sounds without requiring global playback state.

## v4.2.0 — GitHub hardened edition

### Fixed

- Prevented false play state when Web Audio cannot start.
- Added suspended AudioContext resume feedback for stricter mobile browsers.
- Updated service worker cache list for modular CSS/JS assets.

### Changed

- Split the former single-file app into modular static assets:
  - `assets/css/app.css`
  - `assets/css/landing.css`
  - `assets/js/app.js`
- Updated README for the modular architecture.
- Updated audit report and product limits.

### Added

- `SECURITY.md`
- `docs/MOBILE_QA.md`
- `docs/PRODUCT_LIMITS.md`
- `docs/SAAS_ROADMAP.md`
- `tests/static-check.mjs`
- `package.json` with `npm test`
- GitHub Actions static check workflow

## v4.1.0 — Critical audit pass

### Fixed

- Crossfade target recursion bug.
- Missing desktop Director selector.
- Scene-name XSS risk.
- Corrupt localStorage startup handling.
- External Google Fonts dependency.

### Added

- Audit report.
- GitHub Pages readiness files.
