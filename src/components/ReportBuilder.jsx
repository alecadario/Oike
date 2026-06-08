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


function ReportBuilder({ data, api, onAddRecord, onCreateCampaignFromInsight }) {
  const { accounts, stakeholders, outreach, solutions, opportunities, campaigns = [], events = [], contentLab = [], clientPartners = [], users = [] } = data;
  const now = new Date();
  const fmt = (d) => d.toISOString().split('T')[0];
  const defaultFrom = fmt(new Date(now - 14 * 86400000));
  const defaultTo   = fmt(now);

  // ── Top-level report mode: 'outreach' | 'company' | 'stakeholder' | 'account-briefing' ──
  const [reportMode, setReportMode] = useState('outreach');
  const [dateFrom, setDateFrom]   = useState(defaultFrom);
  const [dateTo, setDateTo]       = useState(defaultTo);
  // Grouping dimension (outreach mode): 'accounts' | 'solutions' | 'campaigns' | 'events' | 'cp'
  const [groupBy, setGroupBy]     = useState('accounts');
  const [selectedIds, setSelectedIds] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  // Report view filter (outreach mode): 'all' | 'replies' | 'meetings' | 'posts'
  const [reportFilter, setReportFilter] = useState('all');
  const [reportHtml, setReportHtml] = useState('');
  const [copied, setCopied]       = useState(false);
  const [gmailOpened, setGmailOpened] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [reportNotes, setReportNotes] = useState('');
  // Store AI-analyzed replies so they can be converted to urgent tasks after the report is generated
  const [lastReplyDetails, setLastReplyDetails] = useState([]);
  const [creatingTasks, setCreatingTasks] = useState(false);
  const [tasksCreatedCount, setTasksCreatedCount] = useState(0);

  // ── Intel report state (shared between Company & Stakeholder) ──
  const [intelGroupBy, setIntelGroupBy] = useState('industry'); // industry | country | account (company) | industry | role | country (stakeholder)
  const [intelIncludeOutreach, setIntelIncludeOutreach] = useState(false); // company report toggle
  const [intelIncludeOpps, setIntelIncludeOpps] = useState(true); // stakeholder report toggle
  const [intelFilterIndustry, setIntelFilterIndustry] = useState('');
  const [intelFilterCountry, setIntelFilterCountry] = useState('');
  const [intelFilterInfluence, setIntelFilterInfluence] = useState(''); // stakeholder only
  const [intelFilterAccountIds, setIntelFilterAccountIds] = useState([]); // specific account picker
  const [intelAccountSearch, setIntelAccountSearch] = useState('');
  // Cached insights per group (for "Create campaign from insight")
  const [intelInsights, setIntelInsights] = useState([]);
  // { groupKey, groupLabel, execSummary, suggestedCampaign: { name, type, context, stakeholderIds } }

  // Reset selection when switching group-by type
  const changeGroupBy = (g) => { setGroupBy(g); setSelectedIds([]); setSearchQuery(''); };

  const fromTs = new Date(dateFrom).getTime();
  const toTs   = new Date(dateTo + 'T23:59:59').getTime();

  // ── Generic: all options available for the chosen group-by type ──
  const allOptions = useMemo(() => {
    const sortByName = (arr, nameField) => [...arr].sort((a,b) => (F(a,nameField)||'').localeCompare(F(b,nameField)||''));
    switch (groupBy) {
      case 'solutions': return { items: sortByName(solutions, 'Name'), nameField: 'Name', icon: '🛠️', label: 'Offering' };
      case 'campaigns': return { items: sortByName(campaigns, 'Name'), nameField: 'Name', icon: '📣', label: 'Campaigns' };
      case 'events':    return { items: sortByName(events, 'Event Name'), nameField: 'Event Name', icon: '🎤', label: 'Events' };
      case 'cp': {
        // CP users: those whose ID appears in at least one account's 'CP' linked field
        const cpUserIds = new Set(accounts.flatMap(a => linkedIds(a, 'CP')));
        const cpUsers = users.filter(u => cpUserIds.has(u.id));
        return { items: sortByName(cpUsers.length > 0 ? cpUsers : users, 'Name'), nameField: 'Name', icon: '👤', label: 'Client Partners' };
      }
      case 'accounts':
      default:          return { items: sortByName(accounts, 'Account Name'), nameField: 'Account Name', icon: '🏢', label: 'Accounts' };
    }
  }, [groupBy, accounts, solutions, campaigns, events, users]);

  // Filtered dropdown options (by search query)
  const filteredOptions = useMemo(() => {
    if (!searchQuery.trim()) return allOptions.items;
    const q = searchQuery.toLowerCase();
    return allOptions.items.filter(it => (F(it, allOptions.nameField) || '').toLowerCase().includes(q));
  }, [searchQuery, allOptions]);

  // Active items: the ones to include in report. Empty selection = all options.
  const activeItems = selectedIds.length > 0
    ? allOptions.items.filter(it => selectedIds.includes(it.id))
    : allOptions.items;

  // ── Resolve which accounts to include based on group-by type ──
  // For each groupBy, compute which accountIds are relevant
  const displayAccIds = useMemo(() => {
    if (groupBy === 'accounts') {
      return activeItems.map(a => a.id);
    }
    if (groupBy === 'solutions') {
      const accIds = new Set();
      activeItems.forEach(sol => {
        linkedIds(sol, 'Accounts - New markets').forEach(id => accIds.add(id));
        opportunities.filter(o => linkedIds(o, 'Solutions').includes(sol.id)).forEach(o => {
          linkedIds(o, 'Account').forEach(id => accIds.add(id));
        });
      });
      return [...accIds];
    }
    if (groupBy === 'campaigns') {
      // Accounts reached by outreach linked to these campaigns
      const campaignIds = new Set(activeItems.map(c => c.id));
      const accIds = new Set();
      outreach.forEach(o => {
        if (linkedIds(o, 'Campaign').some(id => campaignIds.has(id))) {
          linkedIds(o, 'Account').forEach(id => accIds.add(id));
        }
      });
      return [...accIds];
    }
    if (groupBy === 'events') {
      // Accounts of stakeholders invited to these events
      const invitedStkIds = new Set(activeItems.flatMap(e => linkedIds(e, 'Stakeholders invited')));
      const accIds = new Set();
      stakeholders.forEach(s => {
        if (invitedStkIds.has(s.id)) linkedIds(s, 'Account').forEach(id => accIds.add(id));
      });
      return [...accIds];
    }
    if (groupBy === 'cp') {
      // Accounts where the CP linked field matches one of the active CP records
      const cpIds = new Set(activeItems.map(cp => cp.id));
      return accounts.filter(a => linkedIds(a, 'CP').some(id => cpIds.has(id))).map(a => a.id);
    }
    return accounts.map(a => a.id);
  }, [groupBy, activeItems, opportunities, outreach, stakeholders, accounts]);

  const displayAccounts = accounts.filter(a => displayAccIds.includes(a.id))
    .sort((a,b) => (F(a,'Account Name')||'').localeCompare(F(b,'Account Name')||''));

  // Legacy aliases (kept to avoid breaking existing derived code below)
  const activeSols = groupBy === 'solutions' ? activeItems : solutions;
  const solAccMap = useMemo(() => {
    const m = {};
    for (const sol of activeSols) {
      const expAccIds = linkedIds(sol, 'Accounts - New markets');
      const oppAccIds = opportunities.filter(o => linkedIds(o, 'Solutions').includes(sol.id)).flatMap(o => linkedIds(o, 'Account'));
      m[sol.id] = [...new Set([...expAccIds, ...oppAccIds])];
    }
    return m;
  }, [activeSols, opportunities]);

  // Stakeholder IDs for the selected accounts (for broader outreach matching)
  const displayStkIds = useMemo(() => {
    const ids = new Set();
    stakeholders.forEach(s => {
      if (linkedIds(s, 'Account').some(id => displayAccIds.includes(id))) ids.add(s.id);
    });
    return ids;
  }, [stakeholders, displayAccIds]);

  // Outreach in period — base filter: by Account OR by Stakeholder belonging to those accounts
  // For campaigns/events groupBy, also tightens by Campaign link or Event invitee
  const periodOutreach = outreach.filter(o => {
    const ts = new Date(o.fields?.['Date'] || 0).getTime();
    if (ts < fromTs || ts > toTs) return false;
    const accountMatch = linkedIds(o, 'Account').some(id => displayAccIds.includes(id));
    const stakeholderMatch = linkedIds(o, 'Stakeholder').some(id => displayStkIds.has(id));
    if (!accountMatch && !stakeholderMatch) return false;
    // Tighter filter when specific campaigns selected → only outreach linked to those campaigns
    if (groupBy === 'campaigns' && selectedIds.length > 0) {
      return linkedIds(o, 'Campaign').some(id => selectedIds.includes(id));
    }
    // Tighter filter when specific events selected → only outreach to invited stakeholders
    if (groupBy === 'events' && selectedIds.length > 0) {
      const invitedStkIds = new Set(activeItems.flatMap(e => linkedIds(e, 'Stakeholders invited')));
      return linkedIds(o, 'Stakeholder').some(id => invitedStkIds.has(id));
    }
    return true;
  });

  const totalSent     = periodOutreach.length;
  const allReplies    = periodOutreach.filter(o => F(o, 'Status') === 'Replied');
  // Deduplicate: 1 reply per unique stakeholder (if same person replied 3x → counts as 1)
  const repliedStkIds = new Set(allReplies.flatMap(o => linkedIds(o, 'Stakeholder')).filter(Boolean));
  const replies       = allReplies.filter((o, _, arr) => {
    const stkId = linkedIds(o, 'Stakeholder')[0];
    if (!stkId) return true; // no stakeholder → keep
    return arr.findIndex(x => linkedIds(x, 'Stakeholder')[0] === stkId) === arr.indexOf(o);
  });
  const meetings      = periodOutreach.filter(o => ['Meeting Scheduled','Meeting Booked'].includes(F(o, 'Status')));
  const bounced       = periodOutreach.filter(o => F(o, 'Status') === 'Bounced');
  const uniqueRepliers = replies.length; // already deduplicated by stakeholder above
  const replyRate     = totalSent > 0 ? Math.round(uniqueRepliers / totalSent * 100) : 0;
  const meetingRate   = totalSent > 0 ? Math.round(meetings.length / totalSent * 100) : 0;
  const bouncedRate   = totalSent > 0 ? Math.round(bounced.length / totalSent * 100) : 0;
  const accsContacted = new Set(periodOutreach.flatMap(o => linkedIds(o, 'Account'))).size;

  const activeSolIds = activeSols.map(s => s.id);
  const activeOpps = opportunities.filter(o =>
    linkedIds(o, 'Solutions').some(sid => activeSolIds.includes(sid)) &&
    linkedIds(o, 'Account').some(id => displayAccIds.includes(id)) &&
    !['Closed Won','Closed/Won','Closed Lost','Closed/Lost','Closed/Canceled'].includes(F(o, 'Stage'))
  );
  const pipeline = activeOpps.reduce((s, o) => s + (o.fields?.['Value'] || 0), 0);

  // ── Branding from Settings (used in all 3 report types) ──
  const reportBranding = (() => {
    try { return JSON.parse(localStorage.getItem('oike_proposal_branding') || '{}'); } catch { return {}; }
  })();
  const RB_NAME    = reportBranding.senderName || COMPANY_PROFILE.senderName || 'Alejandra Cadario';
  const RB_TITLE   = reportBranding.senderTitle || '';
  const RB_EMAIL   = reportBranding.senderEmail || CURRENT_USER?.email || '';
  const RB_PHOTO   = reportBranding.senderPhoto || '';
  const RB_LOGO    = reportBranding.senderLogo || '';
  const RB_PRIMARY   = reportBranding.accentColor    || '#5BBFB5';
  const RB_SECONDARY = reportBranding.secondaryColor || '#A78BFA';
  const RB_TERTIARY  = reportBranding.tertiaryColor  || '#FBBF24';
  const RB_DARK    = reportBranding.darkColor      || '#1A1A2E';

  // ── HTML generator ──
  const generateHtml = async () => {
    setGenerating(true);
    try {
    const T  = RB_DARK;
    const G  = RB_PRIMARY;
    const GR = '#4A4A4A';
    const LG = '#F5F5F5';

    const dateLabel = `${new Date(dateFrom).toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${new Date(dateTo).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`;

    // Generic per-group breakdown (adapts to groupBy type)
    const groupRows = activeItems.map(item => {
      let itemAccIds = [];
      let itemOut = [];

      if (groupBy === 'accounts') {
        itemAccIds = [item.id];
        itemOut = periodOutreach.filter(o => linkedIds(o,'Account').includes(item.id));
      } else if (groupBy === 'solutions') {
        itemAccIds = (solAccMap[item.id] || []).filter(id => displayAccIds.includes(id));
        itemOut = periodOutreach.filter(o => linkedIds(o,'Account').some(id => itemAccIds.includes(id)));
      } else if (groupBy === 'campaigns') {
        itemOut = periodOutreach.filter(o => linkedIds(o,'Campaign').includes(item.id));
        itemAccIds = [...new Set(itemOut.flatMap(o => linkedIds(o,'Account')))];
      } else if (groupBy === 'events') {
        const invitedStkIds = new Set(linkedIds(item, 'Stakeholders invited'));
        itemOut = periodOutreach.filter(o => linkedIds(o,'Stakeholder').some(id => invitedStkIds.has(id)));
        itemAccIds = [...new Set(itemOut.flatMap(o => linkedIds(o,'Account')))];
      } else if (groupBy === 'cp') {
        // All accounts assigned to this CP, then outreach on those accounts
        itemAccIds = accounts.filter(a => linkedIds(a,'CP').includes(item.id)).map(a => a.id);
        itemOut = periodOutreach.filter(o => linkedIds(o,'Account').some(id => itemAccIds.includes(id)));
      }

      const itemAccs = accounts.filter(a => itemAccIds.includes(a.id));
      const itemAllReplies = itemOut.filter(o => F(o,'Status') === 'Replied');
      const itemUniqueStkIds = new Set(itemAllReplies.flatMap(o => linkedIds(o,'Stakeholder')).filter(Boolean));
      const itemUniqueReplies = itemUniqueStkIds.size || itemAllReplies.length;
      const itemMeetings = itemOut.filter(o => ['Meeting Scheduled','Meeting Booked'].includes(F(o,'Status')));
      const itemBounced = itemOut.filter(o => F(o,'Status') === 'Bounced');
      const rr = itemOut.length > 0 ? Math.round(itemUniqueReplies/itemOut.length*100) : 0;
      return {
        item,
        name: F(item, allOptions.nameField) || '—',
        accs: itemAccs,
        sent: itemOut.length,
        replies: itemUniqueReplies,
        meetings: itemMeetings.length,
        bounced: itemBounced.length,
        rr,
      };
    }).filter(r => r.sent > 0 || r.accs.length > 0);

    // Reply details — AI-generated one-liner status per contact
    const replyRaw = replies.slice(0, 20).map(o => {
      const stkId = linkedIds(o,'Stakeholder')[0];
      const stk   = stakeholders.find(s => s.id === stkId);
      const accId = linkedIds(o,'Account')[0] || (stk ? linkedIds(stk,'Account')[0] : null);
      const acc   = accounts.find(a => a.id === accId);
      const rawMsg = (F(o,'Notes') || F(o,'Message') || '')
        .replace(/\[gmsg:[^\]]+\]\n?/g, '')
        .replace(/[-─]+\s*(Forwarded message|Original message|De:|From:).*/si, '')
        .replace(/^Subject:\s*.*/im, '')
        .trim().slice(0, 300);
      const d = o.fields?.['Date'] ? new Date(o.fields['Date']).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '';
      return { stk, acc, rawMsg, d, channel: F(o,'Channel') || '' };
    });

    // Ask AI for one-liner status per contact + strategic thoughts
    let aiAnalysis = {}; // per-reply structured analysis { "1": { intent, summary, next_step, urgency } }
    let aiThoughts = '';
    const groupSummary = groupRows.map(r => `${r.name}: ${r.sent} sent, ${r.replies} replies (${r.rr}%), ${r.meetings} meetings${r.accs.length ? `, accounts: ${r.accs.map(a=>F(a,'Account Name')).join(', ')}` : ''}`).join('\n');
    const replyLines = replyRaw.map((r, i) => {
      const name = r.stk ? `${F(r.stk,'Name')||''} ${F(r.stk,'Last name')||''}`.trim() : 'Unknown';
      const company = r.acc ? F(r.acc,'Account Name') : '';
      const role = r.stk ? F(r.stk,'Role') || '' : '';
      return `${i+1}. ${name}${role ? ' (' + role + ')' : ''} at ${company} [${r.d}]: "${r.rawMsg}"`;
    }).join('\n');

    if (replyRaw.length > 0 || groupRows.length > 0) {
      try {
        const prompt = `You are a senior sales intelligence analyst reviewing a bi-weekly sales report. Do TWO things:

1. For each reply (numbered), return structured analysis — not verbatim summary, but a SALES INTERPRETATION. What do they actually mean? What should the BDR do next? The goal is: the BDR reads this and knows exactly what action to take.

2. Write 3-4 bullet points of STRATEGIC THOUGHTS — what's working, what's at risk, what needs immediate attention, suggested priorities. Be direct, specific, useful. Reference actual accounts/contacts when relevant.
${reportNotes.trim() ? `\nSender's own notes for context:\n"${reportNotes.trim()}"\n` : ''}
PERIOD: ${dateLabel}
BREAKDOWN BY ${allOptions.label.toUpperCase()}:
${groupSummary || 'No items in scope'}

TOTAL: ${totalSent} messages sent, ${uniqueRepliers} unique replies (${replyRate}%), ${meetings.length} meetings

REPLIES:
${replyLines || 'None'}

For each reply, return:
- intent: one of "meeting_request" | "info_request" | "objection" | "follow_up_needed" | "engaged" | "introduction_needed" | "not_now" | "ghosted" | "other"
- summary: 1 sentence interpretation of what they're really saying (not a repeat of the reply — a READ of it)
- next_step: SPECIFIC action the BDR should take (e.g. "Send 3 time slots for next week", "Forward case study to decision maker", "Ask for intro to Head of IT", "Close the loop with breakup message")
- urgency: "high" (requires action this week) | "medium" (within 2 weeks) | "low" (no rush)

Return ONLY valid JSON:
{
  "analysis": {
"1": { "intent": "...", "summary": "...", "next_step": "...", "urgency": "..." },
"2": { ... }
  },
  "thoughts": ["bullet 1", "bullet 2", "bullet 3", "bullet 4"]
}`;

        const result = await callOpenAI({ prompt, temperature: 0.4, max_tokens: 1600 });
        const cleaned = result.replace(/```json?\n?/g,'').replace(/```/g,'').trim();
        const parsed = JSON.parse(cleaned);
        aiAnalysis = parsed.analysis || {};
        aiThoughts = (parsed.thoughts || []).join('|||');
      } catch(e) {
        console.error('AI analysis failed:', e);
        // Fallback: basic structured data
        if (replyRaw.length > 0) {
          try {
            const p2 = `For each reply, return short JSON: {"1":{"intent":"engaged","summary":"...","next_step":"...","urgency":"medium"}, ...}\n\nReplies:\n${replyLines}`;
            const r2 = await callOpenAI({ prompt: p2, temperature: 0.3, max_tokens: 800 });
            const parsed2 = JSON.parse(r2.replace(/```json?\n?/g,'').replace(/```/g,'').trim());
            aiAnalysis = parsed2.analysis || parsed2 || {};
          } catch(e2) { console.error('Fallback failed:', e2); }
        }
      }
    }

    const replyDetails = replyRaw.map((r, i) => {
      const a = aiAnalysis[String(i+1)] || {};
      return {
        ...r,
        intent: a.intent || 'other',
        summary: a.summary || r.rawMsg.split(/[.!?]\s+/)[0]?.trim().slice(0,120) || '—',
        next_step: a.next_step || '',
        urgency: a.urgency || 'medium',
      };
    });

    const kpiBox = (label, value, color) =>
      `<td style="width:25%;padding:16px 12px;text-align:center;background:#fff;border-radius:8px;border:1px solid #e5e7eb;">
        <div style="font-size:28px;font-weight:800;color:${color};line-height:1;">${value}</div>
        <div style="font-size:11px;color:#6b7280;margin-top:6px;text-transform:uppercase;letter-spacing:0.5px;">${label}</div>
      </td>`;

    // Column labels adapt to groupBy type
    const firstColLabel = allOptions.label.replace(/s$/, ''); // Solutions → Solution, Accounts → Account, etc.
    const secondColLabel = groupBy === 'accounts' ? 'Stakeholders reached' : 'Accounts';
    const groupSection = groupRows.length === 0 ? '' : `
      <tr><td style="padding:0 0 8px;">
        <h2 style="margin:0 0 16px;font-size:16px;font-weight:700;color:${T};border-bottom:2px solid ${G};padding-bottom:8px;">By ${allOptions.label}</h2>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr style="background:${T};">
            ${[firstColLabel, secondColLabel,'Sent','Replies','Reply %','Meetings','Bounced'].map(h=>`<th style="padding:8px 10px;text-align:left;font-size:11px;color:#fff;font-weight:600;">${h}</th>`).join('')}
          </tr>
          ${groupRows.map((r,i) => {
            // For accounts groupBy, second column shows stakeholder count instead of the same account name
            let secondCol = '';
            if (groupBy === 'accounts') {
              const stkCount = stakeholders.filter(s => linkedIds(s,'Account').includes(r.item.id)).length;
              secondCol = `${stkCount} stakeholder${stkCount!==1?'s':''}`;
            } else {
              secondCol = r.accs.map(a=>F(a,'Account Name')).join(', ') || '—';
            }
            return `
          <tr style="background:${i%2===0?'#fff':LG};">
            <td style="padding:8px 10px;font-size:13px;font-weight:600;color:${T};">${r.name}</td>
            <td style="padding:8px 10px;font-size:12px;color:${GR};">${secondCol}</td>
            <td style="padding:8px 10px;font-size:13px;font-weight:700;color:${GR};">${r.sent}</td>
            <td style="padding:8px 10px;font-size:13px;font-weight:700;color:${r.replies>0?'#059669':'#9ca3af'};">${r.replies}</td>
            <td style="padding:8px 10px;font-size:13px;font-weight:700;color:${r.rr>=20?'#059669':r.rr>=10?'#d97706':'#9ca3af'};">${r.rr}%</td>
            <td style="padding:8px 10px;font-size:13px;font-weight:700;color:${r.meetings>0?'#2563eb':'#9ca3af'};">${r.meetings}</td>
            <td style="padding:8px 10px;font-size:13px;font-weight:700;color:${r.bounced>0?'#ea580c':'#9ca3af'};">${r.bounced > 0 ? `📭 ${r.bounced}` : '—'}</td>
          </tr>`;
          }).join('')}
        </table>
      </td></tr>`;

    // Group replies by account
    const replyByAcc = {};
    replyDetails.forEach(r => {
      const key = r.acc ? (F(r.acc,'Account Name')||'No account') : 'No account';
      if (!replyByAcc[key]) replyByAcc[key] = [];
      replyByAcc[key].push(r);
    });
    const replyGroups = Object.entries(replyByAcc).sort((a,b) => b[1].length - a[1].length);

    // Intent → label + color map
    const INTENT_STYLES = {
      meeting_request:     { label: '📅 Meeting request', bg: '#dbeafe', fg: '#1e40af' },
      info_request:        { label: '📎 Info request',    bg: '#e0e7ff', fg: '#4338ca' },
      objection:           { label: '🚧 Objection',       bg: '#fee2e2', fg: '#b91c1c' },
      follow_up_needed:    { label: '🔁 Follow-up needed',bg: '#fef3c7', fg: '#92400e' },
      engaged:             { label: '✅ Engaged',          bg: '#d1fae5', fg: '#065f46' },
      introduction_needed: { label: '🔗 Intro needed',    bg: '#f3e8ff', fg: '#6b21a8' },
      not_now:             { label: '⏰ Not now',         bg: '#f3f4f6', fg: '#374151' },
      ghosted:             { label: '👻 Ghosted',         bg: '#f3f4f6', fg: '#6b7280' },
      other:               { label: '💬 Reply',           bg: '#f3f4f6', fg: '#374151' },
    };
    const URGENCY_STYLES = {
      high:   { label: '🔥 HIGH',   fg: '#dc2626' },
      medium: { label: '⏳ MEDIUM', fg: '#d97706' },
      low:    { label: '🌙 LOW',    fg: '#6b7280' },
    };

    const replySection = replyDetails.length === 0 ? '' : `
      <tr><td style="padding:24px 0 8px;">
        <h2 style="margin:0 0 16px;font-size:16px;font-weight:700;color:${T};border-bottom:2px solid ${G};padding-bottom:8px;">Replies Received — action-ready (${uniqueRepliers} contact${uniqueRepliers !== 1 ? 's' : ''})</h2>
        ${replyGroups.map(([accName, rList]) => `
        <div style="margin-bottom:16px;">
          <div style="font-size:12px;font-weight:700;color:${G};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;padding:4px 0;border-bottom:1px solid #d1fae5;">
            🏢 ${accName} <span style="font-weight:400;color:#9ca3af;">(${rList.length} contact${rList.length>1?'s':''})</span>
          </div>
          ${rList.map(r => {
            const name = r.stk ? `${F(r.stk,'Name')||''} ${F(r.stk,'Last name')||''}`.trim() : 'Unknown';
            const role = r.stk ? (F(r.stk,'Role')||'') : '';
            const intent = INTENT_STYLES[r.intent] || INTENT_STYLES.other;
            const urg = URGENCY_STYLES[r.urgency] || URGENCY_STYLES.medium;
            return `
          <div style="margin-bottom:10px;padding:12px 14px;background:#f0fdf4;border-left:3px solid #10b981;border-radius:0 6px 6px 0;">
            <table width="100%" cellpadding="0" cellspacing="0"><tr>
              <td>
                <div style="font-size:13px;font-weight:700;color:${T};">${name}</div>
                ${role ? `<div style="font-size:11px;color:#6b7280;margin-top:1px;">${role}</div>` : ''}
              </td>
              <td style="text-align:right;vertical-align:top;white-space:nowrap;">
                <span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:${intent.bg};color:${intent.fg};margin-right:4px;">${intent.label}</span>
                <span style="font-size:10px;font-weight:700;color:${urg.fg};">${urg.label}</span>
                <div style="font-size:10px;color:#9ca3af;margin-top:2px;">${r.channel} · ${r.d}</div>
              </td>
            </tr></table>
            ${r.summary ? `<div style="font-size:13px;color:${T};margin-top:8px;line-height:1.45;font-weight:500;">${r.summary}</div>` : ''}
            ${r.next_step ? `<div style="margin-top:8px;padding:7px 10px;background:#fff;border-left:2px solid ${G};border-radius:0 4px 4px 0;font-size:12px;color:${T};">
              <span style="font-size:9px;font-weight:700;color:${G};letter-spacing:1px;text-transform:uppercase;">➤ Next step</span><br>
              <span style="color:${GR};">${r.next_step}</span>
            </div>` : ''}
          </div>`;
          }).join('')}
        </div>`).join('')}
      </td></tr>`;

    // ── Meetings-only section ──
    const meetingsList = periodOutreach.filter(o => ['Meeting Scheduled','Meeting Booked'].includes(F(o, 'Status')));
    const meetingsSection = meetingsList.length === 0 ? '' : `
      <tr><td style="padding:24px 0 8px;">
        <h2 style="margin:0 0 16px;font-size:16px;font-weight:700;color:${T};border-bottom:2px solid ${G};padding-bottom:8px;">📅 Meetings Booked (${meetingsList.length})</h2>
        ${meetingsList.map(o => {
          const stkId = linkedIds(o,'Stakeholder')[0];
          const stk = stakeholders.find(s => s.id === stkId);
          const stkName = stk ? `${F(stk,'Name')||''} ${F(stk,'Last name')||''}`.trim() : 'Unknown';
          const stkRole = stk ? F(stk,'Role') || '' : '';
          const accId = linkedIds(o,'Account')[0];
          const acc = accounts.find(a => a.id === accId);
          const accName = acc ? F(acc,'Account Name') : '';
          const d = o.fields?.['Date'] ? new Date(o.fields['Date']).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '?';
          return `
          <div style="margin-bottom:8px;padding:10px 14px;background:#dbeafe;border-left:3px solid #2563eb;border-radius:0 6px 6px 0;">
            <div style="font-size:13px;font-weight:700;color:${T};">${stkName}${accName ? ' · ' + accName : ''}</div>
            ${stkRole ? `<div style="font-size:11px;color:#6b7280;margin-top:1px;">${stkRole}</div>` : ''}
            <div style="font-size:11px;color:#2563eb;font-weight:700;margin-top:4px;">📅 ${d}</div>
            ${F(o,'Notes') ? `<div style="font-size:11px;color:${GR};margin-top:4px;">${String(F(o,'Notes')).slice(0,200)}</div>` : ''}
          </div>`;
        }).join('')}
      </td></tr>`;

    // ── Content Lab posts section ──
    const periodPosts = (contentLab || []).filter(p => {
      const date = F(p, 'Posted Date') || p.createdTime;
      if (!date) return false;
      const ts = new Date(date).getTime();
      return ts >= fromTs && ts <= toTs;
    });
    const postsSection = periodPosts.length === 0 ? '' : `
      <tr><td style="padding:24px 0 8px;">
        <h2 style="margin:0 0 16px;font-size:16px;font-weight:700;color:${T};border-bottom:2px solid ${G};padding-bottom:8px;">✍️ Content Posted (${periodPosts.length})</h2>
        ${periodPosts.map(p => {
          const title = F(p,'Title') || 'Untitled';
          const type = F(p,'Type') || 'Post';
          const status = F(p,'Status') || 'Draft';
          const postedDate = F(p,'Posted Date') || '';
          const url = F(p,'LinkedIn URL') || '';
          const tags = F(p,'Topic Tags');
          const tagsText = Array.isArray(tags) ? tags.join(' · ') : '';
          const statusColor = status === 'Posted' ? '#059669' : status === 'Scheduled' ? '#d97706' : '#6b7280';
          return `
          <div style="margin-bottom:8px;padding:10px 14px;background:#f5f3ff;border-left:3px solid #7c3aed;border-radius:0 6px 6px 0;">
            <div style="font-size:13px;font-weight:700;color:${T};">${title}</div>
            <div style="font-size:10px;color:#9ca3af;margin-top:2px;">
              <span style="color:${statusColor};font-weight:700;">${status}</span> · ${type}${postedDate ? ' · ' + postedDate : ''}${tagsText ? ' · ' + tagsText : ''}
            </div>
            ${url ? `<div style="font-size:11px;margin-top:4px;"><a href="${url}" style="color:#7c3aed;">🔗 View on LinkedIn</a></div>` : ''}
          </div>`;
        }).join('')}
      </td></tr>`;

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;">

  <!-- Header -->
  <tr><td style="background:${T};padding:24px 28px;border-radius:12px 12px 0 0;">
<div style="display:flex;justify-content:space-between;align-items:center;">
  <div>
    ${RB_LOGO
      ? `<img src="${RB_LOGO}" alt="Logo" style="max-height:36px;max-width:140px;margin-bottom:6px;" />`
      : `<div style="font-size:22px;font-weight:800;color:${G};letter-spacing:1px;">OIKE</div>`
    }
    <div style="font-size:12px;color:#9ca3af;margin-top:2px;">Sales Activity Report</div>
  </div>
  <div style="text-align:right;">
    <div style="font-size:13px;color:#e5e7eb;font-weight:600;">${dateLabel}</div>
    <div style="font-size:11px;color:#6b7280;margin-top:2px;">Prepared by ${RB_NAME}</div>
  </div>
</div>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:#fff;padding:28px;border-radius:0 0 12px 12px;">
<table width="100%" cellpadding="0" cellspacing="0">

  <!-- KPIs -->
  <tr><td style="padding:0 0 24px;">
    <h2 style="margin:0 0 16px;font-size:16px;font-weight:700;color:${T};border-bottom:2px solid ${G};padding-bottom:8px;">Overview</h2>
    <table width="100%" cellpadding="6" cellspacing="8">
      <tr>
        ${kpiBox('Messages Sent', totalSent, T)}
        ${kpiBox('Accounts Touched', accsContacted, '#2563eb')}
        ${kpiBox('Reply Rate', replyRate+'%', replyRate>=20?'#059669':replyRate>=10?'#d97706':'#ef4444')}
        ${kpiBox('Meetings', meetings.length, meetings.length>0?'#059669':'#9ca3af')}
        ${bounced.length > 0 ? kpiBox('📭 Bounced', bounced.length, '#ea580c') : ''}
      </tr>
    </table>
  </td></tr>

  ${reportFilter === 'all' ? groupSection : ''}
  ${(reportFilter === 'all' || reportFilter === 'replies') ? replySection : ''}
  ${(reportFilter === 'all' || reportFilter === 'meetings') ? meetingsSection : ''}
  ${(reportFilter === 'all' || reportFilter === 'posts') ? postsSection : ''}

  <!-- Pipeline -->
  ${activeOpps.length > 0 ? `
  <tr><td style="padding:24px 0 8px;">
    <h2 style="margin:0 0 16px;font-size:16px;font-weight:700;color:${T};border-bottom:2px solid ${G};padding-bottom:8px;">Pipeline</h2>
    <table width="100%" cellpadding="0" cellspacing="8">
      <tr>
        <td style="padding:14px 16px;background:#eff6ff;border-radius:8px;text-align:center;width:50%;">
          <div style="font-size:22px;font-weight:800;color:#1d4ed8;">${activeOpps.length}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:4px;text-transform:uppercase;">Open Opportunities</div>
        </td>
        <td style="padding:14px 16px;background:#f0fdf4;border-radius:8px;text-align:center;width:50%;">
          <div style="font-size:22px;font-weight:800;color:#059669;">${formatCurrency(pipeline)}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:4px;text-transform:uppercase;">Pipeline Value</div>
        </td>
      </tr>
    </table>
  </td></tr>` : ''}

  ${aiThoughts ? `
  <!-- AI Thoughts -->
  <tr><td style="padding:24px 0 8px;">
    <h2 style="margin:0 0 16px;font-size:16px;font-weight:700;color:${T};border-bottom:2px solid ${G};padding-bottom:8px;">🧠 Strategic Analysis</h2>
    <div style="padding:14px 16px;background:#f8f4ff;border-left:4px solid #8b5cf6;border-radius:0 8px 8px 0;">
      ${aiThoughts.split('|||').map(b => `<div style="display:flex;gap:10px;margin-bottom:8px;font-size:13px;color:#374151;line-height:1.6;"><span style="color:#8b5cf6;font-weight:700;flex-shrink:0;">▸</span><span>${b.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span></div>`).join('')}
    </div>
  </td></tr>` : ''}

  ${reportNotes.trim() ? `
  <!-- Notes -->
  <tr><td style="padding:24px 0 8px;">
    <h2 style="margin:0 0 16px;font-size:16px;font-weight:700;color:${T};border-bottom:2px solid ${G};padding-bottom:8px;">Notes & Next Steps</h2>
    <div style="padding:14px 16px;background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;font-size:13px;color:${GR};line-height:1.7;white-space:pre-wrap;">${reportNotes.trim().replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
  </td></tr>` : ''}

  <!-- Sender block + Footer -->
  <tr><td style="padding:24px 0 0;border-top:1px solid #e5e7eb;margin-top:24px;">
    ${(RB_PHOTO || RB_TITLE || RB_NAME) ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;"><tr>
      ${RB_PHOTO ? `<td width="64" valign="middle" style="padding-right:12px;"><img src="${RB_PHOTO}" alt="${RB_NAME}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:2px solid ${G};" /></td>` : ''}
      <td valign="middle">
        <div style="font-size:13px;font-weight:700;color:${T};">${RB_NAME}</div>
        ${RB_TITLE ? `<div style="font-size:11px;color:#6b7280;margin-top:2px;">${RB_TITLE}</div>` : ''}
        ${RB_EMAIL ? `<div style="font-size:11px;color:#6b7280;margin-top:2px;"><a href="mailto:${RB_EMAIL}" style="color:${G};text-decoration:none;">${RB_EMAIL}</a></div>` : ''}
      </td>
    </tr></table>` : ''}
    <div style="font-size:11px;color:#9ca3af;text-align:center;">
      Generated by <strong style="color:${G};">Oike</strong> · ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}
    </div>
  </td></tr>

</table>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

    setReportHtml(html);
    // Cache the structured replies so the user can turn them into urgent tasks
    setLastReplyDetails(replyDetails);
    setTasksCreatedCount(0);
  } catch(e) {
    console.error('Report generation failed:', e);
  } finally {
    setGenerating(false);
  }
  };

  // ── Convert AI-analyzed replies into Action Plan tasks (High + Medium urgency) ──
  const generateUrgentTasks = async () => {
    if (!api || !TABLE_IDS.actionPlan) {
      window.__oikeToast('Action Plan table not available.', 'warning');
      return;
    }
    const eligible = (lastReplyDetails || []).filter(r =>
      (r.urgency === 'high' || r.urgency === 'medium') && r.next_step && r.next_step.trim()
    );
    if (eligible.length === 0) {
      window.__oikeToast('No urgent actions to create — all replies are low urgency or have no next step.', 'warning');
      return;
    }
    setCreatingTasks(true);
    let created = 0;
    try {
      for (const r of eligible) {
        // Find the outreach record for this reply (match by stakeholder + Replied status)
        const outreachRec = r.stk
          ? outreach.find(o =>
              linkedIds(o, 'Stakeholder').includes(r.stk.id) &&
              F(o, 'Status') === 'Replied'
            )
          : null;
        const accId = r.acc?.id || (r.stk ? linkedIds(r.stk, 'Account')[0] : null);
        const stkName = r.stk ? `${F(r.stk,'Name')||''} ${F(r.stk,'Last name')||''}`.trim() : '';
        const urgencyLabel = r.urgency === 'high' ? 'High' : 'Medium';

        const fields = {
          'Nombre de la Acción': String(r.next_step).slice(0, 200),
          'Source': 'AI - Reply',
          'Urgency': urgencyLabel,
          'Intent': r.intent || 'other',
        };
        if (accId) fields['Cuenta'] = [accId];
        if (stkName) fields['Stakeholder'] = stkName;
        if (outreachRec) fields['Related Outreach'] = [outreachRec.id];

        try {
          const rec = await api.createRecord(TABLE_IDS.actionPlan, fields);
          if (onAddRecord) onAddRecord('actionPlan', rec.fields || fields, rec.id);
          created++;
        } catch(e) {
          console.error('Failed to create urgent task for', stkName, e);
        }
      }
      setTasksCreatedCount(created);
    } finally {
      setCreatingTasks(false);
    }
  };

  // ══════════════════════════════════════════════════════════
  // INTELLIGENCE RADAR REPORT — full AI radar for 1 account
  // ══════════════════════════════════════════════════════════

  const generateAccountBriefingHtml = async () => {
    const targetAccountId = intelFilterAccountIds[0];
    if (!targetAccountId) {
      window.__oikeToast('Pick exactly 1 account from the "Specific accounts" filter to generate an Intelligence Radar.', 'warning');
      return;
    }
    setGenerating(true);
    try {
      const BG = '#0D0D1A', CARD = '#1A1A2E', G = RB_PRIMARY, S = RB_SECONDARY, GR = '#94a3b8';

      const acc = accounts.find(a => a.id === targetAccountId);
      if (!acc) { window.__oikeToast('Account not found.', 'warning'); setGenerating(false); return; }

      const accName       = F(acc, 'Account Name') || 'Account';
      const accIndustry   = F(acc, 'Industry') || '';
      const accCountry    = F(acc, 'Country') || '';
      const accWebsite    = F(acc, 'Website') || '';
      const accNews       = F(acc, 'Recent News') || '';
      const accIntel      = F(acc, 'Intel Notes') || '';
      const accStatus     = F(acc, 'Inside Sales Status') || '';
      const accDescription= F(acc, 'Company Description') || '';
      const accSize       = F(acc, 'Company size') || '';

      const accIntelClean = accIntel
        ? String(accIntel).replace(/📎\s*FILE:[\s\S]*?(?=\n📎\s*FILE:|$)/g, '').trim()
        : '';

      // ── Stakeholders with HOT/WARM/COLD ──
      const accStks = stakeholders.filter(s => linkedIds(s, 'Account').includes(targetAccountId));
      const accOutreach = outreach
        .filter(o => linkedIds(o, 'Account').includes(targetAccountId))
        .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));

      const totalSent   = accOutreach.length;
      const replies     = accOutreach.filter(o => F(o, 'Status') === 'Replied').length;
      const meetings    = accOutreach.filter(o => ['Meeting Scheduled','Meeting Booked'].includes(F(o, 'Status'))).length;
      const lastTouch   = accOutreach[0];
      const lastTouchDate = lastTouch?.fields?.['Date']
        ? new Date(lastTouch.fields['Date']).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'Never';

      // ── Per-stakeholder outreach breakdown (for the outreach section) ──
      const AUTO_LOG_PATTERN = /auto.?logged|auto.?log|cp briefings|outreach logged/i;
      const stkTouchMap = {};
      accOutreach.forEach(o => {
        const stkId = linkedIds(o, 'Stakeholder')[0];
        if (!stkId) return;
        if (!stkTouchMap[stkId]) stkTouchMap[stkId] = { touches: 0, replied: false, meeting: false, interactions: [] };
        stkTouchMap[stkId].touches++;
        const status = F(o,'Status') || '';
        if (status === 'Replied') stkTouchMap[stkId].replied = true;
        if (['Meeting Scheduled','Meeting Booked'].includes(status)) stkTouchMap[stkId].meeting = true;
        const rawNote = (F(o,'Notes') || F(o,'Message') || '').trim();
        const note = AUTO_LOG_PATTERN.test(rawNote) ? '' : rawNote.slice(0, 150);
        const channel = F(o,'Channel') || '';
        const date = o.fields?.['Date'] ? new Date(o.fields['Date']).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        const subject = F(o,'Subject') || F(o,'Topic') || '';
        stkTouchMap[stkId].interactions.push({ status, channel, date, note, subject });
      });

      // ── Opportunities + Solutions ──
      const accOpps = opportunities.filter(o => linkedIds(o, 'Account').includes(targetAccountId));
      const openOpps = accOpps.filter(o => !['Closed Won','Closed/Won','Closed Lost','Closed/Lost','Closed/Canceled'].includes(F(o, 'Stage')));
      const pipelineValue = openOpps.reduce((sum, o) => sum + (o.fields?.['Value'] || 0), 0);
      const linkedSolIds = new Set(accOpps.flatMap(o => linkedIds(o, 'Solutions')));
      const linkedSols = solutions.filter(s => linkedSolIds.has(s.id));

      // ── Prompt context ──
      const stkSummary = accStks.slice(0, 12).map(s => {
        const sid = s.id;
        const t = stkTouchMap[sid];
        const temp = t?.meeting ? 'HOT🔥' : t?.replied ? 'WARM🌡️' : t?.touches > 0 ? 'WARM🌡️' : 'COLD❄️';
        const pain = (F(s,'Pain Points (Generated)') || F(s,'Pain points') || '').slice(0, 180);
        const signal = (F(s,'LinkedIn News (Generated)') || F(s,'Linkedin lates news') || '').slice(0, 120);
        const touchInfo = t ? ` · ${t.touches} touch${t.touches>1?'es':''}, ${t.replied?'replied':'no reply'}${t.meeting?', meeting booked':''}` : '';
        return `- ${F(s,'Name')||''} ${F(s,'Last name')||''}(${F(s,'Role')||'?'}) [${temp}]${touchInfo}\n${pain?'  Pain: '+pain:''}  ${signal?'\n  Signal: '+signal:''}`;
      }).join('\n');

      const oppsSummary = openOpps.slice(0, 5).map(o =>
        `- ${F(o,'Deal/Opp name')||'Untitled'} | Stage: ${F(o,'Stage')||'?'} | ${formatCurrency(o.fields?.['Value']||0)} | Next: ${F(o,'Next step')||'—'}`
      ).join('\n');

      const solSummary = linkedSols.map(s => `- ${F(s,'Name')}: ${(F(s,'Stakeholder Key Message') || F(s,'Service | Solution Detail') || '').slice(0,150)}`).join('\n');

      const radarPrompt = `You are a senior B2B sales intelligence analyst. Generate a Sales Intelligence Radar for this account. Return ONLY valid JSON.

ACCOUNT: ${accName}
Industry: ${accIndustry} · Country: ${accCountry} · Size: ${accSize}
Website: ${accWebsite}
Description: ${accDescription.slice(0,300)}
Inside Sales Status: ${accStatus}

RECENT NEWS:
${(typeof accNews === 'string' ? accNews : '').slice(0,1200)||'None'}

INTEL NOTES:
${accIntelClean.slice(0,800)||'None'}

STAKEHOLDERS (${accStks.length} mapped):
${stkSummary||'None yet'}

OUTREACH SUMMARY (total ${totalSent}, ${replies} replies, ${meetings} meetings, last touch ${lastTouchDate}):
${accOutreach.slice(0,6).map(o=>{
  const date = o.fields?.['Date'] ? new Date(o.fields['Date']).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '?';
  const sId = linkedIds(o,'Stakeholder')[0];
  const stk = sId ? stakeholders.find(s=>s.id===sId) : null;
  return `- ${date} · ${F(o,'Channel')||''} · ${F(o,'Status')||''} · ${stk?F(stk,'Name'):'Unknown'} · ${(F(o,'Notes')||F(o,'Message')||'').slice(0,100)}`;
}).join('\n')||'No outreach history'}

OPEN OPPORTUNITIES (${openOpps.length}, pipeline ${formatCurrency(pipelineValue)}):
${oppsSummary||'None'}

OFFERING WE ARE PROSPECTING WITH:
${solSummary||'None linked yet'}

Return JSON with EXACTLY these keys. Specific, data-driven. Use real names. If unknown, say so briefly.

{
  "tldr": "3 sentences max: biggest opportunity, key risk, one immediate action",
  "est_budget": "Estimated annual tech/services budget range. E.g. '$2M–5M'. If unknown: 'Unknown — discovery needed'",
  "portfolio_label": "1 line buyer profile, e.g. 'Digital transformation leader, early AI adopter'",
  "key_developments": [{ "headline": "...", "signal": "what this means for us", "source": "News/Intel/LinkedIn" }],
  "financial_signals": "2-3 sentences: financial health, investments, budget signals",
  "people_moves": [{ "name": "...", "move": "what changed", "relevance": "why it matters for our deal" }],
  "social_sentiment": "1-2 sentences: what are they signaling publicly?",
  "tech_stack": [{ "tool": "tool or platform", "category": "CRM/ERP/Cloud/Analytics/etc", "opportunity": "how we can replace, complement or integrate" }],
  "competitive": "2-3 sentences: who else could they evaluate? Our differentiation?",
  "hiring_signals": "1-2 sentences: what roles reveal their strategic priorities?",
  "upcoming_events": [{ "event": "...", "date": "...", "angle": "outreach hook or meeting trigger" }],
  "recommended_actions": [{ "priority": 1, "stakeholder": "Name or role", "temperature": "HOT/WARM/COLD", "action": "specific action", "channel": "LinkedIn/Email/Phone/WhatsApp", "rationale": "why now" }]
}

Rules: key_developments 2-4 items · people_moves only if real signals else [] · tech_stack 2-5 tools · upcoming_events only real events else [] · recommended_actions 3-5 ordered by priority · Return ONLY valid JSON no markdown.`;

      let rd = {};
      try {
        const raw = await callOpenAI({ prompt: radarPrompt, temperature: 0.5, max_tokens: 2800 });
        const cleaned = raw.replace(/```json?\n?/g,'').replace(/```/g,'').trim();
        rd = JSON.parse(cleaned);
      } catch (e) {
        console.error('Radar AI parse failed:', e);
        rd = { tldr: 'AI generation failed — check OpenAI proxy or try again.', est_budget: '', portfolio_label: '', key_developments: [], financial_signals: '', people_moves: [], social_sentiment: '', tech_stack: [], competitive: '', hiring_signals: '', upcoming_events: [], recommended_actions: [] };
      }

      const escape = (x) => String(x||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const dateLabel = `Generated ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`;

      // ── Temperature badge ──
      const tempHtml = (temp) => {
        const cfg = (temp||'').toUpperCase() === 'HOT'  ? { emoji:'🔥', color:'#f87171', bg:'rgba(239,68,68,0.18)' }
                   : (temp||'').toUpperCase() === 'WARM' ? { emoji:'🌡️', color:'#fb923c', bg:'rgba(251,146,60,0.18)' }
                   : { emoji:'❄️', color:'#94a3b8', bg:'rgba(148,163,184,0.12)' };
        return `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:800;padding:2px 9px;border-radius:10px;background:${cfg.bg};color:${cfg.color};">${cfg.emoji} ${escape((temp||'COLD').toUpperCase())}</span>`;
      };

      const secH = (icon, label, color='#5BBFB5') =>
        `<div style="font-size:10px;font-weight:800;color:${color};letter-spacing:1.5px;text-transform:uppercase;margin-bottom:10px;">${icon} ${label}</div>`;

      const card = (content, style='') =>
        `<div style="background:#1A1A2E;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:16px 18px;${style}">${content}</div>`;

      // ── Outreach per stakeholder (improved) ──
      const outreachByStk = accStks
        .filter(s => stkTouchMap[s.id])
        .map(s => {
          const sid = s.id;
          const t = stkTouchMap[sid];
          const sName = `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim() || 'Unknown';
          const sRole = F(s,'Role') || '';
          const tempLabel = t.meeting ? 'HOT' : t.replied ? 'WARM' : 'COLD';
          // Build interaction lines from real data (skip auto-logged empties)
          const interactionLines = (t.interactions||[]).slice(0,3).map(ix => {
            const parts = [];
            if (ix.date) parts.push(`<span style="color:#64748b;">${escape(ix.date)}</span>`);
            if (ix.channel) parts.push(`<span style="background:rgba(96,165,250,0.12);color:#60a5fa;padding:1px 6px;border-radius:4px;font-size:9px;">${escape(ix.channel)}</span>`);
            if (ix.status === 'Replied') parts.push(`<span style="color:#4ade80;font-size:9px;">✓ Replied</span>`);
            else if (['Meeting Scheduled','Meeting Booked'].includes(ix.status)) parts.push(`<span style="color:#a78bfa;font-size:9px;">📅 Meeting</span>`);
            const noteText = ix.note || ix.subject || '';
            return `<div style="margin-bottom:5px;line-height:1.5;">
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:2px;">${parts.join('')}</div>
              ${noteText?`<div style="font-size:11px;color:#94a3b8;">${escape(noteText)}</div>`:''}
            </div>`;
          }).join('');
          return `<div style="background:rgba(0,0,0,0.2);border-radius:10px;padding:12px 14px;margin-bottom:8px;">
            <table width="100%" cellpadding="0" cellspacing="0"><tr>
              <td valign="top">
                <div style="font-size:12px;font-weight:700;color:#e2e8f0;">${escape(sName)}</div>
                ${sRole?`<div style="font-size:10px;color:#64748b;">${escape(sRole)}</div>`:''}
              </td>
              <td style="text-align:right;vertical-align:top;white-space:nowrap;">
                ${tempHtml(tempLabel)}
                <div style="font-size:10px;color:#64748b;margin-top:4px;">${t.touches} touch${t.touches>1?'es':''}</div>
              </td>
            </tr></table>
            <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
              ${t.meeting?`<span style="font-size:9px;background:rgba(167,139,250,0.18);color:#a78bfa;padding:2px 8px;border-radius:6px;font-weight:700;">📅 Meeting booked</span>`:''}
              ${t.replied&&!t.meeting?`<span style="font-size:9px;background:rgba(74,222,128,0.15);color:#4ade80;padding:2px 8px;border-radius:6px;font-weight:700;">💬 Replied</span>`:''}
              ${!t.replied&&!t.meeting?`<span style="font-size:9px;background:rgba(148,163,184,0.12);color:#94a3b8;padding:2px 8px;border-radius:6px;font-weight:700;">📤 No reply yet</span>`:''}
            </div>
            ${interactionLines?`<div style="margin-top:8px;border-left:2px solid rgba(255,255,255,0.08);padding-left:10px;">${interactionLines}</div>`:''}
          </div>`;
        }).join('');

      // ── Solutions being prospected ──
      const solsHtml = linkedSols.length
        ? linkedSols.map(s => {
            const msg = F(s,'Stakeholder Key Message') || F(s,'Service | Solution Detail') || '';
            return `<div style="margin-bottom:8px;">
              <div style="font-size:12px;font-weight:700;color:#e2e8f0;">${escape(F(s,'Name')||'')}</div>
              ${msg?`<div style="font-size:11px;color:#94a3b8;margin-top:2px;">${escape(msg.slice(0,200))}</div>`:''}
            </div>`;
          }).join('')
        : `<div style="font-size:11px;color:#64748b;">No solutions linked yet — link via opportunities.</div>`;

      // ── Other HTML blocks ──
      const keyDevHtml = (rd.key_developments||[]).length
        ? (rd.key_developments||[]).map((d,i,arr) => `<div style="margin-bottom:${i<arr.length-1?'12px':'0'};padding-bottom:${i<arr.length-1?'12px':'0'};border-bottom:${i<arr.length-1?'1px solid rgba(255,255,255,0.05)':'none'};">
            <div style="font-size:12px;font-weight:700;color:#e2e8f0;margin-bottom:3px;">${escape(d.headline||'')}</div>
            <div style="font-size:11px;color:#5BBFB5;margin-bottom:2px;">→ ${escape(d.signal||'')}</div>
            ${d.source?`<div style="font-size:10px;color:#64748b;">Source: ${escape(d.source)}</div>`:''}
          </div>`).join('')
        : '<div style="font-size:11px;color:#64748b;">No key developments in data provided.</div>';

      const peopleMovesHtml = (rd.people_moves||[]).length
        ? (rd.people_moves||[]).map(m => `<div style="margin-bottom:10px;">
            <div style="font-size:12px;font-weight:700;color:#e2e8f0;">${escape(m.name||'')}</div>
            <div style="font-size:11px;color:#fb923c;margin-bottom:2px;">${escape(m.move||'')}</div>
            <div style="font-size:11px;color:#94a3b8;">${escape(m.relevance||'')}</div>
          </div>`).join('')
        : '<div style="font-size:11px;color:#64748b;">No significant people moves detected.</div>';

      const techStackHtml = (rd.tech_stack||[]).length
        ? (rd.tech_stack||[]).map(t => `<div style="margin-bottom:10px;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
              <span style="font-size:12px;font-weight:700;color:#e2e8f0;">${escape(t.tool||'')}</span>
              <span style="font-size:9px;background:rgba(148,163,184,0.12);color:#94a3b8;padding:2px 7px;border-radius:6px;">${escape(t.category||'')}</span>
            </div>
            ${t.opportunity?`<div style="font-size:11px;color:#5BBFB5;">⚡ ${escape(t.opportunity)}</div>`:''}
          </div>`).join('')
        : '<div style="font-size:11px;color:#64748b;">No tech stack signals identified.</div>';

      const eventsHtml = (rd.upcoming_events||[]).length
        ? (rd.upcoming_events||[]).map(ev => `<div style="margin-bottom:10px;">
            <div style="font-size:12px;font-weight:700;color:#e2e8f0;">${escape(ev.event||'')}</div>
            ${ev.date?`<div style="font-size:10px;color:#64748b;margin-bottom:2px;">📅 ${escape(ev.date)}</div>`:''}
            ${ev.angle?`<div style="font-size:11px;color:#38bdf8;">→ ${escape(ev.angle)}</div>`:''}
          </div>`).join('')
        : '<div style="font-size:11px;color:#64748b;">No upcoming events identified.</div>';

      const actionsHtml = (rd.recommended_actions||[]).length
        ? (rd.recommended_actions||[]).map((a,i) => `
          <div style="display:flex;gap:14px;align-items:flex-start;background:rgba(0,0,0,0.25);border-radius:10px;padding:12px 14px;margin-bottom:8px;">
            <div style="font-size:13px;font-weight:800;color:#5BBFB5;min-width:18px;padding-top:1px;">${i+1}</div>
            <div style="flex:1;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap;">
                <span style="font-size:12px;font-weight:700;color:#e2e8f0;">${escape(a.stakeholder||'')}</span>
                ${tempHtml(a.temperature)}
                ${a.channel?`<span style="font-size:10px;background:rgba(255,255,255,0.07);color:#94a3b8;padding:2px 8px;border-radius:6px;">${escape(a.channel)}</span>`:''}
              </div>
              <div style="font-size:13px;color:#e2e8f0;margin-bottom:4px;">${escape(a.action||'')}</div>
              ${a.rationale?`<div style="font-size:11px;color:#94a3b8;">${escape(a.rationale)}</div>`:''}
            </div>
          </div>`).join('')
        : '<div style="font-size:11px;color:#64748b;">No actions generated.</div>';

      // ── Full HTML Report ──
      const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>* { box-sizing: border-box; } body { margin:0;padding:0;background:#0D0D1A;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;line-height:1.6;color:#e2e8f0; } @media print { body { -webkit-print-color-adjust:exact;print-color-adjust:exact; } }</style>
</head><body>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0D0D1A;padding:24px 16px;">
<tr><td align="center">
<table width="860" cellpadding="0" cellspacing="0" style="max-width:860px;">

  <!-- Header -->
  <tr><td style="background:linear-gradient(135deg,#1e1040 0%,#0e1628 50%,#0d1a12 100%);padding:28px 32px;border-radius:14px 14px 0 0;border-bottom:2px solid rgba(91,191,181,0.3);">
<table width="100%" cellpadding="0" cellspacing="0"><tr>
  <td>
    ${RB_LOGO?`<img src="${RB_LOGO}" alt="Logo" style="max-height:30px;max-width:120px;margin-bottom:8px;" />`:`<div style="font-size:16px;font-weight:800;color:#5BBFB5;letter-spacing:2px;margin-bottom:8px;">OIKE</div>`}
    <div style="font-size:22px;color:#fff;font-weight:800;letter-spacing:-0.3px;">🔮 Sales Intelligence Radar</div>
    <div style="font-size:12px;color:#94a3b8;margin-top:4px;">AI-generated account intelligence · ${dateLabel}</div>
  </td>
  <td style="text-align:right;vertical-align:top;">
    <div style="font-size:14px;color:#e2e8f0;font-weight:700;">${escape(accName)}</div>
    <div style="font-size:11px;color:#94a3b8;margin-top:2px;">Prepared by ${RB_NAME}</div>
    <div style="font-size:11px;color:#94a3b8;margin-top:2px;">${escape(accIndustry)}${accCountry?' · '+escape(accCountry):''}</div>
  </td>
</tr></table>
  </td></tr>

  <!-- Stats bar -->
  <tr><td style="background:#131326;padding:16px 32px;border-bottom:1px solid rgba(255,255,255,0.06);">
<table width="100%" cellpadding="0" cellspacing="0"><tr>
  <td style="text-align:center;padding:0 10px;"><div style="font-size:22px;font-weight:800;color:#e2e8f0;">${accStks.length}</div><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Stakeholders</div></td>
  <td style="text-align:center;padding:0 10px;border-left:1px solid rgba(255,255,255,0.05);"><div style="font-size:22px;font-weight:800;color:#5BBFB5;">${totalSent}</div><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Outreach</div></td>
  <td style="text-align:center;padding:0 10px;border-left:1px solid rgba(255,255,255,0.05);"><div style="font-size:22px;font-weight:800;color:${replies>0?'#4ade80':'#64748b'};">${replies}</div><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Replies</div></td>
  <td style="text-align:center;padding:0 10px;border-left:1px solid rgba(255,255,255,0.05);"><div style="font-size:22px;font-weight:800;color:${meetings>0?'#a78bfa':'#64748b'};">${meetings}</div><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Meetings</div></td>
  <td style="text-align:center;padding:0 10px;border-left:1px solid rgba(255,255,255,0.05);"><div style="font-size:22px;font-weight:800;color:${pipelineValue>0?'#4ade80':'#64748b'};">${pipelineValue>0?formatCurrency(pipelineValue):'$0'}</div><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Pipeline</div></td>
  <td style="text-align:center;padding:0 10px;border-left:1px solid rgba(255,255,255,0.05);"><div style="font-size:12px;font-weight:600;color:#e2e8f0;">${escape(lastTouchDate)}</div><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Last Touch</div></td>
</tr></table>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:#0D0D1A;padding:24px 32px;">

<!-- TL;DR -->
<div style="background:linear-gradient(135deg,rgba(167,139,250,0.15) 0%,rgba(91,191,181,0.1) 100%);border:1px solid rgba(167,139,250,0.25);border-radius:12px;padding:18px 22px;margin-bottom:16px;">
  <div style="font-size:10px;font-weight:800;color:#a78bfa;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;">🔮 TL;DR</div>
  <p style="margin:0 0 12px;font-size:13px;color:#e2e8f0;line-height:1.65;">${escape(rd.tldr||'')}</p>
  <table cellpadding="0" cellspacing="0"><tr>
    ${rd.est_budget?`<td style="padding-right:8px;"><span style="display:inline-block;font-size:11px;background:rgba(74,222,128,0.12);color:#4ade80;padding:4px 12px;border-radius:8px;font-weight:600;">💰 ${escape(rd.est_budget)}</span></td>`:''}
    ${rd.portfolio_label?`<td><span style="display:inline-block;font-size:11px;background:rgba(96,165,250,0.12);color:#60a5fa;padding:4px 12px;border-radius:8px;font-weight:600;">🏷️ ${escape(rd.portfolio_label)}</span></td>`:''}
  </tr></table>
</div>

<!-- Key Developments | People Moves + Social -->
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;"><tr>
  <td valign="top" width="50%" style="padding-right:8px;">${card(secH('📰','Key Developments','#fbbf24') + keyDevHtml)}</td>
  <td valign="top" width="50%" style="padding-left:8px;">${card(secH('👥','People Moves','#fb923c') + peopleMovesHtml + '<div style="margin-top:14px;">' + secH('📣','Social Sentiment','#60a5fa') + `<p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6;">${escape(rd.social_sentiment||'—')}</p></div>`)}</td>
</tr></table>

<!-- Financial + Hiring | Tech Stack -->
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;"><tr>
  <td valign="top" width="50%" style="padding-right:8px;">${card(secH('💰','Financial Signals','#4ade80') + `<p style="margin:0 0 14px;font-size:12px;color:#94a3b8;line-height:1.6;">${escape(rd.financial_signals||'—')}</p>` + secH('💼','Hiring Signals','#a78bfa') + `<p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6;">${escape(rd.hiring_signals||'—')}</p>`)}</td>
  <td valign="top" width="50%" style="padding-left:8px;">${card(secH('⚙️','Tech Stack Map','#94a3b8') + techStackHtml)}</td>
</tr></table>

<!-- Competitive | Upcoming Events -->
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;"><tr>
  <td valign="top" width="50%" style="padding-right:8px;">${card(secH('🏆','Competitive Landscape','#f472b6') + `<p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">${escape(rd.competitive||'—')}</p>`)}</td>
  <td valign="top" width="50%" style="padding-left:8px;">${card(secH('📅','Upcoming Events','#38bdf8') + eventsHtml)}</td>
</tr></table>

<!-- Outreach History (per person) | Solutions Being Prospected -->
${(outreachByStk || linkedSols.length > 0) ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;"><tr>
  ${outreachByStk ? `<td valign="top" width="55%" style="padding-right:8px;">${card(secH('📬','Outreach by Person','#60a5fa') + (outreachByStk || '<div style="font-size:11px;color:#64748b;">No outreach recorded.</div>'))}</td>` : ''}
  <td valign="top" ${outreachByStk ? 'width="45%" style="padding-left:8px;"' : 'width="100%"'}>${card(secH('🎯','Offering We Are Prospecting','#5BBFB5') + solsHtml)}</td>
</tr></table>` : ''}

<!-- Recommended Actions -->
<div style="background:linear-gradient(135deg,rgba(91,191,181,0.12) 0%,rgba(91,191,181,0.05) 100%);border:1px solid rgba(91,191,181,0.2);border-radius:12px;padding:18px 22px;margin-bottom:20px;">
  ${secH('⚡','Recommended Actions','#5BBFB5')}
  ${actionsHtml}
</div>

<!-- Footer -->
<div style="padding-top:20px;border-top:1px solid rgba(255,255,255,0.07);">
  ${(RB_PHOTO || RB_TITLE) ? `<table cellpadding="0" cellspacing="0" style="margin-bottom:12px;"><tr>
    ${RB_PHOTO?`<td width="64" valign="middle" style="padding-right:12px;"><img src="${RB_PHOTO}" alt="${RB_NAME}" style="width:52px;height:52px;border-radius:50%;object-fit:cover;border:2px solid #5BBFB5;" /></td>`:''}
    <td valign="middle">
      <div style="font-size:13px;font-weight:700;color:#e2e8f0;">${RB_NAME}</div>
      ${RB_TITLE?`<div style="font-size:11px;color:#94a3b8;margin-top:2px;">${RB_TITLE}</div>`:''}
      ${RB_EMAIL?`<div style="font-size:11px;margin-top:2px;"><a href="mailto:${RB_EMAIL}" style="color:#5BBFB5;text-decoration:none;">${RB_EMAIL}</a></div>`:''}
    </td>
  </tr></table>` : ''}
  <div style="font-size:10px;color:#475569;text-align:center;letter-spacing:0.5px;">Generated by <strong style="color:#5BBFB5;">Oike</strong> · Sales Intelligence Radar · ${dateLabel}</div>
</div>

  </td></tr>
</table>
</td></tr></table>
</body></html>`;

      setReportHtml(html);
      setIntelInsights([]);
    } catch (e) {
      console.error('Intelligence Radar failed:', e);
      window.__oikeToast(`Failed to generate Intelligence Radar: ${e?.message || String(e, 'error')}`);
    } finally {
      setGenerating(false);
    }
  };

  const generateStakeholderPainsHtml = async () => {
    setGenerating(true);
    try {
      const T = RB_DARK, G = RB_PRIMARY, GR = '#4A4A4A';

      // Filter stakeholders
      let poolStks = stakeholders.filter(s => {
        // Must have pain or LinkedIn news to be useful
        const hasPain = !!(F(s, 'Pain Points (Generated)') || F(s, 'Pain points'));
        const hasLinkedin = !!(F(s, 'LinkedIn News (Generated)') || F(s, 'Linkedin lates news'));
        if (!hasPain && !hasLinkedin) return false;
        // Specific account filter wins over broader filters
        if (intelFilterAccountIds.length > 0) {
          const accIds = linkedIds(s, 'Account');
          if (!accIds.some(id => intelFilterAccountIds.includes(id))) return false;
          return true;
        }
        if (intelFilterCountry && F(s, 'Country') !== intelFilterCountry) return false;
        if (intelFilterInfluence && F(s, 'Level of Influence') !== intelFilterInfluence) return false;
        if (intelFilterIndustry) {
          const accId = linkedIds(s, 'Account')[0];
          const acc = accId ? accounts.find(a => a.id === accId) : null;
          if (!acc || F(acc, 'Industry') !== intelFilterIndustry) return false;
        }
        return true;
      });

      // Group by intelGroupBy
      const groups = {};
      poolStks.forEach(s => {
        let key = '';
        if (intelGroupBy === 'industry') {
          const accId = linkedIds(s, 'Account')[0];
          const acc = accId ? accounts.find(a => a.id === accId) : null;
          key = acc ? (F(acc, 'Industry') || 'Uncategorized') : 'No account';
        } else if (intelGroupBy === 'role') {
          key = F(s, 'Role') || 'Unknown role';
        } else if (intelGroupBy === 'country') {
          key = F(s, 'Country') || 'Unknown';
        } else {
          // Default: industry
          const accId = linkedIds(s, 'Account')[0];
          const acc = accId ? accounts.find(a => a.id === accId) : null;
          key = acc ? (F(acc, 'Industry') || 'Uncategorized') : 'No account';
        }
        if (!groups[key]) groups[key] = [];
        groups[key].push(s);
      });

      const groupEntries = Object.entries(groups).sort((a,b) => b[1].length - a[1].length);
      const insights = [];
      const groupSections = [];

      for (const [groupLabel, groupStks] of groupEntries) {
        // Aggregate pains + LinkedIn
        const painsRaw = groupStks.map(s => {
          const pain = F(s, 'Pain Points (Generated)') || F(s, 'Pain points') || '';
          if (!pain) return null;
          const name = `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim();
          return { name, role: F(s,'Role')||'', text: String(pain).slice(0, 300) };
        }).filter(Boolean);

        const linkedinRaw = groupStks.map(s => {
          const news = F(s, 'LinkedIn News (Generated)') || F(s, 'Linkedin lates news') || '';
          if (!news) return null;
          const name = `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim();
          return { name, role: F(s,'Role')||'', text: String(news).slice(0, 250) };
        }).filter(Boolean);

        // Opportunities for this group (if enabled)
        let oppsValue = 0;
        let oppsCount = 0;
        if (intelIncludeOpps) {
          const groupAccIds = new Set(groupStks.flatMap(s => linkedIds(s, 'Account')));
          const groupOpps = opportunities.filter(o =>
            linkedIds(o, 'Account').some(id => groupAccIds.has(id)) &&
            !['Closed Won','Closed/Won','Closed Lost','Closed/Lost','Closed/Canceled'].includes(F(o,'Stage'))
          );
          oppsCount = groupOpps.length;
          oppsValue = groupOpps.reduce((s,o) => s + (o.fields?.['Value'] || 0), 0);
        }

        // AI aggregates pains + themes + timing + suggested campaign
        let aiBlock = { top_pains: [], linkedin_themes: [], timing_signals: [], exec_summary: '', suggested_campaign: null };
        try {
          const prompt = `You are a senior B2B sales strategist. Analyze a group of stakeholders and synthesize aggregated insights. DO NOT list them one by one — synthesize patterns.

GROUP: ${groupLabel} (${groupStks.length} stakeholders)
${intelIncludeOpps ? `OPPORTUNITIES IN GROUP: ${oppsCount} open, total value: ${formatCurrency(oppsValue)}` : ''}

PAIN POINTS ACROSS THE GROUP:
${painsRaw.slice(0, 30).map(p => `- ${p.name} (${p.role}): ${p.text}`).join('\n') || '— none —'}

LINKEDIN NEWS / UPDATES ACROSS THE GROUP:
${linkedinRaw.slice(0, 30).map(l => `- ${l.name} (${l.role}): ${l.text}`).join('\n') || '— none —'}

Return JSON:
{
  "top_pains": [
{ "pain": "short pain label (5-8 words)", "frequency": "X of N mention this", "example": "1 concrete example quote" }
  ],
  "linkedin_themes": [
{ "theme": "short theme label", "details": "1 sentence on what's happening" }
  ],
  "timing_signals": [
{ "signal": "specific trigger (promotion, funding, expansion, rebranding, etc.)", "who": "who triggered it" }
  ],
  "exec_summary": "4-6 sentences: What is this cohort dealing with? What's the narrative? What's the opportunity? Reference real pains and real LinkedIn signals.",
  "suggested_campaign": {
"name": "descriptive campaign name (max 60 chars) that captures the pain/trigger",
"type": "White Paper | News / Article | Product Launch | Case Study | Cold Outreach",
"context": "2-3 short paragraphs: target cohort (role + industry), the core pain this campaign addresses, the angle/hook, what outcome we want from each touch. This becomes AI context for personalized messages."
  }
}

Extract max 5 top_pains, max 4 themes, max 4 timing_signals. Be specific — no generic BS.
Return ONLY valid JSON.`;
          const raw = await callOpenAI({ prompt, temperature: 0.5, max_tokens: 1400 });
          const cleaned = raw.replace(/```json?\n?/g,'').replace(/```/g,'').trim();
          aiBlock = JSON.parse(cleaned);
        } catch (e) {
          console.error('Stakeholder pains AI failed for group', groupLabel, e);
          aiBlock.exec_summary = `${groupStks.length} stakeholders in ${groupLabel}. ${painsRaw.length} with pains, ${linkedinRaw.length} with LinkedIn data.`;
        }

        insights.push({
          groupKey: groupLabel,
          groupLabel,
          execSummary: aiBlock.exec_summary,
          suggestedCampaign: aiBlock.suggested_campaign,
          stakeholderIds: groupStks.map(s => s.id),
        });

        groupSections.push(`
          <tr><td style="padding:18px 0 8px;">
            <h2 style="margin:0 0 12px;font-size:16px;font-weight:700;color:${T};border-bottom:2px solid ${G};padding-bottom:8px;">
              🎯 ${groupLabel} <span style="font-size:12px;font-weight:400;color:#9ca3af;">(${groupStks.length} stakeholder${groupStks.length!==1?'s':''})</span>
            </h2>

            ${aiBlock.exec_summary ? `
            <div style="padding:12px 14px;background:#f8f4ff;border-left:3px solid #8b5cf6;border-radius:0 6px 6px 0;margin-bottom:14px;font-size:13px;line-height:1.6;color:${T};">
              <div style="font-size:10px;font-weight:700;color:#8b5cf6;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">🧠 Executive Summary</div>
              ${aiBlock.exec_summary}
            </div>` : ''}

            ${intelIncludeOpps && oppsCount > 0 ? `
            <div style="padding:10px 14px;background:#eff6ff;border-radius:6px;margin-bottom:12px;font-size:12px;">
              <span style="color:#2563eb;font-weight:700;">💰 Pipeline in this group: </span>${oppsCount} open opp${oppsCount!==1?'s':''} · ${formatCurrency(oppsValue)}
            </div>` : ''}

            ${aiBlock.top_pains && aiBlock.top_pains.length > 0 ? `
            <div style="margin-bottom:14px;">
              <div style="font-size:11px;font-weight:700;color:#b91c1c;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">🔥 Top Pains</div>
              ${aiBlock.top_pains.slice(0, 5).map((p,i) => `
              <div style="padding:8px 12px;background:#fee2e2;border-left:3px solid #ef4444;border-radius:0 6px 6px 0;margin-bottom:6px;">
                <div style="font-size:13px;font-weight:700;color:${T};">${i+1}. ${(p.pain||'').replace(/</g,'&lt;')}</div>
                ${p.frequency ? `<div style="font-size:11px;color:#991b1b;margin-top:2px;">${p.frequency}</div>` : ''}
                ${p.example ? `<div style="font-size:11px;color:${GR};margin-top:4px;font-style:italic;">"${(p.example||'').replace(/</g,'&lt;').slice(0,200)}"</div>` : ''}
              </div>`).join('')}
            </div>` : ''}

            ${aiBlock.linkedin_themes && aiBlock.linkedin_themes.length > 0 ? `
            <div style="margin-bottom:14px;">
              <div style="font-size:11px;font-weight:700;color:#0a66c2;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">💼 LinkedIn Themes</div>
              ${aiBlock.linkedin_themes.slice(0, 4).map(t => `
              <div style="padding:8px 12px;background:#dbeafe;border-left:3px solid #0a66c2;border-radius:0 6px 6px 0;margin-bottom:6px;font-size:12px;color:${T};">
                <strong>${(t.theme||'').replace(/</g,'&lt;')}</strong>${t.details ? ` — <span style="color:${GR};">${(t.details||'').replace(/</g,'&lt;')}</span>` : ''}
              </div>`).join('')}
            </div>` : ''}

            ${aiBlock.timing_signals && aiBlock.timing_signals.length > 0 ? `
            <div style="margin-bottom:14px;">
              <div style="font-size:11px;font-weight:700;color:#d97706;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">⏰ Timing Signals</div>
              ${aiBlock.timing_signals.slice(0, 4).map(t => `
              <div style="padding:8px 12px;background:#fef3c7;border-left:3px solid #f59e0b;border-radius:0 6px 6px 0;margin-bottom:6px;font-size:12px;color:${T};">
                <strong>${(t.signal||'').replace(/</g,'&lt;')}</strong>${t.who ? ` — <span style="color:${GR};">${(t.who||'').replace(/</g,'&lt;')}</span>` : ''}
              </div>`).join('')}
            </div>` : ''}

            ${aiBlock.suggested_campaign ? `
            <div style="padding:12px 14px;background:#ecfdf5;border-left:3px solid #10b981;border-radius:0 6px 6px 0;margin-bottom:6px;font-size:12px;line-height:1.6;">
              <div style="font-size:10px;font-weight:700;color:#10b981;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">💡 Suggested Campaign</div>
              <div style="font-weight:700;color:${T};margin-bottom:4px;">${(aiBlock.suggested_campaign.name || '').replace(/</g,'&lt;')}</div>
              <div style="font-size:11px;color:${GR};margin-bottom:6px;">Type: ${aiBlock.suggested_campaign.type || '?'}</div>
              <div style="font-size:12px;color:${T};white-space:pre-wrap;">${(aiBlock.suggested_campaign.context || '').replace(/</g,'&lt;')}</div>
            </div>` : ''}
          </td></tr>`);
      }

      const dateLabel = `Generated ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
      const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 16px;">
<tr><td align="center">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;">
  <tr><td style="background:${T};padding:24px 28px;border-radius:12px 12px 0 0;">
<div style="display:flex;justify-content:space-between;align-items:center;">
  <div>
    ${RB_LOGO
      ? `<img src="${RB_LOGO}" alt="Logo" style="max-height:36px;max-width:140px;margin-bottom:6px;" />`
      : `<div style="font-size:22px;font-weight:800;color:${G};letter-spacing:1px;">OIKE</div>`
    }
    <div style="font-size:12px;color:#9ca3af;margin-top:2px;">🎯 Stakeholder Pains & LinkedIn Intel</div>
  </div>
  <div style="text-align:right;">
    <div style="font-size:13px;color:#e5e7eb;font-weight:600;">${dateLabel}</div>
    <div style="font-size:11px;color:#6b7280;margin-top:2px;">Grouped by ${intelGroupBy}${intelFilterIndustry ? ` · ${intelFilterIndustry}` : ''}${intelFilterInfluence ? ` · ${intelFilterInfluence}` : ''}</div>
  </div>
</div>
  </td></tr>
  <tr><td style="background:#fff;padding:28px;border-radius:0 0 12px 12px;">
<table width="100%" cellpadding="0" cellspacing="0">
  <tr><td style="padding:0 0 12px;font-size:12px;color:${GR};line-height:1.6;">
    <strong>${poolStks.length}</strong> stakeholders analyzed across <strong>${groupEntries.length}</strong> ${intelGroupBy} group${groupEntries.length!==1?'s':''}. Each cluster includes top pains, LinkedIn themes, timing signals, and a suggested campaign.
  </td></tr>
  ${groupSections.join('')}
</table>
  </td></tr>
</table>
</td></tr></table></body></html>`;

      setReportHtml(html);
      setIntelInsights(insights);
    } catch(e) {
      console.error('Stakeholder pains report failed:', e);
    } finally {
      setGenerating(false);
    }
  };

  const copyHtml = async () => {
    try {
      const blob = new Blob([reportHtml], { type: 'text/html' });
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback: copy as plain text
      navigator.clipboard.writeText(reportHtml).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const openReportInGmail = async () => {
    try {
      const blob = new Blob([reportHtml], { type: 'text/html' });
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': blob })]);
    } catch {
      navigator.clipboard.writeText(reportHtml).catch(() => {});
    }
    window.open('https://mail.google.com/mail/?view=cm&fs=1', '_blank');
    setGmailOpened(true);
    setTimeout(() => setGmailOpened(false), 4000);
  };

  const printReportAsPdf = () => {
    const printHtml = reportHtml.replace('</body>', '<script>window.onload=function(){setTimeout(function(){window.print();},400);};<\/script></body>');
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.open();
    w.document.write(printHtml);
    w.document.close();
  };

  const toggleItem = (id) => setSelectedIds(p => p.includes(id) ? p.filter(x=>x!==id) : [...p, id]);

  // Industry / country options for filters
  const industryOptions = useMemo(() => [...new Set(accounts.map(a => F(a,'Industry')).filter(Boolean))].sort(), [accounts]);
  const countryOptions = useMemo(() => [...new Set([...accounts.map(a => F(a,'Country')), ...stakeholders.map(s => F(s,'Country'))].filter(Boolean))].sort(), [accounts, stakeholders]);
  const influenceOptions = useMemo(() => [...new Set(stakeholders.map(s => F(s,'Level of Influence')).filter(Boolean))].sort(), [stakeholders]);

  return (
    <div>
      <div className="page-header">
        <h1>📧 Report Builder</h1>
        <p>Outreach activity, company intel, stakeholder pains, or full account briefing — ready to email, or turn into a campaign</p>
      </div>

      {/* ── Top-level mode selector ── */}
      <div className="card" style={{ marginBottom: 16, padding: '12px 14px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>Report Type</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {[
            { k: 'outreach',         icon: '📊', label: 'Outreach Activity',  sub: 'Messages sent, replies, meetings, posts' },
            { k: 'stakeholder',      icon: '🎯', label: 'Stakeholder Pains',  sub: 'Pains + LinkedIn, aggregated by cluster' },
            { k: 'account-briefing', icon: '🔮', label: 'Intelligence Radar', sub: 'AI radar: signals, people moves, tech stack, actions' },
          ].map(opt => (
            <button key={opt.k}
              onClick={() => { setReportMode(opt.k); setReportHtml(''); setIntelInsights([]); setTasksCreatedCount(0); }}
              style={{
                padding: '12px 10px', borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                background: reportMode === opt.k ? 'rgba(91,191,181,0.15)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${reportMode === opt.k ? 'var(--globant-green)' : 'rgba(255,255,255,0.08)'}`,
                color: reportMode === opt.k ? 'var(--globant-green)' : 'var(--globant-text)',
              }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{opt.icon} {opt.label}</div>
              <div style={{ fontSize: 10, color: 'var(--globant-muted)', fontWeight: 400 }}>{opt.sub}</div>
            </button>
          ))}
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'320px 1fr', gap:20, alignItems:'start' }}>
        {/* ── Left: Controls ── */}
        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
          {/* View filter — only in outreach mode */}
          {reportMode === 'outreach' && (
          <div className="card">
            <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:10 }}>🎯 View</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              {[
                { k:'all', label:'📊 Full report' },
                { k:'replies', label:'💬 Replies only' },
                { k:'meetings', label:'📅 Meetings only' },
                { k:'posts', label:'✍️ Posts generated' },
              ].map(opt => (
                <button key={opt.k}
                  onClick={() => setReportFilter(opt.k)}
                  style={{
                    padding:'7px 8px', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight:600,
                    background: reportFilter === opt.k ? 'rgba(91,191,181,0.18)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${reportFilter === opt.k ? 'var(--globant-green)' : 'rgba(255,255,255,0.08)'}`,
                    color: reportFilter === opt.k ? 'var(--globant-green)' : 'var(--globant-text)',
                  }}>
                  {opt.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize:10, color:'var(--globant-muted)', marginTop:8, fontStyle:'italic' }}>
              {reportFilter === 'all' && 'KPIs + breakdown + replies + posts'}
              {reportFilter === 'replies' && 'KPIs + replies received with AI status + next steps'}
              {reportFilter === 'meetings' && 'KPIs + meetings booked with stakeholder context'}
              {reportFilter === 'posts' && 'KPIs + Content Lab posts from the period'}
            </div>
          </div>
          )}

          {/* Intel mode controls (Company / Stakeholder / Account Briefing) */}
          {reportMode !== 'outreach' && (
          <div className="card">
            {reportMode === 'account-briefing' && (
              <div style={{ marginBottom:10, padding:'8px 10px', background:'rgba(91,191,181,0.08)', border:'1px solid rgba(91,191,181,0.25)', borderRadius:6, fontSize:11, color:'var(--globant-text)', lineHeight:1.5 }}>
                🔮 <strong>Intelligence Radar</strong> — Pick exactly <strong>1 account</strong> below. AI will generate a full radar: key signals, financial intel, people moves, tech stack, competitive landscape, and HOT🔥/WARM🌡️/COLD❄️ recommended actions.
              </div>
            )}
            {reportMode !== 'account-briefing' && (
            <>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:10 }}>🗂️ Group by</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              {[{k:'industry',label:'🏭 Industry'},{k:'role',label:'👤 Role'},{k:'country',label:'🌎 Country'}].map(opt => (
                <button key={opt.k}
                  onClick={() => setIntelGroupBy(opt.k)}
                  style={{
                    padding:'7px 8px', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight:600,
                    background: intelGroupBy === opt.k ? 'rgba(91,191,181,0.18)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${intelGroupBy === opt.k ? 'var(--globant-green)' : 'rgba(255,255,255,0.08)'}`,
                    color: intelGroupBy === opt.k ? 'var(--globant-green)' : 'var(--globant-text)',
                  }}>
                  {opt.label}
                </button>
              ))}
            </div>
            </>
            )}

            {/* Filters */}
            <div style={{ marginTop: reportMode === 'account-briefing' ? 0 : 12 }}>
              {/* Specific account picker (overrides other filters) */}
              <div style={{ fontSize:10, color:'var(--globant-muted)', fontWeight:600, marginBottom:4, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <span>🏢 SPECIFIC ACCOUNT(S)</span>
                {intelFilterAccountIds.length > 0 && (
                  <span style={{ color:'var(--globant-green)', fontWeight:400 }}>{intelFilterAccountIds.length} selected</span>
                )}
                {intelFilterAccountIds.length === 0 && (
                  <span style={{ color: reportMode === 'account-briefing' ? '#ffc850' : 'var(--globant-muted)', fontWeight:400, fontStyle:'italic' }}>
                    {reportMode === 'account-briefing' ? 'pick 1 account ↓' : 'empty = use other filters'}
                  </span>
                )}
              </div>
              <input
                type="text"
                className="input-field"
                placeholder="🔍 Search accounts by name..."
                style={{ width:'100%', fontSize:12, marginBottom:6 }}
                value={intelAccountSearch}
                onChange={e => setIntelAccountSearch(e.target.value)}
              />
              {/* Selected chips */}
              {intelFilterAccountIds.length > 0 && (
                <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginBottom:6, padding:'4px', background:'rgba(91,191,181,0.06)', borderRadius:6 }}>
                  {intelFilterAccountIds.map(id => {
                    const acc = accounts.find(a => a.id === id);
                    if (!acc) return null;
                    return (
                      <span key={id} style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', background:'rgba(91,191,181,0.18)', border:'1px solid rgba(91,191,181,0.4)', borderRadius:10, fontSize:10, color:'var(--globant-green)', fontWeight:600 }}>
                        {F(acc,'Account Name')}
                        <span onClick={() => setIntelFilterAccountIds(p => p.filter(x => x !== id))} style={{ cursor:'pointer', marginLeft:2, opacity:0.7, fontSize:12 }}>×</span>
                      </span>
                    );
                  })}
                  <button className="action-btn btn-ghost" style={{ fontSize:9, padding:'2px 8px' }} onClick={() => setIntelFilterAccountIds([])}>Clear</button>
                </div>
              )}
              {/* Account list (filtered by search) */}
              {intelAccountSearch.trim().length > 0 && (() => {
                const q = intelAccountSearch.toLowerCase();
                const matches = accounts
                  .filter(a => !intelFilterAccountIds.includes(a.id) && (F(a,'Account Name')||'').toLowerCase().includes(q))
                  .slice(0, 20);
                return (
                  <div style={{ maxHeight:180, overflowY:'auto', border:'1px solid rgba(255,255,255,0.05)', borderRadius:6, marginBottom:6 }}>
                    {matches.length === 0 ? (
                      <div style={{ padding:10, fontSize:11, color:'var(--globant-muted)', textAlign:'center', fontStyle:'italic' }}>No matches</div>
                    ) : (
                      matches.map(a => (
                        <div key={a.id} onClick={() => { setIntelFilterAccountIds(p => [...p, a.id]); setIntelAccountSearch(''); }}
                          style={{ padding:'6px 10px', cursor:'pointer', borderBottom:'1px solid rgba(255,255,255,0.03)', fontSize:12 }}>
                          <div style={{ fontWeight:600 }}>{F(a,'Account Name')}</div>
                          <div style={{ fontSize:10, color:'var(--globant-muted)' }}>{F(a,'Industry') || '—'}{F(a,'Country') ? ` · ${F(a,'Country')}` : ''}</div>
                        </div>
                      ))
                    )}
                  </div>
                );
              })()}

              {reportMode !== 'account-briefing' && (
                <>
                  <div style={{ fontSize:10, color:'var(--globant-muted)', fontWeight:600, marginBottom:4, marginTop: 8, opacity: intelFilterAccountIds.length > 0 ? 0.4 : 1 }}>INDUSTRY FILTER</div>
                  <select className="input-field" style={{ width:'100%', fontSize:12, marginBottom:6, opacity: intelFilterAccountIds.length > 0 ? 0.4 : 1 }} value={intelFilterIndustry} onChange={e => setIntelFilterIndustry(e.target.value)} disabled={intelFilterAccountIds.length > 0}>
                    <option value="">All industries</option>
                    {industryOptions.map(i => <option key={i} value={i}>{i}</option>)}
                  </select>
                  <div style={{ fontSize:10, color:'var(--globant-muted)', fontWeight:600, marginBottom:4, opacity: intelFilterAccountIds.length > 0 ? 0.4 : 1 }}>COUNTRY FILTER</div>
                  <select className="input-field" style={{ width:'100%', fontSize:12, marginBottom:6, opacity: intelFilterAccountIds.length > 0 ? 0.4 : 1 }} value={intelFilterCountry} onChange={e => setIntelFilterCountry(e.target.value)} disabled={intelFilterAccountIds.length > 0}>
                    <option value="">All countries</option>
                    {countryOptions.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </>
              )}
              {reportMode === 'stakeholder' && (
                <>
                  <div style={{ fontSize:10, color:'var(--globant-muted)', fontWeight:600, marginBottom:4 }}>INFLUENCE FILTER</div>
                  <select className="input-field" style={{ width:'100%', fontSize:12, marginBottom:6 }} value={intelFilterInfluence} onChange={e => setIntelFilterInfluence(e.target.value)}>
                    <option value="">All levels</option>
                    {influenceOptions.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </>
              )}
              {reportMode === 'account-briefing' && intelFilterAccountIds.length > 1 && (
                <div style={{ marginTop:8, padding:'6px 10px', background:'rgba(255,200,80,0.08)', border:'1px solid rgba(255,200,80,0.3)', borderRadius:6, fontSize:11, color:'#ffc850' }}>
                  ⚠️ Pick only <strong>1 account</strong> for the Intelligence Radar. The first selected will be used.
                </div>
              )}
            </div>

            {/* Toggles — not shown for account-briefing */}
            {reportMode === 'stakeholder' && (
              <div style={{ marginTop:10, padding:8, borderTop:'1px solid rgba(255,255,255,0.06)' }}>
                {reportMode === 'stakeholder' && (
                  <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:11, cursor:'pointer' }}>
                    <input type="checkbox" checked={intelIncludeOpps} onChange={e => setIntelIncludeOpps(e.target.checked)} />
                    <span>Include open pipeline value per group</span>
                  </label>
                )}
              </div>
            )}
          </div>
          )}

          {/* Date range — only in outreach mode */}
          {reportMode === 'outreach' && (
          <div className="card">
            <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:10 }}>📅 Period</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              <div>
                <label style={{ fontSize:10, color:'var(--globant-muted)', display:'block', marginBottom:3 }}>From</label>
                <input type="date" className="input-field" style={{ width:'100%', fontSize:12 }} value={dateFrom} onChange={e=>setDateFrom(e.target.value)} />
              </div>
              <div>
                <label style={{ fontSize:10, color:'var(--globant-muted)', display:'block', marginBottom:3 }}>To</label>
                <input type="date" className="input-field" style={{ width:'100%', fontSize:12 }} value={dateTo} onChange={e=>setDateTo(e.target.value)} />
              </div>
            </div>
            <div style={{ display:'flex', gap:6, marginTop:8, flexWrap:'wrap' }}>
              {[['Last 7d',7],['Last 14d',14],['Last 30d',30]].map(([label,days])=>(
                <button key={days} className="action-btn btn-ghost" style={{ fontSize:10, padding:'3px 10px' }}
                  onClick={() => { setDateTo(fmt(now)); setDateFrom(fmt(new Date(now - days*86400000))); }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          )}

          {/* Group by selector + search — outreach only */}
          {reportMode === 'outreach' && (
          <div className="card">
            <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:10 }}>🎯 Report Scope</div>

            {/* Group by tabs */}
            <div style={{ fontSize:10, color:'var(--globant-muted)', marginBottom:6, fontWeight:600 }}>GROUP BY</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:4, marginBottom:12 }}>
              {[
                { key: 'accounts', label: 'Accounts', icon: '🏢' },
                { key: 'solutions', label: 'Offering', icon: '🛠️' },
                { key: 'campaigns', label: 'Campaigns', icon: '📣' },
                { key: 'events', label: 'Events', icon: '🎤' },
                { key: 'cp', label: 'CP', icon: '👤' },
              ].map(opt => (
                <button key={opt.key} onClick={() => changeGroupBy(opt.key)}
                  style={{
                    padding: '7px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                    background: groupBy === opt.key ? 'rgba(91,191,181,0.18)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${groupBy === opt.key ? 'var(--globant-green)' : 'rgba(255,255,255,0.08)'}`,
                    color: groupBy === opt.key ? 'var(--globant-green)' : 'var(--globant-text)',
                  }}>
                  {opt.icon} {opt.label}
                </button>
              ))}
            </div>

            {/* Search + results */}
            <div style={{ fontSize:10, color:'var(--globant-muted)', marginBottom:6, fontWeight:600 }}>
              FILTER {allOptions.label.toUpperCase()}
              {selectedIds.length > 0 && <span style={{ marginLeft:6, color:'var(--globant-green)', fontWeight:400 }}>({selectedIds.length} selected)</span>}
              {selectedIds.length === 0 && <span style={{ marginLeft:6, color:'var(--globant-muted)', fontWeight:400, fontStyle:'italic' }}>(empty = all)</span>}
            </div>
            <input
              type="text"
              className="input-field"
              placeholder={`🔍 Search ${allOptions.label.toLowerCase()}...`}
              style={{ width:'100%', fontSize:12, marginBottom:6 }}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />

            {/* Selected chips */}
            {selectedIds.length > 0 && (
              <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginBottom:8, padding:'6px', background:'rgba(91,191,181,0.06)', borderRadius:6 }}>
                {selectedIds.map(id => {
                  const it = allOptions.items.find(x => x.id === id);
                  if (!it) return null;
                  return (
                    <span key={id} style={{
                      display:'inline-flex', alignItems:'center', gap:4,
                      padding:'3px 8px', background:'rgba(91,191,181,0.18)',
                      border:'1px solid rgba(91,191,181,0.4)', borderRadius:10,
                      fontSize:10, color:'var(--globant-green)', fontWeight:600,
                    }}>
                      {F(it, allOptions.nameField)}
                      <span onClick={() => toggleItem(id)} style={{ cursor:'pointer', marginLeft:2, opacity:0.7, fontSize:12 }}>×</span>
                    </span>
                  );
                })}
                <button className="action-btn btn-ghost" style={{ fontSize:9, padding:'2px 8px' }} onClick={() => setSelectedIds([])}>Clear all</button>
              </div>
            )}

            {/* Options list (filtered by search) */}
            <div style={{ maxHeight:220, overflowY:'auto', border:'1px solid rgba(255,255,255,0.05)', borderRadius:6 }}>
              {filteredOptions.length === 0 ? (
                <div style={{ padding:12, fontSize:11, color:'var(--globant-muted)', textAlign:'center', fontStyle:'italic' }}>
                  {searchQuery.trim() ? `No ${allOptions.label.toLowerCase()} match "${searchQuery}"` : `No ${allOptions.label.toLowerCase()} available`}
                </div>
              ) : (
                filteredOptions.map(it => {
                  const isSel = selectedIds.includes(it.id);
                  return (
                    <div key={it.id} onClick={() => toggleItem(it.id)}
                      style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', cursor:'pointer', background:isSel?'rgba(91,191,181,0.12)':'transparent', borderBottom:'1px solid rgba(255,255,255,0.03)' }}>
                      <div style={{ width:14, height:14, borderRadius:3, border:`2px solid ${isSel?'var(--globant-green)':'var(--globant-border)'}`, background:isSel?'var(--globant-green)':'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                        {isSel && <span style={{ color:'#1A1A2E', fontSize:9, fontWeight:900 }}>✓</span>}
                      </div>
                      <span style={{ fontSize:12, color: isSel?'var(--globant-green)':'var(--globant-text)' }}>{F(it, allOptions.nameField)}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          )}

          {/* Stats preview — outreach only */}
          {reportMode === 'outreach' && (
          <div className="card" style={{ background:'rgba(91,191,181,0.06)', border:'1px solid rgba(91,191,181,0.2)' }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-green)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:10 }}>Preview Stats</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              {[['Messages',totalSent],['Accounts',accsContacted],['Unique Replies',uniqueRepliers],['Meetings',meetings.length],['Reply %',replyRate+'%'],['Pipeline',formatCurrency(pipeline)]].map(([l,v])=>(
                <div key={l} style={{ padding:'6px 8px', background:'rgba(255,255,255,0.05)', borderRadius:5 }}>
                  <div style={{ fontSize:15, fontWeight:800, color:'var(--globant-green)' }}>{v}</div>
                  <div style={{ fontSize:10, color:'var(--globant-muted)' }}>{l}</div>
                </div>
              ))}
            </div>
          </div>
          )}

          {/* Notes — outreach only */}
          {reportMode === 'outreach' && (
          <div className="card">
            <div style={{ fontSize:11, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:8 }}>📝 My Notes / Next Steps</div>
            <textarea className="input-field"
              style={{ width:'100%', minHeight:90, resize:'vertical', fontSize:12, fontFamily:'inherit', lineHeight:1.5 }}
              placeholder="Add context, observations, or next steps to include in the report..."
              value={reportNotes}
              onChange={e => setReportNotes(e.target.value)}
            />
          </div>
          )}

          <button className="action-btn btn-primary" style={{ width:'100%', padding:'12px', fontSize:14, fontWeight:700 }}
            onClick={() => {
              if (reportMode === 'outreach') generateHtml();
              else if (reportMode === 'stakeholder') generateStakeholderPainsHtml();
              else if (reportMode === 'account-briefing') generateAccountBriefingHtml();
            }} disabled={generating}>
            {generating ? '⏳ Generating...' : `✨ Generate ${reportMode === 'outreach' ? 'Activity' : reportMode === 'stakeholder' ? 'Stakeholder Pains' : 'Intelligence Radar'} Report`}
          </button>
        </div>

        {/* ── Right: Preview ── */}
        <div>
          {!reportHtml ? (
            <div className="card" style={{ textAlign:'center', padding:'60px 24px', color:'var(--globant-muted)' }}>
              <div style={{ fontSize:40, marginBottom:12 }}>
                {reportMode === 'outreach' ? '📊' : reportMode === 'stakeholder' ? '🎯' : '🔮'}
              </div>
              <div style={{ fontSize:15, marginBottom:6 }}>Configure your report on the left</div>
              <div style={{ fontSize:12 }}>
                {reportMode === 'outreach' && 'Select period, solutions and accounts, then click Generate'}
                {reportMode === 'stakeholder' && 'Pick group-by + filters, then click Generate'}
                {reportMode === 'account-briefing' && 'Pick 1 account, then click Generate — perfect for pre-meeting prep'}
              </div>
            </div>
          ) : (
            <div>
              <div style={{ display:'flex', gap:8, marginBottom:8, flexWrap:'wrap' }}>
                <button style={{ padding:'10px 18px', borderRadius:8, background:'rgba(66,133,244,0.15)', border:'1px solid rgba(66,133,244,0.4)', color:'#60a5fa', fontWeight:700, fontSize:13, cursor:'pointer', display:'flex', alignItems:'center', gap:6 }} onClick={openReportInGmail}>
                  {gmailOpened ? '✅ Copied! Paste in Gmail' : '📧 Open in Gmail'}
                </button>
                <button className="action-btn btn-primary" style={{ padding:'10px 18px', fontSize:13, fontWeight:700 }} onClick={copyHtml}>
                  {copied ? '✅ Copied!' : '📋 Copy HTML'}
                </button>
                <button style={{ padding:'10px 16px', borderRadius:8, border:'1px solid var(--globant-border)', background:'transparent', color:'var(--globant-muted)', fontWeight:600, fontSize:13, cursor:'pointer' }} onClick={printReportAsPdf}>
                  🖨️ PDF
                </button>
                {reportMode === 'outreach' && (() => {
                  const eligibleCount = (lastReplyDetails || []).filter(r => (r.urgency === 'high' || r.urgency === 'medium') && r.next_step && r.next_step.trim()).length;
                  const disabled = creatingTasks || eligibleCount === 0 || tasksCreatedCount > 0;
                  const label = creatingTasks
                    ? '⏳ Creating...'
                    : tasksCreatedCount > 0
                      ? `✅ ${tasksCreatedCount} task${tasksCreatedCount!==1?'s':''} created — see Follow-up Center`
                      : `⚡ Create ${eligibleCount} urgent task${eligibleCount!==1?'s':''}`;
                  return (
                    <button
                      onClick={generateUrgentTasks}
                      disabled={disabled}
                      title={eligibleCount === 0 ? 'No high/medium urgency replies detected' : `Create ${eligibleCount} Action Plan task${eligibleCount!==1?'s':''} from high + medium urgency replies`}
                      style={{ padding:'10px 16px', borderRadius:8, border:`1px solid ${disabled?'rgba(239,68,68,0.25)':'rgba(239,68,68,0.5)'}`, background: tasksCreatedCount > 0 ? 'rgba(16,185,129,0.15)' : disabled ? 'rgba(239,68,68,0.06)' : 'rgba(239,68,68,0.15)', color: tasksCreatedCount > 0 ? '#10b981' : disabled ? 'rgba(239,68,68,0.5)' : '#f87171', fontWeight:700, fontSize:13, cursor: disabled ? 'not-allowed' : 'pointer' }}>
                      {label}
                    </button>
                  );
                })()}
                <button className="action-btn btn-ghost" style={{ padding:'10px 16px', fontSize:13, marginLeft:'auto' }}
                  onClick={() => { setReportHtml(''); setCopied(false); setGmailOpened(false); setTasksCreatedCount(0); setIntelInsights([]); }}>
                  🔄 Reset
                </button>
              </div>

              {/* 💡 Create campaign from insight (intel reports only) */}
              {reportMode !== 'outreach' && intelInsights.length > 0 && (
                <div style={{ padding: '12px 14px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 8, marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#10b981', marginBottom: 8 }}>💡 Create campaign from insight</div>
                  <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 10 }}>
                    Each group has a suggested campaign. Click to open a pre-filled campaign with its context + assigned stakeholders.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {intelInsights.filter(i => i.suggestedCampaign).map((ins, i) => (
                      <button key={i}
                        onClick={() => {
                          if (onCreateCampaignFromInsight) {
                            onCreateCampaignFromInsight({
                              name: ins.suggestedCampaign?.name || ins.groupLabel,
                              type: ins.suggestedCampaign?.type || 'Cold Outreach',
                              context: (ins.suggestedCampaign?.context || '') + (ins.execSummary ? `\n\n--- CONTEXT FROM REPORT ---\n${ins.execSummary}` : ''),
                              stakeholderIds: ins.stakeholderIds || [],
                            });
                          }
                        }}
                        style={{ padding: '10px 12px', borderRadius: 6, background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', color: 'var(--globant-text)', textAlign: 'left', cursor: 'pointer', fontSize: 12 }}>
                        <div style={{ fontWeight: 700, color: '#10b981', marginBottom: 2 }}>💡 {ins.suggestedCampaign.name || ins.groupLabel}</div>
                        <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>
                          {ins.groupLabel} · {ins.stakeholderIds.length} stakeholder{ins.stakeholderIds.length!==1?'s':''} · Type: {ins.suggestedCampaign.type || '?'}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {gmailOpened && (
                <div style={{ padding:'8px 12px', borderRadius:8, background:'rgba(66,133,244,0.08)', border:'1px solid rgba(66,133,244,0.2)', fontSize:12, color:'#93c5fd', marginBottom:10 }}>
                  Gmail is open. Paste with <strong>Ctrl+V</strong> (or ⌘V) in the message body — it renders as formatted HTML.
                </div>
              )}
              <div style={{ border:'1px solid var(--globant-border)', borderRadius:12, overflow:'hidden', background:'#f3f4f6' }}>
                <iframe
                  srcDoc={reportHtml}
                  style={{ width:'100%', height:700, border:'none', background:'#f3f4f6' }}
                  title="Report Preview"
                  sandbox="allow-same-origin"
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============ MAIN APP ============
// ============ LOGIN SCREEN ============
// ============ ACTIVATION SCREEN ============

export default ReportBuilder;
