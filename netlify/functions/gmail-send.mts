import type { Context, Config } from "@netlify/functions";

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

function getJwtSecret(): string {
  const secret = Netlify.env.get('JWT_SECRET');
  if (!secret) throw new Error('JWT_SECRET not configured');
  return secret;
}

const USERS_TABLE_ID = 'tblBMyzKhFKmPFX25';
const USERS_BASE_ID  = 'app3plkFpOx28hhmH';
const AIRTABLE_BASE  = 'https://api.airtable.com/v0';

// ── Get Gmail access token from stored refresh token ──
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

// ── Fetch Gmail refresh token from Airtable ──
async function getUserRefreshToken(email: string, airtableKey: string): Promise<string | null> {
  const formula = encodeURIComponent(`{Email}='${email}'`);
  const url = `${AIRTABLE_BASE}/${USERS_BASE_ID}/${USERS_TABLE_ID}?filterByFormula=${formula}&maxRecords=1`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${airtableKey}` } });
  if (!res.ok) return null;
  const data = await res.json();
  return data.records?.[0]?.fields?.['Gmail Refresh Token'] || null;
}

// ── Build base64url-encoded MIME message ──
function buildMimeMessage({ to, subject, body, cc, inReplyTo, references }: {
  to: string; subject: string; body: string;
  cc?: string[]; inReplyTo?: string; references?: string;
}): string {
  const replySubject = inReplyTo && !subject.toLowerCase().startsWith('re:')
    ? `Re: ${subject}`
    : subject;

  const lines = [
    `To: ${to}`,
    ...(cc && cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${replySubject}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references} ${inReplyTo || ''}`.trim()] : inReplyTo ? [`References: ${inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ];

  const raw = lines.join('\r\n');
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Log sent email as outreach activity in Airtable ──
async function logSentActivity(
  baseId: string, outreachTableId: string, stakeholderId: string,
  accountIds: string[], subject: string, body: string,
  date: string, loggedBy: string, gmailMsgId: string, airtableKey: string
): Promise<void> {
  const fields: Record<string, any> = {
    'Channel':        'Email',
    'Status':         'Sent',
    'Activity Name':  `Email to stakeholder — ${new Date().toLocaleDateString('en-US')}`,
    'Notes':          `[gmsg:${gmailMsgId}]\n${subject}\n\n${body.slice(0, 300)}`,
    'Message':        body,
    'Stakeholder':    [stakeholderId],
    'Date':           date,
    'Logged By':      loggedBy,
  };
  if (accountIds.length > 0) fields['Account'] = accountIds;
  await fetch(`${AIRTABLE_BASE}/${baseId}/${outreachTableId}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${airtableKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
}

// ── Mark a Gmail message as read ──
async function markAsRead(messageId: string, accessToken: string): Promise<void> {
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
  });
}

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204 });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  const payload = await verifyToken(token, getJwtSecret());
  if (!payload) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  const airtableKey = Netlify.env.get('AIRTABLE_API_KEY');
  if (!airtableKey) {
    return new Response(JSON.stringify({ error: 'Airtable not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { to, subject, message, cc, threadId, inReplyTo, references, readMessageId, stakeholderId, accountIds, baseId, outreachTableId } = body;

  if (!to || !subject || !message || !stakeholderId || !baseId || !outreachTableId) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    // 1. Get refresh token
    const refreshToken = await getUserRefreshToken(payload.email, airtableKey);
    if (!refreshToken) {
      return new Response(JSON.stringify({ error: 'Gmail not connected. Please connect Gmail in Settings.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // 2. Get access token
    const accessToken = await getAccessToken(refreshToken);
    if (!accessToken) {
      return new Response(JSON.stringify({ error: 'Could not refresh Gmail access. Please reconnect Gmail.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // 3. Build and send MIME message
    const raw = buildMimeMessage({ to, subject, body: message, cc, inReplyTo, references });
    const sendBody: Record<string, any> = { raw };
    if (threadId) sendBody.threadId = threadId;

    const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(sendBody),
    });

    if (!sendRes.ok) {
      const err = await sendRes.text();
      console.error('[gmail-send] Send failed:', sendRes.status, err);
      return new Response(JSON.stringify({ error: `Gmail send failed (${sendRes.status})` }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const sentData = await sendRes.json();
    const sentGmailId = sentData.id || '';

    // 4. Mark original email as read (if replying)
    if (readMessageId) {
      await markAsRead(readMessageId, accessToken).catch(() => {});
    }

    // 5. Log in Airtable
    const today = new Date().toISOString().split('T')[0];
    await logSentActivity(baseId, outreachTableId, stakeholderId, accountIds || [], subject, message, today, payload.email || '', sentGmailId, airtableKey);

    return new Response(JSON.stringify({ ok: true, gmailMessageId: sentGmailId }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('[gmail-send] Error:', e);
    return new Response(JSON.stringify({ error: e.message || 'Internal error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config: Config = { path: '/api/gmail/send' };
