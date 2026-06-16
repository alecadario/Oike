/* global React */
const { useState, useEffect, useCallback, useMemo, useRef } = React;

import {
  COMPANY_PROFILE, callOpenAI, channelIcon,
  MESSAGE_PROMPTS, resolvePromptTemplate,
} from '../globals.js';
import { F, linkedIds } from '../utils.js';

// ─── Constants ───────────────────────────────────────────────────────────────
const CHANNELS = ['WhatsApp', 'LinkedIn', 'Email'];
const MSG_TYPES = ['First Touch', 'Follow-up', 'Breakup'];
const MSG_TYPE_KEY = { 'First Touch': 'first', 'Follow-up': 'followup', 'Breakup': 'breakup' };
const SEQ_LS_KEY = 'oike_sequences';

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'America/Buenos_Aires', 'America/Bogota',
  'Europe/London', 'Europe/Madrid', 'Europe/Paris', 'Europe/Berlin',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo',
  'Australia/Sydney',
];

const CARD = {
  background: 'rgba(255,255,255,0.04)',
  borderRadius: 12,
  border: '1px solid var(--globant-border)',
  padding: 16,
};

const INPUT = {
  background: 'rgba(255,255,255,0.07)',
  border: '1px solid var(--globant-border)',
  borderRadius: 8,
  color: '#fff',
  padding: '6px 10px',
  fontSize: 13,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

const SEL = { ...INPUT, width: 'auto', minWidth: 140, cursor: 'pointer' };
const MUTED = { color: 'var(--globant-muted)', fontSize: 12 };
const GREEN = '#4ade80';

const CHIP = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  background: 'rgba(74,222,128,0.12)', border: '1px solid rgba(74,222,128,0.3)',
  borderRadius: 20, padding: '2px 10px', fontSize: 11, color: GREEN,
  marginRight: 6, marginBottom: 4,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function todayISO() { return new Date().toISOString().slice(0, 10); }

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + (parseInt(days) || 0));
  return d.toISOString().slice(0, 10);
}

function loadSequences() {
  try { return JSON.parse(localStorage.getItem(SEQ_LS_KEY) || '[]'); } catch { return []; }
}
function saveSequences(seqs) { localStorage.setItem(SEQ_LS_KEY, JSON.stringify(seqs)); }

function getAccount(s, accounts) {
  const ids = linkedIds(s, 'Account');
  return ids.length ? accounts.find(a => a.id === ids[0]) || null : null;
}

function accName(acc) { return acc ? (F(acc, 'Account Name') || '') : ''; }

function getOutreachFor(id, outreach) {
  return outreach.filter(o => {
    const ids = linkedIds(o, 'Stakeholder') || linkedIds(o, 'Stakeholders') || [];
    return ids.includes(id);
  });
}

function getCampaignsFor(id, campaigns) {
  return campaigns.filter(c => {
    const ids = linkedIds(c, 'Stakeholders') || linkedIds(c, 'Contacts') || [];
    return ids.includes(id);
  });
}

function buildPrompt(s, account, outreach, campaigns, msgType, channel) {
  const cp = COMPANY_PROFILE || {};
  const name = F(s, 'Name') || 'the contact';
  const accName = account ? (F(account, 'Account Name') || '') : '';
  const role = F(s, 'Title') || F(s, 'Role') || '';
  const industry = account ? (F(account, 'Industry') || '') : '';
  const painPoints = F(s, 'Pain Points (Generated)') || F(s, 'Pain Points') || '';

  const hist = getOutreachFor(s.id, outreach);
  const touchCount = hist.length;
  const replies = hist.filter(o => F(o, 'Direction') === 'Inbound' || F(o, 'Reply') === 'Yes');
  const replyCount = replies.length;
  const replyState = replyCount > 0 ? `${replyCount} replies` : 'no replies yet';

  const typeKey = MSG_TYPE_KEY[msgType] || 'first';
  const missionTemplate = MESSAGE_PROMPTS[typeKey] || MESSAGE_PROMPTS.first;
  const mission = resolvePromptTemplate(missionTemplate, { name, company: accName, touchCount, replyCount, replyState });

  const campCtx = getCampaignsFor(s.id, campaigns)
    .map(c => `${F(c, 'Name') || 'Campaign'}: ${F(c, 'Description') || ''}`)
    .join('; ');

  const histLines = hist.slice(-5)
    .map(o => `[${F(o, 'Date') || ''}] ${F(o, 'Channel') || ''}: ${(F(o, 'Message') || F(o, 'Notes') || '').slice(0, 120)}`)
    .join('\n');

  const channelRules = channel === 'Email'
    ? 'Up to 5 sentences. Include Subject line. Professional but warm.'
    : 'Max 3 sentences. Concise, direct, conversational. No generic openers.';

  return `You are ${cp.senderName || 'the sender'}, ${cp.senderTitle || 'a sales rep'} at ${cp.companyName || 'our company'}.
IMPORTANT: Sign the message as "${cp.senderName || 'the sender'}" — never use placeholders like [Tu Nombre] or [Your Name].
${cp.services ? `Services: ${cp.services}` : ''}
${cp.voiceTone ? `Tone: ${cp.voiceTone}` : ''}

Recipient: ${name}${role ? `, ${role}` : ''}${accName ? ` at ${accName}` : ''}${industry ? ` (${industry})` : ''}
${painPoints ? `Pain points: ${painPoints}` : ''}
${campCtx ? `Campaign context: ${campCtx}` : ''}

${histLines ? `Outreach history (oldest→newest):\n${histLines}` : 'No prior outreach.'}

Mission: ${mission}

Channel: ${channel}
${channelRules}

Write ONE message only. No preamble, explanation, or meta-commentary. Just the message.`;
}

// ─── Small shared UI ─────────────────────────────────────────────────────────
function CopyBtn({ text, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="action-btn" style={{ fontSize: 12, padding: '4px 10px' }}
      onClick={() => { navigator.clipboard.writeText(text || '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }); }}>
      {copied ? '✓ Copied' : (label || '📋 Copy')}
    </button>
  );
}

function StatusBadge({ status }) {
  const map = {
    pending: ['•', 'var(--globant-muted)'],
    generating: ['⏳', '#facc15'],
    done: ['✓', GREEN],
    error: ['✕', '#f87171'],
    sent: ['📤 Sent', GREEN],
    'not sent': ['—', 'var(--globant-muted)'],
  };
  const [icon, color] = map[status] || ['?', 'var(--globant-muted)'];
  return <span style={{ fontSize: 11, color }}>{icon}</span>;
}

// ─── Send buttons based on available contact info ────────────────────────────
function SendButtons({ stakeholder, message }) {
  const phone = F(stakeholder, 'Phone number');
  const linkedin = F(stakeholder, 'LinkedIn');
  const email = F(stakeholder, 'Email');
  const msg = message || '';

  const btnStyle = { fontSize: 12, padding: '5px 12px' };

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
      {phone && (
        <a href={`https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(msg)}`}
          target="_blank" rel="noopener noreferrer"
          className="action-btn btn-whatsapp" style={btnStyle}>
          💬 WhatsApp
        </a>
      )}
      {email && (
        <a href={`mailto:${email}?body=${encodeURIComponent(msg)}`}
          target="_blank" rel="noopener noreferrer"
          className="action-btn btn-email" style={btnStyle}>
          ✉️ Email
        </a>
      )}
      {linkedin && (
        <a href={linkedin.startsWith('http') ? linkedin : `https://${linkedin}`}
          target="_blank" rel="noopener noreferrer"
          className="action-btn btn-linkedin" style={btnStyle}>
          🔗 LinkedIn
        </a>
      )}
      {!phone && !email && !linkedin && (
        <span style={MUTED}>No contact channels available</span>
      )}
    </div>
  );
}

// ─── Contact picker: Company dropdown → Contact dropdown ──────────────────────
function ContactPicker({ stakeholders, accounts, value, onChange, placeholder }) {
  const [companyId, setCompanyId] = useState('');

  const uniqueAccounts = useMemo(() => {
    const seen = new Set();
    const list = [];
    stakeholders.forEach(s => {
      const acc = getAccount(s, accounts);
      if (acc && !seen.has(acc.id)) { seen.add(acc.id); list.push(acc); }
    });
    return list.sort((a, b) => (F(a, 'Account Name') || '').localeCompare(F(b, 'Account Name') || ''));
  }, [stakeholders, accounts]);

  const contactsInCompany = useMemo(() => {
    if (!companyId) return [];
    return stakeholders.filter(s => {
      const ids = linkedIds(s, 'Account');
      return ids.includes(companyId);
    }).sort((a, b) => (F(a, 'Name') || '').localeCompare(F(b, 'Name') || ''));
  }, [companyId, stakeholders]);

  function handleCompanyChange(e) {
    setCompanyId(e.target.value);
    onChange(null);
  }

  function handleContactChange(e) {
    const s = stakeholders.find(st => st.id === e.target.value);
    onChange(s || null);
  }

  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <select style={SEL} value={companyId} onChange={handleCompanyChange}>
        <option value="">Select company…</option>
        {uniqueAccounts.map(a => <option key={a.id} value={a.id}>{F(a, 'Account Name')}</option>)}
      </select>
      <select style={{ ...SEL, minWidth: 180 }} value={value?.id || ''} onChange={handleContactChange} disabled={!companyId}>
        <option value="">Select contact…</option>
        {contactsInCompany.map(s => <option key={s.id} value={s.id}>{F(s, 'Name')}</option>)}
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
  const { stakeholders, accounts, outreach, campaigns } = data;
  const [selected, setSelected] = useState(null);
  const [msgType, setMsgType] = useState('First Touch');
  const [channel, setChannel] = useState('WhatsApp');
  const [generatedMsg, setGeneratedMsg] = useState('');
  const [generating, setGenerating] = useState(false);

  const account = selected ? getAccount(selected, accounts) : null;
  const hist = selected ? getOutreachFor(selected.id, outreach) : [];
  const stakeholderCampaigns = selected ? getCampaignsFor(selected.id, campaigns) : [];
  const lastChannel = hist.length ? (F(hist[hist.length - 1], 'Channel') || '—') : '—';

  async function handleGenerate() {
    if (!selected) return;
    setGenerating(true);
    setGeneratedMsg('');
    try {
      const prompt = buildPrompt(selected, account, outreach, campaigns, msgType, channel);
      const result = await callOpenAI({ prompt, max_tokens: 450, temperature: 0.75 });
      setGeneratedMsg(result || '');
    } catch (e) {
      setGeneratedMsg('Error: ' + (e.message || e));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ContactPicker stakeholders={stakeholders} accounts={accounts} value={selected}
        onChange={s => { setSelected(s); setGeneratedMsg(''); }} />

      {selected && (
        <div style={CARD}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{F(selected, 'Name')}</div>
              <div style={MUTED}>{F(selected, 'Title') || F(selected, 'Role') || '—'} · {account ? F(account, 'Account Name') : '—'}</div>
              <div style={{ ...MUTED, marginTop: 3 }}>
                Last channel: {channelIcon[lastChannel] || ''} {lastChannel} · {hist.length} messages
              </div>
            </div>
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap' }}>
            {stakeholderCampaigns.map(c => (
              <span key={c.id} style={CHIP}>📣 {F(c, 'Name') || 'Campaign'}</span>
            ))}
            {hist.length > 0 && <span style={CHIP}>💬 {hist.length} messages</span>}
            {(F(selected, 'Pain Points (Generated)') || F(selected, 'Pain Points')) && <span style={CHIP}>🎯 Pain points</span>}
            <span style={CHIP}>🏢 {(COMPANY_PROFILE || {}).companyName || 'Offering'}</span>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <select style={SEL} value={msgType} onChange={e => setMsgType(e.target.value)}>
          {MSG_TYPES.map(t => <option key={t}>{t}</option>)}
        </select>
        <select style={SEL} value={channel} onChange={e => setChannel(e.target.value)}>
          {CHANNELS.map(c => <option key={c}>{channelIcon[c] || ''} {c}</option>)}
        </select>
        <button className="action-btn" onClick={handleGenerate} disabled={!selected || generating}
          style={{ opacity: (!selected || generating) ? 0.5 : 1 }}>
          {generating ? '⏳ Generating…' : '✨ Generate'}
        </button>
      </div>

      {generatedMsg && (
        <div style={CARD}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: GREEN }}>Generated · {channel}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <CopyBtn text={generatedMsg} label={`${channelIcon[channel] || '📋'} Copy`} />
              <button className="action-btn" onClick={handleGenerate} style={{ fontSize: 11 }}>↻ Regen</button>
            </div>
          </div>
          <textarea style={{ ...INPUT, minHeight: 120, resize: 'vertical', lineHeight: 1.6 }}
            value={generatedMsg} onChange={e => setGeneratedMsg(e.target.value)} />
          {selected && <SendButtons stakeholder={selected} message={generatedMsg} />}
        </div>
      )}
    </div>
  );
}

// ─── Tab 2: Bulk ──────────────────────────────────────────────────────────────
function BulkTab({ data }) {
  const { stakeholders, accounts, outreach, campaigns } = data;
  const [companyFilter, setCompanyFilter] = useState('');
  const [industryFilter, setIndustryFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [channel, setChannel] = useState('WhatsApp');
  const [msgType, setMsgType] = useState('First Touch');
  const [bulkMsgs, setBulkMsgs] = useState({});
  const [generating, setGenerating] = useState(false);
  const [expanded, setExpanded] = useState(new Set());

  const uniqueAccounts = useMemo(() => {
    const seen = new Set(); const list = [];
    stakeholders.forEach(s => {
      const acc = getAccount(s, accounts);
      if (acc && !seen.has(acc.id)) { seen.add(acc.id); list.push(acc); }
    });
    return list.sort((a, b) => (F(a, 'Account Name') || '').localeCompare(F(b, 'Account Name') || ''));
  }, [stakeholders, accounts]);

  const uniqueIndustries = useMemo(() => {
    const s = new Set();
    accounts.forEach(a => { const v = F(a, 'Industry'); if (v) s.add(v); });
    return [...s].sort();
  }, [accounts]);

  const uniqueCountries = useMemo(() => {
    const s = new Set();
    accounts.forEach(a => { const v = F(a, 'Country'); if (v) s.add(v); });
    return [...s].sort();
  }, [accounts]);

  const uniqueStatuses = useMemo(() => {
    const s = new Set();
    stakeholders.forEach(st => { const v = F(st, 'Status'); if (v) s.add(v); });
    return [...s].sort();
  }, [stakeholders]);

  const filtered = useMemo(() => {
    return stakeholders.filter(s => {
      const acc = getAccount(s, accounts);
      if (companyFilter && (!acc || acc.id !== companyFilter)) return false;
      if (industryFilter && (!acc || F(acc, 'Industry') !== industryFilter)) return false;
      if (countryFilter && (!acc || F(acc, 'Country') !== countryFilter)) return false;
      if (statusFilter && F(s, 'Status') !== statusFilter) return false;
      return true;
    });
  }, [stakeholders, accounts, companyFilter, industryFilter, countryFilter, statusFilter]);

  const allChecked = filtered.length > 0 && filtered.every(s => selected.has(s.id));

  function toggleAll() {
    if (allChecked) {
      setSelected(prev => { const n = new Set(prev); filtered.forEach(s => n.delete(s.id)); return n; });
    } else {
      setSelected(prev => { const n = new Set(prev); filtered.forEach(s => n.add(s.id)); return n; });
    }
  }
  function toggleOne(id) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function handleGenerateAll() {
    const targets = stakeholders.filter(s => selected.has(s.id));
    if (!targets.length) return;
    setGenerating(true);
    setBulkMsgs(prev => {
      const next = { ...prev };
      targets.forEach(s => { next[s.id] = { text: '', status: 'pending' }; });
      return next;
    });
    for (let i = 0; i < targets.length; i += 3) {
      const chunk = targets.slice(i, i + 3);
      setBulkMsgs(prev => {
        const next = { ...prev };
        chunk.forEach(s => { next[s.id] = { ...next[s.id], status: 'generating' }; });
        return next;
      });
      await Promise.all(chunk.map(async s => {
        const acc = getAccount(s, accounts);
        const prompt = buildPrompt(s, acc, outreach, campaigns, msgType, channel);
        try {
          const result = await callOpenAI({ prompt, max_tokens: 450, temperature: 0.75 });
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

  const selectedStakeholders = stakeholders.filter(s => selected.has(s.id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <select style={SEL} value={companyFilter} onChange={e => setCompanyFilter(e.target.value)}>
          <option value="">All Companies</option>
          {uniqueAccounts.map(a => <option key={a.id} value={a.id}>{F(a, 'Account Name')}</option>)}
        </select>
        <select style={SEL} value={industryFilter} onChange={e => setIndustryFilter(e.target.value)}>
          <option value="">All Industries</option>
          {uniqueIndustries.map(i => <option key={i}>{i}</option>)}
        </select>
        <select style={SEL} value={countryFilter} onChange={e => setCountryFilter(e.target.value)}>
          <option value="">All Countries</option>
          {uniqueCountries.map(c => <option key={c}>{c}</option>)}
        </select>
        <select style={SEL} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
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
              <th style={{ padding: '8px 12px', width: 36 }}>
                <input type="checkbox" checked={allChecked} onChange={toggleAll} />
              </th>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>Name</th>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>Company</th>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>Status</th>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>Message</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 100).map(s => {
              const acc = getAccount(s, accounts);
              const isChecked = selected.has(s.id);
              const msgState = bulkMsgs[s.id];
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
                                onClick={() => setExpanded(prev => { const n = new Set(prev); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; })}>
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
                        <textarea style={{ ...INPUT, minHeight: 80, resize: 'vertical' }}
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

      {/* Action bar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {selected.size > 0 && (
          <span style={{ ...CHIP, fontSize: 13, padding: '4px 12px' }}>{selected.size} selected</span>
        )}
        <select style={SEL} value={msgType} onChange={e => setMsgType(e.target.value)}>
          {MSG_TYPES.map(t => <option key={t}>{t}</option>)}
        </select>
        <select style={SEL} value={channel} onChange={e => setChannel(e.target.value)}>
          {CHANNELS.map(c => <option key={c}>{channelIcon[c] || ''} {c}</option>)}
        </select>
        <button className="action-btn" onClick={handleGenerateAll} disabled={!selected.size || generating}
          style={{ opacity: (!selected.size || generating) ? 0.5 : 1 }}>
          {generating ? '⏳ Generating…' : `✨ Generate for ${selected.size || 0}`}
        </button>
        {Object.values(bulkMsgs).some(m => m.status === 'done') && (
          <button className="action-btn" onClick={handleCopyAll} style={{ fontSize: 12 }}>📋 Copy All</button>
        )}
      </div>
    </div>
  );
}

// ─── Tab 3: Sequences ─────────────────────────────────────────────────────────
function SequencesTab({ data }) {
  const { stakeholders, accounts, outreach, campaigns } = data;
  const [sequences, setSequences] = useState(loadSequences);
  const [selectedSeqId, setSelectedSeqId] = useState(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newSeqName, setNewSeqName] = useState('');
  const [newSteps, setNewSteps] = useState([{ waitDays: 0, channel: 'WhatsApp', note: '' }]);
  const [enrollCompany, setEnrollCompany] = useState('');
  const [enrollSelected, setEnrollSelected] = useState(new Set());
  const [enrollDate, setEnrollDate] = useState(todayISO());
  const [enrollTime, setEnrollTime] = useState('09:00');
  const [enrollTz, setEnrollTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York');
  const [generatingFor, setGeneratingFor] = useState(null);
  const [stepMsgs, setStepMsgs] = useState({});

  const today = todayISO();
  const selectedSeq = sequences.find(s => s.id === selectedSeqId) || null;

  function persist(seqs) { setSequences(seqs); saveSequences(seqs); }
  function updateSeq(updated) { persist(sequences.map(s => s.id === updated.id ? updated : s)); }

  function handleAddStep() { setNewSteps(p => [...p, { waitDays: 3, channel: 'WhatsApp', note: '' }]); }
  function handleRemoveStep(i) { setNewSteps(p => p.filter((_, j) => j !== i)); }
  function handleMoveStep(i, dir) {
    setNewSteps(p => { const a = [...p]; const t = i + dir; if (t < 0 || t >= a.length) return a; [a[i], a[t]] = [a[t], a[i]]; return a; });
  }
  function handleStepField(i, field, val) { setNewSteps(p => p.map((s, j) => j === i ? { ...s, [field]: val } : s)); }

  function handleCreate() {
    if (!newSeqName.trim() || !newSteps.length) return;
    const seq = { id: Date.now(), name: newSeqName.trim(), steps: newSteps, enrollments: {} };
    persist([...sequences, seq]);
    setSelectedSeqId(seq.id);
    setShowNewForm(false);
    setNewSeqName('');
    setNewSteps([{ waitDays: 0, channel: 'WhatsApp', note: '' }]);
  }

  function handleDelete(id) {
    if (!confirm('Delete this sequence?')) return;
    persist(sequences.filter(s => s.id !== id));
    if (selectedSeqId === id) setSelectedSeqId(null);
  }

  // Enroll contacts picker
  const uniqueAccounts = useMemo(() => {
    const seen = new Set(); const list = [];
    stakeholders.forEach(s => {
      const acc = getAccount(s, accounts);
      if (acc && !seen.has(acc.id)) { seen.add(acc.id); list.push(acc); }
    });
    return list.sort((a, b) => (F(a, 'Account Name') || '').localeCompare(F(b, 'Account Name') || ''));
  }, [stakeholders, accounts]);

  const enrollContacts = useMemo(() => {
    if (!enrollCompany) return [];
    return stakeholders.filter(s => linkedIds(s, 'Account').includes(enrollCompany))
      .sort((a, b) => (F(a, 'Name') || '').localeCompare(F(b, 'Name') || ''));
  }, [enrollCompany, stakeholders]);

  function handleEnroll() {
    if (!selectedSeq || !enrollSelected.size) return;
    const updated = { ...selectedSeq, enrollments: { ...selectedSeq.enrollments } };
    enrollSelected.forEach(id => {
      if (!updated.enrollments[id]) {
        updated.enrollments[id] = {
          step: 0,
          nextDate: enrollDate,
          nextTime: enrollTime,
          timezone: enrollTz,
          status: 'active',
          sentSteps: [],
        };
      }
    });
    updateSeq(updated);
    setEnrollSelected(new Set());
    setEnrollCompany('');
  }

  function handleMarkSent(stakeholderId) {
    if (!selectedSeq) return;
    const e = selectedSeq.enrollments[stakeholderId];
    if (!e) return;
    const sentSteps = [...(e.sentSteps || []), { step: e.step, sentAt: new Date().toISOString() }];
    const nextStep = e.step + 1;
    const isLast = nextStep >= selectedSeq.steps.length;
    const updated = {
      ...selectedSeq,
      enrollments: {
        ...selectedSeq.enrollments,
        [stakeholderId]: isLast
          ? { ...e, sentSteps, status: 'completed' }
          : {
              ...e,
              step: nextStep,
              sentSteps,
              nextDate: addDays(selectedSeq.steps[nextStep].waitDays),
            },
      },
    };
    updateSeq(updated);
    setStepMsgs(prev => { const n = { ...prev }; delete n[stakeholderId]; return n; });
  }

  function handleUnenroll(id) {
    if (!selectedSeq) return;
    const updated = { ...selectedSeq, enrollments: { ...selectedSeq.enrollments } };
    delete updated.enrollments[id];
    updateSeq(updated);
  }

  async function handleGenerateStep(stakeholderId) {
    if (!selectedSeq) return;
    const e = selectedSeq.enrollments[stakeholderId];
    const s = stakeholders.find(st => st.id === stakeholderId);
    if (!s || !e) return;
    const step = selectedSeq.steps[e.step];
    const acc = getAccount(s, accounts);
    const stepCtx = `\n\nThis is step ${e.step + 1} of ${selectedSeq.steps.length} in sequence "${selectedSeq.name}": ${step.note || ''} via ${step.channel}${step.waitDays ? ` (${step.waitDays} days after previous)` : ' (day 0)'}. `;
    const prompt = buildPrompt(s, acc, outreach, campaigns, e.step === 0 ? 'First Touch' : 'Follow-up', step.channel) + stepCtx;
    setGeneratingFor(stakeholderId);
    try {
      const result = await callOpenAI({ prompt, max_tokens: 450, temperature: 0.75 });
      setStepMsgs(prev => ({ ...prev, [stakeholderId]: result || '' }));
    } catch (err) {
      setStepMsgs(prev => ({ ...prev, [stakeholderId]: 'Error: ' + (err.message || err) }));
    } finally {
      setGeneratingFor(null);
    }
  }

  const enrolledList = selectedSeq
    ? Object.entries(selectedSeq.enrollments)
        .map(([id, e]) => ({ id, ...e, stakeholder: stakeholders.find(s => s.id === id) }))
        .filter(e => e.stakeholder)
        .sort((a, b) => (a.nextDate || '').localeCompare(b.nextDate || ''))
    : [];

  const dueToday = enrolledList.filter(e => e.nextDate <= today && e.status === 'active');
  const upcoming = enrolledList.filter(e => e.nextDate > today && e.status === 'active');
  const completed = enrolledList.filter(e => e.status === 'completed');

  return (
    <div style={{ display: 'flex', gap: 16, minHeight: 400 }}>
      {/* Left: sequence list */}
      <div style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button className="action-btn" onClick={() => setShowNewForm(true)} style={{ width: '100%' }}>
          + New Sequence
        </button>
        {sequences.map(seq => (
          <div key={seq.id} onClick={() => setSelectedSeqId(seq.id)} style={{
            ...CARD, padding: '10px 12px', cursor: 'pointer',
            borderColor: selectedSeqId === seq.id ? GREEN : 'var(--globant-border)',
            background: selectedSeqId === seq.id ? 'rgba(74,222,128,0.07)' : 'rgba(255,255,255,0.04)',
          }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{seq.name}</div>
            <div style={MUTED}>{seq.steps.length} steps · {Object.keys(seq.enrollments || {}).length} enrolled</div>
            <button style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 11, padding: 0, marginTop: 4 }}
              onClick={e => { e.stopPropagation(); handleDelete(seq.id); }}>Delete</button>
          </div>
        ))}
        {!sequences.length && !showNewForm && (
          <div style={{ ...MUTED, textAlign: 'center', padding: 16 }}>No sequences yet</div>
        )}
      </div>

      {/* Right: detail */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* New sequence form */}
        {showNewForm && (
          <div style={CARD}>
            <div style={{ fontWeight: 700, marginBottom: 12 }}>New Sequence</div>
            <input style={{ ...INPUT, marginBottom: 10 }} placeholder="Sequence name…"
              value={newSeqName} onChange={e => setNewSeqName(e.target.value)} />
            <div style={{ fontSize: 12, color: 'var(--globant-muted)', marginBottom: 6 }}>Steps</div>
            {newSteps.map((step, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{ ...MUTED, minWidth: 22 }}>#{i + 1}</span>
                <input type="number" style={{ ...INPUT, width: 70 }} value={step.waitDays}
                  onChange={e => handleStepField(i, 'waitDays', e.target.value)} placeholder="Days" title="Wait days from previous step" />
                <select style={{ ...SEL, minWidth: 120 }} value={step.channel} onChange={e => handleStepField(i, 'channel', e.target.value)}>
                  {CHANNELS.map(c => <option key={c}>{c}</option>)}
                </select>
                <input style={{ ...INPUT, flex: 1 }} placeholder="Intent / note…"
                  value={step.note} onChange={e => handleStepField(i, 'note', e.target.value)} />
                <button style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer' }} onClick={() => handleMoveStep(i, -1)}>▲</button>
                <button style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer' }} onClick={() => handleMoveStep(i, 1)}>▼</button>
                <button style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer' }} onClick={() => handleRemoveStep(i)}>✕</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="action-btn" onClick={handleAddStep} style={{ fontSize: 12 }}>+ Add Step</button>
              <button className="action-btn" onClick={handleCreate} disabled={!newSeqName.trim()}>Create</button>
              <button style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 12 }} onClick={() => setShowNewForm(false)}>Cancel</button>
            </div>
          </div>
        )}

        {selectedSeq && (
          <>
            {/* Steps timeline */}
            <div style={CARD}>
              <div style={{ fontWeight: 700, marginBottom: 10 }}>{selectedSeq.name}</div>
              <div style={{ display: 'flex', alignItems: 'flex-start', overflowX: 'auto', gap: 0 }}>
                {selectedSeq.steps.map((step, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start' }}>
                    <div style={{ textAlign: 'center', minWidth: 100 }}>
                      <div style={{ width: 28, height: 28, borderRadius: '50%', background: GREEN, color: '#000', fontWeight: 700, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 4px' }}>{i + 1}</div>
                      <div style={{ fontSize: 11, color: GREEN }}>{channelIcon[step.channel]} {step.channel}</div>
                      <div style={{ ...MUTED, marginTop: 2 }}>{step.waitDays ? `+${step.waitDays}d` : 'Day 0'}</div>
                      {step.note && <div style={{ ...MUTED, maxWidth: 90, marginTop: 2 }}>{step.note}</div>}
                    </div>
                    {i < selectedSeq.steps.length - 1 && (
                      <div style={{ width: 24, height: 2, background: 'var(--globant-border)', marginTop: 13 }} />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Due today */}
            {dueToday.length > 0 && (
              <div style={{ ...CARD, borderColor: GREEN }}>
                <div style={{ fontWeight: 700, color: GREEN, marginBottom: 10 }}>📅 Due Today ({dueToday.length})</div>
                {dueToday.map(e => {
                  const s = e.stakeholder;
                  const acc = getAccount(s, accounts);
                  const step = selectedSeq.steps[e.step];
                  const msg = stepMsgs[e.id];
                  return (
                    <div key={e.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10, marginTop: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 6 }}>
                        <div>
                          <span style={{ fontWeight: 600 }}>{F(s, 'Name')}</span>
                          <span style={MUTED}> · {acc ? F(acc, 'Account Name') : '—'}</span>
                          <div style={{ fontSize: 11, color: GREEN, marginTop: 2 }}>
                            Step {e.step + 1}: {channelIcon[step?.channel]} {step?.channel}
                            {e.nextTime && <span style={MUTED}> · {e.nextTime} {e.timezone || ''}</span>}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="action-btn" onClick={() => handleGenerateStep(e.id)}
                            disabled={generatingFor === e.id} style={{ fontSize: 11 }}>
                            {generatingFor === e.id ? '⏳' : '✨ Generate'}
                          </button>
                          <button className="action-btn" onClick={() => handleMarkSent(e.id)} style={{ fontSize: 11 }}
                            title="Mark that YOU sent this manually — does not send automatically">
                            ✓ I Sent This
                          </button>
                        </div>
                      </div>
                      {msg && (
                        <div style={{ marginTop: 8 }}>
                          <textarea style={{ ...INPUT, minHeight: 80, resize: 'vertical' }}
                            value={msg} onChange={ev => setStepMsgs(prev => ({ ...prev, [e.id]: ev.target.value }))} />
                          <div style={{ marginTop: 4, display: 'flex', gap: 6 }}>
                            <CopyBtn text={msg} label={`${channelIcon[step?.channel] || '📋'} Copy`} />
                            <SendButtons stakeholder={s} message={msg} />
                          </div>
                        </div>
                      )}
                      {(e.sentSteps || []).length > 0 && (
                        <div style={{ ...MUTED, marginTop: 4 }}>
                          Sent steps: {(e.sentSteps || []).map(ss => `Step ${ss.step + 1} (${ss.sentAt?.slice(0, 10) || '?'})`).join(', ')}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Upcoming */}
            {upcoming.length > 0 && (
              <div style={CARD}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Upcoming</div>
                {upcoming.map(e => {
                  const s = e.stakeholder;
                  const acc = getAccount(s, accounts);
                  const step = selectedSeq.steps[e.step];
                  return (
                    <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderTop: '1px solid rgba(255,255,255,0.04)', flexWrap: 'wrap', gap: 4 }}>
                      <div>
                        <span style={{ fontWeight: 500 }}>{F(s, 'Name')}</span>
                        <span style={MUTED}> · {acc ? F(acc, 'Account Name') : '—'}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--globant-muted)' }}>
                        {step && <span>{channelIcon[step.channel]} Step {e.step + 1}</span>}
                        <span>Next: {e.nextDate} {e.nextTime || ''}</span>
                        {e.timezone && <span style={{ fontSize: 11 }}>{e.timezone}</span>}
                        <button style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 11 }} onClick={() => handleUnenroll(e.id)}>Remove</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Completed */}
            {completed.length > 0 && (
              <div style={CARD}>
                <div style={{ fontWeight: 700, marginBottom: 8, color: GREEN }}>✓ Completed ({completed.length})</div>
                {completed.map(e => {
                  const s = e.stakeholder;
                  const acc = getAccount(s, accounts);
                  return (
                    <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                      <div>
                        <span style={{ fontWeight: 500 }}>{F(s, 'Name')}</span>
                        <span style={MUTED}> · {acc ? F(acc, 'Account Name') : '—'}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--globant-muted)' }}>
                        <span style={{ color: GREEN }}>✓ All {(e.sentSteps || []).length} steps sent</span>
                        <button style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 11 }} onClick={() => handleUnenroll(e.id)}>Remove</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Enroll contacts */}
            <div style={CARD}>
              <div style={{ fontWeight: 700, marginBottom: 12 }}>Enroll Contacts</div>

              {/* Schedule */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ ...MUTED, marginBottom: 6, fontWeight: 600 }}>📅 Schedule first touch</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input type="date" style={{ ...INPUT, width: 150 }} value={enrollDate}
                    onChange={e => setEnrollDate(e.target.value)} />
                  <input type="time" style={{ ...INPUT, width: 110 }} value={enrollTime}
                    onChange={e => setEnrollTime(e.target.value)} />
                  <select style={{ ...SEL, minWidth: 200 }} value={enrollTz} onChange={e => setEnrollTz(e.target.value)}>
                    {TIMEZONES.map(tz => <option key={tz}>{tz}</option>)}
                  </select>
                </div>
              </div>

              {/* Company picker */}
              <div style={{ ...MUTED, marginBottom: 6, fontWeight: 600 }}>👥 Pick contacts</div>
              <div style={{ marginBottom: 8 }}>
                <select style={{ ...SEL, width: '100%' }} value={enrollCompany} onChange={e => { setEnrollCompany(e.target.value); setEnrollSelected(new Set()); }}>
                  <option value="">Select company…</option>
                  {uniqueAccounts.map(a => <option key={a.id} value={a.id}>{F(a, 'Account Name')}</option>)}
                </select>
              </div>

              {enrollContacts.length > 0 && (
                <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 10 }}>
                  {enrollContacts.map(s => {
                    const isEnrolled = !!selectedSeq.enrollments[s.id];
                    const isSel = enrollSelected.has(s.id);
                    return (
                      <div key={s.id} onClick={() => { if (isEnrolled) return; setEnrollSelected(prev => { const n = new Set(prev); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; }); }}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 6, cursor: isEnrolled ? 'default' : 'pointer', background: isSel ? 'rgba(74,222,128,0.1)' : 'transparent', opacity: isEnrolled ? 0.4 : 1 }}>
                        <input type="checkbox" checked={isSel} readOnly disabled={isEnrolled} />
                        <span style={{ fontSize: 13 }}>{F(s, 'Name')}</span>
                        {isEnrolled && <span style={{ ...MUTED, marginLeft: 'auto' }}>already enrolled</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              <button className="action-btn" onClick={handleEnroll} disabled={!enrollSelected.size}
                style={{ opacity: enrollSelected.size ? 1 : 0.5 }}>
                Enroll {enrollSelected.size > 0 ? `(${enrollSelected.size})` : ''}
              </button>
            </div>
          </>
        )}

        {!selectedSeq && !showNewForm && (
          <div style={{ textAlign: 'center', color: 'var(--globant-muted)', padding: 40 }}>
            Select or create a sequence to get started
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function MessageLab({ data, api, onLogActivity, onUpdateRecord }) {
  const [tab, setTab] = useState('individual');
  const tabs = [
    { key: 'individual', label: '👤 Individual' },
    { key: 'bulk', label: '📋 Bulk' },
    { key: 'sequences', label: '🔁 Sequences' },
  ];

  return (
    <div style={{ padding: 24, background: 'var(--globant-bg, #0f1117)', minHeight: '100vh', boxSizing: 'border-box' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>✉️ Message Lab</h2>
        <p style={{ margin: '4px 0 0', color: 'var(--globant-muted)', fontSize: 13 }}>
          AI-powered outreach — uses your prompts from Settings, campaign context, and full conversation history
        </p>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--globant-border)' }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '8px 16px', fontSize: 14,
            fontWeight: tab === t.key ? 600 : 400, color: tab === t.key ? '#fff' : 'var(--globant-muted)',
            borderBottom: tab === t.key ? `2px solid ${GREEN}` : '2px solid transparent', transition: 'all 0.15s',
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'individual' && <IndividualTab data={data} />}
      {tab === 'bulk' && <BulkTab data={data} />}
      {tab === 'sequences' && <SequencesTab data={data} />}
    </div>
  );
}
