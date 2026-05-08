import type { Context, Config } from "@netlify/functions";

// ── Inline config (no cross-file imports) ──
const STANDARD_TABLES: Record<string, string> = {
  accounts: 'tblkeZ9zXiH2YQJu0',
  stakeholders: 'tblwwNrPg6q2jYxfv',
  opportunities: 'tbljQCLi82To2DPvT',
  actionPlan: 'tblbn0GDUO8i0g7bX',
  outreach: 'tblAvzPQnug9VBcX5',
  solutions: 'tbl1Ji8Mr8eBcAf15',
  events: 'tblQj3t4HUsmmnPiN',
  clientPartners: 'tblwBsDhNdAvcMwzy',
  sources: 'tblciUlYmvQHJm71w',
  users: 'tblCyjbxtx0MTPYq9',
  strategy: 'tblMER8W7Q25Rkegd',
  proposals: 'tblyjHMsB9BbuFYUo',
  campaigns: 'tblHFXH59guU4QIVU',
  contentLab: 'tblUaBbUYHnLLKW01',
  landings: 'tblf3djqCQ5KZJgGT',
};

function buildClientConfig(baseId: string) {
  return { baseId, tables: { ...STANDARD_TABLES }, fields: {} };
}

// ── Simple JWT implementation (HMAC-SHA256) ──

async function createToken(payload: Record<string, any>, secret: string, expiresInHours = 72): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInHours * 3600 };

  const encode = (obj: any) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const headerB64 = encode(header);
  const payloadB64 = encode(fullPayload);
  const data = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return `${data}.${sigB64}`;
}

export async function verifyToken(token: string, secret: string): Promise<Record<string, any> | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, sigB64] = parts;
    const data = `${headerB64}.${payloadB64}`;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const sigStr = atob(sigB64.replace(/-/g, '+').replace(/_/g, '/'));
    const sigBytes = new Uint8Array([...sigStr].map((c) => c.charCodeAt(0)));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));

    if (!valid) return null;

    const payloadStr = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadStr);

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

// ── Password verification ──
async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const data = new TextEncoder().encode(salt + password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashHex = [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex === hash;
}

function getJwtSecret(): string {
  const secret = Netlify.env.get('JWT_SECRET');
  if (!secret) throw new Error('JWT_SECRET environment variable is not configured');
  return secret;
}

// ── Airtable user lookup ──
// ── Centralized Users base (separate from client bases) ──
const USERS_TABLE_ID = 'tblBMyzKhFKmPFX25';
const USERS_BASE_ID = 'app3plkFpOx28hhmH';

async function findAndValidateUser(email: string, password: string) {
  const AIRTABLE_KEY = Netlify.env.get('AIRTABLE_API_KEY');
  if (!AIRTABLE_KEY) return null;

  // Find activated user by email
  const formula = encodeURIComponent(`AND({Email}='${email}', {Active}=TRUE(), {Activated}=TRUE())`);
  const url = `https://api.airtable.com/v0/${USERS_BASE_ID}/${USERS_TABLE_ID}?filterByFormula=${formula}&maxRecords=1`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${AIRTABLE_KEY}` },
  });

  if (!res.ok) return null;
  const data = await res.json();

  if (!data.records || data.records.length === 0) return null;

  const record = data.records[0];
  const fields = record.fields;

  // Verify password
  const storedPassword = fields['Password'] || '';
  if (!storedPassword) return null;

  const passwordValid = await verifyPassword(password, storedPassword);
  if (!passwordValid) return null;

  const baseId = fields['TABLE_IDS'] || '';
  const userName = fields['Name'] || '';

  // Look up the user's record ID in the CLIENT's users table (not the central auth base).
  // This ID is what accounts' linked fields (BDR, CP, etc.) actually reference.
  let clientRecordId = '';
  if (baseId && AIRTABLE_KEY) {
    try {
      const clientUsersTableId = STANDARD_TABLES.users;
      const nameFormula = encodeURIComponent(`{Name}='${userName.replace(/'/g, "\\'")}'`);
      const clientUrl = `https://api.airtable.com/v0/${baseId}/${clientUsersTableId}?filterByFormula=${nameFormula}&maxRecords=1`;
      const clientRes = await fetch(clientUrl, {
        headers: { 'Authorization': `Bearer ${AIRTABLE_KEY}` },
      });
      if (clientRes.ok) {
        const clientData = await clientRes.json();
        clientRecordId = clientData.records?.[0]?.id || '';
      }
    } catch (e) {
      console.warn('[auth] Could not look up client record ID:', e);
    }
  }

  return {
    email: fields['Email'] || email,
    name: userName,
    role: (typeof fields['Role'] === 'object' && fields['Role']?.name) ? fields['Role'].name : (fields['Role'] || 'viewer'),
    baseId,
    airtableRecordId: record.id,
    clientRecordId, // Record ID in the CLIENT's users table (used for BDR/CP filtering)
  };
}

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204 });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const { email, password } = body;

    if (!email || !password) {
      return new Response(JSON.stringify({ error: 'Email and password are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const user = await findAndValidateUser(email.trim().toLowerCase(), password);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Invalid email or password' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const clientConfig = buildClientConfig(user.baseId);
    const secret = getJwtSecret();

    const token = await createToken(
      {
        email: user.email,
        name: user.name,
        role: user.role,
        baseId: user.baseId,
      },
      secret
    );

    return new Response(JSON.stringify({
      token,
      user: { email: user.email, name: user.name, role: user.role, clientRecordId: user.clientRecordId },
      baseId: user.baseId,
      config: clientConfig,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[auth] Unhandled error:', error);
    return new Response(JSON.stringify({ error: 'Authentication failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config: Config = {
  path: "/api/auth/login",
};
