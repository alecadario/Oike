/* global React */
const { useState, useMemo } = React;

import { TABLE_IDS } from './globals.js';

// ============ HELPERS ============
export const F = (record, fieldName) => {
  const val = record?.fields?.[fieldName];
  if (!val) return '';
  // Handle aiText objects with .value property
  if (typeof val === 'object' && val.value !== undefined) return val.value;
  // Handle singleSelect objects with .name property
  if (typeof val === 'object' && !Array.isArray(val) && val.name) return val.name;
  // Handle arrays of objects (multipleSelects, linked records)
  if (Array.isArray(val)) {
    return val.map(v => typeof v === 'object' ? (v.name || v.id || v) : v);
  }
  return val;
};

export const linkedIds = (record, fieldName) => {
  const val = record?.fields?.[fieldName];
  if (!val || !Array.isArray(val)) return [];
  return val.map(v => typeof v === 'object' ? (v.id || v) : v);
};

export const resolveLinked = (record, fieldName, lookupArr, nameField) => {
  const ids = linkedIds(record, fieldName);
  if (!ids.length || !lookupArr) return [];
  return ids.map(id => {
    const found = lookupArr.find(r => r.id === id);
    return found ? (F(found, nameField) || id) : id;
  });
};

// Small info tooltip icon — use: <InfoTip text="What to enter here" />
export const InfoTip = ({ text }) => (
  <span className="info-tip">ⓘ<span className="info-tip-text">{text}</span></span>
);

// ── Data Enrichment ─────────────────────────────────────────────────────────
export const REPLY_STATUSES = new Set(['Replied','Received','Meeting Booked','Meeting Confirmed','Interested','Positive Reply']);

export const computeEnrichment = (results) => {
  const outreach = results.outreach || [];
  const accounts = results.accounts || [];
  const proposals = results.proposals || [];
  const opportunities = results.opportunities || [];
  const campaigns = results.campaigns || [];

  // Build outreach index per stakeholder for O(1) lookup
  const outreachByStakeholder = {};
  outreach.forEach(o => {
    linkedIds(o, 'Stakeholder').forEach(id => {
      if (!outreachByStakeholder[id]) outreachByStakeholder[id] = [];
      outreachByStakeholder[id].push(o);
    });
  });

  // ── Enrich stakeholders ──
  const enrichedStakeholders = (results.stakeholders || []).map(s => {
    const sOut = (outreachByStakeholder[s.id] || [])
      .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
    const lastDate = sOut.length > 0 ? new Date(sOut[0].fields?.['Date'] || 0) : null;
    const now = Date.now();
    const daysSince = lastDate ? Math.floor((now - lastDate) / 86400000) : null;
    const replies = sOut.filter(o => REPLY_STATUSES.has(F(o, 'Status')));
    const replyRate = sOut.length > 0 ? replies.length / sOut.length : 0;
    const lastChannel = sOut.length > 0 ? (F(sOut[0], 'Channel') || null) : null;
    const contactedToday = lastDate ? new Date(lastDate).toDateString() === new Date().toDateString() : false;

    // Focus score: multi-factor priority for My Day
    let focusScore = 0;
    let focusTag = null;
    const influence = F(s, 'Level of Influence') || '';

    if (daysSince === null) {
      focusScore += 30; focusTag = 'new';           // Never contacted
    } else if (daysSince >= 3 && daysSince <= 7) {
      focusScore += 55; focusTag = 'urgent';        // Sweet spot follow-up window
    } else if (daysSince > 7 && daysSince <= 21) {
      focusScore += 30; focusTag = 'followup';      // Needs follow-up
    } else if (daysSince > 21 && daysSince <= 45) {
      focusScore += 15; focusTag = 'reengage';      // Going cold
    } else if (daysSince > 45) {
      focusScore += 5;  focusTag = 'reengage';      // Very cold
    }
    if (influence === 'Decision Maker') focusScore += 25;
    else if (influence === 'Champion') focusScore += 15;
    else if (influence === 'Influencer') focusScore += 10;
    if (replies.length > 0) focusScore += 20;       // Has replied before
    if (contactedToday) focusScore = 0;             // Already done today

    return {
      ...s,
      _enriched: {
        totalTouches: sOut.length,
        daysSince,
        lastDate,
        replyRate,
        lastChannel,
        hasReplied: replies.length > 0,
        contactedToday,
        lastOutreach: sOut[0] || null,
        focusScore,
        focusTag,
      }
    };
  });

  // ── Enrich accounts ──
  const enrichedByAccId = {};
  enrichedStakeholders.forEach(s => {
    linkedIds(s, 'Account').forEach(accId => {
      if (!enrichedByAccId[accId]) enrichedByAccId[accId] = [];
      enrichedByAccId[accId].push(s);
    });
  });

  const enrichedAccounts = accounts.map(acc => {
    const accStk = enrichedByAccId[acc.id] || [];
    const contacted = accStk.filter(s => s._enriched.totalTouches > 0);
    const lastDates = contacted.map(s => s._enriched.lastDate).filter(Boolean).sort((a,b) => b - a);
    const lastContactDate = lastDates[0] || null;
    const daysSinceAny = lastContactDate ? Math.floor((Date.now() - lastContactDate) / 86400000) : null;
    const hasActiveProposal = proposals.some(p => linkedIds(p,'Account').includes(acc.id) && !['Closed Lost','Rejected','Declined'].includes(F(p,'Status')));
    const hasWon = opportunities.some(o => linkedIds(o,'Account').includes(acc.id) && ['Won','Closed Won','Active Client'].includes(F(o,'Stage')));
    const inActiveCampaign = campaigns.some(c => linkedIds(c,'Account').includes(acc.id) && F(c,'Status') !== 'Inactive');

    // Account diagnosis
    let diagnosis;
    if (hasWon)                                      diagnosis = 'won';
    else if (hasActiveProposal)                      diagnosis = 'proposal_out';
    else if (contacted.length === 0)                 diagnosis = 'cold_never';
    else if (daysSinceAny !== null && daysSinceAny > 45) diagnosis = 'stale';
    else if (daysSinceAny !== null && daysSinceAny <= 14) diagnosis = 'warm_active';
    else                                             diagnosis = 'cold_no_response';

    return {
      ...acc,
      _enriched: {
        numStakeholders: accStk.length,
        numContacted: contacted.length,
        lastContactDate,
        daysSinceAny,
        hasActiveProposal,
        hasWon,
        inActiveCampaign,
        diagnosis,
      }
    };
  });

  return { ...results, stakeholders: enrichedStakeholders, accounts: enrichedAccounts };
};

// Diagnosis display config
export const DIAGNOSIS_CONFIG = {
  won:             { label: '✅ Active client',   color: '#4ade80', bg: 'rgba(74,222,128,0.12)',  action: 'Expand relationship' },
  proposal_out:    { label: '📋 Proposal out',    color: '#60a5fa', bg: 'rgba(96,165,250,0.12)',  action: 'Follow up on proposal' },
  warm_active:     { label: '🔥 Active',          color: '#fb923c', bg: 'rgba(251,146,60,0.12)',  action: 'Keep momentum' },
  cold_no_response:{ label: '🔄 No response',     color: '#fbbf24', bg: 'rgba(251,191,36,0.12)',  action: 'Try different channel' },
  stale:           { label: '💤 Stale 45d+',      color: '#a78bfa', bg: 'rgba(167,139,250,0.12)', action: 'Re-engage with new angle' },
  cold_never:      { label: '🥶 Not contacted',   color: 'var(--globant-muted)', bg: 'rgba(255,255,255,0.05)', action: 'Start outreach' },
};

// ── Stakeholder duplicate detection ──
export const findDuplicateStakeholder = (fields, existingStakeholders) => {
  if (!Array.isArray(existingStakeholders) || existingStakeholders.length === 0) return null;
  const norm = s => String(s || '').trim().toLowerCase();
  const email = norm(fields['Email']);
  const linkedin = norm(fields['LinkedIn']);
  const firstName = norm(fields['Name']);
  const lastName = norm(fields['Last name']);
  const accountIds = Array.isArray(fields['Account']) ? fields['Account'] : (fields['Account'] ? [fields['Account']] : []);

  for (const s of existingStakeholders) {
    const f = s.fields || {};
    const sEmail = norm(f['Email']);
    const sLinkedin = norm(f['LinkedIn']);
    const sFirstName = norm(f['Name']);
    const sLastName = norm(f['Last name']);
    const sAccountIds = Array.isArray(f['Account']) ? f['Account'] : [];

    if (email && sEmail && email === sEmail) {
      return { match: s, severity: 'hard', reason: 'Email already exists' };
    }
    if (linkedin && sLinkedin && linkedin === sLinkedin) {
      return { match: s, severity: 'hard', reason: 'LinkedIn URL already exists' };
    }
    if (firstName && sFirstName && firstName === sFirstName &&
        lastName && sLastName && lastName === sLastName &&
        accountIds.length > 0 && sAccountIds.some(id => accountIds.includes(id))) {
      return { match: s, severity: 'soft', reason: 'Same name already exists in same account' };
    }
  }
  return null;
};

// Shows a confirm dialog for duplicate. Returns true if user wants to proceed anyway.
export const confirmDuplicateStakeholder = (dup) => {
  if (!dup) return true;
  const m = dup.match;
  const f = m.fields || {};
  const name = `${f['Name'] || ''} ${f['Last name'] || ''}`.trim();
  const email = f['Email'] || '';
  const role = f['Role'] || '';
  const displayName = name || email || 'existing record';
  const subline = [role, email].filter(Boolean).join(' · ');
  const header = dup.severity === 'hard'
    ? `⚠️ Duplicate detected: ${dup.reason}`
    : `⚠️ Possible duplicate: ${dup.reason}`;
  const body = `\n\nExisting contact:\n${displayName}${subline ? `\n${subline}` : ''}\n\nClick OK to create anyway, or Cancel to skip.`;
  return confirm(header + body);
};

// ── Derive stakeholder status from outreach status ──
export const deriveStakeholderStatus = (outreachStatus) => {
  const s = String(outreachStatus || '').toLowerCase();
  if (s.includes('meeting')) return 'Meeting Booked';
  if (s === 'replied' || s === 'received') return 'Replied';
  if (s === 'bounced') return 'Bounced';
  return 'Contacted'; // default for 'Sent', 'Draft', etc.
};

export const STAKEHOLDER_STATUS_PRIORITY = { '': 0, 'Not Contacted': 0, 'Contacted': 1, 'Replied': 2, 'Meeting Booked': 3 };
export const STAKEHOLDER_STATUS_PROTECTED = ['DNC', 'Left Company', 'Not Interested', 'Nurture', 'Bounced'];
export const updateStakeholderStatus = async (apiInstance, stakeholderId, newStatus, allStakeholders) => {
  if (!apiInstance || !stakeholderId || !newStatus || !allStakeholders) return;
  try {
    const stk = allStakeholders.find(s => s.id === stakeholderId);
    if (!stk) return;
    const currentStatus = String(F(stk, 'Status') || '').trim();
    if (STAKEHOLDER_STATUS_PROTECTED.includes(currentStatus)) return;
    const currentPriority = STAKEHOLDER_STATUS_PRIORITY[currentStatus] ?? 0;
    const newPriority = STAKEHOLDER_STATUS_PRIORITY[newStatus] ?? 0;
    if (newPriority > currentPriority) {
      await apiInstance.updateRecord(TABLE_IDS.stakeholders, stakeholderId, { 'Status': newStatus });
    }
  } catch (e) { console.warn('[updateStakeholderStatus] failed:', e); }
};

export const activateAccountIfNeeded = async (apiInstance, accountIds, allAccounts) => {
  if (!apiInstance || !accountIds || !accountIds.length || !allAccounts) return;
  const ACTIVATABLE_STATUSES = ['', 'Prospect', 'Dormant', 'No Status', 'Inactive', 'New'];
  try {
    for (const aid of accountIds) {
      const acc = allAccounts.find(a => a.id === aid);
      if (!acc) continue;
      const currentStatus = String(F(acc, 'Inside Sales Status') || '').trim();
      if (ACTIVATABLE_STATUSES.includes(currentStatus)) {
        await apiInstance.updateRecord(TABLE_IDS.accounts, aid, { 'Inside Sales Status': 'Active' });
      }
    }
  } catch (e) { console.warn('Auto-activate account failed:', e); }
};

export const formatCurrency = (val) => {
  if (!val) return '$0';
  return '$' + Number(val).toLocaleString('en-US');
};

export const formatDate = (val) => {
  if (!val) return '';
  return new Date(val).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export const strSimilarity = (a, b) => {
  if (!a || !b) return 0;
  a = a.toLowerCase().trim(); b = b.toLowerCase().trim();
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const bg = s.slice(i, i+2); m.set(bg, (m.get(bg)||0)+1); } return m; };
  const aB = bigrams(a), bB = bigrams(b);
  let inter = 0;
  aB.forEach((c, k) => { inter += Math.min(c, bB.get(k)||0); });
  return (2 * inter) / (a.length + b.length - 2);
};

// ============ FILE NOTES RENDERER ============
export function FileNotesRenderer({ notes, onUpdateNotes, accentColor = 'var(--globant-info)' }) {
  const [expanded, setExpanded] = useState({});
  const [deletingIdx, setDeletingIdx] = useState(null);

  const parts = useMemo(() => {
    if (!notes) return [];
    const result = [];
    const regex = /📎 FILE:[\s\S]*?(?=\n📎 FILE:|$)/g;
    let lastIdx = 0;
    let m;
    while ((m = regex.exec(notes)) !== null) {
      if (m.index > lastIdx) {
        const t = notes.slice(lastIdx, m.index).trim();
        if (t) result.push({ type: 'text', content: t });
      }
      result.push({ type: 'file', content: m[0].trim() });
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < notes.length) {
      const t = notes.slice(lastIdx).trim();
      if (t) result.push({ type: 'text', content: t });
    }
    return result;
  }, [notes]);

  const deleteBlock = async (block, idx) => {
    const firstLine = block.split('\n')[0];
    if (!window.confirm(`Delete this file?\n\n${firstLine}`)) return;
    setDeletingIdx(idx);
    try {
      let updated = notes.replace(block, '').replace(/\n{3,}/g, '\n\n').trim();
      await onUpdateNotes(updated);
    } catch (e) {
      console.error('Delete file block failed:', e);
      window.__oikeToast('Failed to delete — try again.', 'error');
    } finally {
      setDeletingIdx(null);
    }
  };

  if (parts.length === 0) return null;

  return (
    <div>
      {parts.map((part, i) => {
        if (part.type === 'text') {
          return (
            <div key={i} style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--globant-text)', whiteSpace: 'pre-wrap', marginBottom: 10 }}>
              {part.content}
            </div>
          );
        }
        const lines = part.content.split('\n');
        const header = lines[0];
        const body = lines.slice(1).join('\n').trim();
        const previewLines = body
          .split('\n')
          .map(l => l.trim().replace(/^[-*•]\s*/, '').replace(/\*\*/g, ''))
          .filter(l => l.length > 0)
          .slice(0, 2);
        const preview = previewLines.join(' · ').slice(0, 180);
        const isExpanded = !!expanded[i];
        const isBusy = deletingIdx === i;

        return (
          <div key={i} style={{ padding: '10px 12px', background: 'rgba(96,165,250,0.06)', borderRadius: 8, border: `1px solid ${accentColor === 'var(--globant-info)' ? 'rgba(96,165,250,0.15)' : 'rgba(91,191,181,0.15)'}`, marginBottom: 8, opacity: isBusy ? 0.5 : 1, transition: 'opacity 0.2s' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: preview || isExpanded ? 6 : 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: accentColor, overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{header}</div>
              <button
                onClick={() => deleteBlock(part.content, i)}
                disabled={isBusy}
                title="Delete this file entry"
                style={{ fontSize: 11, padding: '3px 8px', background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 4, cursor: isBusy ? 'wait' : 'pointer', flexShrink: 0 }}>
                {isBusy ? '⏳' : '🗑️ Delete'}
              </button>
            </div>

            {isExpanded ? (
              <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--globant-text)', whiteSpace: 'pre-wrap', marginTop: 4 }}>
                {body || <span style={{ fontStyle: 'italic', color: 'var(--globant-muted)' }}>No extracted content.</span>}
              </div>
            ) : preview ? (
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {preview}
              </div>
            ) : null}

            {body && body.length > 120 && (
              <button
                onClick={() => setExpanded(p => ({ ...p, [i]: !p[i] }))}
                style={{ fontSize: 10, marginTop: 6, background: 'transparent', border: 'none', color: accentColor, cursor: 'pointer', padding: 0, fontWeight: 600 }}>
                {isExpanded ? '▲ Show less' : '▼ Show full content'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
