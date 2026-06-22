# Nocturne Hybrid Audio Engine v4.4

Nocturne puede funcionar de dos maneras:

1. **Procedural puro**: genera el ambiente con Web Audio API sin archivos externos.
2. **Híbrido realista**: usa un sample real local como cuerpo del sonido y añade encima capas procedurales de movimiento, aire, subgrave, paneo, textura y variación.

## Flujo de señal

```txt
Sample real local ─┐
                   ├─ bus híbrido ─ paneo ─ capa ─ master ─ filtros ─ reverb ─ compresor
Motor procedural ──┤
Aire/textura ──────┘
```

## Control Híbrido

El control **Híbrido** decide cuánto motor procedural se mezcla encima del sample real:

- `0`: sample limpio, casi sin intervención.
- `55`: punto recomendado para calidad cinematográfica.
- `100`: sample + textura procedural intensa.

## Por qué no se incluyen WAV reales

El repositorio no incluye audio real para evitar copyright, peso excesivo y licencias ambiguas. El usuario puede cargar sus propios audios libres, grabados o comprados.

## Nombres recomendados

Los audios deben llamarse como el ID del sonido:

```txt
lluvia-pesada.wav
viento-bosque.wav
fuego-chimenea.wav
olas-orilla.wav
pasos-madera.wav
```

Si el nombre contiene el ID, Nocturne intentará asignarlo automáticamente.


## v4.6 audio master pass

The hybrid engine is now followed by a per-layer polish chain before the master bus. Every layer can receive subtle cleanup filtering, tonal shelf balancing and a small stereo position based on the sound family. This keeps drones, rain, voices and transient micro-events from masking each other in dense scenes.

The UI also includes quick master profiles: Cine, Natural, Oscuro, Cósmico and VHS 80s. These tune master volume, reverb, lowpass, highpass and hybrid blend without requiring the user to understand audio engineering.
