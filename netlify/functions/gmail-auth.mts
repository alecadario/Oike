import type { Context, Config } from "@netlify/functions";
import { verifyToken, getBearerToken } from './shared/auth.ts';

const REDIRECT_URI = 'https://oike.app/api/gmail/callback';
const SCOPES = 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send';

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204 });

  const jwtSecret = Netlify.env.get('JWT_SECRET');
  if (!jwtSecret) return new Response(JSON.stringify({ error: 'Server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  const payload = await verifyToken(getBearerToken(req), jwtSecret);
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
