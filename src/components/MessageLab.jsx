/* global React */
const { useState, useCallback, useMemo } = React;

import {
  COMPANY_PROFILE, callOpenAI, channelIcon,
  MESSAGE_PROMPTS, resolvePromptTemplate,
  AUTH_TOKEN, AIRTABLE_BASE_ID, TABLE_IDS,
} from '../globals.js';
import { F, linkedIds } from '../utils.js';

// ─── Constants ───────────────────────────────────────────────────────────────
const CHANNELS   = ['WhatsApp', 'LinkedIn', 'Email'];
const MSG_TYPES  = ['First Touch', 'Follow-up', 'Breakup'];
const MSG_TYPE_KEY = { 'First Touch': 'first', 'Follow-up': 'followup', 'Breakup': 'breakup' };
const LANGUAGES  = ['Auto (contact country)', 'English', 'Spanish', 'Portuguese', 'French', 'German', 'Italian'];

// ─── Styles ──────────────────────────────────────────────────────────────────
const CARD  = { background: 'rgba(255,255,255,0.04)', borderRadius: 12, border: '1px solid var(--globant-border)', padding: 16 };
const INPUT = { background: 'rgba(255,255,255,0.07)', border: '1px solid var(--globant-border)', borderRadius: 8, color: '#fff', padding: '6px 10px', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' };
const SEL   = { ...INPUT, width: 'auto', minWidth: 140, cursor: 'pointer' };
const MUTED = { color: 'var(--globant-muted)', fontSize: 12 };
const GREEN = '#4ade80';
const CHIP  = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(74,222,128,0.12)', border: '1px solid rgba(74,222,128,0.3)', borderRadius: 20, padding: '2px 10px', fontSize: 11, color: GREEN, marginRight: 6, marginBottom: 4 };

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getAccount(s, accounts) {
  const ids = linkedIds(s, 'Account');
  return ids.length ? accounts.find(a => a.id === ids[0]) || null : null;
}

function getOutreachFor(stkId, outreach) {
  return outreach
    .filter(o => (linkedIds(o, 'Stakeholder').includes(stkId) || linkedIds(o, 'Stakeholders').includes(stkId)))
    .sort((a, b) => (F(a, 'Date') || '').localeCompare(F(b, 'Date') || ''));
}

// Find best matching offering for an account
function getBestOffering(account, solutions) {
  if (!solutions.length) return null;
  // 1. Account directly linked to a solution
  const accSolIds = account ? linkedIds(account, 'Solutions') : [];
  if (accSolIds.length) {
    const sol = solutions.find(s => accSolIds.includes(s.id));
    if (sol) return sol;
  }
  // 2. Match by industry
  const industry = account ? F(account, 'Industry') : '';
  if (industry) {
    const byIndustry = solutions.find(s =>
      (F(s, 'Target Industry') || F(s, 'Industry') || '').toLowerCase().includes(industry.toLowerCase())
    );
    if (byIndustry) return byIndustry;
  }
  // 3. Fallback: first solution
  return solutions[0] || null;
}

// Build enriched prompt using Settings prompts + full context
function buildPrompt(s, account, outreach, campaigns, solutions, events, msgType, channel, language, opts = {}) {
  const cp = COMPANY_PROFILE || {};
  const name     = F(s, 'Name') || 'the contact';
  const aName    = account ? (F(account, 'Account Name') || '') : '';
  const role     = F(s, 'Title') || F(s, 'Role') || '';
  const industry = account ? (F(account, 'Industry') || '') : '';
  const country  = F(s, 'Country') || (account ? F(account, 'Country') : '') || '';
  const painPoints    = F(s, 'Pain Points (Generated)') || F(s, 'Pain Points') || '';
  const linkedinNews  = F(s, 'LinkedIn News (Generated)') || F(s, 'Linkedin latest news') || '';
  const accountNews   = account ? (F(account, 'Recent News') || '') : '';

  // Outreach history
  const hist = getOutreachFor(s.id, outreach);
  const touchCount = hist.length;
  const replies    = hist.filter(o => F(o, 'Direction') === 'Inbound' || F(o, 'Reply') === 'Yes' || F(o, 'Status') === 'Replied');
  const replyCount = replies.length;
  const replyState = replyCount > 0 ? `${replyCount} reply/replies received` : 'no replies yet';
  const histLines  = hist.slice(-5).map(o =>
    `[${F(o, 'Date') || '?'}] ${F(o, 'Channel') || ''}: ${(F(o, 'Message') || F(o, 'Notes') || '').slice(0, 150)}`
  ).join('\n');

  // Settings prompt template
  const typeKey  = MSG_TYPE_KEY[msgType] || 'first';
  const template = (MESSAGE_PROMPTS || {})[typeKey] || '';
  const mission  = resolvePromptTemplate(template, { name, company: aName, touchCount, replyCount, replyState });

  // Offering context
  const offering = opts.offeringId
    ? solutions.find(s2 => s2.id === opts.offeringId)
    : getBestOffering(account, solutions);
  const offeringCtx = offering
    ? `Offering: ${F(offering, 'Name')}${F(offering, 'Service | Solution Detail') ? ` — ${F(offering, 'Service | Solution Detail').slice(0, 200)}` : ''}${F(offering, 'Stakeholder Key Message') ? `\nKey message: ${F(offering, 'Stakeholder Key Message').slice(0, 150)}` : ''}`
    : '';

  // Campaign context
  const campaign = opts.campaignId ? campaigns.find(c => c.id === opts.campaignId) : null;
  const campCtx  = campaign
    ? `Campaign: ${F(campaign, 'Name')} (${F(campaign, 'Type') || ''})\n${F(campaign, 'Message Template') ? `Angle: ${F(campaign, 'Message Template').slice(0, 200)}` : ''}${F(campaign, 'Context') ? `\nContext: ${F(campaign, 'Context').slice(0, 300)}` : ''}`
    : '';

  // Event context
  const event   = opts.eventId ? events.find(e => e.id === opts.eventId) : null;
  const eventCtx = event
    ? `Event to invite to: ${F(event, 'Name')} — ${F(event, 'Date') || ''} ${F(event, 'Location') || ''}\n${F(event, 'Description') ? F(event, 'Description').slice(0, 200) : ''}`
    : '';

  // Channel rules
  const channelRules = channel === 'Email'
    ? 'Format: first line must be "Subject: [subject]", blank line, then body. Max 4 sentences. Professional but warm. Follow the mission prompt structure exactly.'
    : 'Max 3 sentences. Concise, direct, conversational. No generic openers. No "Subject:" line.';

  // Language
  const langRule = (!language || language.startsWith('Auto'))
    ? `Use the language most appropriate for the contact${country ? ` (country: ${country})` : ''}.`
    : `Write ONLY in ${language}.`;

  return `You are ${cp.senderName || 'the sender'}, ${cp.senderTitle || 'Sales Rep'} at ${cp.companyName || 'our company'}.
IMPORTANT: Sign as "${cp.senderName || 'the sender'}" — NEVER use placeholders like [Your Name] or [Tu Nombre].
${cp.services ? `Services: ${cp.services}` : ''}
${cp.voiceTone ? `Tone/voice: ${cp.voiceTone}` : ''}

CONTACT: ${name}${role ? `, ${role}` : ''}${aName ? ` at ${aName}` : ''}${industry ? ` (${industry})` : ''}${country ? ` — ${country}` : ''}
${painPoints ? `Pain points: ${painPoints}` : ''}
${linkedinNews ? `LinkedIn activity: ${linkedinNews}` : ''}
${accountNews ? `Company news: ${accountNews}` : ''}

${offeringCtx ? `\n${offeringCtx}` : ''}
${campCtx ? `\n${campCtx}` : ''}
${eventCtx ? `\n${eventCtx}` : ''}

OUTREACH HISTORY (oldest → newest):
${histLines || 'No prior outreach — this is the first contact.'}

MISSION (follow this exactly): ${mission}

CHANNEL: ${channel}
${channelRules}
LANGUAGE: ${langRule}

BANNED PHRASES: "hope this finds you", "following up", "checking in", "touching base", "I wanted to reach out", "as per", "synergy".

Write ONE message only. No preamble, meta-commentary, or explanation. Just the message.`;
}

// ─── Gmail send ───────────────────────────────────────────────────────────────
async function sendEmailViaGmail(stakeholder, message) {
  const email = F(stakeholder, 'Email');
  if (!email) throw new Error('No email address on file');
  const lines = message.split('\n');
  const si    = lines.findIndex(l => /^subject:/i.test(l.trim()));
  let subject = `Message for ${F(stakeholder, 'Name') || email}`;
  let body    = message;
  if (si !== -1) {
    subject = lines[si].replace(/^subject:\s*/i, '').trim();
    body    = lines.slice(si + 1).join('\n').trim();
  }
  const res = await fetch('/api/gmail/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: email, subject, message: body,
      stakeholderId: stakeholder.id,
      accountIds: linkedIds(stakeholder, 'Account'),
      baseId: AIRTABLE_BASE_ID,
      outreachTableId: TABLE_IDS.outreach,
    }),
  });
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'Send failed'); }
}

// ─── Small UI helpers ─────────────────────────────────────────────────────────
function CopyBtn({ text, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="action-btn" style={{ fontSize: 12, padding: '4px 10px' }}
      onClick={() => navigator.clipboard.writeText(text || '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); })}>
      {copied ? '✓ Copied' : (label || '📋 Copy')}
    </button>
  );
}

function StatusBadge({ status }) {
  const map = { pending: ['•', 'var(--globant-muted)'], generating: ['⏳', '#facc15'], done: ['✓', GREEN], error: ['✕', '#f87171'] };
  const [icon, color] = map[status] || ['?', 'var(--globant-muted)'];
  return <span style={{ fontSize: 11, color }}>{icon}</span>;
}

function SendButtons({ stakeholder, message, onEmailSent, emailOnly }) {
  const phone   = F(stakeholder, 'Phone number');
  const linkedin = F(stakeholder, 'LinkedIn');
  const email   = F(stakeholder, 'Email');
  const msg     = message || '';
  const [emailStatus, setEmailStatus] = useState('idle');
  const [emailError,  setEmailError]  = useState('');
  const btn = { fontSize: 12, padding: '5px 12px' };

  async function handleSendEmail() {
    setEmailStatus('sending'); setEmailError('');
    try {
      await sendEmailViaGmail(stakeholder, msg);
      setEmailStatus('sent');
      if (onEmailSent) onEmailSent();
    } catch (e) { setEmailStatus('error'); setEmailError(e.message || 'Error'); }
  }

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: emailOnly ? 0 : 8, alignItems: 'center' }}>
      {!emailOnly && phone && (
        <a href={`https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(msg)}`}
          target="_blank" rel="noopener noreferrer" className="action-btn btn-whatsapp" style={btn}>
          💬 WhatsApp
        </a>
      )}
      {email && (
        <button className="action-btn btn-email" style={btn}
          onClick={handleSendEmail} disabled={emailStatus === 'sending' || emailStatus === 'sent'}>
          {emailStatus === 'sending' ? '⏳ Sending…' : emailStatus === 'sent' ? '✓ Sent' : '📤 Send Email'}
        </button>
      )}
      {!emailOnly && linkedin && (
        <a href={linkedin.startsWith('http') ? linkedin : `https://${linkedin}`}
          target="_blank" rel="noopener noreferrer" className="action-btn btn-linkedin" style={btn}>
          🔗 LinkedIn
        </a>
      )}
      {emailStatus === 'error' && <span style={{ fontSize: 11, color: '#f87171' }}>{emailError}</span>}
      {!emailOnly && !phone && !email && !linkedin && <span style={MUTED}>No contact channels on file</span>}
    </div>
  );
}

// ─── Outreach History Panel ───────────────────────────────────────────────────
function HistoryPanel({ stakeholder, outreach }) {
  const [open, setOpen] = useState(false);
  const hist = getOutreachFor(stakeholder.id, outreach);
  if (!hist.length) return <div style={{ ...MUTED, marginTop: 6 }}>No outreach history yet.</div>;

  return (
    <div style={{ marginTop: 8 }}>
      <button style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 12, padding: 0, display: 'flex', alignItems: 'center', gap: 4 }}
        onClick={() => setOpen(v => !v)}>
        {open ? '▲' : '▼'} {hist.length} message{hist.length > 1 ? 's' : ''} in history
      </button>
      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {hist.slice(-8).reverse().map((o, i) => {
            const ch = F(o, 'Channel') || '?';
            const replied = F(o, 'Direction') === 'Inbound' || F(o, 'Reply') === 'Yes' || F(o, 'Status') === 'Replied';
            return (
              <div key={o.id || i} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '8px 10px', borderLeft: `2px solid ${replied ? GREEN : 'var(--globant-border)'}` }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                  <span style={{ fontSize: 11, color: GREEN }}>{channelIcon[ch] || '📨'} {ch}</span>
                  <span style={MUTED}>{F(o, 'Date') || '?'}</span>
                  {replied && <span style={{ fontSize: 10, color: GREEN, fontWeight: 700 }}>↩ Replied</span>}
                </div>
                <div style={{ fontSize: 12, color: '#ccc', lineHeight: 1.5 }}>
                  {(F(o, 'Message') || F(o, 'Notes') || '—').slice(0, 250)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Contact Picker ───────────────────────────────────────────────────────────
function ContactPicker({ stakeholders, accounts, value, onChange }) {
  const [companyId, setCompanyId] = useState('');

  const uniqueAccounts = useMemo(() => {
    const seen = new Set(); const list = [];
    stakeholders.forEach(s => {
      const acc = getAccount(s, accounts);
      if (acc && !seen.has(acc.id)) { seen.add(acc.id); list.push(acc); }
    });
    return list.sort((a, b) => (F(a, 'Account Name') || '').localeCompare(F(b, 'Account Name') || ''));
  }, [stakeholders, accounts]);

  const contacts = useMemo(() => {
    if (!companyId) return [];
    return stakeholders.filter(s => linkedIds(s, 'Account').includes(companyId))
      .sort((a, b) => (F(a, 'Name') || '').localeCompare(F(b, 'Name') || ''));
  }, [companyId, stakeholders]);

  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      <select style={SEL} value={companyId} onChange={e => { setCompanyId(e.target.value); onChange(null); }}>
        <option value="">Select company…</option>
        {uniqueAccounts.map(a => <option key={a.id} value={a.id}>{F(a, 'Account Name')}</option>)}
      </select>
      <select style={{ ...SEL, minWidth: 180 }} value={value?.id || ''} disabled={!companyId}
        onChange={e => onChange(stakeholders.find(s => s.id === e.target.value) || null)}>
        <option value="">Select contact…</option>
        {contacts.map(s => <option key={s.id} value={s.id}>{F(s, 'Name')}</option>)}
      </select>
      {value && (
        <button style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer' }}
          onClick={() => { setCompanyId(''); onChange(null); }}>✕</button>
      )}
    </div>
  );
}

// ─── Tab 1: Individual ────────────────────────────────────────────────────────
function IndividualTab({ data }) {
  const { stakeholders, accounts, outreach, campaigns, solutions, events } = data;
  const [selected,    setSelected]    = useState(null);
  const [msgType,     setMsgType]     = useState('First Touch');
  const [channel,     setChannel]     = useState('WhatsApp');
  const [language,    setLanguage]    = useState('Auto (contact country)');
  const [campaignId,  setCampaignId]  = useState('');
  const [offeringId,  setOfferingId]  = useState('');
  const [eventId,     setEventId]     = useState('');
  const [generatedMsg, setGeneratedMsg] = useState('');
  const [generating,  setGenerating]  = useState(false);

  const account  = selected ? getAccount(selected, accounts) : null;
  const hist     = selected ? getOutreachFor(selected.id, outreach) : [];
  const replies  = hist.filter(o => F(o, 'Direction') === 'Inbound' || F(o, 'Reply') === 'Yes' || F(o, 'Status') === 'Replied');

  // Auto-select best offering when contact selected
  React.useEffect(() => {
    if (selected && !offeringId) {
      const best = getBestOffering(account, solutions);
      if (best) setOfferingId(best.id);
    }
  }, [selected]);

  async function handleGenerate() {
    if (!selected) return;
    setGenerating(true); setGeneratedMsg('');
    try {
      const prompt = buildPrompt(selected, account, outreach, campaigns, solutions, events, msgType, channel, language, { campaignId, offeringId, eventId });
      const result = await callOpenAI({ prompt, max_tokens: 500, temperature: 0.75 });
      setGeneratedMsg(result || '');
    } catch (e) { setGeneratedMsg('Error: ' + (e.message || e)); }
    setGenerating(false);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Contact picker */}
      <ContactPicker stakeholders={stakeholders} accounts={accounts} value={selected}
        onChange={s => { setSelected(s); setGeneratedMsg(''); setOfferingId(''); }} />

      {/* Contact card + history */}
      {selected && (
        <div style={CARD}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{F(selected, 'Name')}</div>
          <div style={MUTED}>{F(selected, 'Title') || F(selected, 'Role') || '—'} · {account ? F(account, 'Account Name') : '—'}</div>
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 0 }}>
            {hist.length > 0 && <span style={CHIP}>💬 {hist.length} messages</span>}
            {replies.length > 0 && <span style={CHIP}>↩ {replies.length} replies</span>}
            {(F(selected, 'Pain Points (Generated)') || F(selected, 'Pain Points')) && <span style={CHIP}>🎯 Pain points</span>}
            {(F(selected, 'LinkedIn News (Generated)')) && <span style={CHIP}>🔗 LinkedIn intel</span>}
            {account && F(account, 'Recent News') && <span style={CHIP}>📰 Company news</span>}
          </div>
          <HistoryPanel stakeholder={selected} outreach={outreach} />
        </div>
      )}

      {/* Context selectors */}
      {selected && (
        <div style={{ ...CARD, padding: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>Message context</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <div style={{ ...MUTED, marginBottom: 4 }}>Offering</div>
              <select style={SEL} value={offeringId} onChange={e => setOfferingId(e.target.value)}>
                <option value="">Auto-match</option>
                {solutions.map(s => <option key={s.id} value={s.id}>{F(s, 'Name')}</option>)}
              </select>
            </div>
            <div>
              <div style={{ ...MUTED, marginBottom: 4 }}>Campaign</div>
              <select style={SEL} value={campaignId} onChange={e => setCampaignId(e.target.value)}>
                <option value="">None</option>
                {campaigns.map(c => <option key={c.id} value={c.id}>{F(c, 'Name')}</option>)}
              </select>
            </div>
            <div>
              <div style={{ ...MUTED, marginBottom: 4 }}>Event</div>
              <select style={SEL} value={eventId} onChange={e => setEventId(e.target.value)}>
                <option value="">None</option>
                {events.map(e => <option key={e.id} value={e.id}>{F(e, 'Name')}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Generation controls */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <select style={SEL} value={msgType} onChange={e => setMsgType(e.target.value)}>
          {MSG_TYPES.map(t => <option key={t}>{t}</option>)}
        </select>
        <select style={SEL} value={channel} onChange={e => setChannel(e.target.value)}>
          {CHANNELS.map(c => <option key={c}>{channelIcon[c] || ''} {c}</option>)}
        </select>
        <select style={SEL} value={language} onChange={e => setLanguage(e.target.value)}>
          {LANGUAGES.map(l => <option key={l}>{l}</option>)}
        </select>
        <button className="action-btn btn-primary" onClick={handleGenerate}
          disabled={!selected || generating} style={{ opacity: (!selected || generating) ? 0.5 : 1 }}>
          {generating ? '⏳ Generating…' : '✨ Generate'}
        </button>
      </div>

      {/* Generated message */}
      {generatedMsg && (
        <div style={CARD}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: GREEN }}>Generated · {channel}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <CopyBtn text={generatedMsg} label={`${channelIcon[channel] || '📋'} Copy`} />
              <button className="action-btn" onClick={handleGenerate} style={{ fontSize: 11 }}>↻ Regen</button>
            </div>
          </div>
          <textarea style={{ ...INPUT, minHeight: 140, resize: 'vertical', lineHeight: 1.6 }}
            value={generatedMsg} onChange={e => setGeneratedMsg(e.target.value)} />
          {selected && <SendButtons stakeholder={selected} message={generatedMsg} />}
        </div>
      )}
    </div>
  );
}

// ─── Tab 2: Bulk ──────────────────────────────────────────────────────────────
function BulkTab({ data }) {
  const { stakeholders, accounts, outreach, campaigns, solutions, events } = data;
  const [companyFilter,  setCompanyFilter]  = useState('');
  const [industryFilter, setIndustryFilter] = useState('');
  const [countryFilter,  setCountryFilter]  = useState('');
  const [statusFilter,   setStatusFilter]   = useState('');
  const [selected,    setSelected]    = useState(new Set());
  const [channel,     setChannel]     = useState('WhatsApp');
  const [language,    setLanguage]    = useState('Auto (contact country)');
  const [msgType,     setMsgType]     = useState('First Touch');
  const [campaignId,  setCampaignId]  = useState('');
  const [offeringId,  setOfferingId]  = useState('');
  const [eventId,     setEventId]     = useState('');
  const [bulkMsgs,    setBulkMsgs]    = useState({});
  const [generating,  setGenerating]  = useState(false);
  const [expanded,    setExpanded]    = useState(new Set());

  const uniqueAccounts = useMemo(() => {
    const seen = new Set(); const list = [];
    stakeholders.forEach(s => {
      const acc = getAccount(s, accounts);
      if (acc && !seen.has(acc.id)) { seen.add(acc.id); list.push(acc); }
    });
    return list.sort((a, b) => (F(a, 'Account Name') || '').localeCompare(F(b, 'Account Name') || ''));
  }, [stakeholders, accounts]);

  const uniqueIndustries = useMemo(() => { const s = new Set(); accounts.forEach(a => { const v = F(a, 'Industry'); if (v) s.add(v); }); return [...s].sort(); }, [accounts]);
  const uniqueCountries  = useMemo(() => { const s = new Set(); accounts.forEach(a => { const v = F(a, 'Country'); if (v) s.add(v); }); return [...s].sort(); }, [accounts]);
  const uniqueStatuses   = useMemo(() => { const s = new Set(); stakeholders.forEach(st => { const v = F(st, 'Status'); if (v) s.add(v); }); return [...s].sort(); }, [stakeholders]);

  const filtered = useMemo(() => stakeholders.filter(s => {
    const acc = getAccount(s, accounts);
    if (companyFilter  && (!acc || acc.id !== companyFilter)) return false;
    if (industryFilter && (!acc || F(acc, 'Industry') !== industryFilter)) return false;
    if (countryFilter  && (!acc || F(acc, 'Country') !== countryFilter)) return false;
    if (statusFilter   && F(s, 'Status') !== statusFilter) return false;
    return true;
  }), [stakeholders, accounts, companyFilter, industryFilter, countryFilter, statusFilter]);

  const allChecked = filtered.length > 0 && filtered.every(s => selected.has(s.id));
  function toggleAll() { setSelected(prev => { const n = new Set(prev); allChecked ? filtered.forEach(s => n.delete(s.id)) : filtered.forEach(s => n.add(s.id)); return n; }); }
  function toggleOne(id) { setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }); }

  async function handleGenerateAll() {
    const targets = stakeholders.filter(s => selected.has(s.id));
    if (!targets.length) return;
    setGenerating(true);
    setBulkMsgs(prev => { const next = { ...prev }; targets.forEach(s => { next[s.id] = { text: '', status: 'pending' }; }); return next; });
    for (let i = 0; i < targets.length; i += 3) {
      const chunk = targets.slice(i, i + 3);
      setBulkMsgs(prev => { const next = { ...prev }; chunk.forEach(s => { next[s.id] = { ...next[s.id], status: 'generating' }; }); return next; });
      await Promise.all(chunk.map(async s => {
        const acc = getAccount(s, accounts);
        const effOfferingId = offeringId || (getBestOffering(acc, solutions)?.id || '');
        const prompt = buildPrompt(s, acc, outreach, campaigns, solutions, events, msgType, channel, language, { campaignId, offeringId: effOfferingId, eventId });
        try {
          const result = await callOpenAI({ prompt, max_tokens: 500, temperature: 0.75 });
          setBulkMsgs(prev => ({ ...prev, [s.id]: { text: result || '', status: 'done' } }));
        } catch (e) {
          setBulkMsgs(prev => ({ ...prev, [s.id]: { text: 'Error: ' + (e.message || e), status: 'error' } }));
        }
      }));
    }
    setGenerating(false);
  }

  function handleCopyAll() {
    const lines = stakeholders.filter(s => selected.has(s.id) && bulkMsgs[s.id]?.status === 'done')
      .map(s => `=== ${F(s, 'Name')} ===\n${bulkMsgs[s.id].text}`).join('\n\n');
    navigator.clipboard.writeText(lines);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <select style={SEL} value={companyFilter}  onChange={e => setCompanyFilter(e.target.value)}>
          <option value="">All Companies</option>
          {uniqueAccounts.map(a => <option key={a.id} value={a.id}>{F(a, 'Account Name')}</option>)}
        </select>
        <select style={SEL} value={industryFilter} onChange={e => setIndustryFilter(e.target.value)}>
          <option value="">All Industries</option>
          {uniqueIndustries.map(i => <option key={i}>{i}</option>)}
        </select>
        <select style={SEL} value={countryFilter}  onChange={e => setCountryFilter(e.target.value)}>
          <option value="">All Countries</option>
          {uniqueCountries.map(c => <option key={c}>{c}</option>)}
        </select>
        <select style={SEL} value={statusFilter}   onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          {uniqueStatuses.map(s => <option key={s}>{s}</option>)}
        </select>
        <span style={MUTED}>{filtered.length} contacts</span>
      </div>

      {/* Contact table */}
      <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid var(--globant-border)' }}>
              <th style={{ padding: '8px 12px', width: 36 }}><input type="checkbox" checked={allChecked} onChange={toggleAll} /></th>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>Name</th>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>Company</th>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>Status</th>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>Message</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 100).map(s => {
              const acc       = getAccount(s, accounts);
              const isChecked = selected.has(s.id);
              const msgState  = bulkMsgs[s.id];
              const isExpanded = expanded.has(s.id);
              return (
                <React.Fragment key={s.id}>
                  <tr onClick={() => toggleOne(s.id)} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: isChecked ? 'rgba(74,222,128,0.04)' : 'transparent', cursor: 'pointer' }}>
                    <td style={{ padding: '7px 12px' }}>
                      <input type="checkbox" checked={isChecked} onChange={() => toggleOne(s.id)} onClick={e => e.stopPropagation()} />
                    </td>
                    <td style={{ padding: '7px 12px', fontWeight: 500 }}>{F(s, 'Name')}</td>
                    <td style={{ padding: '7px 12px', color: 'var(--globant-muted)' }}>{acc ? F(acc, 'Account Name') : '—'}</td>
                    <td style={{ padding: '7px 12px' }}>
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(255,255,255,0.08)' }}>{F(s, 'Status') || '—'}</span>
                    </td>
                    <td style={{ padding: '7px 12px' }}>
                      {msgState ? (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <StatusBadge status={msgState.status} />
                          {msgState.status === 'done' && (
                            <>
                              <button style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 11 }}
                                onClick={e => { e.stopPropagation(); setExpanded(prev => { const n = new Set(prev); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; }); }}>
                                {isExpanded ? '▲' : '▼ View'}
                              </button>
                              <CopyBtn text={msgState.text} />
                            </>
                          )}
                        </div>
                      ) : <span style={MUTED}>—</span>}
                    </td>
                  </tr>
                  {isExpanded && msgState?.status === 'done' && (
                    <tr style={{ background: 'rgba(0,0,0,0.2)' }}>
                      <td />
                      <td colSpan={4} style={{ padding: '6px 12px 10px' }}>
                        <textarea style={{ ...INPUT, minHeight: 90, resize: 'vertical' }}
                          value={msgState.text}
                          onChange={e => setBulkMsgs(prev => ({ ...prev, [s.id]: { ...prev[s.id], text: e.target.value } }))} />
                        <SendButtons stakeholder={s} message={msgState.text} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: 'var(--globant-muted)' }}>No contacts match filters</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Context + Generate controls */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {selected.size > 0 && (
          <span style={{ ...CHIP, fontSize: 13, padding: '4px 12px', alignSelf: 'center' }}>{selected.size} selected</span>
        )}
        <div>
          <div style={{ ...MUTED, marginBottom: 4 }}>Type</div>
          <select style={SEL} value={msgType} onChange={e => setMsgType(e.target.value)}>
            {MSG_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <div style={{ ...MUTED, marginBottom: 4 }}>Channel</div>
          <select style={SEL} value={channel} onChange={e => setChannel(e.target.value)}>
            {CHANNELS.map(c => <option key={c}>{channelIcon[c] || ''} {c}</option>)}
          </select>
        </div>
        <div>
          <div style={{ ...MUTED, marginBottom: 4 }}>Language</div>
          <select style={SEL} value={language} onChange={e => setLanguage(e.target.value)}>
            {LANGUAGES.map(l => <option key={l}>{l}</option>)}
          </select>
        </div>
        <div>
          <div style={{ ...MUTED, marginBottom: 4 }}>Offering</div>
          <select style={SEL} value={offeringId} onChange={e => setOfferingId(e.target.value)}>
            <option value="">Auto per contact</option>
            {solutions.map(s => <option key={s.id} value={s.id}>{F(s, 'Name')}</option>)}
          </select>
        </div>
        <div>
          <div style={{ ...MUTED, marginBottom: 4 }}>Campaign</div>
          <select style={SEL} value={campaignId} onChange={e => setCampaignId(e.target.value)}>
            <option value="">None</option>
            {campaigns.map(c => <option key={c.id} value={c.id}>{F(c, 'Name')}</option>)}
          </select>
        </div>
        <div>
          <div style={{ ...MUTED, marginBottom: 4 }}>Event</div>
          <select style={SEL} value={eventId} onChange={e => setEventId(e.target.value)}>
            <option value="">None</option>
            {events.map(e => <option key={e.id} value={e.id}>{F(e, 'Name')}</option>)}
          </select>
        </div>
        <button className="action-btn btn-primary" onClick={handleGenerateAll}
          disabled={!selected.size || generating} style={{ opacity: (!selected.size || generating) ? 0.5 : 1, alignSelf: 'flex-end' }}>
          {generating ? '⏳ Generating…' : `✨ Generate (${selected.size || 0})`}
        </button>
        {Object.values(bulkMsgs).some(m => m.status === 'done') && (
          <button className="action-btn" onClick={handleCopyAll} style={{ fontSize: 12, alignSelf: 'flex-end' }}>📋 Copy All</button>
        )}
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function MessageLab({ data }) {
  const [tab, setTab] = useState('individual');
  const tabs = [
    { key: 'individual', label: '👤 Individual' },
    { key: 'bulk',       label: '📋 Bulk' },
  ];

  return (
    <div style={{ padding: 24, background: 'var(--globant-bg, #0f1117)', minHeight: '100vh', boxSizing: 'border-box' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>✉️ Message Lab</h2>
        <p style={{ margin: '4px 0 0', color: 'var(--globant-muted)', fontSize: 13 }}>
          AI outreach using your Settings prompts, offering context, company intel and full conversation history
        </p>
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--globant-border)' }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '8px 16px', fontSize: 14,
            fontWeight: tab === t.key ? 600 : 400,
            color: tab === t.key ? '#fff' : 'var(--globant-muted)',
            borderBottom: tab === t.key ? `2px solid ${GREEN}` : '2px solid transparent',
            transition: 'all 0.15s',
          }}>{t.label}</button>
        ))}
      </div>
      {tab === 'individual' && <IndividualTab data={data} />}
      {tab === 'bulk'       && <BulkTab       data={data} />}
    </div>
  );
}
