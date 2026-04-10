import type { Context, Config } from "@netlify/functions";

// ── Inline JWT verify (no cross-file imports) ──
async function verifyToken(token: string, secret: string): Promise<Record<string, any> | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const data = `${headerB64}.${payloadB64}`;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sigStr = atob(sigB64.replace(/-/g, '+').replace(/_/g, '/'));
    const sigBytes = new Uint8Array([...sigStr].map((c) => c.charCodeAt(0)));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return null;
    const payloadStr = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadStr);
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

const AIRTABLE_BASE = 'https://api.airtable.com/v0';

function getJwtSecret(): string {
  return Netlify.env.get('JWT_SECRET') || 'oike-default-secret-change-me-2026';
}

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204 });
  }

  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  const payload = await verifyToken(token, getJwtSecret());
  if (!payload) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const AIRTABLE_KEY = Netlify.env.get('AIRTABLE_API_KEY');
  if (!AIRTABLE_KEY) {
    return new Response(JSON.stringify({ error: 'Airtable API key not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const { method = 'GET', baseId, tableId, recordId, fields, offset, records } = body;

    if (!baseId || !tableId) {
      return new Response(JSON.stringify({ error: 'Missing baseId or tableId' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    let url = `${AIRTABLE_BASE}/${baseId}/${tableId}`;
    if (recordId) url += `/${recordId}`;

    const fetchOptions: RequestInit = {
      method,
      headers: { 'Authorization': `Bearer ${AIRTABLE_KEY}`, 'Content-Type': 'application/json' },
    };

    if (method === 'GET') {
      const params = new URLSearchParams();
      if (offset) params.set('offset', offset);
      params.set('pageSize', '100');
      url += `?${params.toString()}`;
    }

    if (method === 'POST' && fields) {
      fetchOptions.body = JSON.stringify({ records: [{ fields }], typecast: true });
    }

    if (method === 'POST' && records) {
      fetchOptions.body = JSON.stringify({ records, typecast: true });
    }

    if (method === 'PATCH' && fields) {
      fetchOptions.body = JSON.stringify({ fields, typecast: true });
    }

    const response = await fetch(url, fetchOptions);
    const data = await response.json();

    if (!response.ok) {
      console.error(`[airtable-proxy] ${response.status} on ${method} ${url}`, JSON.stringify(data));
      return new Response(JSON.stringify({ ...data, _debug: { baseId, tableId, url, method } }), {
        status: response.status, headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config: Config = {
  path: "/api/airtable",
};
