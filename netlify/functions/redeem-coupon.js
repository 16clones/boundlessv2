/**
 * redeem-coupon.js  (Netlify Functions v2)
 *
 * Call this the moment an order is actually placed — never when a code is
 * merely typed into the discount box. It flips the code's Blobs record to
 * redeemed:true so it can never be applied again.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS FILE GOES
 * ---------------------------------------------------------------------------
 * netlify/functions/redeem-coupon.js
 * Live at:
 *   https://YOUR-SITE.netlify.app/.netlify/functions/redeem-coupon
 *
 * ---------------------------------------------------------------------------
 * IMPORTANT — READ THIS BEFORE YOU CONNECT A REAL PAYMENT PROCESSOR
 * ---------------------------------------------------------------------------
 * boundless_v2.html's current placeOrder() is a front-end simulation —
 * there's no real payment gateway yet, so this function is only as
 * trustworthy as the browser's willingness to call it. A determined person
 * could open devtools and skip the call.
 *
 * That's an acceptable stopgap for a pre-launch/demo site. Once you connect
 * a real processor (Shopify, Stripe, etc.), move this call to that
 * processor's order-confirmation webhook instead of calling it from the
 * client — a webhook fires from the payment provider's server after money
 * has actually moved, so it can't be skipped or spoofed the way a client-
 * side fetch can.
 *
 * ---------------------------------------------------------------------------
 * ON RACE CONDITIONS
 * ---------------------------------------------------------------------------
 * This does a read-then-write against Blobs rather than a true atomic
 * compare-and-swap. At real-world volumes for a single-use SMS-signup
 * code, two simultaneous redemption attempts for the *same* code are
 * extremely unlikely — but if that matters for your launch volume, use
 * Blobs' `onlyIfMatch` (etag) option on the write and retry on conflict.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT RETURNS
 * ---------------------------------------------------------------------------
 * 200 { redeemed: true }                              — success
 * 200 { redeemed: false, reason: 'not_found' }         — unknown code
 * 200 { redeemed: false, reason: 'already_used' }      — someone beat you to it
 * 200 { redeemed: false, reason: 'expired' }
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
  const code = rawCode.toUpperCase();

  const store = getStore(COUPON_STORE_NAME);
  const key = `coupon:${code}`;

  let record;
  try {
    record = await store.get(key, { type: 'json' });
  } catch (err) {
    console.error('Blobs lookup failed:', err);
    return jsonResponse({ error: 'Could not redeem coupon right now' }, 502, corsHeaders);
  }

  if (!record) {
    return jsonResponse({ redeemed: false, reason: 'not_found' }, 200, corsHeaders);
  }
  if (record.redeemed) {
    return jsonResponse({ redeemed: false, reason: 'already_used' }, 200, corsHeaders);
  }
  if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) {
    return jsonResponse({ redeemed: false, reason: 'expired' }, 200, corsHeaders);
  }

  try {
    await store.setJSON(key, {
      ...record,
      redeemed: true,
      redeemedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Failed to write redemption:', err);
    return jsonResponse({ error: 'Could not redeem coupon right now' }, 502, corsHeaders);
  }

  return jsonResponse({ redeemed: true }, 200, corsHeaders);
};

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: extraHeaders || { 'Content-Type': 'application/json' }
  });
}
