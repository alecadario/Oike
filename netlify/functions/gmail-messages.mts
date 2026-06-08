import type { Config } from "@netlify/functions";
import { verifyToken, getBearerToken } from './shared/auth.ts';
import { getAccessToken, getUserRefreshToken } from './shared/gmail.ts';

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

  const jwtSecret = Netlify.env.get('JWT_SECRET');
  if (!jwtSecret) return new Response(JSON.stringify({ error: 'Server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  const payload = await verifyToken(getBearerToken(req), jwtSecret);
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
