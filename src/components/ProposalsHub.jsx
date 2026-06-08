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


function ProposalsHub({ data, api, onLogActivity, onAddRecord, onUpdateRecord, navigateToProposalId, clearNavigateProposal }) {
  const { accounts, stakeholders, solutions, opportunities, proposals = [] } = data;
  const isAdmin = CURRENT_USER?.role === 'admin';
  const [selectedId, setSelectedId]   = useState('');
  const [showNew, setShowNew]         = useState(false);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterAccountId, setFilterAccountId] = useState('');
  const [searchTerm, setSearchTerm]   = useState('');
  const [saving, setSaving]           = useState(false);
  const [form, setForm] = useState({ title:'', status:'Draft', amount:'', description:'', presentedDate:'', accountId:'', stakeholderIds:[], solutionIds:[], opportunityId:'', documentUrl:'' });
  const [accSearch, setAccSearch]     = useState('');
  const [solSearch, setSolSearch]     = useState('');
  const [stkSearch, setStkSearch]     = useState('');
  const [accOpen, setAccOpen]         = useState(false);
  const [solOpen, setSolOpen]         = useState(false);
  const [stkOpen, setStkOpen]         = useState(false);
  // Edit states
  const [showEdit, setShowEdit]       = useState(false);
  const [editForm, setEditForm]       = useState({});
  const [editSaving, setEditSaving]   = useState(false);
  const [editAccSearch, setEditAccSearch] = useState('');
  const [editSolSearch, setEditSolSearch] = useState('');
  const [editStkSearch, setEditStkSearch] = useState('');
  const [editAccOpen, setEditAccOpen] = useState(false);
  const [editSolOpen, setEditSolOpen] = useState(false);
  const [editStkOpen, setEditStkOpen] = useState(false);
  // Notes + PPT + AI states
  const [notes, setNotes]             = useState('');
  const [noteSaving, setNoteSaving]   = useState(false);
  const [pptText, setPptText]         = useState('');
  const [pptParsing, setPptParsing]   = useState(false);
  const [pptFileName, setPptFileName] = useState('');
  const [aiRec, setAiRec]             = useState('');
  const [aiLoading, setAiLoading]     = useState(false);
  const PROPOSAL_EXEC_LS_KEY = 'oike_proposal_exec_summaries';
  const [execSummary, setExecSummary]         = useState('');
  const [execSummaryLoading, setExecSummaryLoading] = useState(false);
  const [execSummarySaving, setExecSummarySaving]   = useState(false);
  // Proposal Generator wizard
  const [showGenerator, setShowGenerator] = useState(false);
  const [genStep, setGenStep]             = useState(1);
  const [genCopied, setGenCopied]         = useState(false);
  const [genGmail, setGenGmail]           = useState(false);
  const [genAccSearch, setGenAccSearch]   = useState('');
  const [genAccOpen, setGenAccOpen]       = useState(false);
  const [genStkOpen, setGenStkOpen]       = useState(false);
  const [genPolishing, setGenPolishing]   = useState(false);
  const _b = loadBranding();
  const DEFAULT_GEN = {
    slug:'', company:'', contact:'', contactTitle:'', industry:'',
    accountId:'', stakeholderId:'', language:'en',
    senderName:  _b.senderName  || CLIENT_CONFIG.name || '',
    senderLogo:  _b.senderLogo  || CLIENT_CONFIG.logo || '',
    senderEmail: _b.senderEmail || CURRENT_USER?.email || '',
    calendarLink: _b.calendarLink || '',
    accentColor: _b.accentColor || '#5BBFB5',
    darkColor:   _b.darkColor   || '#0D0D1A',
    discovery:'', pain1:'', pain2:'', pain3:'', goalQuote:'', rootProblem:'',
    option:'B',
    optionName:'',
    optionSubtitle:'',
    optionDesc:'',
    optionFeatures:[''],
    whySolution:'', nextStep1:'Discovery call to align on ICP and target accounts', nextStep2:'We build the economic proposal together', nextStep3:'Kick-off and system setup — week 1',
  };
  const [genForm, setGenForm] = useState(DEFAULT_GEN);
  const GF = (k) => genForm[k] || '';
  const setGF = (k, v) => setGenForm(p => ({...p, [k]: v}));

  // AI Polish for proposal generator — rewrites discovery fields in the selected proposal language
  const LANG_NAMES = { en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French' };
  const polishDiscovery = async () => {
    if (genPolishing) return;
    setGenPolishing(true);
    try {
      const lang = genForm.language || 'en';
      const langName = LANG_NAMES[lang] || 'English';
      const context = [
        genForm.discovery ? 'Discovery context: ' + genForm.discovery : '',
        genForm.pain1     ? 'Pain 1: '           + genForm.pain1     : '',
        genForm.pain2     ? 'Pain 2: '           + genForm.pain2     : '',
        genForm.pain3     ? 'Pain 3: '           + genForm.pain3     : '',
        genForm.goalQuote ? 'Client goal quote: '+ genForm.goalQuote : '',
        genForm.rootProblem? 'Root problem: '    + genForm.rootProblem: '',
      ].filter(Boolean).join('\n');
      if (!context.trim()) { setGenPolishing(false); return; }
      const prompt = 'You are a senior B2B sales consultant writing commercial proposals.\n' +
        'Rewrite the following raw discovery notes into sharp, professional ' + langName + ' suitable for a commercial proposal.\n' +
        'IMPORTANT: Your output MUST be entirely in ' + langName + '. Do not use any other language.\n' +
        'Keep each field short, punchy, and specific. Do not add fluff. Respond ONLY with a JSON object with these keys:\n' +
        '{"discovery":"...","pain1":"...","pain2":"...","pain3":"...","goalQuote":"...","rootProblem":"..."}\n\n' +
        'Raw notes:\n' + context;
      const raw = await callOpenAI({ prompt, temperature: 0.5, max_tokens: 900 });
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        setGenForm(p => ({
          ...p,
          discovery:   parsed.discovery   || p.discovery,
          pain1:       parsed.pain1        || p.pain1,
          pain2:       parsed.pain2        || p.pain2,
          pain3:       parsed.pain3        || p.pain3,
          goalQuote:   parsed.goalQuote    || p.goalQuote,
          rootProblem: parsed.rootProblem  || p.rootProblem,
        }));
      }
    } catch(e) { console.error('[polishDiscovery]', e); }
    setGenPolishing(false);
  };

  const polishSolution = async () => {
    if (genPolishing) return;
    setGenPolishing(true);
    try {
      const lang = genForm.language || 'en';
      const langName = LANG_NAMES[lang] || 'English';
      const context = [
        genForm.optionName    ? 'Solution name: '       + genForm.optionName    : '',
        genForm.optionDesc    ? 'Description: '         + genForm.optionDesc    : '',
        genForm.whySolution   ? 'Why this fits client: '+ genForm.whySolution   : '',
        genForm.company       ? 'Client company: '      + genForm.company       : '',
        genForm.pain1         ? 'Main pain: '           + genForm.pain1         : '',
      ].filter(Boolean).join('\n');
      if (!context.trim()) { setGenPolishing(false); return; }
      const prompt = 'You are a senior B2B sales consultant writing commercial proposals.\n' +
        'Improve the following solution section to be more persuasive and professional in ' + langName + '.\n' +
        'IMPORTANT: Your output MUST be entirely in ' + langName + '. Do not use any other language.\n' +
        'Keep language concrete, outcome-focused, and free of buzzwords. Respond ONLY with JSON:\n' +
        '{"optionDesc":"...","whySolution":"..."}\n\n' +
        'Current content:\n' + context;
      const raw = await callOpenAI({ prompt, temperature: 0.5, max_tokens: 600 });
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        setGenForm(p => ({
          ...p,
          optionDesc:  parsed.optionDesc  || p.optionDesc,
          whySolution: parsed.whySolution || p.whySolution,
        }));
      }
    } catch(e) { console.error('[polishSolution]', e); }
    setGenPolishing(false);
  };
  const OPTION_PRESETS = {
    A: { optionName:'Setup + Autonomy', optionSubtitle:'Platform only', optionDesc:'We set up the full system — ICP, accounts, stakeholders, sequences — and your team operates independently from month 2.', optionFeatures:['Full system setup','Access to the Oike platform','Team training (2 sessions)','Full operational independence'] },
    B: { optionName:'Setup + Advisory', optionSubtitle:'Platform + Ongoing support', optionDesc:'Everything in option A, plus monthly advisory sessions to optimize messages, review metrics and continuously improve the system.', optionFeatures:['Full system setup','Access to the Oike platform','Monthly optimization session','Metrics review & message refinement','Ongoing support via WhatsApp'] },
    C: { optionName:'Setup + I execute', optionSubtitle:'Full-service', optionDesc:'Full setup + monthly retainer where I run prospecting continuously as an external BDR embedded in your team.', optionFeatures:['Full system setup','Daily outreach execution','Pipeline management in Oike','Qualified opportunity handoff','Weekly activity report'] },
  };

  const STATUSES = ['Draft','Presented','Under Review','Accepted','Rejected','Expired'];
  const STATUS_COLOR = { Draft:'#9ca3af', Presented:'#60a5fa', 'Under Review':'#fb923c', Accepted:'#4ade80', Rejected:'#f87171', Expired:'#6b7280' };
  const STATUS_BG    = { Draft:'rgba(156,163,175,0.15)', Presented:'rgba(96,165,250,0.15)', 'Under Review':'rgba(251,146,60,0.15)', Accepted:'rgba(74,222,128,0.15)', Rejected:'rgba(248,113,113,0.15)', Expired:'rgba(107,114,128,0.15)' };

  const selected = selectedId ? proposals.find(p => p.id === selectedId) : null;

  useEffect(() => {
    if (navigateToProposalId) {
      setSelectedId(navigateToProposalId);
      navSetUrl('proposals', navigateToProposalId);
      if (clearNavigateProposal) clearNavigateProposal();
    }
  }, [navigateToProposalId, clearNavigateProposal]);

  useEffect(() => {
    try {
      const prefillAccId = sessionStorage.getItem('oike_proposal_prefill_account');
      if (prefillAccId && accounts.find(a => a.id === prefillAccId)) {
        setForm(f => ({ ...f, accountId: prefillAccId }));
        setShowNew(true);
        sessionStorage.removeItem('oike_proposal_prefill_account');
      }
    } catch {}
  }, [accounts.length]);

  // Sync notes + PPT + exec summary when switching presentation
  useEffect(() => {
    if (selectedId) {
      const p = proposals.find(x => x.id === selectedId);
      if (p) {
        setNotes(p.fields?.['Notes'] || '');
        setPptText(p.fields?.['PPT Content'] || '');
        // Try Airtable first, fall back to localStorage if field doesn't exist yet
        const airtableExec = p.fields?.['Executive Summary'] || '';
        if (airtableExec) {
          setExecSummary(airtableExec);
        } else {
          try {
            const stored = JSON.parse(localStorage.getItem(PROPOSAL_EXEC_LS_KEY) || '{}');
            setExecSummary(stored[selectedId] || '');
          } catch { setExecSummary(''); }
        }
        setPptFileName('');
        setAiRec('');
      }
    } else {
      setNotes(''); setPptText(''); setPptFileName(''); setAiRec(''); setExecSummary('');
    }
  }, [selectedId]);

  const selectProposal = useCallback((id) => {
    setSelectedId(id || '');
    navSetUrl('proposals', id || null);
  }, []);

  const filtered = useMemo(() => {
    let list = [...proposals];
    if (searchTerm) list = list.filter(p => (F(p,'Title')||'').toLowerCase().includes(searchTerm.toLowerCase()));
    if (filterStatus) list = list.filter(p => F(p,'Status') === filterStatus);
    if (filterAccountId) list = list.filter(p => linkedIds(p,'Account').includes(filterAccountId));
    return list.sort((a,b) => new Date(b.fields?.['Created']||0) - new Date(a.fields?.['Created']||0));
  }, [proposals, searchTerm, filterStatus, filterAccountId]);

  const resetForm = () => setForm({ title:'', status:'Draft', amount:'', description:'', presentedDate:'', accountId:'', stakeholderIds:[], solutionIds:[], opportunityId:'', documentUrl:'' });

  const handleCreate = async () => {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      const fields = { 'Title': form.title.trim(), 'Status': form.status };
      if (form.amount)        fields['Amount'] = parseFloat(form.amount);
      if (form.description.trim()) fields['Description'] = form.description.trim();
      if (form.presentedDate) fields['Presented Date'] = form.presentedDate;
      if (form.accountId)     fields['Account'] = [form.accountId];
      if (form.stakeholderIds.length) fields['Stakeholders'] = [...form.stakeholderIds];
      if (form.solutionIds.length)    fields['Solutions'] = [...form.solutionIds];
      if (form.opportunityId) fields['Opportunity'] = [form.opportunityId];
      if (form.documentUrl?.trim()) fields['Document'] = form.documentUrl.trim();
      const a = api || new AirtableAPI();
      const rec = await a.createRecord(TABLE_IDS.proposals, fields);
      if (onAddRecord) onAddRecord('proposals', fields);
      setShowNew(false);
      resetForm();
      if (onLogActivity) onLogActivity();
      try {
        const returnTo = sessionStorage.getItem('oike_return_to_account');
        if (returnTo) {
          const { accountId, tab } = JSON.parse(returnTo);
          sessionStorage.removeItem('oike_return_to_account');
          window.dispatchEvent(new CustomEvent('oike:navigate', { detail: { page: 'accounts', accountId, tab } }));
          return;
        }
      } catch {}
      if (rec?.id) selectProposal(rec.id);
    } catch(e) { console.error(e); window.__oikeToast('Error creating proposal', 'error'); }
    setSaving(false);
  };

  const openEdit = (p) => {
    const accId = linkedIds(p,'Account')[0] || '';
    const acc = accounts.find(a => a.id === accId);
    setEditForm({
      title: F(p,'Title') || '',
      status: F(p,'Status') || 'Draft',
      amount: p.fields?.['Amount'] ? String(p.fields['Amount']) : '',
      description: F(p,'Description') || '',
      presentedDate: F(p,'Presented Date') || '',
      accountId: accId,
      stakeholderIds: linkedIds(p,'Stakeholders'),
      solutionIds: linkedIds(p,'Solutions'),
      documentUrl: F(p,'Document') || '',
    });
    setEditAccSearch(acc ? (F(acc,'Account Name')||'') : '');
    setEditSolSearch(''); setEditStkSearch('');
    setShowEdit(true);
  };

  const handleEdit = async () => {
    if (!selected || !editForm.title.trim()) return;
    setEditSaving(true);
    try {
      const fields = { 'Title': editForm.title.trim(), 'Status': editForm.status };
      if (editForm.amount)           fields['Amount'] = parseFloat(editForm.amount);
      if (editForm.description.trim()) fields['Description'] = editForm.description.trim();
      if (editForm.presentedDate)    fields['Presented Date'] = editForm.presentedDate;
      fields['Account']      = editForm.accountId ? [editForm.accountId] : [];
      fields['Stakeholders'] = [...editForm.stakeholderIds];
      fields['Solutions']    = [...editForm.solutionIds];
      if (editForm.documentUrl.trim()) fields['Document'] = editForm.documentUrl.trim();
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.proposals, selected.id, fields);
      if (onUpdateRecord) onUpdateRecord('proposals', selected.id, fields);
      setShowEdit(false);
      if (onLogActivity) onLogActivity();
    } catch(e) { console.error(e); window.__oikeToast('Error saving proposal', 'error'); }
    setEditSaving(false);
  };

  const handleStatusChange = async (proposal, newStatus) => {
    try {
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.proposals, proposal.id, { 'Status': newStatus });
      if (onUpdateRecord) onUpdateRecord('proposals', proposal.id, { 'Status': newStatus });
      if (onLogActivity) onLogActivity();
    } catch(e) { console.error(e); }
  };

  const saveNotes = async () => {
    if (!selected) return;
    setNoteSaving(true);
    try {
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.proposals, selected.id, { 'Notes': notes });
      if (onUpdateRecord) onUpdateRecord('proposals', selected.id, { 'Notes': notes });
    } catch(e) { console.error('[saveNotes]', e); }
    setNoteSaving(false);
  };

  const saveExecSummary = async (val) => {
    const v = val !== undefined ? val : execSummary;
    if (!selected) return;
    // Always persist to localStorage first so it survives navigation even if Airtable field is missing
    try {
      const stored = JSON.parse(localStorage.getItem(PROPOSAL_EXEC_LS_KEY) || '{}');
      stored[selected.id] = v;
      localStorage.setItem(PROPOSAL_EXEC_LS_KEY, JSON.stringify(stored));
    } catch {}
    setExecSummarySaving(true);
    try {
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.proposals, selected.id, { 'Executive Summary': v });
      if (onUpdateRecord) onUpdateRecord('proposals', selected.id, { 'Executive Summary': v });
    } catch(e) {
      if (e.message && e.message.includes('Unknown field')) {
        console.warn('[saveExecSummary] Field "Executive Summary" not found in Airtable — saved to localStorage only.');
      } else { console.error('[saveExecSummary]', e); }
    }
    setExecSummarySaving(false);
  };

  const generateExecSummary = async () => {
    if (!selected) return;
    setExecSummaryLoading(true);
    try {
      const acc_ = accounts.find(a => linkedIds(selected,'Account').includes(a.id));
      const stkList_ = linkedIds(selected,'Stakeholders').map(id => stakeholders.find(s=>s.id===id)).filter(Boolean);
      const solList_ = linkedIds(selected,'Solutions').map(id => solutions.find(s=>s.id===id)).filter(Boolean);
      const accInfo = acc_ ? [
        F(acc_,'Account Name') ? `Company: ${F(acc_,'Account Name')}` : '',
        F(acc_,'Industry') ? `Industry: ${F(acc_,'Industry')}` : '',
        F(acc_,'Country') ? `Country: ${F(acc_,'Country')}` : '',
        F(acc_,'Description') ? `Description: ${F(acc_,'Description')}` : '',
        F(acc_,'Pain Points') ? `Pain Points: ${F(acc_,'Pain Points')}` : '',
        F(acc_,'Strategic Goals') ? `Strategic Goals: ${F(acc_,'Strategic Goals')}` : '',
      ].filter(Boolean).join('\n') : 'No account info available.';
      const stkContext = stkList_.map(s => `- ${F(s,'Name')} (${F(s,'Title')||''}${F(s,'Department') ? ', '+F(s,'Department') : ''})`).join('\n') || 'None';
      const solContext = solList_.map(s => F(s,'Name')).filter(Boolean).join(', ') || 'None';
      const pptSnippet = pptText ? pptText.slice(0, 2000) : '';
      const messages = [
        { role: 'system', content: 'You are a senior B2B sales strategist. You write sharp, executive-level summaries of commercial presentations. Be concise, direct, and actionable. Respond in English. Use this structure:\n\n**Executive Summary**\n2-3 sentences on what this presentation proposes and why it matters for this account.\n\n**Key Value Propositions**\n3 bullet points max.\n\n**Next Steps**\n2-3 concrete, prioritized actions with owners if possible.' },
        { role: 'user', content: `PRESENTATION: "${F(selected,'Title')||'Untitled'}"\nSTATUS: ${F(selected,'Status')||'Draft'}\nSOLUTIONS: ${solContext}\n\nACCOUNT INFO:\n${accInfo}\n\nSTAKEHOLDERS:\n${stkContext}\n\n${pptSnippet ? 'PRESENTATION CONTENT (extracted):\n'+pptSnippet : ''}\n\n${notes ? 'INTERNAL NOTES:\n'+notes : ''}\n\nGenerate a sharp executive summary with key value propositions and clear next steps.` }
      ];
      const resp = await fetch('/api/openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify({ messages, model: 'gpt-4o', max_tokens: 700 }),
      });
      const d = await resp.json();
      const result = d.content || 'Could not generate summary. Please try again.';
      setExecSummary(result);
      await saveExecSummary(result);
    } catch(e) { console.error('[generateExecSummary]', e); }
    setExecSummaryLoading(false);
  };

  const handlePptUpload = async (file) => {
    if (!file) return;
    const isPptx = file.name.endsWith('.pptx');
    const isPdf  = file.name.endsWith('.pdf');
    if (!isPptx && !isPdf) { window.__oikeToast('Please upload a .pptx or .pdf file', 'error'); return; }
    setPptParsing(true);
    setPptFileName(file.name);
    try {
      let extracted = '';
      if (isPptx) {
        if (typeof JSZip === 'undefined') { window.__oikeToast('JSZip not available. Reload and try again.', 'error'); setPptParsing(false); return; }
        const arrayBuffer = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuffer);
        const slidePattern = new RegExp('^ppt/slides/slide\\d+\\.xml$');
        const numPattern = new RegExp('\\d+');
        const atPattern = new RegExp('<a:t[^>]*>([\\s\\S]*?)<\\/a:t>', 'g');
        const slideFiles = Object.keys(zip.files)
          .filter(n => slidePattern.test(n))
          .sort((a, b) => parseInt(a.match(numPattern)[0]) - parseInt(b.match(numPattern)[0]));
        for (let si = 0; si < slideFiles.length; si++) {
          const name = slideFiles[si];
          const xml = await zip.files[name].async('text');
          const texts = [];
          let m;
          atPattern.lastIndex = 0;
          while ((m = atPattern.exec(xml)) !== null) {
            const t = m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').trim();
            if (t) texts.push(t);
          }
          if (texts.length) {
            const num = name.match(numPattern)[0];
            extracted += '[Slide ' + num + '] ' + texts.join(' ') + '\n';
          }
        }
      } else if (isPdf) {
        const pdfjsLib = window['pdfjs-dist/build/pdf'];
        if (!pdfjsLib) { window.__oikeToast('PDF.js not available. Reload and try again.', 'error'); setPptParsing(false); return; }
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          const pageText = content.items.map(item => item.str).filter(s => s.trim()).join(' ');
          if (pageText.trim()) extracted += '[Page ' + i + '] ' + pageText.trim() + '\n';
        }
      }
      extracted = extracted.trim();
      setPptText(extracted);
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.proposals, selected.id, { 'PPT Content': extracted });
      if (onUpdateRecord) onUpdateRecord('proposals', selected.id, { 'PPT Content': extracted });
    } catch(e) { console.error('[handlePptUpload]', e); window.__oikeToast('Error reading file. Make sure it is a valid .pptx or .pdf.', 'error'); }
    setPptParsing(false);
  };

  const getAiRec = async () => {
    if (!selected) return;
    setAiLoading(true);
    setAiRec('');
    try {
      const accId = linkedIds(selected, 'Account')[0];
      const acc_ = accId ? accounts.find(a => a.id === accId) : null;
      const accStakeholders = accId ? stakeholders.filter(s => linkedIds(s,'Account').includes(accId)) : [];
      const stkList_ = linkedIds(selected,'Stakeholders').map(id => stakeholders.find(s=>s.id===id)).filter(Boolean);
      const solList_ = linkedIds(selected,'Solutions').map(id => solutions.find(s=>s.id===id)).filter(Boolean);
      const stkPool = accStakeholders.length ? accStakeholders : stkList_;
      const stkContext = stkPool.map(s =>
        `• ${F(s,'Name')||''} ${F(s,'Last name')||''} | Cargo: ${F(s,'Role')||'N/A'} | Seniority: ${F(s,'Seniority')||'N/A'} | Influence: ${F(s,'Level of Influence')||'N/A'} | Pain Points: ${F(s,'Pain Points')||'N/A'}`
      ).join('\n');
      const pptSnippet = pptText ? pptText.slice(0, 2500) : '';
      const parts = [
        pptSnippet ? `PRESENTATION CONTENT:\n${pptSnippet}` : '',
        F(selected,'Description') ? `DESCRIPTION:\n${F(selected,'Description')}` : '',
        notes ? `INTERNAL NOTES:\n${notes}` : '',
        solList_.length ? `INCLUDED SOLUTIONS: ${solList_.map(s=>F(s,'Name')).join(', ')}` : '',
      ].filter(Boolean).join('\n\n');
      const messages = [
        { role: 'system', content: 'You are a senior B2B sales strategist. You analyze commercial presentations and recommend who to engage and how to approach them. Respond in English, directly and actionably. Maximum 350 words.' },
        { role: 'user', content: `PRESENTATION: "${F(selected,'Title')||'Untitled'}"\nACCOUNT: ${acc_ ? F(acc_,'Account Name') : 'N/A'}\n\n${parts}\n\nSTAKEHOLDERS IN THIS ACCOUNT:\n${stkContext || 'No stakeholders loaded.'}\n\nWho should I push this presentation to first, and with what argument? Give me the top 2-3 with name, reason, and message angle.` }
      ];
      const resp = await fetch('/api/openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify({ messages, model: 'gpt-4o', max_tokens: 600 }),
      });
      const d = await resp.json();
      setAiRec(d.content || 'Could not generate recommendation. Please try again.');
    } catch(e) { console.error('[getAiRec]', e); setAiRec('Error generating recommendation.'); }
    setAiLoading(false);
  };

  const inputStyle = { width:'100%', padding:'8px 10px', background:'var(--globant-input)', border:'1px solid var(--globant-border)', borderRadius:6, color:'var(--globant-text)', fontSize:13, boxSizing:'border-box' };
  const labelStyle = { fontSize:11, color:'var(--globant-muted)', fontWeight:600, marginBottom:4, textTransform:'uppercase', display:'block' };

  // ── DETAIL VIEW ──
  if (selected) {
    const acc = accounts.find(a => linkedIds(selected,'Account').includes(a.id));
    const stkList = linkedIds(selected,'Stakeholders').map(id => stakeholders.find(s=>s.id===id)).filter(Boolean);
    const solList = linkedIds(selected,'Solutions').map(id => solutions.find(s=>s.id===id)).filter(Boolean);
    const opp = opportunities.find(o => linkedIds(selected,'Opportunity').includes(o.id));
    const docs = selected.fields?.['Document'];
    const status = F(selected,'Status') || 'Draft';
    return (
      <React.Fragment>
      {/* ── Edit Modal ── */}
      {showEdit && (
        <div className="modal-overlay" onClick={() => setShowEdit(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth:580, maxHeight:'90vh', overflowY:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
              <h3 style={{ margin:0 }}>✏️ Edit Proposal</h3>
              <button onClick={() => setShowEdit(false)} style={{ background:'none', border:'none', color:'var(--globant-muted)', cursor:'pointer', fontSize:18 }}>✕</button>
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <div>
                <label style={labelStyle}>Title *</label>
                <input style={inputStyle} value={editForm.title} onChange={e => setEditForm(p=>({...p,title:e.target.value}))} />
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                <div>
                  <label style={labelStyle}>Status</label>
                  <select style={inputStyle} value={editForm.status} onChange={e => setEditForm(p=>({...p,status:e.target.value}))}>
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Amount (USD)</label>
                  <input style={inputStyle} type="number" value={editForm.amount} onChange={e => setEditForm(p=>({...p,amount:e.target.value}))} />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Presented Date</label>
                <input style={inputStyle} type="date" value={editForm.presentedDate} onChange={e => setEditForm(p=>({...p,presentedDate:e.target.value}))} />
              </div>
              {/* Account */}
              <div style={{ position:'relative' }}>
                <label style={labelStyle}>Account</label>
                <input style={inputStyle} placeholder="Type to search account..."
                  value={editForm.accountId ? (F(accounts.find(a=>a.id===editForm.accountId),'Account Name')||editAccSearch) : editAccSearch}
                  onFocus={() => setEditAccOpen(true)}
                  onBlur={() => setTimeout(() => setEditAccOpen(false), 150)}
                  onChange={e => { setEditAccSearch(e.target.value); setEditForm(p=>({...p,accountId:''})); setEditAccOpen(true); }} />
                {editAccOpen && (
                  <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:99, background:'var(--globant-card)', border:'1px solid var(--globant-border)', borderRadius:6, maxHeight:160, overflowY:'auto', boxShadow:'0 8px 24px rgba(0,0,0,0.4)' }}>
                    {[...accounts].filter(a => (F(a,'Account Name')||'').toLowerCase().includes(editAccSearch.toLowerCase())).sort((a,b)=>(F(a,'Account Name')||'').localeCompare(F(b,'Account Name')||'')).slice(0,20).map(a => (
                      <div key={a.id} onMouseDown={() => { setEditForm(p=>({...p,accountId:a.id})); setEditAccSearch(''); setEditAccOpen(false); }}
                        style={{ padding:'8px 12px', cursor:'pointer', fontSize:13, background:editForm.accountId===a.id?'rgba(91,191,181,0.15)':'transparent' }}
                        onMouseEnter={e=>e.currentTarget.style.background='rgba(91,191,181,0.1)'}
                        onMouseLeave={e=>e.currentTarget.style.background=editForm.accountId===a.id?'rgba(91,191,181,0.15)':'transparent'}>
                        {F(a,'Account Name')}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Solutions */}
              <div style={{ position:'relative' }}>
                <label style={labelStyle}>Offering</label>
                {editForm.solutionIds?.length > 0 && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:6 }}>
                    {editForm.solutionIds.map(id => { const s = solutions.find(x=>x.id===id); return s ? (
                      <span key={id} style={{ background:'rgba(91,191,181,0.15)', color:'var(--globant-green)', borderRadius:4, padding:'2px 8px', fontSize:11, display:'flex', alignItems:'center', gap:4 }}>
                        {F(s,'Name')} <span style={{ cursor:'pointer', fontWeight:700 }} onMouseDown={e=>{e.preventDefault();setEditForm(p=>({...p,solutionIds:p.solutionIds.filter(x=>x!==id)}))}}>✕</span>
                      </span>
                    ) : null; })}
                  </div>
                )}
                <input style={inputStyle} placeholder="Type to search solutions..." value={editSolSearch}
                  onFocus={() => setEditSolOpen(true)} onBlur={() => setTimeout(() => setEditSolOpen(false), 150)}
                  onChange={e => { setEditSolSearch(e.target.value); setEditSolOpen(true); }} />
                {editSolOpen && (
                  <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:99, background:'var(--globant-card)', border:'1px solid var(--globant-border)', borderRadius:6, maxHeight:140, overflowY:'auto', boxShadow:'0 8px 24px rgba(0,0,0,0.4)' }}>
                    {[...solutions].filter(s => (F(s,'Name')||'').toLowerCase().includes(editSolSearch.toLowerCase()) && !editForm.solutionIds?.includes(s.id)).sort((a,b)=>(F(a,'Name')||'').localeCompare(F(b,'Name')||'')).slice(0,15).map(s => (
                      <div key={s.id} onMouseDown={() => { setEditForm(p=>({...p,solutionIds:[...(p.solutionIds||[]),s.id]})); setEditSolSearch(''); }}
                        style={{ padding:'8px 12px', cursor:'pointer', fontSize:13 }}
                        onMouseEnter={e=>e.currentTarget.style.background='rgba(91,191,181,0.1)'}
                        onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                        {F(s,'Name')}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Stakeholders */}
              <div style={{ position:'relative' }}>
                <label style={labelStyle}>Stakeholders</label>
                {editForm.stakeholderIds?.length > 0 && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:6 }}>
                    {editForm.stakeholderIds.map(id => { const s = stakeholders.find(x=>x.id===id); return s ? (
                      <span key={id} style={{ background:'rgba(96,165,250,0.15)', color:'var(--globant-info)', borderRadius:4, padding:'2px 8px', fontSize:11, display:'flex', alignItems:'center', gap:4 }}>
                        {F(s,'Name')}{F(s,'Last name') ? ` ${F(s,'Last name')}` : ''} <span style={{ cursor:'pointer', fontWeight:700 }} onMouseDown={e=>{e.preventDefault();setEditForm(p=>({...p,stakeholderIds:p.stakeholderIds.filter(x=>x!==id)}))}}>✕</span>
                      </span>
                    ) : null; })}
                  </div>
                )}
                <input style={inputStyle} placeholder="Type to search stakeholders..." value={editStkSearch}
                  onFocus={() => setEditStkOpen(true)} onBlur={() => setTimeout(() => setEditStkOpen(false), 150)}
                  onChange={e => { setEditStkSearch(e.target.value); setEditStkOpen(true); }} />
                {editStkOpen && (
                  <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:99, background:'var(--globant-card)', border:'1px solid var(--globant-border)', borderRadius:6, maxHeight:140, overflowY:'auto', boxShadow:'0 8px 24px rgba(0,0,0,0.4)' }}>
                    {[...stakeholders].filter(s => !editForm.stakeholderIds?.includes(s.id) && (!editForm.accountId || linkedIds(s,'Account').includes(editForm.accountId)) && (`${F(s,'Name')||''} ${F(s,'Last name')||''} ${F(s,'Role')||''}`).toLowerCase().includes(editStkSearch.toLowerCase())).sort((a,b)=>(F(a,'Name')||'').localeCompare(F(b,'Name')||'')).slice(0,20).map(s => (
                      <div key={s.id} onMouseDown={() => { setEditForm(p=>({...p,stakeholderIds:[...(p.stakeholderIds||[]),s.id]})); setEditStkSearch(''); }}
                        style={{ padding:'8px 12px', cursor:'pointer', fontSize:13 }}
                        onMouseEnter={e=>e.currentTarget.style.background='rgba(96,165,250,0.1)'}
                        onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                        <span style={{ fontWeight:600 }}>{F(s,'Name')}{F(s,'Last name') ? ` ${F(s,'Last name')}` : ''}</span>
                        {F(s,'Role') && <span style={{ fontSize:11, color:'var(--globant-muted)', marginLeft:8 }}>{F(s,'Role')}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Document URL */}
              <div>
                <label style={labelStyle}>Document URL (PDF link)</label>
                <input style={inputStyle} type="url" placeholder="https://drive.google.com/... or Dropbox/OneDrive public link"
                  value={editForm.documentUrl} onChange={e => setEditForm(p=>({...p,documentUrl:e.target.value}))} />
                <div style={{ fontSize:10, color:'var(--globant-muted)', marginTop:4 }}>Paste a public link — Airtable will download and store the file. Leave blank to keep existing document.</div>
              </div>
              <div>
                <label style={labelStyle}>Description</label>
                <textarea style={{ ...inputStyle, minHeight:70, resize:'vertical' }} value={editForm.description} onChange={e => setEditForm(p=>({...p,description:e.target.value}))} />
              </div>
              <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
                <button className="action-btn btn-ghost" onClick={() => setShowEdit(false)}>Cancel</button>
                <button className="action-btn btn-primary" onClick={handleEdit} disabled={editSaving || !editForm.title?.trim()}>
                  {editSaving ? '⏳ Saving...' : '💾 Save Changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <div>
        <div className="page-header" style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
          <div>
            <button className="action-btn btn-ghost" style={{ fontSize:11, marginBottom:8 }} onClick={() => selectProposal('')}>← Back to Proposals</button>
            <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
              <h1 style={{ margin:0 }}>📋 {F(selected,'Title')}</h1>
              <span style={{ background:STATUS_BG[status], color:STATUS_COLOR[status], border:`1px solid ${STATUS_COLOR[status]}50`, borderRadius:6, padding:'3px 10px', fontSize:11, fontWeight:700 }}>{status}</span>
            </div>
            {acc && <div style={{ fontSize:13, color:'var(--globant-muted)', marginTop:4 }}>🏢 {F(acc,'Account Name')}</div>}
          </div>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <select className="input-field" style={{ fontSize:12 }} value={status} onChange={e => handleStatusChange(selected, e.target.value)}>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button className="action-btn btn-ghost" style={{ fontSize:12 }} onClick={() => openEdit(selected)}>✏️ Edit</button>
          </div>
        </div>

        {/* KPIs */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:14, marginBottom:24 }}>
          <div className="card" style={{ textAlign:'center', padding:'16px 12px' }}>
            <div style={{ fontSize:26, fontWeight:800, color:'var(--globant-green)' }}>{F(selected,'Amount') ? formatCurrency(F(selected,'Amount')) : '—'}</div>
            <div style={{ fontSize:11, color:'var(--globant-muted)', marginTop:6 }}>Amount</div>
          </div>
          <div className="card" style={{ textAlign:'center', padding:'16px 12px' }}>
            <div style={{ fontSize:22, fontWeight:800, color:'var(--globant-info)' }}>{F(selected,'Presented Date') ? formatDate(F(selected,'Presented Date')) : '—'}</div>
            <div style={{ fontSize:11, color:'var(--globant-muted)', marginTop:6 }}>Presented</div>
          </div>
          <div className="card" style={{ textAlign:'center', padding:'16px 12px' }}>
            <div style={{ fontSize:22, fontWeight:800, color:'var(--globant-accent)' }}>{solList.length}</div>
            <div style={{ fontSize:11, color:'var(--globant-muted)', marginTop:6 }}>Offering</div>
          </div>
          <div className="card" style={{ textAlign:'center', padding:'16px 12px' }}>
            <div style={{ fontSize:22, fontWeight:800, color:'var(--globant-text)' }}>{stkList.length}</div>
            <div style={{ fontSize:11, color:'var(--globant-muted)', marginTop:6 }}>Stakeholders</div>
          </div>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>
          {/* Left — Description + Document */}
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            {F(selected,'Description') && (
              <div className="card">
                <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:8 }}>📋 Description</div>
                <div style={{ fontSize:13, color:'var(--globant-text)', lineHeight:1.6, whiteSpace:'pre-wrap' }}>{F(selected,'Description')}</div>
              </div>
            )}
            {/* PDF / Document */}
            <div className="card">
              <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:8 }}>📎 Document</div>
              {docs ? (
                <a href={docs} target="_blank" rel="noopener noreferrer"
                  style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 12px', background:'rgba(96,165,250,0.06)', borderRadius:6, border:'1px solid rgba(96,165,250,0.2)', textDecoration:'none', color:'var(--globant-text)', fontSize:12 }}>
                  <span style={{ fontSize:18 }}>📄</span>
                  <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{docs}</span>
                  <span style={{ fontSize:11, color:'var(--globant-info)', flexShrink:0, fontWeight:600 }}>Open ↗</span>
                </a>
              ) : (
                <p style={{ color:'var(--globant-muted)', fontSize:12 }}>No document URL. Click <strong style={{ color:'var(--globant-green)' }}>✏️ Edit</strong> to add one.</p>
              )}
            </div>
          </div>

          {/* Right — Linked records */}
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            {/* Stakeholders */}
            <div className="card">
              <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:8 }}>👥 Stakeholders ({stkList.length})</div>
              {stkList.length === 0
                ? <p style={{ color:'var(--globant-muted)', fontSize:12 }}>No stakeholders linked.</p>
                : stkList.map(s => (
                  <div key={s.id} style={{ padding:'8px 10px', marginBottom:4, borderRadius:6, background:'rgba(255,255,255,0.04)', display:'flex', alignItems:'center', gap:8 }}>
                    <div>
                      <div style={{ fontWeight:600, fontSize:12 }}>{F(s,'Name')}{F(s,'Last name') ? ` ${F(s,'Last name')}` : ''}</div>
                      {F(s,'Role') && <div style={{ fontSize:10, color:'var(--globant-muted)' }}>{F(s,'Role')}</div>}
                    </div>
                    {F(s,'Level of Influence') && <span className="badge badge-accent" style={{ fontSize:9, marginLeft:'auto' }}>{F(s,'Level of Influence')}</span>}
                  </div>
                ))}
            </div>
            {/* Solutions */}
            <div className="card">
              <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:8 }}>🛠️ Offering ({solList.length})</div>
              {solList.length === 0
                ? <p style={{ color:'var(--globant-muted)', fontSize:12 }}>No solutions linked.</p>
                : solList.map(s => (
                  <div key={s.id} style={{ padding:'6px 10px', marginBottom:4, borderRadius:6, background:'rgba(91,191,181,0.06)', border:'1px solid rgba(91,191,181,0.15)', fontSize:12 }}>
                    <span style={{ fontWeight:600, color:'var(--globant-green)' }}>{F(s,'Name')}</span>
                    {F(s,'Type') && <span className="badge badge-blue" style={{ fontSize:9, marginLeft:8 }}>{F(s,'Type')}</span>}
                    {F(s,'Price') && <span style={{ marginLeft:8, fontSize:11, color:'var(--globant-muted)' }}>{F(s,'Price')}</span>}
                  </div>
                ))}
            </div>
            {/* Opportunity */}
            {opp && (
              <div className="card">
                <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:8 }}>💰 Linked Opportunity</div>
                <div style={{ padding:'8px 10px', borderRadius:6, background:'rgba(251,191,36,0.06)', border:'1px solid rgba(251,191,36,0.2)', fontSize:12 }}>
                  <div style={{ fontWeight:600 }}>{F(opp,'Deal/Opp name')}</div>
                  <div style={{ fontSize:11, color:'var(--globant-muted)', marginTop:2 }}>{F(opp,'Stage')}{opp.fields?.['Value'] ? ` · ${formatCurrency(opp.fields['Value'])}` : ''}</div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── EXECUTIVE SUMMARY ── */}
        <div className="card" style={{ marginBottom:16, background:'linear-gradient(135deg, rgba(91,191,181,0.06) 0%, rgba(91,191,181,0.02) 100%)', border:'1px solid rgba(91,191,181,0.2)' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom: execSummary ? 16 : 0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <span style={{ fontSize:18 }}>📋</span>
              <div>
                <div style={{ fontSize:13, fontWeight:700, color:'var(--globant-text)', letterSpacing:'0.2px' }}>Executive Summary</div>
                {!execSummary && !execSummaryLoading && (
                  <div style={{ fontSize:11, color:'var(--globant-muted)', marginTop:2 }}>Auto-generated from presentation + account intelligence</div>
                )}
              </div>
            </div>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              {execSummary && (
                <button
                  onClick={saveExecSummary}
                  disabled={execSummarySaving}
                  style={{ fontSize:11, padding:'5px 12px', borderRadius:6, border:'1px solid var(--globant-border)', background:'rgba(255,255,255,0.04)', color: execSummarySaving ? 'var(--globant-muted)' : 'var(--globant-text)', cursor: execSummarySaving ? 'default' : 'pointer', fontWeight:500 }}
                >
                  {execSummarySaving ? '⏳ Saving...' : '💾 Save edits'}
                </button>
              )}
              <button
                onClick={generateExecSummary}
                disabled={execSummaryLoading}
                style={{ fontSize:12, padding:'6px 18px', borderRadius:7, border:'none', background: execSummaryLoading ? 'rgba(91,191,181,0.1)' : 'var(--globant-green)', color: execSummaryLoading ? 'var(--globant-muted)' : '#0d1117', cursor: execSummaryLoading ? 'default' : 'pointer', fontWeight:700, transition:'all 0.2s' }}
              >
                {execSummaryLoading ? '⏳ Generating...' : execSummary ? '🔄 Regenerate' : '✨ Generate Summary'}
              </button>
            </div>
          </div>

          {execSummaryLoading && (
            <div style={{ display:'flex', alignItems:'center', gap:12, padding:'20px 16px', color:'var(--globant-muted)', fontSize:13 }}>
              <span style={{ animation:'spin 1.2s linear infinite', display:'inline-block', fontSize:20 }}>⚙️</span>
              <div>
                <div style={{ fontWeight:500, marginBottom:2 }}>Analyzing presentation + account data...</div>
                <div style={{ fontSize:11 }}>This takes a few seconds</div>
              </div>
            </div>
          )}

          {execSummary && !execSummaryLoading && (
            <div>
              {/* Rendered view */}
              <div style={{ fontSize:13, color:'var(--globant-text)', lineHeight:1.8, marginBottom:12 }}>
                {execSummary.split('\n').map((line, i) => {
                  const trimmed = line.trim();
                  if (!trimmed) return React.createElement('div', { key:i, style:{ height:6 } });
                  // Section headers: **Title**
                  if (/^\*\*[^*]+\*\*$/.test(trimmed)) {
                    const label = trimmed.replace(/\*\*/g,'');
                    const isNextSteps = /next step/i.test(label);
                    return React.createElement('div', { key:i, style:{ display:'flex', alignItems:'center', gap:8, margin:'14px 0 6px 0' } },
                      React.createElement('span', { style:{ fontSize:13, fontWeight:700, color: isNextSteps ? 'var(--globant-warning)' : 'var(--globant-green)', letterSpacing:'0.3px' } },
                        isNextSteps ? '🎯 ' + label : '📌 ' + label
                      )
                    );
                  }
                  // Bullet points
                  if (/^[-•]/.test(trimmed)) {
                    const content = trimmed.replace(/^[-•]\s*/,'').replace(/\*\*([^*]+)\*\*/g,'___B___$1___/B___');
                    const parts = content.split(/(___B___|___\/B___)/);
                    let bold = false;
                    const rendered = parts.map((p,j) => {
                      if (p==='___B___'){bold=true;return null;}
                      if (p==='___/B___'){bold=false;return null;}
                      return bold ? React.createElement('strong',{key:j,style:{fontWeight:700}},p) : React.createElement('span',{key:j},p);
                    }).filter(Boolean);
                    return React.createElement('div',{key:i,style:{display:'flex',gap:10,marginBottom:6,paddingLeft:4}},
                      React.createElement('span',{style:{color:'var(--globant-green)',marginTop:2,fontSize:12,flexShrink:0}},'▸'),
                      React.createElement('span',{style:{flex:1,lineHeight:1.7}},...rendered)
                    );
                  }
                  // Numbered items
                  const numMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
                  if (numMatch) {
                    const content = numMatch[2].replace(/\*\*([^*]+)\*\*/g,'___B___$1___/B___');
                    const parts = content.split(/(___B___|___\/B___)/);
                    let bold = false;
                    const rendered = parts.map((p,j) => {
                      if (p==='___B___'){bold=true;return null;}
                      if (p==='___/B___'){bold=false;return null;}
                      return bold ? React.createElement('strong',{key:j,style:{fontWeight:700}},p) : React.createElement('span',{key:j},p);
                    }).filter(Boolean);
                    return React.createElement('div',{key:i,style:{display:'flex',gap:10,marginBottom:8,padding:'8px 12px',background:'rgba(251,191,36,0.05)',borderRadius:7,border:'1px solid rgba(251,191,36,0.15)'}},
                      React.createElement('span',{style:{width:20,height:20,minWidth:20,borderRadius:'50%',background:'rgba(251,191,36,0.15)',color:'var(--globant-warning)',fontSize:11,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center'}},numMatch[1]),
                      React.createElement('span',{style:{flex:1,lineHeight:1.7}},...rendered)
                    );
                  }
                  // Regular paragraph
                  return React.createElement('p',{key:i,style:{margin:'0 0 4px 0',lineHeight:1.75,color:'var(--globant-text)'}},trimmed);
                })}
              </div>
              {/* Editable textarea (collapsed by default, expandable) */}
              <details style={{ marginTop:8 }}>
                <summary style={{ fontSize:11, color:'var(--globant-muted)', cursor:'pointer', userSelect:'none', listStyle:'none', display:'flex', alignItems:'center', gap:6 }}>
                  <span>✏️</span><span>Edit raw text</span>
                </summary>
                <textarea
                  style={{ width:'100%', minHeight:120, marginTop:8, padding:'10px 12px', background:'var(--globant-darker)', border:'1px solid var(--globant-border)', borderRadius:7, color:'var(--globant-text)', fontSize:12, boxSizing:'border-box', resize:'vertical', fontFamily:'inherit', lineHeight:1.6, outline:'none' }}
                  value={execSummary}
                  onChange={e => setExecSummary(e.target.value)}
                  onBlur={() => saveExecSummary()}
                />
              </details>
            </div>
          )}
        </div>

        {/* ── NOTES + PPT ANALYSIS ROW ── */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>

          {/* Notes */}
          <div className="card" style={{ display:'flex', flexDirection:'column' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ fontSize:16 }}>📝</span>
                <span style={{ fontSize:12, fontWeight:700, color:'var(--globant-text)', letterSpacing:'0.3px' }}>Internal Notes</span>
              </div>
              <button
                onClick={saveNotes}
                disabled={noteSaving}
                style={{ fontSize:11, padding:'4px 12px', borderRadius:6, border:'1px solid var(--globant-border)', background: noteSaving ? 'transparent' : 'rgba(91,191,181,0.1)', color: noteSaving ? 'var(--globant-muted)' : 'var(--globant-green)', cursor: noteSaving ? 'default' : 'pointer', fontWeight:600, transition:'all 0.2s' }}
              >
                {noteSaving ? '⏳ Saving...' : '💾 Save'}
              </button>
            </div>
            <textarea
              style={{ flex:1, width:'100%', minHeight:140, padding:'12px', background:'var(--globant-darker)', border:'1px solid var(--globant-border)', borderRadius:8, color:'var(--globant-text)', fontSize:13, boxSizing:'border-box', resize:'vertical', fontFamily:'inherit', lineHeight:1.6, outline:'none', transition:'border-color 0.2s' }}
              placeholder="Objections, context, next steps, key insights..."
              value={notes}
              onChange={e => setNotes(e.target.value)}
              onBlur={saveNotes}
              onFocus={e => { e.target.style.borderColor = 'var(--globant-green)'; }}
            />
          </div>

          {/* PPT / PDF Analysis */}
          <div className="card" style={{ display:'flex', flexDirection:'column' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ fontSize:16 }}>📄</span>
                <span style={{ fontSize:12, fontWeight:700, color:'var(--globant-text)', letterSpacing:'0.3px' }}>Document Analysis</span>
              </div>
              {pptText && (
                <label style={{ fontSize:11, padding:'4px 10px', borderRadius:6, border:'1px solid var(--globant-border)', background:'rgba(255,255,255,0.04)', color:'var(--globant-muted)', cursor:'pointer', fontWeight:600 }}>
                  ↻ Replace
                  <input type="file" accept=".pptx,.pdf" style={{ display:'none' }} onChange={e => { if (e.target.files[0]) handlePptUpload(e.target.files[0]); }} />
                </label>
              )}
            </div>
            {!pptText && !pptParsing && (
              <label style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:10, padding:'24px 16px', background:'rgba(91,191,181,0.04)', border:'2px dashed rgba(91,191,181,0.3)', borderRadius:10, cursor:'pointer', textAlign:'center', transition:'all 0.2s' }}
                onMouseEnter={e => { e.currentTarget.style.background='rgba(91,191,181,0.08)'; e.currentTarget.style.borderColor='rgba(91,191,181,0.6)'; }}
                onMouseLeave={e => { e.currentTarget.style.background='rgba(91,191,181,0.04)'; e.currentTarget.style.borderColor='rgba(91,191,181,0.3)'; }}
              >
                <span style={{ fontSize:28 }}>📤</span>
                <div>
                  <div style={{ fontSize:13, fontWeight:600, color:'var(--globant-green)', marginBottom:4 }}>Upload .pptx or .pdf</div>
                  <div style={{ fontSize:11, color:'var(--globant-muted)' }}>Content will be extracted for AI analysis</div>
                </div>
                <input type="file" accept=".pptx,.pdf" style={{ display:'none' }} onChange={e => { if (e.target.files[0]) handlePptUpload(e.target.files[0]); }} />
              </label>
            )}
            {pptParsing && (
              <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:10, padding:'24px 16px' }}>
                <span style={{ fontSize:28, animation:'spin 1.5s linear infinite', display:'inline-block' }}>⚙️</span>
                <div style={{ fontSize:13, color:'var(--globant-muted)', fontWeight:500 }}>Reading file...</div>
              </div>
            )}
            {pptText && !pptParsing && (
              <div style={{ flex:1, display:'flex', flexDirection:'column', gap:8 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background:'rgba(74,222,128,0.07)', borderRadius:7, border:'1px solid rgba(74,222,128,0.2)' }}>
                  <span style={{ fontSize:14 }}>✅</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12, fontWeight:600, color:'var(--globant-success)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{pptFileName}</div>
                    <div style={{ fontSize:11, color:'var(--globant-muted)' }}>{pptText.split('\n').filter(Boolean).length} slides/pages extracted</div>
                  </div>
                </div>
                <div style={{ flex:1, maxHeight:110, overflowY:'auto', padding:'10px 12px', background:'rgba(255,255,255,0.02)', borderRadius:7, border:'1px solid var(--globant-border)', fontSize:11, color:'var(--globant-muted)', lineHeight:1.6, whiteSpace:'pre-wrap' }}>
                  {pptText.slice(0, 600)}{pptText.length > 600 ? '\n...' : ''}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── AI RECOMMENDATION ── */}
        <div className="card" style={{ marginBottom:16 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: (aiRec || aiLoading) ? 16 : 0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ fontSize:16 }}>🤖</span>
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:'var(--globant-text)', letterSpacing:'0.3px' }}>Who should you push this to?</div>
                {!aiRec && !aiLoading && <div style={{ fontSize:11, color:'var(--globant-muted)', marginTop:2 }}>AI analysis of stakeholders + presentation content</div>}
              </div>
            </div>
            <button
              className="action-btn btn-primary"
              style={{ fontSize:12, padding:'7px 18px', borderRadius:8, fontWeight:600, whiteSpace:'nowrap' }}
              onClick={getAiRec}
              disabled={aiLoading}
            >
              {aiLoading ? '⏳ Analyzing...' : aiRec ? '🔄 Regenerate' : '✨ Recommend'}
            </button>
          </div>
          {aiLoading && (
            <div style={{ display:'flex', alignItems:'center', gap:12, padding:'16px', background:'rgba(91,191,181,0.04)', borderRadius:8, border:'1px solid rgba(91,191,181,0.15)', color:'var(--globant-muted)', fontSize:13 }}>
              <span style={{ animation:'spin 1s linear infinite', display:'inline-block', fontSize:18 }}>⚙️</span>
              <span>Analyzing presentation, notes and stakeholder profiles...</span>
            </div>
          )}
          {aiRec && !aiLoading && (
            <div style={{ padding:'16px 18px', background:'rgba(91,191,181,0.05)', borderRadius:10, border:'1px solid rgba(91,191,181,0.18)', fontSize:13, color:'var(--globant-text)', lineHeight:1.75 }}>
              {aiRec.split('\n').map((line, i) => {
                const trimmed = line.trim();
                if (!trimmed) return React.createElement('div', { key:i, style:{ height:8 } });
                // Numbered list items: "1. **Name** - ..."
                const listMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
                if (listMatch) {
                  const content = listMatch[2].replace(/\*\*([^*]+)\*\*/g, '___BOLD_START___$1___BOLD_END___');
                  const parts = content.split(/(___BOLD_START___|___BOLD_END___)/);
                  let bold = false;
                  const rendered = parts.map((p, j) => {
                    if (p === '___BOLD_START___') { bold = true; return null; }
                    if (p === '___BOLD_END___') { bold = false; return null; }
                    return bold ? React.createElement('strong', { key:j, style:{ color:'var(--globant-green)', fontWeight:700 } }, p) : React.createElement('span', { key:j }, p);
                  }).filter(Boolean);
                  return React.createElement('div', { key:i, style:{ display:'flex', gap:12, marginBottom:10, padding:'10px 14px', background:'rgba(255,255,255,0.03)', borderRadius:8, border:'1px solid var(--globant-border)' } },
                    React.createElement('span', { style:{ width:22, height:22, minWidth:22, borderRadius:'50%', background:'rgba(91,191,181,0.15)', color:'var(--globant-green)', fontSize:11, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center' } }, listMatch[1]),
                    React.createElement('span', { style:{ flex:1, lineHeight:1.7 } }, ...rendered)
                  );
                }
                // Bold inline text
                const parts2 = trimmed.replace(/\*\*([^*]+)\*\*/g, '___B___$1___/B___').split(/(___B___|___\/B___)/);
                let isBold = false;
                const rendered2 = parts2.map((p, j) => {
                  if (p === '___B___') { isBold = true; return null; }
                  if (p === '___/B___') { isBold = false; return null; }
                  return isBold ? React.createElement('strong', { key:j, style:{ color:'var(--globant-text)', fontWeight:700 } }, p) : React.createElement('span', { key:j }, p);
                }).filter(Boolean);
                return React.createElement('p', { key:i, style:{ margin:'0 0 6px 0', lineHeight:1.7 } }, ...rendered2);
              })}
            </div>
          )}
        </div>

      </div>
      </React.Fragment>
    );
  }

  // ── PROPOSAL GENERATOR HELPERS (defined here to avoid Babel JSX parse issues with template literals) ──

  // ── i18n translations for proposal static text ──
  const PROPOSAL_I18N = {
    en: {
      locale: 'en-GB', langAttr: 'en',
      tag: '\u26a1 Commercial Proposal',
      builtFor: 'Built for',
      preparedFor: 'Prepared for',
      scheduleCall: 'Schedule a call \u2192',
      whatWeHeard: 'What we heard',
      contextDiscovery: 'Context & Discovery',
      challengesIdentified: 'Challenges identified',
      frictionPoints: 'The three friction points we need to solve',
      declaredGoal: 'Declared goal',
      inTheirWords: 'In their own words',
      rootProblem: 'Root problem',
      underlyingDiagnosis: 'The underlying diagnosis',
      ourProposal: 'Our proposal',
      whatWeRecommend: 'What we recommend for',
      whySolution: 'Why this solution',
      whyItFits: 'Why it fits',
      nextSteps: 'Next steps',
      howWeMove: 'How we move forward',
      readyToMove: 'Ready to move forward?',
      ctaSubtitle: '20 minutes is enough to align on everything.',
      footerLabel: 'Commercial Proposal',
    },
    es: {
      locale: 'es-ES', langAttr: 'es',
      tag: '\u26a1 Propuesta Comercial',
      builtFor: 'Creada para',
      preparedFor: 'Preparada para',
      scheduleCall: 'Agend\u00e1 una llamada \u2192',
      whatWeHeard: 'Lo que escuchamos',
      contextDiscovery: 'Contexto y Discovery',
      challengesIdentified: 'Desaf\u00edos identificados',
      frictionPoints: 'Los tres puntos de fricci\u00f3n a resolver',
      declaredGoal: 'Objetivo declarado',
      inTheirWords: 'En sus propias palabras',
      rootProblem: 'Problema ra\u00edz',
      underlyingDiagnosis: 'El diagn\u00f3stico de fondo',
      ourProposal: 'Nuestra propuesta',
      whatWeRecommend: 'Lo que recomendamos para',
      whySolution: 'Por qu\u00e9 esta soluci\u00f3n',
      whyItFits: 'Por qu\u00e9 encaja con',
      nextSteps: 'Pr\u00f3ximos pasos',
      howWeMove: 'C\u00f3mo avanzamos',
      readyToMove: '\u00bfListos para avanzar?',
      ctaSubtitle: '20 minutos alcanzan para alinear todo.',
      footerLabel: 'Propuesta Comercial',
    },
    pt: {
      locale: 'pt-BR', langAttr: 'pt',
      tag: '\u26a1 Proposta Comercial',
      builtFor: 'Criada para',
      preparedFor: 'Preparada para',
      scheduleCall: 'Agendar uma conversa \u2192',
      whatWeHeard: 'O que ouvimos',
      contextDiscovery: 'Contexto e Discovery',
      challengesIdentified: 'Desafios identificados',
      frictionPoints: 'Os tr\u00eas pontos de atrito a resolver',
      declaredGoal: 'Objetivo declarado',
      inTheirWords: 'Em suas pr\u00f3prias palavras',
      rootProblem: 'Problema raiz',
      underlyingDiagnosis: 'O diagn\u00f3stico subjacente',
      ourProposal: 'Nossa proposta',
      whatWeRecommend: 'O que recomendamos para',
      whySolution: 'Por que esta solu\u00e7\u00e3o',
      whyItFits: 'Por que se encaixa com',
      nextSteps: 'Pr\u00f3ximos passos',
      howWeMove: 'Como avan\u00e7amos',
      readyToMove: 'Prontos para avan\u00e7ar?',
      ctaSubtitle: '20 minutos s\u00e3o suficientes para alinhar tudo.',
      footerLabel: 'Proposta Comercial',
    },
    fr: {
      locale: 'fr-FR', langAttr: 'fr',
      tag: '\u26a1 Proposition Commerciale',
      builtFor: 'Con\u00e7ue pour',
      preparedFor: 'Pr\u00e9par\u00e9e pour',
      scheduleCall: 'Planifier un appel \u2192',
      whatWeHeard: 'Ce que nous avons entendu',
      contextDiscovery: 'Contexte et Discovery',
      challengesIdentified: 'D\u00e9fis identifi\u00e9s',
      frictionPoints: 'Les trois points de friction \u00e0 r\u00e9soudre',
      declaredGoal: 'Objectif d\u00e9clar\u00e9',
      inTheirWords: 'Dans leurs propres mots',
      rootProblem: 'Probl\u00e8me racine',
      underlyingDiagnosis: 'Le diagnostic sous-jacent',
      ourProposal: 'Notre proposition',
      whatWeRecommend: 'Ce que nous recommandons pour',
      whySolution: 'Pourquoi cette solution',
      whyItFits: 'Pourquoi cela convient \u00e0',
      nextSteps: 'Prochaines \u00e9tapes',
      howWeMove: 'Comment nous avan\u00e7ons',
      readyToMove: 'Pr\u00eats \u00e0 avancer\u00a0?',
      ctaSubtitle: '20 minutes suffisent pour tout aligner.',
      footerLabel: 'Proposition Commerciale',
    },
  };

  const generateHTML = () => {
    const T = PROPOSAL_I18N[GF('language') || 'en'] || PROPOSAL_I18N['en'];
    const today = new Date().toLocaleDateString(T.locale, { day:'numeric', month:'long', year:'numeric' });
    const ACC = GF('accentColor') || '#5BBFB5';
    const DARK = GF('darkColor') || '#0D0D1A';
    // Derive tinted versions from accent
    const ACC_DIM = ACC + '1A'; // ~10% opacity
    const ACC_BORDER = ACC + '40'; // ~25% opacity
    const featuresHTML = genForm.optionFeatures.filter(Boolean).map(f =>
      '<li>' + f + '</li>'
    ).join('\n              ');
    return '<!DOCTYPE html>\n' +
'<html lang="' + T.langAttr + '">\n' +
'<head>\n' +
'  <meta charset="UTF-8" />\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
'  <title>Oike \u2014 ' + GF('company') + '</title>\n' +
'  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />\n' +
'  <style>\n' +
'    *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }\n' +
'    :root { --teal:' + ACC + '; --dark:' + DARK + '; --card:#13131F; --card2:#1A1A2E; --border:rgba(255,255,255,0.07); --text:#E8E8F0; --muted:#7878A0; --teal-dim:' + ACC_DIM + '; --teal-border:' + ACC_BORDER + '; }\n' +
'    body { font-family:\'Inter\',sans-serif; background:var(--dark); color:var(--text); line-height:1.6; -webkit-font-smoothing:antialiased; }\n' +
'    nav { position:fixed; top:0; left:0; right:0; z-index:100; display:flex; justify-content:space-between; align-items:center; padding:18px 48px; background:rgba(13,13,26,0.85); backdrop-filter:blur(16px); border-bottom:1px solid var(--border); }\n' +
'    .logo { display:flex; align-items:center; gap:10px; font-size:18px; font-weight:800; color:var(--text); text-decoration:none; }\n' +
'    .logo-icon { width:30px; height:30px; background:var(--teal); border-radius:7px; display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:900; color:#0D0D1A; }\n' +
'    .nav-cta { padding:10px 22px; background:var(--teal); color:#0D0D1A; font-weight:700; font-size:13px; border-radius:8px; text-decoration:none; }\n' +
'    section { padding:80px 48px; max-width:960px; margin:0 auto; }\n' +
'    .hero { padding-top:140px; padding-bottom:60px; }\n' +
'    .hero-tag { display:inline-flex; align-items:center; gap:8px; padding:5px 14px; background:var(--teal-dim); border:1px solid var(--teal-border); border-radius:100px; font-size:11px; font-weight:700; color:var(--teal); margin-bottom:28px; text-transform:uppercase; letter-spacing:0.5px; }\n' +
'    .hero h1 { font-size:clamp(36px,5vw,62px); font-weight:900; line-height:1.1; letter-spacing:-2px; margin-bottom:20px; }\n' +
'    .hero h1 span { background:linear-gradient(135deg,var(--teal) 0%,#a8edea 100%); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }\n' +
'    .hero-meta { font-size:14px; color:var(--muted); }\n' +
'    .hero-meta strong { color:var(--text); }\n' +
'    .card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:36px; margin-bottom:16px; }\n' +
'    .card.teal { background:var(--teal-dim); border-color:var(--teal-border); }\n' +
'    .section-tag { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; color:var(--teal); margin-bottom:12px; display:block; }\n' +
'    h2 { font-size:clamp(22px,3vw,34px); font-weight:800; letter-spacing:-0.8px; margin-bottom:20px; line-height:1.2; }\n' +
'    .pains { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }\n' +
'    .pain-card { padding:24px; background:rgba(248,113,113,0.05); border:1px solid rgba(248,113,113,0.15); border-radius:12px; }\n' +
'    .pain-num { font-size:28px; font-weight:900; color:rgba(248,113,113,0.4); margin-bottom:8px; }\n' +
'    .pain-card p { font-size:14px; color:var(--text); line-height:1.6; }\n' +
'    blockquote { padding:28px 32px; background:var(--teal-dim); border-left:4px solid var(--teal); border-radius:0 12px 12px 0; font-size:18px; font-style:italic; color:var(--text); line-height:1.7; margin:0; }\n' +
'    .features { list-style:none; display:flex; flex-direction:column; gap:10px; }\n' +
'    .features li { display:flex; align-items:flex-start; gap:10px; font-size:14px; }\n' +
'    .features li::before { content:"\\2713"; color:var(--teal); font-weight:700; flex-shrink:0; margin-top:2px; }\n' +
'    .option-card { padding:40px; background:var(--card2); border:1px solid var(--teal-border); border-radius:20px; box-shadow:0 0 40px rgba(91,191,181,0.08); }\n' +
'    .option-letter { width:52px; height:52px; border-radius:14px; background:var(--teal-dim); border:1px solid var(--teal-border); display:flex; align-items:center; justify-content:center; font-size:24px; font-weight:900; color:var(--teal); margin-bottom:20px; }\n' +
'    .option-card h3 { font-size:24px; font-weight:800; letter-spacing:-0.5px; margin-bottom:6px; }\n' +
'    .option-subtitle { font-size:12px; font-weight:600; color:var(--teal); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:18px; }\n' +
'    .option-card p { font-size:15px; color:var(--muted); line-height:1.7; margin-bottom:24px; }\n' +
'    .steps { display:flex; flex-direction:column; gap:14px; }\n' +
'    .step { display:flex; align-items:flex-start; gap:16px; padding:18px 20px; background:var(--card); border:1px solid var(--border); border-radius:12px; }\n' +
'    .step-num { width:30px; height:30px; border-radius:50%; background:var(--teal-dim); border:1px solid var(--teal-border); display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:800; color:var(--teal); flex-shrink:0; }\n' +
'    .step p { font-size:14px; color:var(--text); line-height:1.5; margin:4px 0 0; }\n' +
'    .cta-section { text-align:center; padding:80px 48px 120px; }\n' +
'    .cta-section h2 { font-size:clamp(26px,4vw,44px); font-weight:900; letter-spacing:-1px; margin-bottom:16px; }\n' +
'    .cta-section p { font-size:15px; color:var(--muted); max-width:460px; margin:0 auto 36px; }\n' +
'    .cta-btn { display:inline-flex; align-items:center; gap:10px; padding:16px 44px; background:var(--teal); color:#0D0D1A; font-weight:800; font-size:15px; border-radius:12px; text-decoration:none; }\n' +
'    .divider { height:1px; background:var(--border); max-width:960px; margin:0 auto; }\n' +
'    footer { text-align:center; padding:28px 48px; font-size:13px; color:var(--muted); }\n' +
'    @media(max-width:700px){ nav{padding:14px 20px;} section{padding:60px 20px;} .pains{grid-template-columns:1fr;} .hero{padding-top:110px;} }\n' +
'  </style>\n' +
'</head>\n' +
'<body>\n' +
'  <nav>\n' +
'    <a href="#" class="logo">' +
  (GF('senderLogo')
    ? '<img src="' + GF('senderLogo') + '" alt="' + (GF('senderName')||'Logo') + '" style="height:28px;width:auto;object-fit:contain;" />'
    : '<div class="logo-icon">' + (GF('senderName')||'?')[0].toUpperCase() + '</div> ' + (GF('senderName')||'Your Company')) +
'</a>\n' +
'    <a href="' + GF('calendarLink') + '" target="_blank" class="nav-cta">' + T.scheduleCall + '</a>\n' +
'  </nav>\n' +
'\n' +
'  <section class="hero">\n' +
'    <div class="hero-tag">' + T.tag + '</div>\n' +
'    <h1>' + T.builtFor + ' <span>' + GF('company') + '</span></h1>\n' +
'    <p class="hero-meta">' + T.preparedFor + ' <strong>' + GF('contact') + (GF('contactTitle') ? ', ' + GF('contactTitle') : '') + '</strong>&nbsp;\u00b7&nbsp;' + today + '</p>\n' +
'  </section>\n' +
'\n' +
'  <div class="divider"></div>\n' +
'\n' +
'  <section>\n' +
'    <span class="section-tag">' + T.whatWeHeard + '</span>\n' +
'    <h2>' + T.contextDiscovery + '</h2>\n' +
'    <div class="card">\n' +
'      <p style="font-size:15px; color:#c0c0d8; line-height:1.8;">' + GF('discovery').replace(/\n/g, '<br/>') + '</p>\n' +
'    </div>\n' +
'  </section>\n' +
'\n' +
'  <div class="divider"></div>\n' +
'\n' +
'  <section>\n' +
'    <span class="section-tag">' + T.challengesIdentified + '</span>\n' +
'    <h2>' + T.frictionPoints + '</h2>\n' +
'    <div class="pains">\n' +
'      <div class="pain-card"><div class="pain-num">01</div><p>' + GF('pain1') + '</p></div>\n' +
'      <div class="pain-card"><div class="pain-num">02</div><p>' + GF('pain2') + '</p></div>\n' +
'      <div class="pain-card"><div class="pain-num">03</div><p>' + GF('pain3') + '</p></div>\n' +
'    </div>\n' +
'  </section>\n' +
'\n' +
'  <div class="divider"></div>\n' +
'\n' +
'  <section>\n' +
'    <span class="section-tag">' + T.declaredGoal + '</span>\n' +
'    <h2>' + T.inTheirWords + '</h2>\n' +
'    <blockquote>&ldquo;' + GF('goalQuote') + '&rdquo;</blockquote>\n' +
'  </section>\n' +
'\n' +
'  <div class="divider"></div>\n' +
'\n' +
'  <section>\n' +
'    <span class="section-tag">' + T.rootProblem + '</span>\n' +
'    <h2>' + T.underlyingDiagnosis + '</h2>\n' +
'    <div class="card">\n' +
'      <p style="font-size:15px; color:#c0c0d8; line-height:1.8;">' + GF('rootProblem').replace(/\n/g, '<br/>') + '</p>\n' +
'    </div>\n' +
'  </section>\n' +
'\n' +
'  <div class="divider"></div>\n' +
'\n' +
'  <section>\n' +
'    <span class="section-tag">' + T.ourProposal + '</span>\n' +
'    <h2>' + T.whatWeRecommend + ' ' + GF('company') + '</h2>\n' +
'    <div class="option-card">\n' +
'      <div class="option-letter">' + GF('option') + '</div>\n' +
'      <h3>' + GF('optionName') + '</h3>\n' +
'      <div class="option-subtitle">' + GF('optionSubtitle') + '</div>\n' +
'      <p>' + GF('optionDesc') + '</p>\n' +
'      <ul class="features">\n' +
'              ' + featuresHTML + '\n' +
'      </ul>\n' +
'    </div>\n' +
'  </section>\n' +
'\n' +
'  <div class="divider"></div>\n' +
'\n' +
'  <section>\n' +
'    <span class="section-tag">' + T.whySolution + '</span>\n' +
'    <h2>' + T.whyItFits + ' ' + GF('company') + '</h2>\n' +
'    <div class="card teal">\n' +
'      <p style="font-size:15px; color:var(--text); line-height:1.8;">' + GF('whySolution').replace(/\n/g, '<br/>') + '</p>\n' +
'    </div>\n' +
'  </section>\n' +
'\n' +
'  <div class="divider"></div>\n' +
'\n' +
'  <section>\n' +
'    <span class="section-tag">' + T.nextSteps + '</span>\n' +
'    <h2>' + T.howWeMove + '</h2>\n' +
'    <div class="steps">\n' +
'      <div class="step"><div class="step-num">1</div><div><p>' + GF('nextStep1') + '</p></div></div>\n' +
'      <div class="step"><div class="step-num">2</div><div><p>' + GF('nextStep2') + '</p></div></div>\n' +
'      <div class="step"><div class="step-num">3</div><div><p>' + GF('nextStep3') + '</p></div></div>\n' +
'    </div>\n' +
'  </section>\n' +
'\n' +
'  <div class="divider"></div>\n' +
'\n' +
'  <div class="cta-section">\n' +
'    <h2>' + T.readyToMove + '</h2>\n' +
'    <p>' + T.ctaSubtitle + '</p>\n' +
'    <a href="' + GF('calendarLink') + '" target="_blank" class="cta-btn">' + T.scheduleCall + '</a>\n' +
'  </div>\n' +
'\n' +
'  <div class="divider"></div>\n' +
'  <footer><strong style="color:var(--text);">' + (GF('senderName')||'Your Company') + '</strong>' +
  (GF('senderEmail') ? ' &nbsp;\u00b7&nbsp; <a href="mailto:' + GF('senderEmail') + '" style="color:var(--teal);text-decoration:none;">' + GF('senderEmail') + '</a>' : '') +
'</footer>\n' +
'</body>\n' +
'</html>';
  };

  const downloadProposal = () => {
    const html = generateHTML();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (GF('slug') || 'proposal') + '.html';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Email-compatible HTML (inline styles, no CSS vars, no external fonts)
  const generateEmailHTML = () => {
    const T = PROPOSAL_I18N[GF('language') || 'en'] || PROPOSAL_I18N['en'];
    const today = new Date().toLocaleDateString(T.locale, { day:'numeric', month:'long', year:'numeric' });
    const teal = GF('accentColor') || '#5BBFB5';
    const dark = GF('darkColor') || '#1a1a2e';
    const muted = '#555';
    const border = '#e5e7eb';
    const featuresHTML = genForm.optionFeatures.filter(Boolean).map(f =>
      '<tr><td style="padding:6px 0; color:#1a1a2e; font-size:14px; border-bottom:1px solid #f0f0f0; font-family:Arial,sans-serif;">' +
      '<span style="color:' + teal + '; font-weight:700; margin-right:8px;">✓</span>' + f + '</td></tr>'
    ).join('');
    const painCards = [
      { num:'01', text: GF('pain1') },
      { num:'02', text: GF('pain2') },
      { num:'03', text: GF('pain3') },
    ].filter(p => p.text).map(p =>
      '<td style="width:33%; padding:16px; background:#fff5f5; border:1px solid #fecaca; border-radius:8px; vertical-align:top; font-family:Arial,sans-serif;">' +
      '<div style="font-size:24px; font-weight:900; color:#fca5a5; margin-bottom:6px;">' + p.num + '</div>' +
      '<p style="margin:0; font-size:13px; color:#374151; line-height:1.6;">' + p.text + '</p></td>'
    ).join('<td style="width:12px;"></td>');
    const nextSteps = [GF('nextStep1'), GF('nextStep2'), GF('nextStep3')].filter(Boolean).map((s, i) =>
      '<tr><td style="padding:10px 0; border-bottom:1px solid ' + border + ';">' +
      '<table cellpadding="0" cellspacing="0" style="width:100%;"><tr>' +
      '<td style="width:30px; height:30px; background:#e6f7f6; border:1px solid #b2e4df; border-radius:50%; text-align:center; vertical-align:middle; font-size:12px; font-weight:800; color:' + teal + '; font-family:Arial,sans-serif;">' + (i+1) + '</td>' +
      '<td style="padding-left:12px; font-size:14px; color:#374151; font-family:Arial,sans-serif;">' + s + '</td>' +
      '</tr></table></td></tr>'
    ).join('');

    return '<!DOCTYPE html>' +
'<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
'<body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif;">' +
'<table cellpadding="0" cellspacing="0" style="width:100%;max-width:680px;margin:0 auto;background:#ffffff;">' +

// Header
'<tr><td style="background:' + dark + ';padding:28px 40px;">' +
'<table cellpadding="0" cellspacing="0" style="width:100%;"><tr>' +
'<td>' +
  (GF('senderLogo')
? '<img src="' + GF('senderLogo') + '" alt="' + (GF('senderName')||'Logo') + '" style="height:32px;width:auto;object-fit:contain;" />'
: '<table cellpadding="0" cellspacing="0"><tr>' +
  '<td style="width:34px;height:34px;background:' + teal + ';border-radius:8px;text-align:center;vertical-align:middle;font-size:16px;font-weight:900;color:' + dark + ';">' + (GF('senderName')||'?')[0].toUpperCase() + '</td>' +
  '<td style="padding-left:10px;font-size:18px;font-weight:800;color:#ffffff;">' + (GF('senderName')||'Your Company') + '</td>' +
  '</tr></table>') +
'</td>' +
'<td style="text-align:right;font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">' + T.footerLabel + '</td>' +
'</tr></table></td></tr>' +

// Hero
'<tr><td style="padding:40px 40px 28px;background:' + dark + ';border-bottom:3px solid ' + teal + ';">' +
'<p style="margin:0 0 8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + teal + ';">' + T.builtFor + '</p>' +
'<h1 style="margin:0 0 12px;font-size:36px;font-weight:900;color:#ffffff;letter-spacing:-1px;">' + GF('company') + '</h1>' +
'<p style="margin:0;font-size:13px;color:#9ca3af;">' + T.preparedFor + ' <strong style="color:#e5e7eb;">' + GF('contact') + (GF('contactTitle') ? ', ' + GF('contactTitle') : '') + '</strong> &nbsp;·&nbsp; ' + today + '</p>' +
'</td></tr>' +

// Section: Discovery
'<tr><td style="padding:36px 40px 0;">' +
'<p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + teal + ';">' + T.whatWeHeard + '</p>' +
'<h2 style="margin:0 0 16px;font-size:22px;font-weight:800;color:' + dark + ';">' + T.contextDiscovery + '</h2>' +
'<div style="padding:20px 24px;background:#f9fafb;border:1px solid ' + border + ';border-radius:10px;">' +
'<p style="margin:0;font-size:14px;color:#374151;line-height:1.8;">' + GF('discovery').replace(/\n/g,'<br>') + '</p>' +
'</div></td></tr>' +

// Section: Pain points
'<tr><td style="padding:32px 40px 0;">' +
'<p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + teal + ';">' + T.challengesIdentified + '</p>' +
'<h2 style="margin:0 0 16px;font-size:22px;font-weight:800;color:' + dark + ';">' + T.frictionPoints + '</h2>' +
'<table cellpadding="0" cellspacing="0" style="width:100%;"><tr>' + painCards + '</tr></table>' +
'</td></tr>' +

// Section: Quote
(GF('goalQuote') ? (
'<tr><td style="padding:32px 40px 0;">' +
'<p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + teal + ';">' + T.declaredGoal + '</p>' +
'<h2 style="margin:0 0 16px;font-size:22px;font-weight:800;color:' + dark + ';">' + T.inTheirWords + '</h2>' +
'<blockquote style="margin:0;padding:20px 24px;background:#e6f7f6;border-left:4px solid ' + teal + ';border-radius:0 10px 10px 0;">' +
'<p style="margin:0;font-size:17px;font-style:italic;color:' + dark + ';line-height:1.7;">&ldquo;' + GF('goalQuote') + '&rdquo;</p>' +
'</blockquote></td></tr>'
) : '') +

// Section: Root problem
(GF('rootProblem') ? (
'<tr><td style="padding:32px 40px 0;">' +
'<p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + teal + ';">' + T.rootProblem + '</p>' +
'<h2 style="margin:0 0 16px;font-size:22px;font-weight:800;color:' + dark + ';">' + T.underlyingDiagnosis + '</h2>' +
'<div style="padding:20px 24px;background:#f9fafb;border:1px solid ' + border + ';border-radius:10px;">' +
'<p style="margin:0;font-size:14px;color:#374151;line-height:1.8;">' + GF('rootProblem').replace(/\n/g,'<br>') + '</p>' +
'</div></td></tr>'
) : '') +

// Section: Solution
'<tr><td style="padding:32px 40px 0;">' +
'<p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + teal + ';">' + T.ourProposal + '</p>' +
'<h2 style="margin:0 0 16px;font-size:22px;font-weight:800;color:' + dark + ';">' + T.whatWeRecommend + ' ' + GF('company') + '</h2>' +
'<div style="padding:28px;background:#f0faf9;border:1px solid #b2e4df;border-radius:12px;">' +
'<div style="width:44px;height:44px;background:#e6f7f6;border:1px solid #b2e4df;border-radius:10px;text-align:center;line-height:44px;font-size:20px;font-weight:900;color:' + teal + ';margin-bottom:14px;">' + GF('option') + '</div>' +
'<h3 style="margin:0 0 4px;font-size:20px;font-weight:800;color:' + dark + ';">' + GF('optionName') + '</h3>' +
'<p style="margin:0 0 16px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:' + teal + ';">' + GF('optionSubtitle') + '</p>' +
'<p style="margin:0 0 20px;font-size:14px;color:' + muted + ';line-height:1.7;">' + GF('optionDesc') + '</p>' +
'<table cellpadding="0" cellspacing="0" style="width:100%;">' + featuresHTML + '</table>' +
'</div></td></tr>' +

// Section: Why this solution
(GF('whySolution') ? (
'<tr><td style="padding:32px 40px 0;">' +
'<p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + teal + ';">' + T.whySolution + '</p>' +
'<h2 style="margin:0 0 16px;font-size:22px;font-weight:800;color:' + dark + ';">' + T.whyItFits + ' ' + GF('company') + '</h2>' +
'<div style="padding:20px 24px;background:#e6f7f6;border:1px solid #b2e4df;border-radius:10px;">' +
'<p style="margin:0;font-size:14px;color:' + dark + ';line-height:1.8;">' + GF('whySolution').replace(/\n/g,'<br>') + '</p>' +
'</div></td></tr>'
) : '') +

// Section: Next steps
'<tr><td style="padding:32px 40px 0;">' +
'<p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + teal + ';">' + T.nextSteps + '</p>' +
'<h2 style="margin:0 0 16px;font-size:22px;font-weight:800;color:' + dark + ';">' + T.howWeMove + '</h2>' +
'<table cellpadding="0" cellspacing="0" style="width:100%;">' + nextSteps + '</table>' +
'</td></tr>' +

// CTA
'<tr><td style="padding:40px;text-align:center;background:#f9fafb;margin-top:32px;">' +
'<h2 style="margin:0 0 12px;font-size:22px;font-weight:800;color:' + dark + ';">' + T.readyToMove + '</h2>' +
'<p style="margin:0 0 24px;font-size:14px;color:' + muted + ';">' + T.ctaSubtitle + '</p>' +
'<a href="' + GF('calendarLink') + '" style="display:inline-block;padding:14px 40px;background:' + teal + ';color:' + dark + ';font-weight:800;font-size:14px;border-radius:10px;text-decoration:none;">' + T.scheduleCall + '</a>' +
'</td></tr>' +

// Footer
'<tr><td style="padding:20px 40px;border-top:1px solid ' + border + ';text-align:center;">' +
'<p style="margin:0;font-size:12px;color:#9ca3af;">' +
  '<strong style="color:' + dark + ';">' + (GF('senderName')||'Your Company') + '</strong>' +
  (GF('senderEmail') ? ' &nbsp;&middot;&nbsp; <a href="mailto:' + GF('senderEmail') + '" style="color:' + teal + ';text-decoration:none;">' + GF('senderEmail') + '</a>' : '') +
'</p>' +
'</td></tr>' +

'</table></body></html>';
  };

  const copyProposalHTML = async () => {
    const html = generateEmailHTML();
    try {
      const blob = new Blob([html], { type: 'text/html' });
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': blob })]);
      setGenCopied(true);
      setTimeout(() => setGenCopied(false), 2500);
    } catch {
      navigator.clipboard.writeText(html).catch(() => {});
      setGenCopied(true);
      setTimeout(() => setGenCopied(false), 2500);
    }
  };

  // Opens HTML in new window and triggers browser print-to-PDF dialog
  const printAsPdf = (html) => {
    const printHtml = html.replace('</body>', '<script>window.onload=function(){setTimeout(function(){window.print();},400);};<\/script></body>');
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.open();
    w.document.write(printHtml);
    w.document.close();
  };

  const openProposalInGmail = async () => {
    const html = generateEmailHTML();
    // 1. Copy HTML to clipboard — user just pastes in body
    try {
      const blob = new Blob([html], { type: 'text/html' });
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': blob })]);
    } catch {
      navigator.clipboard.writeText(html).catch(() => {});
    }
    // 2. Build Gmail compose URL with pre-filled To + Subject
    const stk = GF('stakeholderId') ? stakeholders.find(s => s.id === GF('stakeholderId')) : null;
    const toEmail = stk ? (F(stk, 'Email') || '') : '';
    const subjectPrefixes = { en:'Proposal for', es:'Propuesta para', pt:'Proposta para', fr:'Proposition pour' };
    const subject = (subjectPrefixes[GF('language') || 'en'] || 'Proposal for') + ' ' + (GF('company') || '');
    let gmailUrl = 'https://mail.google.com/mail/?view=cm&fs=1';
    if (toEmail) gmailUrl += '&to=' + encodeURIComponent(toEmail);
    if (subject.trim()) gmailUrl += '&su=' + encodeURIComponent(subject.trim());
    window.open(gmailUrl, '_blank');
    setGenGmail(true);
    setTimeout(() => setGenGmail(false), 5000);
  };

  // ── LIST VIEW ──
  return (
    <div>
      <div className="page-header" style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
        <div>
          <h1>Proposals</h1>
          <p>Generate and track client proposals</p>
        </div>
        <div style={{ display:'flex', gap:10, marginTop:4 }}>
          <button className="action-btn btn-primary" style={{ fontSize:12, padding:'8px 16px' }}
            onClick={() => { setGenForm(DEFAULT_GEN); setGenStep(1); setShowGenerator(true); }}>
            + Proposal
          </button>
        </div>
      </div>

      {/* ── PROPOSAL GENERATOR WIZARD ── */}
      {showGenerator && (() => {
        const iStyle = { width:'100%', padding:'9px 12px', background:'var(--globant-darker)', border:'1px solid var(--globant-border)', borderRadius:7, color:'var(--globant-text)', fontSize:13, boxSizing:'border-box', fontFamily:'inherit' };
        const lStyle = { fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:5, display:'block' };
        const taStyle = { ...iStyle, minHeight:80, resize:'vertical', lineHeight:1.5 };

        // generateHTML and downloadProposal are defined in component body above (outside JSX)

        const steps = ['Client', 'Discovery', 'Solution', 'Preview'];
        return (
          <div className="modal-overlay" onClick={() => setShowGenerator(false)}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth:780, width:'95vw', maxHeight:'92vh', display:'flex', flexDirection:'column', padding:0, overflow:'hidden' }}>

              {/* Header */}
              <div style={{ padding:'20px 28px', borderBottom:'1px solid var(--globant-border)', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0 }}>
                <div>
                  <div style={{ fontSize:16, fontWeight:800, color:'var(--globant-text)' }}>🎨 Proposal Generator</div>
                  <div style={{ fontSize:12, color:'var(--globant-muted)', marginTop:2 }}>Create a client-ready HTML proposal</div>
                </div>
                <button onClick={() => setShowGenerator(false)} style={{ background:'none', border:'none', color:'var(--globant-muted)', cursor:'pointer', fontSize:20 }}>✕</button>
              </div>

              {/* Step indicator */}
              <div style={{ padding:'14px 28px', borderBottom:'1px solid var(--globant-border)', display:'flex', gap:8, flexShrink:0 }}>
                {steps.map((s, i) => (
                  <div key={s} onClick={() => i < genStep - 1 && setGenStep(i+1)} style={{ display:'flex', alignItems:'center', gap:6, cursor: i < genStep - 1 ? 'pointer' : 'default' }}>
                    <div style={{ width:24, height:24, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700, background: genStep > i+1 ? 'var(--globant-green)' : genStep === i+1 ? 'var(--globant-accent)' : 'var(--globant-card)', color: genStep >= i+1 ? '#0d1117' : 'var(--globant-muted)', border: genStep === i+1 ? 'none' : '1px solid var(--globant-border)' }}>
                      {genStep > i+1 ? '✓' : i+1}
                    </div>
                    <span style={{ fontSize:12, fontWeight:600, color: genStep === i+1 ? 'var(--globant-text)' : 'var(--globant-muted)' }}>{s}</span>
                    {i < steps.length - 1 && <span style={{ color:'var(--globant-border)', marginLeft:4 }}>›</span>}
                  </div>
                ))}
              </div>

              {/* Body */}
              <div style={{ flex:1, overflowY:'auto', padding:'24px 28px' }}>

                {/* STEP 1 — CLIENT */}
                {genStep === 1 && (
                  <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                    <div style={{ fontSize:13, color:'var(--globant-muted)', marginBottom:4 }}>Basic info about the prospect. This appears in the hero of the proposal.</div>

                    {/* Account picker */}
                    <div style={{ position:'relative' }}>
                      <label style={lStyle}>Link to account</label>
                      <input style={iStyle} placeholder="Search account..."
                        value={GF('accountId') ? (F(accounts.find(a=>a.id===GF('accountId')),'Account Name') || genAccSearch) : genAccSearch}
                        onFocus={() => setGenAccOpen(true)}
                        onBlur={() => setTimeout(() => setGenAccOpen(false), 150)}
                        onChange={e => { setGenAccSearch(e.target.value); setGF('accountId',''); setGenAccOpen(true); }} />
                      {GF('accountId') && (
                        <button onClick={() => { setGF('accountId',''); setGF('stakeholderId',''); setGenAccSearch(''); }} style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%) translateY(9px)', background:'none', border:'none', color:'var(--globant-muted)', cursor:'pointer', fontSize:14, lineHeight:1 }}>✕</button>
                      )}
                      {genAccOpen && (
                        <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:200, background:'var(--globant-card)', border:'1px solid var(--globant-border)', borderRadius:6, maxHeight:180, overflowY:'auto', boxShadow:'0 8px 24px rgba(0,0,0,0.4)' }}>
                          {[...accounts]
                            .filter(a => (F(a,'Account Name')||'').toLowerCase().includes(genAccSearch.toLowerCase()))
                            .sort((a,b) => (F(a,'Account Name')||'').localeCompare(F(b,'Account Name')||''))
                            .slice(0,20).map(acc => (
                            <div key={acc.id} onMouseDown={() => {
                              const name = F(acc,'Account Name') || '';
                              const industry = F(acc,'Industry') || '';
                              setGenForm(p => ({
                                ...p,
                                accountId: acc.id,
                                stakeholderId: '',
                                company: name,
                                industry: industry || p.industry,
                                slug: p.slug || name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),
                              }));
                              setGenAccSearch(''); setGenAccOpen(false);
                            }} style={{ padding:'8px 12px', cursor:'pointer', fontSize:13, background:GF('accountId')===acc.id?'rgba(91,191,181,0.15)':'transparent', color:'var(--globant-text)' }}
                            onMouseEnter={e=>e.currentTarget.style.background='rgba(91,191,181,0.1)'}
                            onMouseLeave={e=>e.currentTarget.style.background=GF('accountId')===acc.id?'rgba(91,191,181,0.15)':'transparent'}>
                              <span style={{ fontWeight:600 }}>{F(acc,'Account Name')}</span>
                              {F(acc,'Industry') && <span style={{ color:'var(--globant-muted)', marginLeft:6, fontSize:11 }}>{F(acc,'Industry')}</span>}
                            </div>
                          ))}
                          {accounts.filter(a => (F(a,'Account Name')||'').toLowerCase().includes(genAccSearch.toLowerCase())).length === 0 && (
                            <div style={{ padding:'10px 12px', fontSize:12, color:'var(--globant-muted)' }}>No accounts found</div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Stakeholder picker — filtered by selected account */}
                    <div style={{ position:'relative' }}>
                      <label style={lStyle}>Proposal directed to (stakeholder)</label>
                      {(() => {
                        const accStakeholders = GF('accountId')
                          ? stakeholders.filter(s => linkedIds(s,'Account').includes(GF('accountId')))
                          : stakeholders;
                        const selectedStk = GF('stakeholderId') ? accStakeholders.find(s=>s.id===GF('stakeholderId')) : null;
                        return (
                          <div style={{ position:'relative' }}>
                            <select style={{ ...iStyle, appearance:'none', paddingRight:30 }}
                              value={GF('stakeholderId')}
                              onChange={e => {
                                const stk = accStakeholders.find(s=>s.id===e.target.value);
                                if (stk) {
                                  setGenForm(p => ({
                                    ...p,
                                    stakeholderId: stk.id,
                                    contact: F(stk,'Name') || p.contact,
                                    contactTitle: F(stk,'Title') || F(stk,'Role') || p.contactTitle,
                                  }));
                                } else {
                                  setGF('stakeholderId','');
                                }
                              }}>
                              <option value="">{GF('accountId') ? (accStakeholders.length ? '— pick a stakeholder —' : 'No stakeholders for this account') : '— select account first —'}</option>
                              {accStakeholders.map(s => (
                                <option key={s.id} value={s.id}>{F(s,'Name')}{F(s,'Title') ? ' · ' + F(s,'Title') : ''}</option>
                              ))}
                            </select>
                            <span style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', pointerEvents:'none', color:'var(--globant-muted)', fontSize:12 }}>▼</span>
                          </div>
                        );
                      })()}
                    </div>

                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                      <div><label style={lStyle}>Company name *</label><input style={iStyle} value={GF('company')} onChange={e=>setGF('company',e.target.value)} placeholder="Acme Corp" autoFocus /></div>
                      <div><label style={lStyle}>URL slug</label><input style={iStyle} value={GF('slug')} onChange={e=>setGF('slug',e.target.value.toLowerCase().replace(/\s+/g,'-'))} placeholder="acme-corp" /><div style={{ fontSize:10, color:'var(--globant-muted)', marginTop:4 }}>oike.app/{GF('slug')||'slug'}</div></div>
                    </div>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                      <div><label style={lStyle}>Contact name *</label><input style={iStyle} value={GF('contact')} onChange={e=>setGF('contact',e.target.value)} placeholder="Jorge Hidalgo" /></div>
                      <div><label style={lStyle}>Title / Role</label><input style={iStyle} value={GF('contactTitle')} onChange={e=>setGF('contactTitle',e.target.value)} placeholder="CEO & Partner" /></div>
                    </div>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                      <div><label style={lStyle}>Industry</label><input style={iStyle} value={GF('industry')} onChange={e=>setGF('industry',e.target.value)} placeholder="ERP consulting" /></div>
                      <div>
                        <label style={lStyle}>Proposal language</label>
                        <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                          {[['en','🇬🇧 English'],['es','🇪🇸 Español'],['pt','🇧🇷 Português'],['fr','🇫🇷 Français']].map(([code,label]) => (
                            <button key={code} onClick={() => setGF('language', code)}
                              style={{ padding:'6px 12px', borderRadius:6, border:'1px solid', fontSize:12, cursor:'pointer', fontWeight: GF('language')===code ? 700 : 400,
                                borderColor: GF('language')===code ? 'var(--globant-accent)' : 'var(--globant-border)',
                                background: GF('language')===code ? 'rgba(91,191,181,0.12)' : 'var(--globant-card)',
                                color: GF('language')===code ? 'var(--globant-accent)' : 'var(--globant-muted)' }}>
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    {(GF('senderName') || GF('senderLogo')) && (
                      <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', background:'rgba(91,191,181,0.06)', border:'1px solid rgba(91,191,181,0.2)', borderRadius:8 }}>
                        {GF('senderLogo') && <img src={GF('senderLogo')} alt="" style={{ height:20, maxWidth:80, objectFit:'contain' }} onError={e=>e.target.style.display='none'} />}
                        <span style={{ fontSize:12, color:'var(--globant-muted)' }}>Branding: <strong style={{ color:'var(--globant-text)' }}>{GF('senderName')}</strong></span>
                        <a onClick={() => setTab && setTab('proposals')} style={{ marginLeft:'auto', fontSize:11, color:'var(--globant-accent)', cursor:'pointer', textDecoration:'underline' }}>Edit in Settings</a>
                      </div>
                    )}
                  </div>
                )}

                {/* STEP 2 — DISCOVERY */}
                {genStep === 2 && (
                  <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                    <div style={{ fontSize:13, color:'var(--globant-muted)', marginBottom:4 }}>Everything you learned in the discovery call. The more specific, the more personalized the proposal looks.</div>
                    <div><label style={lStyle}>What we heard (discovery context)</label><textarea style={{...taStyle, minHeight:100}} value={GF('discovery')} onChange={e=>setGF('discovery',e.target.value)} placeholder="In our conversation, we learned that Appex is the #1 ODOO partner in Bolivia — they went from #10 to #1 in 2 years. Today they manage 40+ prospects with only 2 commercial people and 100% inbound..." /></div>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10 }}>
                      <div><label style={lStyle}>Pain point 1</label><textarea style={{...taStyle, minHeight:70}} value={GF('pain1')} onChange={e=>setGF('pain1',e.target.value)} placeholder="No outbound prospecting system — all leads come from inbound only" /></div>
                      <div><label style={lStyle}>Pain point 2</label><textarea style={{...taStyle, minHeight:70}} value={GF('pain2')} onChange={e=>setGF('pain2',e.target.value)} placeholder="Commercial team is too small to manage the full pipeline manually" /></div>
                      <div><label style={lStyle}>Pain point 3</label><textarea style={{...taStyle, minHeight:70}} value={GF('pain3')} onChange={e=>setGF('pain3',e.target.value)} placeholder="Entering new markets (Mexico, DR) requires proactive outreach they don't have capacity for" /></div>
                    </div>
                    <div><label style={lStyle}>Client's declared goal (their words)</label><input style={iStyle} value={GF('goalQuote')} onChange={e=>setGF('goalQuote',e.target.value)} placeholder="We want to attack Mexico and the DR without hiring more people" /></div>
                    <div><label style={lStyle}>Root problem / diagnosis</label><textarea style={{...taStyle, minHeight:90}} value={GF('rootProblem')} onChange={e=>setGF('rootProblem',e.target.value)} placeholder="They've grown to #1 by being reactive. The next stage of growth requires being proactive — a system that generates pipeline in new markets without depending on referrals or ODOO's platform." /></div>
                    <button onClick={polishDiscovery} disabled={genPolishing}
                      style={{ padding:'10px 18px', borderRadius:8, border:'1px solid rgba(167,139,250,0.4)', background:genPolishing?'rgba(167,139,250,0.05)':'rgba(167,139,250,0.1)', color:'#c4b5fd', fontWeight:700, fontSize:13, cursor:genPolishing?'not-allowed':'pointer', display:'flex', alignItems:'center', gap:8, marginTop:4 }}>
                      {genPolishing ? '⏳ Improving...' : '✨ Polish with AI — in ' + ({'en':'English','es':'Español','pt':'Português','fr':'Français'}[GF('language')||'en'] || 'English')}
                    </button>
                  </div>
                )}

                {/* STEP 3 — SOLUTION */}
                {genStep === 3 && (
                  <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                    <div style={{ fontSize:13, color:'var(--globant-muted)', marginBottom:4 }}>Pick an offering from your Offering Hub to auto-fill the fields, then customize freely.</div>

                    {/* Offering Hub picker */}
                    <div>
                      <label style={lStyle}>Load from Offering Hub</label>
                      {solutions && solutions.length > 0 ? (
                        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                          {solutions.filter(s => F(s,'Name')).map(sol => {
                            const name = F(sol,'Name') || '';
                            const type = F(sol,'Type') || '';
                            const desc = F(sol,'Description') || '';
                            const keyMsg = F(sol,'Key Message') || '';
                            const price = sol.fields?.['Price'] ? `$${sol.fields['Price']}` : '';
                            const isSelected = GF('optionName') === name && GF('optionDesc') === desc;
                            return (
                              <button key={sol.id}
                                onClick={() => {
                                  const features = keyMsg
                                    ? keyMsg.split('\n').map(l => l.replace(/^[-•*]\s*/,'')).filter(Boolean)
                                    : [];
                                  setGenForm(p => ({...p,
                                    optionName: name,
                                    optionSubtitle: type,
                                    optionDesc: desc,
                                    optionFeatures: features.length ? features : [''],
                                  }));
                                }}
                                style={{ width:'100%', padding:'12px 14px', borderRadius:8, border:'1px solid', textAlign:'left', cursor:'pointer',
                                  borderColor: isSelected ? 'var(--globant-accent)' : 'var(--globant-border)',
                                  background: isSelected ? 'rgba(91,191,181,0.08)' : 'var(--globant-card)',
                                }}>
                                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                                  <span style={{ fontWeight:700, fontSize:13, color: isSelected ? 'var(--globant-accent)' : 'var(--globant-text)' }}>{name}</span>
                                  <span style={{ fontSize:11, color:'var(--globant-muted)' }}>{price}{type ? (price ? ' · ' : '') + type : ''}</span>
                                </div>
                                {desc && <div style={{ fontSize:12, color:'var(--globant-muted)', marginTop:3, lineHeight:1.4, overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis' }}>{desc.slice(0,90)}{desc.length>90?'…':''}</div>}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div style={{ padding:'12px 14px', borderRadius:8, border:'1px solid var(--globant-border)', fontSize:12, color:'var(--globant-muted)' }}>
                          No offering found. Add them in Offering Hub or fill the fields manually below.
                        </div>
                      )}
                      <div style={{ fontSize:11, color:'var(--globant-muted)', marginTop:6 }}>Selecting a solution fills the fields below — edit them freely after.</div>
                    </div>

                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                      <div><label style={lStyle}>Option name</label><input style={iStyle} value={GF('optionName')} onChange={e=>setGF('optionName',e.target.value)} /></div>
                      <div><label style={lStyle}>Subtitle / type</label><input style={iStyle} value={GF('optionSubtitle')} onChange={e=>setGF('optionSubtitle',e.target.value)} /></div>
                    </div>
                    <div><label style={lStyle}>Description</label><textarea style={taStyle} value={GF('optionDesc')} onChange={e=>setGF('optionDesc',e.target.value)} /></div>
                    <div>
                      <label style={lStyle}>Features (one per line)</label>
                      <textarea style={{...taStyle, minHeight:110}} value={genForm.optionFeatures.join('\n')} onChange={e=>setGF('optionFeatures', e.target.value.split('\n'))} />
                    </div>
                    <div><label style={lStyle}>Why this solution fits this client</label><textarea style={{...taStyle, minHeight:90}} value={GF('whySolution')} onChange={e=>setGF('whySolution',e.target.value)} placeholder="Appex needs to attack new markets without hiring. Option B gives them the system + the ongoing guidance to operate it as a team, without needing to fully delegate execution." /></div>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10 }}>
                      <div><label style={lStyle}>Next step 1</label><input style={iStyle} value={GF('nextStep1')} onChange={e=>setGF('nextStep1',e.target.value)} /></div>
                      <div><label style={lStyle}>Next step 2</label><input style={iStyle} value={GF('nextStep2')} onChange={e=>setGF('nextStep2',e.target.value)} /></div>
                      <div><label style={lStyle}>Next step 3</label><input style={iStyle} value={GF('nextStep3')} onChange={e=>setGF('nextStep3',e.target.value)} /></div>
                    </div>
                    <button onClick={polishSolution} disabled={genPolishing}
                      style={{ padding:'10px 18px', borderRadius:8, border:'1px solid rgba(167,139,250,0.4)', background:genPolishing?'rgba(167,139,250,0.05)':'rgba(167,139,250,0.1)', color:'#c4b5fd', fontWeight:700, fontSize:13, cursor:genPolishing?'not-allowed':'pointer', display:'flex', alignItems:'center', gap:8, marginTop:4 }}>
                      {genPolishing ? '⏳ Improving...' : '✨ Polish with AI — in ' + ({'en':'English','es':'Español','pt':'Português','fr':'Français'}[GF('language')||'en'] || 'English')}
                    </button>
                  </div>
                )}

                {/* STEP 4 — PREVIEW */}
                {genStep === 4 && (
                  <div>
                    <div style={{ fontSize:13, color:'var(--globant-muted)', marginBottom:16 }}>Your proposal is ready. Send it directly via Gmail, copy to paste in any email client, or download.</div>

                    {/* Primary actions */}
                    {(() => {
                      const stk = GF('stakeholderId') ? stakeholders.find(s => s.id === GF('stakeholderId')) : null;
                      const toEmail = stk ? (F(stk, 'Email') || '') : '';
                      const stkName = stk ? (F(stk, 'Name') || '') : '';
                      return (
                        <div>
                          <div style={{ display:'flex', gap:10, marginBottom:10 }}>
                            <button onClick={openProposalInGmail} style={{ flex:1, padding:'14px', borderRadius:10, background:'rgba(66,133,244,0.15)', border:'1px solid rgba(66,133,244,0.4)', color:'#60a5fa', fontWeight:800, fontSize:14, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                              {genGmail
                                ? '✅ HTML copiado — pegalo en Gmail'
                                : toEmail
                                  ? '📧 Enviar a ' + stkName + ' (' + toEmail + ')'
                                  : '📧 Open in Gmail'}
                            </button>
                          </div>
                          {!toEmail && !genGmail && (
                            <div style={{ fontSize:11, color:'var(--globant-muted)', marginBottom:10, paddingLeft:2 }}>
                              💡 Select a stakeholder in Step 1 to pre-fill the recipient
                            </div>
                          )}
                          {genGmail && (
                            <div style={{ padding:'10px 14px', borderRadius:8, background:'rgba(66,133,244,0.08)', border:'1px solid rgba(66,133,244,0.2)', fontSize:12, color:'#93c5fd', marginBottom:10 }}>
                              {toEmail
                                ? 'Gmail opened with ' + toEmail + ' as recipient and subject pre-filled. Just paste with '
                                : 'Gmail opened. Paste with '}
                              <strong>Ctrl+V</strong> (or ⌘V) in the email body.
                            </div>
                          )}
                          <div style={{ display:'flex', gap:10, marginBottom:10 }}>
                            <button onClick={copyProposalHTML} style={{ flex:1, padding:'11px', borderRadius:10, background:'var(--globant-card)', border:'1px solid var(--globant-border)', color:'var(--globant-muted)', fontWeight:600, fontSize:13, cursor:'pointer' }}>
                              {genCopied ? '✅ Copied!' : '📋 Copy HTML only'}
                            </button>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Secondary actions */}
                    <div style={{ display:'flex', gap:10, marginBottom:20 }}>
                      <button onClick={() => printAsPdf(generateHTML())} style={{ flex:1, padding:'10px', borderRadius:10, background:'transparent', border:'1px solid var(--globant-border)', color:'var(--globant-muted)', fontWeight:600, fontSize:13, cursor:'pointer' }}>
                        🖨️ Download PDF
                      </button>
                      <button onClick={() => { const w=window.open(); w.document.write(generateEmailHTML()); w.document.close(); }} style={{ flex:1, padding:'10px', borderRadius:10, background:'transparent', border:'1px solid var(--globant-border)', color:'var(--globant-muted)', fontWeight:600, fontSize:13, cursor:'pointer' }}>
                        👁 Preview email
                      </button>
                      <button onClick={downloadProposal} style={{ flex:1, padding:'10px', borderRadius:10, background:'transparent', border:'1px solid var(--globant-border)', color:'var(--globant-muted)', fontWeight:600, fontSize:13, cursor:'pointer' }}>
                        ⬇️ Webpage .html
                      </button>
                    </div>
                    <div style={{ padding:'20px 24px', background:'var(--globant-card)', borderRadius:10, border:'1px solid var(--globant-border)' }}>
                      <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:14 }}>Summary</div>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, fontSize:13 }}>
                        {[['Company', GF('company')], ['Contact', GF('contact') + (GF('contactTitle') ? `, ${GF('contactTitle')}` : '')], ['URL', `oike.app/${GF('slug')}`], ['Option', `${GF('option')} — ${GF('optionName')}`]].map(([k,v]) => (
                          <div key={k} style={{ display:'flex', gap:8 }}>
                            <span style={{ color:'var(--globant-muted)', minWidth:60 }}>{k}</span>
                            <span style={{ color:'var(--globant-text)', fontWeight:500 }}>{v || '—'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Footer nav */}
              <div style={{ padding:'16px 28px', borderTop:'1px solid var(--globant-border)', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0 }}>
                <button onClick={() => genStep > 1 ? setGenStep(s=>s-1) : setShowGenerator(false)} style={{ padding:'9px 20px', borderRadius:8, border:'1px solid var(--globant-border)', background:'transparent', color:'var(--globant-muted)', cursor:'pointer', fontSize:13 }}>
                  {genStep === 1 ? 'Cancel' : '← Back'}
                </button>
                <div style={{ fontSize:12, color:'var(--globant-muted)' }}>Step {genStep} of {steps.length}</div>
                {genStep < steps.length ? (
                  <button onClick={() => setGenStep(s=>s+1)} style={{ padding:'9px 24px', borderRadius:8, border:'none', background:'var(--globant-accent)', color:'#0d1117', fontWeight:700, cursor:'pointer', fontSize:13 }}>
                    Next →
                  </button>
                ) : (
                  <button onClick={copyProposalHTML} style={{ padding:'9px 24px', borderRadius:8, border:'none', background:'var(--globant-accent)', color:'#0d1117', fontWeight:700, cursor:'pointer', fontSize:13 }}>
                    {genCopied ? '✅ Copied!' : '📋 Copy for email'}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* New Proposal Modal */}
      {showNew && (
        <div className="modal-overlay" onClick={() => setShowNew(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth:580, maxHeight:'90vh', overflowY:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
              <h3 style={{ margin:0 }}>📋 New Proposal</h3>
              <button onClick={() => setShowNew(false)} style={{ background:'none', border:'none', color:'var(--globant-muted)', cursor:'pointer', fontSize:18 }}>✕</button>
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <div>
                <label style={labelStyle}>Title *</label>
                <input style={inputStyle} value={form.title} onChange={e => setForm(p=>({...p,title:e.target.value}))} placeholder="e.g. Oike Pro Proposal — Acme Corp" autoFocus />
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                <div>
                  <label style={labelStyle}>Status</label>
                  <select style={inputStyle} value={form.status} onChange={e => setForm(p=>({...p,status:e.target.value}))}>
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Amount (USD)</label>
                  <input style={inputStyle} type="number" value={form.amount} onChange={e => setForm(p=>({...p,amount:e.target.value}))} placeholder="5000" />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Presented Date</label>
                <input style={inputStyle} type="date" value={form.presentedDate} onChange={e => setForm(p=>({...p,presentedDate:e.target.value}))} />
              </div>
              {/* ── Account combobox ── */}
              <div style={{ position:'relative' }}>
                <label style={labelStyle}>Account</label>
                <input style={inputStyle} placeholder="Type to search account..."
                  value={form.accountId ? (F(accounts.find(a=>a.id===form.accountId),'Account Name')||accSearch) : accSearch}
                  onFocus={() => setAccOpen(true)}
                  onBlur={() => setTimeout(() => setAccOpen(false), 150)}
                  onChange={e => { setAccSearch(e.target.value); setForm(p=>({...p,accountId:''})); setAccOpen(true); }} />
                {accOpen && (
                  <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:99, background:'var(--globant-card)', border:'1px solid var(--globant-border)', borderRadius:6, maxHeight:180, overflowY:'auto', boxShadow:'0 8px 24px rgba(0,0,0,0.4)' }}>
                    {[...accounts]
                      .filter(a => (F(a,'Account Name')||'').toLowerCase().includes(accSearch.toLowerCase()))
                      .sort((a,b) => (F(a,'Account Name')||'').localeCompare(F(b,'Account Name')||''))
                      .slice(0,20).map(a => (
                      <div key={a.id} onMouseDown={() => { setForm(p=>({...p,accountId:a.id,stakeholderIds:[]})); setAccSearch(''); setAccOpen(false); }}
                        style={{ padding:'8px 12px', cursor:'pointer', fontSize:13, background:form.accountId===a.id?'rgba(91,191,181,0.15)':'transparent', color:form.accountId===a.id?'var(--globant-green)':'var(--globant-text)' }}
                        onMouseEnter={e=>e.currentTarget.style.background='rgba(91,191,181,0.1)'}
                        onMouseLeave={e=>e.currentTarget.style.background=form.accountId===a.id?'rgba(91,191,181,0.15)':'transparent'}>
                        {F(a,'Account Name')}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Solutions combobox ── */}
              <div style={{ position:'relative' }}>
                <label style={labelStyle}>Offering</label>
                {form.solutionIds.length > 0 && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:6 }}>
                    {form.solutionIds.map(id => { const s = solutions.find(x=>x.id===id); return s ? (
                      <span key={id} style={{ background:'rgba(91,191,181,0.15)', color:'var(--globant-green)', borderRadius:4, padding:'2px 8px', fontSize:11, display:'flex', alignItems:'center', gap:4 }}>
                        {F(s,'Name')}
                        <span style={{ cursor:'pointer', fontWeight:700 }} onMouseDown={e=>{e.preventDefault();setForm(p=>({...p,solutionIds:p.solutionIds.filter(x=>x!==id)}))}}>✕</span>
                      </span>
                    ) : null; })}
                  </div>
                )}
                <input style={inputStyle} placeholder="Type to search solutions..."
                  value={solSearch}
                  onFocus={() => setSolOpen(true)}
                  onBlur={() => setTimeout(() => setSolOpen(false), 150)}
                  onChange={e => { setSolSearch(e.target.value); setSolOpen(true); }} />
                {solOpen && (
                  <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:99, background:'var(--globant-card)', border:'1px solid var(--globant-border)', borderRadius:6, maxHeight:160, overflowY:'auto', boxShadow:'0 8px 24px rgba(0,0,0,0.4)' }}>
                    {[...solutions]
                      .filter(s => (F(s,'Name')||'').toLowerCase().includes(solSearch.toLowerCase()) && !form.solutionIds.includes(s.id))
                      .sort((a,b) => (F(a,'Name')||'').localeCompare(F(b,'Name')||''))
                      .slice(0,15).map(s => (
                      <div key={s.id} onMouseDown={() => { setForm(p=>({...p,solutionIds:[...p.solutionIds,s.id]})); setSolSearch(''); }}
                        style={{ padding:'8px 12px', cursor:'pointer', fontSize:13 }}
                        onMouseEnter={e=>e.currentTarget.style.background='rgba(91,191,181,0.1)'}
                        onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                        {F(s,'Name')}{F(s,'Type') ? <span style={{ fontSize:10, color:'var(--globant-muted)', marginLeft:8 }}>{F(s,'Type')}</span> : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Stakeholders combobox ── */}
              <div style={{ position:'relative' }}>
                <label style={labelStyle}>Stakeholders</label>
                {form.stakeholderIds.length > 0 && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:6 }}>
                    {form.stakeholderIds.map(id => { const s = stakeholders.find(x=>x.id===id); return s ? (
                      <span key={id} style={{ background:'rgba(96,165,250,0.15)', color:'var(--globant-info)', borderRadius:4, padding:'2px 8px', fontSize:11, display:'flex', alignItems:'center', gap:4 }}>
                        {F(s,'Name')}{F(s,'Last name') ? ` ${F(s,'Last name')}` : ''}
                        <span style={{ cursor:'pointer', fontWeight:700 }} onMouseDown={e=>{e.preventDefault();setForm(p=>({...p,stakeholderIds:p.stakeholderIds.filter(x=>x!==id)}))}}>✕</span>
                      </span>
                    ) : null; })}
                  </div>
                )}
                <input style={inputStyle} placeholder="Type to search stakeholders..."
                  value={stkSearch}
                  onFocus={() => setStkOpen(true)}
                  onBlur={() => setTimeout(() => setStkOpen(false), 150)}
                  onChange={e => { setStkSearch(e.target.value); setStkOpen(true); }} />
                {stkOpen && (
                  <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:99, background:'var(--globant-card)', border:'1px solid var(--globant-border)', borderRadius:6, maxHeight:160, overflowY:'auto', boxShadow:'0 8px 24px rgba(0,0,0,0.4)' }}>
                    {[...stakeholders]
                      .filter(s => !form.stakeholderIds.includes(s.id) &&
                        (!form.accountId || linkedIds(s,'Account').includes(form.accountId)) &&
                        (`${F(s,'Name')||''} ${F(s,'Last name')||''} ${F(s,'Role')||''}`).toLowerCase().includes(stkSearch.toLowerCase()))
                      .sort((a,b) => (F(a,'Name')||'').localeCompare(F(b,'Name')||''))
                      .slice(0,20).map(s => (
                      <div key={s.id} onMouseDown={() => { setForm(p=>({...p,stakeholderIds:[...p.stakeholderIds,s.id]})); setStkSearch(''); }}
                        style={{ padding:'8px 12px', cursor:'pointer', fontSize:13 }}
                        onMouseEnter={e=>e.currentTarget.style.background='rgba(96,165,250,0.1)'}
                        onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                        <span style={{ fontWeight:600 }}>{F(s,'Name')}{F(s,'Last name') ? ` ${F(s,'Last name')}` : ''}</span>
                        {F(s,'Role') && <span style={{ fontSize:11, color:'var(--globant-muted)', marginLeft:8 }}>{F(s,'Role')}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label style={labelStyle}>Document URL (optional)</label>
                <input style={inputStyle} type="url" placeholder="https://drive.google.com/... or public Dropbox/OneDrive link"
                  value={form.documentUrl} onChange={e => setForm(p=>({...p,documentUrl:e.target.value}))} />
                <div style={{ fontSize:10, color:'var(--globant-muted)', marginTop:4 }}>Paste a public link to your PDF — Airtable will download and store it automatically.</div>
              </div>
              <div>
                <label style={labelStyle}>Description</label>
                <textarea style={{ ...inputStyle, minHeight:70, resize:'vertical' }} value={form.description} onChange={e => setForm(p=>({...p,description:e.target.value}))} placeholder="Summary of what this proposal covers..." />
              </div>
              <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
                <button className="action-btn btn-ghost" onClick={() => setShowNew(false)}>Cancel</button>
                <button className="action-btn btn-primary" onClick={handleCreate} disabled={saving || !form.title.trim()}>
                  {saving ? '⏳ Creating...' : '✅ Create Proposal'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* KPIs */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:14, marginBottom:24 }}>
        {[['All', null], ...STATUSES.map(s => [s, s])].map(([label, statusKey]) => {
          const count = statusKey ? proposals.filter(p => F(p,'Status') === statusKey).length : proposals.length;
          const color = statusKey ? STATUS_COLOR[statusKey] : 'var(--globant-green)';
          const isActive = filterStatus === (statusKey||'');
          return (
            <div key={label} className="card" style={{ textAlign:'center', padding:'12px 8px', cursor:'pointer', border:isActive ? `1px solid ${color}` : undefined, background:isActive ? `${STATUS_BG[statusKey]||'rgba(91,191,181,0.08)'}` : undefined }}
              onClick={() => setFilterStatus(statusKey||'')}>
              <div style={{ fontSize:24, fontWeight:800, color, lineHeight:1 }}>{count}</div>
              <div style={{ fontSize:10, color:'var(--globant-muted)', marginTop:4 }}>{label}</div>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div className="filters-row" style={{ display:'flex', gap:10, alignItems:'center', marginBottom:16 }}>
        <input className="input-field" style={{ maxWidth:300 }} placeholder="Search proposals..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
        <select className="input-field" style={{ maxWidth:220, fontSize:12 }} value={filterAccountId} onChange={e => setFilterAccountId(e.target.value)}>
          <option value="">🏢 All accounts</option>
          {[...accounts].sort((a,b) => (F(a,'Account Name')||'').localeCompare(F(b,'Account Name')||'')).map(a => (
            <option key={a.id} value={a.id}>{F(a,'Account Name')}</option>
          ))}
        </select>
        {(searchTerm || filterStatus || filterAccountId) && (
          <span style={{ fontSize:11, color:'var(--globant-green)', cursor:'pointer', padding:'4px 8px', background:'rgba(91,191,181,0.1)', borderRadius:5, fontWeight:600 }}
            onClick={() => { setSearchTerm(''); setFilterStatus(''); setFilterAccountId(''); }}>✕ Clear</span>
        )}
        <span style={{ fontSize:12, color:'var(--globant-muted)', marginLeft:'auto' }}>{filtered.length} presentation{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Table */}
      <div className="card">
        <div style={{ overflowX:'auto' }}>
          <table className="data-table">
            <thead><tr>
              <th>Title</th>
              <th>Status</th>
              <th>Account</th>
              <th>Offering</th>
              <th style={{ textAlign:'right' }}>Amount</th>
              <th>Presented</th>
              <th>Document</th>
            </tr></thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} style={{ textAlign:'center', color:'var(--globant-muted)', padding:24 }}>No proposals found.</td></tr>
              ) : filtered.map(p => {
                const status = F(p,'Status') || 'Draft';
                const acc = accounts.find(a => linkedIds(p,'Account').includes(a.id));
                const solNames = linkedIds(p,'Solutions').map(id => { const s = solutions.find(x=>x.id===id); return s ? F(s,'Name') : null; }).filter(Boolean);
                const amount = p.fields?.['Amount'];
                return (
                  <tr key={p.id} onClick={() => selectProposal(p.id)} style={{ cursor:'pointer' }}>
                    <td style={{ fontWeight:600 }}>{F(p,'Title')}</td>
                    <td><span style={{ background:STATUS_BG[status], color:STATUS_COLOR[status], borderRadius:5, padding:'2px 8px', fontSize:11, fontWeight:700 }}>{status}</span></td>
                    <td style={{ fontSize:12 }}>{acc ? F(acc,'Account Name') : '—'}</td>
                    <td style={{ fontSize:11, color:'var(--globant-muted)' }}>{solNames.length ? solNames.join(', ') : '—'}</td>
                    <td style={{ textAlign:'right', fontWeight:700, color:'var(--globant-green)' }}>{amount ? formatCurrency(amount) : '—'}</td>
                    <td style={{ fontSize:12 }}>{F(p,'Presented Date') ? formatDate(F(p,'Presented Date')) : '—'}</td>
                    <td style={{ fontSize:12 }}>{F(p,'Document') ? <a href={F(p,'Document')} target="_blank" rel="noopener noreferrer" style={{ color:'var(--globant-info)' }} onClick={e=>e.stopPropagation()}>Open ↗</a> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ============ CAMPAIGNS HUB ============

export default ProposalsHub;
