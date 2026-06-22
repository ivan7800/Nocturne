# Local real sample packs

Nocturne v4.3 can use real recorded audio without shipping copyrighted files in the GitHub repository.

## How it works

1. Collect your own royalty-free or self-recorded audio files.
2. Rename each file to match a Nocturne sound ID.
3. Open Nocturne.
4. Go to **Atmósfera → Samples reales locales → Cargar audios**.
5. Select multiple WAV/MP3/M4A/OGG/FLAC/AAC/WebM files.

The app decodes the files locally in the browser. They are not uploaded, tracked or persisted to a server.

## Naming examples

```txt
lluvia-pesada.wav
tormenta-electrica.mp3
chimenea.wav
olas-orilla.ogg
pasos-madera.wav
murmullo-gente.mp3
viento-fuerte.wav
```

The app matches filenames against internal sound IDs. Spaces and underscores are converted to hyphens, so `lluvia pesada.wav` and `lluvia_pesada.wav` can still match `lluvia-pesada`.

## Important limits

- Samples are session-only. Reloading the page clears them because Nocturne stays static and privacy-first.
- Do not commit commercial/copyrighted audio into the repository unless you have rights.
- For GitHub Pages, keep sample packs outside the repo or provide clear download instructions.
- Long ambient loops work best when they have clean loop points.

## Best sources

Use your own recordings or audio with explicit compatible licenses. Good candidates:

- Self-recorded rain, wind, footsteps, doors and room tones.
- CC0/royalty-free ambience libraries.
- Original sounds designed specifically for this project.

## Why the repository does not include real sounds by default

Realistic audio files increase repository size and can create licensing problems. The default engine is procedural and copyright-safe; local sample packs let users upgrade the realism when they own the audio.
