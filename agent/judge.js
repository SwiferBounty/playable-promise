// The AI half of the agent. It never reads the game's own state: it reads the promise in
// plain English, decides what a player would have to SEE, and judges the screenshots.
import { askJSON } from '../lib/gemini.js';

const S = { type: 'STRING' }, B = { type: 'BOOLEAN' }, I = { type: 'INTEGER' };

// 1. Turn a creator's plain-English promise into visual checkpoints.
export const planChecks = (promise, opts) => askJSON([
  `You are a skeptical playtester working for a game's backers. The creator promised this milestone:\n"${promise}"\n` +
  `List 1 to 3 concrete things that must be VISIBLE on screen during a playthrough to prove the promise was kept. ` +
  `Only things a player could see (text, health bars, colors, enemies gone). Be strict and specific.`,
], { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: S, look_for: S }, required: ['id', 'look_for'] } }, opts);

// 2. Judge the frames the agent captured against those checkpoints.
export const judgeFrames = (promise, checks, frames, opts) => askJSON([
  `You are a skeptical playtester working for backers who only pay if the promise is kept.\n` +
  `Promise: "${promise}"\nCheckpoints:\n${checks.map(c => `- ${c.id}: ${c.look_for}`).join('\n')}\n` +
  `Below are screenshots in time order, each labeled. Judge ONLY from what is visible. ` +
  `If a checkpoint is not clearly visible in any frame, it is not met. A crash, freeze or error screen means the promise is broken.`,
  ...frames.flatMap(f => [`Frame ${f.i} (tick ${f.tick}, ${f.label}):`, { png: f.png }]),
], { type: 'OBJECT', required: ['kept', 'checks', 'summary'], properties: {
  kept: B, summary: S,
  checks: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: S, met: B, frame: I, why: S }, required: ['id', 'met', 'why'] } },
} }, opts);
