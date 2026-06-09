/* global React */
const { useState, useEffect, useCallback, useMemo, useRef } = React;

import {
  AirtableAPI, TABLE_IDS, CURRENT_USER, COMPANY_PROFILE,
  callOpenAI, navSetUrl, SOURCE_OPTIONS, OPP_STAGES, WON_STAGES, CLOSED_STAGES,
  BENCH_REPLY_HIGH, BENCH_REPLY_LOW, BENCH_MEETING_HIGH, BENCH_MEETING_LOW,
  CHANNEL_BENCHMARKS, MESSAGE_PROMPTS, MESSAGE_PROMPT_DEFAULTS, saveMessagePrompts,
  resolvePromptTemplate, saveCompanyProfile, channelIcon, logoutUser,
  CLIENT_CONFIG, AUTH_TOKEN, loadBranding, BRANDING_LS_KEY, ONBOARDING_KEY,
} from '../globals.js';
import {
  F, linkedIds, resolveLinked, InfoTip, REPLY_STATUSES, computeEnrichment,
  DIAGNOSIS_CONFIG, findDuplicateStakeholder, confirmDuplicateStakeholder,
  deriveStakeholderStatus, updateStakeholderStatus, STAKEHOLDER_STATUS_PRIORITY,
  STAKEHOLDER_STATUS_PROTECTED, activateAccountIfNeeded,
  formatCurrency, formatDate, strSimilarity, FileNotesRenderer,
} from '../utils.js';


function OnboardingWizard({ api, onComplete }) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  // Step 0 — Company Profile
  const [profile, setProfile] = useState({
    companyName: COMPANY_PROFILE.companyName !== 'Your Company' ? COMPANY_PROFILE.companyName : '',
    senderName:  COMPANY_PROFILE.senderName  !== 'Your Name'    ? COMPANY_PROFILE.senderName  : '',
    senderTitle: COMPANY_PROFILE.senderTitle !== 'Business Consultant' ? COMPANY_PROFILE.senderTitle : '',
    services:    COMPANY_PROFILE.services    !== 'digital transformation, AI, CX, data' ? COMPANY_PROFILE.services : '',
    market:      COMPANY_PROFILE.market      !== 'your target market' ? COMPANY_PROFILE.market : '',
  });

  // Step 1 — First Account
  const [account, setAccount] = useState({ name: '', industry: '', website: '' });
  const [createdAccountId, setCreatedAccountId] = useState(null);

  // Step 2 — First Contact
  const [contact, setContact] = useState({ firstName: '', lastName: '', role: '', linkedin: '' });

  const INDUSTRIES = ['Technology','Consulting','Real Estate','Financial Services','Healthcare','Retail','Manufacturing','Education','Government','Other'];

  const iStyle = { width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '10px 13px', color: 'var(--globant-text)', fontSize: 13, boxSizing: 'border-box', marginBottom: 12 };
  const lStyle = { fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, display: 'block', textTransform: 'uppercase', letterSpacing: '0.06em' };

  const steps = [
    { icon: '🏢', title: 'Your Company', subtitle: 'This tells the AI who you are so every message sounds like you.' },
    { icon: '🎯', title: 'First Target Account', subtitle: 'Add the first company you want to reach out to.' },
    { icon: '👤', title: 'First Contact', subtitle: 'Who are you trying to reach at that company?' },
    { icon: '🚀', title: "You're ready!", subtitle: 'Oike is set up. Let\'s generate your first message.' },
  ];

  const handleProfileNext = () => {
    if (!profile.companyName.trim() || !profile.senderName.trim()) return window.__oikeToast('Company name and your name are required.', 'warning');
    saveCompanyProfile({
      companyName: profile.companyName,
      senderName:  profile.senderName,
      senderTitle: profile.senderTitle,
      services:    profile.services,
      market:      profile.market,
    });
    setStep(1);
  };

  const handleAccountNext = async () => {
    if (!account.name.trim()) return window.__oikeToast('Account name is required.', 'warning');
    setSaving(true);
    try {
      const fields = { 'Account Name': account.name.trim() };
      if (account.industry) fields['Industry'] = account.industry;
      if (account.website)  fields['Website']  = account.website.trim();
      const rec = await api.createRecord(TABLE_IDS.accounts, fields);
      setCreatedAccountId(rec.id);
      setStep(2);
    } catch (e) {
      window.__oikeToast('Could not create account. Try again.', 'error');
    }
    setSaving(false);
  };

  const handleContactNext = async () => {
    if (!contact.firstName.trim()) return window.__oikeToast('First name is required.', 'warning');
    setSaving(true);
    try {
      const fields = { 'Name': contact.firstName.trim() };
      if (contact.lastName)  fields['Last name'] = contact.lastName.trim();
      if (contact.role)      fields['Role']      = contact.role.trim();
      if (contact.linkedin)  fields['LinkedIn']  = contact.linkedin.trim();
      if (createdAccountId)  fields['Account']   = [createdAccountId];
      await api.createRecord(TABLE_IDS.stakeholders, fields);
      setStep(3);
    } catch (e) {
      window.__oikeToast('Could not create contact. Try again.', 'error');
    }
    setSaving(false);
  };

  const handleFinish = () => {
    try { localStorage.setItem(ONBOARDING_KEY, 'true'); } catch {}
    onComplete();
  };

  const cur = steps[step];

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--globant-card)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: '36px 32px', width: '100%', maxWidth: 480, boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }}>

        {/* Progress dots */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 28 }}>
          {steps.map((_, i) => (
            <div key={i} style={{ flex: 1, height: 3, borderRadius: 99, background: i <= step ? '#BFD730' : 'rgba(255,255,255,0.1)', transition: 'background 0.3s' }} />
          ))}
        </div>

        <div style={{ fontSize: 32, marginBottom: 10 }}>{cur.icon}</div>
        <h2 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 700 }}>{cur.title}</h2>
        <p style={{ margin: '0 0 24px', color: 'var(--globant-muted)', fontSize: 13 }}>{cur.subtitle}</p>

        {/* Step 0 — Company Profile */}
        {step === 0 && (
          <div>
            <label style={lStyle}>Your name *</label>
            <input style={iStyle} placeholder="Ale Cadario" value={profile.senderName} onChange={e => setProfile(p => ({...p, senderName: e.target.value}))} />
            <label style={lStyle}>Your title</label>
            <input style={iStyle} placeholder="Sales Manager" value={profile.senderTitle} onChange={e => setProfile(p => ({...p, senderTitle: e.target.value}))} />
            <label style={lStyle}>Company name *</label>
            <input style={iStyle} placeholder="Oike / Globant / ..." value={profile.companyName} onChange={e => setProfile(p => ({...p, companyName: e.target.value}))} />
            <label style={lStyle}>Services / product (brief)</label>
            <input style={iStyle} placeholder="B2B sales intelligence platform..." value={profile.services} onChange={e => setProfile(p => ({...p, services: e.target.value}))} />
            <label style={lStyle}>Target market</label>
            <input style={iStyle} placeholder="B2B companies with sales teams..." value={profile.market} onChange={e => setProfile(p => ({...p, market: e.target.value}))} />
            <button className="action-btn btn-primary" style={{ width: '100%', padding: '12px', marginTop: 4 }} onClick={handleProfileNext}>Continue →</button>
          </div>
        )}

        {/* Step 1 — First Account */}
        {step === 1 && (
          <div>
            <label style={lStyle}>Company name *</label>
            <input style={iStyle} placeholder="Acme Corp" value={account.name} onChange={e => setAccount(a => ({...a, name: e.target.value}))} />
            <label style={lStyle}>Industry</label>
            <select style={iStyle} value={account.industry} onChange={e => setAccount(a => ({...a, industry: e.target.value}))}>
              <option value="">Select industry...</option>
              {INDUSTRIES.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
            <label style={lStyle}>Website</label>
            <input style={iStyle} placeholder="https://acme.com" value={account.website} onChange={e => setAccount(a => ({...a, website: e.target.value}))} />
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button className="action-btn" style={{ flex: 1, padding: '11px' }} onClick={() => setStep(0)}>{String.fromCharCode(8592)} Back</button>
              <button className="action-btn btn-primary" style={{ flex: 2, padding: '11px' }} onClick={handleAccountNext} disabled={saving}>{saving ? 'Saving...' : 'Continue →'}</button>
            </div>
          </div>
        )}

        {/* Step 2 — First Contact */}
        {step === 2 && (
          <div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={lStyle}>First name *</label>
                <input style={iStyle} placeholder="Mar\uEDa" value={contact.firstName} onChange={e => setContact(c => ({...c, firstName: e.target.value}))} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lStyle}>Last name</label>
                <input style={iStyle} placeholder="Garc\uEDa" value={contact.lastName} onChange={e => setContact(c => ({...c, lastName: e.target.value}))} />
              </div>
            </div>
            <label style={lStyle}>Role / Title</label>
            <input style={iStyle} placeholder="CEO / VP Sales / Director..." value={contact.role} onChange={e => setContact(c => ({...c, role: e.target.value}))} />
            <label style={lStyle}>LinkedIn URL</label>
            <input style={iStyle} placeholder="https://linkedin.com/in/..." value={contact.linkedin} onChange={e => setContact(c => ({...c, linkedin: e.target.value}))} />
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button className="action-btn" style={{ flex: 1, padding: '11px' }} onClick={() => setStep(1)}>{String.fromCharCode(8592)} Back</button>
              <button className="action-btn btn-primary" style={{ flex: 2, padding: '11px' }} onClick={handleContactNext} disabled={saving}>{saving ? 'Saving...' : 'Continue →'}</button>
            </div>
          </div>
        )}

        {/* Step 3 — Done */}
        {step === 3 && (
          <div style={{ textAlign: 'center' }}>
            <p style={{ color: 'var(--globant-muted)', fontSize: 13, marginBottom: 28, lineHeight: 1.6 }}>
              Your company profile is set, your first account and contact are in. Go to <strong>Accounts</strong> to open the account, find your contact, and generate your first message with the AI Generator.
            </p>
            <button className="action-btn btn-primary" style={{ width: '100%', padding: '13px', fontSize: 15 }} onClick={handleFinish}>
              Go to Oike →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ============ MAIN APP ============

export default OnboardingWizard;
