// The backer's agent, as a conversation. The backer sets their mandate by talking to it
// ("never more than $20", "only pay if the boss has three phases") and asks it why it did things;
// it answers from its own decision log and the evidence frames it judged.
import { askJSON } from './gemini.js';

const S = { type: 'STRING' };

export const chat = ({ backer, milestones, decisions, runs, history, message, key }) => askJSON([
  `You are ${backer.name}'s personal agent on Playable Promise. You hold their saved PayPal for a game pre-order ` +
  `($10 per milestone, three milestones). You only pay the creator when you have watched a milestone working yourself, ` +
  `you never pass the backer's cap, you check the backer's personal conditions, and you walk away (delete the saved PayPal) if a milestone is overdue.\n` +
  `Speak in first person, warm and brief (1-3 sentences). Be concrete: amounts, milestone numbers, what you saw. Never invent facts that are not below.\n` +
  `If the backer asks to change their rules, set cap (a dollar amount as digits, or "none" to remove it) and/or conditions (their personal conditions in one plain sentence, or "none" to clear them). Otherwise leave those fields empty.\n` +
  `If you explain a payment or refusal, put that run's id in cite_run.\n\n` +
  `Backer: ${JSON.stringify({ name: backer.name, status: backer.status, cap: backer.cap, conditions: backer.conditions, walked_reason: backer.walked_reason })}\n` +
  `Milestones: ${JSON.stringify(milestones)}\n` +
  `Your decisions (newest first): ${JSON.stringify(decisions)}\n` +
  `Playtest runs you judged: ${JSON.stringify(runs)}\n` +
  `Conversation so far: ${JSON.stringify(history)}\n` +
  `Backer says: "${message}"`,
], { type: 'OBJECT', required: ['reply'], properties: { reply: S, cap: S, conditions: S, cite_run: S } }, { key });

// The backer's own conditions, checked against the same frames the judge saw.
export const checkConditions = ({ conditions, promise, frames, key }) => askJSON([
  `You are a backer's personal agent. The creator's promise was judged kept. Your backer added their own conditions:\n"${conditions}"\n` +
  `Milestone promise: "${promise}"\nJudge ONLY from what is visible in these screenshots whether the backer's conditions are met. ` +
  `If a condition is about something this milestone does not cover, treat it as met.`,
  ...frames.flatMap(f => [`Frame ${f.i} (${f.label}):`, { png: f.png }]),
], { type: 'OBJECT', required: ['met', 'why'], properties: { met: { type: 'BOOLEAN' }, why: S } }, { key });
