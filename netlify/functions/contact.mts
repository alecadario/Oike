import type { Context } from "@netlify/functions";

const LEADS_BASE = 'appqbjfGV6aThqCZV';
const LEADS_TABLE = 'tbldmA2dFX001Lkpu';
const AIRTABLE_BASE = 'https://api.airtable.com/v0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: CORS });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const AIRTABLE_KEY = Netlify.env.get('AIRTABLE_API_KEY');
  if (!AIRTABLE_KEY) {
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const { name, lastName, company, email, phone, message, interest } = body;

  if (!name || !email) {
    return new Response(JSON.stringify({ error: 'Name and email are required' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const fields: Record<string, any> = {
    'Name': String(name).trim(),
    'Email': String(email).trim(),
  };
  if (lastName) fields['Last name'] = String(lastName).trim();
  if (company)  fields['Company']   = String(company).trim();
  if (phone)    fields['Phone']     = String(phone).trim();
  if (message)  fields['Message']   = String(message).trim();
  if (interest) fields['Interest']  = [String(interest)];

  try {
    const res = await fetch(`${AIRTABLE_BASE}/${LEADS_BASE}/${LEADS_TABLE}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Airtable error:', err);
      return new Response(JSON.stringify({ error: 'Failed to save lead' }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('Contact function error:', e);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/contact' };
