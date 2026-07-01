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
 * in your site's repo root. No extra config needed — Netlify wires up the
 * route automatically at:
 *   https://YOUR-SITE.netlify.app/.netlify/functions/generate-coupon
 *
 * ---------------------------------------------------------------------------
 * ONE-TIME SETUP IN KLAVIYO
 * ---------------------------------------------------------------------------
 * 1. In Klaviyo, go to Content > Coupons and create a Coupon (this holds the
 *    discount definition — e.g. "10% off", one-time use, expiration, etc).
 *    Copy its Coupon ID.
 * 2. Go to Settings > Account > API Keys and create a PRIVATE API key with
 *    the `coupon-codes:write` scope. Never put this key in front-end code.
 * 3. In your Netlify site dashboard: Site configuration > Environment
 *    variables, add:
 *      KLAVIYO_PRIVATE_KEY = pk_xxxxxxxxxxxx
 *      KLAVIYO_COUPON_ID   = ABC123
 * 4. Deploy (git push, or `netlify deploy`), then set COUPON_ENDPOINT in
 *    boundless_v2.html to:
 *      https://YOUR-SITE.netlify.app/.netlify/functions/generate-coupon
 */

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const KLAVIYO_PRIVATE_KEY = process.env.KLAVIYO_PRIVATE_KEY;
  const KLAVIYO_COUPON_ID = process.env.KLAVIYO_COUPON_ID;

  if (!KLAVIYO_PRIVATE_KEY || !KLAVIYO_COUPON_ID) {
    return new Response(JSON.stringify({ error: 'Server is missing Klaviyo configuration' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Generate a short, unique, human-typeable code, e.g. "SMS15-7K2P9Q".
  const uniqueCode = `SMS15-${generateRandomSuffix(6)}`;

  try {
    const klaviyoRes = await fetch('https://a.klaviyo.com/api/coupon-codes/', {
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

    if (!klaviyoRes.ok) {
      const errBody = await klaviyoRes.text();
      console.error('Klaviyo coupon-code creation failed:', klaviyoRes.status, errBody);
      return new Response(JSON.stringify({ error: 'Could not create coupon code' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ code: uniqueCode }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('Error creating coupon code:', err);
    return new Response(JSON.stringify({ error: 'Unexpected server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

function generateRandomSuffix(length) {
  // Avoids visually ambiguous characters (0/O, 1/I/L).
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
