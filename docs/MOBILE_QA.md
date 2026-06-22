# Mobile QA checklist

Use this checklist before publishing a public release. The app has been prepared for responsive use, but real-device audio behavior can vary by browser and operating system.

## Required devices

- iPhone Safari, current iOS.
- iPhone Chrome, current iOS.
- Android Chrome, current Android.
- Android Firefox, if possible.
- One small viewport around 360px width.
- One large mobile/tablet viewport around 768px width.

## Core flow

1. Open `index.html` from GitHub Pages or a local server.
2. Confirm the landing/studio does not produce horizontal overflow.
3. Tap **Escuchar ahora** or the main play button.
4. Confirm the browser allows audio after the gesture.
5. Add at least 5 sounds from the mobile catalog.
6. Open the mobile Layers panel.
7. Change volume, rhythm and shadow sliders.
8. Mute/unmute and remove layers.
9. Open mobile Tools.
10. Start/stop Director mode.
11. Start/stop Randomizer mode.
12. Save a scene.
13. Load the saved scene.
14. Export the library.
15. Import the exported library.
16. Toggle light/dark theme.
17. Enter and exit immersion mode.
18. Reload the page and confirm saved data persists.
19. Disconnect network and reload once the PWA has been installed/cached.
20. Confirm the app still opens offline.

## Pass criteria

- No horizontal scroll at mobile widths.
- Bottom navigation remains reachable above safe areas/notches.
- No control is smaller than a comfortable tap target.
- Audio only starts after user action, but never gets stuck in a false playing state.
- No JavaScript console errors during normal use.
- Scene save/import/export works with accented characters and long names.
- App remains usable with 12 layers.

## Known browser behavior

- iOS and Safari require a user gesture before Web Audio can produce sound.
- Some mobile browsers suspend audio after tab switching or screen lock. Press Play again to resume.
- Offline PWA cache requires first loading through HTTPS or a local server.


## v4.5 mobile skin checks

- Confirm the header does not overflow at 390px width.
- Tap the Skins button from the mobile header.
- Confirm the Tools drawer opens directly on the Skins tab.
- Apply at least three skins and verify the background/panel/accent changes immediately.
- Confirm Manuscrito switches to a light long-writing theme.
- Confirm Nocturne or any dark skin returns to dark mode.


## v4.7 phone/tablet navigation checks

- Confirm widths around 390px, 768px, 820px and 1024px use the bottom navigation.
- Confirm desktop three-column mode only returns above 1024px.
- Tap **Catálogo**, **Capas**, **Escenas** and **Ajustes** from the bottom bar.
- Confirm **Escenas** opens a preset drawer and each preset loads correctly.
- Confirm the Tools tab row can scroll horizontally if the text does not fit.
- Rotate a tablet between portrait and landscape and confirm drawers do not get stuck open.
- Confirm the onboarding modal can scroll instead of overflowing off-screen.
