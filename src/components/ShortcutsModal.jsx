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


function ShortcutsModal({ onClose }) {
  const shortcuts = [
    { key: '⌘K', desc: 'Global search' },
    { key: '?', desc: 'Show this panel' },
    { key: 'ESC', desc: 'Close modal / panel' },
  ];
  return (
    React.createElement('div', { className: 'modal-overlay', onClick: onClose, style: { zIndex: 2000 } },
      React.createElement('div', { className: 'modal', onClick: e => e.stopPropagation(), style: { maxWidth: 360, borderRadius: 14 } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 } },
          React.createElement('h3', { style: { margin: 0, fontSize: 15 } }, '⌨️ Keyboard shortcuts'),
          React.createElement('button', { onClick: onClose, style: { background: 'none', border: 'none', color: 'var(--globant-muted)', fontSize: 18, cursor: 'pointer' } }, '×')
        ),
        shortcuts.map(s =>
          React.createElement('div', { key: s.key, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--globant-border)' } },
            React.createElement('span', { style: { fontSize: 13, color: 'var(--globant-muted)' } }, s.desc),
            React.createElement('kbd', { style: { fontSize: 11, background: 'rgba(255,255,255,0.08)', border: '1px solid var(--globant-border)', borderRadius: 5, padding: '2px 8px', fontFamily: 'monospace' } }, s.key)
          )
        )
      )
    )
  );
}

// ============ FEEDBACK MODAL ============

export default ShortcutsModal;
