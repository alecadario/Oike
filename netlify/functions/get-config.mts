import type { Context, Config } from "@netlify/functions";

// ── Standard table IDs (preserved across duplicated bases) ──
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
  icp: 'tblli6WqjCqArxZKx',
  strategy: 'tblMER8W7Q25Rkegd',
  proposals: 'tblyjHMsB9BbuFYUo',
  campaigns: 'tblHFXH59guU4QIVU',
  contentLab: 'tblUaBbUYHnLLKW01',
  landings: 'tblf3djqCQ5KZJgGT',
};

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
