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


function StrategyOverview({ data, api, onUpdateRecord, onAddRecord, onLogActivity }) {
  const { accounts, stakeholders, opportunities, outreach, solutions, events, users = [], strategy = [] } = data;
  const isAdmin = CURRENT_USER?.role === 'admin';

  // ─── STRATEGY GOAL STATE ───
  const strategyRecord = strategy[0] || null;
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalForm, setGoalForm] = useState({ name: '', target: '', startDate: '', deadline: '' });
  const [savingGoal, setSavingGoal] = useState(false);

  // ─── TEAM KPI EDITING ───
  const [editingKpiId, setEditingKpiId] = useState(null);
  const [kpiForm, setKpiForm] = useState({ meetings: '', deals: '' });
  const [savingKpi, setSavingKpi] = useState(false);

  // ─── AI EXECUTIVE SUMMARY ───
  const [aiSummary, setAiSummary] = useState('');
  const [loadingAiSummary, setLoadingAiSummary] = useState(false);

  // ─── GOAL VALUES ───
  const goalName = strategyRecord ? (F(strategyRecord, 'Goal Name') || '') : '';
  const goalTarget = strategyRecord ? (strategyRecord.fields?.['Target Amount'] || 0) : 0;
  const goalDeadline = strategyRecord ? (F(strategyRecord, 'Deadline') || '') : '';
  const goalStartDate = strategyRecord ? (F(strategyRecord, 'Start Date') || '') : '';

  // ─── CORE DATA ───
  const meetingStatuses = ['Meeting Scheduled', 'Meeting Booked'];
  // closedStages / wonStages defined globally as CLOSED_STAGES / WON_STAGES
  const closedStages = CLOSED_STAGES;
  const wonStages = WON_STAGES;

  const allMeetings = outreach.filter(o => meetingStatuses.includes(F(o, 'Status')));
  const wonOpps = opportunities.filter(o => wonStages.includes(F(o, 'Stage')));

  // Active opps: filtered by owner (Users field) + Opening date within goal range
  const _curUserRec = (data.users || []).find(u =>
    (F(u, 'Email') || '').toLowerCase() === (CURRENT_USER?.email || '').toLowerCase()
  );
  const activeOpps = opportunities.filter(o => {
    if (closedStages.includes(F(o, 'Stage'))) return false;
    // Owner filter: if opp has Users linked, current user must be one of them
    const ownerIds = linkedIds(o, 'Users');
    if (ownerIds.length > 0 && _curUserRec && !ownerIds.includes(_curUserRec.id)) return false;
    // Opening date filter: must be on or after goalStartDate (if set)
    if (goalStartDate) {
      const openDate = o.fields?.['Opening date'] || o.fields?.['opening date'] || '';
      if (openDate && new Date(openDate) < new Date(goalStartDate)) return false;
    }
    return true;
  });
  const activePipeline = activeOpps.reduce((s, o) => s + (o.fields?.['Value'] || 0), 0);
  const wonValue = wonOpps.reduce((s, o) => s + (o.fields?.['Value'] || 0), 0);
  const mappedAccounts = accounts.filter(a => linkedIds(a, 'Stakeholders').length > 0);
  const unmappedAccounts = accounts.filter(a => linkedIds(a, 'Stakeholders').length === 0);
  const activeAccounts = accounts.filter(a => ['Active', 'Activo'].includes(F(a, 'Inside Sales Status')));
  const accountsWithSolutions = accounts.filter(a => linkedIds(a, 'Solutions').length > 0);

  // ─── GOAL PROGRESS ───
  const progressPct = goalTarget > 0 ? Math.min(100, Math.round((activePipeline / goalTarget) * 100)) : 0;
  const wonPct = goalTarget > 0 ? Math.min(100, Math.round((wonValue / goalTarget) * 100)) : 0;
  const daysRemaining = goalDeadline ? Math.ceil((new Date(goalDeadline) - new Date()) / (1000 * 60 * 60 * 24)) : null;

  // ─── PERSONAL KPIs ───
  const currentUserRecord = users.find(u => (F(u, 'Email') || '').toLowerCase() === (CURRENT_USER?.email || '').toLowerCase());
  const currentUserId = currentUserRecord?.id;
  const myMeetingsTarget = currentUserRecord ? (currentUserRecord.fields?.['KPI Meetings Target'] || 0) : 0;
  const myDealsTarget = currentUserRecord ? (currentUserRecord.fields?.['KPI Deals Target'] || 0) : 0;

  const myMeetings = allMeetings.filter(o => {
    const lb = F(o, 'Logged By');
    return lb && (lb === CURRENT_USER?.name || lb === CURRENT_USER?.email);
  });

  const myDealsWon = wonOpps.filter(opp =>
    currentUserId && linkedIds(opp, 'Account').some(accId => {
      const acc = accounts.find(a => a.id === accId);
      return acc && (linkedIds(acc, 'BDR').includes(currentUserId) || linkedIds(acc, 'CP').includes(currentUserId));
    })
  );

  // ─── HANDLERS ───
  const openEditGoal = () => {
    setGoalForm({ name: goalName, target: goalTarget ? String(goalTarget) : '', startDate: goalStartDate, deadline: goalDeadline });
    setEditingGoal(true);
  };

  const saveGoal = async () => {
    if (!api) return;
    setSavingGoal(true);
    try {
      const fields = {
        'Goal Name': goalForm.name,
        'Target Amount': parseFloat(goalForm.target) || 0,
        ...(goalForm.startDate ? { 'Start Date': goalForm.startDate } : {}),
        ...(goalForm.deadline ? { 'Deadline': goalForm.deadline } : {}),
      };
      if (strategyRecord) {
        await api.updateRecord(TABLE_IDS.strategy, strategyRecord.id, fields);
        if (onUpdateRecord) onUpdateRecord('strategy', strategyRecord.id, fields);
      } else {
        const created = await api.createRecord(TABLE_IDS.strategy, fields);
        if (onAddRecord) onAddRecord('strategy', created?.fields || fields);
      }
      setEditingGoal(false);
    } catch (e) {
      window.__oikeToast('Failed to save goal: ' + e.message, 'error');
    } finally {
      setSavingGoal(false);
    }
  };

  const openEditKpi = (user) => {
    setEditingKpiId(user.id);
    setKpiForm({
      meetings: String(user.fields?.['KPI Meetings Target'] || ''),
      deals: String(user.fields?.['KPI Deals Target'] || ''),
    });
  };

  const saveKpi = async () => {
    if (!api || !editingKpiId) return;
    setSavingKpi(true);
    try {
      const fields = {
        'KPI Meetings Target': parseInt(kpiForm.meetings) || 0,
        'KPI Deals Target': parseInt(kpiForm.deals) || 0,
      };
      await api.updateRecord(TABLE_IDS.users, editingKpiId, fields);
      if (onUpdateRecord) onUpdateRecord('users', editingKpiId, fields);
      setEditingKpiId(null);
    } catch (e) {
      window.__oikeToast('Failed to save KPI targets: ' + e.message, 'error');
    } finally {
      setSavingKpi(false);
    }
  };

  // ─── EXISTING VISUALISATION DATA ───
  const contactedStakeholderIds = new Set();
  outreach.forEach(o => linkedIds(o, 'Stakeholder').forEach(id => contactedStakeholderIds.add(id)));

  const today = new Date().toISOString().slice(0, 10);
  const upcomingEvents = (events || []).filter(e => {
    const start = e.fields?.['Starting'];
    return start && start >= today;
  }).sort((a, b) => (a.fields?.['Starting'] || '').localeCompare(b.fields?.['Starting'] || ''));

  const statusCounts = {};
  accounts.forEach(a => {
    const s = F(a, 'Inside Sales Status') || 'No Status';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });

  const topAccounts = [...mappedAccounts].sort((a, b) =>
    linkedIds(b, 'Stakeholders').length - linkedIds(a, 'Stakeholders').length
  ).slice(0, 10);

  const repliedIds = new Set(outreach.filter(o => F(o, 'Status') === 'Replied').flatMap(o => linkedIds(o, 'Stakeholder')));
  const meetingIds = new Set(outreach.filter(o => meetingStatuses.includes(F(o, 'Status'))).flatMap(o => linkedIds(o, 'Account')));
  const funnelSteps = [
    { label: 'Accounts', value: accounts.length, color: '#60a5fa' },
    { label: 'Mapped', value: mappedAccounts.length, color: '#818cf8' },
    { label: 'Contacted', value: new Set(outreach.flatMap(o => linkedIds(o, 'Account'))).size, color: '#a78bfa' },
    { label: 'Replied', value: repliedIds.size, color: '#f59e0b' },
    { label: 'Meetings', value: meetingIds.size, color: '#34d399' },
    { label: 'Open Opps', value: activeOpps.length, color: 'var(--globant-green)' },
    { label: 'Won', value: wonOpps.length, color: '#4ade80' },
  ];
  const funnelMax = funnelSteps[0].value || 1;

  const stageProbability = { 'Prospecting': 0.1, 'Qualification': 0.2, 'Discovery': 0.3, 'Proposal': 0.5, 'Negotiation': 0.7, 'Closed Won': 1, 'On Hold': 0.15 };
  const forecastByStage = {};
  activeOpps.forEach(o => {
    const stage = F(o, 'Stage') || 'Unknown';
    const val = o.fields?.['Value'] || 0;
    const prob = stageProbability[stage] ?? (o.fields?.['Close probability (%)'] || 0.2);
    if (!forecastByStage[stage]) forecastByStage[stage] = { count: 0, raw: 0, weighted: 0, prob };
    forecastByStage[stage].count++;
    forecastByStage[stage].raw += val;
    forecastByStage[stage].weighted += val * prob;
  });
  const totalWeighted = Object.values(forecastByStage).reduce((s, v) => s + v.weighted, 0);
  const forecastStages = Object.entries(forecastByStage).sort((a, b) => (stageProbability[b[0]] || 0) - (stageProbability[a[0]] || 0));

  const heatmapDays = 28;
  const heatmapData = {};
  const heatmapStart = new Date(); heatmapStart.setDate(heatmapStart.getDate() - heatmapDays);
  outreach.forEach(o => {
    const d = o.fields?.['Date'] ? new Date(o.fields['Date']).toISOString().slice(0, 10) : null;
    if (d && d >= heatmapStart.toISOString().slice(0, 10)) heatmapData[d] = (heatmapData[d] || 0) + 1;
  });
  const heatmapDaysList = Array.from({ length: heatmapDays }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (heatmapDays - 1 - i));
    const key = d.toISOString().slice(0, 10);
    return { key, count: heatmapData[key] || 0, label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) };
  });
  const heatmapMax = Math.max(...heatmapDaysList.map(d => d.count), 1);

  const now2 = new Date();
  const focusAccounts = mappedAccounts.map(a => {
    const accOut = outreach.filter(o => linkedIds(o, 'Account').includes(a.id));
    const lastOut = accOut.sort((x, y) => new Date(y.fields?.['Date'] || 0) - new Date(x.fields?.['Date'] || 0))[0];
    const daysSince = lastOut ? Math.floor((now2 - new Date(lastOut.fields?.['Date'])) / 86400000) : 999;
    const hasReply = accOut.some(o => F(o, 'Status') === 'Replied');
    const hasMeeting = accOut.some(o => meetingStatuses.includes(F(o, 'Status')));
    const openOppCount = activeOpps.filter(o => linkedIds(o, 'Account').includes(a.id)).length;
    const hasNews = !!(F(a, 'Recent News'));
    let score = 0;
    if (openOppCount > 0) score += 30;
    if (daysSince > 14 && daysSince < 60) score += 20;
    if (hasReply && !hasMeeting) score += 15;
    if (hasNews) score += 10;
    if (daysSince > 60) score += 5;
    if (hasMeeting) score -= 10;
    const reason = openOppCount > 0 ? `${openOppCount} open opp${openOppCount > 1 ? 's' : ''}` : hasReply ? 'Replied — no meeting yet' : daysSince > 14 ? `${daysSince}d without contact` : 'High potential';
    return { a, score, daysSince, reason, openOppCount, hasReply, hasMeeting };
  }).sort((a, b) => b.score - a.score).slice(0, 3);

  // ─── OUTREACH VELOCITY (this week vs last week) ───
  const startOfThisWeek = new Date(); startOfThisWeek.setDate(startOfThisWeek.getDate() - startOfThisWeek.getDay()); startOfThisWeek.setHours(0,0,0,0);
  const startOfLastWeek = new Date(startOfThisWeek); startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);
  const thisWeekTouches = outreach.filter(o => { const d = o.fields?.['Date']; return d && new Date(d) >= startOfThisWeek; }).length;
  const lastWeekTouches = outreach.filter(o => { const d = o.fields?.['Date']; return d && new Date(d) >= startOfLastWeek && new Date(d) < startOfThisWeek; }).length;
  const velocityDelta = thisWeekTouches - lastWeekTouches;
  const velocityPct = lastWeekTouches > 0 ? Math.round((velocityDelta / lastWeekTouches) * 100) : null;

  // ─── REPLY RATE (all time, overview level) ───
  const overviewReplied = outreach.filter(o => F(o, 'Status') === 'Replied').length;
  const overviewReplyRate = outreach.length > 0 ? Math.round((overviewReplied / outreach.length) * 100) : 0;
  const replyRateBenchColor = overviewReplyRate >= BENCH_REPLY_HIGH ? '#4ade80' : overviewReplyRate >= BENCH_REPLY_LOW ? '#fbbf24' : '#ef4444';

  // ─── PIPELINE AT RISK ───
  const atRiskOpps = activeOpps.filter(opp => {
    const accIds = linkedIds(opp, 'Account');
    const lastAct = outreach.filter(o => accIds.some(id => linkedIds(o, 'Account').includes(id)))
      .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0))[0];
    const daysSince = lastAct ? Math.floor((new Date() - new Date(lastAct.fields?.['Date'])) / 86400000) : 999;
    const isOverdue = opp.fields?.['Close date'] && new Date(opp.fields['Close date']) < new Date();
    return daysSince > 21 || isOverdue;
  });
  const atRiskValue = atRiskOpps.reduce((s, o) => s + (o.fields?.['Value'] || 0), 0);

  // ─── ACCOUNT COVERAGE QUALITY ───
  const accsWithNews = mappedAccounts.filter(a => F(a, 'Recent News'));
  const accsWithPlan = mappedAccounts.filter(a => F(a, 'Inside sales plan'));
  const coverageItems = [
    { label: 'Solutions mapped', count: accountsWithSolutions.length, color: '#60a5fa' },
    { label: 'Has recent news', count: accsWithNews.length, color: '#fbbf24' },
    { label: 'Has sales plan', count: accsWithPlan.length, color: '#4ade80' },
    { label: 'Has stakeholders', count: mappedAccounts.length, color: '#a78bfa' },
  ];

  // ─── MONTHLY TREND (last 4 months) ───
  const monthlyTrend = Array.from({ length: 4 }, (_, i) => {
    const d = new Date(); d.setMonth(d.getMonth() - (3 - i));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-US', { month: 'short' });
    const count = outreach.filter(o => (o.fields?.['Date'] || '').startsWith(key)).length;
    const replied = outreach.filter(o => (o.fields?.['Date'] || '').startsWith(key) && F(o, 'Status') === 'Replied').length;
    return { key, label, count, replied };
  });
  const monthlyMax = Math.max(...monthlyTrend.map(m => m.count), 1);

  // ─── AI EXECUTIVE SUMMARY GENERATOR ───
  const generateAiSummary = async () => {
    setLoadingAiSummary(true);
    try {
      const atRiskNames = atRiskOpps.slice(0, 3).map(o => `${F(o,'Deal/Opp name') || '?'} (${resolveLinked(o,'Account',accounts,'Account Name')[0] || '?'})`).join(', ');
      const prompt = `You are a B2B sales director. Write a concise executive summary of the current inside sales situation. Use exactly 5 bullet points. Be direct, data-driven, and actionable. No fluff. Highlight what's working AND what needs urgent attention.

Data:
- Goal: ${goalName || 'not set'} · Target: ${goalTarget > 0 ? formatCurrency(goalTarget) : 'not set'} · ${daysRemaining !== null ? `${daysRemaining} days left` : ''}
- Pipeline: ${formatCurrency(activePipeline)} (${progressPct}% of target) · Won: ${formatCurrency(wonValue)}
- Meetings booked: ${allMeetings.length} · Active opps: ${activeOpps.length} · At-risk opps: ${atRiskOpps.length}${atRiskOpps.length > 0 ? ` (${atRiskNames})` : ''}
- Reply rate: ${overviewReplyRate}% (benchmark: ${BENCH_REPLY_LOW}–${BENCH_REPLY_HIGH}%)
- This week touches: ${thisWeekTouches} vs last week: ${lastWeekTouches} (${velocityDelta >= 0 ? '+' : ''}${velocityDelta})
- Accounts: ${accounts.length} total · ${mappedAccounts.length} mapped · ${activeAccounts.length} active · ${unmappedAccounts.length} unmapped
- Coverage: ${accountsWithSolutions.length}/${mappedAccounts.length} have solutions · ${accsWithNews.length}/${mappedAccounts.length} have news · ${accsWithPlan.length}/${mappedAccounts.length} have sales plan
- Monthly trend: ${monthlyTrend.map(m => `${m.label}: ${m.count} touches`).join(' · ')}

Write 5 bullets: start each with an emoji that reflects urgency/status (🟢 good, 🟡 attention needed, 🔴 critical, 📈 trending up, 📉 trending down). Be specific with numbers.`;
      const result = await callOpenAI({ prompt, max_tokens: 350, temperature: 0.5 });
      setAiSummary(result);
    } catch (e) {
      setAiSummary('Could not generate summary. Try again.');
    } finally {
      setLoadingAiSummary(false);
    }
  };

  // ─── HELPERS ───
  const kpiPct = (actual, target) => target > 0 ? Math.min(100, Math.round((actual / target) * 100)) : null;
  const kpiColor = (pct) => pct === null ? 'var(--globant-muted)' : pct >= 100 ? '#4ade80' : pct >= 60 ? '#fbbf24' : '#ef4444';
  const sStyle = { background: 'var(--globant-darker)', border: '1px solid var(--globant-border)', borderRadius: 6, color: 'var(--globant-text)', padding: '6px 10px', fontSize: 13 };

  return (
    <div>
      <div className="page-header">
        <h1>Inside Sales Dashboard</h1>
        <p>Strategy, KPIs and execution overview</p>
      </div>

      {/* ─── COMPANY GOAL ─── */}
      <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid #BFD730', background: 'linear-gradient(135deg, rgba(191,215,48,0.06) 0%, transparent 60%)' }}>
        {!editingGoal ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 18 }}>🎯</span>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--globant-muted)' }}>Company Goal</span>
              {isAdmin && <button className="action-btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px' }} onClick={openEditGoal}>✏️ Edit</button>}
            </div>
            {goalName ? (
              <>
                <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>{goalName}</div>
                <div style={{ display: 'flex', gap: 20, alignItems: 'center', marginBottom: 12 }}>
                  {goalTarget > 0 && <span style={{ fontSize: 13, color: 'var(--globant-muted)' }}>Target: <strong style={{ color: 'var(--globant-text)' }}>{formatCurrency(goalTarget)}</strong></span>}
                  {goalStartDate && <span style={{ fontSize: 13, color: 'var(--globant-muted)' }}>From: <strong style={{ color: 'var(--globant-text)' }}>{formatDate(goalStartDate)}</strong></span>}
              {goalDeadline && <span style={{ fontSize: 13, color: 'var(--globant-muted)' }}>To: <strong style={{ color: 'var(--globant-text)' }}>{formatDate(goalDeadline)}</strong></span>}
                  {daysRemaining !== null && (
                    <span style={{ fontSize: 12, fontWeight: 700, color: daysRemaining < 0 ? '#ef4444' : daysRemaining < 30 ? '#fbbf24' : '#4ade80' }}>
                      {daysRemaining < 0 ? `${Math.abs(daysRemaining)}d overdue` : `${daysRemaining}d left`}
                    </span>
                  )}
                </div>
                {goalTarget > 0 && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4 }}>
                      <span>Pipeline vs target</span>
                      <span>{progressPct}% — {formatCurrency(activePipeline)} in pipeline{wonValue > 0 ? ` · ${formatCurrency(wonValue)} won` : ''}</span>
                    </div>
                    <div style={{ height: 12, borderRadius: 6, background: 'var(--globant-darker)', overflow: 'hidden', position: 'relative' }}>
                      <div style={{ height: '100%', width: `${progressPct}%`, background: 'linear-gradient(90deg, #60a5fa, #818cf8)', borderRadius: 6, transition: 'width 0.5s' }} />
                      {wonPct > 0 && <div style={{ position: 'absolute', top: 0, height: '100%', width: `${wonPct}%`, background: 'linear-gradient(90deg, #4ade80, #22d3ee)', borderRadius: 6, opacity: 0.75 }} />}
                    </div>
                    <div style={{ display: 'flex', gap: 16, fontSize: 10, color: 'var(--globant-muted)', marginTop: 4 }}>
                      <span><span style={{ color: '#818cf8' }}>█</span> Pipeline: {formatCurrency(activePipeline)}</span>
                      {wonValue > 0 && <span><span style={{ color: '#4ade80' }}>█</span> Won: {formatCurrency(wonValue)} ({wonPct}%)</span>}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div style={{ color: 'var(--globant-muted)', fontSize: 13 }}>
                {isAdmin ? 'No company goal set yet. Click Edit to define your target.' : 'No company goal set by admin yet.'}
              </div>
            )}
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>✏️ Edit Company Goal</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'block', marginBottom: 4 }}>Goal Name</label>
                <input style={{ ...sStyle, width: '100%' }} value={goalForm.name} onChange={e => setGoalForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Q2 2026 Revenue Target" />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'block', marginBottom: 4 }}>Target Amount (€)</label>
                <input style={{ ...sStyle, width: '100%' }} type="number" value={goalForm.target} onChange={e => setGoalForm(p => ({ ...p, target: e.target.value }))} placeholder="1000000" />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'block', marginBottom: 4 }}>Start Date</label>
                <input style={{ ...sStyle, width: '100%' }} type="date" value={goalForm.startDate} onChange={e => setGoalForm(p => ({ ...p, startDate: e.target.value }))} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'block', marginBottom: 4 }}>Deadline</label>
                <input style={{ ...sStyle, width: '100%' }} type="date" value={goalForm.deadline} onChange={e => setGoalForm(p => ({ ...p, deadline: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={saveGoal} disabled={savingGoal}>{savingGoal ? '⏳ Saving...' : '💾 Save Goal'}</button>
              <button className="action-btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setEditingGoal(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* ─── AI EXECUTIVE SUMMARY ─── */}
      <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid #a78bfa' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: aiSummary ? 12 : 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>🧠</span>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: '#a78bfa' }}>AI Executive Summary</span>
          </div>
          <button className="action-btn" style={{ fontSize: 11, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)' }}
            onClick={generateAiSummary} disabled={loadingAiSummary}>
            {loadingAiSummary ? '⏳ Analyzing...' : aiSummary ? '🔄 Refresh' : '✨ Generate Summary'}
          </button>
        </div>
        {aiSummary && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {aiSummary.split('\n').filter(l => l.trim()).map((line, i) => (
              <div key={i} style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--globant-text)', padding: '4px 0',
                borderBottom: i < aiSummary.split('\n').filter(l => l.trim()).length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                {line.replace(/^[-•*]\s*/, '')}
              </div>
            ))}
          </div>
        )}
        {!aiSummary && !loadingAiSummary && (
          <div style={{ fontSize: 12, color: 'var(--globant-muted)', marginTop: 8 }}>
            Click "Generate Summary" to get an AI-written executive brief of where things stand right now.
          </div>
        )}
      </div>

      {/* ─── VELOCITY + REPLY RATE + AT RISK ─── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 20 }}>
        <div className="card" style={{ padding: '16px', borderLeft: `3px solid ${velocityDelta >= 0 ? '#4ade80' : '#ef4444'}` }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>⚡ Outreach Velocity</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: velocityDelta >= 0 ? '#4ade80' : '#ef4444', lineHeight: 1 }}>{thisWeekTouches}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 4 }}>touches this week</div>
          <div style={{ fontSize: 11, marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ color: velocityDelta >= 0 ? '#4ade80' : '#ef4444', fontWeight: 700 }}>
              {velocityDelta >= 0 ? '↑' : '↓'} {Math.abs(velocityDelta)} {velocityPct !== null ? `(${velocityPct > 0 ? '+' : ''}${velocityPct}%)` : ''}
            </span>
            <span style={{ color: 'var(--globant-muted)' }}>vs last week ({lastWeekTouches})</span>
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 3, alignItems: 'flex-end', height: 32 }}>
            {monthlyTrend.map(m => (
              <div key={m.key} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <div style={{ width: '100%', height: Math.max(4, Math.round((m.count / monthlyMax) * 28)), background: '#a78bfa', borderRadius: '2px 2px 0 0', opacity: 0.7 }} />
                <div style={{ fontSize: 8, color: 'var(--globant-muted)' }}>{m.label}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ padding: '16px', borderLeft: `3px solid ${replyRateBenchColor}` }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>💬 Reply Rate</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: replyRateBenchColor, lineHeight: 1 }}>{overviewReplyRate}%</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 4 }}>{overviewReplied} replies / {outreach.length} touches</div>
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3 }}>
              <span>vs benchmark</span>
              <span>{BENCH_REPLY_LOW}–{BENCH_REPLY_HIGH}%</span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--globant-darker)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.min(100, (overviewReplyRate / BENCH_REPLY_HIGH) * 100)}%`, background: replyRateBenchColor, borderRadius: 3, transition: 'width 0.5s' }} />
            </div>
          </div>
          <div style={{ marginTop: 8, fontSize: 10, fontWeight: 700, color: replyRateBenchColor }}>
            {overviewReplyRate >= BENCH_REPLY_HIGH ? '🟢 Above benchmark' : overviewReplyRate >= BENCH_REPLY_LOW ? '🟡 On benchmark' : '🔴 Below benchmark'}
          </div>
        </div>

        <div className="card" style={{ padding: '16px', borderLeft: `3px solid ${atRiskOpps.length > 0 ? '#ef4444' : '#4ade80'}` }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>⚠️ Pipeline at Risk</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: atRiskOpps.length > 0 ? '#ef4444' : '#4ade80', lineHeight: 1 }}>{atRiskOpps.length}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 4 }}>
            {atRiskOpps.length > 0 ? `${formatCurrency(atRiskValue)} at risk` : 'All deals active'}
          </div>
          {atRiskOpps.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {atRiskOpps.slice(0, 3).map(o => {
                const accName = resolveLinked(o, 'Account', accounts, 'Account Name')[0] || '?';
                const isOverdue = o.fields?.['Close date'] && new Date(o.fields['Close date']) < new Date();
                return (
                  <div key={o.id} style={{ fontSize: 10, color: 'var(--globant-muted)', display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>{F(o, 'Deal/Opp name') || accName}</span>
                    <span style={{ color: isOverdue ? '#ef4444' : '#fbbf24', fontWeight: 600 }}>{isOverdue ? '⏰ Overdue' : '😴 Stale'}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ─── COMPANY KPIs ─── */}
      <div style={{ marginBottom: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--globant-muted)' }}>Company Performance</div>
      <div className="kpi-row" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 20 }}>
        <div className="kpi-card">
          <div className="kpi-label">Meetings Booked</div>
          <div className="kpi-value" style={{ color: '#4ade80' }}>{allMeetings.length}</div>
          <div className="kpi-sub">all time</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Deals Won</div>
          <div className="kpi-value" style={{ color: '#BFD730' }}>{wonOpps.length}</div>
          <div className="kpi-sub">{formatCurrency(wonValue)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Active Pipeline</div>
          <div className="kpi-value" style={{ fontSize: activePipeline > 999999999 ? 18 : 26 }}>{formatCurrency(activePipeline)}</div>
          <div className="kpi-sub">{activeOpps.length} open opps</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Active Accounts</div>
          <div className="kpi-value" style={{ color: '#60a5fa' }}>{activeAccounts.length}</div>
          <div className="kpi-sub">of {accounts.length} total</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Accounts Mapped</div>
          <div className="kpi-value">{mappedAccounts.length}</div>
          <div className="kpi-sub">of {accounts.length} total</div>
        </div>
      </div>

      {/* ─── PERSONAL KPIs (only when targets set) ─── */}
      {(myMeetingsTarget > 0 || myDealsTarget > 0) && (
        <>
          <div style={{ marginBottom: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--globant-muted)' }}>Your KPIs</div>
          <div className="kpi-row" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 20 }}>
            <div className="kpi-card" style={{ borderBottom: `3px solid ${kpiColor(kpiPct(myMeetings.length, myMeetingsTarget))}` }}>
              <div className="kpi-label">My Meetings</div>
              <div className="kpi-value" style={{ color: kpiColor(kpiPct(myMeetings.length, myMeetingsTarget)) }}>{myMeetings.length}</div>
              <div className="kpi-sub">target: {myMeetingsTarget} · {kpiPct(myMeetings.length, myMeetingsTarget) ?? 0}%</div>
              {myMeetingsTarget > 0 && <div style={{ height: 4, borderRadius: 2, background: 'var(--globant-darker)', overflow: 'hidden', marginTop: 8 }}>
                <div style={{ height: '100%', width: `${kpiPct(myMeetings.length, myMeetingsTarget) ?? 0}%`, background: kpiColor(kpiPct(myMeetings.length, myMeetingsTarget)), borderRadius: 2, transition: 'width 0.5s' }} />
              </div>}
            </div>
            <div className="kpi-card" style={{ borderBottom: `3px solid ${kpiColor(kpiPct(myDealsWon.length, myDealsTarget))}` }}>
              <div className="kpi-label">My Deals Won</div>
              <div className="kpi-value" style={{ color: kpiColor(kpiPct(myDealsWon.length, myDealsTarget)) }}>{myDealsWon.length}</div>
              <div className="kpi-sub">target: {myDealsTarget} · {kpiPct(myDealsWon.length, myDealsTarget) ?? 0}%</div>
              {myDealsTarget > 0 && <div style={{ height: 4, borderRadius: 2, background: 'var(--globant-darker)', overflow: 'hidden', marginTop: 8 }}>
                <div style={{ height: '100%', width: `${kpiPct(myDealsWon.length, myDealsTarget) ?? 0}%`, background: kpiColor(kpiPct(myDealsWon.length, myDealsTarget)), borderRadius: 2, transition: 'width 0.5s' }} />
              </div>}
            </div>
          </div>
        </>
      )}

      {/* ─── TEAM KPIs TABLE ─── */}
      {users.filter(u => F(u, 'Name') || F(u, 'Email')).length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <h3>👥 Team Performance</h3>
            {isAdmin && <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Click ✏️ to set KPI targets per person</span>}
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th style={{ textAlign: 'center' }}>Meetings</th>
                <th style={{ textAlign: 'center' }}>Target</th>
                <th style={{ textAlign: 'center' }}>Deals Won</th>
                <th style={{ textAlign: 'center' }}>Target</th>
                {isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {users.filter(u => F(u, 'Name') || F(u, 'Email')).map(u => {
                const uName = F(u, 'Name') || '';
                const uEmail = F(u, 'Email') || '';
                const uRole = (() => { const r = F(u, 'Role'); return (typeof r === 'object' ? r?.name : r) || '—'; })();
                const uMeetings = allMeetings.filter(o => { const lb = F(o, 'Logged By'); return lb && (lb === uName || lb === uEmail); }).length;
                const uDealsWon = wonOpps.filter(opp => linkedIds(opp, 'Account').some(accId => {
                  const acc = accounts.find(a => a.id === accId);
                  return acc && (linkedIds(acc, 'BDR').includes(u.id) || linkedIds(acc, 'CP').includes(u.id));
                })).length;
                const uMeetTarget = u.fields?.['KPI Meetings Target'] || 0;
                const uDealTarget = u.fields?.['KPI Deals Target'] || 0;
                const mPct = kpiPct(uMeetings, uMeetTarget);
                const dPct = kpiPct(uDealsWon, uDealTarget);
                const isMe = u.id === currentUserId;
                const isEditing = editingKpiId === u.id;
                return (
                  <React.Fragment key={u.id}>
                    <tr style={{ background: isMe ? 'rgba(191,215,48,0.04)' : undefined }}>
                      <td style={{ fontWeight: isMe ? 700 : 400 }}>
                        {uName || <span style={{ color: 'var(--globant-muted)', fontStyle: 'italic' }}>Pending activation</span>}
                        {isMe && <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(191,215,48,0.2)', color: '#BFD730' }}>you</span>}
                      </td>
                      <td><span className="badge badge-blue">{uRole}</span></td>
                      <td style={{ textAlign: 'center', fontWeight: 600, color: kpiColor(mPct) }}>
                        {uMeetings}{mPct !== null && <span style={{ fontSize: 10, color: 'var(--globant-muted)', fontWeight: 400 }}> ({mPct}%)</span>}
                      </td>
                      <td style={{ textAlign: 'center', color: 'var(--globant-muted)' }}>{uMeetTarget || '—'}</td>
                      <td style={{ textAlign: 'center', fontWeight: 600, color: kpiColor(dPct) }}>
                        {uDealsWon}{dPct !== null && <span style={{ fontSize: 10, color: 'var(--globant-muted)', fontWeight: 400 }}> ({dPct}%)</span>}
                      </td>
                      <td style={{ textAlign: 'center', color: 'var(--globant-muted)' }}>{uDealTarget || '—'}</td>
                      {isAdmin && (
                        <td style={{ textAlign: 'right' }}>
                          {!isEditing
                            ? <button className="action-btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => openEditKpi(u)}>✏️ Set targets</button>
                            : <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>editing ↓</span>}
                        </td>
                      )}
                    </tr>
                    {isAdmin && isEditing && (
                      <tr style={{ background: 'rgba(167,139,250,0.05)' }}>
                        <td colSpan={7} style={{ padding: '10px 12px' }}>
                          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12, fontWeight: 600 }}>KPI targets for {uName || 'this user'}:</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <label style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Meetings:</label>
                              <input style={{ ...sStyle, width: 80 }} type="number" min="0" value={kpiForm.meetings} onChange={e => setKpiForm(p => ({ ...p, meetings: e.target.value }))} placeholder="0" />
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <label style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Deals:</label>
                              <input style={{ ...sStyle, width: 80 }} type="number" min="0" value={kpiForm.deals} onChange={e => setKpiForm(p => ({ ...p, deals: e.target.value }))} placeholder="0" />
                            </div>
                            <button className="action-btn btn-primary" style={{ fontSize: 11 }} onClick={saveKpi} disabled={savingKpi}>{savingKpi ? '⏳' : '💾 Save'}</button>
                            <button className="action-btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setEditingKpiId(null)}>Cancel</button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── Conversion Funnel + Weighted Forecast ─── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="card-header"><h3>🎯 Conversion Funnel</h3></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {funnelSteps.map((step, i) => {
              const pct = Math.round((step.value / funnelMax) * 100);
              const conv = i > 0 && funnelSteps[i-1].value > 0 ? Math.round((step.value / funnelSteps[i-1].value) * 100) : null;
              return (
                <div key={step.label}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                    <span style={{ fontSize: 12, color: 'var(--globant-muted)', width: 90 }}>{step.label}</span>
                    <div style={{ flex: 1, height: 22, background: 'var(--globant-darker)', borderRadius: 4, overflow: 'hidden', margin: '0 10px' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: step.color, borderRadius: 4, transition: 'width 0.5s', display: 'flex', alignItems: 'center', paddingLeft: 6 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#000', whiteSpace: 'nowrap' }}>{step.value > 0 ? step.value : ''}</span>
                      </div>
                    </div>
                    {conv !== null ? (
                      <span style={{ fontSize: 10, color: conv >= 50 ? '#4ade80' : conv >= 25 ? '#f59e0b' : '#ef4444', fontWeight: 700, width: 36, textAlign: 'right' }}>{conv}%</span>
                    ) : <span style={{ width: 36 }} />}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--globant-muted)' }}>% = conversion from previous stage</div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3>📊 Weighted Pipeline Forecast</h3>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--globant-green)' }}>{formatCurrency(totalWeighted)}</span>
          </div>
          {forecastStages.length === 0 ? (
            <p style={{ color: 'var(--globant-muted)', fontSize: 12 }}>No active opportunities</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {forecastStages.map(([stage, stageData]) => {
                const prob = Math.round((stageData.prob || 0) * 100);
                const stageColor = prob >= 70 ? '#4ade80' : prob >= 40 ? '#f59e0b' : '#60a5fa';
                return (
                  <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 90, fontSize: 11, color: 'var(--globant-muted)', flexShrink: 0 }}>{stage}</div>
                    <div style={{ flex: 1, height: 18, background: 'var(--globant-darker)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${prob}%`, background: stageColor, opacity: 0.7, borderRadius: 4 }} />
                    </div>
                    <span style={{ fontSize: 10, color: stageColor, fontWeight: 700, width: 32, textAlign: 'right' }}>{prob}%</span>
                    <span style={{ fontSize: 11, color: 'var(--globant-text)', width: 60, textAlign: 'right' }}>{formatCurrency(stageData.raw)}</span>
                    <span style={{ fontSize: 11, color: 'var(--globant-green)', width: 60, textAlign: 'right', fontWeight: 600 }}>→ {formatCurrency(stageData.weighted)}</span>
                    <span style={{ fontSize: 10, color: 'var(--globant-muted)', width: 20, textAlign: 'center' }}>{stageData.count}</span>
                  </div>
                );
              })}
              <div style={{ marginTop: 6, paddingTop: 8, borderTop: '1px solid var(--globant-border)', display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--globant-muted)' }}>Raw pipeline: <strong style={{ color: 'var(--globant-text)' }}>{formatCurrency(activePipeline)}</strong></span>
                <span style={{ color: 'var(--globant-muted)' }}>Weighted: <strong style={{ color: 'var(--globant-green)' }}>{formatCurrency(totalWeighted)}</strong></span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── Activity Heatmap + Focus Accounts ─── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="card-header">
            <h3>🔥 Activity Heatmap <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--globant-muted)' }}>last 28 days</span></h3>
            <span style={{ fontSize: 12, color: 'var(--globant-muted)' }}>{Object.values(heatmapData).reduce((s, v) => s + v, 0)} touches</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(28, 1fr)', gap: 3 }}>
            {heatmapDaysList.map(day => {
              const intensity = day.count === 0 ? 0 : Math.min(1, day.count / heatmapMax);
              const bg = day.count === 0 ? 'var(--globant-darker)' : `rgba(91,191,181,${0.15 + intensity * 0.85})`;
              return (
                <div key={day.key} title={`${day.label}: ${day.count} activities`}
                  style={{ aspectRatio: '1', borderRadius: 3, background: bg, cursor: 'default', transition: 'transform 0.1s' }}
                  onMouseEnter={e => e.target.style.transform = 'scale(1.3)'}
                  onMouseLeave={e => e.target.style.transform = 'scale(1)'}
                />
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 10, color: 'var(--globant-muted)' }}>
            <span>{heatmapDaysList[0]?.label}</span>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span>Less</span>
              {[0.1, 0.3, 0.6, 1].map(v => <div key={v} style={{ width: 10, height: 10, borderRadius: 2, background: `rgba(91,191,181,${v})` }} />)}
              <span>More</span>
            </div>
            <span>Today</span>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><h3>🎯 Focus Now <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--globant-muted)' }}>top 3 accounts to act on today</span></h3></div>
          {focusAccounts.length === 0 ? (
            <p style={{ color: 'var(--globant-muted)', fontSize: 12 }}>Add accounts to see recommendations</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {focusAccounts.map(({ a, daysSince, reason, openOppCount, hasReply, hasMeeting }, i) => {
                const medals = ['🥇', '🥈', '🥉'];
                const stCount = linkedIds(a, 'Stakeholders').length;
                const urgencyColor = openOppCount > 0 ? '#4ade80' : hasReply ? '#f59e0b' : '#60a5fa';
                return (
                  <div key={a.id} style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--globant-darker)', borderLeft: `3px solid ${urgencyColor}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{medals[i]} {F(a, 'Account Name')}</div>
                      <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 3, display: 'flex', gap: 8 }}>
                        <span>{F(a, 'Industry') || '—'}</span>
                        <span>{stCount} contacts</span>
                        {daysSince < 999 && <span style={{ color: daysSince > 14 ? '#ef4444' : '#60a5fa' }}>{daysSince}d ago</span>}
                      </div>
                      <div style={{ fontSize: 11, marginTop: 4, color: urgencyColor, fontWeight: 600 }}>→ {reason}</div>
                    </div>
                    <div style={{ fontSize: 20 }}>{openOppCount > 0 ? '💰' : hasMeeting ? '📅' : hasReply ? '💬' : '📬'}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ─── Coverage Quality + Monthly Trend ─── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card" style={{ borderLeft: '3px solid #60a5fa' }}>
          <div className="card-header"><h3>🗺️ Account Coverage Quality</h3></div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 12 }}>{mappedAccounts.length} mapped accounts</div>
          {coverageItems.map(item => {
            const pct = mappedAccounts.length > 0 ? Math.round((item.count / mappedAccounts.length) * 100) : 0;
            return (
              <div key={item.label} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: 'var(--globant-muted)' }}>{item.label}</span>
                  <span style={{ fontWeight: 700, color: item.color }}>{item.count} <span style={{ color: 'var(--globant-muted)', fontWeight: 400 }}>({pct}%)</span></span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: 'var(--globant-darker)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: item.color, borderRadius: 4, opacity: 0.8, transition: 'width 0.5s' }} />
                </div>
              </div>
            );
          })}
          {mappedAccounts.length === 0 && <p style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>No mapped accounts yet.</p>}
        </div>

        <div className="card" style={{ borderLeft: '3px solid #fbbf24' }}>
          <div className="card-header"><h3>📅 Monthly Outreach Trend</h3></div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', height: 120, padding: '0 4px' }}>
            {monthlyTrend.map(m => {
              const barH = Math.max(4, Math.round((m.count / monthlyMax) * 90));
              const replyBarH = m.count > 0 ? Math.round((m.replied / m.count) * barH) : 0;
              return (
                <div key={m.key} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-text)' }}>{m.count}</div>
                  <div style={{ width: '100%', height: barH, borderRadius: '4px 4px 0 0', background: 'rgba(96,165,250,0.25)', position: 'relative', overflow: 'hidden' }}>
                    <div style={{ position: 'absolute', bottom: 0, width: '100%', height: replyBarH, background: '#4ade80', opacity: 0.7 }} />
                    <div style={{ position: 'absolute', top: 0, width: '100%', height: barH - replyBarH, background: '#60a5fa', opacity: 0.4 }} />
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>{m.label}</div>
                  {m.replied > 0 && <div style={{ fontSize: 9, color: '#4ade80', fontWeight: 600 }}>{m.replied}💬</div>}
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 12, fontSize: 10, color: 'var(--globant-muted)' }}>
            <span><span style={{ color: '#60a5fa' }}>█</span> Touches</span>
            <span><span style={{ color: '#4ade80' }}>█</span> Replies</span>
          </div>
        </div>
      </div>

      {/* ─── Pipeline at Risk (full table, only if any) ─── */}
      {atRiskOpps.length > 0 && (
        <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid #ef4444' }}>
          <div className="card-header">
            <h3>⚠️ Pipeline at Risk ({atRiskOpps.length})</h3>
            <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 600 }}>{formatCurrency(atRiskValue)} needs attention</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Deal</th><th>Account</th><th>Stage</th><th>Value</th><th>Issue</th>
              </tr>
            </thead>
            <tbody>
              {atRiskOpps.map(o => {
                const accName = resolveLinked(o, 'Account', accounts, 'Account Name')[0] || '—';
                const isOverdue = o.fields?.['Close date'] && new Date(o.fields['Close date']) < new Date();
                const accIds = linkedIds(o, 'Account');
                const lastAct = outreach.filter(act => accIds.some(id => linkedIds(act, 'Account').includes(id)))
                  .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0))[0];
                const daysSince = lastAct ? Math.floor((new Date() - new Date(lastAct.fields?.['Date'])) / 86400000) : null;
                return (
                  <tr key={o.id}>
                    <td style={{ fontWeight: 600 }}>{F(o, 'Deal/Opp name') || '—'}</td>
                    <td>{accName}</td>
                    <td><span className="badge badge-blue">{F(o, 'Stage') || '—'}</span></td>
                    <td>{formatCurrency(o.fields?.['Value'])}</td>
                    <td>
                      {isOverdue && <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 600 }}>⏰ Close date passed</span>}
                      {!isOverdue && daysSince !== null && <span style={{ fontSize: 11, color: '#fbbf24', fontWeight: 600 }}>😴 {daysSince}d no activity</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── Status Breakdown + Upcoming Events ─── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="card-header"><h3>Account Status Breakdown</h3></div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {Object.entries(statusCounts).sort((a, b) => b[1] - a[1]).map(([status, count]) => {
              const color = status === 'Active' || status === 'Activo' ? 'badge-green' :
                            status === 'Won' ? 'badge-accent' :
                            status === 'Lost' ? 'badge-red' :
                            status === 'Dormant' ? 'badge-yellow' : 'badge-blue';
              return (
                <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'var(--globant-darker)', borderRadius: 8 }}>
                  <span className={`badge ${color}`}>{status}</span>
                  <span style={{ fontSize: 20, fontWeight: 700 }}>{count}</span>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 16, fontSize: 12, color: 'var(--globant-muted)' }}>
            {unmappedAccounts.length} accounts still need stakeholder mapping
          </div>
        </div>

        <div className="card">
          <div className="card-header"><h3>Upcoming Events</h3></div>
          {upcomingEvents.length === 0 && <p style={{ color: 'var(--globant-muted)', fontSize: 13 }}>No upcoming events</p>}
          {upcomingEvents.map(ev => {
            const start = ev.fields?.['Starting'];
            const end = ev.fields?.['End date'];
            const invitedCount = linkedIds(ev, 'Stakeholders invited').length;
            return (
              <div key={ev.id} className="log-entry">
                <div className="log-icon" style={{ background: 'rgba(96,165,250,0.15)' }}>📅</div>
                <div className="log-content">
                  <div className="log-title">{F(ev, 'Event Name')}</div>
                  <div className="log-meta">{formatDate(start)}{end && end !== start ? ` — ${formatDate(end)}` : ''} · {invitedCount} stakeholders invited</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── Top Mapped Accounts ─── */}
      <div className="card">
        <div className="card-header"><h3>Top Mapped Accounts</h3></div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Account</th><th>Industry</th><th>Status</th>
              <th style={{ textAlign: 'center' }}>Stakeholders</th>
              <th style={{ textAlign: 'center' }}>Contacted</th>
              <th style={{ textAlign: 'center' }}>Opps</th>
              <th>Offering</th>
            </tr>
          </thead>
          <tbody>
            {topAccounts.map(acc => {
              const name = F(acc, 'Account Name');
              const stIds = linkedIds(acc, 'Stakeholders');
              const contactedCount = stIds.filter(id => contactedStakeholderIds.has(id)).length;
              const oppCount = linkedIds(acc, 'Opportunities').length;
              const solNames = resolveLinked(acc, 'Solutions', solutions, 'Name');
              const status = F(acc, 'Inside Sales Status');
              const statusColor = status === 'Active' || status === 'Activo' ? 'badge-green' :
                                  status === 'Won' ? 'badge-accent' :
                                  status === 'Lost' ? 'badge-red' : 'badge-yellow';
              return (
                <tr key={acc.id}>
                  <td style={{ fontWeight: 600 }}>{name}</td>
                  <td style={{ fontSize: 12 }}>{F(acc, 'Industry')}</td>
                  <td>{status && <span className={`badge ${statusColor}`}>{status}</span>}</td>
                  <td style={{ textAlign: 'center' }}>{stIds.length}</td>
                  <td style={{ textAlign: 'center' }}>
                    <span style={{ color: contactedCount > 0 ? 'var(--globant-success)' : 'var(--globant-warning)' }}>{contactedCount}/{stIds.length}</span>
                  </td>
                  <td style={{ textAlign: 'center' }}>{oppCount}</td>
                  <td style={{ fontSize: 11 }}>{solNames.length > 0 ? solNames.join(', ') : <span style={{ color: 'var(--globant-muted)' }}>—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ─── Active Pipeline ─── */}
      <div className="card">
        <div className="card-header"><h3>Active Pipeline ({activeOpps.length} opportunities)</h3></div>
        <table className="data-table">
          <thead>
            <tr><th>Deal</th><th>Account</th><th>Stage</th><th>Value</th><th>Probability</th><th>Next Step</th></tr>
          </thead>
          <tbody>
            {activeOpps.sort((a, b) => (b.fields?.['Value'] || 0) - (a.fields?.['Value'] || 0)).slice(0, 15).map(opp => (
              <tr key={opp.id}>
                <td style={{ fontWeight: 600 }}>{F(opp, 'Deal/Opp name')}</td>
                <td>{resolveLinked(opp, 'Account', accounts, 'Account Name').join(', ')}</td>
                <td><span className="badge badge-blue">{F(opp, 'Stage')}</span></td>
                <td>{formatCurrency(opp.fields?.['Value'])}</td>
                <td>{opp.fields?.['Close probability (%)'] ? Math.round(opp.fields['Close probability (%)'] * 100) + '%' : '—'}</td>
                <td style={{ fontSize: 12, color: 'var(--globant-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{F(opp, 'Next step') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============ AI MESSAGE MODAL ============

export default StrategyOverview;
