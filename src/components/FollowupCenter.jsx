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
  const [responseModal, setResponseModal] = useState(null);
  const [responseText, setResponseText] = useState('');
  const [meetingModal, setMeetingModal] = useState(null);
  const [meetingNotes, setMeetingNotes] = useState('');
  const [meetingDate, setMeetingDate] = useState('');
  const [meetingTime, setMeetingTime] = useState('');
  const [historyStakeholder, setHistoryStakeholder] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [csvRows, setCsvRows] = useState([]);
  const [generatingFollowup, setGeneratingFollowup] = useState(null);
  const [csvStatus, setCsvStatus] = useState(null);
  const [importResults, setImportResults] = useState(null);
  const [expandedReplies, setExpandedReplies] = useState({});
  const [composeEmail, setComposeEmail] = useState(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [showDismissedReplies, setShowDismissedReplies] = useState(false);
  const [openCard, setOpenCard] = useState(null);
  const [generatedMsgs, setGeneratedMsgs] = useState({});

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

  const DISMISS_KEY = 'oike_dismissed_followups';
  const [dismissedFollowups, setDismissedFollowups] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}');
      const today = new Date().toDateString();
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
  };
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

  const recentlyContacted = useMemo(() => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 3); cutoff.setHours(0, 0, 0, 0);
    const ids = new Set();
    outreach.forEach(o => {
      const d = o.fields?.['Date'] ? new Date(o.fields['Date']) : null;
      if (d && d >= cutoff) linkedIds(o, 'Stakeholder').forEach(id => ids.add(id));
    });
    return ids;
  }, [outreach]);

  const dailyFocusItems = useMemo(() => {
    const campaigns = data.campaigns || [];
    const results = [];
    stakeholders.forEach(s => {
      const e = s._enriched;
      if (!e) return;
      if (e.contactedToday) return;
      if (e.daysSince !== null && e.daysSince < 3) return;
      if (accountSearch) {
        const term = accountSearch.toLowerCase();
        const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
        if (!accNames.some(n => n.toLowerCase().includes(term))) return;
      }
      if (selectedInfluence && F(s, 'Level of Influence') !== selectedInfluence) return;
      if (searchName && !(F(s, 'Name') || '').toLowerCase().includes(searchName.toLowerCase())) return;
      if (e.totalTouches === 0) return;
      let score = e.focusScore;
      const inCampaign = campaigns.some(c => {
        const assigned = linkedIds(c, 'Assigned Stakeholders');
        return assigned.includes(s.id) && F(c, 'Status') !== 'Inactive';
      });
      if (inCampaign) score += 12;
      const accId = linkedIds(s, 'Account')[0];
      const acc = accId ? accounts.find(a => a.id === accId) : null;
      if (acc?._enriched?.inActiveCampaign) score += 8;
      if (!e.focusTag) return;
      results.push({ s, acc, score, tag: e.focusTag, e });
    });
    return results.sort((a, b) => b.score - a.score);
  }, [stakeholders, accounts, data.campaigns, accountSearch, selectedInfluence, searchName]);

  const activeFocusItems    = dailyFocusItems.filter(item => !dismissedFollowups[item.s.id]);
  const dismissedFocusItems = dailyFocusItems.filter(item =>  dismissedFollowups[item.s.id]);
  const urgentItems   = activeFocusItems.filter(item => item.tag === 'urgent');
  const followupItems = activeFocusItems.filter(item => item.tag === 'followup');
  const reengageItems = activeFocusItems.filter(item => item.tag === 'reengage');

  const followupPending = dailyFocusItems;

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
    if (recentlyContacted.has(s.id)) return false;
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

  const handleQuickFollowup = async (s, channel) => {
    setGeneratingFollowup(s.id);
    try {
      const sName = F(s, 'Name') || '';
      const role = F(s, 'Role') || '';
      const accIds = linkedIds(s, 'Account') || [];
      const accNames = accIds.map(id => { const a = accounts.find(x => x.id === id); return a ? F(a, 'Account Name') : ''; }).filter(Boolean);
      const allSolutions = data.solutions || [];
      const accRecord = accIds[0] ? accounts.find(a => a.id === accIds[0]) : null;
      const linkedSolIds = accRecord ? (linkedIds(accRecord, 'Solutions') || []) : [];
      const relevantSolutions = linkedSolIds.length > 0
        ? allSolutions.filter(sol => linkedSolIds.includes(sol.id))
        : allSolutions.slice(0, 6);
      const offeringsText = relevantSolutions.map(sol => {
        const name = F(sol, 'Name') || '';
        const detail = (F(sol, 'Service | Solution Detail') || '').slice(0, 200);
        return `• ${name}${detail ? `: ${detail}` : ''}`;
      }).join('\n');
      const sOutreach = outreach
        .filter(o => linkedIds(o, 'Stakeholder').includes(s.id))
        .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
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
      const history = sOutreach.slice(0, 5)
        .map(o => {
          const dir = ['received','replied'].includes((F(o,'Status')||'').toLowerCase()) ? 'THEY' : 'YOU';
          const date = o.fields?.['Date'] ? new Date(o.fields['Date']).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?';
          const msg = (F(o,'Message') || F(o,'Notes') || '').replace(/^(\[g[^\]]+\])+\s*/,'').slice(0, 300);
          return `[${dir} · ${F(o,'Channel')||'?'} · ${date}]\n${msg}`;
        })
        .join('\n\n');
      const prompt = `You are a senior B2B sales rep at ${COMPANY_PROFILE.companyName || 'our company'}.\n\nABOUT US:\n${COMPANY_PROFILE.services ? `- What we do: ${COMPANY_PROFILE.services}` : ''}\n${COMPANY_PROFILE.goals ? `- Focus: ${COMPANY_PROFILE.goals}` : ''}\n${COMPANY_PROFILE.voiceTone ? `- Voice: ${COMPANY_PROFILE.voiceTone}` : ''}\n${COMPANY_PROFILE.voiceAvoid ? `- Never say: ${COMPANY_PROFILE.voiceAvoid}` : ''}\n\nOUR OFFERINGS${accNames[0] ? ` (relevant to ${accNames[0]})` : ''}:\n${offeringsText || COMPANY_PROFILE.services || '(no offerings configured)'}\n\nCONTACT: ${sName} — ${role} at ${accNames[0] || 'their company'}\n\n${lastSentContent ? `LAST MESSAGE YOU SENT (${lastSentDate}):\n"${lastSentContent}"\n\n` : ''}FULL CONVERSATION HISTORY:\n${history || '— No history found —'}\n\nMISSION: Write ONE short follow-up that continues naturally from the last message you sent — same topic/thread, new angle. Don't restart from scratch. Don't reference "following up". Max 3 sentences. Grounded in our actual offerings above. Human, direct, no filler.\n\nChannel: ${channel}\n${channel === 'Email' ? 'First line must be "Subject: [subject]", then blank line, then body.' : ''}\n${channel === 'WhatsApp' ? 'Ultra short. Casual tone. No subject line.' : ''}\n${channel === 'LinkedIn' ? 'Short, professional but conversational.' : ''}\n\nBANNED: "just following up" / "checking in" / "touching base" / "I hope this finds you well" / "I wanted to reach out" / brackets or placeholders. NEVER invent capabilities we don't have.\n\nOutput ONLY the message, nothing else.`;
      const generated = await callOpenAI({ prompt, temperature: 0.8, max_tokens: 300 });
      useMessage(s, channel, generated.trim());
    } catch (e) {
      console.error('Quick followup generation failed:', e);
      useMessage(s, channel, '');
    }
    setGeneratingFollowup(null);
  };

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
      if (email) {
        setComposeEmail({ stakeholder, subject, body, replyContext: null });
        return;
      }
    }
    if (channel === 'WhatsApp' && phone) window.open(`https://wa.me/${String(phone).replace(/[^0-9+]/g, '')}?text=${encodeURIComponent(message)}`, '_blank');
    else if (channel === 'LinkedIn' && linkedin) { navigator.clipboard.writeText(message).catch(() => {}); window.open(linkedin, '_blank'); }
    else if (channel === 'Call' && phone) window.open(`tel:${phone}`, '_self');
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
        if (eventId) {
          try {
            const evCached = (data.events || []).find(e => e.id === eventId);
            const currentInvited = evCached ? linkedIds(evCached, 'Stakeholders invited') : [];
            await a.updateRecord(TABLE_IDS.events, eventId, {
              'Stakeholders invited': [...new Set([...currentInvited, stakeholder.id])],
            });
          } catch(evErr) { console.error('[useMessage] event invite update failed:', evErr); }
        }
      })
      .then(() => { if (onLogActivity) onLogActivity(); })
      .catch(e => console.error('Auto-log failed:', e));
  };

  const suggestChannel = (s, lastChannel) => {
    const phone = F(s, 'Phone number');
    const linkedin = F(s, 'LinkedIn');
    const email = F(s, 'Email');
    if (lastChannel === 'Email' && phone) return 'WhatsApp';
    if (lastChannel === 'Email' && linkedin) return 'LinkedIn';
    if (lastChannel === 'WhatsApp' && linkedin) return 'LinkedIn';
    if (lastChannel === 'LinkedIn' && email) return 'Email';
    if (phone) return 'WhatsApp';
    if (linkedin) return 'LinkedIn';
    return 'Email';
  };

  const generateFollowupText = async (s, channel) => {
    const sName = F(s, 'Name') || '';
    const role = F(s, 'Role') || '';
    const accIds = linkedIds(s, 'Account') || [];
    const accNames = accIds.map(id => { const a = accounts.find(x => x.id === id); return a ? F(a, 'Account Name') : ''; }).filter(Boolean);
    const allSolutions = data.solutions || [];
    const accRecord = accIds[0] ? accounts.find(a => a.id === accIds[0]) : null;
    const linkedSolIds = accRecord ? (linkedIds(accRecord, 'Solutions') || []) : [];
    const relevantSolutions = linkedSolIds.length > 0 ? allSolutions.filter(sol => linkedSolIds.includes(sol.id)) : allSolutions.slice(0, 4);
    const offeringsText = relevantSolutions.map(sol => `• ${F(sol, 'Name') || ''}${(F(sol, 'Service | Solution Detail') || '').slice(0, 150) ? ': ' + (F(sol, 'Service | Solution Detail') || '').slice(0, 150) : ''}`).join('\n');
    const sOutreach = outreach.filter(o => linkedIds(o, 'Stakeholder').includes(s.id)).sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
    const lastSent = sOutreach.find(o => { const st = (F(o, 'Status') || '').toLowerCase(); return st === 'sent' || st === 'draft'; });
    const lastSentContent = lastSent ? (F(lastSent, 'Message') || F(lastSent, 'Notes') || '').replace(/^(\[g[^\]]+\])+\s*/, '').slice(0, 400) : '';
    const history = sOutreach.slice(0, 4).map(o => { const dir = ['received','replied'].includes((F(o,'Status')||'').toLowerCase()) ? 'THEY' : 'YOU'; const date = o.fields?.['Date'] ? new Date(o.fields['Date']).toLocaleDateString('en-US', {month:'short',day:'numeric'}) : '?'; const msg = (F(o,'Message') || F(o,'Notes') || '').replace(/^(\[g[^\]]+\])+\s*/,'').slice(0, 250); return `[${dir} · ${F(o,'Channel')||'?'} · ${date}]\n${msg}`; }).join('\n\n');
    const prompt = `B2B sales rep at ${COMPANY_PROFILE.companyName || 'our company'}. Write ONE short follow-up message.\n\nCONTACT: ${sName} — ${role} at ${accNames[0] || 'their company'}\nOFFERINGS: ${offeringsText || COMPANY_PROFILE.services || ''}\n${lastSentContent ? `LAST MESSAGE YOU SENT:\n"${lastSentContent}"\n\n` : ''}HISTORY:\n${history || '— none —'}\n\nMISSION: Continue naturally from last message. New angle. Max 3 sentences. No "following up" / "checking in" / "hope this finds you". Human, direct.\nChannel: ${channel}${channel === 'Email' ? '\nFirst line: "Subject: [subject]", blank line, then body.' : ''}${channel === 'WhatsApp' ? '\nUltra short, casual.' : ''}\n\nOutput ONLY the message.`;
    const generated = await callOpenAI({ prompt, temperature: 0.8, max_tokens: 300 });
    return generated.trim();
  };

  const generateForContact = async (s) => {
    const lastChannel = F(s._enriched?.lastOutreach, 'Channel');
    const channel = suggestChannel(s, lastChannel);
    setGeneratedMsgs(prev => ({ ...prev, [s.id]: { text: '', channel, loading: true } }));
    try {
      const text = await generateFollowupText(s, channel);
      setGeneratedMsgs(prev => ({ ...prev, [s.id]: { text, channel, loading: false } }));
    } catch {
      setGeneratedMsgs(prev => ({ ...prev, [s.id]: { text: '', channel, loading: false } }));
    }
  };

  const generateBatch = async (items) => {
    const first5 = items.slice(0, 5);
    await Promise.all(first5.map(({ s }) => generateForContact(s)));
  };

  const executeUrgentTask = async (task, channel) => {
    const stkName = F(task, 'Stakeholder') || '';
    const stkRec = stakeholders.find(s => {
      const full = `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim();
      return full && stkName && full.toLowerCase() === stkName.toLowerCase();
    });
    if (!stkRec) {
      window.__oikeToast(`Stakeholder "${stkName}" not found.`, 'warning');
      return;
    }
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
      const history = outreach
        .filter(o => linkedIds(o, 'Stakeholder').includes(stkRec.id))
        .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0))
        .slice(0, 3)
        .map(o => `[${F(o,'Channel')||'?'} · ${F(o,'Status')||'?'} · ${o.fields?.['Date'] ? new Date(o.fields['Date']).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '?'}]\n${(F(o,'Message') || F(o,'Notes') || '').slice(0, 250)}`)
        .join('\n---\n');
      const intentGuidance = {
        meeting_request: 'They asked for a meeting. Propose 3 concrete time slots next week.',
        info_request: 'They asked for information. Acknowledge the specific ask, promise to send within 24h.',
        objection: 'They raised an objection. Acknowledge briefly, reframe value in 1 line.',
        follow_up_needed: 'They engaged but stalled. Bring a NEW angle. Ask ONE specific question.',
        engaged: 'They are moving. Keep momentum — confirm the next concrete step.',
        introduction_needed: 'They asked for intro. Acknowledge, ask best way to reach that person.',
        not_now: 'They said not now. Respect briefly, ask when would be better.',
        ghosted: 'No response. Try a new angle, be brief, add one micro-value point.',
        other: 'Respond with a specific, actionable next step based on the guidance below.',
      };
      const senderName = (typeof COMPANY_PROFILE !== 'undefined' && COMPANY_PROFILE.senderName) ? COMPANY_PROFILE.senderName : (CURRENT_USER?.name || '');
      const prompt = `You are writing ONE ${channel} message as ${senderName || 'the sender'} to ${stkName}${role ? ' (' + role + ')' : ''}${accName ? ' at ' + accName : ''}.\n\nWHAT THE AI RECOMMENDED AS NEXT STEP FOR THIS CONTACT:\n"${nextStep}"\n\nINTENT OF THEIR LAST REPLY: ${intent}\nGUIDANCE: ${intentGuidance[intent] || intentGuidance.other}\n\nPREVIOUS CONVERSATION (most recent first):\n${history || '— no history —'}\n\nRULES:\n- Short. Human. Direct. No filler.\n- Do NOT say "hope you're well", "just following up", "touching base", "I wanted to reach out".\n- Use the contact's first name once at the start.\n${channel === 'Email' ? '- First line: "Subject: [concise subject]", then BLANK LINE, then body. Body max 6 lines.' : ''}\n${channel === 'WhatsApp' ? '- Ultra casual, max 4 lines, no subject line.' : ''}\n${channel === 'LinkedIn' ? '- Conversational, max 5 lines, no subject line.' : ''}\n\nOutput ONLY the message, nothing else.`;
      let message = '';
      try {
        const raw = await callOpenAI({ prompt, temperature: 0.7, max_tokens: 400 });
        message = (raw || '').trim();
      } catch (e) {
        console.error('AI message gen failed:', e);
        message = nextStep;
      }
      useMessage(stkRec, channel, message);
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
    const dup = findDuplicateStakeholder(fields, stakeholders);
    if (dup && !confirmDuplicateStakeholder(dup)) return;
    if (onAddRecord) onAddRecord('stakeholders', fields);
    setFuNewName(''); setFuNewLast(''); setFuNewRole(''); setFuNewEmail('');
    setFuNewPhone(''); setFuNewLinkedin(''); setFuNewInfluence(''); setFuNewAccountId('');
    setShowFuNewStk(false);
    const a = api || new AirtableAPI();
    a.createRecord(TABLE_IDS.stakeholders, fields)
      .then(() => { if (onLogActivity) onLogActivity(); })
      .catch(e => { console.error(e); window.__oikeToast('Failed to create contact', 'error'); if (onLogActivity) onLogActivity(); });
  };

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
            <button className="action-btn btn-primary" style={{ fontSize: 11 }} onClick={() => setSelectedStakeholder(s)}>✨ Message</button>
            {phone && <button className="action-btn btn-whatsapp" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => setSelectedStakeholder(s)}>💬</button>}
            {email && <button className="action-btn btn-email" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => setSelectedStakeholder(s)}>✉️</button>}
            {linkedin && <button className="action-btn btn-linkedin" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => setSelectedStakeholder(s)}>🔗</button>}
            {phone && <button className="action-btn btn-call" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => useMessage(s, 'Call', '')}>📞</button>}
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
        <h1>My Day</h1>
        <p>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      </div>

      {gmailConnectedFC && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, padding: '8px 14px', background: 'rgba(91,191,181,0.06)', border: '1px solid rgba(91,191,181,0.15)', borderRadius: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--globant-muted)', flex: 1 }}>{gmailSyncMsg || 'Sync Gmail inbox to capture new replies from your contacts.'}</span>
          <button className="action-btn" style={{ background: 'rgba(91,191,181,0.15)', color: 'var(--globant-green)', border: '1px solid rgba(91,191,181,0.3)', fontSize: 11, padding: '5px 12px', flexShrink: 0 }} onClick={handleGmailSyncFC} disabled={gmailSyncing}>{gmailSyncing ? '⏳ Syncing...' : '🔄 Sync inbox'}</button>
        </div>
      )}

      {/* 4 Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        <div onClick={() => setOpenCard(openCard === 'replied' ? null : 'replied')} style={{ cursor: 'pointer', padding: '20px 16px', borderRadius: 12, background: openCard === 'replied' ? 'rgba(74,222,128,0.12)' : 'var(--globant-card)', border: `2px solid ${openCard === 'replied' ? '#4ade80' : repliedToYou.length > 0 ? 'rgba(74,222,128,0.4)' : 'var(--globant-border)'}`, transition: 'all 0.2s' }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#4ade80', marginBottom: 4 }}>{repliedToYou.length}</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--globant-text)', marginBottom: 2 }}>📩 Replied to you</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Your turn to respond</div>
        </div>
        <div onClick={() => { setOpenCard(openCard === 'urgent' ? null : 'urgent'); if (openCard !== 'urgent' && urgentItems.length > 0) generateBatch(urgentItems); }} style={{ cursor: 'pointer', padding: '20px 16px', borderRadius: 12, background: openCard === 'urgent' ? 'rgba(239,68,68,0.1)' : 'var(--globant-card)', border: `2px solid ${openCard === 'urgent' ? '#ef4444' : urgentItems.length > 0 ? 'rgba(239,68,68,0.4)' : 'var(--globant-border)'}`, transition: 'all 0.2s' }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#ef4444', marginBottom: 4 }}>{urgentItems.length}</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--globant-text)', marginBottom: 2 }}>🔴 Follow up now</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)' }}>3–7 days — ideal window</div>
        </div>
        <div onClick={() => { setOpenCard(openCard === 'followup' ? null : 'followup'); if (openCard !== 'followup' && followupItems.length > 0) generateBatch(followupItems); }} style={{ cursor: 'pointer', padding: '20px 16px', borderRadius: 12, background: openCard === 'followup' ? 'rgba(251,191,36,0.1)' : 'var(--globant-card)', border: `2px solid ${openCard === 'followup' ? '#fbbf24' : followupItems.length > 0 ? 'rgba(251,191,36,0.4)' : 'var(--globant-border)'}`, transition: 'all 0.2s' }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#fbbf24', marginBottom: 4 }}>{followupItems.length}</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--globant-text)', marginBottom: 2 }}>🟡 Overdue</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)' }}>8–21 days — don&apos;t lose them</div>
        </div>
        <div onClick={() => { setOpenCard(openCard === 'reengage' ? null : 'reengage'); if (openCard !== 'reengage' && reengageItems.length > 0) generateBatch(reengageItems); }} style={{ cursor: 'pointer', padding: '20px 16px', borderRadius: 12, background: openCard === 'reengage' ? 'rgba(167,139,250,0.1)' : 'var(--globant-card)', border: `2px solid ${openCard === 'reengage' ? '#a78bfa' : reengageItems.length > 0 ? 'rgba(167,139,250,0.4)' : 'var(--globant-border)'}`, transition: 'all 0.2s' }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#a78bfa', marginBottom: 4 }}>{reengageItems.length}</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--globant-text)', marginBottom: 2 }}>🟣 Re-engage</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)' }}>22+ days — new angle needed</div>
        </div>
      </div>

      {/* Expanded: Replied to you */}
      {openCard === 'replied' && (
        <div className="card" style={{ borderLeft: '3px solid #4ade80', marginBottom: 16 }}>
          <div className="card-header">
            <h3 style={{ color: '#4ade80' }}>📩 Replied to you ({repliedToYou.length})</h3>
            <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>They wrote back — respond now</span>
          </div>
          {repliedToYou.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--globant-muted)' }}>All clear!</div>
          ) : repliedToYou.map(({ s, lastOutreach: lo, daysSince }) => {
            const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
            const email = F(s, 'Email') || '';
            const phone = F(s, 'Phone number') || '';
            const linkedin = F(s, 'LinkedIn') || '';
            const notes = F(lo, 'Notes') || '';
            const msgField = F(lo, 'Message') || '';
            const gmsgMatch = notes.match(/\[gmsg:([^\]]+)\]/);
            const gmsgId = gmsgMatch ? gmsgMatch[1] : null;
            const gmailLink = gmsgId ? `https://mail.google.com/mail/#inbox/${gmsgId}` : null;
            const strippedNotes = notes.replace(/^(\[g[^\]]+\])+\s*/,'').trim();
            const rawContent = msgField.trim() || strippedNotes;
            const contentLines = rawContent.split('\n');
            const hasGmsg = !!gmsgMatch && !msgField.trim();
            const subject = hasGmsg ? (contentLines[0] || '') : '';
            const bodyText = (hasGmsg ? contentLines.slice(1).join('\n') : rawContent).trim();
            return (
              <div key={s.id} style={{ padding: '14px 0', borderBottom: '1px solid var(--globant-border)', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 14, cursor: 'pointer', color: 'var(--globant-green)' }} onClick={() => setHistoryStakeholder(s)}>{F(s,'Name')} {F(s,'Last name')||''}</span>
                    <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>{F(s,'Role')||''}{accNames.length ? ` · ${accNames[0]}` : ''}</span>
                    <span style={{ fontSize: 11, color: '#4ade80', background: 'rgba(74,222,128,0.1)', padding: '2px 8px', borderRadius: 20 }}>{daysSince === 0 ? 'today' : `${daysSince}d ago`}</span>
                  </div>
                  {bodyText && <div style={{ fontSize: 12, color: 'var(--globant-muted)', background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.18)', borderRadius: 8, padding: '8px 12px', marginBottom: 8 }}>{subject && <div style={{ fontWeight: 700, marginBottom: 4 }}>📧 {subject}</div>}{bodyText.slice(0, 250)}{bodyText.length > 250 ? '…' : ''}</div>}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {email && <button className="action-btn btn-email" style={{ fontSize: 11, padding: '5px 12px' }} onClick={() => { const replyContext = { threadId: (notes.match(/\[gthread:([^\]]+)\]/) || [])[1] || null, inReplyTo: (notes.match(/\[gmsgid:([^\]]+)\]/) || [])[1] || null, readMsgId: gmsgId }; setComposeEmail({ stakeholder: s, subject: subject ? `Re: ${subject}` : '', body: '', replyContext }); }}>✉️ Reply</button>}
                    {phone && <button className="action-btn btn-whatsapp" style={{ fontSize: 11, padding: '5px 12px' }} onClick={() => window.open(`https://wa.me/${phone.replace(/\D/g,'')}`, '_blank')}>💬 WhatsApp</button>}
                    {linkedin && <button className="action-btn btn-linkedin" style={{ fontSize: 11, padding: '5px 12px' }} onClick={() => window.open(linkedin, '_blank')}>🔗 LinkedIn</button>}
                    {gmailLink && <a href={gmailLink} target="_blank" rel="noreferrer" style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, background: 'rgba(96,165,250,0.12)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.25)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>📨 Gmail</a>}
                    <button className="action-btn btn-ghost" style={{ fontSize: 11, padding: '5px 12px' }} onClick={() => setHistoryStakeholder(s)}>View history</button>
                    <button onClick={() => dismissReply(s.id)} style={{ fontSize: 11, padding: '5px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--globant-border)', color: 'var(--globant-muted)', cursor: 'pointer' }}>✕</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Expanded: urgent / followup / reengage */}
      {(['urgent', 'followup', 'reengage']).map(cardType => {
        const items = cardType === 'urgent' ? urgentItems : cardType === 'followup' ? followupItems : reengageItems;
        const color = cardType === 'urgent' ? '#ef4444' : cardType === 'followup' ? '#fbbf24' : '#a78bfa';
        const label = cardType === 'urgent' ? '🔴 Follow up now' : cardType === 'followup' ? '🟡 Overdue follow-up' : '🟣 Re-engage';
        if (openCard !== cardType) return null;
        return (
          <div key={cardType} className="card" style={{ borderLeft: `3px solid ${color}`, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <h3 style={{ margin: 0, color, fontSize: 14 }}>{label} ({items.length})</h3>
                <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>
                  {cardType === 'urgent' ? 'Ideal window — reach out now' : cardType === 'followup' ? "Overdue — don't let them go cold" : 'Going cold — try a new angle'}
                </span>
              </div>
              <button className="action-btn btn-primary" style={{ fontSize: 11 }} onClick={() => generateBatch(items)}>✨ Generate all</button>
            </div>
            {items.length === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--globant-muted)', fontSize: 13 }}>🎉 All clear!</div>
            ) : items.map(({ s, e }) => {
              const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
              const msgState = generatedMsgs[s.id];
              const phone = F(s, 'Phone number');
              const email = F(s, 'Email');
              const linkedin = F(s, 'LinkedIn');
              const lastChannel = F(e?.lastOutreach, 'Channel');
              const sugCh = msgState?.channel || suggestChannel(s, lastChannel);
              const chIcon = { Email: '✉️', WhatsApp: '💬', LinkedIn: '🔗', Call: '📞' };
              return (
                <div key={s.id} style={{ padding: '14px', marginBottom: 8, borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--globant-border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, fontSize: 14, cursor: 'pointer', color: 'var(--globant-green)' }} onClick={() => setHistoryStakeholder(s)}>{F(s,'Name')} {F(s,'Last name')||''}</span>
                      <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>{F(s,'Role')||''}{accNames.length ? ` · ${accNames[0]}` : ''}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color }}>{e.daysSince}d ago</span>
                      {sugCh && <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: `${color}22`, color, border: `1px solid ${color}44`, fontWeight: 600 }}>{chIcon[sugCh]} {sugCh} suggested</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => setHistoryStakeholder(s)}>History</button>
                      <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => dismissFollowup(s.id)}>✕</button>
                    </div>
                  </div>
                  <div style={{ position: 'relative', marginBottom: 10 }}>
                    {msgState?.loading ? (
                      <div style={{ padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: '1px solid var(--globant-border)', fontSize: 12, color: 'var(--globant-muted)', textAlign: 'center' }}>✨ Generating...</div>
                    ) : (
                      <textarea
                        className="input-field"
                        style={{ width: '100%', minHeight: msgState?.text ? 80 : 44, resize: 'vertical', fontSize: 12, fontFamily: 'inherit', background: msgState?.text ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)', color: msgState?.text ? 'var(--globant-text)' : 'var(--globant-muted)' }}
                        placeholder={msgState === undefined ? 'Click ✨ Generate to create a message...' : 'Generation failed — type manually or try again'}
                        value={msgState?.text || ''}
                        onChange={e2 => setGeneratedMsgs(prev => ({ ...prev, [s.id]: { ...(prev[s.id] || {}), text: e2.target.value } }))}
                      />
                    )}
                    {!msgState?.loading && <button className="action-btn btn-primary" style={{ position: 'absolute', right: 6, bottom: 6, fontSize: 10, padding: '3px 8px' }} onClick={() => generateForContact(s)}>✨ {msgState?.text ? 'Regen' : 'Generate'}</button>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {email && <button className={`action-btn ${sugCh === 'Email' ? 'btn-email' : 'btn-ghost'}`} style={{ fontSize: 11, padding: '5px 12px' }} onClick={() => { useMessage(s, 'Email', msgState?.text || ''); setGeneratedMsgs(prev => { const n = {...prev}; delete n[s.id]; return n; }); dismissFollowup(s.id); }}>✉️ Email{sugCh === 'Email' ? ' ✓' : ''}</button>}
                    {phone && <button className={`action-btn ${sugCh === 'WhatsApp' ? 'btn-whatsapp' : 'btn-ghost'}`} style={{ fontSize: 11, padding: '5px 12px' }} onClick={() => { useMessage(s, 'WhatsApp', msgState?.text || ''); dismissFollowup(s.id); }}>💬 WhatsApp{sugCh === 'WhatsApp' ? ' ✓' : ''}</button>}
                    {linkedin && <button className={`action-btn ${sugCh === 'LinkedIn' ? 'btn-linkedin' : 'btn-ghost'}`} style={{ fontSize: 11, padding: '5px 12px' }} onClick={() => { useMessage(s, 'LinkedIn', msgState?.text || ''); dismissFollowup(s.id); }}>🔗 LinkedIn{sugCh === 'LinkedIn' ? ' ✓' : ''}</button>}
                    {phone && <button className="action-btn btn-ghost" style={{ fontSize: 11, padding: '5px 12px' }} onClick={() => useMessage(s, 'Call', '')}>📞 Call</button>}
                    <button className="action-btn" style={{ fontSize: 11, padding: '5px 12px', background: 'rgba(96,165,250,0.15)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.3)' }} onClick={() => { setResponseModal({ stakeholder: s, lastOutreach: e.lastOutreach }); setResponseText(''); }}>↩ Responded</button>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {/* ⚡ Urgent AI Tasks */}
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
              const stkRec = stakeholders.find(s => { const full = `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim(); return full && stkName && full.toLowerCase() === stkName.toLowerCase(); });
              const urgColor = urgency === 'High' ? '#ef4444' : urgency === 'Medium' ? '#fbbf24' : '#9ca3af';
              const urgBg = urgency === 'High' ? 'rgba(239,68,68,0.08)' : urgency === 'Medium' ? 'rgba(251,191,36,0.08)' : 'rgba(156,163,175,0.06)';
              const isEditing = editingTaskId === task.id;
              const isBusy = taskBusyId === task.id;
              return (
                <div key={task.id} style={{ padding: '12px 14px', marginBottom: 8, borderRadius: 8, background: urgBg, borderLeft: `3px solid ${urgColor}`, opacity: isBusy ? 0.5 : 1, transition: 'opacity 0.2s' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
                    <div style={{ flex: 1 }}>
                      {stkName && <span style={{ fontWeight: 700, fontSize: 13, color: stkRec ? 'var(--globant-green)' : 'var(--globant-text)', cursor: stkRec ? 'pointer' : 'default' }} onClick={() => stkRec && setHistoryStakeholder(stkRec)}>{stkName}</span>}
                      {accName && <span style={{ fontSize: 11, color: 'var(--globant-muted)', marginLeft: stkName ? 8 : 0 }}>{accName}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: intentBadge.bg, color: intentBadge.color }}>{intentBadge.label}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: urgColor + '22', color: urgColor }}>{urgency === 'High' ? '🔥 HIGH' : urgency === 'Medium' ? '⏳ MEDIUM' : '🌙 LOW'}</span>
                    </div>
                  </div>
                  {isEditing ? (
                    <div style={{ marginBottom: 8 }}>
                      <textarea className="input-field" style={{ width: '100%', minHeight: 60, fontSize: 12, fontFamily: 'inherit', resize: 'vertical' }} value={editingTaskText} onChange={e => setEditingTaskText(e.target.value)} autoFocus />
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
                  {!isEditing && (() => {
                    const stkEmail = stkRec ? F(stkRec, 'Email') : '';
                    const stkPhone = stkRec ? F(stkRec, 'Phone number') : '';
                    const stkLinkedin = stkRec ? F(stkRec, 'LinkedIn') : '';
                    return (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        {stkEmail && <button className="action-btn btn-email" style={{ fontSize: 10, padding: '5px 10px' }} disabled={isBusy} onClick={() => executeUrgentTask(task, 'Email')}>{isBusy ? '⏳' : '✉️ Send email + log'}</button>}
                        {stkPhone && <button className="action-btn btn-whatsapp" style={{ fontSize: 10, padding: '5px 10px' }} disabled={isBusy} onClick={() => executeUrgentTask(task, 'WhatsApp')}>{isBusy ? '⏳' : '💬 WhatsApp + log'}</button>}
                        {stkLinkedin && <button className="action-btn btn-linkedin" style={{ fontSize: 10, padding: '5px 10px' }} disabled={isBusy} onClick={() => executeUrgentTask(task, 'LinkedIn')}>{isBusy ? '⏳' : '🔗 LinkedIn + log'}</button>}
                        {!stkRec && <span style={{ fontSize: 10, color: 'var(--globant-muted)', fontStyle: 'italic' }}>⚠️ Contact not found — skip or edit</span>}
                        <div style={{ width: 1, background: 'var(--globant-border)', margin: '0 4px', alignSelf: 'stretch' }} />
                        <button className="action-btn" style={{ fontSize: 10, padding: '5px 10px', background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }} disabled={isBusy} onClick={() => snoozeTask(task, 3)}>💤 Snooze 3d</button>
                        <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '5px 10px' }} disabled={isBusy} onClick={() => { setEditingTaskId(task.id); setEditingTaskText(taskText); }}>✏️ Edit</button>
                        <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '5px 10px' }} disabled={isBusy} onClick={() => markTaskDone(task)}>✅ Skip — mark done</button>
                        {stkRec && <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '5px 10px' }} onClick={() => setHistoryStakeholder(stkRec)}>🔗 View conversation</button>}
                        {acc && goToAccount && <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '5px 10px' }} onClick={() => goToAccount(acc.id)}>🏢 Account</button>}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* New Contact */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, marginTop: 16 }}>
        <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={() => setShowFuNewStk(!showFuNewStk)}>{showFuNewStk ? '✕ Close' : '➕ New Contact'}</button>
      </div>

      {showFuNewStk && (
        <div className="card" style={{ borderLeft: '3px solid var(--globant-green)', marginBottom: 16 }}>
          <div className="card-header"><h3>➕ Create New Contact</h3></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <div><label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>FIRST NAME *</label><input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="e.g. Khalid" value={fuNewName} onChange={e => setFuNewName(e.target.value)} /></div>
            <div><label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>LAST NAME</label><input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="e.g. Al-Rashid" value={fuNewLast} onChange={e => setFuNewLast(e.target.value)} /></div>
            <div><label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>ACCOUNT *</label><select className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} value={fuNewAccountId} onChange={e => setFuNewAccountId(e.target.value)}><option value="">Select account...</option>{accounts.map(a => <option key={a.id} value={a.id}>{F(a, 'Account Name')}</option>)}</select></div>
            <div><label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>ROLE</label><input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="e.g. CTO" value={fuNewRole} onChange={e => setFuNewRole(e.target.value)} /></div>
            <div><label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>EMAIL</label><input className="input-field" type="email" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="email@company.com" value={fuNewEmail} onChange={e => setFuNewEmail(e.target.value)} /></div>
            <div><label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>PHONE</label><input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="+971..." value={fuNewPhone} onChange={e => setFuNewPhone(e.target.value)} /></div>
            <div><label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>LINKEDIN URL</label><input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="https://linkedin.com/in/..." value={fuNewLinkedin} onChange={e => setFuNewLinkedin(e.target.value)} /></div>
            <div><label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>INFLUENCE</label><select className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} value={fuNewInfluence} onChange={e => setFuNewInfluence(e.target.value)}><option value="">Select...</option><option value="High">High</option><option value="Medium">Medium</option><option value="Low">Low</option></select></div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={fuCreateStakeholder} disabled={!fuNewName.trim() || !fuNewAccountId || fuCreating}>{fuCreating ? '⏳ Creating...' : '🚀 Create Contact'}</button>
            <button className="action-btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowFuNewStk(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Needs First Contact */}
      {filtered.length > 0 && (
        <div className="card" style={{ borderLeft: '3px solid var(--globant-warning)' }}>
          <div className="card-header">
            <h3 style={{ color: 'var(--globant-warning)' }}>🟡 Needs First Contact ({filtered.length})</h3>
            <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Never contacted — use AI or direct channel to reach out</span>
          </div>
          <table className="data-table">
            <thead><tr><th>Contact</th><th>Account</th><th>Influence</th><th style={{ textAlign: 'center' }}>Done</th><th>Actions</th></tr></thead>
            <tbody>{filtered.map(s => <StakeholderRow key={s.id} s={s} />)}</tbody>
          </table>
        </div>
      )}

      {responseModal && (
        <div className="modal-overlay" onClick={() => setResponseModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>💬 Log Response</h3>
            <div style={{ fontSize: 13, color: 'var(--globant-muted)', marginBottom: 12 }}>{F(responseModal.stakeholder, 'Name')} responded — what did they say?</div>
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 12, padding: '6px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>Your last message: {(F(responseModal.lastOutreach, 'Message') || '').substring(0, 100)}...</div>
            <textarea className="input-field" style={{ width: '100%', minHeight: 100, resize: 'vertical', marginBottom: 12, fontFamily: 'inherit' }} placeholder="Paste or type their response here..." value={responseText} onChange={e => setResponseText(e.target.value)} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="action-btn btn-ghost" style={{ flex: 1 }} onClick={() => setResponseModal(null)}>Cancel</button>
              <button className="action-btn btn-primary" style={{ flex: 1 }} disabled={!responseText.trim()} onClick={async () => { await logResponse(responseModal.stakeholder, responseText); setResponseModal(null); setResponseText(''); }}>Log Response</button>
            </div>
          </div>
        </div>
      )}

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
              <div style={{ fontSize: 13, color: 'var(--globant-muted)', marginBottom: 4 }}>{msName} · {msRole}</div>
              <div style={{ fontSize: 12, color: 'var(--globant-accent)', marginBottom: 14 }}>{msAccNames.join(', ')}</div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                <div style={{ flex: 1 }}><label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>DATE</label><input type="date" className="input-field" style={{ width: '100%' }} value={meetingDate} onChange={e => setMeetingDate(e.target.value)} /></div>
                <div style={{ flex: 1 }}><label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>TIME</label><input type="time" className="input-field" style={{ width: '100%' }} value={meetingTime} onChange={e => setMeetingTime(e.target.value)} /></div>
              </div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>NOTES / AGENDA</label>
              <textarea className="input-field" style={{ width: '100%', minHeight: 70, resize: 'vertical', marginBottom: 14, fontFamily: 'inherit', fontSize: 12 }} placeholder="Meeting topic, agenda, key questions to ask..." value={meetingNotes} onChange={e => setMeetingNotes(e.target.value)} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="action-btn btn-ghost" style={{ flex: 1 }} onClick={() => setMeetingModal(null)}>Cancel</button>
                {meetingDate && <button className="action-btn" style={{ flex: 1, background: 'rgba(66,133,244,0.15)', color: '#4285f4', border: '1px solid rgba(66,133,244,0.3)' }} onClick={() => window.open(buildCalendarUrl(), '_blank')}>📆 Open in Calendar</button>}
                <button className="action-btn" style={{ flex: 1, background: 'rgba(96,165,250,0.2)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.4)' }} onClick={async () => { await logMeeting(ms, meetingNotes, meetingDate); setMeetingModal(null); setMeetingNotes(''); setMeetingDate(''); setMeetingTime(''); }}>✅ Log Meeting</button>
              </div>
            </div>
          </div>
        );
      })()}

      {selectedStakeholder && (
        <AIMessageModal stakeholder={selectedStakeholder} onClose={() => setSelectedStakeholder(null)} onSend={useMessage}
          onSuccess={() => { setSelectedStakeholder(null); if (onLogActivity) onLogActivity(); }} data={data} />
      )}

      {composeEmail && (
        <EmailComposeModal stakeholder={composeEmail.stakeholder} initialSubject={composeEmail.subject} initialBody={composeEmail.body}
          replyContext={composeEmail.replyContext} accounts={accounts} outreach={outreach} gmailConnected={gmailConnectedFC}
          onClose={() => setComposeEmail(null)} onSuccess={() => { setComposeEmail(null); if (onLogActivity) onLogActivity(); }} />
      )}

      {historyStakeholder && (
        <StakeholderHistoryModal stakeholder={historyStakeholder} outreach={outreach} accounts={accounts}
          onClose={() => setHistoryStakeholder(null)} onRefresh={onLogActivity} onAddRecord={onAddRecord}
          allData={data} onNavigateToAccount={goToAccount} onSend={useMessage} />
      )}
    </div>
  );
}

// ============ EMAIL COMPOSE MODAL ============

export default FollowupCenter;
