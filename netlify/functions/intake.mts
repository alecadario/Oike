import type { Context, Config } from "@netlify/functions";
import { STANDARD_TABLES } from './shared/tables.ts';

const AIRTABLE_BASE = 'https://api.airtable.com/v0';
const BASE_ID = 'appilTHSsdc8Ioyvg';
const TABLE_ID = STANDARD_TABLES.diagnosticIntake;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function airtableHeaders(key: string) {
  return { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
}

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });

  const key = Netlify.env.get('AIRTABLE_API_KEY');
  if (!key) return new Response(JSON.stringify({ error: 'Server error' }), { status: 500, headers: CORS });

  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (!token) return new Response(JSON.stringify({ error: 'Missing token' }), { status: 400, headers: CORS });

  // GET: fetch intake record by token
  if (req.method === 'GET') {
    const searchUrl = `${AIRTABLE_BASE}/${BASE_ID}/${TABLE_ID}?filterByFormula={Token}="${token}"&maxRecords=1`;
    const res = await fetch(searchUrl, { headers: airtableHeaders(key) });
    if (!res.ok) return new Response(JSON.stringify({ error: 'Airtable error' }), { status: 502, headers: CORS });
    const data = await res.json() as { records: any[] };
    if (!data.records?.length) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: CORS });
    const record = data.records[0];
    return new Response(JSON.stringify({ id: record.id, fields: record.fields }), { status: 200, headers: CORS });
  }

  // POST: save intake responses
  if (req.method === 'POST') {
    let body: any;
    try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: CORS }); }

    // Find the record by token first
    const searchUrl = `${AIRTABLE_BASE}/${BASE_ID}/${TABLE_ID}?filterByFormula={Token}="${token}"&maxRecords=1`;
    const searchRes = await fetch(searchUrl, { headers: airtableHeaders(key) });
    if (!searchRes.ok) return new Response(JSON.stringify({ error: 'Airtable error' }), { status: 502, headers: CORS });
    const searchData = await searchRes.json() as { records: any[] };
    if (!searchData.records?.length) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: CORS });

    const recordId = searchData.records[0].id;
    const existingStatus = searchData.records[0].fields?.['Status'];
    if (existingStatus === 'Submitted') {
      return new Response(JSON.stringify({ error: 'Already submitted' }), { status: 409, headers: CORS });
    }

    const allowedFields = [
      'Company Context', 'Current Sales Motion', 'Sales Team Size',
      'Main Challenge', 'What They\'ve Tried', 'Goals',
      'Pipeline Last 90 Days', 'Prospecting Activity', 'Messaging Examples',
      'Additional Context',
    ];
    const fields: Record<string, any> = { 'Status': 'Submitted', 'Submitted At': new Date().toISOString() };
    for (const f of allowedFields) {
      if (body[f] !== undefined && body[f] !== '') fields[f] = body[f];
    }

    // Upload attachments to Airtable
    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      const uploaded: { url: string; filename: string }[] = [];
      for (const file of body.attachments.slice(0, 5)) {
        try {
          // Upload via Airtable's upload attachment API
          const uploadUrl = `https://content.airtable.com/v0/${BASE_ID}/${TABLE_ID}/${recordId}/Attachment/uploadAttachment`;
          const binaryData = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
          const uploadRes = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${key}`,
              'Content-Type': file.type || 'application/octet-stream',
              'x-airtable-attachment-filename': encodeURIComponent(file.name),
            },
            body: binaryData,
          });
          if (uploadRes.ok) {
            const uploadData = await uploadRes.json() as { attachment?: { url: string } };
            if (uploadData?.attachment?.url) uploaded.push({ url: uploadData.attachment.url, filename: file.name });
          }
        } catch(e) { console.error('[intake] attachment upload failed:', e); }
      }
      if (uploaded.length > 0) fields['Attachment'] = uploaded.map(f => ({ url: f.url, filename: f.filename }));
    }

    const patchUrl = `${AIRTABLE_BASE}/${BASE_ID}/${TABLE_ID}/${recordId}`;
    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: airtableHeaders(key),
      body: JSON.stringify({ fields }),
    });
    if (!patchRes.ok) {
      const err = await patchRes.text();
      console.error('[intake] patch failed:', err);
      return new Response(JSON.stringify({ error: 'Failed to save' }), { status: 502, headers: CORS });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
};

export const config: Config = { path: '/api/intake' };
