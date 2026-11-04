// PayPal REST (sandbox by default). OAuth uses the client id and secret.
// If they are unset, requests go out without an Authorization header (for proxies that inject it).
// makePayPal() works in Node and in Cloudflare Workers; the named exports read process.env (Node).
export function makePayPal({ id, secret, base = 'https://api-m.sandbox.paypal.com' } = {}) {
  let tok = null, exp = 0;
  async function authHeader() {
    if (!id || !secret) return {};
    if (!tok || Date.now() > exp) {
      const r = await fetch(`${base}/v1/oauth2/token`, {
        method: 'POST', body: 'grant_type=client_credentials',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(`${id}:${secret}`) } });
      const j = await r.json(); if (!r.ok) throw new Error(`PayPal auth failed: ${j.error_description}`);
      tok = j.access_token; exp = Date.now() + (j.expires_in - 60) * 1000;
    }
    return { Authorization: `Bearer ${tok}` };
  }
  async function api(method, path, body, idem = crypto.randomUUID()) {
    const r = await fetch(base + path, { method, body: body && JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'PayPal-Request-Id': idem, ...(await authHeader()) } });
    const t = await r.text(); const j = t ? JSON.parse(t) : {};
    if (!r.ok) throw Object.assign(new Error(`PayPal ${r.status} ${method} ${path}: ${j.message || j.name}`), { details: j });
    return j;
  }
  return {
    // Pre-order: save the backer's PayPal wallet with nothing charged today.
    createSetupToken: (returnUrl, cancelUrl) => api('POST', '/v3/vault/setup-tokens', {
      payment_source: { paypal: { usage_type: 'MERCHANT', customer_type: 'CONSUMER', permit_multiple_payment_tokens: true,
        description: 'Playable Promise: pay per verified milestone',
        experience_context: { return_url: returnUrl, cancel_url: cancelUrl, brand_name: 'Playable Promise', shipping_preference: 'NO_SHIPPING' } } } }),
    createPaymentToken: setupTokenId => api('POST', '/v3/vault/payment-tokens',
      { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } }),
    // A milestone passed: charge that tranche against the saved wallet (customer not present).
    // The idempotency key makes a retried charge for the same backer and milestone safe.
    chargeTranche: ({ vaultId, amount, milestone, title, backerId, runId }) => api('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: `M${milestone}`, custom_id: `${backerId}:${runId}`,
        description: `Milestone ${milestone} (${title}) verified by playtest run ${runId}`.slice(0, 127),
        amount: { currency_code: 'USD', value: amount } }],
      payment_source: { paypal: { vault_id: vaultId,
        stored_credential: { payment_initiator: 'MERCHANT', usage: 'SUBSEQUENT', payment_type: 'UNSCHEDULED' } } },
    }, `pp-${backerId}-m${milestone}`),
    refundCapture: captureId => api('POST', `/v2/payments/captures/${captureId}/refund`, {}),
    // Release the creator's share once backers have paid for a verified milestone.
    payoutCreator: ({ email, amount, milestone, runId }) => api('POST', '/v1/payments/payouts', {
      sender_batch_header: { sender_batch_id: `pp-m${milestone}-${runId}`, email_subject: `Milestone ${milestone} verified: you've been paid`,
        email_message: `Your backers' agents verified milestone ${milestone} (playtest run ${runId}).` },
      items: [{ recipient_type: 'EMAIL', receiver: email, amount: { value: amount, currency: 'USD' },
        note: `Milestone ${milestone} verified by playtest run ${runId}`, sender_item_id: `m${milestone}` }],
    }, `payout-m${milestone}-${runId}`),
    // The backer's agent walks away: delete the saved wallet so it can never be charged again.
    deletePaymentToken: id => api('DELETE', `/v3/vault/payment-tokens/${id}`),
  };
}

const env = globalThis.process?.env || {};
const node = makePayPal({ id: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, base: env.PAYPAL_API_BASE });
export const { createSetupToken, createPaymentToken, chargeTranche, refundCapture, payoutCreator, deletePaymentToken } = node;
