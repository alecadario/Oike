import type { Context, Config } from "@netlify/functions";

// ── Constants ──
const REDIRECT_URI = 'https://oike.app/api/gmail/callback';
const USERS_TABLE_ID = 'tblBMyzKhFKmPFX25';
const USERS_BASE_ID = 'app3plkFpOx28hhmH';

// ── Exchange OAuth code for tokens ──
async function exchangeCode(code: string, clientId: string, clientSecret: string): Promise<{ access_token: string; refresh_token?: string } | null> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) return null;
  return await res.json();
}

// ── Find user record by email and store refresh token ──
async function storeRefreshToken(email: string, refreshToken: string, airtableKey: string): Promise<boolean> {
  const formula = encodeURIComponent(`{Email}='${email}'`);
  const url = `https://api.airtable.com/v0/${USERS_BASE_ID}/${USERS_TABLE_ID}?filterByFormula=${formula}&maxRecords=1`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${airtableKey}` },
  });
  if (!res.ok) return false;

  const data = await res.json();
  if (!data.records || data.records.length === 0) return false;

  const recordId = data.records[0].id;

  // Update the user record with the Gmail refresh token
  const updateRes = await fetch(`https://api.airtable.com/v0/${USERS_BASE_ID}/${USERS_TABLE_ID}/${recordId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${airtableKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: { 'Gmail Refresh Token': refreshToken } }),
  });

  return updateRes.ok;
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const code  = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  // User denied access
  if (error) {
    return Response.redirect('https://oike.app?gmail=denied', 302);
  }

  if (!code || !state) {
    return Response.redirect('https://oike.app?gmail=error', 302);
  }

  // Decode user email from state
  let userEmail = '';
  try { userEmail = atob(state); } catch {
    return Response.redirect('https://oike.app?gmail=error', 302);
  }

  if (!userEmail) {
    return Response.redirect('https://oike.app?gmail=error', 302);
  }

  const clientId     = Netlify.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Netlify.env.get('GOOGLE_CLIENT_SECRET');
  const airtableKey  = Netlify.env.get('AIRTABLE_API_KEY');

  if (!clientId || !clientSecret || !airtableKey) {
    return Response.redirect('https://oike.app?gmail=error', 302);
  }

  // Exchange code for tokens
  const tokens = await exchangeCode(code, clientId, clientSecret);
  if (!tokens || !tokens.refresh_token) {
    return Response.redirect('https://oike.app?gmail=error', 302);
  }

  // Store refresh token in Airtable
  const stored = await storeRefreshToken(userEmail, tokens.refresh_token, airtableKey);
  if (!stored) {
    return Response.redirect('https://oike.app?gmail=error', 302);
  }

  return Response.redirect('https://oike.app?gmail=connected', 302);
};

export const config: Config = { path: '/api/gmail/callback' };
