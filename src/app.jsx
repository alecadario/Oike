/* global React, ReactDOM */
const { useState, useEffect, useCallback, useMemo, useRef } = React;

import {
  AirtableAPI, TABLE_IDS, CURRENT_USER, COMPANY_PROFILE,
  callOpenAI, navSetUrl, SOURCE_OPTIONS, OPP_STAGES, WON_STAGES, CLOSED_STAGES,
  BENCH_REPLY_HIGH, BENCH_REPLY_LOW, BENCH_MEETING_HIGH, BENCH_MEETING_LOW,
  CHANNEL_BENCHMARKS, MESSAGE_PROMPTS, MESSAGE_PROMPT_DEFAULTS, saveMessagePrompts,
  resolvePromptTemplate, saveCompanyProfile, channelIcon, logoutUser,
  CLIENT_CONFIG, AUTH_TOKEN, loadBranding, BRANDING_LS_KEY, ONBOARDING_KEY,
  AUTH_TOKEN as _AT, CURRENT_USER as _CU, loadClientConfig,
} from './globals.js';
import {
  F, linkedIds, resolveLinked, InfoTip, REPLY_STATUSES, computeEnrichment,
  DIAGNOSIS_CONFIG, findDuplicateStakeholder, confirmDuplicateStakeholder,
  deriveStakeholderStatus, updateStakeholderStatus, STAKEHOLDER_STATUS_PRIORITY,
  STAKEHOLDER_STATUS_PROTECTED, activateAccountIfNeeded,
  formatCurrency, formatDate, strSimilarity, FileNotesRenderer,
} from './utils.js';

import StakeholderHistoryModal from './components/StakeholderHistoryModal.jsx';
import ConfigScreen from './components/ConfigScreen.jsx';
import StrategyOverview from './components/StrategyOverview.jsx';
import AIMessageModal from './components/AIMessageModal.jsx';
import FollowupCenter from './components/FollowupCenter.jsx';
import EmailComposeModal from './components/EmailComposeModal.jsx';
import GlobalSearchModal from './components/GlobalSearchModal.jsx';
import ShortcutsModal from './components/ShortcutsModal.jsx';
import FeedbackModal from './components/FeedbackModal.jsx';
import EditModal from './components/EditModal.jsx';
import ContactsSection from './components/ContactsSection.jsx';
import ActivityTracker from './components/ActivityTracker.jsx';
import CPBriefings from './components/CPBriefings.jsx';
import InsightsView from './components/InsightsView.jsx';
import EventsHub from './components/EventsHub.jsx';
import ICPSection from './components/ICPSection.jsx';
import SolutionsHub from './components/SolutionsHub.jsx';
import ProposalsHub from './components/ProposalsHub.jsx';
import CampaignsHub from './components/CampaignsHub.jsx';
import MessageLab from './components/MessageLab.jsx';
import ContentLab from './components/ContentLab.jsx';
import LandingsHub from './components/LandingsHub.jsx';
import ReportBuilder from './components/ReportBuilder.jsx';
import ActivateScreen from './components/ActivateScreen.jsx';
import LoginScreen from './components/LoginScreen.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import OnboardingWizard from './components/OnboardingWizard.jsx';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(!!AUTH_TOKEN && !!CURRENT_USER);

  const [ready, setReady] = useState(false);
  const _isBDR = CURRENT_USER?.role === 'bdr';
  const BDR_PAGES = new Set(['followup','accounts','contacts','campaigns','proposals']);
  const [page, setPage] = useState(() => {
    const urlV = new URLSearchParams(window.location.search).get('v');
    const saved = urlV || localStorage.getItem('oike_page') || 'overview';
    if (_isBDR && !BDR_PAGES.has(saved)) return 'followup';
    return saved;
  });
  const setPageAndSave = useCallback((p) => {
    setPage(p);
    localStorage.setItem('oike_page', p);
    navSetUrl(p, null); // clear ?id when switching pages
  }, []);

  // Listen to global navigation events (e.g. from StakeholderHistoryModal → "Generate Landing")
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.page) {
        setPageAndSave(e.detail.page);
        if (e.detail.accountId) setNavigateToAccountId(e.detail.accountId);
        if (e.detail.tab) setNavigateToAccountTab(e.detail.tab);
      }
    };
    window.addEventListener('oike:navigate', handler);
    return () => window.removeEventListener('oike:navigate', handler);
  }, [setPageAndSave]);

  // Handle browser back/forward button
  useEffect(() => {
    const onPopState = (e) => {
      const params = new URLSearchParams(window.location.search);
      const p = e.state?.page || params.get('v') || localStorage.getItem('oike_page') || 'overview';
      setPage(p);
      localStorage.setItem('oike_page', p);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const [data, setData] = useState({ accounts: [], stakeholders: [], opportunities: [], actionPlan: [], outreach: [], solutions: [], events: [], clientPartners: [], sources: [], icp: [], proposals: [], campaigns: [], contentLab: [], landings: [] });
  const [loading, setLoading] = useState(true);
  const [api, setApi] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [gmailReturnStatus, setGmailReturnStatus] = useState(''); // 'connected' | 'error' | 'denied'
  const [configError, setConfigError] = useState('');
  const [navigateToAccountId, setNavigateToAccountId] = useState('');
  const [navigateToSolId, setNavigateToSolId] = useState('');
  const [navigateToEventId, setNavigateToEventId] = useState('');
  const [navigateToProposalId, setNavigateToProposalId] = useState('');
  const [navigateToAccountTab, setNavigateToAccountTab] = useState('');
  // Campaign prefill from Report Builder → Campaigns (Create campaign from insight)
  const [campaignPrefill, setCampaignPrefill] = useState(null); // { name, type, context, stakeholderIds }
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // ── Toast system ──
  const [toasts, setToasts] = React.useState([]);
  const showToast = React.useCallback((msg, type = 'info', duration = 3500) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
  }, []);
  // Expose globally so nested components can call it
  React.useEffect(() => { window.__oikeToast = showToast; }, [showToast]);

  // ── Global search ──
  const [showGlobalSearch, setShowGlobalSearch] = React.useState(false);

  // ── Shortcuts panel ──
  const [showShortcuts, setShowShortcuts] = React.useState(false);

  // ── Feedback modal ──
  const [showFeedback, setShowFeedback] = React.useState(false);

  // Keyboard shortcuts: Cmd+K and ?
  React.useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setShowGlobalSearch(v => !v); }
      if (e.key === '?' && !e.target.matches('input,textarea')) setShowShortcuts(v => !v);
      if (e.key === 'Escape') { setShowGlobalSearch(false); setShowShortcuts(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const goToAccount = useCallback((accountId) => {
    setNavigateToAccountId(accountId);
    setPageAndSave('accounts');
  }, [setPageAndSave]);

  const goToSolution = useCallback((solId) => {
    setNavigateToSolId(solId);
    setPageAndSave('solutionshub');
  }, [setPageAndSave]);

  const goToProposal = useCallback((proposalId) => {
    if (proposalId) setNavigateToProposalId(proposalId);
    setPageAndSave('proposals');
  }, [setPageAndSave]);

  const createCampaignFromInsight = useCallback((prefill) => {
    setCampaignPrefill(prefill);
    setPageAndSave('campaigns');
  }, [setPageAndSave]);

  // Optimistic update: add a record to local state instantly (before API response)
  // Pass realId when the Airtable ID is already known (e.g. after createRecord returns)
  const addToData = useCallback((tableKey, fields, realId = null) => {
    const recordId = realId || ('tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
    setData(prev => ({
      ...prev,
      [tableKey]: [...(prev[tableKey] || []), { id: recordId, fields }]
    }));
  }, []);

  // Optimistic update: edit a record in local state instantly
  const updateInData = useCallback((tableKey, recordId, updatedFields) => {
    setData(prev => ({
      ...prev,
      [tableKey]: (prev[tableKey] || []).map(r =>
        r.id === recordId ? { ...r, fields: { ...r.fields, ...updatedFields } } : r
      )
    }));
  }, []);

  const removeFromData = useCallback((tableKey, recordId) => {
    setData(prev => ({
      ...prev,
      [tableKey]: (prev[tableKey] || []).filter(r => r.id !== recordId)
    }));
  }, []);

  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async (apiInstance, silent = false) => {
    if (!silent) setLoading(true);
    if (silent) setRefreshing(true);
    try {
      const keys = ['accounts','stakeholders','opportunities','actionPlan','outreach','solutions','events','clientPartners','sources','icp','users','strategy','proposals','campaigns','contentLab','landings'];
      const ids = [TABLE_IDS.accounts, TABLE_IDS.stakeholders, TABLE_IDS.opportunities, TABLE_IDS.actionPlan, TABLE_IDS.outreach, TABLE_IDS.solutions, TABLE_IDS.events, TABLE_IDS.clientPartners, TABLE_IDS.sources, TABLE_IDS.icp, TABLE_IDS.users, TABLE_IDS.strategy, TABLE_IDS.proposals, TABLE_IDS.campaigns, TABLE_IDS.contentLab, TABLE_IDS.landings];
      // Load all tables in parallel — ~0.5s instead of ~4s
      const fetched = await Promise.all(keys.map((k, i) => apiInstance.fetchTable(ids[i]).catch(() => [])));
      const results = {};
      keys.forEach((k, i) => { results[k] = fetched[i]; });
      // Filter out placeholder opportunities named "None"
      results.opportunities = (results.opportunities || []).filter(o => {
        const name = F(o, 'Name') || F(o, 'Opportunity') || '';
        return name.toLowerCase() !== 'none';
      });

      // ── Role-based filtering ──
      const userRole = CURRENT_USER?.role || 'viewer';
      const userEmail = CURRENT_USER?.email || '';

      if (userRole === 'bdr') {
        const allAccounts = results.accounts || [];
        const userName = (CURRENT_USER?.name || '').toLowerCase().trim();

        // assignedAccountIds comes from the login response (read from client users table at auth time)
        const assignedFromLogin = new Set(CURRENT_USER?.assignedAccountIds || []);

        // Fallback: find user record in results.users by clientRecordId or name
        const clientRecordId = CURRENT_USER?.clientRecordId || '';
        const usersRecords = results.users || [];
        const myUserRecord = usersRecords.find(r =>
          (clientRecordId && r.id === clientRecordId) ||
          (userName && (F(r, 'Name') || '').toLowerCase().trim() === userName)
        );
        const assignedFromRecord = new Set(myUserRecord ? linkedIds(myUserRecord, 'Accounts') : []);
        const myRecordId = myUserRecord?.id || clientRecordId;

        console.log('[BDR filter] assignedFromLogin:', assignedFromLogin.size, '| assignedFromRecord:', assignedFromRecord.size, '| myRecordId:', myRecordId);

        // Filter: account must be in assigned set (either source), or BDR field, or BDR Owner text
        results.accounts = allAccounts.filter(a => {
          if (assignedFromLogin.has(a.id)) return true;
          if (assignedFromRecord.has(a.id)) return true;
          if (myRecordId && linkedIds(a, 'BDR').includes(myRecordId)) return true;
          const bdrOwner = (F(a, 'BDR Owner') || '').toLowerCase().trim();
          if (userName && bdrOwner === userName) return true;
          if (userEmail && bdrOwner === userEmail.toLowerCase()) return true;
          return false;
        });

        // Cascade filter: only show related data for visible accounts
        const visibleAccountIds = new Set(results.accounts.map(a => a.id));
        results.stakeholders = (results.stakeholders || []).filter(s =>
          linkedIds(s, 'Account').some(id => visibleAccountIds.has(id))
        );
        const visibleStakeholderIds = new Set(results.stakeholders.map(s => s.id));
        results.opportunities = (results.opportunities || []).filter(o =>
          linkedIds(o, 'Account').some(id => visibleAccountIds.has(id))
        );
        results.outreach = (results.outreach || []).filter(o =>
          linkedIds(o, 'Account').some(id => visibleAccountIds.has(id)) ||
          linkedIds(o, 'Stakeholder').some(id => visibleStakeholderIds.has(id))
        );
        results.actionPlan = (results.actionPlan || []).filter(ap =>
          linkedIds(ap, 'Cuenta').some(id => visibleAccountIds.has(id))
        );
      }

      if (userRole === 'cp') {
        // CP: only accounts where Client Partners linked record matches user email
        const cpRecords = results.clientPartners || [];
        const myCpIds = cpRecords
          .filter(cp => (F(cp, 'Email') || '').toLowerCase() === userEmail.toLowerCase())
          .map(cp => cp.id);

        if (myCpIds.length > 0) {
          results.accounts = (results.accounts || []).filter(a => {
            const cpIds = linkedIds(a, 'CP');
            return cpIds.some(id => myCpIds.includes(id));
          });
        } else {
          results.accounts = [];
        }

        // Cascade filter
        const visibleAccountIds = new Set(results.accounts.map(a => a.id));
        results.stakeholders = (results.stakeholders || []).filter(s =>
          linkedIds(s, 'Account').some(id => visibleAccountIds.has(id))
        );
        const visibleStakeholderIds = new Set(results.stakeholders.map(s => s.id));
        results.opportunities = (results.opportunities || []).filter(o =>
          linkedIds(o, 'Account').some(id => visibleAccountIds.has(id))
        );
        results.outreach = (results.outreach || []).filter(o =>
          linkedIds(o, 'Account').some(id => visibleAccountIds.has(id)) ||
          linkedIds(o, 'Stakeholder').some(id => visibleStakeholderIds.has(id))
        );
        results.actionPlan = (results.actionPlan || []).filter(ap =>
          linkedIds(ap, 'Cuenta').some(id => visibleAccountIds.has(id))
        );
      }
      // admin: no filtering — sees everything

      // Enrich stakeholders + accounts with computed fields (_enriched)
      const enriched = computeEnrichment(results);
      setData(enriched);
    } catch (e) {
      console.error('Load failed:', e);
    }
    if (!silent) setLoading(false);
    if (silent) setRefreshing(false);
  }, []);

  // Update document title with pending follow-up count
  React.useEffect(() => {
    const count = (data?.stakeholders || []).filter(s => s._enriched && !s._enriched.contactedToday && s._enriched.focusTag && s._enriched.daysSince >= 3).length;
    document.title = count > 0 ? `(${count}) Oike Sales Intel` : 'Oike Sales Intel';
  }, [data]);

  // Auto-connect: if already authenticated, load config + data
  useEffect(() => {
    if (!isAuthenticated) { setLoading(false); return; }
    (async () => {
      try {
        await loadClientConfig();
        const a = new AirtableAPI();
        setApi(a);
        setReady(true);
        await loadData(a);
        // Show onboarding wizard on first login
        const done = localStorage.getItem(ONBOARDING_KEY);
        if (!done) setShowOnboarding(true);
        // Detect Gmail OAuth return
        const urlParams = new URLSearchParams(window.location.search);
        const gmailParam = urlParams.get('gmail');
        const urlId      = urlParams.get('id');
        const urlPage    = urlParams.get('v');
        // Restore selected record from URL (e.g. after refresh)
        if (urlId) {
          const targetPage = urlPage || localStorage.getItem('oike_page') || 'overview';
          if (targetPage === 'accounts')          setNavigateToAccountId(urlId);
          else if (targetPage === 'solutionshub') setNavigateToSolId(urlId);
          else if (targetPage === 'events')       setNavigateToEventId(urlId);
          else if (targetPage === 'proposals')    setNavigateToProposalId(urlId);
        }
        if (gmailParam) {
          if (gmailParam === 'connected') localStorage.setItem('oike_gmail_connected', 'true');
          setGmailReturnStatus(gmailParam);
          setShowSettings(true);
          // Only remove the gmail param, preserve ?v= and ?id=
          navSetUrl(urlPage || page, urlId || null);
        }
      } catch (e) {
        console.error('Init failed:', e);
        setConfigError('Failed to connect. Please try again.');
        setLoading(false);
      }
    })();
  }, [loadData, isAuthenticated]);

  // ── Login gate ──
  if (!isAuthenticated) {
    return <LoginScreen onLogin={() => setIsAuthenticated(true)} />;
  }

  if (configError) return (
    <div className="config-screen">
      <div className="config-box">
        <div className="logo-big" style={{ background: '#5BBFB5' }}>O</div>
        <h2 style={{ marginBottom: 8 }}>Oike Sales Intelligence</h2>
        <p style={{ color: 'var(--globant-danger)', fontSize: 13 }}>{configError}</p>
        <button className="action-btn btn-primary" style={{ marginTop: 16, padding: '12px 24px' }} onClick={() => window.location.reload()}>Retry</button>
      </div>
    </div>
  );
  if (loading) return <div className="loading"><div className="spinner" /></div>;


  const bgSync = () => api && loadData(api, true);
  const pages = {
    overview: <StrategyOverview data={data} api={api} onUpdateRecord={updateInData} onAddRecord={addToData} onLogActivity={bgSync} />,
    followup: <FollowupCenter data={data} api={api} onLogActivity={bgSync} onAddRecord={addToData} onUpdateRecord={updateInData} goToAccount={goToAccount} />,
    contacts: <ContactsSection data={data} api={api} onLogActivity={bgSync} onAddRecord={addToData} onUpdateRecord={updateInData} onDeleteRecord={removeFromData} goToAccount={goToAccount} />,
    activity: <ActivityTracker data={data} api={api} onLogActivity={bgSync} onUpdateRecord={updateInData} onDeleteRecord={removeFromData} />,
    events: <EventsHub data={data} api={api} onLogActivity={bgSync} onAddRecord={addToData} onUpdateRecord={updateInData} navigateToEventId={navigateToEventId} clearNavigateEvent={() => setNavigateToEventId('')} />,
    proposals: <ProposalsHub data={data} api={api} onLogActivity={bgSync} onAddRecord={addToData} onUpdateRecord={updateInData} navigateToProposalId={navigateToProposalId} clearNavigateProposal={() => setNavigateToProposalId('')} />,
    insights: <InsightsView data={data} />,
    campaigns: <CampaignsHub data={data} api={api} onLogActivity={bgSync} onAddRecord={addToData} onUpdateRecord={updateInData} onDeleteRecord={removeFromData} campaignPrefill={campaignPrefill} clearCampaignPrefill={() => setCampaignPrefill(null)} />,
    messagelab: <MessageLab data={data} api={api} onLogActivity={bgSync} onUpdateRecord={updateInData} />,
    contentlab: <ContentLab data={data} api={api} onLogActivity={bgSync} onAddRecord={addToData} onDeleteRecord={removeFromData} />,
    landings: <LandingsHub data={data} api={api} onLogActivity={bgSync} onAddRecord={addToData} onUpdateRecord={updateInData} />,
    reports:  <ReportBuilder data={data} api={api} onAddRecord={addToData} onCreateCampaignFromInsight={createCampaignFromInsight} />,
    accounts: <CPBriefings data={data} api={api} onLogActivity={bgSync} onAddRecord={addToData} onUpdateRecord={updateInData} onDeleteRecord={removeFromData} navigateToAccountId={navigateToAccountId} clearNavigate={() => setNavigateToAccountId('')} navigateToAccountTab={navigateToAccountTab} clearNavigateTab={() => setNavigateToAccountTab('')} goToAccount={goToAccount} goToProposal={goToProposal} />,
    solutionshub: <SolutionsHub data={data} api={api} onLogActivity={bgSync} onAddRecord={addToData} onDeleteRecord={removeFromData} goToAccount={goToAccount} navigateToSolId={navigateToSolId} clearNavigateSol={() => setNavigateToSolId('')} />,
    icp: <ICPSection data={data} goToSolution={goToSolution} api={api} onLogActivity={bgSync} onAddRecord={addToData} />,
  };

  const isBDR = CURRENT_USER?.role === 'bdr';
  const isAdmin = CURRENT_USER?.role === 'admin';

  const allNavItems = [
    // Group 1 — Daily Execution
    { icon: '🎯', label: 'My Day', key: 'followup', bdr: true, group: 1 },
    { icon: '🏢', label: 'Accounts', key: 'accounts', bdr: true, group: 1 },
    { icon: '👤', label: 'Contacts', key: 'contacts', bdr: true, group: 1 },
    { icon: '📣', label: 'Campaigns', key: 'campaigns', bdr: true, group: 1 },
    { icon: '✉️', label: 'Message Lab', key: 'messagelab', bdr: true, group: 1 },
    // Group 2 — Outreach & Pipeline
    { icon: '🎪', label: 'Events', key: 'events', group: 2 },
    { icon: '📈', label: 'Activity Tracker', key: 'activity', group: 2 },
    // Group 3 — Intelligence & Reporting
    { icon: '🧠', label: 'Insights', key: 'insights', group: 3 },
    { icon: '📧', label: 'Reports', key: 'reports', group: 3 },
    // Group 4 — Strategy & Setup
    { icon: '📊', label: 'Strategy Overview', key: 'overview', group: 4 },
    { icon: '🎯', label: 'ICP', key: 'icp', group: 4 },
    { icon: '🛠️', label: 'Offering Hub', key: 'solutionshub', group: 4 },
  ];
  const navItems = isBDR ? allNavItems.filter(i => i.bdr) : allNavItems;

  const currentPageLabel = (navItems.find(i => i.key === page) || {}).label || 'Overview';

  return (
    <div>
      {/* Onboarding wizard — shown on first login */}
      {showOnboarding && api && (
        <OnboardingWizard
          api={api}
          onComplete={() => { setShowOnboarding(false); api && loadData(api, true); }}
        />
      )}
      {/* Mobile top bar */}
      <div className="mobile-topbar">
        <button
          onClick={() => setSidebarOpen(true)}
          style={{ background: 'none', border: 'none', color: 'var(--globant-text)', fontSize: 22, cursor: 'pointer', lineHeight: 1, padding: '4px 6px' }}
        >&#9776;</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="logo-icon" style={{ background: '#5BBFB5', width: 28, height: 28, fontSize: 14 }}>O</div>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--globant-text)' }}>{currentPageLabel}</span>
        </div>
      </div>
      {/* Sidebar overlay (tap to close) */}
      <div
        className={'sidebar-overlay' + (sidebarOpen ? ' mob-open' : '')}
        onClick={() => setSidebarOpen(false)}
      />
      <div className={'sidebar' + (sidebarOpen ? ' mob-open' : '')}>
        <div className="sidebar-logo">
          <div className="logo-icon" style={{ background: '#5BBFB5' }}>O</div>
          <div>
            <span>{CLIENT_CONFIG.name || 'Oike'}</span>
            <small>Sales Intel</small>
          </div>
        </div>
        <nav className="sidebar-nav">
          {navItems.map((item, idx) => {
            const prevItem = navItems[idx - 1];
            const showDivider = !isBDR && idx > 0 && item.group !== prevItem?.group;
            return (
              <React.Fragment key={item.key}>
                {showDivider && (
                  <div style={{ margin: '6px 12px', borderTop: '1px solid var(--globant-border)', opacity: 0.5 }} />
                )}
                <div
                  className={'nav-item ' + (page === item.key ? 'active' : '')}
                  onClick={() => { setPageAndSave(item.key); setSidebarOpen(false); }}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span>{item.label}</span>
                </div>
              </React.Fragment>
            );
          })}
        </nav>
        <div style={{ flexShrink: 0, padding: '12px 12px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button
            className="action-btn btn-ghost"
            style={{ width: '100%', fontSize: 12, padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            onClick={() => setShowGlobalSearch(true)}
          >
            🔍 Search <span style={{ opacity: 0.6, fontSize: 10 }}>⌘K</span>
          </button>
          <button
            className="action-btn btn-ghost"
            style={{ width: '100%', fontSize: 12, padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            onClick={() => api && loadData(api)}
          >
            🔄 Refresh Data
          </button>
          <button
            className="action-btn btn-ghost"
            style={{ width: '100%', fontSize: 12, padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            onClick={() => setShowSettings(true)}
          >
            ⚙️ Settings
          </button>
        </div>
        <div className="sidebar-footer" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {CURRENT_USER && (
            <>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--globant-text)' }}>{CURRENT_USER.name}</div>
                <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>{CURRENT_USER.email}</div>
                <div style={{ fontSize: 9, marginTop: 2 }}><span style={{ background: CURRENT_USER.role === 'admin' ? 'rgba(91,191,181,0.2)' : 'rgba(96,165,250,0.2)', color: CURRENT_USER.role === 'admin' ? 'var(--globant-green)' : 'var(--globant-info)', padding: '2px 8px', borderRadius: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{CURRENT_USER.role || 'user'}</span></div>
              </div>
            </>
          )}
          <button
            onClick={() => setShowFeedback(true)}
            style={{ width: '100%', padding: '7px 12px', borderRadius: 8, cursor: 'pointer', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--globant-border)', color: 'var(--globant-muted)', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 6 }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}>
            💬 Send feedback
          </button>
          <button
            onClick={() => { if (confirm('Sign out of Oike?')) logoutUser(); }}
            style={{
              width: '100%', padding: '9px 12px', borderRadius: 8, cursor: 'pointer',
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
              color: '#f87171', fontSize: 12, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.18)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.1)'; }}
            title="Sign out of Oike">
            🚪 Sign out
          </button>
        </div>
      </div>
      <div className="main">
        {refreshing && (
          <div style={{ position: 'fixed', top: 8, right: 20, zIndex: 999, background: 'rgba(91,191,181,0.15)', border: '1px solid rgba(91,191,181,0.3)', borderRadius: 8, padding: '6px 14px', fontSize: 11, color: 'var(--globant-green)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>🔄</span> Syncing...
          </div>
        )}
        {pages[page] || pages.overview}
      </div>

      {/* Settings Modal */}
      {showSettings && <SettingsModal onClose={() => { setShowSettings(false); setGmailReturnStatus(''); }} gmailReturnStatus={gmailReturnStatus} />}

      {/* Global Search Modal */}
      {showGlobalSearch && (
        <GlobalSearchModal
          data={data}
          onClose={() => setShowGlobalSearch(false)}
          onNavigate={(section, id, record) => {
            if (section === 'accounts' && id) {
              goToAccount(id);
            } else if (section === 'contacts' && id) {
              // Navigate to contacts and fire a custom event to open the record
              setPageAndSave('contacts');
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('oike:openContact', { detail: { id, record } }));
              }, 100);
            } else {
              setPageAndSave(section);
            }
          }}
        />
      )}

      {/* Keyboard Shortcuts Modal */}
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}

      {/* Feedback Modal */}
      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}

      {/* Feedback button — moved to sidebar above Sign Out */}
      <button onClick={() => setShowFeedback(true)} style={{ display: 'none' }}>
        💬 Feedback
      </button>

      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 }}>
          {toasts.map(t => (
            <div key={t.id} style={{
              padding: '12px 16px', borderRadius: 10, fontSize: 13, fontWeight: 500,
              background: t.type === 'success' ? 'rgba(74,222,128,0.15)' : t.type === 'error' ? 'rgba(239,68,68,0.15)' : t.type === 'warning' ? 'rgba(251,191,36,0.15)' : 'rgba(96,165,250,0.15)',
              border: `1px solid ${t.type === 'success' ? 'rgba(74,222,128,0.4)' : t.type === 'error' ? 'rgba(239,68,68,0.4)' : t.type === 'warning' ? 'rgba(251,191,36,0.4)' : 'rgba(96,165,250,0.4)'}`,
              color: t.type === 'success' ? '#4ade80' : t.type === 'error' ? '#f87171' : t.type === 'warning' ? '#fbbf24' : '#60a5fa',
              boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
              backdropFilter: 'blur(8px)',
              animation: 'slideInRight 0.25s ease',
            }}>
              {t.type === 'success' ? '✅ ' : t.type === 'error' ? '❌ ' : t.type === 'warning' ? '⚠️ ' : 'ℹ️ '}{t.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Oike crash:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#12121F', color: '#E8E8F0', fontFamily: 'Inter, sans-serif', padding: 40 }}>
          <div style={{ maxWidth: 480, textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
            <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12, color: '#BFD730' }}>Something went wrong</h2>
            <p style={{ fontSize: 13, color: '#8888A8', marginBottom: 24 }}>The application encountered an unexpected error. Try reloading the page.</p>
            <pre style={{ fontSize: 11, color: '#F87171', background: '#1E1E32', padding: '12px 16px', borderRadius: 8, textAlign: 'left', overflowX: 'auto', marginBottom: 20 }}>
              {this.state.error.message}
            </pre>
            <button onClick={() => window.location.reload()} style={{ padding: '10px 24px', background: '#BFD730', color: '#1A1A2E', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 14 }}>
              🔄 Recargar
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Hide loading screen once React mounts
const rootEl = document.getElementById('root');
const loadingEl = document.getElementById('oike-loading');
if (loadingEl) loadingEl.style.display = 'none';

ReactDOM.createRoot(rootEl).render(
  <ErrorBoundary><App /></ErrorBoundary>
);

// Register service worker for PWA caching
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('[SW] Registration failed:', e));
}
