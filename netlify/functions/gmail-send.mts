import type { Context, Config } from "@netlify/functions";
import { verifyToken, getBearerToken } from './shared/auth.ts';
import { getAccessToken, getUserRefreshToken, getGmailSignature, buildMimeMessage } from './shared/gmail.ts';

const AIRTABLE_BASE = 'https://api.airtable.com/v0';

const STAKEHOLDER_STATUS_PRIORITY: Record<string, number> = { '': 0, 'Not Contacted': 0, 'Contacted': 1, 'Replied': 2, 'Meeting Booked': 3 };
const STAKEHOLDER_STATUS_PROTECTED = ['DNC', 'Left Company', 'Not Interested', 'Nurture', 'Bounced'];
const STAKEHOLDERS_TABLE = 'tblwwNrPg6q2jYxfv';

async function logSentActivity(
  baseId: string, outreachTableId: string, stakeholderId: string,
  accountIds: string[], subject: string, body: string,
  date: string, loggedBy: string, gmailMsgId: string, airtableKey: string
): Promise<void> {
  const fields: Record<string, any> = {
    'Channel':       'Email',
    'Status':        'Sent',
    'Activity Name': `Email — ${new Date().toLocaleDateString('en-US')}`,
    'Notes':         `[gmsg:${gmailMsgId}] ${subject}`,
    'Message':       body.slice(0, 1000),
    'Stakeholder':   [stakeholderId],
    'Date':          date,
    'Logged By':     loggedBy,
  };
  if (accountIds.length > 0) fields['Account'] = accountIds;
  console.log('[gmail-send] logSentActivity →', { baseId, outreachTableId, stakeholderId, accountIds, date, loggedBy });
  const logRes = await fetch(`${AIRTABLE_BASE}/${baseId}/${outreachTableId}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${airtableKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  if (!logRes.ok) {
    const err = await logRes.text().catch(() => '?');
    console.error('[gmail-send] logSentActivity failed:', logRes.status, err, '| fields:', JSON.stringify(fields));
    throw new Error(`Airtable log failed (${logRes.status}): ${err}`);
  }
  console.log('[gmail-send] logSentActivity ✓ created outreach record');
}

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

  const jwtSecret = Netlify.env.get('JWT_SECRET');
  if (!jwtSecret) return new Response(JSON.stringify({ error: 'Server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  const payload = await verifyToken(getBearerToken(req), jwtSecret);
  if (!payload) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  const airtableKey = Netlify.env.get('AIRTABLE_API_KEY');
  if (!airtableKey) return new Response(JSON.stringify({ error: 'Airtable not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { to, subject, message, bodyHtml, cc, threadId, inReplyTo, references, readMessageId, stakeholderId, accountIds, baseId, outreachTableId, draft = false } = body;

  if (!to || !subject || !message || !stakeholderId || !baseId || !outreachTableId) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const refreshToken = await getUserRefreshToken(payload.email, airtableKey);
    if (!refreshToken) {
      return new Response(JSON.stringify({ error: 'Gmail not connected. Please connect Gmail in Settings.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const accessToken = await getAccessToken(refreshToken);
    if (!accessToken) {
      return new Response(JSON.stringify({ error: 'Could not refresh Gmail access. Please reconnect Gmail.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const signature = await getGmailSignature(accessToken);
    const raw = buildMimeMessage({ to, subject, body: message, bodyHtml, signature, cc, inReplyTo, references });

    if (draft) {
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

      const today = new Date().toISOString().split('T')[0];
      const fields: Record<string, any> = {
        'Channel': 'Email', 'Status': 'Draft',
        'Activity Name': `[DRAFT] Email — ${new Date().toLocaleDateString('en-US')}`,
        'Notes': `[gmsg:${draftGmailId}]\n${subject}\n\n${message.slice(0, 300)}`,
        'Message': message, 'Stakeholder': [stakeholderId],
        'Date': today, 'Logged By': payload.name || payload.email || '',
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
      return new Response(JSON.stringify({ ok: true, draft: true, gmailDraftId: draftGmailId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

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

    if (readMessageId) await markAsRead(readMessageId, accessToken).catch(() => {});

    const today = new Date().toISOString().split('T')[0];
    try {
      await logSentActivity(baseId, outreachTableId, stakeholderId, accountIds || [], subject, message, today, payload.name || payload.email || '', sentGmailId, airtableKey);
    } catch (logErr: any) {
      console.error('[gmail-send] Email sent but activity log failed:', logErr.message);
      return new Response(JSON.stringify({ error: `Email sent but failed to log in Airtable: ${logErr.message}` }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
    await advanceStakeholderStatus(baseId, stakeholderId, 'Contacted', airtableKey);

    return new Response(JSON.stringify({ ok: true, gmailMessageId: sentGmailId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('[gmail-send] Error:', e);
    return new Response(JSON.stringify({ error: e.message || 'Internal error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config: Config = { path: '/api/gmail/send' };
