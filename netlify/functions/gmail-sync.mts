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

function getJwtSecret(): string {
  const secret = Netlify.env.get('JWT_SECRET');
  if (!secret) throw new Error('JWT_SECRET not configured');
  return secret;
}

// ── Constants ──
const USERS_TABLE_ID  = 'tblBMyzKhFKmPFX25';
const USERS_BASE_ID   = 'app3plkFpOx28hhmH';
const AIRTABLE_BASE   = 'https://api.airtable.com/v0';

// ── Get a fresh access token using the stored refresh token ──
async function getAccessToken(refreshToken: string): Promise<string | null> {
  const clientId     = Netlify.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Netlify.env.get('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token || null;
}

// ── Fetch user's Gmail refresh token from Airtable ──
async function getUserRefreshToken(email: string, airtableKey: string): Promise<string | null> {
  const formula = encodeURIComponent(`{Email}='${email}'`);
  const url = `${AIRTABLE_BASE}/${USERS_BASE_ID}/${USERS_TABLE_ID}?filterByFormula=${formula}&maxRecords=1`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${airtableKey}` } });
  if (!res.ok) return null;
  const data = await res.json();
  return data.records?.[0]?.fields?.['Gmail Refresh Token'] || null;
}

// ── Fetch all stakeholders with emails from a given Airtable base ──
async function fetchStakeholders(baseId: string, tableId: string, airtableKey: string): Promise<Array<{ id: string; email: string; name: string; accountIds: string[] }>> {
  const url = `${AIRTABLE_BASE}/${baseId}/${tableId}?pageSize=100`;
  const stakeholders: Array<{ id: string; email: string; name: string; accountIds: string[] }> = [];
  let nextOffset: string | null = null;

  do {
    const fetchUrl = nextOffset ? `${url}&offset=${nextOffset}` : url;
    const res = await fetch(fetchUrl, { headers: { 'Authorization': `Bearer ${airtableKey}` } });
    if (!res.ok) break;
    const data = await res.json();
    for (const r of (data.records || [])) {
      const email = r.fields?.['Email'] || '';
      if (email) {
        // Account is a linked record field — array of record IDs
        const accountRaw = r.fields?.['Account'];
        const accountIds: string[] = Array.isArray(accountRaw) ? accountRaw : (accountRaw ? [accountRaw] : []);
        stakeholders.push({
          id:         r.id,
          email:      email.trim().toLowerCase(),
          name:       `${r.fields?.['First name'] || ''} ${r.fields?.['Last name'] || ''}`.trim(),
          accountIds,
        });
      }
    }
    nextOffset = data.offset || null;
  } while (nextOffset);

  return stakeholders;
}

// ── Fetch recent emails from Gmail ──
async function fetchRecentEmails(accessToken: string, daysBack = 30): Promise<any[]> {
  // Gmail `after:` operator requires YYYY/MM/DD format, not Unix timestamps
  const afterDate = new Date(Date.now() - daysBack * 24 * 3600 * 1000);
  const afterStr = `${afterDate.getFullYear()}/${String(afterDate.getMonth() + 1).padStart(2, '0')}/${String(afterDate.getDate()).padStart(2, '0')}`;
  // Only INBOX — log received emails from contacts, not outbound sent
  const query = encodeURIComponent(`in:inbox after:${afterStr}`);
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=100`;

  const listRes = await fetch(listUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!listRes.ok) {
    const errText = await listRes.text();
    console.error('[gmail-sync] Gmail list error:', listRes.status, errText);
    return [];
  }
  const listData = await listRes.json();
  if (!listData.messages || listData.messages.length === 0) return [];

  // Fetch metadata for each message in parallel (batched)
  const messages = await Promise.all(
    listData.messages.map(async (m: { id: string }) => {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      if (!msgRes.ok) return null;
      return await msgRes.json();
    })
  );

  return messages.filter(Boolean);
}

// ── Extract email addresses from Gmail header value ──
function extractEmails(headerValue: string): string[] {
  const matches = headerValue.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g) || [];
  return matches.map(e => e.toLowerCase());
}

// ── Parse Gmail message headers ──
function getHeader(headers: any[], name: string): string {
  return headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// ── Fetch already-synced Gmail message IDs from outreach table ──
// IDs are stored as a hidden prefix in the Notes field: [gmsg:MESSAGE_ID]
async function fetchSyncedMessageIds(baseId: string, outreachTableId: string, airtableKey: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let offset: string | null = null;
  do {
    const url = `${AIRTABLE_BASE}/${baseId}/${outreachTableId}?fields%5B%5D=Notes&pageSize=100${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${airtableKey}` } });
    if (!res.ok) break;
    const data = await res.json();
    for (const r of (data.records || [])) {
      const notes: string = r.fields?.Notes || '';
      const match = notes.match(/^\[gmsg:([^\]]+)\]/);
      if (match) ids.add(match[1]);
    }
    offset = data.offset || null;
  } while (offset);
  return ids;
}

// ── Log an email as outreach activity in Airtable ──
async function logEmailActivity(
  baseId: string,
  outreachTableId: string,
  stakeholderId: string,
  accountIds: string[],
  messageId: string,
  subject: string,
  snippet: string,
  date: string,
  direction: 'sent' | 'received',
  loggedBy: string,
  airtableKey: string
): Promise<boolean> {
  const fields: Record<string, any> = {
    'Channel':     'Email',
    'Status':      direction === 'sent' ? 'Sent' : 'Received',
    'Notes':       `[gmsg:${messageId}]\n${subject}\n\n${snippet}`,
    'Stakeholder': [stakeholderId],
    'Date':        date,
    'Logged By':   loggedBy,
  };
  if (accountIds.length > 0) fields['Account'] = accountIds;

  const res = await fetch(`${AIRTABLE_BASE}/${baseId}/${outreachTableId}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${airtableKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  return res.ok;
}

// ── Advance stakeholder Status in funnel — only advances forward, respects manual states ──
const STAKEHOLDER_STATUS_PRIORITY: Record<string, number> = { '': 0, 'Not Contacted': 0, 'Contacted': 1, 'Replied': 2, 'Meeting Booked': 3 };
const STAKEHOLDER_STATUS_PROTECTED = ['DNC', 'Left Company', 'Not Interested', 'Nurture', 'Bounced'];

async function advanceStakeholderStatus(
  baseId: string,
  stakeholdersTableId: string,
  stakeholderId: string,
  targetStatus: string,
  airtableKey: string
): Promise<boolean> {
  try {
    // 1. Read current status
    const getRes = await fetch(`${AIRTABLE_BASE}/${baseId}/${stakeholdersTableId}/${stakeholderId}`, {
      headers: { 'Authorization': `Bearer ${airtableKey}` },
    });
    if (!getRes.ok) return false;
    const rec = await getRes.json();
    const currentStatus = String(rec?.fields?.['Status'] || '').trim();

    // Respect manual/terminal states
    if (STAKEHOLDER_STATUS_PROTECTED.includes(currentStatus)) return false;

    const currentPriority = STAKEHOLDER_STATUS_PRIORITY[currentStatus] ?? 0;
    const targetPriority = STAKEHOLDER_STATUS_PRIORITY[targetStatus] ?? 0;
    if (targetPriority <= currentPriority) return false;

    // 2. Update
    const updRes = await fetch(`${AIRTABLE_BASE}/${baseId}/${stakeholdersTableId}/${stakeholderId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${airtableKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { 'Status': targetStatus }, typecast: true }),
    });
    return updRes.ok;
  } catch (e) {
    console.warn('[advanceStakeholderStatus] failed:', e);
    return false;
  }
}

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204 });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  // Verify JWT
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

  try {
    const body = await req.json();
    const { baseId, stakeholdersTableId, outreachTableId, daysBack = 7 } = body;

    if (!baseId || !stakeholdersTableId || !outreachTableId) {
      return new Response(JSON.stringify({ error: 'Missing baseId, stakeholdersTableId, or outreachTableId' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // 1. Get user's Gmail refresh token
    const refreshToken = await getUserRefreshToken(payload.email, airtableKey);
    if (!refreshToken) {
      return new Response(JSON.stringify({ error: 'Gmail not connected. Connect Gmail first.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // 2. Get a fresh access token
    const accessToken = await getAccessToken(refreshToken);
    if (!accessToken) {
      return new Response(JSON.stringify({ error: 'Could not refresh Gmail access. Please reconnect Gmail.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // 3. Fetch stakeholders with emails
    const stakeholders = await fetchStakeholders(baseId, stakeholdersTableId, airtableKey);
    if (stakeholders.length === 0) {
      return new Response(JSON.stringify({ synced: 0, message: 'No contacts with email addresses found. Add email addresses to your contacts first.' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Build a lookup map: email → stakeholder
    const emailMap = new Map<string, typeof stakeholders[0]>();
    for (const s of stakeholders) emailMap.set(s.email, s);

    // 3b. Confirm which Gmail account is connected
    let gmailAccountEmail = 'unknown';
    try {
      const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      if (profileRes.ok) {
        const prof = await profileRes.json();
        gmailAccountEmail = prof.emailAddress || 'unknown';
      } else {
        const errText = await profileRes.text();
        console.error('[gmail-sync] Profile fetch failed:', profileRes.status, errText);
        return new Response(JSON.stringify({ error: `Gmail auth error (${profileRes.status}). Please reconnect Gmail.` }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
    } catch (e) {
      console.error('[gmail-sync] Profile fetch exception:', e);
    }

    // 4. Load already-synced message IDs to avoid duplicates
    const syncedIds = await fetchSyncedMessageIds(baseId, outreachTableId, airtableKey);

    // 5. Fetch recent emails
    const emails = await fetchRecentEmails(accessToken, daysBack);

    // 6. Match and log (skipping already-synced)
    let synced = 0;
    let skipped = 0;
    for (const msg of emails) {
      // Skip if already logged
      if (syncedIds.has(msg.id)) { skipped++; continue; }

      const headers = msg.payload?.headers || [];
      const from    = getHeader(headers, 'From');
      const to      = getHeader(headers, 'To');
      const subject = getHeader(headers, 'Subject') || '(no subject)';
      const dateStr = getHeader(headers, 'Date');
      const snippet = (msg.snippet || '').slice(0, 300);

      const fromEmails = extractEmails(from);
      const toEmails   = extractEmails(to);

      // Find if any email matches a stakeholder
      let matchedStakeholder: typeof stakeholders[0] | undefined;
      let direction: 'sent' | 'received' = 'received';

      for (const e of toEmails) {
        if (emailMap.has(e)) { matchedStakeholder = emailMap.get(e); direction = 'sent'; break; }
      }
      if (!matchedStakeholder) {
        for (const e of fromEmails) {
          if (emailMap.has(e)) { matchedStakeholder = emailMap.get(e); direction = 'received'; break; }
        }
      }

      if (!matchedStakeholder) continue;

      // Parse date — extract directly from header string to avoid UTC offset shifting the day
      let isoDate = new Date().toISOString().split('T')[0];
      try {
        const MONTHS: Record<string, string> = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
        const m = dateStr.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/);
        if (m) isoDate = `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}`;
        else isoDate = new Date(dateStr).toISOString().split('T')[0];
      } catch {}

      const logged = await logEmailActivity(
        baseId,
        outreachTableId,
        matchedStakeholder.id,
        matchedStakeholder.accountIds,
        msg.id,
        subject,
        snippet,
        isoDate,
        direction,
        payload.email || '',
        airtableKey
      );
      if (logged) {
        synced++;
        // Advance stakeholder Status based on direction
        // - received email → Replied (highest priority for inbound)
        // - sent email → Contacted (only if still Not Contacted)
        const targetStatus = direction === 'received' ? 'Replied' : 'Contacted';
        await advanceStakeholderStatus(baseId, stakeholdersTableId, matchedStakeholder.id, targetStatus, airtableKey);
      }
    }

    const diagMsg = synced > 0
      ? `✅ ${synced} new email(s) logged.${skipped > 0 ? ` (${skipped} already synced, skipped)` : ''} Gmail: ${gmailAccountEmail}, scanned ${emails.length} messages.`
      : skipped > 0
        ? `✅ All up to date — ${skipped} email(s) already synced, nothing new to log.`
        : emails.length === 0
          ? `Gmail "${gmailAccountEmail}" — 0 messages found in last ${daysBack} days.`
          : `No matches. Gmail "${gmailAccountEmail}" had ${emails.length} message(s) but none matched your ${stakeholders.length} contacts' emails.`;

    return new Response(JSON.stringify({ synced, skipped, total: emails.length, contacts: stakeholders.length, message: diagMsg }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });

  } catch (e: any) {
    console.error('[gmail-sync] Error:', e);
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config: Config = { path: '/api/gmail/sync' };
