/* global React */
const { useState, useEffect, useCallback, useMemo, useRef } = React;

import {
  AirtableAPI, TABLE_IDS, CURRENT_USER, COMPANY_PROFILE,
  callOpenAI, channelIcon, CLIENT_CONFIG,
} from '../globals.js';
import { F, linkedIds, resolveLinked, InfoTip } from '../utils.js';

// ─── Constants ───────────────────────────────────────────────────────────────
const CHANNELS = ['WhatsApp', 'LinkedIn', 'Email'];
const MSG_TYPES = ['First Touch', 'Follow-up', 'Breakup'];
const SEQ_LS_KEY = 'oike_sequences';

const CARD_STYLE = {
  background: 'rgba(255,255,255,0.04)',
  borderRadius: 12,
  border: '1px solid var(--globant-border)',
  padding: 16,
};

const INPUT_STYLE = {
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

const SELECT_STYLE = {
  ...INPUT_STYLE,
  width: 'auto',
  minWidth: 120,
  cursor: 'pointer',
};

const CHIP_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  background: 'rgba(74,222,128,0.12)',
  border: '1px solid rgba(74,222,128,0.3)',
  borderRadius: 20,
  padding: '2px 10px',
  fontSize: 11,
  color: '#4ade80',
  marginRight: 6,
  marginBottom: 4,
};

const MUTED = { color: 'var(--globant-muted)', fontSize: 12 };
const GREEN = '#4ade80';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function loadSequences() {
  try {
    return JSON.parse(localStorage.getItem(SEQ_LS_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveSequences(seqs) {
  localStorage.setItem(SEQ_LS_KEY, JSON.stringify(seqs));
}

function getStakeholderAccount(s, accounts) {
  const accIds = linkedIds(s, 'Account');
  if (!accIds.length) return null;
  return accounts.find(a => a.id === accIds[0]) || null;
}

function buildIndividualPrompt(s, account, outreach, campaigns, msgType, channel) {
  const cp = COMPANY_PROFILE || {};
  const name = F(s, 'Name') || 'the contact';
  const role = F(s, 'Title') || F(s, 'Role') || '';
  const accName = account ? F(account, 'Name') : '';
  const industry = account ? F(account, 'Industry') : '';
  const painPoints = F(s, 'Pain Points (Generated)') || F(s, 'Pain Points') || '';

  // Campaign context
  const stakeholderCampaigns = campaigns.filter(c => {
    const ids = linkedIds(c, 'Stakeholders') || linkedIds(c, 'Contacts') || [];
    return ids.includes(s.id);
  });
  const campaignCtx = stakeholderCampaigns.length
    ? stakeholderCampaigns.map(c => `${F(c, 'Name') || 'Campaign'}: ${F(c, 'Description') || ''}`).join('; ')
    : '';

  // Outreach history (last 5)
  const history = outreach
    .filter(o => {
      const ids = linkedIds(o, 'Stakeholder') || linkedIds(o, 'Stakeholders') || [];
      return ids.includes(s.id);
    })
    .slice(-5)
    .map(o => `[${F(o, 'Date') || ''}] ${F(o, 'Channel') || ''}: ${(F(o, 'Message') || '').slice(0, 120)}`)
    .join('\n');

  const channelRules = (channel === 'Email')
    ? 'Write up to 5 sentences. Professional but warm tone. Include a subject line.'
    : 'Write max 3 sentences. Concise, conversational, no fluff.';

  const typeInstructions = {
    'First Touch': 'This is the very first outreach. Do not reference past conversations. Focus on relevance and value.',
    'Follow-up': 'This is a follow-up. Reference previous contact naturally without being pushy.',
    'Breakup': 'This is a final breakup message. Keep it short, gracious, and leave the door open.',
  }[msgType] || '';

  return `You are ${cp.senderTitle || 'a sales rep'} at ${cp.companyName || 'our company'}.
${cp.services ? `Services/offering: ${cp.services}` : ''}
${cp.voiceTone ? `Voice/tone: ${cp.voiceTone}` : ''}

Recipient:
- Name: ${name}
- Role: ${role}
- Company: ${accName}
- Industry: ${industry}
${painPoints ? `- Pain points: ${painPoints}` : ''}
${campaignCtx ? `- Campaign context: ${campaignCtx}` : ''}

${history ? `Outreach history (most recent):\n${history}` : 'No prior outreach history.'}

Message type: ${msgType}
Channel: ${channel}
${typeInstructions}
${channelRules}

Write ONE message only. No preamble or explanation. Just the message itself.`;
}

// ─── Copy button ──────────────────────────────────────────────────────────────
function CopyBtn({ text, label }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text || '').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <button
      className="action-btn"
      onClick={handleCopy}
      style={{ fontSize: 12, padding: '4px 10px' }}
    >
      {copied ? '✓ Copied' : (label || '📋 Copy')}
    </button>
  );
}

// ─── Tab 1: Individual ────────────────────────────────────────────────────────
function IndividualTab({ data }) {
  const { stakeholders, accounts, outreach, campaigns } = data;
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [msgType, setMsgType] = useState('First Touch');
  const [channel, setChannel] = useState('WhatsApp');
  const [generatedMsg, setGeneratedMsg] = useState('');
  const [generating, setGenerating] = useState(false);

  const filtered = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    return stakeholders.filter(s => {
      const name = (F(s, 'Name') || '').toLowerCase();
      const acc = getStakeholderAccount(s, accounts);
      const accName = acc ? (F(acc, 'Name') || '').toLowerCase() : '';
      return name.includes(q) || accName.includes(q);
    }).slice(0, 8);
  }, [search, stakeholders, accounts]);

  const account = selected ? getStakeholderAccount(selected, accounts) : null;

  const stakeholderOutreach = useMemo(() => {
    if (!selected) return [];
    return outreach.filter(o => {
      const ids = linkedIds(o, 'Stakeholder') || linkedIds(o, 'Stakeholders') || [];
      return ids.includes(selected.id);
    });
  }, [selected, outreach]);

  const stakeholderCampaigns = useMemo(() => {
    if (!selected) return [];
    return campaigns.filter(c => {
      const ids = linkedIds(c, 'Stakeholders') || linkedIds(c, 'Contacts') || [];
      return ids.includes(selected.id);
    });
  }, [selected, campaigns]);

  const lastChannel = stakeholderOutreach.length
    ? F(stakeholderOutreach[stakeholderOutreach.length - 1], 'Channel') || '—'
    : '—';

  const handleGenerate = async () => {
    if (!selected) return;
    setGenerating(true);
    setGeneratedMsg('');
    try {
      const prompt = buildIndividualPrompt(selected, account, outreach, campaigns, msgType, channel);
      const result = await callOpenAI({ prompt, max_tokens: 400, temperature: 0.75 });
      setGeneratedMsg(result || '');
    } catch (e) {
      setGeneratedMsg('Error generating message: ' + (e.message || e));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Contact search */}
      <div style={{ position: 'relative' }}>
        <input
          style={INPUT_STYLE}
          placeholder="Search contacts by name or company…"
          value={search}
          onChange={e => { setSearch(e.target.value); setSelected(null); setGeneratedMsg(''); }}
        />
        {filtered.length > 0 && !selected && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
            background: '#1a1d27', border: '1px solid var(--globant-border)',
            borderRadius: 8, overflow: 'hidden', marginTop: 2,
          }}>
            {filtered.map(s => {
              const acc = getStakeholderAccount(s, accounts);
              return (
                <div
                  key={s.id}
                  onClick={() => { setSelected(s); setSearch(F(s, 'Name') || ''); setGeneratedMsg(''); }}
                  style={{
                    padding: '8px 12px', cursor: 'pointer', fontSize: 13,
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.07)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <span style={{ fontWeight: 600 }}>{F(s, 'Name')}</span>
                  {acc && <span style={MUTED}> · {F(acc, 'Name')}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Selected contact info */}
      {selected && (
        <div style={CARD_STYLE}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{F(selected, 'Name')}</div>
              <div style={MUTED}>{F(selected, 'Title') || F(selected, 'Role') || '—'} · {account ? F(account, 'Name') : '—'}</div>
              <div style={{ ...MUTED, marginTop: 4 }}>
                Last channel: {channelIcon[lastChannel] || ''} {lastChannel} &nbsp;·&nbsp; {stakeholderOutreach.length} messages
              </div>
            </div>
            <button style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 16 }}
              onClick={() => { setSelected(null); setSearch(''); setGeneratedMsg(''); }}>✕</button>
          </div>

          {/* Context chips */}
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap' }}>
            {stakeholderCampaigns.map(c => (
              <span key={c.id} style={CHIP_STYLE}>📣 Campaign: {F(c, 'Name') || 'Unknown'}</span>
            ))}
            {stakeholderOutreach.length > 0 && (
              <span style={CHIP_STYLE}>💬 {stakeholderOutreach.length} messages</span>
            )}
            {(F(selected, 'Pain Points (Generated)') || F(selected, 'Pain Points')) && (
              <span style={CHIP_STYLE}>🎯 Pain points</span>
            )}
            <span style={CHIP_STYLE}>🏢 {(COMPANY_PROFILE || {}).companyName || 'Offering'}</span>
          </div>
        </div>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <select style={SELECT_STYLE} value={msgType} onChange={e => setMsgType(e.target.value)}>
          {MSG_TYPES.map(t => <option key={t}>{t}</option>)}
        </select>
        <select style={SELECT_STYLE} value={channel} onChange={e => setChannel(e.target.value)}>
          {CHANNELS.map(c => <option key={c}>{channelIcon[c] || ''} {c}</option>)}
        </select>
        <button
          className="action-btn"
          onClick={handleGenerate}
          disabled={!selected || generating}
          style={{ opacity: (!selected || generating) ? 0.5 : 1 }}
        >
          {generating ? '⏳ Generating…' : '✨ Generate'}
        </button>
      </div>

      {/* Generated message */}
      {generatedMsg && (
        <div style={CARD_STYLE}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: GREEN }}>Generated · {channel}</span>
            <CopyBtn text={generatedMsg} label={`${channelIcon[channel] || '📋'} Copy`} />
          </div>
          <textarea
            style={{ ...INPUT_STYLE, minHeight: 120, resize: 'vertical', lineHeight: 1.6 }}
            value={generatedMsg}
            onChange={e => setGeneratedMsg(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}

// ─── Tab 2: Bulk ──────────────────────────────────────────────────────────────
function BulkTab({ data }) {
  const { stakeholders, accounts, outreach, campaigns } = data;
  const [statusFilter, setStatusFilter] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [nameSearch, setNameSearch] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [channel, setChannel] = useState('WhatsApp');
  const [msgType, setMsgType] = useState('First Touch');
  const [bulkMsgs, setBulkMsgs] = useState({});
  const [generating, setGenerating] = useState(false);
  const [expanded, setExpanded] = useState(new Set());

  const uniqueStatuses = useMemo(() => {
    const s = new Set();
    stakeholders.forEach(st => { const v = F(st, 'Status'); if (v) s.add(v); });
    return [...s].sort();
  }, [stakeholders]);

  const uniqueStages = useMemo(() => {
    const s = new Set();
    stakeholders.forEach(st => { const v = F(st, 'Stage'); if (v) s.add(v); });
    return [...s].sort();
  }, [stakeholders]);

  const filtered = useMemo(() => {
    return stakeholders.filter(s => {
      if (statusFilter && F(s, 'Status') !== statusFilter) return false;
      if (stageFilter && F(s, 'Stage') !== stageFilter) return false;
      if (nameSearch) {
        const q = nameSearch.toLowerCase();
        const name = (F(s, 'Name') || '').toLowerCase();
        const acc = getStakeholderAccount(s, accounts);
        const accName = acc ? (F(acc, 'Name') || '').toLowerCase() : '';
        if (!name.includes(q) && !accName.includes(q)) return false;
      }
      return true;
    });
  }, [stakeholders, accounts, statusFilter, stageFilter, nameSearch]);

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

  const selectedStakeholders = stakeholders.filter(s => selected.has(s.id));

  async function handleGenerateAll() {
    if (!selectedStakeholders.length) return;
    setGenerating(true);
    // Initialize all as pending
    setBulkMsgs(prev => {
      const next = { ...prev };
      selectedStakeholders.forEach(s => { next[s.id] = { text: '', status: 'pending' }; });
      return next;
    });

    const chunks = [];
    for (let i = 0; i < selectedStakeholders.length; i += 3) {
      chunks.push(selectedStakeholders.slice(i, i + 3));
    }

    for (const chunk of chunks) {
      // Mark chunk as generating
      setBulkMsgs(prev => {
        const next = { ...prev };
        chunk.forEach(s => { next[s.id] = { ...next[s.id], status: 'generating' }; });
        return next;
      });

      await Promise.all(chunk.map(async (s) => {
        const acc = getStakeholderAccount(s, accounts);
        const prompt = buildIndividualPrompt(s, acc, outreach, campaigns, msgType, channel);
        try {
          const result = await callOpenAI({ prompt, max_tokens: 400, temperature: 0.75 });
          setBulkMsgs(prev => ({ ...prev, [s.id]: { text: result || '', status: 'done' } }));
        } catch (e) {
          setBulkMsgs(prev => ({ ...prev, [s.id]: { text: 'Error: ' + (e.message || e), status: 'error' } }));
        }
      }));
    }
    setGenerating(false);
  }

  function handleCopyAll() {
    const lines = selectedStakeholders
      .filter(s => bulkMsgs[s.id]?.status === 'done')
      .map(s => `=== ${F(s, 'Name')} ===\n${bulkMsgs[s.id].text}`)
      .join('\n\n');
    navigator.clipboard.writeText(lines);
  }

  function getLastTouch(s) {
    const hist = outreach.filter(o => {
      const ids = linkedIds(o, 'Stakeholder') || linkedIds(o, 'Stakeholders') || [];
      return ids.includes(s.id);
    });
    if (!hist.length) return '—';
    const last = hist[hist.length - 1];
    return F(last, 'Date') || '—';
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          style={{ ...INPUT_STYLE, width: 180 }}
          placeholder="Search by name…"
          value={nameSearch}
          onChange={e => setNameSearch(e.target.value)}
        />
        <select style={SELECT_STYLE} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          {uniqueStatuses.map(s => <option key={s}>{s}</option>)}
        </select>
        <select style={SELECT_STYLE} value={stageFilter} onChange={e => setStageFilter(e.target.value)}>
          <option value="">All Stages</option>
          {uniqueStages.map(s => <option key={s}>{s}</option>)}
        </select>
      </div>

      {/* Contact table */}
      <div style={{ ...CARD_STYLE, padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid var(--globant-border)' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', width: 36 }}>
                <input type="checkbox" checked={allChecked} onChange={toggleAll} />
              </th>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>Name</th>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>Company</th>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>Last Touch</th>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 100).map(s => {
              const acc = getStakeholderAccount(s, accounts);
              const isChecked = selected.has(s.id);
              const msgState = bulkMsgs[s.id];
              const isExpanded = expanded.has(s.id);
              return (
                <React.Fragment key={s.id}>
                  <tr
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: isChecked ? 'rgba(74,222,128,0.05)' : 'transparent' }}
                  >
                    <td style={{ padding: '7px 12px' }}>
                      <input type="checkbox" checked={isChecked} onChange={() => toggleOne(s.id)} />
                    </td>
                    <td style={{ padding: '7px 12px', fontWeight: 500 }}>{F(s, 'Name')}</td>
                    <td style={{ padding: '7px 12px', color: 'var(--globant-muted)' }}>{acc ? F(acc, 'Name') : '—'}</td>
                    <td style={{ padding: '7px 12px', color: 'var(--globant-muted)' }}>{getLastTouch(s)}</td>
                    <td style={{ padding: '7px 12px' }}>
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(255,255,255,0.08)' }}>
                        {F(s, 'Status') || '—'}
                      </span>
                    </td>
                  </tr>
                  {/* Inline generated message */}
                  {msgState && (
                    <tr style={{ background: 'rgba(0,0,0,0.2)' }}>
                      <td />
                      <td colSpan={4} style={{ padding: '6px 12px 10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span style={{ fontSize: 11, color: msgState.status === 'done' ? GREEN : msgState.status === 'error' ? '#f87171' : 'var(--globant-muted)' }}>
                            {msgState.status === 'generating' ? '⏳ Generating…' : msgState.status === 'done' ? '✓ Done' : msgState.status === 'error' ? '✕ Error' : '• Pending'}
                          </span>
                          {msgState.status === 'done' && (
                            <>
                              <button style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 11 }}
                                onClick={() => setExpanded(prev => { const n = new Set(prev); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; })}>
                                {isExpanded ? '▲ Collapse' : '▼ Expand'}
                              </button>
                              <CopyBtn text={msgState.text} />
                            </>
                          )}
                        </div>
                        {isExpanded && msgState.status === 'done' && (
                          <textarea
                            style={{ ...INPUT_STYLE, minHeight: 80, resize: 'vertical' }}
                            value={msgState.text}
                            onChange={e => setBulkMsgs(prev => ({ ...prev, [s.id]: { ...prev[s.id], text: e.target.value } }))}
                          />
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: 'var(--globant-muted)' }}>No contacts found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Bulk action bar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {selected.size > 0 && (
          <span style={{ ...CHIP_STYLE, fontSize: 13, padding: '4px 12px' }}>{selected.size} selected</span>
        )}
        <select style={SELECT_STYLE} value={msgType} onChange={e => setMsgType(e.target.value)}>
          {MSG_TYPES.map(t => <option key={t}>{t}</option>)}
        </select>
        <select style={SELECT_STYLE} value={channel} onChange={e => setChannel(e.target.value)}>
          {CHANNELS.map(c => <option key={c}>{channelIcon[c] || ''} {c}</option>)}
        </select>
        <button
          className="action-btn"
          onClick={handleGenerateAll}
          disabled={!selected.size || generating}
          style={{ opacity: (!selected.size || generating) ? 0.5 : 1 }}
        >
          {generating ? '⏳ Generating…' : `✨ Generate for ${selected.size || 0} contacts`}
        </button>
        {Object.values(bulkMsgs).some(m => m.status === 'done') && (
          <button className="action-btn" onClick={handleCopyAll} style={{ fontSize: 12 }}>
            📋 Copy All
          </button>
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
  const [enrollSearch, setEnrollSearch] = useState('');
  const [enrollSelected, setEnrollSelected] = useState(new Set());
  const [generatingFor, setGeneratingFor] = useState(null);
  const [stepMsgs, setStepMsgs] = useState({});

  const today = todayISO();
  const selectedSeq = sequences.find(s => s.id === selectedSeqId) || null;

  function persistSequences(seqs) {
    setSequences(seqs);
    saveSequences(seqs);
  }

  function updateSequence(updated) {
    persistSequences(sequences.map(s => s.id === updated.id ? updated : s));
  }

  // ── New sequence form ──
  function handleAddStep() {
    setNewSteps(prev => [...prev, { waitDays: 3, channel: 'WhatsApp', note: '' }]);
  }

  function handleRemoveStep(idx) {
    setNewSteps(prev => prev.filter((_, i) => i !== idx));
  }

  function handleMoveStep(idx, dir) {
    setNewSteps(prev => {
      const a = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= a.length) return a;
      [a[idx], a[target]] = [a[target], a[idx]];
      return a;
    });
  }

  function handleUpdateStep(idx, field, val) {
    setNewSteps(prev => prev.map((s, i) => i === idx ? { ...s, [field]: val } : s));
  }

  function handleCreateSequence() {
    if (!newSeqName.trim() || !newSteps.length) return;
    const seq = {
      id: Date.now(),
      name: newSeqName.trim(),
      steps: newSteps,
      enrollments: {},
    };
    persistSequences([...sequences, seq]);
    setSelectedSeqId(seq.id);
    setShowNewForm(false);
    setNewSeqName('');
    setNewSteps([{ waitDays: 0, channel: 'WhatsApp', note: '' }]);
  }

  function handleDeleteSequence(id) {
    if (!confirm('Delete this sequence?')) return;
    persistSequences(sequences.filter(s => s.id !== id));
    if (selectedSeqId === id) setSelectedSeqId(null);
  }

  // ── Enrollments ──
  const enrollFiltered = useMemo(() => {
    if (!enrollSearch.trim()) return stakeholders.slice(0, 50);
    const q = enrollSearch.toLowerCase();
    return stakeholders.filter(s => {
      const name = (F(s, 'Name') || '').toLowerCase();
      const acc = getStakeholderAccount(s, accounts);
      const accName = acc ? (F(acc, 'Name') || '').toLowerCase() : '';
      return name.includes(q) || accName.includes(q);
    }).slice(0, 30);
  }, [enrollSearch, stakeholders, accounts]);

  function handleEnroll() {
    if (!selectedSeq || !enrollSelected.size) return;
    const updated = { ...selectedSeq, enrollments: { ...selectedSeq.enrollments } };
    enrollSelected.forEach(id => {
      if (!updated.enrollments[id]) {
        updated.enrollments[id] = {
          step: 0,
          nextDate: addDaysISO(updated.steps[0]?.waitDays || 0),
          status: 'active',
        };
      }
    });
    updateSequence(updated);
    setEnrollSelected(new Set());
    setEnrollSearch('');
  }

  function handleAdvanceStep(stakeholderId) {
    if (!selectedSeq) return;
    const enrollment = selectedSeq.enrollments[stakeholderId];
    if (!enrollment) return;
    const nextStep = enrollment.step + 1;
    if (nextStep >= selectedSeq.steps.length) {
      const updated = {
        ...selectedSeq,
        enrollments: {
          ...selectedSeq.enrollments,
          [stakeholderId]: { ...enrollment, step: nextStep - 1, status: 'completed' },
        },
      };
      updateSequence(updated);
      return;
    }
    const updated = {
      ...selectedSeq,
      enrollments: {
        ...selectedSeq.enrollments,
        [stakeholderId]: {
          ...enrollment,
          step: nextStep,
          nextDate: addDaysISO(selectedSeq.steps[nextStep].waitDays),
        },
      },
    };
    updateSequence(updated);
  }

  function handleUnenroll(stakeholderId) {
    if (!selectedSeq) return;
    const updated = { ...selectedSeq, enrollments: { ...selectedSeq.enrollments } };
    delete updated.enrollments[stakeholderId];
    updateSequence(updated);
  }

  async function handleGenerateStep(stakeholderId) {
    if (!selectedSeq) return;
    const enrollment = selectedSeq.enrollments[stakeholderId];
    const s = stakeholders.find(st => st.id === stakeholderId);
    if (!s || !enrollment) return;
    const step = selectedSeq.steps[enrollment.step];
    const acc = getStakeholderAccount(s, accounts);
    const stepContext = `Step ${enrollment.step + 1} of ${selectedSeq.steps.length}: ${step.note || ''} via ${step.channel} after ${step.waitDays} days`;
    const prompt = buildIndividualPrompt(s, acc, outreach, campaigns, 'Follow-up', step.channel)
      + `\n\nSequence step context: ${stepContext}`;

    setGeneratingFor(stakeholderId);
    try {
      const result = await callOpenAI({ prompt, max_tokens: 400, temperature: 0.75 });
      setStepMsgs(prev => ({ ...prev, [stakeholderId]: result || '' }));
    } catch (e) {
      setStepMsgs(prev => ({ ...prev, [stakeholderId]: 'Error: ' + (e.message || e) }));
    } finally {
      setGeneratingFor(null);
    }
  }

  // Enrolled contacts sorted: due first
  const enrolledList = selectedSeq
    ? Object.entries(selectedSeq.enrollments)
        .map(([id, e]) => ({ id, ...e, stakeholder: stakeholders.find(s => s.id === id) }))
        .filter(e => e.stakeholder)
        .sort((a, b) => (a.nextDate || '').localeCompare(b.nextDate || ''))
    : [];

  const dueToday = enrolledList.filter(e => e.nextDate <= today && e.status === 'active');
  const upcoming = enrolledList.filter(e => e.nextDate > today || e.status !== 'active');

  return (
    <div style={{ display: 'flex', gap: 16, minHeight: 400 }}>
      {/* Left panel: sequence list */}
      <div style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button className="action-btn" onClick={() => setShowNewForm(true)} style={{ width: '100%' }}>
          + New Sequence
        </button>

        {sequences.map(seq => (
          <div
            key={seq.id}
            onClick={() => setSelectedSeqId(seq.id)}
            style={{
              ...CARD_STYLE,
              padding: '10px 12px',
              cursor: 'pointer',
              borderColor: selectedSeqId === seq.id ? GREEN : 'var(--globant-border)',
              background: selectedSeqId === seq.id ? 'rgba(74,222,128,0.07)' : 'rgba(255,255,255,0.04)',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{seq.name}</div>
            <div style={MUTED}>{seq.steps.length} steps · {Object.keys(seq.enrollments || {}).length} enrolled</div>
            <button
              style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 11, padding: 0, marginTop: 4 }}
              onClick={e => { e.stopPropagation(); handleDeleteSequence(seq.id); }}
            >
              Delete
            </button>
          </div>
        ))}

        {sequences.length === 0 && !showNewForm && (
          <div style={{ ...MUTED, textAlign: 'center', padding: 16 }}>No sequences yet</div>
        )}
      </div>

      {/* Right panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* New sequence form */}
        {showNewForm && (
          <div style={CARD_STYLE}>
            <div style={{ fontWeight: 700, marginBottom: 12 }}>New Sequence</div>
            <input
              style={{ ...INPUT_STYLE, marginBottom: 10 }}
              placeholder="Sequence name…"
              value={newSeqName}
              onChange={e => setNewSeqName(e.target.value)}
            />

            <div style={{ fontSize: 12, color: 'var(--globant-muted)', marginBottom: 6 }}>Steps</div>
            {newSteps.map((step, idx) => (
              <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{ ...MUTED, minWidth: 20 }}>#{idx + 1}</span>
                <input
                  type="number"
                  style={{ ...INPUT_STYLE, width: 70 }}
                  value={step.waitDays}
                  onChange={e => handleUpdateStep(idx, 'waitDays', parseInt(e.target.value) || 0)}
                  placeholder="Days"
                  title="Wait days"
                />
                <select style={{ ...SELECT_STYLE, minWidth: 110 }} value={step.channel} onChange={e => handleUpdateStep(idx, 'channel', e.target.value)}>
                  {CHANNELS.map(c => <option key={c}>{c}</option>)}
                </select>
                <input
                  style={{ ...INPUT_STYLE, flex: 1 }}
                  placeholder="Note / intent…"
                  value={step.note}
                  onChange={e => handleUpdateStep(idx, 'note', e.target.value)}
                />
                <button style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer' }} onClick={() => handleMoveStep(idx, -1)} title="Move up">▲</button>
                <button style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer' }} onClick={() => handleMoveStep(idx, 1)} title="Move down">▼</button>
                <button style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer' }} onClick={() => handleRemoveStep(idx)}>✕</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="action-btn" onClick={handleAddStep} style={{ fontSize: 12 }}>+ Add Step</button>
              <button className="action-btn" onClick={handleCreateSequence} disabled={!newSeqName.trim()}>Create</button>
              <button style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 12 }} onClick={() => setShowNewForm(false)}>Cancel</button>
            </div>
          </div>
        )}

        {selectedSeq && (
          <>
            {/* Steps timeline */}
            <div style={CARD_STYLE}>
              <div style={{ fontWeight: 700, marginBottom: 10 }}>{selectedSeq.name} — Steps</div>
              <div style={{ display: 'flex', gap: 0, alignItems: 'flex-start', overflowX: 'auto' }}>
                {selectedSeq.steps.map((step, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'flex-start' }}>
                    <div style={{ textAlign: 'center', minWidth: 100 }}>
                      <div style={{ width: 28, height: 28, borderRadius: '50%', background: GREEN, color: '#000', fontWeight: 700, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 4px' }}>
                        {idx + 1}
                      </div>
                      <div style={{ fontSize: 11, color: GREEN }}>{channelIcon[step.channel]} {step.channel}</div>
                      <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 2 }}>{step.waitDays ? `+${step.waitDays}d` : 'Day 0'}</div>
                      {step.note && <div style={{ fontSize: 10, color: 'var(--globant-muted)', maxWidth: 90, marginTop: 2 }}>{step.note}</div>}
                    </div>
                    {idx < selectedSeq.steps.length - 1 && (
                      <div style={{ width: 24, height: 2, background: 'var(--globant-border)', marginTop: 13 }} />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Due today */}
            {dueToday.length > 0 && (
              <div style={{ ...CARD_STYLE, borderColor: GREEN }}>
                <div style={{ fontWeight: 700, color: GREEN, marginBottom: 8 }}>📅 Due Today ({dueToday.length})</div>
                {dueToday.map(e => {
                  const s = e.stakeholder;
                  const acc = getStakeholderAccount(s, accounts);
                  const step = selectedSeq.steps[e.step];
                  const msgKey = e.id;
                  return (
                    <div key={e.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10, marginTop: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                        <div>
                          <span style={{ fontWeight: 600 }}>{F(s, 'Name')}</span>
                          <span style={MUTED}> · {acc ? F(acc, 'Name') : '—'}</span>
                          <span style={{ fontSize: 11, marginLeft: 8, color: GREEN }}>
                            Step {e.step + 1}: {channelIcon[step?.channel]} {step?.channel}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="action-btn"
                            onClick={() => handleGenerateStep(e.id)}
                            disabled={generatingFor === e.id}
                            style={{ fontSize: 11 }}
                          >
                            {generatingFor === e.id ? '⏳' : '✨ Generate'}
                          </button>
                          <button className="action-btn" onClick={() => handleAdvanceStep(e.id)} style={{ fontSize: 11 }}>
                            Mark Sent →
                          </button>
                        </div>
                      </div>
                      {stepMsgs[e.id] && (
                        <div style={{ marginTop: 8 }}>
                          <textarea
                            style={{ ...INPUT_STYLE, minHeight: 80, resize: 'vertical' }}
                            value={stepMsgs[e.id]}
                            onChange={ev => setStepMsgs(prev => ({ ...prev, [e.id]: ev.target.value }))}
                          />
                          <div style={{ marginTop: 4 }}>
                            <CopyBtn text={stepMsgs[e.id]} />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Enrolled contacts */}
            {upcoming.length > 0 && (
              <div style={CARD_STYLE}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Enrolled Contacts</div>
                {upcoming.map(e => {
                  const s = e.stakeholder;
                  const acc = getStakeholderAccount(s, accounts);
                  const step = selectedSeq.steps[e.step];
                  const statusColor = e.status === 'completed' ? GREEN : e.status === 'paused' ? '#facc15' : 'var(--globant-muted)';
                  return (
                    <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderTop: '1px solid rgba(255,255,255,0.04)', flexWrap: 'wrap', gap: 4 }}>
                      <div>
                        <span style={{ fontWeight: 500 }}>{F(s, 'Name')}</span>
                        <span style={MUTED}> · {acc ? F(acc, 'Name') : '—'}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: 'var(--globant-muted)' }}>
                        {step && <span>{channelIcon[step.channel]} Step {e.step + 1}</span>}
                        <span>Next: {e.nextDate}</span>
                        <span style={{ color: statusColor }}>{e.status}</span>
                        <button style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 11 }} onClick={() => handleUnenroll(e.id)}>Remove</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Enroll contacts */}
            <div style={CARD_STYLE}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Enroll Contacts</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <input
                  style={{ ...INPUT_STYLE, flex: 1 }}
                  placeholder="Search contacts…"
                  value={enrollSearch}
                  onChange={e => setEnrollSearch(e.target.value)}
                />
                <button
                  className="action-btn"
                  onClick={handleEnroll}
                  disabled={!enrollSelected.size}
                  style={{ opacity: enrollSelected.size ? 1 : 0.5 }}
                >
                  Enroll {enrollSelected.size > 0 ? `(${enrollSelected.size})` : ''}
                </button>
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                {enrollFiltered.map(s => {
                  const acc = getStakeholderAccount(s, accounts);
                  const isEnrolled = !!selectedSeq.enrollments[s.id];
                  const isSelected = enrollSelected.has(s.id);
                  return (
                    <div
                      key={s.id}
                      onClick={() => {
                        if (isEnrolled) return;
                        setEnrollSelected(prev => { const n = new Set(prev); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; });
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
                        borderRadius: 6, cursor: isEnrolled ? 'default' : 'pointer',
                        background: isSelected ? 'rgba(74,222,128,0.1)' : 'transparent',
                        opacity: isEnrolled ? 0.4 : 1,
                      }}
                    >
                      <input type="checkbox" checked={isSelected} readOnly disabled={isEnrolled} />
                      <span style={{ fontSize: 13 }}>{F(s, 'Name')}</span>
                      <span style={MUTED}>{acc ? F(acc, 'Name') : ''}</span>
                      {isEnrolled && <span style={{ ...MUTED, marginLeft: 'auto' }}>enrolled</span>}
                    </div>
                  );
                })}
              </div>
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

// ─── Main component ───────────────────────────────────────────────────────────
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
          AI-powered outreach for individuals, bulk campaigns, and automated sequences
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--globant-border)', paddingBottom: 0 }}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: tab === t.key ? `2px solid ${GREEN}` : '2px solid transparent',
              color: tab === t.key ? '#fff' : 'var(--globant-muted)',
              cursor: 'pointer',
              padding: '8px 16px',
              fontSize: 14,
              fontWeight: tab === t.key ? 600 : 400,
              transition: 'all 0.15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'individual' && <IndividualTab data={data} />}
      {tab === 'bulk' && <BulkTab data={data} />}
      {tab === 'sequences' && <SequencesTab data={data} />}
    </div>
  );
}
