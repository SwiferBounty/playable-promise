// Each backer gets their own agent. It holds their saved PayPal wallet and a mandate:
//   - pay a tranche only when the playtest proves the promise from the screen,
//   - never spend past the backer's cap,
//   - if a milestone is overdue, walk away: delete the saved wallet so nothing more can be charged.
// Every decision is written down with its reason, so the backer can audit their money.

export function decide(backer, milestone, report, spent) {
  if (!report.passed) return { action: 'hold', reason: report.tamper
    ? `Refused: the build claimed M${milestone.n} was done, but the screen showed otherwise. Not paying for a promise I could not see kept.`
    : report.crashed ? `Held: the build crashed (${report.crashed}). Waiting for a working build.`
    : `Held: the promise "${milestone.test}" was not kept on screen. Waiting for a better build.` };
  const amount = Number(milestone.amount);
  if (backer.cap && spent + amount > Number(backer.cap))
    return { action: 'hold', reason: `Held: paying $${milestone.amount} would pass your $${backer.cap} cap.` };
  return { action: 'pay', reason: `Paying $${milestone.amount}: I watched M${milestone.n} work myself. ${report.ai?.summary || ''}`.trim() };
}

// Run on every clock tick: any backer whose next milestone is overdue gets their wallet released.
export function overdue(milestones, today) {
  return milestones.find(m => m.status !== 'verified' && m.due && m.due < today) || null;
}
