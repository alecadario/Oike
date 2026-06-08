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


function ActivateScreen({ onBack }) {
  const [inviteCode, setInviteCode] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleActivate = async (e) => {
    e.preventDefault();
    if (!inviteCode || !name || !email || !password) { setError('All fields are required'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    if (password !== confirmPw) { setError('Passwords do not match'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteCode: inviteCode.trim(), name: name.trim(), email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Activation failed');
      setSuccess(true);
    } catch (err) {
      setError(err.message || 'Activation failed');
    }
    setLoading(false);
  };

  const inputStyle = { width: '100%', padding: '12px 14px', background: 'var(--globant-darker)', border: '1px solid var(--globant-border)', borderRadius: 8, color: 'var(--globant-text)', fontSize: 14, outline: 'none' };
  const labelStyle = { fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6, display: 'block' };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--globant-darker)' }}>
      <div style={{ width: 400, background: 'var(--globant-card)', border: '1px solid var(--globant-border)', borderRadius: 16, padding: 40, textAlign: 'center' }}>
        <div style={{ width: 56, height: 56, background: '#5BBFB5', borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 24, color: 'var(--globant-dark)', margin: '0 auto 20px' }}>O</div>
        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Activate your account</h2>
        <p style={{ fontSize: 13, color: 'var(--globant-muted)', marginBottom: 24 }}>Enter the invite code you received</p>

        {success ? (
          <div>
            <div style={{ color: 'var(--globant-success)', fontSize: 14, marginBottom: 20, padding: '14px', background: 'rgba(74,222,128,0.1)', borderRadius: 8, fontWeight: 600 }}>Account activated successfully!</div>
            <button onClick={onBack} style={{ width: '100%', padding: '13px', background: 'var(--globant-green)', border: 'none', borderRadius: 8, color: 'var(--globant-dark)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Go to Sign In</button>
          </div>
        ) : (
          <form onSubmit={handleActivate}>
            <div style={{ marginBottom: 12, textAlign: 'left' }}>
              <label style={labelStyle}>Invite Code</label>
              <input type="text" value={inviteCode} onChange={e => setInviteCode(e.target.value)} placeholder="e.g. EMPX-2026-PRO" style={{...inputStyle, fontFamily: 'monospace', letterSpacing: 1}} autoFocus />
            </div>
            <div style={{ marginBottom: 12, textAlign: 'left' }}>
              <label style={labelStyle}>Full Name</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" style={inputStyle} />
            </div>
            <div style={{ marginBottom: 12, textAlign: 'left' }}>
              <label style={labelStyle}>Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" style={inputStyle} />
            </div>
            <div style={{ marginBottom: 12, textAlign: 'left' }}>
              <label style={labelStyle}>Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Min. 6 characters" style={inputStyle} />
            </div>
            <div style={{ marginBottom: 18, textAlign: 'left' }}>
              <label style={labelStyle}>Confirm Password</label>
              <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} placeholder="Repeat your password" style={inputStyle} />
            </div>

            {error && <div style={{ color: 'var(--globant-danger)', fontSize: 12, marginBottom: 14, padding: '8px 12px', background: 'rgba(248,113,113,0.1)', borderRadius: 8 }}>{error}</div>}

            <button type="submit" disabled={loading} style={{ width: '100%', padding: '13px', background: loading ? 'var(--globant-border)' : 'var(--globant-green)', border: 'none', borderRadius: 8, color: 'var(--globant-dark)', fontSize: 14, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer' }}>
              {loading ? 'Activating...' : 'Activate Account'}
            </button>
          </form>
        )}

        <p style={{ fontSize: 12, color: 'var(--globant-muted)', marginTop: 20, cursor: 'pointer' }} onClick={onBack}>
          Already have an account? <strong style={{ color: 'var(--globant-green)' }}>Sign in</strong>
        </p>
      </div>
    </div>
  );
}

// ============ LOGIN SCREEN ============

export default ActivateScreen;
