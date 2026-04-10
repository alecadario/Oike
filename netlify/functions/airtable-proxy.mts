import type { Context, Config } from "@netlify/functions";
import { verifyToken } from "./auth.mts";

const AIRTABLE_BASE = 'https://api.airtable.com/v0';

function getJwtSecret(): string {
  return Netlify.env.get('JWT_SECRET') || 'oike-default-secret-change-me-2026';
}

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204 });
  }

  // ── Auth check ──
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  const payload = await verifyToken(token, getJwtSecret());
  if (!payload) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const AIRTABLE_KEY = Netlify.env.get('AIRTABLE_API_KEY');
  if (!AIRTABLE_KEY) {
    return new Response(JSON.stringify({ error: 'Airtable API key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const { method = 'GET', baseId, tableId, recordId, fields, offset, records } = body;

    if (!baseId || !tableId) {
      return new Response(JSON.stringify({ error: 'Missing baseId or tableId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let url = `${AIRTABLE_BASE}/${baseId}/${tableId}`;
    if (recordId) url += `/${recordId}`;

    const fetchOptions: RequestInit = {
      method: method,
      headers: {
        'Authorization': `Bearer ${AIRTABLE_KEY}`,
        'Content-Type': 'application/json',
      },
    };

    // GET with pagination
    if (method === 'GET') {
      const params = new URLSearchParams();
      if (offset) params.set('offset', offset);
      params.set('pageSize', '100');
      url += `?${params.toString()}`;
    }

    // POST (create record with fields)
    if (method === 'POST' && fields) {
      fetchOptions.body = JSON.stringify({ records: [{ fields }], typecast: true });
    }

    // POST batch create
    if (method === 'POST' && records) {
      fetchOptions.body = JSON.stringify({ records, typecast: true });
    }

    // PATCH (update record)
    if (method === 'PATCH' && fields) {
      fetchOptions.body = JSON.stringify({ fields, typecast: true });
    }

    const response = await fetch(url, fetchOptions);
    const data = await response.json();

    if (!response.ok) {
      return new Response(JSON.stringify({ ...data, _debug: { baseId, tableId, url } }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config: Config = {
  path: "/api/airtable",
};
