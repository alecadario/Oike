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


function AIMessageModal({ stakeholder, onClose, onSend, onSuccess, data }) {
  const [tab, setTab] = useState(() => {
    const touchCount = (data.outreach || []).filter(o => linkedIds(o, 'Stakeholder').includes(stakeholder.id)).length;
    return touchCount >= 5 ? 'breakup' : touchCount >= 1 ? 'followup' : 'first';
  });
  const [generatedMessages, setGeneratedMessages] = useState({ first: '', followup: '', breakup: '' });
  const [loadingAI, setLoadingAI] = useState(false);
  const [selectedChannel, setSelectedChannel] = useState('');
  const [savingDraft, setSavingDraft] = useState(false);
  const [extraContext, setExtraContext] = useState('');
  const [ccPartner, setCcPartner] = useState(true);
  const [selectedEventId, setSelectedEventId] = useState('');
  const [eventMode, setEventMode] = useState('invite'); // 'invite' | 'followup'
  const [selectedSolutionId, setSelectedSolutionId] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState('');
  const [sendingGmail, setSendingGmail] = useState(false);

  const gmailConnected = localStorage.getItem('oike_gmail_connected') === 'true';

  const currentMessage = generatedMessages[tab] || '';

  // Gather rich context
  const sName = F(stakeholder, 'Name') + (F(stakeholder, 'Last name') ? ` ${F(stakeholder, 'Last name')}` : '');
  const role = F(stakeholder, 'Role');
  const pain = F(stakeholder, 'Pain Points (Generated)') || F(stakeholder, 'Pain points') || '';
  const painText = typeof pain === 'string' ? pain.slice(0, 400) : String(pain).slice(0, 400);
  const influence = F(stakeholder, 'Level of Influence');
  const linkedinNews = F(stakeholder, 'LinkedIn News (Generated)') || F(stakeholder, 'Linkedin lates news') || '';
  const linkedinText = typeof linkedinNews === 'string' ? linkedinNews.slice(0, 300) : '';

  const accountIds = linkedIds(stakeholder, 'Account');
  const account = data.accounts.find(a => accountIds.includes(a.id));
  const accountName = account ? F(account, 'Account Name') : 'the company';
  const industry = account ? F(account, 'Industry') : '';
  const accountCountry = account ? (F(account, 'Country') || '') : '';
  const countryLanguageMap = {
    'Saudi Arabia': 'English', 'KSA': 'English', 'UAE': 'English', 'Qatar': 'English',
    'Bahrain': 'English', 'Kuwait': 'English', 'Oman': 'English', 'Jordan': 'English',
    'Egypt': 'English', 'Morocco': 'English (or French if culturally preferred)',
    'Spain': 'Spanish', 'Mexico': 'Spanish', 'Colombia': 'Spanish', 'Argentina': 'Spanish',
    'Chile': 'Spanish', 'Peru': 'Spanish', 'Venezuela': 'Spanish', 'Ecuador': 'Spanish',
    'Bolivia': 'Spanish', 'Paraguay': 'Spanish', 'Uruguay': 'Spanish',
    'Brazil': 'Portuguese', 'Portugal': 'Portuguese',
    'France': 'French', 'Belgium': 'French',
    'Germany': 'German', 'Austria': 'German', 'Switzerland': 'German or French',
    'Italy': 'Italian', 'Netherlands': 'English or Dutch', 'Poland': 'English or Polish',
    'Turkey': 'English or Turkish', 'India': 'English', 'Pakistan': 'English',
    'United States': 'English', 'USA': 'English', 'United Kingdom': 'English', 'UK': 'English',
    'Canada': 'English', 'Australia': 'English', 'Singapore': 'English',
  };
  const suggestedLanguage = accountCountry ? (countryLanguageMap[accountCountry] || 'English') : '';
  const recentNews = account ? (F(account, 'Recent News') || '') : '';
  // Also check localStorage news generated in Account Intel view (stored under oike_news_ai)
  const localAccountNews = (() => {
    try {
      const cache = JSON.parse(localStorage.getItem('oike_news_ai') || '{}');
      return account ? (cache[account.id]?.text || '') : '';
    } catch { return ''; }
  })();
  const newsText = (() => {
    const src = (typeof recentNews === 'string' && recentNews) ? recentNews : localAccountNews;
    return typeof src === 'string' ? src.slice(0, 800) : '';
  })();
  const intelPlan = account ? (F(account, 'Inside sales plan') || '') : '';
  const planText = typeof intelPlan === 'string' ? intelPlan.slice(0, 300) : '';
  // Note: planText still used as fallback context in AI Message Generator
  const intelNotes = account ? (F(account, 'Intel Notes') || '') : '';
  const intelNotesText = typeof intelNotes === 'string' ? intelNotes.slice(0, 400) : '';
  const serviceFocus = account ? F(account, 'Service / Focus') : '';
  const focusText = Array.isArray(serviceFocus) ? serviceFocus.join(', ') : serviceFocus;
  const solNames = account ? resolveLinked(account, 'Solutions', data.solutions, 'Name') : [];
  const opps = account ? data.opportunities.filter(o => linkedIds(o, 'Account').includes(account.id)) : [];
  const oppSummary = opps.map(o => `${F(o, 'Deal/Opp name')} (${F(o, 'Stage')})`).join(', ');

  // Contact info for channel filtering
  const stkPhone = F(stakeholder, 'Phone number') || '';
  const stkEmail = F(stakeholder, 'Email') || '';
  const stkLinkedin = F(stakeholder, 'LinkedIn') || '';
  const availableChannels = ['Email', 'WhatsApp', 'LinkedIn', 'Call'].filter(ch => {
    if (ch === 'WhatsApp' && !stkPhone) return false;
    if (ch === 'Call' && !stkPhone) return false;
    if (ch === 'LinkedIn' && !stkLinkedin) return false;
    return true;
  });

  // Find Client Partner(s) for this account
  const accountOwners = account ? (F(account, 'Account Owner') || []) : [];
  const ownerNames = Array.isArray(accountOwners) ? accountOwners : (accountOwners ? [accountOwners] : []);
  const matchedCPs = (data.clientPartners || []).filter(cp => {
    const cpName = F(cp, 'Name') || '';
    // Match by name OR by linked accounts
    const cpAccIds = linkedIds(cp, 'Accounts');
    return ownerNames.some(o => cpName.toLowerCase().includes(o.toLowerCase()) || o.toLowerCase().includes(cpName.toLowerCase())) ||
           (account && cpAccIds.includes(account.id));
  });
  const cpEmails = matchedCPs.map(cp => F(cp, 'Email')).filter(Boolean);

  // Previous outreach history
  const sOutreach = data.outreach.filter(o => linkedIds(o, 'Stakeholder').includes(stakeholder.id))
    .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
  const lastMessages = sOutreach.slice(0, 3).map(o => `[${F(o, 'Channel')} ${formatDate(o.fields?.['Date'])}] ${(F(o, 'Message') || '').slice(0, 100)}`).join('\n');

  // Conversation stats for preview + history summary
  const convoReplyCount = sOutreach.filter(o => ['Replied','Received'].includes(F(o, 'Status'))).length;
  const convoLastFromThem = sOutreach.find(o => ['Replied','Received'].includes(F(o, 'Status')));
  const convoDaysSinceTheirLast = convoLastFromThem?.fields?.['Date']
    ? Math.floor((Date.now() - new Date(convoLastFromThem.fields['Date']).getTime()) / (1000*60*60*24))
    : null;

  // Event reference
  const events = data.events || [];
  const selectedEvent = selectedEventId ? events.find(e => e.id === selectedEventId) : null;
  const eventContext = selectedEvent ? (() => {
    const eName = F(selectedEvent, 'Event Name') || '';
    const eStart = selectedEvent.fields?.['Starting'] ? new Date(selectedEvent.fields['Starting']).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
    const eEnd = selectedEvent.fields?.['End date'] ? new Date(selectedEvent.fields['End date']).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
    const eUrl = F(selectedEvent, 'URL') || '';
    const eAdditional = F(selectedEvent, 'Aditional context') || '';
    const eSummary = F(selectedEvent, 'Attachment Summary') || '';
    const eTemplate = F(selectedEvent, 'Stakeholder Invitation') || '';
    return `EVENT: ${eName}${eStart ? ` | Date: ${eStart}${eEnd ? ` – ${eEnd}` : ''}` : ''}${eUrl ? ` | URL: ${eUrl}` : ''}${eAdditional ? `\nEvent Context: ${eAdditional.slice(0, 300)}` : ''}${eSummary ? `\nEvent Summary: ${(typeof eSummary === 'string' ? eSummary : '').slice(0, 300)}` : ''}${eTemplate ? `\n\n━━━ INVITATION TEMPLATE (use this as the base, personalize to the recipient) ━━━\n${eTemplate.slice(0, 500)}` : ''}`;
  })() : '';
  const isEventFollowup = !!(eventContext && eventMode === 'followup');
  const isEventInvite = !!(eventContext && eventMode === 'invite');

  // Solution reference
  const allSolutions = data.solutions || [];
  const selectedSolution = selectedSolutionId ? allSolutions.find(s => s.id === selectedSolutionId) : null;
  const solutionContext = selectedSolution ? (() => {
    const solName = F(selectedSolution, 'Name') || '';
    const solDetail = F(selectedSolution, 'Service | Solution Detail') || '';
    const solDetailText = typeof solDetail === 'string' ? solDetail.slice(0, 500) : String(solDetail || '').slice(0, 500);
    const solNotes = F(selectedSolution, 'Extra imput') || '';
    const solNotesText = typeof solNotes === 'string' ? solNotes.slice(0, 300) : '';
    return `SOLUTION: ${solName}${solDetailText ? `\nSolution Detail: ${solDetailText}` : ''}${solNotesText ? `\nAdditional Notes: ${solNotesText}` : ''}`;
  })() : '';

  const channelPrompts = {
    WhatsApp: {
      tone: 'casual, warm, direct — like texting a business contact you already respect. Confident but not salesy.',
      format: `Short (30-50 words max). Rules:
- Start with "Hi [First Name]," — NEVER "Dear", NEVER full name, NEVER formal Arabic greetings
- Get to the ONE value point in the first sentence
- Use 1 strategic emoji max (not decorative)
- End with a single soft question or micro-CTA (e.g. "Worth a quick chat?" or "Would that be relevant for your team?")
- NO signature, NO links, NO bullet points
- Write like a real human texts — short sentences, natural rhythm`,
    },
    Email: {
      tone: 'professional but human — sounds like a smart peer, not a sales robot. Confident, concise, zero fluff.',
      format: `Rules:
- First line: "Subject: [specific, curiosity-driven subject — reference their company name or a concrete trigger, max 8 words]"
- Then blank line, then body (60-90 words MAX — shorter is better for cold outreach)
- Opening: 1 sentence that shows you know something specific about THEM (news, role, challenge). Never generic.
- Body: 1 short paragraph connecting ${COMPANY_PROFILE.companyName}'s capability to THEIR specific situation. No laundry list of services.
- CTA: 1 clear, low-commitment ask (e.g. "Would a 15-min call next week make sense?" or "Happy to share how we approached this for [similar company]")
- Sign-off: "Best,\\n${COMPANY_PROFILE.senderName}\\n${COMPANY_PROFILE.senderTitle} — ${COMPANY_PROFILE.companyName}"
- NEVER use "I hope this finds you well", "I wanted to reach out", "I came across your profile", "I'd love to", or any filler phrases`,
    },
    LinkedIn: {
      tone: 'peer-to-peer, genuinely curious — like reaching out to someone whose work you find interesting. Not transactional.',
      format: `Short (40-70 words). Rules:
- NO greeting like "Dear" or "Hello [Full Name]" — start conversationally ("Noticed your...", "Your team's work on...", "Saw that [company]...")
- Reference something SPECIFIC: a recent post, a company move, their role, an industry trend — show you're not copy-pasting
- 1 sentence of value or relevant connection point
- End with a genuine question or soft bridge (e.g. "Would love to hear your take" or "Is this something on your radar?")
- NO signature, NO job title, NO links
- Must work within 300 characters if this is a connection request (state both: a short version for connection request AND a longer InMail version)`,
    },
    Call: {
      tone: 'confident, conversational, structured — a talk track that sounds natural when spoken aloud, not read from a script',
      format: `Write a call script (80-100 words) with these labeled sections:
[OPENER] — Pattern interrupt opening (NOT "Hi, my name is..." — instead lead with a trigger: "I saw that [company] just..." or "I was looking into [industry challenge]...")
[HOOK] — 1 sentence connecting their situation to a specific result ${COMPANY_PROFILE.companyName} has delivered
[QUESTION] — An open-ended question that gets them talking about their challenge (NOT "Do you have 5 minutes?")
[OBJECTION READY] — 1 short response for "We're not interested right now" (pivot to value or future timing)
Keep it natural — write for the ear, not the eye.`,
    },
  };

  const handleGenerate = async () => {
    if (!selectedChannel) { window.__oikeToast('Select a channel first', 'warning'); return; }

    // Warning for protected statuses — get confirmation before generating
    const currentStakeholderStatus = F(stakeholder, 'Status') || '';
    const BLOCK_STATUSES = ['DNC', 'Bounced', 'Left Company'];
    if (BLOCK_STATUSES.includes(currentStakeholderStatus)) {
      const msg = {
        'DNC': `⚠️ This contact is marked as DNC (Do Not Contact).\n\nContacting them may violate their preference or legal requirements. Proceed anyway?`,
        'Bounced': `⚠️ This contact's email is marked as Bounced.\n\nThe email address likely doesn't work. Verify it's correct before sending. Proceed anyway?`,
        'Left Company': `⚠️ This contact is marked as having Left Company.\n\nThey may no longer be at ${accountName}. Data might be stale. Proceed anyway?`,
      }[currentStakeholderStatus];
      if (!confirm(msg)) return;
    }

    setLoadingAI(true);
    try {
      const chGuide = channelPrompts[selectedChannel];
      const touchCount = sOutreach.length;

      // ── Build rich conversation history (bi-directional, chronological) ──
      // Extract content from Message field OR Notes (for Gmail-synced inbound emails)
      const extractContent = (o) => {
        const msg = F(o, 'Message') || '';
        if (msg.trim()) return msg.trim();
        // Gmail sync stores received emails in Notes with prefix [gmsg:ID]\nSubject\n\nSnippet
        const notes = F(o, 'Notes') || '';
        const cleaned = notes.replace(/^\[gmsg:[^\]]+\]\s*/, '').trim();
        return cleaned || '(no content captured)';
      };
      // Direction: YOU if sent by you, THEY if received/replied from contact
      const directionOf = (o) => {
        const status = String(F(o, 'Status') || '').toLowerCase();
        if (status === 'received' || status === 'replied') return 'THEY';
        // Gmail sync edge case — if Notes has [gmsg:] and no explicit Status, infer from Notes direction
        return 'YOU';
      };
      // Sort oldest-first for narrative arc (sOutreach is newest-first → reverse)
      const chronological = [...sOutreach].reverse().slice(-10);
      const replyCount = sOutreach.filter(o => ['Replied','Received'].includes(F(o,'Status'))).length;
      const lastDate = sOutreach[0]?.fields?.['Date'];
      const daysSinceLast = lastDate ? Math.floor((Date.now() - new Date(lastDate).getTime()) / (1000*60*60*24)) : null;
      const lastFromThem = sOutreach.find(o => ['Replied','Received'].includes(F(o,'Status')));
      const daysSinceTheirLast = lastFromThem?.fields?.['Date']
        ? Math.floor((Date.now() - new Date(lastFromThem.fields['Date']).getTime()) / (1000*60*60*24))
        : null;

      const historyBlock = sOutreach.length > 0
        ? `━━━ FULL CONVERSATION HISTORY (chronological, oldest → newest) ━━━
${chronological.map(o => {
  const d = F(o,'Date') ? new Date(F(o,'Date')).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}) : '?';
  const ch = F(o,'Channel') || '?';
  const dir = directionOf(o);
  const st = F(o,'Status') || '';
  const content = extractContent(o).slice(0, 400);
  return `[${d} · ${ch} · ${dir} · ${st}]\n"${content}"`;
}).join('\n\n')}

━━━ CONVERSATION STATS ━━━
- Total touches: ${touchCount}
- Replies from them: ${replyCount}
- Days since ANY activity: ${daysSinceLast !== null ? daysSinceLast : 'n/a'}
- Days since THEY last engaged: ${daysSinceTheirLast !== null ? daysSinceTheirLast : 'never engaged'}`
        : '';

      const firstContactBlock = [
        painText && `• Their pain points: ${painText.slice(0, 400)}`,
        newsText && `• Recent company news: ${newsText.slice(0, 400)}`,
        linkedinText && `• LinkedIn activity: ${linkedinText.slice(0, 200)}`,
        intelNotesText && `• Sales intel: ${intelNotesText.slice(0, 250)}`,
        solutionContext && `━━━ SOLUTION TO REFERENCE ━━━\n${solutionContext}\nHint at relevance — don't pitch.`,
      ].filter(Boolean).join('\n');

      const eventBlock = eventContext
        ? `━━━ EVENT ━━━\n${eventContext}`
        : '';

      // Mission + context per tab
      let mission = '';
      let contextBlock = '';

      const promptVars = {
        name: sName,
        company: COMPANY_PROFILE.companyName,
        touchCount,
        replyCount,
        replyState: replyCount > 0 ? `${replyCount} repl${replyCount>1?'ies':'y'} from them` : 'no replies yet',
      };

      if (isEventInvite) {
        mission = `MISSION: Invite ${sName} to this event. Casual and direct — ask if they're attending, mention you'd like to meet there. No pitch. No formalities. One question, done.`;
        contextBlock = eventBlock;
      } else if (isEventFollowup) {
        mission = `MISSION: Follow up after meeting ${sName} in person at an event. Skip intro. Reference the meeting naturally. ONE clear next step.`;
        contextBlock = eventBlock;
      } else if (tab === 'first') {
        mission = `MISSION: ${resolvePromptTemplate(MESSAGE_PROMPTS.first, promptVars)}`;
        contextBlock = firstContactBlock ? `━━━ CONTEXT (use this, don't invent) ━━━\n${firstContactBlock}` : '→ No specific data. Infer from role and industry.';
      } else if (tab === 'followup') {
        mission = `MISSION: ${resolvePromptTemplate(MESSAGE_PROMPTS.followup, promptVars)}`;
        contextBlock = [historyBlock, firstContactBlock && `━━━ CONTACT CONTEXT (pain points, LinkedIn, news — use as NEW angles if relevant) ━━━\n${firstContactBlock}`].filter(Boolean).join('\n\n') || '→ No previous messages found.';
      } else if (tab === 'breakup') {
        mission = `MISSION: ${resolvePromptTemplate(MESSAGE_PROMPTS.breakup, promptVars)}`;
        contextBlock = [historyBlock, firstContactBlock && `━━━ CONTACT CONTEXT (pain points, LinkedIn, news — reference only if it adds a genuine closing note) ━━━\n${firstContactBlock}`].filter(Boolean).join('\n\n') || '→ No previous messages found.';
      }

      const prompt = `You are a senior B2B sales copywriter. Write ONE message that sounds like a real human — not a template.

${mission}

━━━ SENDER ━━━
${COMPANY_PROFILE.senderName}${COMPANY_PROFILE.senderTitle ? `, ${COMPANY_PROFILE.senderTitle}` : ''} at ${COMPANY_PROFILE.companyName}${COMPANY_PROFILE.services ? ` — ${COMPANY_PROFILE.services}` : ''}
${COMPANY_PROFILE.goals ? `Company focus: ${COMPANY_PROFILE.goals}` : ''}

━━━ RECIPIENT ━━━
${sName} | ${role || 'Unknown role'} at ${accountName} | ${industry || 'Unknown industry'}${influence ? ` | ${influence}` : ''}

${contextBlock}
${extraContext ? `\n━━━ EXTRA CONTEXT — HIGHEST PRIORITY ━━━\n"${extraContext}"\nThis MUST be reflected naturally in the message.\n` : ''}
━━━ CHANNEL & FORMAT ━━━
Channel: ${selectedChannel}
Tone: ${chGuide.tone}
${chGuide.format}
Language: ${selectedLanguage || suggestedLanguage || 'English'} — write the ENTIRE message in this language.
${COMPANY_PROFILE.voiceTone ? `\nSender's voice:\n- ${COMPANY_PROFILE.voiceTone}${COMPANY_PROFILE.voiceAvoid ? `\n- Never: ${COMPANY_PROFILE.voiceAvoid}` : ''}${COMPANY_PROFILE.voiceExample ? `\n- Example: "${COMPANY_PROFILE.voiceExample}"` : ''}` : ''}

━━━ RULES ━━━
1. First name only — never full name in the body.
2. ONE micro-CTA — specific, low friction.
3. BANNED PHRASES: "I hope this finds you well" / "I wanted to reach out" / "just checking in" / "following up" / "touching base" / "I'd love to connect" / "as a leader in" / "I noticed that"
4. NEVER use [brackets] or placeholder text like [Company Name] or [insert X]. If you don't have the data, write around it naturally.
5. If it sounds like AI wrote it, rewrite it.
6. Output ONLY the message — no intro, no explanation. Email: first line must be "Subject: [your subject here]", then blank line, then body.`;

      const generated = await callOpenAI({ prompt, temperature: 0.75, max_tokens: 500 });
      setGeneratedMessages(prev => ({ ...prev, [tab]: generated }));
    } catch (e) {
      console.error(e);
      window.__oikeToast('Failed to generate. Error: ' + (e.message || 'unknown error'), 'error');
    }
    setLoadingAI(false);
  };

  const handleSendViaGmail = async () => {
    if (!currentMessage.trim()) return;
    const stakeholderEmail = F(stakeholder, 'Email') || '';
    if (!stakeholderEmail) { window.__oikeToast('This contact has no email address.', 'warning'); return; }

    // Parse subject from generated message (first line must be "Subject: ...")
    const lines = currentMessage.split('\n');
    const subjectLine = lines.find(l => l.toLowerCase().startsWith('subject:'));
    const subject = subjectLine ? subjectLine.replace(/^subject:\s*/i, '').trim() : '(no subject)';
    const bodyStart = lines.findIndex(l => l.toLowerCase().startsWith('subject:'));
    const messageBody = bodyStart >= 0
      ? lines.slice(bodyStart + 1).join('\n').replace(/^\s*\n/, '').trim()
      : currentMessage.trim();

    // Find thread context from last received email
    const lastReceived = sOutreach.find(o => ['Received', 'Replied'].includes(F(o, 'Status') || ''));
    const lastNotes = lastReceived ? (F(lastReceived, 'Notes') || '') : '';
    const threadMatch  = lastNotes.match(/\[gthread:([^\]]+)\]/);
    const gmsgidMatch  = lastNotes.match(/\[gmsgid:([^\]]+)\]/);
    const gmsgMatch    = lastNotes.match(/\[gmsg:([^\]]+)\]/);
    const threadId     = threadMatch ? threadMatch[1] : null;
    const inReplyTo    = gmsgidMatch ? gmsgidMatch[1] : null;
    const readMsgId    = gmsgMatch   ? gmsgMatch[1]   : null;
    const ccList = (ccPartner && cpEmails.length > 0) ? cpEmails : [];

    setSendingGmail(true);
    try {
      const res = await fetch('/api/gmail/send', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          to: stakeholderEmail,
          subject,
          message: messageBody,
          cc: ccList.length ? ccList : undefined,
          threadId:      threadId   || undefined,
          inReplyTo:     inReplyTo  || undefined,
          readMessageId: readMsgId  || undefined,
          stakeholderId: stakeholder.id,
          accountIds: accountIds || [],
          baseId: AIRTABLE_BASE_ID,
          outreachTableId: TABLE_IDS.outreach,
        }),
      });
      const result = await res.json();
      if (!res.ok) {
        // Scope not granted yet — fall back to Gmail compose with subject pre-filled
        const ccParam = ccList.length > 0 ? `&cc=${encodeURIComponent(ccList.join(','))}` : '';
        window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(stakeholderEmail)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(messageBody)}${ccParam}`, '_blank');
        if (result.error?.includes('connect') || result.error?.includes('scope') || result.error?.includes('auth')) {
          window.__oikeToast('Reconnect Gmail in Settings → Integrations to send directly from the app. Opening Gmail compose instead.', 'error');
        }
        setSendingGmail(false);
        return;
      }
      if (onSuccess) onSuccess();
      onClose();
    } catch (e) {
      // Network error — fall back to Gmail compose
      const ccParam = ccList.length > 0 ? `&cc=${encodeURIComponent(ccList.join(','))}` : '';
      window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(stakeholderEmail)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(messageBody)}${ccParam}`, '_blank');
    }
    setSendingGmail(false);
  };

  const handleSend = (channel) => {
    if (!currentMessage.trim()) return;
    const ccList = (channel === 'Email' && ccPartner && cpEmails.length > 0) ? cpEmails : [];
    // Pass selectedEventId whenever an event is selected — regardless of invite/followup mode
    onSend(stakeholder, channel, currentMessage, ccList, selectedEventId || null);
    onClose();
  };

  const handleSaveDraft = async () => {
    if (!currentMessage.trim() || !selectedChannel) return;
    setSavingDraft(true);

    // Parse subject/body for Email
    const lines = currentMessage.split('\n');
    const subjectLine = lines.find(l => l.toLowerCase().startsWith('subject:'));
    const subject = subjectLine ? subjectLine.replace(/^subject:\s*/i, '').trim() : `[DRAFT] Email to ${sName}`;
    const bodyStart = lines.findIndex(l => l.toLowerCase().startsWith('subject:'));
    const messageBody = bodyStart >= 0 ? lines.slice(bodyStart + 1).join('\n').replace(/^\s*\n/, '').trim() : currentMessage.trim();
    const stakeholderEmail = F(stakeholder, 'Email') || '';
    const ccList = (selectedChannel === 'Email' && ccPartner && cpEmails.length > 0) ? cpEmails : [];

    // If Email + Gmail connected → save as real Gmail draft
    if (selectedChannel === 'Email' && gmailConnected && stakeholderEmail) {
      try {
        const lastReceived = sOutreach.find(o => ['Received', 'Replied'].includes(F(o, 'Status') || ''));
        const lastNotes = lastReceived ? (F(lastReceived, 'Notes') || '') : '';
        const threadMatch = lastNotes.match(/\[gthread:([^\]]+)\]/);
        const inReplyTo   = lastNotes.match(/\[gmsgid:([^\]]+)\]/)?.[1];

        const res = await fetch('/api/gmail/send', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            to: stakeholderEmail,
            subject,
            message: messageBody,
            cc: ccList.length ? ccList : undefined,
            threadId:  threadMatch ? threadMatch[1] : undefined,
            inReplyTo: inReplyTo || undefined,
            stakeholderId: stakeholder.id,
            accountIds: accountIds || [],
            baseId: AIRTABLE_BASE_ID,
            outreachTableId: TABLE_IDS.outreach,
            draft: true,
          }),
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Draft failed');
        window.__oikeToast('✅ Draft saved to Gmail Borradores!', 'success');
        if (onSuccess) onSuccess();
        onClose();
      } catch (e) {
        window.__oikeToast('Failed to save Gmail draft: ' + (e.message || 'unknown error'), 'error');
      }
      setSavingDraft(false);
      return;
    }

    // Fallback: save to Airtable only
    try {
      const a = new AirtableAPI();
      await a.createRecord(TABLE_IDS.outreach, {
        'Activity Name': `[DRAFT] ${selectedChannel} to ${sName} — ${new Date().toLocaleDateString('en-US')}`,
        'Account': accountIds,
        'Stakeholder': [stakeholder.id],
        'Channel': selectedChannel,
        'Date': new Date().toISOString(),
        'Status': 'Draft',
        'Message': currentMessage,
        'Notes': `Saved as draft from AI Message Generator (${tab === 'first' ? 'First Contact' : tab === 'breakup' ? 'Breakup' : 'Follow-up'})${selectedChannel === 'Email' && ccPartner && cpEmails.length > 0 ? ` | CC: ${cpEmails.join(', ')}` : ''}`,
        'Logged By': CURRENT_USER?.name || '',
        ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
        ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
      });
      window.__oikeToast('Draft saved to Airtable.', 'success');
      onClose();
    } catch (e) {
      console.error('Save draft failed:', e);
      window.__oikeToast('Failed to save draft.', 'error');
    }
    setSavingDraft(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 580, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>AI Message Generator</h3>
          <span style={{ fontSize: 12, color: 'var(--globant-muted)' }}>{sName} · {role}</span>
        </div>

        {/* Context preview */}
        <div style={{ padding: '8px 10px', background: 'rgba(91,191,181,0.06)', borderRadius: 8, marginBottom: 12, borderLeft: '3px solid var(--globant-green)', fontSize: 11, color: 'var(--globant-muted)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--globant-green)' }}>Context loaded:</strong>{' '}
          {painText ? '✅ Pain points' : '⚠️ No pain points'} · {linkedinText ? '✅ LinkedIn news' : '⚠️ No LinkedIn news'} · {newsText ? '✅ Company news' : '⚠️ No company news'} · {intelNotesText ? '✅ Intel notes' : '⚠️ No intel notes'} · {sOutreach.length > 0
            ? `✅ ${sOutreach.length} touch${sOutreach.length!==1?'es':''}${convoReplyCount > 0 ? ` · ${convoReplyCount} repl${convoReplyCount>1?'ies':'y'} from them` : ''}${convoDaysSinceTheirLast !== null ? ` · last from them ${convoDaysSinceTheirLast}d ago` : ''}`
            : '⚠️ No history'}
        </div>

        {/* Step 1: Channel */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 11, marginBottom: 6, color: 'var(--globant-muted)', fontWeight: 600 }}>1. CHANNEL</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {availableChannels.map(ch => (
              <button key={ch} className={`action-btn ${selectedChannel === ch ? 'btn-primary' : 'btn-ghost'}`} style={{ fontSize: 12 }}
                onClick={() => setSelectedChannel(ch)}>
                {channelIcon[ch]} {ch}
              </button>
            ))}
          </div>
          {/* CC Client Partner toggle — only for Email */}
          {selectedChannel === 'Email' && cpEmails.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(91,191,181,0.06)', borderRadius: 8, border: '1px solid rgba(91,191,181,0.15)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, flex: 1 }}>
                <input type="checkbox" checked={ccPartner} onChange={e => setCcPartner(e.target.checked)}
                  style={{ accentColor: 'var(--globant-green)', width: 16, height: 16 }} />
                <span style={{ fontWeight: 600, color: 'var(--globant-green)' }}>CC Client Partner</span>
                <span style={{ color: 'var(--globant-muted)', fontSize: 11 }}>
                  {matchedCPs.map(cp => `${F(cp, 'Name')} (${F(cp, 'Email')})`).join(', ')}
                </span>
              </label>
            </div>
          )}
          {selectedChannel === 'Email' && cpEmails.length === 0 && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--globant-muted)', fontStyle: 'italic' }}>
              ℹ️ No Client Partner found for this account. Add CPs in Airtable's "Client Partners" table.
            </div>
          )}
        </div>

        {/* Step 2: Message type */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 11, marginBottom: 6, color: 'var(--globant-muted)', fontWeight: 600 }}>2. MESSAGE TYPE</label>
          <div className="tabs">
            <button className={`tab-btn ${tab === 'first' ? 'active' : ''}`} onClick={() => setTab('first')}>First Contact</button>
            <button className={`tab-btn ${tab === 'followup' ? 'active' : ''}`} onClick={() => setTab('followup')}>Follow-up{sOutreach.length > 0 ? ` · ${sOutreach.length}` : ''}</button>
            <button className={`tab-btn ${tab === 'breakup' ? 'active' : ''}`} onClick={() => setTab('breakup')}>Breakup 💀</button>
          </div>
        </div>

        {/* Advanced toggle */}
        <div style={{ marginBottom: showAdvanced ? 12 : 4 }}>
          <button onClick={() => setShowAdvanced(v => !v)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--globant-muted)', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 10 }}>{showAdvanced ? '▼' : '▶'}</span>
            <span>{showAdvanced ? 'Hide advanced options' : '+ Event / Solution (optional)'}</span>
          </button>
        </div>

        {showAdvanced && <>
        {/* Event reference */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 11, marginBottom: 6, color: 'var(--globant-muted)', fontWeight: 600 }}>EVENT REFERENCE <span style={{ fontWeight: 400 }}>(optional)</span></label>
          <select className="input-field" style={{ width: '100%', fontSize: 12 }}
            value={selectedEventId} onChange={e => { setSelectedEventId(e.target.value); setEventMode('invite'); }}>
            <option value="">— No event (general outreach) —</option>
            {events.sort((a, b) => new Date(b.fields?.['Starting'] || 0) - new Date(a.fields?.['Starting'] || 0)).map(ev => {
              const evName = F(ev, 'Event Name') || 'Unnamed';
              const evDate = ev.fields?.['Starting'] ? new Date(ev.fields['Starting']).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
              return <option key={ev.id} value={ev.id}>{evName}{evDate ? ` (${evDate})` : ''}</option>;
            })}
          </select>
          {selectedEvent && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <button
                  onClick={() => setEventMode('invite')}
                  style={{ flex: 1, fontSize: 11, padding: '5px 0', borderRadius: 6, border: `1px solid ${eventMode === 'invite' ? 'var(--globant-green)' : 'var(--globant-border)'}`, background: eventMode === 'invite' ? 'rgba(91,191,181,0.15)' : 'rgba(255,255,255,0.03)', color: eventMode === 'invite' ? 'var(--globant-green)' : 'var(--globant-muted)', cursor: 'pointer', fontWeight: eventMode === 'invite' ? 700 : 400 }}>
                  🎫 Invite — "Are you going?"
                </button>
                <button
                  onClick={() => setEventMode('followup')}
                  style={{ flex: 1, fontSize: 11, padding: '5px 0', borderRadius: 6, border: `1px solid ${eventMode === 'followup' ? '#a78bfa' : 'var(--globant-border)'}`, background: eventMode === 'followup' ? 'rgba(167,139,250,0.15)' : 'rgba(255,255,255,0.03)', color: eventMode === 'followup' ? '#a78bfa' : 'var(--globant-muted)', cursor: 'pointer', fontWeight: eventMode === 'followup' ? 700 : 400 }}>
                  🤝 Follow-up — "Great meeting you"
                </button>
              </div>
              <div style={{ padding: '6px 10px', background: 'rgba(91,191,181,0.06)', borderRadius: 6, fontSize: 11, color: 'var(--globant-muted)', borderLeft: `3px solid ${eventMode === 'followup' ? '#a78bfa' : 'var(--globant-green)'}` }}>
                {eventMode === 'invite' ? '🎪' : '🤝'} <strong>{F(selectedEvent, 'Event Name')}</strong>
                {selectedEvent.fields?.['Starting'] && <span> · {new Date(selectedEvent.fields['Starting']).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>}
                <span style={{ marginLeft: 8, color: eventMode === 'followup' ? '#a78bfa' : 'var(--globant-green)' }}>{eventMode === 'invite' ? 'Invite mode' : 'Follow-up mode'}</span>
              </div>
            </div>
          )}
        </div>

        {/* Solution to pitch */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 11, marginBottom: 6, color: 'var(--globant-muted)', fontWeight: 600 }}>OFFERING TO PITCH <span style={{ fontWeight: 400 }}>(optional)</span></label>
          <select className="input-field" style={{ width: '100%', fontSize: 12 }}
            value={selectedSolutionId} onChange={e => setSelectedSolutionId(e.target.value)}>
            <option value="">— No specific solution —</option>
            {allSolutions.map(sol => (
              <option key={sol.id} value={sol.id}>{F(sol, 'Name')}</option>
            ))}
          </select>
          {selectedSolution && (
            <div style={{ marginTop: 6, padding: '6px 10px', background: 'rgba(91,191,181,0.06)', borderRadius: 6, fontSize: 11, color: 'var(--globant-muted)', borderLeft: '3px solid #a78bfa' }}>
              🛠️ <strong>{F(selectedSolution, 'Name')}</strong>
              {(() => { const d = F(selectedSolution, 'Service | Solution Detail'); return d ? <span> · {(typeof d === 'string' ? d : '').slice(0, 120)}...</span> : null; })()}
            </div>
          )}
        </div>

        </>}

        {/* Language selector */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 11, marginBottom: 6, color: 'var(--globant-muted)', fontWeight: 600 }}>LANGUAGE <span style={{ fontWeight: 400 }}>(auto-detected: {suggestedLanguage || 'English'})</span></label>
          <select className="input-field" style={{ width: '100%', fontSize: 12 }}
            value={selectedLanguage} onChange={e => setSelectedLanguage(e.target.value)}>
            <option value="">— Auto ({suggestedLanguage || 'English'}) —</option>
            <option value="English">🇬🇧 English</option>
            <option value="Spanish">🇪🇸 Español</option>
            <option value="Portuguese">🇧🇷 Português</option>
            <option value="French">🇫🇷 Français</option>
            <option value="Arabic">🇸🇦 العربية</option>
            <option value="German">🇩🇪 Deutsch</option>
            <option value="Italian">🇮🇹 Italiano</option>
          </select>
        </div>

        {/* Your context */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 11, marginBottom: 6, color: 'var(--globant-muted)', fontWeight: 600 }}>3. YOUR CONTEXT <span style={{ fontWeight: 400 }}>(optional — anything extra the AI should know)</span></label>
          <textarea
            className="input-field"
            style={{ width: '100%', minHeight: 50, resize: 'vertical', fontFamily: 'inherit', fontSize: 12 }}
            placeholder="E.g. I met them at LEAP, they mentioned interest in AI for customer service, focus on the retail banking angle..."
            value={extraContext}
            onChange={e => setExtraContext(e.target.value)}
          />
        </div>

        {/* Generate button */}
        <button
          className="action-btn btn-primary"
          style={{ width: '100%', marginBottom: 12, padding: '10px 16px' }}
          onClick={handleGenerate}
          disabled={loadingAI || !selectedChannel}
        >
          {loadingAI ? '⏳ Generating with GPT-4o...' : !selectedChannel ? 'Select a channel first ↑' : `✨ Generate ${tab === 'first' ? 'First Contact' : tab === 'breakup' ? 'Breakup' : 'Follow-up'} via ${selectedChannel}`}
        </button>

        {/* Generated message */}
        {currentMessage ? (
          <div className="message-box" style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto' }}>{currentMessage}</div>
        ) : (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--globant-muted)', fontSize: 12, background: 'rgba(255,255,255,0.03)', borderRadius: 8, marginBottom: 12 }}>
            Select channel + type, then click Generate
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="action-btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
          <button className="action-btn" style={{ flex: 1, background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }}
            onClick={handleSaveDraft} disabled={!selectedChannel || !currentMessage.trim() || savingDraft}>
            {savingDraft ? 'Saving...' : '📝 Draft'}
          </button>
          {selectedChannel === 'Email' && gmailConnected ? (
            <button className="action-btn" style={{ flex: 2, background: 'rgba(91,191,181,0.15)', color: 'var(--globant-green)', border: '1px solid rgba(91,191,181,0.3)', fontWeight: 700 }}
              onClick={handleSendViaGmail} disabled={!currentMessage.trim() || sendingGmail}>
              {sendingGmail ? '⏳ Sending...' : '✉️ Send via Gmail'}
            </button>
          ) : (
            <button className="action-btn btn-primary" style={{ flex: 1 }}
              onClick={() => selectedChannel && handleSend(selectedChannel)} disabled={!selectedChannel || !currentMessage.trim()}>
              Send {selectedChannel ? `via ${selectedChannel}` : ''}{selectedChannel === 'Email' && ccPartner && cpEmails.length > 0 ? ' + CC' : ''}
            </button>
          )}
        </div>
        {selectedChannel === 'Email' && !gmailConnected && (
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6, textAlign: 'center' }}>
            Connect Gmail in Settings to send directly from the app
          </div>
        )}
      </div>
    </div>
  );
}

// ============ FOLLOW-UP CENTER ============

export default AIMessageModal;
