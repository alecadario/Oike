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

// ── Fetch Gmail signature for the user's default send-as address ──
async function getGmailSignature(accessToken: string): Promise<string> {
  try {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!res.ok) return '';
    const data = await res.json();
    const sendAs: any[] = data.sendAs || [];
    const primary = sendAs.find(s => s.isDefault || s.isPrimary) || sendAs[0];
    return primary?.signature || '';
  } catch { return ''; }
}

// ── Convert plain text to HTML (preserves line breaks) ──
function textToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

// ── RFC 2047 encode subject for non-ASCII characters ──
function encodeSubject(subject: string): string {
  if (!/[^\x00-\x7F]/.test(subject)) return subject;
  const bytes = new TextEncoder().encode(subject);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

// ── Build base64url-encoded MIME message (HTML with signature) ──
function buildMimeMessage({ to, subject, body, bodyHtml, signature, cc, inReplyTo, references }: {
  to: string; subject: string; body: string; bodyHtml?: string; signature?: string;
  cc?: string[]; inReplyTo?: string; references?: string;
}): string {
  const replySubject = inReplyTo && !subject.toLowerCase().startsWith('re:')
    ? `Re: ${subject}`
    : subject;

  // If pre-built HTML is provided, inject signature before </body>; otherwise convert plain text
  let htmlBody: string;
  if (bodyHtml) {
    const sigBlock = signature ? `<div style="margin:24px 32px 0;padding-top:16px;border-top:1px solid #eee;">${signature}</div>` : '';
    htmlBody = sigBlock
      ? (bodyHtml.includes('</body>') ? bodyHtml.replace('</body>', sigBlock + '</body>') : bodyHtml + sigBlock)
      : bodyHtml;
  } else {
    htmlBody = `<div style="font-family:sans-serif;font-size:14px;">${textToHtml(body)}</div>`
      + (signature ? `<br><div>${signature}</div>` : '');
  }

  const lines = [
    `To: ${to}`,
    ...(cc && cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${encodeSubject(replySubject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references} ${inReplyTo || ''}`.trim()] : inReplyTo ? [`References: ${inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    htmlBody,
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
  const logRes = await fetch(`${AIRTABLE_BASE}/${baseId}/${outreachTableId}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${airtableKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  if (!logRes.ok) {
    const err = await logRes.text().catch(() => '?');
    console.error('[gmail-send] logSentActivity failed:', logRes.status, err);
    throw new Error(`Failed to log activity in Airtable: ${logRes.status} — ${err}`);
  }
}

// ── Advance stakeholder status (only forward, respects protected states) ──
const STAKEHOLDER_STATUS_PRIORITY: Record<string, number> = { '': 0, 'Not Contacted': 0, 'Contacted': 1, 'Replied': 2, 'Meeting Booked': 3 };
const STAKEHOLDER_STATUS_PROTECTED = ['DNC', 'Left Company', 'Not Interested', 'Nurture', 'Bounced'];
const STAKEHOLDERS_TABLE = 'tblwwNrPg6q2jYxfv';

async function advanceStakeholderStatus(baseId: string, stakeholderId: string, targetStatus: string, airtableKey: string): Promise<void> {
  try {
    const getRes = await fetch(`${AIRTABLE_BASE}/${baseId}/${STAKEHOLDERS_TABLE}/${stakeholderId}`, {
      headers: { 'Authorization': `Bearer ${airtableKey}` },
    });
    if (!getRes.ok) return;
    const rec = await getRes.json();
    const current = String(rec?.fields?.['Status'] || '').trim();
    if (STAKEHOLDER_STATUS_PROTECTED.includes(current)) return;
    if ((STAKEHOLDER_STATUS_PRIORITY[targetStatus] ?? 0) <= (STAKEHOLDER_STATUS_PRIORITY[current] ?? 0)) return;
    await fetch(`${AIRTABLE_BASE}/${baseId}/${STAKEHOLDERS_TABLE}/${stakeholderId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${airtableKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { 'Status': targetStatus }, typecast: true }),
    });
  } catch {}
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

  const { to, subject, message, bodyHtml, cc, threadId, inReplyTo, references, readMessageId, stakeholderId, accountIds, baseId, outreachTableId, draft = false } = body;

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

    // 3. Fetch Gmail signature + build MIME message
    const signature = await getGmailSignature(accessToken);
    const raw = buildMimeMessage({ to, subject, body: message, bodyHtml, signature, cc, inReplyTo, references });

    if (draft) {
      // ── Create Gmail draft ──
      const draftBody: Record<string, any> = { message: { raw } };
      if (threadId) draftBody.message.threadId = threadId;

      const draftRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(draftBody),
      });

      if (!draftRes.ok) {
        const err = await draftRes.text();
        console.error('[gmail-send] Draft failed:', draftRes.status, err);
        return new Response(JSON.stringify({ error: `Gmail draft failed (${draftRes.status})` }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }

      const draftData = await draftRes.json();
      const draftGmailId = draftData.id || '';

      // Log in Airtable as Draft
      const today = new Date().toISOString().split('T')[0];
      const fields: Record<string, any> = {
        'Channel': 'Email', 'Status': 'Draft',
        'Activity Name': `[DRAFT] Email — ${new Date().toLocaleDateString('en-US')}`,
        'Notes': `[gmsg:${draftGmailId}]\n${subject}\n\n${message.slice(0, 300)}`,
        'Message': message, 'Stakeholder': [stakeholderId],
        'Date': today, 'Logged By': payload.email || '',
      };
      if (accountIds?.length) fields['Account'] = accountIds;
      const draftLogRes = await fetch(`${AIRTABLE_BASE}/${baseId}/${outreachTableId}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${airtableKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields }], typecast: true }),
      });
      if (!draftLogRes.ok) {
        const err = await draftLogRes.text().catch(() => '?');
        console.error('[gmail-send] draft log failed:', draftLogRes.status, err);
        return new Response(JSON.stringify({ error: `Draft created in Gmail but failed to log in Airtable: ${draftLogRes.status} — ${err}` }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
      await advanceStakeholderStatus(baseId, stakeholderId, 'Contacted', airtableKey);

      return new Response(JSON.stringify({ ok: true, draft: true, gmailDraftId: draftGmailId }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Send email ──
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

    // Mark original email as read (if replying)
    if (readMessageId) {
      await markAsRead(readMessageId, accessToken).catch(() => {});
    }

    // Log in Airtable as Sent + advance stakeholder status
    const today = new Date().toISOString().split('T')[0];
    try {
      await logSentActivity(baseId, outreachTableId, stakeholderId, accountIds || [], subject, message, today, payload.email || '', sentGmailId, airtableKey);
    } catch (logErr: any) {
      console.error('[gmail-send] Email sent but activity log failed:', logErr.message);
      return new Response(JSON.stringify({ error: `Email sent but failed to log in Airtable: ${logErr.message}` }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
    await advanceStakeholderStatus(baseId, stakeholderId, 'Contacted', airtableKey);

    return new Response(JSON.stringify({ ok: true, gmailMessageId: sentGmailId }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('[gmail-send] Error:', e);
    return new Response(JSON.stringify({ error: e.message || 'Internal error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config: Config = { path: '/api/gmail/send' };
