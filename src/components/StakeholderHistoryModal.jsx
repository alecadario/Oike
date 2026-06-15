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


function StakeholderHistoryModal({ stakeholder, outreach, accounts, onClose, onRefresh, allData, onNavigateToAccount, onSend, onAddRecord }) {
  if (!stakeholder) return null;
  const [genLoading, setGenLoading] = useState(''); // 'pain' | 'linkedin' | ''
  const PAIN_TS_LS_KEY = 'oike_pain_timestamps';
  const PAIN_CACHE_KEY = `oike_pain_content_${stakeholder.id}`;
  const LINKEDIN_CACHE_KEY = `oike_linkedin_content_${stakeholder.id}`;
  const [localPain, setLocalPain] = useState(
    localStorage.getItem(PAIN_CACHE_KEY) ||
    F(stakeholder, 'Pain Points (Generated)') || F(stakeholder, 'Pain points') || '');
  const [localPainTs, setLocalPainTs] = useState(() => {
    try { return JSON.parse(localStorage.getItem(PAIN_TS_LS_KEY) || '{}')[stakeholder.id] || null; } catch { return null; }
  });
  const [localLinkedin, setLocalLinkedin] = useState(
    localStorage.getItem(LINKEDIN_CACHE_KEY) ||
    F(stakeholder, 'LinkedIn News (Generated)') || F(stakeholder, 'Linkedin lates news') || '');
  const [quickAction, setQuickAction] = useState(''); // 'bounced' | 'reply' | 'meeting' | 'notinterested' | ''
  const [quickReplyChannel, setQuickReplyChannel] = useState('Email');
  const [quickNote, setQuickNote] = useState('');
  const [quickDate, setQuickDate] = useState('');
  const [savingQuick, setSavingQuick] = useState(false);
  const [quickMsg, setQuickMsg] = useState('');
  const [quickMsgChannel, setQuickMsgChannel] = useState('LinkedIn');
  const [sendingQuickMsg, setSendingQuickMsg] = useState(false);
  const [showAIGenerator, setShowAIGenerator] = useState(false);
  const [enrichLoading, setEnrichLoading] = useState(false);
  // Gmail panel state
  const [showGmailPanel, setShowGmailPanel] = useState(false);
  const [gmailMsgs, setGmailMsgs] = useState([]);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [selectedGmailMsg, setSelectedGmailMsg] = useState(null);
  const [gmailMsgLoading, setGmailMsgLoading] = useState(false);
  const gmailConnected = localStorage.getItem('oike_gmail_connected') === 'true';
  const stkEmail = F(stakeholder, 'Email') || '';

  const loadGmailMsgs = async () => {
    if (!stkEmail) return;
    setGmailLoading(true);
    setGmailMsgs([]);
    setSelectedGmailMsg(null);
    try {
      const res = await fetch('/api/gmail/messages?contactEmail=' + encodeURIComponent(stkEmail), { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.gmailNotConnected) { window.__oikeToast('Gmail no conectado — conectalo en Settings', 'warning'); setShowGmailPanel(false); return; }
      setGmailMsgs(data.messages || []);
    } catch (e) { window.__oikeToast('Error cargando emails', 'error'); }
    setGmailLoading(false);
  };

  const loadGmailMsg = async (id) => {
    setGmailMsgLoading(true);
    try {
      const res = await fetch('/api/gmail/messages?messageId=' + encodeURIComponent(id), { headers: getAuthHeaders() });
      const data = await res.json();
      setSelectedGmailMsg(data);
    } catch (e) { window.__oikeToast('Error cargando email', 'error'); }
    setGmailMsgLoading(false);
  };

  // ── AI Next-Step Recommendation ──
  const [aiRec, setAiRec] = useState('');
  const [aiRecLoading, setAiRecLoading] = useState(false);
  const [aiRecSaved, setAiRecSaved] = useState(false);

  const generateAiRec = async () => {
    setAiRecLoading(true);
    setAiRec('');
    setAiRecSaved(false);
    try {
      const pain = localPain || F(stakeholder, 'Pain Points (Generated)') || F(stakeholder, 'Pain points') || '';
      const linkedin = localLinkedin || F(stakeholder, 'LinkedIn News (Generated)') || F(stakeholder, 'Linkedin lates news') || '';
      const intelNotes = F(stakeholder, 'Intel Notes') || stkNotes || '';
      const accDesc = account ? (F(account, 'Company Description') || '') : '';
      const accNews = account ? (F(account, 'Recent News') || '') : '';
      const accIntel = account ? (F(account, 'Intel Notes') || '') : '';
      const history = sOutreach.slice(0, 6).map(o => {
        const ch = F(o, 'Channel') || '?';
        const st = F(o, 'Status') || '?';
        const dt = o.fields?.['Date'] ? new Date(o.fields['Date']).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?';
        const msg = (F(o, 'Message') || F(o, 'Notes') || '').replace(/^(\[g[^\]]+\])+\s*/, '').slice(0, 150);
        return `• ${dt} — ${ch} (${st})${msg ? `: "${msg}"` : ''}`;
      }).join('\n') || 'No interactions yet.';

      const prompt = `You are a senior B2B sales strategist working for ${COMPANY_PROFILE.companyName || 'our company'}.
${COMPANY_PROFILE.services ? `What we offer: ${COMPANY_PROFILE.services}` : ''}
${COMPANY_PROFILE.goals ? `Focus: ${COMPANY_PROFILE.goals}` : ''}

CONTACT: ${sName} — ${role || 'Unknown role'}
COMPANY: ${accountName || 'Unknown'}${industry ? ` (${industry})` : ''}
${accDesc ? `Company description: ${accDesc.slice(0, 200)}` : ''}
${accNews ? `Recent company news: ${accNews.slice(0, 200)}` : ''}
${accIntel ? `Account intel: ${accIntel.slice(0, 200)}` : ''}
${pain ? `Pain points: ${pain.slice(0, 300)}` : ''}
${linkedin ? `LinkedIn intel: ${linkedin.slice(0, 200)}` : ''}
${intelNotes ? `Additional intel: ${intelNotes.slice(0, 200)}` : ''}

INTERACTION HISTORY (newest first):
${history}

Based on ALL this context, give a sharp, specific recommendation for the NEXT BEST ACTION with this contact.
Include:
1. **Recommended action** (1 sentence — what exactly to do: call, email, LinkedIn DM, send asset, invite to event, etc.)
2. **Why now** (1-2 sentences — what signal or context makes this the right move)
3. **Suggested angle** (2-3 sentences — what to say, referencing their specific situation)
4. **Timing** (when to do it)

Be direct and actionable. No generic advice. Reference their actual situation.`;

      const rec = await callOpenAI({ prompt, temperature: 0.65, max_tokens: 500 });
      setAiRec(rec);

      // Auto-save as activity in Airtable
      const a = new AirtableAPI();
      const today = new Date().toISOString().split('T')[0];
      await a.createRecord(TABLE_IDS.outreach, {
        'Activity Name': `🤖 AI Rec — ${sName} — ${new Date().toLocaleDateString('en-US')}`,
        'Channel': 'Note',
        'Status': 'Pending',
        'Notes': rec,
        'Stakeholder': [stakeholder.id],
        'Date': new Date().toISOString(),
        ...(accountIds.length > 0 ? { 'Account': accountIds } : {}),
        'Logged By': CURRENT_USER?.name || 'AI',
        ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
        ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
      });
      setAiRecSaved(true);
      if (onRefresh) onRefresh();
    } catch (e) {
      window.__oikeToast('Error generando recomendación: ' + (e.message || 'unknown'), 'error');
    }
    setAiRecLoading(false);
  };
  const [localEmail, setLocalEmail] = useState(F(stakeholder, 'Email') || '');
  // Intel Notes for this stakeholder
  const [stkNotes, setStkNotes] = useState(F(stakeholder, 'Intel Notes') || '');
  const [editingStkNotes, setEditingStkNotes] = useState(false);
  const [stkNotesDraft, setStkNotesDraft] = useState('');
  const [savingStkNotes, setSavingStkNotes] = useState(false);
  const [uploadingStkFile, setUploadingStkFile] = useState(false);
  const saveStkNotes = async () => {
    setSavingStkNotes(true);
    try {
      const a = new AirtableAPI();
      await a.updateRecord(TABLE_IDS.stakeholders, stakeholder.id, { 'Intel Notes': stkNotesDraft });
      setStkNotes(stkNotesDraft);
      setEditingStkNotes(false);
      if (onRefresh) onRefresh();
    } catch (e) { window.__oikeToast('Error saving notes: ' + (e.message || 'unknown'), 'error'); }
    setSavingStkNotes(false);
  };
  const handleStkFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploadingStkFile(true);
    try {
      let content = '';
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      if (isPdf) {
        const pdfjsLib = await new Promise((resolve, reject) => {
          if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
          script.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; resolve(window.pdfjsLib); };
          script.onerror = () => reject(new Error('Failed to load PDF.js'));
          document.head.appendChild(script);
        });
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const pages = [];
        for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          pages.push(textContent.items.map(item => item.str).join(' '));
        }
        content = pages.join('\n');
      } else {
        content = await file.text();
      }
      if (!content.trim()) throw new Error('File appears to be empty or unreadable.');
      const truncated = content.slice(0, 4000);
      const prompt = `You are a B2B sales analyst working for ${COMPANY_PROFILE.companyName || 'our company'} (${COMPANY_PROFILE.services || 'professional services'}). Summarize the key insights from this file relevant for sales outreach to ${sName} (${F(stakeholder,'Role')||'?'}).

FILE: ${file.name}
CONTENT:
${truncated}

Provide:
1. Brief summary (2-3 sentences) of what this file contains
2. Key insights for outreach (3-5 bullet points)
3. Any specific pain points, commitments, or next steps mentioned

Be concise and actionable.`;
      const summary = await callOpenAI({ prompt, temperature: 0.5, max_tokens: 500 });
      const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const newEntry = `\n\n📎 FILE: ${file.name} (uploaded ${dateStr})\n${summary}`;
      const updated = (stkNotes || '') + newEntry;
      const a = new AirtableAPI();
      await a.updateRecord(TABLE_IDS.stakeholders, stakeholder.id, { 'Intel Notes': updated });
      setStkNotes(updated);
      if (onRefresh) onRefresh();
    } catch (err) {
      window.__oikeToast('Error processing file: ' + (err.message || 'unknown'), 'error');
    }
    setUploadingStkFile(false);
    e.target.value = '';
  };
  const [emailMeta, setEmailMeta] = useState({
    confidence: F(stakeholder, 'email_confidence') || null,
    source: F(stakeholder, 'email_source') || '',
    qualification: F(stakeholder, 'email_qualification') || '',
  });

  const sName = F(stakeholder, 'Name') + (F(stakeholder, 'Last name') ? ` ${F(stakeholder, 'Last name')}` : '');
  const accNames = resolveLinked(stakeholder, 'Account', accounts, 'Account Name');
  const role = F(stakeholder, 'Role');
  const sOutreach = outreach.filter(o => linkedIds(o, 'Stakeholder').includes(stakeholder.id))
    .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));

  const accountIds = linkedIds(stakeholder, 'Account');
  const account = accounts.find(a => accountIds.includes(a.id));
  const accountName = account ? F(account, 'Account Name') : '';
  const industry = account ? F(account, 'Industry') : '';
  const serviceFocus = account ? F(account, 'Service / Focus') : '';
  const focusText = Array.isArray(serviceFocus) ? serviceFocus.join(', ') : serviceFocus;
  const recentNews = account ? (F(account, 'Recent News') || '') : '';
  const newsText = typeof recentNews === 'string' ? recentNews.slice(0, 300) : '';

  // Pain Points: GPT-4o generated (analysis-based)
  const generatePainPoints = async () => {
    setGenLoading('pain');
    try {
      const prompt = `You are a B2B sales research analyst. Analyze this stakeholder and identify their likely pain points.

STAKEHOLDER: ${sName}
ROLE: ${role}
COMPANY: ${accountName}
INDUSTRY: ${industry}
SERVICE FOCUS: ${focusText || 'Not defined'}
RECENT COMPANY NEWS: ${newsText || 'Not available'}

Generate 3-5 specific, actionable pain points for this person based on their role and industry context. Each pain point should:
- Be specific to their role (not generic)
- Reference industry challenges they likely face
- Connect to areas where ${COMPANY_PROFILE.companyName} (${COMPANY_PROFILE.services}) could help

Format as bullet points. Be concise (1-2 sentences each). Write ONLY the pain points, no intro or summary.`;

      const generated = await callOpenAI({ prompt, temperature: 0.7, max_tokens: 400 });
      // Show result immediately
      setLocalPain(generated);
      // Persist to localStorage so it survives page refresh even if Airtable write fails
      try { localStorage.setItem(PAIN_CACHE_KEY, generated); } catch {}
      const painTs = new Date().toISOString();
      setLocalPainTs(painTs);
      try {
        const painTsMap = JSON.parse(localStorage.getItem(PAIN_TS_LS_KEY) || '{}');
        painTsMap[stakeholder.id] = painTs;
        localStorage.setItem(PAIN_TS_LS_KEY, JSON.stringify(painTsMap));
      } catch {}
      // Also try to save to Airtable (graceful fail — localStorage is the source of truth)
      if (!stakeholder.id.startsWith('tmp_')) {
        const a = new AirtableAPI();
        a.updateRecord(TABLE_IDS.stakeholders, stakeholder.id, { 'Pain points': generated })
          .then(() => { if (onRefresh) onRefresh(); })
          .catch(e => console.warn('Could not persist pain points to Airtable (cached locally):', e.message));
      }
    } catch (e) {
      console.error(e);
      window.__oikeToast('Failed to generate. Error: ' + (e.message || 'unknown error'), 'error');
    }
    setGenLoading('');
  };

  // LinkedIn Insights: Triggers Airtable AI (real LinkedIn data)
  const refreshLinkedIn = async () => {
    const atKey = localStorage?.getItem?.('at_key');
    setGenLoading('linkedin');
    try {
      const a = new AirtableAPI();
      // Step 1: Update trigger field to fire Airtable Automation
      const triggerTime = new Date().toISOString();
      await a.updateRecord(TABLE_IDS.stakeholders, stakeholder.id, {
        'AI Refresh Trigger': triggerTime
      });

      // Wait for Airtable Automation + AI to regenerate
      setGenLoading('linkedin-wait');
      await new Promise(r => setTimeout(r, 20000));

      // Re-fetch the record to get fresh aiText
      const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${TABLE_IDS.stakeholders}/${stakeholder.id}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${atKey}` } });
      if (!res.ok) throw new Error('Failed to fetch updated record');
      const record = await res.json();

      // Handle aiText: could be {value: "...", state: "generated"} or just a string
      const rawVal = record?.fields?.['Linkedin lates news'];
      let freshText = '';
      if (rawVal && typeof rawVal === 'object' && rawVal.value) {
        freshText = rawVal.value;
      } else if (typeof rawVal === 'string') {
        freshText = rawVal;
      }

      if (freshText) {
        setLocalLinkedin(freshText);
        try { localStorage.setItem(LINKEDIN_CACHE_KEY, freshText); } catch {}
      } else {
        // AI still generating — retry after 10 more seconds
        setGenLoading('linkedin-retry');
        await new Promise(r => setTimeout(r, 10000));
        const res2 = await fetch(url, { headers: { Authorization: `Bearer ${atKey}` } });
        const record2 = await res2.json();
        const rawVal2 = record2?.fields?.['Linkedin lates news'];
        const text2 = rawVal2?.value || (typeof rawVal2 === 'string' ? rawVal2 : '');
        if (text2) {
          setLocalLinkedin(text2);
          try { localStorage.setItem(LINKEDIN_CACHE_KEY, text2); } catch {};
        } else {
          window.__oikeToast('LinkedIn AI is still generating. Wait a moment and try Refresh Data, then open the contact again.', 'warning');
        }
      }
    } catch (e) {
      console.error('[LinkedIn] Error:', e);
      window.__oikeToast('Failed to refresh LinkedIn data. Check console for details.', 'error');
    }
    setGenLoading('');
  };

  // Email Enrichment: Dropcontact → Snov.io waterfall via Netlify function
  const enrichEmail = async () => {
    if (enrichLoading) return;
    const hasEmail = !!localEmail;
    if (hasEmail && !confirm('Re-enrich this email? This will consume enrichment credits and may overwrite the current email.')) return;
    setEnrichLoading(true);
    try {
      const res = await fetch('/api/enrich-stakeholder', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          stakeholder_id: stakeholder.id,
          base_id: AIRTABLE_BASE_ID,
          force: hasEmail,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { logoutUser(); return; }
      if (!res.ok) {
        window.__oikeToast('Enrichment failed: ' + (data.error || `HTTP ${res.status}`), 'error');
        return;
      }
      if (data.ok && data.email) {
        setLocalEmail(data.email);
        setEmailMeta({ confidence: data.confidence, source: data.source, qualification: data.qualification });
        if (onRefresh) onRefresh();
      } else if (data.cached) {
        window.__oikeToast('Already enriched recently — no credits consumed.', 'warning');
      } else {
        // No provider found the email — offer manual LinkedIn search fallback
        const domainInfo = data.domain_used ? `Domain tried: ${data.domain_used}` : 'No company domain was available on the account';
        const fullName = `${F(stakeholder, 'Name') || ''} ${F(stakeholder, 'Last name') || ''}`.trim();
        const liSearch = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(fullName + (accountName ? ' ' + accountName : ''))}`;
        const tried = Array.isArray(data.providers_tried) ? data.providers_tried : [];
        const providerLines = [];
        if (tried.includes('dropcontact')) providerLines.push(`• Dropcontact → ${data.dropcontact_reason || data.reason || 'no match'}`);
        if (tried.includes('snov'))        providerLines.push(`• Snov.io → ${data.snov_reason || data.reason || 'no match'}`);
        if (providerLines.length === 0)    providerLines.push(`• No providers configured (check env vars)`);
        const shouldOpenLi = confirm(
          `No email found.\n\n` +
          `Providers tried:\n${providerLines.join('\n')}\n\n` +
          `${domainInfo}\n\n` +
          `Tip: small or private domains often aren't in enrichment DBs. Try manual search on LinkedIn → check their profile/contact info.\n\n` +
          `Open LinkedIn search for "${fullName}" now?`
        );
        if (shouldOpenLi) window.open(liSearch, '_blank');
      }
    } catch (e) {
      console.error('[enrich] Error:', e);
      window.__oikeToast('Enrichment error: ' + (e.message || 'unknown'), 'error');
    }
    setEnrichLoading(false);
  };

  const statusColor = { 'Replied': '#4ade80', 'Meeting Scheduled': '#60a5fa', 'Sent': '#fbbf24', 'Pending': '#a78bfa' };
  const painText = typeof localPain === 'string' ? localPain : String(localPain || '');
  const linkedinText = typeof localLinkedin === 'string' ? localLinkedin : String(localLinkedin || '');

  return (
    <>
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 640, maxHeight: '85vh', overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 18 }}>{sName}</h3>
            <div style={{ fontSize: 12, color: 'var(--globant-muted)', marginTop: 4 }}>
              {role}{account && onNavigateToAccount ? <span> · <span style={{ color: 'var(--globant-green)', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => { onClose(); onNavigateToAccount(account.id); }}>{accountName}</span></span> : (accNames.length ? ` · ${accNames.join(', ')}` : '')}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {localEmail ? (
                  <>
                    ✉️ {localEmail}
                    {emailMeta.source && (
                      <span style={{ fontSize: 9, opacity: 0.7, marginLeft: 2 }}>
                        ({emailMeta.source}{emailMeta.confidence ? ` · ${emailMeta.confidence}%` : ''}{emailMeta.qualification ? ` · ${emailMeta.qualification}` : ''})
                      </span>
                    )}
                  </>
                ) : (
                  <span style={{ fontStyle: 'italic' }}>✉️ no email yet</span>
                )}
                <button
                  onClick={enrichEmail}
                  disabled={enrichLoading}
                  title={localEmail ? 'Re-enrich email via Dropcontact + Snov.io' : 'Find email via Dropcontact + Snov.io'}
                  style={{
                    fontSize: 10, padding: '2px 8px', borderRadius: 6, cursor: enrichLoading ? 'wait' : 'pointer',
                    background: 'rgba(91,191,181,0.12)', border: '1px solid rgba(91,191,181,0.3)',
                    color: 'var(--globant-green)', fontWeight: 600, marginLeft: 4,
                  }}>
                  {enrichLoading ? '⏳ Enriching...' : localEmail ? '🔄 Re-enrich' : '🔍 Find email'}
                </button>
              </span>
              {F(stakeholder, 'Phone number') && <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>📞 {F(stakeholder, 'Phone number')}</span>}
              {F(stakeholder, 'Level of Influence') && <span className="badge badge-accent" style={{ fontSize: 10 }}>{F(stakeholder, 'Level of Influence')}</span>}
              {(() => {
                const status = F(stakeholder, 'Status') || 'Not Contacted';
                const colors = {
                  'Not Contacted': { bg: 'rgba(136,136,168,0.15)', fg: '#8888a8', br: 'rgba(136,136,168,0.35)' },
                  'Contacted':     { bg: 'rgba(251,191,36,0.15)', fg: '#fbbf24', br: 'rgba(251,191,36,0.35)' },
                  'Replied':       { bg: 'rgba(74,222,128,0.15)', fg: '#4ade80', br: 'rgba(74,222,128,0.35)' },
                  'Meeting Booked':{ bg: 'rgba(96,165,250,0.15)', fg: '#60a5fa', br: 'rgba(96,165,250,0.35)' },
                  'Not Interested':{ bg: 'rgba(249,115,22,0.15)', fg: '#f97316', br: 'rgba(249,115,22,0.35)' },
                  'DNC':           { bg: 'rgba(239,68,68,0.20)',  fg: '#ef4444', br: 'rgba(239,68,68,0.45)' },
                  'Bounced':       { bg: 'rgba(234,88,12,0.15)',  fg: '#ea580c', br: 'rgba(234,88,12,0.35)' },
                  'Left Company':  { bg: 'rgba(156,163,175,0.15)',fg: '#9ca3af', br: 'rgba(156,163,175,0.35)' },
                  'Nurture':       { bg: 'rgba(167,139,250,0.15)',fg: '#a78bfa', br: 'rgba(167,139,250,0.35)' },
                }[status] || { bg: 'rgba(136,136,168,0.15)', fg: '#8888a8', br: 'rgba(136,136,168,0.35)' };
                return (
                  <span style={{ fontSize: 10, padding: '3px 9px', borderRadius: 10, background: colors.bg, color: colors.fg, border: `1px solid ${colors.br}`, fontWeight: 700 }}>
                    {status}
                  </span>
                );
              })()}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 18, padding: 4 }}>✕</button>
        </div>

        {/* Pain Points */}
        <div style={{ padding: '10px 12px', background: 'rgba(91,191,181,0.06)', borderRadius: 8, marginBottom: 10, borderLeft: '3px solid var(--globant-green)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <div>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-green)' }}>PAIN POINTS</span>
              {localPainTs && (
                <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 1 }}>
                  Last updated: {new Date(localPainTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </div>
              )}
            </div>
            <button className="action-btn btn-primary" style={{ fontSize: 10, padding: '3px 10px' }}
              onClick={generatePainPoints} disabled={genLoading === 'pain'}>
              {genLoading === 'pain' ? '⏳ Generating...' : painText ? '🔄 Regenerate' : '✨ Generate with AI'}
            </button>
          </div>
          {painText ? (
            <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--globant-text)', whiteSpace: 'pre-wrap' }}>{painText.slice(0, 500)}</div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>No pain points yet — click Generate to create with AI</div>
          )}
        </div>

        {/* LinkedIn News */}
        <div style={{ padding: '10px 12px', background: 'rgba(10,102,194,0.06)', borderRadius: 8, marginBottom: 16, borderLeft: '3px solid #0A66C2' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#0A66C2' }}>LINKEDIN INSIGHTS</span>
            <button className="action-btn" style={{ fontSize: 10, padding: '3px 10px', background: 'rgba(10,102,194,0.15)', color: '#0A66C2', border: '1px solid rgba(10,102,194,0.3)' }}
              onClick={refreshLinkedIn} disabled={genLoading === 'linkedin' || genLoading === 'linkedin-wait'}>
              {genLoading === 'linkedin' ? '⏳ Triggering...' : genLoading === 'linkedin-wait' ? '⏳ Waiting for Airtable AI (~10s)...' : linkedinText ? '🔄 Refresh from Airtable' : '🔗 Get LinkedIn Insights'}
            </button>
          </div>
          {linkedinText ? (
            <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--globant-text)', whiteSpace: 'pre-wrap' }}>{linkedinText.slice(0, 500)}</div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>No LinkedIn insights yet — click Generate to create with AI</div>
          )}
        </div>

        {/* Stats row */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 1, padding: '10px 14px', background: 'var(--globant-darker)', borderRadius: 8, textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--globant-green)' }}>{sOutreach.length}</div>
            <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>Total Interactions</div>
          </div>
          <div style={{ flex: 1, padding: '10px 14px', background: 'var(--globant-darker)', borderRadius: 8, textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#4ade80' }}>{sOutreach.filter(o => F(o, 'Status') === 'Replied').length}</div>
            <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>Replies</div>
          </div>
          <div style={{ flex: 1, padding: '10px 14px', background: 'var(--globant-darker)', borderRadius: 8, textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#60a5fa' }}>{sOutreach.filter(o => F(o, 'Status') === 'Meeting Scheduled').length}</div>
            <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>Meetings</div>
          </div>
          <div style={{ flex: 1, padding: '10px 14px', background: 'var(--globant-darker)', borderRadius: 8, textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--globant-text)' }}>
              {sOutreach.length > 0 ? `${Math.floor((new Date() - new Date(sOutreach[0].fields?.['Date'])) / (1000*60*60*24))}d` : '—'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>Last Touch</div>
          </div>
        </div>

        {/* Intel Notes */}
        <div style={{ padding: '12px 14px', background: 'rgba(251,191,36,0.05)', borderRadius: 8, marginBottom: 14, borderLeft: '3px solid #fbbf24' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#fbbf24' }}>📝 INTEL NOTES</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {!editingStkNotes ? (
                <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '3px 10px' }}
                  onClick={() => { setStkNotesDraft(stkNotes); setEditingStkNotes(true); }}>
                  {stkNotes ? '✏️ Edit' : '➕ Add Notes'}
                </button>
              ) : (
                <>
                  <button className="action-btn btn-primary" style={{ fontSize: 10, padding: '3px 10px' }} onClick={saveStkNotes} disabled={savingStkNotes}>
                    {savingStkNotes ? '⏳' : '💾 Save'}
                  </button>
                  <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '3px 10px' }} onClick={() => setEditingStkNotes(false)}>Cancel</button>
                </>
              )}
              <label style={{ cursor: 'pointer' }}>
                <span className="action-btn btn-ghost" style={{ fontSize: 10, padding: '3px 10px', display: 'inline-block', color: 'var(--globant-info)', border: '1px solid rgba(96,165,250,0.3)', background: 'rgba(96,165,250,0.08)' }}>
                  {uploadingStkFile ? '⏳' : '📎 Upload File'}
                </span>
                <input type="file" accept=".csv,.txt,.json,.md,.html,.tsv,.xml,.pdf" onChange={handleStkFileUpload} style={{ display: 'none' }} disabled={uploadingStkFile} />
              </label>
            </div>
          </div>
          {editingStkNotes ? (
            <textarea className="input-field" value={stkNotesDraft} onChange={e => setStkNotesDraft(e.target.value)}
              placeholder="Meeting notes, key commitments, context, next steps..."
              style={{ width: '100%', minHeight: 100, fontSize: 12, lineHeight: 1.6, resize: 'vertical' }} />
          ) : stkNotes ? (
            <FileNotesRenderer notes={stkNotes} accentColor="#fbbf24"
              onUpdateNotes={async (updated) => {
                const a = new AirtableAPI();
                await a.updateRecord(TABLE_IDS.stakeholders, stakeholder.id, { 'Intel Notes': updated });
                setStkNotes(updated);
                if (onRefresh) onRefresh();
              }} />
          ) : (
            <div style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>
              No notes yet — add meeting context, proposal PDFs, or any relevant intel about this contact.
            </div>
          )}
        </div>

        {/* AI Message Generator toggle */}
        <div style={{ marginBottom: 12 }}>
          <button
            onClick={() => setShowAIGenerator(v => !v)}
            style={{ width: '100%', padding: '10px 16px', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 13,
              background: showAIGenerator ? 'rgba(91,191,181,0.15)' : 'rgba(91,191,181,0.07)',
              border: '1px solid rgba(91,191,181,0.35)', color: 'var(--globant-green)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>✨ Generate Message</span>
            <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>{showAIGenerator ? '▲' : '▼'}</span>
          </button>
        </div>

        {/* Manual Quick Message */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--globant-text)' }}>✍️ Quick Message</div>
          <textarea className="input-field" style={{ width: '100%', minHeight: 70, resize: 'vertical', fontFamily: 'inherit', fontSize: 12, marginBottom: 8 }}
            placeholder="Write your message here... it will be copied, logged, and the channel opened." value={quickMsg} onChange={e => setQuickMsg(e.target.value)} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {['LinkedIn', 'WhatsApp', 'Email'].map(ch => (
              <button key={ch} style={{ fontSize: 11, padding: '5px 12px', borderRadius: 8, cursor: 'pointer',
                background: quickMsgChannel === ch ? 'rgba(91,191,181,0.2)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${quickMsgChannel === ch ? 'var(--globant-green)' : 'rgba(255,255,255,0.08)'}`,
                color: quickMsgChannel === ch ? 'var(--globant-green)' : 'var(--globant-text)',
                fontWeight: quickMsgChannel === ch ? 700 : 400,
              }} onClick={() => setQuickMsgChannel(ch)}>
                {ch === 'LinkedIn' ? '🔗' : ch === 'WhatsApp' ? '💬' : '✉️'} {ch}
              </button>
            ))}
            <button className="action-btn btn-primary" style={{ fontSize: 11, marginLeft: 'auto' }}
              disabled={!quickMsg.trim() || sendingQuickMsg}
              onClick={() => {
                if (!quickMsg.trim()) return;
                // Guard: stakeholder must be saved in Airtable, not tmp
                if (stakeholder.id && stakeholder.id.startsWith('tmp_')) {
                  window.__oikeToast('This contact is still saving. Wait a moment and try again.', 'warning');
                  return;
                }
                setSendingQuickMsg(true);
                const name = F(stakeholder, 'Name') || '';
                const email = F(stakeholder, 'Email') || '';
                const phone = F(stakeholder, 'Phone number') || '';
                const linkedin = F(stakeholder, 'LinkedIn') || '';
                // Open channel synchronously first (must be before any await)
                navigator.clipboard.writeText(quickMsg).catch(() => {});
                if (quickMsgChannel === 'LinkedIn' && linkedin) window.open(linkedin, '_blank');
                else if (quickMsgChannel === 'WhatsApp' && phone) window.open(`https://wa.me/${String(phone).replace(/[^0-9+]/g, '')}?text=${encodeURIComponent(quickMsg)}`, '_blank');
                else if (quickMsgChannel === 'Email' && email) window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&body=${encodeURIComponent(quickMsg)}`, '_blank');
                // Build outreach fields
                const outreachFields = {
                  'Activity Name': `${quickMsgChannel} to ${name} — ${new Date().toLocaleDateString('en-US')}`,
                  'Account': accountIds, 'Stakeholder': [stakeholder.id],
                  'Channel': quickMsgChannel, 'Date': new Date().toISOString(),
                  'Status': 'Sent', 'Message': quickMsg,
                  'Notes': 'Sent via Quick Message',
                  'Logged By': CURRENT_USER?.name || '',
                  ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
                  ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
                };
                // Optimistic update — so modal shows it immediately
                if (onAddRecord) onAddRecord('outreach', outreachFields);
                // API call in background
                const a = new AirtableAPI();
                a.createRecord(TABLE_IDS.outreach, outreachFields)
                  .then(async () => {
                    await activateAccountIfNeeded(a, accountIds, accounts);
                    await updateStakeholderStatus(a, stakeholder.id, 'Contacted', allData?.stakeholders || []);
                    if (onRefresh) onRefresh();
                  })
                  .catch(e => { console.error('Quick message log failed:', e); if (onRefresh) onRefresh(); });
                setQuickMsg('');
                setSendingQuickMsg(false);
              }}>
              {sendingQuickMsg ? '⏳ Sending...' : '🚀 Send & Log'}
            </button>
          </div>
        </div>

        {/* Quick Actions */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--globant-text)' }}>Quick Log</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: quickAction ? 10 : 0 }}>
            {[
              { key: 'bounced', label: '📭 Bounced Mail', color: '#f87171', status: 'Bounced' },
              { key: 'reply', label: '💬 Reply Received', color: '#4ade80', status: 'Replied' },
              { key: 'meeting', label: '📅 Meeting Booked', color: '#60a5fa', status: 'Meeting Scheduled' },
              { key: 'notinterested', label: '🚫 Not Interested', color: '#fbbf24', status: 'Not Interested' },
            ].map(act => (
              <button key={act.key}
                style={{ fontSize: 11, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                  background: quickAction === act.key ? act.color + '25' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${quickAction === act.key ? act.color : 'rgba(255,255,255,0.08)'}`,
                  color: quickAction === act.key ? act.color : 'var(--globant-text)',
                  fontWeight: quickAction === act.key ? 700 : 400,
                }}
                onClick={() => { setQuickAction(quickAction === act.key ? '' : act.key); setQuickNote(''); setQuickReplyChannel('Email'); }}>
                {act.label}
              </button>
            ))}
          </div>
          {quickAction && (() => {
            const actions = {
              bounced: { status: 'Bounced', label: 'Bounced Mail', hasNote: false },
              reply: { status: 'Replied', label: 'Reply Received', hasNote: true, notePlaceholder: 'What did they say? Key takeaways...' },
              meeting: { status: 'Meeting Scheduled', label: 'Meeting Booked', hasNote: true, notePlaceholder: 'Meeting date, topic, attendees...' },
              notinterested: { status: 'Not Interested', label: 'Not Interested', hasNote: true, notePlaceholder: 'Reason — timing, budget, wrong contact...' },
            };
            const act = actions[quickAction];
            return (
              <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
                {quickAction === 'reply' && (
                  <div style={{ marginBottom: 8 }}>
                    <label style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'block', marginBottom: 6 }}>Reply came via</label>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {[
                        { ch: 'Email', icon: '📧' },
                        { ch: 'LinkedIn', icon: '💼' },
                        { ch: 'WhatsApp', icon: '💬' },
                        { ch: 'Phone', icon: '📞' },
                        { ch: 'SMS', icon: '📱' },
                      ].map(({ ch, icon }) => (
                        <button key={ch}
                          onClick={() => setQuickReplyChannel(ch)}
                          style={{ fontSize: 11, padding: '5px 11px', borderRadius: 6, cursor: 'pointer',
                            background: quickReplyChannel === ch ? 'rgba(74,222,128,0.2)' : 'rgba(255,255,255,0.04)',
                            border: `1px solid ${quickReplyChannel === ch ? '#4ade80' : 'rgba(255,255,255,0.1)'}`,
                            color: quickReplyChannel === ch ? '#4ade80' : 'var(--globant-text)',
                            fontWeight: quickReplyChannel === ch ? 700 : 400,
                          }}>
                          {icon} {ch}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {quickAction === 'meeting' && (
                  <div style={{ marginBottom: 8 }}>
                    <label style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'block', marginBottom: 4 }}>Meeting date & time</label>
                    <input type="datetime-local" className="input-field" style={{ fontSize: 12, width: '100%' }}
                      value={quickDate} onChange={e => setQuickDate(e.target.value)} />
                  </div>
                )}
                {act.hasNote && (
                  <textarea className="input-field" style={{ width: '100%', minHeight: 50, resize: 'vertical', fontFamily: 'inherit', fontSize: 12, marginBottom: 8 }}
                    placeholder={act.notePlaceholder} value={quickNote} onChange={e => setQuickNote(e.target.value)} />
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="action-btn btn-primary" style={{ fontSize: 11 }}
                    disabled={savingQuick}
                    onClick={async () => {
                      setSavingQuick(true);
                      try {
                        const a = new AirtableAPI();
                        await a.createRecord(TABLE_IDS.outreach, {
                          'Activity Name': `${act.label} — ${sName} — ${new Date().toLocaleDateString('en-US')}`,
                          'Account': accountIds,
                          'Stakeholder': [stakeholder.id],
                          'Channel': quickAction === 'meeting' ? 'Calendar' : quickAction === 'reply' ? quickReplyChannel : 'Email',
                          'Date': (quickAction === 'meeting' && quickDate) ? new Date(quickDate).toISOString() : new Date().toISOString(),
                          'Status': act.status,
                          ...(quickNote ? { 'Notes': quickNote } : {}),
                          'Logged By': CURRENT_USER?.name || '',
                          ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
                          ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
                        });
                        await activateAccountIfNeeded(a, accountIds, accounts);
                        // Manual Quick Log is authoritative — set stakeholder Status directly (bypasses auto-advance rules)
                        const QUICK_TO_STK_STATUS = {
                          bounced: 'Bounced',
                          reply: 'Replied',
                          meeting: 'Meeting Booked',
                          notinterested: 'Not Interested',
                        };
                        const newStkStatus = QUICK_TO_STK_STATUS[quickAction];
                        if (newStkStatus) {
                          await a.updateRecord(TABLE_IDS.stakeholders, stakeholder.id, { 'Status': newStkStatus })
                            .catch(e => console.warn('[QuickLog] failed to update stakeholder status:', e));
                        }
                        if (onRefresh) onRefresh();
                        setQuickAction('');
                        setQuickNote('');
                        setQuickDate('');
                      } catch (e) {
                        console.error(e);
                        window.__oikeToast('Failed to log activity', 'error');
                      }
                      setSavingQuick(false);
                    }}>
                    {savingQuick ? '⏳ Saving...' : `✅ Log ${act.label}`}
                  </button>
                  <button className="action-btn btn-ghost" style={{ fontSize: 11 }}
                    onClick={() => { setQuickAction(''); setQuickNote(''); setQuickDate(''); }}>
                    Cancel
                  </button>
                </div>
              </div>
            );
          })()}
        </div>

        {/* ── AI Next-Step Recommendation ── */}
        {(() => {
          // Detect recommended channel from AI text
          const recLower = aiRec.toLowerCase();
          const detectedChannel = recLower.includes('linkedin') ? 'LinkedIn'
            : recLower.includes('whatsapp') ? 'WhatsApp'
            : recLower.includes('email') || recLower.includes('correo') ? 'Email'
            : recLower.includes('call') || recLower.includes('llamada') ? 'Call'
            : null;
          // Extract suggested angle text (between quotes or after "Suggested angle:")
          const angleMatch = aiRec.match(/[""]([^"""]{20,})[""]/) || aiRec.match(/(?:suggested angle|ángulo sugerido)[^:]*:\s*[""]?([^""\n]{20,})/i);
          const suggestedMsg = angleMatch ? angleMatch[1].trim() : '';
          // Render **bold** markdown inline
          const renderMd = (text) => {
            const parts = text.split(/(\*\*[^*]+\*\*)/g);
            return parts.map((p, i) => p.startsWith('**') && p.endsWith('**')
              ? React.createElement('strong', { key: i, style: { color: 'var(--globant-text)', fontWeight: 700 } }, p.slice(2, -2))
              : p
            );
          };
          const channelConfig = {
            LinkedIn: { icon: '🔗', color: '#0a66c2', bg: 'rgba(10,102,194,0.12)', border: 'rgba(10,102,194,0.3)', label: 'Ir a LinkedIn' },
            Email:    { icon: '✉️', color: 'var(--globant-green)', bg: 'rgba(91,191,181,0.12)', border: 'rgba(91,191,181,0.3)', label: 'Redactar Email' },
            WhatsApp: { icon: '💬', color: '#25d366', bg: 'rgba(37,211,102,0.12)', border: 'rgba(37,211,102,0.3)', label: 'Abrir WhatsApp' },
            Call:     { icon: '📞', color: '#fbbf24', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.3)', label: 'Llamar' },
          };
          const cfg = detectedChannel ? channelConfig[detectedChannel] : null;
          const handleAction = async () => {
            const msgToCopy = suggestedMsg || aiRec.slice(0, 500);
            // Copy message to clipboard always
            if (msgToCopy) navigator.clipboard.writeText(msgToCopy).catch(() => {});

            if (detectedChannel === 'LinkedIn') {
              const url = F(stakeholder, 'LinkedIn') || F(stakeholder, 'linkedin_url') || '';
              if (url) { window.open(url, '_blank'); window.__oikeToast('📋 Mensaje copiado — pegalo en LinkedIn', 'success'); }
              else window.__oikeToast('No hay URL de LinkedIn para este contacto', 'warning');
            } else if (detectedChannel === 'Email') {
              if (onSend) onSend(stakeholder, 'Email', msgToCopy, null, null, {});
              else window.__oikeToast('📋 Mensaje copiado', 'success');
            } else if (detectedChannel === 'WhatsApp') {
              const phone = F(stakeholder, 'Phone') || '';
              if (phone) { window.open(`https://wa.me/${phone.replace(/\D/g,'')}?text=${encodeURIComponent(msgToCopy)}`, '_blank'); }
              else window.__oikeToast('No hay teléfono para este contacto', 'warning');
            } else if (detectedChannel === 'Call') {
              const phone = F(stakeholder, 'Phone') || '';
              if (phone) { window.open(`tel:${phone}`); window.__oikeToast('📋 Ángulo copiado al portapapeles', 'success'); }
              else window.__oikeToast('No hay teléfono para este contacto', 'warning');
            }

            // Log the action as activity
            try {
              const a = new AirtableAPI();
              await a.createRecord(TABLE_IDS.outreach, {
                'Activity Name': `${detectedChannel || 'Outreach'} → ${sName} — ${new Date().toLocaleDateString('en-US')}`,
                'Channel': detectedChannel === 'Call' ? 'Phone' : detectedChannel || 'Email',
                'Status': 'Sent',
                'Notes': `[AI Rec] ${msgToCopy.slice(0, 500)}`,
                'Stakeholder': [stakeholder.id],
                'Date': new Date().toISOString(),
                ...(accountIds.length > 0 ? { 'Account': accountIds } : {}),
                'Logged By': CURRENT_USER?.name || '',
                ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
                ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
              });
              if (onRefresh) onRefresh();
            } catch (e) { console.warn('Failed to log action:', e); }
          };
          return (
            <div style={{ marginBottom: 16, background: 'rgba(91,191,181,0.05)', border: '1px solid rgba(91,191,181,0.2)', borderRadius: 10, padding: '10px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: aiRec ? 10 : 0 }}>
                <div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--globant-green)' }}>🤖 Próximo paso recomendado</span>
                  {aiRecSaved && <span style={{ fontSize: 10, color: 'var(--globant-muted)', marginLeft: 8 }}>✅ Guardado</span>}
                </div>
                <button onClick={generateAiRec} disabled={aiRecLoading}
                  style={{ fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 8, background: 'rgba(91,191,181,0.12)', border: '1px solid rgba(91,191,181,0.3)', color: 'var(--globant-green)', cursor: aiRecLoading ? 'default' : 'pointer', opacity: aiRecLoading ? 0.7 : 1 }}>
                  {aiRecLoading ? '⏳ Analizando...' : aiRec ? '🔄 Regenerar' : '✨ Generar'}
                </button>
              </div>
              {aiRec && (
                <div style={{ borderTop: '1px solid rgba(91,191,181,0.15)', paddingTop: 10 }}>
                  {/* Rendered content — one paragraph per line, bold markdown */}
                  <div style={{ fontSize: 12, color: 'var(--globant-muted)', lineHeight: 1.8 }}>
                    {aiRec.split('\n').filter(l => l.trim()).map((line, i) => (
                      <p key={i} style={{ margin: '0 0 8px 0' }}>{renderMd(line)}</p>
                    ))}
                  </div>
                  {/* Action button */}
                  {cfg && (
                    <button onClick={handleAction}
                      style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, padding: '7px 16px', borderRadius: 8, background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color, cursor: 'pointer', width: '100%', justifyContent: 'center' }}>
                      {cfg.icon} {cfg.label} →
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* ── Gmail panel ── */}
        {stkEmail && gmailConnected && (
          <div style={{ marginBottom: 16, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--globant-border)', borderRadius: 10, padding: '10px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--globant-text)' }}>✉️ Emails con {F(stakeholder,'Name')}</span>
              <button
                onClick={() => { if (!showGmailPanel) loadGmailMsgs(); setShowGmailPanel(p => !p); }}
                style={{ fontSize: 11, fontWeight: 600, color: 'var(--globant-green)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                {showGmailPanel ? 'Ocultar' : 'Ver emails'}
              </button>
            </div>
            {showGmailPanel && (
              <div style={{ marginTop: 10 }}>
                {gmailLoading && <p style={{ fontSize: 12, color: 'var(--globant-muted)', textAlign: 'center', padding: '8px 0' }}>Cargando...</p>}
                {!gmailLoading && gmailMsgs.length === 0 && !selectedGmailMsg && (
                  <p style={{ fontSize: 12, color: 'var(--globant-muted)', textAlign: 'center', padding: '8px 0' }}>No hay emails con este contacto.</p>
                )}
                {!selectedGmailMsg && gmailMsgs.map(msg => (
                  <div key={msg.id} onClick={() => loadGmailMsg(msg.id)}
                    style={{ padding: '8px 10px', marginBottom: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--globant-border)', borderRadius: 8, cursor: 'pointer' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                      <span style={{ fontSize: 12, fontWeight: msg.unread ? 700 : 500, color: 'var(--globant-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
                        {msg.unread && <span style={{ display: 'inline-block', width: 6, height: 6, background: '#60a5fa', borderRadius: '50%', marginRight: 6, verticalAlign: 'middle' }} />}
                        {msg.subject || '(Sin asunto)'}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--globant-muted)', flexShrink: 0, marginLeft: 8 }}>
                        {msg.date ? new Date(msg.date).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) : ''}
                      </span>
                    </div>
                    <p style={{ fontSize: 11, color: 'var(--globant-muted)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{msg.snippet}</p>
                  </div>
                ))}
                {selectedGmailMsg && (
                  <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--globant-border)', borderRadius: 8, padding: '10px 12px' }}>
                    <button onClick={() => setSelectedGmailMsg(null)} style={{ fontSize: 11, color: 'var(--globant-muted)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 8, padding: 0 }}>← Volver</button>
                    {gmailMsgLoading ? <p style={{ fontSize: 12, color: 'var(--globant-muted)' }}>Cargando...</p> : (
                      <>
                        <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--globant-text)', marginBottom: 4 }}>{selectedGmailMsg.subject || '(Sin asunto)'}</p>
                        <p style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 2 }}>De: {selectedGmailMsg.from}</p>
                        <p style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 10 }}>{selectedGmailMsg.date}</p>
                        <p style={{ fontSize: 12, color: 'var(--globant-text)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{selectedGmailMsg.body?.slice(0, 2000)}</p>
                        <button
                          onClick={() => { if (onSend) onSend(stakeholder, 'Email', '', null, null, { threadId: selectedGmailMsg.threadId, replyToMessageId: selectedGmailMsg.id, subject: selectedGmailMsg.subject ? `Re: ${selectedGmailMsg.subject}` : '' }); }}
                          style={{ marginTop: 10, fontSize: 11, fontWeight: 600, padding: '5px 12px', borderRadius: 8, background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.3)', color: 'var(--globant-green)', cursor: 'pointer' }}>
                          ↩ Responder
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Interaction timeline */}
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: 'var(--globant-text)' }}>Interaction History</div>
        {sOutreach.length === 0 ? (
          <p style={{ color: 'var(--globant-muted)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>No interactions logged yet</p>
        ) : (
          <div style={{ position: 'relative', paddingLeft: 20 }}>
            {/* Timeline line */}
            <div style={{ position: 'absolute', left: 7, top: 8, bottom: 8, width: 2, background: 'var(--globant-border)' }} />
            {sOutreach.map((o, i) => {
              const channel = F(o, 'Channel');
              const status = F(o, 'Status');
              const message = F(o, 'Message');
              const notes = (F(o, 'Notes') || '').replace(/^(\[g[^\]]+\])+\s*/, '').trim();
              const dotColor = statusColor[status] || 'var(--globant-muted)';
              return (
                <div key={o.id || i} style={{ position: 'relative', marginBottom: 12, paddingBottom: 12, borderBottom: i < sOutreach.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                  {/* Timeline dot */}
                  <div style={{ position: 'absolute', left: -16, top: 6, width: 10, height: 10, borderRadius: '50%', background: dotColor, border: '2px solid var(--globant-dark)' }} />
                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 14 }}>{channelIcon[channel] || '📋'}</span>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{F(o, 'Activity Name') || channel || 'Activity'}</span>
                      {status && <span className={`badge ${status === 'Replied' ? 'badge-green' : status === 'Meeting Scheduled' ? 'badge-blue' : 'badge-yellow'}`} style={{ fontSize: 9 }}>{status}</span>}
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>{formatDate(o.fields?.['Date'])}</span>
                  </div>
                  {/* Message content */}
                  {message && (
                    <div style={{ fontSize: 12, color: 'var(--globant-text)', lineHeight: 1.5, padding: '6px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 6, marginTop: 4, whiteSpace: 'pre-wrap' }}>
                      {message.length > 300 ? message.slice(0, 300) + '...' : message}
                    </div>
                  )}
                  {notes && (
                    <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 4, fontStyle: 'italic' }}>
                      📝 {notes.length > 200 ? notes.slice(0, 200) + '...' : notes}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>

    {showAIGenerator && (
      <AIMessageModal
        stakeholder={{
          ...stakeholder,
          fields: {
            ...stakeholder.fields,
            // Merge locally generated values so AI sees fresh pain points & LinkedIn news
            // even before a full refresh (field names may differ from Airtable schema)
            'Pain points': localPain || F(stakeholder, 'Pain Points (Generated)') || F(stakeholder, 'Pain points') || '',
            'Linkedin lates news': localLinkedin || F(stakeholder, 'LinkedIn News (Generated)') || F(stakeholder, 'Linkedin lates news') || '',
          }
        }}
        onClose={() => setShowAIGenerator(false)}
        onSend={(s, ch, msg, cc, evId) => { if (onSend) onSend(s, ch, msg, cc, evId); setShowAIGenerator(false); if (onRefresh) onRefresh(); }}
        onSuccess={() => { setShowAIGenerator(false); if (onRefresh) onRefresh(); }}
        data={{ ...allData, outreach: allData?.outreach || [] }}
      />
    )}
    </>
  );
}

// ============ CONFIG SCREEN ============

export default StakeholderHistoryModal;
