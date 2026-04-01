/**
 * Expense Logger — Cloudflare Worker Proxy
 *
 * Holds all API keys server-side. The browser never sees them.
 *
 * Secrets (set via GitHub Actions or `wrangler secret put`):
 *   STREAMTIME_KEY    — Streamtime bearer token
 *   GEMINI_KEY        — Google AI Studio API key
 *   GOOGLE_CLIENT_ID  — Google OAuth Client ID (safe to expose, but convenient here)
 *   DRIVE_FOLDER_ID   — Google Drive folder ID (root receipts folder)
 *   ALLOWED_ORIGIN    — e.g. https://your-org.github.io (optional but recommended)
 *
 * Endpoints:
 *   GET  /                — health check
 *   GET  /config          — returns non-sensitive config to the browser
 *   POST /jobs            — list active Streamtime jobs
 *   POST /expenses        — create a logged expense in Streamtime
 *   POST /extract         — extract receipt details via Gemini
 *   POST /companies/search — search Streamtime companies by name (fuzzy)
 *   POST /companies/create — create a new company in Streamtime
 */

const EXTRACT_PROMPT = `Extract the expense details from this receipt or invoice. Return ONLY a valid JSON object — no markdown, no code fences, no explanation.

{
  "date": "YYYY-MM-DD",
  "supplier": "Vendor or company name",
  "itemName": "Brief description of what was purchased",
  "reference": "Invoice or receipt number, or null if not visible",
  "amountExGST": 0.00,
  "gstAmount": 0.00,
  "totalIncGST": 0.00
}

Rules:
- All amounts must be numbers, not strings
- If GST is not itemised separately: assume 10% GST is included in the total
  (amountExGST = total / 1.1 rounded to 2 decimal places; gstAmount = total − amountExGST)
- If no GST applies: set gstAmount to 0 and amountExGST equal to totalIncGST
- If the date is ambiguous or missing, use today: __TODAY__
- Currency is AUD — do not include it in the JSON`;

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

function errorResponse(message, status = 500, origin = '*') {
  return jsonResponse({ error: message }, status, origin);
}

async function streamtimePassthrough(url, body, env, origin) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STREAMTIME_KEY}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ─────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Optional origin restriction
    if (env.ALLOWED_ORIGIN) {
      const allowed = env.ALLOWED_ORIGIN.split(',').map(s => s.trim());
      if (!allowed.includes('*') && !allowed.includes(origin)) {
        return errorResponse('Forbidden', 403, origin);
      }
    }

    try {
      // ── GET / — health check ──────────────────────────────────────
      if (url.pathname === '/' && request.method === 'GET') {
        return jsonResponse({
          status: 'ok',
          endpoints: ['/config', '/jobs', '/expenses', '/extract', '/companies/search', '/companies/all', '/companies/create'],
        }, 200, origin);
      }

      // ── GET /config ───────────────────────────────────────────────
      if (url.pathname === '/config' && request.method === 'GET') {
        return jsonResponse({
          googleClientId: env.GOOGLE_CLIENT_ID || '',
          driveFolderId:  env.DRIVE_FOLDER_ID  || '',
        }, 200, origin);
      }

      // ── POST /jobs ────────────────────────────────────────────────
      if (url.pathname === '/jobs' && request.method === 'POST') {
        if (!env.STREAMTIME_KEY) return errorResponse('STREAMTIME_KEY not configured', 500, origin);
        const body = await request.text();
        return streamtimePassthrough(
          'https://api.streamtime.net/v1/search?search_view=7&include_statistics=false',
          body, env, origin
        );
      }

      // ── POST /expenses ────────────────────────────────────────────
      if (url.pathname === '/expenses' && request.method === 'POST') {
        if (!env.STREAMTIME_KEY) return errorResponse('STREAMTIME_KEY not configured', 500, origin);
        const body = await request.text();
        return streamtimePassthrough(
          'https://api.streamtime.net/v1/logged_expenses',
          body, env, origin
        );
      }

      // ── POST /companies/search — fuzzy company lookup ─────────────
      // Body: { "query": "Officeworks" }
      // Uses search_view=12 (Companies). Returns array of { id, name } matches.
      if (url.pathname === '/companies/search' && request.method === 'POST') {
        if (!env.STREAMTIME_KEY) return errorResponse('STREAMTIME_KEY not configured', 500, origin);

        const body = await request.json();
        const query = body.query ?? '';

        const searchBody = JSON.stringify({
          wildcardSearch: query,
          offset: 0,
          maxResults: 10,
          filterGroupCollection: { conditionMatchTypeId: 1, filterGroupCollections: [], filterGroups: [] },
        });

        const res = await fetch(
          'https://api.streamtime.net/v1/search?search_view=12&include_statistics=false',
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.STREAMTIME_KEY}`,
              'Content-Type': 'application/json',
            },
            body: searchBody,
          }
        );

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return errorResponse(err.message || `Streamtime ${res.status}`, res.status, origin);
        }

        const data = await res.json();
        const results = (data.searchResults || data.results || []).map(r => ({
          id:   r.id ?? r.companyId ?? r['Company ID'],
          name: r.name ?? r.companyName ?? r['Company Name'] ?? r['Name'],
        })).filter(r => r.id && r.name);

        return jsonResponse({ results }, 200, origin);
      }

      // ── GET /companies/all — load all companies for combobox ──────
      // Paginates through search_view=12 and returns up to 500 companies.
      if (url.pathname === '/companies/all' && request.method === 'GET') {
        if (!env.STREAMTIME_KEY) return errorResponse('STREAMTIME_KEY not configured', 500, origin);

        const pageSize = 200;
        let offset = 0;
        let allResults = [];

        while (allResults.length < 500) {
          const searchBody = JSON.stringify({
            wildcardSearch: '',
            offset,
            maxResults: pageSize,
            filterGroupCollection: { conditionMatchTypeId: 1, filterGroupCollections: [], filterGroups: [] },
          });

          const res = await fetch(
            'https://api.streamtime.net/v1/search?search_view=12&include_statistics=false',
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.STREAMTIME_KEY}`,
                'Content-Type': 'application/json',
              },
              body: searchBody,
            }
          );

          if (!res.ok) break;
          const data = await res.json();
          const page = (data.searchResults || []).map(r => ({
            id:   r.id ?? r.companyId,
            name: r.name ?? r.companyName ?? r['Company Name'],
          })).filter(r => r.id && r.name);

          allResults = allResults.concat(page);
          if (page.length < pageSize) break;
          offset += pageSize;
        }

        return jsonResponse({ companies: allResults }, 200, origin);
      }

      // ── POST /companies/create — create a new company ─────────────
      // Body: { "name": "New Supplier Pty Ltd" }
      // Returns the created company object including its id.
      if (url.pathname === '/companies/create' && request.method === 'POST') {
        if (!env.STREAMTIME_KEY) return errorResponse('STREAMTIME_KEY not configured', 500, origin);

        const { name } = await request.json();
        if (!name) return errorResponse('name is required', 400, origin);

        const res = await fetch('https://api.streamtime.net/v1/companies', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.STREAMTIME_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name }),
        });

        const text = await res.text();
        return new Response(text, {
          status: res.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }

      // ── POST /extract — Gemini receipt extraction ─────────────────
      if (url.pathname === '/extract' && request.method === 'POST') {
        if (!env.GEMINI_KEY) return errorResponse('GEMINI_KEY not configured', 500, origin);

        const { mimeType, data } = await request.json();
        if (!mimeType || !data) return errorResponse('mimeType and data are required', 400, origin);

        const today = new Date().toISOString().split('T')[0];
        const prompt = EXTRACT_PROMPT.replace('__TODAY__', today);

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { inline_data: { mime_type: mimeType, data } },
                  { text: prompt },
                ],
              }],
              generationConfig: { temperature: 0, maxOutputTokens: 1024 },
            }),
          }
        );

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return errorResponse(
            err.error?.message || `Gemini error ${res.status}`,
            res.status,
            origin
          );
        }

        const geminiData = await res.json();
        let txt = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
        txt = txt.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

        try {
          const extracted = JSON.parse(txt);
          return jsonResponse(extracted, 200, origin);
        } catch {
          return errorResponse(`Could not parse Gemini response: ${txt.slice(0, 200)}`, 500, origin);
        }
      }

      return errorResponse('Not found', 404, origin);

    } catch (err) {
      return errorResponse(err.message, 500, origin);
    }
  },
};
