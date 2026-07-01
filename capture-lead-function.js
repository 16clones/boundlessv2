/**
 * capture-lead-function.js  (Netlify Functions v2)
 *
 * Stores a phone number the moment someone signs up on the coming-soon
 * gate — completely independent of Klaviyo. This exists so signups are
 * never lost if Klaviyo (subscription or coupon minting) is down, slow,
 * or misconfigured.
 *
 * Pairs with view-leads-function.js, which reads these back out as a
 * simple password-protected page.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS FILE GOES
 * ---------------------------------------------------------------------------
 * netlify/functions/capture-lead-function.js
 *
 * ---------------------------------------------------------------------------
 * DEDUPING
 * ---------------------------------------------------------------------------
 * Keyed by phone number, so resubmitting the form doesn't create
 * duplicate rows — it just bumps a count and updates lastSeenAt.
 */

import { getStore } from '@netlify/blobs';

const LEADS_STORE_NAME = 'sms-gate-leads';

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

  const phone = (body && body.phone || '').trim();
  const phoneValid = /^\+[1-9]\d{7,14}$/.test(phone);
  if (!phoneValid) {
    return jsonResponse({ error: 'A valid E.164 phone number is required (e.g. +14079829002)' }, 400, corsHeaders);
  }

  try {
    const store = getStore(LEADS_STORE_NAME);
    const key = `lead:${phone}`;
    const existing = await store.get(key, { type: 'json' });

    const now = new Date().toISOString();
    await store.setJSON(key, {
      phone,
      firstSeenAt: existing ? existing.firstSeenAt : now,
      lastSeenAt: now,
      count: existing ? (existing.count || 1) + 1 : 1
    });
  } catch (err) {
    console.error('Failed to store lead:', err);
    return jsonResponse({ error: 'Could not save your number right now' }, 502, corsHeaders);
  }

  return jsonResponse({ captured: true }, 200, corsHeaders);
};

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: extraHeaders || { 'Content-Type': 'application/json' }
  });
}
