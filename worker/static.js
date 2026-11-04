// Static files bundled into the Worker as text (small, and no separate asset upload).
import index from '../public/index.html';
import gameHtml from '../public/games/boss-rush/index.html';
import gameJs from '../public/games/boss-rush/game.js.txt';

const H = 'text/html; charset=utf-8', J = 'text/javascript; charset=utf-8';
const FILES = {
  '/': [index, H], '/index.html': [index, H],
  '/games/boss-rush/': [gameHtml, H], '/games/boss-rush/index.html': [gameHtml, H],
  '/games/boss-rush/game.js': [gameJs, J],
};
export function serveStatic(url) {
  const f = FILES[url.pathname] || (url.pathname === '/games/boss-rush' && FILES['/games/boss-rush/']);
  return f ? new Response(f[0], { headers: { 'Content-Type': f[1], 'Cache-Control': 'no-cache' } }) : new Response('Not found', { status: 404 });
}
