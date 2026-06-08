import type { Context, Config } from "@netlify/functions";
import { verifyToken, getBearerToken } from './shared/auth.ts';

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204 });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }

  const jwtSecret = Netlify.env.get('JWT_SECRET');
  if (!jwtSecret) return new Response(JSON.stringify({ error: 'Server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  const payload = await verifyToken(getBearerToken(req), jwtSecret);
  if (!payload) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const OPENAI_KEY = Netlify.env.get('OPENAI_API_KEY');
  if (!OPENAI_KEY) {
    return new Response(JSON.stringify({ error: 'OpenAI API key not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const { messages, model = 'gpt-4o', temperature = 0.7, max_tokens = 700 } = body;

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: 'Missing messages array' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature, max_tokens }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[openai-proxy] OpenAI error:', response.status, JSON.stringify(data));
      const errorMsg = data?.error?.message || 'AI request failed';
      return new Response(JSON.stringify({ error: errorMsg }), {
        status: response.status, headers: { 'Content-Type': 'application/json' },
      });
    }

    const content = data.choices?.[0]?.message?.content || '';
    return new Response(JSON.stringify({ content, usage: data.usage }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[openai-proxy] Unhandled error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config: Config = {
  path: "/api/openai",
};
