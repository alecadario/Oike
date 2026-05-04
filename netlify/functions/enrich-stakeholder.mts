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

const AIRTABLE_BASE = 'https://api.airtable.com/v0';
const STAKEHOLDERS_TABLE = 'tblwwNrPg6q2jYxfv';
const ACCOUNTS_TABLE = 'tblkeZ9zXiH2YQJu0';

// ── Utilities ──
function getJwtSecret(): string {
  const secret = Netlify.env.get('JWT_SECRET');
  if (!secret) throw new Error('JWT_SECRET not configured');
  return secret;
}

function extractDomain(url: string): string | null {
  if (!url) return null;
  try {
    const clean = url.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].split('?')[0];
    if (!clean || !clean.includes('.')) return null;
    return clean.toLowerCase();
  } catch { return null; }
}

function mapDropcontactQualification(q: string): string {
  const s = String(q || '').toLowerCase();
  if (s.includes('nominative') || s === 'ok' || s.includes('valid')) return 'valid';
  if (s.includes('pro')) return 'valid';
  if (s.includes('catch')) return 'catch_all';
  if (s.includes('risk')) return 'risky';
  if (s.includes('invalid') || s.includes('unreach')) return 'invalid';
  return 'risky';
}

function mapSnovStatus(emailStatus: string, smtpStatus: string): string {
  const s = String(emailStatus || '').toLowerCase();
  const sm = String(smtpStatus || '').toLowerCase();
  // Verified + smtp yes → highest confidence
  if (s === 'verified' && sm === 'yes') return 'valid';
  if (s === 'verified') return 'valid';
  // smtp yes alone → still valid
  if (sm === 'yes') return 'valid';
  // smtp no → invalid
  if (sm === 'no') return 'invalid';
  // Catch-all detection
  if (s.includes('catch') || sm.includes('catch')) return 'catch_all';
  // Otherwise risky/unverified
  return 'risky';
}

function confidenceFromQualification(q: string): number {
  switch (q) {
    case 'valid': return 95;
    case 'catch_all': return 60;
    case 'risky': return 40;
    case 'invalid': return 10;
    default: return 50;
  }
}

// ── Airtable helpers ──
async function airtableGet(baseId: string, tableId: string, recordId: string, key: string) {
  const res = await fetch(`${AIRTABLE_BASE}/${baseId}/${tableId}/${recordId}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Airtable GET ${tableId}/${recordId} -> ${res.status}`);
  return res.json();
}

async function airtablePatch(baseId: string, tableId: string, recordId: string, fields: Record<string, any>, key: string) {
  const res = await fetch(`${AIRTABLE_BASE}/${baseId}/${tableId}/${recordId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Airtable PATCH ${tableId}/${recordId} -> ${res.status}: ${err}`);
  }
  return res.json();
}

// ── Dropcontact ──
async function enrichWithDropcontact(firstName: string, lastName: string, domain: string | null, apiKey: string) {
  const payload: any = {
    data: [{
      first_name: firstName,
      last_name: lastName,
      ...(domain ? { website: domain } : {}),
    }],
    siren: false,
    language: 'en',
  };
  const submit = await fetch('https://api.dropcontact.io/batch', {
    method: 'POST',
    headers: { 'X-Access-Token': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const submitData: any = await submit.json().catch(() => ({}));
  if (!submit.ok || !submitData.request_id) {
    return { ok: false, reason: `submit-failed: ${submitData?.reason || submit.status}` };
  }
  const requestId = submitData.request_id;

  // Poll up to 6 seconds (3 polls × 2s)
  for (let i = 0; i < 3; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(`https://api.dropcontact.io/batch/${requestId}?token=${encodeURIComponent(apiKey)}`, {
      headers: { 'X-Access-Token': apiKey },
    });
    const pollData: any = await pollRes.json().catch(() => ({}));
    if (pollData?.success && Array.isArray(pollData.data) && pollData.data.length > 0) {
      const row = pollData.data[0];
      const emails = Array.isArray(row.email) ? row.email : [];
      if (emails.length > 0 && emails[0].email) {
        const qualification = mapDropcontactQualification(emails[0].qualification || 'valid');
        return {
          ok: true,
          email: String(emails[0].email).toLowerCase(),
          qualification,
          confidence: confidenceFromQualification(qualification),
          source: 'dropcontact',
        };
      }
      return { ok: false, reason: 'no-match' };
    }
  }
  return { ok: false, reason: 'timeout' };
}

// ── Snov.io (fallback) ──
async function getSnovToken(userId: string, secret: string): Promise<string | null> {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: userId,
    client_secret: secret,
  });
  const res = await fetch('https://api.snov.io/v1/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    console.error('[snov] auth failed:', res.status, JSON.stringify(data).slice(0, 200));
    return null;
  }
  return data.access_token;
}

async function enrichWithSnov(firstName: string, lastName: string, domain: string | null, userId: string, secret: string) {
  if (!domain) return { ok: false, reason: 'snov-no-domain' };

  const token = await getSnovToken(userId, secret);
  if (!token) return { ok: false, reason: 'snov-auth-failed' };

  // Find email by name + domain
  const params = new URLSearchParams({
    firstName,
    lastName,
    domain,
  });
  const res = await fetch('https://api.snov.io/v1/get-emails-from-names', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data: any = await res.json().catch(() => ({}));

  if (!res.ok) {
    const apiMsg = data?.message || data?.error || JSON.stringify(data).slice(0, 120);
    console.error('[snov] HTTP error:', res.status, apiMsg);
    return { ok: false, reason: `snov-${res.status}: ${apiMsg}` };
  }

  if (!data?.success) {
    return { ok: false, reason: `snov-error: ${data?.message || 'unknown'}` };
  }

  const emails = data?.data?.emails || [];
  if (!Array.isArray(emails) || emails.length === 0) {
    return { ok: false, reason: 'snov-no-match' };
  }

  // Pick best email — prefer verified + smtp_status yes
  const sorted = [...emails].sort((a: any, b: any) => {
    const score = (e: any) => {
      const verified = String(e.status || '').toLowerCase() === 'verified' ? 2 : 0;
      const smtp = String(e.smtp_status || '').toLowerCase() === 'yes' ? 1 : 0;
      return verified + smtp;
    };
    return score(b) - score(a);
  });
  const best = sorted[0];
  if (!best?.email) return { ok: false, reason: 'snov-no-email' };

  const qualification = mapSnovStatus(best.status || '', best.smtp_status || '');
  return {
    ok: true,
    email: String(best.email).toLowerCase(),
    qualification,
    confidence: confidenceFromQualification(qualification),
    source: 'snov',
  };
}

// ── Handler ──
export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204 });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Auth
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  const payload = await verifyToken(token, getJwtSecret());
  if (!payload) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const AIRTABLE_KEY = Netlify.env.get('AIRTABLE_API_KEY');
  const DROPCONTACT_KEY = Netlify.env.get('DROPCONTACT_API_KEY');
  const SNOVIO_USER_ID = Netlify.env.get('SNOVIO_USER_ID');
  const SNOVIO_SECRET = Netlify.env.get('SNOVIO_SECRET');
  const SNOVIO_CONFIGURED = !!(SNOVIO_USER_ID && SNOVIO_SECRET);
  if (!AIRTABLE_KEY) {
    return new Response(JSON.stringify({ error: 'Airtable API key not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!DROPCONTACT_KEY && !SNOVIO_CONFIGURED) {
    return new Response(JSON.stringify({ error: 'No enrichment provider configured (Dropcontact or Snov.io)' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const { stakeholder_id, base_id, force } = body;
  if (!stakeholder_id || !base_id) {
    return new Response(JSON.stringify({ error: 'Missing stakeholder_id or base_id' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // 1. Get stakeholder
    const stakeholder = await airtableGet(base_id, STAKEHOLDERS_TABLE, stakeholder_id, AIRTABLE_KEY);
    const fields = stakeholder.fields || {};
    const firstName = String(fields['Name'] || '').trim();
    const lastName = String(fields['Last name'] || '').trim();
    const currentEmail = String(fields['Email'] || '').trim();
    const lastAttempt = fields['enrichment_last_attempt'];
    const currentStatus = fields['enrichment_status'];

    if (!firstName || !lastName) {
      return new Response(JSON.stringify({ error: 'Stakeholder missing Name or Last name' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Cache guard (skip if enriched <90 days ago, unless force=true)
    if (!force && currentStatus === 'enriched' && lastAttempt) {
      const ageMs = Date.now() - new Date(lastAttempt).getTime();
      if (ageMs < 90 * 24 * 60 * 60 * 1000) {
        return new Response(JSON.stringify({
          ok: true, cached: true, email: currentEmail,
          message: 'Already enriched within 90 days (use force=true to re-run)',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // 3. Get company domain from linked Account
    let domain: string | null = null;
    const accountLinks = fields['Account'];
    if (Array.isArray(accountLinks) && accountLinks.length > 0) {
      try {
        const account = await airtableGet(base_id, ACCOUNTS_TABLE, accountLinks[0], AIRTABLE_KEY);
        const website = account?.fields?.['Website'];
        domain = extractDomain(website);
      } catch (e) {
        console.warn('[enrich-stakeholder] Could not load account domain:', e);
      }
    }

    // 4. Waterfall: Dropcontact → Snov.io fallback
    let result: any = { ok: false, reason: 'no-provider-configured' };
    const providersTried: string[] = [];
    let dropcontactReason = '';
    let snovReason = '';

    if (DROPCONTACT_KEY) {
      providersTried.push('dropcontact');
      result = await enrichWithDropcontact(firstName, lastName, domain, DROPCONTACT_KEY);
      if (!result.ok) dropcontactReason = result.reason || 'unknown';
    }
    if (!result.ok && SNOVIO_CONFIGURED) {
      providersTried.push('snov');
      const snovResult = await enrichWithSnov(firstName, lastName, domain, SNOVIO_USER_ID!, SNOVIO_SECRET!);
      if (snovResult.ok) {
        result = snovResult;
      } else {
        snovReason = snovResult.reason || 'unknown';
      }
    }

    // 5. Save to Airtable
    const today = new Date().toISOString().slice(0, 10);
    const updateFields: Record<string, any> = {
      enrichment_last_attempt: today,
    };

    if (result.ok) {
      updateFields['Email'] = result.email;
      updateFields['email_confidence'] = result.confidence;
      updateFields['email_source'] = result.source;
      updateFields['email_qualification'] = result.qualification;
      updateFields['enrichment_status'] = 'enriched';
    } else {
      updateFields['enrichment_status'] = result.reason === 'no-match' || result.reason === 'no-email' ? 'no_match' : 'failed';
    }

    await airtablePatch(base_id, STAKEHOLDERS_TABLE, stakeholder_id, updateFields, AIRTABLE_KEY);

    return new Response(JSON.stringify({
      ok: result.ok,
      email: result.ok ? result.email : null,
      confidence: result.ok ? result.confidence : null,
      source: result.ok ? result.source : null,
      qualification: result.ok ? result.qualification : null,
      status: updateFields['enrichment_status'],
      reason: result.ok ? null : result.reason,
      domain_used: domain,
      providers_tried: providersTried,
      dropcontact_reason: dropcontactReason || null,
      snov_reason: snovReason || null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[enrich-stakeholder] Error:', error);
    // Best-effort: mark as failed in Airtable
    try {
      await airtablePatch(base_id, STAKEHOLDERS_TABLE, stakeholder_id, {
        enrichment_status: 'failed',
        enrichment_last_attempt: new Date().toISOString().slice(0, 10),
      }, AIRTABLE_KEY);
    } catch {}
    return new Response(JSON.stringify({ error: error.message || 'Internal error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config: Config = {
  path: "/api/enrich-stakeholder",
};
