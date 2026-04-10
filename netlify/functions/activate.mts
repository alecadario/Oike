import type { Context, Config } from "@netlify/functions";

// ── Centralized Users base ──
const USERS_TABLE_ID = 'tblBMyzKhFKmPFX25';
const USERS_BASE_ID = 'app3plkFpOx28hhmH';

// ── Password hashing with Web Crypto (SHA-256 + salt) ──
async function hashPassword(password: string, salt?: string): Promise<string> {
  const s = salt || crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const data = new TextEncoder().encode(s + password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashHex = [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${s}:${hashHex}`;
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

  const AIRTABLE_KEY = Netlify.env.get('AIRTABLE_API_KEY');
  if (!AIRTABLE_KEY) {
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const { inviteCode, email, name, password } = body;

    if (!inviteCode || !email || !name || !password) {
      return new Response(JSON.stringify({ error: 'All fields are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (password.length < 6) {
      return new Response(JSON.stringify({ error: 'Password must be at least 6 characters' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Find user by invite code
    const formula = encodeURIComponent(`AND({Código}='${inviteCode}', {Active}=TRUE(), NOT({Activated}))`);
    const url = `https://api.airtable.com/v0/${USERS_BASE_ID}/${USERS_TABLE_ID}?filterByFormula=${formula}&maxRecords=1`;

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_KEY}` },
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'Server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await res.json();

    if (!data.records || data.records.length === 0) {
      return new Response(JSON.stringify({ error: 'Invalid or already used invite code' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const record = data.records[0];

    // Check if email is already taken by another activated user
    const emailCheck = encodeURIComponent(`AND({Email}='${email.trim().toLowerCase()}', {Activated}=TRUE())`);
    const emailUrl = `https://api.airtable.com/v0/${USERS_BASE_ID}/${USERS_TABLE_ID}?filterByFormula=${emailCheck}&maxRecords=1`;
    const emailRes = await fetch(emailUrl, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_KEY}` },
    });
    const emailData = await emailRes.json();

    if (emailData.records && emailData.records.length > 0) {
      return new Response(JSON.stringify({ error: 'This email is already registered' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Hash the password
    const hashedPassword = await hashPassword(password);

    // Update the user record
    const updateUrl = `https://api.airtable.com/v0/${USERS_BASE_ID}/${USERS_TABLE_ID}/${record.id}`;
    const updateRes = await fetch(updateUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          'Name': name.trim(),
          'Email': email.trim().toLowerCase(),
          'Password': hashedPassword,
          'Activated': true,
        },
        typecast: true,
      }),
    });

    if (!updateRes.ok) {
      return new Response(JSON.stringify({ error: 'Failed to activate account' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Account activated. You can now sign in.',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config: Config = {
  path: "/api/auth/activate",
};
