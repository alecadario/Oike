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


function EventsHub({ data, api, onLogActivity, onAddRecord, onUpdateRecord, navigateToEventId, clearNavigateEvent }) {
  const { accounts, stakeholders, events, outreach } = data;
  const [selectedEventId, setSelectedEventId] = useState(null);
  // Wrapper that keeps URL in sync with the selected event
  const selectEvent = useCallback((id) => {
    setSelectedEventId(id || null);
    navSetUrl('events', id || null);
    setInviteByAccId('');
    setInviteBySearch('');
    setShowInvited(false);
    setInvitePreview(null);
  }, []);
  // Restore from URL / external navigation
  useEffect(() => {
    if (navigateToEventId) {
      selectEvent(navigateToEventId);
      if (clearNavigateEvent) clearNavigateEvent();
    }
  }, [navigateToEventId, clearNavigateEvent]);
  const [aiSuggestions, setAiSuggestions] = useState([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestionReason, setSuggestionReason] = useState({});
  const [evHistoryStakeholder, setEvHistoryStakeholder] = useState(null);
  const [evSelectedStakeholder, setEvSelectedStakeholder] = useState(null);
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [evNewName, setEvNewName] = useState('');
  const [evNewStart, setEvNewStart] = useState('');
  const [evNewEnd, setEvNewEnd] = useState('');
  const [evNewContext, setEvNewContext] = useState('');
  const [evNewWebsite, setEvNewWebsite] = useState('');
  const [evNewAttachUrl, setEvNewAttachUrl] = useState('');
  const [editingInviteTemplate, setEditingInviteTemplate] = useState(false);
  const [inviteByAccId, setInviteByAccId] = useState('');
  const [inviteBySearch, setInviteBySearch] = useState('');
  const [invitePreview, setInvitePreview] = useState(null);
  const [showInvited, setShowInvited] = useState(false); // {id, mode, msg, generating}
  const [inviteTemplateValue, setInviteTemplateValue] = useState('');
  const [savingInviteTemplate, setSavingInviteTemplate] = useState(false);
  const [evCreating, setEvCreating] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [evUploadingFile, setEvUploadingFile] = useState(false);
  const [evGeneratingSummary, setEvGeneratingSummary] = useState(false);

  // Generate Executive Summary for the event — uses files + context + linked solutions
  const generateEventExecSummary = async (eventRec) => {
    if (!eventRec) return;
    setEvGeneratingSummary(true);
    try {
      const evName = F(eventRec, 'Event Name') || '';
      const evContext = F(eventRec, 'Aditional context') || '';
      const evStart = eventRec.fields?.['Starting'] ? new Date(eventRec.fields['Starting']).toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' }) : '';
      const evUrl = F(eventRec, 'URL') || '';
      const evAirtableSummary = F(eventRec, 'Attachment Summary') || '';
      const linkedSolIds = linkedIds(eventRec, 'Solutions');
      const linkedSols = (data.solutions || []).filter(s => linkedSolIds.includes(s.id));
      const solInfo = linkedSols.map(s => `- ${F(s,'Name')}: ${F(s,'Stakeholder Key Message') || (F(s,'Service | Solution Detail')||'').slice(0,150)}`).join('\n');

      const prompt = `You are a senior B2B sales strategist. Generate an executive summary of this event that will be used as context for AI-personalized invitations to prospects.

EVENT: ${evName}
${evStart ? `DATE: ${evStart}` : ''}
${evUrl ? `URL: ${evUrl}` : ''}

CONTEXT (uploaded files + manual notes):
${evContext.slice(0, 3000) || 'None'}

${evAirtableSummary ? `AIRTABLE ATTACHMENT SUMMARY:\n${typeof evAirtableSummary === 'string' ? evAirtableSummary.slice(0, 800) : ''}` : ''}

${solInfo ? `OFFERING WE PROMOTE AT THIS EVENT:\n${solInfo}` : ''}

Generate a structured executive summary with these 5 sections:

### 🎯 What this event is
2-3 sentences: type of event, format (in-person/online/hybrid), scale, the core promise.

### 👥 Target audience
Who should attend: roles, seniority, industries, company size. Specific.

### 💡 Why it matters now
The trigger / timing / context that makes this event relevant TODAY (industry shifts, regulation, technology change).

### 🎁 What attendees take away
3-4 concrete outcomes (knowledge, network, tools, deals).

### 🪝 Hooks for invitations
3 angles a BDR could use to invite different prospect personas. Each one specific (not generic).

Return as plain markdown text, NO surrounding JSON. Use the headers exactly as shown above. Keep total under 400 words.`;

      const summary = await callOpenAI({ prompt, temperature: 0.5, max_tokens: 900 });
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.events, eventRec.id, { 'Exec Summary': summary });
      if (onUpdateRecord) onUpdateRecord('events', eventRec.id, { 'Exec Summary': summary });
      if (onLogActivity) onLogActivity();
    } catch (err) {
      console.error('Generate Exec Summary failed:', err);
      const msg = err?.message || String(err) || 'unknown error';
      window.__oikeToast(`Failed to generate summary: ${msg}. Check browser console for details.`, 'error');
    }
    setEvGeneratingSummary(false);
  };
  const now = new Date();

  // Handle file upload → AI summary → append to "Aditional context" as FILE: block
  const handleEventFileUpload = async (e, eventRec) => {
    const file = e.target.files?.[0];
    if (!file || !eventRec) return;
    setEvUploadingFile(true);
    try {
      const text = await file.text();
      const prompt = `Summarize the following file content. Extract the most relevant points for a B2B sales team running this event. Be concise (5-8 bullets max).\n\nFile: ${file.name}\n\n${text.slice(0, 8000)}`;
      const summary = await callOpenAI({ prompt, temperature: 0.4, max_tokens: 500 });
      const dateStr = new Date().toLocaleDateString('en-GB');
      const entry = `\n\n📎 FILE: ${file.name} (uploaded ${dateStr})\n${summary}`;
      const currentContext = F(eventRec, 'Aditional context') || '';
      const updated = (currentContext + entry).trim();
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.events, eventRec.id, { 'Aditional context': updated });
      if (onUpdateRecord) onUpdateRecord('events', eventRec.id, { 'Aditional context': updated });
      if (onLogActivity) onLogActivity();
    } catch (err) {
      console.error('Event file upload failed:', err);
      window.__oikeToast('File upload failed — try again with a smaller file or a different format.', 'error');
    }
    setEvUploadingFile(false);
    e.target.value = '';
  };

  const saveEventEdit = async (updatedFields) => {
    if (!editingEvent || !api) return;
    const transformed = { ...updatedFields };
    if (transformed['Starting']) transformed['Starting'] = new Date(transformed['Starting']).toISOString();
    if (transformed['End date']) transformed['End date'] = new Date(transformed['End date']).toISOString();
    if (onUpdateRecord) onUpdateRecord('events', editingEvent.id, transformed);
    setEditingEvent(null);
    try {
      await api.updateRecord(TABLE_IDS.events, editingEvent.id, transformed);
      if (onLogActivity) onLogActivity();
    } catch (e) {
      console.error('Event edit error', e);
      window.__oikeToast('Failed to save event changes', 'error');
      if (onLogActivity) onLogActivity();
    }
  };

  const createEvent = async () => {
    if (!evNewName.trim() || !evNewStart) return;
    const fields = {
      'Event Name': evNewName.trim(),
      'Starting': new Date(evNewStart).toISOString(),
    };
    if (evNewEnd) fields['End date'] = new Date(evNewEnd).toISOString();
    if (evNewContext.trim()) fields['Aditional context'] = evNewContext.trim();
    if (evNewWebsite.trim()) fields['URL'] = evNewWebsite.trim();
    if (evNewAttachUrl.trim()) fields['Attachments'] = [{ url: evNewAttachUrl.trim() }];
    // Optimistic: show instantly
    if (onAddRecord) onAddRecord('events', fields);
    setEvNewName(''); setEvNewStart(''); setEvNewEnd('');
    setEvNewContext(''); setEvNewWebsite(''); setEvNewAttachUrl('');
    setShowAddEvent(false);
    // API in background
    const a = api || new AirtableAPI();
    a.createRecord(TABLE_IDS.events, fields)
      .then(() => { if (onLogActivity) onLogActivity(); })
      .catch(e => { console.error(e); window.__oikeToast('Failed to create event', 'error'); if (onLogActivity) onLogActivity(); });
  };

  const upcoming = events.filter(ev => {
    const start = ev.fields?.['Starting'] ? new Date(ev.fields['Starting']) : null;
    return start && start > now;
  }).sort((a, b) => new Date(a.fields?.['Starting']) - new Date(b.fields?.['Starting']));

  const past = events.filter(ev => {
    const start = ev.fields?.['Starting'] ? new Date(ev.fields['Starting']) : null;
    return start && start <= now;
  }).sort((a, b) => new Date(b.fields?.['Starting']) - new Date(a.fields?.['Starting']));

  const totalInvited = events.reduce((sum, ev) => sum + linkedIds(ev, 'Stakeholders invited').length, 0);

  const selectedEvent = selectedEventId ? events.find(e => e.id === selectedEventId) : null;

  // Invite function — window.open MUST be called synchronously (before any await)
  // so we open the channel first, then fire async API work in background
  const inviteStakeholder = (stakeholder, event, channel) => {
    const sName = F(stakeholder, 'Name') || '';
    const email = F(stakeholder, 'Email') || '';
    const phone = F(stakeholder, 'Phone number') || '';
    const linkedin = F(stakeholder, 'LinkedIn') || '';
    const evName = F(event, 'Event Name') || '';
    const evDate = formatDate(event.fields?.['Starting']);
    const aiInvite = F(event, 'Stakeholder Invitation') || '';
    const fallbackInvite = `Hi ${sName}, I'd like to invite you to "${evName}" on ${evDate}. It could be a great opportunity to connect and explore how ${COMPANY_PROFILE.companyName} can support your goals. Would you be interested? Looking forward to hearing from you.`;
    const message = aiInvite || fallbackInvite;
    const subject = `Invitation: ${evName} — ${evDate}`;

    // Open channel synchronously — must happen before any async call
    if (channel === 'WhatsApp' && phone) {
      window.open(`https://wa.me/${String(phone).replace(/[^0-9+]/g, '')}?text=${encodeURIComponent(message)}`, '_blank');
    } else if (channel === 'Email' && email) {
      window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`, '_blank');
    } else if (channel === 'LinkedIn' && linkedin) {
      navigator.clipboard.writeText(message).catch(() => {});
      window.open(linkedin, '_blank');
    } else if (channel === 'Call' && phone) {
      window.open(`tel:${phone}`, '_self');
    }

    // Fire API calls in background (no await at top level)
    const doAsync = async () => {
      const companyIds = linkedIds(stakeholder, 'Account');
      const a = api || new AirtableAPI();
      // 1. Log outreach activity
      await a.createRecord(TABLE_IDS.outreach, {
        'Activity Name': `Event Invite: ${sName} → ${evName} — ${new Date().toLocaleDateString('en-US')}`,
        'Account': companyIds,
        'Stakeholder': [stakeholder.id],
        'Channel': channel,
        'Date': new Date().toISOString(),
        'Status': 'Sent',
        'Message': message,
        'Notes': `Event invitation for "${evName}" (${evDate})`,
        'Logged By': CURRENT_USER?.name || '',
        ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
        ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
      });
      // 2. Add stakeholder to event's "Stakeholders invited" field
      const currentInvited = linkedIds(event, 'Stakeholders invited');
      if (!currentInvited.includes(stakeholder.id)) {
        await a.updateRecord(TABLE_IDS.events, event.id, {
          'Stakeholders invited': [...currentInvited, stakeholder.id],
        });
      }
      await activateAccountIfNeeded(a, companyIds, data.accounts);
      await updateStakeholderStatus(a, stakeholder.id, 'Contacted', data.stakeholders);
      if (onLogActivity) onLogActivity();
    };
    doAsync().catch(e => console.error('Event invite log failed:', e));
  };

  // AI-powered suggestion for event invitations
  const generateSmartSuggestions = async (event, notInvitedList) => {
    setLoadingSuggestions(true);
    try {
      const evName = F(event, 'Event Name') || '';
      const evContext = F(event, 'Aditional context') || '';
      const evSummary = F(event, 'Attachment Summary') || '';
      const evStart = formatDate(event.fields?.['Starting']);

      // Build stakeholder profiles
      const profiles = notInvitedList.slice(0, 60).map(s => {
        const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
        const accIndustries = linkedIds(s, 'Account').map(id => accounts.find(a => a.id === id)).filter(Boolean).map(a => F(a, 'Industry') || '').filter(Boolean);
        const pain = F(s, 'Pain Points (Generated)') || F(s, 'Pain points') || '';
        const painStr = typeof pain === 'string' ? pain.slice(0, 150) : '';
        return `ID:${s.id} | ${F(s, 'Name')} ${F(s, 'Last name') || ''} | ${F(s, 'Role') || '?'} at ${accNames.join(', ')} | Industry: ${accIndustries.join(', ')} | Influence: ${F(s, 'Level of Influence') || '?'} | Pain: ${painStr}`;
      }).join('\n');

      const prompt = `You are a B2B sales strategist for ${COMPANY_PROFILE.companyName} (${COMPANY_PROFILE.services}).

EVENT:
- Name: ${evName}
- Date: ${evStart}
- Context: ${evContext || 'None'}
- Summary: ${typeof evSummary === 'string' ? evSummary.slice(0, 500) : 'None'}

STAKEHOLDERS NOT YET INVITED:
${profiles}

TASK: Select the TOP 10 most relevant stakeholders to invite to this event. Consider:
1. Industry alignment with the event theme
2. Role relevance (would they benefit from / be interested in this event?)
3. Pain points that the event topics might address
4. Level of influence (Decision Makers and Champions are priority)
5. Company strategic value

Return a JSON array of objects with EXACTLY this format (no markdown, no code fences):
[{"id":"recXXX","reason":"One sentence explaining why this person is relevant for this event"},...]

Return ONLY the JSON array, nothing else.`;

      const text = await callOpenAI({ prompt, temperature: 0.4, max_tokens: 1000 });
      const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const ids = parsed.map(p => p.id);
      const reasons = {};
      parsed.forEach(p => { reasons[p.id] = p.reason; });
      setSuggestionReason(reasons);
      setAiSuggestions(ids);
    } catch (e) {
      console.error('Smart suggestions failed:', e);
      window.__oikeToast('Failed to generate suggestions. Check console.', 'error');
    }
    setLoadingSuggestions(false);
  };

  // Events: use message (send + log)
  const [removingInvite, setRemovingInvite] = useState(null);

  // Remove stakeholder from event invitation
  const uninviteStakeholder = async (stakeholder, event) => {
    setRemovingInvite(stakeholder.id);
    try {
      const a = api || new AirtableAPI();
      const currentInvited = linkedIds(event, 'Stakeholders invited');
      const updated = currentInvited.filter(id => id !== stakeholder.id);
      await a.updateRecord(TABLE_IDS.events, event.id, {
        'Stakeholders invited': updated
      });
      if (onLogActivity) onLogActivity();
    } catch (e) {
      console.error('Uninvite failed:', e);
      window.__oikeToast('Failed to remove invitation', 'error');
    }
    setRemovingInvite(null);
  };

  const evUseMessage = async (stakeholder, channel, message, ccList = [], eventId = null) => {
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
    // Log outreach
    const companyIds = linkedIds(stakeholder, 'Account');
    try {
      const a = api || new AirtableAPI();
      await a.createRecord(TABLE_IDS.outreach, {
        'Activity Name': `${channel} to ${sn} — ${new Date().toLocaleDateString('en-US')}`,
        'Account': companyIds, 'Stakeholder': [stakeholder.id],
        'Channel': channel, 'Date': new Date().toISOString(),
        'Status': 'Sent', 'Message': message,
        'Notes': 'Sent from Events Hub',
        'Logged By': CURRENT_USER?.name || '',
        ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
        ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
      });
      await activateAccountIfNeeded(a, companyIds, data.accounts);
      await updateStakeholderStatus(a, stakeholder.id, 'Contacted', data.stakeholders);
      // If this was an event invite from AI Generator, link the stakeholder to the event
      if (eventId) {
        try {
          const ev = data.events?.find(e => e.id === eventId);
          const currentInvited = ev ? linkedIds(ev, 'Stakeholders invited') : [];
          const merged = [...new Set([...currentInvited, stakeholder.id])];
          await a.updateRecord(TABLE_IDS.events, eventId, {
            'Stakeholders invited': merged,
          });
        } catch (evErr) { console.error('[evUseMessage] Failed to update Stakeholders invited:', evErr); }
      }
      if (onLogActivity) onLogActivity();
    } catch (e) { console.error('Event message log failed:', e); }
  };

  // Event detail view
  if (selectedEvent) {
    const evName = F(selectedEvent, 'Event Name');
    const startDate = selectedEvent.fields?.['Starting'];
    const endDate = selectedEvent.fields?.['End date'];
    const context = F(selectedEvent, 'Aditional context');
    const summary = F(selectedEvent, 'Attachment Summary');
    const aiInviteMsg = F(selectedEvent, 'Stakeholder Invitation');
    const invitedIds = linkedIds(selectedEvent, 'Stakeholders invited');
    const invitedStakeholders = invitedIds.map(id => stakeholders.find(s => s.id === id)).filter(Boolean);

    // All stakeholders NOT invited (potential invites)
    const notInvited = stakeholders.filter(s => !invitedIds.includes(s.id));

    // Group invited by account
    const invitedByAccount = {};
    invitedStakeholders.forEach(s => {
      const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
      const accKey = accNames.join(', ') || 'No Account';
      if (!invitedByAccount[accKey]) invitedByAccount[accKey] = [];
      invitedByAccount[accKey].push(s);
    });

    // Event outreach activities
    const eventOutreach = outreach.filter(o => {
      const notes = F(o, 'Notes') || '';
      return notes.includes(evName);
    });

    const isPast = startDate && new Date(startDate) <= now;
    const daysUntil = startDate ? Math.ceil((new Date(startDate) - now) / (1000*60*60*24)) : null;

    return (
      <div>
        <div className="page-header">
          <h1>Events Hub</h1>
          <p>Event detail and stakeholder management</p>
        </div>

        {/* Event Header */}
        <div className="card" style={{ borderLeft: `3px solid ${isPast ? 'var(--globant-muted)' : 'var(--globant-green)'}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <button className="action-btn btn-ghost" style={{ fontSize: 11 }} onClick={() => selectEvent(null)}>← Back to all events</button>
            <button className="action-btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setEditingEvent(selectedEvent)}>✏️ Edit</button>
          </div>
          <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>{evName}</h2>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--globant-muted)' }}>📅 {formatDate(startDate)}{endDate ? ` — ${formatDate(endDate)}` : ''}</span>
            {isPast ? (
              <span className="badge badge-yellow">Past Event</span>
            ) : daysUntil !== null ? (
              <span className="badge badge-green">{daysUntil === 0 ? 'Today!' : daysUntil === 1 ? 'Tomorrow' : `In ${daysUntil} days`}</span>
            ) : null}
            <span style={{ fontSize: 13, color: 'var(--globant-muted)' }}>👥 {invitedStakeholders.length} invited</span>
          </div>
        </div>

        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 20 }}>
          <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--globant-green)', lineHeight: 1 }}>{invitedStakeholders.length}</div>
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Stakeholders Invited</div>
          </div>
          <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--globant-info)', lineHeight: 1 }}>{Object.keys(invitedByAccount).length}</div>
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Accounts Represented</div>
          </div>
          <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--globant-warning)', lineHeight: 1 }}>{eventOutreach.length}</div>
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Invitations Sent</div>
          </div>
        </div>

        {/* Context & Summary */}
        <div className="card">
          <div className="card-header">
            <h3>📝 Event Details & Files</h3>
            <label style={{ cursor: 'pointer' }}>
              <input type="file" accept=".csv,.txt,.json,.md,.html,.tsv,.xml,.pdf" style={{ display: 'none' }} onChange={e => handleEventFileUpload(e, selectedEvent)} disabled={evUploadingFile} />
              <span className="action-btn btn-ghost" style={{ fontSize: 10, padding: '3px 10px', display: 'inline-block' }}>
                {evUploadingFile ? '⏳ Processing...' : '📎 Upload File'}
              </span>
            </label>
          </div>
          {context ? (
            <FileNotesRenderer
              notes={context}
              accentColor="var(--globant-info)"
              onUpdateNotes={async (updated) => {
                const a = api || new AirtableAPI();
                await a.updateRecord(TABLE_IDS.events, selectedEvent.id, { 'Aditional context': updated });
                if (onUpdateRecord) onUpdateRecord('events', selectedEvent.id, { 'Aditional context': updated });
                if (onLogActivity) onLogActivity();
              }}
            />
          ) : (
            <p style={{ color: 'var(--globant-muted)', fontSize: 12, fontStyle: 'italic' }}>No event context yet. Upload a file (PDF, CSV, TXT) and AI will extract key points, or add context manually via Edit.</p>
          )}
          {summary && (
            <div style={{ padding: '10px 14px', background: 'rgba(91,191,181,0.06)', borderRadius: 8, borderLeft: '3px solid var(--globant-accent)', marginTop: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 6 }}>📎 Airtable Attachment Summary</div>
              <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--globant-text)', whiteSpace: 'pre-wrap' }}>{typeof summary === 'string' ? summary.slice(0, 500) : String(summary).slice(0, 500)}</div>
            </div>
          )}
        </div>

        {/* AI Executive Summary — used by AI when inviting prospects via Landings */}
        <div className="card" style={{ borderLeft: '3px solid #a78bfa' }}>
          <div className="card-header">
            <h3>🧠 AI Executive Summary</h3>
            <button className="action-btn btn-primary" style={{ fontSize: 11 }}
              onClick={() => generateEventExecSummary(selectedEvent)}
              disabled={evGeneratingSummary || (!context && !F(selectedEvent, 'Attachment Summary'))}>
              {evGeneratingSummary ? '⏳ Generating...' : F(selectedEvent, 'Exec Summary') ? '🔄 Regenerate' : '✨ Generate'}
            </button>
          </div>
          {F(selectedEvent, 'Exec Summary') ? (
            <div style={{ fontSize: 12, color: 'var(--globant-text)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {(() => {
                const summaryText = F(selectedEvent, 'Exec Summary');
                const lines = String(summaryText).split('\n').filter(l => l.trim());
                const parseInline = (text) => {
                  const parts = [];
                  const regex = /\*\*(.+?)\*\*/g;
                  let lastIndex = 0, match, key = 0;
                  while ((match = regex.exec(text)) !== null) {
                    if (match.index > lastIndex) parts.push(<span key={key++}>{text.slice(lastIndex, match.index)}</span>);
                    parts.push(<strong key={key++} style={{ fontWeight: 700, color: 'var(--globant-text)' }}>{match[1]}</strong>);
                    lastIndex = match.index + match[0].length;
                  }
                  if (lastIndex < text.length) parts.push(<span key={key++}>{text.slice(lastIndex)}</span>);
                  return parts.length ? parts : text;
                };
                return lines.map((line, i) => {
                  if (line.startsWith('### ')) return <h4 key={i} style={{ margin: '12px 0 6px', fontSize: 13, fontWeight: 700, color: '#a78bfa' }}>{parseInline(line.replace('### ', '').replace(/\*\*/g, ''))}</h4>;
                  if (line.startsWith('- ') || line.startsWith('* ')) return <div key={i} style={{ paddingLeft: 14, marginBottom: 3, position: 'relative' }}><span style={{ position: 'absolute', left: 0 }}>•</span>{parseInline(line.slice(2))}</div>;
                  return <p key={i} style={{ margin: '3px 0' }}>{parseInline(line)}</p>;
                });
              })()}
            </div>
          ) : (
            <p style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>
              {context || F(selectedEvent, 'Attachment Summary')
                ? 'Click "✨ Generate" to have AI create an executive summary of this event. This summary will be used automatically when creating Prospect Landings that invite to this event — so the AI writes better personalized invitations.'
                : 'Upload files or add context to the event first. Then you can generate the summary.'}
            </p>
          )}
        </div>

        {/* Invitation Template — editable */}
        <div className="card">
          <div className="card-header">
            <h3>✉️ Invitation Message Template</h3>
            <div style={{ display:'flex', gap:6 }}>
              {!editingInviteTemplate ? (
                <button className="action-btn btn-ghost" style={{ fontSize:10 }}
                  onClick={() => { setEditingInviteTemplate(true); setInviteTemplateValue(aiInviteMsg || ''); }}>
                  {aiInviteMsg ? '✏️ Edit' : '➕ Add Template'}
                </button>
              ) : (
                <>
                  <button className="action-btn btn-primary" style={{ fontSize:10 }} disabled={savingInviteTemplate}
                    onClick={async () => {
                      setSavingInviteTemplate(true);
                      try {
                        const a = api || new AirtableAPI();
                        await a.updateRecord(TABLE_IDS.events, selectedEventId, { 'Stakeholder Invitation': inviteTemplateValue });
                        if (onUpdateRecord) onUpdateRecord('events', selectedEventId, { 'Stakeholder Invitation': inviteTemplateValue });
                        setEditingInviteTemplate(false);
                        if (onLogActivity) onLogActivity();
                      } catch(e) { console.error(e); window.__oikeToast('Failed to save template', 'error'); }
                      setSavingInviteTemplate(false);
                    }}>
                    {savingInviteTemplate ? '⏳' : '💾 Save'}
                  </button>
                  <button className="action-btn btn-ghost" style={{ fontSize:10 }} onClick={() => setEditingInviteTemplate(false)}>Cancel</button>
                </>
              )}
            </div>
          </div>
          {editingInviteTemplate ? (
            <div>
              <textarea className="input-field"
                style={{ width:'100%', minHeight:120, resize:'vertical', fontSize:12, fontFamily:'inherit', lineHeight:1.6 }}
                placeholder={`Write the base message for inviting stakeholders to this event.\n\nThe AI will use this as a guide to personalize each invitation.\n\nExample:\n"Hi [Name], I wanted to personally invite you to [Event]. Given your role in [Company], I think it's a great opportunity to connect and explore [topic]. Are you planning to attend?"`}
                value={inviteTemplateValue}
                onChange={e => setInviteTemplateValue(e.target.value)}
              />
              <div style={{ fontSize:11, color:'var(--globant-muted)', marginTop:6 }}>
                💡 The AI will use this template + the stakeholder's pain points and context to personalize each invitation.
              </div>
            </div>
          ) : aiInviteMsg ? (
            <div style={{ fontSize:13, lineHeight:1.7, color:'var(--globant-text)', whiteSpace:'pre-wrap', padding:'10px 14px', background:'rgba(91,191,181,0.06)', borderRadius:8 }}>{aiInviteMsg}</div>
          ) : (
            <p style={{ color:'var(--globant-muted)', fontSize:12 }}>No template set. Add one to guide the AI when generating personalized invitations for this event.</p>
          )}
        </div>

        {/* Invited Stakeholders grouped by account — collapsible */}
        <div className="card">
          <div className="card-header" style={{ cursor:'pointer' }} onClick={() => setShowInvited(v => !v)}>
            <h3>✅ Invited Stakeholders ({invitedStakeholders.length})</h3>
            <span style={{ fontSize:12, color:'var(--globant-muted)' }}>{showInvited ? '▲ Hide' : '▼ Show'}</span>
          </div>
          {!showInvited && invitedStakeholders.length === 0 && <p style={{ color:'var(--globant-warning)', fontSize:13 }}>No stakeholders invited yet.</p>}
          {showInvited && invitedStakeholders.length === 0 && <p style={{ color:'var(--globant-warning)', fontSize:13 }}>No stakeholders invited yet.</p>}
          {showInvited && invitedStakeholders.length > 0 && (<React.Fragment>
          {Object.entries(invitedByAccount).sort((a, b) => b[1].length - a[1].length).map(([accName, sArr]) => (
            <div key={accName} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--globant-green)', marginBottom: 8, padding: '4px 0', borderBottom: '1px solid var(--globant-border)' }}>
                🏢 {accName} ({sArr.length})
              </div>
              {sArr.map(s => {
                const hasPhone = !!F(s, 'Phone number');
                const hasEmail = !!F(s, 'Email');
                const hasLinkedin = !!F(s, 'LinkedIn');
                // Check if invitation was already sent
                const invSent = eventOutreach.some(o => linkedIds(o, 'Stakeholder').includes(s.id));
                return (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', marginBottom: 4, background: 'rgba(91,191,181,0.04)', borderRadius: 6 }}>
                    <div>
                      <span style={{ fontWeight: 600, fontSize: 13, cursor: 'pointer', color: 'var(--globant-green)' }} onClick={() => setEvHistoryStakeholder(s)}>
                        {F(s, 'Name')}{F(s, 'Last name') ? ` ${F(s, 'Last name')}` : ''}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--globant-muted)', marginLeft: 8 }}>{F(s, 'Role')}</span>
                      {invSent && <span className="badge badge-green" style={{ marginLeft: 8, fontSize: 9 }}>Invite Sent</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      {!invSent && (
                        <>
                          <span style={{ fontSize: 9, color: 'var(--globant-muted)', marginRight: 2 }}>Invite →</span>
                          {hasEmail && <button className="action-btn btn-email" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => inviteStakeholder(s, selectedEvent, 'Email')}>✉️</button>}
                          {hasPhone && <button className="action-btn btn-whatsapp" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => inviteStakeholder(s, selectedEvent, 'WhatsApp')}>💬</button>}
                          {hasLinkedin && <button className="action-btn btn-linkedin" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => inviteStakeholder(s, selectedEvent, 'LinkedIn')}>🔗</button>}
                        </>
                      )}
                      <button
                        title="Remove from event"
                        style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 6, padding: '3px 7px', cursor: 'pointer', fontSize: 10, color: '#ef4444', marginLeft: 4 }}
                        onClick={() => uninviteStakeholder(s, selectedEvent)}
                        disabled={removingInvite === s.id}>
                        {removingInvite === s.id ? '⏳' : '✕'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          </React.Fragment>)}
        </div>

        {/* Suggest more stakeholders to invite */}
        {notInvited.length > 0 && !isPast && (
          <div className="card" style={{ borderLeft: '3px solid var(--globant-warning)' }}>
            <div className="card-header">
              <h3>🎫 Suggest More Invitations</h3>
              <button className="action-btn btn-primary" style={{ fontSize: 11 }}
                onClick={() => generateSmartSuggestions(selectedEvent, notInvited)}
                disabled={loadingSuggestions}>
                {loadingSuggestions ? '⏳ Analyzing...' : '✨ AI Smart Suggestions'}
              </button>
            </div>

            {/* AI suggestions */}
            {aiSuggestions.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--globant-green)', marginBottom: 8 }}>
                  🤖 AI-RECOMMENDED FOR THIS EVENT ({aiSuggestions.length})
                </div>
                {aiSuggestions.map(sid => {
                  const s = stakeholders.find(st => st.id === sid);
                  if (!s) return null;
                  const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
                  const hasPhone = !!F(s, 'Phone number');
                  const hasEmail = !!F(s, 'Email');
                  const hasLinkedin = !!F(s, 'LinkedIn');
                  const reason = suggestionReason[sid] || '';
                  return (
                    <div key={s.id} style={{ padding: '10px 12px', marginBottom: 6, background: 'rgba(91,191,181,0.06)', borderRadius: 8, border: '1px solid rgba(91,191,181,0.15)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: reason ? 4 : 0 }}>
                        <div>
                          <span style={{ fontWeight: 600, fontSize: 13, cursor: 'pointer', color: 'var(--globant-green)' }} onClick={() => setEvHistoryStakeholder(s)}>
                            {F(s, 'Name')}{F(s, 'Last name') ? ` ${F(s, 'Last name')}` : ''}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--globant-muted)', marginLeft: 8 }}>{F(s, 'Role')} · {accNames.join(', ')}</span>
                          <span className="badge badge-accent" style={{ marginLeft: 8, fontSize: 9 }}>{F(s, 'Level of Influence')}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="action-btn btn-primary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => setEvSelectedStakeholder(s)}>✨</button>
                          {hasEmail && <button className="action-btn btn-email" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => inviteStakeholder(s, selectedEvent, 'Email')}>✉️</button>}
                          {hasPhone && <button className="action-btn btn-whatsapp" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => inviteStakeholder(s, selectedEvent, 'WhatsApp')}>💬</button>}
                          {hasLinkedin && <button className="action-btn btn-linkedin" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => inviteStakeholder(s, selectedEvent, 'LinkedIn')}>🔗</button>}
                        </div>
                      </div>
                      {reason && <div style={{ fontSize: 11, color: 'var(--globant-info)', fontStyle: 'italic', lineHeight: 1.4 }}>💡 {reason}</div>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Fallback: influence-based list */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--globant-muted)', marginBottom: 6 }}>
                {aiSuggestions.length > 0 ? 'OTHER HIGH-INFLUENCE CONTACTS' : `${notInvited.length} stakeholders not invited — showing top by influence:`}
              </div>
              {notInvited
                .filter(s => F(s, 'Level of Influence') && !aiSuggestions.includes(s.id))
                .sort((a, b) => {
                  const order = { 'Decision Maker': 1, 'High': 2, 'Influencer': 3, 'Champion': 4 };
                  return (order[F(a, 'Level of Influence')] || 99) - (order[F(b, 'Level of Influence')] || 99);
                })
                .slice(0, aiSuggestions.length > 0 ? 5 : 8)
                .map(s => {
                  const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
                  const hasPhone = !!F(s, 'Phone number');
                  const hasEmail = !!F(s, 'Email');
                  const hasLinkedin = !!F(s, 'LinkedIn');
                  return (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', marginBottom: 4, background: 'rgba(251,191,36,0.06)', borderRadius: 6 }}>
                      <div>
                        <span style={{ fontWeight: 600, fontSize: 13, cursor: 'pointer', color: 'var(--globant-green)' }} onClick={() => setEvHistoryStakeholder(s)}>
                          {F(s, 'Name')}{F(s, 'Last name') ? ` ${F(s, 'Last name')}` : ''}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--globant-muted)', marginLeft: 8 }}>{F(s, 'Role')} · {accNames.join(', ')}</span>
                        <span className="badge badge-accent" style={{ marginLeft: 8, fontSize: 9 }}>{F(s, 'Level of Influence')}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="action-btn btn-primary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => setEvSelectedStakeholder(s)}>✨</button>
                        {hasEmail && <button className="action-btn btn-email" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => inviteStakeholder(s, selectedEvent, 'Email')}>✉️</button>}
                        {hasPhone && <button className="action-btn btn-whatsapp" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => inviteStakeholder(s, selectedEvent, 'WhatsApp')}>💬</button>}
                        {hasLinkedin && <button className="action-btn btn-linkedin" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => inviteStakeholder(s, selectedEvent, 'LinkedIn')}>🔗</button>}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* ── Invite by Company ── */}
        {!isPast && (
          <div className="card">
            <div className="card-header">
              <h3>🏢 Invite by Company</h3>
            </div>
            {/* Account filter */}
            <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap' }}>
              <select className="input-field" style={{ fontSize:12, maxWidth:260 }}
                value={inviteByAccId}
                onChange={e => { setInviteByAccId(e.target.value); setInviteBySearch(''); }}>
                <option value="">— All accounts —</option>
                {[...accounts].sort((a,b) => (F(a,'Account Name')||'').localeCompare(F(b,'Account Name')||'')).map(a => (
                  <option key={a.id} value={a.id}>{F(a,'Account Name')}</option>
                ))}
              </select>
              <input className="input-field" style={{ fontSize:12, maxWidth:220 }}
                placeholder="Search by name or role..."
                value={inviteBySearch}
                onChange={e => setInviteBySearch(e.target.value)} />
            </div>
            {(() => {
              const filtered = stakeholders
                .filter(s => {
                  if (!invitedIds.includes(s.id) === false) return false; // skip already invited
                  if (inviteByAccId && !linkedIds(s,'Account').includes(inviteByAccId)) return false;
                  if (inviteBySearch) {
                    const q = inviteBySearch.toLowerCase();
                    if (!(`${F(s,'Name')||''} ${F(s,'Last name')||''} ${F(s,'Role')||''}`).toLowerCase().includes(q)) return false;
                  }
                  return !invitedIds.includes(s.id);
                })
                .sort((a,b) => (F(a,'Name')||'').localeCompare(F(b,'Name')||''))
                .slice(0, 30);
              if (filtered.length === 0) return <p style={{ color:'var(--globant-muted)', fontSize:12 }}>{inviteByAccId || inviteBySearch ? 'No contacts match.' : 'Select a company to see contacts.'}</p>;

              const generateInviteMsg = async (s, mode) => {
                setInvitePreview({ id: s.id, mode, msg: '', generating: true });
                const sName = `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim();
                const role = F(s,'Role') || '';
                const pain = (F(s,'Pain Points (Generated)') || F(s,'Pain points') || '').slice(0,400);
                const linkedinNews = (F(s,'LinkedIn News (Generated)') || F(s,'Linkedin lates news') || '').slice(0,200);
                const accId = linkedIds(s,'Account')[0];
                const acc = accounts.find(a => a.id === accId);
                const accName = acc ? F(acc,'Account Name') : '';
                const industry = acc ? (F(acc,'Industry') || '') : '';
                const accNews = acc ? (F(acc,'Recent News') || '').slice(0,200) : '';
                const influence = F(s,'Level of Influence') || '';
                const sOut = outreach.filter(o => linkedIds(o,'Stakeholder').includes(s.id))
                  .sort((a,b) => new Date(b.fields?.['Date']||0)-new Date(a.fields?.['Date']||0))
                  .slice(0,4)
                  .map(o => `[${F(o,'Channel')||'?'} · ${o.fields?.['Date']?new Date(o.fields['Date']).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'?'}] ${(F(o,'Message')||'').slice(0,150)}`).join('\n');
                const evName = F(selectedEvent,'Event Name') || '';
                const evDate = selectedEvent.fields?.['Starting'] ? new Date(selectedEvent.fields['Starting']).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}) : '';
                const evContext = F(selectedEvent,'Aditional context') || '';
                const template = F(selectedEvent,'Stakeholder Invitation') || '';
                const isInvite = mode === 'invite';
                const prompt = `B2B sales rep. Write ONE short personalized message. Max 3 sentences + subject if email.

CONTACT: ${sName} | ${role}${influence ? ` (${influence})` : ''} | ${accName}${industry ? ` — ${industry}` : ''}
${pain ? `Pain: ${pain.slice(0,200)}` : ''}${linkedinNews ? `\nLinkedIn: ${linkedinNews.slice(0,150)}` : ''}${accNews ? `\nCompany news: ${accNews.slice(0,150)}` : ''}
History: ${sOut || 'First contact'}

EVENT: ${evName}${evDate ? ` (${evDate})` : ''}${evContext ? ` — ${evContext.slice(0,100)}` : ''}
${template ? `Template tone/angle to adapt (DO NOT copy verbatim — rewrite for this specific contact):\n"${template.slice(0,300)}"` : ''}

${isInvite
  ? `MISSION: Invite ${sName} to ${evName}. Personalize to their role/pain. Casual, direct. Ask if they're attending.`
  : `MISSION: Follow up after meeting ${sName} at ${evName}. Reference meeting naturally. One clear next step.`
}
BANNED: "following up"/"checking in"/"hope this finds you"/"touching base"/brackets/placeholders.
Sender: ${COMPANY_PROFILE.senderName||'Ale'}, ${COMPANY_PROFILE.companyName||'Oike'}
If email: line 1 = "Subject: [subject]", blank line, body. Output ONLY the message.`;
                try {
                  const msg = await callOpenAI({ prompt, temperature: 0.75, max_tokens: 250 });
                  setInvitePreview({ id: s.id, mode, msg: msg.trim(), generating: false });
                } catch(e) {
                  console.error('generateInviteMsg failed:', e);
                  const fallback = isInvite
                    ? `Hi ${sName}, I wanted to personally invite you to ${evName}${evDate ? ` on ${evDate}` : ''}. Given your role at ${accName}, I think it could be a great opportunity to connect. Are you planning to attend?`
                    : `Hi ${sName}, it was great meeting you at ${evName}. I'd love to continue our conversation — do you have time for a quick call this week?`;
                  setInvitePreview({ id: s.id, mode, msg: fallback, generating: false });
                }
              };

              const sendInviteMsg = (_s, channel) => {
                if (!invitePreview?.msg) return;
                // Always look up by invitePreview.id — avoids closure/re-render mismatch
                const s = stakeholders.find(x => x.id === invitePreview.id) || _s;
                const msg = invitePreview.msg;
                const email = F(s,'Email')||'';
                const phone = F(s,'Phone number')||'';
                const linkedin = F(s,'LinkedIn')||'';
                let subject = '', body = msg;
                if (channel === 'Email') {
                  const lines = body.split('\n');
                  const si = lines.findIndex(l => /^subject:/i.test(l.trim()));
                  if (si !== -1) { subject = lines[si].replace(/^subject:\s*/i,'').trim(); body = lines.slice(si+1).join('\n').trim(); }
                  else { subject = `${F(selectedEvent,'Event Name')||'Event'} — ${F(s,'Name')||''}`; }
                }
                // Open channel with the GENERATED message (only once)
                if (channel==='WhatsApp'&&phone) window.open(`https://wa.me/${String(phone).replace(/[^0-9+]/g,'')}?text=${encodeURIComponent(msg)}`,'_blank');
                else if (channel==='Email'&&email) window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,'_blank');
                else if (channel==='LinkedIn'&&linkedin) { navigator.clipboard.writeText(msg).catch(()=>{}); window.open(linkedin,'_blank'); }
                // Log activity + register as invited (without reopening channel)
                const companyIds = linkedIds(s,'Account');
                const sName = `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim();
                const evName = F(selectedEvent,'Event Name')||'';
                const a = api || new AirtableAPI();
                a.createRecord(TABLE_IDS.outreach, {
                  'Activity Name': `Event ${invitePreview.mode==='invite'?'Invite':'Follow-up'}: ${sName} → ${evName} — ${new Date().toLocaleDateString('en-US')}`,
                  'Account': companyIds, 'Stakeholder': [s.id],
                  'Channel': channel, 'Date': new Date().toISOString(),
                  'Status': 'Sent', 'Message': msg,
                  'Notes': `${invitePreview.mode==='invite'?'Event invitation':'Post-event follow-up'} for "${evName}"`,
                  'Logged By': CURRENT_USER?.name || '',
                }).then(async () => {
                  // Register as invited/met
                  const evCached = (data.events||[]).find(e => e.id === selectedEventId);
                  const currentInvited = evCached ? linkedIds(evCached,'Stakeholders invited') : [];
                  await a.updateRecord(TABLE_IDS.events, selectedEventId, {
                    'Stakeholders invited': [...new Set([...currentInvited, s.id])],
                  }).catch(e => console.error('Event invite register failed:', e));
                  await activateAccountIfNeeded(a, companyIds, data.accounts);
                  await updateStakeholderStatus(a, s.id, 'Contacted', data.stakeholders);
                  if (onLogActivity) onLogActivity();
                }).catch(e => console.error('sendInviteMsg log failed:', e));
                setInvitePreview(null);
              };

              return (
                <div style={{ maxHeight:400, overflowY:'auto' }}>
                  {filtered.map(s => {
                    const accNames = resolveLinked(s,'Account',accounts,'Account Name');
                    const hasPhone = !!F(s,'Phone number');
                    const hasEmail = !!F(s,'Email');
                    const hasLinkedin = !!F(s,'LinkedIn');
                    const isActive = invitePreview?.id === s.id;
                    return (
                      <div key={s.id} style={{ marginBottom:6, borderRadius:8, border:`1px solid ${isActive?'var(--globant-green)':'var(--globant-border)'}`, overflow:'hidden' }}>
                        {/* Contact row */}
                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 12px', background:'rgba(255,255,255,0.03)' }}>
                          <div>
                            <span style={{ fontWeight:600, fontSize:13, cursor:'pointer', color:'var(--globant-green)' }} onClick={() => setEvHistoryStakeholder(s)}>
                              {F(s,'Name')}{F(s,'Last name') ? ` ${F(s,'Last name')}` : ''}
                            </span>
                            <span style={{ fontSize:11, color:'var(--globant-muted)', marginLeft:8 }}>{F(s,'Role')}{accNames.length>0 ? ` · ${accNames[0]}` : ''}</span>
                            {F(s,'Level of Influence') && <span className="badge badge-accent" style={{ marginLeft:6, fontSize:9 }}>{F(s,'Level of Influence')}</span>}
                          </div>
                          <div style={{ display:'flex', gap:4 }}>
                            <button className="action-btn btn-primary" style={{ fontSize:10, padding:'4px 10px', fontWeight:700 }}
                              disabled={isActive && invitePreview.generating}
                              onClick={() => invitePreview?.id===s.id && invitePreview.mode==='invite' ? setInvitePreview(null) : generateInviteMsg(s,'invite')}>
                              {isActive && invitePreview.mode==='invite' && invitePreview.generating ? '⏳' : '📨 Invite'}
                            </button>
                            <button className="action-btn btn-ghost" style={{ fontSize:10, padding:'4px 10px' }}
                              disabled={isActive && invitePreview.generating}
                              onClick={() => invitePreview?.id===s.id && invitePreview.mode==='followup' ? setInvitePreview(null) : generateInviteMsg(s,'followup')}>
                              {isActive && invitePreview.mode==='followup' && invitePreview.generating ? '⏳' : '🤝 Met them'}
                            </button>
                          </div>
                        </div>
                        {/* Preview panel */}
                        {isActive && !invitePreview.generating && invitePreview.msg && (
                          <div style={{ padding:'10px 12px', background:'rgba(91,191,181,0.06)', borderTop:'1px solid var(--globant-border)' }}>
                            <div style={{ fontSize:12, color:'var(--globant-text)', lineHeight:1.6, marginBottom:10, whiteSpace:'pre-wrap' }}>{invitePreview.msg}</div>
                            <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                              {hasEmail && <button className="action-btn btn-email" style={{ fontSize:11 }} onClick={() => sendInviteMsg(s,'Email')}>✉️ Send via Email</button>}
                              {hasPhone && <button className="action-btn btn-whatsapp" style={{ fontSize:11 }} onClick={() => sendInviteMsg(s,'WhatsApp')}>💬 Send via WhatsApp</button>}
                              {hasLinkedin && <button className="action-btn btn-linkedin" style={{ fontSize:11 }} onClick={() => sendInviteMsg(s,'LinkedIn')}>🔗 Send via LinkedIn</button>}
                              <button className="action-btn btn-ghost" style={{ fontSize:11 }} onClick={() => generateInviteMsg(s, invitePreview.mode)}>🔄 Regenerate</button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        )}

        {/* Stakeholder History Modal */}
        {evHistoryStakeholder && (
          <StakeholderHistoryModal
            stakeholder={evHistoryStakeholder}
            outreach={outreach}
            accounts={accounts}
            onClose={() => setEvHistoryStakeholder(null)}
            onRefresh={onLogActivity}
            onAddRecord={onAddRecord}
            allData={data}
            onSend={(s, ch, msg, cc, evId) => evUseMessage(s, ch, msg, cc, evId || selectedEventId)}
          />
        )}

        {/* AI Message Modal */}
        {evSelectedStakeholder && (
          <AIMessageModal
            stakeholder={evSelectedStakeholder}
            onClose={() => setEvSelectedStakeholder(null)}
            onSend={(s, ch, msg, cc, evId) => evUseMessage(s, ch, msg, cc, evId || selectedEventId)}
            onSuccess={() => { setEvSelectedStakeholder(null); if (onLogActivity) onLogActivity(); }}
            data={data}
          />
        )}

        {/* Edit Event Modal — must be inside detail view (not list view) */}
        {editingEvent && (
          <EditModal
            title={`Edit: ${F(editingEvent, 'Event Name') || 'Event'}`}
            fields={[
              { key: 'Event Name', label: 'Event Name', fullWidth: true },
              { key: 'Starting', label: 'Start Date', type: 'date' },
              { key: 'End date', label: 'End Date', type: 'date' },
              { key: 'URL', label: 'Website' },
              { key: 'Aditional context', label: 'Additional Context', type: 'textarea', fullWidth: true },
            ]}
            initialValues={(() => {
              const v = { ...editingEvent.fields };
              if (v['Starting']) v['Starting'] = v['Starting'].split('T')[0];
              if (v['End date']) v['End date'] = v['End date'].split('T')[0];
              return v;
            })()}
            onSave={saveEventEdit}
            onClose={() => setEditingEvent(null)}
          />
        )}
      </div>
    );
  }

  // Events list view
  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>Events Hub</h1>
          <p>Manage events, track invitations and stakeholder engagement</p>
        </div>
        <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={() => setShowAddEvent(!showAddEvent)}>
          {showAddEvent ? '✕ Close' : '➕ Add Event'}
        </button>
      </div>

      {/* Add Event Form */}
      {showAddEvent && (
        <div className="card" style={{ borderLeft: '3px solid var(--globant-green)', marginBottom: 16 }}>
          <div className="card-header"><h3>🎪 New Event</h3></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>EVENT NAME *</label>
              <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="e.g. GITEX 2025" value={evNewName} onChange={e => setEvNewName(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>START DATE *</label>
              <input type="date" className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} value={evNewStart} onChange={e => setEvNewStart(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>END DATE</label>
              <input type="date" className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} value={evNewEnd} onChange={e => setEvNewEnd(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>WEBSITE</label>
              <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="https://..." value={evNewWebsite} onChange={e => setEvNewWebsite(e.target.value)} />
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>ADDITIONAL CONTEXT</label>
            <textarea className="input-field" style={{ width: '100%', minHeight: 60, resize: 'vertical', fontFamily: 'inherit', fontSize: 12 }} placeholder="Event description, theme, target audience..." value={evNewContext} onChange={e => setEvNewContext(e.target.value)} />
          </div>
          <div style={{ marginTop: 10 }}>
            <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>ATTACHMENT URL <span style={{ fontWeight: 400, textTransform: 'none' }}>(Google Drive / Dropbox / any public link)</span></label>
            <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="https://drive.google.com/..." value={evNewAttachUrl} onChange={e => setEvNewAttachUrl(e.target.value)} />
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={createEvent} disabled={!evNewName.trim() || !evNewStart || evCreating}>
              {evCreating ? '⏳ Creating...' : '🚀 Create Event'}
            </button>
            <button className="action-btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowAddEvent(false)}>Cancel</button>
            <span style={{ fontSize: 11, color: 'var(--globant-muted)', marginLeft: 8 }}>💡 Make sure "Website" and "Attachments" fields exist in your Events table in Airtable</span>
          </div>
        </div>
      )}

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 24 }}>
        <div className="card" style={{ textAlign: 'center', padding: '18px 12px', background: 'linear-gradient(135deg, rgba(91,191,181,0.12) 0%, rgba(91,191,181,0.03) 100%)' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--globant-green)', lineHeight: 1 }}>{events.length}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Total Events</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '18px 12px' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--globant-info)', lineHeight: 1 }}>{upcoming.length}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Upcoming</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '18px 12px' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--globant-success)', lineHeight: 1 }}>{totalInvited}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Total Invitations</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '18px 12px' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--globant-warning)', lineHeight: 1 }}>{past.length}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Past Events</div>
        </div>
      </div>

      {/* Upcoming Events */}
      {upcoming.length > 0 && (
        <div className="card" style={{ borderLeft: '3px solid var(--globant-green)' }}>
          <div className="card-header"><h3>🟢 Upcoming Events</h3></div>
          {upcoming.map(ev => {
            const invitedIds = linkedIds(ev, 'Stakeholders invited');
            const invitedSh = invitedIds.map(id => stakeholders.find(s => s.id === id)).filter(Boolean);
            const startDate = ev.fields?.['Starting'];
            const daysUntil = startDate ? Math.ceil((new Date(startDate) - now) / (1000*60*60*24)) : null;
            const accSet = new Set();
            invitedSh.forEach(s => resolveLinked(s, 'Account', accounts, 'Account Name').forEach(n => accSet.add(n)));
            return (
              <div key={ev.id} onClick={() => selectEvent(ev.id)} style={{ padding: '14px 12px', marginBottom: 8, borderRadius: 8, background: 'rgba(91,191,181,0.04)', cursor: 'pointer', transition: 'background 0.2s' }} onMouseEnter={e => e.currentTarget.style.background = 'rgba(91,191,181,0.1)'} onMouseLeave={e => e.currentTarget.style.background = 'rgba(91,191,181,0.04)'}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{F(ev, 'Event Name')}</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span className="badge badge-blue">{formatDate(startDate)}{ev.fields?.['End date'] ? ` — ${formatDate(ev.fields['End date'])}` : ''}</span>
                    {daysUntil !== null && <span className="badge badge-green">{daysUntil === 0 ? 'Today' : daysUntil === 1 ? 'Tomorrow' : `${daysUntil}d`}</span>}
                    <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '2px 6px' }} onClick={e => { e.stopPropagation(); setEditingEvent(ev); }}>✏️</button>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--globant-muted)' }}>
                  <span>👥 {invitedSh.length} invited</span>
                  <span>🏢 {accSet.size} account{accSet.size !== 1 ? 's' : ''}</span>
                  {invitedSh.length > 0 && <span>{invitedSh.slice(0, 3).map(s => F(s, 'Name')).join(', ')}{invitedSh.length > 3 ? ` +${invitedSh.length - 3}` : ''}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Past Events */}
      {past.length > 0 && (
        <div className="card">
          <div className="card-header"><h3>📁 Past Events</h3></div>
          {past.map(ev => {
            const invitedIds = linkedIds(ev, 'Stakeholders invited');
            const invCount = invitedIds.length;
            return (
              <div key={ev.id} onClick={() => selectEvent(ev.id)} style={{ padding: '12px', marginBottom: 6, borderRadius: 8, background: 'rgba(255,255,255,0.02)', cursor: 'pointer', transition: 'background 0.2s' }} onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'} onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{F(ev, 'Event Name')}</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span className="badge badge-yellow">{formatDate(ev.fields?.['Starting'])}</span>
                    <span style={{ fontSize: 12, color: 'var(--globant-muted)' }}>👥 {invCount}</span>
                    <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '2px 6px' }} onClick={e => { e.stopPropagation(); setEditingEvent(ev); }}>✏️</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {events.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <p style={{ color: 'var(--globant-muted)', fontSize: 14 }}>No events found. Add events in Airtable to start managing invitations here.</p>
        </div>
      )}

      {editingEvent && (
        <EditModal
          title={`Edit: ${F(editingEvent, 'Event Name') || 'Event'}`}
          fields={[
            { key: 'Event Name', label: 'Event Name', fullWidth: true },
            { key: 'Starting', label: 'Start Date', type: 'date' },
            { key: 'End date', label: 'End Date', type: 'date' },
            { key: 'URL', label: 'Website' },
            { key: 'Aditional context', label: 'Additional Context', type: 'textarea', fullWidth: true },
          ]}
          initialValues={(() => {
            const v = { ...editingEvent.fields };
            if (v['Starting']) v['Starting'] = v['Starting'].split('T')[0];
            if (v['End date']) v['End date'] = v['End date'].split('T')[0];
            return v;
          })()}
          onSave={saveEventEdit}
          onClose={() => setEditingEvent(null)}
        />
      )}
    </div>
  );
}

// ============ ICP ============

export default EventsHub;
