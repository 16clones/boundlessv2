/**
 * generate-coupon.js  (Netlify Functions v2)
 *
 * Backend endpoint that mints a real, unique Klaviyo coupon code and returns
 * it to the site. This MUST run server-side — never in the browser — because
 * it uses your PRIVATE Klaviyo API key.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS FILE GOES
 * ---------------------------------------------------------------------------
 * Netlify Functions v2 auto-detects files placed at:
 *   netlify/functions/generate-coupon.js
 * Live at:
 *   https://YOUR-SITE.netlify.app/.netlify/functions/generate-coupon
 *
 * ---------------------------------------------------------------------------
 * ONE-TIME SETUP IN KLAVIYO
 * ---------------------------------------------------------------------------
 * 1. Create a Coupon via the Coupons API (NOT the dashboard's "Uploaded
 *    Coupons" flow — that requires a CSV). See prior setup notes for the
 *    one-time curl command. Copy the returned Coupon `id`.
 * 2. Settings > Account > API Keys > create a PRIVATE key with scopes:
 *      coupon-codes:write
 *      profiles:write
 *      profiles:read
 * 3. Netlify site dashboard > Site configuration > Environment variables:
 *      KLAVIYO_PRIVATE_KEY   = pk_xxxxxxxxxxxx
 *      KLAVIYO_COUPON_ID     = SMS15   (or whatever your Coupon's id is)
 *      COUPON_EXPIRY_DAYS    = 30      (optional, defaults to 30)
 *      ALLOWED_ORIGIN        = https://yoursite.com   (optional, defaults to *)
 *    Also add, since the Coupon ID isn't a real secret and will otherwise
 *    trip Netlify's secret scanner if it happens to match other text:
 *      SECRETS_SCAN_OMIT_KEYS = KLAVIYO_COUPON_ID
 * 4. Deploy, then point COUPON_ENDPOINT in boundless_v2.html at the live URL.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS VERSION ADDS OVER THE BASIC ONE
 * ---------------------------------------------------------------------------
 * - Idempotency: if a phone number already has a code (stored as a profile
 *   property), that same code is returned instead of minting a new one.
 *   This is the main abuse guard — without it, anyone could resubmit the
 *   form forever and rack up unlimited discount codes.
 * - CORS: proper preflight (OPTIONS) handling + Access-Control-Allow-Origin
 *   header, so the browser fetch doesn't silently fail if the site and
 *   function ever end up on different origins.
 * - Input validation: rejects requests without a plausible phone number
 *   before spending a Klaviyo API call on them.
 * - Collision retry: if a generated code happens to collide with an
 *   existing one (extremely unlikely with 6 random chars, but not
 *   impossible), it retries with a fresh code up to 3 times.
 * - Expiration: codes are created with an expiry date (default 30 days,
 *   configurable via COUPON_EXPIRY_DAYS) instead of living forever.
 * - Profile tracking: the assigned code is written back onto the person's
 *   Klaviyo profile as a custom property, so you can look up who has what
 *   code directly in the dashboard (Audience > Profiles > search phone).
 *
 * Not covered (out of scope for a stateless function without a database):
 * - IP-based rate limiting. Real abuse protection beyond "one code per
 *   phone number" would need persistent storage across invocations.
 *
 * ---------------------------------------------------------------------------
 * UPDATE: NOW WRITES TO NETLIFY BLOBS (needed for checkout validation)
 * ---------------------------------------------------------------------------
 * Klaviyo's Coupon Codes API has no way to look up a code by the code
 * string itself (its filters only support expires_at, status, coupon.id,
 * and profile.id — never the code text a customer types). So checkout
 * can't ask Klaviyo "is CODE-4K7QRT valid?" directly.
 *
 * To make validate-coupon-function.js and redeem-coupon-function.js work,
 * this function now also writes its own record to Netlify Blobs the
 * moment it mints a code:
 *   key:   coupon:<CODE>
 *   value: { phone, expiresAt, redeemed: false, createdAt }
 * That record is the source of truth checkout validates against.
 *
 * Requires the @netlify/blobs package. If you're deploying via git push,
 * add it to your package.json:
 *   npm install @netlify/blobs
 * Blob stores are created automatically on first write — no separate
 * provisioning step needed.
 */

import { getStore } from '@netlify/blobs';

const KLAVIYO_REVISION = '2026-04-15';
const COUPON_STORE_NAME = 'sms-gate-coupons';

export default async (req) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Handle CORS preflight.
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  const KLAVIYO_PRIVATE_KEY = process.env.KLAVIYO_PRIVATE_KEY;
  const KLAVIYO_COUPON_ID = process.env.KLAVIYO_COUPON_ID;
  const COUPON_EXPIRY_DAYS = Number(process.env.COUPON_EXPIRY_DAYS) || 30;

  const missing = [];
  if (!KLAVIYO_PRIVATE_KEY) missing.push('KLAVIYO_PRIVATE_KEY');
  if (!KLAVIYO_COUPON_ID) missing.push('KLAVIYO_COUPON_ID');
  if (missing.length) {
    console.error('Missing environment variables:', missing.join(', '));
    return jsonResponse({
      error: 'Server is missing Klaviyo configuration',
      missing
    }, 500, corsHeaders);
  }

  // ---- 1) Validate input ----
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

  const authHeaders = {
    'Content-Type': 'application/vnd.api+json',
    'Authorization': `Klaviyo-API-Key ${KLAVIYO_PRIVATE_KEY}`,
    'revision': KLAVIYO_REVISION
  };

  // ---- 2) Idempotency check: does this phone already have a code? ----
  try {
    const existingCode = await findExistingCode(phone, authHeaders);
    if (existingCode) {
      return jsonResponse({ code: existingCode, reused: true }, 200, corsHeaders);
    }
  } catch (lookupErr) {
    // Non-fatal — if the lookup itself fails, we fall through and mint a
    // new code rather than blocking the visitor entirely. Logged for
    // visibility, but not surfaced as an error to the client.
    console.error('Idempotency lookup failed (continuing anyway):', lookupErr);
  }

  // ---- 3) Mint a coupon code, retrying on rare collisions ----
  const expiresAt = new Date(Date.now() + COUPON_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let code = null;
  let lastError = null;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const candidate = `CODE-${generateRandomSuffix(6)}`;

    let klaviyoRes;
    try {
      klaviyoRes = await fetch('https://a.klaviyo.com/api/coupon-codes/', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          data: {
            type: 'coupon-code',
            attributes: {
              unique_code: candidate,
              expires_at: expiresAt
            },
            relationships: {
              coupon: { data: { type: 'coupon', id: KLAVIYO_COUPON_ID } }
            }
          }
        })
      });
    } catch (networkErr) {
      console.error('Network error calling Klaviyo (coupon-codes):', networkErr);
      return jsonResponse({
        error: 'Could not reach Klaviyo',
        detail: String(networkErr && networkErr.message || networkErr)
      }, 502, corsHeaders);
    }

    if (klaviyoRes.ok) {
      code = candidate;
      break;
    }

    const detail = await safeParseError(klaviyoRes);
    lastError = { status: klaviyoRes.status, detail };

    const isCollision = klaviyoRes.status === 400 &&
      JSON.stringify(detail).toLowerCase().includes('already exist');

    if (!isCollision) {
      // Not a collision — retrying won't help (bad coupon ID, auth issue,
      // etc). Fail fast with the real error.
      console.error('Klaviyo coupon-code creation failed (non-retryable):', klaviyoRes.status, detail);
      return jsonResponse({
        error: 'Could not create coupon code',
        klaviyo_status: klaviyoRes.status,
        klaviyo_detail: detail,
        hint: hintForStatus(klaviyoRes.status),
        attempted_coupon_id: KLAVIYO_COUPON_ID
      }, 502, corsHeaders);
    }

    console.warn(`Coupon code collision on attempt ${attempt}, retrying...`);
  }

  if (!code) {
    console.error('Exhausted retries creating coupon code:', lastError);
    return jsonResponse({
      error: 'Could not create a unique coupon code after multiple attempts',
      klaviyo_status: lastError && lastError.status,
      klaviyo_detail: lastError && lastError.detail
    }, 502, corsHeaders);
  }

  // ---- 4) Record the code in our own store so checkout can validate it ----
  // (Klaviyo has no "look up by code string" API — see note at top of file.)
  try {
    const store = getStore(COUPON_STORE_NAME);
    await store.setJSON(`coupon:${code}`, {
      phone,
      expiresAt,
      redeemed: false,
      createdAt: new Date().toISOString()
    });
  } catch (blobErr) {
    // Non-fatal — the Klaviyo code is still valid even if we fail to
    // record it locally, but checkout won't be able to validate it until
    // this succeeds. Logged for investigation.
    console.error('Failed to write coupon record to Blobs (checkout validation may fail for this code):', blobErr);
  }

  // ---- 5) Write the code back onto the profile for tracking/idempotency ----
  try {
    await tagProfileWithCode(phone, code, authHeaders);
  } catch (tagErr) {
    // Non-fatal — the code is already valid and usable even if we fail to
    // record it on the profile. Logged so it can be investigated.
    console.error('Failed to tag profile with assigned code (code is still valid):', tagErr);
  }

  return jsonResponse({ code }, 200, corsHeaders);
};

/**
 * Looks up a profile by phone number and returns a previously-assigned
 * coupon code, if any, from its custom properties.
 */
async function findExistingCode(phone, authHeaders) {
  const filter = encodeURIComponent(`equals(phone_number,"${phone}")`);
  const res = await fetch(`https://a.klaviyo.com/api/profiles/?filter=${filter}`, {
    method: 'GET',
    headers: authHeaders
  });

  if (!res.ok) {
    throw new Error(`Profile lookup failed with status ${res.status}`);
  }

  const data = await res.json();
  const profile = data && data.data && data.data[0];
  const props = profile && profile.attributes && profile.attributes.properties;
  return (props && props.sms_gate_coupon_code) || null;
}

/**
 * Upserts a profile by phone number and stores the assigned code as a
 * custom property, so it's visible in the Klaviyo dashboard and so future
 * requests from the same number are idempotent.
 */
async function tagProfileWithCode(phone, code, authHeaders) {
  const res = await fetch('https://a.klaviyo.com/api/profile-import/', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      data: {
        type: 'profile',
        attributes: {
          phone_number: phone,
          properties: {
            sms_gate_coupon_code: code,
            sms_gate_coupon_assigned_at: new Date().toISOString()
          }
        }
      }
    })
  });

  if (!res.ok) {
    const detail = await safeParseError(res);
    throw new Error(`Profile tagging failed with status ${res.status}: ${JSON.stringify(detail)}`);
  }
}

async function safeParseError(res) {
  let rawBody = null;
  try {
    rawBody = await res.text();
    const parsed = JSON.parse(rawBody);
    return parsed && parsed.errors ? parsed.errors : parsed;
  } catch (parseErr) {
    return rawBody;
  }
}

function hintForStatus(status) {
  if (status === 401) return 'Check that KLAVIYO_PRIVATE_KEY is correct and has the coupon-codes:write scope.';
  if (status === 404) return 'Check that KLAVIYO_COUPON_ID matches a real Coupon ID in your Klaviyo account (Content > Coupons > API Coupons).';
  if (status === 400) return 'Klaviyo rejected the request body — see klaviyo_detail above for the exact field it flagged.';
  return 'See klaviyo_detail above for specifics from Klaviyo.';
}

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: extraHeaders || { 'Content-Type': 'application/json' }
  });
}

function generateRandomSuffix(length) {
  // Avoids visually ambiguous characters (0/O, 1/I/L).
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
