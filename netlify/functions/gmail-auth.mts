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
  if (!secret) throw new Error('JWT_SECRET environment variable is not configured');
  return secret;
}

const REDIRECT_URI = 'https://oike.app/api/gmail/callback';
const SCOPES = 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send';

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204 });

  // Verify user is authenticated
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  const payload = await verifyToken(token, getJwtSecret());
  if (!payload) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const clientId = Netlify.env.get('GOOGLE_CLIENT_ID');
  if (!clientId) {
    return new Response(JSON.stringify({ error: 'Google OAuth not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Encode user email in state so callback knows which user to update
  const state = btoa(payload.email || '');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent', // force refresh token to always be returned
    state,
  });

  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  return new Response(JSON.stringify({ url }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

export const config: Config = { path: '/api/gmail/auth' };
