// PayPal REST (sandbox by default). Uses PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET for OAuth.
// If they are unset, requests go out without an Authorization header (for proxies that inject it).
const BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
const { PAYPAL_CLIENT_ID: ID, PAYPAL_CLIENT_SECRET: SECRET } = process.env;
let tok = null, exp = 0;

async function authHeader() {
  if (!ID || !SECRET) return {};
  if (!tok || Date.now() > exp) {
    const r = await fetch(`${BASE}/v1/oauth2/token`, {
      method: 'POST', body: 'grant_type=client_credentials',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64') } });
    const j = await r.json(); if (!r.ok) throw new Error(`PayPal auth failed: ${j.error_description}`);
    tok = j.access_token; exp = Date.now() + (j.expires_in - 60) * 1000;
  }
  return { Authorization: `Bearer ${tok}` };
}

async function api(method, path, body, idem = crypto.randomUUID()) {
  const r = await fetch(BASE + path, { method, body: body && JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'PayPal-Request-Id': idem, ...(await authHeader()) } });
  const t = await r.text(); const j = t ? JSON.parse(t) : {};
  if (!r.ok) throw Object.assign(new Error(`PayPal ${r.status} ${method} ${path}: ${j.message || j.name}`), { details: j });
  return j;
}

// Pre-order: save the backer's PayPal wallet with nothing charged today.
export const createSetupToken = (returnUrl, cancelUrl) => api('POST', '/v3/vault/setup-tokens', {
  payment_source: { paypal: { usage_type: 'MERCHANT', customer_type: 'CONSUMER', permit_multiple_payment_tokens: true,
    description: 'Playable Promise: pay per verified milestone',
    experience_context: { return_url: returnUrl, cancel_url: cancelUrl, brand_name: 'Playable Promise', shipping_preference: 'NO_SHIPPING' } } } });

export const createPaymentToken = setupTokenId => api('POST', '/v3/vault/payment-tokens',
  { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } });

// A milestone passed: charge that tranche against the saved wallet (customer not present).
// The idempotency key makes a retried charge for the same backer and milestone safe.
export const chargeTranche = ({ vaultId, amount, milestone, title, backerId, runId }) => api('POST', '/v2/checkout/orders', {
  intent: 'CAPTURE',
  purchase_units: [{ reference_id: `M${milestone}`, custom_id: `${backerId}:${runId}`,
    description: `Milestone ${milestone} (${title}) verified by playtest run ${runId}`.slice(0, 127),
    amount: { currency_code: 'USD', value: amount } }],
  payment_source: { paypal: { vault_id: vaultId,
    stored_credential: { payment_initiator: 'MERCHANT', usage: 'SUBSEQUENT', payment_type: 'UNSCHEDULED' } } },
}, `pp-${backerId}-m${milestone}`);

export const refundCapture = captureId => api('POST', `/v2/payments/captures/${captureId}/refund`, {});
