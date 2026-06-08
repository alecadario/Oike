/* global React */

// ============ AUTH & CLIENT CONFIG ============
export let AIRTABLE_BASE_ID = '';
export let TABLE_IDS = {};
export let CLIENT_CONFIG = {};
export let AUTH_TOKEN = localStorage.getItem('oike_token') || '';
export let CURRENT_USER = JSON.parse(localStorage.getItem('oike_user') || 'null');

export let BASE_ID = localStorage.getItem('oike_base_id') || '';

export function getAuthHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${AUTH_TOKEN}`,
  };
}

export async function loginUser(email, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Login failed' }));
    throw new Error(err.error || 'Invalid credentials');
  }
  const data = await res.json();
  AUTH_TOKEN = data.token;
  CURRENT_USER = data.user;
  localStorage.setItem('oike_token', data.token);
  localStorage.setItem('oike_user', JSON.stringify(data.user));
  // Set base ID from login response
  const loginBaseId = data.baseId || data.config?.baseId || '';
  BASE_ID = loginBaseId;
  AIRTABLE_BASE_ID = loginBaseId;
  localStorage.setItem('oike_base_id', loginBaseId);
  TABLE_IDS = data.config?.tables || {};
  CLIENT_CONFIG = data.config || {};
  // login successful
  return data;
}

export function logoutUser() {
  AUTH_TOKEN = '';
  CURRENT_USER = null;
  localStorage.removeItem('oike_token');
  localStorage.removeItem('oike_user');
  localStorage.removeItem('oike_base_id');
  localStorage.removeItem('oike_gmail_connected');
  window.location.reload();
}

export async function loadClientConfig() {
  if (!BASE_ID || !AUTH_TOKEN) return null;
  try {
    const res = await fetch(`/api/config?baseId=${BASE_ID}`, {
      headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
    });
    if (!res.ok) throw new Error('Config load failed');
    const config = await res.json();
    AIRTABLE_BASE_ID = config.baseId;
    TABLE_IDS = config.tables;
    CLIENT_CONFIG = config;
    return config;
  } catch (e) {
    console.error('Failed to load client config:', e);
    return null;
  }
}

export const channelIcon = { WhatsApp: '\u{1F4AC}', Email: '✉️', LinkedIn: '\u{1F517}', Call: '\u{1F4DE}', Meeting: '\u{1F4C5}' };

// ============ URL NAV STATE ============
export function navSetUrl(page, id) {
  const params = new URLSearchParams(window.location.search);
  if (page) params.set('v', page); else params.delete('v');
  if (id)   params.set('id', id); else params.delete('id');
  params.delete('gmail'); // never persist oauth params
  const qs = params.toString();
  const newUrl = window.location.pathname + (qs ? '?' + qs : '');
  if (window.location.search !== (qs ? '?' + qs : '')) {
    window.history.pushState({ page, id }, '', newUrl);
  } else {
    window.history.replaceState({ page, id }, '', newUrl);
  }
}

// ============ COMPANY PROFILE (configurable per client) ============
export const COMPANY_PROFILE_KEY = 'oike_company_profile';
export const SOURCE_OPTIONS = ['Outbound', 'Inbound - Events', 'Inbound - Paid Media', 'Inbound - Referral', 'Inbound - Website', 'Inbound - Direct'];

// ============ PIPELINE CONSTANTS ============
export const OPP_STAGES     = ['Prospecting', 'Qualification', 'Discovery', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost', 'On Hold'];
export const WON_STAGES     = ['Closed Won', 'Closed/Won', 'Cierre ganado'];
export const CLOSED_STAGES  = [...WON_STAGES, 'Closed Lost', 'Closed/Lost', 'Closed/Canceled', 'Cierre perdido'];

// ============ PERFORMANCE BENCHMARKS ============
export const BENCH_REPLY_HIGH   = 10;
export const BENCH_REPLY_LOW    = 5;
export const BENCH_MEETING_HIGH = 5;
export const BENCH_MEETING_LOW  = 2;

export const CHANNEL_BENCHMARKS = {
  'Email': {
    label: 'Cold Email', icon: '\u{1F4E7}',
    acceptable: 3, good: 6, excellent: 10,
    note: 'Belkins 2025: 5.8% avg (down from 6.8% in 2023). Hyper-segmented (1–2 per account) reaches 7.8%.',
  },
  'LinkedIn': {
    label: 'LinkedIn', icon: '\u{1F4BC}',
    acceptable: 5, good: 8, excellent: 15,
    note: 'Cold/connection: 5–9%. With personalized msg: 9.36% vs 5.44% without. Warm/1st-degree/events: 10–12%+.',
  },
  'WhatsApp': {
    label: 'WhatsApp', icon: '\u{1F4AC}',
    acceptable: 25, good: 40, excellent: 50,
    note: 'Only valid for warm/opt-in contacts. Essential in LATAM. Not comparable to cold email.',
  },
  'Phone': {
    label: 'Phone / Cold Call', icon: '\u{1F4DE}',
    acceptable: 2, good: 4, excellent: 6,
    note: 'Measured as dial-to-meeting %, not reply rate. SalesHive avg: ~2.3–2.5%. Top teams: 5–8%. Europe (Cognism): 6% success rate.',
  },
  'SMS': {
    label: 'SMS', icon: '\u{1F4F1}',
    acceptable: 25, good: 35, excellent: 45,
    note: 'Warm/opt-in only. 45% response rate (general). For cold B2B: use only for confirmations or reactivation.',
  },
};

export let COMPANY_PROFILE = (() => {
  const defaults = {
    companyName: 'Your Company',
    services: 'digital transformation, AI, CX, data',
    market: 'your target market',
    senderName: 'Your Name',
    senderTitle: 'Business Consultant',
    goals: '',
    voiceTone: '',
    voiceAvoid: '',
    voiceExample: '',
  };
  try {
    const saved = localStorage.getItem(COMPANY_PROFILE_KEY);
    if (saved) return { ...defaults, ...JSON.parse(saved) };
  } catch (e) { /* ignore */ }
  return defaults;
})();

export function saveCompanyProfile(profile) {
  COMPANY_PROFILE = { ...COMPANY_PROFILE, ...profile };
  localStorage.setItem(COMPANY_PROFILE_KEY, JSON.stringify(COMPANY_PROFILE));
}

// ============ MESSAGE PROMPT TEMPLATES (configurable per user) ============
export const MESSAGE_PROMPTS_KEY = 'oike_message_prompts';
export const MESSAGE_PROMPT_DEFAULTS = {
  first: `First message to {{name}} — they don't know you yet. Open a conversation, earn a reply. No pitch. Genuine curiosity. One sentence intro: who you are, your role, {{company}}.`,
  followup: `Follow-up to {{name}} ({{touchCount}} touches, {{replyState}}).\n\nRead the conversation history and diagnose the state:\n• ENGAGED → advance with a concrete next step\n• STALLED → nudge with a NEW signal or angle from their pain points or LinkedIn\n• GHOSTED → radically different angle (shorter, question-first, pattern-interrupt)\n• OBJECTION → address it honestly\n\nDO NOT repeat phrases or angles used before. Feel like a natural continuation.`,
  breakup: `Last message to {{name}} — {{touchCount}} attempts, {{replyState}}. Ultra-short (max 3 sentences).\n\nRead the history: what didn't land? Pick ONE honest observation. Close the loop with zero pressure. Leave a door open (e.g. "if X changes for you") but don't beg.\n\nHuman, warm, final. No guilt-tripping, no final pitch.`,
};
export let MESSAGE_PROMPTS = (() => {
  try {
    const saved = localStorage.getItem(MESSAGE_PROMPTS_KEY);
    if (saved) return { ...MESSAGE_PROMPT_DEFAULTS, ...JSON.parse(saved) };
  } catch (e) { /* ignore */ }
  return { ...MESSAGE_PROMPT_DEFAULTS };
})();
export function saveMessagePrompts(prompts) {
  MESSAGE_PROMPTS = { ...MESSAGE_PROMPTS, ...prompts };
  localStorage.setItem(MESSAGE_PROMPTS_KEY, JSON.stringify(MESSAGE_PROMPTS));
}
export function resolvePromptTemplate(template, vars) {
  return template
    .replace(/\{\{name\}\}/g, vars.name || '')
    .replace(/\{\{company\}\}/g, vars.company || '')
    .replace(/\{\{touchCount\}\}/g, vars.touchCount ?? '')
    .replace(/\{\{replyCount\}\}/g, vars.replyCount ?? '')
    .replace(/\{\{replyState\}\}/g, vars.replyState || '');
}

// ============ AIRTABLE API (via backend proxy) ============
export class AirtableAPI {
  constructor(apiKeyOrNull) {
    this.proxyUrl = '/api/airtable';
  }

  async fetchTable(tableId) {
    let allRecords = [];
    let offset = null;
    do {
      const res = await fetch(this.proxyUrl, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ method: 'GET', baseId: AIRTABLE_BASE_ID, tableId, offset }),
      });
      if (!res.ok) {
        if (res.status === 401) { logoutUser(); return []; }
        const errData = await res.json().catch(() => ({}));
        console.warn(`Table ${tableId} returned ${res.status}`, errData);
        return allRecords;
      }
      const data = await res.json();
      allRecords = allRecords.concat(data.records || []);
      offset = data.offset;
    } while (offset);
    return allRecords;
  }

  async createRecord(tableId, fields) {
    const res = await fetch(this.proxyUrl, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ method: 'POST', baseId: AIRTABLE_BASE_ID, tableId, fields }),
    });
    if (res.status === 401) { logoutUser(); throw new Error('Session expired'); }
    if (!res.ok) throw new Error(`Create error: ${res.status}`);
    const data = await res.json();
    return data.records ? data.records[0] : data;
  }

  async updateRecord(tableId, recordId, fields) {
    const res = await fetch(this.proxyUrl, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ method: 'PATCH', baseId: AIRTABLE_BASE_ID, tableId, recordId, fields }),
    });
    if (res.status === 401) { logoutUser(); throw new Error('Session expired'); }
    if (!res.ok) {
      let errBody = '';
      try { const d = await res.json(); errBody = JSON.stringify(d); } catch {}
      throw new Error(`Update error: ${res.status} — ${errBody}`);
    }
    return await res.json();
  }

  async deleteRecord(tableId, recordId) {
    const res = await fetch(this.proxyUrl, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ method: 'DELETE', baseId: AIRTABLE_BASE_ID, tableId, recordId }),
    });
    if (res.status === 401) { logoutUser(); throw new Error('Session expired'); }
    if (!res.ok) throw new Error(`Delete error: ${res.status}`);
    return await res.json();
  }
}

// ============ OPENAI API (via backend proxy) ============
export async function callOpenAI({ prompt, temperature = 0.7, max_tokens = 700 }) {
  const res = await fetch('/api/openai', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], temperature, max_tokens }),
  });
  if (res.status === 401) { logoutUser(); throw new Error('Session expired'); }
  if (!res.ok) throw new Error('OpenAI API error');
  const data = await res.json();
  return data.content || '';
}

// Intercept direct OpenAI calls — redirect to backend proxy transparently
const _originalFetch = window.fetch;
window.fetch = function(url, options) {
  if (typeof url === 'string' && url.includes('api.openai.com')) {
    const body = JSON.parse(options?.body || '{}');
    return _originalFetch('/api/openai', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        messages: body.messages,
        model: body.model || 'gpt-4o',
        temperature: body.temperature || 0.7,
        max_tokens: body.max_tokens || 700,
      }),
    }).then(async (res) => {
      if (res.status === 401) { logoutUser(); return new Response('{}', { status: 401 }); }
      const data = await res.json();
      return new Response(JSON.stringify({
        choices: [{ message: { content: data.content || '' } }],
        usage: data.usage,
      }), { status: res.status, headers: { 'Content-Type': 'application/json' } });
    });
  }
  return _originalFetch.apply(this, arguments);
};

// Make openaiKey checks pass (key is server-side now)
if (!localStorage.getItem('openai_key')) {
  localStorage.setItem('openai_key', 'managed-by-backend');
}

// ============ BRANDING ============
export const BRANDING_LS_KEY = 'oike_proposal_branding';
export function loadBranding() {
  try { return JSON.parse(localStorage.getItem(BRANDING_LS_KEY) || '{}'); } catch { return {}; }
}
