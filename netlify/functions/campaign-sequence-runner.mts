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
interface Enrollment { step: number; nextDate: string; status: 'active' | 'paused' | 'completed' | 'replied'; senderEmail: string; enrolledDate: string; }
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

function buildMime({ to, subject, body, signature }: { to: string; subject: string; body: string; signature?: string }): string {
  const htmlBody = `<div style="font-family:sans-serif;font-size:14px;">${textToHtml(body)}</div>${signature ? `<br><div>${signature}</div>` : ''}`;
  const raw = [`To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', htmlBody].join('\r\n');
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function sendGmail(to: string, subject: string, body: string, accessToken: string): Promise<string | null> {
  const signature = await getGmailSignature(accessToken);
  const raw = buildMime({ to, subject, body, signature });
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) { console.error('[seq-runner] Gmail send failed:', res.status, await res.text()); return null; }
  const data = await res.json();
  return data.id || null;
}

async function createGmailDraft(to: string, subject: string, body: string, accessToken: string): Promise<string | null> {
  const signature = await getGmailSignature(accessToken);
  const raw = buildMime({ to, subject, body, signature });
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw } }),
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

// ── Main scheduled handler ──
export default async () => {
  const airtableKey = Netlify.env.get('AIRTABLE_API_KEY');
  if (!airtableKey) { console.error('[seq-runner] AIRTABLE_API_KEY not set'); return; }

  const today = new Date().toISOString().split('T')[0];
  console.log(`[seq-runner] Starting run for ${today}`);

  // 1. Get all users to find unique tenant bases + their Gmail refresh tokens
  let users: any[] = [];
  try { users = await getAllRecords(USERS_BASE_ID, USERS_TABLE_ID, airtableKey, ['Email', 'TABLE_IDS', 'Gmail Refresh Token']); }
  catch(e) { console.error('[seq-runner] Failed to fetch users:', e); return; }

  // Build maps: email → refreshToken, and set of unique baseIds to process
  const userRefreshMap: Record<string, string> = {}; // email → refreshToken
  const baseIds = new Set<string>();
  for (const u of users) {
    const email = F(u,'Email');
    const baseId = F(u,'TABLE_IDS');
    const refreshToken = F(u,'Gmail Refresh Token');
    if (email && refreshToken) userRefreshMap[email] = refreshToken;
    if (baseId) baseIds.add(baseId);
  }

  // Cache access tokens per sender email to avoid redundant refreshes
  const accessTokenCache: Record<string, string> = {};
  async function getTokenFor(senderEmail: string): Promise<string | null> {
    if (accessTokenCache[senderEmail]) return accessTokenCache[senderEmail];
    const refreshToken = userRefreshMap[senderEmail];
    if (!refreshToken) return null;
    const token = await getAccessToken(refreshToken);
    if (token) accessTokenCache[senderEmail] = token;
    return token;
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
        let seqCfg: { sendHour: number; timezone: string };
        try {
          steps = JSON.parse(F(campaign,'Sequence Steps') || '[]');
          enrollments = JSON.parse(F(campaign,'Sequence Enrollments') || '{}');
          seqCfg = { sendHour: 9, timezone: 'America/Argentina/Buenos_Aires', ...JSON.parse(F(campaign,'Sequence Config') || '{}') };
        } catch { continue; }
        if (steps.length === 0) continue;

        // Check if current hour in campaign's configured timezone matches the send hour
        try {
          const nowInTz = new Intl.DateTimeFormat('en-US', { timeZone: seqCfg.timezone, hour: 'numeric', hour12: false }).format(new Date());
          const currentHour = parseInt(nowInTz);
          if (currentHour !== seqCfg.sendHour) {
            console.log(`[seq-runner] Campaign "${F(campaign,'Name')}": current hour ${currentHour} != configured ${seqCfg.sendHour} in ${seqCfg.timezone} — skipping`);
            continue;
          }
        } catch(e) {
          console.warn(`[seq-runner] Invalid timezone "${seqCfg.timezone}" — defaulting to UTC`);
          if (new Date().getUTCHours() !== seqCfg.sendHour) continue;
        }

        let enrollmentsChanged = false;

        for (const [stkId, en] of Object.entries(enrollments)) {
          if (en.status !== 'active') continue;
          if (en.nextDate > today) continue;
          if (en.step >= steps.length) { en.status = 'completed'; enrollmentsChanged = true; continue; }

          const step = steps[en.step];
          const stk = stkMap[stkId];
          if (!stk) continue;
          const email = F(stk,'Email');
          if (!email) continue;

          // Check reply condition
          const replied = hasReplied(stkId, outreach, en.enrolledDate);
          if (replied) {
            en.status = 'replied';
            enrollmentsChanged = true;
            console.log(`[seq-runner] ${stkId} replied — marking sequence as replied`);
            continue;
          }
          if (step.condition === 'no_reply' && replied) continue;

          // Generate and send using the email stored at enrollment time
          const senderEmail = en.senderEmail;
          console.log(`[seq-runner] Sending step ${en.step+1} to ${email} from ${senderEmail} (campaign: ${F(campaign,'Name')})`);
          const accessToken = await getTokenFor(senderEmail);
          if (!accessToken) {
            console.warn(`[seq-runner] No Gmail token for ${senderEmail} — skipping`);
            totalSkipped++;
            continue;
          }
          const accId = (Array.isArray(stk.fields?.['Account']) ? stk.fields['Account'][0] : null);
          const acc = accId ? accMap[accId] : null;
          const recentOutreach = outreach.filter(o => linkedIds(o,'Stakeholder').includes(stkId))
            .sort((a,b) => (b.fields?.['Date']||'').localeCompare(a.fields?.['Date']||'')).slice(0,3);

          try {
            const msg = await generateMessage(stk, campaign, step, acc, recentOutreach);
            const lines = msg.split('\n');
            const si = lines.findIndex(l => /^subject:/i.test(l.trim()));
            let subject = `${F(campaign,'Name')} — ${F(stk,'Name')||''}`;
            let body = msg;
            if (si !== -1) { subject = lines[si].replace(/^subject:\s*/i,'').trim(); body = lines.slice(si+1).join('\n').trim(); }

            const isDraft = (step.mode || 'send') === 'draft';
            const gmailId = isDraft
              ? await createGmailDraft(email, subject, body, accessToken)
              : await sendGmail(email, subject, body, accessToken);
            if (gmailId) {
              await logActivity(baseId, outreachTableId, stk, campaign, subject, body, gmailId, senderEmail, airtableKey, isDraft);
              if (!isDraft) await advanceStatus(baseId, stkId, airtableKey);
              totalSent++;
              console.log(`[seq-runner] ${isDraft ? 'Draft created' : 'Sent'} for ${email}`);
            } else {
              totalErrors++;
              console.error(`[seq-runner] ${isDraft ? 'Draft' : 'Send'} failed for ${email}`);
            }

            // Advance to next step
            const nextStepIdx = en.step + 1;
            if (nextStepIdx >= steps.length) {
              en.status = 'completed';
            } else {
              const nextStep = steps[nextStepIdx];
              const nextDate = new Date();
              nextDate.setDate(nextDate.getDate() + nextStep.waitDays);
              en.step = nextStepIdx;
              en.nextDate = nextDate.toISOString().split('T')[0];
            }
            enrollmentsChanged = true;
          } catch(e) {
            console.error(`[seq-runner] Error processing ${stkId}:`, e);
            totalErrors++;
          }

          // Throttle between sends
          await new Promise(r => setTimeout(r, 1500));
        }

        // Save updated enrollments back to Airtable
        if (enrollmentsChanged) {
          try {
            await atFetch(`/${baseId}/${campaignsTableId}/${campaign.id}`, airtableKey, {
              method: 'PATCH',
              body: JSON.stringify({ fields: { 'Sequence Enrollments': JSON.stringify(enrollments) }, typecast: true }),
            });
          } catch(e) { console.error(`[seq-runner] Failed to save enrollments for campaign ${campaign.id}:`, e); }
        }
      }
    } catch(e) {
      console.error(`[seq-runner] Error processing base ${baseId}:`, e);
      totalErrors++;
    }
  }

  console.log(`[seq-runner] Done — sent: ${totalSent}, skipped: ${totalSkipped}, errors: ${totalErrors}`);
};

export const config: Config = {
  schedule: '0 * * * *', // Every hour — each campaign filters by its own configured send time + timezone
};
