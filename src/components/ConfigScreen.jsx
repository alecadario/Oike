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


function ConfigScreen({ onConnect }) {
  const [key, setKey] = useState(localStorage?.getItem?.('at_key') || '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleConnect = async () => {
    if (!key.trim()) return;
    setLoading(true);
    setError('');
    try {
      const api = new AirtableAPI(key.trim());
      await api.fetchTable(TABLE_IDS.accounts);
      try { localStorage.setItem('at_key', key.trim()); } catch(e) {}
      onConnect(key.trim());
    } catch (e) {
      setError('Could not connect. Check your API key.');
    }
    setLoading(false);
  };

  return (
    <div className="config-screen">
      <div className="config-box">
        <div className="logo-big">G</div>
        <h2 style={{ marginBottom: 8 }}>Sales Intelligence Hub</h2>
        <p style={{ color: 'var(--globant-muted)', fontSize: 13, marginBottom: 24 }}>
          Connect your Airtable to get started
        </p>
        <input
          className="input-field"
          type="password"
          placeholder="Paste your Airtable Personal Access Token"
          value={key}
          onChange={e => setKey(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleConnect()}
          style={{ marginBottom: 12 }}
        />
        {error && <p style={{ color: 'var(--globant-danger)', fontSize: 12, marginBottom: 12 }}>{error}</p>}
        <button className="action-btn btn-primary" style={{ width: '100%', padding: '12px', fontSize: 14 }} onClick={handleConnect} disabled={loading}>
          {loading ? 'Connecting...' : 'Connect'}
        </button>
        <p style={{ color: 'var(--globant-muted)', fontSize: 11, marginTop: 16 }}>
          Your key stays in your browser. Get one at airtable.com/create/tokens
        </p>
      </div>
    </div>
  );
}

// ============ STRATEGY OVERVIEW ============

export default ConfigScreen;
