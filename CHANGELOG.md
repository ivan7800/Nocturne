# Changelog

## [1.1.0] — 2026

### UX & experiencia de escritor

- **Preview auditivo** — botón `▶` en cada sonido del catálogo reproduce 3 segundos en solitario antes de añadirlo a la escena. Aparece al hacer hover en desktop, siempre visible en móvil. Para inmediatamente al pulsar de nuevo o al previsualizar otro sonido.
- **Onboarding activo** — el modal de bienvenida ahora incluye tres tarjetas de escena seleccionables (Tormenta, R'lyeh, Giallo) con descripción narrativa. Al pulsar "Escuchar ahora →" carga la escena elegida y arranca el audio con fade in de 1.5 segundos.
- **Vocabulario de escritor** — renombradas todas las etiquetas técnicas: Mezcla → Atmósfera, Director → Narración, Herramientas → Escritura, Cine → Inmersión, Aleatorizar → Sorprender, Vol → Nivel, Corrup → Sombra, Espacio & filtros → Ambiente sonoro, Arco dramático → Evolución de la escena, Aleatorizador de sustos → Golpes de efecto, Crossfade → Transición entre escenas, Temporizador → Sesión de escritura.
- **Intención narrativa en escenas** — cada una de las 30 escenas preset tiene ahora una línea de contexto narrativo. Aparece como tooltip al hacer hover sobre el chip, y como toast de 4 segundos al cargar la escena.
- **Toast mejorado** — acepta duración variable, admite texto multilínea, ancho máximo 480px. Ya no se corta en frases largas.

### Biblioteca de escenas

- **Exportar biblioteca** — botón en el panel "Escenas guardadas" (desktop y móvil) que descarga todas las escenas guardadas como `nocturne-biblioteca-YYYY-MM-DD.json`.
- **Importar biblioteca** — acepta tres formatos: biblioteca completa, escena individual, o JSON sin wrapper. Fusión inteligente: solo sobreescribe escenas existentes si la importada es más reciente. El toast confirma cuántas escenas se añadieron o actualizaron.

### Modo Capítulo (nuevo)

- Sección en el tab Narración que permite definir una secuencia ordenada de escenas guardadas con duración en minutos cada una.
- Al ejecutar, Nocturne carga cada escena en orden y 8 segundos antes del final hace un crossfade suave hacia la siguiente.
- Barra de progreso en tiempo real con nombre de escena actual y número de paso.
- El capítulo se puede detener en cualquier momento.

### Correcciones técnicas (audio)

- **Fix fuga de nodos** en 7 motores de síntesis donde osciladores y LFOs creados dentro de `forEach` no se devolvían al sistema de cleanup: `synthNonEuclideanEcho` (4 LFOs), `synthFormantVoid` (3 LFOs), `synthGlossolalia` (3 LFOs), `synthSpectralInvert` (5 LFOs), `synthInnsmouthDeep` (3 osciladores de tono + waveLfo), `synth528Hz` (2 armónicos), `synthPerfectFifth` (4 osciladores). Todos devuelven ahora un `_stopFn` que detiene correctamente todos los nodos creados.

### Móvil

- **Targets táctiles** aumentados a estándar iOS/Android: thumb de slider 10px → 24px, track 2px → 6px, padding vertical añadido a contenedor `.sl`, botones de acción 34px → 38px, barra de navegación inferior con `min-height: 44px`.

### Documentación

- README reescrito en inglés con estructura orientada a conversión: ejemplos narrativos por género, tabla de características, sección técnica detallada de los 102 motores de síntesis, shortcuts en tabla, instrucciones de despliegue. Badges limpios (eliminada duplicación).

---

## [1.0.0] — 2026

### Primera versión pública

**Sonidos**
- 173 sonidos en 22 categorías
- 102 motores de síntesis procedural (Web Audio API pura, sin archivos de audio)
- Categorías: Lluvia & agua, Viento & aire, Fuego & calor, Bosque & naturaleza, Interior & doméstico, Urbano & social, Música & atmósfera, Subterráneo & terror, Espacial & onírico, Mar & barcos, Cine de terror, Tensión & suspense, Percusión & golpes, Horror visceral, Industrial siniestro, Synth de género, Lovecraft & mitología, Frecuencias especiales, Placer & bienestar, Sectas & ocultismo, Ambientes oscuros, Síntesis experimental

**Características**
- Hasta 12 capas simultáneas con volumen, ritmo y corrupción independientes
- Eje emocional interactivo (calma↔tensión / placer↔terror)
- Slider de corrupción por capa con pares de degradación
- Modo director con 4 arcos dramáticos automáticos
- Aleatorizador de eventos en momentos impredecibles
- Crossfade entre escenas guardadas
- Reverb maestra por convolución procedural + filtros globales
- Modo cine: pantalla completa con visualizador reactivo al espectro
- Compartir escena por URL (sin servidor)
- Historial de últimas 8 sesiones en localStorage
- Tema claro/oscuro con preferencia guardada
- Modal de onboarding para nuevos usuarios
- Tooltips en cada sonido del catálogo
- Chips de filtro por categoría en el catálogo
- Atajos de teclado completos
- PWA instalable, funciona offline

**Rigor musical**
- Todas las frecuencias verificadas contra temperamento igual (A4=440Hz)
- Gregoriano oscuro en modo frigio real (E D C B A G F E)
- Drone de tensión usa tritono A-Eb (diabolus in musica)
- Clavecín Goblin usa F# disminuido + tritono
- Detuning intencional documentado (drones de misterio, campanas)
- Cuencos tibetanos con parciales reales (no armónicos)
- Frecuencias psicoacústicas documentadas (19Hz, 111Hz, 136.1Hz, 528Hz, 7.83Hz)

**Técnico**
- Un único archivo HTML de 214 KB
- Cero dependencias, cero archivos de audio, cero llamadas de red
- Sin console.log en producción
- 67 funciones de limpieza de nodos de audio
- 37 bloques try/catch para manejo de errores
