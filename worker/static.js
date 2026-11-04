// Serves the bundled public/ files (see tools/bundle-static.mjs).
import FILES from './static-files.js';
const cache = {};
export function serveStatic(url) {
  let path = url.pathname;
  if (path.endsWith('/')) path += 'index.html';
  let f = FILES[path] || FILES[path + '.html'] || FILES[path + '/index.html'];
  if (!f) return new Response('Not found', { status: 404 });
  const body = cache[path] ||= Uint8Array.from(atob(f[1]), c => c.charCodeAt(0));
  return new Response(body, { headers: { 'Content-Type': f[0], 'Cache-Control': 'no-cache' } });
}
