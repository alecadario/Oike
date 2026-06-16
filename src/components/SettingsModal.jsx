/* global React */
const { useState, useEffect, useCallback, useMemo, useRef } = React;

import {
  AirtableAPI, TABLE_IDS, CURRENT_USER, COMPANY_PROFILE,
  callOpenAI, navSetUrl, SOURCE_OPTIONS, OPP_STAGES, WON_STAGES, CLOSED_STAGES,
  BENCH_REPLY_HIGH, BENCH_REPLY_LOW, BENCH_MEETING_HIGH, BENCH_MEETING_LOW,
  CHANNEL_BENCHMARKS, MESSAGE_PROMPTS, MESSAGE_PROMPT_DEFAULTS, saveMessagePrompts,
  resolvePromptTemplate, saveCompanyProfile, channelIcon, logoutUser,
  CLIENT_CONFIG, AUTH_TOKEN, loadBranding, BRANDING_LS_KEY, ONBOARDING_KEY,
  getAuthHeaders,
} from '../globals.js';
import {
  F, linkedIds, resolveLinked, InfoTip, REPLY_STATUSES, computeEnrichment,
  DIAGNOSIS_CONFIG, findDuplicateStakeholder, confirmDuplicateStakeholder,
  deriveStakeholderStatus, updateStakeholderStatus, STAKEHOLDER_STATUS_PRIORITY,
  STAKEHOLDER_STATUS_PROTECTED, activateAccountIfNeeded,
  formatCurrency, formatDate, strSimilarity, FileNotesRenderer,
} from '../utils.js';


function SettingsModal({ onClose, gmailReturnStatus = '' }) {
  const isAdmin = CURRENT_USER?.role === 'admin';
  const [tab, setTab] = useState(gmailReturnStatus ? 'integrations' : 'profile');
  const [profile, setProfile] = useState({ ...COMPANY_PROFILE });
  const [saved, setSaved] = useState(false);

  // ── Message Prompts state ──
  const [prompts, setPrompts] = useState({ ...MESSAGE_PROMPTS });
  const [promptsSaved, setPromptsSaved] = useState(false);
  const handleSavePrompts = () => {
    saveMessagePrompts(prompts);
    setPromptsSaved(true);
    setTimeout(() => setPromptsSaved(false), 2000);
  };
  const handleResetPrompts = (key) => {
    setPrompts(p => ({ ...p, [key]: MESSAGE_PROMPT_DEFAULTS[key] }));
  };

  // ── Proposal branding ──
  const [branding, setBranding] = useState(() => {
    const b = loadBranding();
    return {
      senderName:     b.senderName     || CLIENT_CONFIG.name || '',
      senderEmail:    b.senderEmail    || CURRENT_USER?.email || '',
      senderLogo:     b.senderLogo     || CLIENT_CONFIG.logo  || '',
      senderLogoUrl:  b.senderLogoUrl  || '',
      senderPhoto:    b.senderPhoto    || '',
      senderPhotoUrl: b.senderPhotoUrl || '',
      senderTitle:    b.senderTitle    || '',
      calendarLink:   b.calendarLink   || '',
      accentColor:    b.accentColor    || '#5BBFB5', // Primary
      secondaryColor: b.secondaryColor || '#A78BFA', // Secondary
      tertiaryColor:  b.tertiaryColor  || '#FBBF24', // Tertiary / highlight
      darkColor:      b.darkColor      || '#0D0D1A', // Dark background
    };
  });
  const [brandingSaved, setBrandingSaved] = useState(false);
  const saveBranding = () => {
    localStorage.setItem(BRANDING_LS_KEY, JSON.stringify(branding));
    setBrandingSaved(true);
    setTimeout(() => setBrandingSaved(false), 2000);
  };

  // ── Gmail integration state ──
  const [gmailConnected, setGmailConnected] = useState(
    gmailReturnStatus === 'connected' || localStorage.getItem('oike_gmail_connected') === 'true'
  );
  const [gmailConnecting, setGmailConnecting] = useState(false);
  const [gmailSyncing, setGmailSyncing] = useState(false);
  const [gmailSyncResult, setGmailSyncResult] = useState(
    gmailReturnStatus === 'error' || gmailReturnStatus === 'denied'
      ? 'Gmail connection failed. Please try again.'
      : ''
  );
  const [gmailDaysBack, setGmailDaysBack] = useState(30);

  const handleConnectGmail = async () => {
    setGmailConnecting(true);
    try {
      const res = await fetch('/api/gmail/auth', {
        method: 'GET',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else setGmailSyncResult('Could not start Gmail connection.');
    } catch (e) {
      setGmailSyncResult('Connection error. Try again.');
    }
    setGmailConnecting(false);
  };

  const handleGmailSync = async () => {
    setGmailSyncing(true);
    setGmailSyncResult('');
    try {
      const res = await fetch('/api/gmail/sync', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          baseId: AIRTABLE_BASE_ID,
          stakeholdersTableId: TABLE_IDS.stakeholders,
          outreachTableId: TABLE_IDS.outreach,
          daysBack: gmailDaysBack,
        }),
      });
      const data = await res.json();
      if (res.ok) setGmailSyncResult(data.message || `${data.synced} email(s) logged.`);
      else setGmailSyncResult(data.error || 'Sync failed.');
    } catch (e) {
      setGmailSyncResult('Sync error. Try again.');
    }
    setGmailSyncing(false);
  };

  const handleSave = () => {
    saveCompanyProfile(profile);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const inputStyle = {
    width: '100%', padding: '8px 10px', background: 'var(--globant-input)',
    border: '1px solid var(--globant-border)', borderRadius: 6,
    color: 'var(--globant-text)', fontSize: 13, boxSizing: 'border-box',
  };
  const labelStyle = { fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', display: 'block' };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 640, width: '95vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexShrink: 0 }}>
          <h3 style={{ margin: 0 }}>⚙️ Settings</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '1px solid var(--globant-border)', paddingBottom: 12, flexShrink: 0 }}>
          {[
            { key: 'profile', label: '🤖 AI Profile' },
            { key: 'prompts', label: '✉️ Prompts' },
            { key: 'proposals', label: '🏷️ Company Info' },
            { key: 'integrations', label: '🔌 Integrations' },
            { key: 'workspace', label: '🏢 Workspace' },
          ].map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              background: tab === t.key ? 'rgba(91,191,181,0.15)' : 'none',
              border: tab === t.key ? '1px solid rgba(91,191,181,0.3)' : '1px solid transparent',
              color: tab === t.key ? 'var(--globant-green)' : 'var(--globant-muted)',
              borderRadius: 6, padding: '6px 14px', fontSize: 12, cursor: 'pointer', fontWeight: 600,
            }}>{t.label}</button>
          ))}
        </div>

        {/* Message Prompts tab */}
        {tab === 'prompts' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20, overflowY: 'auto' }}>
            <div style={{ fontSize: 12, color: 'var(--globant-muted)', background: 'rgba(91,191,181,0.08)', border: '1px solid rgba(91,191,181,0.2)', borderRadius: 8, padding: '10px 14px', lineHeight: 1.6 }}>
              Customize the mission each message type follows. Use <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 4, fontSize: 11 }}>{'{{name}}'}</code>, <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 4, fontSize: 11 }}>{'{{company}}'}</code>, <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 4, fontSize: 11 }}>{'{{touchCount}}'}</code>, <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 4, fontSize: 11 }}>{'{{replyCount}}'}</code>, <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 4, fontSize: 11 }}>{'{{replyState}}'}</code> as placeholders.
            </div>

            {[
              { key: 'first', label: '🟢 First Contact', hint: 'The very first message to a prospect who doesn\'t know you yet.' },
              { key: 'followup', label: '🔵 Follow-up', hint: 'Subsequent touches. Has access to full conversation history + contact pain points.' },
              { key: 'breakup', label: '💀 Breakup', hint: 'Final message after multiple attempts with no response.' },
            ].map(({ key, label, hint }) => (
              <div key={key}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <label style={labelStyle}>{label}</label>
                  <button onClick={() => handleResetPrompts(key)} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}>Reset to default</button>
                </div>
                <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 6 }}>{hint}</div>
                <textarea
                  style={{ ...inputStyle, minHeight: 110, resize: 'vertical', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 }}
                  value={prompts[key]}
                  onChange={e => setPrompts(p => ({ ...p, [key]: e.target.value }))}
                />
              </div>
            ))}

            <button onClick={handleSavePrompts} style={{ padding: '10px 20px', background: 'var(--globant-green)', color: 'var(--globant-dark)', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
              {promptsSaved ? '✅ Saved!' : 'Save Prompts'}
            </button>
          </div>
        )}

        {/* Company Info tab */}
        {tab === 'proposals' && (
          <div style={{ display:'flex', flexDirection:'column', gap:16, overflowY:'auto' }}>
            <div style={{ fontSize:13, color:'var(--globant-muted)' }}>
              Configure once — auto-fills every proposal you generate.
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              <div>
                <label style={labelStyle}>Company name</label>
                <input style={inputStyle} value={branding.senderName} onChange={e=>setBranding(p=>({...p,senderName:e.target.value}))} placeholder="Your Company" />
              </div>
              <div>
                <label style={labelStyle}>Your email</label>
                <input style={inputStyle} value={branding.senderEmail} onChange={e=>setBranding(p=>({...p,senderEmail:e.target.value}))} placeholder="you@company.com" />
              </div>
            </div>

            <div>
              <label style={labelStyle}>Calendar / booking link</label>
              <input style={inputStyle} value={branding.calendarLink} onChange={e=>setBranding(p=>({...p,calendarLink:e.target.value}))} placeholder="https://cal.com/yourname" />
            </div>

            <div>
              <label style={labelStyle}>Logo</label>
              <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                {/* Logo preview */}
                <div style={{ width:80, height:56, borderRadius:8, border:'1px solid var(--globant-border)', background:'var(--globant-darker)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, overflow:'hidden' }}>
                  {branding.senderLogo
                    ? <img src={branding.senderLogo} alt="logo" style={{ maxWidth:72, maxHeight:48, objectFit:'contain' }} onError={e=>{e.target.style.display='none';}} />
                    : <span style={{ fontSize:11, color:'var(--globant-muted)' }}>No logo</span>
                  }
                </div>
                <div style={{ flex:1, display:'flex', flexDirection:'column', gap:8 }}>
                  {/* File upload */}
                  <label style={{ display:'block', cursor:'pointer' }}>
                    <div style={{ padding:'9px 14px', borderRadius:7, border:'1px dashed var(--globant-border)', background:'var(--globant-darker)', fontSize:12, color:'var(--globant-muted)', textAlign:'center', cursor:'pointer' }}>
                      📁 Upload image (PNG, JPG, SVG)
                    </div>
                    <input type="file" accept="image/*" style={{ display:'none' }} onChange={e => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = ev => setBranding(p=>({...p, senderLogo: ev.target.result}));
                      reader.readAsDataURL(file);
                    }} />
                  </label>
                  <input
                    className="input-field"
                    style={{ fontSize:11 }}
                    placeholder="🔗 Public logo URL (required for emails)"
                    value={branding.senderLogoUrl || ''}
                    onChange={e => setBranding(p=>({...p, senderLogoUrl: e.target.value.trim()}))}
                  />
                  <div style={{ fontSize:10, color:'var(--globant-muted)', fontStyle:'italic' }}>Upload = app/proposals. URL = emails.</div>
                  {branding.senderLogo && (
                    <button onClick={() => setBranding(p=>({...p,senderLogo:'',senderLogoUrl:''}))}
                      style={{ fontSize:11, padding:'4px 10px', borderRadius:6, border:'1px solid var(--globant-border)', background:'none', color:'var(--globant-muted)', cursor:'pointer' }}>
                      🗑 Remove logo
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Sender photo (face) — used in Landings, Proposals & Reports near sender signature */}
            <div>
              <label style={labelStyle}>Your photo (face)</label>
              <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                <div style={{ width:72, height:72, borderRadius:'50%', border:'1px solid var(--globant-border)', background:'var(--globant-darker)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, overflow:'hidden' }}>
                  {branding.senderPhoto
                    ? <img src={branding.senderPhoto} alt="you" style={{ width:'100%', height:'100%', objectFit:'cover' }} onError={e=>{e.target.style.display='none';}} />
                    : <span style={{ fontSize:22 }}>👤</span>
                  }
                </div>
                <div style={{ flex:1, display:'flex', flexDirection:'column', gap:8 }}>
                  <label style={{ display:'block', cursor:'pointer' }}>
                    <div style={{ padding:'9px 14px', borderRadius:7, border:'1px dashed var(--globant-border)', background:'var(--globant-darker)', fontSize:12, color:'var(--globant-muted)', textAlign:'center', cursor:'pointer' }}>
                      📸 Upload photo (for app display)
                    </div>
                    <input type="file" accept="image/*" style={{ display:'none' }} onChange={e => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = ev => setBranding(p=>({...p, senderPhoto: ev.target.result}));
                      reader.readAsDataURL(file);
                    }} />
                  </label>
                  <input
                    className="input-field"
                    style={{ fontSize:11 }}
                    placeholder="🔗 Public photo URL (required for emails)"
                    value={branding.senderPhotoUrl || ''}
                    onChange={e => setBranding(p=>({...p, senderPhotoUrl: e.target.value.trim()}))}
                  />
                  <div style={{ fontSize:10, color:'var(--globant-muted)', fontStyle:'italic', lineHeight:1.4 }}>
                    Upload = shown in the app. Public URL = shown in emails (Gmail blocks embedded images).<br/>
                    Get your URL from LinkedIn, Google Drive (share → copy link), or any image host.
                  </div>
                  {branding.senderPhoto && (
                    <button onClick={() => setBranding(p=>({...p,senderPhoto:'',senderPhotoUrl:''}))}
                      style={{ fontSize:11, padding:'4px 10px', borderRadius:6, border:'1px solid var(--globant-border)', background:'none', color:'var(--globant-muted)', cursor:'pointer', alignSelf:'flex-start' }}>
                      🗑 Remove photo
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Sender title / tagline */}
            <div>
              <label style={labelStyle}>Your title / tagline</label>
              <input style={inputStyle} value={branding.senderTitle || ''} onChange={e=>setBranding(p=>({...p,senderTitle:e.target.value}))} placeholder="e.g. Founder · Oike · Sales Intelligence" />
              <div style={{ fontSize:10, color:'var(--globant-muted)', marginTop:4, fontStyle:'italic' }}>Shown below your name, next to your photo.</div>
            </div>

            {/* Color palette — 4 colors */}
            <div>
              <label style={labelStyle}>Color palette (4 colores)</label>
              <div style={{ fontSize:10, color:'var(--globant-muted)', marginBottom:10, fontStyle:'italic' }}>
                Primary = CTA + headers. Secondary = soporte / accents. Tertiary = highlights / badges. Dark = fondos oscuros.
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {/* Presets — 4 colors each */}
                <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                  {[
                    { label:'Oike',     primary:'#5BBFB5', secondary:'#A78BFA', tertiary:'#FBBF24', dark:'#0D0D1A' },
                    { label:'Sunset',   primary:'#F97316', secondary:'#F43F5E', tertiary:'#FBBF24', dark:'#1F1B2E' },
                    { label:'Ocean',    primary:'#06B6D4', secondary:'#3B82F6', tertiary:'#10B981', dark:'#0F172A' },
                    { label:'Forest',   primary:'#10B981', secondary:'#059669', tertiary:'#84CC16', dark:'#0F1F1A' },
                    { label:'Royal',    primary:'#6366F1', secondary:'#8B5CF6', tertiary:'#EC4899', dark:'#0D0D1A' },
                    { label:'Mocha',    primary:'#A16207', secondary:'#C2410C', tertiary:'#FBBF24', dark:'#1C1917' },
                    { label:'Slate',    primary:'#475569', secondary:'#94A3B8', tertiary:'#06B6D4', dark:'#0F172A' },
                    { label:'Mono',     primary:'#1F2937', secondary:'#6B7280', tertiary:'#9CA3AF', dark:'#000000' },
                  ].map(preset => {
                    const isActive = branding.accentColor === preset.primary && branding.darkColor === preset.dark
                      && branding.secondaryColor === preset.secondary && branding.tertiaryColor === preset.tertiary;
                    return (
                      <button key={preset.label} onClick={() => setBranding(p=>({...p,
                        accentColor: preset.primary,
                        secondaryColor: preset.secondary,
                        tertiaryColor: preset.tertiary,
                        darkColor: preset.dark
                      }))}
                        title={preset.label}
                        style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:6, padding:'8px 10px', borderRadius:8, border:'1px solid', cursor:'pointer',
                          borderColor: isActive ? preset.primary : 'var(--globant-border)',
                          background: isActive ? 'rgba(255,255,255,0.06)' : 'var(--globant-darker)',
                        }}>
                        <div style={{ display:'flex', gap:2 }}>
                          <div style={{ width:14, height:24, borderRadius:'4px 0 0 4px', background:preset.primary }} />
                          <div style={{ width:14, height:24, background:preset.secondary }} />
                          <div style={{ width:14, height:24, background:preset.tertiary }} />
                          <div style={{ width:14, height:24, borderRadius:'0 4px 4px 0', background:preset.dark }} />
                        </div>
                        <span style={{ fontSize:9, color: isActive ? preset.primary : 'var(--globant-muted)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.3px' }}>{preset.label}</span>
                      </button>
                    );
                  })}
                </div>
                {/* 4 Custom pickers in 2x2 grid */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  {[
                    { key:'accentColor',    label:'PRIMARY',   default:'#5BBFB5', sub:'CTAs · Headers · Borders' },
                    { key:'secondaryColor', label:'SECONDARY', default:'#A78BFA', sub:'Accents · Sub-buttons' },
                    { key:'tertiaryColor',  label:'TERTIARY',  default:'#FBBF24', sub:'Highlights · Badges' },
                    { key:'darkColor',      label:'DARK',      default:'#0D0D1A', sub:'Backgrounds · Hero' },
                  ].map(c => (
                    <div key={c.key}>
                      <label style={{ fontSize:10, color:'var(--globant-muted)', display:'block', marginBottom:4, fontWeight:700 }}>{c.label}</label>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <input type="color" value={branding[c.key] || c.default}
                          onChange={e => setBranding(p=>({...p, [c.key]: e.target.value}))}
                          style={{ width:36, height:36, borderRadius:6, border:'none', cursor:'pointer', padding:2, background:'var(--globant-darker)', flexShrink:0 }} />
                        <input style={{ ...inputStyle, fontFamily:'monospace', fontSize:11, flex:1, padding:'8px 8px' }}
                          value={branding[c.key] || c.default}
                          onChange={e => setBranding(p=>({...p, [c.key]: e.target.value}))}
                          placeholder={c.default} />
                      </div>
                      <div style={{ fontSize:9, color:'var(--globant-muted)', marginTop:3, fontStyle:'italic' }}>{c.sub}</div>
                    </div>
                  ))}
                </div>
                {/* Live preview strip with all 4 colors */}
                <div style={{ borderRadius:8, overflow:'hidden', border:'1px solid var(--globant-border)', display:'flex', height:48 }}>
                  <div style={{ flex:2, background: branding.darkColor || '#0D0D1A', display:'flex', alignItems:'center', paddingLeft:14 }}>
                    <span style={{ fontSize:12, fontWeight:800, color: branding.accentColor || '#5BBFB5' }}>Hero</span>
                  </div>
                  <div style={{ flex:1, background: branding.accentColor || '#5BBFB5', display:'flex', alignItems:'center', justifyContent:'center' }}>
                    <span style={{ fontSize:11, fontWeight:800, color: branding.darkColor || '#0D0D1A' }}>CTA</span>
                  </div>
                  <div style={{ flex:1, background: branding.secondaryColor || '#A78BFA', display:'flex', alignItems:'center', justifyContent:'center' }}>
                    <span style={{ fontSize:11, fontWeight:800, color: '#fff' }}>2nd</span>
                  </div>
                  <div style={{ flex:1, background: branding.tertiaryColor || '#FBBF24', display:'flex', alignItems:'center', justifyContent:'center' }}>
                    <span style={{ fontSize:11, fontWeight:800, color: branding.darkColor || '#0D0D1A' }}>★</span>
                  </div>
                </div>
              </div>
            </div>

            <button className="action-btn btn-primary" style={{ padding:'11px', fontWeight:700 }} onClick={saveBranding}>
              {brandingSaved ? '✅ Saved!' : '💾 Save'}
            </button>
          </div>
        )}

        {/* Integrations tab */}
        {tab === 'integrations' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Gmail card */}
            <div style={{ background: 'var(--globant-darker)', borderRadius: 10, padding: '18px 20px', border: '1px solid rgba(255,255,255,0.07)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                <span style={{ fontSize: 26 }}>📧</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>Gmail</div>
                  <div style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Auto-log emails to/from your contacts</div>
                </div>
                <div style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: gmailConnected ? '#4ade80' : 'var(--globant-muted)' }}>
                  {gmailConnected ? '● Connected' : '○ Not connected'}
                </div>
              </div>

              {!gmailConnected ? (
                <button className="action-btn btn-primary" style={{ width: '100%', padding: '10px' }} onClick={handleConnectGmail} disabled={gmailConnecting}>
                  {gmailConnecting ? 'Redirecting to Google...' : '🔗 Connect Gmail'}
                </button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <label style={{ fontSize: 12, color: 'var(--globant-muted)', whiteSpace: 'nowrap' }}>Sync last</label>
                    <select value={gmailDaysBack} onChange={e => setGmailDaysBack(Number(e.target.value))}
                      style={{ background: 'var(--globant-input)', border: '1px solid var(--globant-border)', borderRadius: 6, color: 'var(--globant-text)', padding: '6px 10px', fontSize: 12 }}>
                      <option value={3}>3 days</option>
                      <option value={7}>7 days</option>
                      <option value={14}>14 days</option>
                      <option value={30}>30 days</option>
                    </select>
                    <button className="action-btn btn-primary" style={{ flex: 1, padding: '8px' }} onClick={handleGmailSync} disabled={gmailSyncing}>
                      {gmailSyncing ? '⏳ Syncing...' : '🔄 Sync now'}
                    </button>
                  </div>
                  <button className="action-btn" style={{ width: '100%', padding: '8px', fontSize: 12 }} onClick={handleConnectGmail}>
                    Reconnect Gmail
                  </button>
                </div>
              )}

              {gmailSyncResult && (
                <div style={{ marginTop: 10, fontSize: 12, color: gmailSyncResult.toLowerCase().includes('fail') || gmailSyncResult.toLowerCase().includes('error') ? '#f87171' : '#4ade80', background: 'rgba(255,255,255,0.04)', borderRadius: 6, padding: '8px 12px' }}>
                  {gmailSyncResult}
                </div>
              )}

              <div style={{ marginTop: 12, fontSize: 11, color: 'var(--globant-muted)', lineHeight: 1.5 }}>
                Oike reads emails to/from contacts already in your CRM and logs them automatically as activities. Read-only access — Oike never sends emails on your behalf.
              </div>
            </div>

            {/* Reset onboarding */}
            <div style={{ background: 'var(--globant-darker)', borderRadius: 10, padding: '16px 20px', border: '1px solid rgba(255,255,255,0.07)' }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>🚀 Onboarding</div>
              <div style={{ fontSize: 12, color: 'var(--globant-muted)', marginBottom: 10 }}>Restart the setup wizard — useful before a demo.</div>
              <button className="action-btn" style={{ padding: '8px 16px', fontSize: 12 }} onClick={() => {
                localStorage.removeItem(ONBOARDING_KEY);
                onClose();
                window.location.reload();
              }}>Reset onboarding tour</button>
            </div>

          </div>
        )}

        {/* Workspace tab */}
        {tab === 'workspace' && (
          <div>
            <div style={{ padding: '12px', background: 'var(--globant-darker)', borderRadius: 8, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase' }}>Workspace</div>
              <div style={{ fontSize: 14, color: 'var(--globant-text)', fontWeight: 600 }}>{CLIENT_CONFIG.name || 'Oike'}</div>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 4 }}>Plan: {CLIENT_CONFIG.plan || 'standard'}</div>
            </div>
            <div style={{ padding: '12px', background: 'var(--globant-darker)', borderRadius: 8, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase' }}>Services</div>
              <div style={{ fontSize: 12, color: 'var(--globant-green)', marginBottom: 4 }}>✅ Database connected</div>
              <div style={{ fontSize: 12, color: 'var(--globant-green)' }}>✅ AI engine active</div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', textAlign: 'center', marginTop: 16 }}>
              Powered by <strong style={{ color: 'var(--globant-green)' }}>Oike</strong> · Sales Intelligence Platform
            </div>
          </div>
        )}

        {/* AI Profile tab */}
        {tab === 'profile' && (
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <div style={{ overflowY: 'auto', flex: 1, paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--globant-muted)', background: 'rgba(91,191,181,0.08)', border: '1px solid rgba(91,191,181,0.2)', borderRadius: 8, padding: '10px 14px', lineHeight: 1.6 }}>
              These values are injected into all AI prompts. Set them to match your company — every client gets their own AI context.
            </div>

            <div>
              <label style={labelStyle}>Company Name</label>
              <input style={inputStyle} value={profile.companyName} onChange={e => setProfile(p => ({ ...p, companyName: e.target.value }))} placeholder="e.g. Globant" />
            </div>

            <div>
              <label style={labelStyle}>Services / Capabilities</label>
              <input style={inputStyle} value={profile.services} onChange={e => setProfile(p => ({ ...p, services: e.target.value }))} placeholder="e.g. digital transformation, AI, CX, data" />
              <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 3 }}>Short comma-separated list used in AI prompts</div>
            </div>

            <div>
              <label style={labelStyle}>Target Market / Region</label>
              <input style={inputStyle} value={profile.market} onChange={e => setProfile(p => ({ ...p, market: e.target.value }))} placeholder="e.g. MENA, KSA &amp; UAE" />
            </div>

            <div>
              <label style={labelStyle}>Sender Name</label>
              <input style={inputStyle} value={profile.senderName} onChange={e => setProfile(p => ({ ...p, senderName: e.target.value }))} placeholder="e.g. Alejandra Cadario" />
              <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 3 }}>Name used in message sign-offs and AI context</div>
            </div>

            <div>
              <label style={labelStyle}>Sender Title</label>
              <input style={inputStyle} value={profile.senderTitle} onChange={e => setProfile(p => ({ ...p, senderTitle: e.target.value }))} placeholder="e.g. Business Consultant" />
            </div>

            <div>
              <label style={labelStyle}>Company Goals / Extra Context (optional)</label>
              <textarea style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} value={profile.goals} onChange={e => setProfile(p => ({ ...p, goals: e.target.value }))} placeholder="e.g. Expand into healthcare and government sectors. Focus on AI and data analytics offerings." />
              <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 3 }}>Added to AI prompts as extra strategic context</div>
            </div>

            {/* Voice & Tone section */}
            <div style={{ borderTop: '1px solid var(--globant-border)', paddingTop: 14, marginTop: 2 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--globant-green)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                ✍️ Voice & Tone
                <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--globant-muted)' }}>— how the AI should sound when writing your messages</span>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>Tone / Personality</label>
                <input style={inputStyle} value={profile.voiceTone || ''} onChange={e => setProfile(p => ({ ...p, voiceTone: e.target.value }))}
                  placeholder="e.g. direct, warm, confident, no fluff, slight humor" />
                <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 3 }}>Adjectives that describe how you communicate</div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>What to NEVER do</label>
                <input style={inputStyle} value={profile.voiceAvoid || ''} onChange={e => setProfile(p => ({ ...p, voiceAvoid: e.target.value }))}
                  placeholder="e.g. never use 'I hope this finds you well', no emojis, no bullet points in messages" />
                <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 3 }}>Hard rules — the AI will never break these</div>
              </div>

              <div>
                <label style={labelStyle}>Example phrase (optional)</label>
                <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} value={profile.voiceExample || ''} onChange={e => setProfile(p => ({ ...p, voiceExample: e.target.value }))}
                  placeholder="Paste a real message or sentence you wrote. The AI will calibrate its style to match yours." />
                <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 3 }}>The closer to your real voice, the better the output</div>
              </div>
            </div>

            </div>
            {/* Save button — fixed at bottom */}
            <div style={{ flexShrink: 0, paddingTop: 12, borderTop: '1px solid var(--globant-border)', marginTop: 4 }}>
              <button
                className="action-btn btn-primary"
                style={{ padding: '10px 0', width: '100%', fontSize: 13 }}
                onClick={handleSave}
              >
                {saved ? '✅ Saved!' : '💾 Save AI Profile'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default SettingsModal;
