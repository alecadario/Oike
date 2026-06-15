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


function InsightsView({ data }) {
  const { accounts, stakeholders, opportunities, actionPlan, outreach, solutions, events, strategy = [], users = [] } = data;
  const isAdmin = CURRENT_USER?.role === 'admin';
  const strategyRecord = strategy[0] || null;
  const goalName = strategyRecord ? (F(strategyRecord, 'Goal Name') || '') : '';
  const goalTarget = strategyRecord ? (strategyRecord.fields?.['Target Amount'] || 0) : 0;
  const goalDeadline = strategyRecord ? (F(strategyRecord, 'Deadline') || '') : '';
  const now = new Date();
  const [timePeriod, setTimePeriod] = useState('all');

  // ─── VIEW SELECTOR (admin = company or per-user; others = own only) ───
  const currentUserRecord = users.find(u => (F(u, 'Email') || '').toLowerCase() === (CURRENT_USER?.email || '').toLowerCase());
  const currentUserId = currentUserRecord?.id;
  const [insightsView, setInsightsView] = useState(isAdmin ? 'company' : (currentUserRecord?.id || 'me'));
  const [aiProjection, setAiProjection] = useState('');
  const [loadingProjection, setLoadingProjection] = useState(false);

  const meetingStatuses = ['Meeting Scheduled', 'Meeting Booked'];
  const wonOppsAll = opportunities.filter(o => WON_STAGES.includes(F(o, 'Stage')));

  // Selected user for personal view
  const selectedUserRecord = insightsView === 'company' ? null : (users.find(u => u.id === insightsView) || currentUserRecord);
  const viewName = selectedUserRecord ? (F(selectedUserRecord, 'Name') || F(selectedUserRecord, 'Email') || 'User') : 'Company';
  const viewMeetingsTarget = selectedUserRecord ? (selectedUserRecord.fields?.['KPI Meetings Target'] || 0) : 0;
  const viewDealsTarget = selectedUserRecord ? (selectedUserRecord.fields?.['KPI Deals Target'] || 0) : 0;

  // Activities for selected view
  const viewActivities = insightsView === 'company' ? outreach : outreach.filter(o => {
    const lb = F(o, 'Logged By');
    const uName = F(selectedUserRecord, 'Name') || '';
    const uEmail = F(selectedUserRecord, 'Email') || '';
    // Also match against CURRENT_USER JWT name/email for the current user's own view
    const cuName = insightsView === currentUserId ? (CURRENT_USER?.name || '') : '';
    const cuEmail = insightsView === currentUserId ? (CURRENT_USER?.email || '') : '';
    return lb && (lb === uName || lb === uEmail || (cuName && lb === cuName) || (cuEmail && lb === cuEmail));
  });
  const viewMeetings = viewActivities.filter(o => meetingStatuses.includes(F(o, 'Status')));

  // Deals won for selected view
  const viewDealsWon = insightsView === 'company'
    ? wonOppsAll.length
    : wonOppsAll.filter(opp => selectedUserRecord && linkedIds(opp, 'Account').some(accId => {
        const acc = accounts.find(a => a.id === accId);
        return acc && (linkedIds(acc, 'BDR').includes(selectedUserRecord.id) || linkedIds(acc, 'CP').includes(selectedUserRecord.id));
      })).length;

  // ─── VELOCITY (last 4 weeks) ───
  const fourWeeksAgo = new Date(); fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  const recentActivities = viewActivities.filter(o => { const d = o.fields?.['Date']; return d && new Date(d) >= fourWeeksAgo; });
  const recentMeetingsCount = recentActivities.filter(o => meetingStatuses.includes(F(o, 'Status'))).length;
  const activitiesPerWeek = recentActivities.length / 4;
  const meetingConvRate = recentActivities.length > 0 ? recentMeetingsCount / recentActivities.length : 0;

  // ─── GAP ANALYSIS ───
  const meetingsGap = Math.max(0, viewMeetingsTarget - viewMeetings.length);
  const activitiesNeeded = meetingConvRate > 0 ? Math.ceil(meetingsGap / meetingConvRate) : null;
  const weeksToTarget = activitiesPerWeek > 0 && activitiesNeeded !== null ? (activitiesNeeded / activitiesPerWeek) : null;
  const dealsGap = Math.max(0, viewDealsTarget - viewDealsWon);
  const meetingsToDealRate = viewMeetings.length > 0 ? viewDealsWon / viewMeetings.length : 0;
  const meetingsNeededForDeals = meetingsToDealRate > 0 ? Math.ceil(dealsGap / meetingsToDealRate) : null;

  // ─── AI PROJECTION ───
  const generateProjection = async () => {
    setLoadingProjection(true);
    try {
      const deadlineDays = goalDeadline ? Math.ceil((new Date(goalDeadline) - new Date()) / (1000*60*60*24)) : null;
      const chBenchContext = channelReplyStats.filter(r => r.count >= 5 && r.bench).map(r => `${r.ch}: ${r.rate}% reply (benchmark: ${r.bench.acceptable}–${r.bench.good}%+)`).join('; ');
      const todayMs = Date.now();

      // ── Recent outreach with timing + content ──
      const last30 = viewActivities
        .filter(o => { const d = o.fields?.['Date']; return d && (todayMs - new Date(d).getTime()) <= 30*24*60*60*1000; })
        .sort((a,b) => new Date(b.fields?.['Date']||0) - new Date(a.fields?.['Date']||0));

      // Messages sent in last 7 days (likely still within reply window)
      const last7 = last30.filter(o => (todayMs - new Date(o.fields?.['Date']||0).getTime()) <= 7*24*60*60*1000);
      const pending7 = last7.filter(o => !['Replied','Meeting Scheduled','Meeting Booked'].includes(F(o,'Status')));
      const replied7 = last7.filter(o => ['Replied','Meeting Scheduled','Meeting Booked'].includes(F(o,'Status')));

      // Messages 8-30 days old (should have replied by now)
      const stale = last30.filter(o => {
        const daysAgo = (todayMs - new Date(o.fields?.['Date']||0).getTime()) / (24*60*60*1000);
        return daysAgo > 7 && !['Replied','Meeting Scheduled','Meeting Booked'].includes(F(o,'Status'));
      });

      // Avg days to reply (from replied records with dates)
      const repliedWithDates = viewActivities.filter(o => ['Replied'].includes(F(o,'Status')) && o.fields?.['Date']);
      const avgDaysToReply = repliedWithDates.length > 0
        ? (repliedWithDates.reduce((sum,o) => sum + (todayMs - new Date(o.fields['Date']).getTime())/(24*60*60*1000), 0) / repliedWithDates.length).toFixed(1)
        : null;

      // Sample recent message content (last 5, meaningful messages)
      const recentMsgSamples = last30
        .filter(o => (F(o,'Message')||'').length > 20)
        .slice(0, 5)
        .map(o => {
          const daysAgo = Math.round((todayMs - new Date(o.fields?.['Date']||0).getTime()) / (24*60*60*1000));
          const stkId = linkedIds(o,'Stakeholder')[0];
          const stk = stkId ? stakeholders.find(s => s.id === stkId) : null;
          const stkName = stk ? `${F(stk,'Name')||''} ${F(stk,'Last name')||''}`.trim() : '?';
          const accId = linkedIds(o,'Account')[0];
          const acc = accId ? accounts.find(a => a.id === accId) : null;
          const accName = acc ? F(acc,'Account Name') : '';
          const msg = (F(o,'Message')||'').slice(0, 180);
          return `[${daysAgo}d ago · ${F(o,'Channel')||'?'} · ${F(o,'Status')||'Sent'} · ${stkName}${accName?' @ '+accName:''}]\n"${msg}${msg.length===180?'…':''}"`;
        }).join('\n\n');

      // Channels breakdown for last 30d
      const recentByChannel = {};
      last30.forEach(o => { const ch = F(o,'Channel')||'?'; recentByChannel[ch] = (recentByChannel[ch]||0)+1; });
      const channelBreakdown = Object.entries(recentByChannel).map(([ch,n]) => `${ch}: ${n}`).join(', ');

      const prompt = `You are a senior B2B sales coach reviewing ${viewName}'s outreach activity. Write a sharp, honest analysis in 5-7 sentences. Be specific, use the data, and name real patterns. No generic advice.

═══ GOALS & PIPELINE ═══
- Company goal: ${goalName || 'not set'}${goalTarget > 0 ? ` (€${goalTarget.toLocaleString()})` : ''}${deadlineDays !== null ? ` · ${deadlineDays} days left` : ''}
- Meetings target: ${viewMeetingsTarget} | Achieved: ${viewMeetings.length} | Gap: ${meetingsGap}
- Deals target: ${viewDealsTarget} | Won: ${viewDealsWon} | Gap: ${dealsGap}

═══ ACTIVITY VELOCITY ═══
- Last 4 weeks: ${activitiesPerWeek.toFixed(1)} activities/week
- Last 30 days channels: ${channelBreakdown || 'no data'}
- Channel reply rates vs benchmarks: ${chBenchContext || 'insufficient data'}
- Activities needed to close meetings gap: ${activitiesNeeded ?? 'insufficient data'}
- Weeks to hit target at current pace: ${weeksToTarget !== null ? weeksToTarget.toFixed(1) : 'insufficient data'}

═══ TIMING & REPLY CONTEXT ═══
- Messages sent last 7 days (still within normal reply window): ${last7.length}
  → ${pending7.length} pending (IMPORTANT: these are recent — it's normal not to have replies yet, do NOT count these as no-replies)
  → ${replied7.length} already replied/meeting booked
- Messages 8-30 days old with NO reply yet (legitimately stale): ${stale.length}
- Avg days to reply (from historical data): ${avgDaysToReply ? avgDaysToReply + ' days' : 'not enough data'}
${avgDaysToReply ? `- IMPORTANT: factor in this avg reply lag when assessing current pipeline health` : ''}

═══ RECENT MESSAGE CONTENT (last 5 sent) ═══
${recentMsgSamples || 'No message content available.'}

Your analysis must cover:
1. Pipeline health RIGHT NOW — accounting for the reply lag (recent messages are not yet stale)
2. Quality of the messages above — are the angles sharp? Too generic? Right length? Specific enough?
3. Whether the ${stale.length} stale no-replies suggest a messaging problem, wrong targets, or just volume
4. The ONE channel or ONE behavior to change this week for the biggest impact
5. Whether the current pace will hit the target — and by when if not

Write in English. Be direct. Quote specific numbers from the data above.`;

      const result = await callOpenAI({ prompt, max_tokens: 450, temperature: 0.65 });
      setAiProjection(result);
    } catch (e) {
      setAiProjection('Could not generate projection. Try again.');
    } finally {
      setLoadingProjection(false);
    }
  };

  // ─── TIME FILTER ───
  const getDateThreshold = () => {
    if (timePeriod === '7d') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (timePeriod === '30d') return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (timePeriod === 'year') return new Date(now.getFullYear(), 0, 1);
    return null;
  };
  const threshold = getDateThreshold();
  const filterByDate = (records, dateField = 'Date') => {
    if (!threshold) return records;
    return records.filter(r => {
      const d = r.fields?.[dateField];
      return d && new Date(d) >= threshold;
    });
  };
  const filteredOutreach = filterByDate(outreach);
  const filteredOpps = filterByDate(opportunities, 'close date');
  const periodLabel = timePeriod === '7d' ? 'Last 7 Days' : timePeriod === '30d' ? 'Last 30 Days' : timePeriod === 'year' ? 'This Year' : 'All Time';

  // ─── LEAD SOURCE ANALYSIS (from Sources table) ───
  const sources = data.sources || [];
  // Group by Source category (e.g. "Outbound", "Inbound - Events")
  const sourceCatCount = {};
  sources.forEach(src => {
    const cat = F(src, 'Source') || 'Unknown';
    const catName = typeof cat === 'object' ? (cat.name || 'Unknown') : cat;
    const stkCount = linkedIds(src, 'Stakeholders').length;
    sourceCatCount[catName] = (sourceCatCount[catName] || 0) + stkCount;
  });
  const sourceCatSorted = Object.entries(sourceCatCount).sort((a, b) => b[1] - a[1]);
  const totalFromSources = Object.values(sourceCatCount).reduce((a, b) => a + b, 0);

  // Detail by Source Name (e.g. "Iata Event", "Tech Trends 2026")
  const sourceNameDetails = sources.map(src => {
    const name = F(src, 'Source Name') || 'Unknown';
    const cat = F(src, 'Source') || '';
    const catName = typeof cat === 'object' ? (cat.name || '') : cat;
    const stkIds = linkedIds(src, 'Stakeholders');
    const stkCount = stkIds.length;
    // Count how many of these stakeholders have outreach in period
    const activeCount = stkIds.filter(sid =>
      filteredOutreach.some(o => linkedIds(o, 'Stakeholder').includes(sid))
    ).length;
    return { name, category: catName, stakeholders: stkCount, active: activeCount };
  }).sort((a, b) => b.stakeholders - a.stakeholders);

  // Legacy compat
  const sourceSorted = sourceCatSorted;
  const totalSources = totalFromSources || stakeholders.length;

  // ─── ACCOUNT ANALYSIS ───
  const mappedAccounts = accounts.filter(a => linkedIds(a, 'Stakeholders').length > 0);
  const unmappedAccounts = accounts.filter(a => linkedIds(a, 'Stakeholders').length === 0);
  const accsWithSolutions = mappedAccounts.filter(a => linkedIds(a, 'Solutions').length > 0);
  const accsWithNews = mappedAccounts.filter(a => F(a, 'Recent News'));
  const accsWithPlan = mappedAccounts.filter(a => F(a, 'Inside sales plan'));

  // ─── STAKEHOLDER ANALYSIS ───
  const insightContactedIds = new Set();
  outreach.forEach(o => linkedIds(o, 'Stakeholder').forEach(id => insightContactedIds.add(id)));
  const contacted = stakeholders.filter(s => insightContactedIds.has(s.id));

  // ─── OUTREACH ANALYSIS ───
  const byChannel = {};
  const repliedByChannel = {};
  filteredOutreach.forEach(a => {
    const ch = F(a, 'Channel');
    byChannel[ch] = (byChannel[ch] || 0) + 1;
    if (F(a, 'Status') === 'Replied') repliedByChannel[ch] = (repliedByChannel[ch] || 0) + 1;
  });
  const totalOutreach = filteredOutreach.length;
  const topChannel = Object.entries(byChannel).sort((a, b) => b[1] - a[1])[0];
  const weakChannel = Object.entries(byChannel).sort((a, b) => a[1] - b[1])[0];

  // Per-channel reply rates with benchmark evaluation
  const channelReplyStats = Object.entries(byChannel).map(([ch, count]) => {
    const replied = repliedByChannel[ch] || 0;
    const rate = count > 0 ? Math.round((replied / count) * 100) : 0;
    const bench = CHANNEL_BENCHMARKS[ch] || null;
    let benchLabel = null, benchColor = null;
    if (bench && count >= 5) {
      if (rate >= bench.excellent) { benchLabel = `🟢 Excellent (>${bench.excellent}%)`; benchColor = '#4ade80'; }
      else if (rate >= bench.good) { benchLabel = `🟡 Good (${bench.good}–${bench.excellent}%)`; benchColor = '#fbbf24'; }
      else if (rate >= bench.acceptable) { benchLabel = `🟠 Acceptable (${bench.acceptable}–${bench.good}%)`; benchColor = '#fb923c'; }
      else { benchLabel = `🔴 Below baseline (<${bench.acceptable}%)`; benchColor = '#ef4444'; }
    }
    return { ch, count, replied, rate, bench, benchLabel, benchColor };
  }).sort((a, b) => b.count - a.count);

  // Accounts with outreach (in period)
  const accountsWithOutreach = new Set();
  filteredOutreach.forEach(a => linkedIds(a, 'Account').forEach(id => accountsWithOutreach.add(id)));
  const accountsNoOutreach = mappedAccounts.filter(a => !accountsWithOutreach.has(a.id));

  // Stakeholders with outreach (in period)
  const stakeholdersWithOutreach = new Set();
  filteredOutreach.forEach(a => linkedIds(a, 'Stakeholder').forEach(id => stakeholdersWithOutreach.add(id)));
  const stakeholdersNoOutreach = stakeholders.filter(s => !stakeholdersWithOutreach.has(s.id));

  // ─── OUTREACH BY STATUS (in period) ───
  const byStatus = {};
  filteredOutreach.forEach(o => { const st = F(o, 'Status') || 'Unknown'; byStatus[st] = (byStatus[st] || 0) + 1; });
  const repliedCount = byStatus['Replied'] || 0;
  const meetingCount = byStatus['Meeting Scheduled'] || 0;
  const bouncedCount = byStatus['Bounced'] || 0;
  const bouncedRate  = totalOutreach > 0 ? Math.round((bouncedCount / totalOutreach) * 100) : 0;
  const replyRate = totalOutreach > 0 ? Math.round((repliedCount / totalOutreach) * 100) : 0;
  const meetingRate = totalOutreach > 0 ? Math.round((meetingCount / totalOutreach) * 100) : 0;

  // Benchmarks
  const replyBench = replyRate >= BENCH_REPLY_HIGH ? { label: 'Above benchmark', color: '#4ade80', icon: '🟢' }
    : replyRate >= BENCH_REPLY_LOW ? { label: 'On benchmark', color: '#fbbf24', icon: '🟡' }
    : { label: `Below benchmark (${BENCH_REPLY_LOW}–${BENCH_REPLY_HIGH}%)`, color: '#f87171', icon: '🔴' };
  const meetingBench = meetingRate >= BENCH_MEETING_HIGH ? { label: 'Above benchmark', color: '#4ade80', icon: '🟢' }
    : meetingRate >= BENCH_MEETING_LOW ? { label: 'On benchmark', color: '#fbbf24', icon: '🟡' }
    : { label: `Below benchmark (${BENCH_MEETING_LOW}–${BENCH_MEETING_HIGH}%)`, color: '#f87171', icon: '🔴' };

  // Last contact per stakeholder
  const staleStakeholders = [];
  const recentStakeholders = [];
  stakeholders.forEach(s => {
    const so = outreach.filter(o => linkedIds(o, 'Stakeholder').includes(s.id))
      .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
    if (so.length > 0) {
      const days = Math.floor((now - new Date(so[0].fields?.['Date'])) / (1000*60*60*24));
      if (days > 14) staleStakeholders.push({ s, days, lastChannel: F(so[0], 'Channel') });
      else recentStakeholders.push({ s, days });
    }
  });

  // ─── PIPELINE ANALYSIS ───
  const closedWon = opportunities.filter(o => ['Closed Won','Closed/Won'].includes(F(o, 'Stage')));
  const closedLost = opportunities.filter(o => ['Closed Lost','Closed/Lost','Closed/Canceled'].includes(F(o, 'Stage')));
  const openOpps = opportunities.filter(o => !['Closed Won','Closed/Won','Closed Lost','Closed/Lost','Closed/Canceled'].includes(F(o, 'Stage')));
  const totalPipelineValue = openOpps.reduce((sum, o) => sum + (o.fields?.['Value'] || 0), 0);
  const wonValue = closedWon.reduce((sum, o) => sum + (o.fields?.['Value'] || 0), 0);
  const winRate = (closedWon.length + closedLost.length) > 0 ? Math.round((closedWon.length / (closedWon.length + closedLost.length)) * 100) : 0;

  // Stage distribution
  const stageCounts = {};
  opportunities.forEach(o => { const st = F(o, 'Stage') || 'Unknown'; stageCounts[st] = (stageCounts[st] || 0) + 1; });

  // ─── EVENTS ANALYSIS ───
  const upcomingEvents = events.filter(ev => {
    const start = ev.fields?.['Starting'] ? new Date(ev.fields['Starting']) : null;
    return start && start > now;
  });
  const pastEvents = events.filter(ev => {
    const start = ev.fields?.['Starting'] ? new Date(ev.fields['Starting']) : null;
    return start && start <= now;
  });

  // ─── ACCOUNT PERFORMANCE (outreach per account, filtered by period) ───
  const accountPerformance = mappedAccounts.map(a => {
    const aOutreach = filteredOutreach.filter(o => linkedIds(o, 'Account').includes(a.id));
    const aStakeholders = linkedIds(a, 'Stakeholders').length;
    const aOpps = opportunities.filter(o => linkedIds(o, 'Account').includes(a.id));
    const aOpenOpps = aOpps.filter(o => !['Closed Won','Closed/Won','Closed Lost','Closed/Lost','Closed/Canceled'].includes(F(o, 'Stage')));
    return {
      name: F(a, 'Account Name'),
      tier: F(a, 'Tier'),
      status: F(a, 'Inside Sales Status'),
      outreachCount: aOutreach.length,
      stakeholderCount: aStakeholders,
      oppCount: aOpps.length,
      openOppCount: aOpenOpps.length,
      pipelineValue: aOpenOpps.reduce((s, o) => s + (o.fields?.['Value'] || 0), 0),
      hasSolution: linkedIds(a, 'Solutions').length > 0,
    };
  }).sort((a, b) => b.outreachCount - a.outreachCount);

  // ─── GENERATE INSIGHTS ───
  const conclusions = [];
  const improvements = [];

  // Coverage
  const coveragePct = accounts.length > 0 ? Math.round((mappedAccounts.length / accounts.length) * 100) : 0;
  conclusions.push({ icon: '🗺️', title: 'Account Coverage', text: `${mappedAccounts.length} of ${accounts.length} accounts mapped (${coveragePct}%). ${unmappedAccounts.length > 0 ? `${unmappedAccounts.length} accounts still have no stakeholders.` : 'All accounts have stakeholders mapped.'}` });

  // Contact rate
  const contactPct = stakeholders.length > 0 ? Math.round((contacted.length / stakeholders.length) * 100) : 0;
  if (contactPct < 30) {
    conclusions.push({ icon: '📉', title: 'Low Contact Rate', text: `Only ${contactPct}% of stakeholders marked as contacted (${contacted.length}/${stakeholders.length}). Heavy lifting still needed.` });
  } else if (contactPct < 60) {
    conclusions.push({ icon: '📊', title: 'Moderate Contact Rate', text: `${contactPct}% of stakeholders contacted (${contacted.length}/${stakeholders.length}). Good progress but room to grow.` });
  } else {
    conclusions.push({ icon: '🟢', title: 'Strong Contact Rate', text: `${contactPct}% contacted (${contacted.length}/${stakeholders.length}). Solid execution on outreach.` });
  }

  // Channel effectiveness
  if (topChannel) {
    conclusions.push({ icon: '📡', title: 'Channel Mix', text: `${topChannel[0]} is the most used channel (${topChannel[1]} activities). ${weakChannel && weakChannel[0] !== topChannel[0] ? `${weakChannel[0]} is underused (${weakChannel[1]} only).` : ''}` });
  }

  // Pipeline
  conclusions.push({ icon: '💰', title: 'Pipeline Health', text: `${openOpps.length} open opportunities worth ${formatCurrency(totalPipelineValue)}. Win rate: ${winRate}% (${closedWon.length} won / ${closedLost.length} lost).${wonValue > 0 ? ` Total won: ${formatCurrency(wonValue)}.` : ''}${goalTarget > 0 ? ` Pipeline is at ${Math.round((totalPipelineValue / goalTarget) * 100)}% of your ${formatCurrency(goalTarget)} goal.` : ''}` });

  // Stale contacts
  if (staleStakeholders.length > 0) {
    improvements.push({ icon: '⏰', priority: 'high', title: 'Re-engage Stale Contacts', text: `${staleStakeholders.length} stakeholder${staleStakeholders.length > 1 ? 's' : ''} haven't been contacted in 14+ days. Top: ${staleStakeholders.sort((a,b) => b.days - a.days).slice(0, 3).map(x => `${F(x.s, 'Name')} (${x.days}d)`).join(', ')}.` });
  }

  // Unmapped accounts
  if (unmappedAccounts.length > 0) {
    improvements.push({ icon: '🗺️', priority: 'high', title: 'Map Remaining Accounts', text: `${unmappedAccounts.length} account${unmappedAccounts.length > 1 ? 's' : ''} have zero stakeholders: ${unmappedAccounts.slice(0, 5).map(a => F(a, 'Account Name')).join(', ')}${unmappedAccounts.length > 5 ? '...' : ''}.` });
  }

  // Accounts with stakeholders but no outreach
  if (accountsNoOutreach.length > 0) {
    improvements.push({ icon: '🚨', priority: 'high', title: 'Activate Mapped Accounts', text: `${accountsNoOutreach.length} mapped account${accountsNoOutreach.length > 1 ? 's' : ''} have zero outreach: ${accountsNoOutreach.slice(0, 4).map(a => F(a, 'Account Name')).join(', ')}${accountsNoOutreach.length > 4 ? '...' : ''}.` });
  }

  // Channel diversification
  if (topChannel && totalOutreach > 5) {
    const topPct = Math.round((topChannel[1] / totalOutreach) * 100);
    if (topPct > 65) {
      improvements.push({ icon: '📡', priority: 'medium', title: 'Diversify Channels', text: `${topPct}% of outreach is via ${topChannel[0]}. Multi-channel approach (Email + LinkedIn + WhatsApp) increases response rates. Try mixing in more ${weakChannel ? weakChannel[0] : 'other channels'}.` });
    }
  }

  // Events utilization
  if (upcomingEvents.length > 0) {
    const totalInvited = upcomingEvents.reduce((sum, ev) => sum + linkedIds(ev, 'Stakeholders invited').length, 0);
    improvements.push({ icon: '🎫', priority: 'medium', title: 'Leverage Events', text: `${upcomingEvents.length} upcoming event${upcomingEvents.length > 1 ? 's' : ''} with ${totalInvited} stakeholder${totalInvited !== 1 ? 's' : ''} invited. Use events as warm openers for new stakeholders.` });
  }

  // Solutions coverage
  if (accsWithSolutions.length < mappedAccounts.length) {
    improvements.push({ icon: '🛠️', priority: 'low', title: 'Expand Solution Mapping', text: `Only ${accsWithSolutions.length}/${mappedAccounts.length} mapped accounts have solutions assigned. Defining solutions early sharpens the pitch.` });
  }

  const priorityOrder = { high: 1, medium: 2, low: 3 };
  improvements.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  const priorityColor = { high: '#ef4444', medium: '#fbbf24', low: '#60a5fa' };
  const priorityBg = { high: 'rgba(239,68,68,0.08)', medium: 'rgba(251,191,36,0.08)', low: 'rgba(96,165,250,0.08)' };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>Inside Sales Insights</h1>
          <p>Performance analysis, conclusions and actionable recommendations</p>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {[{ key: 'all', label: 'All Time' }, { key: '7d', label: '7 Days' }, { key: '30d', label: '30 Days' }, { key: 'year', label: 'This Year' }].map(p => (
            <button key={p.key}
              className={`action-btn ${timePeriod === p.key ? 'btn-primary' : 'btn-ghost'}`}
              style={{ fontSize: 11, padding: '6px 12px' }}
              onClick={() => setTimePeriod(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* ─── VIEW SELECTOR ─── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {isAdmin && (
            <button className={`action-btn ${insightsView === 'company' ? 'btn-primary' : 'btn-ghost'}`} style={{ fontSize: 11, padding: '6px 14px' }} onClick={() => { setInsightsView('company'); setAiProjection(''); }}>
              🏢 Company
            </button>
          )}
          {users.filter(u => F(u, 'Name') || F(u, 'Email')).map(u => {
            const uName = F(u, 'Name') || F(u, 'Email') || 'User';
            const isMe = u.id === currentUserId;
            if (!isAdmin && !isMe) return null;
            return (
              <button key={u.id} className={`action-btn ${insightsView === u.id ? 'btn-primary' : 'btn-ghost'}`} style={{ fontSize: 11, padding: '6px 14px' }} onClick={() => { setInsightsView(u.id); setAiProjection(''); }}>
                👤 {uName}{isMe ? ' (you)' : ''}
              </button>
            );
          })}
        </div>
        {insightsView !== 'company' && <div style={{ fontSize: 12, color: 'var(--globant-muted)' }}>Showing personal insights for <strong style={{ color: 'var(--globant-text)' }}>{viewName}</strong></div>}
      </div>

      {/* ─── PERSONAL KPI SUMMARY (always shown in personal view) ─── */}
      {insightsView !== 'company' && viewMeetingsTarget === 0 && viewDealsTarget === 0 && (
        <div style={{ display: 'flex', gap: 14, marginBottom: 20, flexWrap: 'wrap' }}>
          <div className="card" style={{ flex: 1, minWidth: 140, borderLeft: '3px solid #60a5fa' }}>
            <div style={{ fontSize: 10, color: 'var(--globant-muted)', fontWeight: 700, letterSpacing: 1, marginBottom: 8 }}>📅 MEETINGS ACHIEVED</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: '#4ade80' }}>{viewMeetings.length}</div>
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 4 }}>Set a target in Strategy to track progress</div>
          </div>
          <div className="card" style={{ flex: 1, minWidth: 140, borderLeft: '3px solid #a78bfa' }}>
            <div style={{ fontSize: 10, color: 'var(--globant-muted)', fontWeight: 700, letterSpacing: 1, marginBottom: 8 }}>📊 ACTIVITIES LOGGED</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--globant-text)' }}>{viewActivities.length}</div>
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 4 }}>{activitiesPerWeek.toFixed(1)} / week avg (last 4 weeks)</div>
          </div>
        </div>
      )}

      {/* ─── PERSONAL KPI PROJECTION (only in personal view with targets set) ─── */}
      {insightsView !== 'company' && (viewMeetingsTarget > 0 || viewDealsTarget > 0) && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14, marginBottom: 14 }}>

            {/* Meetings Gap Card */}
            {viewMeetingsTarget > 0 && (
              <div className="card" style={{ borderLeft: `3px solid ${meetingsGap === 0 ? '#4ade80' : '#60a5fa'}` }}>
                <div className="card-header"><h3>📅 Meetings Projection</h3></div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 28, fontWeight: 800, color: '#4ade80' }}>{viewMeetings.length}</div>
                    <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 4 }}>Achieved</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--globant-muted)' }}>{viewMeetingsTarget}</div>
                    <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 4 }}>Target</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 28, fontWeight: 800, color: meetingsGap === 0 ? '#4ade80' : '#f59e0b' }}>{meetingsGap}</div>
                    <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 4 }}>Gap</div>
                  </div>
                </div>
                {meetingsGap > 0 && (
                  <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--globant-darker)', fontSize: 12 }}>
                    {activitiesNeeded !== null ? (
                      <>
                        <div style={{ marginBottom: 6 }}>→ You need <strong style={{ color: '#60a5fa' }}>{activitiesNeeded} more activities</strong> to close the gap</div>
                        <div style={{ marginBottom: 6, color: 'var(--globant-muted)' }}>Current rate: <strong style={{ color: 'var(--globant-text)' }}>{(meetingConvRate * 100).toFixed(0)}%</strong> conversion · <strong style={{ color: 'var(--globant-text)' }}>{activitiesPerWeek.toFixed(1)}</strong> activities/week</div>
                        {weeksToTarget !== null && <div style={{ color: weeksToTarget <= 4 ? '#4ade80' : weeksToTarget <= 8 ? '#f59e0b' : '#ef4444', fontWeight: 700 }}>⏱ At your current pace: ~{weeksToTarget.toFixed(1)} weeks to reach target</div>}
                      </>
                    ) : (
                      <div style={{ color: 'var(--globant-muted)' }}>Not enough recent activity data (last 4 weeks) to project.</div>
                    )}
                  </div>
                )}
                {meetingsGap === 0 && <div style={{ color: '#4ade80', fontWeight: 700, fontSize: 13 }}>🎉 Target reached!</div>}
              </div>
            )}

            {/* Deals Gap Card */}
            {viewDealsTarget > 0 && (
              <div className="card" style={{ borderLeft: `3px solid ${dealsGap === 0 ? '#4ade80' : '#a78bfa'}` }}>
                <div className="card-header"><h3>💰 Deals Projection</h3></div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 28, fontWeight: 800, color: '#BFD730' }}>{viewDealsWon}</div>
                    <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 4 }}>Won</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--globant-muted)' }}>{viewDealsTarget}</div>
                    <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 4 }}>Target</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 28, fontWeight: 800, color: dealsGap === 0 ? '#4ade80' : '#f59e0b' }}>{dealsGap}</div>
                    <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 4 }}>Gap</div>
                  </div>
                </div>
                {dealsGap > 0 && (
                  <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--globant-darker)', fontSize: 12 }}>
                    {meetingsNeededForDeals !== null ? (
                      <>
                        <div style={{ marginBottom: 6 }}>→ You need <strong style={{ color: '#a78bfa' }}>{meetingsNeededForDeals} more meetings</strong> to close the gap</div>
                        <div style={{ color: 'var(--globant-muted)' }}>Current rate: <strong style={{ color: 'var(--globant-text)' }}>{(meetingsToDealRate * 100).toFixed(0)}%</strong> meeting → deal</div>
                      </>
                    ) : (
                      <div style={{ color: 'var(--globant-muted)' }}>Not enough data to project. Close more meetings first.</div>
                    )}
                  </div>
                )}
                {dealsGap === 0 && <div style={{ color: '#4ade80', fontWeight: 700, fontSize: 13 }}>🎉 Target reached!</div>}
              </div>
            )}
          </div>

          {/* AI Projection */}
          <div className="card" style={{ borderLeft: '3px solid #BFD730' }}>
            <div className="card-header">
              <h3>🤖 AI Sales Coach</h3>
              <button className="action-btn btn-primary" style={{ fontSize: 11 }} onClick={generateProjection} disabled={loadingProjection}>
                {loadingProjection ? '⏳ Analyzing...' : aiProjection ? '🔄 Regenerate' : '✨ Generate Projection'}
              </button>
            </div>
            {aiProjection ? (
              <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--globant-text)', padding: '4px 0' }}>{aiProjection}</div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--globant-muted)' }}>Generate a personalized projection based on your current activity and goals.</div>
            )}
          </div>
        </div>
      )}

      {/* Goal context banner */}
      {goalName && (
        <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 8, background: 'rgba(191,215,48,0.07)', border: '1px solid rgba(191,215,48,0.2)', display: 'flex', gap: 12, alignItems: 'center', fontSize: 12 }}>
          <span style={{ fontSize: 16 }}>🎯</span>
          <span style={{ color: 'var(--globant-muted)' }}>Goal: <strong style={{ color: 'var(--globant-text)' }}>{goalName}</strong>
            {goalTarget > 0 && <span> · Target: <strong style={{ color: '#BFD730' }}>{formatCurrency(goalTarget)}</strong></span>}
            {goalDeadline && <span> · Deadline: <strong style={{ color: 'var(--globant-text)' }}>{formatDate(goalDeadline)}</strong></span>}
          </span>
        </div>
      )}

      {/* Scorecard */}
      {timePeriod !== 'all' && (
        <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--globant-green)', fontWeight: 600 }}>
          📅 Showing activity for: {periodLabel}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 14, marginBottom: 24 }}>
        <div className="card" style={{ textAlign: 'center', padding: '18px 12px', background: 'linear-gradient(135deg, rgba(91,191,181,0.15) 0%, rgba(91,191,181,0.03) 100%)' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--globant-green)', lineHeight: 1 }}>{coveragePct}%</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Account Coverage</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '18px 12px' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--globant-info)', lineHeight: 1 }}>{totalOutreach}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Touches {timePeriod !== 'all' ? `(${periodLabel})` : ''}</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '18px 12px', borderBottom: `3px solid ${replyBench.color}` }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: replyBench.color, lineHeight: 1 }}>{replyRate}%</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Reply Rate</div>
          {(() => {
            const tracked = channelReplyStats.filter(r => r.count >= 5 && r.bench);
            if (tracked.length === 0) {
              return <div style={{ fontSize: 9, color: 'var(--globant-muted)', marginTop: 4 }}>All-channel target: {BENCH_REPLY_LOW}–{BENCH_REPLY_HIGH}%</div>;
            }
            return (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {tracked.slice(0, 3).map(r => (
                  <div key={r.ch} style={{ fontSize: 9, display: 'flex', justifyContent: 'space-between', gap: 4 }}>
                    <span style={{ color: 'var(--globant-muted)' }}>{channelIcon[r.ch] || ''} {r.ch}</span>
                    <span style={{ color: r.benchColor, fontWeight: 700 }}>{r.rate}% {r.bench ? `(ok: ${r.bench.acceptable}%+)` : ''}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '18px 12px', borderBottom: `3px solid ${meetingBench.color}` }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: meetingBench.color, lineHeight: 1 }}>{meetingRate}%</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Meeting Rate</div>
          <div style={{ fontSize: 9, color: meetingBench.color, marginTop: 4, fontWeight: 600 }}>{meetingBench.icon} {meetingBench.label}</div>
          <div style={{ fontSize: 9, color: 'var(--globant-muted)', marginTop: 2 }}>{`Benchmark: ${BENCH_MEETING_LOW}–${BENCH_MEETING_HIGH}%`}</div>
          <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 4 }}>{meetingCount} meetings / {totalOutreach} touches</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '18px 12px', borderBottom: bouncedCount > 0 ? '3px solid #ea580c' : undefined }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: bouncedCount > 0 ? '#ea580c' : 'var(--globant-muted)', lineHeight: 1 }}>{bouncedCount}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>📭 Bounced</div>
          {bouncedCount > 0 && <div style={{ fontSize: 9, color: '#ea580c', marginTop: 4, fontWeight: 600 }}>{bouncedRate}% of touches · fix emails</div>}
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '18px 12px' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: winRate >= 40 ? 'var(--globant-success)' : 'var(--globant-warning)', lineHeight: 1 }}>{winRate}%</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Win Rate</div>
        </div>
      </div>

      {/* Lead Source by Category + Source Name Detail + Channel Breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        <div className="card" style={{ borderLeft: '3px solid var(--globant-info)' }}>
          <div className="card-header"><h3>🎯 Lead Sources by Category</h3></div>
          <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--globant-muted)' }}>{totalFromSources} contacts across {sourceCatSorted.length} categories</div>
          {sourceCatSorted.map(([cat, count], i) => {
            const pct = totalFromSources > 0 ? (count / totalFromSources) * 100 : 0;
            const catColors = { 'Outbound': '#f87171', 'Inbound - Events': '#4ade80', 'Inbound - Hi@Globant': '#60a5fa', 'Inbound - Paid Media': '#fbbf24' };
            const colors = ['#BFD730', '#60a5fa', '#fbbf24', '#4ade80', '#f87171', '#a78bfa', '#fb923c', '#22d3ee'];
            const color = catColors[cat] || colors[i % colors.length];
            return (
              <div key={cat} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                  <span style={{ fontWeight: 600 }}>{cat}</span>
                  <span style={{ fontWeight: 700 }}>{count} <span style={{ fontSize: 10, color: 'var(--globant-muted)', fontWeight: 400 }}>({Math.round(pct)}%)</span></span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: 'var(--globant-darker)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 4, width: `${pct}%`, background: color, transition: 'width 0.3s' }} />
                </div>
              </div>
            );
          })}
          {sourceCatSorted.length === 0 && <p style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>No source data available. Add sources in Airtable.</p>}
        </div>

        <div className="card" style={{ borderLeft: '3px solid #a78bfa' }}>
          <div className="card-header"><h3>📋 Source Detail</h3></div>
          <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--globant-muted)' }}>{sourceNameDetails.length} campaigns / sources tracked</div>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {sourceNameDetails.map((src, i) => {
              const catColors = { 'Outbound': '#f87171', 'Inbound - Events': '#4ade80', 'Inbound - Hi@Globant': '#60a5fa', 'Inbound - Paid Media': '#fbbf24' };
              const catColor = catColors[src.category] || '#94a3b8';
              return (
                <div key={i} style={{ padding: '10px 12px', marginBottom: 6, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{src.name}</span>
                    <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 5, background: catColor + '22', color: catColor, fontWeight: 600 }}>{src.category || 'Unknown'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--globant-muted)' }}>
                    <span><strong style={{ color: 'var(--globant-text)' }}>{src.stakeholders}</strong> contacts</span>
                    <span><strong style={{ color: src.active > 0 ? '#4ade80' : 'var(--globant-muted)' }}>{src.active}</strong> with outreach{timePeriod !== 'all' ? ` (${periodLabel})` : ''}</span>
                    {src.stakeholders > 0 && <span style={{ color: src.active / src.stakeholders > 0.5 ? '#4ade80' : '#fbbf24' }}>{Math.round((src.active / src.stakeholders) * 100)}% activated</span>}
                  </div>
                </div>
              );
            })}
            {sourceNameDetails.length === 0 && <p style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>No source records found.</p>}
          </div>
        </div>
      </div>

      {/* Channel Breakdown + Benchmarks */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>

        <div className="card" style={{ borderLeft: '3px solid var(--globant-accent)' }}>
          <div className="card-header"><h3>📡 Channel Breakdown {timePeriod !== 'all' ? `(${periodLabel})` : ''}</h3></div>
          <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--globant-muted)' }}>{totalOutreach} activities across {Object.keys(byChannel).length} channels</div>
          {channelReplyStats.map(({ ch, count, replied, rate, bench, benchLabel, benchColor }) => {
            const pct = totalOutreach > 0 ? (count / totalOutreach) * 100 : 0;
            const chColors = { WhatsApp: '#25D366', Email: '#60a5fa', LinkedIn: '#0A66C2', Phone: '#fbbf24', Call: '#fbbf24', SMS: '#a78bfa' };
            const color = chColors[ch] || '#a78bfa';
            return (
              <div key={ch} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4, alignItems: 'center' }}>
                  <span style={{ fontWeight: 600 }}>{channelIcon[ch] || '📋'} {ch}</span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {count >= 5 && bench && (
                      <span style={{ fontSize: 10, color: benchColor, fontWeight: 700 }}>
                        {rate}% reply{benchLabel ? ` · ${benchLabel}` : ''}
                      </span>
                    )}
                    <span style={{ fontWeight: 700 }}>{count} <span style={{ fontSize: 10, color: 'var(--globant-muted)', fontWeight: 400 }}>({Math.round(pct)}%)</span></span>
                  </div>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: 'var(--globant-darker)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 4, width: `${pct}%`, background: color, transition: 'width 0.3s' }} />
                </div>
                {count < 5 && bench && <div style={{ fontSize: 9, color: 'var(--globant-muted)', marginTop: 2 }}>Need ≥5 touches for benchmark comparison</div>}
              </div>
            );
          })}
          {totalOutreach === 0 && <p style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>No outreach activity in this period.</p>}

          {/* Status breakdown */}
          {totalOutreach > 0 && (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--globant-border)' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--globant-muted)', marginBottom: 8 }}>RESPONSE STATUS</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(byStatus).sort((a, b) => b[1] - a[1]).map(([st, count]) => {
                  const stColor = st === 'Replied' ? '#4ade80' : st === 'Meeting Scheduled' ? '#60a5fa' : st === 'Sent' ? '#fbbf24' : '#8888A8';
                  return (
                    <span key={st} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, background: `${stColor}15`, border: `1px solid ${stColor}30`, color: stColor, fontWeight: 600 }}>
                      {st}: {count}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Industry Benchmarks 2025 */}
        <div className="card" style={{ borderLeft: '3px solid #a78bfa' }}>
          <div className="card-header">
            <h3>📊 B2B Outbound Benchmarks 2025</h3>
          </div>
          <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginBottom: 12, lineHeight: 1.5 }}>
            Source: Belkins + Reply.io + Expandi + Nooks — 16.5M cold emails, 20M+ LinkedIn outreach, 5M+ calls analyzed.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Object.entries(CHANNEL_BENCHMARKS).map(([key, b]) => (
              <div key={key} style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>{b.icon} {b.label}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 5, background: 'rgba(239,68,68,0.15)', color: '#f87171', fontWeight: 600 }}>{b.acceptable}%+</span>
                    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 5, background: 'rgba(251,191,36,0.15)', color: '#fbbf24', fontWeight: 600 }}>{b.good}%+</span>
                    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 5, background: 'rgba(74,222,128,0.15)', color: '#4ade80', fontWeight: 600 }}>{b.excellent}%+</span>
                  </div>
                </div>
                <div style={{ fontSize: 10, color: 'var(--globant-muted)', lineHeight: 1.5 }}>{b.note}</div>
              </div>
            ))}
            <div style={{ marginTop: 4, padding: '10px 12px', borderRadius: 8, background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#a78bfa', marginBottom: 4 }}>🔗 Multichannel multiplier</div>
              <div style={{ fontSize: 10, color: 'var(--globant-muted)', lineHeight: 1.5 }}>
                Email + LinkedIn + Phone combined = +287% engagement vs. single channel. Target: 10–15% total reply/engagement for a well-orchestrated campaign.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Two-column layout: Conclusions + Improvements */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>

        {/* Conclusions */}
        <div className="card" style={{ borderLeft: '3px solid var(--globant-green)' }}>
          <div className="card-header"><h3>📋 Performance Summary</h3></div>
          {conclusions.map((c, i) => (
            <div key={i} style={{ padding: '10px 0', borderBottom: i < conclusions.length - 1 ? '1px solid var(--globant-border)' : 'none' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{c.icon} {c.title}</div>
              <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--globant-muted)' }}>{c.text}</div>
            </div>
          ))}
        </div>

        {/* Improvements */}
        <div className="card" style={{ borderLeft: '3px solid var(--globant-warning)' }}>
          <div className="card-header"><h3>🚀 Recommendations</h3></div>
          {improvements.map((imp, i) => (
            <div key={i} style={{ padding: '10px 12px', marginBottom: 8, borderRadius: 8, background: priorityBg[imp.priority], borderLeft: `3px solid ${priorityColor[imp.priority]}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{imp.icon} {imp.title}</span>
                <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: priorityColor[imp.priority], padding: '2px 8px', background: `${priorityColor[imp.priority]}22`, borderRadius: 4 }}>{imp.priority}</span>
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--globant-text)' }}>{imp.text}</div>
            </div>
          ))}
          {improvements.length === 0 && <p style={{ color: 'var(--globant-success)', fontSize: 13 }}>Everything looks good! No major improvements needed right now.</p>}
        </div>
      </div>

      {/* Pipeline Breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        <div className="card">
          <div className="card-header"><h3>🎯 Pipeline by Stage</h3></div>
          {Object.entries(stageCounts).sort((a, b) => b[1] - a[1]).map(([stage, count], i) => {
            const pct = opportunities.length > 0 ? (count / opportunities.length) * 100 : 0;
            const color = stage.toLowerCase().includes('won') ? '#4ade80' :
                          stage.toLowerCase().includes('lost') || stage.toLowerCase().includes('cancel') ? '#ef4444' :
                          stage.toLowerCase().includes('negot') || stage.toLowerCase().includes('closing') ? '#fbbf24' : '#60a5fa';
            return (
              <div key={i} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                  <span>{stage}</span>
                  <span style={{ fontWeight: 700 }}>{count}</span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: 'var(--globant-darker)' }}>
                  <div style={{ height: '100%', borderRadius: 3, width: `${pct}%`, background: color }} />
                </div>
              </div>
            );
          })}
        </div>

        <div className="card">
          <div className="card-header"><h3>👥 Engagement Gaps</h3></div>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--globant-muted)', marginBottom: 8 }}>Stakeholders never contacted:</div>
            {stakeholdersNoOutreach.length === 0 && <p style={{ fontSize: 12, color: 'var(--globant-success)' }}>All stakeholders have been reached!</p>}
            {stakeholdersNoOutreach.slice(0, 8).map(s => {
              const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
              return (
                <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--globant-border)', fontSize: 12 }}>
                  <span><span style={{ fontWeight: 600 }}>{F(s, 'Name')}{F(s, 'Last name') ? ` ${F(s, 'Last name')}` : ''}</span> <span style={{ color: 'var(--globant-muted)' }}>({F(s, 'Role')})</span></span>
                  <span style={{ color: 'var(--globant-muted)', fontSize: 11 }}>{accNames.join(', ')}</span>
                </div>
              );
            })}
            {stakeholdersNoOutreach.length > 8 && <p style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>+{stakeholdersNoOutreach.length - 8} more</p>}
          </div>

          {staleStakeholders.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--globant-warning)', marginBottom: 8, marginTop: 12 }}>⏰ Going cold (14+ days):</div>
              {staleStakeholders.sort((a, b) => b.days - a.days).slice(0, 5).map(({ s, days, lastChannel }) => {
                const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
                return (
                  <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--globant-border)', fontSize: 12 }}>
                    <span><span style={{ fontWeight: 600 }}>{F(s, 'Name')}</span> <span style={{ color: 'var(--globant-muted)' }}>({accNames.join(', ')})</span></span>
                    <span style={{ color: 'var(--globant-warning)', fontSize: 11 }}>{days}d ago via {lastChannel}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============ EVENTS HUB ============

export default InsightsView;
