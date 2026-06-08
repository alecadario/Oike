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


function LandingsHub({ data, api, onLogActivity, onAddRecord, onUpdateRecord }) {
  const { landings = [], stakeholders = [], accounts = [], solutions = [], events = [] } = data;

  const [selectedId, setSelectedId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editingLanding, setEditingLanding] = useState(null);
  const [saving, setSaving] = useState(false);
  const [generatingAI, setGeneratingAI] = useState(false);
  const [copied, setCopied] = useState(false);
  const [listSearch, setListSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // ── Language strings (EN default · ES · PT · FR · DE · IT · AR) ──
  const LANDING_I18N = {
    es: {
      greeting: 'Hola',
      heroSub: 'armé esto pensando en',
      painHeading: 'Lo que veo en',
      yourCompany: 'tu empresa',
      valueHeading: 'Cómo puedo ayudarte',
      valueHeadingWithSol: 'Cómo puedo ayudarte con',
      ctaIntro: 'Si lo que digo hace sentido:',
      ctaDefault: 'Hablemos 20 minutos',
      ctaFooter: 'Si no aplica, al menos te quedan estas ideas. No vendo en esta call.',
      poweredBy: 'Powered by',
      eventHeading: 'Te invito a',
      eventDate: 'Fecha',
      eventRegisterCta: 'Inscribirme al evento',
      eventOr: 'o si preferís hablar antes:',
      aiInstruction: 'Write in Spanish (using "vos" if natural — voseo style).',
      subject: (sName, accName) => `Pensé en ${sName ? sName + ' — ' : ''}${accName || 'tu empresa'}`,
    },
    en: {
      greeting: 'Hi',
      heroSub: 'I put this together thinking about',
      painHeading: 'What I see at',
      yourCompany: 'your company',
      valueHeading: 'How I can help you',
      valueHeadingWithSol: 'How I can help you with',
      ctaIntro: 'If what I\'m saying makes sense:',
      ctaDefault: 'Let\'s talk 20 minutes',
      ctaFooter: 'If it doesn\'t apply, at least you keep these ideas. No selling in this call.',
      poweredBy: 'Powered by',
      eventHeading: 'You\'re invited to',
      eventDate: 'Date',
      eventRegisterCta: 'Register for the event',
      eventOr: 'or if you\'d rather talk first:',
      aiInstruction: 'Write in English. Natural, direct, conversational — not formal corporate speak.',
      subject: (sName, accName) => `Thinking about ${sName ? sName + ' — ' : ''}${accName || 'your company'}`,
    },
    pt: {
      greeting: 'Olá',
      heroSub: 'preparei isto pensando em',
      painHeading: 'O que vejo em',
      yourCompany: 'sua empresa',
      valueHeading: 'Como posso ajudar você',
      valueHeadingWithSol: 'Como posso ajudar você com',
      ctaIntro: 'Se o que estou dizendo faz sentido:',
      ctaDefault: 'Vamos conversar 20 minutos',
      ctaFooter: 'Se não se aplica, pelo menos essas ideias ficam. Não vendo nessa call.',
      poweredBy: 'Powered by',
      eventHeading: 'Você está convidado(a) a',
      eventDate: 'Data',
      eventRegisterCta: 'Inscrever-me no evento',
      eventOr: 'ou se preferir conversar antes:',
      aiInstruction: 'Write in Brazilian Portuguese. Natural, direct, conversational.',
      subject: (sName, accName) => `Pensei em ${sName ? sName + ' — ' : ''}${accName || 'sua empresa'}`,
    },
    fr: {
      greeting: 'Bonjour',
      heroSub: 'j\'ai préparé ceci en pensant à',
      painHeading: 'Ce que je vois chez',
      yourCompany: 'votre entreprise',
      valueHeading: 'Comment je peux vous aider',
      valueHeadingWithSol: 'Comment je peux vous aider avec',
      ctaIntro: 'Si ce que je dis a du sens :',
      ctaDefault: 'Parlons 20 minutes',
      ctaFooter: 'Si ça ne s\'applique pas, vous gardez au moins ces idées. Pas de vente sur cet appel.',
      poweredBy: 'Powered by',
      eventHeading: 'Vous êtes invité(e) à',
      eventDate: 'Date',
      eventRegisterCta: 'M\'inscrire à l\'événement',
      eventOr: 'ou si vous préférez parler avant :',
      aiInstruction: 'Write in French. Natural, direct, conversational — not formal corporate speak.',
      subject: (sName, accName) => `Pensé à ${sName ? sName + ' — ' : ''}${accName || 'votre entreprise'}`,
    },
    de: {
      greeting: 'Hallo',
      heroSub: 'das hier habe ich mit Blick auf',
      painHeading: 'Was ich bei',
      yourCompany: 'Ihrem Unternehmen',
      valueHeading: 'Wie ich Ihnen helfen kann',
      valueHeadingWithSol: 'Wie ich Ihnen helfen kann mit',
      ctaIntro: 'Wenn das Sinn ergibt:',
      ctaDefault: 'Lassen Sie uns 20 Minuten reden',
      ctaFooter: 'Falls nicht passend, bleiben Ihnen zumindest die Ideen. Kein Verkauf in diesem Call.',
      poweredBy: 'Powered by',
      eventHeading: 'Sie sind eingeladen zu',
      eventDate: 'Datum',
      eventRegisterCta: 'Zum Event anmelden',
      eventOr: 'oder wenn Sie lieber vorher sprechen:',
      aiInstruction: 'Write in German. Use formal "Sie" form. Natural and direct, not stiff corporate German.',
      subject: (sName, accName) => `Gedanken zu ${sName ? sName + ' — ' : ''}${accName || 'Ihrem Unternehmen'}`,
    },
    it: {
      greeting: 'Ciao',
      heroSub: 'ho preparato questo pensando a',
      painHeading: 'Quello che vedo in',
      yourCompany: 'la vostra azienda',
      valueHeading: 'Come posso aiutarvi',
      valueHeadingWithSol: 'Come posso aiutarvi con',
      ctaIntro: 'Se quello che dico ha senso:',
      ctaDefault: 'Parliamo 20 minuti',
      ctaFooter: 'Se non si applica, almeno vi restano queste idee. Niente vendita in questa call.',
      poweredBy: 'Powered by',
      eventHeading: 'Siete invitati a',
      eventDate: 'Data',
      eventRegisterCta: 'Iscrivermi all\'evento',
      eventOr: 'o se preferite parlare prima:',
      aiInstruction: 'Write in Italian. Natural, direct, conversational — formal "voi" or "Lei" depending on context.',
      subject: (sName, accName) => `Pensato a ${sName ? sName + ' — ' : ''}${accName || 'la vostra azienda'}`,
    },
    ar: {
      greeting: 'مرحباً',
      heroSub: 'أعددت هذا وأنا أفكر في',
      painHeading: 'ما أراه في',
      yourCompany: 'شركتكم',
      valueHeading: 'كيف يمكنني مساعدتكم',
      valueHeadingWithSol: 'كيف يمكنني مساعدتكم مع',
      ctaIntro: 'إذا كان ما أقوله منطقياً:',
      ctaDefault: 'لنتحدث 20 دقيقة',
      ctaFooter: 'إذا لم يكن مناسباً، تبقى لكم هذه الأفكار على الأقل. لا بيع في هذه المكالمة.',
      poweredBy: 'Powered by',
      eventHeading: 'أنتم مدعوون إلى',
      eventDate: 'التاريخ',
      eventRegisterCta: 'التسجيل في الفعالية',
      eventOr: 'أو إذا كنتم تفضلون الحديث أولاً:',
      aiInstruction: 'Write in Modern Standard Arabic (formal but conversational). Use plural "you" form (أنتم) for respect. The HTML supports RTL.',
      subject: (sName, accName) => `أفكر في ${sName ? sName + ' — ' : ''}${accName || 'شركتكم'}`,
    },
  };

  // Form state — English by default
  const emptyForm = {
    slug: '',
    stakeholderId: '',
    accountId: '',
    solutionId: '',
    eventId: '',
    eventRegisterLink: '', // custom override; if empty, uses event's URL field
    language: 'en',
    visualStyle: 'modern', // 'modern' | 'bold' | 'minimal'
    heroTagline: '', // Custom hero subtitle ("I put this together thinking about" by default). Empty = use i18n default
    hook: '',
    painContext: '',
    valueProposition: '',
    bullets: '',
    socialProof: '',
    ctaText: LANDING_I18N.en.ctaDefault,
    ctaLink: COMPANY_PROFILE.calendarLink || 'https://calendar.app.google/',
    status: 'Draft',
    // Section toggles — control which blocks appear in the rendered landing
    sections: { hook: true, pain: true, value: true, bullets: true, socialProof: true, event: true, cta: true },
  };
  const [form, setForm] = useState(emptyForm);

  // Branding from Settings (localStorage)
  const branding = (() => {
    try { return JSON.parse(localStorage.getItem('oike_proposal_branding') || '{}'); } catch { return {}; }
  })();
  const senderName = branding.senderName || COMPANY_PROFILE.senderName || CURRENT_USER?.name || 'Ale';
  const senderEmail = branding.senderEmail || CURRENT_USER?.email || '';
  const senderLogo = branding.senderLogo || '';
  const senderPhoto = branding.senderPhoto || '';
  const senderTitle = branding.senderTitle || '';
  const accentColor = branding.accentColor || '#5BBFB5';        // Primary
  const secondaryColor = branding.secondaryColor || '#A78BFA';  // Secondary
  const tertiaryColor = branding.tertiaryColor || '#FBBF24';    // Tertiary / highlight
  const darkColor = branding.darkColor || '#0D0D1A';

  // ── Check for prefill stakeholder from navigation (e.g. from Stakeholder History Modal) ──
  useEffect(() => {
    try {
      const prefillId = sessionStorage.getItem('oike_landing_prefill_stakeholder');
      if (prefillId && stakeholders.find(s => s.id === prefillId)) {
        setForm(f => ({
          ...emptyForm,
          stakeholderId: prefillId,
          slug: autoSlugFromStakeholder(prefillId),
        }));
        setShowForm(true);
        sessionStorage.removeItem('oike_landing_prefill_stakeholder');
      }
    } catch {}
  }, [stakeholders.length]);

  // ── Check for prefill account from navigation (e.g. from Presentations tab) ──
  useEffect(() => {
    try {
      const prefillAccId = sessionStorage.getItem('oike_landing_prefill_account');
      if (prefillAccId) {
        const accStk = stakeholders.filter(s => linkedIds(s, 'Account').includes(prefillAccId));
        const onlyOne = accStk.length === 1;
        setForm(f => ({
          ...emptyForm,
          accountId: prefillAccId,
          stakeholderId: onlyOne ? accStk[0].id : '',
          slug: onlyOne ? autoSlugFromStakeholder(accStk[0].id) : '',
        }));
        setShowForm(true);
        sessionStorage.removeItem('oike_landing_prefill_account');
      }
    } catch {}
  }, [stakeholders.length]);

  // ── Filtered landings list ──
  const filteredLandings = useMemo(() => landings.filter(l => {
    if (statusFilter && F(l, 'Status') !== statusFilter) return false;
    if (listSearch) {
      const q = listSearch.toLowerCase();
      const slug = (F(l, 'Slug') || '').toLowerCase();
      const stkIds = linkedIds(l, 'Stakeholder');
      const stk = stkIds[0] ? stakeholders.find(s => s.id === stkIds[0]) : null;
      const stkName = stk ? `${F(stk,'Name')||''} ${F(stk,'Last name')||''}`.toLowerCase() : '';
      if (!slug.includes(q) && !stkName.includes(q)) return false;
    }
    return true;
  }).sort((a,b) => new Date(b.createdTime || 0) - new Date(a.createdTime || 0)), [landings, listSearch, statusFilter, stakeholders]);

  // ── Helpers for auto-fill ──
  const autoSlugFromStakeholder = (stakeholderId) => {
    const s = stakeholders.find(x => x.id === stakeholderId);
    if (!s) return '';
    const n = (F(s,'Name')||'').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const l = (F(s,'Last name')||'').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const accId = linkedIds(s,'Account')[0];
    const acc = accId ? accounts.find(a => a.id === accId) : null;
    const accSlug = acc ? (F(acc,'Account Name')||'').toLowerCase().replace(/[^a-z0-9]+/g, '-') : '';
    return [n, l, accSlug].filter(Boolean).join('-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  };

  // ── Auto-detect language based on stakeholder/account country ──
  const detectLanguageFromCountry = (stakeholder, account) => {
    const country = (stakeholder ? F(stakeholder, 'Country') : '') || (account ? F(account, 'Country') : '') || '';
    const c = String(country).toLowerCase();
    // Portuguese
    if (c.includes('brazil') || c.includes('brasil') || c.includes('portugal')) return 'pt';
    // Spanish (LatAm + España)
    const esCountries = ['spain','españa','espana','mexico','méxico','argentina','colombia','chile','peru','perú','venezuela','ecuador','bolivia','paraguay','uruguay','guatemala','honduras','costa rica','panama','panamá','el salvador','nicaragua','dominican','cuba','puerto rico'];
    if (esCountries.some(k => c.includes(k))) return 'es';
    // French
    const frCountries = ['france','belgium','belgique','luxembourg','monaco','senegal','sénégal','ivory coast',"côte d'ivoire",'morocco','maroc','tunisia','tunisie','algeria','algérie','quebec','québec'];
    if (frCountries.some(k => c.includes(k))) return 'fr';
    // German
    const deCountries = ['germany','deutschland','austria','österreich','switzerland','schweiz','liechtenstein'];
    if (deCountries.some(k => c.includes(k))) return 'de';
    // Italian
    if (c.includes('italy') || c.includes('italia') || c.includes('vatican') || c.includes('san marino')) return 'it';
    // Arabic (MENA — Saudi, UAE, Qatar, Kuwait, Bahrain, Oman, Egypt, Jordan, Iraq, Lebanon, Yemen, Syria, Libya)
    const arCountries = ['saudi','uae','united arab emirates','emirates','qatar','kuwait','bahrain','oman','egypt','egipto','jordan','iraq','lebanon','líbano','yemen','syria','siria','libya','libia','sudan','sudán','palestine','palestina'];
    if (arCountries.some(k => c.includes(k))) return 'ar';
    // English (default for everything else: USA, UK, Europe non-listed, Asia, Africa)
    if (c) return 'en';
    return null; // unknown country, don't override
  };

  // Pick stakeholder → auto-fill slug + account + language detection
  const onPickStakeholder = (stakeholderId) => {
    const s = stakeholders.find(x => x.id === stakeholderId);
    const accId = s ? linkedIds(s, 'Account')[0] : '';
    const acc = accId ? accounts.find(a => a.id === accId) : null;
    const detectedLang = detectLanguageFromCountry(s, acc);
    setForm(f => ({
      ...f,
      stakeholderId,
      accountId: accId || f.accountId,
      slug: f.slug || autoSlugFromStakeholder(stakeholderId),
      // Override language if we can detect from country (and only if user hasn't manually picked yet)
      language: detectedLang || f.language,
      ctaText: detectedLang && (f.ctaText === LANDING_I18N[f.language || 'en'].ctaDefault || !f.ctaText)
        ? LANDING_I18N[detectedLang].ctaDefault
        : f.ctaText,
    }));
  };

  // Pick account (standalone, no stakeholder) — also detect language from account country
  const onPickAccount = (accountId) => {
    const a = accounts.find(x => x.id === accountId);
    const detectedLang = detectLanguageFromCountry(null, a);
    setForm(f => ({
      ...f,
      accountId,
      slug: f.slug || (a ? (F(a, 'Account Name')||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') : ''),
      language: detectedLang || f.language,
      ctaText: detectedLang && (f.ctaText === LANDING_I18N[f.language || 'en'].ctaDefault || !f.ctaText)
        ? LANDING_I18N[detectedLang].ctaDefault
        : f.ctaText,
    }));
  };

  // AI auto-fill — uses stakeholder + solution + account context
  const aiAutofill = async () => {
    if (!form.stakeholderId && !form.accountId) { window.__oikeToast('Pick at least an account or stakeholder first', 'warning'); return; }
    setGeneratingAI(true);
    try {
      const s = form.stakeholderId ? stakeholders.find(x => x.id === form.stakeholderId) : null;
      const sol = form.solutionId ? solutions.find(x => x.id === form.solutionId) : null;
      const ev = form.eventId ? events.find(x => x.id === form.eventId) : null;
      // Account: explicit wins, otherwise from stakeholder
      const accId = form.accountId || (s ? linkedIds(s, 'Account')[0] : null);
      const acc = accId ? accounts.find(a => a.id === accId) : null;

      const sName = s ? `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim() : '';
      const sRole = s ? F(s,'Role') || '' : '';
      const accName = acc ? F(acc,'Account Name') : '';
      const industry = acc ? F(acc,'Industry') : '';
      const pain = s ? (F(s,'Pain Points (Generated)') || F(s,'Pain points') || '').slice(0, 400) : '';
      const linkedinNews = s ? (F(s,'LinkedIn News (Generated)') || F(s,'Linkedin lates news') || '').slice(0, 300) : '';
      const accNews = acc ? (F(acc,'Recent News')||'').slice(0, 300) : '';
      const accIntel = acc ? (F(acc,'Intel Notes')||'').slice(0, 400) : '';
      const solName = sol ? F(sol,'Name') : '';
      const solDetail = sol ? (F(sol,'Service | Solution Detail')||'').slice(0, 300) : '';
      const solKeyMsg = sol ? F(sol,'Stakeholder Key Message') : '';

      const evName = ev ? F(ev,'Event Name') : '';
      const evDate = ev?.fields?.['Starting'] ? new Date(ev.fields['Starting']).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }) : '';
      const evContext = ev ? (F(ev,'Aditional context')||'').slice(0, 400) : '';
      const evExecSummary = ev ? (F(ev,'Exec Summary')||'').slice(0, 1500) : '';

      const langInstruction = LANDING_I18N[form.language || 'en'].aiInstruction;
      const targetDescriptor = sName
        ? `${sName}${sRole ? ` (${sRole})` : ''}${accName ? ` at ${accName}` : ''}`
        : `${accName || 'the company'}${industry ? ` (${industry})` : ''} — company-level (no specific stakeholder)`;

      const prompt = `Generate content for a personalized landing page for a B2B prospect.

LANGUAGE: ${langInstruction}

TARGET: ${targetDescriptor}
${industry ? `Industry: ${industry}` : ''}
${pain ? `Stakeholder pain points: ${pain}` : ''}
${linkedinNews ? `LinkedIn news of contact: ${linkedinNews}` : ''}
${accNews ? `Company news: ${accNews}` : ''}
${accIntel ? `Company intel notes: ${accIntel}` : ''}

${solName ? `SOLUTION WE OFFER: ${solName}\n${solDetail}\n${solKeyMsg ? `Key message: ${solKeyMsg}` : ''}` : ''}

${evName ? `EVENT TO INVITE THEM TO: "${evName}"${evDate ? ` on ${evDate}` : ''}${evContext ? `\nEvent context: ${evContext}` : ''}${evExecSummary ? `\n\nEVENT EXECUTIVE SUMMARY (use this as ground truth for what the event is, who should attend, and why):\n${evExecSummary}\n\nIMPORTANT: Use the executive summary to:\n1. Match the prospect to one of the "Hooks for invitations" angles in the summary\n2. Reference the "Why it matters now" trigger to anchor urgency\n3. Mention what they'll concretely take away (from "What attendees take away")\nThe hook should connect this prospect's specific context (their pain, role, recent news) with WHY this event is for them specifically. Don't recite the event details — translate them into a personal invitation.` : '\nIMPORTANT: Reference this event naturally in the content. The hook OR the value proposition should mention WHY this prospect specifically is a great fit for this event.'}` : ''}

Generate 4 short sections in JSON format. Each very direct, human, no filler.

Return ONLY this JSON:
{
  "hook": "Opening line — max 2 sentences. Reference a specific trigger (news, role, their context). NOT generic.",
  "painContext": "2-3 sentences describing what we see happening in their company and why it's a real pain. Be specific.",
  "valueProposition": "2-3 sentences on how our solution addresses their specific context. Concrete, not salesy.",
  "bullets": "3-4 specific value points, one per line (no markdown, just plain text)."
}

BANNED in any language: "hope this finds you well", "just reaching out", "I wanted to", "espero que estés bien", "te quería escribir", generic business jargon.`;

      const raw = await callOpenAI({ prompt, temperature: 0.6, max_tokens: 800 });
      const cleaned = raw.replace(/```json?\n?/g,'').replace(/```/g,'').trim();
      const parsed = JSON.parse(cleaned);

      setForm(f => ({
        ...f,
        hook: parsed.hook || f.hook,
        painContext: parsed.painContext || f.painContext,
        valueProposition: parsed.valueProposition || f.valueProposition,
        bullets: parsed.bullets || f.bullets,
      }));
    } catch (e) {
      console.error('AI autofill failed:', e);
      window.__oikeToast('AI autofill failed — check the console', 'error');
    }
    setGeneratingAI(false);
  };

  // Build the HTML preview
  const buildLandingHTML = (f) => {
    const s = f.stakeholderId ? stakeholders.find(x => x.id === f.stakeholderId) : null;
    const sol = f.solutionId ? solutions.find(x => x.id === f.solutionId) : null;
    const ev = f.eventId ? events.find(x => x.id === f.eventId) : null;
    // Account: explicit form.accountId wins; else pull from stakeholder's linked account
    const accId = f.accountId || (s ? linkedIds(s,'Account')[0] : null);
    const acc = accId ? accounts.find(a => a.id === accId) : null;
    const sName = s ? `${F(s,'Name')||''} ${F(s,'Last name')||''}`.trim() : 'Prospect';
    const sRole = s ? F(s,'Role') || '' : '';
    const accName = acc ? F(acc,'Account Name') : '';
    const solName = sol ? F(sol,'Name') : '';
    const evName = ev ? F(ev,'Event Name') : '';
    const evStart = ev?.fields?.['Starting'] ? new Date(ev.fields['Starting']) : null;
    const evDateStr = evStart ? evStart.toLocaleDateString(f.language === 'en' ? 'en-US' : (f.language === 'pt' ? 'pt-BR' : 'es-ES'), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '';
    const evRegisterLink = (f.eventRegisterLink || '').trim() || (ev ? F(ev,'URL') || '' : '');

    // Get clean event description for the landing — prefers Exec Summary's intro,
    // strips raw FILE: blocks from Aditional context, never shows raw file dumps.
    const getEventDescription = () => {
      if (!ev) return '';
      const execSummary = F(ev, 'Exec Summary') || '';
      if (execSummary) {
        // Try to extract "What this event is" section from the structured summary
        const sectionMatch = execSummary.match(/###[^\n]*?(What this event is|Qué es|O que é)[^\n]*\n([\s\S]+?)(?=\n###|$)/i);
        if (sectionMatch && sectionMatch[2]) {
          return sectionMatch[2].trim().replace(/\*\*/g, '').slice(0, 380);
        }
        // Fallback: first paragraph after the first heading
        const firstPara = execSummary.replace(/###[^\n]+\n/, '').split('\n###')[0].replace(/\*\*/g, '').trim();
        if (firstPara.length > 20) return firstPara.slice(0, 380);
      }
      // No exec summary → strip FILE: blocks from manual context
      const context = F(ev, 'Aditional context') || '';
      if (!context) return '';
      // Remove "📎 FILE: ..." headers AND their following bullet content (until next FILE: or end)
      const stripped = context.replace(/📎\s*FILE:[\s\S]*?(?=\n📎\s*FILE:|$)/g, '').trim();
      if (stripped.length > 20) return stripped.slice(0, 380);
      return '';
    };
    const evDescription = getEventDescription();
    const bulletsList = (f.bullets||'').split('\n').map(b => b.trim()).filter(Boolean);
    const escape = (x) => String(x||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // Gmail-safe: escape + convert newlines to <br> (avoids white-space:pre-wrap which breaks in Outlook)
    const nl2br = (x) => escape(x).replace(/\r?\n/g, '<br>');
    const lang = f.language || 'en';
    const t = LANDING_I18N[lang] || LANDING_I18N.en;
    const isRTL = lang === 'ar';
    // Section toggles — defaults to ON, respect user's off switches
    const S = { hook: true, pain: true, value: true, bullets: true, socialProof: true, event: true, cta: true, ...(f.sections || {}) };

    // Shared event block — Gmail-safe (solid bg, no gradient, no flex)
    const eventBlock = (ev && S.event) ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;border-collapse:separate;">
  <tr><td bgcolor="${secondaryColor}11" style="background:${secondaryColor}11;padding:20px 22px;border:2px solid ${secondaryColor};border-radius:12px;">
    <div style="font-size:11px;font-weight:800;color:${secondaryColor};letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;font-family:Arial,Helvetica,sans-serif;">🎟️ ${t.eventHeading}</div>
    <div style="font-size:20px;font-weight:800;color:${darkColor};line-height:1.2;margin-bottom:8px;font-family:Arial,Helvetica,sans-serif;">${escape(evName)}</div>
    ${evDateStr ? `<div style="font-size:13px;color:#6B7280;margin-bottom:10px;font-family:Arial,Helvetica,sans-serif;"><strong style="color:${darkColor};">${t.eventDate}:</strong> ${escape(evDateStr)}</div>` : ''}
    ${evDescription ? `<div style="font-size:13px;color:#374151;line-height:1.55;margin-bottom:14px;font-family:Arial,Helvetica,sans-serif;">${nl2br(evDescription)}</div>` : ''}
    ${evRegisterLink ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${secondaryColor}" style="background:${secondaryColor};border-radius:8px;"><a href="${escape(evRegisterLink)}" style="display:inline-block;padding:11px 22px;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;font-family:Arial,Helvetica,sans-serif;">${t.eventRegisterCta} &rarr;</a></td></tr></table>` : ''}
  </td></tr>
</table>` : '';

    // ─────────────────────────────────────────────────────
    // TEMPLATE: MODERN — clean, sophisticated, balanced
    // ─────────────────────────────────────────────────────
    const renderModern = () => `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="${lang}"${isRTL ? ' dir="rtl"' : ''}>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<meta name="x-apple-disable-message-reformatting" />
<title>${escape(sName)}${accName ? ' &middot; ' + escape(accName) : ''}</title>
<!--[if mso]><style type="text/css">table,td,div,h1,h2,h3,p,a{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->
</head>
<body${isRTL ? ' dir="rtl"' : ''} style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:${darkColor};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4f6" style="background:#f3f4f6;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="620" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:620px;background:#ffffff;border-radius:16px;border-collapse:separate;">

  <!-- Hero — solid color (Gmail-safe), no gradient -->
  <tr><td bgcolor="${darkColor}" align="center" style="background:${darkColor};padding:48px 36px 40px;text-align:center;border-bottom:4px solid ${accentColor};border-radius:16px 16px 0 0;">
${senderLogo ? `<img src="${escape(senderLogo)}" alt="Logo" width="auto" height="48" style="display:block;max-height:48px;max-width:180px;margin:0 auto 24px;border:0;outline:none;" />` : ''}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 16px;">
  <tr><td bgcolor="${accentColor}25" style="background:${accentColor}25;border:1px solid ${accentColor}66;border-radius:20px;padding:5px 14px;color:${accentColor};font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif;">
    ${escape(sRole || 'For')} ${sName ? '&middot; ' + escape(sName.split(' ')[0]) : ''}
  </td></tr>
</table>
<h1 style="margin:0;font-size:32px;color:#ffffff;font-weight:800;line-height:1.15;letter-spacing:-0.5px;font-family:Arial,Helvetica,sans-serif;">${t.greeting} ${escape(sName.split(' ')[0])} &mdash;</h1>
<p style="margin:14px 0 0;font-size:15px;color:#D1D5DB;line-height:1.5;font-family:Arial,Helvetica,sans-serif;">${escape(f.heroTagline || t.heroSub)} <strong style="color:${accentColor};">${escape(accName || sName)}</strong></p>
  </td></tr>

  <!-- Body -->
  <tr><td style="padding:40px 36px 32px;"${isRTL ? ' dir="rtl"' : ''}>

${(f.hook && S.hook) ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 32px;border-collapse:separate;">
  <tr><td bgcolor="${accentColor}10" style="background:${accentColor}10;padding:20px 24px;border-left:4px solid ${accentColor};border-radius:0 12px 12px 0;font-size:16px;line-height:1.55;color:${darkColor};font-weight:500;font-family:Arial,Helvetica,sans-serif;">
    ${nl2br(f.hook)}
  </td></tr>
</table>` : ''}

${(f.painContext && S.pain) ? `
<div style="margin-bottom:32px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;"><tr>
    <td valign="middle" width="6" style="background:${tertiaryColor};border-radius:3px;font-size:0;line-height:0;">&nbsp;</td>
    <td valign="middle" style="padding-left:10px;font-size:20px;font-weight:800;color:${darkColor};letter-spacing:-0.3px;font-family:Arial,Helvetica,sans-serif;">${t.painHeading} ${escape(accName || t.yourCompany)}</td>
  </tr></table>
  <div style="font-size:15px;color:#374151;line-height:1.65;font-family:Arial,Helvetica,sans-serif;">${nl2br(f.painContext)}</div>
</div>` : ''}

${(f.valueProposition && S.value) ? `
<div style="margin-bottom:28px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;"><tr>
    <td valign="middle" width="6" style="background:${accentColor};border-radius:3px;font-size:0;line-height:0;">&nbsp;</td>
    <td valign="middle" style="padding-left:10px;font-size:20px;font-weight:800;color:${darkColor};letter-spacing:-0.3px;font-family:Arial,Helvetica,sans-serif;">${solName ? t.valueHeadingWithSol + ' ' + escape(solName) : t.valueHeading}</td>
  </tr></table>
  <div style="font-size:15px;color:#374151;line-height:1.65;font-family:Arial,Helvetica,sans-serif;">${nl2br(f.valueProposition)}</div>
</div>` : ''}

${(bulletsList.length && S.bullets) ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 32px;border-collapse:separate;">
  <tr><td bgcolor="#FAFAFA" style="background:#FAFAFA;padding:20px 22px;border-radius:12px;border:1px solid ${accentColor}22;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${bulletsList.map((b, i) => {
        const colors = [accentColor, secondaryColor, tertiaryColor, accentColor];
        const c = colors[i % colors.length];
        const isLast = i === bulletsList.length - 1;
        return `<tr>
          <td valign="top" width="42" style="padding:8px 14px 8px 0;${isLast ? '' : `border-bottom:1px solid ${c}15;`}">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td bgcolor="${c}20" align="center" valign="middle" width="28" height="28" style="background:${c}20;color:${c};font-weight:800;font-size:13px;border-radius:14px;width:28px;height:28px;line-height:28px;text-align:center;font-family:Arial,Helvetica,sans-serif;">${i + 1}</td>
            </tr></table>
          </td>
          <td valign="top" style="padding:11px 0 8px;${isLast ? '' : `border-bottom:1px solid ${c}15;`}font-size:14px;color:${darkColor};line-height:1.55;font-family:Arial,Helvetica,sans-serif;">${escape(b)}</td>
        </tr>`;
      }).join('')}
    </table>
  </td></tr>
</table>` : ''}

${(f.socialProof && S.socialProof) ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;border-collapse:separate;">
  <tr><td bgcolor="${tertiaryColor}10" style="background:${tertiaryColor}10;padding:18px 22px;border-left:4px solid ${tertiaryColor};border-radius:0 12px 12px 0;font-size:14px;color:#4B5563;font-style:italic;line-height:1.6;font-family:Georgia,'Times New Roman',serif;">
    <span style="font-size:24px;color:${tertiaryColor};font-style:normal;font-weight:800;font-family:Georgia,serif;">&ldquo;</span>${nl2br(f.socialProof)}
  </td></tr>
</table>` : ''}

${eventBlock}

<!-- CTA + sender block -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;border-top:2px solid ${accentColor}15;">
  <tr><td style="padding:28px 0 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      ${senderPhoto ? `<td width="94" valign="middle" style="padding-right:18px;">
        <img src="${escape(senderPhoto)}" alt="${escape(senderName)}" width="76" height="76" style="display:block;width:76px;height:76px;border-radius:50%;border:3px solid ${accentColor};outline:none;" />
      </td>` : ''}
      <td valign="middle" style="font-family:Arial,Helvetica,sans-serif;">
        ${S.cta ? `
        <div style="font-size:12px;color:#6B7280;font-weight:500;margin-bottom:6px;">${ev && S.event ? t.eventOr : t.ctaIntro}</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px;"><tr>
          <td bgcolor="${accentColor}" style="background:${accentColor};border-radius:10px;">
            <a href="${escape(f.ctaLink)}" style="display:inline-block;padding:14px 30px;color:${darkColor};text-decoration:none;font-weight:800;font-size:14px;letter-spacing:0.2px;font-family:Arial,Helvetica,sans-serif;">${escape(f.ctaText || t.ctaDefault)} &rarr;</a>
          </td>
        </tr></table>` : ''}
        <div style="font-size:13px;color:${darkColor};font-weight:700;margin-top:4px;">${escape(senderName)}</div>
        ${senderTitle ? `<div style="font-size:11px;font-weight:500;color:#6B7280;margin-top:2px;">${escape(senderTitle)}</div>` : ''}
      </td>
    </tr></table>
    ${S.cta ? `<div style="margin:18px 0 0;font-size:11px;color:#9CA3AF;font-style:italic;text-align:center;font-family:Arial,Helvetica,sans-serif;">${t.ctaFooter}</div>` : ''}
  </td></tr>
</table>

  </td></tr>

  <!-- Footer -->
  <tr><td bgcolor="${darkColor}" align="center" style="background:${darkColor};padding:22px 36px;text-align:center;border-radius:0 0 16px 16px;">
<div style="font-size:12px;color:#D1D5DB;font-family:Arial,Helvetica,sans-serif;">
  <strong style="color:#ffffff;">${escape(senderName)}</strong>${senderEmail ? ` &middot; <a href="mailto:${escape(senderEmail)}" style="color:${accentColor};text-decoration:none;">${escape(senderEmail)}</a>` : ''}
</div>
<div style="margin-top:6px;font-size:10px;color:#9CA3AF;letter-spacing:1px;font-family:Arial,Helvetica,sans-serif;">
  ${t.poweredBy} <a href="https://oike.app" style="color:${accentColor};text-decoration:none;font-weight:700;">OIKE</a> &middot; SALES INTELLIGENCE
</div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

    // ─────────────────────────────────────────────────────
    // TEMPLATE: BOLD — editorial, magazine-style, asymmetric
    // ─────────────────────────────────────────────────────
    const renderBold = () => `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="${lang}"${isRTL ? ' dir="rtl"' : ''}>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<meta name="x-apple-disable-message-reformatting" />
<title>${escape(sName)}${accName ? ' &middot; ' + escape(accName) : ''}</title>
<!--[if mso]><style type="text/css">table,td,div,h1,h2,h3,p,a{font-family:Arial,Helvetica,sans-serif !important;}.bold-serif{font-family:Georgia,'Times New Roman',serif !important;}</style><![endif]-->
</head>
<body${isRTL ? ' dir="rtl"' : ''} style="margin:0;padding:0;background:${darkColor};font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:#ffffff;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${darkColor}" style="background:${darkColor};">
<tr><td align="center" style="padding:0;">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:680px;background:#ffffff;color:${darkColor};border-collapse:separate;">

  <!-- Hero: side-by-side colorblocks via 2-col table (Gmail-safe) -->
  <tr><td style="padding:0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
  <td bgcolor="${accentColor}" valign="top" width="55%" style="background:${accentColor};padding:48px 36px;width:55%;">
    ${senderLogo ? `<img src="${escape(senderLogo)}" alt="Logo" height="36" style="display:block;max-height:36px;max-width:160px;margin:0 0 32px;border:0;outline:none;" />` : ''}
    <div style="font-size:11px;font-weight:800;color:${darkColor};letter-spacing:3px;text-transform:uppercase;margin-bottom:12px;font-family:Arial,Helvetica,sans-serif;">${escape(f.heroTagline || t.heroSub)}</div>
    <div class="bold-serif" style="font-size:42px;font-weight:900;line-height:1;color:${darkColor};letter-spacing:-1.5px;font-family:Georgia,'Times New Roman',serif;">${escape(accName || sName)}</div>
  </td>
  <td bgcolor="${darkColor}" valign="top" width="45%" style="background:${darkColor};padding:48px 32px;width:45%;text-align:left;">
    ${senderPhoto ? `<img src="${escape(senderPhoto)}" alt="${escape(senderName)}" width="90" height="90" style="display:block;width:90px;height:90px;border-radius:50%;border:4px solid ${tertiaryColor};margin:0 0 16px;outline:none;" />` : ''}
    <div style="font-size:13px;color:${tertiaryColor};font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;font-family:Arial,Helvetica,sans-serif;">${t.greeting} ${escape(sName.split(' ')[0])}</div>
    <div style="font-size:15px;color:#ffffff;font-weight:600;line-height:1.4;font-family:Arial,Helvetica,sans-serif;">${escape(senderName)}</div>
    ${senderTitle ? `<div style="font-size:12px;color:#9CA3AF;margin-top:4px;font-family:Arial,Helvetica,sans-serif;">${escape(senderTitle)}</div>` : ''}
  </td>
</tr></table>
  </td></tr>

  <!-- Hook as pull-quote -->
  ${(f.hook && S.hook) ? `
  <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:48px 48px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
  <td valign="top" width="6" style="background:${accentColor};font-size:0;line-height:0;">&nbsp;</td>
  <td valign="top" style="padding:8px 0 8px 24px;">
    <div class="bold-serif" style="font-size:22px;line-height:1.4;color:${darkColor};font-style:italic;font-family:Georgia,'Times New Roman',serif;font-weight:500;">${nl2br(f.hook)}</div>
  </td>
</tr></table>
  </td></tr>` : ''}

  <!-- Body sections with alternating colorblocks -->
  ${(f.painContext && S.pain) ? `
  <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:32px 48px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;"><tr>
  <td bgcolor="${tertiaryColor}" style="background:${tertiaryColor};padding:4px 12px;color:${darkColor};font-size:10px;font-weight:900;letter-spacing:2px;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif;">01 &middot; ${t.painHeading}</td>
</tr></table>
<h2 class="bold-serif" style="margin:0 0 16px;font-size:30px;font-weight:900;line-height:1.1;color:${darkColor};letter-spacing:-0.8px;font-family:Georgia,'Times New Roman',serif;">${escape(accName || t.yourCompany)}</h2>
<div style="font-size:16px;color:#374151;line-height:1.7;font-family:Arial,Helvetica,sans-serif;">${nl2br(f.painContext)}</div>
  </td></tr>` : ''}

  ${(f.valueProposition && S.value) ? `
  <tr><td bgcolor="${darkColor}" style="background:${darkColor};padding:32px 48px;color:#ffffff;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;"><tr>
  <td bgcolor="${accentColor}" style="background:${accentColor};padding:4px 12px;color:${darkColor};font-size:10px;font-weight:900;letter-spacing:2px;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif;">02 &middot; ${solName ? t.valueHeadingWithSol : t.valueHeading}</td>
</tr></table>
${solName ? `<h2 class="bold-serif" style="margin:0 0 16px;font-size:30px;font-weight:900;line-height:1.1;color:#ffffff;letter-spacing:-0.8px;font-family:Georgia,'Times New Roman',serif;">${escape(solName)}</h2>` : ''}
<div style="font-size:16px;color:#D1D5DB;line-height:1.7;font-family:Arial,Helvetica,sans-serif;">${nl2br(f.valueProposition)}</div>
  </td></tr>` : ''}

  ${(bulletsList.length && S.bullets) ? `
  <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:40px 48px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;"><tr>
  <td bgcolor="${secondaryColor}" style="background:${secondaryColor};padding:4px 12px;color:#ffffff;font-size:10px;font-weight:900;letter-spacing:2px;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif;">03 &middot; WHAT YOU GET</td>
</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  ${bulletsList.map((b, i) => {
    const colors = [accentColor, secondaryColor, tertiaryColor, accentColor];
    const c = colors[i % colors.length];
    const isLast = i === bulletsList.length - 1;
    return `<tr><td valign="top" style="padding:14px 0;${isLast ? '' : `border-bottom:2px solid ${c}30;`}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="64" valign="top" style="padding-right:20px;">
          <span class="bold-serif" style="display:block;font-family:Georgia,'Times New Roman',serif;font-size:42px;font-weight:900;color:${c};line-height:1;letter-spacing:-2px;">${String(i + 1).padStart(2, '0')}</span>
        </td>
        <td valign="top" style="padding-top:6px;font-size:16px;color:${darkColor};line-height:1.55;font-weight:500;font-family:Arial,Helvetica,sans-serif;">${escape(b)}</td>
      </tr></table>
    </td></tr>`;
  }).join('')}
</table>
  </td></tr>` : ''}

  ${(f.socialProof && S.socialProof) ? `
  <tr><td bgcolor="${tertiaryColor}" style="background:${tertiaryColor};padding:32px 48px;color:${darkColor};">
<div class="bold-serif" style="font-size:18px;line-height:1.5;font-style:italic;font-family:Georgia,'Times New Roman',serif;font-weight:500;">
  <span style="font-size:32px;color:${darkColor};font-weight:900;font-family:Georgia,serif;">&ldquo;</span>${nl2br(f.socialProof)}
</div>
  </td></tr>` : ''}

  ${(ev && S.event) ? `<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:32px 48px;">${eventBlock}</td></tr>` : ''}

  <!-- Big CTA — solid color (Gmail-safe), no gradient -->
  ${S.cta ? `
  <tr><td bgcolor="${accentColor}" align="center" style="background:${accentColor};padding:48px 48px 56px;text-align:center;color:${darkColor};">
<div style="margin:0 0 18px;font-size:13px;color:${darkColor};font-weight:700;letter-spacing:2px;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif;">${(ev && S.event) ? t.eventOr : t.ctaIntro}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr>
  <td bgcolor="${darkColor}" style="background:${darkColor};border-radius:50px;">
    <a href="${escape(f.ctaLink)}" style="display:inline-block;padding:18px 40px;color:#ffffff;text-decoration:none;font-weight:800;font-size:17px;letter-spacing:0.3px;font-family:Arial,Helvetica,sans-serif;">${escape(f.ctaText || t.ctaDefault)} &rarr;</a>
  </td>
</tr></table>
<div style="margin:20px 0 0;font-size:12px;color:${darkColor};opacity:0.7;font-style:italic;font-family:Arial,Helvetica,sans-serif;">${t.ctaFooter}</div>
  </td></tr>` : ''}

  <!-- Footer -->
  <tr><td bgcolor="${darkColor}" align="center" style="background:${darkColor};padding:22px 36px;text-align:center;">
<div style="font-size:12px;color:#D1D5DB;font-family:Arial,Helvetica,sans-serif;">
  <strong style="color:#ffffff;">${escape(senderName)}</strong>${senderEmail ? ` &middot; <a href="mailto:${escape(senderEmail)}" style="color:${accentColor};text-decoration:none;">${escape(senderEmail)}</a>` : ''}
</div>
<div style="margin-top:6px;font-size:10px;color:#9CA3AF;letter-spacing:1.5px;font-family:Arial,Helvetica,sans-serif;">
  ${t.poweredBy} <a href="https://oike.app" style="color:${accentColor};text-decoration:none;font-weight:700;">OIKE</a> &middot; SALES INTELLIGENCE
</div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

    // ── Dispatch by visualStyle ──
    const style = f.visualStyle || 'modern';
    const rendered = (style === 'bold') ? renderBold() : renderModern();
    // Embed section toggles + custom strings as a meta comment so openEdit can recover them
    const meta = `<!-- oike-meta:${JSON.stringify({ sections: S, language: lang, visualStyle: style, heroTagline: f.heroTagline || '' })} -->`;
    return rendered.replace('<body', `${meta}\n<body`);
  };

  const htmlPreview = useMemo(() => buildLandingHTML(form), [form, stakeholders, accounts, solutions]);

  // Save
  const saveLanding = async (sendStatus = 'Draft') => {
    if (!form.slug.trim()) { window.__oikeToast('Slug is required', 'warning'); return; }
    if (!form.stakeholderId) { window.__oikeToast('Pick a stakeholder', 'warning'); return; }
    setSaving(true);
    try {
      const fields = {
        'Slug': form.slug,
        ...(form.stakeholderId ? { 'Stakeholder': [form.stakeholderId] } : {}),
        ...(form.solutionId ? { 'Solution': [form.solutionId] } : {}),
        ...(form.eventId ? { 'Event': [form.eventId] } : {}),
        ...(form.eventRegisterLink ? { 'Event Register Link': form.eventRegisterLink } : {}),
        ...(form.visualStyle ? { 'Visual Style': form.visualStyle } : {}),
        'Hook': form.hook,
        'Pain Context': form.painContext,
        'Value Proposition': form.valueProposition,
        'Bullets': form.bullets,
        'Social Proof': form.socialProof,
        'CTA Text': form.ctaText,
        ...(form.ctaLink ? { 'CTA Link': form.ctaLink } : {}),
        'Status': sendStatus,
        // Strip base64 data: URIs (sender photo, logo) — they bloat the HTML way past Airtable's
        // 100K-char limit for long text. The preview/copy in the app keep the real images;
        // this saved version is for re-editing only (we recover via the meta comment).
        'Saved HTML': (() => {
          const compact = htmlPreview.replace(/src="data:[^"]{500,}"/g, 'src=""');
          const MAX_LEN = 95000; // Airtable safety limit
          return compact.length > MAX_LEN ? compact.slice(0, MAX_LEN - 50) + '\n<!-- truncated -->' : compact;
        })(),
        'Created By': CURRENT_USER?.name || '',
        ...(sendStatus === 'Sent' ? { 'Sent Date': new Date().toISOString().split('T')[0] } : {}),
      };
      const a = api || new AirtableAPI();
      if (editingLanding) {
        await a.updateRecord(TABLE_IDS.landings, editingLanding.id, fields);
        if (onUpdateRecord) onUpdateRecord('landings', editingLanding.id, fields);
      } else {
        const created = await a.createRecord(TABLE_IDS.landings, fields);
        if (onAddRecord) onAddRecord('landings', created?.fields || fields, created?.id);
      }

      // ── Auto-invite to event when status = Sent ──
      // If there's an event + stakeholder, add the stakeholder to event.Stakeholders invited
      if (sendStatus === 'Sent' && form.eventId && form.stakeholderId) {
        try {
          const eventRec = events.find(e => e.id === form.eventId);
          const currentInvited = eventRec ? linkedIds(eventRec, 'Stakeholders invited') : [];
          if (!currentInvited.includes(form.stakeholderId)) {
            const newInvited = [...currentInvited, form.stakeholderId];
            await a.updateRecord(TABLE_IDS.events, form.eventId, {
              'Stakeholders invited': newInvited,
            });
            if (onUpdateRecord) onUpdateRecord('events', form.eventId, {
              'Stakeholders invited': newInvited,
            });
          }
        } catch (eventErr) {
          console.error('Auto-invite to event failed:', eventErr);
          // Non-blocking — landing was saved, just the invite update failed
        }
      }

      // ── Auto-log as outreach when status = Sent (so it appears in stakeholder history) ──
      // Only on FIRST transition to Sent (avoid duplicates if re-saving an already-Sent landing)
      const wasAlreadySent = editingLanding && F(editingLanding, 'Status') === 'Sent';
      if (sendStatus === 'Sent' && form.stakeholderId && !wasAlreadySent) {
        try {
          const stkRec = stakeholders.find(x => x.id === form.stakeholderId);
          const sNameForLog = stkRec ? `${F(stkRec,'Name')||''} ${F(stkRec,'Last name')||''}`.trim() : 'Prospect';
          const accIdForLog = form.accountId || (stkRec ? linkedIds(stkRec, 'Account')[0] : null);
          const todayLabel = new Date().toLocaleDateString('en-US');
          const landingHook = (form.hook || '').slice(0, 200);
          const landingValue = (form.valueProposition || '').slice(0, 300);
          const landingMessage = [landingHook, landingValue].filter(Boolean).join('\n\n') || `Landing sent: /p/${form.slug}`;

          const outreachFields = {
            'Activity Name': `📨 Landing to ${sNameForLog} — ${todayLabel}`,
            ...(accIdForLog ? { 'Account': [accIdForLog] } : {}),
            'Stakeholder': [form.stakeholderId],
            ...(form.solutionId ? { 'Solutions': [form.solutionId] } : {}),
            ...(form.eventId ? { 'Event': [form.eventId] } : {}),
            'Channel': 'Email',
            'Date': new Date().toISOString(),
            'Status': 'Sent',
            'Message': landingMessage,
            'Notes': `Prospect Landing — slug: ${form.slug}${form.eventId ? ' · with event invite' : ''}`,
            'Logged By': CURRENT_USER?.name || '',
            ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
            ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
          };
          // Optimistic update so it shows up immediately
          if (onAddRecord) onAddRecord('outreach', outreachFields);
          // Background API call
          a.createRecord(TABLE_IDS.outreach, outreachFields).catch(err => {
            console.error('Auto-log landing as outreach failed:', err);
          });
        } catch (logErr) {
          console.error('Outreach log build failed:', logErr);
          // Non-blocking
        }
      }

      setShowForm(false);
      setEditingLanding(null);
      setForm(emptyForm);
      if (onLogActivity) onLogActivity();
      try {
        const returnTo = sessionStorage.getItem('oike_return_to_account');
        if (returnTo) {
          const { accountId, tab } = JSON.parse(returnTo);
          sessionStorage.removeItem('oike_return_to_account');
          window.dispatchEvent(new CustomEvent('oike:navigate', { detail: { page: 'accounts', accountId, tab } }));
        }
      } catch {}
    } catch (e) {
      console.error('Save landing failed:', e);
      window.__oikeToast('Error: ' + (e.message || 'unknown'), 'error');
    }
    setSaving(false);
  };

  // Build a plain-text fallback for the clipboard so non-HTML targets still work
  const buildPlainText = (html) => {
    return String(html||'')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&middot;/g, '·').replace(/&mdash;/g, '—').replace(/&rarr;/g, '→').replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"')
      .replace(/\n{3,}/g, '\n\n').trim();
  };

  const copyHTML = async () => {
    try {
      const htmlBlob = new Blob([htmlPreview], { type: 'text/html' });
      const textBlob = new Blob([buildPlainText(htmlPreview)], { type: 'text/plain' });
      // Both formats — Gmail picks text/html, simpler clients pick text/plain
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      navigator.clipboard.writeText(htmlPreview).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const openInGmail = async () => {
    try {
      const htmlBlob = new Blob([htmlPreview], { type: 'text/html' });
      const textBlob = new Blob([buildPlainText(htmlPreview)], { type: 'text/plain' });
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })]);
    } catch {
      navigator.clipboard.writeText(htmlPreview).catch(() => {});
    }
    const s = form.stakeholderId ? stakeholders.find(x => x.id === form.stakeholderId) : null;
    const email = s ? F(s, 'Email') || '' : '';
    const sName = s ? F(s, 'Name') || '' : '';
    const accName = s ? F(accounts.find(a => linkedIds(s,'Account')[0] === a.id) || {}, 'Account Name') : '';
    const t = LANDING_I18N[form.language || 'en'] || LANDING_I18N.en;
    const subject = t.subject(sName, accName);
    window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}`, '_blank');
  };

  const openEdit = (landing) => {
    setEditingLanding(landing);
    const stkId = linkedIds(landing, 'Stakeholder')[0] || '';
    const solId = linkedIds(landing, 'Solution')[0] || '';
    const evId = linkedIds(landing, 'Event')[0] || '';
    // Derive accountId from stakeholder if available
    const stk = stkId ? stakeholders.find(x => x.id === stkId) : null;
    const accId = stk ? linkedIds(stk, 'Account')[0] || '' : '';
    // Recover section toggles + lang/style from the meta comment we embed in saved HTML
    const savedHtml = F(landing, 'Saved HTML') || '';
    let savedMeta = {};
    const metaMatch = savedHtml.match(/<!--\s*oike-meta:(\{[\s\S]*?\})\s*-->/);
    if (metaMatch) { try { savedMeta = JSON.parse(metaMatch[1]); } catch {} }
    const defaultSections = { hook: true, pain: true, value: true, bullets: true, socialProof: true, event: true, cta: true };
    setForm({
      slug: F(landing, 'Slug') || '',
      stakeholderId: stkId,
      accountId: accId,
      solutionId: solId,
      eventId: evId,
      eventRegisterLink: F(landing, 'Event Register Link') || '',
      language: F(landing, 'Language') || savedMeta.language || 'en',
      visualStyle: F(landing, 'Visual Style') || savedMeta.visualStyle || 'modern',
      heroTagline: savedMeta.heroTagline || '',
      hook: F(landing, 'Hook') || '',
      painContext: F(landing, 'Pain Context') || '',
      valueProposition: F(landing, 'Value Proposition') || '',
      bullets: F(landing, 'Bullets') || '',
      socialProof: F(landing, 'Social Proof') || '',
      ctaText: F(landing, 'CTA Text') || (LANDING_I18N[F(landing,'Language') || savedMeta.language || 'en']?.ctaDefault) || 'Let\'s talk 20 minutes',
      ctaLink: F(landing, 'CTA Link') || '',
      status: F(landing, 'Status') || 'Draft',
      sections: { ...defaultSections, ...(savedMeta.sections || {}) },
    });
    setShowForm(true);
  };

  const openCreate = () => {
    setEditingLanding(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const inputSt = { background:'var(--globant-darker)', border:'1px solid var(--globant-border)', borderRadius:6, color:'var(--globant-text)', padding:'8px 10px', fontSize:13, width:'100%', fontFamily: 'inherit' };

  // ── FORM VIEW ──
  if (showForm) {
    const currentStk = form.stakeholderId ? stakeholders.find(x => x.id === form.stakeholderId) : null;
    const stkAcc = form.accountId
      ? accounts.find(a => a.id === form.accountId)
      : (currentStk ? accounts.find(a => a.id === linkedIds(currentStk, 'Account')[0]) : null);

    return (
      <div>
        <div className="page-header" style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <button className="action-btn btn-ghost" style={{ fontSize: 11, marginBottom: 8 }} onClick={() => { setShowForm(false); setEditingLanding(null); }}>← Back to Landings</button>
            <h1>📨 {editingLanding ? 'Edit' : 'New'} Prospect Landing</h1>
            <p style={{ color: 'var(--globant-muted)', fontSize: 13 }}>Personalized HTML for first-touch outreach. Copy-paste to Gmail or publish.</p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '400px 1fr', gap: 20, alignItems: 'start' }}>
          {/* Form panel */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="card">
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>🌐 Language</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
                {[
                  { code: 'en', label: '🇬🇧 English' },
                  { code: 'es', label: '🇪🇸 Español' },
                  { code: 'pt', label: '🇧🇷 Português' },
                  { code: 'fr', label: '🇫🇷 Français' },
                  { code: 'de', label: '🇩🇪 Deutsch' },
                  { code: 'it', label: '🇮🇹 Italiano' },
                  { code: 'ar', label: '🇸🇦 العربية' },
                ].map(opt => (
                  <button key={opt.code}
                    onClick={() => {
                      // Also update default CTA if it matches the old language's default
                      setForm(f => ({
                        ...f,
                        language: opt.code,
                        ctaText: (f.ctaText === LANDING_I18N[f.language || 'en'].ctaDefault || !f.ctaText) ? LANDING_I18N[opt.code].ctaDefault : f.ctaText,
                      }));
                    }}
                    style={{
                      padding: '8px 6px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                      background: form.language === opt.code ? 'rgba(91,191,181,0.18)' : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${form.language === opt.code ? 'var(--globant-green)' : 'rgba(255,255,255,0.08)'}`,
                      color: form.language === opt.code ? 'var(--globant-green)' : 'var(--globant-text)',
                    }}>
                    {opt.label}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 8, fontStyle: 'italic' }}>
                English by default. AI generates in this language + the HTML's fixed labels also adapt. Arabic auto-switches to RTL layout.
              </div>
            </div>

            <div className="card">
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>🎨 Visual Style</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {[
                  { code: 'modern', label: '✨ Modern', sub: 'Clean · sofisticado · balanced' },
                  { code: 'bold',   label: '📰 Bold',   sub: 'Editorial · color blocking · big type' },
                ].map(opt => (
                  <button key={opt.code}
                    onClick={() => setForm(f => ({ ...f, visualStyle: opt.code }))}
                    style={{
                      padding: '10px 12px', borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                      background: form.visualStyle === opt.code ? 'rgba(91,191,181,0.18)' : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${form.visualStyle === opt.code ? 'var(--globant-green)' : 'rgba(255,255,255,0.08)'}`,
                      color: form.visualStyle === opt.code ? 'var(--globant-green)' : 'var(--globant-text)',
                    }}>
                    <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>{opt.label}</div>
                    <div style={{ fontSize: 10, color: 'var(--globant-muted)', fontWeight: 400 }}>{opt.sub}</div>
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 8, fontStyle: 'italic' }}>
                Modern: clean, serious B2B. Bold: magazine-style, creative brands & agencies.
              </div>
            </div>

            {/* ── Sections toggles — define what blocks appear in the landing ── */}
            <div className="card">
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>📋 Sections</div>
              <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginBottom: 10, fontStyle: 'italic' }}>
                Toggle on/off the blocks you want in this landing.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {[
                  { k: 'hook',        icon: '💬', label: 'Hook' },
                  { k: 'pain',        icon: '🎯', label: 'Pain Context' },
                  { k: 'value',       icon: '⚡', label: 'Value Proposition' },
                  { k: 'bullets',     icon: '📌', label: 'Bullets' },
                  { k: 'socialProof', icon: '⭐', label: 'Social Proof' },
                  { k: 'event',       icon: '🎟️', label: 'Event Block' },
                  { k: 'cta',         icon: '🔘', label: 'CTA Button' },
                ].map(opt => {
                  const on = form.sections?.[opt.k] !== false;
                  return (
                    <button key={opt.k}
                      onClick={() => setForm(f => ({ ...f, sections: { ...(f.sections||{}), [opt.k]: !on } }))}
                      style={{
                        padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                        background: on ? 'rgba(74,222,128,0.15)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${on ? 'rgba(74,222,128,0.5)' : 'rgba(255,255,255,0.08)'}`,
                        color: on ? '#4ade80' : 'var(--globant-muted)',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      }}>
                      <span>{opt.icon} {opt.label}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 8, background: on ? '#4ade80' : 'rgba(255,255,255,0.08)', color: on ? '#0D0D1A' : 'var(--globant-muted)' }}>
                        {on ? 'ON' : 'OFF'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="card">
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>Target</div>

              <label style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, display: 'block' }}>Account (company)</label>
              <select style={inputSt} value={form.accountId} onChange={e => onPickAccount(e.target.value)}>
                <option value="">— Pick an account —</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{F(a,'Account Name')}{F(a,'Industry') ? ` · ${F(a,'Industry')}` : ''}</option>)}
              </select>

              <label style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, display: 'block', marginTop: 10 }}>Stakeholder {form.accountId ? '(optional if you already picked an account)' : '*'}</label>
              <select style={inputSt} value={form.stakeholderId} onChange={e => onPickStakeholder(e.target.value)}>
                <option value="">— Pick a stakeholder —</option>
                {stakeholders
                  .filter(s => !form.accountId || linkedIds(s, 'Account').includes(form.accountId))
                  .map(s => {
                    const accId = linkedIds(s, 'Account')[0];
                    const acc = accId ? accounts.find(a => a.id === accId) : null;
                    const accN = acc ? F(acc, 'Account Name') : '';
                    return <option key={s.id} value={s.id}>{F(s,'Name')||''} {F(s,'Last name')||''} {accN ? `· ${accN}` : ''}</option>;
                  })}
              </select>
              {form.accountId && (
                <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 4, fontStyle: 'italic' }}>
                  Filtered by selected account. Change the account to see other contacts.
                </div>
              )}

              {stkAcc && (
                <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(91,191,181,0.06)', borderRadius: 6, fontSize: 11, color: 'var(--globant-muted)' }}>
                  <strong style={{ color: 'var(--globant-text)' }}>{F(stkAcc, 'Account Name')}</strong>
                  {F(stkAcc, 'Industry') ? ` · ${F(stkAcc, 'Industry')}` : ''}
                  {F(stkAcc, 'Country') ? ` · ${F(stkAcc, 'Country')}` : ''}
                </div>
              )}

              <label style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, display: 'block', marginTop: 10 }}>Solution (optional)</label>
              <select style={inputSt} value={form.solutionId} onChange={e => setForm(f => ({ ...f, solutionId: e.target.value }))}>
                <option value="">— No solution attached —</option>
                {solutions.map(s => <option key={s.id} value={s.id}>{F(s,'Name')}</option>)}
              </select>

              <label style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, display: 'block', marginTop: 10 }}>🎟️ Event (optional — invite them)</label>
              <select style={inputSt} value={form.eventId} onChange={e => {
                const evId = e.target.value;
                const ev = evId ? events.find(x => x.id === evId) : null;
                setForm(f => ({
                  ...f,
                  eventId: evId,
                  // Auto-fill register link with event URL if no custom link yet
                  eventRegisterLink: f.eventRegisterLink || (ev ? F(ev, 'URL') || '' : ''),
                }));
              }}>
                <option value="">— No event attached —</option>
                {events
                  .sort((a, b) => new Date(b.fields?.['Starting'] || 0) - new Date(a.fields?.['Starting'] || 0))
                  .map(ev => {
                    const start = ev.fields?.['Starting'];
                    const dateStr = start ? new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
                    return <option key={ev.id} value={ev.id}>{F(ev,'Event Name')}{dateStr ? ` · ${dateStr}` : ''}</option>;
                  })}
              </select>

              {form.eventId && (
                <div style={{ marginTop: 8 }}>
                  <label style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, display: 'block' }}>🔗 Registration link (override the event's URL)</label>
                  <input style={inputSt} value={form.eventRegisterLink} onChange={e => setForm(f => ({ ...f, eventRegisterLink: e.target.value }))} placeholder="https://eventbrite.com/... or internal link" />
                  <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 3, fontStyle: 'italic' }}>
                    If empty, uses the event's URL. Use this for landings with a specific registration link.
                  </div>
                </div>
              )}

              <label style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, display: 'block', marginTop: 10 }}>Slug (URL) *</label>
              <input style={inputSt} value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') }))} placeholder="juan-nuvocargo" />
            </div>

            <button className="action-btn btn-primary" style={{ padding: '10px', fontSize: 13, fontWeight: 700 }} onClick={aiAutofill} disabled={generatingAI || !form.stakeholderId}>
              {generatingAI ? '⏳ Generating...' : '✨ AI Auto-fill (hook, pain, value, bullets)'}
            </button>

            <div className="card">
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>Content</div>

              <label style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, display: 'block' }}>
                ✨ Hero tagline <span style={{ fontStyle: 'italic', fontWeight: 400 }}>(small text above the company name)</span>
              </label>
              <input style={inputSt} value={form.heroTagline}
                onChange={e => setForm(f => ({ ...f, heroTagline: e.target.value }))}
                placeholder={(LANDING_I18N[form.language || 'en']?.heroSub) || 'I put this together thinking about'} />
              <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 3, marginBottom: 10, fontStyle: 'italic' }}>
                Empty = use default for {form.language || 'en'}. Replaces "{(LANDING_I18N[form.language || 'en']?.heroSub) || ''}" in the hero.
              </div>

              <label style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, display: 'block' }}>Hook (opening line)</label>
              <textarea style={{ ...inputSt, minHeight: 60, resize: 'vertical' }} value={form.hook} onChange={e => setForm(f => ({ ...f, hook: e.target.value }))} placeholder="Vi tu post sobre X. Notable que..." />

              <label style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, display: 'block', marginTop: 10 }}>Pain Context</label>
              <textarea style={{ ...inputSt, minHeight: 70, resize: 'vertical' }} value={form.painContext} onChange={e => setForm(f => ({ ...f, painContext: e.target.value }))} placeholder="What I see happening at their company..." />

              <label style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, display: 'block', marginTop: 10 }}>Value Proposition</label>
              <textarea style={{ ...inputSt, minHeight: 70, resize: 'vertical' }} value={form.valueProposition} onChange={e => setForm(f => ({ ...f, valueProposition: e.target.value }))} placeholder="How I can specifically help..." />

              <label style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, display: 'block', marginTop: 10 }}>Bullets (uno por línea)</label>
              <textarea style={{ ...inputSt, minHeight: 80, resize: 'vertical' }} value={form.bullets} onChange={e => setForm(f => ({ ...f, bullets: e.target.value }))} placeholder="3-4 specific value points" />

              <label style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, display: 'block', marginTop: 10 }}>Social Proof (opcional)</label>
              <textarea style={{ ...inputSt, minHeight: 50, resize: 'vertical' }} value={form.socialProof} onChange={e => setForm(f => ({ ...f, socialProof: e.target.value }))} placeholder="Similar cases, relevant metrics" />
            </div>

            <div className="card">
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>CTA</div>
              <label style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, display: 'block' }}>CTA button text</label>
              <input style={inputSt} value={form.ctaText} onChange={e => setForm(f => ({ ...f, ctaText: e.target.value }))} />
              <label style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, display: 'block', marginTop: 10 }}>CTA link</label>
              <input style={inputSt} value={form.ctaLink} onChange={e => setForm(f => ({ ...f, ctaLink: e.target.value }))} placeholder="https://calendar.app.google/..." />
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button className="action-btn btn-primary" style={{ flex: 1, padding: '10px', fontSize: 13, fontWeight: 700 }} onClick={() => saveLanding('Draft')} disabled={saving}>
                {saving ? '⏳' : '💾 Save Draft'}
              </button>
              <button className="action-btn" style={{ flex: 1, padding: '10px', fontSize: 13, fontWeight: 700, background: '#4ade80', color: '#0D0D1A' }} onClick={() => saveLanding('Sent')} disabled={saving}>
                ✉️ Mark as Sent
              </button>
            </div>
            {form.eventId && form.stakeholderId && (
              <div style={{ marginTop: 6, padding: '8px 12px', background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.25)', borderRadius: 6, fontSize: 11, color: 'var(--globant-muted)' }}>
                🎟️ On Mark as Sent, this stakeholder will be auto-added as an invitee to the event in Oike.
              </div>
            )}
          </div>

          {/* Preview panel */}
          <div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <button className="action-btn btn-primary" style={{ padding: '10px 18px', fontSize: 13, fontWeight: 700 }} onClick={copyHTML}>
                {copied ? '✅ Copied!' : '📋 Copy HTML'}
              </button>
              <button style={{ padding: '10px 18px', borderRadius: 8, background: 'rgba(66,133,244,0.15)', border: '1px solid rgba(66,133,244,0.4)', color: '#60a5fa', fontWeight: 700, fontSize: 13, cursor: 'pointer' }} onClick={openInGmail}>
                ✉️ Open in Gmail
              </button>
            </div>
            <div style={{ border: '1px solid var(--globant-border)', borderRadius: 12, overflow: 'hidden', background: '#f3f4f6' }}>
              <iframe srcDoc={htmlPreview} style={{ width: '100%', height: 700, border: 'none', background: '#f3f4f6' }} sandbox="allow-same-origin" title="Landing Preview" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── LIST VIEW ──
  return (
    <div>
      <div className="page-header">
        <h1>📨 Prospect Landings</h1>
        <p>Personalized HTML pages per prospect. Copy-paste to Gmail or publish as a link.</p>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <input className="input-field" style={{ fontSize: 12, flex: 1, minWidth: 180 }} placeholder="Search by slug or contact..." value={listSearch} onChange={e => setListSearch(e.target.value)} />
        <select className="input-field" style={{ fontSize: 12, minWidth: 140 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="Draft">Draft</option>
          <option value="Sent">Sent</option>
          <option value="Archived">Archived</option>
        </select>
        <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={openCreate}>+ New Landing</button>
      </div>

      {filteredLandings.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📨</div>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>No landings {landings.length === 0 ? 'yet' : 'match'}</div>
          <div style={{ fontSize: 13, color: 'var(--globant-muted)', marginBottom: 16 }}>
            {landings.length === 0 ? 'Create your first personalized landing for a prospect' : 'Adjust your filters'}
          </div>
          {landings.length === 0 && <button className="action-btn btn-primary" onClick={openCreate}>+ New Landing</button>}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {filteredLandings.map(l => {
            const status = F(l, 'Status') || 'Draft';
            const stkId = linkedIds(l, 'Stakeholder')[0];
            const stk = stkId ? stakeholders.find(s => s.id === stkId) : null;
            const accId = stk ? linkedIds(stk, 'Account')[0] : null;
            const acc = accId ? accounts.find(a => a.id === accId) : null;
            const sColor = { Draft: '#a78bfa', Sent: '#4ade80', Archived: '#6b7280' }[status] || '#a78bfa';
            return (
              <div key={l.id} className="card" style={{ cursor: 'pointer', borderTop: `3px solid ${sColor}` }} onClick={() => openEdit(l)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 8 }}>
                  <div style={{ fontSize: 12, color: 'var(--globant-green)', fontWeight: 700, fontFamily: 'monospace' }}>/{F(l, 'Slug') || '—'}</div>
                  <span style={{ fontSize: 10, padding: '3px 8px', borderRadius: 20, background: `${sColor}20`, color: sColor, fontWeight: 700 }}>{status}</span>
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
                  {stk ? `${F(stk,'Name')||''} ${F(stk,'Last name')||''}`.trim() : '—'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--globant-muted)', marginBottom: 10 }}>
                  {stk ? F(stk,'Role') : ''}{acc ? ` · ${F(acc,'Account Name')}` : ''}
                </div>
                {F(l, 'Hook') && (
                  <div style={{ fontSize: 11, color: 'var(--globant-muted)', fontStyle: 'italic', marginBottom: 8, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    "{F(l, 'Hook')}"
                  </div>
                )}
                <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>
                  {F(l, 'Sent Date') ? `Sent: ${F(l, 'Sent Date')}` : 'Draft'}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============ REPORT BUILDER ============

export default LandingsHub;
