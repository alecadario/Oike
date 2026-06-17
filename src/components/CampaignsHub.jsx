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
import ContentLab from './ContentLab.jsx';


function CampaignsHub({ data, api, onLogActivity, onAddRecord, onUpdateRecord, onDeleteRecord, campaignPrefill, clearCampaignPrefill }) {
  const { campaigns = [], stakeholders = [], accounts = [], outreach = [], events = [], landings = [] } = data;

  const [selectedId, setSelectedId] = useState(null);
  const [listSearch, setListSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(null);
  const [form, setForm] = useState({ name:'', type:'White Paper', status:'Draft', messageTemplate:'', assetUrl:'', startDate:'', goal:'', context:'', assignedIds: [] });
  const [saving, setSaving] = useState(false);
  const [hubTab, setHubTab] = useState('campaigns');
  const [tplExpanded, setTplExpanded] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [ctxExpanded, setCtxExpanded] = useState(false);
  const [sumExpanded, setSumExpanded] = useState(false);

  // Handle campaignPrefill coming from Report Builder (Create campaign from insight)
  useEffect(() => {
    if (campaignPrefill) {
      setEditingCampaign(null);
      setSelectedId(null);
      setForm({
        name: campaignPrefill.name || '',
        type: campaignPrefill.type || 'White Paper',
        status: 'Draft',
        messageTemplate: '',
        assetUrl: '',
        startDate: '',
        goal: '',
        context: campaignPrefill.context || '',
        assignedIds: campaignPrefill.stakeholderIds || [],
      });
      setShowForm(true);
      if (clearCampaignPrefill) clearCampaignPrefill();
    }
  }, [campaignPrefill, clearCampaignPrefill]);
  const [filterIndustry, setFilterIndustry] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [invitePreview, setInvitePreview] = useState(null); // {id, msg, generating}

  // Campaign Context + AI Summary state
  const [editingContext, setEditingContext] = useState(false);
  const [contextDraft, setContextDraft] = useState('');
  const [savingContext, setSavingContext] = useState(false);
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [campaignUploadingFile, setCampaignUploadingFile] = useState(false);

  // Message Template inline edit
  const [editingTemplate, setEditingTemplate] = useState(false);
  const [templateDraft, setTemplateDraft] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Sequence step preview
  const [stepPreviews, setStepPreviews] = useState({});
  const [generatingStepPreview, setGeneratingStepPreview] = useState(null);

  const saveCampaignContext = async () => {
    if (!selectedCampaign) return;
    setSavingContext(true);
    try {
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, { 'Context': contextDraft });
      if (onUpdateRecord) onUpdateRecord('campaigns', selectedCampaign.id, { 'Context': contextDraft });
      setEditingContext(false);
      if (onLogActivity) onLogActivity();
    } catch (e) {
      console.error('[saveCampaignContext] Error:', e);
      window.__oikeToast('Failed to save context: ' + (e.message || 'unknown'), 'error');
    }
    setSavingContext(false);
  };

  const saveCampaignTemplate = async () => {
    if (!selectedCampaign) return;
    setSavingTemplate(true);
    try {
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, { 'Message Template': templateDraft });
      if (onUpdateRecord) onUpdateRecord('campaigns', selectedCampaign.id, { 'Message Template': templateDraft });
      setEditingTemplate(false);
      if (onLogActivity) onLogActivity();
    } catch (e) {
      window.__oikeToast('Failed to save template: ' + (e.message || 'unknown'), 'error');
    }
    setSavingTemplate(false);
  };

  const generateStepPreview = async (stepIndex, step) => {
    if (!selectedCampaign || generatingStepPreview !== null) return;
    setGeneratingStepPreview(stepIndex);
    try {
      const template = F(selectedCampaign, 'Message Template') || '';
      const context  = F(selectedCampaign, 'Context') || '';
      const aiSummary = F(selectedCampaign, 'AI Summary') || '';
      const campaignName = F(selectedCampaign, 'Name') || '';
      const campaignType = F(selectedCampaign, 'Type') || '';
      const assetUrl = F(selectedCampaign, 'Asset URL') || '';
      const isFollowUp = stepIndex > 0;
      const langInstruction = tplLanguage === 'es' ? 'Write in Spanish (Latin American, tuteo or voseo as natural).' : tplLanguage === 'pt' ? 'Write in Brazilian Portuguese.' : tplLanguage === 'fr' ? 'Write in French.' : 'Write in English.';
      const prompt = `You are a senior B2B sales rep writing a ${step.channel || 'Email'} message for step ${stepIndex + 1} of the "${campaignName}" outreach campaign (${campaignType}).

${isFollowUp
  ? `This is a follow-up (sent ${step.waitDays} day${step.waitDays !== 1 ? 's' : ''} after the previous touch, condition: ${step.condition === 'no_reply' ? 'only if no reply' : 'always'}). Reference that a previous message was sent and add a new angle or brief value-add. Keep it short — 3-4 sentences max.`
  : `This is the first touch. Keep it punchy and human — 4-6 sentences max. Open with a sharp observation, not a generic intro.`}
${step.note ? `Step intent: "${step.note}"` : ''}
${template ? `\nReference angle (personalize — DO NOT copy verbatim, rewrite naturally):\n"${template.slice(0, 500)}"` : ''}
${context ? `\nCampaign context:\n${context.slice(0, 700)}` : ''}
${aiSummary ? `\nStrategic brief:\n${aiSummary.slice(0, 500)}` : ''}
${assetUrl ? `\nAsset link to reference: ${assetUrl}` : ''}

LANGUAGE: ${langInstruction}
Write for a fictional prospect — use {{first_name}} and {{company}} as tokens. Output ONLY the message body (no subject line, no greeting label, no signature block). Sound like a human, not a template.`;

      const preview = await callOpenAI({ prompt, temperature: 0.72, max_tokens: 400 });
      setStepPreviews(prev => ({ ...prev, [stepIndex]: preview }));
    } catch (e) {
      window.__oikeToast('Preview generation failed: ' + (e.message || 'unknown'), 'error');
    }
    setGeneratingStepPreview(null);
  };

  // File upload → AI summary → append to Campaign "Context" as FILE: block
  const handleCampaignFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !selectedCampaign) return;
    setCampaignUploadingFile(true);
    try {
      const text = await file.text();
      const prompt = `Summarize the following file content. Extract the most relevant points for a B2B sales team running this campaign. Be concise (5-8 bullets max).\n\nFile: ${file.name}\n\n${text.slice(0, 8000)}`;
      const summary = await callOpenAI({ prompt, temperature: 0.4, max_tokens: 500 });
      const dateStr = new Date().toLocaleDateString('en-GB');
      const entry = `\n\n📎 FILE: ${file.name} (uploaded ${dateStr})\n${summary}`;
      const currentContext = F(selectedCampaign, 'Context') || '';
      const updated = (currentContext + entry).trim();
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, { 'Context': updated });
      if (onUpdateRecord) onUpdateRecord('campaigns', selectedCampaign.id, { 'Context': updated });
      if (onLogActivity) onLogActivity();
    } catch (err) {
      console.error('Campaign file upload failed:', err);
      window.__oikeToast('File upload failed — try again with a smaller file or a different format.', 'error');
    }
    setCampaignUploadingFile(false);
    e.target.value = '';
  };

  const generateCampaignSummary = async () => {
    if (!selectedCampaign) return;
    const ctx = F(selectedCampaign, 'Context') || '';
    if (!ctx.trim()) {
      window.__oikeToast('Add campaign context first — the AI needs something to work with.', 'warning');
      return;
    }
    setGeneratingSummary(true);
    try {
      const name = F(selectedCampaign, 'Name') || '';
      const type = F(selectedCampaign, 'Type') || '';
      const template = F(selectedCampaign, 'Message Template') || '';
      const asset = F(selectedCampaign, 'Asset URL') || '';
      const notes = F(selectedCampaign, 'Notes') || '';

      const prompt = `You are a senior B2B sales strategist for ${COMPANY_PROFILE.companyName} (${COMPANY_PROFILE.services}).

Write a concise strategic summary (under 180 words) of this outreach campaign. Focus on: who should be targeted, what pain this asset solves, the best opening angle, and what outcome we want per touch. Be specific and actionable — this summary will be used as context when personalizing individual messages.

CAMPAIGN: ${name}
TYPE: ${type}
ASSET: ${asset || 'None provided'}

MANUAL CONTEXT (user-written):
${ctx}

${template ? `REFERENCE MESSAGE TEMPLATE:\n${template.slice(0, 400)}` : ''}
${notes ? `ADDITIONAL NOTES:\n${notes.slice(0, 400)}` : ''}

Format as 3-4 short sections with ### headers: Target, Angle, Pain Addressed, Desired Outcome. Use **bold** for key phrases. No fluff.`;

      const summary = await callOpenAI({ prompt, temperature: 0.6, max_tokens: 500 });
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, { 'AI Summary': summary });
      if (onLogActivity) onLogActivity();
    } catch (e) {
      console.error('[generateCampaignSummary] Error:', e);
      window.__oikeToast('Failed to generate summary: ' + (e.message || 'unknown'), 'error');
    }
    setGeneratingSummary(false);
  };

  const TYPE_OPTIONS = ['White Paper', 'News / Article', 'Product Launch', 'Case Study', 'Cold Outreach'];
  const STATUS_OPTIONS = ['Draft', 'Active', 'Paused', 'Completed'];
  const STATUS_COLORS = { 'Draft': '#a78bfa', 'Active': '#4ade80', 'Paused': '#fbbf24', 'Completed': '#60a5fa' };
  const TYPE_ICONS = { 'White Paper': '📄', 'News / Article': '📰', 'Product Launch': '🚀', 'Case Study': '📊', 'Cold Outreach': '🎯' };

  const selectedCampaign = campaigns.find(c => c.id === selectedId) || null;
  const reachedIds = selectedCampaign ? linkedIds(selectedCampaign, 'Stakeholders Reached') : [];
  // Assigned = curated list of contacts for this campaign. Includes legacy Reached for backward compatibility.
  const assignedIdsRaw = selectedCampaign ? linkedIds(selectedCampaign, 'Assigned Stakeholders') : [];
  const assignedIds = [...new Set([...assignedIdsRaw, ...reachedIds])];

  // ── Filtered campaigns list ──
  const filteredCampaigns = campaigns.filter(c => {
    if (statusFilter && F(c,'Status') !== statusFilter) return false;
    if (listSearch && !(F(c,'Name')||'').toLowerCase().includes(listSearch.toLowerCase())) return false;
    return true;
  }).sort((a,b) => (F(b,'Start Date')||'').localeCompare(F(a,'Start Date')||''));

  // ── Filter options for detail view ──
  const industryOptions = [...new Set(accounts.map(a => F(a,'Industry')).filter(Boolean))].sort();
  const roleOptions = [...new Set(stakeholders.map(s => F(s,'Role')).filter(Boolean))].sort();

  // ── Detail contacts: ONLY those assigned to this campaign (curated) ──
  const detailContacts = selectedCampaign ? stakeholders.filter(s => {
    if (!assignedIds.includes(s.id)) return false; // Only assigned contacts
    if (filterSearch) {
      const q = filterSearch.toLowerCase();
      if (!(`${F(s,'Name')||''} ${F(s,'Last name')||''} ${F(s,'Role')||''}`).toLowerCase().includes(q)) return false;
    }
    if (filterRole && F(s,'Role') !== filterRole) return false;
    if (filterIndustry) {
      const acc = accounts.find(a => linkedIds(s,'Account').includes(a.id));
      if (!acc || F(acc,'Industry') !== filterIndustry) return false;
    }
    return true;
  }).sort((a,b) => {
    const aR = reachedIds.includes(a.id), bR = reachedIds.includes(b.id);
    if (aR !== bR) return aR ? 1 : -1; // Pending first, reached last
    return (F(a,'Name')||'').localeCompare(F(b,'Name')||'');
  }) : [];

  // Contacts pending outreach that have an email (for bulk send)
  const pendingEmailContacts = useMemo(() => (selectedCampaign
    ? detailContacts.filter(s => !reachedIds.includes(s.id) && !!F(s,'Email'))
    : []), [selectedCampaign, detailContacts, reachedIds]);

  // All contacts with email (pending + already reached) — used in bulk panel to allow re-touch
  const allEmailContacts = useMemo(() => (selectedCampaign
    ? detailContacts.filter(s => !!F(s,'Email'))
    : []), [selectedCampaign, detailContacts]);

  // ── Add / Remove contacts from campaign ──
  const [showAddContacts, setShowAddContacts] = useState(false);
  const [addContactsSearch, setAddContactsSearch] = useState('');
  const [addingContactId, setAddingContactId] = useState(null);
  const [selectedToAdd, setSelectedToAdd] = useState(new Set()); // bulk selection
  const [bulkAdding, setBulkAdding] = useState(false);
  const [campaignHistoryStk, setCampaignHistoryStk] = useState(null); // for StakeholderHistoryModal
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkMsgs, setBulkMsgs] = useState({}); // {[id]: {msg, status, error}}
  const [bulkSending, setBulkSending] = useState(false);
  const [bulkResult, setBulkResult] = useState(null); // {sent, errors}
  const [bulkDraftMode, setBulkDraftMode] = useState(false);
  const [gmailQueueIdx, setGmailQueueIdx] = useState(null); // null = not in queue mode; number = current index
  const [showSeq, setShowSeq] = useState(false);
  const [seqSteps, setSeqSteps] = useState([]);
  const [seqConfig, setSeqConfig] = useState({ sendHour: 9, timezone: 'America/Argentina/Buenos_Aires' });
  const [seqDirty, setSeqDirty] = useState(false);
  const [savingSeq, setSavingSeq] = useState(false);
  const [seqTab, setSeqTab] = useState('steps');
  const [enrolling, setEnrolling] = useState(false);
  const [enrollDateTime, setEnrollDateTime] = useState('');
  const [runningSeq, setRunningSeq] = useState(false);
  const [showEmailTpl, setShowEmailTpl] = useState(false);
  const [showCampaignLandings, setShowCampaignLandings] = useState(false);
  const [emailTplHtml, setEmailTplHtml] = useState('');
  const [emailTplDirty, setEmailTplDirty] = useState(false);
  const [emailTplSubject, setEmailTplSubject] = useState('');
  const [generatingTpl, setGeneratingTpl] = useState(false);
  const [savingTpl, setSavingTpl] = useState(false);
  const [previewTpl, setPreviewTpl] = useState(false);
  const [bulkUseHtml, setBulkUseHtml] = useState(false);
  const [emailTplContent, setEmailTplContent] = useState(null); // parsed sections for visual editor
  const [tplLanguage, setTplLanguage] = useState('en');

  const addContactToCampaign = async (stakeholderId) => {
    if (!selectedCampaign) return;
    const currentAssigned = linkedIds(selectedCampaign, 'Assigned Stakeholders');
    if (currentAssigned.includes(stakeholderId)) return;
    setAddingContactId(stakeholderId);
    const newAssigned = [...currentAssigned, stakeholderId];
    if (onUpdateRecord) onUpdateRecord('campaigns', selectedCampaign.id, { 'Assigned Stakeholders': newAssigned });
    try {
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, { 'Assigned Stakeholders': newAssigned });
      // NOTE: do NOT update stakeholder's 'Campaign' field — that field is the reverse link
      // of 'Stakeholders Reached' and would mark the contact as reached immediately.
    } catch (e) { console.error('Add contact to campaign failed:', e); }
    setAddingContactId(null);
  };

  const addBulkContactsToCampaign = async () => {
    if (!selectedCampaign || selectedToAdd.size === 0) return;
    setBulkAdding(true);
    const currentAssigned = linkedIds(selectedCampaign, 'Assigned Stakeholders');
    const toAdd = [...selectedToAdd].filter(id => !currentAssigned.includes(id));
    if (toAdd.length === 0) { setBulkAdding(false); setSelectedToAdd(new Set()); return; }
    const newAssigned = [...currentAssigned, ...toAdd];
    if (onUpdateRecord) onUpdateRecord('campaigns', selectedCampaign.id, { 'Assigned Stakeholders': newAssigned });
    try {
      const a = api || new AirtableAPI();
      // Update campaign's Assigned Stakeholders only — do NOT touch stakeholder's 'Campaign' field
      // because that is the reverse link of 'Stakeholders Reached' and would mark them as reached.
      await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, { 'Assigned Stakeholders': newAssigned });
    } catch (e) { console.error('Bulk add contacts failed:', e); window.__oikeToast('Some contacts may not have been added — check your connection and try again.', 'error'); }
    setSelectedToAdd(new Set());
    setShowAddContacts(false);
    setAddContactsSearch('');
    setBulkAdding(false);
  };

  const removeContactFromCampaign = async (stakeholderId) => {
    if (!selectedCampaign) return;
    if (!window.confirm('Remove this contact from the campaign? (Their outreach history stays intact.)')) return;
    setAddingContactId(stakeholderId);
    const currentAssigned = linkedIds(selectedCampaign, 'Assigned Stakeholders');
    const currentReached = linkedIds(selectedCampaign, 'Stakeholders Reached');
    const newAssigned = currentAssigned.filter(id => id !== stakeholderId);
    const newReached = currentReached.filter(id => id !== stakeholderId);
    if (onUpdateRecord) onUpdateRecord('campaigns', selectedCampaign.id, {
      'Assigned Stakeholders': newAssigned,
      'Stakeholders Reached': newReached,
    });
    try {
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, {
        'Assigned Stakeholders': newAssigned,
        'Stakeholders Reached': newReached,
      });
    } catch (e) { console.error('Remove contact from campaign failed:', e); }
    setAddingContactId(null);
  };

  // ── Bulk Email: generate AI messages (or HTML openers) for targeted contacts ──
  const generateBulkMessages = async (contacts) => {
    if (!contacts.length) return;
    const init = {};
    contacts.forEach(s => { init[s.id] = { msg: '', status: 'generating', error: '' }; });
    // Merge into existing state (don't wipe already-sent contacts)
    setBulkMsgs(prev => ({ ...prev, ...init }));
    setBulkResult(null);
    const BATCH = 3;
    for (let i = 0; i < contacts.length; i += BATCH) {
      const batch = contacts.slice(i, i + BATCH);
      await Promise.all(batch.map(async (s) => {
        try {
          if (bulkUseHtml) {
            // HTML mode: generate short AI opener (body only, no Subject line)
            const opener = await generateContactOpener(s);
            setBulkMsgs(prev => ({ ...prev, [s.id]: { msg: opener.trim(), status: 'ready', error: '' } }));
          } else {
            const sName = `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim();
            const role = F(s,'Role') || '';
            const influence = F(s,'Level of Influence') || '';
            const pain = (F(s,'Pain Points (Generated)') || F(s,'Pain points') || '').slice(0,300);
            const linkedinNews = (F(s,'LinkedIn News (Generated)') || F(s,'Linkedin lates news') || '').slice(0,200);
            const accId = linkedIds(s,'Account')[0];
            const acc = accounts.find(a => a.id === accId);
            const accName = acc ? F(acc,'Account Name') : '';
            const industry = acc ? F(acc,'Industry') : '';
            const accNews = acc ? (F(acc,'Recent News')||'').slice(0,150) : '';
            const sOut = outreach
              .filter(o => linkedIds(o,'Stakeholder').includes(s.id))
              .sort((a,b) => new Date(b.fields?.['Date']||0) - new Date(a.fields?.['Date']||0))
              .slice(0,2).map(o => `[${F(o,'Channel')||'?'} · ${o.fields?.['Date'] ? new Date(o.fields['Date']).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '?'}] ${(F(o,'Message')||'').slice(0,100)}`).join('\n');
            const campaignName = F(selectedCampaign,'Name') || '';
            const campaignType = F(selectedCampaign,'Type') || '';
            const template = F(selectedCampaign,'Message Template') || '';
            const assetUrl = F(selectedCampaign,'Asset URL') || '';
            const campaignContext = (F(selectedCampaign,'Context') || '').slice(0, 600);
            const campaignAiSummary = (F(selectedCampaign,'AI Summary') || '').slice(0, 600);
            const prompt = `B2B sales rep. Write ONE personalized email for this campaign. Start with "Subject: [subject]", blank line, body. Max 3 sentences. No fluff.

CONTACT: ${sName} | ${role}${influence ? ` (${influence})` : ''} | ${accName}${industry ? ` — ${industry}` : ''}
${pain ? `Pain: ${pain}` : ''}${linkedinNews ? `\nLinkedIn: ${linkedinNews}` : ''}${accNews ? `\nCompany news: ${accNews}` : ''}
History: ${sOut || 'First contact'}
CAMPAIGN: "${campaignName}" (${campaignType})
${campaignContext ? `CAMPAIGN CONTEXT:\n${campaignContext}\n` : ''}${campaignAiSummary ? `STRATEGIC BRIEF:\n${campaignAiSummary}\n` : ''}${template ? `Angle (rewrite for this person, DO NOT copy verbatim): "${template.slice(0,300)}"` : ''}${assetUrl ? `\nAsset: ${assetUrl}` : ''}
Sender: ${COMPANY_PROFILE.senderName||'Ale'}, ${COMPANY_PROFILE.companyName||'Oike'}
BANNED: "following up"/"checking in"/"hope this finds you"/"touching base"/brackets/placeholders.`;
            const msg = await callOpenAI({ prompt, temperature: 0.75, max_tokens: 250 });
            setBulkMsgs(prev => ({ ...prev, [s.id]: { msg: msg.trim(), status: 'ready', error: '' } }));
          }
        } catch(e) {
          setBulkMsgs(prev => ({ ...prev, [s.id]: { msg: '', status: 'error', error: e.message || 'Generation failed' } }));
        }
      }));
    }
  };

  // ── Open in Gmail queue — one per click (avoids popup blocker), copies HTML to clipboard ──
  const openGmailQueueItem = (targets, idx) => {
    if (idx >= targets.length) { setGmailQueueIdx(null); if (onLogActivity) onLogActivity(); return; }
    const a = api || new AirtableAPI();
    const s = targets[idx];
    const email = F(s,'Email');
    const firstName = F(s,'Name') || 'there';
    const accId = linkedIds(s,'Account')[0];
    const acc = accId ? accounts.find(a => a.id === accId) : null;
    const companyName = acc ? F(acc,'Account Name') : '';
    const campaignName = F(selectedCampaign,'Name') || 'Campaign';
    const msg = bulkMsgs[s.id]?.msg || '';
    let subject, body;
    if (bulkUseHtml) {
      subject = emailTplSubject.trim()
        ? emailTplSubject.replace(/\{\{first_name\}\}/g, firstName).replace(/\{\{company\}\}/g, companyName)
        : `${campaignName} — for ${firstName} at ${companyName||'your team'}`;
      body = msg; // AI opener as plain text body
      // Copy full HTML template to clipboard so user can paste in Gmail
      if (emailTplHtml) {
        const personalizedHtml = emailTplHtml
          .replace(/\{\{first_name\}\}/g, firstName)
          .replace(/\{\{company\}\}/g, companyName)
          .replace(/\{\{ai_opener\}\}/g, msg);
        navigator.clipboard.writeText(personalizedHtml).catch(() => {});
      }
    } else {
      const lines = msg.split('\n');
      const si = lines.findIndex(l => /^subject:/i.test(l.trim()));
      subject = si !== -1 ? lines[si].replace(/^subject:\s*/i,'').trim() : `${campaignName} — ${firstName}`;
      body = si !== -1 ? lines.slice(si+1).join('\n').trim() : msg;
    }
    window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
    // Log activity
    const accIds = linkedIds(s,'Account');
    const actFields = {
      'Activity Name': `Email — ${new Date().toLocaleDateString('en-US')}`,
      'Channel': 'Email', 'Status': 'Sent', 'Message': body,
      'Stakeholder': [s.id], 'Date': new Date().toISOString(),
      'Logged By': CURRENT_USER?.name || '',
      ...(accIds.length ? { 'Account': accIds } : {}),
      ...(selectedCampaign?.id ? { 'Campaign': [selectedCampaign.id] } : {}),
    };
    if (onAddRecord) onAddRecord('outreach', actFields);
    a.createRecord(TABLE_IDS.outreach, actFields).catch(e => console.error('[gmail-queue] log failed:', e));
    a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, {
      'Stakeholders Reached': [...new Set([...linkedIds(selectedCampaign,'Stakeholders Reached'), s.id])],
      'Assigned Stakeholders': [...new Set([...linkedIds(selectedCampaign,'Assigned Stakeholders'), s.id])],
    }).catch(() => {});
    setBulkMsgs(prev => ({ ...prev, [s.id]: { ...prev[s.id], status: 'sent' } }));
    window.__oikeToast(`✉️ Email queued for ${F(s, 'Name') || 'contact'} — opening Gmail`, 'success');
    setGmailQueueIdx(idx + 1); // advance to next
  };

  // ── Bulk Email: send all ready messages via Gmail API ──
  const executeBulkSend = async () => {
    setBulkSending(true);
    setBulkResult(null);
    let sent = 0, errors = 0;
    const readyContacts = pendingEmailContacts.filter(s => bulkMsgs[s.id]?.status === 'ready');
    for (let i = 0; i < readyContacts.length; i++) {
      const s = readyContacts[i];
      const { msg } = bulkMsgs[s.id];
      const email = F(s,'Email') || '';
      const lines = msg.split('\n');
      const si = lines.findIndex(l => /^subject:/i.test(l.trim()));
      let subject = `${F(selectedCampaign,'Name')||'Campaign'} — ${F(s,'Name')||''}`;
      let body = msg;
      if (si !== -1) { subject = lines[si].replace(/^subject:\s*/i,'').trim(); body = lines.slice(si+1).join('\n').trim(); }
      setBulkMsgs(prev => ({ ...prev, [s.id]: { ...prev[s.id], status: 'sending' } }));
      try {
        const res = await fetch('/api/gmail/send', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: email, subject, message: body, stakeholderId: s.id, accountIds: linkedIds(s,'Account'), baseId: AIRTABLE_BASE_ID, outreachTableId: TABLE_IDS.outreach, draft: bulkDraftMode }),
        });
        if (res.ok) {
          setBulkMsgs(prev => ({ ...prev, [s.id]: { ...prev[s.id], status: bulkDraftMode ? 'draft' : 'sent' } }));
          // Mark as reached on campaign
          const currentReached = linkedIds(selectedCampaign, 'Stakeholders Reached');
          const currentAssigned = linkedIds(selectedCampaign, 'Assigned Stakeholders');
          const a = api || new AirtableAPI();
          await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, {
            'Stakeholders Reached': [...new Set([...currentReached, s.id])],
            'Assigned Stakeholders': [...new Set([...currentAssigned, s.id])],
          }).catch(() => {});
          sent++;
        } else {
          const err = await res.json().catch(() => ({}));
          setBulkMsgs(prev => ({ ...prev, [s.id]: { ...prev[s.id], status: 'error', error: err.error || 'Send failed' } }));
          errors++;
        }
      } catch(e) {
        setBulkMsgs(prev => ({ ...prev, [s.id]: { ...prev[s.id], status: 'error', error: e.message || 'Send failed' } }));
        errors++;
      }
      if (i < readyContacts.length - 1) await new Promise(r => setTimeout(r, 1500));
    }
    setBulkSending(false);
    setBulkResult({ sent, errors });
    if (onLogActivity) onLogActivity();
  };

  // ── Sequence helpers ──
  const parseSeqSteps = (c) => { try { return JSON.parse(F(c,'Sequence Steps') || '[]'); } catch { return []; } };
  const parseSeqEnrollments = (c) => { try { return JSON.parse(F(c,'Sequence Enrollments') || '{}'); } catch { return {}; } };
  const parseSeqConfig = (c) => { try { return { sendHour: 9, timezone: 'America/Argentina/Buenos_Aires', active: true, sendMode: 'send', sendOnEnroll: false, ...JSON.parse(F(c,'Sequence Config') || '{}') }; } catch { return { sendHour: 9, timezone: 'America/Argentina/Buenos_Aires', active: true, sendMode: 'send', sendOnEnroll: false }; } };

  const parseTplContent = (html) => {
    try {
      const m = html.match(/<!--oike-content:(\{[\s\S]*?\})-->/);
      return m ? JSON.parse(m[1]) : null;
    } catch { return null; }
  };

  // Sync local seqSteps + config + email template when campaign changes
  useEffect(() => {
    if (selectedCampaign) {
      setSeqSteps(parseSeqSteps(selectedCampaign));
      setSeqConfig(parseSeqConfig(selectedCampaign));
      const savedHtml = F(selectedCampaign, 'Email HTML Template') || '';
      const savedContent = parseTplContent(savedHtml);
      setEmailTplContent(savedContent);
      // Re-render with current branding (restores photo/colors stripped at save time)
      setEmailTplHtml(savedContent ? renderCampaignEmail(savedContent, selectedCampaign, tplLanguage) : savedHtml);
    }
    setSeqDirty(false);
    setEmailTplDirty(false);
    setStepPreviews({});
    setEditingTemplate(false);
    setTplOpen(false);
  }, [selectedId]);

  const addSeqStep = () => {
    const last = seqSteps[seqSteps.length - 1];
    setSeqSteps(prev => [...prev, { waitDays: last ? (last.waitDays + 3) : 0, channel: 'Email', condition: prev.length === 0 ? 'always' : 'no_reply', note: '' }]);
    setSeqDirty(true);
  };
  const removeSeqStep = (i) => { setSeqSteps(prev => prev.filter((_,idx) => idx !== i)); setSeqDirty(true); };
  const updateSeqStep = (i, key, val) => { setSeqSteps(prev => prev.map((s,idx) => idx===i ? {...s,[key]:val} : s)); setSeqDirty(true); };

  const SEQ_TIMEZONES = [
    { label: 'Buenos Aires (ART, UTC-3)',  value: 'America/Argentina/Buenos_Aires' },
    { label: 'São Paulo (BRT, UTC-3)',      value: 'America/Sao_Paulo' },
    { label: 'Santiago (CLT, UTC-3/-4)',    value: 'America/Santiago' },
    { label: 'Bogotá (COT, UTC-5)',         value: 'America/Bogota' },
    { label: 'México DF (CST, UTC-6)',      value: 'America/Mexico_City' },
    { label: 'Lima (PET, UTC-5)',           value: 'America/Lima' },
    { label: 'New York (ET, UTC-5/-4)',     value: 'America/New_York' },
    { label: 'Chicago (CT, UTC-6/-5)',      value: 'America/Chicago' },
    { label: 'Los Angeles (PT, UTC-8/-7)',  value: 'America/Los_Angeles' },
    { label: 'London (GMT/BST)',            value: 'Europe/London' },
    { label: 'Madrid (CET, UTC+1/+2)',      value: 'Europe/Madrid' },
    { label: 'UTC',                         value: 'UTC' },
  ];

  const saveSeqSteps = async () => {
    if (!selectedCampaign) return;
    setSavingSeq(true);
    const stepsJson  = JSON.stringify(seqSteps);
    const configJson = JSON.stringify({ ...seqConfig, prompts: MESSAGE_PROMPTS });
    try {
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, { 'Sequence Steps': stepsJson, 'Sequence Config': configJson });
      if (onUpdateRecord) onUpdateRecord('campaigns', selectedCampaign.id, { 'Sequence Steps': stepsJson, 'Sequence Config': configJson });
      setSeqDirty(false);
    } catch(e) { window.__oikeToast('Failed to save sequence: ' + e.message, 'error'); }
    setSavingSeq(false);
  };

  const enrollInSequence = async () => {
    if (!selectedCampaign || seqSteps.length === 0) return;
    setEnrolling(true);
    const senderEmail = CURRENT_USER?.email || '';
    const today = new Date().toISOString().split('T')[0];
    const current = parseSeqEnrollments(selectedCampaign);
    const toEnroll = pendingEmailContacts.filter(s => !current[s.id] || current[s.id].status === 'completed');
    if (toEnroll.length === 0) { setEnrolling(false); window.__oikeToast('No pending email contacts to enroll.', 'warning'); return; }
    const firstStep = seqSteps[0];
    // Compute nextDateTime: if user picked a datetime use it, otherwise use now (for immediate) or add waitDays
    let baseDateTime;
    if (enrollDateTime) {
      baseDateTime = new Date(enrollDateTime);
    } else {
      baseDateTime = new Date(); // send immediately
    }
    if (firstStep.waitDays > 0 && !enrollDateTime) {
      baseDateTime.setDate(baseDateTime.getDate() + firstStep.waitDays);
    }
    const nextDateTime = baseDateTime.toISOString();
    const nextDate = nextDateTime.split('T')[0]; // backwards compat
    toEnroll.forEach(s => { current[s.id] = { step: 0, nextDate, nextDateTime, status: 'active', senderEmail, enrolledDate: today }; });
    const json = JSON.stringify(current);
    try {
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, { 'Sequence Enrollments': json });
      if (onUpdateRecord) onUpdateRecord('campaigns', selectedCampaign.id, { 'Sequence Enrollments': json });
      window.__oikeToast(`✅ ${toEnroll.length} contact${toEnroll.length>1?'s':''} enrolled in sequence.`, 'success');
      if (seqConfig.sendOnEnroll && seqConfig.active !== false) {
        setTimeout(() => runSequenceNow(), 800);
      }
    } catch(e) { window.__oikeToast('Enrollment failed: ' + e.message, 'error'); }
    setEnrolling(false);
  };

  const unenrollFromSequence = async (stakeholderId) => {
    if (!selectedCampaign) return;
    const current = parseSeqEnrollments(selectedCampaign);
    delete current[stakeholderId];
    const json = JSON.stringify(current);
    const a = api || new AirtableAPI();
    await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, { 'Sequence Enrollments': json });
    if (onUpdateRecord) onUpdateRecord('campaigns', selectedCampaign.id, { 'Sequence Enrollments': json });
  };

  // Force-advance all active enrollments to now, then run the sequence
  const forceRunSequenceNow = async () => {
    if (!selectedCampaign) return;
    setRunningSeq(true);
    try {
      const current = parseSeqEnrollments(selectedCampaign);
      const nowIso = new Date().toISOString();
      let changed = false;
      Object.values(current).forEach(en => {
        if (en.status === 'active') { en.nextDateTime = nowIso; en.nextDate = nowIso.split('T')[0]; changed = true; }
      });
      if (changed) {
        const a = api || new AirtableAPI();
        await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, { 'Sequence Enrollments': JSON.stringify(current) });
        if (onUpdateRecord) onUpdateRecord('campaigns', selectedCampaign.id, { 'Sequence Enrollments': JSON.stringify(current) });
      }
    } catch(e) { window.__oikeToast('Error advancing schedule: ' + e.message, 'error'); setRunningSeq(false); return; }
    await runSequenceNow(true);
  };

  // Feature 4: Trigger sequence runner manually
  const runSequenceNow = async (alreadyLoading = false) => {
    if (!alreadyLoading) setRunningSeq(true);
    try {
      const res = await fetch('/.netlify/functions/campaign-sequence-runner', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      let result = {};
      try { result = await res.json(); } catch {}
      const sentCount = result.sent ?? 0;
      const skippedCount = result.skipped ?? 0;
      const errCount = result.errors ?? 0;
      const version = result.v ? ` (v${result.v})` : ' (old)';
      const diag = result.diag;
      const logErrCount = diag?.logErrors ?? 0;
      const enrollErrCount = diag?.enrollErrors ?? 0;
      const diagStr = diag ? ` [${diag.users}u·${diag.bases}b·${diag.campaigns}c·${diag.due}due${logErrCount > 0 ? `·${logErrCount}logErr` : ''}${enrollErrCount > 0 ? `·${enrollErrCount}enrollErr` : ''}]` : '';
      const errDetail = result.firstError ? `: ${result.firstError.slice(0, 80)}` : ' — check Netlify logs';
      if (sentCount > 0 && logErrCount === 0 && enrollErrCount === 0) {
        window.__oikeToast(`✅ ${sentCount} email${sentCount > 1 ? 's' : ''} sent!${skippedCount > 0 ? ` · ${skippedCount} skipped` : ''}${version}${diagStr}`, 'success');
      } else if (sentCount > 0 && enrollErrCount > 0) {
        window.__oikeToast(`⚠️ ${sentCount} sent pero no se guardó el estado${errDetail}${diagStr}${version}`, 'warning');
      } else if (sentCount > 0 && logErrCount > 0) {
        window.__oikeToast(`⚠️ ${sentCount} sent pero falló el log de actividad${errDetail}${diagStr}${version}`, 'warning');
      } else if (errCount > 0) {
        window.__oikeToast(`❌ ${errCount} error${errCount > 1 ? 's' : ''}${errDetail}${diagStr}${version}`, 'error');
      } else if (skippedCount > 0) {
        window.__oikeToast(`⚠️ 0 sent — ${skippedCount} skipped (no Gmail token)${diagStr}${version}`, 'warning');
      } else {
        window.__oikeToast(`No emails due right now${diagStr}${version}`, 'info');
      }
      if (onLogActivity) onLogActivity();
    } catch (e) {
      window.__oikeToast('Failed to run sequence: ' + (e.message || 'unknown'), 'error');
    }
    setRunningSeq(false);
  };

  // ── Render campaign email HTML from content sections ──
  const renderCampaignEmail = (S, camp, lang = 'en') => {
    const _br         = loadBranding();
    const accentColor = _br.accentColor  || COMPANY_PROFILE.accentColor || '#5bbfb5';
    const darkColor   = _br.darkColor    || COMPANY_PROFILE.darkColor   || '#1a1a2e';
    const _rawLogo    = _br.senderLogo   || COMPANY_PROFILE.senderLogo  || '';
    const _rawPhoto   = _br.senderPhoto  || COMPANY_PROFILE.senderPhoto || '';
    // Prefer explicit public URLs for email (Gmail blocks data: URIs)
    const senderLogo  = _br.senderLogoUrl  || (_rawLogo.startsWith('data:')  ? '' : _rawLogo);
    const senderPhoto = _br.senderPhotoUrl || (_rawPhoto.startsWith('data:') ? '' : _rawPhoto);
    const senderTitle = _br.senderTitle  || COMPANY_PROFILE.senderTitle || '';
    const senderName  = _br.senderName   || COMPANY_PROFILE.senderName  || 'Ale';
    const senderCo    = COMPANY_PROFILE.companyName || 'Oike';
    const senderEmail = _br.senderEmail  || CURRENT_USER?.email || '';
    const calendarLink= _br.calendarLink || '';
    const assetUrl    = F(camp,'Asset URL') || '';
    const campaignName= F(camp,'Name') || '';
    const campaignType= F(camp,'Type') || '';
    const ctaLink     = assetUrl || calendarLink || `mailto:${senderEmail}`;
    const escape = t => String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const nl2br  = t => String(t||'').replace(/\n/g,'<br/>');
    const bullets = Array.isArray(S.bullets) ? S.bullets.filter(Boolean) : [];
    const eventRec = S.eventId ? (events || []).find(e => e.id === S.eventId) : null;
    const evName   = eventRec ? F(eventRec, 'Event Name') : '';
    const evDate   = eventRec?.fields?.['Starting'] ? new Date(eventRec.fields['Starting']).toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long', year:'numeric' }) : '';
    const evUrl    = eventRec ? (F(eventRec, 'URL') || '') : '';
    const evDesc   = eventRec ? (F(eventRec, 'Aditional context') || '').slice(0,180) : '';
    const contentMeta = `<!--oike-content:${JSON.stringify(S)}-->`;
    const i18nDefaults = lang === 'es' ? {
      closingLine1: 'Si algo de esto resuena con lo que está trabajando {{first_name}}, o querés profundizar en algún punto, respondé este mail y lo charlamos.',
      closingLine2: 'Con gusto comparto más contexto o datos específicos para tu industria.',
      replyBtn: 'Responder →',
      calBtn: '📅 Agendemos 15 min',
    } : lang === 'pt' ? {
      closingLine1: 'Se algo aqui ressoa com o que {{first_name}} está trabalhando, ou quiser aprofundar algum ponto, responda este e-mail e conversamos.',
      closingLine2: 'Fico feliz em compartilhar mais contexto ou dados específicos para o seu setor.',
      replyBtn: 'Responder →',
      calBtn: '📅 Agendar 15 min',
    } : {
      closingLine1: 'If any of this resonates with what {{first_name}} is working on, or you\'d like to dig deeper into any of these points, just reply to this email.',
      closingLine2: 'Happy to share more context or data specific to your industry.',
      replyBtn: 'Reply →',
      calBtn: '📅 Book 15 min',
    };
    const i18n = {
      closingLine1: S.closingLine1 || i18nDefaults.closingLine1,
      closingLine2: S.closingLine2 || i18nDefaults.closingLine2,
      replyBtn: S.replyBtn || i18nDefaults.replyBtn,
      calBtn: S.calBtn || i18nDefaults.calBtn,
    };
    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<meta name="x-apple-disable-message-reformatting" />
<title>${escape(campaignName)}</title>
${contentMeta}
<!--[if mso]><style type="text/css">table,td,div,h1,h2,h3,p,a{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:${escape(darkColor)};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4f6" style="background:#f3f4f6;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="620" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:620px;background:#ffffff;border-radius:16px;border-collapse:separate;">
  <tr><td bgcolor="${escape(darkColor)}" align="center" style="background:${escape(darkColor)};padding:40px 36px 36px;text-align:center;border-bottom:4px solid ${escape(accentColor)};border-radius:16px 16px 0 0;">
${senderLogo ? `<img src="${escape(senderLogo)}" alt="${escape(senderCo)}" width="auto" height="44" style="display:block;max-height:44px;max-width:160px;margin:0 auto 20px;border:0;outline:none;" />` : `<div style="display:inline-block;background:${escape(accentColor)};color:${escape(darkColor)};font-size:18px;font-weight:900;letter-spacing:1px;padding:8px 18px;border-radius:10px;margin:0 auto 20px;font-family:Arial,Helvetica,sans-serif;">${escape(senderCo)}</div>`}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 14px;"><tr><td bgcolor="${escape(accentColor)}25" style="background:${escape(accentColor)}25;border:1px solid ${escape(accentColor)}66;border-radius:20px;padding:4px 14px;color:${escape(accentColor)};font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif;">${escape(campaignType)} &middot; ${escape(senderCo)}</td></tr></table>
<h1 style="margin:0;font-size:28px;color:#ffffff;font-weight:800;line-height:1.2;letter-spacing:-0.5px;font-family:Arial,Helvetica,sans-serif;">${escape(campaignName)}</h1>
${S.subtitle !== '' ? `<p style="margin:12px 0 0;font-size:13px;color:${escape(accentColor)};letter-spacing:0.5px;font-family:Arial,Helvetica,sans-serif;opacity:0.85;">${S.subtitle || '{{company}}'}</p>` : ''}
  </td></tr>
  <tr><td style="padding:36px 36px 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;border-collapse:separate;"><tr><td bgcolor="${escape(accentColor)}10" style="background:${escape(accentColor)}10;padding:18px 22px;border-left:4px solid ${escape(accentColor)};border-radius:0 10px 10px 0;font-size:15px;line-height:1.6;color:${escape(darkColor)};font-weight:500;font-family:Arial,Helvetica,sans-serif;">{{ai_opener}}</td></tr></table>
${S.hook ? `<p style="margin:0 0 28px;font-size:15px;color:#374151;line-height:1.65;font-family:Arial,Helvetica,sans-serif;">${nl2br(escape(S.hook))}</p>` : ''}
${S.pain ? `<div style="margin-bottom:28px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;"><tr><td valign="middle" width="6" style="background:${escape(accentColor)};border-radius:3px;font-size:0;line-height:0;">&nbsp;</td><td valign="middle" style="padding-left:10px;font-size:18px;font-weight:800;color:${escape(darkColor)};font-family:Arial,Helvetica,sans-serif;">${escape(S.painHeading||'')}</td></tr></table><div style="font-size:14px;color:#374151;line-height:1.65;font-family:Arial,Helvetica,sans-serif;">${nl2br(escape(S.pain))}</div></div>` : ''}
${S.value ? `<div style="margin-bottom:24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;"><tr><td valign="middle" width="6" style="background:#a78bfa;border-radius:3px;font-size:0;line-height:0;">&nbsp;</td><td valign="middle" style="padding-left:10px;font-size:18px;font-weight:800;color:${escape(darkColor)};font-family:Arial,Helvetica,sans-serif;">${escape(S.valueHeading||'')}</td></tr></table><div style="font-size:14px;color:#374151;line-height:1.65;font-family:Arial,Helvetica,sans-serif;">${nl2br(escape(S.value))}</div></div>` : ''}
${bullets.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;border-collapse:separate;"><tr><td bgcolor="#FAFAFA" style="background:#FAFAFA;padding:18px 20px;border-radius:12px;border:1px solid ${escape(accentColor)}22;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${bullets.map((b,i)=>{const c=[accentColor,'#a78bfa','#60a5fa',accentColor][i%4];const last=i===bullets.length-1;return `<tr><td valign="top" width="38" style="padding:7px 12px 7px 0;${last?'':`border-bottom:1px solid ${escape(c)}15;`}"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${escape(c)}20" align="center" valign="middle" width="26" height="26" style="background:${escape(c)}20;color:${escape(c)};font-weight:800;font-size:12px;border-radius:13px;width:26px;height:26px;line-height:26px;text-align:center;font-family:Arial,Helvetica,sans-serif;">${i+1}</td></tr></table></td><td valign="top" style="padding:9px 0 7px;${last?'':`border-bottom:1px solid ${escape(c)}15;`}font-size:13px;color:${escape(darkColor)};line-height:1.5;font-family:Arial,Helvetica,sans-serif;">${escape(b)}</td></tr>`;}).join('')}</table></td></tr></table>` : ''}
${S.socialProof ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;border-collapse:separate;"><tr><td bgcolor="${escape(accentColor)}12" style="background:${escape(accentColor)}12;border:1px solid ${escape(accentColor)}33;border-radius:12px;padding:18px 22px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px;border-collapse:separate;"><tr>
    <td bgcolor="${escape(accentColor)}" align="center" valign="middle" width="28" height="28" style="background:${escape(accentColor)};border-radius:8px;width:28px;height:28px;text-align:center;line-height:28px;font-size:14px;">💡</td>
    <td style="padding-left:10px;font-size:11px;font-weight:800;color:${escape(accentColor)};text-transform:uppercase;letter-spacing:1.5px;font-family:Arial,Helvetica,sans-serif;">${tplLanguage === 'es' ? 'Acción concreta' : tplLanguage === 'pt' ? 'Ação prática' : 'Actionable tip'}</td>
  </tr></table>
  <div style="font-size:14px;color:${escape(darkColor)};line-height:1.65;font-family:Arial,Helvetica,sans-serif;font-weight:500;">${nl2br(escape(S.socialProof))}</div>
</td></tr></table>` : ''}
${evName ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;border-collapse:separate;">
  <tr><td bgcolor="${escape(accentColor)}08" style="background:${escape(accentColor)}08;border:1px solid ${escape(accentColor)}33;border-radius:12px;padding:20px 22px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="top" style="padding-right:16px;">
        <div style="font-size:10px;font-weight:700;color:${escape(accentColor)};text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px;font-family:Arial,Helvetica,sans-serif;">&#128197; Evento</div>
        <div style="font-size:17px;font-weight:800;color:${escape(darkColor)};margin-bottom:4px;font-family:Arial,Helvetica,sans-serif;">${escape(evName)}</div>
        ${evDate ? `<div style="font-size:12px;color:#6B7280;margin-bottom:${evDesc?'8':'0'}px;font-family:Arial,Helvetica,sans-serif;">${escape(evDate)}</div>` : ''}
        ${evDesc ? `<div style="font-size:12px;color:#374151;line-height:1.5;font-family:Arial,Helvetica,sans-serif;">${nl2br(escape(evDesc))}</div>` : ''}
      </td>
      ${evUrl ? `<td valign="middle" width="120" align="right" style="white-space:nowrap;">
        <a href="${escape(evUrl)}" style="display:inline-block;padding:10px 18px;background:${escape(accentColor)};color:${escape(darkColor)};text-decoration:none;font-weight:800;font-size:12px;border-radius:8px;font-family:Arial,Helvetica,sans-serif;">Ver evento &rarr;</a>
      </td>` : ''}
    </tr></table>
  </td></tr>
</table>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;border-top:1px solid #E5E7EB;border-collapse:separate;"><tr><td style="padding:28px 0 0;">
  <p style="margin:0 0 6px;font-size:14px;color:#374151;line-height:1.65;font-family:Arial,Helvetica,sans-serif;">${escape(i18n.closingLine1)}</p>
  <p style="margin:0 0 20px;font-size:14px;color:#374151;line-height:1.65;font-family:Arial,Helvetica,sans-serif;">${escape(i18n.closingLine2)}</p>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;border-collapse:separate;"><tr>
    <td bgcolor="${escape(accentColor)}" style="background:${escape(accentColor)};border-radius:10px;"><a href="mailto:${escape(senderEmail)}" style="display:inline-block;padding:11px 24px;color:${escape(darkColor)};text-decoration:none;font-weight:800;font-size:13px;font-family:Arial,Helvetica,sans-serif;">${escape(i18n.replyBtn)}</a></td>
    ${calendarLink?`<td width="10" style="font-size:0;line-height:0;">&nbsp;</td><td bgcolor="${escape(darkColor)}15" style="background:${escape(darkColor)}15;border-radius:10px;border:1px solid ${escape(accentColor)}44;"><a href="${escape(calendarLink)}" style="display:inline-block;padding:11px 20px;color:${escape(darkColor)};text-decoration:none;font-weight:700;font-size:13px;font-family:Arial,Helvetica,sans-serif;">${escape(i18n.calBtn)}</a></td>`:''}
  </tr></table>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>
    ${senderPhoto?`<td width="52" valign="middle" style="padding-right:12px;"><img src="${escape(senderPhoto)}" alt="${escape(senderName)}" width="44" height="44" style="display:block;width:44px;height:44px;border-radius:50%;border:2px solid ${escape(accentColor)};outline:none;" /></td>`:''}
    <td valign="middle" style="font-family:Arial,Helvetica,sans-serif;">
      <div style="font-size:13px;font-weight:700;color:${escape(darkColor)};">${escape(senderName)}</div>
      ${senderTitle?`<div style="font-size:11px;color:#6B7280;margin-top:1px;">${escape(senderTitle)}</div>`:''}
      ${senderEmail?`<div style="font-size:11px;color:${escape(accentColor)};margin-top:2px;">${escape(senderEmail)}</div>`:''}
    </td>
  </tr></table>
</td></tr></table>
  </td></tr>
  <tr><td bgcolor="${escape(darkColor)}" align="center" style="background:${escape(darkColor)};padding:20px 36px;text-align:center;border-radius:0 0 16px 16px;">
<div style="font-size:12px;color:#D1D5DB;font-family:Arial,Helvetica,sans-serif;"><strong style="color:#ffffff;">${escape(senderName)}</strong>${senderEmail?` &middot; <a href="mailto:${escape(senderEmail)}" style="color:${escape(accentColor)};text-decoration:none;">${escape(senderEmail)}</a>`:''}</div>
<div style="margin-top:6px;font-size:10px;color:#9CA3AF;letter-spacing:1px;font-family:Arial,Helvetica,sans-serif;">Powered by <a href="https://oike.app" style="color:${escape(accentColor)};text-decoration:none;font-weight:700;">OIKE</a> &middot; SALES INTELLIGENCE</div>
  </td></tr>
</table></td></tr></table>
</body></html>`;
  };

  // ── Email HTML Template (white paper style, landing-page structure) ──
  const generateEmailTemplate = async () => {
    if (!selectedCampaign) return;
    setGeneratingTpl(true);
    try {
      const campaignName = F(selectedCampaign,'Name') || '';
      const campaignType = F(selectedCampaign,'Type') || '';
      const template     = F(selectedCampaign,'Message Template') || '';
      const context      = F(selectedCampaign,'Context') || '';
      const aiSummary    = F(selectedCampaign,'AI Summary') || '';
      const assetUrl     = F(selectedCampaign,'Asset URL') || '';
      const senderName   = COMPANY_PROFILE.senderName || 'Ale';
      const senderCo     = COMPANY_PROFILE.companyName || 'Oike';
      const senderEmail  = CURRENT_USER?.email || '';
      const companyServices = COMPANY_PROFILE.services || '';
      const companyDesc  = COMPANY_PROFILE.description || COMPANY_PROFILE.companyDescription || '';

      // Aggregate pain intel from assigned contacts (across industries)
      const allContacts = detailContacts.slice(0, 30);
      const pains = allContacts.map(s => F(s,'Pain Points (Generated)') || F(s,'Pain points') || '').filter(Boolean);
      const roles = [...new Set(allContacts.map(s => F(s,'Role') || '').filter(Boolean))].slice(0, 8);
      const industries = [...new Set(allContacts.map(s => { const a = accounts.find(ac => linkedIds(s,'Account').includes(ac.id)); return a ? F(a,'Industry') : ''; }).filter(Boolean))];
      const painSummary = pains.slice(0, 10).join('\n- ').slice(0, 1200);
      const industrySummary = industries.slice(0, 6).join(', ') || 'various industries';

      // Step 1: generate content sections
      const sectionsPrompt = `You are a B2B industry analyst writing a substantive thought leadership email — NOT a salesperson. Your goal is to deliver real value: specific insights, data points, and observations that make the reader think "this person understands my world." Never pitch, never sell, never say "our solution" or "we offer". Write like a trusted advisor sharing what they're seeing across the industry.

Return a JSON object with these exact keys (all strings):
{
  "hook": "2-3 sentences. A sharp, specific observation about what's happening in the target industry RIGHT NOW. Reference real dynamics, tensions, or shifts. Surprising and credible — not generic.",
  "painHeading": "4-6 word heading naming the core tension as an observation. E.g. 'Why alignment breaks down at scale' or 'The gap between strategy and execution'",
  "pain": "3-4 sentences. Describe the challenge in depth — the WHY behind it, the systemic reasons it happens, the cost of ignoring it. Analytical and empathetic, not blaming.",
  "valueHeading": "4-6 word heading for the insight/shift section. E.g. 'What leading teams are doing differently' or 'The move that changes the dynamic'",
  "value": "3-4 sentences. Share specific, concrete approaches that work — what high-performing teams do differently, what patterns lead to better outcomes. Can reference ${senderCo}'s perspective naturally but NOT as a pitch.",
  "bullets": ["Specific, actionable insight or data point — concrete, under 18 words", "insight 2", "insight 3", "insight 4", "insight 5"],
  "socialProof": "1-2 sentences. A concrete, actionable tip the reader can apply immediately — something specific they can do this week to address the challenge described. Not a quote, not social proof. A real recommendation."
}

LANGUAGE: Write ALL content in ${tplLanguage === 'es' ? 'Spanish (Latin American)' : tplLanguage === 'pt' ? 'Brazilian Portuguese' : 'English'}.
CAMPAIGN: "${campaignName}" (${campaignType})
SENDER: ${senderName} — ${senderCo}${companyServices ? ` (${companyServices})` : ''}${companyDesc ? `\nCOMPANY CONTEXT: ${companyDesc.slice(0,400)}` : ''}
TARGET INDUSTRIES: ${industrySummary}
TARGET ROLES: ${roles.join(', ') || 'various'}
PAIN INTEL from ${pains.length} contacts:\n- ${painSummary}
${context ? `\nCAMPAIGN CONTEXT (use this heavily):\n${context.slice(0,1500)}\n` : ''}${aiSummary ? `\nSTRATEGIC BRIEF (use this heavily):\n${aiSummary.slice(0,1200)}\n` : ''}${template ? `\nMESSAGING ANGLE:\n${template.slice(0,600)}\n` : ''}

Be specific. Use the campaign context and strategic brief as the primary source of content. Return ONLY the JSON. No markdown fences.`;

      const sectionsRaw = await callOpenAI({ prompt: sectionsPrompt, temperature: 0.5, max_tokens: 1600 });
      let sections = {};
      try { sections = JSON.parse(sectionsRaw.replace(/^```json\n?|```$/g,'')); } catch { sections = {}; }

      const langClosing = tplLanguage === 'es'
        ? { line1: 'Si algo de esto resuena con lo que está trabajando {{first_name}}, o querés profundizar en algún punto, respondé este mail y lo charlamos.', line2: 'Con gusto comparto más contexto o datos específicos para tu industria.', reply: 'Responder →', cal: '📅 Agendemos 15 min' }
        : tplLanguage === 'pt'
        ? { line1: 'Se algo aqui ressoa com o que {{first_name}} está trabalhando, ou quiser aprofundar algum ponto, responda este e-mail e conversamos.', line2: 'Fico feliz em compartilhar mais contexto ou dados específicos para o seu setor.', reply: 'Responder →', cal: '📅 Agendar 15 min' }
        : { line1: 'If any of this resonates with what {{first_name}} is working on, or you\'d like to dig deeper into any of these points, just reply to this email.', line2: 'Happy to share more context or data specific to your industry.', reply: 'Reply →', cal: '📅 Book 15 min' };

      const S = {
        subtitle: '{{company}}',
        hook: sections.hook || '',
        painHeading: sections.painHeading || (tplLanguage === 'es' ? 'El desafío más común' : tplLanguage === 'pt' ? 'O desafio mais comum' : 'The challenge most teams face'),
        pain: sections.pain || '',
        valueHeading: sections.valueHeading || (tplLanguage === 'es' ? 'Lo que está funcionando en 2025' : tplLanguage === 'pt' ? 'O que está funcionando em 2025' : 'What\'s working in 2025'),
        value: sections.value || '',
        bullets: Array.isArray(sections.bullets) ? sections.bullets.filter(Boolean) : [],
        socialProof: sections.socialProof || '',
        closingLine1: langClosing.line1,
        closingLine2: langClosing.line2,
        replyBtn: langClosing.reply,
        calBtn: langClosing.cal,
      };

      // Step 2: render HTML via shared function
      const html = renderCampaignEmail(S, selectedCampaign, tplLanguage);
      setEmailTplContent(S);
      setEmailTplHtml(html);
      setEmailTplDirty(true);
      setPreviewTpl(true);
    } catch(e) {
      window.__oikeToast('Failed to generate template: ' + e.message, 'error');
    }
    setGeneratingTpl(false);
  };

  const saveEmailTemplate = async () => {
    if (!selectedCampaign) return;
    setSavingTpl(true);
    try {
      const a = api || new AirtableAPI();
      // Strip base64-encoded images before saving (they can exceed Airtable's 100k char limit)
      const htmlToSave = emailTplHtml.replace(/src="data:[^"]{100,}"/g, 'src=""');
      await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, { 'Email HTML Template': htmlToSave });
      if (onUpdateRecord) onUpdateRecord('campaigns', selectedCampaign.id, { 'Email HTML Template': htmlToSave });
      setEmailTplDirty(false);
    } catch(e) { window.__oikeToast('Failed to save template: ' + e.message, 'error'); }
    setSavingTpl(false);
  };

  // Generate a personalized opener (1-2 sentences) for a contact using the HTML template flow
  const generateContactOpener = async (s) => {
    const sName = `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim();
    const firstName = F(s,'Name') || sName;
    const role = F(s,'Role') || '';
    const pain = (F(s,'Pain Points (Generated)') || F(s,'Pain points') || '').slice(0,250);
    const linkedinNews = (F(s,'LinkedIn News (Generated)') || F(s,'Linkedin lates news') || '').slice(0,150);
    const accId = linkedIds(s,'Account')[0];
    const acc = accounts.find(a => a.id === accId);
    const accName = acc ? F(acc,'Account Name') : '';
    const industry = acc ? F(acc,'Industry') : '';
    const accNews = acc ? (F(acc,'Recent News')||'').slice(0,120) : '';
    const campaignName = F(selectedCampaign,'Name') || '';
    const aiSummary = (F(selectedCampaign,'AI Summary') || '').slice(0,300);
    const context = (F(selectedCampaign,'Context') || '').slice(0,300);

    const langLabel = tplLanguage === 'es' ? 'Spanish (Latin American)' : tplLanguage === 'pt' ? 'Brazilian Portuguese' : 'English';
    const prompt = `Write 1-2 sentences in ${langLabel} that open a B2B email to ${firstName} at ${accName || 'their company'}. The sentence must:
- Reference something specific about them or their company (use pain, LinkedIn news, or company news if available)
- Connect naturally to the campaign angle below
- Sound like a human wrote it, not a template
- Be under 40 words total
- NOT start with "I", "We", "Hope", or "Following up"

CONTACT: ${firstName} | ${role} | ${accName}${industry ? ` (${industry})` : ''}
${pain ? `Pain: ${pain}` : ''}${linkedinNews ? `\nLinkedIn: ${linkedinNews}` : ''}${accNews ? `\nNews: ${accNews}` : ''}
CAMPAIGN ANGLE: ${aiSummary || context || campaignName}

Return ONLY the 1-2 sentences in ${langLabel}. No greeting, no subject line.`;

    const opener = await callOpenAI({ prompt, temperature: 0.8, max_tokens: 80 });
    return opener.trim();
  };

  // Execute bulk send using HTML template — generates opener per contact and substitutes tokens
  const executeBulkSendHtml = async () => {
    if (!emailTplHtml) return;
    setBulkSending(true);
    setBulkResult(null);
    let sent = 0, errors = 0;
    const contacts = pendingEmailContacts.filter(s => !!F(s,'Email'));

    for (let i = 0; i < contacts.length; i++) {
      const s = contacts[i];
      const email = F(s,'Email');
      const firstName = F(s,'Name') || 'there';
      const accId = linkedIds(s,'Account')[0];
      const acc = accId ? accounts.find(a => a.id === accId) : null;
      const companyName = acc ? F(acc,'Account Name') : '';

      setBulkMsgs(prev => ({ ...prev, [s.id]: { msg: '', status: 'sending', error: '' } }));
      try {
        const opener = await generateContactOpener(s);
        // Substitute tokens
        const personalizedHtml = emailTplHtml
          .replace(/\{\{first_name\}\}/g, firstName)
          .replace(/\{\{company\}\}/g, companyName)
          .replace(/\{\{ai_opener\}\}/g, opener);

        // Subject: use custom subject if set, otherwise fall back to campaign name
        const subject = emailTplSubject.trim()
          ? emailTplSubject.replace(/\{\{first_name\}\}/g, firstName).replace(/\{\{company\}\}/g, companyName)
          : `${F(selectedCampaign,'Name')||'Hello'} — for ${firstName} at ${companyName || 'your team'}`;

        const res = await fetch('/api/gmail/send', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: email, subject, message: opener, bodyHtml: personalizedHtml,
            stakeholderId: s.id, accountIds: linkedIds(s,'Account'),
            baseId: AIRTABLE_BASE_ID, outreachTableId: TABLE_IDS.outreach,
            draft: bulkDraftMode,
          }),
        });

        if (res.ok) {
          setBulkMsgs(prev => ({ ...prev, [s.id]: { msg: opener, status: bulkDraftMode ? 'draft' : 'sent', error: '' } }));
          const a = api || new AirtableAPI();
          const today = new Date().toISOString().split('T')[0];
          const activityFields = {
            'Channel': 'Email',
            'Status': bulkDraftMode ? 'Draft' : 'Sent',
            'Activity Name': `Email — ${new Date().toLocaleDateString('en-US')}`,
            'Message': opener,
            'Stakeholder': [s.id],
            'Date': today,
            'Logged By': CURRENT_USER?.name || '',
          };
          const accIds = linkedIds(s, 'Account');
          if (accIds.length) activityFields['Account'] = accIds;
          if (selectedCampaign?.id) activityFields['Campaign'] = [selectedCampaign.id];
          // Create outreach record directly from frontend (reliable, same path as manual log)
          a.createRecord(TABLE_IDS.outreach, activityFields)
            .then(rec => { if (onAddRecord && rec?.id) onAddRecord('outreach', activityFields, rec.id); })
            .catch(e => console.error('[bulk-send] outreach log failed:', e));
          // Also optimistically update local state for immediate display
          if (onAddRecord) onAddRecord('outreach', activityFields);
          // Update campaign reached count
          const currentReached = linkedIds(selectedCampaign,'Stakeholders Reached');
          const currentAssigned = linkedIds(selectedCampaign,'Assigned Stakeholders');
          await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, {
            'Stakeholders Reached': [...new Set([...currentReached, s.id])],
            'Assigned Stakeholders': [...new Set([...currentAssigned, s.id])],
          }).catch(() => {});
          sent++;
        } else {
          const err = await res.json().catch(() => ({}));
          setBulkMsgs(prev => ({ ...prev, [s.id]: { msg: '', status: 'error', error: err.error || 'Send failed' } }));
          errors++;
        }
      } catch(e) {
        setBulkMsgs(prev => ({ ...prev, [s.id]: { msg: '', status: 'error', error: e.message || 'Failed' } }));
        errors++;
      }
      if (i < contacts.length - 1) await new Promise(r => setTimeout(r, 1500));
    }
    setBulkSending(false);
    setBulkResult({ sent, errors });
    if (onLogActivity) onLogActivity();
  };

  // Available contacts to add (not yet assigned, filtered by search)
  const availableToAdd = useMemo(() => {
    if (!selectedCampaign || !showAddContacts) return [];
    const assigned = new Set(assignedIds);
    const q = addContactsSearch.toLowerCase().trim();
    let pool = stakeholders.filter(s => !assigned.has(s.id));
    if (q) {
      pool = pool.filter(s => {
        const full = `${F(s,'Name')||''} ${F(s,'Last name')||''} ${F(s,'Role')||''}`.toLowerCase();
        const accId = linkedIds(s,'Account')[0];
        const acc = accId ? accounts.find(a => a.id === accId) : null;
        const accName = acc ? (F(acc,'Account Name')||'').toLowerCase() : '';
        return full.includes(q) || accName.includes(q);
      });
    }
    return pool.slice(0, 50); // cap to avoid huge lists
  }, [selectedCampaign, showAddContacts, addContactsSearch, assignedIds, stakeholders, accounts]);

  // ── Form helpers ──
  const openCreate = () => {
    setEditingCampaign(null);
    setForm({ name:'', type:'White Paper', status:'Draft', messageTemplate:'', assetUrl:'', startDate:'', goal:'', context:'', assignedIds: [] });
    setShowForm(true);
  };

  const openEdit = (c) => {
    setEditingCampaign(c);
    setForm({
      name: F(c,'Name') || '',
      type: F(c,'Type') || 'White Paper',
      status: F(c,'Status') || 'Draft',
      messageTemplate: F(c,'Message Template') || '',
      assetUrl: F(c,'Asset URL') || '',
      startDate: c.fields?.['Start Date'] || '',
      goal: c.fields?.['Goal'] ? String(c.fields['Goal']) : '',
      context: F(c,'Context') || '',
      assignedIds: linkedIds(c, 'Assigned Stakeholders'),
    });
    setShowForm(true);
  };

  const saveCampaign = async () => {
    if (!form.name.trim()) { window.__oikeToast('Campaign name is required', 'warning'); return; }
    setSaving(true);
    try {
      const fields = {
        'Name': form.name.trim(),
        'Type': form.type,
        'Status': form.status,
        'Message Template': form.messageTemplate,
        ...(form.assetUrl ? { 'Asset URL': form.assetUrl } : {}),
        ...(form.startDate ? { 'Start Date': form.startDate } : {}),
        ...(form.goal ? { 'Goal': parseInt(form.goal) || 0 } : {}),
        ...(form.context ? { 'Context': form.context } : {}),
        ...(form.assignedIds && form.assignedIds.length > 0 ? { 'Assigned Stakeholders': form.assignedIds } : {}),
      };
      if (editingCampaign) {
        await api.updateRecord(TABLE_IDS.campaigns, editingCampaign.id, fields);
        if (onUpdateRecord) onUpdateRecord('campaigns', editingCampaign.id, fields);
      } else {
        const created = await api.createRecord(TABLE_IDS.campaigns, fields);
        if (onAddRecord) onAddRecord('campaigns', created?.fields || fields, created?.id);
        // After creating, navigate directly to the new campaign's detail view
        if (created?.id) setSelectedId(created.id);
      }
      setShowForm(false);
      if (onLogActivity) onLogActivity();
    } catch(e) {
      window.__oikeToast('Error saving campaign: ' + e.message, 'error');
    }
    setSaving(false);
  };

  // ── Generate message ──
  const generateMsg = async (s) => {
    setInvitePreview({ id: s.id, msg: '', generating: true });
    const sName = `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim();
    const role = F(s,'Role') || '';
    const influence = F(s,'Level of Influence') || '';
    const pain = (F(s,'Pain Points (Generated)') || F(s,'Pain points') || '').slice(0,300);
    const linkedinNews = (F(s,'LinkedIn News (Generated)') || F(s,'Linkedin lates news') || '').slice(0,200);
    const accId = linkedIds(s,'Account')[0];
    const acc = accounts.find(a => a.id === accId);
    const accName = acc ? F(acc,'Account Name') : '';
    const industry = acc ? F(acc,'Industry') : '';
    const accNews = acc ? (F(acc,'Recent News')||'').slice(0,150) : '';
    const sOut = outreach
      .filter(o => linkedIds(o,'Stakeholder').includes(s.id))
      .sort((a,b) => new Date(b.fields?.['Date']||0) - new Date(a.fields?.['Date']||0))
      .slice(0,3)
      .map(o => `[${F(o,'Channel')||'?'} · ${o.fields?.['Date'] ? new Date(o.fields['Date']).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '?'}] ${(F(o,'Message')||'').slice(0,120)}`)
      .join('\n');
    const campaignName = F(selectedCampaign,'Name') || '';
    const campaignType = F(selectedCampaign,'Type') || '';
    const template = F(selectedCampaign,'Message Template') || '';
    const assetUrl = F(selectedCampaign,'Asset URL') || '';
    const campaignContext = F(selectedCampaign,'Context') || '';
    const campaignAiSummary = F(selectedCampaign,'AI Summary') || '';

    const prompt = `B2B sales rep running a ${campaignType} campaign. Write ONE short personalized message. Max 3 sentences + subject if email.

CONTACT: ${sName} | ${role}${influence ? ` (${influence})` : ''} | ${accName}${industry ? ` — ${industry}` : ''}
${pain ? `Pain: ${pain}` : ''}${linkedinNews ? `\nLinkedIn: ${linkedinNews}` : ''}${accNews ? `\nCompany news: ${accNews}` : ''}
History: ${sOut || 'First contact'}

CAMPAIGN: "${campaignName}" (${campaignType})
${campaignContext ? `\nCAMPAIGN CONTEXT (author-written — treat as strategic ground truth):\n${campaignContext.slice(0, 800)}\n` : ''}
${campaignAiSummary ? `\nCAMPAIGN STRATEGIC BRIEF (AI-generated from context):\n${campaignAiSummary.slice(0, 800)}\n` : ''}
${template ? `\nReference angle (personalize — DO NOT copy verbatim, rewrite for this specific person):\n"${template.slice(0,400)}"` : ''}
${assetUrl ? `Asset/resource to reference: ${assetUrl}` : ''}

MISSION: Connect this ${campaignType} campaign to ${sName}'s specific context at ${accName}. Align the message with the CAMPAIGN CONTEXT and STRATEGIC BRIEF above — those define the angle, pain, and outcome. Be direct, specific, and relevant to their role.
BANNED: "following up"/"checking in"/"hope this finds you"/"touching base"/brackets/placeholders.
Sender: ${COMPANY_PROFILE.senderName||'Ale'}, ${COMPANY_PROFILE.companyName||'Oike'}
If email: line 1 = "Subject: [subject]", blank line, body. Output ONLY the message.`;

    try {
      const msg = await callOpenAI({ prompt, temperature: 0.75, max_tokens: 250 });
      setInvitePreview({ id: s.id, msg: msg.trim(), generating: false });
    } catch(e) {
      console.error('Campaign generateMsg failed:', e);
      const fallback = `Hi ${sName}, I wanted to share something that might be relevant to your work at ${accName}${industry ? ` in the ${industry} space` : ''}. ${template ? template.slice(0,120) + '...' : 'Would love to connect and share more.'} Can we set up a quick call?`;
      setInvitePreview({ id: s.id, msg: fallback, generating: false });
    }
  };

  // ── Send message ──
  const sendMsg = (_s, channel) => {
    if (!invitePreview?.msg) return;
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
      else { subject = `${F(selectedCampaign,'Name')||'Campaign'} — ${F(s,'Name')||''}`; }
    }
    // Open channel synchronously (before any await)
    if (channel==='WhatsApp'&&phone) window.open(`https://wa.me/${String(phone).replace(/[^0-9+]/g,'')}?text=${encodeURIComponent(msg)}`,'_blank');
    else if (channel==='Email'&&email) window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,'_blank');
    else if (channel==='LinkedIn'&&linkedin) { navigator.clipboard.writeText(msg).catch(()=>{}); window.open(linkedin,'_blank'); }

    // Log outreach + update Stakeholders Reached
    const companyIds = linkedIds(s,'Account');
    const sName = `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim();
    const campaignName = F(selectedCampaign,'Name')||'';
    const a = api || new AirtableAPI();
    a.createRecord(TABLE_IDS.outreach, {
      'Activity Name': `Campaign "${campaignName}": ${sName} — ${new Date().toLocaleDateString('en-US')}`,
      'Account': companyIds, 'Stakeholder': [s.id],
      'Channel': channel, 'Date': new Date().toISOString(),
      'Status': 'Sent', 'Message': msg,
      'Notes': `Campaign: ${campaignName} (${F(selectedCampaign,'Type')||''})`,
      'Logged By': CURRENT_USER?.name || '',
    }).then(async () => {
      const currentReached = linkedIds(selectedCampaign, 'Stakeholders Reached');
      const currentAssigned = linkedIds(selectedCampaign, 'Assigned Stakeholders');
      await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, {
        'Stakeholders Reached': [...new Set([...currentReached, s.id])],
        // Also ensure the contact is in Assigned (in case they were added ad-hoc)
        'Assigned Stakeholders': [...new Set([...currentAssigned, s.id])],
      }).catch(e => console.error('Campaign reached update failed:', e));
      await activateAccountIfNeeded(a, companyIds, data.accounts);
      await updateStakeholderStatus(a, s.id, 'Contacted', data.stakeholders);
      if (onLogActivity) onLogActivity();
    }).catch(e => console.error('Campaign send log failed:', e));

    setInvitePreview(null);
  };

  const inputSt = { background:'var(--globant-darker)', border:'1px solid var(--globant-border)', borderRadius:6, color:'var(--globant-text)', padding:'8px 10px', fontSize:13, width:'100%' };

  // ── DETAIL VIEW ──
  if (selectedCampaign) {
    const reached = reachedIds.length;
    const goal = selectedCampaign.fields?.['Goal'] || 0;
    const campaignType = F(selectedCampaign,'Type') || '';
    const status = F(selectedCampaign,'Status') || '';
    const template = F(selectedCampaign,'Message Template') || '';
    const assetUrl = F(selectedCampaign,'Asset URL') || '';

    return (
      <div>
        {/* Back + header */}
        <div className="page-header" style={{ marginBottom:12 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4 }}>
            <button className="action-btn btn-ghost" style={{ fontSize:11 }} onClick={() => { setSelectedId(null); setInvitePreview(null); setFilterIndustry(''); setFilterRole(''); setFilterSearch(''); }}>← Back</button>
            <span style={{ fontSize:11, color:'var(--globant-muted)' }}>Campaigns</span>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
            <span style={{ fontSize:18 }}>{TYPE_ICONS[campaignType]||'📣'}</span>
            <h1 style={{ margin:0 }}>{F(selectedCampaign,'Name')}</h1>
            <span style={{ fontSize:11, padding:'3px 10px', borderRadius:20, background:`${STATUS_COLORS[status]||'#666'}20`, color:STATUS_COLORS[status]||'var(--globant-muted)', fontWeight:700, border:`1px solid ${STATUS_COLORS[status]||'var(--globant-border)'}40` }}>{status}</span>
            <button className="action-btn btn-ghost" style={{ fontSize:11, marginLeft:'auto' }} onClick={() => openEdit(selectedCampaign)}>✏️ Edit</button>
          </div>
          <div style={{ display:'flex', gap:16, marginTop:6, flexWrap:'wrap' }}>
            <span style={{ fontSize:12, color:'var(--globant-muted)' }}>Type: <strong style={{ color:'var(--globant-text)' }}>{campaignType}</strong></span>
            {selectedCampaign.fields?.['Start Date'] && <span style={{ fontSize:12, color:'var(--globant-muted)' }}>Start: <strong style={{ color:'var(--globant-text)' }}>{formatDate(selectedCampaign.fields['Start Date'])}</strong></span>}
            <span style={{ fontSize:12, color:'var(--globant-muted)' }}>Reached: <strong style={{ color:'#4ade80' }}>{reached}</strong>{goal>0 ? ` / ${goal} goal` : ''}</span>
            {assetUrl && <a href={assetUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize:12, color:'var(--globant-green)' }}>🔗 View Asset</a>}
          </div>
          {F(selectedCampaign, 'Last Run') && (
            <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>
              Last run: {new Date(F(selectedCampaign, 'Last Run')).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              {F(selectedCampaign, 'Last Run Result') && <span style={{ marginLeft: 8, color: 'var(--globant-green)' }}>· {F(selectedCampaign, 'Last Run Result')}</span>}
            </div>
          )}
        </div>

        {/* Message Template — inline editable */}
        <div className="card" style={{ marginBottom:14, borderLeft:'3px solid var(--globant-green)', padding:'10px 14px' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-green)', textTransform:'uppercase', letterSpacing:1 }}>✍️ Message Template / Reference Angle</div>
            <div style={{ display:'flex', gap:6, alignItems:'center' }}>
              {!editingTemplate ? (
                <>
                  {template.length > 200 && (
                    <button onClick={() => setTplExpanded(x=>!x)} style={{ background:'none', border:'none', color:'var(--globant-green)', cursor:'pointer', fontSize:10, padding:0, fontWeight:600 }}>
                      {tplExpanded ? '▲ Less' : '▼ More'}
                    </button>
                  )}
                  <button className="action-btn btn-ghost" style={{ fontSize:10 }}
                    onClick={() => { setTemplateDraft(template); setEditingTemplate(true); setTplExpanded(true); }}>
                    {template ? '✏️ Edit' : '➕ Add Template'}
                  </button>
                </>
              ) : (
                <>
                  <button className="action-btn btn-primary" style={{ fontSize:10 }} onClick={saveCampaignTemplate} disabled={savingTemplate}>
                    {savingTemplate ? '⏳' : '💾 Save'}
                  </button>
                  <button className="action-btn btn-ghost" style={{ fontSize:10 }} onClick={() => setEditingTemplate(false)}>Cancel</button>
                </>
              )}
            </div>
          </div>
          {editingTemplate ? (
            <textarea
              className="input-field"
              style={{ width:'100%', minHeight:120, resize:'vertical', fontFamily:'inherit', fontSize:12, lineHeight:1.6 }}
              placeholder={`Write the reference angle / message template the AI will personalize per contact.\n\nTips:\n- Opening hook or observation\n- Main pain you're addressing\n- What you're sharing and why it matters\n- Call to action`}
              value={templateDraft}
              onChange={e => setTemplateDraft(e.target.value)}
            />
          ) : template ? (
            <div style={{ fontSize:12, color:'var(--globant-text)', lineHeight:1.7, whiteSpace:'pre-wrap', overflow:'hidden', maxHeight: tplExpanded || template.length <= 200 ? 'none' : '72px', position:'relative' }}>
              {template}
              {!tplExpanded && template.length > 200 && (
                <div style={{ position:'absolute', bottom:0, left:0, right:0, height:32, background:'linear-gradient(transparent, var(--globant-card))' }} />
              )}
            </div>
          ) : (
            <div style={{ fontSize:12, color:'var(--globant-muted)', fontStyle:'italic' }}>
              No template yet — click "Add Template" to write the reference angle the AI will use to personalize each message.
            </div>
          )}
        </div>

        {/* Campaign Context + AI Summary (mirror of Events pattern) */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          {/* Context (manual input) */}
          <div className="card" style={{ borderLeft: '3px solid var(--globant-accent)', padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-accent)', textTransform: 'uppercase', letterSpacing: 1 }}>📝 Campaign Context & Files</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {!editingContext && F(selectedCampaign,'Context') && (F(selectedCampaign,'Context')||'').length > 150 && (
                  <button onClick={() => setCtxExpanded(x=>!x)} style={{ background:'none', border:'none', color:'var(--globant-accent)', cursor:'pointer', fontSize:10, padding:0, fontWeight:600 }}>
                    {ctxExpanded ? '▲' : '▼'}
                  </button>
                )}
                {!editingContext ? (
                  <button className="action-btn btn-ghost" style={{ fontSize: 10 }}
                    onClick={() => { setContextDraft(F(selectedCampaign, 'Context') || ''); setEditingContext(true); }}>
                    {F(selectedCampaign, 'Context') ? '✏️ Edit' : '➕ Add Context'}
                  </button>
                ) : (
                  <>
                    <button className="action-btn btn-primary" style={{ fontSize: 10 }} onClick={saveCampaignContext} disabled={savingContext}>
                      {savingContext ? '⏳' : '💾 Save'}
                    </button>
                    <button className="action-btn btn-ghost" style={{ fontSize: 10 }} onClick={() => setEditingContext(false)}>Cancel</button>
                  </>
                )}
                <label style={{ cursor: 'pointer' }}>
                  <input type="file" accept=".csv,.txt,.json,.md,.html,.tsv,.xml,.pdf" style={{ display: 'none' }} onChange={handleCampaignFileUpload} disabled={campaignUploadingFile} />
                  <span className="action-btn btn-ghost" style={{ fontSize: 10, padding: '3px 10px', display: 'inline-block' }}>
                    {campaignUploadingFile ? '⏳ Processing...' : '📎 Upload File'}
                  </span>
                </label>
              </div>
            </div>
            {editingContext ? (
              <textarea
                className="input-field"
                style={{ width: '100%', minHeight: 120, resize: 'vertical', fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5 }}
                placeholder={`Write context the AI should know about this campaign:\n- Goals / outcome desired\n- ICP nuances (industries, roles)\n- Pain points this asset addresses\n- Messaging angle / tone\n- Triggers or timing reasons\n- What to avoid mentioning`}
                value={contextDraft}
                onChange={e => setContextDraft(e.target.value)} />
            ) : (
              F(selectedCampaign, 'Context') ? (
                <div style={{ overflow:'hidden', maxHeight: ctxExpanded || (F(selectedCampaign,'Context')||'').length <= 150 ? 'none' : '80px', position:'relative', transition:'max-height 0.2s' }}>
                  <FileNotesRenderer
                    notes={F(selectedCampaign, 'Context')}
                    accentColor="var(--globant-accent)"
                    onUpdateNotes={async (updated) => {
                      const a = api || new AirtableAPI();
                      await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, { 'Context': updated });
                      if (onUpdateRecord) onUpdateRecord('campaigns', selectedCampaign.id, { 'Context': updated });
                      if (onLogActivity) onLogActivity();
                    }}
                  />
                  {!ctxExpanded && (F(selectedCampaign,'Context')||'').length > 150 && (
                    <div style={{ position:'absolute', bottom:0, left:0, right:0, height:32, background:'linear-gradient(transparent, var(--globant-card))' }} />
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>
                  No context yet — click "Add Context" to write manually, or "Upload File" to let AI extract key points from a PDF / doc.
                </div>
              )
            )}
          </div>

          {/* AI Summary */}
          <div className="card" style={{ borderLeft: '3px solid var(--globant-green)', padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-green)', textTransform: 'uppercase', letterSpacing: 1 }}>🧠 AI Summary</div>
              <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                {F(selectedCampaign,'AI Summary') && (F(selectedCampaign,'AI Summary')||'').length > 150 && (
                  <button onClick={() => setSumExpanded(x=>!x)} style={{ background:'none', border:'none', color:'var(--globant-green)', cursor:'pointer', fontSize:10, padding:0, fontWeight:600 }}>
                    {sumExpanded ? '▲' : '▼'}
                  </button>
                )}
                <button className="action-btn btn-primary" style={{ fontSize: 10 }}
                  onClick={generateCampaignSummary} disabled={generatingSummary}>
                  {generatingSummary ? '⏳ Generating...' : F(selectedCampaign, 'AI Summary') ? '🔄 Regenerate' : '✨ Generate Summary'}
                </button>
              </div>
            </div>
            {F(selectedCampaign, 'AI Summary') ? (
              <div style={{ overflow:'hidden', maxHeight: sumExpanded || (F(selectedCampaign,'AI Summary')||'').length <= 150 ? 'none' : '80px', position:'relative', transition:'max-height 0.2s' }}>
              <div style={{ fontSize: 12, color: 'var(--globant-text)', lineHeight: 1.6 }}>
                {(() => {
                  const summaryText = F(selectedCampaign, 'AI Summary');
                  const lines = summaryText.split('\n').filter(l => l.trim());
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
                    if (line.startsWith('### ')) return <h4 key={i} style={{ margin: '8px 0 4px', fontSize: 12, fontWeight: 700, color: 'var(--globant-green)' }}>{parseInline(line.replace('### ', '').replace(/\*\*/g, ''))}</h4>;
                    if (line.startsWith('- ') || line.startsWith('* ')) return <div key={i} style={{ paddingLeft: 12, marginBottom: 3, position: 'relative' }}><span style={{ position: 'absolute', left: 0 }}>•</span>{parseInline(line.slice(2))}</div>;
                    return <p key={i} style={{ margin: '3px 0' }}>{parseInline(line)}</p>;
                  });
                })()}
              </div>
              {!sumExpanded && (F(selectedCampaign,'AI Summary')||'').length > 150 && (
                <div style={{ position:'absolute', bottom:0, left:0, right:0, height:32, background:'linear-gradient(transparent, var(--globant-card))' }} />
              )}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>
                {F(selectedCampaign, 'Context') ? 'Click "Generate Summary" to have AI create a strategic brief that will anchor all messages from this campaign.' : 'Add context first, then generate the AI summary.'}
              </div>
            )}
          </div>
        </div>

        {/* Email HTML Template */}
        <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid #60a5fa', padding: '12px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: 1 }}>📧 Email HTML Template</div>
            <button className="action-btn btn-ghost" style={{ fontSize: 10 }} onClick={() => setShowEmailTpl(!showEmailTpl)}>
              {showEmailTpl ? '▲ Collapse' : (emailTplHtml ? '▼ Template saved' : '▼ Build template')}
            </button>
          </div>
          {showEmailTpl && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <select value={tplLanguage} onChange={e => {
                  const lang = e.target.value;
                  setTplLanguage(lang);
                  if (emailTplContent && selectedCampaign) {
                    setEmailTplHtml(renderCampaignEmail(emailTplContent, selectedCampaign, lang));
                    setEmailTplDirty(true);
                  }
                }} style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.07)', color: '#e5e7eb', cursor: 'pointer' }}>
                  <option value="en">🇬🇧 English</option>
                  <option value="es">🇦🇷 Español</option>
                  <option value="pt">🇧🇷 Português</option>
                </select>
                <button className="action-btn btn-primary" style={{ fontSize: 11 }}
                  onClick={generateEmailTemplate} disabled={generatingTpl || bulkSending}>
                  {generatingTpl ? '⏳ Generating...' : emailTplHtml ? '🔄 Regenerate' : '✨ Generate Template'}
                </button>
                {emailTplHtml && (
                  <button className="action-btn btn-ghost" style={{ fontSize: 11 }}
                    onClick={() => setPreviewTpl(!previewTpl)}>
                    {previewTpl ? '✏️ Edit' : '👁️ Preview'}
                  </button>
                )}
                {emailTplDirty && (
                  <button className="action-btn" style={{ fontSize: 11, background: 'rgba(96,165,250,0.15)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.3)' }}
                    onClick={saveEmailTemplate} disabled={savingTpl}>
                    {savingTpl ? '⏳ Saving...' : '💾 Save'}
                  </button>
                )}
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 0.8, display: 'block', marginBottom: 4 }}>
                  Subject line <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— supports <code style={{ fontSize: 10 }}>{'{{first_name}}'}</code> and <code style={{ fontSize: 10 }}>{'{{company}}'}</code></span>
                </label>
                <input
                  className="input-field"
                  style={{ width: '100%', fontSize: 12, padding: '6px 10px' }}
                  placeholder={`${F(selectedCampaign,'Name')||'Campaign'} — for {{first_name}} at {{company}}`}
                  value={emailTplSubject}
                  onChange={e => setEmailTplSubject(e.target.value)}
                />
              </div>

              {emailTplHtml && (
                previewTpl ? (
                  <div style={{ border: '1px solid var(--globant-border)', borderRadius: 6, overflow: 'hidden', background: '#fff' }}>
                    <div style={{ padding: '6px 10px', background: 'var(--globant-darker)', borderBottom: '1px solid var(--globant-border)', fontSize: 10, color: 'var(--globant-muted)' }}>
                      Preview — tokens filled per contact on send
                    </div>
                    <iframe
                      srcDoc={emailTplHtml}
                      style={{ width: '100%', height: 480, border: 'none', display: 'block' }}
                      sandbox="allow-same-origin"
                      title="Email preview"
                    />
                  </div>
                ) : (() => {
                  const C = emailTplContent || {};
                  const updateContent = (key, val) => {
                    const updated = { ...C, [key]: val };
                    setEmailTplContent(updated);
                    setEmailTplHtml(renderCampaignEmail(updated, selectedCampaign, tplLanguage));
                    setEmailTplDirty(true);
                  };
                  const updateBullet = (i, val) => {
                    const bullets = [...(C.bullets || [])];
                    bullets[i] = val;
                    updateContent('bullets', bullets);
                  };
                  const addBullet = () => updateContent('bullets', [...(C.bullets || []), '']);
                  const removeBullet = (i) => {
                    const bullets = (C.bullets || []).filter((_,idx) => idx !== i);
                    updateContent('bullets', bullets);
                  };
                  const fieldStyle = { width: '100%', marginBottom: 10, boxSizing: 'border-box' };
                  const labelStyle = { fontSize: 10, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 3, display: 'block' };
                  return (
                    <div style={{ background: 'var(--globant-darker)', borderRadius: 8, padding: '14px 14px 6px', border: '1px solid var(--globant-border)' }}>
                      <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginBottom: 12, lineHeight: 1.5 }}>
                        ✏️ Edit the content below — the email updates automatically. Tokens <code style={{ color: '#60a5fa' }}>{'{{first_name}}'}</code> · <code style={{ color: '#60a5fa' }}>{'{{company}}'}</code> · <code style={{ color: '#60a5fa' }}>{'{{ai_opener}}'}</code> are filled per contact on send.
                      </div>

                      <label style={labelStyle}>Header subtitle</label>
                      <select className="input-field" style={{ ...fieldStyle, fontSize: 12 }}
                        value={C.subtitle ?? '{{company}}'}
                        onChange={e => updateContent('subtitle', e.target.value)}>
                        <option value="{{company}}">Company name — {'{{company}}'}</option>
                        <option value="{{first_name}}">First name — {'{{first_name}}'}</option>
                        <option value="{{first_name}} at {{company}}">Name at Company — {'{{first_name}} at {{company}}'}</option>
                        <option value="Prepared for {{first_name}}">Prepared for {'{{first_name}}'}</option>
                        <option value="">No subtitle</option>
                      </select>

                      <label style={labelStyle}>Opening hook (1-2 sentences)</label>
                      <textarea className="input-field" style={{ ...fieldStyle, minHeight: 56, resize: 'vertical', fontSize: 12 }}
                        value={C.hook || ''} onChange={e => updateContent('hook', e.target.value)} />

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                        <div>
                          <label style={labelStyle}>Pain section heading</label>
                          <input className="input-field" style={{ width: '100%', fontSize: 12 }}
                            value={C.painHeading || ''} onChange={e => updateContent('painHeading', e.target.value)} />
                        </div>
                        <div>
                          <label style={labelStyle}>Value section heading</label>
                          <input className="input-field" style={{ width: '100%', fontSize: 12 }}
                            value={C.valueHeading || ''} onChange={e => updateContent('valueHeading', e.target.value)} />
                        </div>
                      </div>

                      <label style={labelStyle}>Pain paragraph</label>
                      <textarea className="input-field" style={{ ...fieldStyle, minHeight: 60, resize: 'vertical', fontSize: 12 }}
                        value={C.pain || ''} onChange={e => updateContent('pain', e.target.value)} />

                      <label style={labelStyle}>Value paragraph</label>
                      <textarea className="input-field" style={{ ...fieldStyle, minHeight: 60, resize: 'vertical', fontSize: 12 }}
                        value={C.value || ''} onChange={e => updateContent('value', e.target.value)} />

                      <label style={labelStyle}>Numbered bullets</label>
                      {(C.bullets || []).map((b, i) => (
                        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                          <div style={{ minWidth: 22, height: 22, background: 'rgba(91,191,181,0.2)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: '#5bbfb5', marginTop: 6 }}>{i+1}</div>
                          <input className="input-field" style={{ flex: 1, fontSize: 12 }}
                            value={b} onChange={e => updateBullet(i, e.target.value)} />
                          <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '2px 8px', color: '#ef4444' }} onClick={() => removeBullet(i)}>✕</button>
                        </div>
                      ))}
                      <button className="action-btn btn-ghost" style={{ fontSize: 10, marginBottom: 10 }} onClick={addBullet}>+ Add bullet</button>

                      <label style={labelStyle}>💡 Actionable tip (optional)</label>
                      <textarea className="input-field" style={{ ...fieldStyle, minHeight: 60, resize: 'vertical', fontSize: 12 }}
                        placeholder="A concrete action or recommendation the reader can apply right now..."
                        value={C.socialProof || ''} onChange={e => updateContent('socialProof', e.target.value)} />

                      <div style={{ borderTop: '1px solid var(--globant-border)', margin: '10px 0 12px', paddingTop: 12 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Closing section</div>
                        <label style={labelStyle}>Line 1</label>
                        <textarea className="input-field" style={{ ...fieldStyle, minHeight: 52, resize: 'vertical', fontSize: 12 }}
                          value={C.closingLine1 || ''} onChange={e => updateContent('closingLine1', e.target.value)} />
                        <label style={labelStyle}>Line 2</label>
                        <input className="input-field" style={{ ...fieldStyle, fontSize: 12 }}
                          value={C.closingLine2 || ''} onChange={e => updateContent('closingLine2', e.target.value)} />
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                          <div>
                            <label style={labelStyle}>Reply button</label>
                            <input className="input-field" style={{ width: '100%', fontSize: 12 }}
                              value={C.replyBtn || ''} onChange={e => updateContent('replyBtn', e.target.value)} />
                          </div>
                          <div>
                            <label style={labelStyle}>Calendar button</label>
                            <input className="input-field" style={{ width: '100%', fontSize: 12 }}
                              value={C.calBtn || ''} onChange={e => updateContent('calBtn', e.target.value)} />
                          </div>
                        </div>
                      </div>

                      <label style={labelStyle}>Evento (opcional)</label>
                      <select className="input-field" style={{ ...fieldStyle, fontSize: 12 }}
                        value={C.eventId || ''}
                        onChange={e => updateContent('eventId', e.target.value || null)}>
                        <option value="">— Sin evento —</option>
                        {(events || []).sort((a,b) => (b.fields?.['Starting']||'').localeCompare(a.fields?.['Starting']||'')).map(ev => {
                          const evD = ev.fields?.['Starting'] ? new Date(ev.fields['Starting']).toLocaleDateString('es-AR', { day:'numeric', month:'short' }) : '';
                          return <option key={ev.id} value={ev.id}>{F(ev,'Event Name')}{evD ? ` (${evD})` : ''}</option>;
                        })}
                      </select>
                      {C.eventId && (
                        <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: -6, marginBottom: 10 }}>
                          Aparece como bloque de invitación antes del CTA.
                        </div>
                      )}
                    </div>
                  );
                })()
              )}
            </div>
          )}
        </div>


        {/* Sequence */}
        {(() => {
          const enrollments = parseSeqEnrollments(selectedCampaign);
          const enrolledIds = Object.keys(enrollments);
          const now = new Date();
          const isDue = (en) => {
            if (en.status !== 'active') return false;
            const dt = en.nextDateTime ? new Date(en.nextDateTime) : (en.nextDate ? new Date(en.nextDate) : null);
            return dt && dt <= now;
          };
          const getNextDate = (en) => { const dt = en.nextDateTime || en.nextDate; return dt ? new Date(dt) : new Date(9999,0); };
          const groupDue = enrolledIds.filter(id => isDue(enrollments[id]));
          const groupScheduled = enrolledIds.filter(id => enrollments[id].status === 'active' && !isDue(enrollments[id])).sort((a,b) => getNextDate(enrollments[a]) - getNextDate(enrollments[b]));
          const groupFinished = enrolledIds.filter(id => ['completed','replied'].includes(enrollments[id].status));
          const activeCount = enrolledIds.filter(id => enrollments[id].status === 'active').length;
          const repliedCount = enrolledIds.filter(id => enrollments[id].status === 'replied').length;
          const completedCount = enrolledIds.filter(id => enrollments[id].status === 'completed').length;
          const pctDone = enrolledIds.length > 0 ? Math.round((completedCount + repliedCount) / enrolledIds.length * 100) : 0;
          const getDueLabel = (en) => {
            const nextDT = en.nextDateTime || en.nextDate;
            if (!nextDT) return null;
            const diffMs = new Date(nextDT) - new Date();
            const diffD = Math.ceil(diffMs / (1000*60*60*24));
            if (diffMs <= 0) return { label: 'Due now', color: '#ef4444' };
            if (diffD <= 1) return { label: 'Tomorrow', color: '#fbbf24' };
            if (diffD <= 3) return { label: `In ${diffD}d`, color: '#fb923c' };
            const d = new Date(nextDT);
            return { label: d.toLocaleDateString('en', { month:'short', day:'numeric' }), color: 'var(--globant-muted)' };
          };
          const pendingToEnroll = pendingEmailContacts.filter(s => !enrollments[s.id] || enrollments[s.id].status === 'completed');
          const isActive = seqConfig.active !== false;
          const STATUS_C = { active: '#60a5fa', completed: 'var(--globant-muted)', replied: '#4ade80', paused: '#a78bfa' };

          const renderContactRow = (stkId, showDivider) => {
            const en = enrollments[stkId];
            const stk = stakeholders.find(s => s.id === stkId);
            if (!stk) return null;
            const name = `${F(stk,'Name')}${F(stk,'Last name') ? ` ${F(stk,'Last name')}` : ''}`;
            const step = en.step || 0;
            const contactIsDue = isDue(en);
            const dueInfo = en.status === 'active' ? getDueLabel(en) : null;
            let centerContent = null;
            if (en.status === 'completed') centerContent = <span style={{ color:'#4ade80', fontSize:11 }}>✅ All {seqSteps.length} steps sent</span>;
            else if (en.status === 'replied') centerContent = <span style={{ color:'#4ade80', fontSize:11 }}>💬 Replied — stopped</span>;
            else if (contactIsDue) centerContent = <span style={{ color:'#ef4444', fontSize:11, fontWeight:600 }}>🔴 Step {step+1} due now</span>;
            else centerContent = (
              <span style={{ fontSize:11 }}>
                {step > 0 && <span style={{ color:'#4ade80' }}>✅ {step} sent · </span>}
                <span style={{ color:'var(--globant-muted)' }}>Step {step+1} — </span>
                <span style={{ color: dueInfo?.color || 'var(--globant-muted)', fontWeight:600 }}>{dueInfo?.label || '—'}</span>
              </span>
            );
            const pillColor = contactIsDue ? '#ef4444' : (STATUS_C[en.status] || 'var(--globant-muted)');
            return (
              <div key={stkId} style={{ display:'flex', alignItems:'center', padding:'8px 12px', borderBottom: showDivider ? '1px solid var(--globant-border)' : 'none', gap:8 }}>
                <div style={{ minWidth:120, flexShrink:0 }}>
                  <div style={{ fontWeight:700, fontSize:12 }}>{name}</div>
                  <div style={{ fontSize:10, color:'var(--globant-muted)' }}>Step {step}/{seqSteps.length}</div>
                </div>
                <div style={{ flex:1 }}>{centerContent}</div>
                <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
                  <span style={{ fontSize:10, fontWeight:700, color:pillColor, padding:'2px 7px', borderRadius:10, background:`${pillColor}20`, border:`1px solid ${pillColor}40` }}>{en.status}</span>
                  <button onClick={() => unenrollFromSequence(stkId)} style={{ background:'none', border:'none', color:'var(--globant-muted)', cursor:'pointer', fontSize:12, padding:0 }} title="Remove">✕</button>
                </div>
              </div>
            );
          };

          return (
            <div className="card" style={{ marginBottom:14, borderLeft:`3px solid ${isActive && seqSteps.length > 0 ? '#a78bfa' : 'var(--globant-border)'}`, padding:'14px 16px' }}>
              {/* Header */}
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <span style={{ fontSize:12, fontWeight:700, color:'#a78bfa', textTransform:'uppercase', letterSpacing:0.8 }}>📨 Email Sequence</span>
                  {seqSteps.length > 0 && (
                    <span style={{ fontSize:11, fontWeight:700, padding:'2px 9px', borderRadius:20, background: isActive ? 'rgba(74,222,128,0.15)' : 'rgba(255,255,255,0.06)', color: isActive ? '#4ade80' : 'var(--globant-muted)', border:`1px solid ${isActive ? 'rgba(74,222,128,0.35)' : 'var(--globant-border)'}` }}>
                      {isActive ? '🟢 Active' : '⏸ Paused'}
                    </span>
                  )}
                  {enrolledIds.length > 0 && <span style={{ fontSize:11, color:'var(--globant-muted)' }}>{activeCount} active · {enrolledIds.length} total</span>}
                </div>
                {seqSteps.length > 0 && (
                  <button onClick={async () => {
                    const newCfg = { ...seqConfig, active: !isActive };
                    setSeqConfig(newCfg);
                    const a = api || new AirtableAPI();
                    await a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, { 'Sequence Config': JSON.stringify(newCfg) });
                    if (onUpdateRecord) onUpdateRecord('campaigns', selectedCampaign.id, { 'Sequence Config': JSON.stringify(newCfg) });
                    window.__oikeToast(!isActive ? '🟢 Sequence activated.' : '⏸ Sequence paused.', !isActive ? 'success' : 'warning');
                  }} style={{ fontSize:11, background:'none', border:'1px solid var(--globant-border)', borderRadius:6, color:'var(--globant-muted)', cursor:'pointer', padding:'3px 10px' }}>
                    {isActive ? 'Pause' : 'Activate'}
                  </button>
                )}
              </div>

              {/* Tabs */}
              <div style={{ display:'flex', borderBottom:'1px solid var(--globant-border)', marginBottom:16 }}>
                {[['steps', `📋 Steps (${seqSteps.length})`], ['contacts', `👥 Contacts (${enrolledIds.length})`]].map(([key, label]) => (
                  <button key={key} onClick={() => setSeqTab(key)} style={{ padding:'6px 16px', fontSize:12, fontWeight: seqTab===key ? 700 : 400, cursor:'pointer', background:'none', border:'none', borderBottom: seqTab===key ? '2px solid #a78bfa' : '2px solid transparent', color: seqTab===key ? '#a78bfa' : 'var(--globant-muted)', marginBottom:-1 }}>{label}</button>
                ))}
              </div>

              {/* STEPS TAB */}
              {seqTab === 'steps' && (
                <div>
                  {/* When to send */}
                  <div style={{ marginBottom:14, padding:'10px 12px', background:'rgba(167,139,250,0.05)', borderRadius:8, border:'1px solid rgba(167,139,250,0.15)' }}>
                    <div style={{ fontSize:10, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:0.5, marginBottom:8 }}>When to send</div>
                    <div style={{ display:'flex', gap:6, marginBottom: seqConfig.sendOnEnroll ? 0 : 10, flexWrap:'wrap' }}>
                      {[{ val: true, label:'⚡ Immediately on enroll' }, { val: false, label:'🕐 Scheduled' }].map(opt => {
                        const active = !!seqConfig.sendOnEnroll === opt.val;
                        return (
                          <button key={String(opt.val)} onClick={() => { setSeqConfig(p => ({...p, sendOnEnroll: opt.val})); setSeqDirty(true); }}
                            style={{ padding:'5px 14px', borderRadius:8, cursor:'pointer', fontSize:12, fontWeight: active ? 700 : 400, background: active ? 'rgba(167,139,250,0.18)' : 'rgba(0,0,0,0.1)', color: active ? '#a78bfa' : 'var(--globant-muted)', border:`1px solid ${active ? 'rgba(167,139,250,0.5)' : 'var(--globant-border)'}` }}>
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                    {!seqConfig.sendOnEnroll && (
                      <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                        <div>
                          <div style={{ fontSize:9, color:'var(--globant-muted)', marginBottom:3, fontWeight:600, textTransform:'uppercase' }}>Hour</div>
                          <select className="input-field" style={{ fontSize:12, padding:'4px 8px' }} value={seqConfig.sendHour} onChange={e => { setSeqConfig(p => ({...p, sendHour: parseInt(e.target.value)})); setSeqDirty(true); }}>
                            {Array.from({length:24}, (_,h) => <option key={h} value={h}>{String(h).padStart(2,'0')}:00</option>)}
                          </select>
                        </div>
                        <div style={{ flex:1, minWidth:180 }}>
                          <div style={{ fontSize:9, color:'var(--globant-muted)', marginBottom:3, fontWeight:600, textTransform:'uppercase' }}>Timezone</div>
                          <select className="input-field" style={{ fontSize:12, padding:'4px 8px', width:'100%' }} value={seqConfig.timezone} onChange={e => { setSeqConfig(p => ({...p, timezone: e.target.value})); setSeqDirty(true); }}>
                            {SEQ_TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
                          </select>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Send mode */}
                  <div style={{ marginBottom:14, display:'flex', gap:6, alignItems:'center' }}>
                    <span style={{ fontSize:11, color:'var(--globant-muted)', flexShrink:0 }}>Mode:</span>
                    {[{ val:'send', label:'🤖 Auto-send' }, { val:'draft', label:'📝 Save as draft' }].map(opt => {
                      const active = (seqConfig.sendMode || 'send') === opt.val;
                      return (
                        <button key={opt.val} onClick={() => { setSeqConfig(p => ({...p, sendMode: opt.val})); setSeqDirty(true); }}
                          style={{ padding:'4px 12px', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight: active ? 700 : 400, background: active ? (opt.val==='send' ? 'rgba(91,191,181,0.18)' : 'rgba(251,191,36,0.15)') : 'rgba(0,0,0,0.1)', color: active ? (opt.val==='send' ? 'var(--globant-green)' : '#fbbf24') : 'var(--globant-muted)', border:`1px solid ${active ? (opt.val==='send' ? 'rgba(91,191,181,0.4)' : 'rgba(251,191,36,0.4)') : 'var(--globant-border)'}` }}>
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>

                  {/* Message angle */}
                  <div style={{ marginBottom:14, borderRadius:6, border:'1px solid rgba(91,191,181,0.2)', overflow:'hidden' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 12px', background:'rgba(91,191,181,0.06)', cursor:'pointer' }} onClick={() => { if (!editingTemplate) setTplOpen(o => !o); }}>
                      <span style={{ fontSize:10, fontWeight:700, color:'var(--globant-green)', textTransform:'uppercase', letterSpacing:0.5 }}>
                        {tplOpen ? '▲' : '▼'} ✍️ Message Angle
                        {!tplOpen && F(selectedCampaign,'Message Template') && <span style={{ marginLeft:8, fontWeight:400, color:'var(--globant-muted)', textTransform:'none', letterSpacing:0, fontSize:11 }}>{F(selectedCampaign,'Message Template').slice(0,60).trim()}{F(selectedCampaign,'Message Template').length > 60 ? '…' : ''}</span>}
                      </span>
                      <div style={{ display:'flex', gap:6 }} onClick={e => e.stopPropagation()}>
                        {!editingTemplate ? (
                          <button className="action-btn btn-ghost" style={{ fontSize:10 }} onClick={() => { setTemplateDraft(F(selectedCampaign,'Message Template')||''); setEditingTemplate(true); setTplOpen(true); }}>{F(selectedCampaign,'Message Template') ? '✏️ Edit' : '➕ Add'}</button>
                        ) : (
                          <>
                            <button className="action-btn btn-primary" style={{ fontSize:10 }} onClick={saveCampaignTemplate} disabled={savingTemplate}>{savingTemplate ? '⏳' : '💾 Save'}</button>
                            <button className="action-btn btn-ghost" style={{ fontSize:10 }} onClick={() => setEditingTemplate(false)}>Cancel</button>
                          </>
                        )}
                      </div>
                    </div>
                    {(tplOpen || editingTemplate) && (
                      <div style={{ padding:'10px 12px' }}>
                        {editingTemplate ? (
                          <textarea className="input-field" style={{ width:'100%', minHeight:80, resize:'vertical', fontFamily:'inherit', fontSize:12, lineHeight:1.6 }} placeholder="Describe the angle and goal. AI will personalize per contact using your Settings prompts..." value={templateDraft} onChange={e => setTemplateDraft(e.target.value)} />
                        ) : F(selectedCampaign,'Message Template') ? (
                          <div style={{ fontSize:12, color:'var(--globant-text)', lineHeight:1.7, whiteSpace:'pre-wrap' }}>{F(selectedCampaign,'Message Template')}</div>
                        ) : (
                          <div style={{ fontSize:11, color:'var(--globant-muted)', fontStyle:'italic' }}>No angle yet — click "Add" to write the focus the AI will use for every step.</div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Steps */}
                  <div style={{ fontSize:10, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:0.5, marginBottom:8 }}>Steps</div>
                  {seqSteps.length === 0 && <div style={{ fontSize:12, color:'var(--globant-muted)', fontStyle:'italic', marginBottom:10 }}>No steps yet — add your first step below.</div>}
                  <div style={{ display:'flex', flexDirection:'column' }}>
                    {seqSteps.map((step, i) => {
                      const chColor = step.channel === 'Email' ? '#60a5fa' : step.channel === 'LinkedIn' ? '#6366f1' : '#4ade80';
                      const chBg = step.channel === 'Email' ? 'rgba(96,165,250,0.18)' : step.channel === 'LinkedIn' ? 'rgba(99,102,241,0.18)' : 'rgba(74,222,128,0.18)';
                      const chIcon = step.channel === 'Email' ? '✉️' : step.channel === 'LinkedIn' ? '🔗' : '💬';
                      return (
                        <div key={i} style={{ display:'flex', gap:0 }}>
                          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', width:36, flexShrink:0 }}>
                            <div style={{ width:28, height:28, borderRadius:'50%', background:chBg, border:`2px solid ${chColor}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, zIndex:1 }}>{chIcon}</div>
                            {i < seqSteps.length - 1 && <div style={{ width:2, flex:1, minHeight:14, background:'var(--globant-border)', margin:'2px 0' }} />}
                          </div>
                          <div style={{ flex:1, marginBottom:10, marginLeft:10, padding:'10px 12px', borderRadius:8, background:'var(--globant-surface)', border:'1px solid var(--globant-border)' }}>
                            <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                              <span style={{ fontSize:10, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', minWidth:22 }}>#{i+1}</span>
                              {i === 0 ? (
                                <span style={{ fontSize:11, color:'var(--globant-muted)', background:'rgba(167,139,250,0.1)', padding:'2px 8px', borderRadius:6 }}>Day 0 — sends on enroll</span>
                              ) : (
                                <div style={{ display:'flex', alignItems:'center', gap:4, fontSize:11, color:'var(--globant-muted)' }}>
                                  Wait <input type="number" min={1} value={step.waitDays} onChange={e => updateSeqStep(i,'waitDays',parseInt(e.target.value)||1)} style={{ width:40, textAlign:'center', background:'rgba(255,255,255,0.06)', border:'1px solid var(--globant-border)', borderRadius:4, color:'var(--globant-text)', fontSize:11, padding:'1px 4px' }} /> days
                                </div>
                              )}
                              <select value={step.channel} onChange={e => updateSeqStep(i,'channel',e.target.value)} className="input-field" style={{ fontSize:11, padding:'3px 6px', minWidth:90 }}>
                                <option>Email</option><option>LinkedIn</option><option>WhatsApp</option>
                              </select>
                              <select value={step.condition} onChange={e => updateSeqStep(i,'condition',e.target.value)} className="input-field" style={{ fontSize:11, padding:'3px 6px', minWidth:120 }}>
                                <option value="always">Always send</option>
                                <option value="no_reply">Only if no reply</option>
                              </select>
                              <input value={step.note||''} onChange={e => updateSeqStep(i,'note',e.target.value)} className="input-field" placeholder="Note (optional)" style={{ flex:1, minWidth:100, fontSize:11, padding:'3px 6px' }} />
                              <button onClick={() => removeSeqStep(i)} style={{ background:'none', border:'none', color:'var(--globant-muted)', cursor:'pointer', fontSize:14, padding:'0 4px', flexShrink:0 }}>✕</button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display:'flex', gap:8, marginTop:4 }}>
                    <button className="action-btn btn-ghost" style={{ fontSize:11 }} onClick={addSeqStep}>+ Add Step</button>
                    {seqDirty && <button className="action-btn btn-primary" style={{ fontSize:11 }} onClick={saveSeqSteps} disabled={savingSeq}>{savingSeq ? '⏳ Saving...' : '💾 Save Sequence'}</button>}
                  </div>
                </div>
              )}

              {/* CONTACTS TAB */}
              {seqTab === 'contacts' && seqSteps.length === 0 && (
                <div style={{ padding:'20px', textAlign:'center', color:'var(--globant-muted)', fontSize:12 }}>Set up your steps first, then enroll contacts here.</div>
              )}
              {seqTab === 'contacts' && seqSteps.length > 0 && (
                <div>
                  {enrolledIds.length > 0 && (
                    <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap', alignItems:'center' }}>
                      {groupDue.length > 0 && <span style={{ fontSize:11, fontWeight:600, color:'#ef4444', padding:'3px 8px', borderRadius:10, background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.25)' }}>🔴 {groupDue.length} due now</span>}
                      {groupScheduled.length > 0 && <span style={{ fontSize:11, fontWeight:600, color:'#60a5fa', padding:'3px 8px', borderRadius:10, background:'rgba(96,165,250,0.1)', border:'1px solid rgba(96,165,250,0.25)' }}>📅 {groupScheduled.length} scheduled</span>}
                      {repliedCount > 0 && <span style={{ fontSize:11, fontWeight:600, color:'#4ade80', padding:'3px 8px', borderRadius:10, background:'rgba(74,222,128,0.1)', border:'1px solid rgba(74,222,128,0.25)' }}>💬 {repliedCount} replied</span>}
                      {completedCount > 0 && <span style={{ fontSize:11, color:'var(--globant-muted)', padding:'3px 8px', borderRadius:10, background:'rgba(255,255,255,0.04)', border:'1px solid var(--globant-border)' }}>✅ {completedCount} done</span>}
                      <div style={{ flex:1 }} />
                      {isActive && activeCount > 0 && (
                        <button className="action-btn btn-primary" style={{ fontSize:11 }} onClick={groupDue.length > 0 ? runSequenceNow : forceRunSequenceNow} disabled={runningSeq}>
                          {runningSeq ? '⏳ Sending…' : groupDue.length > 0 ? `⚡ Send ${groupDue.length} now` : `⚡ Send ${activeCount} now`}
                        </button>
                      )}
                    </div>
                  )}
                  {enrolledIds.length > 0 && (
                    <div style={{ marginBottom:14 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'var(--globant-muted)', marginBottom:4 }}>
                        <span>Sequence progress</span><span style={{ fontWeight:700, color:'var(--globant-green)' }}>{pctDone}%</span>
                      </div>
                      <div style={{ height:4, borderRadius:2, background:'rgba(255,255,255,0.08)', overflow:'hidden' }}>
                        <div style={{ height:'100%', width:`${pctDone}%`, background:'linear-gradient(90deg,#4ade80,#60a5fa)', borderRadius:2 }} />
                      </div>
                    </div>
                  )}
                  {pendingToEnroll.length > 0 && (
                    <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', marginBottom:12, padding:'10px 12px', background:'rgba(167,139,250,0.06)', borderRadius:8, border:'1px solid rgba(167,139,250,0.2)' }}>
                      <div style={{ flex:1, minWidth:200 }}>
                        <div style={{ fontSize:11, fontWeight:600, color:'#a78bfa', marginBottom:4 }}>{pendingToEnroll.length} contact{pendingToEnroll.length>1?'s':''} ready to enroll</div>
                        <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
                          <label style={{ fontSize:11, color:'var(--globant-muted)' }}>Step 1 sends:</label>
                          <select className="input-field" style={{ fontSize:11, padding:'3px 6px' }}
                            value={enrollDateTime === '' ? 'now' : 'custom'}
                            onChange={e => {
                              if (e.target.value === 'now') setEnrollDateTime('');
                              else { const d = new Date(); d.setMinutes(0,0,0); d.setHours(d.getHours()+1); setEnrollDateTime(d.toISOString().slice(0,16)); }
                            }}>
                            <option value="now">⚡ Immediately</option>
                            <option value="custom">📅 Custom date &amp; time</option>
                          </select>
                          {enrollDateTime !== '' && (
                            <input type="datetime-local" className="input-field" style={{ fontSize:11, padding:'3px 6px' }} value={enrollDateTime} onChange={e => setEnrollDateTime(e.target.value)} />
                          )}
                        </div>
                      </div>
                      <button className="action-btn btn-primary" style={{ fontSize:11 }} onClick={enrollInSequence} disabled={enrolling}>
                        {enrolling ? '⏳ Enrolling...' : `+ Enroll ${pendingToEnroll.length}`}
                      </button>
                    </div>
                  )}
                  {enrolledIds.length > 0 && (
                    <div style={{ border:'1px solid var(--globant-border)', borderRadius:6, overflow:'hidden', maxHeight:360, overflowY:'auto' }}>
                      {groupDue.length > 0 && (
                        <>
                          <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 12px', background:'rgba(239,68,68,0.05)', borderBottom:'1px solid var(--globant-border)' }}>
                            <span style={{ fontSize:10, fontWeight:700, color:'#ef4444', textTransform:'uppercase', letterSpacing:0.8 }}>🔴 Due now ({groupDue.length})</span>
                            <div style={{ flex:1, height:1, background:'var(--globant-border)' }} />
                          </div>
                          {groupDue.map((id, i) => renderContactRow(id, i < groupDue.length-1 || groupScheduled.length > 0 || groupFinished.length > 0))}
                        </>
                      )}
                      {groupScheduled.length > 0 && (
                        <>
                          <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 12px', background:'rgba(255,255,255,0.03)', borderBottom:'1px solid var(--globant-border)' }}>
                            <span style={{ fontSize:10, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:0.8 }}>📅 Scheduled ({groupScheduled.length})</span>
                            <div style={{ flex:1, height:1, background:'var(--globant-border)' }} />
                          </div>
                          {groupScheduled.map((id, i) => renderContactRow(id, i < groupScheduled.length-1 || groupFinished.length > 0))}
                        </>
                      )}
                      {groupFinished.length > 0 && (
                        <>
                          <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 12px', background:'rgba(255,255,255,0.03)', borderBottom:'1px solid var(--globant-border)' }}>
                            <span style={{ fontSize:10, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:0.8 }}>✅ Finished ({groupFinished.length})</span>
                            <div style={{ flex:1, height:1, background:'var(--globant-border)' }} />
                          </div>
                          {groupFinished.map((id, i) => renderContactRow(id, i < groupFinished.length-1))}
                        </>
                      )}
                    </div>
                  )}
                  {enrolledIds.length === 0 && pendingToEnroll.length === 0 && (
                    <div style={{ padding:'20px', textAlign:'center', color:'var(--globant-muted)', fontSize:12 }}>No contacts enrolled yet.</div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* Stats */}
        <div className="kpi-row" style={{ gridTemplateColumns:'repeat(3,1fr)', marginBottom:14 }}>
          <div className="kpi-card">
            <div className="kpi-label">Assigned</div>
            <div className="kpi-value">{assignedIds.length}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Reached</div>
            <div className="kpi-value" style={{ color:'#4ade80' }}>{assignedIds.filter(id=>reachedIds.includes(id)).length}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Pending</div>
            <div className="kpi-value" style={{ color:'#fbbf24' }}>{assignedIds.filter(id=>!reachedIds.includes(id)).length}</div>
          </div>
        </div>

        {/* Add contacts panel */}
        {showAddContacts && (
          <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid var(--globant-green)', padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--globant-green)' }}>➕ Add contacts to campaign</div>
                <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 2 }}>
                  Campaign: <strong style={{ color: 'var(--globant-text)' }}>{F(selectedCampaign, 'Name')}</strong>
                </div>
              </div>
              <button className="action-btn btn-ghost" style={{ fontSize: 11 }} onClick={() => { setShowAddContacts(false); setAddContactsSearch(''); setSelectedToAdd(new Set()); }}>✕ Close</button>
            </div>
            <input
              className="input-field"
              style={{ width: '100%', fontSize: 12, marginBottom: 8 }}
              placeholder="Search by name, role, or account..."
              value={addContactsSearch}
              onChange={e => { setAddContactsSearch(e.target.value); setSelectedToAdd(new Set()); }}
              autoFocus
            />
            {availableToAdd.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, padding: '4px 2px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--globant-muted)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selectedToAdd.size === availableToAdd.length}
                    onChange={e => setSelectedToAdd(e.target.checked ? new Set(availableToAdd.map(s => s.id)) : new Set())}
                  />
                  Select all ({availableToAdd.length})
                </label>
                {selectedToAdd.size > 0 && (
                  <button
                    className="action-btn btn-primary"
                    style={{ fontSize: 11 }}
                    disabled={bulkAdding}
                    onClick={addBulkContactsToCampaign}
                  >
                    {bulkAdding ? '⏳ Adding...' : `✅ Add ${selectedToAdd.size} contact${selectedToAdd.size > 1 ? 's' : ''} to "${F(selectedCampaign,'Name')}"`}
                  </button>
                )}
              </div>
            )}
            <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--globant-border)', borderRadius: 6 }}>
              {availableToAdd.length === 0 ? (
                <div style={{ padding: 14, textAlign: 'center', color: 'var(--globant-muted)', fontSize: 12 }}>
                  {addContactsSearch ? `No contacts match "${addContactsSearch}"` : 'All contacts are already assigned to this campaign'}
                </div>
              ) : (
                availableToAdd.map(s => {
                  const accId = linkedIds(s, 'Account')[0];
                  const acc = accId ? accounts.find(a => a.id === accId) : null;
                  const accName = acc ? F(acc, 'Account Name') : '';
                  const industry = acc ? F(acc, 'Industry') : '';
                  const isChecked = selectedToAdd.has(s.id);
                  return (
                    <div
                      key={s.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--globant-border)', cursor: 'pointer', background: isChecked ? 'rgba(91,191,181,0.06)' : 'transparent' }}
                      onClick={() => setSelectedToAdd(prev => { const n = new Set(prev); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; })}
                    >
                      <input type="checkbox" checked={isChecked} onChange={() => {}} style={{ pointerEvents: 'none', flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{F(s,'Name')}{F(s,'Last name') ? ` ${F(s,'Last name')}` : ''}</div>
                        <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>{F(s,'Role')}{accName ? ` · ${accName}` : ''}{industry ? ` · ${industry}` : ''}</div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* Contact filters */}
        <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap' }}>
          <input className="input-field" style={{ fontSize:12, flex:1, minWidth:160 }} placeholder="Search assigned contacts..." value={filterSearch} onChange={e=>setFilterSearch(e.target.value)} />
          <select className="input-field" style={{ fontSize:12, minWidth:160 }} value={filterIndustry} onChange={e=>setFilterIndustry(e.target.value)}>
            <option value="">🏭 All industries</option>
            {industryOptions.map(i=><option key={i} value={i}>{i}</option>)}
          </select>
          <select className="input-field" style={{ fontSize:12, minWidth:160 }} value={filterRole} onChange={e=>setFilterRole(e.target.value)}>
            <option value="">👤 All roles</option>
            {roleOptions.map(r=><option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        {/* Bulk Email Panel */}
        {bulkMode && (() => {
          const gmailConn = localStorage.getItem('oike_gmail_connected') === 'true';
          const allStatuses = pendingEmailContacts.map(s => bulkMsgs[s.id]?.status);
          const generating = allStatuses.some(st => st === 'generating');
          const readyCount = allStatuses.filter(st => st === 'ready').length;
          const sentCount = allStatuses.filter(st => st === 'sent').length;
          const errorCount = allStatuses.filter(st => st === 'error').length;
          // Show list if we have generated messages OR there are already-reached contacts to re-touch
          const hasMessages = Object.keys(bulkMsgs).length > 0 || reachedIds.some(id => allEmailContacts.find(s => s.id === id));
          return (
            <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--globant-green)', padding: '14px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--globant-green)' }}>📣 Bulk Email — {F(selectedCampaign,'Name')}</div>
                  <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 3 }}>
                    {pendingEmailContacts.length} pending · {reachedIds.filter(id => allEmailContacts.find(s => s.id === id)).length} already reached
                    {hasMessages && ` · ${readyCount} ready · ${sentCount} sent${errorCount ? ` · ${errorCount} errors` : ''}`}
                  </div>
                </div>
                <button className="action-btn btn-ghost" style={{ fontSize: 11 }} onClick={() => { setBulkMode(false); setBulkMsgs({}); setBulkResult(null); }}>✕ Close</button>
              </div>
              {bulkResult && (
                <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 6, background: bulkResult.errors === 0 ? 'rgba(74,222,128,0.1)' : 'rgba(251,191,36,0.1)', border: `1px solid ${bulkResult.errors === 0 ? 'rgba(74,222,128,0.3)' : 'rgba(251,191,36,0.3)'}` }}>
                  <span style={{ fontSize: 12, color: bulkResult.errors === 0 ? '#4ade80' : '#fbbf24', fontWeight: 700 }}>
                    {bulkResult.errors === 0
                      ? (bulkDraftMode ? `📝 ${bulkResult.sent} drafts saved to Gmail Borradores!` : `✅ All ${bulkResult.sent} emails sent successfully!`)
                      : `⚠️ ${bulkResult.sent} ${bulkDraftMode?'drafted':'sent'}, ${bulkResult.errors} failed — check errors below and retry`}
                  </span>
                </div>
              )}
              {/* Content mode toggle */}
              {emailTplHtml && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  {[{val:false,label:'🤖 AI text per contact'},{val:true,label:'📧 HTML template + AI opener'}].map(opt => (
                    <button key={String(opt.val)} onClick={() => { setBulkUseHtml(opt.val); setBulkMsgs({}); setBulkResult(null); }}
                      style={{ flex:1, padding:'6px 10px', borderRadius:6, fontSize:11, cursor:'pointer', fontWeight: bulkUseHtml===opt.val ? 700 : 400,
                        background: bulkUseHtml===opt.val ? 'rgba(96,165,250,0.18)' : 'rgba(0,0,0,0.15)',
                        color: bulkUseHtml===opt.val ? '#60a5fa' : 'var(--globant-muted)',
                        border: `1px solid ${bulkUseHtml===opt.val ? 'rgba(96,165,250,0.4)' : 'var(--globant-border)'}` }}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
              {/* Send / Draft mode toggle */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                {[{val:false,label:'📤 Send directly'},{val:true,label:'📝 Save as draft'}].map(opt => (
                  <button key={String(opt.val)} onClick={() => { setBulkDraftMode(opt.val); setBulkMsgs({}); setBulkResult(null); }}
                    style={{ flex:1, padding:'6px 10px', borderRadius:6, fontSize:11, cursor:'pointer', fontWeight: bulkDraftMode===opt.val ? 700 : 400,
                      background: bulkDraftMode===opt.val ? 'rgba(251,191,36,0.15)' : 'rgba(0,0,0,0.15)',
                      color: bulkDraftMode===opt.val ? '#fbbf24' : 'var(--globant-muted)',
                      border: `1px solid ${bulkDraftMode===opt.val ? 'rgba(251,191,36,0.4)' : 'var(--globant-border)'}` }}>
                    {opt.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                {(() => {
                  // Contacts that need a message generated (pending or re-touched, no msg yet)
                  const needsGeneration = allEmailContacts.filter(s => {
                    if (!F(s,'Email')) return false;
                    const rawBm = bulkMsgs[s.id];
                    if (!rawBm) return !reachedIds.includes(s.id); // pending, never generated
                    return rawBm.status === 'ready' && !rawBm.msg; // re-touched, no message yet
                  });
                  // Contacts with message ready to open in Gmail
                  const readyToOpen = allEmailContacts.filter(s => {
                    const rawBm = bulkMsgs[s.id];
                    return rawBm?.status === 'ready' && rawBm?.msg && !!F(s,'Email');
                  });
                  return (<>
                    {/* Generate button — works for both modes, includes re-touched */}
                    <button className="action-btn btn-primary" style={{ fontSize: 11 }}
                      disabled={generating || bulkSending || needsGeneration.length === 0}
                      onClick={() => generateBulkMessages(needsGeneration)}>
                      {generating ? '⏳ Generating...' : `✨ Generate${bulkUseHtml ? ' Openers' : ' Messages'} (${needsGeneration.length})`}
                    </button>
                    {/* Gmail integration: send directly */}
                    {gmailConn && bulkUseHtml && (
                      <button className="action-btn" style={{ fontSize: 11, background: bulkDraftMode ? 'rgba(251,191,36,0.15)' : 'rgba(96,165,250,0.15)', color: bulkDraftMode ? '#fbbf24' : '#60a5fa', border: `1px solid ${bulkDraftMode ? 'rgba(251,191,36,0.3)' : 'rgba(96,165,250,0.3)'}`, fontWeight: 700 }}
                        disabled={bulkSending} onClick={executeBulkSendHtml}>
                        {bulkSending ? '⏳ Processing...' : bulkDraftMode ? `📝 Draft all (${pendingEmailContacts.filter(s=>!!F(s,'Email')).length})` : `📧 Send HTML to all (${pendingEmailContacts.filter(s=>!!F(s,'Email')).length})`}
                      </button>
                    )}
                    {gmailConn && !bulkUseHtml && readyCount > 0 && (
                      <button className="action-btn" style={{ fontSize: 11, background: bulkDraftMode ? 'rgba(251,191,36,0.15)' : 'rgba(91,191,181,0.15)', color: bulkDraftMode ? '#fbbf24' : 'var(--globant-green)', border: `1px solid ${bulkDraftMode ? 'rgba(251,191,36,0.3)' : 'rgba(91,191,181,0.3)'}`, fontWeight: 700 }}
                        disabled={bulkSending} onClick={executeBulkSend}>
                        {bulkSending ? '⏳ Processing...' : bulkDraftMode ? `📝 Draft All (${readyCount})` : `✉️ Send All (${readyCount})`}
                      </button>
                    )}
                    {/* No Gmail integration: queue mode — one Gmail window per click */}
                    {!gmailConn && readyToOpen.length > 0 && gmailQueueIdx === null && (
                      <button className="action-btn" style={{ fontSize: 11, background: 'rgba(251,191,36,0.18)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.4)', fontWeight: 700 }}
                        onClick={() => setGmailQueueIdx(0)}>
                        📬 Start sending ({readyToOpen.length}) — one per click
                      </button>
                    )}
                    {!gmailConn && needsGeneration.length > 0 && readyToOpen.length === 0 && gmailQueueIdx === null && (
                      <span style={{ fontSize: 11, color: 'var(--globant-muted)', alignSelf: 'center' }}>← generate first, then open in Gmail</span>
                    )}
                  </>);
                })()}
              </div>
              {/* Gmail queue panel — shows current contact, click to open Gmail and advance */}
              {gmailQueueIdx !== null && (() => {
                const gmailConn = localStorage.getItem('oike_gmail_connected') === 'true';
                const readyToOpen = allEmailContacts.filter(s => {
                  const rawBm = bulkMsgs[s.id];
                  return rawBm?.status === 'ready' && rawBm?.msg && !!F(s,'Email');
                });
                if (gmailQueueIdx >= readyToOpen.length) {
                  return (
                    <div style={{ marginBottom: 12, padding: '12px 14px', borderRadius: 8, background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.3)', textAlign: 'center' }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#4ade80', marginBottom: 6 }}>✅ All done! {readyToOpen.length} emails opened.</div>
                      <button className="action-btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setGmailQueueIdx(null)}>Close queue</button>
                    </div>
                  );
                }
                const current = readyToOpen[gmailQueueIdx];
                const firstName = F(current,'Name') || 'there';
                const accId = linkedIds(current,'Account')[0];
                const acc = accId ? accounts.find(a => a.id === accId) : null;
                const companyName = acc ? F(acc,'Account Name') : '';
                const msg = bulkMsgs[current.id]?.msg || '';
                const campaignName = F(selectedCampaign,'Name') || 'Campaign';
                let subject, body;
                if (bulkUseHtml) {
                  subject = emailTplSubject.trim()
                    ? emailTplSubject.replace(/\{\{first_name\}\}/g, firstName).replace(/\{\{company\}\}/g, companyName)
                    : `${campaignName} — for ${firstName} at ${companyName||'your team'}`;
                  body = msg;
                } else {
                  const lines = msg.split('\n');
                  const si = lines.findIndex(l => /^subject:/i.test(l.trim()));
                  subject = si !== -1 ? lines[si].replace(/^subject:\s*/i,'').trim() : `${campaignName} — ${firstName}`;
                  body = si !== -1 ? lines.slice(si+1).join('\n').trim() : msg;
                }
                return (
                  <div style={{ marginBottom: 12, borderRadius: 8, border: '1px solid rgba(251,191,36,0.4)', overflow: 'hidden' }}>
                    <div style={{ padding: '8px 12px', background: 'rgba(251,191,36,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#fbbf24' }}>
                        📬 {gmailQueueIdx + 1} of {readyToOpen.length} — {firstName} {F(current,'Last name')||''}{companyName ? ` · ${companyName}` : ''}
                      </span>
                      <button className="action-btn btn-ghost" style={{ fontSize: 10 }} onClick={() => setGmailQueueIdx(null)}>✕ Stop</button>
                    </div>
                    <div style={{ padding: '10px 12px' }}>
                      <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4 }}>
                        <strong>To:</strong> {F(current,'Email')} &nbsp;·&nbsp; <strong>Subject:</strong> {subject}
                      </div>
                      <div style={{ fontSize: 11, color: '#e5e7eb', lineHeight: 1.5, marginBottom: 8, whiteSpace: 'pre-wrap', background: 'rgba(0,0,0,0.2)', borderRadius: 6, padding: '8px 10px' }}>
                        {body.slice(0,300)}{body.length > 300 ? '…' : ''}
                      </div>
                      {bulkUseHtml && emailTplHtml && (
                        <div style={{ fontSize: 10, color: '#60a5fa', marginBottom: 8 }}>
                          💡 HTML template will be copied to clipboard — paste it in Gmail's compose body
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="action-btn" style={{ flex: 1, fontSize: 12, fontWeight: 700, background: 'rgba(251,191,36,0.2)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.5)', padding: '8px 14px' }}
                          onClick={() => openGmailQueueItem(readyToOpen, gmailQueueIdx)}>
                          📬 Open in Gmail → Next
                        </button>
                        {gmailQueueIdx < readyToOpen.length - 1 && (
                          <button className="action-btn btn-ghost" style={{ fontSize: 11 }}
                            onClick={() => setGmailQueueIdx(gmailQueueIdx + 1)}>
                            Skip →
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}
              {hasMessages && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 480, overflowY: 'auto' }}>
                  {allEmailContacts.map(s => {
                    const isReached = reachedIds.includes(s.id);
                    const rawBm = bulkMsgs[s.id];
                    // If contact is already reached and has no active new message, show as sent so Re-touch appears
                    const bm = (!rawBm || (isReached && rawBm.status === 'ready' && !rawBm.msg))
                      ? (isReached ? { msg: '', status: 'sent', error: '' } : (rawBm || {}))
                      : rawBm;
                    const accId = linkedIds(s,'Account')[0];
                    const acc = accId ? accounts.find(a => a.id === accId) : null;
                    const STATUS_BADGE = { generating: ['#fbbf24','⏳ Generating'], ready: ['var(--globant-green)','✅ Ready'], sending: ['#60a5fa','📤 Sending...'], sent: ['#4ade80','✅ Sent'], draft: ['#fbbf24','📝 Draft saved'], error: ['#ef4444','❌ Error'] };
                    const [badgeColor, badgeLabel] = STATUS_BADGE[bm.status] || ['var(--globant-muted)','—'];
                    return (
                      <div key={s.id} style={{ background: 'rgba(0,0,0,0.15)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--globant-border)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <div>
                            <span style={{ fontSize: 12, fontWeight: 700 }}>{F(s,'Name')}{F(s,'Last name') ? ` ${F(s,'Last name')}` : ''}</span>
                            <span style={{ fontSize: 11, color: 'var(--globant-muted)', marginLeft: 8 }}>{F(s,'Role')}{acc ? ` · ${F(acc,'Account Name')}` : ''}</span>
                          </div>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: `${badgeColor}20`, color: badgeColor, border: `1px solid ${badgeColor}40` }}>{badgeLabel}</span>
                        </div>
                        {bm.status === 'error' && <div style={{ fontSize: 11, color: '#ef4444', marginBottom: 4 }}>{bm.error}</div>}
                        {bm.msg && bm.status !== 'sent' && (
                          <textarea className="input-field"
                            style={{ width: '100%', minHeight: 80, resize: 'vertical', fontSize: 12, lineHeight: 1.5, fontFamily: 'inherit' }}
                            value={bm.msg}
                            onChange={e => setBulkMsgs(prev => ({ ...prev, [s.id]: { ...prev[s.id], msg: e.target.value } }))}
                            disabled={bm.status === 'sending'} />
                        )}
                        {bm.status === 'ready' && !bm.msg && (
                          <div style={{ fontSize: 11, color: 'var(--globant-muted)', fontStyle: 'italic', marginTop: 4 }}>
                            ↑ Hit <strong>Generate All</strong> to create a new message
                          </div>
                        )}
                        {bm.status === 'ready' && !gmailConn && F(s,'Email') && (
                          <button style={{ marginTop: 6, width: '100%', padding: '5px 10px', borderRadius: 6, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}
                            onClick={() => {
                              const email = F(s,'Email');
                              const msg = bm.msg;
                              const lines = msg.split('\n');
                              const si = lines.findIndex(l => /^subject:/i.test(l.trim()));
                              const subject = si !== -1 ? lines[si].replace(/^subject:\s*/i,'').trim() : `${F(selectedCampaign,'Name')||'Campaign'} — ${F(s,'Name')||''}`;
                              const body = si !== -1 ? lines.slice(si+1).join('\n').trim() : msg;
                              window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
                              // Log activity + mark reached
                              const accIds = linkedIds(s,'Account');
                              const a = api || new AirtableAPI();
                              const actFields = {
                                'Activity Name': `Email — ${new Date().toLocaleDateString('en-US')}`,
                                'Channel': 'Email', 'Status': 'Sent', 'Message': body,
                                'Stakeholder': [s.id], 'Date': new Date().toISOString(),
                                'Logged By': CURRENT_USER?.name || '',
                                ...(accIds.length ? { 'Account': accIds } : {}),
                                ...(selectedCampaign?.id ? { 'Campaign': [selectedCampaign.id] } : {}),
                              };
                              if (onAddRecord) onAddRecord('outreach', actFields);
                              a.createRecord(TABLE_IDS.outreach, actFields).catch(e => console.error('[gmail-open] log failed:', e));
                              a.updateRecord(TABLE_IDS.campaigns, selectedCampaign.id, {
                                'Stakeholders Reached': [...new Set([...linkedIds(selectedCampaign,'Stakeholders Reached'), s.id])],
                                'Assigned Stakeholders': [...new Set([...linkedIds(selectedCampaign,'Assigned Stakeholders'), s.id])],
                              }).catch(() => {});
                              setBulkMsgs(prev => ({ ...prev, [s.id]: { ...prev[s.id], status: 'sent' } }));
                              if (onLogActivity) onLogActivity();
                            }}>
                            📬 Open in Gmail
                          </button>
                        )}
                        {bm.status === 'sent' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {bm.msg && <div style={{ fontSize: 11, color: 'var(--globant-muted)', fontStyle: 'italic' }}>{bm.msg.slice(0, 150)}…</div>}
                            <button
                              style={{ marginTop: 2, padding: '4px 10px', borderRadius: 6, background: 'rgba(91,191,181,0.08)', border: '1px solid rgba(91,191,181,0.25)', color: 'var(--globant-green)', cursor: 'pointer', fontSize: 11, fontWeight: 700, alignSelf: 'flex-start' }}
                              onClick={() => setBulkMsgs(prev => ({ ...prev, [s.id]: { msg: '', status: 'ready', error: '' } }))}
                            >
                              ↩️ Re-touch
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}


        {/* Contacts list */}
        <div className="card" style={{ padding:0, overflow:'hidden' }}>
          <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--globant-border)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize:13, fontWeight:700 }}>Assigned contacts ({detailContacts.length}{assignedIds.length !== detailContacts.length ? ` of ${assignedIds.length}` : ''})</span>
              <span style={{ fontSize:11, color:'var(--globant-muted)' }}>✅ = reached · ⏳ = pending</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {allEmailContacts.length > 0 && (
                <button className="action-btn" style={{ fontSize: 11, background: bulkMode ? 'rgba(91,191,181,0.2)' : 'rgba(91,191,181,0.1)', color: 'var(--globant-green)', border: '1px solid rgba(91,191,181,0.3)' }}
                  onClick={() => { setBulkMode(!bulkMode); if (bulkMode) { setBulkMsgs({}); setBulkResult(null); } }}>
                  {bulkMode ? '✕ Close Bulk' : pendingEmailContacts.length > 0 ? `📣 Bulk Email (${pendingEmailContacts.length} pending)` : `↩️ Bulk Re-touch (${allEmailContacts.length})`}
                </button>
              )}
              <button className="action-btn btn-primary" style={{ fontSize: 11 }} onClick={() => setShowAddContacts(!showAddContacts)}>
                {showAddContacts ? '✕ Cancel' : '➕ Add contacts'}
              </button>
            </div>
          </div>
          {assignedIds.length === 0 ? (
            <div style={{ padding: 32, textAlign:'center', color:'var(--globant-muted)', fontSize:13 }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>👥</div>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: 'var(--globant-text)' }}>No contacts assigned yet</div>
              <div style={{ marginBottom: 14 }}>Click <strong>➕ Add contacts</strong> above to select who you want to reach with this campaign.</div>
              <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={() => setShowAddContacts(true)}>➕ Add contacts</button>
            </div>
          ) : detailContacts.length === 0 ? (
            <div style={{ padding:24, textAlign:'center', color:'var(--globant-muted)', fontSize:13 }}>No assigned contacts match the current filters.</div>
          ) : (
            <div style={{ maxHeight:540, overflowY:'auto' }}>
              {detailContacts.map(s => {
                const isReached = reachedIds.includes(s.id);
                const accId = linkedIds(s,'Account')[0];
                const acc = accounts.find(a=>a.id===accId);
                const accName = acc ? F(acc,'Account Name') : '';
                const industry = acc ? F(acc,'Industry') : '';
                const hasEmail = !!F(s,'Email');
                const hasPhone = !!F(s,'Phone number');
                const hasLinkedin = !!F(s,'LinkedIn');
                const isActive = invitePreview?.id === s.id;

                const isRemoving = addingContactId === s.id;
                return (
                  <div key={s.id} style={{ borderBottom:'1px solid var(--globant-border)', opacity: (isReached&&!isActive) || isRemoving ? 0.65 : 1 }}>
                    {/* Contact row */}
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 14px', gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                          {isReached ? (
                            <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'rgba(74,222,128,0.15)', color: '#4ade80' }}>✅ Reached</span>
                          ) : (
                            <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>⏳ Pending</span>
                          )}
                          <span
                            style={{ fontWeight:600, fontSize:13, cursor:'pointer', color:'var(--globant-green)' }}
                            title="Open contact history"
                            onClick={() => setCampaignHistoryStk(s)}>
                            {F(s,'Name')}{F(s,'Last name') ? ` ${F(s,'Last name')}` : ''}
                          </span>
                          {F(s,'Level of Influence') && <span className="badge badge-accent" style={{ fontSize:9 }}>{F(s,'Level of Influence')}</span>}
                        </div>
                        <div style={{ fontSize:11, color:'var(--globant-muted)', marginTop:2 }}>
                          {F(s,'Role')}{accName ? ` · ${accName}` : ''}{industry ? ` · ${industry}` : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <button
                          className="action-btn btn-primary" style={{ fontSize:10, padding:'4px 12px' }}
                          disabled={(isActive && invitePreview.generating) || isRemoving}
                          onClick={() => isActive ? setInvitePreview(null) : generateMsg(s)}>
                          {isActive && invitePreview.generating ? '⏳' : isActive ? '✕ Close' : isReached ? '🔄 Resend' : '✨ Generate'}
                        </button>
                        <button
                          className="action-btn btn-ghost" style={{ fontSize: 10, padding: '4px 8px', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}
                          disabled={isRemoving}
                          title="Remove from campaign"
                          onClick={() => removeContactFromCampaign(s.id)}>
                          {isRemoving ? '⏳' : '🗑️'}
                        </button>
                      </div>
                    </div>
                    {/* Preview panel */}
                    {isActive && !invitePreview.generating && invitePreview.msg && (
                      <div style={{ padding:'10px 14px', background:'rgba(91,191,181,0.06)', borderTop:'1px solid var(--globant-border)' }}>
                        <div style={{ fontSize:12, color:'var(--globant-text)', lineHeight:1.6, marginBottom:10, whiteSpace:'pre-wrap' }}>{invitePreview.msg}</div>
                        <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                          {hasEmail && <button className="action-btn btn-email" style={{ fontSize:11 }} onClick={()=>sendMsg(s,'Email')}>✉️ Send via Email</button>}
                          {hasPhone && <button className="action-btn btn-whatsapp" style={{ fontSize:11 }} onClick={()=>sendMsg(s,'WhatsApp')}>💬 Send via WhatsApp</button>}
                          {hasLinkedin && <button className="action-btn btn-linkedin" style={{ fontSize:11 }} onClick={()=>sendMsg(s,'LinkedIn')}>🔗 Send via LinkedIn</button>}
                          <button className="action-btn btn-ghost" style={{ fontSize:11 }} onClick={()=>generateMsg(s)}>🔄 Regenerate</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Campaign Activity Log */}
        {(() => {
          const campOutreach = outreach.filter(o => {
            const linked = o.fields?.['Campaign'];
            return Array.isArray(linked) && linked.includes(selectedCampaign.id);
          }).sort((a,b) => (b.fields?.['Date']||'').localeCompare(a.fields?.['Date']||''));
          if (campOutreach.length === 0) return null;
          return (
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10, color: 'var(--globant-text)' }}>📬 Activity Log ({campOutreach.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {campOutreach.map(o => {
                  const stkId = (o.fields?.['Stakeholder']||[])[0];
                  const stk = stakeholders.find(s => s.id === stkId);
                  const sName = stk ? `${F(stk,'Name')||''}${F(stk,'Last name') ? ' '+F(stk,'Last name') : ''}`.trim() : '—';
                  const date = o.fields?.['Date'] ? new Date(o.fields['Date']+'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '';
                  const status = o.fields?.['Status'] || '';
                  const channel = o.fields?.['Channel'] || 'Email';
                  const loggedBy = o.fields?.['Logged By'] || '';
                  return (
                    <div key={o.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', background:'rgba(255,255,255,0.03)', borderRadius:6, border:'1px solid var(--globant-border)' }}>
                      <span style={{ fontSize:13 }}>{channel==='Email'?'✉️':channel==='WhatsApp'?'💬':channel==='LinkedIn'?'🔗':'📋'}</span>
                      <div style={{ flex:1 }}>
                        <span style={{ fontSize:12, fontWeight:600 }}>{sName}</span>
                        {loggedBy && <span style={{ fontSize:11, color:'var(--globant-muted)' }}> · {loggedBy}</span>}
                      </div>
                      {date && <span style={{ fontSize:11, color:'var(--globant-muted)' }}>{date}</span>}
                      {status && <span style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:10, background: status==='Sent'?'rgba(74,222,128,0.12)':status==='Draft'?'rgba(251,191,36,0.12)':'rgba(91,191,181,0.12)', color: status==='Sent'?'#4ade80':status==='Draft'?'#fbbf24':'var(--globant-green)' }}>{status}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Edit modal (reuses create form) */}
        {showForm && (
          <div className="modal-overlay" onClick={()=>setShowForm(false)}>
            <div className="modal" onClick={e=>e.stopPropagation()} style={{ maxWidth:560 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
                <h3 style={{ margin:0 }}>✏️ Edit Campaign</h3>
                <button onClick={()=>setShowForm(false)} style={{ background:'none', border:'none', color:'var(--globant-muted)', cursor:'pointer', fontSize:18 }}>✕</button>
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                <div>
                  <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Campaign Name *</label>
                  <input style={inputSt} value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} />
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                  <div>
                    <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Type</label>
                    <select style={inputSt} value={form.type} onChange={e=>setForm(p=>({...p,type:e.target.value}))}>
                      {TYPE_OPTIONS.map(t=><option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Status</label>
                    <select style={inputSt} value={form.status} onChange={e=>setForm(p=>({...p,status:e.target.value}))}>
                      {STATUS_OPTIONS.map(s=><option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                  <div>
                    <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Start Date</label>
                    <input type="date" style={inputSt} value={form.startDate} onChange={e=>setForm(p=>({...p,startDate:e.target.value}))} />
                  </div>
                  <div>
                    <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Goal (# contacts)</label>
                    <input type="number" style={inputSt} placeholder="e.g. 50" value={form.goal} onChange={e=>setForm(p=>({...p,goal:e.target.value}))} />
                  </div>
                </div>
                <div>
                  <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Asset URL (optional)</label>
                  <input style={inputSt} placeholder="https://..." value={form.assetUrl} onChange={e=>setForm(p=>({...p,assetUrl:e.target.value}))} />
                </div>
                <div>
                  <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Message Template / Reference Angle *</label>
                  <textarea style={{ ...inputSt, minHeight:100, resize:'vertical', fontFamily:'inherit' }}
                    placeholder="Core angle, key message, or talking points. The AI uses this as reference to personalize for each contact."
                    value={form.messageTemplate} onChange={e=>setForm(p=>({...p,messageTemplate:e.target.value}))} />
                </div>
                <div>
                  <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Campaign Context (strategic brief)</label>
                  <textarea style={{ ...inputSt, minHeight:120, resize:'vertical', fontFamily:'inherit' }}
                    placeholder="Target cohort, pain addressed, angle, desired outcome..."
                    value={form.context || ''} onChange={e=>setForm(p=>({...p,context:e.target.value}))} />
                </div>
                {form.assignedIds && form.assignedIds.length > 0 && (
                  <div style={{ padding: '10px 12px', background: 'rgba(16,185,129,0.08)', borderRadius: 6, border: '1px solid rgba(16,185,129,0.2)' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#10b981', marginBottom: 4 }}>👥 Pre-assigned stakeholders ({form.assignedIds.length})</div>
                    <div style={{ fontSize: 11, color: 'var(--globant-muted)' }}>
                      These contacts will be added to the campaign on save. You can remove any on the detail view after saving.
                    </div>
                  </div>
                )}
              </div>
              <div style={{ display:'flex', gap:8, marginTop:18 }}>
                <button className="action-btn btn-primary" style={{ fontSize:13 }} onClick={saveCampaign} disabled={saving}>{saving?'⏳ Saving...':'💾 Save Campaign'}</button>
                <button className="action-btn btn-ghost" style={{ fontSize:13 }} onClick={()=>setShowForm(false)}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* Stakeholder history modal — opens when clicking a contact name */}
        {campaignHistoryStk && (
          <StakeholderHistoryModal
            stakeholder={campaignHistoryStk}
            outreach={outreach}
            accounts={accounts}
            onClose={() => setCampaignHistoryStk(null)}
            onRefresh={onLogActivity}
            onAddRecord={onAddRecord}
            allData={data}
            onSend={(stakeholder, channel, message) => {
              // Reuse sendMsg — but since that uses invitePreview, build message directly via channel
              const email = F(stakeholder,'Email')||'';
              const phone = F(stakeholder,'Phone number')||'';
              const linkedin = F(stakeholder,'LinkedIn')||'';
              let subject = '', body = message;
              if (channel === 'Email') {
                const lines = body.split('\n');
                const si = lines.findIndex(l => /^subject:/i.test(l.trim()));
                if (si !== -1) { subject = lines[si].replace(/^subject:\s*/i,'').trim(); body = lines.slice(si+1).join('\n').trim(); }
              }
              if (channel==='WhatsApp'&&phone) window.open(`https://wa.me/${String(phone).replace(/[^0-9+]/g,'')}?text=${encodeURIComponent(message)}`,'_blank');
              else if (channel==='Email'&&email) window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,'_blank');
              else if (channel==='LinkedIn'&&linkedin) { navigator.clipboard.writeText(message).catch(()=>{}); window.open(linkedin,'_blank'); }
            }}
          />
        )}
      </div>
    );
  }

  // ── LIST VIEW ──
  return (
    <div>
      {/* Hub Tab switcher */}
      <div style={{ display:'flex', gap:0, marginBottom:24, borderBottom:'1px solid var(--globant-border)' }}>
        {[['campaigns','📣 Campaigns'],['contentlab','✍️ Content Lab']].map(([k,label]) => (
          <button key={k} onClick={() => setHubTab(k)} style={{ padding:'10px 22px', background:'none', border:'none', borderBottom: hubTab===k ? '2px solid var(--globant-green)' : '2px solid transparent', color: hubTab===k ? 'var(--globant-green)' : 'var(--globant-muted)', fontWeight: hubTab===k ? 700 : 400, fontSize:14, cursor:'pointer', transition:'all 0.15s' }}>
            {label}
          </button>
        ))}
      </div>

      {hubTab === 'contentlab' && (
        <ContentLab data={data} api={api} onLogActivity={onLogActivity} onAddRecord={onAddRecord} onDeleteRecord={onDeleteRecord} />
      )}

      {hubTab === 'campaigns' && <div>
      <div style={{ display:'flex', gap:8, marginBottom:16, flexWrap:'wrap' }}>
        <input className="input-field" style={{ fontSize:12, flex:1, minWidth:180 }} placeholder="Search campaigns..." value={listSearch} onChange={e=>setListSearch(e.target.value)} />
        <select className="input-field" style={{ fontSize:12, minWidth:140 }} value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map(s=><option key={s} value={s}>{s}</option>)}
        </select>
        <button className="action-btn btn-primary" style={{ fontSize:12 }} onClick={openCreate}>+ New Campaign</button>
      </div>

      {filteredCampaigns.length === 0 ? (
        <div className="card" style={{ textAlign:'center', padding:40 }}>
          <div style={{ fontSize:32, marginBottom:12 }}>📣</div>
          <div style={{ fontSize:15, fontWeight:700, marginBottom:8 }}>{campaigns.length===0 ? 'No campaigns yet' : 'No campaigns match'}</div>
          <div style={{ fontSize:13, color:'var(--globant-muted)', marginBottom:16 }}>{campaigns.length===0 ? 'Create your first campaign to start targeted outreach' : 'Try adjusting your filters'}</div>
          {campaigns.length===0 && <button className="action-btn btn-primary" onClick={openCreate}>+ New Campaign</button>}
        </div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(300px,1fr))', gap:14 }}>
          {filteredCampaigns.map(c => {
            const status = F(c,'Status') || '';
            const type = F(c,'Type') || '';
            const reached = linkedIds(c,'Stakeholders Reached').length;
            const cardAssignedRaw = linkedIds(c,'Assigned Stakeholders');
            const assigned = [...new Set([...cardAssignedRaw, ...linkedIds(c,'Stakeholders Reached')])].length;
            const goal = c.fields?.['Goal'] || 0;
            const pct = goal>0 ? Math.min(100, Math.round((reached/goal)*100)) : null;
            return (
              <div key={c.id} className="card" style={{ cursor:'pointer', borderTop:`3px solid ${STATUS_COLORS[status]||'var(--globant-border)'}` }}
                onClick={()=>{ setSelectedId(c.id); setInvitePreview(null); }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'start', marginBottom:8 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                    <span style={{ fontSize:18 }}>{TYPE_ICONS[type]||'📣'}</span>
                    <span style={{ fontWeight:700, fontSize:14 }}>{F(c,'Name')}</span>
                  </div>
                  <span style={{ fontSize:10, padding:'3px 8px', borderRadius:20, background:`${STATUS_COLORS[status]||'#666'}20`, color:STATUS_COLORS[status]||'var(--globant-muted)', fontWeight:700, whiteSpace:'nowrap', border:`1px solid ${STATUS_COLORS[status]||'var(--globant-border)'}40` }}>{status}</span>
                </div>
                <div style={{ fontSize:11, color:'var(--globant-muted)', marginBottom:8 }}>
                  {type}{c.fields?.['Start Date'] ? ` · ${formatDate(c.fields['Start Date'])}` : ''}
                </div>
                {F(c,'Message Template') && (
                  <div style={{ fontSize:11, color:'var(--globant-muted)', fontStyle:'italic', marginBottom:10, lineHeight:1.4 }}>
                    "{(F(c,'Message Template')||'').slice(0,100)}{(F(c,'Message Template')||'').length>100?'...':''}"
                  </div>
                )}
                <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize:12, color:'var(--globant-muted)', fontWeight:600 }}>👥 {assigned} assigned</span>
                  <span style={{ fontSize:12, color:'#4ade80', fontWeight:700 }}>✅ {reached} reached</span>
                  {goal>0 && <span style={{ fontSize:11, color:'var(--globant-muted)' }}>/ {goal} goal</span>}
                </div>
                {pct!==null && (
                  <div style={{ height:4, borderRadius:2, background:'var(--globant-darker)', overflow:'hidden', marginTop:8 }}>
                    <div style={{ height:'100%', width:`${pct}%`, background:'linear-gradient(90deg,#4ade80,#22d3ee)', borderRadius:2 }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create modal */}
      {showForm && (
        <div className="modal-overlay" onClick={()=>setShowForm(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()} style={{ maxWidth:560 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
              <h3 style={{ margin:0 }}>📣 New Campaign</h3>
              <button onClick={()=>setShowForm(false)} style={{ background:'none', border:'none', color:'var(--globant-muted)', cursor:'pointer', fontSize:18 }}>✕</button>
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              <div>
                <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Campaign Name *</label>
                <input style={inputSt} placeholder="e.g. White Paper Q2 — Real Estate" value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} />
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                <div>
                  <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Type</label>
                  <select style={inputSt} value={form.type} onChange={e=>setForm(p=>({...p,type:e.target.value}))}>
                    {TYPE_OPTIONS.map(t=><option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Status</label>
                  <select style={inputSt} value={form.status} onChange={e=>setForm(p=>({...p,status:e.target.value}))}>
                    {STATUS_OPTIONS.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                <div>
                  <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Start Date</label>
                  <input type="date" style={inputSt} value={form.startDate} onChange={e=>setForm(p=>({...p,startDate:e.target.value}))} />
                </div>
                <div>
                  <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Goal (# contacts)</label>
                  <input type="number" style={inputSt} placeholder="e.g. 50" value={form.goal} onChange={e=>setForm(p=>({...p,goal:e.target.value}))} />
                </div>
              </div>
              <div>
                <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Asset URL (optional)</label>
                <input style={inputSt} placeholder="https://..." value={form.assetUrl} onChange={e=>setForm(p=>({...p,assetUrl:e.target.value}))} />
              </div>
              <div>
                <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Message Template / Reference Angle *</label>
                <textarea style={{ ...inputSt, minHeight:100, resize:'vertical', fontFamily:'inherit' }}
                  placeholder="Core angle, key message, or talking points. The AI uses this as reference to personalize for each contact."
                  value={form.messageTemplate} onChange={e=>setForm(p=>({...p,messageTemplate:e.target.value}))} />
              </div>
              <div>
                <label style={{ fontSize:11, color:'var(--globant-muted)', display:'block', marginBottom:4 }}>Campaign Context (strategic brief)</label>
                <textarea style={{ ...inputSt, minHeight:120, resize:'vertical', fontFamily:'inherit' }}
                  placeholder="Target cohort, pain addressed, angle, desired outcome..."
                  value={form.context || ''} onChange={e=>setForm(p=>({...p,context:e.target.value}))} />
              </div>
              {form.assignedIds && form.assignedIds.length > 0 && (
                <div style={{ padding: '10px 12px', background: 'rgba(16,185,129,0.08)', borderRadius: 6, border: '1px solid rgba(16,185,129,0.2)' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#10b981', marginBottom: 4 }}>👥 Pre-assigned stakeholders ({form.assignedIds.length})</div>
                  <div style={{ fontSize: 11, color: 'var(--globant-muted)' }}>
                    These contacts will be added to the campaign on save.
                  </div>
                </div>
              )}
            </div>
            <div style={{ display:'flex', gap:8, marginTop:18 }}>
              <button className="action-btn btn-primary" style={{ fontSize:13 }} onClick={saveCampaign} disabled={saving}>{saving?'⏳ Saving...':'💾 Save Campaign'}</button>
              <button className="action-btn btn-ghost" style={{ fontSize:13 }} onClick={()=>setShowForm(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      </div>}
    </div>
  );
}

// ============ CONTENT LAB ============

export default CampaignsHub;
