# Product limits and mitigations

Nocturne is a static, offline-first Web Audio application. These are intentional product boundaries, not hidden bugs.

## Web Audio startup policy

Modern browsers block audio until the user interacts with the page. No web app can fully bypass that policy. Nocturne mitigates it by:

- Starting audio only from explicit user actions.
- Resuming a suspended `AudioContext` before playback.
- Avoiding a false playing state when the browser refuses audio.
- Showing a toast when the browser requires another tap.

## Browser and device variance

The synthesis engine uses standard Web Audio nodes, but timing, CPU budget and background-tab behavior vary across browsers.

Mitigations:

- Layer count is capped.
- Gains are faded to avoid clicks.
- A compressor prevents clipping with dense scenes.
- The app degrades gracefully when audio is unsupported.

## Storage

Nocturne uses local browser storage for scenes and settings. This is private and simple, but not cloud-synced.

Mitigations:

- Export/import library as JSON.
- Corrupt saved data is handled defensively.
- Imported scenes are normalized before being stored.

## Static product boundary

This GitHub Pages version intentionally has:

- No login.
- No backend.
- No payments.
- No cloud database.
- No server-side analytics.

Those features belong to a future SaaS edition, outlined in `docs/SAAS_ROADMAP.md`.


## Real audio samples

The built-in engine is procedural. For truly recorded realism, users can load their own local samples in v4.3. These samples are session-only and must be legally owned or royalty-free.
