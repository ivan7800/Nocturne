# Contribuir a Nocturne

Gracias por tu interés. Nocturne es un único archivo HTML con síntesis procedural — añadir un sonido nuevo es sencillo si sigues este proceso.

## Cómo añadir un sonido nuevo

### 1. Escribe la función de síntesis

En `index.html`, dentro del bloque `<script>`, después de los motores existentes y antes de `function stopNodes`:

```js
function synthMiSonido(def, rate, out) {
  // `def`  — definición del sonido (accede a def.freq, def.freqs, etc.)
  // `rate` — slider de ritmo (0-60), úsalo para modular velocidad de eventos
  // `out`  — nodo de salida (AudioNode), conecta aquí tu cadena

  const o = audioCtx.createOscillator();
  o.type = 'sine';
  o.frequency.value = def.freq || 440;

  const g = audioCtx.createGain();
  g.gain.value = 0.1;

  o.connect(g);
  g.connect(out);
  o.start();

  // Devuelve todos los nodos que necesiten limpieza
  return { osc: o };
}
```

**Reglas de la función de síntesis:**
- Siempre conecta la cadena a `out`, nunca directamente a `masterGain`
- Devuelve un objeto con todos los nodos creados
- Si usas `setTimeout` recursivo, devuelve `{ _stopFn: () => clearTimeout(timer) }`
- Si usas osciladores secundarios (LFOs), inclúyelos en el return para que `stopNodes` los limpie
- No uses `async/await` — la síntesis es síncrona

### 2. Registra el tipo en el `switch`

Busca el bloque `switch (def.synth)` dentro de `createSoundNode` y añade tu case:

```js
case 'mi-sintetico': nodes = { ...nodes, ...synthMiSonido(def, rate, out) }; break;
```

### 3. Añade la definición en `SOUND_DEFS`

```js
'mi-sonido-id': { synth: 'mi-sintetico', freq: 220 },
```

Los parámetros opcionales que puedes pasar en `def`:
- `freq` — frecuencia base en Hz
- `freqs` — array de frecuencias
- `notes` — secuencia de notas para arpegios
- `scale` — escala para instrumentos
- `seq` — secuencia para sintetizadores
- `root` — frecuencia raíz
- `base` — frecuencia base alternativa
- `ratios` — ratios de afinación
- `intervals` — intervalos en semitonos
- `beat` — diferencia para binaurales
- `carrier` — portadora para binaurales
- `dir` — dirección (1 o -1) para glissandos
- `wave` — tipo de oscilador ('sine', 'square', 'sawtooth', 'triangle')

### 4. Añade el sonido al `CATALOG`

Elige la categoría adecuada o crea una nueva:

```js
{ id: 'mi-sonido-id', name: 'Nombre visible', tag: 'etiqueta' },
```

Las etiquetas existentes: `clima`, `naturaleza`, `detalle`, `interior`, `evento`, `atmósfera`, `ritual`, `terror`, `cósmico`, `sintetizador`, `experimental`, `bienestar`

### 5. Añade el tooltip en `SOUND_TOOLTIPS`

```js
'mi-sonido-id': 'Descripción técnica de una línea: qué sintetiza y cómo',
```

### 6. Añade las coordenadas en `EMO_MAP`

Asigna la posición del sonido en el eje emocional `[tensión 0-1, terror 0-1]`:

```js
'mi-sonido-id': [0.3, 0.4], // tensión media, algo de terror
```

Referencia aproximada:
- `[0.0, 0.0]` — calma total, placer (ronroneo, olas en calma)
- `[0.5, 0.0]` — neutro (lluvia suave)
- `[0.8, 0.8]` — tensión alta, terror alto (stingers, entidades)
- `[0.9, 0.95]` — caos absoluto (Azathoth, Shoggoth)

### 7. Opcional: par de corrupción

Si tu sonido tiene un equivalente "corrupto", añádelo en `CORRUPTION_PAIRS`:

```js
'mi-sonido-id': 'id-del-equivalente-oscuro',
```

### 8. Opcional: nueva escena preset

```js
'MiEscena': { name: 'Nombre descriptivo', ids: [
  { id: 'mi-sonido-id', vol: 55, rate: 25 },
  { id: 'otro-sonido',  vol: 40, rate: 15 },
]},
```

---

## Verificación antes de abrir PR

```bash
# Comprueba sintaxis JS
node --check index.html 2>&1 | grep SyntaxError

# O extrae y verifica el bloque JS
python3 -c "
import re
html = open('index.html').read()
m = re.search(r\"<script>\s*'use strict';(.*?)</script>\", html, re.DOTALL)
open('/tmp/check.js', 'w').write(\"'use strict';\" + m.group(1))
"
node --check /tmp/check.js
```

Comprueba también que:
- El ID del sonido en `SOUND_DEFS`, `CATALOG`, `EMO_MAP` y `SOUND_TOOLTIPS` es idéntico
- El tipo `synth:` en `SOUND_DEFS` coincide exactamente con el `case` en el switch
- La función devuelve todos los nodos que necesiten limpieza

---

## Guía de síntesis rápida

### Ruido continuo (lluvia, viento, estático)
```js
const buf = makeNoiseBuffer('brown', 4); // 'white' o 'brown', segundos
const src = loopNoise(buf);
const filter = audioCtx.createBiquadFilter();
filter.type = 'lowpass'; // 'highpass', 'bandpass'
filter.frequency.value = 800;
src.connect(filter); filter.connect(out);
return { src, filter };
```

### Eventos periódicos (pasos, gotas, crujidos)
```js
let timer;
function event() {
  if (!playing) return;
  // crea y dispara un sonido breve...
  timer = setTimeout(event, interval * 1000);
}
event();
return { _stopFn: () => clearTimeout(timer) };
```

### Drone con LFO
```js
const o = audioCtx.createOscillator();
o.type = 'sawtooth'; o.frequency.value = 110;
const g = audioCtx.createGain(); g.gain.value = 0.08;
const lfo = audioCtx.createOscillator();
lfo.frequency.value = 0.05;
const lfoG = audioCtx.createGain(); lfoG.gain.value = 0.2;
lfo.connect(lfoG); lfoG.connect(g.gain); // modula la ganancia
o.connect(g); g.connect(out);
o.start(); lfo.start();
return { osc: o, lfo, lfoG };
```

---

## Estilo de código

- Variables `const` siempre que sea posible
- Nombres de funciones: `synthNombreDescriptivo` en camelCase
- IDs de sonidos: `palabra-palabra-palabra` en kebab-case
- Sin `console.log` en el código final
- Comenta la cadena de audio si es compleja

---

## Preguntas

Abre un [issue](https://github.com/ivanroig/nocturne/issues) con la etiqueta `nuevo sonido` si necesitas ayuda o quieres discutir la idea antes de implementarla.
