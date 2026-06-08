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


function ContentLab({ data, api, onLogActivity, onAddRecord, onDeleteRecord }) {
  const { accounts = [], stakeholders = [], outreach = [], solutions = [], opportunities = [], campaigns = [], events = [], contentLab = [] } = data;
  const [tab, setTab] = useState('ideas'); // 'ideas' | 'writer' | 'library' | 'voice'
  const [ideas, setIdeas] = useState([]);
  const [loadingIdeas, setLoadingIdeas] = useState(false);
  const [writerTopic, setWriterTopic] = useState('');
  const [writerType, setWriterType] = useState('Short Post');
  const [writerTone, setWriterTone] = useState('direct');
  const [writerLanguage, setWriterLanguage] = useState('en');
  const [writerTag, setWriterTag] = useState('');
  const [sourceInsight, setSourceInsight] = useState('');
  const [draft, setDraft] = useState('');
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [copied, setCopied] = useState(false);
  const [improving, setImproving] = useState(''); // '' | 'shorter' | 'hook' | 'cta' | 'polish'
  const [voiceSamples, setVoiceSamples] = useState(() => localStorage.getItem('oike_voice_samples') || '');
  const [voiceSaved, setVoiceSaved] = useState(false);
  const [libraryFilter, setLibraryFilter] = useState('all');
  const [editingPost, setEditingPost] = useState(null);

  // Source selector + coach questions state (for Ideas tab)
  const [ideaSource, setIdeaSource] = useState('outreach'); // 'outreach' | 'upcoming-event' | 'past-event' | 'campaign' | 'solution' | 'free'
  const [sourceItemId, setSourceItemId] = useState(''); // selected event/campaign/solution ID
  const [coachStage, setCoachStage] = useState('idle'); // 'idle' | 'asking' | 'answering' | 'done'
  const [coachQuestions, setCoachQuestions] = useState([]);
  const [coachAnswers, setCoachAnswers] = useState([]);
  const [loadingCoach, setLoadingCoach] = useState(false);

  // Engagement analyzer state (Library tab)
  const [analyzingPostId, setAnalyzingPostId] = useState('');
  const [engagementAnalysis, setEngagementAnalysis] = useState({}); // {postId: analysisResult}

  // Recipients recommender state (Library tab)
  const [findingRecipientsFor, setFindingRecipientsFor] = useState('');
  const [recipientsByPost, setRecipientsByPost] = useState({}); // {postId: [{stakeholder_id, match_score, match_reason, intro_message}]}
  const [sendingKey, setSendingKey] = useState(''); // `${postId}:${stkId}:${channel}` while sending

  const TAGS = ['Sales', 'Personal', 'Strategy', 'Lead gen', 'Industry insight', 'Lesson learned', 'Contrarian', 'Story', 'Framework'];
  const TYPES = ['Short Post', 'Long Post', 'Article'];
  const TONES = ['direct', 'personal', 'technical', 'inspirational', 'contrarian'];

  // ── Save voice samples ──
  const saveVoiceSamples = () => {
    try { localStorage.setItem('oike_voice_samples', voiceSamples); } catch {}
    setVoiceSaved(true);
    setTimeout(() => setVoiceSaved(false), 1800);
  };

  // ── Build Oike context for AI ──
  const buildOikeContext = () => {
    const recentDays = 14;
    const cutoff = Date.now() - recentDays * 86400000;
    const recentOutreach = outreach.filter(o => new Date(o.fields?.['Date'] || 0).getTime() > cutoff);
    const recentReplies = recentOutreach.filter(o => ['Replied', 'Received'].includes(F(o, 'Status')));
    const activeAccountIds = new Set(recentOutreach.flatMap(o => linkedIds(o, 'Account')));
    const activeAccounts = accounts.filter(a => activeAccountIds.has(a.id));
    const industries = [...new Set(activeAccounts.map(a => F(a, 'Industry')).filter(Boolean))];
    const painPoints = stakeholders.map(s => F(s, 'Pain points') || F(s, 'Pain Points (Generated)'))
      .filter(p => typeof p === 'string' && p.trim().length > 20)
      .slice(0, 8);
    const solutionNames = solutions.map(s => F(s, 'Name')).filter(Boolean);
    const meetingsWon = recentOutreach.filter(o => ['Meeting Scheduled', 'Meeting Booked'].includes(F(o, 'Status')));
    const replyExcerpts = recentReplies.slice(0, 5).map(o => {
      const raw = (F(o, 'Notes') || F(o, 'Message') || '').replace(/^\[gmsg:[^\]]+\]\s*/, '').trim();
      return raw.slice(0, 200);
    }).filter(Boolean);

    return {
      recentDays,
      touchesCount: recentOutreach.length,
      repliesCount: recentReplies.length,
      meetingsCount: meetingsWon.length,
      industries,
      painPoints,
      solutionNames,
      replyExcerpts,
    };
  };

  // ── Generate ideas (source-aware) ──
  const generateIdeas = async () => {
    setLoadingIdeas(true);
    // Build source-specific context block
    const srcCtx = buildSourceContext();
    let sourceBlock = '';
    if (srcCtx) {
      if (srcCtx.kind === 'upcoming-event') {
        sourceBlock = `SOURCE — UPCOMING EVENT:
Name: ${srcCtx.name}
Date: ${srcCtx.date}${srcCtx.endDate ? ' → ' + srcCtx.endDate : ''}
Context: ${srcCtx.context || 'not provided'}
${srcCtx.summary ? `Summary: ${String(srcCtx.summary).slice(0, 400)}` : ''}
${srcCtx.url ? `URL: ${srcCtx.url}` : ''}
Invited count: ${srcCtx.invitedCount}
Invited roles: ${srcCtx.invitedRoles.join(', ') || 'varied'}
Industries: ${srcCtx.invitedIndustries.join(', ') || 'varied'}

FRAME: Posts should PRE-BUILD interest in this upcoming event — what you'll share, why it matters, what invitees should expect, or a provocative take tied to the event theme.`;
      } else if (srcCtx.kind === 'past-event') {
        sourceBlock = `SOURCE — PAST EVENT:
Name: ${srcCtx.name}
Date: ${srcCtx.date}${srcCtx.endDate ? ' → ' + srcCtx.endDate : ''}
Context: ${srcCtx.context || 'not provided'}
${srcCtx.summary ? `Summary: ${String(srcCtx.summary).slice(0, 400)}` : ''}
Attended count: ${srcCtx.attendedCount}
Attended roles: ${srcCtx.attendedRoles.join(', ') || 'varied'}

FRAME: Posts should REFLECT on the event — insights taken away, patterns observed, contrarian takes, lessons for the industry, specific moments worth sharing.`;
      } else if (srcCtx.kind === 'campaign') {
        sourceBlock = `SOURCE — CAMPAIGN:
Name: ${srcCtx.name}
Type: ${srcCtx.type}
Status: ${srcCtx.status}
Context (user-written): ${srcCtx.context || 'not provided'}
${srcCtx.aiSummary ? `Strategic brief:\n${String(srcCtx.aiSummary).slice(0, 600)}` : ''}
Stakeholders reached: ${srcCtx.reached}

FRAME: Posts should RESONATE with the campaign's ICP and pain — warm up the audience before/during the campaign outreach.`;
      } else if (srcCtx.kind === 'solution') {
        sourceBlock = `SOURCE — SOLUTION:
Name: ${srcCtx.name}
Type: ${srcCtx.type}
Detail: ${String(srcCtx.detail).slice(0, 400)}
Key message: ${srcCtx.keyMessage}
Accounts mapped: ${srcCtx.accountsCount}
Sample accounts: ${srcCtx.accountsSample.join(', ') || 'none'}
${srcCtx.execSummary ? `Exec summary:\n${String(srcCtx.execSummary).slice(0, 500)}` : ''}

Pain points across stakeholders:
${srcCtx.painPoints.map((p, i) => `${i+1}. ${String(p).slice(0, 200)}`).join('\n') || 'Not captured'}

FRAME: Posts should hit the pain points this solution addresses, without naming the solution as a product. Teach, provoke, or tell stories.`;
      }
    } else if (ideaSource === 'outreach') {
      const ctx = buildOikeContext();
      sourceBlock = `SOURCE — RECENT OUTREACH (last ${ctx.recentDays} days):
- Touches sent: ${ctx.touchesCount}
- Replies received: ${ctx.repliesCount}
- Meetings booked: ${ctx.meetingsCount}
- Active industries: ${ctx.industries.slice(0,6).join(', ') || 'varied'}
- Solutions in conversation: ${ctx.solutionNames.slice(0,5).join(', ') || 'multiple'}

OBSERVED PAIN POINTS:
${ctx.painPoints.map((p, i) => `${i+1}. ${p.slice(0, 200)}`).join('\n') || 'Not captured'}

RECENT REPLY EXCERPTS (anonymized):
${ctx.replyExcerpts.map((r, i) => `${i+1}. "${r}"`).join('\n') || 'No samples'}

FRAME: Posts should reflect real patterns from the week's conversations — what's hitting, what's not, what you learned.`;
    } else {
      // free
      sourceBlock = `SOURCE — FREE TOPIC (no specific data — use founder's general positioning and recent context).`;
    }

    // Coach answers (if any)
    const coachBlock = coachQuestions.length > 0 && coachAnswers.some(a => a.trim())
      ? `\n\nFOUNDER'S DIRECTION (answered guided questions):
${coachQuestions.map((q, i) => `Q: ${q}\nA: ${coachAnswers[i] || '(skipped)'}`).join('\n\n')}\n\nWeave these answers into the ideas — they define the angle the founder wants.`
      : '';

    const prompt = `You are a content strategist for a B2B founder: ${COMPANY_PROFILE.senderName || 'the founder'}${COMPANY_PROFILE.senderTitle ? ' (' + COMPANY_PROFILE.senderTitle + ')' : ''} at ${COMPANY_PROFILE.companyName || ''}, offering ${COMPANY_PROFILE.services || 'sales intelligence'}.

Generate 8-10 LinkedIn post ideas anchored in this REAL SOURCE (no generic advice):

${sourceBlock}${coachBlock}

Rules:
- Be SPECIFIC (not "10 tips to sell better")
- Reference real patterns (never name clients unless source is public)
- Position as a credible operator, not an influencer
- Mix formats: story, lesson learned, contrarian take, observation, framework
- Each ends with an engagement hook (question, bold claim, invitation)
- Language: match the founder's typical content language (default English unless samples suggest otherwise)

Return ONLY a valid JSON array:
[
  {
"hook": "First line of the post (the scroll-stopper, max 15 words)",
"angle": "Short description of the angle (1 sentence)",
"source": "Which insight from the source inspires this idea",
"format": "story | lesson | contrarian | observation | framework",
"tag": "one of: Sales, Personal, Strategy, Lead gen, Industry insight, Lesson learned, Contrarian, Story, Framework"
  }
]`;

    try {
      const response = await callOpenAI({ prompt, temperature: 0.8, max_tokens: 1800 });
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      setIdeas(Array.isArray(parsed) ? parsed : []);
      setCoachStage('idle'); // reset coach for next run
    } catch (e) {
      console.error('[Content Lab] Generate ideas failed:', e);
      window.__oikeToast('Failed to generate ideas: ' + (e.message || 'unknown'), 'error');
    }
    setLoadingIdeas(false);
  };

  // ── Send idea to writer ──
  const useIdea = (idea) => {
    setWriterTopic(idea.hook + ' — ' + idea.angle);
    setWriterTag(idea.tag || '');
    setSourceInsight(idea.source || '');
    setTab('writer');
  };

  // ── Build source-specific context (events, campaigns, solutions, etc.) ──
  const buildSourceContext = () => {
    const now = Date.now();
    if (ideaSource === 'upcoming-event') {
      const event = events.find(e => e.id === sourceItemId);
      if (!event) return null;
      const invitedIds = linkedIds(event, 'Stakeholders invited');
      const invited = stakeholders.filter(s => invitedIds.includes(s.id));
      return {
        kind: 'upcoming-event',
        name: F(event, 'Event Name') || '',
        date: F(event, 'Starting') || '',
        endDate: F(event, 'End date') || '',
        context: F(event, 'Aditional context') || '',
        summary: typeof F(event, 'Attachment Summary') === 'object' ? F(event, 'Attachment Summary')?.value : F(event, 'Attachment Summary'),
        url: F(event, 'URL') || '',
        invitedCount: invited.length,
        invitedRoles: [...new Set(invited.map(s => F(s, 'Role')).filter(Boolean))].slice(0, 8),
        invitedIndustries: [...new Set(invited.flatMap(s => linkedIds(s, 'Account')).map(id => accounts.find(a => a.id === id)).filter(Boolean).map(a => F(a, 'Industry')).filter(Boolean))].slice(0, 6),
      };
    }
    if (ideaSource === 'past-event') {
      const event = events.find(e => e.id === sourceItemId);
      if (!event) return null;
      const invitedIds = linkedIds(event, 'Stakeholders invited');
      const invited = stakeholders.filter(s => invitedIds.includes(s.id));
      return {
        kind: 'past-event',
        name: F(event, 'Event Name') || '',
        date: F(event, 'Starting') || '',
        endDate: F(event, 'End date') || '',
        context: F(event, 'Aditional context') || '',
        summary: typeof F(event, 'Attachment Summary') === 'object' ? F(event, 'Attachment Summary')?.value : F(event, 'Attachment Summary'),
        attendedCount: invited.length,
        attendedRoles: [...new Set(invited.map(s => F(s, 'Role')).filter(Boolean))].slice(0, 8),
      };
    }
    if (ideaSource === 'campaign') {
      const camp = campaigns.find(c => c.id === sourceItemId);
      if (!camp) return null;
      return {
        kind: 'campaign',
        name: F(camp, 'Name') || '',
        type: F(camp, 'Type') || '',
        status: F(camp, 'Status') || '',
        context: F(camp, 'Context') || '',
        aiSummary: F(camp, 'AI Summary') || '',
        template: F(camp, 'Message Template') || '',
        assetUrl: F(camp, 'Asset URL') || '',
        reached: linkedIds(camp, 'Stakeholders Reached').length,
      };
    }
    if (ideaSource === 'solution') {
      const sol = solutions.find(s => s.id === sourceItemId);
      if (!sol) return null;
      const solAccs = accounts.filter(a => linkedIds(a, 'Solutions').includes(sol.id));
      const solStks = stakeholders.filter(s => {
        const accIds = linkedIds(s, 'Account');
        return accIds.some(id => solAccs.some(a => a.id === id));
      });
      return {
        kind: 'solution',
        name: F(sol, 'Name') || '',
        type: F(sol, 'Type') || '',
        detail: F(sol, 'Service | Solution Detail') || '',
        keyMessage: F(sol, 'Stakeholder Key Message') || '',
        execSummary: F(sol, 'AI Exec Summary') || '',
        recommendations: F(sol, 'AI Strategic Recommendations') || '',
        accountsCount: solAccs.length,
        accountsSample: solAccs.slice(0, 5).map(a => F(a, 'Account Name')).filter(Boolean),
        painPoints: solStks.map(s => F(s, 'Pain points')).filter(p => typeof p === 'string' && p.trim()).slice(0, 5),
      };
    }
    // Default: 'outreach' (last 14 days activity — same as before)
    return null; // signals use existing buildOikeContext()
  };

  // ── Generate coach questions based on source ──
  const generateCoachQuestions = async () => {
    if (ideaSource === 'free') {
      // No coach questions needed — user defines freely
      setCoachStage('done');
      return;
    }
    setLoadingCoach(true);
    const srcCtx = buildSourceContext();
    const ctxPayload = srcCtx ? JSON.stringify(srcCtx).slice(0, 1500) : 'Last 14 days of outreach activity';

    const prompt = `You are a content coach for a B2B founder. Before generating LinkedIn post ideas, ask 2-3 questions that pull OUT their authentic, specific, unfiltered perspective.

SOURCE TYPE: ${ideaSource}
SOURCE DATA:
${ctxPayload}

Your questions should EXTRACT truth, not invite structure. The goal is to get the founder to say something REAL that only they could say — so the posts don't sound AI-generated.

RULES for your questions:
✓ Specific to THIS source (not "what do you want to say about your work")
✓ Ask for moments, feelings, specifics: numbers, names, dates, places, real quotes
✓ Push for opinions, not observations ("what annoyed you" > "what happened")
✓ Allow contradictions and uncomfortable truths
✓ 1 question per concrete dimension (the feeling · the detail · the take)
✓ Phrased as a human would ask a friend over coffee, not as a content coach

AVOID:
✗ Generic "what's your unique angle" questions
✗ "What lesson did you learn" (invites AI-sounding lessons)
✗ "What inspired you" (too vague)
✗ Asking about frameworks or takeaways
✗ Marketing-speak
✗ More than 3 questions (keep it tight)

Example good questions (different sources):
• (past event) "What's the one thing someone said during X that you still haven't fully processed?"
• (campaign) "Who specifically in this ICP have you been annoyed by lately, and why?"
• (outreach) "Which reply from this week surprised you — and what did they say, literally?"
• (upcoming event) "If you had 30 seconds with the audience, what would you actually want them to walk away remembering?"

Return ONLY valid JSON:
{
  "questions": [
"Specific, coffee-chat-style question 1?",
"Specific, coffee-chat-style question 2?",
"Specific, coffee-chat-style question 3?"
  ]
}`;
    try {
      const res = await callOpenAI({ prompt, temperature: 0.6, max_tokens: 500 });
      const cleaned = res.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const qs = Array.isArray(parsed.questions) ? parsed.questions : [];
      setCoachQuestions(qs);
      setCoachAnswers(qs.map(() => ''));
      setCoachStage('answering');
    } catch (e) {
      console.error('[coach] failed:', e);
      // Fallback: skip coach, go straight to generation
      setCoachStage('done');
    }
    setLoadingCoach(false);
  };

  // ── Improve draft (5 modes) ──
  const improveDraft = async (mode) => {
    if (!draft.trim()) { window.__oikeToast('Nothing to improve', 'warning'); return; }
    setImproving(mode);
    const instructions = {
      'shorter': 'Cut the draft by 30-50% while preserving the core point, hook and closing. Aim for punch. Keep the exact same voice — do NOT rewrite stylistically.',
      'hook': 'Rewrite ONLY the first line (the hook). Make it scroll-stopping, specific, bold, curiosity-triggering. No cliché openers ("In today\'s world", "Let me ask you this", "Here\'s the thing"). Keep the rest of the post EXACTLY as is.',
      'cta': 'Rewrite ONLY the final line/closing. Make it a sharper invitation to engage, but NOT a cliché ("Agree? Disagree?", "Let me know in the comments", "Thoughts?"). A real human closing — could be a question, a statement, or silence. Keep the rest EXACTLY as is.',
      'polish': 'Polish the draft: tighten phrasing, kill filler words and corporate-speak, strengthen verbs, fix awkward rhythm. Maintain voice and meaning. Do not restructure or add content.',
      'debot': `RE-HUMANIZE THIS POST. Identify and destroy every single AI-tell — the phrases, structures, and patterns that make LinkedIn content obviously AI-generated.

Specifically eliminate:
• Clichés: "Here's the thing", "Let me ask you this", "Imagine a world", "Most people don't realize", "The truth is", "And then it hit me", "Let that sink in"
• Binary-flip patterns: "Stop X. Start Y." / "It's not X. It's Y."
• Corporate-speak: leverage, synergy, ecosystem, empower, unlock, game-changer, next-level
• "Unpopular opinion:" / "Hot take:" intros
• Numbered lesson lists tied to anecdotes
• Hashtag soup at end
• Single-word dramatic paragraphs ("Stop." "Wait." "Pause.")
• Perfect transitions
• Motivational closing takeaways
• "Agree? Disagree? Let me know in the comments."

Add instead (if missing):
• Uneven sentence length (some short, some meandering)
• Concrete specifics (real numbers, real places, real dates, real names)
• Strong opinion without apology
• Contradictions — it's OK to disagree with yourself mid-post
• Fragments
• "And" or "But" at start of sentences
• Ending abruptly if it feels right

Keep the core message intact. Just strip the AI patina. The result should read like it was typed, not generated.`,
    };
    const prompt = `You are a senior LinkedIn editor helping refine a post.

${voiceSamples.trim() ? `VOICE SAMPLES — this is the voice you must preserve/match:\n"""\n${voiceSamples.slice(0, 3000)}\n"""\n\n` : ''}CURRENT DRAFT:
"""
${draft}
"""

INSTRUCTION:
${instructions[mode] || instructions.polish}

Output ONLY the revised post. No meta-commentary. No "Here's the improved version". No markdown fences. Just the post text, ready to copy-paste.`;
    try {
      const response = await callOpenAI({ prompt, temperature: mode === 'debot' ? 0.75 : 0.55, max_tokens: 1000 });
      setDraft(response.trim());
    } catch (e) {
      console.error('[improveDraft] failed:', e);
      window.__oikeToast('Failed to improve: ' + (e.message || 'unknown'), 'error');
    }
    setImproving('');
  };

  // ── Analyze engagement notes for a post ──
  const analyzeEngagement = async (post) => {
    const notes = F(post, 'Engagement Notes') || '';
    if (!notes.trim()) { window.__oikeToast('No engagement notes to analyze. Paste comments/likes in the Engagement Notes field first.', 'error'); return; }
    setAnalyzingPostId(post.id);
    const content = F(post, 'Content') || '';
    const prompt = `Analyze the engagement data for this LinkedIn post.

POST:
"""
${content.slice(0, 1000)}
"""

ENGAGEMENT DATA (raw text the user pasted — comments, likes count, DM excerpts):
"""
${notes.slice(0, 2500)}
"""

Return analysis as valid JSON:
{
  "overall_sentiment": "positive | mixed | negative",
  "key_themes": ["theme 1", "theme 2"],
  "notable_commenters": ["name 1 if mentioned", "name 2"],
  "suggested_followups": ["follow-up post idea 1", "follow-up post idea 2"],
  "suggested_replies": [{"for_comment": "short quote", "reply": "suggested reply"}]
}

Keep each field short. Return ONLY the JSON, no markdown.`;
    try {
      const res = await callOpenAI({ prompt, temperature: 0.5, max_tokens: 900 });
      const cleaned = res.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      setEngagementAnalysis(prev => ({ ...prev, [post.id]: parsed }));
    } catch (e) {
      console.error('[analyzeEngagement] failed:', e);
      window.__oikeToast('Failed to analyze: ' + (e.message || 'unknown'), 'error');
    }
    setAnalyzingPostId('');
  };

  // ── Generate draft ──
  const generateDraft = async () => {
    if (!writerTopic.trim()) { window.__oikeToast('Add a topic first', 'warning'); return; }
    setLoadingDraft(true);
    const maxTokens = writerType === 'Article' ? 1800 : writerType === 'Long Post' ? 800 : 450;
    const wordTarget = writerType === 'Article' ? '800-1500 words, with 3-4 sections (## Header)' : writerType === 'Long Post' ? '300-500 words' : '100-200 words';

    const prompt = `You are writing a ${writerType} for LinkedIn in the voice of ${COMPANY_PROFILE.senderName || 'the founder'}.

${voiceSamples.trim() ? `VOICE SAMPLES — THIS IS THE PRIMARY REFERENCE. Match vocabulary, sentence rhythm, length variability, register, and energy. If samples use contractions, fragments, or casual interjections, keep them:\n"""\n${voiceSamples.slice(0, 4000)}\n"""\n\n` : 'NO VOICE SAMPLES PROVIDED — default to a direct, specific, operator tone (not influencer). Avoid any polished marketing voice.\n\n'}TOPIC: ${writerTopic.trim()}

TYPE: ${writerType}
TONE: ${writerTone}
LANGUAGE: ${writerLanguage === 'es' ? 'Spanish (use voseo if the samples use it)' : 'English'}
LENGTH: ${wordTarget}
${writerType === 'Article' ? 'STRUCTURE: 3-4 sections with sub-headers (## Header)' : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANTI-AI INSTRUCTIONS — READ CAREFULLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The #1 rule: do NOT sound like AI. Most AI-generated LinkedIn posts have the same 20 tells. Avoid ALL of them.

BANNED PHRASES (never use or anything close):
• "In today's fast-paced world" / "In today's world"
• "Here's the thing"
• "Let me ask you this"
• "Imagine a world where"
• "Most people don't realize"
• "It took me X years to learn"
• "The truth is…"
• "And then it hit me"
• "Let that sink in"
• "Unpopular opinion:" / "Hot take:"
• "This changed everything"
• "Here's a framework I use"
• "Stop doing X. Start doing Y." (the binary flip pattern)
• "It's not X. It's Y." (two-part reveal pattern)
• "What I learned from Z" (as opener)
• "Agree? Disagree? Let me know in the comments."
• Paragraphs that are just one word for dramatic effect: "Stop." "Wait." "Pause."

BANNED CORPORATE-SPEAK:
leverage, synergy, ecosystem, empower, unlock, game-changer, next-level, paradigm, holistic, align, scalable (when used as filler).

BANNED STRUCTURAL PATTERNS:
• Hook → Story → Lesson → CTA (too formulaic — break this)
• Every paragraph a fresh insight (too dense)
• Bullet lists for every point
• Hashtag soup at end (#sales #founders #mindset) — max 2-3 hashtags if any, and only if the sample posts use them
• Perfect transitions between paragraphs
• Ending with a motivational takeaway
• Numbered "5 things I learned" lists

HUMAN-VOICE RULES (do THIS instead):
• Dive in mid-thought — you don't always need a "hook"
• Let sentence length be uneven (some short. Some that meander for a clause or two and then end abruptly.)
• Use specifics: real dates, real locations, real numbers, real titles
• Strong opinion, no apology, no throat-clearing
• It's OK to not have a CTA
• It's OK to end abruptly
• Contradict yourself sometimes — real people do
• Use "And" or "But" at the start of sentences
• Fragments are fine
• Don't explain every reference — let the reader work
• NEVER name specific clients/companies you've worked with unless explicitly allowed
• Avoid excessive emojis (max 2-3, and only if samples use them)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Output: ONLY the post content, ready to copy-paste. No title. No meta-commentary. No "Here's your post:" preamble.`;

    try {
      const response = await callOpenAI({ prompt, temperature: 0.85, max_tokens: maxTokens });
      setDraft(response.trim());
    } catch (e) {
      console.error('[Content Lab] Generate draft failed:', e);
      window.__oikeToast('Failed to generate draft: ' + (e.message || 'unknown'), 'error');
    }
    setLoadingDraft(false);
  };

  // ── Copy to clipboard ──
  const copyDraft = () => {
    navigator.clipboard.writeText(draft).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  // ── Save draft to library ──
  const saveDraft = async () => {
    if (!draft.trim()) { window.__oikeToast('Nothing to save', 'warning'); return; }
    setSavingDraft(true);
    try {
      const a = api || new AirtableAPI();
      const firstLine = draft.split('\n').find(l => l.trim())?.slice(0, 80) || 'Untitled';
      const fields = {
        'Title': firstLine,
        'Content': draft,
        'Type': writerType,
        'Status': 'Draft',
        'Platform': 'LinkedIn',
        ...(writerTag ? { 'Topic Tags': [writerTag] } : {}),
        ...(sourceInsight ? { 'Source Insight': sourceInsight } : {}),
      };
      await a.createRecord(TABLE_IDS.contentLab, fields);
      if (onLogActivity) onLogActivity();
      window.__oikeToast('✅ Saved to Library', 'success');
    } catch (e) {
      console.error('[Content Lab] Save failed:', e);
      window.__oikeToast('Failed to save: ' + (e.message || 'unknown'), 'error');
    }
    setSavingDraft(false);
  };

  // ── Post to LinkedIn: copy + open LinkedIn composer + log in Library ──
  const postToLinkedIn = async () => {
    if (!draft.trim()) { window.__oikeToast('Nothing to post', 'warning'); return; }
    // Synchronous first: clipboard + open tab (browsers require user-gesture context)
    try { await navigator.clipboard.writeText(draft); } catch {}
    window.open('https://www.linkedin.com/feed/?shareActive', '_blank');
    // Log in Airtable in background
    setSavingDraft(true);
    try {
      const a = api || new AirtableAPI();
      const firstLine = draft.split('\n').find(l => l.trim())?.slice(0, 80) || 'Untitled';
      const nowIso = new Date().toISOString();
      const today = nowIso.slice(0, 10);
      const fields = {
        'Title': firstLine,
        'Content': draft,
        'Type': writerType,
        'Status': 'Posted',
        'Platform': 'LinkedIn',
        'Posted Date': today,
        ...(writerTag ? { 'Topic Tags': [writerTag] } : {}),
        ...(sourceInsight ? { 'Source Insight': sourceInsight } : {}),
        'Engagement Notes': `Posted ${nowIso.slice(0, 16).replace('T', ' ')} from Content Lab`,
      };
      const record = await a.createRecord(TABLE_IDS.contentLab, fields);
      if (onLogActivity) onLogActivity();
      // Prompt for URL (optional, after LinkedIn tab is open)
      setTimeout(() => {
        const url = prompt('📲 LinkedIn opened + post copied to clipboard.\n\nPaste with Cmd+V in LinkedIn and click Post.\n\nOnce posted, paste the LinkedIn URL here (or cancel — you can add it later):');
        if (url && url.trim() && record?.id) {
          a.updateRecord(TABLE_IDS.contentLab, record.id, { 'LinkedIn URL': url.trim() })
            .then(() => { if (onLogActivity) onLogActivity(); })
            .catch(e => console.warn('LinkedIn URL save failed:', e));
        }
      }, 400);
    } catch (e) {
      console.error('[postToLinkedIn] save failed:', e);
      window.__oikeToast('Post copied + LinkedIn opened, but failed to log in Library: ' + (e.message || 'unknown'), 'error');
    }
    setSavingDraft(false);
  };

  // ── Mark as posted (simple update) ──
  const markPosted = async (post, linkedinUrl) => {
    try {
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.contentLab, post.id, {
        'Status': 'Posted',
        'Posted Date': new Date().toISOString().slice(0, 10),
        ...(linkedinUrl ? { 'LinkedIn URL': linkedinUrl } : {}),
      });
      if (onLogActivity) onLogActivity();
    } catch (e) {
      console.error('[Content Lab] Mark posted failed:', e);
      window.__oikeToast('Failed: ' + (e.message || 'unknown'), 'error');
    }
  };

  // ── Find recipients for a post (AI ranks stakeholders + writes personalized intros) ──
  const findRecipients = async (post) => {
    const content = F(post, 'Content') || '';
    if (!content.trim()) { window.__oikeToast('Post has no content', 'warning'); return; }
    setFindingRecipientsFor(post.id);

    // Filter candidates: exclude protected statuses + recent outreach
    const SEVEN_DAYS = 7 * 86400000;
    const nowMs = Date.now();
    const recentStkIds = new Set();
    outreach.forEach(o => {
      const ts = new Date(o.fields?.['Date'] || 0).getTime();
      if (nowMs - ts < SEVEN_DAYS) {
        linkedIds(o, 'Stakeholder').forEach(id => recentStkIds.add(id));
      }
    });
    const PROTECTED = ['DNC', 'Bounced', 'Left Company', 'Not Interested'];

    const candidates = stakeholders.filter(s => {
      const status = F(s, 'Status') || '';
      if (PROTECTED.includes(status)) return false;
      if (recentStkIds.has(s.id)) return false;
      // Need at least a name and some context
      if (!F(s, 'Name')) return false;
      return true;
    });

    // Rank candidates by "content-ready": has pain points > role > linkedin > email
    const scored = candidates.map(s => {
      let score = 0;
      if (F(s, 'Pain points') || F(s, 'Pain Points (Generated)')) score += 3;
      if (F(s, 'Role')) score += 2;
      if (F(s, 'LinkedIn')) score += 1;
      if (F(s, 'Email')) score += 1;
      if (F(s, 'Level of Influence') === 'Decision Maker') score += 2;
      return { s, score };
    }).sort((a, b) => b.score - a.score).slice(0, 40);

    // Build RICH pool for AI — includes conversation history per stakeholder
    const nowTs = Date.now();
    const pool = scored.map(({ s }) => {
      const accName = (() => {
        const ids = linkedIds(s, 'Account');
        return ids.length > 0 ? (accounts.find(a => a.id === ids[0])) : null;
      })();
      const industry = accName ? F(accName, 'Industry') : '';
      const pain = F(s, 'Pain points') || F(s, 'Pain Points (Generated)') || '';
      const painText = typeof pain === 'string' ? pain.slice(0, 200) : '';
      const stkStatus = F(s, 'Status') || 'Not Contacted';

      // Pull conversation history
      const stkOutreach = outreach
        .filter(o => linkedIds(o, 'Stakeholder').includes(s.id))
        .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
      const touchesCount = stkOutreach.length;
      const last = stkOutreach[0];
      const lastDaysAgo = last?.fields?.['Date'] ? Math.floor((nowTs - new Date(last.fields['Date']).getTime()) / 86400000) : null;
      const lastStatus = last ? F(last, 'Status') : '';
      const lastChannel = last ? F(last, 'Channel') : '';
      const hasReplyBack = stkOutreach.some(o => ['Replied', 'Received'].includes(F(o, 'Status')));
      const lastFromThem = stkOutreach.find(o => ['Replied', 'Received'].includes(F(o, 'Status')));
      const lastFromThemExcerpt = lastFromThem ? (
        (F(lastFromThem, 'Notes') || F(lastFromThem, 'Message') || '')
          .replace(/^\[gmsg:[^\]]+\]\s*/, '')
          .replace(/[-─]+\s*(Forwarded message|Original message|De:|From:).*/si, '')
          .trim().slice(0, 250)
      ) : '';
      const lastDate = lastFromThem?.fields?.['Date'];
      const lastFromThemDaysAgo = lastDate ? Math.floor((nowTs - new Date(lastDate).getTime()) / 86400000) : null;

      // Build conversation history block
      let historyBlock = '';
      if (touchesCount === 0) {
        historyBlock = 'COLD — no prior contact';
      } else if (hasReplyBack && lastFromThemExcerpt) {
        historyBlock = `ENGAGED — ${touchesCount} touches · they replied ${lastFromThemDaysAgo}d ago · last from them: "${lastFromThemExcerpt}"`;
      } else if (hasReplyBack) {
        historyBlock = `ENGAGED PREVIOUSLY — ${touchesCount} touches · they engaged at some point · last touch ${lastDaysAgo}d ago`;
      } else {
        historyBlock = `NO REPLY YET — ${touchesCount} touches · last ${lastDaysAgo}d ago (${lastChannel} ${lastStatus})`;
      }

      return `[${s.id}]
Name: ${F(s, 'Name')} ${F(s, 'Last name') || ''}
Role: ${F(s, 'Role') || '?'} at ${accName ? F(accName, 'Account Name') : '?'} (${industry || 'industry unknown'})
Pipeline Status: ${stkStatus}
Pain: ${painText || 'n/a'}
Relationship: ${historyBlock}`;
    }).join('\n\n');

    const prompt = `You are helping a B2B founder reach out to specific stakeholders with a thoughtful message inspired by a LinkedIn post they just wrote. The goal is NOT to broadcast the post. The goal is to OPEN CONVERSATIONS with people for whom the insight is genuinely relevant.

THE POST (use as INSPIRATION — extract the key insight, don't just paste the link):
"""
${content.slice(0, 2500)}
"""

STAKEHOLDER POOL:
${pool}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚨 CRITICAL: RESPECT CONVERSATION HISTORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Each stakeholder has a Relationship status. The intro message MUST match it:

• **COLD (no prior contact)** → appropriate first-touch framing. OK to reference a signal ("saw you in X", "your post on Y"), OK to be exploratory. Never pretend you've spoken before.

• **ENGAGED (they replied at some point)** — this is GOLD. Reference the last thing THEY said (use the excerpt provided). Continue the conversation naturally. DO NOT start cold. DO NOT write as if this is a first touch. Example: "You mentioned [their last point] — this is exactly what I was thinking about when I wrote [insight]..."

• **ENGAGED PREVIOUSLY (replied long ago, went quiet)** → acknowledge the gap naturally. "It's been a while" style, but not apologetic. Reconnect with value, not guilt.

• **NO REPLY YET (X touches, no response)** → do NOT just blast them again with the same angle. Acknowledge the silence implicitly by bringing a NEW angle (the post's insight). Soft, no pressure. Never imply they've been ignoring you.

⚠️ NEVER write a first-touch-style opener to someone with ENGAGED status. That's the #1 way to lose trust.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW TO WRITE THE INTRO MESSAGES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. **Open with their context AND relationship state** (see above rules). Make it unmistakable you remember where you left off.

2. **Tease the insight** from the post — share the key idea in your OWN voice (1-2 sentences). Do NOT paste the post. Do NOT just say "check out my post". Frame the insight as something you've been thinking about.

3. **CTA tailored to match score AND relationship:**
   • HIGH match + ENGAGED → strong invitation ("worth the call we talked about?", "let's book that 15 min")
   • HIGH match + COLD → direct but respectful ("open to a 15-min call?")
   • MEDIUM match → soft engagement ("curious what you think", "would love your take")
   • LOW match → light tease, no hard CTA ("might resonate", "thought of you")
   • Anyone STALLED / NO REPLY YET → very soft, no CTA that puts pressure. Just plant the seed.

4. **Optional** post link: only mention as soft afterthought if it truly adds. Use [POST_URL] placeholder.

5. **Voice rules** (CRITICAL — warmth WITHOUT AI-tells):

   **ALWAYS start with a proper greeting — warm and human:**
   • Spanish: "Hola [FirstName]," / "Hola [FirstName], qué tal?" / "[FirstName]!"
   • English: "Hey [FirstName]," / "Hi [FirstName]," / "[FirstName]!"
   • After the greeting, directly into their context — not into filler

   **BANNED filler after greeting (these are the AI-tells, NOT the greeting itself):**
   • "Hope you're well" / "Espero que estés bien"
   • "Hope this finds you well"
   • "Just wanted to share" / "Solo quería compartir"
   • "I came across..." / "Me crucé con..."
   • "Hope you're having a great week"

   **Example contrast:**
   ❌ BAD (too cold): "Juan, when you mentioned the follow-up problem..."
   ❌ BAD (AI-tell): "Hi Juan, hope you're well! Wanted to share something..."
   ✅ GOOD (warm + direct): "Hola Juan — cuando me comentaste lo del follow-up hace unas semanas, estuve dándole vueltas..."
   ✅ GOOD (English warm): "Hey Maria — remember what you said about the SDR ramp? I wrote something that directly answers it."

   • Conversational, like a Slack DM to a friend who happens to be a CFO
   • Short. 3-4 sentences max. No paragraphs.
   • Match the founder's voice from the post (rhythm, register)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Pick UP TO 15 stakeholders with REAL relevance (not forced — fewer is better than padding). ENGAGED/ENGAGED PREVIOUSLY stakeholders with relevant pain should be prioritized over COLD ones (warmer conversations convert better).

Return ONLY valid JSON array:
[
  {
"stakeholder_id": "recXXX",
"match_score": "high | medium | low",
"match_reason": "One line: why this person + relationship state (e.g. 'Replied 18d ago asking for case study — post answers their question directly')",
"intro_message": "Personalized intro that respects relationship history, opens with their context, teases the insight in your voice, ends with CTA matching score + relationship. 3-4 sentences max."
  }
]

No markdown, no commentary. JSON only.`;

    try {
      const res = await callOpenAI({ prompt, temperature: 0.7, max_tokens: 2500 });
      const cleaned = res.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const list = Array.isArray(parsed) ? parsed : [];
      setRecipientsByPost(prev => ({ ...prev, [post.id]: list }));
    } catch (e) {
      console.error('[findRecipients] failed:', e);
      window.__oikeToast('Failed to find recipients: ' + (e.message || 'unknown'), 'error');
    }
    setFindingRecipientsFor('');
  };

  // ── Send post to a specific recipient ──
  const sendToRecipient = async (post, rec, channel) => {
    const stk = stakeholders.find(s => s.id === rec.stakeholder_id);
    if (!stk) { window.__oikeToast('Stakeholder not found', 'warning'); return; }
    const key = `${post.id}:${rec.stakeholder_id}:${channel}`;
    setSendingKey(key);

    const postUrl = F(post, 'LinkedIn URL') || '';
    // If URL exists → substitute. If not → strip the placeholder cleanly (some AIs may leave orphan punctuation, best effort)
    const messageWithUrl = postUrl
      ? (rec.intro_message || '').replace(/\[POST_URL\]/g, postUrl)
      : (rec.intro_message || '').replace(/\s*[:—-]?\s*\[POST_URL\]\s*\.?/g, '').trim();
    const postTitle = F(post, 'Title') || 'LinkedIn post';
    const sName = F(stk, 'Name') || '';
    const email = F(stk, 'Email') || '';
    const linkedin = F(stk, 'LinkedIn') || '';
    const companyIds = linkedIds(stk, 'Account');

    // Open channel synchronously (user gesture required)
    if (channel === 'LinkedIn') {
      if (!linkedin) { window.__oikeToast('This contact has no LinkedIn URL', 'warning'); setSendingKey(''); return; }
      try { await navigator.clipboard.writeText(messageWithUrl); } catch {}
      window.open(linkedin, '_blank');
    } else if (channel === 'Email') {
      if (!email) { window.__oikeToast('This contact has no email', 'warning'); setSendingKey(''); return; }
      const subject = `Thought of you: ${postTitle.slice(0, 60)}`;
      window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(messageWithUrl)}`, '_blank');
    }

    // Log outreach in background
    try {
      const a = api || new AirtableAPI();
      const outreachFields = {
        'Activity Name': `${channel} · Shared post "${postTitle.slice(0, 50)}" with ${sName}`,
        'Account': companyIds, 'Stakeholder': [stk.id],
        'Channel': channel, 'Date': new Date().toISOString(),
        'Status': 'Sent',
        'Message': messageWithUrl,
        'Notes': `Content Lab share — post: ${postTitle}${postUrl ? ' · ' + postUrl : ''}`,
        'Logged By': CURRENT_USER?.name || '',
        ...(CURRENT_USER?.role === 'bdr' && CURRENT_USER?.name ? { 'BDR Owner': CURRENT_USER.name } : {}),
        ...(CURRENT_USER?.role === 'cp' && CURRENT_USER?.name ? { 'CP Assigned': CURRENT_USER.name } : {}),
      };
      await a.createRecord(TABLE_IDS.outreach, outreachFields);
      await activateAccountIfNeeded(a, companyIds, accounts);
      await updateStakeholderStatus(a, stk.id, 'Contacted', stakeholders);
      if (onLogActivity) onLogActivity();
      // Mark this recipient as sent in local state (so UI shows ✓)
      setRecipientsByPost(prev => {
        const list = (prev[post.id] || []).map(r => r.stakeholder_id === rec.stakeholder_id ? { ...r, sentChannel: channel, sentAt: Date.now() } : r);
        return { ...prev, [post.id]: list };
      });
    } catch (e) {
      console.error('[sendToRecipient] log failed:', e);
    }
    setSendingKey('');
  };

  // ── Delete post from Library ──
  const deletePost = async (post) => {
    const name = F(post, 'Title') || 'this post';
    if (!confirm(`Delete "${name.slice(0, 60)}"?\n\nThis removes it from the Library permanently.`)) return;
    try {
      const a = api || new AirtableAPI();
      await a.deleteRecord(TABLE_IDS.contentLab, post.id);
      if (onDeleteRecord) onDeleteRecord('contentLab', post.id);
      if (onLogActivity) onLogActivity();
    } catch (e) {
      console.error('[Content Lab] Delete failed:', e);
      window.__oikeToast('Failed to delete: ' + (e.message || 'unknown'), 'error');
    }
  };

  // ── Post from Library: copy + open LinkedIn + mark posted ──
  const postFromLibrary = async (post) => {
    const content = F(post, 'Content') || '';
    if (!content.trim()) { window.__oikeToast('Empty post, nothing to share', 'warning'); return; }
    try { await navigator.clipboard.writeText(content); } catch {}
    window.open('https://www.linkedin.com/feed/?shareActive', '_blank');
    const nowIso = new Date().toISOString();
    try {
      const a = api || new AirtableAPI();
      await a.updateRecord(TABLE_IDS.contentLab, post.id, {
        'Status': 'Posted',
        'Posted Date': nowIso.slice(0, 10),
        'Engagement Notes': ((F(post, 'Engagement Notes') || '') + `\nPosted ${nowIso.slice(0, 16).replace('T', ' ')} from Content Lab`).trim(),
      });
      if (onLogActivity) onLogActivity();
      setTimeout(() => {
        const url = prompt('📲 LinkedIn opened + post copied.\n\nPaste in LinkedIn (Cmd+V) and click Post.\n\nOnce posted, paste the LinkedIn URL here (or cancel to add later):');
        if (url && url.trim()) {
          a.updateRecord(TABLE_IDS.contentLab, post.id, { 'LinkedIn URL': url.trim() })
            .then(() => { if (onLogActivity) onLogActivity(); })
            .catch(e => console.warn('LinkedIn URL save failed:', e));
        }
      }, 400);
    } catch (e) {
      console.error('[postFromLibrary] failed:', e);
    }
  };

  // ── Library filtered ──
  const filteredLibrary = contentLab.filter(p => {
    if (libraryFilter === 'all') return true;
    return (F(p, 'Status') || 'Draft').toLowerCase() === libraryFilter.toLowerCase();
  }).sort((a, b) => new Date(b.fields?.['Posted Date'] || b.createdTime || 0) - new Date(a.fields?.['Posted Date'] || a.createdTime || 0));

  // Tab buttons style
  const tabBtnStyle = (active) => ({
    padding: '10px 18px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
    background: active ? 'rgba(91,191,181,0.18)' : 'rgba(255,255,255,0.04)',
    border: `1px solid ${active ? 'var(--globant-green)' : 'rgba(255,255,255,0.08)'}`,
    color: active ? 'var(--globant-green)' : 'var(--globant-text)',
  });

  return (
    <div>
      <div className="page-header">
        <h1>✍️ Content Lab</h1>
        <p>LinkedIn posts and articles, anchored to your real sales data. Your content and pipeline feed each other.</p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <button style={tabBtnStyle(tab === 'ideas')} onClick={() => setTab('ideas')}>💡 Ideas</button>
        <button style={tabBtnStyle(tab === 'writer')} onClick={() => setTab('writer')}>✏️ Writer</button>
        <button style={tabBtnStyle(tab === 'library')} onClick={() => setTab('library')}>📚 Library ({contentLab.length})</button>
        <button style={tabBtnStyle(tab === 'voice')} onClick={() => setTab('voice')}>🎙️ Voice Training</button>
      </div>

      {/* ── IDEAS TAB ── */}
      {tab === 'ideas' && (
        <div>
          {/* Source selector */}
          <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--globant-green)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
              SOURCE — what should inspire the ideas?
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {[
                { key: 'outreach', label: '📧 Recent outreach', needsId: false },
                { key: 'upcoming-event', label: '📆 Upcoming event', needsId: true },
                { key: 'past-event', label: '🎤 Past event', needsId: true },
                { key: 'campaign', label: '📣 Campaign', needsId: true },
                { key: 'solution', label: '🛠️ Solution', needsId: true },
                { key: 'free', label: '✍️ Free topic', needsId: false },
              ].map(src => (
                <button key={src.key}
                  onClick={() => { setIdeaSource(src.key); setSourceItemId(''); setCoachStage('idle'); setCoachQuestions([]); setCoachAnswers([]); }}
                  style={{
                    padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                    background: ideaSource === src.key ? 'rgba(91,191,181,0.18)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${ideaSource === src.key ? 'var(--globant-green)' : 'rgba(255,255,255,0.08)'}`,
                    color: ideaSource === src.key ? 'var(--globant-green)' : 'var(--globant-text)',
                  }}>
                  {src.label}
                </button>
              ))}
            </div>

            {/* Specific item selector */}
            {ideaSource === 'upcoming-event' && (
              <select className="input-field" style={{ width: '100%', fontSize: 12, marginBottom: 10 }} value={sourceItemId} onChange={e => setSourceItemId(e.target.value)}>
                <option value="">— Pick an upcoming event —</option>
                {events.filter(e => {
                  const st = e.fields?.['Starting'];
                  return st && new Date(st).getTime() > Date.now() - 86400000;
                }).sort((a, b) => new Date(a.fields?.['Starting'] || 0) - new Date(b.fields?.['Starting'] || 0)).map(e => (
                  <option key={e.id} value={e.id}>
                    {F(e, 'Event Name')} {e.fields?.['Starting'] ? `· ${formatDate(e.fields['Starting'])}` : ''}
                  </option>
                ))}
              </select>
            )}
            {ideaSource === 'past-event' && (
              <select className="input-field" style={{ width: '100%', fontSize: 12, marginBottom: 10 }} value={sourceItemId} onChange={e => setSourceItemId(e.target.value)}>
                <option value="">— Pick a past event —</option>
                {events.filter(e => {
                  const st = e.fields?.['Starting'];
                  return st && new Date(st).getTime() <= Date.now();
                }).sort((a, b) => new Date(b.fields?.['Starting'] || 0) - new Date(a.fields?.['Starting'] || 0)).map(e => (
                  <option key={e.id} value={e.id}>
                    {F(e, 'Event Name')} {e.fields?.['Starting'] ? `· ${formatDate(e.fields['Starting'])}` : ''}
                  </option>
                ))}
              </select>
            )}
            {ideaSource === 'campaign' && (
              <select className="input-field" style={{ width: '100%', fontSize: 12, marginBottom: 10 }} value={sourceItemId} onChange={e => setSourceItemId(e.target.value)}>
                <option value="">— Pick a campaign —</option>
                {campaigns.map(c => (
                  <option key={c.id} value={c.id}>{F(c, 'Name')} {F(c, 'Status') ? `· ${F(c, 'Status')}` : ''}</option>
                ))}
              </select>
            )}
            {ideaSource === 'solution' && (
              <select className="input-field" style={{ width: '100%', fontSize: 12, marginBottom: 10 }} value={sourceItemId} onChange={e => setSourceItemId(e.target.value)}>
                <option value="">— Pick a solution —</option>
                {solutions.map(s => <option key={s.id} value={s.id}>{F(s, 'Name')}</option>)}
              </select>
            )}

            {/* Coach + Generate buttons */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {coachStage === 'idle' && (
                <>
                  <button className="action-btn btn-primary" style={{ fontSize: 13 }}
                    onClick={generateIdeas}
                    disabled={loadingIdeas || (['upcoming-event','past-event','campaign','solution'].includes(ideaSource) && !sourceItemId)}>
                    {loadingIdeas ? '⏳ Generating...' : '✨ Generate Ideas'}
                  </button>
                  {ideaSource !== 'free' && (
                    <button className="action-btn btn-ghost" style={{ fontSize: 13 }}
                      onClick={generateCoachQuestions}
                      disabled={loadingCoach || (['upcoming-event','past-event','campaign','solution'].includes(ideaSource) && !sourceItemId)}>
                      {loadingCoach ? '⏳ Asking...' : '🎯 Guided (AI asks first)'}
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Coach questions panel */}
            {coachStage === 'answering' && coachQuestions.length > 0 && (
              <div style={{ marginTop: 14, padding: '14px 16px', background: 'rgba(167,139,250,0.08)', borderRadius: 10, border: '1px solid rgba(167,139,250,0.25)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#a78bfa', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
                  🎯 Answer these to sharpen the angle
                </div>
                {coachQuestions.map((q, i) => (
                  <div key={i} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--globant-text)', marginBottom: 4 }}>{i+1}. {q}</div>
                    <textarea
                      className="input-field"
                      style={{ width: '100%', minHeight: 55, fontSize: 12, fontFamily: 'inherit', lineHeight: 1.5, resize: 'vertical' }}
                      value={coachAnswers[i] || ''}
                      onChange={e => {
                        const next = [...coachAnswers];
                        next[i] = e.target.value;
                        setCoachAnswers(next);
                      }}
                      placeholder="1-2 sentences, your honest take..."
                    />
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={generateIdeas} disabled={loadingIdeas}>
                    {loadingIdeas ? '⏳ Generating...' : '✨ Generate ideas with these answers'}
                  </button>
                  <button className="action-btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setCoachStage('idle'); setCoachQuestions([]); setCoachAnswers([]); }}>
                    ← Back
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Empty state */}
          {ideas.length === 0 && !loadingIdeas && coachStage !== 'answering' && (
            <div className="card" style={{ textAlign: 'center', padding: 32, color: 'var(--globant-muted)' }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>💡</div>
              <p style={{ fontSize: 14 }}>Pick a source above and click "Generate Ideas".</p>
              <p style={{ fontSize: 12, marginTop: 6 }}>Want tighter results? Use <strong>🎯 Guided</strong> — the AI will ask you 2-3 questions first.</p>
            </div>
          )}

          {/* Ideas grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
            {ideas.map((idea, i) => (
              <div key={i} className="card" style={{ borderLeft: '3px solid var(--globant-accent)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--globant-accent)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
                  {idea.format || 'post'} · {idea.tag || 'Sales'}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--globant-text)', marginBottom: 8, lineHeight: 1.4 }}>
                  {idea.hook}
                </div>
                <div style={{ fontSize: 12, color: 'var(--globant-muted)', marginBottom: 10, lineHeight: 1.5 }}>
                  {idea.angle}
                </div>
                {idea.source && (
                  <div style={{ fontSize: 10, color: 'var(--globant-muted)', fontStyle: 'italic', marginBottom: 12, padding: '6px 10px', background: 'rgba(91,191,181,0.06)', borderRadius: 6, borderLeft: '2px solid var(--globant-green)' }}>
                    💡 {idea.source}
                  </div>
                )}
                <button className="action-btn btn-primary" style={{ fontSize: 11, width: '100%' }} onClick={() => useIdea(idea)}>
                  ✏️ Write this post →
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── WRITER TAB ── */}
      {tab === 'writer' && (
        <div>
          <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--globant-green)' }}>
            <h3 style={{ fontSize: 15, marginBottom: 12 }}>✏️ Post configuration</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'block', marginBottom: 4 }}>Type</label>
                <select className="input-field" style={{ width: '100%', fontSize: 12 }} value={writerType} onChange={e => setWriterType(e.target.value)}>
                  {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'block', marginBottom: 4 }}>Tone</label>
                <select className="input-field" style={{ width: '100%', fontSize: 12 }} value={writerTone} onChange={e => setWriterTone(e.target.value)}>
                  {TONES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'block', marginBottom: 4 }}>Language</label>
                <select className="input-field" style={{ width: '100%', fontSize: 12 }} value={writerLanguage} onChange={e => setWriterLanguage(e.target.value)}>
                  <option value="en">English</option>
                  <option value="es">Español</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'block', marginBottom: 4 }}>Topic tag</label>
                <select className="input-field" style={{ width: '100%', fontSize: 12 }} value={writerTag} onChange={e => setWriterTag(e.target.value)}>
                  <option value="">— No tag —</option>
                  {TAGS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>
            <label style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'block', marginBottom: 4 }}>Topic / Brief</label>
            <textarea
              className="input-field"
              style={{ width: '100%', minHeight: 80, resize: 'vertical', fontSize: 13, fontFamily: 'inherit', lineHeight: 1.5 }}
              placeholder="E.g.: How I noticed 80% of SDRs do follow-up wrong — and what I changed in my messages after 100 meetings"
              value={writerTopic}
              onChange={e => setWriterTopic(e.target.value)}
            />
            {sourceInsight && (
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', fontStyle: 'italic', marginTop: 6, padding: '6px 10px', background: 'rgba(91,191,181,0.06)', borderRadius: 6 }}>
                💡 Source insight: {sourceInsight}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="action-btn btn-primary" style={{ fontSize: 13 }} onClick={generateDraft} disabled={loadingDraft || !writerTopic.trim()}>
                {loadingDraft ? '⏳ Generating...' : draft ? '🔄 Regenerate' : '✨ Generate Draft'}
              </button>
              {!voiceSamples.trim() && (
                <button className="action-btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setTab('voice')}>
                  💡 Add voice samples for better results →
                </button>
              )}
            </div>
          </div>

          {/* Draft preview */}
          {draft && (
            <div className="card" style={{ borderLeft: '3px solid var(--globant-accent)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                <h3 style={{ fontSize: 15, margin: 0 }}>📝 Your draft</h3>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="action-btn btn-ghost" style={{ fontSize: 11 }} onClick={copyDraft}>
                    {copied ? '✅ Copied!' : '📋 Copy'}
                  </button>
                  <button className="action-btn btn-ghost" style={{ fontSize: 11 }} onClick={saveDraft} disabled={savingDraft}>
                    {savingDraft ? '⏳' : '💾 Save as Draft'}
                  </button>
                  <button className="action-btn btn-linkedin" style={{ fontSize: 11, background: 'rgba(10,102,194,0.18)', border: '1px solid rgba(10,102,194,0.5)', color: '#4A9BFF' }} onClick={postToLinkedIn} disabled={savingDraft}>
                    {savingDraft ? '⏳' : '🔗 Post on LinkedIn'}
                  </button>
                </div>
              </div>

              {/* Improve with AI — 5 modes */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, padding: '8px 10px', background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#a78bfa', letterSpacing: 1, textTransform: 'uppercase', alignSelf: 'center', marginRight: 4 }}>✨ Improve:</span>
                {[
                  { key: 'shorter', label: '✂️ Shorter', title: 'Cut 30-50% keeping the core', color: '#a78bfa' },
                  { key: 'hook', label: '🔥 Punchier hook', title: 'Rewrite only first line', color: '#a78bfa' },
                  { key: 'cta', label: '🎯 Sharpen CTA', title: 'Rewrite only closing/CTA', color: '#a78bfa' },
                  { key: 'polish', label: '✨ Polish', title: 'Tighten phrasing, kill filler', color: '#a78bfa' },
                  { key: 'debot', label: '🤖→👤 Debot', title: 'Strip AI tells — humanize the text', color: '#4ade80', special: true },
                ].map(m => (
                  <button key={m.key}
                    onClick={() => improveDraft(m.key)}
                    disabled={!!improving}
                    title={m.title}
                    style={{
                      fontSize: 10, padding: '4px 10px', borderRadius: 6, cursor: improving ? 'wait' : 'pointer',
                      background: m.special ? 'rgba(74,222,128,0.15)' : 'rgba(167,139,250,0.15)',
                      border: `1px solid ${m.special ? 'rgba(74,222,128,0.4)' : 'rgba(167,139,250,0.35)'}`,
                      color: m.color, fontWeight: 700,
                    }}>
                    {improving === m.key ? '⏳ Working...' : m.label}
                  </button>
                ))}
              </div>

              <textarea
                className="input-field"
                style={{ width: '100%', minHeight: 340, fontSize: 13.5, fontFamily: 'inherit', lineHeight: 1.7, resize: 'vertical' }}
                value={draft}
                onChange={e => setDraft(e.target.value)}
              />
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 8 }}>
                💡 Edit freely, or use ✨ Improve buttons to polish with AI. The draft is yours now.
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── LIBRARY TAB ── */}
      {tab === 'library' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {['all', 'draft', 'scheduled', 'posted'].map(f => (
              <button key={f} style={tabBtnStyle(libraryFilter === f)} onClick={() => setLibraryFilter(f)}>
                {f === 'all' ? `All (${contentLab.length})` : f.charAt(0).toUpperCase() + f.slice(1) + ` (${contentLab.filter(p => (F(p, 'Status') || 'Draft').toLowerCase() === f).length})`}
              </button>
            ))}
          </div>

          {filteredLibrary.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: 32, color: 'var(--globant-muted)' }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>📚</div>
              <p style={{ fontSize: 14 }}>No saved posts yet.</p>
              <p style={{ fontSize: 12 }}>Generate one in <strong>Writer</strong> and click "Save to Library".</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              {filteredLibrary.map(post => {
                const status = F(post, 'Status') || 'Draft';
                const statusColor = status === 'Posted' ? '#4ade80' : status === 'Scheduled' ? '#fbbf24' : '#8888A8';
                const content = F(post, 'Content') || '';
                const preview = content.slice(0, 220);
                const postedDate = F(post, 'Posted Date');
                const linkedinUrl = F(post, 'LinkedIn URL');
                const tags = F(post, 'Topic Tags');
                return (
                  <div key={post.id} className="card" style={{ borderLeft: `3px solid ${statusColor}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 8, gap: 10 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                          <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: `${statusColor}25`, color: statusColor, fontWeight: 700 }}>{status}</span>
                          <span style={{ fontSize: 10, color: 'var(--globant-muted)' }}>{F(post, 'Type')}</span>
                          {Array.isArray(tags) && tags.map(t => <span key={t} style={{ fontSize: 9, padding: '1px 7px', borderRadius: 8, background: 'rgba(91,191,181,0.15)', color: 'var(--globant-green)', fontWeight: 600 }}>{t}</span>)}
                          {postedDate && <span style={{ fontSize: 10, color: 'var(--globant-muted)' }}>· Posted {postedDate}</span>}
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--globant-text)', marginBottom: 4 }}>{F(post, 'Title')}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="action-btn btn-ghost" style={{ fontSize: 10 }} title="Copy content" onClick={() => { navigator.clipboard.writeText(content); }}>📋</button>
                        <button className="action-btn btn-ghost" style={{ fontSize: 10 }} title={editingPost === post.id ? 'Collapse' : 'Expand'} onClick={() => setEditingPost(editingPost === post.id ? null : post.id)}>
                          {editingPost === post.id ? '✕' : '👁️'}
                        </button>
                        {status !== 'Posted' && (
                          <button className="action-btn btn-primary" style={{ fontSize: 10, background: 'rgba(10,102,194,0.18)', border: '1px solid rgba(10,102,194,0.5)', color: '#4A9BFF' }} onClick={() => postFromLibrary(post)}>
                            🔗 Post on LinkedIn
                          </button>
                        )}
                        <button className="action-btn btn-ghost" style={{ fontSize: 10, background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.35)', color: '#a78bfa', fontWeight: 700 }} title="Find stakeholders who would benefit from this post"
                          onClick={() => findRecipients(post)} disabled={findingRecipientsFor === post.id}>
                          {findingRecipientsFor === post.id ? '⏳ Finding...' : '📮 Find recipients'}
                        </button>
                        <button className="action-btn btn-ghost" style={{ fontSize: 10, color: '#e57373', border: '1px solid rgba(229,115,115,0.3)' }} title="Delete post" onClick={() => deletePost(post)}>🗑️</button>
                      </div>
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--globant-text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                      {editingPost === post.id ? content : (preview + (content.length > 220 ? '...' : ''))}
                    </div>
                    {linkedinUrl && (
                      <a href={linkedinUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: 'var(--globant-info)', marginTop: 8, display: 'inline-block' }}>🔗 View on LinkedIn</a>
                    )}

                    {/* Recipients recommender panel */}
                    {recipientsByPost[post.id] && recipientsByPost[post.id].length > 0 && (
                      <div style={{ marginTop: 14, padding: '12px 14px', background: 'rgba(167,139,250,0.06)', borderRadius: 8, borderLeft: '2px solid #a78bfa' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: '#a78bfa', letterSpacing: 1, textTransform: 'uppercase' }}>
                            📮 {recipientsByPost[post.id].length} recipient{recipientsByPost[post.id].length !== 1 ? 's' : ''} recommended
                          </div>
                          <button className="action-btn btn-ghost" style={{ fontSize: 10 }} onClick={() => setRecipientsByPost(prev => { const next = { ...prev }; delete next[post.id]; return next; })}>✕ Close</button>
                        </div>
                        {!linkedinUrl && (
                          <div style={{ padding: '6px 10px', background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.25)', borderRadius: 6, fontSize: 11, color: 'var(--globant-info)', marginBottom: 10 }}>
                            ℹ️ No LinkedIn URL saved for this post. That's fine — the intros are insight + conversation-driven, not link-dependent. If you add the URL later (Post on LinkedIn action), it'll appear only where the AI chose to reference it.
                          </div>
                        )}
                        {recipientsByPost[post.id].map((rec, i) => {
                          const stk = stakeholders.find(s => s.id === rec.stakeholder_id);
                          if (!stk) return null;
                          const stkName = `${F(stk, 'Name') || ''} ${F(stk, 'Last name') || ''}`.trim();
                          const stkRole = F(stk, 'Role') || '';
                          const accIds = linkedIds(stk, 'Account');
                          const acc = accIds.length > 0 ? accounts.find(a => a.id === accIds[0]) : null;
                          const accName = acc ? F(acc, 'Account Name') : '';
                          const hasEmail = !!F(stk, 'Email');
                          const hasLinkedIn = !!F(stk, 'LinkedIn');
                          const scoreColor = rec.match_score === 'high' ? '#4ade80' : rec.match_score === 'medium' ? '#fbbf24' : '#8888a8';
                          const scoreIcon = rec.match_score === 'high' ? '🟢' : rec.match_score === 'medium' ? '🟡' : '⚪';
                          const alreadySent = !!rec.sentChannel;

                          // Compute relationship state for visual badge
                          const stkOut = outreach.filter(o => linkedIds(o, 'Stakeholder').includes(stk.id));
                          const hasReply = stkOut.some(o => ['Replied', 'Received'].includes(F(o, 'Status')));
                          const lastOut = stkOut.sort((a,b) => new Date(b.fields?.['Date']||0) - new Date(a.fields?.['Date']||0))[0];
                          const lastFromThem = stkOut.find(o => ['Replied', 'Received'].includes(F(o, 'Status')));
                          const lastFromThemDays = lastFromThem?.fields?.['Date'] ? Math.floor((Date.now() - new Date(lastFromThem.fields['Date']).getTime()) / 86400000) : null;
                          let relState = 'cold', relLabel = 'Cold', relColor = '#8888a8';
                          if (stkOut.length === 0) {
                            relState = 'cold'; relLabel = 'Cold'; relColor = '#8888a8';
                          } else if (hasReply && lastFromThemDays !== null && lastFromThemDays < 60) {
                            relState = 'engaged'; relLabel = `Engaged · ${lastFromThemDays}d`; relColor = '#4ade80';
                          } else if (hasReply) {
                            relState = 'engaged-old'; relLabel = 'Engaged (old)'; relColor = '#60a5fa';
                          } else {
                            const lastDays = lastOut?.fields?.['Date'] ? Math.floor((Date.now() - new Date(lastOut.fields['Date']).getTime()) / 86400000) : 0;
                            relState = 'stalled'; relLabel = `Stalled · ${stkOut.length} touches, no reply`; relColor = '#fbbf24';
                          }
                          return (
                            <div key={i} style={{ marginBottom: 10, padding: 10, background: 'rgba(255,255,255,0.03)', borderRadius: 6, opacity: alreadySent ? 0.6 : 1 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 10, marginBottom: 6 }}>
                                <div style={{ flex: 1 }}>
                                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--globant-text)' }}>
                                    {scoreIcon} {stkName}
                                    <span style={{ fontSize: 9, marginLeft: 8, padding: '1px 7px', borderRadius: 8, background: `${scoreColor}25`, color: scoreColor, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>{rec.match_score}</span>
                                    <span style={{ fontSize: 9, marginLeft: 4, padding: '1px 7px', borderRadius: 8, background: `${relColor}20`, color: relColor, fontWeight: 700, border: `1px solid ${relColor}50` }}>{relLabel}</span>
                                  </div>
                                  <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 2 }}>
                                    {stkRole}{accName ? ` · ${accName}` : ''}
                                  </div>
                                </div>
                              </div>
                              <div style={{ fontSize: 11, color: 'var(--globant-muted)', fontStyle: 'italic', marginBottom: 8, padding: '4px 8px', background: 'rgba(91,191,181,0.05)', borderLeft: '2px solid rgba(91,191,181,0.4)', borderRadius: 4 }}>
                                💡 {rec.match_reason}
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--globant-text)', lineHeight: 1.5, padding: '8px 10px', background: 'rgba(255,255,255,0.04)', borderRadius: 6, marginBottom: 8, whiteSpace: 'pre-wrap' }}>
                                {linkedinUrl
                                  ? (rec.intro_message || '').replace(/\[POST_URL\]/g, linkedinUrl)
                                  : (rec.intro_message || '').replace(/\s*[:—-]?\s*\[POST_URL\]\s*\.?/g, '').trim()}
                              </div>
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                {alreadySent ? (
                                  <span style={{ fontSize: 11, padding: '4px 10px', background: 'rgba(74,222,128,0.15)', color: '#4ade80', borderRadius: 6, fontWeight: 700 }}>✓ Sent via {rec.sentChannel}</span>
                                ) : (
                                  <>
                                    {hasLinkedIn && (
                                      <button className="action-btn btn-linkedin" style={{ fontSize: 11 }}
                                        disabled={sendingKey === `${post.id}:${rec.stakeholder_id}:LinkedIn`}
                                        onClick={() => sendToRecipient(post, rec, 'LinkedIn')}>
                                        {sendingKey === `${post.id}:${rec.stakeholder_id}:LinkedIn` ? '⏳' : '💬 Send via LinkedIn'}
                                      </button>
                                    )}
                                    {hasEmail && (
                                      <button className="action-btn btn-email" style={{ fontSize: 11 }}
                                        disabled={sendingKey === `${post.id}:${rec.stakeholder_id}:Email`}
                                        onClick={() => sendToRecipient(post, rec, 'Email')}>
                                        {sendingKey === `${post.id}:${rec.stakeholder_id}:Email` ? '⏳' : '✉️ Send via Email'}
                                      </button>
                                    )}
                                    {!hasLinkedIn && !hasEmail && (
                                      <span style={{ fontSize: 11, color: 'var(--globant-muted)', fontStyle: 'italic' }}>⚠️ No LinkedIn or email on file</span>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Engagement analyzer (only visible when expanded) */}
                    {editingPost === post.id && status === 'Posted' && (
                      <div style={{ marginTop: 14, padding: '12px 14px', background: 'rgba(96,165,250,0.06)', borderRadius: 8, borderLeft: '2px solid var(--globant-info)' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-info)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
                          🧠 Engagement analysis
                        </div>
                        <p style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 8, lineHeight: 1.5 }}>
                          Paste comments, DMs, and likes count in the post's <strong style={{ color: 'var(--globant-text)' }}>Engagement Notes</strong> field in Airtable, then click Analyze. LinkedIn doesn't allow auto-reading these — manual paste for now.
                        </p>
                        {!F(post, 'Engagement Notes') ? (
                          <div style={{ fontSize: 11, color: 'var(--globant-muted)', fontStyle: 'italic' }}>
                            ⚠️ No engagement notes yet. Add them in Airtable first.
                          </div>
                        ) : (
                          <>
                            <button className="action-btn btn-primary" style={{ fontSize: 11 }}
                              onClick={() => analyzeEngagement(post)}
                              disabled={analyzingPostId === post.id}>
                              {analyzingPostId === post.id ? '⏳ Analyzing...' : engagementAnalysis[post.id] ? '🔄 Re-analyze' : '🧠 Analyze engagement'}
                            </button>

                            {engagementAnalysis[post.id] && (() => {
                              const a = engagementAnalysis[post.id];
                              const sentimentColor = a.overall_sentiment === 'positive' ? '#4ade80' : a.overall_sentiment === 'negative' ? '#e57373' : '#fbbf24';
                              return (
                                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--globant-text)' }}>
                                  <div style={{ marginBottom: 10 }}>
                                    <strong style={{ color: 'var(--globant-muted)', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' }}>Sentiment:</strong>
                                    <span style={{ marginLeft: 8, padding: '2px 10px', borderRadius: 10, background: `${sentimentColor}25`, color: sentimentColor, fontWeight: 700, fontSize: 11 }}>{a.overall_sentiment}</span>
                                  </div>
                                  {Array.isArray(a.key_themes) && a.key_themes.length > 0 && (
                                    <div style={{ marginBottom: 10 }}>
                                      <strong style={{ color: 'var(--globant-muted)', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Key themes:</strong>
                                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                        {a.key_themes.map((t, i) => <span key={i} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 8, background: 'rgba(91,191,181,0.15)', color: 'var(--globant-green)', fontWeight: 600 }}>{t}</span>)}
                                      </div>
                                    </div>
                                  )}
                                  {Array.isArray(a.notable_commenters) && a.notable_commenters.length > 0 && (
                                    <div style={{ marginBottom: 10 }}>
                                      <strong style={{ color: 'var(--globant-muted)', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Notable commenters:</strong>
                                      <div style={{ fontSize: 12 }}>{a.notable_commenters.join(' · ')}</div>
                                    </div>
                                  )}
                                  {Array.isArray(a.suggested_followups) && a.suggested_followups.length > 0 && (
                                    <div style={{ marginBottom: 10 }}>
                                      <strong style={{ color: 'var(--globant-muted)', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Follow-up ideas:</strong>
                                      <ul style={{ paddingLeft: 20, margin: 0, fontSize: 12, lineHeight: 1.6 }}>
                                        {a.suggested_followups.map((f, i) => <li key={i}>{f}</li>)}
                                      </ul>
                                    </div>
                                  )}
                                  {Array.isArray(a.suggested_replies) && a.suggested_replies.length > 0 && (
                                    <div>
                                      <strong style={{ color: 'var(--globant-muted)', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Suggested replies:</strong>
                                      {a.suggested_replies.map((r, i) => (
                                        <div key={i} style={{ marginBottom: 8, padding: '6px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 6, borderLeft: '2px solid var(--globant-accent)' }}>
                                          <div style={{ fontSize: 11, color: 'var(--globant-muted)', fontStyle: 'italic', marginBottom: 4 }}>On: "{r.for_comment}"</div>
                                          <div style={{ fontSize: 12 }}>→ {r.reply}</div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── VOICE TRAINING TAB ── */}
      {tab === 'voice' && (
        <div>
          <div className="card" style={{ borderLeft: '3px solid var(--globant-accent)' }}>
            <h3 style={{ fontSize: 15, marginBottom: 10 }}>🎙️ Your voice</h3>
            <p style={{ fontSize: 13, color: 'var(--globant-muted)', marginBottom: 12, lineHeight: 1.55 }}>
              Paste 10-15 of your LinkedIn posts below (the ones that sound most like you). The AI will read them to match your vocabulary, rhythm, sentence length, and energy. <strong style={{ color: 'var(--globant-text)' }}>Without this, drafts come out generic.</strong>
            </p>
            <p style={{ fontSize: 12, color: 'var(--globant-muted)', marginBottom: 8 }}>
              💡 Tip: separate each post with a line of dashes <code>---</code> so the AI can distinguish them.
            </p>
            <textarea
              className="input-field"
              style={{ width: '100%', minHeight: 360, fontSize: 13, fontFamily: 'inherit', lineHeight: 1.6, resize: 'vertical' }}
              placeholder={`Paste your past posts here. Example:\n\nYesterday I had a meeting with a CFO...\n[your post 1]\n\n---\n\nIn 20 years selling B2B...\n[your post 2]\n\n---\n\n[etc]`}
              value={voiceSamples}
              onChange={e => setVoiceSamples(e.target.value)}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
              <button className="action-btn btn-primary" style={{ fontSize: 13 }} onClick={saveVoiceSamples}>
                {voiceSaved ? '✅ Saved' : '💾 Save voice samples'}
              </button>
              <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>
                {voiceSamples.trim() ? `✓ ${voiceSamples.length} chars loaded · used automatically in Writer` : '⚠️ Without samples, voice comes out generic'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============ LANDINGS HUB ============
// Prospect landings — generate personalized HTML for first-touch prospecting
// Output: copy HTML for Gmail OR public URL oike.app/p/{slug}

export default ContentLab;
