import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = file => readFileSync(file, 'utf8');
const fail = message => {
  console.error(`STATIC_CHECK_FAIL: ${message}`);
  process.exit(1);
};
const assert = (condition, message) => {
  if (!condition) fail(message);
};

const required = [
  'index.html',
  'landing.html',
  'assets/css/app.css',
  'assets/css/landing.css',
  'assets/js/app.js',
  'manifest.json',
  'sw.js',
  'icon.svg',
  'README.md',
  'SECURITY.md',
  'docs/MOBILE_QA.md',
  'docs/PRODUCT_LIMITS.md',
  'docs/SAAS_ROADMAP.md',
  'docs/SAMPLE_PACKS.md',
  'assets/samples/README.md'
];
for (const file of required) assert(existsSync(file), `missing ${file}`);

execFileSync(process.execPath, ['--check', 'assets/js/app.js'], { stdio: 'inherit' });
execFileSync(process.execPath, ['--check', 'sw.js'], { stdio: 'inherit' });

const index = read('index.html');
const landing = read('landing.html');
const app = read('assets/js/app.js');
const sw = read('sw.js');

assert(index.includes('assets/css/app.css'), 'index must use modular app css');
assert(index.includes('assets/js/app.js'), 'index must use modular app js');
assert(landing.includes('assets/css/landing.css'), 'landing must use modular css');
assert(index.includes('Content-Security-Policy'), 'index must include CSP meta');
assert(landing.includes('Content-Security-Policy'), 'landing must include CSP meta');

const runtimeRemotePatterns = [
  /<script[^>]+src=["']https?:\/\//i,
  /<link[^>]+href=["']https?:\/\//i,
  /@import\s+url\(["']?https?:\/\//i,
  /fonts\.googleapis\.com/i,
  /fonts\.gstatic\.com/i,
  /cdn\.jsdelivr\.net/i,
  /cdnjs\.cloudflare\.com/i,
  /unpkg\.com/i
];
for (const pattern of runtimeRemotePatterns) {
  assert(!pattern.test(index), `remote runtime dependency in index: ${pattern}`);
  assert(!pattern.test(landing), `remote runtime dependency in landing: ${pattern}`);
  assert(!pattern.test(read('assets/css/app.css')), `remote runtime dependency in app css: ${pattern}`);
  assert(!pattern.test(read('assets/css/landing.css')), `remote runtime dependency in landing css: ${pattern}`);
}

for (const asset of ['assets/css/app.css', 'assets/css/landing.css', 'assets/js/app.js']) {
  assert(sw.includes(asset), `service worker must cache ${asset}`);
}

assert(app.includes('function ensureAudio()') && app.includes('return false;'), 'audio guard must return failure safely');
assert(app.includes('sanitizeSceneLibrary'), 'imported scene normalization must exist');
assert(app.includes('updateCrossfadeTargetsBase'), 'crossfade recursion fix must exist');
assert(app.includes('Toca de nuevo para activar el audio'), 'mobile/browser audio resume feedback must exist');
assert(app.includes('importSamplePack'), 'local sample pack loader must exist');
assert(app.includes('synthImportedSample'), 'sample override synthesizer must exist');
assert(app.includes('createHybridSampleNode'), 'hybrid sample engine must exist');
assert(app.includes('synthHybridAirBed'), 'hybrid procedural air layer must exist');
assert(app.includes('setHybridBlend'), 'hybrid blend control must exist');
assert(app.includes('makeRealNoise'), 'realistic procedural noise helper must exist');
assert(index.includes('sample-pack-file'), 'desktop sample input must exist');
assert(index.includes('sample-bank-status-m'), 'mobile sample status must exist');
assert(index.includes('hybrid-blend-slider'), 'desktop hybrid blend slider must exist');
assert(index.includes('hybrid-blend-slider-m'), 'mobile hybrid blend slider must exist');
assert(index.includes('viewport-fit=cover'), 'viewport must support safe areas on iOS/tablets');
assert(index.includes('mnav-presets') && index.includes('presets-bar-mobile'), 'mobile/tablet preset navigation must exist');
assert(read('assets/css/app.css').includes('@media (max-width: 1024px)'), 'tablet breakpoint must use touch-first navigation');
assert(app.includes('MOBILE_TABLET_QUERY') && app.includes('isMobileTabletUI'), 'shared mobile/tablet UI detector must exist');
assert(app.includes('buildPresetsMobile'), 'mobile/tablet preset builder must exist');

assert(index.includes('btn-skins'), 'header skin button must exist');
assert(index.includes('skin-picker'), 'desktop skin picker must exist');
assert(index.includes('skin-picker-m'), 'mobile skin picker must exist');
assert(app.includes('VISUAL_SKINS') && app.includes('applyVisualSkin') && app.includes('renderSkinPicker'), 'visual skin engine must exist');
assert(app.includes('cleanText(data.n') && app.includes('sanitizeLayerInput({ id: row[0]'), 'shared URL payload must be sanitized');
assert(read('assets/css/app.css').includes('[data-skin="vhs"]'), 'VHS skin css must exist');
assert(read('assets/css/app.css').includes('[data-skin="rlyeh"]'), 'Rlyeh skin css must exist');

assert(app.includes('MASTER_PROFILES') && app.includes('applyMasterProfile') && index.includes('master-profile-grid'), 'master profile engine and UI must exist');
assert(app.includes('createLayerPolishChain') && app.includes('inferSoundPolish'), 'per-layer audio polish engine must exist');
assert(app.includes('previewAudioActive') && app.includes('isAudioEngineActive') && app.includes('shouldKeepScheduling'), 'event preview active-state fix must exist');
assert(sw.includes('nocturne-v4.9-publication-final'), 'service worker cache must use v4.9 publication final cache name');
assert(!index.includes('https://github.com/ivanroig/nocturne'), 'runtime app must not expose a GitHub link that can 404 while the repo is private/missing');
assert(!landing.includes('https://github.com/ivanroig/nocturne'), 'landing page must not expose a GitHub link that can 404 while the repo is private/missing');
assert(!read('README.md').includes('https://ivanroig.github.io/nocturne'), 'README must not hard-code a possibly stale GitHub Pages URL');
for (const file of ['index.html','landing.html','README.md','CONTRIBUTING.md']) {
  assert(!read(file).includes('https://github.com/ivanroig/nocturne'), `${file} must not hard-code a 404-prone repository URL`);
}
assert(index.includes('landing.html#install'), 'header guide button must point to internal publication guide');
assert(landing.includes('id="install"') && landing.includes('Guía de publicación'), 'landing publication guide must exist');

assert(!landing.toLowerCase().includes('sube la carpeta completa'), 'landing must not tell users to upload the container folder');
assert(!read('README.md').toLowerCase().includes('sube la carpeta completa'), 'README must not tell users to upload the container folder');
assert(landing.includes('raíz del repositorio') || landing.includes('/root'), 'landing must clearly mention repository root deployment');
assert(read('README.md').includes('repository root') || read('README.md').includes('/root'), 'README must clearly mention repository root deployment');

console.log('STATIC_CHECKS_PASS');
