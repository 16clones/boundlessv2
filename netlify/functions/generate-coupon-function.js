/**
 * generate-coupon-function.js
 *
 * Backend endpoint that mints a real, unique Klaviyo coupon code and returns
 * it to the site. This MUST run server-side (Vercel/Netlify function, AWS
 * Lambda, a small Express server, etc) — never in the browser — because it
 * uses your PRIVATE Klaviyo API key.
 *
 * ---------------------------------------------------------------------------
 * ONE-TIME SETUP IN KLAVIYO
 * ---------------------------------------------------------------------------
 * 1. In Klaviyo, go to Content > Coupons and create a Coupon (this holds the
 *    discount definition — e.g. "10% off", one-time use, expiration, etc).
 *    Copy its Coupon ID.
 * 2. Go to Settings > Account > API Keys and create a PRIVATE API key with
 *    the `coupon-codes:write` scope. Never put this key in front-end code.
 * 3. Set the two values below as environment variables on whatever platform
 *    you deploy this function to (Vercel/Netlify/etc call this "Environment
 *    Variables" in project settings):
 *      KLAVIYO_PRIVATE_KEY = pk_xxxxxxxxxxxx
 *      KLAVIYO_COUPON_ID   = ABC123
 * 4. Deploy this function, then set COUPON_ENDPOINT in boundless_v2.html to
 *    its live URL (e.g. https://yoursite.vercel.app/api/generate-coupon).
 *
 * ---------------------------------------------------------------------------
 * DEPLOY OPTIONS
 * ---------------------------------------------------------------------------
 * Vercel: drop this file at /api/generate-coupon.js in a Vercel project,
 *         `vercel deploy`, done — Vercel wires up the route automatically.
 * Netlify: same idea under /netlify/functions/generate-coupon.js, but the
 *         handler signature differs slightly (see Netlify docs).
 * Node/Express: wrap the handler body in an app.post() route — see the
 *         commented block at the bottom of this file.
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const KLAVIYO_PRIVATE_KEY = process.env.KLAVIYO_PRIVATE_KEY;
  const KLAVIYO_COUPON_ID = process.env.KLAVIYO_COUPON_ID;

  if (!KLAVIYO_PRIVATE_KEY || !KLAVIYO_COUPON_ID) {
    return res.status(500).json({ error: 'Server is missing Klaviyo configuration' });
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
      return res.status(502).json({ error: 'Could not create coupon code' });
    }

    return res.status(200).json({ code: uniqueCode });
  } catch (err) {
    console.error('Error creating coupon code:', err);
    return res.status(500).json({ error: 'Unexpected server error' });
  }
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

/* ---------------------------------------------------------------------------
 * PLAIN NODE / EXPRESS VERSION
 * ---------------------------------------------------------------------------
 * If you're not using Vercel/Netlify, wrap the same logic in an Express
 * route instead:
 *
 *   import express from 'express';
 *   const app = express();
 *   app.use(express.json());
 *
 *   app.post('/api/generate-coupon', async (req, res) => {
 *     // ... same body as handler() above ...
 *   });
 *
 *   app.listen(3000);
 * ------------------------------------------------------------------------- */
