import React from 'react'
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
} from '../utils.jsx';
import StakeholderHistoryModal from './StakeholderHistoryModal.jsx';
import AIMessageModal from './AIMessageModal.jsx';
import { getMatchingICPs } from '../utils/icpMatch.js';
import AccountsList from './AccountsList.jsx';
import AccountIntelTab from './AccountIntelTab.jsx';
import AccountContactsTab from './AccountContactsTab.jsx';
import AccountProposalsTab from './AccountProposalsTab.jsx';
import AccountStrategyTab from './AccountStrategyTab.jsx';
import AccountIntakeTab from './AccountIntakeTab.jsx';


function CPBriefings({ data, api, onLogActivity, onAddRecord, onUpdateRecord, onDeleteRecord, navigateToAccountId, clearNavigate, navigateToAccountTab, clearNavigateTab, goToAccount, goToProposal, goToMessageLab }) {
  const { accounts, stakeholders, opportunities, actionPlan, outreach, solutions, events, users = [], campaigns = [], landings = [], icp = [] } = data;
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const isAdmin = CURRENT_USER?.role === 'admin';
  // Wrapper that keeps URL in sync with the selected account
  const selectAccount = useCallback((id) => {
    setSelectedAccountId(id || '');
    navSetUrl('accounts', id || null);
    // Load AI Notes from Airtable for this account (hydrates localStorage cache)
    if (id) {
      const acct = (data.accounts || []).find(a => a.id === id);
      const aiNotes = acct?.fields?.['AI Notes'];
      if (aiNotes) {
        try {
          const parsed = JSON.parse(aiNotes);
          if (parsed.execSummary) setExecSummaryData(prev => ({ ...prev, [id]: parsed.execSummary }));
          if (parsed.meddpicc) setMeddpiccData(prev => ({ ...prev, [id]: parsed.meddpicc }));
        } catch {}
      }
    }
  }, [data.accounts]);

  // Handle navigation from other pages (and URL restore on refresh)
  useEffect(() => {
    if (navigateToAccountId) {
      selectAccount(navigateToAccountId);
      setSearchTerm('');
      if (navigateToAccountTab) setAccDetailTab(navigateToAccountTab);
      if (clearNavigate) clearNavigate();
      if (clearNavigateTab) clearNavigateTab();
    }
  }, [navigateToAccountId, clearNavigate, navigateToAccountTab, clearNavigateTab]);
  const [talkingPoints, setTalkingPoints] = useState('');
  const [loadingTP, setLoadingTP] = useState(false);
  const EXEC_SUMMARY_LS_KEY = 'oike_exec_summaries';
  const [execSummaryData, setExecSummaryData] = useState(() => {
    try { return JSON.parse(localStorage.getItem(EXEC_SUMMARY_LS_KEY) || '{}'); } catch { return {}; }
  });
  const [loadingSummary, setLoadingSummary] = useState(false);
  const execSummaryEntry = selectedAccountId ? (execSummaryData[selectedAccountId] || null) : null;
  const execSummary = execSummaryEntry?.text || '';
  const execSummaryUpdatedAt = execSummaryEntry?.updatedAt || null;
  const setExecSummary = (text) => {
    const updatedAt = new Date().toISOString();
    setExecSummaryData(prev => {
      const next = { ...prev, [selectedAccountId]: { text, updatedAt } };
      try { localStorage.setItem(EXEC_SUMMARY_LS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
    // Persist to Airtable in background
    if (selectedAccountId && onUpdateRecord) {
      const a = api || new AirtableAPI();
      const current = account ? (JSON.parse(account.fields?.['AI Notes'] || '{}')) : {};
      const updated = { ...current, execSummary: { text, updatedAt } };
      a.updateRecord(TABLE_IDS.accounts, selectedAccountId, { 'AI Notes': JSON.stringify(updated) }).catch(() => {});
      onUpdateRecord('accounts', selectedAccountId, { 'AI Notes': JSON.stringify(updated) });
    }
  };
  // ── MEDDPICC ──
  const MEDDPICC_LS_KEY = 'oike_meddpicc';
  const MEDDPICC_FIELDS = [
    { key: 'metrics',         label: 'M — Metrics',           hint: 'What measurable value does the solution deliver? (ROI, cost savings, % improvement)' },
    { key: 'economicBuyer',   label: 'E — Economic Buyer',    hint: 'Who has budget authority and can sign off?' },
    { key: 'decisionCriteria',label: 'D — Decision Criteria',  hint: 'How will they evaluate and compare options?' },
    { key: 'decisionProcess', label: 'D — Decision Process',   hint: 'What is the internal approval process and timeline?' },
    { key: 'paperProcess',    label: 'P — Paper Process',      hint: 'What is the contracting, legal, and procurement process?' },
    { key: 'identifyPain',    label: 'I — Identify Pain',      hint: 'What is the core problem they need to solve urgently?' },
    { key: 'champion',        label: 'C — Champion',           hint: 'Who inside the account is advocating for you?' },
    { key: 'competition',     label: 'C — Competition',        hint: 'Who else are they evaluating? What is your differentiator?' },
  ];
  const [meddpiccData, setMeddpiccData] = useState(() => {
    try { return JSON.parse(localStorage.getItem(MEDDPICC_LS_KEY) || '{}'); } catch { return {}; }
  });
  const [loadingMeddpicc, setLoadingMeddpicc] = useState(false);
  const [editingMeddpicc, setEditingMeddpicc] = useState(false);
  const [meddpiccDraft, setMeddpiccDraft] = useState({});
  const [meddpiccExpanded, setMeddpiccExpanded] = useState(false);
  const meddpiccEntry = selectedAccountId ? (meddpiccData[selectedAccountId] || null) : null;
  const meddpiccValues = meddpiccEntry?.fields || {};
  const meddpiccUpdatedAt = meddpiccEntry?.updatedAt || null;
  const saveMeddpicc = (fields) => {
    const updatedAt = new Date().toISOString();
    setMeddpiccData(prev => {
      const next = { ...prev, [selectedAccountId]: { fields, updatedAt } };
      try { localStorage.setItem(MEDDPICC_LS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
    // Persist to Airtable in background
    if (selectedAccountId && onUpdateRecord) {
      const a = api || new AirtableAPI();
      const current = account ? (JSON.parse(account.fields?.['AI Notes'] || '{}')) : {};
      const updated = { ...current, meddpicc: { fields, updatedAt } };
      a.updateRecord(TABLE_IDS.accounts, selectedAccountId, { 'AI Notes': JSON.stringify(updated) }).catch(() => {});
      onUpdateRecord('accounts', selectedAccountId, { 'AI Notes': JSON.stringify(updated) });
    }
  };

  const [historyStakeholder, setHistoryStakeholder] = useState(null);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [editingStkNotes, setEditingStkNotes] = useState(null); // stakeholder id
  const [stkNotesValue, setStkNotesValue] = useState('');
  const [savingStkNotes, setSavingStkNotes] = useState(false);
  const [contactRecs, setContactRecs] = useState('');
  const [loadingRecs, setLoadingRecs] = useState(false);
  const [stakeholderSearch, setStakeholderSearch] = useState('');
  const [filterSolutionId, setFilterSolutionId] = useState('');
  const [filterIndustry, setFilterIndustry] = useState('');
  const [filterCountry, setFilterCountry] = useState('');
  const [filterCPId, setFilterCPId] = useState('');
  const [selectedAccountIds, setSelectedAccountIds] = useState(new Set());
  const [deletingAccounts, setDeletingAccounts] = useState(false);
  const bulkDeleteAccounts = async () => {
    if (selectedAccountIds.size === 0) return;
    if (!window.confirm(`Delete ${selectedAccountIds.size} account${selectedAccountIds.size > 1 ? 's' : ''} and all their contacts, outreach and opportunities? This cannot be undone.`)) return;
    setDeletingAccounts(true);
    const a = api || new AirtableAPI();
    const ids = [...selectedAccountIds];
    for (const id of ids) {
      try {
        const acct = accounts.find(ac => ac.id === id);
        if (acct) {
          const stkIds = linkedIds(acct, 'Stakeholders');
          for (const sid of stkIds) {
            await a.deleteRecord(TABLE_IDS.stakeholders, sid).catch(() => {});
            if (onDeleteRecord) onDeleteRecord('stakeholders', sid);
          }
          const relOutreach = (data.outreach || []).filter(o => linkedIds(o, 'Account').includes(id));
          for (const o of relOutreach) {
            await a.deleteRecord(TABLE_IDS.outreach, o.id).catch(() => {});
            if (onDeleteRecord) onDeleteRecord('outreach', o.id);
          }
          const relOpps = (data.opportunities || []).filter(o => linkedIds(o, 'Account').includes(id));
          for (const o of relOpps) {
            await a.deleteRecord(TABLE_IDS.opportunities, o.id).catch(() => {});
            if (onDeleteRecord) onDeleteRecord('opportunities', o.id);
          }
        }
        await a.deleteRecord(TABLE_IDS.accounts, id);
        if (onDeleteRecord) onDeleteRecord('accounts', id);
      } catch (e) { console.error('Failed to delete account', id, e); }
    }
    setSelectedAccountIds(new Set());
    setDeletingAccounts(false);
  };

  const [selectedContactIds, setSelectedContactIds] = useState(new Set());
  const [deletingContacts, setDeletingContacts] = useState(false);
  const bulkDeleteContacts = async () => {
    if (selectedContactIds.size === 0) return;
    if (!window.confirm(`Delete ${selectedContactIds.size} contact${selectedContactIds.size > 1 ? 's' : ''} and all their outreach history? This cannot be undone.`)) return;
    setDeletingContacts(true);
    const a = api || new AirtableAPI();
    for (const id of [...selectedContactIds]) {
      try {
        const relOutreach = (data.outreach || []).filter(o => linkedIds(o, 'Stakeholder').includes(id));
        for (const o of relOutreach) {
          await a.deleteRecord(TABLE_IDS.outreach, o.id).catch(() => {});
          if (onDeleteRecord) onDeleteRecord('outreach', o.id);
        }
        await a.deleteRecord(TABLE_IDS.stakeholders, id);
        if (onDeleteRecord) onDeleteRecord('stakeholders', id);
      } catch (e) { console.error('Failed to delete contact', id, e); }
    }
    setSelectedContactIds(new Set());
    setDeletingContacts(false);
  };

  const [editingOpp, setEditingOpp] = useState(null);   // null | { opp: record | null, isNew: bool }
  const [oppForm, setOppForm] = useState({});
  const [oppFormSolIds, setOppFormSolIds] = useState([]);
  const [savingOppForm, setSavingOppForm] = useState(false);
  const [cpSelectedStakeholder, setCpSelectedStakeholder] = useState(null);
  const [cpEditingContact, setCpEditingContact] = useState(null);
  const saveCpContactEdit = async (values) => {
    if (!cpEditingContact) return;
    const raw = {
      'Name': values['Name'], 'Last name': values['Last name'],
      'Role': values['Role'], 'Email': values['Email'],
      'Phone number': values['Phone number'], 'LinkedIn': values['LinkedIn'],
      'Campaign': values['Campaign'] ? [values['Campaign']] : null, // linked record
      'Country': values['Country'] || null,
      'Level of Influence': values['Level of Influence'] || null,
      'Source': values['Source'] || null,
    };
    const fields = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== '' && v !== undefined && v !== null));
    if (onUpdateRecord) onUpdateRecord('stakeholders', cpEditingContact.id, fields);
    setCpEditingContact(null);
    const a = api || new AirtableAPI();
    a.updateRecord(TABLE_IDS.stakeholders, cpEditingContact.id, fields)
      .then(() => { if (onLogActivity) onLogActivity(); })
      .catch(e => { console.error(e); window.__oikeToast('Failed to save. ' + e.message, 'error'); if (onLogActivity) onLogActivity(); });
  };
  const [cpMeetingModal, setCpMeetingModal] = useState(null);
  const [cpMeetingNotes, setCpMeetingNotes] = useState('');
  const [cpMeetingDate, setCpMeetingDate] = useState('');
  const [cpMeetingTime, setCpMeetingTime] = useState('');
  const [cpCallModal, setCpCallModal] = useState(null);
  const [cpCallNotes, setCpCallNotes] = useState('');
  const [showAccImport, setShowAccImport] = useState(false);
  const [accCsvRows, setAccCsvRows] = useState([]);
  const [accImporting, setAccImporting] = useState(false);
  const [accImportResult, setAccImportResult] = useState(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [showSolPicker, setShowSolPicker] = useState(false);
  const [newSolName, setNewSolName] = useState('');
  const [creatingSol, setCreatingSol] = useState(false);
  const [showIcpAutoMatch, setShowIcpAutoMatch] = useState(false);
  const [icpAutoMatchSelected, setIcpAutoMatchSelected] = useState({});
  const [savingAutoMatch, setSavingAutoMatch] = useState(false);
  const [selectedOppId, setSelectedOppId] = useState('');
  const [oppNotes, setOppNotes] = useState('');
  const [editingOppNotes, setEditingOppNotes] = useState(false);
  const [savingOppNotes, setSavingOppNotes] = useState(false);
  const [oppNextStep, setOppNextStep] = useState('');
  const [oppStakeholder, setOppStakeholder] = useState('');
  const [showAddOppStk, setShowAddOppStk] = useState(false);
  const [newOppStkName, setNewOppStkName] = useState('');
  const [newOppStkRole, setNewOppStkRole] = useState('');
  const [creatingOppStk, setCreatingOppStk] = useState(false);
  const [oppSolutionIds, setOppSolutionIds] = useState([]);
  const [removingSol, setRemovingSol] = useState(null);
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [newAccName, setNewAccName] = useState('');
  const [newAccWebsite, setNewAccWebsite] = useState('');
  const [creatingAcc, setCreatingAcc] = useState(false);
  const [showNewStakeholder, setShowNewStakeholder] = useState(false);
  const [newStkName, setNewStkName] = useState('');
  const [newStkLastName, setNewStkLastName] = useState('');
  const [newStkRole, setNewStkRole] = useState('');
  const [newStkEmail, setNewStkEmail] = useState('');
  const [newStkPhone, setNewStkPhone] = useState('');
  const [newStkLinkedin, setNewStkLinkedin] = useState('');
  const [newStkInfluence, setNewStkInfluence] = useState('');
  const [creatingStk, setCreatingStk] = useState(false);
  const [bulkPainLoading, setBulkPainLoading] = useState(false);
  const [bulkPainProgress, setBulkPainProgress] = useState('');
  const [editingAccount, setEditingAccount] = useState(null);
  const [accDetailTab, setAccDetailTab] = useState('strategy');
  const [viewingProposal, setViewingProposal] = useState(null);
  const [viewingLanding, setViewingLanding] = useState(null);
  const RADAR_LS_KEY = 'oike_radar_data';
  const [radarStore, setRadarStore] = useState(() => {
    try { return JSON.parse(localStorage.getItem(RADAR_LS_KEY) || '{}'); } catch { return {}; }
  });
  const radarData = selectedAccountId ? (radarStore[selectedAccountId]?.data || null) : null;
  const radarUpdatedAt = selectedAccountId ? (radarStore[selectedAccountId]?.updatedAt || null) : null;
  const setRadarData = (data) => {
    const updatedAt = new Date().toISOString();
    setRadarStore(prev => {
      const next = { ...prev, [selectedAccountId]: { data, updatedAt } };
      try { localStorage.setItem(RADAR_LS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const [loadingRadar, setLoadingRadar] = useState(false);
  const [savingRadar, setSavingRadar] = useState(false);
  const now = new Date();

  // NBA cache per account
  const nbaCache = useRef({});
  const [nbaText, setNbaText] = useState('');
  const [nbaLoading, setNbaLoading] = useState(false);

  // Offering recommendation
  const offeringRecCache = useRef({});
  const [offeringRec, setOfferingRec] = useState(null); // { solName, solId, why, fit }
  const [offeringRecLoading, setOfferingRecLoading] = useState(false);

  // Strategy state
  const [strategyData, setStrategyData] = useState({ objective: '', targetDate: '', angle: '', stakeholderRoles: {}, milestones: [] });
  const [savingStrategy, setSavingStrategy] = useState(false);
  const [newMilestone, setNewMilestone] = useState({ text: '', date: '', status: 'Pending' });

  const saveAccountEdit = async (updatedFields) => {
    if (!editingAccount || !api) return;
    if (onUpdateRecord) onUpdateRecord('accounts', editingAccount.id, updatedFields);
    setEditingAccount(null);
    try {
      await api.updateRecord(TABLE_IDS.accounts, editingAccount.id, updatedFields);
      if (onLogActivity) onLogActivity();
    } catch (e) {
      console.error('Account edit error', e);
      window.__oikeToast('Failed to save account changes', 'error');
      if (onLogActivity) onLogActivity();
    }
  };

  const mappedAccounts = useMemo(() => accounts.filter(a => linkedIds(a, 'Stakeholders').length > 0), [accounts]);
  const filteredAccounts = useMemo(() => {
    const isBdr = CURRENT_USER?.role === 'bdr';
    const hasFilter = searchTerm || filterSolutionId || filterIndustry || filterCountry || filterCPId;
    // BDRs see ALL their assigned accounts (not just mapped ones), because accounts
    // may have been assigned before any stakeholders are added.
    let list = (hasFilter || isBdr)
      ? [...accounts]
      : [...mappedAccounts];

    // Build outreach count per account for sorting
    const outreachCountByAccount = {};
    outreach.forEach(o => {
      linkedIds(o, 'Account').forEach(aid => {
        outreachCountByAccount[aid] = (outreachCountByAccount[aid] || 0) + 1;
      });
    });

    // Active statuses rank highest
    const ACTIVE_STATUSES = ['Active Outreach', 'Active', 'Activo', 'Meeting Booked', 'Qualified', 'Proposal Sent', 'Negotiation'];
    const statusRank = (a) => ACTIVE_STATUSES.includes(F(a, 'Inside Sales Status')) ? 0 : 1;

    list = list.sort((a, b) => {
      const rankDiff = statusRank(a) - statusRank(b);
      if (rankDiff !== 0) return rankDiff;
      // Within same group: most outreach first
      const outDiff = (outreachCountByAccount[b.id] || 0) - (outreachCountByAccount[a.id] || 0);
      if (outDiff !== 0) return outDiff;
      // Fallback: alphabetical
      return (F(a, 'Account Name') || '').localeCompare(F(b, 'Account Name') || '');
    });
    if (searchTerm) {
      list = list.filter(a => (F(a, 'Account Name') || '').toLowerCase().includes(searchTerm.toLowerCase()));
    }
    if (filterSolutionId) {
      list = list.filter(a => linkedIds(a, 'Solutions').includes(filterSolutionId));
    }
    if (filterIndustry) {
      list = list.filter(a => (F(a, 'Industry') || '').trim() === filterIndustry.trim());
    }
    if (filterCountry) {
      list = list.filter(a => (F(a, 'Country') || '').trim() === filterCountry.trim());
    }
    if (filterCPId) {
      // Account has a 'CP' field (linked record → Users table) — filter by user ID directly
      list = list.filter(a => linkedIds(a, 'CP').includes(filterCPId));
    }
    return list;
  }, [accounts, mappedAccounts, outreach, searchTerm, filterSolutionId, filterIndustry, filterCountry, filterCPId]);

  const account = selectedAccountId ? accounts.find(a => a.id === selectedAccountId) : null;

  // Account data
  const name = account ? F(account, 'Account Name') : '';
  const accStakeholderIds = account ? linkedIds(account, 'Stakeholders') : [];
  const accStakeholders = accStakeholderIds.map(id => stakeholders.find(s => s.id === id)).filter(Boolean);
  const accOutreach = useMemo(() => {
    if (!account) return [];
    return outreach.filter(o => linkedIds(o, 'Account').includes(account.id))
      .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
  }, [account, outreach]);
  const opps = account ? opportunities.filter(o => linkedIds(o, 'Account').includes(account.id)) : [];
  const actions = account ? actionPlan.filter(a => linkedIds(a, 'Cuenta').includes(account.id)) : [];
  const solNames = account ? resolveLinked(account, 'Solutions', solutions, 'Name') : [];
  const recentNews = account ? F(account, 'Recent News') : '';
  const intelPlan = account ? F(account, 'Inside sales plan') : '';
  const intelNotes = account ? (F(account, 'Intel Notes') || '') : '';
  const upcomingEventsAI = account ? (F(account, 'Opcoming events') || '') : '';
  const upcomingEventsText = typeof upcomingEventsAI === 'string' ? upcomingEventsAI : String(upcomingEventsAI || '');

  const saveIntelNotes = async () => {
    if (!api || !account) return;
    setSavingNotes(true);
    try {
      await api.updateRecord(TABLE_IDS.accounts, account.id, { 'Intel Notes': notesValue });
      setEditingNotes(false);
      if (onLogActivity) onLogActivity();
    } catch (e) {
      console.error(e);
      window.__oikeToast('Failed to save Intel Notes', 'error');
    }
    setSavingNotes(false);
  };

  const saveStkNotes = async (stk) => {
    if (!api || !stk) return;
    setSavingStkNotes(true);
    try {
      await api.updateRecord(TABLE_IDS.stakeholders, stk.id, { 'Intel Notes': stkNotesValue });
      if (onUpdateRecord) onUpdateRecord('stakeholders', stk.id, { 'Intel Notes': stkNotesValue });
      setEditingStkNotes(null);
    } catch (e) {
      console.error(e);
      window.__oikeToast('Failed to save contact notes', 'error');
    }
    setSavingStkNotes(false);
  };

  // ── AI-GENERATED NEWS state (must be before newsItems useMemo) ──
  const NEWS_AI_LS_KEY = 'oike_news_ai';
  const [newsAIData, setNewsAIData] = useState(() => {
    try { return JSON.parse(localStorage.getItem(NEWS_AI_LS_KEY) || '{}'); } catch { return {}; }
  });
  const [loadingNewsAI, setLoadingNewsAI] = useState(false);
  const newsAIEntry = selectedAccountId ? (newsAIData[selectedAccountId] || null) : null;
  const newsAIUpdatedAt = newsAIEntry?.updatedAt || null;

  const newsItems = useMemo(() => {
    const sourceText = recentNews;
    if (!sourceText || typeof sourceText !== 'string') return [];
    const raw = sourceText.split(/\n+/).map(l => l.trim()).filter(l => l.length > 3);
    // Parse into structured news items: { title, body, source }
    const items = [];
    let current = null;
    const cleanMd = (s) => s.replace(/^\.\s*/, '').replace(/\*\*/g, '').replace(/^[-•*\d.]+\s*/, '').trim();
    const isLink = (s) => /^\[Read more\]|^\[Source\]|^\[Link\]|^https?:\/\//i.test(s.trim());
    const extractUrl = (s) => { const m = s.match(/\((https?:\/\/[^)]+)\)/); return m ? m[1] : s.match(/(https?:\/\/\S+)/)?.[1] || ''; };
    const isTitle = (s) => {
      const c = cleanMd(s);
      return c.length > 10 && c.length < 200 && (/\*\*/.test(s) || /^[A-Z]/.test(c));
    };
    for (const line of raw) {
      if (isLink(cleanMd(line))) {
        if (current) current.source = extractUrl(line);
        continue;
      }
      const cleaned = cleanMd(line);
      if (!cleaned || cleaned.length < 5) continue;
      // Check if this looks like a new headline (short-ish, starts with caps or was bold)
      if (isTitle(line) && cleaned.length < 120) {
        // If we already have a title with no body and this also looks like a title, check for dups
        if (current) items.push(current);
        current = { title: cleaned, body: '', source: '' };
      } else if (current && !current.body) {
        current.body = cleaned;
      } else if (!current) {
        current = { title: cleaned, body: '', source: '' };
      }
    }
    if (current) items.push(current);
    // Deduplicate by checking title similarity
    const seen = new Set();
    const unique = items.filter(item => {
      const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.slice(0, 5);
  }, [recentNews]);
  // Keep newsLines for backward compat with talking points prompt
  const newsLines = newsItems.map(n => `${n.title}${n.body ? ': ' + n.body : ''}`);

  const generateNewsAI = async () => {
    setLoadingNewsAI(true);
    try {
      const website = F(account, 'Website') || '';
      const country = F(account, 'Country') || '';
      const industry = F(account, 'Industry') || '';
      const prompt = `You are a B2B sales research analyst. Generate 4-5 recent and relevant news items about this company to help a salesperson open a conversation.

COMPANY: ${name}
WEBSITE: ${website || 'Not provided'}
INDUSTRY: ${industry || 'Not specified'}
COUNTRY: ${country || 'Not specified'}

INSTRUCTIONS:
${website ? `- First, focus on news SPECIFIC to this company (${name}) — use your knowledge about their recent announcements, expansions, partnerships, leadership changes, technology investments, or strategic moves.` : ''}
- If you don't have enough specific company news, supplement with 1-2 relevant INDUSTRY trends in ${country || 'their market'} that would be relevant to a sales conversation.
- Each news item must be actionable — something a salesperson can reference to open a conversation or identify a pain point.

FORMAT each item exactly like this (include the ** for titles):
**[News headline here]**
[1-2 sentence description with context and sales relevance]

Generate 4-5 items. No intro, no outro, just the formatted items.`;

      const generated = await callOpenAI({ prompt, temperature: 0.6, max_tokens: 800 });
      const updatedAt = new Date().toISOString();
      setNewsAIData(prev => {
        const next = { ...prev, [selectedAccountId]: { text: generated, updatedAt } };
        try { localStorage.setItem(NEWS_AI_LS_KEY, JSON.stringify(next)); } catch {}
        return next;
      });
    } catch(e) {
      console.error(e); window.__oikeToast('Failed to generate news: ' + (e.message || 'unknown error'), 'error');
    } finally { setLoadingNewsAI(false); }
  };

  // Upcoming events for this account
  const accEvents = useMemo(() => {
    if (!account) return [];
    return events.filter(ev => {
      const start = ev.fields?.['Starting'] ? new Date(ev.fields['Starting']) : null;
      if (!start || start < now) return false;
      const invitedIds = linkedIds(ev, 'Stakeholders invited');
      return accStakeholderIds.some(sid => invitedIds.includes(sid));
    });
  }, [account, events, accStakeholderIds]);

  // Engagement timeline per stakeholder
  const stakeholderEngagement = useMemo(() => {
    if (!account) return [];
    return accStakeholders.map(s => {
      const sName = F(s, 'Name') + (F(s, 'Last name') ? ` ${F(s, 'Last name')}` : '');
      const sOutreach = outreach.filter(o => linkedIds(o, 'Stakeholder').includes(s.id))
        .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
      const lastTouch = sOutreach[0] || null;
      const daysSince = lastTouch ? Math.floor((now - new Date(lastTouch.fields?.['Date'])) / (1000*60*60*24)) : null;
      const hasReplied = sOutreach.some(o => F(o, 'Status') === 'Replied');
      const hasMeeting = sOutreach.some(o => F(o, 'Status') === 'Meeting Scheduled');
      return { s, sName, sOutreach, lastTouch, daysSince, hasReplied, hasMeeting, totalTouches: sOutreach.length };
    }).sort((a, b) => {
      // Oldest outreach first: never contacted → longest since last touch → most recent
      return (b.daysSince ?? 999) - (a.daysSince ?? 999);
    });
  }, [account, accStakeholders, outreach]);

  // ── Health Score + Momentum ──
  const healthScore = useMemo(() => {
    if (!account) return 0;
    let score = 0;
    const hasOpenOpp = opps.some(o => OPP_STAGES && OPP_STAGES.includes(F(o, 'Stage')));
    if (hasOpenOpp) score += 20;
    const recent14 = accOutreach.some(o => { const d = new Date(o.fields?.['Date']); return (now - d) / (1000*60*60*24) <= 14; });
    if (recent14) score += 15;
    const hasReply = accOutreach.some(o => F(o,'Status')==='Replied' || F(o,'Direction')==='Inbound' || F(o,'Reply')==='Yes');
    const replyIn30 = accOutreach.some(o => {
      const d = new Date(o.fields?.['Date']);
      return (now - d) / (1000*60*60*24) <= 30 && (F(o,'Status')==='Replied' || F(o,'Direction')==='Inbound' || F(o,'Reply')==='Yes');
    });
    if (replyIn30) score += 15;
    if (accStakeholders.length >= 3) score += 10;
    if (intelNotes || radarData) score += 10;
    const meetingIn60 = accOutreach.some(o => { const d = new Date(o.fields?.['Date']); return (now - d) / (1000*60*60*24) <= 60 && (F(o,'Channel')==='Meeting' || F(o,'Status')==='Meeting Booked'); });
    if (meetingIn60) score += 10;
    if (F(account,'Website') || accStakeholders.some(s => F(s,'LinkedIn'))) score += 10;
    const status = F(account,'Inside Sales Status') || '';
    if (['Active','In Progress','Active Outreach'].includes(status)) score += 10;
    return Math.min(score, 100);
  }, [account, accOutreach, accStakeholders, opps, intelNotes, radarData]);

  const momentum = useMemo(() => {
    if (!account || accOutreach.length === 0) return { emoji: '❄️', label: 'COLD' };
    const sorted = [...accOutreach].sort((a,b) => new Date(b.fields?.['Date']||0) - new Date(a.fields?.['Date']||0));
    const latestDate = new Date(sorted[0]?.fields?.['Date'] || 0);
    const daysSince = (now - latestDate) / (1000*60*60*24);
    const hasReplyRecent7 = sorted.some(o => { const d = new Date(o.fields?.['Date']); return (now-d)/(1000*60*60*24) <= 7 && (F(o,'Status')==='Replied' || F(o,'Direction')==='Inbound' || F(o,'Reply')==='Yes'); });
    if (hasReplyRecent7) return { emoji: '🔥', label: 'HOT' };
    if (daysSince <= 10) return { emoji: '📈', label: 'ACTIVE' };
    if (daysSince <= 30) return { emoji: '➡️', label: 'STEADY' };
    if (daysSince <= 60) return { emoji: '🧊', label: 'COOLING' };
    return { emoji: '❄️', label: 'COLD' };
  }, [account, accOutreach]);

  // Bulk generate pain points for all stakeholders
  const bulkGeneratePainPoints = async () => {
    const atKey = localStorage?.getItem?.('at_key');
    const targets = stakeholderEngagement.filter(e => {
      const existing = F(e.s, 'Pain Points (Generated)') || '';
      return !existing || existing.length < 10;
    });

    if (targets.length === 0) {
      window.__oikeToast('All stakeholders already have pain points generated. To regenerate, clear them in Airtable first.', 'warning');
      return;
    }

    setBulkPainLoading(true);
    const a = new AirtableAPI();
    const accName = account ? F(account, 'Account Name') : '';
    const accIndustry = account ? F(account, 'Industry') : '';
    const accFocus = account ? (Array.isArray(F(account, 'Service / Focus')) ? F(account, 'Service / Focus').join(', ') : F(account, 'Service / Focus') || '') : '';
    const accNews = account ? ((F(account, 'Recent News') || '').toString().slice(0, 300)) : '';

    let done = 0;
    for (const eng of targets) {
      done++;
      const sFullName = eng.sName;
      const sRole = F(eng.s, 'Role') || '';
      setBulkPainProgress(`${done}/${targets.length}: ${sFullName}`);
      try {
        const prompt = `You are a B2B sales research analyst. Analyze this stakeholder and identify their likely pain points.

STAKEHOLDER: ${sFullName}
ROLE: ${sRole}
COMPANY: ${accName}
INDUSTRY: ${accIndustry}
SERVICE FOCUS: ${accFocus || 'Not defined'}
RECENT COMPANY NEWS: ${accNews || 'Not available'}

Generate 3-5 specific, actionable pain points for this person based on their role and industry context. Each pain point should:
- Be specific to their role (not generic)
- Reference industry challenges they likely face
- Connect to areas where ${COMPANY_PROFILE.companyName} (${COMPANY_PROFILE.services}) could help

Format as bullet points. Be concise (1-2 sentences each). Write ONLY the pain points, no intro or summary.`;

        const generated = await callOpenAI({ prompt, temperature: 0.7, max_tokens: 400 });
        if (!eng.s.id.startsWith('tmp_')) {
          await a.updateRecord(TABLE_IDS.stakeholders, eng.s.id, { 'Pain points': generated })
            .catch(e => console.warn(`Could not save pain points for ${sFullName}:`, e.message));
        }
      } catch (e) {
        console.error(`Failed for ${sFullName}:`, e);
      }
      // Small delay to avoid rate limits
      if (done < targets.length) await new Promise(r => setTimeout(r, 500));
    }
    setBulkPainLoading(false);
    setBulkPainProgress('');
    if (onLogActivity) onLogActivity();
  };

  // Generate MEDDPICC
  const generateMeddpicc = async () => {
    setLoadingMeddpicc(true);
    try {
      const newsStr = newsLines.slice(0, 5).join('\n') || 'No recent news';
      const stksStr = accStakeholders.map(s => {
        const pain = F(s, 'Pain Points (Generated)') || F(s, 'Pain points') || '';
        const painStr = pain ? ` | Pain Points: ${pain.slice(0, 200)}` : '';
        return `- ${F(s,'Name')} ${F(s,'Last name')||''} (${F(s,'Role')||'?'}) — Influence: ${F(s,'Level of Influence')||'?'}${painStr}`;
      }).join('\n') || 'No stakeholders mapped';
      const oppsStr = opps.map(o => `- ${F(o,'Deal/Opp name')}: Stage=${F(o,'Stage')}, Value=${o.fields?.['Value']||'N/A'}`).join('\n') || 'No opportunities';
      const prompt = `You are a senior B2B sales strategist. Based on the account context below, fill out a MEDDPICC qualification framework. Be specific and practical — use names, data, and signals from the context. If information is not available, write "Unknown — needs discovery" for that field.

ACCOUNT: ${name}
INDUSTRY: ${F(account,'Industry')||'N/A'}
COUNTRY: ${F(account,'Country')||'N/A'}
TIER: ${F(account,'Tier')||'N/A'}
RECENT NEWS:
${newsStr}
STAKEHOLDERS:
${stksStr}
OPPORTUNITIES:
${oppsStr}
INTEL NOTES: ${intelNotes||'None'}
SELLER COMPANY: ${COMPANY_PROFILE.companyName} — ${COMPANY_PROFILE.services}

Return ONLY a valid JSON object with exactly these keys (no markdown, no explanation):
{
  "metrics": "...",
  "economicBuyer": "...",
  "decisionCriteria": "...",
  "decisionProcess": "...",
  "identifyPain": "...",
  "champion": "...",
  "competition": "...",
  "compellingEvent": "..."
}`;
      const raw = await callOpenAI({ prompt, temperature: 0.5, max_tokens: 800 });
      let parsed;
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      } catch { parsed = {}; MEDDPICC_FIELDS.forEach(f => { parsed[f.key] = raw; }); }
      saveMeddpicc(parsed);
      setEditingMeddpicc(false);
    } catch(e) {
      console.error(e); window.__oikeToast('Failed to generate MEDDPICC: ' + (e.message || 'unknown error'), 'error');
    } finally { setLoadingMeddpicc(false); }
  };

  // Generate Executive Summary
  const generateExecSummary = async () => {
    setLoadingSummary(true);
    try {
      const newsStr = newsLines.slice(0, 5).join('\n') || 'No recent news';
      const oppStr = opps.map(o => `- ${F(o, 'Deal/Opp name')}: Stage=${F(o, 'Stage')}, Value=${o.fields?.['Value'] || 'N/A'}, Next step=${F(o, 'Next step') || 'N/A'}, Stakeholder=${F(o, 'Stakeholders') || 'N/A'}`).join('\n') || 'No opportunities';
      const solStr = solNames.join(', ') || 'None mapped';
      const stSummary = stakeholderEngagement.map(e => {
        const pain = F(e.s, 'Pain Points (Generated)') || F(e.s, 'Pain points') || '';
        const painStr = typeof pain === 'string' ? pain.slice(0, 100) : '';
        const status = e.hasMeeting ? 'Meeting' : e.hasReplied ? 'Replied' : e.totalTouches > 0 ? `${e.totalTouches}x, no reply` : 'Not contacted';
        return `- ${e.sName} (${F(e.s, 'Role')}, ${F(e.s, 'Level of Influence') || '?'}) — ${status}${painStr ? ` | Pain: ${painStr}` : ''}`;
      }).join('\n') || 'No stakeholders';
      const eventsStr = (data.events || []).filter(ev => {
        const invitedIds = linkedIds(ev, 'Stakeholders invited');
        return accStakeholderIds.some(sid => invitedIds.includes(sid));
      }).map(ev => `- ${F(ev, 'Event Name')} (${ev.fields?.['Starting'] ? new Date(ev.fields['Starting']).toLocaleDateString('en-US', {month:'short',day:'numeric'}) : '?'})`).join('\n') || 'None';
      const upcomingEvAI = account ? (F(account, 'Opcoming events') || '') : '';
      const upcomingEvStr = typeof upcomingEvAI === 'string' ? upcomingEvAI.slice(0, 300) : '';

      const prompt = `You are a senior B2B sales strategist. Create a concise EXECUTIVE SUMMARY for this account to brief a BDR before prospecting.

ACCOUNT: ${name}
INDUSTRY: ${F(account, 'Industry') || 'N/A'}
TIER: ${F(account, 'Tier') || 'N/A'}
SERVICE FOCUS: ${Array.isArray(F(account, 'Service / Focus')) ? F(account, 'Service / Focus').join(', ') : F(account, 'Service / Focus') || 'N/A'}

RECENT NEWS:
${newsStr}

INTEL NOTES (BDR first-hand context):
${intelNotes || 'None'}

SOLUTIONS MAPPED: ${solStr}

OPPORTUNITIES:
${oppStr}

STAKEHOLDER MAP:
${stSummary}

COMPANY EVENTS INTEL:
${upcomingEvStr || 'None'}

EVENTS WITH INVITED STAKEHOLDERS:
${eventsStr}

Write the Executive Summary with these sections (use ### headers):

### 🏢 Account Snapshot
2-3 sentences: What does this company do, what's their current situation based on news, and why are they relevant for ${COMPANY_PROFILE.companyName}.

### 🎯 Strategic Angle
2-3 sentences: What's the best entry point for ${COMPANY_PROFILE.companyName}? Which solutions/services are most relevant and why? What pain points or triggers should we leverage?

### 📊 Pipeline Status
2-3 sentences: Current state of opportunities, what stage they're in, blockers, and what needs to happen next to advance them.

### 👥 Relationship Map
2-3 sentences: Who are our key contacts, who's engaged, who's cold, and who's missing from the map. Where are the gaps?

### ⚡ Immediate Actions
3-4 bullet points: Specific things to do THIS WEEK. Be concrete — name stakeholders, suggest channels, reference triggers.

Be specific. Use names. No generic advice. Under 300 words total.`;

      setExecSummary(await callOpenAI({ prompt, temperature: 0.7, max_tokens: 700 }) || 'Could not generate summary.');
    } catch (e) {
      console.error(e);
      window.__oikeToast('Failed to generate. Error: ' + (e.message || 'unknown error'), 'error');
    }
    setLoadingSummary(false);
  };

  // Generate AI talking points
  const generateTalkingPoints = async () => {
    setLoadingTP(true);
    try {
      const stakeholderSummary = stakeholderEngagement.map(e => {
        const pain = F(e.s, 'Pain Points (Generated)') || F(e.s, 'Pain points') || 'Unknown';
        const status = e.hasMeeting ? 'Meeting Scheduled' : e.hasReplied ? 'Replied' : e.totalTouches > 0 ? `Contacted ${e.totalTouches}x, no reply` : 'Not contacted';
        return `- ${e.sName} (${F(e.s, 'Role')}): Pain points: ${typeof pain === 'string' ? pain.slice(0, 150) : pain}. Status: ${status}`;
      }).join('\n');

      const oppSummary = opps.map(o => `- ${F(o, 'Deal/Opp name')}: Stage=${F(o, 'Stage')}, Value=${o.fields?.['Value'] || 'N/A'}, Angle=${F(o, 'Suggested Angle') || 'N/A'}`).join('\n');

      const prompt = `You are a sales strategist preparing a Client Partner for meetings with ${name}.

ACCOUNT CONTEXT:
- Industry: ${F(account, 'Industry') || 'N/A'}
- Tier: ${F(account, 'Tier') || 'N/A'}
- Solutions mapped: ${solNames.join(', ') || 'None yet'}
- Service Focus: ${F(account, 'Service / Focus') || 'N/A'}

RECENT NEWS:
${newsLines.slice(0, 5).join('\n') || 'No recent news available'}

STAKEHOLDERS:
${stakeholderSummary || 'No stakeholders mapped'}

OPPORTUNITIES:
${oppSummary || 'No opportunities registered'}

EXECUTIVE SUMMARY:
${execSummary ? execSummary.slice(0, 600) : 'Not generated yet — use news, stakeholders, and opps context above'}

INTEL NOTES (recent context from BDR):
${intelNotes ? intelNotes.slice(0, 400) : 'No additional notes'}

Generate exactly 4 TALKING POINTS for the Client Partner. Each should:
1. Reference a specific stakeholder by name and their pain point
2. Connect it to a ${COMPANY_PROFILE.companyName} capability or the mapped solution
3. Be actionable — what to say or ask in the meeting
4. Use recent news if relevant as a conversation hook

Format each as:
🎯 [Stakeholder Name] — [Topic]
[2-3 sentences of what to say/ask and why]

Be specific, not generic. The CP needs to sound informed and prepared.`;

      setTalkingPoints(await callOpenAI({ prompt, temperature: 0.7, max_tokens: 600 }) || 'Could not generate talking points.');
    } catch (e) {
      console.error(e);
      window.__oikeToast('Failed to generate talking points. Error: ' + (e.message || 'unknown error'), 'error');
    }
    setLoadingTP(false);
  };

  // Generate "Who to Contact" AI recommendations
  const generateContactRecs = async () => {
    setLoadingRecs(true);
    try {
      const stakeholderSummary = stakeholderEngagement.length > 0
        ? stakeholderEngagement.map(e => {
            const pain = F(e.s, 'Pain Points (Generated)') || F(e.s, 'Pain points') || 'Unknown';
            const painStr = typeof pain === 'string' ? pain.slice(0, 120) : String(pain).slice(0, 120);
            const status = e.hasMeeting ? 'Meeting Scheduled' : e.hasReplied ? 'Replied' : e.totalTouches > 0 ? `Contacted ${e.totalTouches}x (last ${e.daysSince}d ago), no reply` : 'Never contacted';
            const influence = F(e.s, 'Level of Influence') || 'Unknown';
            return `- ${e.sName} | ${F(e.s, 'Role')} | Influence: ${influence} | Status: ${status} | Pain: ${painStr}`;
          }).join('\n')
        : 'NO STAKEHOLDERS MAPPED YET';

      const oppSummary = opps.length > 0
        ? opps.map(o => `- ${F(o, 'Deal/Opp name')}: Stage=${F(o, 'Stage')}, Angle=${F(o, 'Suggested Angle') || 'N/A'}`).join('\n')
        : 'No opportunities yet';

      const industry = account ? F(account, 'Industry') : '';
      const focusRaw = account ? F(account, 'Service / Focus') : '';
      const focusStr = Array.isArray(focusRaw) ? focusRaw.join(', ') : focusRaw || '';
      const newsStr = typeof recentNews === 'string' ? recentNews.slice(0, 400) : '';
      const planStr = typeof intelPlan === 'string' ? intelPlan.slice(0, 300) : '';

      const prompt = `You are a senior B2B sales strategist advising a BDR (Business Development Representative) at ${COMPANY_PROFILE.companyName} (${COMPANY_PROFILE.services}) who is prospecting ${name} in the ${industry || 'enterprise'} sector.

ACCOUNT CONTEXT:
- Company: ${name}
- Industry: ${industry || 'N/A'}
- Service Focus: ${focusStr || 'N/A'}
- Recent News: ${newsStr || 'None available'}
- Executive Summary: ${execSummary ? execSummary.slice(0, 500) : 'Not generated'}
- Intel Notes: ${intelNotes || 'None'}
- Solutions mapped: ${solNames.length > 0 ? solNames.join(', ') : 'None yet'}

CURRENT STAKEHOLDERS:
${stakeholderSummary}

PIPELINE:
${oppSummary}

Based on ALL this context, provide actionable outreach recommendations:

1. **PRIORITY CONTACTS** — Which existing stakeholders should be contacted NEXT and WHY? Consider: who hasn't been touched recently, who replied but no meeting yet, who has high influence but no contact. For each, give a specific reason and suggested approach (channel + angle).

2. **MISSING ROLES** — What roles/titles are MISSING from the stakeholder map that would be critical to advance this deal? Think about typical decision-making units for ${industry || 'enterprise'} companies buying digital transformation / AI / CX services. Suggest specific titles to search for on LinkedIn.

3. **RE-ENGAGEMENT** — Any stakeholders that went cold? Suggest a creative re-engagement tactic with a specific hook based on recent news or pain points.

4. **TIMING & TRIGGERS** — Based on news, industry context, or events, is there an urgency trigger we should leverage NOW?

Be specific, direct, and actionable. No generic advice. Use names when referring to existing stakeholders. Format with clear sections and bullet points. Keep it under 400 words.`;

      setContactRecs(await callOpenAI({ prompt, temperature: 0.7, max_tokens: 700 }) || 'No recommendations generated.');
    } catch (e) {
      console.error(e);
      window.__oikeToast('Failed to generate. Error: ' + (e.message || 'unknown error'), 'error');
    }
    setLoadingRecs(false);
  };

  // CP Briefings: log meeting
  const cpLogMeeting = async (stakeholder, notes, date) => {
    const sn = F(stakeholder, 'Name') || '';
    const companyIds = linkedIds(stakeholder, 'Account');
    try {
      const a = api || new AirtableAPI();
      await a.createRecord(TABLE_IDS.outreach, {
        'Activity Name': `Meeting Scheduled: ${sn} — ${new Date().toLocaleDateString('en-US')}`,
        'Account': companyIds, 'Stakeholder': [stakeholder.id],
        'Channel': 'Call', 'Date': new Date().toISOString(),
        'Status': 'Meeting Scheduled', 'Message': notes || '',
        'Notes': `Meeting ${date ? `on ${date}` : 'TBD'} — logged from CP Briefings`,
        'Logged By': CURRENT_USER?.name || '',
        ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
        ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
      });
      await activateAccountIfNeeded(a, companyIds, data.accounts);
      await updateStakeholderStatus(a, stakeholder.id, 'Meeting Booked', data.stakeholders);
      if (onLogActivity) onLogActivity();
    } catch (e) { console.error('Log meeting failed:', e); }
  };

  // CP Briefings: log call
  const cpLogCall = async (stakeholder, notes) => {
    const sn = F(stakeholder, 'Name') || '';
    const companyIds = linkedIds(stakeholder, 'Account');
    try {
      const a = api || new AirtableAPI();
      await a.createRecord(TABLE_IDS.outreach, {
        'Activity Name': `Call with ${sn} — ${new Date().toLocaleDateString('en-US')}`,
        'Account': companyIds, 'Stakeholder': [stakeholder.id],
        'Channel': 'Call', 'Date': new Date().toISOString(),
        'Status': 'Sent', 'Message': notes || '',
        'Notes': `Call logged from CP Briefings`,
        'Logged By': CURRENT_USER?.name || '',
        ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
        ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
      });
      await activateAccountIfNeeded(a, companyIds, data.accounts);
      await updateStakeholderStatus(a, stakeholder.id, 'Contacted', data.stakeholders);
      if (onLogActivity) onLogActivity();
    } catch (e) { console.error('Log call failed:', e); }
  };

  // CP Briefings: use message (send + log)
  const cpUseMessage = async (stakeholder, channel, message, ccList = [], eventId = null) => {
    const sn = F(stakeholder, 'Name') || '';
    const email = F(stakeholder, 'Email') || '';
    const phone = F(stakeholder, 'Phone number') || '';
    const linkedin = F(stakeholder, 'LinkedIn') || '';
    let subject = '', body = message;
    if (channel === 'Email') {
      const lines = message.split('\n');
      const subjectIdx = lines.findIndex(l => /^subject:/i.test(l.trim()));
      if (subjectIdx !== -1) {
        subject = lines[subjectIdx].replace(/^subject:\s*/i, '').trim();
        body = lines.slice(subjectIdx + 1).join('\n').trim();
      }
    }
    const ccParam = (channel === 'Email' && ccList.length > 0) ? `&cc=${encodeURIComponent(ccList.join(','))}` : '';
    if (channel === 'WhatsApp' && phone) window.open(`https://wa.me/${String(phone).replace(/[^0-9+]/g, '')}?text=${encodeURIComponent(message)}`, '_blank');
    else if (channel === 'Email' && email) window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}${ccParam}`, '_blank');
    else if (channel === 'LinkedIn' && linkedin) { navigator.clipboard.writeText(message).catch(() => {}); window.open(linkedin, '_blank'); }
    else if (channel === 'Call' && phone) window.open(`tel:${phone}`, '_self');

    const companyIds = linkedIds(stakeholder, 'Account');
    try {
      const a = api || new AirtableAPI();
      await a.createRecord(TABLE_IDS.outreach, {
        'Activity Name': `${channel} to ${sn} — ${new Date().toLocaleDateString('en-US')}`,
        'Account': companyIds, 'Stakeholder': [stakeholder.id],
        'Channel': channel, 'Date': new Date().toISOString(),
        'Status': 'Sent', 'Message': message || '',
        'Notes': `Auto-logged from CP Briefings${eventId ? ' (event invite)' : ''}`,
        'Logged By': CURRENT_USER?.name || '',
        ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
        ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
      });
      // If an event was referenced, register stakeholder as invited (bidirectional link auto-syncs to Stakeholder.Events)
      if (eventId) {
        const ev = data.events?.find(e => e.id === eventId);
        const currentInvited = ev ? linkedIds(ev, 'Stakeholders invited') : [];
        await a.updateRecord(TABLE_IDS.events, eventId, {
          'Stakeholders invited': [...new Set([...currentInvited, stakeholder.id])],
        }).catch(e => console.error('[cpUseMessage] event invite update failed:', e));
      }
      await activateAccountIfNeeded(a, companyIds, data.accounts);
      await updateStakeholderStatus(a, stakeholder.id, 'Contacted', data.stakeholders);
      if (onLogActivity) onLogActivity();
    } catch (e) { console.error('Auto-log failed:', e); }
  };

  // Manual Account Creation
  const createAccount = async () => {
    if (!newAccName.trim()) return;
    const exists = accounts.some(a => (F(a, 'Account Name') || '').toLowerCase() === newAccName.trim().toLowerCase());
    if (exists) { window.__oikeToast('Account already exists!', 'warning'); return; }
    const fields = { 'Account Name': newAccName.trim() };
    if (newAccWebsite.trim()) fields['Website'] = newAccWebsite.trim();
    if (CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name) fields['BDR Owner'] = CURRENT_USER.name;
    if (CURRENT_USER?.role === 'cp' && CURRENT_USER?.name) fields['CP Assigned'] = CURRENT_USER.name;
    // Optimistic: show instantly
    if (onAddRecord) onAddRecord('accounts', fields);
    setNewAccName(''); setNewAccWebsite(''); setShowNewAccount(false);
    // API in background
    const a = api || new AirtableAPI();
    a.createRecord(TABLE_IDS.accounts, fields)
      .then(() => { if (onLogActivity) onLogActivity(); })
      .catch(e => { console.error(e); window.__oikeToast('Failed to create account', 'error'); if (onLogActivity) onLogActivity(); });
  };

  // ── Diagnostic Intake ──
  const [intakeRecord, setIntakeRecord] = useState(null);
  const [intakeLoading, setIntakeLoading] = useState(false);
  const [generatingIntake, setGeneratingIntake] = useState(false);

  useEffect(() => {
    setIntakeRecord(null);
  }, [selectedAccountId]);

  const loadIntakeRecord = async () => {
    if (!account) return;
    setIntakeLoading(true);
    try {
      const a = api || new AirtableAPI();
      const rows = await a.fetchTable(TABLE_IDS.diagnosticIntake);
      const match = rows.find(r => {
        const linked = r.fields?.['Account'];
        return Array.isArray(linked) ? linked.includes(account.id) : linked === account.id;
      });
      setIntakeRecord(match || null);
    } catch(e) { console.error('intake load:', e); }
    setIntakeLoading(false);
  };

  const generateIntakeLink = async () => {
    if (!account) return;
    setGeneratingIntake(true);
    try {
      const token = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
      const a = api || new AirtableAPI();
      const rec = await a.createRecord(TABLE_IDS.diagnosticIntake, {
        'Name': F(account, 'Account Name') || 'Intake',
        'Account': [account.id],
        'Token': token,
        'Status': 'Pending',
      });
      setIntakeRecord(rec);
    } catch(e) { console.error('intake create:', e); window.__oikeToast('Error generando el link', 'error'); }
    setGeneratingIntake(false);
  };

  // Manual Stakeholder Creation
  const createStakeholder = async () => {
    if (!newStkName.trim() || !account) return;
    const fields = { 'Name': newStkName.trim(), 'Account': [account.id] };
    if (newStkLastName.trim()) fields['Last name'] = newStkLastName.trim();
    if (newStkRole.trim()) fields['Role'] = newStkRole.trim();
    if (newStkEmail.trim()) fields['Email'] = newStkEmail.trim();
    if (newStkPhone.trim()) fields['Phone number'] = newStkPhone.trim();
    if (newStkLinkedin.trim()) fields['LinkedIn'] = newStkLinkedin.trim();
    if (newStkInfluence) fields['Level of Influence'] = newStkInfluence;
    if (CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name) fields['BDR Owner'] = CURRENT_USER.name;
    if (CURRENT_USER?.role === 'cp' && CURRENT_USER?.name) fields['CP Assigned'] = CURRENT_USER.name;
    // Duplicate check
    const dup = findDuplicateStakeholder(fields, stakeholders);
    if (dup && !confirmDuplicateStakeholder(dup)) return;
    // Optimistic: show instantly
    if (onAddRecord) onAddRecord('stakeholders', fields);
    setNewStkName(''); setNewStkLastName(''); setNewStkRole(''); setNewStkEmail('');
    setNewStkPhone(''); setNewStkLinkedin(''); setNewStkInfluence(''); setShowNewStakeholder(false);
    // API in background
    const a = api || new AirtableAPI();
    a.createRecord(TABLE_IDS.stakeholders, fields)
      .then(() => { if (onLogActivity) onLogActivity(); })
      .catch(e => { console.error(e); window.__oikeToast('Failed to create stakeholder', 'error'); if (onLogActivity) onLogActivity(); });
  };

  // CSV Account Import
  const handleAccCsv = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const rows = result.data.map(row => {
          const norm = {};
          Object.keys(row).forEach(k => {
            const kl = k.toLowerCase().trim();
            if (kl.includes('name') || kl.includes('nombre') || kl.includes('account') || kl.includes('company') || kl.includes('empresa')) norm.name = row[k]?.trim();
            if (kl.includes('website') || kl.includes('web') || kl.includes('url') || kl.includes('sitio')) norm.website = row[k]?.trim();
          });
          return norm;
        }).filter(r => r.name);
        // Duplicate detection (exact + fuzzy)
        const existingAccNames = accounts.map(a => F(a, 'Account Name') || '');
        const enriched = rows.map(r => {
          const rLow = r.name.toLowerCase();
          const exactMatch = existingAccNames.some(n => n.toLowerCase() === rLow);
          if (exactMatch) return { ...r, isDuplicate: true, duplicateReason: 'Name exists', selected: false };
          const fuzzyMatch = existingAccNames.find(n => strSimilarity(n, r.name) >= 0.75);
          if (fuzzyMatch) return { ...r, isDuplicate: false, isFuzzy: true, fuzzyReason: `Similar to "${fuzzyMatch}"`, selected: true };
          return { ...r, isDuplicate: false, isFuzzy: false, selected: true };
        });
        setAccCsvRows(enriched);
        setAccImportResult(null);
      }
    });
  };

  const importAccounts = async () => {
    const toImport = accCsvRows.filter(r => r.selected && !r.isDuplicate);
    if (!toImport.length) return;
    setAccImporting(true);
    let created = 0, failed = 0;
    const a = api || new AirtableAPI();
    for (const row of toImport) {
      try {
        const fields = { 'Account Name': row.name };
        if (row.website) fields['Website'] = row.website;
        await a.createRecord(TABLE_IDS.accounts, fields);
        created++;
        await new Promise(r => setTimeout(r, 250));
      } catch (e) { failed++; console.error(e); }
    }
    setAccImportResult({ created, failed });
    setAccImporting(false);
    if (onLogActivity) onLogActivity();
  };

  // File upload for Intel Notes
  const loadPdfJs = () => new Promise((resolve, reject) => {
    if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    script.onerror = () => reject(new Error('Failed to load PDF.js'));
    document.head.appendChild(script);
  });

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file || !account) return;
    setUploadingFile(true);
    try {
      let content = '';
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      if (isPdf) {
        try {
          const pdfjsLib = await loadPdfJs();
          const arrayBuffer = await file.arrayBuffer();
          const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
          const pages = [];
          for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            pages.push(textContent.items.map(item => item.str).join(' '));
          }
          content = pages.join('\n');
        } catch (pdfErr) {
          throw new Error(`Could not read PDF "${file.name}": ${pdfErr.message}`);
        }
      } else {
        try {
          content = await file.text();
        } catch (readErr) {
          throw new Error(`Could not read file "${file.name}". Supported types: .txt, .csv, .json, .md, .html, .pdf`);
        }
      }
      if (!content.trim()) throw new Error('File appears to be empty or unreadable.');
      const truncated = content.slice(0, 4000);

      const prompt = `You are a B2B sales intelligence analyst working for ${COMPANY_PROFILE.companyName || 'our company'} (${COMPANY_PROFILE.services || 'professional services'}). Summarize the key insights from this file that are relevant for selling to ${name}.

FILE NAME: ${file.name}
FILE CONTENT:
${truncated}

Provide:
1. A brief summary (2-3 sentences) of what this file contains
2. Key insights relevant for sales outreach (3-5 bullet points)
3. Any specific names, roles, pain points, or opportunities mentioned

Be concise and actionable. Focus on what's useful for a BDR prospecting this account.`;

      const summary = await callOpenAI({ prompt, temperature: 0.5, max_tokens: 500 });

      const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const newEntry = `\n\n📎 FILE: ${file.name} (uploaded ${dateStr})\n${summary}`;
      const updatedNotes = (intelNotes || '') + newEntry;

      const atApi = api || new AirtableAPI();
      await atApi.updateRecord(TABLE_IDS.accounts, account.id, { 'Intel Notes': updatedNotes });
      if (onLogActivity) onLogActivity();
    } catch (e) {
      console.error(e);
      window.__oikeToast('Failed to process file: ' + (e.message || 'Unknown error. Check file type and OpenAI API key.'), 'error');
    }
    setUploadingFile(false);
    e.target.value = '';
  };

  // Solution management
  const currentSolIds = account ? linkedIds(account, 'Solutions') : [];
  const allSolutions = data.solutions || [];
  const availableSolutions = allSolutions.filter(s => !currentSolIds.includes(s.id));

  const addSolutionToAccount = async (solId) => {
    if (!account) return;
    if (currentSolIds.includes(solId)) return;
    try {
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.accounts, account.id, { 'Solutions': [...currentSolIds, solId] });
      setShowSolPicker(false);
      if (onLogActivity) onLogActivity();
    } catch (e) {
      console.error('[addSolutionToAccount] Error:', e);
      window.__oikeToast('Failed to add solution: ' + (e.message || 'unknown'), 'error');
    }
  };

  const removeSolutionFromAccount = async (solId) => {
    if (!account) return;
    setRemovingSol(solId);
    try {
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.accounts, account.id, { 'Solutions': currentSolIds.filter(id => id !== solId) });
      if (onLogActivity) onLogActivity();
    } catch (e) { console.error(e); window.__oikeToast('Failed to remove solution', 'error'); }
    setRemovingSol(null);
  };

  const createNewSolution = async () => {
    if (!newSolName.trim() || !account) return;
    setCreatingSol(true);
    try {
      const a = api || new AirtableAPI();
      const newRec = await a.createRecord(TABLE_IDS.solutions, {
        'Name': newSolName.trim(),
        ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
        ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
      });
      if (newRec?.id) {
        await a.updateRecord(TABLE_IDS.accounts, account.id, { 'Solutions': [...currentSolIds, newRec.id] });
      }
      setNewSolName('');
      if (onLogActivity) onLogActivity();
    } catch (e) { console.error(e); window.__oikeToast('Failed to create solution', 'error'); }
    setCreatingSol(false);
  };

  // ICP auto-match: solutions recommended by matching ICPs, not yet linked
  const icpMatchedSolutions = useMemo(() => {
    if (!account || !icp?.length || !allSolutions?.length) return [];
    const matchingIcps = icp.filter(icpRec => {
      const F2 = (rec, f) => { const v = rec?.fields?.[f]; return v != null ? String(v) : ''; };
      const accIndustry = F(account, 'Industry').toLowerCase();
      const accCountry = F(account, 'Country').toLowerCase();
      const icpIndustry = F2(icpRec, 'Industry').toLowerCase();
      const icpCountry = F2(icpRec, 'Country').toLowerCase();
      const industryMatch = icpIndustry && accIndustry &&
        icpIndustry.split(/[/,]+/).map(s => s.trim()).some(w => w && accIndustry.includes(w));
      if (!industryMatch) return false;
      if (icpCountry) {
        const countryMatch = icpCountry.split(/[/,]+/).map(s => s.trim()).some(w => w && accCountry.includes(w));
        if (!countryMatch) return false;
      }
      return true;
    });
    const recommendedSolIds = new Set(matchingIcps.flatMap(icpRec => linkedIds(icpRec, 'Solutions')));
    return allSolutions.filter(s => recommendedSolIds.has(s.id) && !currentSolIds.includes(s.id))
      .map(s => ({ sol: s, icpNames: matchingIcps.filter(icpRec => linkedIds(icpRec, 'Solutions').includes(s.id)).map(icpRec => F(icpRec, 'Name')) }));
  }, [account, icp, allSolutions, currentSolIds]);

  const openIcpAutoMatch = () => {
    const init = {};
    icpMatchedSolutions.forEach(({ sol }) => { init[sol.id] = true; });
    setIcpAutoMatchSelected(init);
    setShowIcpAutoMatch(true);
  };

  const confirmIcpAutoMatch = async () => {
    const toAdd = icpMatchedSolutions.filter(({ sol }) => icpAutoMatchSelected[sol.id]).map(({ sol }) => sol.id);
    if (!toAdd.length) { setShowIcpAutoMatch(false); return; }
    setSavingAutoMatch(true);
    try {
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.accounts, account.id, { 'Solutions': [...currentSolIds, ...toAdd] });
      if (onLogActivity) onLogActivity();
      setShowIcpAutoMatch(false);
      window.__oikeToast(`${toAdd.length} solution${toAdd.length > 1 ? 's' : ''} added`, 'success');
    } catch (e) { console.error(e); window.__oikeToast('Failed to add solutions', 'error'); }
    setSavingAutoMatch(false);
  };

  // ─── OFFERING RECOMMENDATION ───
  const generateOfferingRec = async () => {
    if (!account || !allSolutions.length) return;
    const cacheKey = account.id;
    if (offeringRecCache.current[cacheKey]) { setOfferingRec(offeringRecCache.current[cacheKey]); return; }
    setOfferingRecLoading(true);
    try {
      const cp = COMPANY_PROFILE || {};
      const accIntelRaw = F(account, 'Intel Notes') || '';
      const accIntelClean = accIntelRaw.replace(/📎\s*FILE:[\s\S]*?(?=\n📎\s*FILE:|$)/g, '').trim();
      const accNews = F(account, 'Recent News') || '';
      const solList = allSolutions.map(s => `- ID:${s.id} | ${F(s, 'Name')}: ${(F(s, 'Service | Solution Detail') || F(s, 'Stakeholder Key Message') || '').slice(0, 200)}`).join('\n');
      const prompt = `You are a B2B sales strategist for ${cp.companyName || 'our company'}.

ACCOUNT: ${F(account, 'Account Name')} | Industry: ${F(account, 'Industry')} | Country: ${F(account, 'Country')}
ACCOUNT INTEL: ${accIntelClean.slice(0, 600) || 'None'}
RECENT NEWS: ${accNews.slice(0, 300) || 'None'}

OUR SOLUTIONS:
${solList}

Based ONLY on the account intel above, pick the SINGLE BEST solution for this account right now. Respond with JSON only:
{ "solId": "<the exact ID from the list>", "solName": "<solution name>", "why": "<2-3 sentences explaining why this is the best fit based on the intel>", "fit": "high|medium|low" }`;
      const raw = await callOpenAI({ prompt, max_tokens: 400 });
      console.log('[offeringRec] raw:', raw);
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON in response');
      const json = JSON.parse(match[0]);
      // resolve solId by name if AI returned a wrong/partial id
      if (json.solName && (!json.solId || !allSolutions.find(s => s.id === json.solId))) {
        const found = allSolutions.find(s => F(s, 'Name').toLowerCase() === (json.solName || '').toLowerCase());
        if (found) json.solId = found.id;
      }
      offeringRecCache.current[cacheKey] = json;
      setOfferingRec(json);
    } catch (e) { console.error('[offeringRec] error:', e); window.__oikeToast('Failed to generate recommendation: ' + (e.message || 'unknown'), 'error'); }
    setOfferingRecLoading(false);
  };

  // auto-trigger when account changes and intel exists
  useEffect(() => {
    if (!account) return;
    const hasIntel = !!(F(account, 'Intel Notes') || F(account, 'Recent News') || radarStore[account.id]?.data);
    if (!hasIntel) { setOfferingRec(null); return; }
    const cached = offeringRecCache.current[account.id];
    if (cached) { setOfferingRec(cached); return; }
    setOfferingRec(null);
    generateOfferingRec();
  }, [account?.id]);

  // ─── OPPORTUNITY CREATE / EDIT ───
  // OPP_STAGES defined globally above

  const openNewOpp = () => {
    setOppForm({ name: '', stage: 'Prospecting', description: '', owner: '', value: '', closeDate: '', openingDate: '', nextStep: '' });
    setOppFormSolIds([]);
    setEditingOpp({ opp: null, isNew: true });
  };

  const openEditOpp = (opp) => {
    setOppForm({
      name: F(opp, 'Deal/Opp name') || '',
      stage: F(opp, 'Stage') || '',
      description: F(opp, 'Reason') || '',
      owner: F(opp, 'Opp Owner') || '',
      value: opp.fields?.['Value'] != null ? String(opp.fields['Value']) : '',
      closeDate: opp.fields?.['close date'] ? String(opp.fields['close date']).slice(0, 10) : '',
      openingDate: opp.fields?.['Opening date'] ? String(opp.fields['Opening date']).slice(0, 10) : '',
      nextStep: F(opp, 'Next step') || '',
    });
    setOppFormSolIds(linkedIds(opp, 'Solutions'));
    setEditingOpp({ opp, isNew: false });
  };

  const saveOppForm = async () => {
    if (!oppForm.name.trim()) { window.__oikeToast('Opportunity name is required', 'warning'); return; }
    setSavingOppForm(true);
    try {
      const a = api || new AirtableAPI();
      const fields = {
        'Deal/Opp name': oppForm.name.trim(),
        'Stage': oppForm.stage || 'Prospecting',
        'Reason': oppForm.description.trim() || undefined,
        'Opp Owner': oppForm.owner.trim() || undefined,
        'Next step': oppForm.nextStep.trim() || undefined,
      };
      if (oppForm.value && !isNaN(Number(oppForm.value))) fields['Value'] = Number(oppForm.value);
      if (oppForm.closeDate) fields['close date'] = oppForm.closeDate;
      if (oppForm.openingDate) fields['Opening date'] = oppForm.openingDate;
      if (oppFormSolIds.length > 0) fields['Solutions'] = oppFormSolIds;
      // Remove undefined
      Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

      if (editingOpp.isNew) {
        fields['Account'] = account ? [account.id] : [];
        const newRec = await a.createRecord(TABLE_IDS.opportunities, fields);
        if (onAddRecord) onAddRecord('opportunities', { ...fields, Account: account ? [account.id] : [] });
      } else {
        await a.updateRecord(TABLE_IDS.opportunities, editingOpp.opp.id, fields);
        if (onUpdateRecord) onUpdateRecord('opportunities', editingOpp.opp.id, fields);
      }
      setEditingOpp(null);
      if (onLogActivity) onLogActivity();
    } catch (e) {
      console.error(e);
      window.__oikeToast('Failed to save opportunity: ' + e.message, 'error');
    }
    setSavingOppForm(false);
  };

  const deleteOpp = async (opp) => {
    if (!confirm(`Delete "${F(opp, 'Deal/Opp name')}"? This cannot be undone.`)) return;
    if (onDeleteRecord) onDeleteRecord('opportunities', opp.id);
    const a = api || new AirtableAPI();
    a.deleteRecord(TABLE_IDS.opportunities, opp.id).catch(e => { console.error(e); if (onLogActivity) onLogActivity(); });
  };

  // Opportunity modal (shared for create + edit)
  const renderOppModal = () => {
    if (!editingOpp) return null;
    const iStyle = { width: '100%', padding: '7px 9px', background: 'var(--globant-input)', border: '1px solid var(--globant-border)', borderRadius: 6, color: 'var(--globant-text)', fontSize: 12, boxSizing: 'border-box' };
    const lStyle = { fontSize: 10, color: 'var(--globant-muted)', fontWeight: 600, marginBottom: 3, textTransform: 'uppercase', display: 'block' };
    const set = (key, val) => setOppForm(p => ({ ...p, [key]: val }));
    return (
      <div className="modal-overlay" onClick={() => setEditingOpp(null)}>
        <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
            <h3 style={{ margin: 0 }}>{editingOpp.isNew ? '🚀 New Opportunity' : '✏️ Edit Opportunity'}</h3>
            <button onClick={() => setEditingOpp(null)} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={lStyle}>Deal / Opportunity Name *</label>
              <input style={iStyle} value={oppForm.name} onChange={e => set('name', e.target.value)} placeholder="e.g. AI Platform — Phase 1" autoFocus />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={lStyle}>Stage</label>
                <select style={iStyle} value={oppForm.stage} onChange={e => set('stage', e.target.value)}>
                  {OPP_STAGES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label style={lStyle}>Value (USD)</label>
                <input style={iStyle} type="number" value={oppForm.value} onChange={e => set('value', e.target.value)} placeholder="e.g. 50000" />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={lStyle}>Opening Date</label>
                <input style={iStyle} type="date" value={oppForm.openingDate} onChange={e => set('openingDate', e.target.value)} />
              </div>
              <div>
                <label style={lStyle}>Close Date</label>
                <input style={iStyle} type="date" value={oppForm.closeDate} onChange={e => set('closeDate', e.target.value)} />
              </div>
            </div>
            <div>
              <label style={lStyle}>Owner</label>
              <input style={iStyle} value={oppForm.owner} onChange={e => set('owner', e.target.value)} placeholder="e.g. John Smith" />
            </div>
            <div>
              <label style={lStyle}>Description / Notes</label>
              <textarea style={{ ...iStyle, minHeight: 70, resize: 'vertical' }} value={oppForm.description} onChange={e => set('description', e.target.value)} placeholder="Context, deal background, blockers..." />
            </div>
            <div>
              <label style={lStyle}>Next Step</label>
              <input style={iStyle} value={oppForm.nextStep} onChange={e => set('nextStep', e.target.value)} placeholder="e.g. Send proposal by Friday" />
            </div>
            <div>
              <label style={lStyle}>Offering</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                {oppFormSolIds.map(sid => {
                  const sol = solutions.find(s => s.id === sid);
                  return sol ? (
                    <span key={sid} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', display: 'flex', alignItems: 'center', gap: 5 }}>
                      {F(sol, 'Name')}
                      <span style={{ cursor: 'pointer', fontWeight: 700 }} onClick={() => setOppFormSolIds(prev => prev.filter(id => id !== sid))}>×</span>
                    </span>
                  ) : null;
                })}
              </div>
              <select style={iStyle} value="" onChange={e => { if (e.target.value && !oppFormSolIds.includes(e.target.value)) setOppFormSolIds(prev => [...prev, e.target.value]); }}>
                <option value="">+ Add solution...</option>
                {solutions.filter(s => !oppFormSolIds.includes(s.id)).map(s => <option key={s.id} value={s.id}>{F(s, 'Name')}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button className="action-btn btn-ghost" style={{ flex: 1 }} onClick={() => setEditingOpp(null)}>Cancel</button>
              <button className="action-btn btn-primary" style={{ flex: 2 }} onClick={saveOppForm} disabled={savingOppForm || !oppForm.name.trim()}>
                {savingOppForm ? '⏳ Saving...' : editingOpp.isNew ? '🚀 Create Opportunity' : '💾 Save Changes'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Reset talking points and recs when account changes
  useEffect(() => { setTalkingPoints(''); setContactRecs(''); setStakeholderSearch(''); setAccDetailTab('strategy'); setNbaText(''); setNbaLoading(false); }, [selectedAccountId]);

  // Load strategy from account record when account changes
  useEffect(() => {
    if (!account) { setStrategyData({ objective: '', targetDate: '', angle: '', stakeholderRoles: {}, milestones: [] }); return; }
    try {
      const raw = F(account, 'Strategy');
      if (raw) { setStrategyData(JSON.parse(raw)); return; }
    } catch {}
    setStrategyData({ objective: '', targetDate: '', angle: '', stakeholderRoles: {}, milestones: [] });
  }, [selectedAccountId]);

  // NBA useEffect — generate next best action per account
  useEffect(() => {
    if (!account) { setNbaText(''); return; }
    if (nbaCache.current[account.id]) { setNbaText(nbaCache.current[account.id]); return; }
    setNbaText('');
    setNbaLoading(true);
    const prompt = `Account: ${F(account,'Account Name')}. Stage: ${F(account,'Inside Sales Status')}. Last outreach: ${accOutreach.length} touches. Stakeholders: ${accStakeholders.length}. Opps: ${opps.length}. Give ONE specific next best action in 1 sentence.`;
    callOpenAI({ prompt, temperature: 0.5, max_tokens: 80 })
      .then(r => { nbaCache.current[account.id] = r; setNbaText(r); })
      .catch(() => setNbaText(''))
      .finally(() => setNbaLoading(false));
  }, [selectedAccountId]);

  // ── Sales Intelligence Radar — generate for current account ──
  const generateAccountRadar = async () => {
    if (!account) return;
    setLoadingRadar(true);
    try {
      const accName = F(account, 'Account Name') || 'Account';
      const accIndustry = F(account, 'Industry') || '';
      const accCountry = F(account, 'Country') || '';
      const accSize = F(account, 'Company size') || '';
      const accDescription = F(account, 'Company Description') || '';
      const accWebsite = F(account, 'Website') || '';
      const accStatus = F(account, 'Inside Sales Status') || '';
      const accNews = F(account, 'Recent News') || '';
      const accIntelRaw = F(account, 'Intel Notes') || '';
      const accIntelClean = accIntelRaw ? String(accIntelRaw).replace(/📎\s*FILE:[\s\S]*?(?=\n📎\s*FILE:|$)/g, '').trim() : '';

      // Stakeholders with HOT/WARM/COLD temperature from outreach history
      const stkSummary = stakeholderEngagement.slice(0, 12).map(e => {
        const temp = e.hasMeeting ? 'HOT🔥' : (e.hasReplied || e.totalTouches > 0) ? 'WARM🌡️' : 'COLD❄️';
        const pain = (F(e.s, 'Pain Points (Generated)') || F(e.s, 'Pain points') || '').slice(0, 180);
        const linkedin = (F(e.s, 'LinkedIn News (Generated)') || F(e.s, 'Linkedin lates news') || '').slice(0, 150);
        return `- ${e.sName} (${F(e.s,'Role')||'?'}) [${temp}]${e.totalTouches > 0 ? ` · ${e.totalTouches} touches${e.daysSince !== null ? `, ${e.daysSince}d ago` : ''}` : ''}
${pain ? `  Pain: ${pain}` : ''}${linkedin ? `\n  Signal: ${linkedin}` : ''}`;
      }).join('\n');

      const outreachSummary = accOutreach.slice(0, 8).map(o => {
        const stkId = linkedIds(o, 'Stakeholder')[0];
        const stk = stkId ? accStakeholders.find(s => s.id === stkId) : null;
        const sName = stk ? `${F(stk,'Name')||''}` : 'Unknown';
        const date = o.fields?.['Date'] ? new Date(o.fields['Date']).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?';
        return `- ${date} · ${F(o,'Channel')||''} · ${F(o,'Status')||''} · ${sName}`;
      }).join('\n');

      const oppsSummary = opps.slice(0, 5).map(o =>
        `- ${F(o,'Deal/Opp name')||'Untitled'} | Stage: ${F(o,'Stage')||'?'} | ${formatCurrency(o.fields?.['Value']||0)} | Next: ${F(o,'Next step')||'—'}`
      ).join('\n');

      // Real tech stack from Snov.io
      let realTechStack = [];
      if (accWebsite) {
        try {
          const enrichRes = await fetch('/api/enrich-company', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` },
            body: JSON.stringify({ website: accWebsite }),
          });
          const enrichData = await enrichRes.json().catch(() => ({}));
          if (enrichData.ok && enrichData.technologies?.length) {
            realTechStack = enrichData.technologies;
            console.log('[radar] tech stack from snov:', realTechStack);
          }
        } catch (e) { console.warn('[radar] snov enrich failed:', e); }
      }

      // Our company offering — from COMPANY_PROFILE + real solutions from Airtable
      const cp = COMPANY_PROFILE;
      const allSolutions = data.solutions || [];
      const accSolIds = account ? linkedIds(account, 'Solutions') : [];
      const accSolutions = accSolIds.length > 0
        ? allSolutions.filter(s => accSolIds.includes(s.id))
        : allSolutions; // if no solutions linked to account, use all available
      const solutionsList = accSolutions.slice(0, 12).map(s => {
        const name = F(s, 'Name') || '';
        const desc = (F(s, 'Description') || F(s, 'Info') || '').slice(0, 150);
        const km = (F(s, 'Key Message') || '').slice(0, 100);
        return `• ${name}${desc ? ` — ${desc}` : ''}${km ? ` | Key message: ${km}` : ''}`;
      }).join('\n');

      const prompt = `You are a senior B2B sales intelligence analyst working for ${cp.companyName || 'our company'}.
${cp.services ? `Our services: ${cp.services}` : ''}
${cp.goals ? `Strategic focus: ${cp.goals}` : ''}

OUR SOLUTIONS / OFFERINGS:
${solutionsList || cp.services || 'Not specified'}

Generate a Sales Intelligence Radar for the following account. All analysis must be grounded in how OUR specific solutions above can address this account's needs. Return ONLY valid JSON.

ACCOUNT: ${accName}
Industry: ${accIndustry} · Country: ${accCountry} · Size: ${accSize}
Website: ${accWebsite}
Description: ${accDescription.slice(0,300)}
Inside Sales Status: ${accStatus}

RECENT NEWS:
${(typeof accNews === 'string' ? accNews : '').slice(0,1200) || 'None'}

INTEL NOTES:
${accIntelClean.slice(0,800) || 'None'}

STAKEHOLDERS (${stakeholderEngagement.length} mapped):
${stkSummary || 'None yet'}

RECENT OUTREACH:
${outreachSummary || 'No outreach history'}

OPEN OPPORTUNITIES:
${oppsSummary || 'None'}

Return a JSON object with EXACTLY these keys. Be specific and data-driven. Reference our actual solutions by name when relevant.

{
  "tldr": "3 sentences max: biggest opportunity right now (referencing a specific solution if applicable), key risk, one immediate action",
  "est_budget": "Estimated annual tech/services budget range based on company size and industry. E.g. '$2M–5M'. If unknown write 'Unknown — discovery needed'",
  "portfolio_label": "1 line: what category of buyer are they? e.g. 'Digital transformation leader, early AI adopter'",
  "key_developments": [
{ "headline": "...", "signal": "what this means for our specific solutions and why it's an opening", "source": "News/Intel/LinkedIn" }
  ],
  "financial_signals": "2-3 sentences on financial health, investment activity, budget signals, hiring trends that imply budget",
  "people_moves": [
{ "name": "...", "move": "what changed (new role, promoted, left)", "relevance": "why it matters for our deal" }
  ],
  "social_sentiment": "1-2 sentences: what is the company publicly saying/signaling on LinkedIn or press? Tone: growth, caution, cost-cutting?",
  "tech_stack": [
{ "tool": "tool or platform name", "category": "CRM/ERP/Cloud/Analytics/etc", "opportunity": "how one of our specific solutions can replace, complement or integrate with this" }
  ],
${realTechStack.length ? `REAL TECH STACK FROM SNOV.IO (use these, do not invent others): ${realTechStack.join(', ')}` : ''}
  "competitive": "2-3 sentences: who else could they be evaluating? What is our differentiation with our specific solutions vs likely competitors?",
  "hiring_signals": "1-2 sentences: what roles are they hiring that reveal strategic priorities and align with our solutions?",
  "upcoming_events": [
{ "event": "...", "date": "...", "angle": "how to use this as an outreach hook, referencing a relevant solution if applicable" }
  ],
  "recommended_actions": [
{ "priority": 1, "stakeholder": "Name or role", "temperature": "HOT/WARM/COLD", "action": "specific action mentioning which solution to lead with", "channel": "LinkedIn/Email/Phone/WhatsApp", "rationale": "why now and why this solution fits" }
  ]
}

Rules:
- key_developments: 2-4 items based on real news/intel provided
- people_moves: only include if there are actual signals, otherwise empty array []
- tech_stack: use ONLY the real tools from SNOV.IO list above if provided; otherwise infer 2-5 from industry/description. Always connect opportunity to one of our specific solutions
- upcoming_events: only if you can infer real events (conferences, fiscal year end, announced launches), otherwise []
- recommended_actions: 3-5 actions, ordered by priority, using real stakeholder names from the data. Always name which solution to lead with
- Return ONLY valid JSON. No markdown. No commentary.`;

      const raw = await callOpenAI({ prompt, temperature: 0.5, max_tokens: 2800 });
      const cleaned = raw.replace(/```json?\n?/g,'').replace(/```/g,'').trim();
      const parsed = JSON.parse(cleaned);
      parsed._techFromSnov = realTechStack.length > 0;
      setRadarData(parsed);
    } catch (e) {
      console.error('Radar generation failed:', e);
      window.__oikeToast('Radar generation failed: ' + (e?.message || String(e)), 'error');
    }
    setLoadingRadar(false);
  };

  // ── Save Radar to Intel Notes (prepends to existing notes) ──
  const saveRadarToIntel = async () => {
    if (!radarData || !account) return;
    setSavingRadar(true);
    try {
      const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const lines = [
        `🔮 SALES INTELLIGENCE RADAR — ${F(account,'Account Name')||'Account'} · ${dateStr}`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ``,
        `TL;DR: ${radarData.tldr || ''}`,
        `Est. Budget: ${radarData.est_budget || ''}`,
        `Profile: ${radarData.portfolio_label || ''}`,
        ``,
        `📰 KEY DEVELOPMENTS:`,
        ...(radarData.key_developments || []).map(d => `• ${d.headline} → ${d.signal}`),
        ``,
        `💰 FINANCIAL SIGNALS: ${radarData.financial_signals || ''}`,
        ``,
        `👥 PEOPLE MOVES:`,
        ...(radarData.people_moves || []).map(m => `• ${m.name}: ${m.move} — ${m.relevance}`),
        ``,
        `🏆 COMPETITIVE: ${radarData.competitive || ''}`,
        ``,
        `💼 HIRING SIGNALS: ${radarData.hiring_signals || ''}`,
        ``,
        `⚡ RECOMMENDED ACTIONS:`,
        ...(radarData.recommended_actions || []).map(a => `• [${a.temperature}] ${a.stakeholder} → ${a.action} via ${a.channel} — ${a.rationale}`),
        ``,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ];
      const radarText = lines.join('\n');
      const existingNotes = F(account, 'Intel Notes') || '';
      const newNotes = radarText + (existingNotes ? '\n\n' + existingNotes : '');
      if (onUpdateRecord) onUpdateRecord('accounts', account.id, { 'Intel Notes': newNotes });
      await api.updateRecord(TABLE_IDS.accounts, account.id, { 'Intel Notes': newNotes });
      if (onLogActivity) onLogActivity();
      window.__oikeToast('✅ Radar saved to Intel Notes!', 'success');
    } catch (e) {
      console.error('Save radar failed:', e);
      window.__oikeToast('Failed to save Radar: ' + (e?.message || String(e)), 'error');
    }
    setSavingRadar(false);
  };

  return (
    <div>
      {renderOppModal()}
      {!selectedAccountId && (
        <AccountsList
          searchTerm={searchTerm} setSearchTerm={setSearchTerm}
          filterSolutionId={filterSolutionId} setFilterSolutionId={setFilterSolutionId}
          filterIndustry={filterIndustry} setFilterIndustry={setFilterIndustry}
          filterCountry={filterCountry} setFilterCountry={setFilterCountry}
          filterCPId={filterCPId} setFilterCPId={setFilterCPId}
          filteredAccounts={filteredAccounts} accounts={accounts}
          selectedAccountIds={selectedAccountIds} setSelectedAccountIds={setSelectedAccountIds}
          deletingAccounts={deletingAccounts} bulkDeleteAccounts={bulkDeleteAccounts}
          selectAccount={selectAccount}
          showNewAccount={showNewAccount} setShowNewAccount={setShowNewAccount}
          showAccImport={showAccImport} setShowAccImport={setShowAccImport}
          newAccName={newAccName} setNewAccName={setNewAccName}
          newAccWebsite={newAccWebsite} setNewAccWebsite={setNewAccWebsite}
          creatingAcc={creatingAcc} createAccount={createAccount}
          handleAccCsv={handleAccCsv} accCsvRows={accCsvRows} setAccCsvRows={setAccCsvRows}
          accImporting={accImporting} importAccounts={importAccounts} accImportResult={accImportResult}
          setEditingAccount={setEditingAccount}
          data={data} outreach={outreach} opportunities={opportunities}
        />
      )}

      {/* Account Briefing */}
      {account && (
        <div>
          {/* ── HERO HEADER ── */}
          <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 0, border: '1px solid rgba(91,191,181,0.2)', borderRadius: 12 }}>
            <div style={{ background: 'linear-gradient(135deg, rgba(91,191,181,0.12) 0%, rgba(96,165,250,0.06) 55%, rgba(167,139,250,0.07) 100%)', padding: '18px 24px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <button className="action-btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => selectAccount('')}>← Back</button>
                <button className="action-btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => setEditingAccount(account)}>✏️ Edit</button>
                {F(account, 'Website') && (
                  <a href={String(F(account, 'Website')).startsWith('http') ? F(account, 'Website') : `https://${F(account, 'Website')}`} target="_blank" rel="noopener noreferrer"
                    style={{ fontSize: 11, color: 'var(--globant-green)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: 'rgba(91,191,181,0.1)', borderRadius: 6, border: '1px solid rgba(91,191,181,0.2)' }}>
                    🔗 Website
                  </a>
                )}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <h2 style={{ fontSize: 28, fontWeight: 800, margin: '0 0 12px', letterSpacing: '-0.5px', color: 'var(--globant-text)' }}>{name}</h2>
                  <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
                    {F(account, 'Industry') && <span style={{ fontSize: 11, padding: '4px 11px', borderRadius: 20, background: 'rgba(96,165,250,0.14)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.22)', fontWeight: 600 }}>🏭 {F(account, 'Industry')}</span>}
                    {F(account, 'Country') && <span style={{ fontSize: 11, padding: '4px 11px', borderRadius: 20, background: 'rgba(244,114,182,0.12)', color: '#f472b6', border: '1px solid rgba(244,114,182,0.2)', fontWeight: 600 }}>📍 {F(account, 'Country')}</span>}
                    {F(account, 'Tier') && <span style={{ fontSize: 11, padding: '4px 11px', borderRadius: 20, background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.2)', fontWeight: 600 }}>⭐ {F(account, 'Tier')}</span>}
                    {F(account, 'Inside Sales Status') && <span style={{ fontSize: 11, padding: '4px 11px', borderRadius: 20, background: 'rgba(91,191,181,0.14)', color: 'var(--globant-green)', border: '1px solid rgba(91,191,181,0.22)', fontWeight: 600 }}>{F(account, 'Inside Sales Status')}</span>}
                    {(() => { const d = account._enriched?.diagnosis; const cfg = d ? DIAGNOSIS_CONFIG[d] : null; return cfg ? <span style={{ fontSize: 11, padding: '4px 11px', borderRadius: 20, background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.color}40`, fontWeight: 600 }}>{cfg.label}</span> : null; })()}
                    {solNames.map((sn, i) => <span key={i} style={{ fontSize: 11, padding: '4px 11px', borderRadius: 20, background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.18)' }}>🛠️ {sn}</span>)}
                    {getMatchingICPs(account, icp).map((icpName, i) => <span key={'icp'+i} style={{ fontSize: 11, padding: '4px 11px', borderRadius: 20, background: 'rgba(52,211,153,0.12)', color: '#34d399', border: '1px solid rgba(52,211,153,0.2)', fontWeight: 600 }}>✅ ICP: {icpName}</span>)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
                  {[
                    { val: accStakeholders.length, label: 'Contacts', color: 'var(--globant-green)', tab: 'contacts' },
                    { val: accOutreach.length, label: 'Touches', color: '#60a5fa', tab: null },
                    { val: opps.length, label: 'Opps', color: '#fbbf24', tab: 'proposals' },
                    { val: stakeholderEngagement.filter(e => e.hasMeeting).length, label: 'Meetings', color: '#a78bfa', tab: null },
                  ].map(({ val, label, color, tab: targetTab }) => (
                    <div key={label} onClick={() => targetTab && setAccDetailTab(targetTab)}
                      style={{ textAlign: 'center', padding: '10px 16px', background: 'rgba(0,0,0,0.3)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.07)', cursor: targetTab ? 'pointer' : 'default', minWidth: 64 }}>
                      <div style={{ fontSize: 24, fontWeight: 800, color, lineHeight: 1 }}>{val}</div>
                      <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 3, fontWeight: 600 }}>{label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* ── DEAL PULSE ── */}
          {(() => {
            const lastEngDay = stakeholderEngagement.reduce((min, e) => e.daysSince !== null ? Math.min(min, e.daysSince) : min, Infinity);
            const hasLastDay = lastEngDay !== Infinity;
            const temp = radarData?.recommended_actions?.[0]?.temperature;
            const tempCfg = temp === 'HOT' ? { icon: '🔥', color: '#f87171', label: 'HOT' }
                         : temp === 'WARM' ? { icon: '🌡️', color: '#fb923c', label: 'WARM' }
                         : temp === 'COLD' ? { icon: '❄️', color: '#94a3b8', label: 'COLD' }
                         : hasLastDay && lastEngDay > 14 ? { icon: '❄️', color: '#94a3b8', label: 'COLD' }
                         : hasLastDay && lastEngDay > 7 ? { icon: '🌡️', color: '#fb923c', label: 'WARM' }
                         : hasLastDay ? { icon: '🔥', color: '#f87171', label: 'HOT' }
                         : { icon: '❓', color: 'var(--globant-muted)', label: 'NO DATA' };
            const nextAction = radarData?.recommended_actions?.[0]?.action || null;
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, marginTop: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: tempCfg.color }}>{tempCfg.icon} {tempCfg.label}</span>
                <span style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)', display: 'inline-block' }} />
                <span style={{ fontSize: 12, color: hasLastDay ? (lastEngDay > 14 ? '#ef4444' : lastEngDay > 7 ? '#fbbf24' : '#60a5fa') : 'var(--globant-muted)' }}>
                  {hasLastDay ? `Last contact ${lastEngDay}d ago` : 'No contact yet'}
                </span>
                {nextAction && (
                  <>
                    <span style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)', display: 'inline-block' }} />
                    <span style={{ fontSize: 12, color: 'var(--globant-text)', flex: 1, minWidth: 0 }}>
                      <span style={{ color: 'var(--globant-muted)', marginRight: 6 }}>Next move:</span>{nextAction}
                    </span>
                  </>
                )}
                <button className="action-btn btn-primary" style={{ fontSize: 11, marginLeft: 'auto', flexShrink: 0 }} onClick={() => setAccDetailTab('strategy')}>
                  🗺️ Strategy
                </button>
              </div>
            );
          })()}

          {/* ── TAB NAVIGATION ── */}
          <div style={{ display: 'flex', gap: 4, padding: '4px', background: 'var(--globant-darker)', borderRadius: 12, marginTop: 12, marginBottom: 16, border: '1px solid var(--globant-border)' }}>
            {[['strategy', '🗺️ Strategy'], ['intel', '📊 Intel'], ['contacts', '👥 Contacts'], ['proposals', '📋 Proposals'], ['intake', '📋 Intake']].map(([tab, label]) => (
              <button key={tab} onClick={() => setAccDetailTab(tab)}
                style={{ flex: 1, padding: '9px 0', border: 'none', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 600, transition: 'all 0.15s',
                  background: accDetailTab === tab ? 'linear-gradient(135deg, rgba(91,191,181,0.2) 0%, rgba(91,191,181,0.08) 100%)' : 'transparent',
                  color: accDetailTab === tab ? 'var(--globant-green)' : 'var(--globant-muted)',
                  boxShadow: accDetailTab === tab ? '0 1px 4px rgba(0,0,0,0.25), inset 0 1px 0 rgba(91,191,181,0.12)' : 'none',
                }}>
                {label}
              </button>
            ))}
          </div>

          {/* ══════════ INTEL TAB ══════════ */}
          {accDetailTab === 'intel' && (
            <AccountIntelTab
              radarData={radarData} loadingRadar={loadingRadar}
              generateAccountRadar={generateAccountRadar} generateMeddpicc={generateMeddpicc}
              accStakeholders={accStakeholders} stakeholderEngagement={stakeholderEngagement}
              opps={opps} meddpiccValues={meddpiccValues} MEDDPICC_FIELDS={MEDDPICC_FIELDS} loadingMeddpicc={loadingMeddpicc}
              newsItems={newsItems}
              intelNotes={intelNotes} editingNotes={editingNotes} notesValue={notesValue}
              setNotesValue={setNotesValue} setEditingNotes={setEditingNotes} saveIntelNotes={saveIntelNotes} savingNotes={savingNotes}
              setCpSelectedStakeholder={setCpSelectedStakeholder} setAccDetailTab={setAccDetailTab}
              isAdmin={isAdmin} users={users} account={account} api={api} onLogActivity={onLogActivity} onUpdateRecord={onUpdateRecord}
            />
          )}
          )}

          {/* ══════════ STAKEHOLDERS TAB ══════════ */}
          {/* ══════════ STAKEHOLDERS TAB ══════════ */}
          {accDetailTab === 'contacts' && (
            <AccountContactsTab
              name={name} stakeholderEngagement={stakeholderEngagement}
              stakeholderSearch={stakeholderSearch} setStakeholderSearch={setStakeholderSearch}
              bulkGeneratePainPoints={bulkGeneratePainPoints} bulkPainLoading={bulkPainLoading} bulkPainProgress={bulkPainProgress}
              showNewStakeholder={showNewStakeholder} setShowNewStakeholder={setShowNewStakeholder}
              newStkName={newStkName} setNewStkName={setNewStkName}
              newStkLastName={newStkLastName} setNewStkLastName={setNewStkLastName}
              newStkRole={newStkRole} setNewStkRole={setNewStkRole}
              newStkEmail={newStkEmail} setNewStkEmail={setNewStkEmail}
              newStkPhone={newStkPhone} setNewStkPhone={setNewStkPhone}
              newStkLinkedin={newStkLinkedin} setNewStkLinkedin={setNewStkLinkedin}
              newStkInfluence={newStkInfluence} setNewStkInfluence={setNewStkInfluence}
              createStakeholder={createStakeholder} creatingStk={creatingStk}
              setHistoryStakeholder={setHistoryStakeholder}
              editingStkNotes={editingStkNotes} setEditingStkNotes={setEditingStkNotes}
              stkNotesValue={stkNotesValue} setStkNotesValue={setStkNotesValue}
              saveStkNotes={saveStkNotes} savingStkNotes={savingStkNotes}
              setCpSelectedStakeholder={setCpSelectedStakeholder}
              setCpMeetingModal={setCpMeetingModal} setCpMeetingNotes={setCpMeetingNotes}
              setCpMeetingDate={setCpMeetingDate} setCpMeetingTime={setCpMeetingTime}
              setCpCallModal={setCpCallModal} setCpCallNotes={setCpCallNotes}
              setCpEditingContact={setCpEditingContact}
              goToMessageLab={goToMessageLab}
              selectedContactIds={selectedContactIds} setSelectedContactIds={setSelectedContactIds}
              deletingContacts={deletingContacts} bulkDeleteContacts={bulkDeleteContacts}
            />
          )}

          {/* ══════════ TALKING POINTS TAB (moved from Intel) ══════════ */}
          {accDetailTab === 'contacts' && (
            <div className="card" style={{ marginTop: 16, borderLeft: '3px solid var(--globant-accent)' }}>
              <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3>🎤 Talking Points</h3>
                <button className="action-btn btn-primary" style={{ fontSize: 11 }} onClick={generateTalkingPoints} disabled={loadingTP}>
                  {loadingTP ? '⏳ Generating...' : talkingPoints ? '🔄 Regenerate' : '✨ Generate with AI'}
                </button>
              </div>
              {!talkingPoints && !loadingTP && (
                <p style={{ color: 'var(--globant-muted)', fontSize: 12, padding: '4px 0' }}>
                  Generate personalized talking points based on stakeholder pain points, recent news, and mapped solutions.
                </p>
              )}
              {talkingPoints && (() => {
                const tpLines = talkingPoints.split('\n').filter(l => l.trim());
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {tpLines.map((line, i) => {
                      const isHeader = line.match(/^#{1,3}\s/) || line.match(/^\*\*[A-Z]/);
                      const clean = line.replace(/^#{1,3}\s+/, '').replace(/^\*\*/, '').replace(/\*\*$/, '').trim();
                      if (!clean) return null;
                      if (isHeader) return <div key={i} style={{ fontSize: 13, fontWeight: 700, color: 'var(--globant-green)', marginTop: i > 0 ? 10 : 0, paddingBottom: 4, borderBottom: '1px solid rgba(91,191,181,0.15)' }}>{clean.replace(/\*\*/g, '')}</div>;
                      const isBullet = line.match(/^[\s]*[-•*]\s|^\d+\./);
                      const bulletClean = clean.replace(/^[-•*]\s*/, '').replace(/^\d+\.\s*/, '');
                      const parts = bulletClean.split(/(\*\*[^*]+\*\*)/g);
                      return (
                        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '4px 0' }}>
                          {isBullet && <span style={{ color: 'var(--globant-green)', fontSize: 8, marginTop: 6 }}>●</span>}
                          <span style={{ fontSize: 12, lineHeight: 1.6 }}>
                            {parts.map((p, pi) => p.startsWith('**') && p.endsWith('**')
                              ? <strong key={pi} style={{ color: 'var(--globant-green)' }}>{p.slice(2, -2)}</strong>
                              : <span key={pi}>{p}</span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* ══════════ PIPELINE (now merged into proposals) ══════════ */}
          {/* ══════════ PIPELINE TAB ══════════ */}
          {accDetailTab === 'proposals' && (
            <AccountProposalsTab
              opps={opps} account={account} accStakeholders={accStakeholders}
              solutions={solutions} accEvents={accEvents}
              selectedOppId={selectedOppId} setSelectedOppId={setSelectedOppId}
              oppNotes={oppNotes} setOppNotes={setOppNotes}
              oppNextStep={oppNextStep} setOppNextStep={setOppNextStep}
              oppStakeholder={oppStakeholder} setOppStakeholder={setOppStakeholder}
              oppSolutionIds={oppSolutionIds} setOppSolutionIds={setOppSolutionIds}
              editingOppNotes={editingOppNotes} setEditingOppNotes={setEditingOppNotes}
              savingOppNotes={savingOppNotes} setSavingOppNotes={setSavingOppNotes}
              showAddOppStk={showAddOppStk} setShowAddOppStk={setShowAddOppStk}
              newOppStkName={newOppStkName} setNewOppStkName={setNewOppStkName}
              newOppStkRole={newOppStkRole} setNewOppStkRole={setNewOppStkRole}
              creatingOppStk={creatingOppStk} setCreatingOppStk={setCreatingOppStk}
              upcomingEventsText={upcomingEventsText}
              openNewOpp={openNewOpp} openEditOpp={openEditOpp} deleteOpp={deleteOpp}
              api={api} onLogActivity={onLogActivity} stakeholders={stakeholders}
            />
          )}

          {/* ══ PROPOSALS TAB ══ */}
          {accDetailTab === 'proposals' && (() => {
            const accProposals = (data.proposals || []).filter(p => linkedIds(p,'Account').includes(account.id))
              .sort((a,b) => new Date(b.fields?.['Created']||0) - new Date(a.fields?.['Created']||0));
            const STATUS_COLOR = { Draft:'#9ca3af', Presented:'#60a5fa', 'Under Review':'#fb923c', Accepted:'#4ade80', Rejected:'#f87171', Expired:'#6b7280' };
            const STATUS_BG    = { Draft:'rgba(156,163,175,0.15)', Presented:'rgba(96,165,250,0.15)', 'Under Review':'rgba(251,146,60,0.15)', Accepted:'rgba(74,222,128,0.15)', Rejected:'rgba(248,113,113,0.15)', Expired:'rgba(107,114,128,0.15)' };
            const accStakeholderIdSet = new Set(accStakeholders.map(s => s.id));
            const accLandings = landings.filter(l => linkedIds(l,'Stakeholder').some(stkId => accStakeholderIdSet.has(stkId)))
              .sort((a,b) => new Date(b.createdTime||0) - new Date(a.createdTime||0));
            const LANDING_STATUS_COLOR = { Draft:'#a78bfa', Sent:'#4ade80', Archived:'#6b7280' };
            const LANDING_STATUS_BG    = { Draft:'rgba(167,139,250,0.15)', Sent:'rgba(74,222,128,0.15)', Archived:'rgba(107,114,128,0.15)' };
            return (
              <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
                {/* Proposals section */}
                <div className="card">
                  <div className="card-header" style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <h3>📋 Proposals ({accProposals.length})</h3>
                    <button className="action-btn btn-primary" style={{ fontSize:11, padding:'4px 12px' }}
                      onClick={() => {
                        try {
                          sessionStorage.setItem('oike_proposal_prefill_account', account.id);
                          sessionStorage.setItem('oike_return_to_account', JSON.stringify({ accountId: account.id, tab: 'proposals' }));
                        } catch {}
                        goToProposal && goToProposal();
                      }}>
                      + New Proposal
                    </button>
                  </div>
                  {accProposals.length === 0 ? (
                    <p style={{ color:'var(--globant-muted)', fontSize:12 }}>No proposals for this account yet.</p>
                  ) : (
                    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                      {accProposals.map(p => {
                        const status = F(p,'Status') || 'Draft';
                        const solNames = linkedIds(p,'Solutions').map(id => { const s = (data.solutions||[]).find(x=>x.id===id); return s ? F(s,'Name') : null; }).filter(Boolean);
                        const amount = p.fields?.['Amount'];
                        const docs = p.fields?.['Document'];
                        return (
                          <div key={p.id} style={{ padding:'12px 14px', borderRadius:8, background:'rgba(255,255,255,0.03)', border:'1px solid var(--globant-border)', cursor:'pointer' }}
                            onClick={() => setViewingProposal(p)}>
                            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:4 }}>
                              <div style={{ fontWeight:700, fontSize:13 }}>{F(p,'Title')}</div>
                              <div style={{ display:'flex', gap:8, alignItems:'center', flexShrink:0 }}>
                                {amount && <span style={{ fontWeight:700, color:'var(--globant-green)', fontSize:12 }}>{formatCurrency(amount)}</span>}
                                <span style={{ background:STATUS_BG[status], color:STATUS_COLOR[status], borderRadius:5, padding:'2px 8px', fontSize:10, fontWeight:700 }}>{status}</span>
                              </div>
                            </div>
                            <div style={{ display:'flex', gap:12, fontSize:11, color:'var(--globant-muted)' }}>
                              {solNames.length > 0 && <span>🛠️ {solNames.join(', ')}</span>}
                              {F(p,'Presented Date') && <span>📅 {formatDate(F(p,'Presented Date'))}</span>}
                              {docs && Array.isArray(docs) && docs.length > 0 && <span>📎 {docs.length} doc{docs.length > 1 ? 's' : ''}</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                {/* Landings section */}
                <div className="card">
                  <div className="card-header" style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <h3>📨 Landings ({accLandings.length})</h3>
                    <button className="action-btn btn-primary" style={{ fontSize:11, padding:'4px 12px' }}
                      onClick={() => {
                        try {
                          sessionStorage.setItem('oike_landing_prefill_account', account.id);
                          sessionStorage.setItem('oike_return_to_account', JSON.stringify({ accountId: account.id, tab: 'proposals' }));
                        } catch {}
                        window.dispatchEvent(new CustomEvent('oike:navigate', { detail: { page: 'landings' } }));
                      }}>
                      + New Landing
                    </button>
                  </div>
                  {accLandings.length === 0 ? (
                    <p style={{ color:'var(--globant-muted)', fontSize:12 }}>No landings for this account yet.</p>
                  ) : (
                    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                      {accLandings.map(l => {
                        const lStatus = F(l,'Status') || 'Draft';
                        const stkId = linkedIds(l,'Stakeholder')[0];
                        const stk = stkId ? stakeholders.find(s => s.id === stkId) : null;
                        const stkName = stk ? `${F(stk,'Name')||''} ${F(stk,'Last name')||''}`.trim() : '—';
                        return (
                          <div key={l.id} style={{ padding:'12px 14px', borderRadius:8, background:'rgba(255,255,255,0.03)', border:'1px solid var(--globant-border)', cursor:'pointer' }}
                            onClick={() => setViewingLanding(l)}>
                            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:4 }}>
                              <div style={{ fontWeight:700, fontSize:13 }}>{F(l,'Slug') || l.id}</div>
                              <span style={{ background:LANDING_STATUS_BG[lStatus]||'rgba(156,163,175,0.15)', color:LANDING_STATUS_COLOR[lStatus]||'#9ca3af', borderRadius:5, padding:'2px 8px', fontSize:10, fontWeight:700 }}>{lStatus}</span>
                            </div>
                            <div style={{ fontSize:11, color:'var(--globant-muted)' }}>👤 {stkName}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* ══════════ STRATEGY TAB ══════════ */}
          {/* ══════════ STRATEGY TAB ══════════ */}
          {accDetailTab === 'strategy' && (
            <AccountStrategyTab
              account={account} accStakeholders={accStakeholders}
              allSolutions={allSolutions} solutions={solutions} currentSolIds={currentSolIds}
              healthScore={healthScore} momentum={momentum} nbaLoading={nbaLoading} nbaText={nbaText}
              intelNotes={intelNotes} recentNews={recentNews} radarData={radarData}
              offeringRec={offeringRec} offeringRecLoading={offeringRecLoading}
              offeringRecCache={offeringRecCache} generateOfferingRec={generateOfferingRec} setOfferingRec={setOfferingRec}
              showSolPicker={showSolPicker} setShowSolPicker={setShowSolPicker}
              availableSolutions={availableSolutions}
              addSolutionToAccount={addSolutionToAccount} removeSolutionFromAccount={removeSolutionFromAccount} removingSol={removingSol}
              newSolName={newSolName} setNewSolName={setNewSolName} creatingSol={creatingSol} createNewSolution={createNewSolution}
              strategyData={strategyData} setStrategyData={setStrategyData}
              newMilestone={newMilestone} setNewMilestone={setNewMilestone}
              savingStrategy={savingStrategy} setSavingStrategy={setSavingStrategy}
              setAccDetailTab={setAccDetailTab}
              api={api} onUpdateRecord={onUpdateRecord}
            />
          )}

          {/* ══════════ PERFORMANCE TAB ══════════ */}
          {accDetailTab === 'strategy' && (() => {
            // Funnel
            const sent = accOutreach.length;
            const replied = accOutreach.filter(o => F(o,'Status')==='Replied' || F(o,'Direction')==='Inbound' || F(o,'Reply')==='Yes').length;
            const meetings = accOutreach.filter(o => F(o,'Channel')==='Meeting' || F(o,'Status')==='Meeting Booked' || F(o,'Status')==='Meeting Scheduled').length;
            const proposalCount = (data.proposals||[]).filter(p => linkedIds(p,'Account').includes(account.id)).length;

            // Velocity
            const sortedOutreach = [...accOutreach].filter(o => o.fields?.['Date']).sort((a,b) => new Date(a.fields['Date']) - new Date(b.fields['Date']));
            let velocity = null;
            if (sortedOutreach.length > 1) {
              const gaps = [];
              for (let i = 1; i < sortedOutreach.length; i++) {
                const gap = (new Date(sortedOutreach[i].fields['Date']) - new Date(sortedOutreach[i-1].fields['Date'])) / (1000*60*60*24);
                if (gap >= 0) gaps.push(gap);
              }
              if (gaps.length) velocity = Math.round(gaps.reduce((a,b)=>a+b,0)/gaps.length);
            }

            // Sparkline — last 8 weeks
            const getISOWeek = d => { const dd = new Date(d); dd.setHours(0,0,0,0); dd.setDate(dd.getDate()+4-(dd.getDay()||7)); const yearStart = new Date(dd.getFullYear(),0,1); return Math.ceil(((dd-yearStart)/86400000+1)/7); };
            const weekBuckets = {};
            accOutreach.forEach(o => { if (!o.fields?.['Date']) return; const d = new Date(o.fields['Date']); const wk = `${d.getFullYear()}-W${String(getISOWeek(d)).padStart(2,'0')}`; weekBuckets[wk] = (weekBuckets[wk]||0)+1; });
            const recentWeeks = [];
            for (let i = 7; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i*7); const wk = `${d.getFullYear()}-W${String(getISOWeek(d)).padStart(2,'0')}`; recentWeeks.push({ wk, count: weekBuckets[wk]||0 }); }
            const maxCount = Math.max(...recentWeeks.map(w=>w.count), 1);
            const svgW = 200, svgH = 40, padX = 6, padY = 4;
            const pts = recentWeeks.map((w,i) => { const x = padX + (i/(recentWeeks.length-1))*(svgW-2*padX); const y = svgH - padY - (w.count/maxCount)*(svgH-2*padY); return `${x},${y}`; });
            const sparklinePath = pts.length > 1 ? `M ${pts.join(' L ')}` : '';

            // Benchmark
            const allOut = data.outreach || [];
            const allReplied = allOut.filter(o => F(o,'Status')==='Replied' || F(o,'Direction')==='Inbound' || F(o,'Reply')==='Yes').length;
            const allReplyRate = allOut.length ? ((allReplied/allOut.length)*100).toFixed(1) : 0;
            const accReplyRate = sent ? ((replied/sent)*100).toFixed(1) : 0;

            return (
              <>
                {/* Funnel */}
                <div className="card">
                  <div className="card-header"><h3>🔽 Outreach Funnel</h3></div>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
                    {[['Sent', sent, '#5bbfb5'], ['Replied', replied, '#34d399'], ['Meetings', meetings, '#fbbf24'], ['Proposals', proposalCount, '#a78bfa']].map(([label, val, color]) => (
                      <div key={label} style={{ flex: 1, minWidth: 80, padding: '12px 14px', borderRadius: 9, background: `${color}14`, border: `1px solid ${color}44`, textAlign: 'center' }}>
                        <div style={{ fontSize: 24, fontWeight: 800, color }}>{val}</div>
                        <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 2 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Velocity + Sparkline */}
                <div className="card">
                  <div className="card-header"><h3>📈 Activity Trend (Last 8 Weeks)</h3></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 8 }}>
                    <div style={{ flex: 1 }}>
                      {sparklinePath ? (
                        <svg width="100%" viewBox={`0 0 ${svgW} ${svgH}`} style={{ display: 'block' }}>
                          <path d={sparklinePath} fill="none" stroke="#5bbfb5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          {pts.map((pt, i) => { const [x,y] = pt.split(','); return <circle key={i} cx={x} cy={y} r="2.5" fill="#5bbfb5" />; })}
                        </svg>
                      ) : <p style={{ fontSize: 12, color: 'var(--globant-muted)' }}>No outreach data.</p>}
                    </div>
                    {velocity !== null && (
                      <div style={{ textAlign: 'center', flexShrink: 0 }}>
                        <div style={{ fontSize: 22, fontWeight: 800, color: '#5bbfb5' }}>{velocity}d</div>
                        <div style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Avg. between touches</div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Benchmark */}
                <div className="card">
                  <div className="card-header"><h3>📊 Reply Rate Benchmark</h3></div>
                  <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                    <div style={{ flex: 1, padding: '12px 14px', borderRadius: 9, background: 'rgba(91,191,181,0.1)', border: '1px solid rgba(91,191,181,0.3)', textAlign: 'center' }}>
                      <div style={{ fontSize: 24, fontWeight: 800, color: '#5bbfb5' }}>{accReplyRate}%</div>
                      <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 2 }}>This Account</div>
                    </div>
                    <div style={{ flex: 1, padding: '12px 14px', borderRadius: 9, background: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.2)', textAlign: 'center' }}>
                      <div style={{ fontSize: 24, fontWeight: 800, color: '#94a3b8' }}>{allReplyRate}%</div>
                      <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 2 }}>All Accounts Avg</div>
                    </div>
                  </div>
                  {parseFloat(accReplyRate) > parseFloat(allReplyRate) ? (
                    <p style={{ fontSize: 12, color: '#34d399', marginTop: 8 }}>✅ Above average — this account is more engaged than peers.</p>
                  ) : sent > 0 ? (
                    <p style={{ fontSize: 12, color: '#fbbf24', marginTop: 8 }}>⚠️ Below average — consider changing approach or channel.</p>
                  ) : null}
                </div>
              </>
            );
          })()}

          {/* ══════════ INTAKE TAB ══════════ */}
          {accDetailTab === 'intake' && (
            <AccountIntakeTab
              account={account}
              intakeRecord={intakeRecord}
              intakeLoading={intakeLoading}
              generatingIntake={generatingIntake}
              loadIntakeRecord={loadIntakeRecord}
              generateIntakeLink={generateIntakeLink}
            />
          )}

        </div>
      )}

      {/* Proposal Viewer Modal */}
      {viewingProposal && (() => {
        const vp = viewingProposal;
        const vpStatus = F(vp,'Status') || 'Draft';
        const vpAmount = vp.fields?.['Amount'];
        const vpAccount = (data.accounts||[]).find(a => linkedIds(vp,'Account').includes(a.id));
        const vpStks = linkedIds(vp,'Stakeholders').map(id => stakeholders.find(s=>s.id===id)).filter(Boolean);
        const vpSols = linkedIds(vp,'Solutions').map(id => (data.solutions||[]).find(s=>s.id===id)).filter(Boolean);
        const vpDoc = F(vp,'Document');
        const STATUS_COLOR = { Draft:'#9ca3af', Presented:'#60a5fa', 'Under Review':'#fb923c', Accepted:'#4ade80', Rejected:'#f87171', Expired:'#6b7280' };
        const STATUS_BG = { Draft:'rgba(156,163,175,0.15)', Presented:'rgba(96,165,250,0.15)', 'Under Review':'rgba(251,146,60,0.15)', Accepted:'rgba(74,222,128,0.15)', Rejected:'rgba(248,113,113,0.15)', Expired:'rgba(107,114,128,0.15)' };
        return (
          <div className="modal-overlay" onClick={() => setViewingProposal(null)} style={{ zIndex:1100 }}>
            <div className="modal" style={{ maxWidth:540, width:'90%' }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2 style={{ margin:0, fontSize:17 }}>📋 {F(vp,'Title')}</h2>
                <button className="btn-icon" onClick={() => setViewingProposal(null)}>✕</button>
              </div>
              <div style={{ padding:'0 20px 20px', display:'flex', flexDirection:'column', gap:14 }}>
                {/* Status + meta */}
                <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
                  <span style={{ background:STATUS_BG[vpStatus], color:STATUS_COLOR[vpStatus], borderRadius:5, padding:'3px 10px', fontSize:11, fontWeight:700 }}>{vpStatus}</span>
                  {vpAmount && <span style={{ fontWeight:700, color:'var(--globant-green)', fontSize:14 }}>{formatCurrency(vpAmount)}</span>}
                  {F(vp,'Presented Date') && <span style={{ fontSize:11, color:'var(--globant-muted)' }}>📅 {formatDate(F(vp,'Presented Date'))}</span>}
                </div>
                {/* Stakeholders */}
                {vpStks.length > 0 && (
                  <div>
                    <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:6 }}>Stakeholders</div>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                      {vpStks.map(s => <span key={s.id} style={{ background:'rgba(91,191,181,0.12)', color:'var(--globant-green)', borderRadius:5, padding:'3px 10px', fontSize:12 }}>{F(s,'Name')} {F(s,'Last name')||''}</span>)}
                    </div>
                  </div>
                )}
                {/* Solutions */}
                {vpSols.length > 0 && (
                  <div>
                    <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:6 }}>Offerings</div>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                      {vpSols.map(s => <span key={s.id} style={{ background:'rgba(255,255,255,0.06)', color:'var(--globant-text)', borderRadius:5, padding:'3px 10px', fontSize:12 }}>🛠️ {F(s,'Name')}</span>)}
                    </div>
                  </div>
                )}
                {/* Description */}
                {F(vp,'Description') && (
                  <div>
                    <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:6 }}>Description</div>
                    <div style={{ fontSize:13, color:'var(--globant-text)', lineHeight:1.6, whiteSpace:'pre-wrap', background:'rgba(255,255,255,0.03)', borderRadius:8, padding:'10px 12px' }}>{F(vp,'Description')}</div>
                  </div>
                )}
                {/* Document */}
                {vpDoc && (
                  <div>
                    <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:6 }}>Document</div>
                    <a href={vpDoc} target="_blank" rel="noopener noreferrer" style={{ color:'var(--globant-green)', fontSize:13, wordBreak:'break-all' }}>📎 {vpDoc}</a>
                  </div>
                )}
                {/* Actions */}
                <div style={{ display:'flex', gap:8, justifyContent:'flex-end', paddingTop:4 }}>
                  <button className="action-btn btn-ghost" onClick={() => setViewingProposal(null)}>Close</button>
                  <button className="action-btn btn-primary" style={{ fontSize:12 }} onClick={() => { setViewingProposal(null); goToProposal && goToProposal(vp.id); }}>Open Full View →</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Landing Viewer Modal */}
      {viewingLanding && (() => {
        const vl = viewingLanding;
        const vlStatus = F(vl,'Status') || 'Draft';
        const vlSlug = F(vl,'Slug') || vl.id;
        const vlStkId = linkedIds(vl,'Stakeholder')[0];
        const vlStk = vlStkId ? stakeholders.find(s=>s.id===vlStkId) : null;
        const vlStkName = vlStk ? `${F(vlStk,'Name')||''} ${F(vlStk,'Last name')||''}`.trim() : '—';
        const vlSolId = linkedIds(vl,'Solution')[0];
        const vlSol = vlSolId ? (data.solutions||[]).find(s=>s.id===vlSolId) : null;
        const LANDING_STATUS_COLOR = { Draft:'#a78bfa', Sent:'#4ade80', Archived:'#6b7280' };
        const LANDING_STATUS_BG = { Draft:'rgba(167,139,250,0.15)', Sent:'rgba(74,222,128,0.15)', Archived:'rgba(107,114,128,0.15)' };
        const previewUrl = `${window.location.origin}/p/${vlSlug}`;
        return (
          <div className="modal-overlay" onClick={() => setViewingLanding(null)} style={{ zIndex:1100 }}>
            <div className="modal" style={{ maxWidth:480, width:'90%' }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2 style={{ margin:0, fontSize:17 }}>📨 Landing: {vlSlug}</h2>
                <button className="btn-icon" onClick={() => setViewingLanding(null)}>✕</button>
              </div>
              <div style={{ padding:'0 20px 20px', display:'flex', flexDirection:'column', gap:14 }}>
                <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
                  <span style={{ background:LANDING_STATUS_BG[vlStatus]||'rgba(156,163,175,0.15)', color:LANDING_STATUS_COLOR[vlStatus]||'#9ca3af', borderRadius:5, padding:'3px 10px', fontSize:11, fontWeight:700 }}>{vlStatus}</span>
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                    <span style={{ fontSize:12, color:'var(--globant-muted)', minWidth:80 }}>Stakeholder</span>
                    <span style={{ fontSize:13, color:'var(--globant-text)', fontWeight:600 }}>👤 {vlStkName}</span>
                  </div>
                  {vlSol && (
                    <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                      <span style={{ fontSize:12, color:'var(--globant-muted)', minWidth:80 }}>Offering</span>
                      <span style={{ fontSize:13, color:'var(--globant-text)' }}>🛠️ {F(vlSol,'Name')}</span>
                    </div>
                  )}
                  <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                    <span style={{ fontSize:12, color:'var(--globant-muted)', minWidth:80 }}>Preview URL</span>
                    <a href={previewUrl} target="_blank" rel="noopener noreferrer" style={{ color:'var(--globant-green)', fontSize:12, wordBreak:'break-all' }}>{previewUrl}</a>
                  </div>
                </div>
                <div style={{ display:'flex', gap:8, justifyContent:'flex-end', paddingTop:4 }}>
                  <button className="action-btn btn-ghost" onClick={() => setViewingLanding(null)}>Close</button>
                  <button className="action-btn btn-primary" style={{ fontSize:12 }} onClick={() => {
                    setViewingLanding(null);
                    try {
                      sessionStorage.setItem('oike_return_to_account', JSON.stringify({ accountId: selectedAccountId, tab: 'proposals' }));
                      const stkId = vlStkId;
                      if (stkId) sessionStorage.setItem('oike_landing_prefill_stakeholder', stkId);
                    } catch {}
                    window.dispatchEvent(new CustomEvent('oike:navigate', { detail: { page: 'landings', landingId: vl.id } }));
                  }}>Edit Landing →</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Edit Contact Modal (from Account view) */}
      {cpEditingContact && (() => {
        // Resolve current Campaign: field holds array of IDs in Airtable
        const currentCampaignId = (cpEditingContact.fields?.['Campaign'] || [])[0] || '';
        const campaignOptions = [{ value: '', label: 'No campaign' },
          ...campaigns.sort((a,b) => (F(a,'Name')||'').localeCompare(F(b,'Name')||'')).map(c => ({ value: c.id, label: `${F(c,'Name')}${F(c,'Status') ? ` (${F(c,'Status')})` : ''}` }))
        ];
        const editInitial = { ...(cpEditingContact.fields || {}), Campaign: currentCampaignId };
        return (
          <EditModal
            title={`${F(cpEditingContact, 'Name')} ${F(cpEditingContact, 'Last name') || ''}`.trim()}
            fields={[
              { key: 'Name', label: 'First Name' },
              { key: 'Last name', label: 'Last Name' },
              { key: 'Role', label: 'Role / Title' },
              { key: 'Email', label: 'Email' },
              { key: 'Phone number', label: 'Phone' },
              { key: 'LinkedIn', label: 'LinkedIn URL' },
              { key: 'Level of Influence', label: 'Influence', type: 'select', options: ['Decision Maker', 'High', 'Influencer', 'Champion', 'Medium', 'Low'] },
              { key: 'Source', label: 'Source', type: 'select', options: SOURCE_OPTIONS },
              { key: 'Campaign', label: 'Campaign', type: 'select', options: campaignOptions },
            ]}
            initialValues={editInitial}
            onSave={saveCpContactEdit}
            onClose={() => setCpEditingContact(null)}
          />
        );
      })()}

      {/* AI Message Modal */}
      {cpSelectedStakeholder && (
        <AIMessageModal
          stakeholder={cpSelectedStakeholder}
          onClose={() => setCpSelectedStakeholder(null)}
          onSend={cpUseMessage}
          onSuccess={() => { setCpSelectedStakeholder(null); if (onLogActivity) onLogActivity(); }}
          data={data}
        />
      )}

      {/* Meeting Modal */}
      {cpMeetingModal && (() => {
        const ms = cpMeetingModal.stakeholder;
        const msName = F(ms, 'Name') + (F(ms, 'Last name') ? ` ${F(ms, 'Last name')}` : '');
        const msRole = F(ms, 'Role') || '';
        const msEmail = F(ms, 'Email') || '';
        const msAccNames = resolveLinked(ms, 'Account', accounts, 'Account Name');
        const buildCalendarUrl = () => {
          const startDt = new Date(`${cpMeetingDate}T${cpMeetingTime || '10:00'}`);
          const endDt = new Date(startDt.getTime() + 60 * 60 * 1000);
          const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
          const title = `${COMPANY_PROFILE.companyName} x ${msAccNames[0] || 'Account'} — ${msName}`;
          const details = `Meeting with ${msName} (${msRole}) at ${msAccNames.join(', ')}\n\n${cpMeetingNotes || 'Intro call'}`;
          return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${fmt(startDt)}/${fmt(endDt)}&details=${encodeURIComponent(details)}${msEmail ? `&add=${encodeURIComponent(msEmail)}` : ''}`;
        };
        return (
          <div className="modal-overlay" onClick={() => setCpMeetingModal(null)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <h3>📅 Schedule Meeting</h3>
              <div style={{ fontSize: 13, color: 'var(--globant-muted)', marginBottom: 4 }}>{msName} · {msRole}</div>
              <div style={{ fontSize: 12, color: 'var(--globant-accent)', marginBottom: 14 }}>{msAccNames.join(', ')}</div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>DATE</label>
                  <input type="date" className="input-field" style={{ width: '100%' }} value={cpMeetingDate} onChange={e => setCpMeetingDate(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>TIME</label>
                  <input type="time" className="input-field" style={{ width: '100%' }} value={cpMeetingTime} onChange={e => setCpMeetingTime(e.target.value)} />
                </div>
              </div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>NOTES / AGENDA</label>
              <textarea className="input-field" style={{ width: '100%', minHeight: 70, resize: 'vertical', marginBottom: 14, fontFamily: 'inherit', fontSize: 12 }}
                placeholder="Meeting topic, agenda..." value={cpMeetingNotes} onChange={e => setCpMeetingNotes(e.target.value)} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="action-btn btn-ghost" style={{ flex: 1 }} onClick={() => setCpMeetingModal(null)}>Cancel</button>
                {cpMeetingDate && (
                  <button className="action-btn" style={{ flex: 1, background: 'rgba(66,133,244,0.15)', color: '#4285f4', border: '1px solid rgba(66,133,244,0.3)' }}
                    onClick={() => window.open(buildCalendarUrl(), '_blank')}>📆 Open in Calendar</button>
                )}
                <button className="action-btn" style={{ flex: 1, background: 'rgba(96,165,250,0.2)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.4)' }}
                  onClick={async () => { await cpLogMeeting(ms, cpMeetingNotes, cpMeetingDate); setCpMeetingModal(null); }}>
                  ✅ Log Meeting
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Log Call Modal */}
      {cpCallModal && (
        <div className="modal-overlay" onClick={() => setCpCallModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <h3>📞 Log Call</h3>
            <div style={{ fontSize: 13, color: 'var(--globant-muted)', marginBottom: 12 }}>
              {F(cpCallModal, 'Name')}{F(cpCallModal, 'Last name') ? ` ${F(cpCallModal, 'Last name')}` : ''} · {F(cpCallModal, 'Role')}
            </div>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>CALL NOTES</label>
            <textarea className="input-field" style={{ width: '100%', minHeight: 90, resize: 'vertical', marginBottom: 14, fontFamily: 'inherit', fontSize: 12 }}
              placeholder="What was discussed? Key takeaways, next steps..." value={cpCallNotes} onChange={e => setCpCallNotes(e.target.value)} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="action-btn btn-ghost" style={{ flex: 1 }} onClick={() => setCpCallModal(null)}>Cancel</button>
              {F(cpCallModal, 'Phone number') && (
                <button className="action-btn" style={{ flex: 1, background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }}
                  onClick={() => window.open(`tel:${F(cpCallModal, 'Phone number')}`, '_self')}>📱 Dial</button>
              )}
              <button className="action-btn" style={{ flex: 1, background: 'rgba(96,165,250,0.2)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.4)' }}
                onClick={async () => { await cpLogCall(cpCallModal, cpCallNotes); setCpCallModal(null); }}>
                ✅ Log Call
              </button>
            </div>
          </div>
        </div>
      )}

      {historyStakeholder && (
        <StakeholderHistoryModal
          stakeholder={historyStakeholder}
          outreach={outreach}
          accounts={accounts}
          onClose={() => setHistoryStakeholder(null)}
          onRefresh={onLogActivity}
          onAddRecord={onAddRecord}
          allData={data}
          onNavigateToAccount={goToAccount}
          onSend={cpUseMessage}
        />
      )}

      {editingAccount && (
        <EditModal
          title={`Edit: ${F(editingAccount, 'Account Name') || 'Account'}`}
          fields={[
            { key: 'Account Name', label: 'Account Name' },
            { key: 'Website', label: 'Website' },
            { key: 'Industry', label: 'Industry' },
            { key: 'Country', label: 'Country' },
            { key: 'Inside Sales Status', label: 'Inside Sales Status', type: 'select', options: ['Prospect', 'Active Outreach', 'Meeting Booked', 'Qualified', 'Proposal Sent', 'Negotiation', 'Won', 'Lost', 'On Hold', 'Dormant'] },
            { key: 'Company Description', label: 'Company Description', type: 'textarea', fullWidth: true },
          ]}
          initialValues={editingAccount.fields || {}}
          onSave={saveAccountEdit}
          onClose={() => setEditingAccount(null)}
        />
      )}
    </div>
  );
}

// ============ INSIGHTS & CONCLUSIONS ============

export default CPBriefings;
