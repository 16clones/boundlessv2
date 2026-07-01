/**
 * view-leads-function.js  (Netlify Functions v2)
 *
 * A simple password-protected page listing every phone number captured
 * by capture-lead-function.js, newest first.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS FILE GOES
 * ---------------------------------------------------------------------------
 * netlify/functions/view-leads-function.js
 * Live at:
 *   https://YOUR-SITE.netlify.app/.netlify/functions/view-leads-function?key=YOUR_KEY
 *
 * ---------------------------------------------------------------------------
 * ONE-TIME SETUP
 * ---------------------------------------------------------------------------
 * Netlify site dashboard > Site configuration > Environment variables:
 *   LEADS_ADMIN_KEY = pick-any-long-random-string
 *
 * Then visit the URL above with ?key=whatever-you-picked appended. Treat
 * that URL like a password — anyone with it can see every phone number
 * you've collected. Don't post it publicly or link to it from the site.
 *
 * If LEADS_ADMIN_KEY isn't set, this refuses every request (fails closed)
 * rather than leaving the page open.
 */

import { getStore } from '@netlify/blobs';

const LEADS_STORE_NAME = 'sms-gate-leads';

export default async (req) => {
  const ADMIN_KEY = process.env.LEADS_ADMIN_KEY;
  const url = new URL(req.url);
  const providedKey = url.searchParams.get('key');

  if (!ADMIN_KEY || !providedKey || providedKey !== ADMIN_KEY) {
    return new Response('Not authorized. Append ?key=YOUR_LEADS_ADMIN_KEY to the URL.', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  let leads = [];
  try {
    const store = getStore(LEADS_STORE_NAME);
    const { blobs } = await store.list({ prefix: 'lead:' });
    leads = await Promise.all(
      blobs.map(b => store.get(b.key, { type: 'json' }))
    );
    leads = leads.filter(Boolean).sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
  } catch (err) {
    console.error('Failed to list leads:', err);
    return new Response('Could not load leads right now.', {
      status: 502,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  const rows = leads.map(l => `
    <tr>
      <td>${escapeHtml(l.phone)}</td>
      <td>${escapeHtml(formatDate(l.firstSeenAt))}</td>
      <td>${escapeHtml(formatDate(l.lastSeenAt))}</td>
      <td>${l.count || 1}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>SMS gate leads</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#f6f5f2;color:#121212;padding:32px;}
  h1{font-size:18px;margin-bottom:4px;}
  .count{color:#5c5a55;font-size:13px;margin-bottom:20px;}
  table{border-collapse:collapse;width:100%;max-width:720px;background:#fff;}
  th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #d8d5cd;font-size:13px;}
  th{color:#5c5a55;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:0.05em;}
  tr:last-child td{border-bottom:none;}
</style>
</head>
<body>
  <h1>SMS gate signups</h1>
  <div class="count">${leads.length} number${leads.length===1?'':'s'} captured</div>
  <table>
    <thead><tr><th>Phone</th><th>First seen</th><th>Last seen</th><th>Times submitted</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">No signups yet.</td></tr>'}</tbody>
  </table>
</body>
</html>`;

  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
};

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
