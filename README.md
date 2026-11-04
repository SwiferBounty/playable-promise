# Playable Promise

**Game pre-orders that pay out one playable milestone at a time.** Backers save their PayPal once and pay $0 up front. Each time the developer ships a milestone build, an AI playtest agent opens it in a real headless browser and plays it. Backers are charged for that milestone only if the agent beats its acceptance test. A broken build charges nobody, and every charge in the ledger links to the playtest run that earned it.

Built for the PayPal AI Hackathon (2026).

## How it works

1. **Pre-order.** Pledging creates a PayPal vault setup token (`/v3/vault/setup-tokens`), and the backer approves it on PayPal. When they return, a payment token is created and the backer becomes active. Nothing is charged.
2. **Ship a build.** The creator submits a milestone build. Milestone N can be submitted only after N-1 is verified.
3. **Agent playtest.** `agent/playtest.js` loads the build in Chromium with Playwright and runs a perception-action loop. It reads the game state, picks inputs (approach, attack, jump over incoming shots), and steps the game. Then it checks every acceptance test from M1 to MN, so a regression in an earlier milestone fails too. Crashes are caught and reported.
4. **Charge or don't.** On a pass, every active backer is charged the milestone's tranche. The charge is a merchant-initiated Orders v2 capture against the saved wallet (`payment_source.paypal.vault_id`, stored credential `MERCHANT / SUBSEQUENT / UNSCHEDULED`). The `PayPal-Request-Id` is built from the backer and the milestone, so a retry never double-charges. On a fail, nobody is charged and the verdict says why.
5. **Ledger.** An AG Grid ledger shows each backer against each milestone, with the payment status and a link to the evidence screenshot.

## The demo game

`games/boss-rush` is a tiny canvas game with four builds (`?build=m1|m2|m3-broken|m3`):

| Build | M1: level 1 | M2: boss phases 1-2 | M3: phase 3 + ending |
|---|---|---|---|
| m1 | pass | fail (no boss) | fail |
| m2 | pass | pass | fail (boss stuck in phase 3) |
| m3-broken | pass | pass | **crash** in phase 3 |
| m3 | pass | pass | pass |

## Run it

```bash
npm install
npx playwright install chromium   # or set CHROMIUM_PATH to a system Chromium
export PAYPAL_CLIENT_ID=...        # sandbox REST app with "Save payment methods" enabled
export PAYPAL_CLIENT_SECRET=...
export PUBLIC_URL=http://localhost:3000
npm start
```

To run the agent by itself: `npm run playtest -- m3-broken 3`.

## Stack

Node 22 + Express, SQLite (`node:sqlite`), Playwright + Chromium, PayPal Vault v3 + Orders v2 (sandbox), AG Grid Community.

## License

MIT
