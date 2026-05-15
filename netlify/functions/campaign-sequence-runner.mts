import type { Config } from "@netlify/functions";

const AIRTABLE_BASE = 'https://api.airtable.com/v0';
const USERS_BASE_ID  = 'app3plkFpOx28hhmH';
const USERS_TABLE_ID = 'tblBMyzKhFKmPFX25';
const STAKEHOLDERS_TABLE = 'tblwwNrPg6q2jYxfv';

// Standard table IDs (same across all client bases)
const T = {
  campaigns:    'tblHFXH59guU4QIVU',
  outreach:     'tblAvzPQnug9VBcX5',
  stakeholders: 'tblwwNrPg6q2jYxfv',
  accounts:     'tblkeZ9zXiH2YQJu0',
};

// ── Types ──
interface SeqStep   { waitDays: number; channel: string; condition: 'always' | 'no_reply'; note: string; mode?: 'send' | 'draft'; }
interface Enrollment { step: number; nextDate: string; nextDateTime?: string; status: 'active' | 'paused' | 'completed' | 'replied'; senderEmail: string; enrolledDate: string; gmailThreadId?: string; gmailSubject?: string; }
type Enrollments = Record<string, Enrollment>;

// ── Airtable helpers ──
async function atFetch(path: string, key: string, opts: RequestInit = {}) {
  const res = await fetch(`${AIRTABLE_BASE}${path}`, {
    ...opts,
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getAllRecords(baseId: string, tableId: string, key: string, fields?: string[]): Promise<any[]> {
  const records: any[] = [];
  let offset: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (offset) params.set('offset', offset);
    if (fields) params.set('fields[]', fields.join('&fields[]='));
    const data = await atFetch(`/${baseId}/${tableId}?${params}`, key);
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records;
}

function F(rec: any, field: string): string { return rec?.fields?.[field] || ''; }
function linkedIds(rec: any, field: string): string[] { return Array.isArray(rec?.fields?.[field]) ? rec.fields[field] : []; }

// ── Gmail helpers ──
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

function textToHtml(text: string): string {
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

function encodeSubject(subject: string): string {
  if (!/[^\x00-\x7F]/.test(subject)) return subject;
  const bytes = new TextEncoder().encode(subject);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

function buildMime({ to, subject, body, signature, threadId }: { to: string; subject: string; body: string; signature?: string; threadId?: string }): string {
  const reSubject = threadId && !subject.toLowerCase().startsWith('re:') ? `Re: ${subject}` : subject;
  const htmlBody = `<div style="font-family:sans-serif;font-size:14px;">${textToHtml(body)}</div>${signature ? `<br><div>${signature}</div>` : ''}`;
  const raw = [`To: ${to}`, `Subject: ${encodeSubject(reSubject)}`, 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', htmlBody].join('\r\n');
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

// Returns { gmailMsgId, gmailThreadId } or null on failure
async function sendGmail(to: string, subject: string, body: string, accessToken: string, threadId?: string): Promise<{ gmailMsgId: string; gmailThreadId: string } | null> {
  const signature = await getGmailSignature(accessToken);
  const raw = buildMime({ to, subject, body, signature, threadId });
  const payload: Record<string, any> = { raw };
  if (threadId) payload.threadId = threadId;
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) { console.error('[seq-runner] Gmail send failed:', res.status, await res.text()); return null; }
  const data = await res.json();
  return data.id ? { gmailMsgId: data.id, gmailThreadId: data.threadId || data.id } : null;
}

async function createGmailDraft(to: string, subject: string, body: string, accessToken: string, threadId?: string): Promise<string | null> {
  const signature = await getGmailSignature(accessToken);
  const raw = buildMime({ to, subject, body, signature, threadId });
  const msgPayload: Record<string, any> = { raw };
  if (threadId) msgPayload.threadId = threadId;
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msgPayload }),
  });
  if (!res.ok) { console.error('[seq-runner] Gmail draft failed:', res.status, await res.text()); return null; }
  const data = await res.json();
  return data.id || null;
}

// ── OpenAI message generation ──
async function generateMessage(stk: any, campaign: any, step: SeqStep, acc: any | null, recentOutreach: any[]): Promise<string> {
  const openaiKey = Netlify.env.get('OPENAI_API_KEY');
  const sName = `${F(stk,'Name')||''} ${F(stk,'Last name')||''}`.trim();
  const role = F(stk,'Role') || '';
  const pain = (F(stk,'Pain Points (Generated)') || F(stk,'Pain points') || '').slice(0,300);
  const linkedinNews = (F(stk,'LinkedIn News (Generated)') || F(stk,'Linkedin lates news') || '').slice(0,200);
  const accName = acc ? F(acc,'Account Name') : '';
  const industry = acc ? F(acc,'Industry') : '';
  const accNews = acc ? (F(acc,'Recent News')||'').slice(0,150) : '';
  const history = recentOutreach.slice(0,3).map(o => `[${F(o,'Channel')||'?'}] ${(F(o,'Message')||'').slice(0,100)}`).join('\n') || 'First contact';
  const campaignName = F(campaign,'Name') || '';
  const campaignType = F(campaign,'Type') || '';
  const template = F(campaign,'Message Template') || '';
  const campaignContext = (F(campaign,'Context') || '').slice(0,600);
  const stepNote = step.note || (step.condition === 'no_reply' ? 'Follow-up / breakup' : 'First contact');

  const prompt = `B2B sales rep. Write ONE personalized email. Start with "Subject: [subject]", blank line, body. Max 3 sentences. No fluff.

CONTACT: ${sName} | ${role} | ${accName}${industry ? ` — ${industry}` : ''}
${pain ? `Pain: ${pain}` : ''}${linkedinNews ? `\nLinkedIn: ${linkedinNews}` : ''}${accNews ? `\nCompany news: ${accNews}` : ''}
History: ${history}
STEP: ${stepNote} (day ${step.waitDays} of sequence)
CAMPAIGN: "${campaignName}" (${campaignType})
${campaignContext ? `CAMPAIGN CONTEXT:\n${campaignContext}\n` : ''}${template ? `Angle (rewrite for this person, DO NOT copy verbatim): "${template.slice(0,300)}"` : ''}
BANNED: "following up"/"checking in"/"hope this finds you"/"touching base"/brackets/placeholders.`;

  if (!openaiKey) return `Hi ${sName}, I wanted to reach out about ${campaignName}. Would love to connect quickly.`;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], temperature: 0.75, max_tokens: 250 }),
  });
  if (!res.ok) return `Hi ${sName}, I wanted to connect about ${campaignName}.`;
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || `Hi ${sName}, I wanted to connect about ${campaignName}.`;
}

// ── Check if stakeholder has replied since enrollment ──
function hasReplied(stkId: string, outreach: any[], enrolledDate: string): boolean {
  return outreach.some(o => {
    if (!linkedIds(o,'Stakeholder').includes(stkId)) return false;
    const status = F(o,'Status').toLowerCase();
    if (!['received','replied'].includes(status)) return false;
    const date = o.fields?.['Date'] || '';
    return date >= enrolledDate;
  });
}

// ── Log sent email to Airtable outreach table ──
async function logActivity(baseId: string, outreachTableId: string, stk: any, campaign: any, subject: string, body: string, gmailId: string, senderEmail: string, key: string, isDraft = false): Promise<void> {
  const sName = `${F(stk,'Name')||''} ${F(stk,'Last name')||''}`.trim();
  const today = new Date().toISOString().split('T')[0];
  const prefix = isDraft ? '[DRAFT] ' : '';
  await atFetch(`/${baseId}/${outreachTableId}`, key, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields: {
      'Channel': 'Email', 'Status': isDraft ? 'Draft' : 'Sent',
      'Activity Name': `${prefix}[Sequence] ${F(campaign,'Name')} — ${sName} — ${today}`,
      'Notes': `[gmsg:${gmailId}]\n${subject}\n\n${body.slice(0,300)}`,
      'Message': body, 'Stakeholder': [stk.id],
      'Account': linkedIds(stk,'Account'),
      'Date': today, 'Logged By': senderEmail,
    }}], typecast: true }),
  });
}

// ── Advance stakeholder status if not protected ──
async function advanceStatus(baseId: string, stkId: string, airtableKey: string): Promise<void> {
  try {
    const rec = await atFetch(`/${baseId}/${STAKEHOLDERS_TABLE}/${stkId}`, airtableKey);
    const current = String(rec?.fields?.['Status'] || '').trim();
    const PROTECTED = ['DNC','Left Company','Not Interested','Nurture','Bounced','Replied','Meeting Booked'];
    if (PROTECTED.includes(current)) return;
    if (current === 'Contacted') return;
    await atFetch(`/${baseId}/${STAKEHOLDERS_TABLE}/${stkId}`, airtableKey, {
      method: 'PATCH',
      body: JSON.stringify({ fields: { 'Status': 'Contacted' }, typecast: true }),
    });
  } catch {}
}

// ── Main handler (works for both HTTP triggers and scheduled runs) ──
export default async (req?: Request) => {
  const airtableKey = Netlify.env.get('AIRTABLE_API_KEY');
  if (!airtableKey) {
    console.error('[seq-runner] AIRTABLE_API_KEY not set');
    return new Response(JSON.stringify({ error: 'missing key' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const today = new Date().toISOString().split('T')[0];
  console.log(`[seq-runner] Starting run for ${today}`);

  // 1. Get all users to find unique tenant bases
  let users: any[] = [];
  try { users = await getAllRecords(USERS_BASE_ID, USERS_TABLE_ID, airtableKey); }
  catch(e) { console.error('[seq-runner] Failed to fetch users:', e); return new Response(JSON.stringify({ error: 'failed to fetch users' }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }

  console.log(`[seq-runner] Found ${users.length} users`);

  // Build set of unique baseIds to process
  const baseIds = new Set<string>();
  for (const u of users) {
    const baseId = F(u,'TABLE_IDS');
    if (baseId) baseIds.add(baseId);
  }
  console.log(`[seq-runner] Base IDs to process: ${[...baseIds].join(', ') || '(none)'}`);

  // ── Per-email token cache + direct Airtable lookup (same approach as gmail-send.mts) ──
  const accessTokenCache: Record<string, string> = {};
  async function getTokenFor(senderEmail: string): Promise<string | null> {
    if (accessTokenCache[senderEmail]) return accessTokenCache[senderEmail];
    // Direct Airtable lookup — reliable, works even if pre-load missed the user
    try {
      const formula = encodeURIComponent(`AND({Email}='${senderEmail}',{Gmail Refresh Token}!='')`);
      const res = await fetch(`https://api.airtable.com/v0/${USERS_BASE_ID}/${USERS_TABLE_ID}?filterByFormula=${formula}&maxRecords=1`, {
        headers: { 'Authorization': `Bearer ${airtableKey}` },
      });
      if (!res.ok) { console.warn(`[seq-runner] Airtable user lookup failed for ${senderEmail}: ${res.status}`); return null; }
      const data = await res.json();
      const refreshToken = data.records?.[0]?.fields?.['Gmail Refresh Token'] || null;
      if (!refreshToken) { console.warn(`[seq-runner] No Gmail Refresh Token found for ${senderEmail}`); return null; }
      const token = await getAccessToken(refreshToken);
      if (token) accessTokenCache[senderEmail] = token;
      return token;
    } catch(e) { console.error(`[seq-runner] Error fetching token for ${senderEmail}:`, e); return null; }
  }

  let totalSent = 0, totalSkipped = 0, totalErrors = 0;

  // 2. Process each tenant base
  for (const baseId of baseIds) {
    console.log(`[seq-runner] Processing base ${baseId}`);
    try {
      const campaignsTableId    = T.campaigns;
      const outreachTableId     = T.outreach;
      const stakeholdersTableId = T.stakeholders;
      const accountsTableId     = T.accounts;

      // Fetch campaigns with sequence steps
      const campaigns = await getAllRecords(baseId, campaignsTableId, airtableKey, ['Name','Type','Status','Sequence Steps','Sequence Enrollments','Sequence Config','Message Template','Asset URL','Context','AI Summary']);
      const activeCampaigns = campaigns.filter(c => {
        if (F(c,'Status') === 'Paused' || F(c,'Status') === 'Completed') return false;
        const steps = F(c,'Sequence Steps');
        const enrollments = F(c,'Sequence Enrollments');
        return steps && enrollments && steps !== '[]' && enrollments !== '{}';
      });

      console.log(`[seq-runner] ${campaigns.length} campaigns total, ${activeCampaigns.length} active with enrollments`);
      if (activeCampaigns.length === 0) continue;

      // Fetch supporting data once per base
      const [stakeholders, outreach, accounts] = await Promise.all([
        getAllRecords(baseId, stakeholdersTableId, airtableKey, ['Name','Last name','Email','Role','Level of Influence','Pain Points (Generated)','Pain points','LinkedIn News (Generated)','Linkedin lates news','Account','Status']),
        getAllRecords(baseId, outreachTableId, airtableKey, ['Stakeholder','Channel','Status','Message','Date']),
        getAllRecords(baseId, accountsTableId, airtableKey, ['Account Name','Industry','Recent News']),
      ]);

      const stkMap = Object.fromEntries(stakeholders.map(s => [s.id, s]));
      const accMap = Object.fromEntries(accounts.map(a => [a.id, a]));

      for (const campaign of activeCampaigns) {
        let steps: SeqStep[];
        let enrollments: Enrollments;
        let seqCfg: { sendHour: number; timezone: string; active?: boolean };
        try {
          steps = JSON.parse(F(campaign,'Sequence Steps') || '[]');
          enrollments = JSON.parse(F(campaign,'Sequence Enrollments') || '{}');
          seqCfg = { sendHour: 9, timezone: 'America/Argentina/Buenos_Aires', ...JSON.parse(F(campaign,'Sequence Config') || '{}') };
        } catch { continue; }
        if (steps.length === 0) continue;

        // Check if sequence is paused
        if (seqCfg.active === false) {
          console.log(`[seq-runner] Campaign "${F(campaign,'Name')}": sequence is paused — skipping`);
          continue;
        }

        let enrollmentsChanged = false;

        // ── Filter to due enrollments ──
        const dueEntries = Object.entries(enrollments).filter(([stkId, en]) => {
          if (en.status !== 'active') return false;
          if (en.step >= steps.length) { en.status = 'completed'; enrollmentsChanged = true; return false; }
          const isDue = en.nextDateTime ? new Date(en.nextDateTime) <= new Date() : en.nextDate <= today;
          if (!isDue) { console.log(`[seq-runner] ${stkId} not due — nextDate: ${en.nextDate}`); return false; }
          return true;
        });

        console.log(`[seq-runner] Campaign "${F(campaign,'Name')}": ${dueEntries.length} enrollments due`);
        if (dueEntries.length === 0) continue;

        // ── Pre-fetch Gmail tokens for all unique senders (parallel) ──
        const uniqueSenders = [...new Set(dueEntries.map(([,en]) => en.senderEmail).filter(Boolean))];
        console.log(`[seq-runner] Unique senders: ${uniqueSenders.join(', ')}`);
        await Promise.all(uniqueSenders.map(email => getTokenFor(email))); // warms cache

        // ── Process all due enrollments in parallel ──
        const results = await Promise.allSettled(dueEntries.map(async ([stkId, en]) => {
          const step = steps[en.step];
          const stk = stkMap[stkId];
          if (!stk) throw new Error(`Stakeholder ${stkId} not found`);
          const email = F(stk,'Email');
          if (!email) throw new Error(`No email for ${stkId}`);

          // Check reply
          const replied = hasReplied(stkId, outreach, en.enrolledDate);
          if (replied) { en.status = 'replied'; return 'replied'; }
          if (step.condition === 'no_reply' && replied) return 'skipped-replied';

          const senderEmail = en.senderEmail;
          const accessToken = await getTokenFor(senderEmail);
          if (!accessToken) {
            console.warn(`[seq-runner] No Gmail token for "${senderEmail}"`);
            return 'skipped-no-token';
          }

          const accId = Array.isArray(stk.fields?.['Account']) ? stk.fields['Account'][0] : null;
          const acc = accId ? accMap[accId] : null;
          const recentOutreach = outreach
            .filter(o => linkedIds(o,'Stakeholder').includes(stkId))
            .sort((a,b) => (b.fields?.['Date']||'').localeCompare(a.fields?.['Date']||''))
            .slice(0,3);

          const msg = await generateMessage(stk, campaign, step, acc, recentOutreach);
          const lines = msg.split('\n');
          const si = lines.findIndex(l => /^subject:/i.test(l.trim()));
          let subject = en.gmailSubject || `${F(campaign,'Name')} — ${F(stk,'Name')||''}`;
          let body = msg;
          if (si !== -1) {
            if (!en.gmailThreadId) subject = lines[si].replace(/^subject:\s*/i,'').trim();
            body = lines.slice(si+1).join('\n').trim();
          }

          const isDraft = (seqCfg as any).sendMode === 'draft';
          const existingThreadId = en.gmailThreadId;

          let gmailId: string | null = null;
          if (isDraft) {
            gmailId = await createGmailDraft(email, subject, body, accessToken, existingThreadId);
          } else {
            const result = await sendGmail(email, subject, body, accessToken, existingThreadId);
            if (result) {
              gmailId = result.gmailMsgId;
              if (!en.gmailThreadId) { en.gmailThreadId = result.gmailThreadId; en.gmailSubject = subject; }
            }
          }

          if (!gmailId) throw new Error(`Gmail ${isDraft ? 'draft' : 'send'} failed for ${email}`);

          await logActivity(baseId, outreachTableId, stk, campaign, subject, body, gmailId, senderEmail, airtableKey, isDraft);
          if (!isDraft) await advanceStatus(baseId, stkId, airtableKey);
          console.log(`[seq-runner] ✅ ${isDraft ? 'Draft' : 'Sent'} step ${en.step+1} → ${email}`);

          // Advance enrollment to next step
          const nextIdx = en.step + 1;
          if (nextIdx >= steps.length) {
            en.status = 'completed';
          } else {
            const base = en.nextDateTime ? new Date(en.nextDateTime) : new Date();
            base.setDate(base.getDate() + steps[nextIdx].waitDays);
            en.step = nextIdx;
            en.nextDateTime = base.toISOString();
            en.nextDate = base.toISOString().split('T')[0];
          }
          return 'sent';
        }));

        // Tally results
        for (const r of results) {
          if (r.status === 'fulfilled') {
            if (r.value === 'sent') { totalSent++; enrollmentsChanged = true; }
            else if (r.value === 'replied') { enrollmentsChanged = true; }
            else if (r.value === 'skipped-no-token') totalSkipped++;
          } else {
            console.error(`[seq-runner] Error:`, r.reason);
            totalErrors++;
          }
        }

        // Save updated enrollments + last run metadata back to Airtable
        const campaignSentCount = Object.values(enrollments).filter(e => e.status !== 'active').length; // rough proxy
        try {
          await atFetch(`/${baseId}/${campaignsTableId}/${campaign.id}`, airtableKey, {
            method: 'PATCH',
            body: JSON.stringify({ fields: {
              ...(enrollmentsChanged ? { 'Sequence Enrollments': JSON.stringify(enrollments) } : {}),
              'Last Run': new Date().toISOString(),
              'Last Run Result': `${totalSent} sent · ${totalSkipped} skipped · ${totalErrors} errors`,
            }, typecast: true }),
          });
        } catch(e) { console.error(`[seq-runner] Failed to save campaign metadata for ${campaign.id}:`, e); }
      }
    } catch(e) {
      console.error(`[seq-runner] Error processing base ${baseId}:`, e);
      totalErrors++;
    }
  }

  console.log(`[seq-runner] Done — sent: ${totalSent}, skipped: ${totalSkipped}, errors: ${totalErrors}`);
  return new Response(
    JSON.stringify({ v: 4, sent: totalSent, skipped: totalSkipped, errors: totalErrors }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export const config: Config = {
  schedule: '0 * * * *', // Every hour — each campaign filters by its own configured send time + timezone
};
