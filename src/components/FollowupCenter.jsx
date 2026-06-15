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


function FollowupCenter({ data, api, onLogActivity, onAddRecord, onUpdateRecord, goToAccount }) {
  const { accounts, stakeholders, outreach, actionPlan = [] } = data;
  const [accountSearch, setAccountSearch] = useState('');
  const [selectedInfluence, setSelectedInfluence] = useState('');
  const [searchName, setSearchName] = useState('');
  const [selectedStakeholder, setSelectedStakeholder] = useState(null);
  const [responseModal, setResponseModal] = useState(null); // { stakeholder, lastOutreach }
  const [responseText, setResponseText] = useState('');
  const [meetingModal, setMeetingModal] = useState(null); // { stakeholder }
  const [meetingNotes, setMeetingNotes] = useState('');
  const [meetingDate, setMeetingDate] = useState('');
  const [meetingTime, setMeetingTime] = useState('');
  const [historyStakeholder, setHistoryStakeholder] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [csvRows, setCsvRows] = useState([]);
  const [generatingFollowup, setGeneratingFollowup] = useState(null); // stakeholder.id being generated
  const [csvStatus, setCsvStatus] = useState(null);
  const [importResults, setImportResults] = useState(null);
  const [expandedReplies, setExpandedReplies] = useState({}); // { [stakeholder.id]: bool }
  const [composeEmail, setComposeEmail] = useState(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [showDismissedReplies, setShowDismissedReplies] = useState(false);

  // Dismissed replies — persisted in localStorage, auto-expire after 1 day
  const DISMISS_REPLIES_KEY = 'oike_dismissed_replies';
  const [dismissedReplies, setDismissedReplies] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(DISMISS_REPLIES_KEY) || '{}');
      const today = new Date().toDateString();
      const filtered = {};
      Object.entries(raw).forEach(([id, date]) => { if (date === today) filtered[id] = date; });
      return filtered;
    } catch { return {}; }
  });
  const dismissReply = (stakeholderId) => {
    const today = new Date().toDateString();
    const next = { ...dismissedReplies, [stakeholderId]: today };
    setDismissedReplies(next);
    try { localStorage.setItem(DISMISS_REPLIES_KEY, JSON.stringify(next)); } catch {}
  };
  const undismissReply = (stakeholderId) => {
    const next = { ...dismissedReplies };
    delete next[stakeholderId];
    setDismissedReplies(next);
    try { localStorage.setItem(DISMISS_REPLIES_KEY, JSON.stringify(next)); } catch {}
  };

  // Dismissed follow-ups — persisted in localStorage, auto-expire after 1 day
  const DISMISS_KEY = 'oike_dismissed_followups';
  const [dismissedFollowups, setDismissedFollowups] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}');
      const today = new Date().toDateString();
      // Keep only dismissals from today
      const filtered = {};
      Object.entries(raw).forEach(([id, date]) => { if (date === today) filtered[id] = date; });
      return filtered;
    } catch { return {}; }
  });

  const dismissFollowup = (stakeholderId) => {
    const today = new Date().toDateString();
    const next = { ...dismissedFollowups, [stakeholderId]: today };
    setDismissedFollowups(next);
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(next)); } catch {}
  };
  const undismissFollowup = (stakeholderId) => {
    const next = { ...dismissedFollowups };
    delete next[stakeholderId];
    setDismissedFollowups(next);
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(next)); } catch {}
  }; // { stakeholder, subject, body, replyContext: { threadId, inReplyTo, readMsgId } | null }
  const [showFuNewStk, setShowFuNewStk] = useState(false);
  const [fuNewName, setFuNewName] = useState('');
  const [fuNewLast, setFuNewLast] = useState('');
  const [fuNewRole, setFuNewRole] = useState('');
  const [fuNewEmail, setFuNewEmail] = useState('');
  const [fuNewPhone, setFuNewPhone] = useState('');
  const [fuNewLinkedin, setFuNewLinkedin] = useState('');
  const [fuNewInfluence, setFuNewInfluence] = useState('');
  const [fuNewAccountId, setFuNewAccountId] = useState('');
  const [fuCreating, setFuCreating] = useState(false);

  // Gmail sync state for Follow-up Center
  const [gmailSyncing, setGmailSyncing] = useState(false);
  const [gmailSyncMsg, setGmailSyncMsg] = useState('');
  const gmailConnectedFC = localStorage.getItem('oike_gmail_connected') === 'true';

  const handleGmailSyncFC = async () => {
    setGmailSyncing(true);
    setGmailSyncMsg('');
    try {
      const res = await fetch('/api/gmail/sync', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ baseId: AIRTABLE_BASE_ID, stakeholdersTableId: TABLE_IDS.stakeholders, outreachTableId: TABLE_IDS.outreach, daysBack: 7 }),
      });
      const d = await res.json();
      setGmailSyncMsg(d.message || (res.ok ? 'Sync complete' : d.error || 'Sync failed'));
      if (res.ok && d.synced > 0 && onLogActivity) onLogActivity();
    } catch (e) {
      setGmailSyncMsg('Sync error. Try again.');
    }
    setGmailSyncing(false);
  };

  // Stakeholders who replied to you (last touch is Received) and you haven't responded since
  const repliedToYou = useMemo(() => {
    const results = [];
    stakeholders.forEach(s => {
      const sOutreach = outreach
        .filter(o => linkedIds(o, 'Stakeholder').includes(s.id))
        .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
      if (sOutreach.length === 0) return;
      const latest = sOutreach[0];
      const latestStatus = String(F(latest, 'Status') || '').toLowerCase();
      if (latestStatus !== 'received' && latestStatus !== 'replied') return;
      // Apply filters
      if (accountSearch) {
        const term = accountSearch.toLowerCase();
        const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
        if (!accNames.some(n => n.toLowerCase().includes(term))) return;
      }
      if (selectedInfluence && F(s, 'Level of Influence') !== selectedInfluence) return;
      if (searchName && !(F(s, 'Name') || '').toLowerCase().includes(searchName.toLowerCase())) return;
      const daysSince = Math.floor((Date.now() - new Date(latest.fields?.['Date'] || 0)) / (1000*60*60*24));
      results.push({ s, lastOutreach: latest, daysSince });
    });
    return results.sort((a, b) => a.daysSince - b.daysSince);
  }, [stakeholders, outreach, accounts, accountSearch, selectedInfluence, searchName]);

  // Stakeholders contacted in last 3 days (hidden from Ready/Needs groups)
  const recentlyContacted = useMemo(() => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 3); cutoff.setHours(0, 0, 0, 0);
    const ids = new Set();
    outreach.forEach(o => {
      const d = o.fields?.['Date'] ? new Date(o.fields['Date']) : null;
      if (d && d >= cutoff) linkedIds(o, 'Stakeholder').forEach(id => ids.add(id));
    });
    return ids;
  }, [outreach]);

  // Stakeholders with outreach but NOT contacted in last 3 days → follow-up pending
  // ── Daily Focus: smart scored list replacing simple 3-day cutoff ──
  const dailyFocusItems = useMemo(() => {
    const campaigns = data.campaigns || [];
    const results = [];
    stakeholders.forEach(s => {
      const e = s._enriched;
      if (!e) return; // not enriched yet (shouldn't happen)
      if (e.contactedToday) return; // already handled today
      // Skip contacts touched in the last 2 days — too soon to follow up
      if (e.daysSince !== null && e.daysSince < 3) return;
      // Apply search filters
      if (accountSearch) {
        const term = accountSearch.toLowerCase();
        const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
        if (!accNames.some(n => n.toLowerCase().includes(term))) return;
      }
      if (selectedInfluence && F(s, 'Level of Influence') !== selectedInfluence) return;
      if (searchName && !(F(s, 'Name') || '').toLowerCase().includes(searchName.toLowerCase())) return;
      // Only show contacts that have been touched (never-touched go to "needs contact" list)
      if (e.totalTouches === 0) return;
      // Apply campaign membership bonus to score
      let score = e.focusScore;
      const inCampaign = campaigns.some(c => {
        const assigned = linkedIds(c, 'Assigned Stakeholders');
        return assigned.includes(s.id) && F(c, 'Status') !== 'Inactive';
      });
      if (inCampaign) score += 12;
      const accId = linkedIds(s, 'Account')[0];
      const acc = accId ? accounts.find(a => a.id === accId) : null;
      if (acc?._enriched?.inActiveCampaign) score += 8;
      // Skip if no valid focus tag (e.g. daysSince 1-2, edge case)
      if (!e.focusTag) return;
      results.push({ s, acc, score, tag: e.focusTag, e });
    });
    return results.sort((a, b) => b.score - a.score);
  }, [stakeholders, accounts, data.campaigns, accountSearch, selectedInfluence, searchName]);

  // Split into active vs dismissed
  const activeFocusItems    = dailyFocusItems.filter(item => !dismissedFollowups[item.s.id]);
  const dismissedFocusItems = dailyFocusItems.filter(item =>  dismissedFollowups[item.s.id]);

  // Backwards-compat alias used by summary line and old section header
  const followupPending = dailyFocusItems;

  // ── Urgent Actions: AI-generated Action Plan tasks, not done, not snoozed for today ──
  const DONE_STATUSES = new Set(['Completado', 'Cerrado', 'Done', 'Closed']);
  const urgentActions = useMemo(() => {
    const todayIso = new Date().toISOString().split('T')[0];
    return (actionPlan || [])
      .filter(a => {
        const source = F(a, 'Source') || '';
        if (!source.startsWith('AI')) return false;
        const status = F(a, 'Status') || '';
        if (DONE_STATUSES.has(status)) return false;
        const snoozed = F(a, 'Snoozed Until');
        if (snoozed && snoozed >= todayIso) return false;
        return true;
      })
      .sort((a, b) => {
        const urgWeight = { High: 3, Medium: 2, Low: 1 };
        const ua = urgWeight[F(a, 'Urgency')] || 0;
        const ub = urgWeight[F(b, 'Urgency')] || 0;
        if (ub !== ua) return ub - ua;
        return (a.createdTime || '').localeCompare(b.createdTime || '');
      });
  }, [actionPlan]);

  const [editingTaskId, setEditingTaskId] = useState(null);
  const [editingTaskText, setEditingTaskText] = useState('');
  const [taskBusyId, setTaskBusyId] = useState(null);

  const markTaskDone = async (task) => {
    setTaskBusyId(task.id);
    if (onUpdateRecord) onUpdateRecord('actionPlan', task.id, { 'Status': 'Completado' });
    try {
      const a = api || new AirtableAPI();
      if (!String(task.id).startsWith('tmp_')) {
        await a.updateRecord(TABLE_IDS.actionPlan, task.id, { 'Status': 'Completado' });
      }
    } catch (e) { console.error('Mark done failed:', e); }
    finally { setTaskBusyId(null); }
  };

  const snoozeTask = async (task, days = 3) => {
    setTaskBusyId(task.id);
    const until = new Date(); until.setDate(until.getDate() + days);
    const iso = until.toISOString().split('T')[0];
    if (onUpdateRecord) onUpdateRecord('actionPlan', task.id, { 'Snoozed Until': iso });
    try {
      const a = api || new AirtableAPI();
      if (!String(task.id).startsWith('tmp_')) {
        await a.updateRecord(TABLE_IDS.actionPlan, task.id, { 'Snoozed Until': iso });
      }
    } catch (e) { console.error('Snooze failed:', e); }
    finally { setTaskBusyId(null); }
  };

  const saveTaskEdit = async (task) => {
    const newText = editingTaskText.trim();
    if (!newText) { setEditingTaskId(null); return; }
    setTaskBusyId(task.id);
    if (onUpdateRecord) onUpdateRecord('actionPlan', task.id, { 'Nombre de la Acción': newText });
    try {
      const a = api || new AirtableAPI();
      if (!String(task.id).startsWith('tmp_')) {
        await a.updateRecord(TABLE_IDS.actionPlan, task.id, { 'Nombre de la Acción': newText });
      }
    } catch (e) { console.error('Edit task failed:', e); }
    finally { setTaskBusyId(null); setEditingTaskId(null); }
  };

  // Intent → label + style for urgent task badges
  const INTENT_BADGE = {
    meeting_request:     { label: '📅 Meeting request', color: '#1e40af', bg: 'rgba(30,64,175,0.12)' },
    info_request:        { label: '📎 Info request',    color: '#4338ca', bg: 'rgba(67,56,202,0.12)' },
    objection:           { label: '🚧 Objection',       color: '#b91c1c', bg: 'rgba(185,28,28,0.12)' },
    follow_up_needed:    { label: '🔁 Follow-up',       color: '#92400e', bg: 'rgba(146,64,14,0.12)' },
    engaged:             { label: '✅ Engaged',          color: '#065f46', bg: 'rgba(6,95,70,0.12)' },
    introduction_needed: { label: '🔗 Intro needed',    color: '#6b21a8', bg: 'rgba(107,33,168,0.12)' },
    not_now:             { label: '⏰ Not now',         color: '#374151', bg: 'rgba(55,65,81,0.12)' },
    ghosted:             { label: '👻 Ghosted',         color: '#6b7280', bg: 'rgba(107,114,128,0.12)' },
    other:               { label: '💬 Reply',           color: '#374151', bg: 'rgba(55,65,81,0.12)' },
  };

  // Log response
  const logResponse = async (stakeholder, responseContent) => {
    const name = F(stakeholder, 'Name') || '';
    const companyIds = linkedIds(stakeholder, 'Account');
    try {
      const a = api || new AirtableAPI();
      await a.createRecord(TABLE_IDS.outreach, {
        'Activity Name': `Reply from ${name} — ${new Date().toLocaleDateString('en-US')}`,
        'Account': companyIds,
        'Stakeholder': [stakeholder.id],
        'Channel': 'Email',
        'Date': new Date().toISOString(),
        'Status': 'Replied',
        'Message': responseContent,
        'Notes': 'Stakeholder responded — logged from Follow-up Center',
        'Logged By': CURRENT_USER?.name || '',
        ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
        ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
      });
      await activateAccountIfNeeded(a, companyIds, data.accounts);
      await updateStakeholderStatus(a, stakeholder.id, 'Replied', data.stakeholders);
      if (onLogActivity) onLogActivity();
    } catch (e) { console.error('Log response failed:', e); }
  };

  // Log meeting scheduled
  const logMeeting = async (stakeholder, notes, date) => {
    const name = F(stakeholder, 'Name') || '';
    const companyIds = linkedIds(stakeholder, 'Account');
    try {
      const a = api || new AirtableAPI();
      await a.createRecord(TABLE_IDS.outreach, {
        'Activity Name': `Meeting Scheduled: ${name} — ${new Date().toLocaleDateString('en-US')}`,
        'Account': companyIds,
        'Stakeholder': [stakeholder.id],
        'Channel': 'Meeting',
        'Date': new Date().toISOString(),
        'Status': 'Meeting Scheduled',
        'Message': notes || '',
        'Notes': `Meeting ${date ? `on ${date}` : 'TBD'} — logged from Follow-up Center`,
        'Logged By': CURRENT_USER?.name || '',
        ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
        ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
      });
      await activateAccountIfNeeded(a, companyIds, data.accounts);
      await updateStakeholderStatus(a, stakeholder.id, 'Meeting Booked', data.stakeholders);
      if (onLogActivity) onLogActivity();
    } catch (e) { console.error('Log meeting failed:', e); }
  };

  const filtered = useMemo(() => stakeholders.filter(s => {
    // Hide stakeholders contacted in last 3 days
    if (recentlyContacted.has(s.id)) return false;
    // Hide stakeholders that have outreach (they go to followupPending)
    const hasOutreach = outreach.some(o => linkedIds(o, 'Stakeholder').includes(s.id));
    if (hasOutreach) return false;
    if (accountSearch) {
      const term = accountSearch.toLowerCase();
      const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
      if (!accNames.some(n => n.toLowerCase().includes(term))) return false;
    }
    if (selectedInfluence && F(s, 'Level of Influence') !== selectedInfluence) return false;
    if (searchName && !(F(s, 'Name') || '').toLowerCase().includes(searchName.toLowerCase())) return false;
    return true;
  }), [stakeholders, accountSearch, accounts, selectedInfluence, searchName, recentlyContacted]);

  // AI-powered quick follow-up — reads last message history and generates a new angle
  const handleQuickFollowup = async (s, channel) => {
    setGeneratingFollowup(s.id);
    try {
      const sName = F(s, 'Name') || '';
      const role = F(s, 'Role') || '';
      const accIds = linkedIds(s, 'Account') || [];
      const accNames = accIds.map(id => { const a = accounts.find(x => x.id === id); return a ? F(a, 'Account Name') : ''; }).filter(Boolean);

      // Get offerings linked to this contact's account
      const allSolutions = data.solutions || [];
      const accRecord = accIds[0] ? accounts.find(a => a.id === accIds[0]) : null;
      const linkedSolIds = accRecord ? (linkedIds(accRecord, 'Solutions') || []) : [];
      const relevantSolutions = linkedSolIds.length > 0
        ? allSolutions.filter(sol => linkedSolIds.includes(sol.id))
        : allSolutions.slice(0, 6); // fallback: first 6 if none linked
      const offeringsText = relevantSolutions.map(sol => {
        const name = F(sol, 'Name') || '';
        const detail = (F(sol, 'Service | Solution Detail') || '').slice(0, 200);
        return `• ${name}${detail ? `: ${detail}` : ''}`;
      }).join('\n');

      // Sort outreach newest-first
      const sOutreach = outreach
        .filter(o => linkedIds(o, 'Stakeholder').includes(s.id))
        .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));

      // Last SENT message (for continuity)
      const lastSent = sOutreach.find(o => {
        const st = (F(o, 'Status') || '').toLowerCase();
        return st === 'sent' || st === 'draft';
      });
      const lastSentMsg = lastSent ? (F(lastSent, 'Message') || '').slice(0, 500) : '';
      const lastSentNotes = lastSent ? (() => {
        const n = F(lastSent, 'Notes') || '';
        return n.replace(/^(\[g[^\]]+\])+\s*/, '').trim().slice(0, 200);
      })() : '';
      const lastSentContent = lastSentMsg || lastSentNotes;
      const lastSentDate = lastSent?.fields?.['Date']
        ? new Date(lastSent.fields['Date']).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';

      // Full history (last 5)
      const history = sOutreach.slice(0, 5)
        .map(o => {
          const dir = ['received','replied'].includes((F(o,'Status')||'').toLowerCase()) ? 'THEY' : 'YOU';
          const date = o.fields?.['Date'] ? new Date(o.fields['Date']).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?';
          const msg = (F(o,'Message') || F(o,'Notes') || '').replace(/^(\[g[^\]]+\])+\s*/,'').slice(0, 300);
          return `[${dir} · ${F(o,'Channel')||'?'} · ${date}]\n${msg}`;
        })
        .join('\n\n');

      const prompt = `You are a senior B2B sales rep at ${COMPANY_PROFILE.companyName || 'our company'}.

ABOUT US:
${COMPANY_PROFILE.services ? `- What we do: ${COMPANY_PROFILE.services}` : ''}
${COMPANY_PROFILE.goals ? `- Focus: ${COMPANY_PROFILE.goals}` : ''}
${COMPANY_PROFILE.voiceTone ? `- Voice: ${COMPANY_PROFILE.voiceTone}` : ''}
${COMPANY_PROFILE.voiceAvoid ? `- Never say: ${COMPANY_PROFILE.voiceAvoid}` : ''}

OUR OFFERINGS${accNames[0] ? ` (relevant to ${accNames[0]})` : ''}:
${offeringsText || COMPANY_PROFILE.services || '(no offerings configured)'}

CONTACT: ${sName} — ${role} at ${accNames[0] || 'their company'}

${lastSentContent ? `LAST MESSAGE YOU SENT (${lastSentDate}):
"${lastSentContent}"

` : ''}FULL CONVERSATION HISTORY:
${history || '— No history found —'}

MISSION: Write ONE short follow-up that continues naturally from the last message you sent — same topic/thread, new angle. Don't restart from scratch. Don't reference "following up". Max 3 sentences. Grounded in our actual offerings above. Human, direct, no filler.

Channel: ${channel}
${channel === 'Email' ? 'First line must be "Subject: [subject]", then blank line, then body.' : ''}
${channel === 'WhatsApp' ? 'Ultra short. Casual tone. No subject line.' : ''}
${channel === 'LinkedIn' ? 'Short, professional but conversational.' : ''}

BANNED: "just following up" / "checking in" / "touching base" / "I hope this finds you well" / "I wanted to reach out" / brackets or placeholders. NEVER invent capabilities we don't have.

Output ONLY the message, nothing else.`;

      const generated = await callOpenAI({ prompt, temperature: 0.8, max_tokens: 300 });
      useMessage(s, channel, generated.trim());
    } catch (e) {
      console.error('Quick followup generation failed:', e);
      // Fallback: open channel with empty body so user can type manually
      useMessage(s, channel, '');
    }
    setGeneratingFollowup(null);
  };

  // All contacts in "Needs First Contact" are in a single list now —
  // messages are generated on-demand via AI when user clicks ✨ Message (no pregen)

  // Get unique influence levels from actual data
  const influenceLevels = useMemo(() => {
    const levels = new Set();
    stakeholders.forEach(s => { const l = F(s, 'Level of Influence'); if (l) levels.add(l); });
    return [...levels].sort();
  }, [stakeholders]);

  const useMessage = (stakeholder, channel, message, ccList = [], eventId = null) => {
    const name = F(stakeholder, 'Name') || '';
    const email = F(stakeholder, 'Email') || '';
    const phone = F(stakeholder, 'Phone number') || '';
    const linkedin = F(stakeholder, 'LinkedIn') || '';
    let subject = '';
    let body = message;
    if (channel === 'Email') {
      const lines = message.split('\n');
      const subjectIdx = lines.findIndex(l => /^subject:/i.test(l.trim()));
      if (subjectIdx !== -1) {
        subject = lines[subjectIdx].replace(/^subject:\s*/i, '').trim();
        body = lines.slice(subjectIdx + 1).join('\n').trim();
      }
      // Open in-app compose modal instead of external Gmail URL
      if (email) {
        setComposeEmail({ stakeholder, subject, body, replyContext: null });
        return;
      }
    }
    if (channel === 'WhatsApp' && phone) window.open(`https://wa.me/${String(phone).replace(/[^0-9+]/g, '')}?text=${encodeURIComponent(message)}`, '_blank');
    else if (channel === 'LinkedIn' && linkedin) { navigator.clipboard.writeText(message).catch(() => {}); window.open(linkedin, '_blank'); }
    else if (channel === 'Call' && phone) window.open(`tel:${phone}`, '_self');
    // Log outreach optimistically + fire API in background
    const companyIds = linkedIds(stakeholder, 'Account');
    const outreachFields = {
      'Activity Name': `${channel} to ${name} — ${new Date().toLocaleDateString('en-US')}`,
      'Account': companyIds, 'Stakeholder': [stakeholder.id],
      'Channel': channel, 'Date': new Date().toISOString(),
      'Status': 'Sent', 'Message': message || '',
      'Notes': 'Auto-logged from Follow-up Center',
      'Logged By': CURRENT_USER?.name || '',
      ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
      ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
    };
    if (onAddRecord) onAddRecord('outreach', outreachFields);
    const a = api || new AirtableAPI();
    a.createRecord(TABLE_IDS.outreach, outreachFields)
      .then(() => activateAccountIfNeeded(a, companyIds, data.accounts))
      .then(() => updateStakeholderStatus(a, stakeholder.id, 'Contacted', data.stakeholders))
      .then(async () => {
        // If sent as event invite, register stakeholder as invited in the event
        if (eventId) {
          try {
            const evCached = (data.events || []).find(e => e.id === eventId);
            const currentInvited = evCached ? linkedIds(evCached, 'Stakeholders invited') : [];
            // Always update even if stakeholder seems already there (cache may be stale)
            await a.updateRecord(TABLE_IDS.events, eventId, {
              'Stakeholders invited': [...new Set([...currentInvited, stakeholder.id])],
            });
          } catch(evErr) { console.error('[useMessage] event invite update failed:', evErr); }
        }
      })
      .then(() => { if (onLogActivity) onLogActivity(); })
      .catch(e => console.error('Auto-log failed:', e));
  };

  // ── Execute urgent task: AI-generate message from next_step + intent, open channel, log outreach, mark task done ──
  const executeUrgentTask = async (task, channel) => {
    const stkName = F(task, 'Stakeholder') || '';
    const stkRec = stakeholders.find(s => {
      const full = `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim();
      return full && stkName && full.toLowerCase() === stkName.toLowerCase();
    });
    if (!stkRec) {
      window.__oikeToast(`Stakeholder "${stkName}" not found. The contact may have been deleted — open the task and edit or skip.`, 'warning');
      return;
    }
    // Check channel availability
    const phone = F(stkRec, 'Phone number');
    const email = F(stkRec, 'Email');
    const linkedin = F(stkRec, 'LinkedIn');
    if (channel === 'Email' && !email) { window.__oikeToast('No email on file for this contact.', 'warning'); return; }
    if (channel === 'WhatsApp' && !phone) { window.__oikeToast('No phone on file for this contact.', 'warning'); return; }
    if (channel === 'LinkedIn' && !linkedin) { window.__oikeToast('No LinkedIn URL on file for this contact.', 'warning'); return; }

    setTaskBusyId(task.id);
    try {
      const intent = F(task, 'Intent') || 'other';
      const nextStep = F(task, 'Nombre de la Acción') || '';
      const accIds = linkedIds(task, 'Cuenta');
      const acc = accIds[0] ? accounts.find(a => a.id === accIds[0]) : null;
      const accName = acc ? F(acc, 'Account Name') : '';
      const role = F(stkRec, 'Role') || '';

      // Last 3 messages for context
      const history = outreach
        .filter(o => linkedIds(o, 'Stakeholder').includes(stkRec.id))
        .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0))
        .slice(0, 3)
        .map(o => `[${F(o,'Channel')||'?'} · ${F(o,'Status')||'?'} · ${o.fields?.['Date'] ? new Date(o.fields['Date']).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '?'}]\n${(F(o,'Message') || F(o,'Notes') || '').slice(0, 250)}`)
        .join('\n---\n');

      const intentGuidance = {
        meeting_request:     'They asked for a meeting. Propose 3 concrete time slots next week (morning EU time). Include a Google Meet link option.',
        info_request:        'They asked for information. Acknowledge the specific ask, promise to send within 24h (or attach if ready), offer a 15-min walkthrough call.',
        objection:           'They raised an objection. Acknowledge it briefly, reframe value in 1 line, suggest a short call to discuss — no defensiveness.',
        follow_up_needed:    'They engaged but stalled. Bring a NEW angle (trigger, insight, question). Do not say "just following up". Ask ONE specific question.',
        engaged:             'They are moving. Keep momentum — confirm the next concrete step with specific date/time.',
        introduction_needed: 'They asked for intro to someone else. Acknowledge, ask best way to reach that person, offer to draft an intro blurb.',
        not_now:             'They said not now. Respect briefly, ask when would be better, keep door open with one line of value.',
        ghosted:             'No response. Try a new angle, be brief, add one micro-value point.',
        other:               'Respond with a specific, actionable next step based on the guidance below.',
      };

      const senderName = (typeof COMPANY_PROFILE !== 'undefined' && COMPANY_PROFILE.senderName) ? COMPANY_PROFILE.senderName : (CURRENT_USER?.name || '');

      const prompt = `You are writing ONE ${channel} message as ${senderName || 'the sender'} to ${stkName}${role ? ' (' + role + ')' : ''}${accName ? ' at ' + accName : ''}.

WHAT THE AI RECOMMENDED AS NEXT STEP FOR THIS CONTACT:
"${nextStep}"

INTENT OF THEIR LAST REPLY: ${intent}
GUIDANCE: ${intentGuidance[intent] || intentGuidance.other}

PREVIOUS CONVERSATION (most recent first):
${history || '— no history —'}

RULES:
- Short. Human. Direct. No filler.
- Do NOT say "hope you're well", "just following up", "touching base", "I wanted to reach out".
- Use the contact's first name once at the start. Be warm but not overly familiar.
- Anchor the message to what they actually said and the recommended next step.
${channel === 'Email' ? '- First line: "Subject: [concise subject]", then BLANK LINE, then body. Body max 6 lines.' : ''}
${channel === 'WhatsApp' ? '- Ultra casual, max 4 lines, no subject line.' : ''}
${channel === 'LinkedIn' ? '- Conversational, max 5 lines, no subject line.' : ''}

Output ONLY the message, nothing else.`;

      let message = '';
      try {
        const raw = await callOpenAI({ prompt, temperature: 0.7, max_tokens: 400 });
        message = (raw || '').trim();
      } catch (e) {
        console.error('AI message gen failed, using next_step as fallback:', e);
        message = nextStep;
      }

      // Fire channel + log outreach (via existing useMessage helper — it handles both)
      useMessage(stkRec, channel, message);

      // Mark task as Done (optimistic + API)
      if (onUpdateRecord) onUpdateRecord('actionPlan', task.id, { 'Status': 'Completado' });
      if (!String(task.id).startsWith('tmp_')) {
        const a = api || new AirtableAPI();
        a.updateRecord(TABLE_IDS.actionPlan, task.id, { 'Status': 'Completado' })
          .catch(e => console.error('Mark task done (after execute) failed:', e));
      }
    } finally {
      setTaskBusyId(null);
    }
  };

  // Manual stakeholder creation in Follow-up Center
  const fuCreateStakeholder = async () => {
    if (!fuNewName.trim() || !fuNewAccountId) return;
    const fields = { 'Name': fuNewName.trim(), 'Account': [fuNewAccountId] };
    if (fuNewLast.trim()) fields['Last name'] = fuNewLast.trim();
    if (fuNewRole.trim()) fields['Role'] = fuNewRole.trim();
    if (fuNewEmail.trim()) fields['Email'] = fuNewEmail.trim();
    if (fuNewPhone.trim()) fields['Phone number'] = fuNewPhone.trim();
    if (fuNewLinkedin.trim()) fields['LinkedIn'] = fuNewLinkedin.trim();
    if (fuNewInfluence) fields['Level of Influence'] = fuNewInfluence;
    if (CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name) fields['BDR Owner'] = CURRENT_USER.name;
    if (CURRENT_USER?.role === 'cp' && CURRENT_USER?.name) fields['CP Assigned'] = CURRENT_USER.name;
    // Duplicate check
    const dup = findDuplicateStakeholder(fields, stakeholders);
    if (dup && !confirmDuplicateStakeholder(dup)) return;
    // Optimistic: show in UI instantly
    if (onAddRecord) onAddRecord('stakeholders', fields);
    // Close form immediately
    setFuNewName(''); setFuNewLast(''); setFuNewRole(''); setFuNewEmail('');
    setFuNewPhone(''); setFuNewLinkedin(''); setFuNewInfluence(''); setFuNewAccountId('');
    setShowFuNewStk(false);
    // API in background
    const a = api || new AirtableAPI();
    a.createRecord(TABLE_IDS.stakeholders, fields)
      .then(() => { if (onLogActivity) onLogActivity(); })
      .catch(e => { console.error(e); window.__oikeToast('Failed to create contact', 'error'); if (onLogActivity) onLogActivity(); });
  };

  // Stakeholder row renderer
  const StakeholderRow = ({ s }) => {
    const accountNames = resolveLinked(s, 'Account', accounts, 'Account Name');
    const isDone = s.fields?.['Hecho'] === true;
    const phone = F(s, 'Phone number');
    const email = F(s, 'Email');
    const linkedin = F(s, 'LinkedIn');
    return (
      <tr key={s.id}>
        <td>
          <div style={{ fontWeight: 600, cursor: 'pointer', color: 'var(--globant-green)' }} onClick={() => setHistoryStakeholder(s)}>{F(s, 'Name')}{F(s, 'Last name') ? ` ${F(s, 'Last name')}` : ''}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)' }}>{F(s, 'Role')}</div>
        </td>
        <td style={{ fontSize: 12 }}>{accountNames.join(', ')}</td>
        <td><span className="badge badge-accent">{F(s, 'Level of Influence')}</span></td>
        <td style={{ textAlign: 'center' }}>{isDone ? <span style={{ color: 'var(--globant-success)' }}>✅</span> : <span style={{ color: 'var(--globant-muted)' }}>—</span>}</td>
        <td>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {/* Main CTA — always opens AI Message Modal (generates message on demand via OpenAI) */}
            <button className="action-btn btn-primary" style={{ fontSize: 11 }} onClick={() => setSelectedStakeholder(s)}>✨ Message</button>
            {/* Channel shortcuts also open the AI Message Modal so user can pick channel after generation */}
            {phone && <button className="action-btn btn-whatsapp" style={{ fontSize: 11, padding: '4px 8px' }} title="Generate WhatsApp message with AI" onClick={() => setSelectedStakeholder(s)}>💬</button>}
            {email && <button className="action-btn btn-email" style={{ fontSize: 11, padding: '4px 8px' }} title="Generate email with AI" onClick={() => setSelectedStakeholder(s)}>✉️</button>}
            {linkedin && <button className="action-btn btn-linkedin" style={{ fontSize: 11, padding: '4px 8px' }} title="Generate LinkedIn message with AI" onClick={() => setSelectedStakeholder(s)}>🔗</button>}
            {phone && <button className="action-btn btn-call" style={{ fontSize: 11, padding: '4px 8px' }} title="Call this contact" onClick={() => useMessage(s, 'Call', '')}>📞</button>}
            <button className="action-btn" style={{ fontSize: 11, padding: '4px 8px', background: 'rgba(96,165,250,0.15)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.3)' }}
              onClick={() => { setMeetingModal({ stakeholder: s }); setMeetingNotes(''); setMeetingDate(''); setMeetingTime(''); }}>📅</button>
          </div>
        </td>
      </tr>
    );
  };

  return (
    <div>
      <div className="page-header">
        <h1>Follow-up Center</h1>
        <p>Showing stakeholders not contacted in the last 3 days{recentlyContacted.size > 0 ? ` · ${recentlyContacted.size} recently contacted hidden` : ''}</p>
      </div>

      <div className="filters-row">
        <input
          className="input-field"
          style={{ maxWidth: 250 }}
          placeholder="Filter by account..."
          value={accountSearch}
          onChange={e => setAccountSearch(e.target.value)}
        />
        <input
          className="input-field"
          style={{ maxWidth: 220 }}
          placeholder="Search by name..."
          value={searchName}
          onChange={e => setSearchName(e.target.value)}
        />
        <select className="input-field" style={{ maxWidth: 200 }} value={selectedInfluence} onChange={e => setSelectedInfluence(e.target.value)}>
          <option value="">All Influence Levels</option>
          {influenceLevels.map(level => (
            <option key={level} value={level}>{level}</option>
          ))}
        </select>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--globant-muted)' }}>
          {filtered.length + followupPending.length} contacts · {followupPending.length} follow-up · {filtered.length} needs contact
        </div>
      </div>

      {/* Manual contact creation */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className="action-btn btn-primary" style={{ fontSize: 12 }}
          onClick={() => setShowFuNewStk(!showFuNewStk)}>
          {showFuNewStk ? '✕ Close' : '➕ New Contact'}
        </button>
      </div>

      {/* Manual Stakeholder Creation */}
      {showFuNewStk && (
        <div className="card" style={{ borderLeft: '3px solid var(--globant-green)' }}>
          <div className="card-header"><h3>➕ Create New Contact</h3></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>FIRST NAME *</label>
              <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                placeholder="e.g. Khalid" value={fuNewName} onChange={e => setFuNewName(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>LAST NAME</label>
              <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                placeholder="e.g. Al-Rashid" value={fuNewLast} onChange={e => setFuNewLast(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>ACCOUNT *</label>
              <select className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                value={fuNewAccountId} onChange={e => setFuNewAccountId(e.target.value)}>
                <option value="">Select account...</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{F(a, 'Account Name')}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>ROLE</label>
              <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                placeholder="e.g. CTO" value={fuNewRole} onChange={e => setFuNewRole(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>EMAIL</label>
              <input className="input-field" type="email" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                placeholder="khalid@company.com" value={fuNewEmail} onChange={e => setFuNewEmail(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>PHONE</label>
              <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                placeholder="+971..." value={fuNewPhone} onChange={e => setFuNewPhone(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>LINKEDIN URL</label>
              <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                placeholder="https://linkedin.com/in/..." value={fuNewLinkedin} onChange={e => setFuNewLinkedin(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>INFLUENCE</label>
              <select className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                value={fuNewInfluence} onChange={e => setFuNewInfluence(e.target.value)}>
                <option value="">Select...</option>
                <option value="High">High</option>
                <option value="Medium">Medium</option>
                <option value="Low">Low</option>
              </select>
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="action-btn btn-primary" style={{ fontSize: 12 }}
              onClick={fuCreateStakeholder} disabled={!fuNewName.trim() || !fuNewAccountId || fuCreating}>
              {fuCreating ? '⏳ Creating...' : '🚀 Create Contact'}
            </button>
            <button className="action-btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowFuNewStk(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* CSV Bulk Import — moved to Contacts section */}
      <div className="card" style={{ display: 'none' }}>
        <div className="card-header">
          <h3 style={{ color: 'var(--globant-accent)' }}>📥 Bulk Import Contacts</h3>
          <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Upload CSV to add stakeholders — duplicates auto-detected</span>
        </div>
          <div>
            {/* Instructions */}
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', padding: '8px 12px', background: 'rgba(91,191,181,0.06)', borderRadius: 6, marginBottom: 12, lineHeight: 1.6 }}>
              <strong>CSV columns:</strong> Name, Last Name, Role, Email, Phone, LinkedIn, Account, Influence<br />
              <strong>Account</strong> must match an existing account name. <strong>Duplicates</strong> detected by email or name+account match.
            </div>

            {/* File upload */}
            {!csvStatus && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input type="file" accept=".csv,.tsv,.txt" style={{ fontSize: 12 }} onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  Papa.parse(file, {
                    header: true,
                    skipEmptyLines: true,
                    complete: (results) => {
                      const rows = results.data.map(row => {
                        // Normalize column names (case insensitive, trimmed)
                        const norm = {};
                        Object.keys(row).forEach(k => { norm[k.trim().toLowerCase().replace(/\s+/g, '_')] = (row[k] || '').trim(); });
                        const firstName = norm['name'] || norm['first_name'] || norm['nombre'] || '';
                        const lastName = norm['last_name'] || norm['last'] || norm['apellido'] || norm['lart_name'] || '';
                        const email = norm['email'] || norm['mail'] || norm['correo'] || '';
                        const role = norm['role'] || norm['title'] || norm['position'] || norm['cargo'] || '';
                        const phone = norm['phone'] || norm['phone_number'] || norm['telefono'] || norm['tel'] || '';
                        const linkedin = norm['linkedin'] || norm['linkedin_url'] || '';
                        const accountName = norm['account'] || norm['company'] || norm['empresa'] || norm['cuenta'] || '';
                        const influence = norm['influence'] || norm['level_of_influence'] || '';

                        // Duplicate detection
                        const matchedAccount = accounts.find(a => (F(a, 'Account Name') || '').toLowerCase() === accountName.toLowerCase());
                        let isDuplicate = false;
                        let duplicateReason = '';
                        if (email) {
                          const emailMatch = stakeholders.find(s => (F(s, 'Email') || '').toLowerCase() === email.toLowerCase());
                          if (emailMatch) { isDuplicate = true; duplicateReason = 'Email exists'; }
                        }
                        if (!isDuplicate && firstName && matchedAccount) {
                          const nameMatch = stakeholders.find(s => {
                            const sAcc = linkedIds(s, 'Account');
                            return (F(s, 'Name') || '').toLowerCase() === firstName.toLowerCase()
                              && (F(s, 'Last name') || '').toLowerCase() === lastName.toLowerCase()
                              && sAcc.includes(matchedAccount.id);
                          });
                          if (nameMatch) { isDuplicate = true; duplicateReason = 'Name + Account match'; }
                        }

                        return {
                          firstName, lastName, email, role, phone, linkedin, accountName,
                          influence, matchedAccount, isDuplicate, duplicateReason,
                          selected: !isDuplicate && !!firstName,
                        };
                      }).filter(r => r.firstName || r.email);
                      setCsvRows(rows);
                      setCsvStatus('parsed');
                    },
                  });
                }} />
                <button className="action-btn btn-ghost" style={{ fontSize: 11 }} onClick={() => {
                  const sample = 'Name,Last Name,Role,Email,Phone,LinkedIn,Account,Influence\nJohn,Smith,CTO,john@company.com,+971501234567,https://linkedin.com/in/john,Acme Corp,High';
                  const blob = new Blob([sample], { type: 'text/csv' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a'); a.href = url; a.download = 'contacts_template.csv'; a.click();
                }}>📄 Download Template</button>
              </div>
            )}

            {/* Preview table */}
            {csvStatus === 'parsed' && csvRows.length > 0 && (
              <div>
                <div style={{ fontSize: 12, marginBottom: 8, color: 'var(--globant-text)' }}>
                  <strong>{csvRows.filter(r => r.selected).length}</strong> new contacts to import · <strong style={{ color: '#ef4444' }}>{csvRows.filter(r => r.isDuplicate).length}</strong> duplicates detected
                </div>
                <div style={{ overflowX: 'auto', maxHeight: 300, overflowY: 'auto' }}>
                  <table className="data-table">
                    <thead><tr>
                      <th style={{ width: 30 }}></th>
                      <th>Name</th><th>Role</th><th>Email</th><th>Account</th><th>Status</th>
                    </tr></thead>
                    <tbody>
                      {csvRows.map((row, i) => (
                        <tr key={i} style={{ opacity: row.isDuplicate ? 0.5 : 1 }}>
                          <td><input type="checkbox" checked={row.selected} disabled={row.isDuplicate}
                            onChange={e => { const copy = [...csvRows]; copy[i] = { ...copy[i], selected: e.target.checked }; setCsvRows(copy); }} /></td>
                          <td style={{ fontWeight: 600 }}>{row.firstName} {row.lastName}</td>
                          <td style={{ fontSize: 11 }}>{row.role}</td>
                          <td style={{ fontSize: 11 }}>{row.email}</td>
                          <td style={{ fontSize: 11 }}>{row.accountName}
                            {row.matchedAccount ? <span style={{ color: 'var(--globant-green)', marginLeft: 4 }}>✓</span> : row.accountName ? <span style={{ color: '#ef4444', marginLeft: 4 }}>✗ not found</span> : ''}
                          </td>
                          <td>
                            {row.isDuplicate ? <span className="badge" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', fontSize: 9 }}>Duplicate: {row.duplicateReason}</span>
                              : <span className="badge badge-green" style={{ fontSize: 9 }}>New</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button className="action-btn btn-ghost" onClick={() => { setCsvRows([]); setCsvStatus(null); setImportResults(null); }}>Cancel</button>
                  <button className="action-btn btn-primary"
                    disabled={csvRows.filter(r => r.selected).length === 0}
                    onClick={async () => {
                      setCsvStatus('importing');
                      const toImport = csvRows.filter(r => r.selected);
                      let created = 0, failed = 0, errors = [];
                      const a = api || new AirtableAPI();
                      for (const row of toImport) {
                        try {
                          const fields = {
                            'Name': row.firstName,
                            'Last name': row.lastName,
                            'Role': row.role,
                            'Email': row.email || undefined,
                            'Phone number': row.phone || undefined,
                            'LinkedIn': row.linkedin || undefined,
                            'Level of Influence': row.influence || undefined,
                          };
                          if (row.matchedAccount) fields['Account'] = [row.matchedAccount.id];
                          fields['BDR Owner'] = CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '';
                          fields['CP Assigned'] = CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '';
                          // Remove undefined fields
                          Object.keys(fields).forEach(k => { if (!fields[k]) delete fields[k]; });
                          await a.createRecord(TABLE_IDS.stakeholders, fields);
                          created++;
                          // Small delay to respect rate limits
                          await new Promise(r => setTimeout(r, 250));
                        } catch (e) {
                          failed++;
                          errors.push(`${row.firstName} ${row.lastName}: ${e.message}`);
                        }
                      }
                      setImportResults({ created, failed, errors });
                      setCsvStatus('done');
                      if (onLogActivity) onLogActivity();
                    }}>
                    Import {csvRows.filter(r => r.selected).length} contacts
                  </button>
                </div>
              </div>
            )}

            {csvStatus === 'importing' && (
              <div style={{ padding: 20, textAlign: 'center' }}>
                <div className="spinner" style={{ margin: '0 auto 12px' }} />
                <p style={{ fontSize: 13, color: 'var(--globant-muted)' }}>Importing contacts to Airtable...</p>
              </div>
            )}

            {csvStatus === 'done' && importResults && (
              <div style={{ padding: '14px', background: 'rgba(74,222,128,0.06)', borderRadius: 8, borderLeft: '3px solid #4ade80' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#4ade80', marginBottom: 6 }}>Import Complete</div>
                <div style={{ fontSize: 12, color: 'var(--globant-text)' }}>
                  ✅ <strong>{importResults.created}</strong> contacts created
                  {importResults.failed > 0 && <span style={{ color: '#ef4444' }}> · ❌ {importResults.failed} failed</span>}
                </div>
                {importResults.errors.length > 0 && (
                  <div style={{ fontSize: 11, color: '#ef4444', marginTop: 6 }}>{importResults.errors.join(', ')}</div>
                )}
                <button className="action-btn btn-ghost" style={{ marginTop: 10, fontSize: 11 }}
                  onClick={() => { setCsvRows([]); setCsvStatus(null); setImportResults(null); }}>Import More</button>
              </div>
            )}
          </div>
      </div>

      {/* ⚡ Urgent Actions — AI-generated tasks from conversation analysis */}
      {urgentActions.length > 0 && (
        <div className="card" style={{ borderLeft: '3px solid #ef4444', background: 'rgba(239,68,68,0.03)' }}>
          <div className="card-header">
            <h3 style={{ color: '#ef4444' }}>⚡ Urgent Actions ({urgentActions.length})</h3>
            <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>AI-generated next steps from recent conversations — handle these first</span>
          </div>
          <div>
            {urgentActions.map(task => {
              const urgency = F(task, 'Urgency') || 'Medium';
              const intent = F(task, 'Intent') || 'other';
              const intentBadge = INTENT_BADGE[intent] || INTENT_BADGE.other;
              const stkName = F(task, 'Stakeholder') || '';
              const accIds = linkedIds(task, 'Cuenta');
              const acc = accIds[0] ? accounts.find(a => a.id === accIds[0]) : null;
              const accName = acc ? F(acc, 'Account Name') : '';
              const taskText = F(task, 'Nombre de la Acción') || '';
              // Find the full stakeholder record (to open history modal)
              const stkRec = stakeholders.find(s => {
                const full = `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim();
                return full && stkName && full.toLowerCase() === stkName.toLowerCase();
              });
              const urgColor = urgency === 'High' ? '#ef4444' : urgency === 'Medium' ? '#fbbf24' : '#9ca3af';
              const urgBg = urgency === 'High' ? 'rgba(239,68,68,0.08)' : urgency === 'Medium' ? 'rgba(251,191,36,0.08)' : 'rgba(156,163,175,0.06)';
              const isEditing = editingTaskId === task.id;
              const isBusy = taskBusyId === task.id;

              return (
                <div key={task.id} style={{ padding: '12px 14px', marginBottom: 8, borderRadius: 8, background: urgBg, borderLeft: `3px solid ${urgColor}`, opacity: isBusy ? 0.5 : 1, transition: 'opacity 0.2s' }}>
                  {/* Top row: who + badges */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
                    <div style={{ flex: 1 }}>
                      {stkName && (
                        <span
                          style={{ fontWeight: 700, fontSize: 13, color: stkRec ? 'var(--globant-green)' : 'var(--globant-text)', cursor: stkRec ? 'pointer' : 'default' }}
                          onClick={() => stkRec && setHistoryStakeholder(stkRec)}>
                          {stkName}
                        </span>
                      )}
                      {accName && <span style={{ fontSize: 11, color: 'var(--globant-muted)', marginLeft: stkName ? 8 : 0 }}>{accName}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: intentBadge.bg, color: intentBadge.color }}>{intentBadge.label}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: urgColor + '22', color: urgColor }}>{urgency === 'High' ? '🔥 HIGH' : urgency === 'Medium' ? '⏳ MEDIUM' : '🌙 LOW'}</span>
                    </div>
                  </div>

                  {/* Task text (inline edit) */}
                  {isEditing ? (
                    <div style={{ marginBottom: 8 }}>
                      <textarea
                        className="input-field"
                        style={{ width: '100%', minHeight: 60, fontSize: 12, fontFamily: 'inherit', resize: 'vertical' }}
                        value={editingTaskText}
                        onChange={e => setEditingTaskText(e.target.value)}
                        autoFocus
                      />
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        <button className="action-btn btn-primary" style={{ fontSize: 10, padding: '4px 10px' }} onClick={() => saveTaskEdit(task)}>💾 Save</button>
                        <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '4px 10px' }} onClick={() => { setEditingTaskId(null); setEditingTaskText(''); }}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: 'var(--globant-text)', lineHeight: 1.5, marginBottom: 10, padding: '8px 10px', background: 'rgba(255,255,255,0.04)', borderRadius: 6, borderLeft: `2px solid ${urgColor}` }}>
                      <span style={{ fontSize: 9, fontWeight: 700, color: urgColor, letterSpacing: 1, textTransform: 'uppercase', display: 'block', marginBottom: 3 }}>➤ Next step</span>
                      {taskText || '—'}
                    </div>
                  )}

                  {/* Action buttons */}
                  {!isEditing && (() => {
                    const stkEmail = stkRec ? F(stkRec, 'Email') : '';
                    const stkPhone = stkRec ? F(stkRec, 'Phone number') : '';
                    const stkLinkedin = stkRec ? F(stkRec, 'LinkedIn') : '';
                    return (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        {/* Channel actions — AI-generate message + open channel + log outreach + auto-mark done */}
                        {stkEmail && (
                          <button className="action-btn btn-email" style={{ fontSize: 10, padding: '5px 10px' }} disabled={isBusy}
                            onClick={() => executeUrgentTask(task, 'Email')}>
                            {isBusy ? '⏳' : '✉️ Send email + log'}
                          </button>
                        )}
                        {stkPhone && (
                          <button className="action-btn btn-whatsapp" style={{ fontSize: 10, padding: '5px 10px' }} disabled={isBusy}
                            onClick={() => executeUrgentTask(task, 'WhatsApp')}>
                            {isBusy ? '⏳' : '💬 WhatsApp + log'}
                          </button>
                        )}
                        {stkLinkedin && (
                          <button className="action-btn btn-linkedin" style={{ fontSize: 10, padding: '5px 10px' }} disabled={isBusy}
                            onClick={() => executeUrgentTask(task, 'LinkedIn')}>
                            {isBusy ? '⏳' : '🔗 LinkedIn + log'}
                          </button>
                        )}
                        {!stkRec && (
                          <span style={{ fontSize: 10, color: 'var(--globant-muted)', fontStyle: 'italic' }}>
                            ⚠️ Contact not found — skip or edit
                          </span>
                        )}

                        <div style={{ width: 1, background: 'var(--globant-border)', margin: '0 4px', alignSelf: 'stretch' }} />

                        <button className="action-btn" style={{ fontSize: 10, padding: '5px 10px', background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }} disabled={isBusy}
                          onClick={() => snoozeTask(task, 3)}>
                          💤 Snooze 3d
                        </button>
                        <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '5px 10px' }} disabled={isBusy}
                          onClick={() => { setEditingTaskId(task.id); setEditingTaskText(taskText); }}>
                          ✏️ Edit
                        </button>
                        <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '5px 10px' }} disabled={isBusy}
                          title="Close this task without sending a message (use when handled offline)"
                          onClick={() => markTaskDone(task)}>
                          ✅ Skip — mark done
                        </button>
                        {stkRec && (
                          <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '5px 10px' }}
                            onClick={() => setHistoryStakeholder(stkRec)}>
                            🔗 View conversation
                          </button>
                        )}
                        {acc && goToAccount && (
                          <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '5px 10px' }}
                            onClick={() => goToAccount(acc.id)}>
                            🏢 Account
                          </button>
                        )}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Gmail sync bar */}
      {gmailConnectedFC && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, padding: '8px 14px', background: 'rgba(91,191,181,0.06)', border: '1px solid rgba(91,191,181,0.15)', borderRadius: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--globant-muted)', flex: 1 }}>
            {gmailSyncMsg || 'Sync Gmail inbox to capture new replies from your contacts.'}
          </span>
          <button className="action-btn" style={{ background: 'rgba(91,191,181,0.15)', color: 'var(--globant-green)', border: '1px solid rgba(91,191,181,0.3)', fontSize: 11, padding: '5px 12px', flexShrink: 0 }}
            onClick={handleGmailSyncFC} disabled={gmailSyncing}>
            {gmailSyncing ? '⏳ Syncing...' : '🔄 Sync inbox'}
          </button>
        </div>
      )}

      {/* Group 0: Replied to you */}
      {repliedToYou.length > 0 && (() => {
        const activeReplies    = repliedToYou.filter(r => !dismissedReplies[r.s.id]);
        const dismissedReplied = repliedToYou.filter(r =>  dismissedReplies[r.s.id]);
        return (
        <div className="card" style={{ borderLeft: '3px solid #4ade80', marginBottom: 16 }}>
          <div className="card-header">
            <h3 style={{ color: '#4ade80' }}>📩 Replied to you ({activeReplies.length})</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>They wrote back — your turn</span>
              {dismissedReplied.length > 0 && (
                <button onClick={() => setShowDismissedReplies(v => !v)} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--globant-border)', color: 'var(--globant-muted)', cursor: 'pointer' }}>
                  {showDismissedReplies ? '▲' : '▼'} {dismissedReplied.length} dismissed
                </button>
              )}
            </div>
          </div>
          <div>
            {activeReplies.map(({ s, lastOutreach, daysSince }) => {
              const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
              const email    = F(s, 'Email') || '';
              const phone    = F(s, 'Phone') || '';
              const linkedin = F(s, 'LinkedIn') || '';
              const notes    = F(lastOutreach, 'Notes') || '';
              const msgField = F(lastOutreach, 'Message') || '';
              // Extract all metadata tags: [gmsg:ID][gthread:XYZ][gmsgid:ABC]
              const gmsgMatch   = notes.match(/\[gmsg:([^\]]+)\]/);
              const gmsgId      = gmsgMatch ? gmsgMatch[1] : null;
              const gmailLink   = gmsgId ? `https://mail.google.com/mail/#inbox/${gmsgId}` : null;
              // Strip ALL [g...] metadata tags from the start of Notes, then trim
              const strippedNotes = notes.replace(/^(\[g[^\]]+\])+\s*/,'').trim();
              // Content: prefer Message field, fall back to stripped Notes
              const rawContent  = msgField.trim() || strippedNotes;
              const contentLines = rawContent.split('\n');
              // Notes-sourced (gmail sync) = has [gmsg:] tag AND no Message field
              const hasGmsg     = !!gmsgMatch && !msgField.trim();
              // If gmail-synced: first line = subject, rest = body; otherwise everything is body
              const subject     = hasGmsg ? (contentLines[0] || '') : '';
              const bodyRaw     = hasGmsg ? contentLines.slice(1).join('\n') : rawContent;
              const bodyText    = bodyRaw.trim();
              const isExpanded  = expandedReplies?.[s.id];
              const PREVIEW_LEN = 200;
              return (
                <div key={s.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--globant-border)' }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                        <span style={{ fontWeight: 700, fontSize: 13 }}>{F(s, 'Name')} {F(s, 'Last name') || ''}</span>
                        <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>{F(s, 'Role') || ''}{accNames.length ? ` · ${accNames[0]}` : ''}</span>
                        <span style={{ fontSize: 11, color: '#4ade80', background: 'rgba(74,222,128,0.1)', padding: '2px 8px', borderRadius: 20 }}>
                          {daysSince === 0 ? 'today' : `${daysSince}d ago`}
                        </span>
                      </div>
                      {/* Email card — always show if replied, even without content */}
                      {(rawContent || gmailLink) && (
                        <div style={{ background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.18)', borderRadius: 8, padding: '10px 12px', marginTop: 4 }}>
                          {subject && (
                            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--globant-text)', marginBottom: 6 }}>
                              📧 {subject}
                            </div>
                          )}
                          {!rawContent && !subject && (
                            <div style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>No preview — sync inbox to capture email content.</div>
                          )}
                          {bodyText && (
                            <>
                              <div style={{ fontSize: 12, color: 'var(--globant-muted)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                                {isExpanded ? bodyText : (bodyText.length > PREVIEW_LEN ? bodyText.slice(0, PREVIEW_LEN) + '…' : bodyText)}
                              </div>
                              {bodyText.length > PREVIEW_LEN && (
                                <button
                                  onClick={() => setExpandedReplies(prev => ({ ...prev, [s.id]: !prev[s.id] }))}
                                  style={{ marginTop: 6, fontSize: 11, background: 'none', border: 'none', color: '#4ade80', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
                                  {isExpanded ? 'Show less ▲' : 'Show more ▼'}
                                </button>
                              )}
                            </>
                          )}
                          {gmailLink && (
                            <a href={gmailLink} target="_blank" rel="noreferrer"
                              style={{ display: 'inline-block', marginTop: 8, fontSize: 11, color: '#60a5fa', textDecoration: 'none', background: 'rgba(96,165,250,0.1)', padding: '3px 10px', borderRadius: 12, border: '1px solid rgba(96,165,250,0.25)' }}>
                              📨 Open in Gmail
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                      {email && <button className="action-btn btn-email" style={{ fontSize: 10, padding: '5px 10px' }}
                        onClick={() => {
                          const n = F(lastOutreach, 'Notes') || '';
                          const replyContext = {
                            threadId:   (n.match(/\[gthread:([^\]]+)\]/) || [])[1] || null,
                            inReplyTo:  (n.match(/\[gmsgid:([^\]]+)\]/) || [])[1] || null,
                            readMsgId:  (n.match(/\[gmsg:([^\]]+)\]/) || [])[1] || null,
                          };
                          setComposeEmail({ stakeholder: s, subject: subject ? `Re: ${subject}` : '', body: '', replyContext });
                        }}>✉️ Reply</button>}
                      {phone && <button className="action-btn btn-whatsapp" style={{ fontSize: 10, padding: '5px 10px' }}
                        onClick={() => { window.open(`https://wa.me/${phone.replace(/\D/g,'')}`, '_blank'); }}>💬 WhatsApp</button>}
                      {linkedin && <button className="action-btn btn-linkedin" style={{ fontSize: 10, padding: '5px 10px' }}
                        onClick={() => window.open(linkedin, '_blank')}>🔗 LinkedIn</button>}
                      <button onClick={() => dismissReply(s.id)} title="Dismiss for today" style={{ fontSize: 11, padding: '5px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--globant-border)', color: 'var(--globant-muted)', cursor: 'pointer' }}>✕</button>
                    </div>
                  </div>
                </div>
              );
            })}
            {showDismissedReplies && dismissedReplied.length > 0 && (
              <div style={{ borderTop: '1px dashed var(--globant-border)', padding: '10px 0 4px' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, paddingLeft: 4 }}>
                  ✕ Dismissed today
                </div>
                {dismissedReplied.map(({ s, daysSince }) => {
                  const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
                  return (
                    <div key={s.id} style={{ padding: '8px 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', opacity: 0.5, borderBottom: '1px solid var(--globant-border)' }}>
                      <div>
                        <span style={{ fontWeight: 600, fontSize: 12 }}>{F(s,'Name')} {F(s,'Last name')||''}</span>
                        <span style={{ fontSize: 11, color: 'var(--globant-muted)', marginLeft: 8 }}>{F(s,'Role')||''}{accNames.length ? ` · ${accNames[0]}` : ''}</span>
                        <span style={{ fontSize: 11, color: '#4ade80', marginLeft: 8 }}>{daysSince === 0 ? 'today' : `${daysSince}d ago`}</span>
                      </div>
                      <button onClick={() => undismissReply(s.id)} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.06)', border: '1px solid var(--globant-border)', color: 'var(--globant-muted)', cursor: 'pointer' }}>↩ Restore</button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        );
      })()}

      {/* Group 1: Daily Focus — scored & tagged */}
      {(() => {
        const TAG_CFG = {
          urgent:    { label: '🔴 Urgent',    color: '#ef4444', bg: 'rgba(239,68,68,0.08)',    border: '#ef4444', desc: 'Ideal follow-up window (3–7d)' },
          followup:  { label: '🟡 Follow-up', color: '#fbbf24', bg: 'rgba(251,191,36,0.06)',   border: '#fbbf24', desc: 'Follow-up overdue (8–21d)' },
          reengage:  { label: '🟣 Re-engage', color: '#a78bfa', bg: 'rgba(167,139,250,0.06)',  border: '#a78bfa', desc: 'Going cold — new angle needed' },
        };
        const groups = {};
        activeFocusItems.forEach(item => {
          const tag = item.tag || 'followup';
          if (!groups[tag]) groups[tag] = [];
          groups[tag].push(item);
        });
        const tagOrder = ['urgent', 'followup', 'reengage'];

        const renderFocusCard = ({ s, acc, score, e }, isDismissed = false) => {
          const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
          const lastOutreach = e.lastOutreach;
          const lastChannel = F(lastOutreach, 'Channel');
          const lastMsg = F(lastOutreach, 'Message');
          const lastStatus = F(lastOutreach, 'Status');
          const phone = F(s, 'Phone number');
          const email = F(s, 'Email');
          const linkedin = F(s, 'LinkedIn');
          const accDiag = acc?._enriched?.diagnosis;
          const diagCfg = accDiag ? DIAGNOSIS_CONFIG[accDiag] : null;
          const tag = e.focusTag || 'followup';
          const cfg = TAG_CFG[tag] || TAG_CFG.followup;
          return (
            <div key={s.id} style={{ padding: '12px 14px', marginBottom: 6, borderRadius: 8, background: isDismissed ? 'rgba(255,255,255,0.02)' : cfg.bg, borderLeft: `3px solid ${isDismissed ? 'var(--globant-border)' : cfg.border}`, opacity: isDismissed ? 0.65 : 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: isDismissed ? 0 : 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, cursor: 'pointer', color: isDismissed ? 'var(--globant-muted)' : 'var(--globant-green)' }} onClick={() => setHistoryStakeholder(s)}>
                    {F(s,'Name')}{F(s,'Last name') ? ` ${F(s,'Last name')}` : ''}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--globant-muted)', marginLeft: 8 }}>{F(s,'Role')} · {accNames.join(', ')}</span>
                  {diagCfg && !isDismissed && (
                    <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: diagCfg.bg, color: diagCfg.color }}>
                      {diagCfg.label}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                  {e.daysSince !== null && <span style={{ fontSize: 11, fontWeight: 700, color: isDismissed ? 'var(--globant-muted)' : cfg.color }}>{e.daysSince}d ago</span>}
                  {!isDismissed && <span className="badge badge-accent" style={{ fontSize: 9 }}>{e.totalTouches} touch{e.totalTouches !== 1 ? 'es' : ''}</span>}
                  {!isDismissed && e.hasReplied && <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 8, background: 'rgba(74,222,128,0.15)', color: '#4ade80' }}>↩ replied</span>}
                  {!isDismissed && <span title="Focus score: timing (up to +55) + influence (+10–25) + has replied (+20) + campaign (+12–20)" style={{ fontSize: 9, color: 'var(--globant-muted)', cursor: 'help' }}>score {score}</span>}
                  {isDismissed ? (
                    <button onClick={() => undismissFollowup(s.id)} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.06)', border: '1px solid var(--globant-border)', color: 'var(--globant-muted)', cursor: 'pointer' }}>↩ Restore</button>
                  ) : (
                    <button onClick={() => dismissFollowup(s.id)} title="Dismiss for today" style={{ fontSize: 11, lineHeight: 1, padding: '3px 7px', borderRadius: 6, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--globant-border)', color: 'var(--globant-muted)', cursor: 'pointer' }}>✕</button>
                  )}
                </div>
              </div>
              {!isDismissed && lastOutreach && (
                <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 8, padding: '5px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
                  <span style={{ marginRight: 6 }}>{channelIcon[lastChannel] || '📋'}</span>
                  {F(lastOutreach,'Activity Name')} · <span className="badge badge-green" style={{ fontSize: 9 }}>{lastStatus}</span>
                  {lastMsg && <div style={{ marginTop: 3, fontSize: 10, whiteSpace: 'pre-wrap', maxHeight: 32, overflow: 'hidden' }}>{lastMsg.substring(0, 120)}…</div>}
                </div>
              )}
              {!isDismissed && diagCfg && <div style={{ fontSize: 10, color: diagCfg.color, marginBottom: 8, fontStyle: 'italic' }}>💡 {diagCfg.action}</div>}
              {!isDismissed && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {email && <button className="action-btn btn-email" style={{ fontSize: 10, padding: '5px 10px' }} disabled={generatingFollowup === s.id} onClick={() => handleQuickFollowup(s, 'Email')}>{generatingFollowup === s.id ? '⏳' : '✉️ Follow-up'}</button>}
                  {phone && <button className="action-btn btn-whatsapp" style={{ fontSize: 10, padding: '5px 10px' }} disabled={generatingFollowup === s.id} onClick={() => handleQuickFollowup(s, 'WhatsApp')}>{generatingFollowup === s.id ? '⏳' : '💬 Follow-up'}</button>}
                  {linkedin && <button className="action-btn btn-linkedin" style={{ fontSize: 10, padding: '5px 10px' }} disabled={generatingFollowup === s.id} onClick={() => handleQuickFollowup(s, 'LinkedIn')}>{generatingFollowup === s.id ? '⏳' : '🔗 Follow-up'}</button>}
                  {phone && <button className="action-btn btn-call" style={{ fontSize: 10, padding: '5px 10px' }} onClick={() => useMessage(s, 'Call', '')}>📞 Call</button>}
                  <div style={{ width: 1, background: 'var(--globant-border)', margin: '0 4px' }} />
                  <button className="action-btn btn-primary" style={{ fontSize: 10, padding: '5px 10px' }} onClick={() => { setResponseModal({ stakeholder: s, lastOutreach }); setResponseText(''); }}>💬 Responded</button>
                  <button className="action-btn" style={{ fontSize: 10, padding: '5px 10px', background: 'rgba(96,165,250,0.15)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.3)' }} onClick={() => { setMeetingModal({ stakeholder: s }); setMeetingNotes(''); setMeetingDate(''); setMeetingTime(''); }}>📅 Meeting</button>
                  <button className="action-btn btn-primary" style={{ fontSize: 10, padding: '5px 10px' }} onClick={() => setSelectedStakeholder(s)}>✨ AI</button>
                </div>
              )}
            </div>
          );
        };

        return (
          <div className="card" style={{ borderLeft: '3px solid var(--globant-green)', padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--globant-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, color: 'var(--globant-green)', fontSize: 14 }}>🎯 Daily Focus ({activeFocusItems.length})</h3>
                <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Scored by timing · influence · reply history · campaign</span>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {tagOrder.filter(t => groups[t]?.length).map(t => (
                  <span key={t} style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: TAG_CFG[t].bg, color: TAG_CFG[t].color, border: `1px solid ${TAG_CFG[t].color}40` }}>
                    {TAG_CFG[t].label.split(' ')[0]} {groups[t].length}
                  </span>
                ))}
                {dismissedFocusItems.length > 0 && (
                  <button onClick={() => setShowDismissed(v => !v)} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--globant-border)', color: 'var(--globant-muted)', cursor: 'pointer' }}>
                    {showDismissed ? '▲' : '▼'} {dismissedFocusItems.length} dismissed
                  </button>
                )}
              </div>
            </div>
            {activeFocusItems.length === 0 && dismissedFocusItems.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '32px 16px' }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🎉</div>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6, color: 'var(--globant-text)' }}>Inbox clear!</div>
                <div style={{ fontSize: 13, color: 'var(--globant-muted)' }}>No follow-ups due today. Check back tomorrow or add new contacts.</div>
              </div>
            ) : (
              <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {activeFocusItems.length === 0 && (
                  <p style={{ color: 'var(--globant-muted)', fontSize: 13, margin: 0 }}>🎉 All done for today!</p>
                )}
                {tagOrder.map(tag => {
                  const items = groups[tag];
                  if (!items?.length) return null;
                  const cfg = TAG_CFG[tag];
                  return (
                    <div key={tag}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: cfg.color, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6, marginTop: 4 }}>
                        {cfg.label} — {cfg.desc}
                      </div>
                      {items.map(item => renderFocusCard(item, false))}
                    </div>
                  );
                })}
                {showDismissed && dismissedFocusItems.length > 0 && (
                  <div style={{ marginTop: 8, borderTop: '1px dashed var(--globant-border)', paddingTop: 10 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                      ✕ Dismissed today — {dismissedFocusItems.length}
                    </div>
                    {dismissedFocusItems.map(item => renderFocusCard(item, true))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Group 2: Needs First Contact */}
      <div className="card" style={{ borderLeft: '3px solid var(--globant-warning)' }}>
        <div className="card-header">
          <h3 style={{ color: 'var(--globant-warning)' }}>🟡 Needs First Contact ({filtered.length})</h3>
          <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Never contacted — use AI or direct channel to reach out</span>
        </div>
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 16px', color: 'var(--globant-muted)', fontSize: 13 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>👥</div>
            <div>All contacts have been reached out to{accountSearch ? ` for "${accountSearch}"` : ''}!</div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr><th>Contact</th><th>Account</th><th>Influence</th><th style={{ textAlign: 'center' }}>Done</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {filtered.map(s => <StakeholderRow key={s.id} s={s} />)}
            </tbody>
          </table>
        )}
      </div>

      {/* Response Modal */}
      {responseModal && (
        <div className="modal-overlay" onClick={() => setResponseModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>💬 Log Response</h3>
            <div style={{ fontSize: 13, color: 'var(--globant-muted)', marginBottom: 12 }}>
              {F(responseModal.stakeholder, 'Name')} responded — what did they say?
            </div>
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 12, padding: '6px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
              Your last message: {(F(responseModal.lastOutreach, 'Message') || '').substring(0, 100)}...
            </div>
            <textarea
              className="input-field"
              style={{ width: '100%', minHeight: 100, resize: 'vertical', marginBottom: 12, fontFamily: 'inherit' }}
              placeholder="Paste or type their response here..."
              value={responseText}
              onChange={e => setResponseText(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="action-btn btn-ghost" style={{ flex: 1 }} onClick={() => setResponseModal(null)}>Cancel</button>
              <button
                className="action-btn btn-primary"
                style={{ flex: 1 }}
                disabled={!responseText.trim()}
                onClick={async () => {
                  await logResponse(responseModal.stakeholder, responseText);
                  setResponseModal(null);
                  setResponseText('');
                }}
              >
                Log Response
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Meeting Modal */}
      {meetingModal && (() => {
        const ms = meetingModal.stakeholder;
        const msName = F(ms, 'Name') + (F(ms, 'Last name') ? ` ${F(ms, 'Last name')}` : '');
        const msEmail = F(ms, 'Email');
        const msAccNames = resolveLinked(ms, 'Account', accounts, 'Account Name');
        const msRole = F(ms, 'Role');

        const buildCalendarUrl = () => {
          if (!meetingDate) return '';
          const start = meetingTime ? `${meetingDate}T${meetingTime}:00` : `${meetingDate}T09:00:00`;
          const startDt = new Date(start);
          const endDt = new Date(startDt.getTime() + 30 * 60 * 1000);
          const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
          const title = `${COMPANY_PROFILE.companyName} x ${msAccNames[0] || 'Account'} — ${msName}`;
          const details = `Meeting with ${msName} (${msRole}) at ${msAccNames.join(', ')}\n\n${meetingNotes || 'Intro call'}`;
          return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${fmt(startDt)}/${fmt(endDt)}&details=${encodeURIComponent(details)}${msEmail ? `&add=${encodeURIComponent(msEmail)}` : ''}`;
        };

        return (
          <div className="modal-overlay" onClick={() => setMeetingModal(null)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <h3>📅 Schedule Meeting</h3>
              <div style={{ fontSize: 13, color: 'var(--globant-muted)', marginBottom: 4 }}>
                {msName} · {msRole}
              </div>
              <div style={{ fontSize: 12, color: 'var(--globant-accent)', marginBottom: 14 }}>
                {msAccNames.join(', ')}
              </div>

              <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>DATE</label>
                  <input type="date" className="input-field" style={{ width: '100%' }} value={meetingDate} onChange={e => setMeetingDate(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>TIME</label>
                  <input type="time" className="input-field" style={{ width: '100%' }} value={meetingTime} onChange={e => setMeetingTime(e.target.value)} />
                </div>
              </div>

              <label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>NOTES / AGENDA</label>
              <textarea className="input-field" style={{ width: '100%', minHeight: 70, resize: 'vertical', marginBottom: 14, fontFamily: 'inherit', fontSize: 12 }}
                placeholder="Meeting topic, agenda, key questions to ask..." value={meetingNotes} onChange={e => setMeetingNotes(e.target.value)} />

              <div style={{ display: 'flex', gap: 8 }}>
                <button className="action-btn btn-ghost" style={{ flex: 1 }} onClick={() => setMeetingModal(null)}>Cancel</button>
                {meetingDate && (
                  <button className="action-btn" style={{ flex: 1, background: 'rgba(66,133,244,0.15)', color: '#4285f4', border: '1px solid rgba(66,133,244,0.3)' }}
                    onClick={() => { window.open(buildCalendarUrl(), '_blank'); }}>
                    📆 Open in Calendar
                  </button>
                )}
                <button className="action-btn" style={{ flex: 1, background: 'rgba(96,165,250,0.2)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.4)' }}
                  onClick={async () => {
                    await logMeeting(ms, meetingNotes, meetingDate);
                    setMeetingModal(null);
                    setMeetingNotes(''); setMeetingDate(''); setMeetingTime('');
                  }}>
                  ✅ Log Meeting
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {selectedStakeholder && (
        <AIMessageModal
          stakeholder={selectedStakeholder}
          onClose={() => setSelectedStakeholder(null)}
          onSend={useMessage}
          onSuccess={() => { setSelectedStakeholder(null); if (onLogActivity) onLogActivity(); }}
          data={data}
        />
      )}

      {composeEmail && (
        <EmailComposeModal
          stakeholder={composeEmail.stakeholder}
          initialSubject={composeEmail.subject}
          initialBody={composeEmail.body}
          replyContext={composeEmail.replyContext}
          accounts={accounts}
          outreach={outreach}
          gmailConnected={gmailConnectedFC}
          onClose={() => setComposeEmail(null)}
          onSuccess={() => { setComposeEmail(null); if (onLogActivity) onLogActivity(); }}
        />
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
          onSend={useMessage}
        />
      )}
    </div>
  );
}

// ============ EMAIL COMPOSE MODAL ============

export default FollowupCenter;
