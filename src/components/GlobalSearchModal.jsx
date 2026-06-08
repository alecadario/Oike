/* global React */
const { useState, useEffect, useCallback, useMemo, useRef } = React;

import {
  AirtableAPI, TABLE_IDS, CURRENT_USER, COMPANY_PROFILE,
  callOpenAI, navSetUrl, SOURCE_OPTIONS, OPP_STAGES, WON_STAGES, CLOSED_STAGES,
  BENCH_REPLY_HIGH, BENCH_REPLY_LOW, BENCH_MEETING_HIGH, BENCH_MEETING_LOW,
  CHANNEL_BENCHMARKS, MESSAGE_PROMPTS, MESSAGE_PROMPT_DEFAULTS, saveMessagePrompts,
  resolvePromptTemplate, saveCompanyProfile, channelIcon, logoutUser,
  CLIENT_CONFIG, AUTH_TOKEN, loadBranding, BRANDING_LS_KEY,
} from '../globals.js';
import {
  F, linkedIds, resolveLinked, InfoTip, REPLY_STATUSES, computeEnrichment,
  DIAGNOSIS_CONFIG, findDuplicateStakeholder, confirmDuplicateStakeholder,
  deriveStakeholderStatus, updateStakeholderStatus, STAKEHOLDER_STATUS_PRIORITY,
  STAKEHOLDER_STATUS_PROTECTED, activateAccountIfNeeded,
  formatCurrency, formatDate, strSimilarity, FileNotesRenderer,
} from '../utils.js';


function GlobalSearchModal({ data, onClose, onNavigate }) {
  const [q, setQ] = React.useState('');
  const inputRef = React.useRef(null);
  React.useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);

  const stakeholders = data?.stakeholders || [];
  const accounts = data?.accounts || [];
  const campaigns = data?.campaigns || [];

  const results = React.useMemo(() => {
    if (q.trim().length < 2) return [];
    const term = q.toLowerCase();
    const hits = [];
    stakeholders.slice(0, 400).forEach(s => {
      const name = ((s.fields?.['Name'] || '') + ' ' + (s.fields?.['Last name'] || '')).toLowerCase();
      const role = (s.fields?.['Role'] || '').toLowerCase();
      const accName = (s.fields?.['Account']?.[0] || '').toLowerCase();
      if (name.includes(term) || role.includes(term)) hits.push({
        type: 'contact',
        label: ((s.fields?.['Name'] || '') + ' ' + (s.fields?.['Last name'] || '')).trim(),
        sub: s.fields?.['Role'] || '',
        id: s.id,
        record: s,
        nav: 'contacts',
      });
    });
    accounts.slice(0, 400).forEach(a => {
      const name = (a.fields?.['Account Name'] || '').toLowerCase();
      if (name.includes(term)) hits.push({
        type: 'account',
        label: a.fields?.['Account Name'] || '',
        sub: a.fields?.['Industry'] || '',
        id: a.id,
        record: a,
        nav: 'accounts',
      });
    });
    campaigns.slice(0, 100).forEach(c => {
      const name = (c.fields?.['Name'] || '').toLowerCase();
      if (name.includes(term)) hits.push({
        type: 'campaign',
        label: c.fields?.['Name'] || '',
        sub: c.fields?.['Status'] || '',
        id: c.id,
        record: c,
        nav: 'campaigns',
      });
    });
    return hits.slice(0, 12);
  }, [q, stakeholders, accounts, campaigns]);

  const typeIcon = { contact: '👤', account: '🏢', campaign: '📪' };
  const typeColor = { contact: '#60a5fa', account: '#4ade80', campaign: '#fb923c' };

  const handleSelect = (r) => {
    onNavigate(r.nav, r.id, r.record);
    onClose();
  };

  return (
    React.createElement('div', { className: 'modal-overlay', onClick: onClose, style: { zIndex: 2000, alignItems: 'flex-start', paddingTop: '15vh' } },
      React.createElement('div', { className: 'modal', onClick: e => e.stopPropagation(), style: { width: '100%', maxWidth: 520, borderRadius: 14, padding: 0, overflow: 'hidden' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--globant-border)' } },
          React.createElement('span', { style: { fontSize: 16 } }, '🔍'),
          React.createElement('input', { ref: inputRef, value: q, onChange: e => setQ(e.target.value), placeholder: 'Search contacts, accounts, campaigns…', style: { flex: 1, background: 'none', border: 'none', outline: 'none', fontSize: 15, color: 'var(--globant-text)' } }),
          React.createElement('span', { style: { fontSize: 10, color: 'var(--globant-muted)', background: 'rgba(255,255,255,0.06)', padding: '2px 6px', borderRadius: 4 } }, 'ESC')
        ),
        React.createElement('div', { style: { maxHeight: 360, overflowY: 'auto' } },
          q.trim().length < 2 && React.createElement('div', { style: { padding: '20px 16px', color: 'var(--globant-muted)', fontSize: 13, textAlign: 'center' } }, 'Type at least 2 characters…'),
          q.trim().length >= 2 && results.length === 0 && React.createElement('div', { style: { padding: '20px 16px', color: 'var(--globant-muted)', fontSize: 13, textAlign: 'center' } }, 'No results for "' + q + '"'),
          results.map((r, i) =>
            React.createElement('div', {
              key: r.id + i,
              onClick: () => handleSelect(r),
              style: { padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', borderBottom: '1px solid var(--globant-border)' },
              onMouseEnter: e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; },
              onMouseLeave: e => { e.currentTarget.style.background = 'none'; },
            },
              React.createElement('span', { style: { fontSize: 16 } }, typeIcon[r.type]),
              React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                React.createElement('div', { style: { fontWeight: 600, fontSize: 13 } }, r.label),
                r.sub && React.createElement('div', { style: { fontSize: 11, color: 'var(--globant-muted)' } }, r.sub)
              ),
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 } },
                React.createElement('span', { style: { fontSize: 10, color: typeColor[r.type], background: 'rgba(255,255,255,0.05)', padding: '2px 7px', borderRadius: 8 } }, r.type),
                React.createElement('span', { style: { fontSize: 11, color: 'var(--globant-muted)' } }, '→')
              )
            )
          )
        ),
        React.createElement('div', { style: { padding: '8px 16px', borderTop: '1px solid var(--globant-border)', fontSize: 10, color: 'var(--globant-muted)', display: 'flex', gap: 12 } },
          React.createElement('span', null, '↵ open record'),
          React.createElement('span', null, 'ESC close'),
          React.createElement('span', null, '⌘K toggle')
        )
      )
    )
  );
}

// ============ SHORTCUTS MODAL ============

export default GlobalSearchModal;
