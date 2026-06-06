# Changelog

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
