import type { Config } from "@netlify/functions";

// ── Inline JWT verify ──
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

const USERS_TABLE_ID = 'tblBMyzKhFKmPFX25';
const USERS_BASE_ID  = 'app3plkFpOx28hhmH';
const AIRTABLE_BASE  = 'https://api.airtable.com/v0';

async function getAccessToken(refreshToken: string): Promise<string | null> {
  const clientId     = Netlify.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Netlify.env.get('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token || null;
}

async function getUserRefreshToken(email: string, airtableKey: string): Promise<string | null> {
  const formula = encodeURIComponent(`{Email}='${email}'`);
  const url = `${AIRTABLE_BASE}/${USERS_BASE_ID}/${USERS_TABLE_ID}?filterByFormula=${formula}&maxRecords=1`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${airtableKey}` } });
  if (!res.ok) return null;
  const data = await res.json();
  return data.records?.[0]?.fields?.['Gmail Refresh Token'] || null;
}

// ── Decode base64url ──
function decodeBase64(str: string): string {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return atob(b64);
  }
}

// ── Extract body from Gmail message payload ──
function extractBody(payload: any): string {
  if (!payload) return '';
  // Direct body
  if (payload.body?.data) return decodeBase64(payload.body.data);
  // Multipart — prefer text/plain, fall back to text/html
  if (payload.parts) {
    const plain = payload.parts.find((p: any) => p.mimeType === 'text/plain');
    if (plain?.body?.data) return decodeBase64(plain.body.data);
    const html = payload.parts.find((p: any) => p.mimeType === 'text/html');
    if (html?.body?.data) {
      // Strip HTML tags for plain text preview
      return decodeBase64(html.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    // Recurse into nested multipart
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return '';
}

// ── Get header value from Gmail message ──
function getHeader(headers: any[], name: string): string {
  return headers?.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

export default async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204 });

  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  const jwtSecret = Netlify.env.get('JWT_SECRET');
  if (!jwtSecret) return new Response(JSON.stringify({ error: 'Server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  const payload = await verifyToken(token, jwtSecret);
  if (!payload) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  const airtableKey = Netlify.env.get('AIRTABLE_API_KEY');
  if (!airtableKey) return new Response(JSON.stringify({ error: 'Airtable not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  const url = new URL(req.url);
  const contactEmail = url.searchParams.get('contactEmail') || '';
  const messageId    = url.searchParams.get('messageId') || '';

  // Get user's Gmail refresh token
  const refreshToken = await getUserRefreshToken(payload.email, airtableKey);
  if (!refreshToken) {
    return new Response(JSON.stringify({ error: 'Gmail not connected', gmailNotConnected: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const accessToken = await getAccessToken(refreshToken);
  if (!accessToken) {
    return new Response(JSON.stringify({ error: 'Could not refresh Gmail token' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  // ── Fetch single message ──
  if (messageId) {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!res.ok) return new Response(JSON.stringify({ error: 'Failed to fetch message' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    const msg = await res.json();
    const headers = msg.payload?.headers || [];
    return new Response(JSON.stringify({
      id: msg.id,
      threadId: msg.threadId,
      subject: getHeader(headers, 'subject'),
      from: getHeader(headers, 'from'),
      to: getHeader(headers, 'to'),
      date: getHeader(headers, 'date'),
      body: extractBody(msg.payload),
      labelIds: msg.labelIds || [],
      unread: (msg.labelIds || []).includes('UNREAD'),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // ── List messages with contact ──
  if (!contactEmail) {
    return new Response(JSON.stringify({ error: 'contactEmail required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const query = encodeURIComponent(`from:${contactEmail} OR to:${contactEmail}`);
  const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=20`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!listRes.ok) return new Response(JSON.stringify({ error: 'Failed to list messages' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  const listData = await listRes.json();
  const msgIds: string[] = (listData.messages || []).map((m: any) => m.id);

  if (msgIds.length === 0) {
    return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Fetch metadata for each message (parallel, capped at 15)
  const toFetch = msgIds.slice(0, 15);
  const metaResults = await Promise.allSettled(toFetch.map(id =>
    fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }).then(r => r.json())
  ));

  const messages = metaResults
    .filter(r => r.status === 'fulfilled')
    .map((r: any) => {
      const msg = r.value;
      const headers = msg.payload?.headers || [];
      return {
        id: msg.id,
        threadId: msg.threadId,
        subject: getHeader(headers, 'subject'),
        from: getHeader(headers, 'from'),
        date: getHeader(headers, 'date'),
        snippet: msg.snippet || '',
        unread: (msg.labelIds || []).includes('UNREAD'),
      };
    });

  return new Response(JSON.stringify({ messages }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config: Config = { path: '/api/gmail/messages' };
