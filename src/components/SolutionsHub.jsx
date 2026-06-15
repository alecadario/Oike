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
import StakeholderHistoryModal from './StakeholderHistoryModal.jsx';


function SolutionsHub({ data, api, onLogActivity, onAddRecord, onDeleteRecord, goToAccount, navigateToSolId, clearNavigateSol }) {
  const { accounts, stakeholders, opportunities, outreach, solutions, campaigns = [], events = [] } = data;
  const isAdmin = CURRENT_USER?.role === 'admin';
  const [selectedSolId, setSelectedSolId] = useState('');
  const [repliesModalSolId, setRepliesModalSolId] = useState('');
  const [solHistoryStakeholder, setSolHistoryStakeholder] = useState(null);
  const [solStkFilterAccount, setSolStkFilterAccount] = useState(''); // ID of solution whose replies to show
  // Wrapper that keeps URL in sync with the selected solution
  const selectSol = useCallback((id) => {
    setSelectedSolId(id || '');
    setSolStkFilterAccount('');
    navSetUrl('solutionshub', id || null);
  }, []);

  React.useEffect(() => {
    if (navigateToSolId) {
      selectSol(navigateToSolId);
      if (clearNavigateSol) clearNavigateSol();
    }
  }, [navigateToSolId]);
  const [searchTerm, setSearchTerm] = useState('');
  const [solNotes, setSolNotes] = useState('');
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [aiRecsMap, setAiRecsMap] = useState({});
  // Prefer in-memory (just generated) → fallback to persisted Airtable field
  const aiRecs = (() => {
    if (!selectedSolId) return '';
    if (aiRecsMap[selectedSolId] !== undefined) return aiRecsMap[selectedSolId];
    const sol = solutions.find(s => s.id === selectedSolId);
    return sol ? (F(sol, 'AI Strategic Recommendations') || '') : '';
  })();
  const setAiRecs = (val) => setAiRecsMap(prev => ({ ...prev, [selectedSolId]: val }));
  const [loadingRecs, setLoadingRecs] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const [addAccSearch, setAddAccSearch] = useState('');
  const [solExecSummaryMap, setSolExecSummaryMap] = useState({});
  const [loadingSolSummary, setLoadingSolSummary] = useState(false);
  const solExecSummary = (() => {
    if (!selectedSolId) return '';
    if (solExecSummaryMap[selectedSolId] !== undefined) return solExecSummaryMap[selectedSolId];
    const sol = solutions.find(s => s.id === selectedSolId);
    return sol ? (F(sol, 'AI Exec Summary') || '') : '';
  })();
  const setSolExecSummary = (val) => setSolExecSummaryMap(prev => ({ ...prev, [selectedSolId]: val }));

  // ─── NEW SOLUTION ───
  const [showNewSol, setShowNewSol] = useState(false);
  const [newSolForm, setNewSolForm] = useState({ name: '', type: 'Service', description: '', price: '', keyMessage: '' });
  const [savingNewSol, setSavingNewSol] = useState(false);

  const SOL_TYPES = ['Product', 'SaaS', 'Service', 'Package', 'Retainer', 'Training'];

  // ─── EDIT SOLUTION (admin only) ───
  const [showEditSol, setShowEditSol] = useState(false);
  const [editSolForm, setEditSolForm] = useState({ name: '', type: 'Service', description: '', price: '', keyMessage: '' });
  const [savingEditSol, setSavingEditSol] = useState(false);

  const openEditSol = (sol) => {
    const desc = F(sol, 'Service | Solution Detail');
    const km = F(sol, 'Stakeholder Key Message');
    setEditSolForm({
      name: F(sol, 'Name') || '',
      type: F(sol, 'Type') || 'Service',
      description: typeof desc === 'string' ? desc : '',
      price: F(sol, 'Price') || '',
      keyMessage: typeof km === 'string' ? km : '',
    });
    setShowEditSol(true);
  };

  const handleEditSolution = async () => {
    if (!selectedSol || !editSolForm.name.trim()) return;
    setSavingEditSol(true);
    try {
      const a = api || new AirtableAPI();
      const fields = { 'Name': editSolForm.name.trim() };
      if (editSolForm.description.trim()) fields['Service | Solution Detail'] = editSolForm.description.trim();
      if (editSolForm.keyMessage.trim()) fields['Stakeholder Key Message'] = editSolForm.keyMessage.trim();
      if (editSolForm.type) fields['Type'] = editSolForm.type;
      if (editSolForm.price.trim()) fields['Price'] = editSolForm.price.trim();
      await a.updateRecord(TABLE_IDS.solutions, selectedSol.id, fields);
      setShowEditSol(false);
      if (onLogActivity) onLogActivity();
    } catch (e) { console.error(e); window.__oikeToast('Failed to save: ' + e.message, 'error'); }
    setSavingEditSol(false);
  };

  // ─── OPP EDIT (reuse CPBriefings modal pattern via navigate) ───
  const [solHubEditingOpp, setSolHubEditingOpp] = useState(null);
  const [solHubOppForm, setSolHubOppForm] = useState({});
  const [solHubOppSolIds, setSolHubOppSolIds] = useState([]);
  const [savingSolHubOpp, setSavingSolHubOpp] = useState(false);
  const OPP_STAGES_SH = OPP_STAGES;

  const openSolHubOppEdit = (opp) => {
    setSolHubOppForm({
      name: F(opp, 'Deal/Opp name') || '',
      description: F(opp, 'Description') || '',
      stage: F(opp, 'Stage') || '',
      value: opp.fields?.['Value'] ? String(opp.fields['Value']) : '',
      closeDate: opp.fields?.['close date'] ? String(opp.fields['close date']).slice(0, 10) : '',
      openingDate: opp.fields?.['Opening date'] ? String(opp.fields['Opening date']).slice(0, 10) : '',
      nextStep: F(opp, 'Next step') || '',
    });
    setSolHubOppSolIds(linkedIds(opp, 'Solutions'));
    setSolHubEditingOpp(opp);
  };

  const saveSolHubOpp = async () => {
    if (!solHubEditingOpp || !solHubOppForm.name.trim()) return;
    setSavingSolHubOpp(true);
    try {
      const a = api || new AirtableAPI();
      const fields = { 'Deal/Opp name': solHubOppForm.name.trim() };
      if (solHubOppForm.description.trim()) fields['Description'] = solHubOppForm.description.trim();
      if (solHubOppForm.stage) fields['Stage'] = solHubOppForm.stage;
      if (solHubOppForm.value && !isNaN(Number(solHubOppForm.value))) fields['Value'] = Number(solHubOppForm.value);
      if (solHubOppForm.closeDate) fields['close date'] = solHubOppForm.closeDate;
      if (solHubOppForm.openingDate) fields['Opening date'] = solHubOppForm.openingDate;
      if (solHubOppForm.nextStep.trim()) fields['Next step'] = solHubOppForm.nextStep.trim();
      if (solHubOppSolIds.length > 0) fields['Solutions'] = solHubOppSolIds;
      await a.updateRecord(TABLE_IDS.opportunities, solHubEditingOpp.id, fields);
      setSolHubEditingOpp(null);
      if (onLogActivity) onLogActivity();
    } catch (e) { console.error(e); window.__oikeToast('Failed to save: ' + e.message, 'error'); }
    setSavingSolHubOpp(false);
  };

  const deleteOppSH = async (opp) => {
    if (!confirm(`Delete "${F(opp, 'Deal/Opp name')}"? This cannot be undone.`)) return;
    if (onDeleteRecord) onDeleteRecord('opportunities', opp.id);
    const a = api || new AirtableAPI();
    a.deleteRecord(TABLE_IDS.opportunities, opp.id).catch(e => { console.error(e); if (onLogActivity) onLogActivity(); });
  };

  const handleCreateSolution = async () => {
    if (!newSolForm.name.trim()) { window.__oikeToast('Solution name is required', 'warning'); return; }
    setSavingNewSol(true);
    try {
      const a = api || new AirtableAPI();

      // Step 1: create with guaranteed-safe fields only
      const safeFields = { 'Name': newSolForm.name.trim() };
      if (newSolForm.description.trim()) safeFields['Service | Solution Detail'] = newSolForm.description.trim();
      if (newSolForm.keyMessage.trim()) safeFields['Stakeholder Key Message'] = newSolForm.keyMessage.trim();

      const newRec = await a.createRecord(TABLE_IDS.solutions, safeFields);

      // Step 2: try to save Type & Price separately — if fields don't exist in Airtable yet, fail silently
      if (newRec?.id && (newSolForm.type || newSolForm.price.trim())) {
        const extraFields = {};
        if (newSolForm.type) extraFields['Type'] = newSolForm.type;
        if (newSolForm.price.trim()) extraFields['Price'] = newSolForm.price.trim();
        a.updateRecord(TABLE_IDS.solutions, newRec.id, extraFields)
          .catch(e => console.warn('Type/Price fields not in Airtable yet:', e.message));
      }

      if (onAddRecord) onAddRecord('solutions', { ...safeFields, Type: newSolForm.type, Price: newSolForm.price });
      setShowNewSol(false);
      setNewSolForm({ name: '', type: 'Service', description: '', price: '', keyMessage: '' });
      if (onLogActivity) onLogActivity();
      if (newRec?.id) selectSol(newRec.id);
    } catch (e) {
      console.error(e);
      window.__oikeToast('Failed to create solution: ' + e.message, 'error');
    }
    setSavingNewSol(false);
  };

  const now = new Date();

  // Compute metrics per solution
  const solutionMetrics = useMemo(() => {
    return solutions.map(sol => {
      const solAccIds_explicit = linkedIds(sol, 'Accounts - New markets');
      const solOpps = opportunities.filter(o => linkedIds(o, 'Solutions').includes(sol.id));
      // Auto-derive accounts from linked opportunities + explicitly mapped accounts
      const oppAccIds = solOpps.flatMap(o => linkedIds(o, 'Account'));
      const solAccIds = [...new Set([...solAccIds_explicit, ...oppAccIds])];
      const solAccounts = accounts.filter(a => solAccIds.includes(a.id));
      const solStakeholderIds = new Set();
      solAccounts.forEach(a => linkedIds(a, 'Stakeholders').forEach(id => solStakeholderIds.add(id)));
      const solStakeholderIdSet = new Set();
      solAccounts.forEach(a => linkedIds(a, 'Stakeholders').forEach(id => solStakeholderIdSet.add(id)));
      const solOutreach = outreach.filter(o =>
        linkedIds(o, 'Account').some(aid => solAccIds.includes(aid)) ||
        linkedIds(o, 'Stakeholder').some(sid => solStakeholderIdSet.has(sid))
      );
      const openOpps = solOpps.filter(o => !['Closed Won','Closed/Won','Closed Lost','Closed/Lost','Closed/Canceled'].includes(F(o, 'Stage')));
      const pipeline = openOpps.reduce((s, o) => s + (o.fields?.['Value'] || 0), 0);
      // Count unique stakeholders who replied (not total reply messages)
      const repliedStkSet = new Set(solOutreach.filter(o => F(o,'Status')==='Replied').flatMap(o=>linkedIds(o,'Stakeholder')).filter(Boolean));
      const replied = repliedStkSet.size || solOutreach.filter(o => F(o,'Status')==='Replied').length;
      return {
        sol, id: sol.id, name: F(sol, 'Name') || 'Unnamed',
        accountCount: solAccounts.length,
        stakeholderCount: solStakeholderIds.size,
        outreachCount: solOutreach.length,
        oppCount: solOpps.length,
        openOppCount: openOpps.length,
        pipeline, replied,
      };
    }).sort((a, b) => b.accountCount - a.accountCount);
  }, [solutions, accounts, stakeholders, outreach, opportunities]);

  const filteredSolutions = (searchTerm
    ? solutionMetrics.filter(s => s.name.toLowerCase().includes(searchTerm.toLowerCase()))
    : [...solutionMetrics]
  ).sort((a, b) => a.name.localeCompare(b.name));

  // Selected solution detail
  const selectedSol = selectedSolId ? solutions.find(s => s.id === selectedSolId) : null;
  const selectedMetrics = selectedSolId ? solutionMetrics.find(m => m.id === selectedSolId) : null;

  // Load notes when selecting
  useEffect(() => {
    if (selectedSol) {
      const notes = F(selectedSol, 'Extra imput') || '';
      setSolNotes(typeof notes === 'string' ? notes : '');
    }
  }, [selectedSolId]);

  // Save notes
  const saveNotes = async () => {
    if (!selectedSol) return;
    setSavingNotes(true);
    try {
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.solutions, selectedSol.id, { 'Extra imput': notesValue });
      setSolNotes(notesValue);
      setEditingNotes(false);
      if (onLogActivity) onLogActivity();
    } catch (e) { console.error(e); window.__oikeToast('Failed to save notes', 'error'); }
    setSavingNotes(false);
  };

  // File upload + GPT summary
  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingFile(true);
    try {
      const text = await file.text();
      const prompt = `Summarize the following file content. Extract the most relevant points for a B2B sales team selling this solution. Be concise (5-8 bullets max).\n\nFile: ${file.name}\n\n${text.slice(0, 8000)}`;
      const summary = await callOpenAI({ prompt, temperature: 0.4, max_tokens: 500 });
      const entry = `\n\n📎 FILE: ${file.name} (uploaded ${new Date().toLocaleDateString('en-GB')})\n${summary}`;
      const updated = (solNotes || '') + entry;
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.solutions, selectedSol.id, { 'Extra imput': updated });
      setSolNotes(updated);
      if (onLogActivity) onLogActivity();
    } catch (e) { console.error(e); window.__oikeToast('File upload failed', 'error'); }
    setUploadingFile(false);
    e.target.value = '';
  };

  // Solution Executive Summary
  const generateSolExecSummary = async () => {
    if (!selectedSol || !selectedMetrics) return;
    setLoadingSolSummary(true);
    try {
      const solAccIds = linkedIds(selectedSol, 'Accounts - New markets');
      const solAccs = accounts.filter(a => solAccIds.includes(a.id));
      const solDetail = F(selectedSol, 'Service | Solution Detail') || '';
      const solDetailText = typeof solDetail === 'string' ? solDetail.slice(0, 800) : '';
      const solOpps = opportunities.filter(o => linkedIds(o, 'Solutions').includes(selectedSol.id));
      const openOpps = solOpps.filter(o => !['Closed Won','Closed/Won','Closed Lost','Closed/Lost','Closed/Canceled'].includes(F(o, 'Stage')));
      const wonOpps = solOpps.filter(o => ['Closed Won','Closed/Won'].includes(F(o, 'Stage')));

      // Account summaries with their news & stakeholder engagement
      const accSummaries = solAccs.slice(0, 15).map(a => {
        const aNews = F(a, 'Recent News') || '';
        const newsSnip = typeof aNews === 'string' ? aNews.slice(0, 150) : '';
        const aStks = stakeholders.filter(s => linkedIds(s, 'Account').includes(a.id));
        const aOutreach = outreach.filter(o => linkedIds(o, 'Account').includes(a.id));
        const replied = aOutreach.filter(o => F(o, 'Status') === 'Replied').length;
        const meetings = aOutreach.filter(o => F(o, 'Status') === 'Meeting Scheduled').length;
        const aOpps = solOpps.filter(o => linkedIds(o, 'Account').includes(a.id));
        return `- ${F(a, 'Account Name')} | ${F(a, 'Industry') || '?'} | Tier: ${F(a, 'Tier') || '?'} | Stakeholders: ${aStks.length} | Outreach: ${aOutreach.length} (${replied} replies, ${meetings} meetings) | Opps: ${aOpps.length}${newsSnip ? ` | News: ${newsSnip}` : ''}`;
      }).join('\n');

      // Stakeholder engagement across all accounts for this solution
      const allStkIds = new Set();
      solAccs.forEach(a => linkedIds(a, 'Stakeholders').forEach(id => allStkIds.add(id)));
      const solStks = stakeholders.filter(s => allStkIds.has(s.id));
      const stkSummary = solStks.slice(0, 20).map(s => {
        const sOut = outreach.filter(o => linkedIds(o, 'Stakeholder').includes(s.id));
        const hasReply = sOut.some(o => F(o, 'Status') === 'Replied');
        const hasMeeting = sOut.some(o => F(o, 'Status') === 'Meeting Scheduled');
        const pain = F(s, 'Pain Points (Generated)') || F(s, 'Pain points') || '';
        const painStr = typeof pain === 'string' ? pain.slice(0, 80) : '';
        const status = hasMeeting ? 'Meeting' : hasReply ? 'Replied' : sOut.length > 0 ? `${sOut.length}x, no reply` : 'Not contacted';
        const accName = resolveLinked(s, 'Account', accounts, 'Account Name')[0] || '?';
        return `- ${F(s, 'Name')} (${F(s, 'Role') || '?'}, ${accName}) — ${status}${painStr ? ` | Pain: ${painStr}` : ''}`;
      }).join('\n');

      // Non-mapped accounts as potential targets
      const nonMapped = accounts.filter(a => !solAccIds.includes(a.id) && linkedIds(a, 'Stakeholders').length > 0);
      const potentialStr = nonMapped.slice(0, 8).map(a => `- ${F(a, 'Account Name')} | ${F(a, 'Industry') || '?'} | Tier: ${F(a, 'Tier') || '?'}`).join('\n');

      const prompt = `You are a senior B2B sales strategist for ${COMPANY_PROFILE.companyName}. Create an EXECUTIVE SUMMARY for this SOLUTION to help a BDR understand the full picture and plan next moves.

SOLUTION: ${F(selectedSol, 'Name')}
DETAIL: ${solDetailText || 'Not available'}
NOTES: ${(solNotes || '').slice(0, 600) || 'None'}

METRICS:
- Accounts mapped: ${selectedMetrics.accountCount}
- Stakeholders: ${selectedMetrics.stakeholderCount}
- Total outreach: ${selectedMetrics.outreachCount}
- Replies: ${selectedMetrics.replied}
- Open opps: ${selectedMetrics.openOppCount} | Won: ${wonOpps.length}
- Pipeline: $${selectedMetrics.pipeline.toLocaleString()}

ACCOUNTS USING THIS SOLUTION:
${accSummaries || 'None'}

TOP STAKEHOLDERS:
${stkSummary || 'None'}

OPEN OPPORTUNITIES:
${openOpps.map(o => `- ${F(o, 'Deal/Opp name')}: Stage=${F(o, 'Stage')}, Value=${o.fields?.['Value'] || 'N/A'}, Next=${F(o, 'Next step') || 'N/A'}`).join('\n') || 'None'}

POTENTIAL NEW ACCOUNTS (not yet mapped):
${potentialStr || 'None'}

Write the Executive Summary with these sections (use ### headers):

### 🛠️ Solution Overview
2-3 sentences: What this solution does, its key value prop for ${COMPANY_PROFILE.market || 'your target market'}, and current positioning status.

### 📊 Traction & Pipeline
2-3 sentences: How is this solution performing? Accounts engaged, outreach results, reply rates, meetings, pipeline value. What's working and what's not.

### 🎯 Top Accounts & Engagement
3-4 sentences: Which accounts are most engaged or promising? Where are we closest to closing? Who's gone cold? Name specific accounts and stakeholders.

### 🔥 Key Pain Points & Triggers
2-3 sentences: Common pain points across stakeholders for this solution. What market triggers or news make this solution relevant right now?

### 📈 Expansion Opportunities
2-3 sentences: Which non-mapped accounts could be good targets? What industries or verticals are underrepresented?

### ⚡ Immediate Actions
4-5 bullet points: Specific things to do THIS WEEK. Name stakeholders, suggest outreach channels, reference concrete triggers.

Be specific. Use real names from the data. No generic advice. Under 350 words total.`;

      const summary = await callOpenAI({ prompt, temperature: 0.7, max_tokens: 800 }) || 'Could not generate summary.';
      setSolExecSummary(summary);
      // Persist to Airtable (fire and forget — in-memory is source of truth for this session)
      if (selectedSol && !selectedSol.id.startsWith('tmp_')) {
        const a = api || new AirtableAPI();
        a.updateRecord(TABLE_IDS.solutions, selectedSol.id, { 'AI Exec Summary': summary })
          .then(() => { if (onLogActivity) onLogActivity(); })
          .catch(e => console.warn('[exec summary] Airtable save failed (kept in memory):', e.message));
      }
    } catch (e) {
      console.error(e);
      window.__oikeToast('Failed to generate. Error: ' + (e.message || 'unknown error'), 'error');
    }
    setLoadingSolSummary(false);
  };

  // AI Recommendations
  const generateRecs = async () => {
    if (!selectedSol || !selectedMetrics) return;
    setLoadingRecs(true);
    try {
      const solAccIds_exp = linkedIds(selectedSol, 'Accounts - New markets');
      const solOpps_ai = opportunities.filter(o => linkedIds(o, 'Solutions').includes(selectedSol.id));
      const solAccIds = [...new Set([...solAccIds_exp, ...solOpps_ai.flatMap(o => linkedIds(o, 'Account'))])];
      const solAccounts = accounts.filter(a => solAccIds.includes(a.id));
      const solDetail = F(selectedSol, 'Service | Solution Detail') || '';
      const solDetailText = typeof solDetail === 'string' ? solDetail.slice(0, 500) : '';
      const keyMsg = F(selectedSol, 'Stakeholder Key Message') || '';
      const keyMsgText = typeof keyMsg === 'string' ? keyMsg.slice(0, 300) : Array.isArray(keyMsg) ? keyMsg.join(', ').slice(0, 300) : '';

      const accSummaries = solAccounts.slice(0, 15).map(a => {
        const aOutreach = outreach.filter(o => linkedIds(o, 'Account').includes(a.id));
        const aOpps = opportunities.filter(o => linkedIds(o, 'Account').includes(a.id));
        const lastOut = aOutreach.sort((x, y) => new Date(y.fields?.['Date'] || 0) - new Date(x.fields?.['Date'] || 0))[0];
        const daysSince = lastOut ? Math.floor((now - new Date(lastOut.fields?.['Date'])) / (1000*60*60*24)) : null;
        return `${F(a, 'Account Name')} | ${F(a, 'Industry') || '?'} | Tier: ${F(a, 'Tier') || '?'} | Outreach: ${aOutreach.length} | Last: ${daysSince !== null ? daysSince + 'd ago' : 'Never'} | Opps: ${aOpps.length}`;
      }).join('\n');

      // Accounts NOT using this solution (potential targets)
      const nonSolAccounts = accounts.filter(a => !solAccIds.includes(a.id) && linkedIds(a, 'Stakeholders').length > 0);
      const potentialTargets = nonSolAccounts.slice(0, 10).map(a => `${F(a, 'Account Name')} | ${F(a, 'Industry') || '?'} | Tier: ${F(a, 'Tier') || '?'} | Stakeholders: ${linkedIds(a, 'Stakeholders').length}`).join('\n');

      const prompt = `You are a senior B2B sales strategist for ${COMPANY_PROFILE.companyName} (${COMPANY_PROFILE.services}).

SOLUTION: ${F(selectedSol, 'Name')}
Detail: ${solDetailText || 'Not available'}
Key Message: ${keyMsgText || 'Not available'}
Notes: ${(solNotes || '').slice(0, 500) || 'None'}

CURRENT ACCOUNTS USING THIS SOLUTION (${solAccounts.length}):
${accSummaries || 'None'}

METRICS:
- Accounts: ${selectedMetrics.accountCount}
- Stakeholders reached: ${selectedMetrics.stakeholderCount}
- Total outreach: ${selectedMetrics.outreachCount}
- Replies: ${selectedMetrics.replied}
- Open opportunities: ${selectedMetrics.openOppCount}
- Pipeline value: $${selectedMetrics.pipeline.toLocaleString()}

POTENTIAL TARGET ACCOUNTS (not yet using this solution):
${potentialTargets || 'None'}

Provide strategic recommendations in these 4 sections (use ### headers):

### 🎯 Expansion Opportunities
Which current accounts should we deepen? Which potential accounts should we pitch this solution to and why?

### 💬 Messaging Strategy
What angles and pain points should we lead with? Tailored by industry if relevant.

### ⚠️ Risk & Gaps
What's weak? Stale accounts, low reply rates, missing stakeholder coverage?

### 📋 Next Actions
Top 5 specific, actionable steps to grow this solution's pipeline in the next 2 weeks.`;

      const recs = await callOpenAI({ prompt, temperature: 0.6, max_tokens: 1200 }) || 'No recommendations generated.';
      setAiRecs(recs);
      // Persist to Airtable (fire and forget)
      if (selectedSol && !selectedSol.id.startsWith('tmp_')) {
        const a = api || new AirtableAPI();
        a.updateRecord(TABLE_IDS.solutions, selectedSol.id, { 'AI Strategic Recommendations': recs })
          .then(() => { if (onLogActivity) onLogActivity(); })
          .catch(e => console.warn('[ai recs] Airtable save failed (kept in memory):', e.message));
      }
    } catch (e) { console.error(e); window.__oikeToast('Failed to generate recommendations', 'error'); }
    setLoadingRecs(false);
  };

  // Combined: generate both Executive Summary + AI Recommendations at once
  const generateAll = () => Promise.all([generateSolExecSummary(), generateRecs()]);

  // ── Markdown helpers (shared by AI Recs + Exec Summary) ──
  // Parse inline **bold** → React nodes
  const renderInlineMd = (text) => {
    const parts = [];
    const regex = /\*\*(.+?)\*\*/g;
    let lastIndex = 0;
    let match;
    let key = 0;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) parts.push(<span key={key++}>{text.slice(lastIndex, match.index)}</span>);
      parts.push(<strong key={key++} style={{ fontWeight: 700, color: 'var(--globant-text)' }}>{match[1]}</strong>);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) parts.push(<span key={key++}>{text.slice(lastIndex)}</span>);
    return parts.length ? parts : text;
  };

  // Parse block-level markdown (paragraphs, bullets, numbered lists)
  const renderMdBlocks = (text) => {
    if (!text) return null;
    const lines = text.split('\n');
    const blocks = [];
    let listBuffer = null; // { type: 'ul' | 'ol', items: [] }
    const flushList = () => { if (listBuffer) { blocks.push(listBuffer); listBuffer = null; } };
    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) { flushList(); return; }
      const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
      const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);
      if (bullet) {
        if (!listBuffer || listBuffer.type !== 'ul') { flushList(); listBuffer = { type: 'ul', items: [] }; }
        listBuffer.items.push(bullet[1]);
      } else if (numbered) {
        if (!listBuffer || listBuffer.type !== 'ol') { flushList(); listBuffer = { type: 'ol', items: [] }; }
        listBuffer.items.push(numbered[1]);
      } else {
        flushList();
        blocks.push({ type: 'p', text: trimmed });
      }
    });
    flushList();
    return blocks.map((blk, i) => {
      if (blk.type === 'p') return <p key={i} style={{ margin: '0 0 8px 0' }}>{renderInlineMd(blk.text)}</p>;
      if (blk.type === 'ul') return <ul key={i} style={{ margin: '0 0 8px 0', paddingLeft: 18 }}>{blk.items.map((it, j) => <li key={j} style={{ marginBottom: 4 }}>{renderInlineMd(it)}</li>)}</ul>;
      if (blk.type === 'ol') return <ol key={i} style={{ margin: '0 0 8px 0', paddingLeft: 18 }}>{blk.items.map((it, j) => <li key={j} style={{ marginBottom: 4 }}>{renderInlineMd(it)}</li>)}</ol>;
      return null;
    });
  };

  // Render AI recs with section cards
  const renderRecs = (text) => {
    if (!text) return null;
    const sections = text.split(/###\s+/).filter(Boolean);
    const sectionStyles = [
      { bg: 'rgba(74,222,128,0.06)', border: '#4ade80', color: '#4ade80' },
      { bg: 'rgba(96,165,250,0.06)', border: '#60a5fa', color: '#60a5fa' },
      { bg: 'rgba(251,191,36,0.06)', border: '#fbbf24', color: '#fbbf24' },
      { bg: 'rgba(91,191,181,0.06)', border: '#BFD730', color: '#BFD730' },
    ];
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {sections.map((sec, i) => {
          const lines = sec.trim().split('\n');
          const title = lines[0].replace(/\*\*/g, '');
          const body = lines.slice(1).join('\n').trim();
          const st = sectionStyles[i % sectionStyles.length];
          return (
            <div key={i} style={{ padding: '14px', borderRadius: 10, background: st.bg, borderLeft: `3px solid ${st.border}` }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: st.color, marginBottom: 8 }}>{title}</div>
              <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--globant-text)' }}>{renderMdBlocks(body)}</div>
            </div>
          );
        })}
      </div>
    );
  };

  // ─── ADD ACCOUNT TO SOLUTION ───
  const addAccountToSolution = async (accountId) => {
    if (!api || !selectedSol) return;
    setAddingAccount(true);
    try {
      const currentAccIds = linkedIds(selectedSol, 'Accounts - New markets');
      if (currentAccIds.includes(accountId)) {
        setShowAddAccount(false);
        setAddAccSearch('');
        setAddingAccount(false);
        return;
      }
      const newAccIds = [...currentAccIds, accountId];
      // Airtable expects array of string IDs for multipleRecordLinks (same format as addSolutionToAccount)
      await api.updateRecord(TABLE_IDS.solutions, selectedSol.id, { 'Accounts - New markets': newAccIds });
      setShowAddAccount(false);
      setAddAccSearch('');
      if (onLogActivity) onLogActivity();
    } catch (e) {
      console.error('[addAccountToSolution] Error:', e);
      window.__oikeToast('Error adding account: ' + (e.message || 'unknown'), 'error');
    }
    setAddingAccount(false);
  };

  // ─── DETAIL VIEW ───
  if (selectedSol && selectedMetrics) {
    const solAccIds_explicit = linkedIds(selectedSol, 'Accounts - New markets');
    const solOpps = opportunities.filter(o => linkedIds(o, 'Solutions').includes(selectedSol.id));
    // Auto-derive accounts from linked opportunities + explicitly mapped accounts
    const oppAccIds = solOpps.flatMap(o => linkedIds(o, 'Account'));
    const solAccIds = [...new Set([...solAccIds_explicit, ...oppAccIds])];
    const solAccounts = accounts.filter(a => solAccIds.includes(a.id));
    const solStakeholders = [];
    solAccounts.forEach(a => {
      linkedIds(a, 'Stakeholders').forEach(sid => {
        const s = stakeholders.find(st => st.id === sid);
        if (s) solStakeholders.push({ s, account: a });
      });
    });
    const solOutreach = outreach.filter(o => linkedIds(o, 'Account').some(aid => solAccIds.includes(aid)));
    const openOpps = solOpps.filter(o => !['Closed Won','Closed/Won','Closed Lost','Closed/Lost','Closed/Canceled'].includes(F(o, 'Stage')));

    // Notes rendering
    const renderNotes = (text) => {
      if (!text) return null;
      const parts = text.split(/(📎 FILE:.*?)(?=\n📎 FILE:|$)/s).filter(Boolean);
      return parts.map((part, i) => {
        if (part.startsWith('📎 FILE:')) {
          return (
            <div key={i} style={{ padding: '8px 10px', background: 'rgba(96,165,250,0.06)', borderRadius: 6, border: '1px solid rgba(96,165,250,0.15)', marginBottom: 6, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
              {part}
            </div>
          );
        }
        return <div key={i} style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', marginBottom: 6 }}>{part}</div>;
      });
    };

    const solType = F(selectedSol, 'Type') || '';
    const solPrice = F(selectedSol, 'Price') || '';
    const typeColor = solType === 'Service' ? '#60a5fa' : solType === 'Product' ? '#4ade80' : solType === 'Retainer' ? 'var(--globant-accent)' : solType === 'Consulting' ? '#fbbf24' : '#60a5fa';

    return (
      <React.Fragment>
      <div>
        {/* Edit Solution Modal (admin only) */}
        {showEditSol && isAdmin && (() => {
          const iStyle = { width: '100%', padding: '8px 10px', background: 'var(--globant-input)', border: '1px solid var(--globant-border)', borderRadius: 6, color: 'var(--globant-text)', fontSize: 13, boxSizing: 'border-box' };
          const lStyle = { fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', display: 'block' };
          return (
            <div className="modal-overlay" onClick={() => setShowEditSol(false)}>
              <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                  <h3 style={{ margin: 0 }}>✏️ Edit Solution</h3>
                  <button onClick={() => setShowEditSol(false)} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div>
                    <label style={lStyle}>Name *<InfoTip text="The commercial name of this solution as it will appear in the app and to clients." /></label>
                    <input style={iStyle} value={editSolForm.name} onChange={e => setEditSolForm(p => ({ ...p, name: e.target.value }))} autoFocus />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <label style={lStyle}>Type<InfoTip text="Product = one-time purchase. SaaS = subscription. Service = done-for-you. Package = bundled. Retainer = ongoing. Training = education." /></label>
                      <select style={iStyle} value={editSolForm.type} onChange={e => setEditSolForm(p => ({ ...p, type: e.target.value }))}>
                        {SOL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={lStyle}>Price<InfoTip text="The price or pricing range shown in the app. E.g. '$149/mo', 'From $5,000', or 'Custom'." /></label>
                      <input style={iStyle} value={editSolForm.price} onChange={e => setEditSolForm(p => ({ ...p, price: e.target.value }))} placeholder="e.g. $149/mo" />
                    </div>
                  </div>
                  <div>
                    <label style={lStyle}>Description<InfoTip text="A clear description of what this solution delivers, who it's for, and what problem it solves." /></label>
                    <textarea style={{ ...iStyle, minHeight: 80, resize: 'vertical' }} value={editSolForm.description} onChange={e => setEditSolForm(p => ({ ...p, description: e.target.value }))} />
                  </div>
                  <div>
                    <label style={lStyle}>Key Message for Stakeholders<InfoTip text="The one-line value statement you want stakeholders to remember. Used in AI-generated outreach and briefs." /></label>
                    <textarea style={{ ...iStyle, minHeight: 60, resize: 'vertical' }} value={editSolForm.keyMessage} onChange={e => setEditSolForm(p => ({ ...p, keyMessage: e.target.value }))} />
                  </div>
                  <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                    <button className="action-btn btn-ghost" onClick={() => setShowEditSol(false)}>Cancel</button>
                    <button className="action-btn btn-primary" onClick={handleEditSolution} disabled={savingEditSol || !editSolForm.name.trim()}>
                      {savingEditSol ? '⏳ Saving...' : '✅ Save Changes'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <button className="action-btn btn-ghost" style={{ fontSize: 11, marginBottom: 8 }} onClick={() => selectSol('')}>← Back to Offering</button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0 }}>🛠️ {F(selectedSol, 'Name')}</h1>
              {solType && <span style={{ background: `${typeColor}20`, color: typeColor, border: `1px solid ${typeColor}50`, borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 700 }}>{solType}</span>}
              {solPrice && <span style={{ background: 'rgba(91,191,181,0.15)', color: 'var(--globant-green)', border: '1px solid rgba(91,191,181,0.3)', borderRadius: 6, padding: '3px 12px', fontSize: 13, fontWeight: 700 }}>💰 {solPrice}</span>}
            </div>
            {F(selectedSol, 'Service | Solution Detail') && (
              <p style={{ marginTop: 6, color: 'var(--globant-muted)', fontSize: 13, lineHeight: 1.5 }}>{typeof F(selectedSol, 'Service | Solution Detail') === 'string' ? F(selectedSol, 'Service | Solution Detail') : ''}</p>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {isAdmin && <button className="action-btn btn-ghost" style={{ fontSize: 12 }} onClick={() => openEditSol(selectedSol)}>✏️ Edit</button>}
            <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={generateAll} disabled={loadingRecs || loadingSolSummary}>
              {(loadingRecs || loadingSolSummary) ? '⏳ Generating...' : (aiRecs || solExecSummary) ? '🔄 Regenerate Analysis' : '✨ Generate AI Analysis'}
            </button>
          </div>
        </div>

        {/* About — description + key message */}
        {(F(selectedSol, 'Service | Solution Detail') || F(selectedSol, 'Stakeholder Key Message')) && (
          <div className="card" style={{ marginBottom: 20, display: 'grid', gridTemplateColumns: F(selectedSol, 'Service | Solution Detail') && F(selectedSol, 'Stakeholder Key Message') ? '1fr 1fr' : '1fr', gap: 20 }}>
            {F(selectedSol, 'Service | Solution Detail') && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>📋 Description</div>
                <div style={{ fontSize: 13, color: 'var(--globant-text)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{typeof F(selectedSol, 'Service | Solution Detail') === 'string' ? F(selectedSol, 'Service | Solution Detail') : ''}</div>
              </div>
            )}
            {F(selectedSol, 'Stakeholder Key Message') && (
              <div style={{ background: 'rgba(91,191,181,0.06)', borderRadius: 8, padding: '14px 16px', border: '1px solid rgba(91,191,181,0.2)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-green)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>💬 Key Message for Stakeholders</div>
                <div style={{ fontSize: 13, color: 'var(--globant-text)', lineHeight: 1.6, fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>{typeof F(selectedSol, 'Stakeholder Key Message') === 'string' ? F(selectedSol, 'Stakeholder Key Message') : ''}</div>
              </div>
            )}
          </div>
        )}

        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 14, marginBottom: 24 }}>
          <div className="card" style={{ textAlign: 'center', padding: '16px 12px', background: 'linear-gradient(135deg, rgba(91,191,181,0.12) 0%, rgba(91,191,181,0.03) 100%)' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--globant-green)', lineHeight: 1 }}>{selectedMetrics.accountCount}</div>
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Accounts</div>
          </div>
          <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--globant-info)', lineHeight: 1 }}>{selectedMetrics.stakeholderCount}</div>
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Stakeholders</div>
          </div>
          <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--globant-success)', lineHeight: 1 }}>{selectedMetrics.outreachCount}</div>
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Outreach</div>
          </div>
          <div className="card" style={{ textAlign: 'center', padding: '16px 12px', cursor: selectedMetrics.replied > 0 ? 'pointer' : 'default' }}
            onClick={() => selectedMetrics.replied > 0 && setRepliesModalSolId(selectedSolId)}>
            <div style={{ fontSize: 28, fontWeight: 800, color: selectedMetrics.replied > 0 ? '#4ade80' : 'var(--globant-muted)', lineHeight: 1 }}>{selectedMetrics.replied}</div>
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Replies {selectedMetrics.replied > 0 && <span style={{ color: '#4ade80' }}>↗</span>}</div>
          </div>
          <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--globant-warning)', lineHeight: 1 }}>{selectedMetrics.openOppCount}</div>
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Open Opps</div>
          </div>
          <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--globant-green)', lineHeight: 1 }}>{selectedMetrics.pipeline > 0 ? '$' + (selectedMetrics.pipeline / 1000).toFixed(0) + 'K' : '$0'}</div>
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Pipeline</div>
          </div>
        </div>

        {/* AI Recommendations */}
        {aiRecs && (
          <div className="card" style={{ borderLeft: '3px solid var(--globant-green)', marginBottom: 16 }}>
            <div className="card-header"><h3>🤖 AI Strategic Recommendations</h3></div>
            {renderRecs(aiRecs)}
          </div>
        )}

        {/* Executive Summary */}
        <div className="card" style={{ borderLeft: '3px solid var(--globant-accent)', marginBottom: 16 }}>
          <div className="card-header">
            <h3>🧠 Executive Summary</h3>
          </div>
          {!solExecSummary && !loadingSolSummary && (
            <p style={{ color: 'var(--globant-muted)', fontSize: 12, fontStyle: 'italic' }}>
              Click "Generate AI Analysis" above to generate a strategic briefing with solution traction, top accounts, pain points, and immediate actions.
            </p>
          )}
          {solExecSummary && (() => {
            const lines = solExecSummary.split('\n').filter(l => l.trim());
            return (
              <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                {lines.map((line, i) => {
                  if (line.startsWith('### ')) return <h4 key={i} style={{ margin: '12px 0 4px', fontSize: 13, fontWeight: 700, color: 'var(--globant-text)' }}>{renderInlineMd(line.replace('### ', '').replace(/\*\*/g, ''))}</h4>;
                  if (line.startsWith('- ') || line.startsWith('* ')) return <div key={i} style={{ paddingLeft: 12, marginBottom: 3, position: 'relative' }}><span style={{ position: 'absolute', left: 0 }}>•</span>{renderInlineMd(line.slice(2))}</div>;
                  const numMatch = line.match(/^(\d+[.)]\s+)(.+)$/);
                  if (numMatch) return <div key={i} style={{ paddingLeft: 18, marginBottom: 3, position: 'relative' }}><span style={{ position: 'absolute', left: 0, color: 'var(--globant-muted)' }}>{numMatch[1]}</span>{renderInlineMd(numMatch[2])}</div>;
                  return <p key={i} style={{ margin: '3px 0', color: 'var(--globant-text-secondary)' }}>{renderInlineMd(line)}</p>;
                })}
              </div>
            );
          })()}
        </div>

        {/* Linked Campaigns + Events */}
        {(() => {
          const linkedCampaignIds = linkedIds(selectedSol, 'Campaign');
          const linkedEventIds = linkedIds(selectedSol, 'Events');
          const linkedCampaigns = campaigns.filter(c => linkedCampaignIds.includes(c.id));
          const linkedEvents = events.filter(e => linkedEventIds.includes(e.id));
          if (linkedCampaigns.length === 0 && linkedEvents.length === 0) return null;
          return (
            <div className="card" style={{ borderLeft: '3px solid #a78bfa', marginBottom: 16, padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <h3 style={{ margin: 0, fontSize: 14 }}>🔗 Linked Campaigns & Events</h3>
                <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>{linkedCampaigns.length + linkedEvents.length} linked</span>
              </div>

              {linkedCampaigns.length > 0 && (
                <div style={{ marginBottom: linkedEvents.length > 0 ? 12 : 0 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>📣 Campaigns ({linkedCampaigns.length})</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {linkedCampaigns.map(c => {
                      const cType = F(c, 'Type') || '';
                      const cStatus = F(c, 'Status') || '';
                      const typeIcon = { 'White Paper': '📄', 'News / Article': '📰', 'Product Launch': '🚀', 'Case Study': '📊', 'Cold Outreach': '🎯' }[cType] || '📣';
                      const statusColor = { 'Draft': '#a78bfa', 'Active': '#4ade80', 'Paused': '#fbbf24', 'Completed': '#60a5fa' }[cStatus] || '#666';
                      return (
                        <div key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.25)', fontSize: 12 }}>
                          <span>{typeIcon}</span>
                          <span style={{ fontWeight: 600 }}>{F(c, 'Name')}</span>
                          {cStatus && <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 10, background: `${statusColor}22`, color: statusColor, fontWeight: 700, border: `1px solid ${statusColor}44` }}>{cStatus}</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {linkedEvents.length > 0 && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>🎤 Events ({linkedEvents.length})</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {linkedEvents.map(e => {
                      const evStart = e.fields?.['Starting'];
                      const dateStr = evStart ? new Date(evStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
                      const isPast = evStart ? new Date(evStart) < new Date() : false;
                      return (
                        <div key={e.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.25)', fontSize: 12, opacity: isPast ? 0.6 : 1 }}>
                          <span>🎤</span>
                          <span style={{ fontWeight: 600 }}>{F(e, 'Event Name')}</span>
                          {dateStr && <span style={{ fontSize: 10, color: 'var(--globant-muted)' }}>· {dateStr}{isPast ? ' (past)' : ''}</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* Two columns: Notes + Accounts */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          {/* Notes & Files */}
          <div className="card" style={{ borderLeft: '3px solid var(--globant-info)' }}>
            <div className="card-header">
              <h3>📝 Solution Notes & Files</h3>
              <div style={{ display: 'flex', gap: 6 }}>
                {!editingNotes ? (
                  <button className="action-btn btn-ghost" style={{ fontSize: 10 }} onClick={() => { setEditingNotes(true); setNotesValue(solNotes); }}>
                    {solNotes ? '✏️ Edit' : '➕ Add Notes'}
                  </button>
                ) : (
                  <>
                    <button className="action-btn btn-primary" style={{ fontSize: 10 }} onClick={saveNotes} disabled={savingNotes}>{savingNotes ? '⏳' : '💾 Save'}</button>
                    <button className="action-btn btn-ghost" style={{ fontSize: 10 }} onClick={() => setEditingNotes(false)}>Cancel</button>
                  </>
                )}
                <label style={{ cursor: 'pointer' }}>
                  <input type="file" accept=".csv,.txt,.json,.md,.html,.tsv,.xml,.pdf" style={{ display: 'none' }} onChange={handleFileUpload} />
                  <span className="action-btn btn-ghost" style={{ fontSize: 10, padding: '3px 10px', display: 'inline-block' }}>{uploadingFile ? '⏳ Processing...' : '📎 Upload File'}</span>
                </label>
              </div>
            </div>
            {/* Airtable Attachments from Info field */}
            {(() => {
              const attachments = selectedSol?.fields?.['Info'];
              if (!attachments || !Array.isArray(attachments) || attachments.length === 0) return null;
              return (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>📁 Attached Files ({attachments.length})</div>
                  {attachments.map((att, i) => (
                    <a key={i} href={att.url} target="_blank" rel="noopener noreferrer"
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'rgba(96,165,250,0.06)', borderRadius: 6, border: '1px solid rgba(96,165,250,0.15)', marginBottom: 4, textDecoration: 'none', color: 'var(--globant-text)', fontSize: 12, cursor: 'pointer' }}>
                      <span style={{ fontSize: 16 }}>{att.type?.includes('pdf') ? '📄' : att.type?.includes('image') ? '🖼️' : att.type?.includes('sheet') || att.type?.includes('excel') ? '📊' : att.type?.includes('presentation') || att.type?.includes('powerpoint') ? '📽️' : '📎'}</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.filename || 'Untitled'}</span>
                      <span style={{ fontSize: 10, color: 'var(--globant-muted)', whiteSpace: 'nowrap' }}>{att.size ? (att.size > 1048576 ? (att.size / 1048576).toFixed(1) + ' MB' : (att.size / 1024).toFixed(0) + ' KB') : ''}</span>
                      <span style={{ fontSize: 10, color: 'var(--globant-info)' }}>Open ↗</span>
                    </a>
                  ))}
                </div>
              );
            })()}
            {/* Notes */}
            {editingNotes ? (
              <textarea className="input-field" style={{ width: '100%', minHeight: 150, resize: 'vertical', fontFamily: 'inherit', fontSize: 12 }}
                value={notesValue} onChange={e => setNotesValue(e.target.value)}
                placeholder="Add notes about this solution — positioning, competitive intel, key differentiators..." />
            ) : (
              solNotes ? (
                <FileNotesRenderer
                  notes={solNotes}
                  accentColor="var(--globant-info)"
                  onUpdateNotes={async (updated) => {
                    const a = api || new AirtableAPI();
                    await a.updateRecord(TABLE_IDS.solutions, selectedSol.id, { 'Extra imput': updated });
                    if (onLogActivity) onLogActivity();
                  }}
                />
              ) : <p style={{ color: 'var(--globant-muted)', fontSize: 12, fontStyle: 'italic' }}>No notes yet. Add context, competitive intel, or upload files.</p>
            )}
          </div>

          {/* Accounts using this solution */}
          <div className="card" style={{ borderLeft: '3px solid var(--globant-green)' }}>
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>🏢 Accounts ({solAccounts.length})</h3>
              <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 12px' }}
                onClick={() => { setShowAddAccount(!showAddAccount); setAddAccSearch(''); }}>
                {showAddAccount ? '✕ Cancel' : '+ Add Account'}
              </button>
            </div>
            {showAddAccount && (() => {
              const available = accounts.filter(a => !solAccIds.includes(a.id));
              const filtered = addAccSearch
                ? available.filter(a => (F(a, 'Account Name') || '').toLowerCase().includes(addAccSearch.toLowerCase()))
                : available.slice(0, 20);
              return (
                <div style={{ marginBottom: 12, padding: '10px 12px', background: 'rgba(91,191,181,0.06)', borderRadius: 8 }}>
                  <input className="input-field" style={{ width: '100%', marginBottom: 8, fontSize: 12 }}
                    placeholder="Search accounts to add..." value={addAccSearch}
                    onChange={e => setAddAccSearch(e.target.value)} autoFocus />
                  <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                    {filtered.length === 0 ? (
                      <p style={{ fontSize: 11, color: 'var(--globant-muted)', textAlign: 'center', padding: 8 }}>
                        {addAccSearch ? 'No matching accounts found' : 'All accounts already mapped'}
                      </p>
                    ) : filtered.map(a => (
                      <div key={a.id} style={{ padding: '8px 10px', marginBottom: 4, borderRadius: 6, background: 'rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', border: '1px solid rgba(91,191,181,0.1)' }}
                        onClick={() => !addingAccount && addAccountToSolution(a.id)}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 12 }}>{F(a, 'Account Name')}</div>
                          <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>
                            {[F(a, 'Industry'), F(a, 'Tier')].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        <span style={{ fontSize: 11, color: 'var(--globant-green)', fontWeight: 600 }}>
                          {addingAccount ? '...' : '+ Add'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
            {solAccounts.length === 0 && !showAddAccount ? (
              <p style={{ color: 'var(--globant-muted)', fontSize: 12 }}>No accounts mapped to this solution yet.</p>
            ) : solAccounts.length > 0 ? (
              <div style={{ maxHeight: 350, overflowY: 'auto' }}>
                {solAccounts.map(a => {
                  const aOut = outreach.filter(o => linkedIds(o, 'Account').includes(a.id));
                  const lastOut = aOut.sort((x, y) => new Date(y.fields?.['Date'] || 0) - new Date(x.fields?.['Date'] || 0))[0];
                  const daysSince = lastOut ? Math.floor((now - new Date(lastOut.fields?.['Date'])) / (1000*60*60*24)) : null;
                  const aOpps = opportunities.filter(o => linkedIds(o, 'Account').includes(a.id)).length;
                  const stCount = linkedIds(a, 'Stakeholders').length;
                  return (
                    <div key={a.id} style={{ padding: '10px 12px', marginBottom: 6, borderRadius: 8, background: 'rgba(91,191,181,0.04)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13, cursor: goToAccount ? 'pointer' : 'default', color: goToAccount ? 'var(--globant-green)' : 'inherit' }}
                          onClick={() => goToAccount && goToAccount(a.id)}
                          title="Open account overview">{F(a, 'Account Name')} →</div>
                        <div style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'flex', gap: 8, marginTop: 2 }}>
                          {F(a, 'Industry') && <span>{F(a, 'Industry')}</span>}
                          {F(a, 'Tier') && <span className="badge badge-accent" style={{ fontSize: 9 }}>{F(a, 'Tier')}</span>}
                          <span>{stCount} contacts</span>
                          <span>{aOut.length} touches</span>
                          {aOpps > 0 && <span style={{ color: 'var(--globant-info)' }}>{aOpps} opps</span>}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', fontSize: 11 }}>
                        {daysSince !== null ? (
                          <span style={{ fontWeight: 600, color: daysSince > 14 ? '#ef4444' : daysSince > 7 ? '#fbbf24' : '#60a5fa' }}>
                            {daysSince}d ago
                          </span>
                        ) : (
                          <span className="badge" style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444', fontSize: 10 }}>Never</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>

        {/* Opp Edit Modal */}
        {solHubEditingOpp && (() => {
          const iStyle = { width: '100%', padding: '7px 10px', background: 'var(--globant-input)', border: '1px solid var(--globant-border)', borderRadius: 6, color: 'var(--globant-text)', fontSize: 13, boxSizing: 'border-box' };
          const lStyle = { fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', display: 'block' };
          return (
            <div className="modal-overlay" onClick={() => setSolHubEditingOpp(null)}>
              <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <h3 style={{ margin: 0 }}>✏️ Edit Opportunity</h3>
                  <button onClick={() => setSolHubEditingOpp(null)} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div><label style={lStyle}>Name *</label><input style={iStyle} value={solHubOppForm.name} onChange={e => setSolHubOppForm(p => ({ ...p, name: e.target.value }))} /></div>
                  <div><label style={lStyle}>Description</label><textarea style={{ ...iStyle, minHeight: 60, resize: 'vertical' }} value={solHubOppForm.description} onChange={e => setSolHubOppForm(p => ({ ...p, description: e.target.value }))} /></div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div><label style={lStyle}>Stage</label>
                      <select style={iStyle} value={solHubOppForm.stage} onChange={e => setSolHubOppForm(p => ({ ...p, stage: e.target.value }))}>
                        <option value="">Select...</option>
                        {OPP_STAGES_SH.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div><label style={lStyle}>Value ($)</label><input style={iStyle} type="number" value={solHubOppForm.value} onChange={e => setSolHubOppForm(p => ({ ...p, value: e.target.value }))} /></div>
                    <div><label style={lStyle}>Opening Date</label><input style={iStyle} type="date" value={solHubOppForm.openingDate} onChange={e => setSolHubOppForm(p => ({ ...p, openingDate: e.target.value }))} /></div>
                    <div><label style={lStyle}>Close Date</label><input style={iStyle} type="date" value={solHubOppForm.closeDate} onChange={e => setSolHubOppForm(p => ({ ...p, closeDate: e.target.value }))} /></div>
                  </div>
                  <div><label style={lStyle}>Next Step</label><input style={iStyle} value={solHubOppForm.nextStep} onChange={e => setSolHubOppForm(p => ({ ...p, nextStep: e.target.value }))} /></div>
                  <div>
                    <label style={lStyle}>Offering</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                      {solHubOppSolIds.map(sid => {
                        const sol = data.solutions.find(s => s.id === sid);
                        return sol ? <span key={sid} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', display: 'flex', alignItems: 'center', gap: 5 }}>{F(sol, 'Name')} <span style={{ cursor: 'pointer' }} onClick={() => setSolHubOppSolIds(p => p.filter(i => i !== sid))}>✕</span></span> : null;
                      })}
                    </div>
                    <select style={iStyle} value="" onChange={e => { if (e.target.value && !solHubOppSolIds.includes(e.target.value)) setSolHubOppSolIds(p => [...p, e.target.value]); }}>
                      <option value="">+ Add solution...</option>
                      {data.solutions.filter(s => !solHubOppSolIds.includes(s.id)).map(s => <option key={s.id} value={s.id}>{F(s, 'Name')}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                  <button className="action-btn btn-primary" style={{ flex: 1 }} onClick={saveSolHubOpp} disabled={savingSolHubOpp}>{savingSolHubOpp ? '⏳ Saving...' : '💾 Save'}</button>
                  <button className="action-btn btn-ghost" onClick={() => setSolHubEditingOpp(null)}>Cancel</button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Stakeholders + Opportunities */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {/* Stakeholders */}
          <div className="card">
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>👥 Stakeholders ({solStakeholders.length})</h3>
              {solAccounts.length > 1 && (
                <select
                  className="input-field"
                  style={{ fontSize: 11, padding: '4px 8px', maxWidth: 200 }}
                  value={solStkFilterAccount}
                  onChange={e => setSolStkFilterAccount(e.target.value)}
                >
                  <option value="">All accounts</option>
                  {solAccounts.map(a => (
                    <option key={a.id} value={a.id}>{F(a, 'Account Name')}</option>
                  ))}
                </select>
              )}
            </div>
            {solStakeholders.length === 0 ? (
              <p style={{ color: 'var(--globant-muted)', fontSize: 12 }}>No stakeholders in mapped accounts.</p>
            ) : (
              <div style={{ maxHeight: 350, overflowY: 'auto' }}>
                <table className="data-table">
                  <thead><tr><th>Name</th><th>Role</th><th>Account</th><th>Influence</th><th>Last Contact</th></tr></thead>
                  <tbody>
                    {solStakeholders.filter(({ account }) => !solStkFilterAccount || account.id === solStkFilterAccount).map(({ s, account }) => {
                      const sOut = outreach.filter(o => linkedIds(o, 'Stakeholder').includes(s.id))
                        .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
                      const lastTouch = sOut[0];
                      const daysSince = lastTouch ? Math.floor((now - new Date(lastTouch.fields?.['Date'])) / (1000*60*60*24)) : null;
                      return (
                        <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => setSolHistoryStakeholder(s)}>
                          <td style={{ fontWeight: 600, fontSize: 12, color: 'var(--globant-green)' }}>{F(s, 'Name')}{F(s, 'Last name') ? ` ${F(s, 'Last name')}` : ''}</td>
                          <td style={{ fontSize: 11 }}>{F(s, 'Role')}</td>
                          <td style={{ fontSize: 11 }}>{F(account, 'Account Name')}</td>
                          <td>{F(s, 'Level of Influence') ? <span className="badge badge-accent" style={{ fontSize: 9 }}>{F(s, 'Level of Influence')}</span> : '—'}</td>
                          <td style={{ fontSize: 11 }}>
                            {daysSince !== null ? (
                              <span style={{ fontWeight: 600, color: daysSince > 14 ? '#ef4444' : daysSince > 7 ? '#fbbf24' : '#60a5fa' }}>{daysSince}d</span>
                            ) : <span style={{ color: '#ef4444', fontSize: 10 }}>Never</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Opportunities */}
          <div className="card">
            <div className="card-header"><h3>💰 Opportunities ({solOpps.length})</h3></div>
            {solOpps.length === 0 ? (
              <p style={{ color: 'var(--globant-muted)', fontSize: 12 }}>No opportunities linked to accounts with this solution.</p>
            ) : (
              <div style={{ maxHeight: 350, overflowY: 'auto' }}>
                {solOpps.map(o => {
                  const stage = F(o, 'Stage') || 'Unknown';
                  const isOpen = !['Closed Won','Closed/Won','Closed Lost','Closed/Lost','Closed/Canceled'].includes(stage);
                  const val = o.fields?.['Value'] || 0;
                  const stageColor = stage.toLowerCase().includes('won') ? '#4ade80' : stage.toLowerCase().includes('lost') || stage.toLowerCase().includes('cancel') ? '#ef4444' : isOpen ? '#60a5fa' : '#8888A8';
                  return (
                    <div key={o.id} style={{ padding: '8px 10px', marginBottom: 4, borderRadius: 6, background: `${stageColor}08`, borderLeft: `3px solid ${stageColor}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 12 }}>{F(o, 'Deal/Opp name')}</div>
                        <span className="badge" style={{ background: `${stageColor}20`, color: stageColor, fontSize: 9 }}>{stage}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {val > 0 && <span style={{ fontWeight: 700, fontSize: 12, color: stageColor }}>${(val / 1000).toFixed(0)}K</span>}
                        <button title="Edit" onClick={() => openSolHubOppEdit(o)} style={{ fontSize: 11, padding: '2px 7px', borderRadius: 5, border: '1px solid var(--globant-border)', background: 'rgba(255,255,255,0.04)', color: 'var(--globant-muted)', cursor: 'pointer' }}>✏️</button>
                        <button title="Delete" onClick={() => deleteOppSH(o)} style={{ fontSize: 11, padding: '2px 7px', borderRadius: 5, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', color: '#ef4444', cursor: 'pointer' }}>🗑</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Stakeholder card modal */}
      {solHistoryStakeholder && (
        <StakeholderHistoryModal
          stakeholder={solHistoryStakeholder}
          outreach={outreach}
          accounts={accounts}
          onClose={() => setSolHistoryStakeholder(null)}
          onRefresh={onLogActivity}
          onAddRecord={onAddRecord}
          allData={data}
          onSend={(s, ch, msg, cc, evId) => {
            // Open channel synchronously first
            const email = F(s, 'Email') || '';
            const phone = F(s, 'Phone number') || '';
            const linkedin = F(s, 'LinkedIn') || '';
            let subject = '', body = msg || '';
            if (ch === 'Email') {
              const lines = body.split('\n');
              const si = lines.findIndex(l => /^subject:/i.test(l.trim()));
              if (si !== -1) { subject = lines[si].replace(/^subject:\s*/i,'').trim(); body = lines.slice(si+1).join('\n').trim(); }
            }
            const ccParam = cc?.length > 0 ? `&cc=${encodeURIComponent(cc.join(','))}` : '';
            if (ch === 'WhatsApp' && phone) window.open(`https://wa.me/${String(phone).replace(/[^0-9+]/g,'')}?text=${encodeURIComponent(msg||'')}`, '_blank');
            else if (ch === 'Email' && email) window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}${ccParam}`, '_blank');
            else if (ch === 'LinkedIn' && linkedin) { navigator.clipboard.writeText(msg||'').catch(()=>{}); window.open(linkedin, '_blank'); }
            else if (ch === 'Call' && phone) window.open(`tel:${phone}`, '_self');
            // Then log to Airtable
            const companyIds = linkedIds(s, 'Account');
            const name = F(s, 'Name') || '';
            const a = api || new AirtableAPI();
            a.createRecord(TABLE_IDS.outreach, {
              'Activity Name': `${ch} to ${name} — ${new Date().toLocaleDateString('en-US')}`,
              'Account': companyIds, 'Stakeholder': [s.id],
              'Channel': ch, 'Date': new Date().toISOString(),
              'Status': 'Sent', 'Message': msg || '',
              'Notes': `Sent from Offering Hub${evId ? ' (event invite)' : ''}`,
              'Logged By': CURRENT_USER?.name || '',
            })
              .then(async () => {
                // If event referenced, register stakeholder as invited (bidirectional link auto-syncs both sides)
                if (evId) {
                  const ev = data.events?.find(e => e.id === evId);
                  const currentInvited = ev ? linkedIds(ev, 'Stakeholders invited') : [];
                  await a.updateRecord(TABLE_IDS.events, evId, {
                    'Stakeholders invited': [...new Set([...currentInvited, s.id])],
                  }).catch(e => console.error('[SolutionsHub onSend] event invite update failed:', e));
                }
                await activateAccountIfNeeded(a, companyIds, data.accounts);
                await updateStakeholderStatus(a, s.id, 'Contacted', data.stakeholders);
              })
              .then(() => { if (onLogActivity) onLogActivity(); })
              .catch(console.error);
          }}
        />
      )}

      {/* Replies modal — shared with list view */}
      {repliesModalSolId && (() => {
        const rSol = solutions.find(s => s.id === repliesModalSolId);
        const rName = rSol ? (F(rSol, 'Name') || 'Solution') : 'Solution';
        const rAccIds_exp = linkedIds(rSol, 'Accounts - New markets');
        const rOpps2 = opportunities.filter(o => linkedIds(o, 'Solutions').includes(repliesModalSolId));
        const rAccIds = [...new Set([...rAccIds_exp, ...rOpps2.flatMap(o => linkedIds(o, 'Account'))])];
        const rStkIds2 = new Set();
        accounts.filter(a => rAccIds.includes(a.id)).forEach(a => linkedIds(a, 'Stakeholders').forEach(id => rStkIds2.add(id)));
        const rReplies = outreach
          .filter(o => F(o, 'Status') === 'Replied' && (
            linkedIds(o, 'Account').some(aid => rAccIds.includes(aid)) ||
            linkedIds(o, 'Stakeholder').some(sid => rStkIds2.has(sid))
          ))
          .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
        return (
          <div className="modal-overlay" onClick={() => setRepliesModalSolId('')}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 620, maxHeight: '80vh', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h3 style={{ margin: 0 }}>💬 Replies — {rName}</h3>
                <button onClick={() => setRepliesModalSolId('')} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
              </div>
              {rReplies.length === 0
                ? <p style={{ color: 'var(--globant-muted)', fontSize: 13 }}>No replied outreach found for this solution.</p>
                : rReplies.map(o => {
                  const stkIds = linkedIds(o, 'Stakeholder');
                  const stk = stakeholders.find(s => stkIds.includes(s.id));
                  const stkName = stk ? `${F(stk, 'Name') || ''} ${F(stk, 'Last name') || ''}`.trim() : 'Unknown';
                  const stkRole = stk ? (F(stk, 'Role') || '') : '';
                  const accId2 = linkedIds(o, 'Account')[0];
                  const acc2 = accId2 ? accounts.find(a => a.id === accId2) : null;
                  const accName2 = acc2 ? (F(acc2, 'Account Name') || '') : '';
                  const date = o.fields?.['Date'] ? new Date(o.fields['Date']).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
                  const notes = F(o, 'Notes') || F(o, 'Message') || '';
                  const channel = F(o, 'Channel') || '';
                  return (
                    <div key={o.id} style={{ padding: '12px 14px', marginBottom: 10, borderRadius: 8, background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.2)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                        <div>
                          <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--globant-text)' }}>{stkName}</span>
                          {stkRole && <span style={{ fontSize: 11, color: 'var(--globant-muted)', marginLeft: 8 }}>{stkRole}</span>}
                          {accName2 && <span style={{ fontSize: 11, color: 'var(--globant-green)', marginLeft: 8 }}>· {accName2}</span>}
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                          {channel && <span className="badge badge-accent" style={{ fontSize: 9 }}>{channel}</span>}
                          <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>{date}</span>
                        </div>
                      </div>
                      {notes && <div style={{ fontSize: 12, color: 'var(--globant-text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>{notes.slice(0, 400)}{notes.length > 400 ? '…' : ''}</div>}
                    </div>
                  );
                })}
            </div>
          </div>
        );
      })()}
      </React.Fragment>
    );
  }

  // ─── LIST VIEW ───
  return (
    <React.Fragment>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>Offering Hub</h1>
          <p>Explore your offering, track adoption across accounts, and get strategic recommendations</p>
        </div>
        {isAdmin && <button className="action-btn btn-primary" style={{ fontSize: 12, padding: '8px 16px', marginTop: 4 }}
          onClick={() => { setShowNewSol(true); setNewSolForm({ name: '', type: 'Service', description: '', price: '', keyMessage: '' }); }}>
          ➕ New Solution
        </button>}
      </div>

      {/* New Solution Modal */}
      {showNewSol && (() => {
        const iStyle = { width: '100%', padding: '8px 10px', background: 'var(--globant-input)', border: '1px solid var(--globant-border)', borderRadius: 6, color: 'var(--globant-text)', fontSize: 13, boxSizing: 'border-box' };
        const lStyle = { fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', display: 'block' };
        return (
          <div className="modal-overlay" onClick={() => setShowNewSol(false)}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                <h3 style={{ margin: 0 }}>🛠️ New Solution</h3>
                <button onClick={() => setShowNewSol(false)} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label style={lStyle}>Name *<InfoTip text="The commercial name of this solution as it will appear in the app and to clients." /></label>
                  <input style={iStyle} value={newSolForm.name} onChange={e => setNewSolForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. AI Process Automation" autoFocus />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={lStyle}>Type<InfoTip text="Product = one-time purchase. SaaS = subscription software. Service = done-for-you work. Package = bundled offering. Retainer = ongoing engagement. Training = education program." /></label>
                    <select style={iStyle} value={newSolForm.type} onChange={e => setNewSolForm(p => ({ ...p, type: e.target.value }))}>
                      {SOL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={lStyle}>Price (optional)<InfoTip text="The price or pricing range shown in the app. E.g. '$149/mo', 'From $5,000', or 'Custom'." /></label>
                    <input style={iStyle} value={newSolForm.price} onChange={e => setNewSolForm(p => ({ ...p, price: e.target.value }))} placeholder="e.g. $5,000/mo or From $20K" />
                  </div>
                </div>
                <div>
                  <label style={lStyle}>Description<InfoTip text="A clear description of what this solution delivers, who it's for, and what problem it solves." /></label>
                  <textarea style={{ ...iStyle, minHeight: 80, resize: 'vertical' }} value={newSolForm.description} onChange={e => setNewSolForm(p => ({ ...p, description: e.target.value }))} placeholder="What does this solution do? What problem does it solve?" />
                </div>
                <div>
                  <label style={lStyle}>Key Message for Stakeholders (optional)<InfoTip text="The one-line value statement you want stakeholders to walk away with. This gets used in AI-generated outreach." /></label>
                  <textarea style={{ ...iStyle, minHeight: 60, resize: 'vertical' }} value={newSolForm.keyMessage} onChange={e => setNewSolForm(p => ({ ...p, keyMessage: e.target.value }))} placeholder="Main value prop to pitch to decision-makers..." />
                </div>
                <div style={{ fontSize: 11, color: 'var(--globant-muted)', background: 'rgba(96,165,250,0.08)', borderRadius: 6, padding: '8px 12px' }}>
                  💡 To enable Type and Price fields, add them in your Airtable Solutions table: <strong>Type</strong> (Single line text) and <strong>Price</strong> (Single line text)
                </div>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button className="action-btn btn-ghost" onClick={() => setShowNewSol(false)}>Cancel</button>
                  <button className="action-btn btn-primary" onClick={handleCreateSolution} disabled={savingNewSol || !newSolForm.name.trim()}>
                    {savingNewSol ? '⏳ Creating...' : '✅ Create Solution'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="filters-row" style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 }}>
        <input className="input-field" style={{ maxWidth: 350 }} placeholder="Search offering..." value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)} />
        <span style={{ fontSize: 12, color: 'var(--globant-muted)' }}>{solutions.length} solutions</span>
      </div>

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 24 }}>
        <div className="card" style={{ textAlign: 'center', padding: '18px 12px', background: 'linear-gradient(135deg, rgba(91,191,181,0.12) 0%, rgba(91,191,181,0.03) 100%)' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--globant-green)', lineHeight: 1 }}>{solutions.length}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Total Offering</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '18px 12px' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--globant-info)', lineHeight: 1 }}>{solutionMetrics.reduce((s, m) => s + m.accountCount, 0)}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Total Mappings</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '18px 12px' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--globant-success)', lineHeight: 1 }}>{solutionMetrics.reduce((s, m) => s + m.outreachCount, 0)}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Total Outreach</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '18px 12px' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--globant-warning)', lineHeight: 1 }}>${(solutionMetrics.reduce((s, m) => s + m.pipeline, 0) / 1000).toFixed(0)}K</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Total Pipeline</div>
        </div>
      </div>

      {/* Solutions list */}
      <div className="card">
        <div className="card-header"><h3>Offering</h3></div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr>
              <th>Offering</th>
              <th>Type</th>
              <th>Price</th>
              <th style={{ textAlign: 'center' }}>Accounts</th>
              <th style={{ textAlign: 'center' }}>Stakeholders</th>
              <th style={{ textAlign: 'center' }}>Outreach</th>
              <th style={{ textAlign: 'center' }}>Replies</th>
              <th style={{ textAlign: 'center' }}>Open Opps</th>
              <th style={{ textAlign: 'right' }}>Pipeline</th>
            </tr></thead>
            <tbody>
              {filteredSolutions.map(m => {
                const solType = F(m.sol, 'Type') || '';
                const solPrice = F(m.sol, 'Price') || '';
                const typeColor = solType === 'Service' ? 'badge-blue' : solType === 'Product' ? 'badge-green' : solType === 'Retainer' ? 'badge-accent' : solType === 'Consulting' ? 'badge-yellow' : 'badge-blue';
                return (
                  <tr key={m.id} onClick={() => { selectSol(m.id); setSearchTerm(''); }} style={{ cursor: 'pointer' }}>
                    <td style={{ fontWeight: 600 }}>
                      {m.name}
                      {F(m.sol, 'Service | Solution Detail') && (
                        <div style={{ fontSize: 11, color: 'var(--globant-muted)', fontWeight: 400, marginTop: 2, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {typeof F(m.sol, 'Service | Solution Detail') === 'string' ? F(m.sol, 'Service | Solution Detail').slice(0, 80) : ''}
                        </div>
                      )}
                    </td>
                    <td>{solType ? <span className={`badge ${typeColor}`} style={{ fontSize: 10 }}>{solType}</span> : <span style={{ color: 'var(--globant-muted)', fontSize: 11 }}>—</span>}</td>
                    <td style={{ fontSize: 12, fontWeight: 600, color: solPrice ? 'var(--globant-green)' : 'var(--globant-muted)' }}>{solPrice || '—'}</td>
                    <td style={{ textAlign: 'center' }}>{m.accountCount}</td>
                    <td style={{ textAlign: 'center' }}>{m.stakeholderCount}</td>
                    <td style={{ textAlign: 'center' }}><span style={{ fontWeight: 700, color: m.outreachCount > 0 ? 'var(--globant-green)' : 'var(--globant-muted)' }}>{m.outreachCount}</span></td>
                    <td style={{ textAlign: 'center' }}>
                      {m.replied > 0
                        ? <span onClick={e => { e.stopPropagation(); setRepliesModalSolId(m.id); }} style={{ fontWeight: 700, color: 'var(--globant-success)', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' }}>{m.replied}</span>
                        : <span style={{ color: 'var(--globant-muted)' }}>0</span>}
                    </td>
                    <td style={{ textAlign: 'center' }}>{m.openOppCount > 0 ? <span className="badge badge-blue">{m.openOppCount}</span> : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{m.pipeline > 0 ? '$' + (m.pipeline / 1000).toFixed(0) + 'K' : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

    {/* ── Replies Modal ── */}
    {repliesModalSolId && (() => {
      const rSol = solutions.find(s => s.id === repliesModalSolId);
      const rName = rSol ? (F(rSol, 'Name') || 'Solution') : 'Solution';
      // Get accounts for this solution (explicit + from opps)
      const rAccIds_exp = linkedIds(rSol, 'Accounts - New markets');
      const rOpps = opportunities.filter(o => linkedIds(o, 'Solutions').includes(repliesModalSolId));
      const rAccIds = [...new Set([...rAccIds_exp, ...rOpps.flatMap(o => linkedIds(o, 'Account'))])];
      // Stakeholder IDs for this solution's accounts
      const rStkIds = new Set();
      accounts.filter(a => rAccIds.includes(a.id)).forEach(a => linkedIds(a, 'Stakeholders').forEach(id => rStkIds.add(id)));
      // Filter replied outreach: linked to solution accounts OR to stakeholders of those accounts
      const rReplies = outreach
        .filter(o => F(o, 'Status') === 'Replied' && (
          linkedIds(o, 'Account').some(aid => rAccIds.includes(aid)) ||
          linkedIds(o, 'Stakeholder').some(sid => rStkIds.has(sid))
        ))
        .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
      return (
        <div className="modal-overlay" onClick={() => setRepliesModalSolId('')}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 620, maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>💬 Replies — {rName}</h3>
              <button onClick={() => setRepliesModalSolId('')} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            {rReplies.length === 0
              ? <p style={{ color: 'var(--globant-muted)', fontSize: 13 }}>No replied outreach found for this solution.</p>
              : rReplies.map(o => {
                const stkIds = linkedIds(o, 'Stakeholder');
                const stk = stakeholders.find(s => stkIds.includes(s.id));
                const stkName = stk ? `${F(stk, 'Name') || ''} ${F(stk, 'Last name') || ''}`.trim() : 'Unknown';
                const stkRole = stk ? (F(stk, 'Role') || '') : '';
                const accIds = linkedIds(o, 'Account');
                const acc = accounts.find(a => accIds.includes(a.id));
                const accName = acc ? (F(acc, 'Account Name') || '') : '';
                const date = o.fields?.['Date'] ? new Date(o.fields['Date']).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
                const notes = F(o, 'Notes') || F(o, 'Message') || '';
                const channel = F(o, 'Channel') || '';
                return (
                  <div key={o.id} style={{ padding: '12px 14px', marginBottom: 10, borderRadius: 8, background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.2)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                      <div>
                        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--globant-text)' }}>{stkName}</span>
                        {stkRole && <span style={{ fontSize: 11, color: 'var(--globant-muted)', marginLeft: 8 }}>{stkRole}</span>}
                        {accName && <span style={{ fontSize: 11, color: 'var(--globant-green)', marginLeft: 8 }}>· {accName}</span>}
                      </div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                        {channel && <span className="badge badge-accent" style={{ fontSize: 9 }}>{channel}</span>}
                        <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>{date}</span>
                      </div>
                    </div>
                    {notes && <div style={{ fontSize: 12, color: 'var(--globant-text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>{notes.slice(0, 400)}{notes.length > 400 ? '…' : ''}</div>}
                  </div>
                );
              })}
          </div>
        </div>
      );
    })()}
    </React.Fragment>
  );
}

// ============ PROPOSALS HUB ============

export default SolutionsHub;
