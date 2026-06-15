/* global React */
const { useState, useEffect, useCallback, useMemo, useRef } = React;

import {
  AirtableAPI, TABLE_IDS, CURRENT_USER, COMPANY_PROFILE,
  callOpenAI, navSetUrl, SOURCE_OPTIONS, OPP_STAGES, WON_STAGES, CLOSED_STAGES,
  BENCH_REPLY_HIGH, BENCH_REPLY_LOW, BENCH_MEETING_HIGH, BENCH_MEETING_LOW,
  CHANNEL_BENCHMARKS, MESSAGE_PROMPTS, MESSAGE_PROMPT_DEFAULTS, saveMessagePrompts,
  resolvePromptTemplate, saveCompanyProfile, channelIcon, logoutUser,
  CLIENT_CONFIG, AUTH_TOKEN, loadBranding, BRANDING_LS_KEY, loginUser,
} from '../globals.js';
import {
  F, linkedIds, resolveLinked, InfoTip, REPLY_STATUSES, computeEnrichment,
  DIAGNOSIS_CONFIG, findDuplicateStakeholder, confirmDuplicateStakeholder,
  deriveStakeholderStatus, updateStakeholderStatus, STAKEHOLDER_STATUS_PRIORITY,
  STAKEHOLDER_STATUS_PROTECTED, activateAccountIfNeeded,
  formatCurrency, formatDate, strSimilarity, FileNotesRenderer,
} from '../utils.js';


function LoginScreen({ onLogin }) {
  const [mode, setMode] = useState('login'); // 'login' or 'activate'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (mode === 'activate') {
    return <ActivateScreen onBack={() => setMode('login')} />;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) { setError('Enter your email and password'); return; }
    setError('');
    setLoading(true);
    try {
      await loginUser(email.trim(), password);
      onLogin();
    } catch (err) {
      setError(err.message || 'Invalid credentials');
    }
    setLoading(false);
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--globant-darker)' }}>
      <div style={{ width: 380, background: 'var(--globant-card)', border: '1px solid var(--globant-border)', borderRadius: 16, padding: 40, textAlign: 'center' }}>
        <div style={{ width: 56, height: 56, background: '#5BBFB5', borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 24, color: 'var(--globant-dark)', margin: '0 auto 20px' }}>O</div>
        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Welcome to Oike</h2>
        <p style={{ fontSize: 13, color: 'var(--globant-muted)', marginBottom: 28 }}>Sales Intelligence Platform</p>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 14, textAlign: 'left' }}>
            <label style={{ fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6, display: 'block' }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@company.com"
              style={{ width: '100%', padding: '12px 14px', background: 'var(--globant-darker)', border: '1px solid var(--globant-border)', borderRadius: 8, color: 'var(--globant-text)', fontSize: 14, outline: 'none' }}
              autoFocus
            />
          </div>
          <div style={{ marginBottom: 20, textAlign: 'left' }}>
            <label style={{ fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6, display: 'block' }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter your password"
              style={{ width: '100%', padding: '12px 14px', background: 'var(--globant-darker)', border: '1px solid var(--globant-border)', borderRadius: 8, color: 'var(--globant-text)', fontSize: 14, outline: 'none' }}
            />
          </div>

          {error && <div style={{ color: 'var(--globant-danger)', fontSize: 12, marginBottom: 14, padding: '8px 12px', background: 'rgba(248,113,113,0.1)', borderRadius: 8 }}>{error}</div>}

          <button
            type="submit"
            disabled={loading}
            style={{ width: '100%', padding: '13px', background: loading ? 'var(--globant-border)' : 'var(--globant-green)', border: 'none', borderRadius: 8, color: 'var(--globant-dark)', fontSize: 14, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', transition: 'all 0.2s' }}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p style={{ fontSize: 12, color: 'var(--globant-muted)', marginTop: 20, cursor: 'pointer' }} onClick={() => setMode('activate')}>
          Have an invite code? <strong style={{ color: 'var(--globant-green)' }}>Activate account</strong>
        </p>

        <p style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 16 }}>Powered by <strong style={{ color: 'var(--globant-green)' }}>Oike</strong></p>
      </div>
    </div>
  );
}


export default LoginScreen;
