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


function FeedbackModal({ onClose }) {
  const [text, setText] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState('');

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    setError('');
    try {
      const USERS_BASE  = 'app3plkFpOx28hhmH';
      const USERS_TABLE = 'tblBMyzKhFKmPFX25';
      const userEmail = CURRENT_USER?.email || '';
      const userName  = CURRENT_USER?.name  || '';

      // Create a new row for each feedback submission
      const res = await fetch('/api/airtable', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          method: 'POST',
          baseId: USERS_BASE,
          tableId: USERS_TABLE,
          fields: {
            Name:     userName,
            Email:    userEmail,
            Feedback: text.trim(),
          },
        }),
      });
      if (!res.ok) throw new Error('Save failed');

      setSent(true);
      setTimeout(onClose, 1800);
    } catch (e) {
      setError('Could not save feedback. Try again.');
    }
    setSending(false);
  };
  return (
    React.createElement('div', { className: 'modal-overlay', onClick: onClose, style: { zIndex: 2000 } },
      React.createElement('div', { className: 'modal', onClick: e => e.stopPropagation(), style: { maxWidth: 400, borderRadius: 14 } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 } },
          React.createElement('h3', { style: { margin: 0, fontSize: 15 } }, '💬 Send feedback'),
          React.createElement('button', { onClick: onClose, style: { background: 'none', border: 'none', color: 'var(--globant-muted)', fontSize: 18, cursor: 'pointer' } }, '×')
        ),
        sent
          ? React.createElement('p', { style: { color: '#4ade80', textAlign: 'center', fontSize: 14, margin: 0 } }, '✅ Thanks for your feedback!')
          : React.createElement(React.Fragment, null,
              React.createElement('textarea', { className: 'input-field', rows: 4, value: text, onChange: e => setText(e.target.value), placeholder: "What's working? What's broken? What do you wish existed?", style: { width: '100%', boxSizing: 'border-box', resize: 'vertical', fontSize: 13, marginBottom: 12 } }),
              error && React.createElement('div', { style: { fontSize: 12, color: '#f87171', marginBottom: 8 } }, error),
              React.createElement('button', { className: 'action-btn btn-primary', onClick: send, disabled: sending, style: { width: '100%', padding: '10px', opacity: sending ? 0.6 : 1 } }, sending ? '⏳ Saving…' : '📨 Send feedback')
            )
      )
    )
  );
}

// ============ SHARED EDIT MODAL ============

export default FeedbackModal;
