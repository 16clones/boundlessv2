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
 * 1. Content > Coupons > create a Coupon. Copy its Coupon ID.
 * 2. Settings > Account > API Keys > create a PRIVATE key with the
 *    `coupon-codes:write` scope.
 * 3. Netlify site dashboard > Site configuration > Environment variables:
 *      KLAVIYO_PRIVATE_KEY = pk_xxxxxxxxxxxx
 *      KLAVIYO_COUPON_ID   = ABC123
 * 4. Deploy, then point COUPON_ENDPOINT in boundless_v2.html at the live URL.
 *
 * ---------------------------------------------------------------------------
 * DEBUGGING "Could not create coupon code"
 * ---------------------------------------------------------------------------
 * This version returns Klaviyo's actual error detail in the JSON response
 * (visible in your browser's Network tab / console), instead of a generic
 * message. The most common causes, by status code:
 *
 *   401 Unauthorized       -> KLAVIYO_PRIVATE_KEY is wrong, or the key
 *                             doesn't have the `coupon-codes:write` scope.
 *   404 Not Found           -> KLAVIYO_COUPON_ID doesn't match a real coupon
 *                             in your account (double check you copied the
 *                             Coupon ID, not the coupon's name).
 *   400 Invalid input       -> unique_code format rejected, or a code
 *                             collision (astronomically rare with 6 random
 *                             chars, but possible if you're re-testing fast).
 *   500 missing configuration -> env vars aren't set on Netlify, or aren't
 *                             set on the specific deploy context you're
 *                             testing against (Production vs Preview/branch
 *                             deploys don't automatically inherit Production
 *                             env vars unless you scope them to "All").
 *
 * Once you see the real Klaviyo error in the response, it's usually obvious
 * which of these it is.
 */

export default async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const KLAVIYO_PRIVATE_KEY = process.env.KLAVIYO_PRIVATE_KEY;
  const KLAVIYO_COUPON_ID = process.env.KLAVIYO_COUPON_ID;

  const missing = [];
  if (!KLAVIYO_PRIVATE_KEY) missing.push('KLAVIYO_PRIVATE_KEY');
  if (!KLAVIYO_COUPON_ID) missing.push('KLAVIYO_COUPON_ID');
  if (missing.length) {
    console.error('Missing environment variables:', missing.join(', '));
    return jsonResponse({
      error: 'Server is missing Klaviyo configuration',
      missing
    }, 500);
  }

  // Generate a short, unique, human-typeable code, e.g. "SMS15-7K2P9Q".
  const uniqueCode = `SMS15-${generateRandomSuffix(6)}`;

  let klaviyoRes;
  try {
    klaviyoRes = await fetch('https://a.klaviyo.com/api/coupon-codes/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.api+json',
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_PRIVATE_KEY}`,
        'revision': '2026-04-15'
      },
      body: JSON.stringify({
        data: {
          type: 'coupon-code',
          attributes: {
            unique_code: uniqueCode
          },
          relationships: {
            coupon: {
              data: { type: 'coupon', id: KLAVIYO_COUPON_ID }
            }
          }
        }
      })
    });
  } catch (networkErr) {
    // fetch() itself threw — e.g. DNS/network failure reaching Klaviyo.
    console.error('Network error calling Klaviyo:', networkErr);
    return jsonResponse({
      error: 'Could not reach Klaviyo',
      detail: String(networkErr && networkErr.message || networkErr)
    }, 502);
  }

  if (!klaviyoRes.ok) {
    // Try to parse Klaviyo's structured error body; fall back to raw text
    // if it isn't valid JSON.
    let detail = null;
    let rawBody = null;
    try {
      rawBody = await klaviyoRes.text();
      const parsed = JSON.parse(rawBody);
      detail = parsed && parsed.errors ? parsed.errors : parsed;
    } catch (parseErr) {
      detail = rawBody;
    }

    console.error('Klaviyo coupon-code creation failed:', klaviyoRes.status, detail);

    return jsonResponse({
      error: 'Could not create coupon code',
      klaviyo_status: klaviyoRes.status,
      klaviyo_detail: detail,
      hint: hintForStatus(klaviyoRes.status),
      attempted_coupon_id: KLAVIYO_COUPON_ID
    }, 502);
  }

  return jsonResponse({ code: uniqueCode }, 200);
};

function hintForStatus(status) {
  if (status === 401) return 'Check that KLAVIYO_PRIVATE_KEY is correct and has the coupon-codes:write scope.';
  if (status === 404) return 'Check that KLAVIYO_COUPON_ID matches a real Coupon ID in your Klaviyo account (Content > Coupons).';
  if (status === 400) return 'Klaviyo rejected the request body — see klaviyo_detail above for the exact field it flagged.';
  return 'See klaviyo_detail above for specifics from Klaviyo.';
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
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
