/**
 * validate-coupon.js  (Netlify Functions v2)
 *
 * Checkout calls this to check whether a code the customer typed in is a
 * real, unused, unexpired coupon minted by generate-coupon.js.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS / WHY IT DOESN'T CALL KLAVIYO DIRECTLY
 * ---------------------------------------------------------------------------
 * Klaviyo's Coupon Codes API has no endpoint or filter that accepts the
 * code string itself — you can only fetch a coupon-code by its internal
 * Klaviyo ID, or list codes by coupon.id / profile.id / status / expires_at.
 * There's no "does CODE-4K7QRT exist?" call.
 *
 * So generate-coupon.js writes its own record to Netlify Blobs the moment
 * it mints a code (see that file for details). This function reads that
 * record — it's the source of truth checkout actually validates against.
 * Klaviyo itself is never called here.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS FILE GOES
 * ---------------------------------------------------------------------------
 * netlify/functions/validate-coupon.js
 * Live at:
 *   https://YOUR-SITE.netlify.app/.netlify/functions/validate-coupon
 *
 * ---------------------------------------------------------------------------
 * WHAT IT RETURNS
 * ---------------------------------------------------------------------------
 * 200 { valid: true, percent: 0.15 }               — good to apply
 * 200 { valid: false, reason: 'not_found' }        — never issued / typo
 * 200 { valid: false, reason: 'expired' }
 * 200 { valid: false, reason: 'already_used' }
 *
 * All the "invalid" cases return 200 (not 4xx) — an invalid code isn't a
 * request error, it's a normal answer the UI needs to render a message for.
 *
 * ---------------------------------------------------------------------------
 * FIXED DISCOUNT PERCENT
 * ---------------------------------------------------------------------------
 * Every code minted by generate-coupon.js gives the same discount. Set it
 * via env var so it's changed in one place (must match whatever your
 * SMS-signup messaging actually promises):
 *   COUPON_DISCOUNT_PERCENT = 0.15   (defaults to 0.15 = 15% off)
 */

import { getStore } from '@netlify/blobs';

const COUPON_STORE_NAME = 'sms-gate-coupons';

export default async (req) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  let body;
  try {
    body = await req.json();
  } catch (err) {
    return jsonResponse({ error: 'Request body must be valid JSON' }, 400, corsHeaders);
  }

  const rawCode = (body && body.code || '').trim();
  if (!rawCode) {
    return jsonResponse({ error: 'A coupon code is required' }, 400, corsHeaders);
  }
  // Codes are minted uppercase (CODE-XXXXXX) — normalize so a customer
  // typing lowercase still matches.
  const code = rawCode.toUpperCase();

  const percent = Number(process.env.COUPON_DISCOUNT_PERCENT) || 0.15;

  let record;
  try {
    const store = getStore(COUPON_STORE_NAME);
    record = await store.get(`coupon:${code}`, { type: 'json' });
  } catch (err) {
    console.error('Blobs lookup failed:', err);
    return jsonResponse({ error: 'Could not check coupon right now' }, 502, corsHeaders);
  }

  if (!record) {
    return jsonResponse({ valid: false, reason: 'not_found' }, 200, corsHeaders);
  }

  if (record.redeemed) {
    return jsonResponse({ valid: false, reason: 'already_used' }, 200, corsHeaders);
  }

  if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) {
    return jsonResponse({ valid: false, reason: 'expired' }, 200, corsHeaders);
  }

  return jsonResponse({ valid: true, percent }, 200, corsHeaders);
};

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: extraHeaders || { 'Content-Type': 'application/json' }
  });
}
