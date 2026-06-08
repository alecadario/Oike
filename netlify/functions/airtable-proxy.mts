import type { Context, Config } from "@netlify/functions";
import { verifyToken, getBearerToken } from './shared/auth.ts';

const AIRTABLE_BASE = 'https://api.airtable.com/v0';

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204 });
  }

  const jwtSecret = Netlify.env.get('JWT_SECRET');
  if (!jwtSecret) return new Response(JSON.stringify({ error: 'Server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  const payload = await verifyToken(getBearerToken(req), jwtSecret);
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
      console.error(`[airtable-proxy] ${response.status} on ${method} ${tableId}`, JSON.stringify(data));
      const errorMsg = data?.error?.message || data?.error || 'Airtable request failed';
      return new Response(JSON.stringify({ error: errorMsg }), {
        status: response.status, headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[airtable-proxy] Unhandled error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config: Config = {
  path: "/api/airtable",
};
