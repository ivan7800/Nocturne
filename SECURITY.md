# Security policy

Nocturne Studio is a static, offline-first web app. It does not send saved scenes, settings or imported libraries to a server.

## Current security posture

- No backend secrets.
- No runtime third-party JavaScript.
- No bundled audio files or remote CDN dependencies. Optional user-loaded samples are decoded locally in the browser session.
- Imported scene libraries are normalized before storage.
- User audio samples are not uploaded or persisted by the app.
- User-provided scene names are rendered as text, not executable HTML.
- A Content Security Policy meta tag restricts external loading for the static app.
- Service worker caching is limited to same-origin GET requests.

## Reporting a vulnerability

Open a private security advisory on the repository or contact the maintainer directly.

Please include:

- Browser and operating system.
- Steps to reproduce.
- Expected behavior.
- Actual behavior.
- Proof-of-concept payload if applicable.

## Out of scope

- Browser Web Audio policies requiring a user gesture.
- Device-specific audio suspension when the OS puts a tab to sleep.
- Loss of local browser storage after manual browser data deletion.
