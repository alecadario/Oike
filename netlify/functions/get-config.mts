import type { Context, Config } from "@netlify/functions";
import { STANDARD_TABLES } from './shared/tables.js';

// ── Build config dynamically from baseId ──
export function buildClientConfig(baseId: string) {
  return {
    baseId,
    tables: { ...STANDARD_TABLES },
    fields: {},
  };
}

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204 });
  }

  const url = new URL(req.url);
  const baseId = req.headers.get('x-base-id') || url.searchParams.get('baseId');

  if (!baseId) {
    return new Response(JSON.stringify({ error: 'Missing base ID' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const config = buildClientConfig(baseId);

  return new Response(JSON.stringify(config), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config: Config = {
  path: "/api/config",
};
