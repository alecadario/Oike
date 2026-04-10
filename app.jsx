    const { useState, useEffect, useCallback, useMemo } = React;

    // ============ AUTH & CLIENT CONFIG ============
    let AIRTABLE_BASE_ID = '';
    let TABLE_IDS = {};
    let CLIENT_CONFIG = {};
    let AUTH_TOKEN = localStorage.getItem('oike_token') || '';
    let CURRENT_USER = JSON.parse(localStorage.getItem('oike_user') || 'null');

    let BASE_ID = localStorage.getItem('oike_base_id') || '';

    function getAuthHeaders() {
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH_TOKEN}`,
      };
    }

    async function loginUser(email, password) {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Login failed' }));
        throw new Error(err.error || 'Invalid credentials');
      }
      const data = await res.json();
      AUTH_TOKEN = data.token;
      CURRENT_USER = data.user;
      localStorage.setItem('oike_token', data.token);
      localStorage.setItem('oike_user', JSON.stringify(data.user));
      // Set base ID from login response
      const loginBaseId = data.baseId || data.config?.baseId || '';
      BASE_ID = loginBaseId;
      AIRTABLE_BASE_ID = loginBaseId;
      localStorage.setItem('oike_base_id', loginBaseId);
      TABLE_IDS = data.config?.tables || {};
      CLIENT_CONFIG = data.config || {};
      console.log('LOGIN OK — baseId:', AIRTABLE_BASE_ID, 'tables:', TABLE_IDS);
      return data;
    }

    function logoutUser() {
      AUTH_TOKEN = '';
      CURRENT_USER = null;
      localStorage.removeItem('oike_token');
      localStorage.removeItem('oike_user');
      localStorage.removeItem('oike_base_id');
      window.location.reload();
    }

    async function loadClientConfig() {
      if (!BASE_ID || !AUTH_TOKEN) return null;
      try {
        const res = await fetch(`/api/config?baseId=${BASE_ID}`, {
          headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
        });
        if (!res.ok) throw new Error('Config load failed');
        const config = await res.json();
        AIRTABLE_BASE_ID = config.baseId;
        TABLE_IDS = config.tables;
        CLIENT_CONFIG = config;
        return config;
      } catch (e) {
        console.error('Failed to load client config:', e);
        return null;
      }
    }

    const channelIcon = { WhatsApp: '💬', Email: '✉️', LinkedIn: '🔗', Call: '📞' };

    // ============ COMPANY PROFILE (configurable per client) ============
    const COMPANY_PROFILE_KEY = 'oike_company_profile';
    let COMPANY_PROFILE = (() => {
      const defaults = {
        companyName: 'Your Company',
        services: 'digital transformation, AI, CX, data',
        market: 'your target market',
        senderName: 'Your Name',
        senderTitle: 'Business Consultant',
        goals: '',
        voiceTone: '',
        voiceAvoid: '',
        voiceExample: '',
      };
      try {
        const saved = localStorage.getItem(COMPANY_PROFILE_KEY);
        if (saved) return { ...defaults, ...JSON.parse(saved) };
      } catch (e) { /* ignore */ }
      return defaults;
    })();

    function saveCompanyProfile(profile) {
      COMPANY_PROFILE = { ...COMPANY_PROFILE, ...profile };
      localStorage.setItem(COMPANY_PROFILE_KEY, JSON.stringify(COMPANY_PROFILE));
    }

    // ============ AIRTABLE API (via backend proxy) ============
    class AirtableAPI {
      constructor(apiKeyOrNull) {
        this.proxyUrl = '/api/airtable';
      }

      async fetchTable(tableId) {
        let allRecords = [];
        let offset = null;
        do {
          const res = await fetch(this.proxyUrl, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ method: 'GET', baseId: AIRTABLE_BASE_ID, tableId, offset }),
          });
          if (!res.ok) {
            if (res.status === 401) { logoutUser(); return []; }
            const errData = await res.json().catch(() => ({}));
            console.warn(`Table ${tableId} returned ${res.status}`, errData);
            return allRecords;
          }
          const data = await res.json();
          allRecords = allRecords.concat(data.records || []);
          offset = data.offset;
        } while (offset);
        return allRecords;
      }

      async createRecord(tableId, fields) {
        const res = await fetch(this.proxyUrl, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ method: 'POST', baseId: AIRTABLE_BASE_ID, tableId, fields }),
        });
        if (res.status === 401) { logoutUser(); throw new Error('Session expired'); }
        if (!res.ok) throw new Error(`Create error: ${res.status}`);
        const data = await res.json();
        return data.records ? data.records[0] : data;
      }

      async updateRecord(tableId, recordId, fields) {
        const res = await fetch(this.proxyUrl, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ method: 'PATCH', baseId: AIRTABLE_BASE_ID, tableId, recordId, fields }),
        });
        if (res.status === 401) { logoutUser(); throw new Error('Session expired'); }
        if (!res.ok) {
          let errBody = '';
          try { const d = await res.json(); errBody = JSON.stringify(d); } catch {}
          throw new Error(`Update error: ${res.status} — ${errBody}`);
        }
        return await res.json();
      }

      async deleteRecord(tableId, recordId) {
        const res = await fetch(this.proxyUrl, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ method: 'DELETE', baseId: AIRTABLE_BASE_ID, tableId, recordId }),
        });
        if (res.status === 401) { logoutUser(); throw new Error('Session expired'); }
        if (!res.ok) throw new Error(`Delete error: ${res.status}`);
        return await res.json();
      }
    }

    // ============ OPENAI API (via backend proxy) ============
    async function callOpenAI({ prompt, temperature = 0.7, max_tokens = 700 }) {
      const res = await fetch('/api/openai', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], temperature, max_tokens }),
      });
      if (res.status === 401) { logoutUser(); throw new Error('Session expired'); }
      if (!res.ok) throw new Error('OpenAI API error');
      const data = await res.json();
      return data.content || '';
    }

    // Intercept direct OpenAI calls — redirect to backend proxy transparently
    const _originalFetch = window.fetch;
    window.fetch = function(url, options) {
      if (typeof url === 'string' && url.includes('api.openai.com')) {
        const body = JSON.parse(options?.body || '{}');
        return _originalFetch('/api/openai', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            messages: body.messages,
            model: body.model || 'gpt-4o',
            temperature: body.temperature || 0.7,
            max_tokens: body.max_tokens || 700,
          }),
        }).then(async (res) => {
          if (res.status === 401) { logoutUser(); return new Response('{}', { status: 401 }); }
          const data = await res.json();
          return new Response(JSON.stringify({
            choices: [{ message: { content: data.content || '' } }],
            usage: data.usage,
          }), { status: res.status, headers: { 'Content-Type': 'application/json' } });
        });
      }
      return _originalFetch.apply(this, arguments);
    };

    // Make openaiKey checks pass (key is server-side now)
    if (!localStorage.getItem('openai_key')) {
      localStorage.setItem('openai_key', 'managed-by-backend');
    }

    // ============ HELPERS ============
    const F = (record, fieldName) => {
      const val = record?.fields?.[fieldName];
      if (!val) return '';
      // Handle aiText objects with .value property
      if (typeof val === 'object' && val.value !== undefined) return val.value;
      // Handle singleSelect objects with .name property
      if (typeof val === 'object' && !Array.isArray(val) && val.name) return val.name;
      // Handle arrays of objects (multipleSelects, linked records)
      if (Array.isArray(val)) {
        return val.map(v => typeof v === 'object' ? (v.name || v.id || v) : v);
      }
      return val;
    };

    const linkedIds = (record, fieldName) => {
      const val = record?.fields?.[fieldName];
      if (!val || !Array.isArray(val)) return [];
      return val.map(v => typeof v === 'object' ? (v.id || v) : v);
    };

    const resolveLinked = (record, fieldName, lookupArr, nameField) => {
      const ids = linkedIds(record, fieldName);
      if (!ids.length || !lookupArr) return [];
      return ids.map(id => {
        const found = lookupArr.find(r => r.id === id);
        return found ? (F(found, nameField) || id) : id;
      });
    };

    // Auto-activate account when outreach is logged
    const activateAccountIfNeeded = async (apiInstance, accountIds, allAccounts) => {
      if (!apiInstance || !accountIds || !accountIds.length || !allAccounts) return;
      try {
        for (const aid of accountIds) {
          const acc = allAccounts.find(a => a.id === aid);
          if (!acc) continue;
          const currentStatus = F(acc, 'Inside Sales Status');
          if (!currentStatus || currentStatus === 'No Status' || currentStatus === 'Inactive' || currentStatus === 'New') {
            await apiInstance.updateRecord(TABLE_IDS.accounts, aid, { 'Inside Sales Status': 'Active' });
          }
        }
      } catch (e) { console.warn('Auto-activate account failed:', e); }
    };

    const formatCurrency = (val) => {
      if (!val) return '$0';
      return '$' + Number(val).toLocaleString('en-US');
    };

    const formatDate = (val) => {
      if (!val) return '';
      return new Date(val).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    };

    // ============ FUZZY STRING SIMILARITY (bigram-based) ============
    const strSimilarity = (a, b) => {
      if (!a || !b) return 0;
      a = a.toLowerCase().trim(); b = b.toLowerCase().trim();
      if (a === b) return 1;
      if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
      const bigrams = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const bg = s.slice(i, i+2); m.set(bg, (m.get(bg)||0)+1); } return m; };
      const aB = bigrams(a), bB = bigrams(b);
      let inter = 0;
      aB.forEach((c, k) => { inter += Math.min(c, bB.get(k)||0); });
      return (2 * inter) / (a.length + b.length - 2);
    };

    // ============ STAKEHOLDER HISTORY MODAL ============
    function StakeholderHistoryModal({ stakeholder, outreach, accounts, onClose, onRefresh, allData }) {
      if (!stakeholder) return null;
      const [genLoading, setGenLoading] = useState(''); // 'pain' | 'linkedin' | ''
      const PAIN_TS_LS_KEY = 'oike_pain_timestamps';
      const [localPain, setLocalPain] = useState(F(stakeholder, 'Pain Points (Generated)') || F(stakeholder, 'Pain points') || '');
      const [localPainTs, setLocalPainTs] = useState(() => {
        try { return JSON.parse(localStorage.getItem(PAIN_TS_LS_KEY) || '{}')[stakeholder.id] || null; } catch { return null; }
      });
      const [localLinkedin, setLocalLinkedin] = useState(F(stakeholder, 'LinkedIn News (Generated)') || F(stakeholder, 'Linkedin lates news') || '');
      const [quickAction, setQuickAction] = useState(''); // 'bounced' | 'reply' | 'meeting' | 'notinterested' | ''
      const [quickNote, setQuickNote] = useState('');
      const [savingQuick, setSavingQuick] = useState(false);
      const [quickMsg, setQuickMsg] = useState('');
      const [quickMsgChannel, setQuickMsgChannel] = useState('LinkedIn');
      const [sendingQuickMsg, setSendingQuickMsg] = useState(false);

      const sName = F(stakeholder, 'Name') + (F(stakeholder, 'Lart name') ? ` ${F(stakeholder, 'Lart name')}` : '');
      const accNames = resolveLinked(stakeholder, 'Account', accounts, 'Account Name');
      const role = F(stakeholder, 'Role');
      const sOutreach = outreach.filter(o => linkedIds(o, 'Stakeholder').includes(stakeholder.id))
        .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));

      const accountIds = linkedIds(stakeholder, 'Account');
      const account = accounts.find(a => accountIds.includes(a.id));
      const accountName = account ? F(account, 'Account Name') : '';
      const industry = account ? F(account, 'Industry') : '';
      const serviceFocus = account ? F(account, 'Service / Focus') : '';
      const focusText = Array.isArray(serviceFocus) ? serviceFocus.join(', ') : serviceFocus;
      const recentNews = account ? (F(account, 'Recent News') || '') : '';
      const newsText = typeof recentNews === 'string' ? recentNews.slice(0, 300) : '';

      // Pain Points: GPT-4o generated (analysis-based)
      const generatePainPoints = async () => {
        setGenLoading('pain');
        try {
          const prompt = `You are a B2B sales research analyst. Analyze this stakeholder and identify their likely pain points.

STAKEHOLDER: ${sName}
ROLE: ${role}
COMPANY: ${accountName}
INDUSTRY: ${industry}
SERVICE FOCUS: ${focusText || 'Not defined'}
RECENT COMPANY NEWS: ${newsText || 'Not available'}

Generate 3-5 specific, actionable pain points for this person based on their role and industry context. Each pain point should:
- Be specific to their role (not generic)
- Reference industry challenges they likely face
- Connect to areas where ${COMPANY_PROFILE.companyName} (${COMPANY_PROFILE.services}) could help

Format as bullet points. Be concise (1-2 sentences each). Write ONLY the pain points, no intro or summary.`;

          const generated = await callOpenAI({ prompt, temperature: 0.7, max_tokens: 400 });
          // Show result immediately — save to Airtable in background (graceful fail)
          setLocalPain(generated);
          const painTs = new Date().toISOString();
          setLocalPainTs(painTs);
          try {
            const painTsMap = JSON.parse(localStorage.getItem(PAIN_TS_LS_KEY) || '{}');
            painTsMap[stakeholder.id] = painTs;
            localStorage.setItem(PAIN_TS_LS_KEY, JSON.stringify(painTsMap));
          } catch {}
          if (!stakeholder.id.startsWith('tmp_')) {
            const a = new AirtableAPI();
            a.updateRecord(TABLE_IDS.stakeholders, stakeholder.id, { 'Pain Points (Generated)': generated })
              .catch(e => console.warn('Could not persist pain points to Airtable:', e.message));
          }
        } catch (e) {
          console.error(e);
          alert('Failed to generate. Error: ' + (e.message || 'unknown error'));
        }
        setGenLoading('');
      };

      // LinkedIn Insights: Triggers Airtable AI (real LinkedIn data)
      const refreshLinkedIn = async () => {
        const atKey = localStorage?.getItem?.('at_key');
        setGenLoading('linkedin');
        try {
          const a = new AirtableAPI();
          // Step 1: Update trigger field to fire Airtable Automation
          const triggerTime = new Date().toISOString();
          console.log('[LinkedIn] Step 1: Updating AI Refresh Trigger to', triggerTime);
          await a.updateRecord(TABLE_IDS.stakeholders, stakeholder.id, {
            'AI Refresh Trigger': triggerTime
          });

          // Step 2: Wait for Airtable Automation + AI to regenerate
          setGenLoading('linkedin-wait');
          console.log('[LinkedIn] Step 2: Waiting 20s for Airtable AI...');
          await new Promise(r => setTimeout(r, 20000));

          // Step 3: Re-fetch the record to get fresh aiText
          console.log('[LinkedIn] Step 3: Re-fetching record...');
          const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${TABLE_IDS.stakeholders}/${stakeholder.id}`;
          const res = await fetch(url, { headers: { Authorization: `Bearer ${atKey}` } });
          if (!res.ok) throw new Error('Failed to fetch updated record');
          const record = await res.json();

          // Debug: log the raw field value
          const rawVal = record?.fields?.['Linkedin lates news'];
          console.log('[LinkedIn] Raw field value:', JSON.stringify(rawVal));
          console.log('[LinkedIn] Field state:', rawVal?.state, 'isAiText:', typeof rawVal === 'object' && rawVal?.value !== undefined);

          // Handle aiText: could be {value: "...", state: "generated"} or just a string
          let freshText = '';
          if (rawVal && typeof rawVal === 'object' && rawVal.value) {
            freshText = rawVal.value;
          } else if (typeof rawVal === 'string') {
            freshText = rawVal;
          }

          if (freshText) {
            setLocalLinkedin(freshText);
            console.log('[LinkedIn] Success! Got', freshText.length, 'chars');
          } else {
            // Maybe AI is still generating — try again after 10 more seconds
            console.log('[LinkedIn] No value yet, retrying in 10s...');
            setGenLoading('linkedin-retry');
            await new Promise(r => setTimeout(r, 10000));
            const res2 = await fetch(url, { headers: { Authorization: `Bearer ${atKey}` } });
            const record2 = await res2.json();
            const rawVal2 = record2?.fields?.['Linkedin lates news'];
            console.log('[LinkedIn] Retry raw value:', JSON.stringify(rawVal2));
            const text2 = rawVal2?.value || (typeof rawVal2 === 'string' ? rawVal2 : '');
            if (text2) {
              setLocalLinkedin(text2);
            } else {
              alert('LinkedIn AI is still generating. Wait a moment and try Refresh Data, then open the contact again.');
            }
          }
        } catch (e) {
          console.error('[LinkedIn] Error:', e);
          alert('Failed to refresh LinkedIn data. Check console for details.');
        }
        setGenLoading('');
      };

      const statusColor = { 'Replied': '#4ade80', 'Meeting Scheduled': '#60a5fa', 'Sent': '#fbbf24', 'Pending': '#a78bfa' };
      const painText = typeof localPain === 'string' ? localPain : String(localPain || '');
      const linkedinText = typeof localLinkedin === 'string' ? localLinkedin : String(localLinkedin || '');

      return (
        <div className="modal-overlay" onClick={onClose}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 640, maxHeight: '85vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 18 }}>{sName}</h3>
                <div style={{ fontSize: 12, color: 'var(--globant-muted)', marginTop: 4 }}>
                  {role}{accNames.length ? ` · ${accNames.join(', ')}` : ''}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  {F(stakeholder, 'Email') && <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>✉️ {F(stakeholder, 'Email')}</span>}
                  {F(stakeholder, 'Phone number') && <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>📞 {F(stakeholder, 'Phone number')}</span>}
                  {F(stakeholder, 'Level of Influence') && <span className="badge badge-accent" style={{ fontSize: 10 }}>{F(stakeholder, 'Level of Influence')}</span>}
                </div>
              </div>
              <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 18, padding: 4 }}>✕</button>
            </div>

            {/* Pain Points */}
            <div style={{ padding: '10px 12px', background: 'rgba(191,215,48,0.06)', borderRadius: 8, marginBottom: 10, borderLeft: '3px solid var(--globant-green)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-green)' }}>PAIN POINTS</span>
                  {localPainTs && (
                    <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 1 }}>
                      Last updated: {new Date(localPainTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  )}
                </div>
                <button className="action-btn btn-primary" style={{ fontSize: 10, padding: '3px 10px' }}
                  onClick={generatePainPoints} disabled={genLoading === 'pain'}>
                  {genLoading === 'pain' ? '⏳ Generating...' : painText ? '🔄 Regenerate' : '✨ Generate with AI'}
                </button>
              </div>
              {painText ? (
                <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--globant-text)', whiteSpace: 'pre-wrap' }}>{painText.slice(0, 500)}</div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>No pain points yet — click Generate to create with AI</div>
              )}
            </div>

            {/* LinkedIn News */}
            <div style={{ padding: '10px 12px', background: 'rgba(10,102,194,0.06)', borderRadius: 8, marginBottom: 16, borderLeft: '3px solid #0A66C2' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#0A66C2' }}>LINKEDIN INSIGHTS</span>
                <button className="action-btn" style={{ fontSize: 10, padding: '3px 10px', background: 'rgba(10,102,194,0.15)', color: '#0A66C2', border: '1px solid rgba(10,102,194,0.3)' }}
                  onClick={refreshLinkedIn} disabled={genLoading === 'linkedin' || genLoading === 'linkedin-wait'}>
                  {genLoading === 'linkedin' ? '⏳ Triggering...' : genLoading === 'linkedin-wait' ? '⏳ Waiting for Airtable AI (~10s)...' : linkedinText ? '🔄 Refresh from Airtable' : '🔗 Get LinkedIn Insights'}
                </button>
              </div>
              {linkedinText ? (
                <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--globant-text)', whiteSpace: 'pre-wrap' }}>{linkedinText.slice(0, 500)}</div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>No LinkedIn insights yet — click Generate to create with AI</div>
              )}
            </div>

            {/* Stats row */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              <div style={{ flex: 1, padding: '10px 14px', background: 'var(--globant-darker)', borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--globant-green)' }}>{sOutreach.length}</div>
                <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>Total Interactions</div>
              </div>
              <div style={{ flex: 1, padding: '10px 14px', background: 'var(--globant-darker)', borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#4ade80' }}>{sOutreach.filter(o => F(o, 'Status') === 'Replied').length}</div>
                <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>Replies</div>
              </div>
              <div style={{ flex: 1, padding: '10px 14px', background: 'var(--globant-darker)', borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#60a5fa' }}>{sOutreach.filter(o => F(o, 'Status') === 'Meeting Scheduled').length}</div>
                <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>Meetings</div>
              </div>
              <div style={{ flex: 1, padding: '10px 14px', background: 'var(--globant-darker)', borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--globant-text)' }}>
                  {sOutreach.length > 0 ? `${Math.floor((new Date() - new Date(sOutreach[0].fields?.['Date'])) / (1000*60*60*24))}d` : '—'}
                </div>
                <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>Last Touch</div>
              </div>
            </div>

            {/* Manual Quick Message */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--globant-text)' }}>✍️ Quick Message</div>
              <textarea className="input-field" style={{ width: '100%', minHeight: 70, resize: 'vertical', fontFamily: 'inherit', fontSize: 12, marginBottom: 8 }}
                placeholder="Write your message here... it will be copied, logged, and the channel opened." value={quickMsg} onChange={e => setQuickMsg(e.target.value)} />
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {['LinkedIn', 'WhatsApp', 'Email'].map(ch => (
                  <button key={ch} style={{ fontSize: 11, padding: '5px 12px', borderRadius: 8, cursor: 'pointer',
                    background: quickMsgChannel === ch ? 'rgba(191,215,48,0.2)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${quickMsgChannel === ch ? 'var(--globant-green)' : 'rgba(255,255,255,0.08)'}`,
                    color: quickMsgChannel === ch ? 'var(--globant-green)' : 'var(--globant-text)',
                    fontWeight: quickMsgChannel === ch ? 700 : 400,
                  }} onClick={() => setQuickMsgChannel(ch)}>
                    {ch === 'LinkedIn' ? '🔗' : ch === 'WhatsApp' ? '💬' : '✉️'} {ch}
                  </button>
                ))}
                <button className="action-btn btn-primary" style={{ fontSize: 11, marginLeft: 'auto' }}
                  disabled={!quickMsg.trim() || sendingQuickMsg}
                  onClick={async () => {
                    if (!quickMsg.trim()) return;
                    setSendingQuickMsg(true);
                    const name = F(stakeholder, 'Name') || '';
                    const email = F(stakeholder, 'Email') || '';
                    const phone = F(stakeholder, 'Phone number') || '';
                    const linkedin = F(stakeholder, 'LinkedIn') || '';
                    try { await navigator.clipboard.writeText(quickMsg); } catch(e) {}
                    if (quickMsgChannel === 'LinkedIn' && linkedin) window.open(linkedin, '_blank');
                    else if (quickMsgChannel === 'WhatsApp' && phone) window.open(`https://wa.me/${String(phone).replace(/[^0-9+]/g, '')}?text=${encodeURIComponent(quickMsg)}`, '_blank');
                    else if (quickMsgChannel === 'Email' && email) window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&body=${encodeURIComponent(quickMsg)}`, '_blank');
                    try {
                      const a = new AirtableAPI();
                      await a.createRecord(TABLE_IDS.outreach, {
                        'Activity Name': `${quickMsgChannel} to ${name} — ${new Date().toLocaleDateString('en-US')}`,
                        'Account': accountIds, 'Stakeholder': [stakeholder.id],
                        'Channel': quickMsgChannel, 'Date': new Date().toISOString(),
                        'Status': 'Sent', 'Message': quickMsg,
                        'Notes': 'Sent via Quick Message',
                        'Logged By': CURRENT_USER?.name || '',
                        'BDR Owner': CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '',
                        'CP Assigned': CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '',
                      });
                      if (onRefresh) onRefresh();
                    } catch (e) { console.error('Quick message log failed:', e); }
                    setQuickMsg('');
                    setSendingQuickMsg(false);
                  }}>
                  {sendingQuickMsg ? '⏳ Sending...' : '🚀 Send & Log'}
                </button>
              </div>
            </div>

            {/* Quick Actions */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--globant-text)' }}>Quick Log</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: quickAction ? 10 : 0 }}>
                {[
                  { key: 'bounced', label: '📭 Bounced Mail', color: '#f87171', status: 'Bounced' },
                  { key: 'reply', label: '💬 Reply Received', color: '#4ade80', status: 'Replied' },
                  { key: 'meeting', label: '📅 Meeting Booked', color: '#60a5fa', status: 'Meeting Scheduled' },
                  { key: 'notinterested', label: '🚫 Not Interested', color: '#fbbf24', status: 'Not Interested' },
                ].map(act => (
                  <button key={act.key}
                    style={{ fontSize: 11, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                      background: quickAction === act.key ? act.color + '25' : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${quickAction === act.key ? act.color : 'rgba(255,255,255,0.08)'}`,
                      color: quickAction === act.key ? act.color : 'var(--globant-text)',
                      fontWeight: quickAction === act.key ? 700 : 400,
                    }}
                    onClick={() => { setQuickAction(quickAction === act.key ? '' : act.key); setQuickNote(''); }}>
                    {act.label}
                  </button>
                ))}
              </div>
              {quickAction && (() => {
                const actions = {
                  bounced: { status: 'Bounced', label: 'Bounced Mail', hasNote: false },
                  reply: { status: 'Replied', label: 'Reply Received', hasNote: true, notePlaceholder: 'What did they say? Key takeaways...' },
                  meeting: { status: 'Meeting Scheduled', label: 'Meeting Booked', hasNote: true, notePlaceholder: 'Meeting date, topic, attendees...' },
                  notinterested: { status: 'Not Interested', label: 'Not Interested', hasNote: true, notePlaceholder: 'Reason — timing, budget, wrong contact...' },
                };
                const act = actions[quickAction];
                return (
                  <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
                    {act.hasNote && (
                      <textarea className="input-field" style={{ width: '100%', minHeight: 50, resize: 'vertical', fontFamily: 'inherit', fontSize: 12, marginBottom: 8 }}
                        placeholder={act.notePlaceholder} value={quickNote} onChange={e => setQuickNote(e.target.value)} />
                    )}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="action-btn btn-primary" style={{ fontSize: 11 }}
                        disabled={savingQuick}
                        onClick={async () => {
                          setSavingQuick(true);
                          try {
                            const a = new AirtableAPI();
                            await a.createRecord(TABLE_IDS.outreach, {
                              'Activity Name': `${act.label} — ${sName} — ${new Date().toLocaleDateString('en-US')}`,
                              'Account': accountIds,
                              'Stakeholder': [stakeholder.id],
                              'Channel': 'Email',
                              'Date': new Date().toISOString(),
                              'Status': act.status,
                              ...(quickNote ? { 'Notes': quickNote } : {}),
                              'Logged By': CURRENT_USER?.name || '',
                              'BDR Owner': CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '',
                              'CP Assigned': CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '',
                            });
                            await activateAccountIfNeeded(a, accountIds, accounts);
                            setQuickAction('');
                            setQuickNote('');
                            if (onRefresh) onRefresh();
                          } catch (e) {
                            console.error(e);
                            alert('Failed to log activity');
                          }
                          setSavingQuick(false);
                        }}>
                        {savingQuick ? '⏳ Saving...' : `✅ Log ${act.label}`}
                      </button>
                      <button className="action-btn btn-ghost" style={{ fontSize: 11 }}
                        onClick={() => { setQuickAction(''); setQuickNote(''); }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Interaction timeline */}
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: 'var(--globant-text)' }}>Interaction History</div>
            {sOutreach.length === 0 ? (
              <p style={{ color: 'var(--globant-muted)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>No interactions logged yet</p>
            ) : (
              <div style={{ position: 'relative', paddingLeft: 20 }}>
                {/* Timeline line */}
                <div style={{ position: 'absolute', left: 7, top: 8, bottom: 8, width: 2, background: 'var(--globant-border)' }} />
                {sOutreach.map((o, i) => {
                  const channel = F(o, 'Channel');
                  const status = F(o, 'Status');
                  const message = F(o, 'Message');
                  const notes = F(o, 'Notes');
                  const dotColor = statusColor[status] || 'var(--globant-muted)';
                  return (
                    <div key={o.id || i} style={{ position: 'relative', marginBottom: 12, paddingBottom: 12, borderBottom: i < sOutreach.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                      {/* Timeline dot */}
                      <div style={{ position: 'absolute', left: -16, top: 6, width: 10, height: 10, borderRadius: '50%', background: dotColor, border: '2px solid var(--globant-dark)' }} />
                      {/* Header */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontSize: 14 }}>{channelIcon[channel] || '📋'}</span>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>{F(o, 'Activity Name') || channel || 'Activity'}</span>
                          {status && <span className={`badge ${status === 'Replied' ? 'badge-green' : status === 'Meeting Scheduled' ? 'badge-blue' : 'badge-yellow'}`} style={{ fontSize: 9 }}>{status}</span>}
                        </div>
                        <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>{formatDate(o.fields?.['Date'])}</span>
                      </div>
                      {/* Message content */}
                      {message && (
                        <div style={{ fontSize: 12, color: 'var(--globant-text)', lineHeight: 1.5, padding: '6px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 6, marginTop: 4, whiteSpace: 'pre-wrap' }}>
                          {message.length > 300 ? message.slice(0, 300) + '...' : message}
                        </div>
                      )}
                      {notes && (
                        <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 4, fontStyle: 'italic' }}>
                          📝 {notes.length > 200 ? notes.slice(0, 200) + '...' : notes}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      );
    }

    // ============ CONFIG SCREEN ============
    function ConfigScreen({ onConnect }) {
      const [key, setKey] = useState(localStorage?.getItem?.('at_key') || '');
      const [error, setError] = useState('');
      const [loading, setLoading] = useState(false);

      const handleConnect = async () => {
        if (!key.trim()) return;
        setLoading(true);
        setError('');
        try {
          const api = new AirtableAPI(key.trim());
          await api.fetchTable(TABLE_IDS.accounts);
          try { localStorage.setItem('at_key', key.trim()); } catch(e) {}
          onConnect(key.trim());
        } catch (e) {
          setError('Could not connect. Check your API key.');
        }
        setLoading(false);
      };

      return (
        <div className="config-screen">
          <div className="config-box">
            <div className="logo-big">G</div>
            <h2 style={{ marginBottom: 8 }}>Sales Intelligence Hub</h2>
            <p style={{ color: 'var(--globant-muted)', fontSize: 13, marginBottom: 24 }}>
              Connect your Airtable to get started
            </p>
            <input
              className="input-field"
              type="password"
              placeholder="Paste your Airtable Personal Access Token"
              value={key}
              onChange={e => setKey(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleConnect()}
              style={{ marginBottom: 12 }}
            />
            {error && <p style={{ color: 'var(--globant-danger)', fontSize: 12, marginBottom: 12 }}>{error}</p>}
            <button className="action-btn btn-primary" style={{ width: '100%', padding: '12px', fontSize: 14 }} onClick={handleConnect} disabled={loading}>
              {loading ? 'Connecting...' : 'Connect'}
            </button>
            <p style={{ color: 'var(--globant-muted)', fontSize: 11, marginTop: 16 }}>
              Your key stays in your browser. Get one at airtable.com/create/tokens
            </p>
          </div>
        </div>
      );
    }

    // ============ STRATEGY OVERVIEW ============
    function StrategyOverview({ data }) {
      const { accounts, stakeholders, opportunities, outreach, solutions, events } = data;

      // Executive KPIs
      const mappedAccounts = accounts.filter(a => linkedIds(a, 'Stakeholders').length > 0);
      const unmappedAccounts = accounts.filter(a => linkedIds(a, 'Stakeholders').length === 0);
      const accountsWithSolutions = accounts.filter(a => linkedIds(a, 'Solutions').length > 0);
      const contactedStakeholderIds = new Set();
      outreach.forEach(o => linkedIds(o, 'Stakeholder').forEach(id => contactedStakeholderIds.add(id)));
      const contactedStakeholders = stakeholders.filter(s => contactedStakeholderIds.has(s.id));
      const pendingStakeholders = stakeholders.filter(s => !contactedStakeholderIds.has(s.id));

      const closedStages = ['Closed Won', 'Closed Lost', 'Closed/Won', 'Closed/Lost', 'Closed/Canceled', 'Cierre ganado', 'Cierre perdido'];
      const activeOpps = opportunities.filter(o => !closedStages.includes(F(o, 'Stage')));
      const activePipeline = activeOpps.reduce((sum, o) => sum + (o.fields?.['Value'] || 0), 0);
      const wonOpps = opportunities.filter(o => ['Closed Won', 'Closed/Won', 'Cierre ganado'].includes(F(o, 'Stage')));

      const today = new Date().toISOString().slice(0, 10);
      const upcomingEvents = (events || []).filter(e => {
        const start = e.fields?.['Starting'];
        return start && start >= today;
      }).sort((a, b) => (a.fields?.['Starting'] || '').localeCompare(b.fields?.['Starting'] || ''));

      // Status breakdown
      const statusCounts = {};
      accounts.forEach(a => {
        const s = F(a, 'Inside Sales Status') || 'No Status';
        statusCounts[s] = (statusCounts[s] || 0) + 1;
      });

      // Top accounts by stakeholder count (mapped ones)
      const topAccounts = [...mappedAccounts].sort((a, b) =>
        linkedIds(b, 'Stakeholders').length - linkedIds(a, 'Stakeholders').length
      ).slice(0, 10);

      // ── Conversion Funnel ──
      const repliedIds = new Set(outreach.filter(o => F(o, 'Status') === 'Replied').flatMap(o => linkedIds(o, 'Stakeholder')));
      const meetingIds = new Set(outreach.filter(o => ['Meeting Scheduled','Meeting Booked'].includes(F(o, 'Status'))).flatMap(o => linkedIds(o, 'Account')));
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

      // ── Weighted Forecast ──
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

      // ── Activity Heatmap (last 28 days) ──
      const heatmapDays = 28;
      const heatmapData = {};
      const heatmapStart = new Date(); heatmapStart.setDate(heatmapStart.getDate() - heatmapDays);
      outreach.forEach(o => {
        const d = o.fields?.['Date'] ? new Date(o.fields['Date']).toISOString().slice(0,10) : null;
        if (d && d >= heatmapStart.toISOString().slice(0,10)) heatmapData[d] = (heatmapData[d] || 0) + 1;
      });
      const heatmapDaysList = Array.from({ length: heatmapDays }, (_, i) => {
        const d = new Date(); d.setDate(d.getDate() - (heatmapDays - 1 - i));
        const key = d.toISOString().slice(0,10);
        return { key, count: heatmapData[key] || 0, label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) };
      });
      const heatmapMax = Math.max(...heatmapDaysList.map(d => d.count), 1);

      // ── Top 3 Focus Accounts ──
      const now2 = new Date();
      const focusAccounts = mappedAccounts.map(a => {
        const stIds = linkedIds(a, 'Stakeholders');
        const accOut = outreach.filter(o => linkedIds(o, 'Account').includes(a.id));
        const lastOut = accOut.sort((x,y) => new Date(y.fields?.['Date']||0) - new Date(x.fields?.['Date']||0))[0];
        const daysSince = lastOut ? Math.floor((now2 - new Date(lastOut.fields?.['Date'])) / 86400000) : 999;
        const hasReply = accOut.some(o => F(o, 'Status') === 'Replied');
        const hasMeeting = accOut.some(o => ['Meeting Scheduled','Meeting Booked'].includes(F(o,'Status')));
        const openOppCount = activeOpps.filter(o => linkedIds(o,'Account').includes(a.id)).length;
        const hasNews = !!(F(a,'Recent News'));
        let score = 0;
        if (openOppCount > 0) score += 30;
        if (daysSince > 14 && daysSince < 60) score += 20;
        if (hasReply && !hasMeeting) score += 15;
        if (hasNews) score += 10;
        if (daysSince > 60) score += 5;
        if (hasMeeting) score -= 10;
        const reason = openOppCount > 0 ? `${openOppCount} open opp${openOppCount>1?'s':''}` : hasReply ? 'Replied — no meeting yet' : daysSince > 14 ? `${daysSince}d without contact` : 'High potential';
        return { a, score, daysSince, reason, openOppCount, hasReply, hasMeeting };
      }).sort((a,b) => b.score - a.score).slice(0, 3);

      return (
        <div>
          <div className="page-header">
            <h1>Inside Sales Dashboard</h1>
            <p>Executive overview of your sales operation</p>
          </div>

          {/* Row 1: Core KPIs */}
          <div className="kpi-row" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
            <div className="kpi-card">
              <div className="kpi-label">Accounts Mapped</div>
              <div className="kpi-value">{mappedAccounts.length}</div>
              <div className="kpi-sub">of {accounts.length} total</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">With Solutions</div>
              <div className="kpi-value">{accountsWithSolutions.length}</div>
              <div className="kpi-sub">solution assigned</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Contacted</div>
              <div className="kpi-value" style={{ color: contactedStakeholders.length > 0 ? 'var(--globant-success)' : 'var(--globant-warning)' }}>{contactedStakeholders.length}</div>
              <div className="kpi-sub">of {stakeholders.length} stakeholders</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Active Pipeline</div>
              <div className="kpi-value" style={{ fontSize: activePipeline > 999999999 ? 20 : 28 }}>{formatCurrency(activePipeline)}</div>
              <div className="kpi-sub">{activeOpps.length} open opps</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Won Deals</div>
              <div className="kpi-value" style={{ color: 'var(--globant-success)' }}>{wonOpps.length}</div>
              <div className="kpi-sub">{formatCurrency(wonOpps.reduce((s, o) => s + (o.fields?.['Value'] || 0), 0))}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Outreach Logged</div>
              <div className="kpi-value">{outreach.length}</div>
              <div className="kpi-sub">activities</div>
            </div>
          </div>

          {/* ── Conversion Funnel + Weighted Forecast ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

            {/* Funnel */}
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
              <div style={{ marginTop: 10, fontSize: 11, color: 'var(--globant-muted)' }}>
                % = conversion from previous stage
              </div>
            </div>

            {/* Weighted Forecast */}
            <div className="card">
              <div className="card-header">
                <h3>📊 Weighted Pipeline Forecast</h3>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--globant-green)' }}>{formatCurrency(totalWeighted)}</span>
              </div>
              {forecastStages.length === 0 ? (
                <p style={{ color: 'var(--globant-muted)', fontSize: 12 }}>No active opportunities</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {forecastStages.map(([stage, data]) => {
                    const prob = Math.round((data.prob || 0) * 100);
                    const stageColor = prob >= 70 ? '#4ade80' : prob >= 40 ? '#f59e0b' : '#60a5fa';
                    return (
                      <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 90, fontSize: 11, color: 'var(--globant-muted)', flexShrink: 0 }}>{stage}</div>
                        <div style={{ flex: 1, height: 18, background: 'var(--globant-darker)', borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${prob}%`, background: stageColor, opacity: 0.7, borderRadius: 4 }} />
                        </div>
                        <span style={{ fontSize: 10, color: stageColor, fontWeight: 700, width: 32, textAlign: 'right' }}>{prob}%</span>
                        <span style={{ fontSize: 11, color: 'var(--globant-text)', width: 60, textAlign: 'right' }}>{formatCurrency(data.raw)}</span>
                        <span style={{ fontSize: 11, color: 'var(--globant-green)', width: 60, textAlign: 'right', fontWeight: 600 }}>→ {formatCurrency(data.weighted)}</span>
                        <span style={{ fontSize: 10, color: 'var(--globant-muted)', width: 20, textAlign: 'center' }}>{data.count}</span>
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

          {/* ── Activity Heatmap + Top Focus Accounts ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

            {/* Heatmap */}
            <div className="card">
              <div className="card-header">
                <h3>🔥 Activity Heatmap <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--globant-muted)' }}>last 28 days</span></h3>
                <span style={{ fontSize: 12, color: 'var(--globant-muted)' }}>{Object.values(heatmapData).reduce((s,v)=>s+v,0)} touches</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(28, 1fr)', gap: 3 }}>
                {heatmapDaysList.map(day => {
                  const intensity = day.count === 0 ? 0 : Math.min(1, day.count / heatmapMax);
                  const bg = day.count === 0 ? 'var(--globant-darker)' : `rgba(191,215,48,${0.15 + intensity * 0.85})`;
                  return (
                    <div key={day.key} title={`${day.label}: ${day.count} activities`}
                      style={{ aspectRatio: '1', borderRadius: 3, background: bg, cursor: 'default', transition: 'transform 0.1s' }}
                      onMouseEnter={e => e.target.style.transform='scale(1.3)'}
                      onMouseLeave={e => e.target.style.transform='scale(1)'}
                    />
                  );
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 10, color: 'var(--globant-muted)' }}>
                <span>{heatmapDaysList[0]?.label}</span>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span>Less</span>
                  {[0.1,0.3,0.6,1].map(v => <div key={v} style={{ width: 10, height: 10, borderRadius: 2, background: `rgba(191,215,48,${v})` }} />)}
                  <span>More</span>
                </div>
                <span>Today</span>
              </div>
            </div>

            {/* Top 3 Focus Accounts */}
            <div className="card">
              <div className="card-header"><h3>🎯 Focus Now <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--globant-muted)' }}>top 3 accounts to act on today</span></h3></div>
              {focusAccounts.length === 0 ? (
                <p style={{ color: 'var(--globant-muted)', fontSize: 12 }}>Add accounts to see recommendations</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {focusAccounts.map(({ a, daysSince, reason, openOppCount, hasReply, hasMeeting }, i) => {
                    const medals = ['🥇','🥈','🥉'];
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
                        <div style={{ fontSize: 20 }}>
                          {openOppCount > 0 ? '💰' : hasMeeting ? '📅' : hasReply ? '💬' : '📬'}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Row 2: Status breakdown + Upcoming Events side by side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            {/* Account Status */}
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

            {/* Upcoming Events */}
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
                      <div className="log-meta">
                        {formatDate(start)}{end && end !== start ? ` — ${formatDate(end)}` : ''} · {invitedCount} stakeholders invited
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Row 3: Top Mapped Accounts table */}
          <div className="card">
            <div className="card-header"><h3>Top Mapped Accounts</h3></div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Industry</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'center' }}>Stakeholders</th>
                  <th style={{ textAlign: 'center' }}>Contacted</th>
                  <th style={{ textAlign: 'center' }}>Opps</th>
                  <th>Solutions</th>
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
                        <span style={{ color: contactedCount > 0 ? 'var(--globant-success)' : 'var(--globant-warning)' }}>
                          {contactedCount}/{stIds.length}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center' }}>{oppCount}</td>
                      <td style={{ fontSize: 11 }}>{solNames.length > 0 ? solNames.join(', ') : <span style={{ color: 'var(--globant-muted)' }}>—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Row 4: Active Pipeline */}
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
    function AIMessageModal({ stakeholder, onClose, onSend, data }) {
      const [tab, setTab] = useState('first');
      const [generatedMessages, setGeneratedMessages] = useState({ first: '', followup2: '', followup3: '' });
      const [loadingAI, setLoadingAI] = useState(false);
      const [selectedChannel, setSelectedChannel] = useState('');
      const [savingDraft, setSavingDraft] = useState(false);
      const [extraContext, setExtraContext] = useState('');
      const [ccPartner, setCcPartner] = useState(true);
      const [selectedEventId, setSelectedEventId] = useState('');
      const [eventMode, setEventMode] = useState('invite'); // 'invite' | 'followup'
      const [selectedSolutionId, setSelectedSolutionId] = useState('');

      const currentMessage = generatedMessages[tab] || '';

      // Gather rich context
      const sName = F(stakeholder, 'Name') + (F(stakeholder, 'Lart name') ? ` ${F(stakeholder, 'Lart name')}` : '');
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
      const newsText = typeof recentNews === 'string' ? recentNews.slice(0, 400) : '';
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
        return `EVENT: ${eName}${eStart ? ` | Date: ${eStart}${eEnd ? ` – ${eEnd}` : ''}` : ''}${eUrl ? ` | URL: ${eUrl}` : ''}${eAdditional ? `\nEvent Context: ${eAdditional.slice(0, 300)}` : ''}${eSummary ? `\nEvent Summary: ${(typeof eSummary === 'string' ? eSummary : '').slice(0, 300)}` : ''}`;
      })() : '';

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

      const tabPrompts = {
        first: {
          label: 'First Contact',
          goal: 'This is the FIRST outreach ever to this person. Your only goal: open a conversation and earn a response. Do NOT try to sell or pitch. Create genuine curiosity based on their specific context and propose one clear, low-friction next step.',
          extra: `Do NOT reference any previous conversation — this is cold outreach. Lead with THEIR world (a challenge, a news trigger, an industry shift), not with ${COMPANY_PROFILE.companyName}. CRITICAL: Since this is first contact, the message MUST include a brief self-introduction — one sentence mentioning who you are (name if available), your role, and ${COMPANY_PROFILE.companyName}. Place it naturally, not as the opening line.`,
        },
        followup2: {
          label: 'Follow-up 2',
          goal: 'This is a SECOND touch — they did not reply. Your goal: re-engage with a completely NEW angle. Add value they didn\'t get in the first message — a new insight, a relevant case study mention, a different pain point. Do NOT repeat or reference the first message directly.',
          extra: lastMessages ? `PREVIOUS MESSAGES SENT:\n${lastMessages}\n\nCRITICAL: Bring a fresh angle — different pain point, different hook, different value. Never say "following up on my previous message" or "just checking in".` : '',
        },
        followup3: {
          label: 'Follow-up 3',
          goal: 'This is the THIRD and final touch. Be ultra-concise (shorter than previous messages). Options: offer something tangible (a 1-pager, a benchmark, a specific insight), suggest a specific time, or create gentle urgency. This is your breakup message — make it memorable, not desperate.',
          extra: lastMessages ? `PREVIOUS MESSAGES SENT:\n${lastMessages}\n\nCRITICAL: This is the last shot. Do NOT repeat ANY previous angle. Either: (a) offer something concrete and downloadable, (b) name-drop a relevant client result, or (c) propose a specific date/time. Keep it under 40 words for WhatsApp/LinkedIn, under 60 for Email.` : '',
        },
      };

      const handleGenerate = async () => {
        if (!selectedChannel) { alert('Select a channel first'); return; }

        setLoadingAI(true);
        try {
          const chGuide = channelPrompts[selectedChannel];
          const tabGuide = tabPrompts[tab];

          const prompt = `You are a B2B sales copywriter for ${COMPANY_PROFILE.companyName} (${COMPANY_PROFILE.services}).

STAKEHOLDER:
- Name: ${sName}
- Role: ${role} at ${accountName}
- Industry: ${industry}
- Influence: ${influence}
- Pain Points: ${painText || 'Not available'}
- LinkedIn Latest News: ${linkedinText || 'Not available'}

ACCOUNT CONTEXT:
- Company: ${accountName}
- Recent News: ${newsText || 'Not available'}
- Service Focus: ${focusText || 'Not defined'}
- Solutions Mapped: ${solNames.join(', ') || 'None yet'}
- Active Opportunities: ${oppSummary || 'None'}
- Inside Sales Plan: ${planText || 'Not available'}
- Intel Notes (recent context from BDR): ${intelNotesText || 'None'}

MESSAGE TYPE: ${eventContext && eventMode === 'followup' ? 'Post-Event Follow-up' : tabGuide.label}
${eventContext && eventMode === 'followup' ? 'This is a WARM follow-up after meeting in person at an event. The relationship has already started — do NOT treat this as cold outreach. Skip introductions, reference the meeting naturally, and focus on continuing the conversation with one clear next step.' : tabGuide.goal}
${eventContext && eventMode === 'followup' ? '' : tabGuide.extra}

CHANNEL: ${selectedChannel}
- Tone: ${chGuide.tone}
- Format: ${chGuide.format}

${extraContext ? `⚠️ CRITICAL — SENDER'S PERSONAL CONTEXT (MUST be incorporated into the message):\n"${extraContext}"\nYou MUST weave this context naturally into the message. This is first-hand intel from the sender and takes priority over other data.\n` : ''}
${eventContext && eventMode === 'invite' ? `🎪 EVENT CONTEXT — Use this event as the reason to reach out:\n${eventContext}\nAPPROACH: Keep it simple and natural. Ask if they're planning to attend the event, and say you'd love to meet them there / grab a coffee / say hello. Do NOT write a formal invitation or pitch the event. Just use it as a warm, human excuse to connect. Example tone: "I'll be at [event] — are you planning to go? Would love to meet in person."\n` : ''}${eventContext && eventMode === 'followup' ? `🤝 POST-EVENT FOLLOW-UP — The sender already met this person at the event:\n${eventContext}\nAPPROACH: This is a warm follow-up after an in-person meeting. Reference that you met at the event naturally — don't make it awkward or overly formal. Acknowledge the conversation you had (keep it vague since we don't know the details), express genuine interest in continuing it, and include one clear next step (a call, a coffee, sending something). Tone: warm, human, brief. It should feel like a message from someone who actually remembers the conversation and wants to take it further. Do NOT pitch heavily — the relationship is already warm. Example tone: "Great meeting you at [event] — wanted to follow up on what we discussed. Would love to continue the conversation over a quick call next week."\n` : ''}
${solutionContext ? `🛠️ SOLUTION TO PITCH — The sender wants to position this specific solution/service in the message:\n${solutionContext}\nYou MUST weave this solution naturally into the message — explain how it addresses the stakeholder's pain points or industry challenges. Reference the solution's capabilities specifically, don't be generic. The solution is the VALUE PROPOSITION of this message.\n` : ''}
SENDER: ${COMPANY_PROFILE.senderName}, ${COMPANY_PROFILE.senderTitle} — ${COMPANY_PROFILE.companyName}
${suggestedLanguage ? `\n🌍 LANGUAGE: The account is based in ${accountCountry}. Write the message in ${suggestedLanguage}. If the sender's personal context explicitly specifies a different language, use that instead.\n` : ''}
${COMPANY_PROFILE.voiceTone ? `\n🎙️ SENDER'S VOICE & TONE (CRITICAL — this defines HOW the message sounds):\n- Personality: ${COMPANY_PROFILE.voiceTone}\n${COMPANY_PROFILE.voiceAvoid ? `- NEVER do this: ${COMPANY_PROFILE.voiceAvoid}\n` : ''}${COMPANY_PROFILE.voiceExample ? `- Write like this real example from the sender: "${COMPANY_PROFILE.voiceExample}"\n` : ''}- The message MUST sound like this person wrote it, not like an AI. Match the energy, rhythm and vocabulary from the example above.\n` : ''}
RULES:
- Lead with THEIR world, not yours. First sentence must reference something about THEM (role, company, news, challenge)
- Personalize with their first name only — never full name in the body
- Reference recent news or LinkedIn activity ONLY if it's specific and recent — vague references are worse than none
- Connect ${COMPANY_PROFILE.companyName}'s capabilities to THEIR specific challenges — never list services generically
- BANNED PHRASES: "I hope this finds you well", "I came across your profile", "I wanted to reach out", "I'd love to connect", "just checking in", "following up", "touching base", "quick question", "I noticed that you", "as a leader in"
- ONE clear micro-CTA — low commitment, specific (not "let me know if you're interested")
- Sound like a real person, not a template. Read it aloud — if it sounds robotic, rewrite it.
- ${COMPANY_PROFILE.market ? `Market context (${COMPANY_PROFILE.market}): tailor tone and references to the target market. Be culturally aware without overdoing it.` : ''}
${COMPANY_PROFILE.goals ? `COMPANY STRATEGIC CONTEXT: ${COMPANY_PROFILE.goals}\n` : ''}${eventContext && eventMode === 'invite' ? '- EVENT: Keep it casual — ask if they\'re attending, say you\'d love to meet there. Do NOT write a formal invitation.\n' : ''}${eventContext && eventMode === 'followup' ? '- POST-EVENT: You ALREADY met them. DO NOT ask if they\'re attending. Reference the meeting as something that already happened. The tone is warm, not cold.\n' : ''}${solutionContext ? '- SOLUTION: Weave the solution naturally as a value prop connected to their pain points. Don\'t pitch — hint at relevant results.\n' : ''}${extraContext ? '- SENDER CONTEXT: The personal context provided MUST appear naturally in the message — it\'s first-hand intel and takes priority.\n' : ''}- Write ONLY the message. No meta-commentary, no explanations, no "Here's a message for..." prefix.`;

          const generated = await callOpenAI({ prompt, temperature: 0.7, max_tokens: 500 });
          setGeneratedMessages(prev => ({ ...prev, [tab]: generated }));
        } catch (e) {
          console.error(e);
          alert('Failed to generate. Error: ' + (e.message || 'unknown error'));
        }
        setLoadingAI(false);
      };

      const handleSend = (channel) => {
        if (!currentMessage.trim()) return;
        const ccList = (channel === 'Email' && ccPartner && cpEmails.length > 0) ? cpEmails : [];
        onSend(stakeholder, channel, currentMessage, ccList);
        onClose();
      };

      const handleSaveDraft = async () => {
        if (!currentMessage.trim() || !selectedChannel) return;
        setSavingDraft(true);
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
            'Notes': `Saved as draft from AI Message Generator (${tabPrompts[tab]?.label || tab})${selectedChannel === 'Email' && ccPartner && cpEmails.length > 0 ? ` | CC: ${cpEmails.join(', ')}` : ''}`,
            'Logged By': CURRENT_USER?.name || '',
            'BDR Owner': CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '',
            'CP Assigned': CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '',
          });
          alert('Draft saved! Run "create-gmail-drafts" task to push to Gmail.');
          onClose();
        } catch (e) {
          console.error('Save draft failed:', e);
          alert('Failed to save draft.');
        }
        setSavingDraft(false);
      };

      return (
        <div className="modal-overlay" onClick={onClose}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 580 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>AI Message Generator</h3>
              <span style={{ fontSize: 12, color: 'var(--globant-muted)' }}>{sName} · {role}</span>
            </div>

            {/* Context preview */}
            <div style={{ padding: '8px 10px', background: 'rgba(191,215,48,0.06)', borderRadius: 8, marginBottom: 12, borderLeft: '3px solid var(--globant-green)', fontSize: 11, color: 'var(--globant-muted)', lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--globant-green)' }}>Context loaded:</strong>{' '}
              {painText ? '✅ Pain points' : '⚠️ No pain points'} · {linkedinText ? '✅ LinkedIn news' : '⚠️ No LinkedIn news'} · {newsText ? '✅ Company news' : '⚠️ No company news'} · {intelNotesText ? '✅ Intel notes' : '⚠️ No intel notes'} · {sOutreach.length > 0 ? `✅ ${sOutreach.length} previous touches` : '⚠️ No history'}
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
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(191,215,48,0.06)', borderRadius: 8, border: '1px solid rgba(191,215,48,0.15)' }}>
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
                <button className={`tab-btn ${tab === 'followup2' ? 'active' : ''}`} onClick={() => setTab('followup2')}>Follow-up 2</button>
                <button className={`tab-btn ${tab === 'followup3' ? 'active' : ''}`} onClick={() => setTab('followup3')}>Follow-up 3</button>
              </div>
            </div>

            {/* Step 3: Event reference */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, marginBottom: 6, color: 'var(--globant-muted)', fontWeight: 600 }}>3. EVENT REFERENCE <span style={{ fontWeight: 400 }}>(optional)</span></label>
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
                      style={{ flex: 1, fontSize: 11, padding: '5px 0', borderRadius: 6, border: `1px solid ${eventMode === 'invite' ? 'var(--globant-green)' : 'var(--globant-border)'}`, background: eventMode === 'invite' ? 'rgba(191,215,48,0.15)' : 'rgba(255,255,255,0.03)', color: eventMode === 'invite' ? 'var(--globant-green)' : 'var(--globant-muted)', cursor: 'pointer', fontWeight: eventMode === 'invite' ? 700 : 400 }}>
                      🎫 Invite — "Are you going?"
                    </button>
                    <button
                      onClick={() => setEventMode('followup')}
                      style={{ flex: 1, fontSize: 11, padding: '5px 0', borderRadius: 6, border: `1px solid ${eventMode === 'followup' ? '#a78bfa' : 'var(--globant-border)'}`, background: eventMode === 'followup' ? 'rgba(167,139,250,0.15)' : 'rgba(255,255,255,0.03)', color: eventMode === 'followup' ? '#a78bfa' : 'var(--globant-muted)', cursor: 'pointer', fontWeight: eventMode === 'followup' ? 700 : 400 }}>
                      🤝 Follow-up — "Great meeting you"
                    </button>
                  </div>
                  <div style={{ padding: '6px 10px', background: 'rgba(191,215,48,0.06)', borderRadius: 6, fontSize: 11, color: 'var(--globant-muted)', borderLeft: `3px solid ${eventMode === 'followup' ? '#a78bfa' : 'var(--globant-green)'}` }}>
                    {eventMode === 'invite' ? '🎪' : '🤝'} <strong>{F(selectedEvent, 'Event Name')}</strong>
                    {selectedEvent.fields?.['Starting'] && <span> · {new Date(selectedEvent.fields['Starting']).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>}
                    <span style={{ marginLeft: 8, color: eventMode === 'followup' ? '#a78bfa' : 'var(--globant-green)' }}>{eventMode === 'invite' ? 'Invite mode' : 'Follow-up mode'}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Step 4: Solution to pitch */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, marginBottom: 6, color: 'var(--globant-muted)', fontWeight: 600 }}>4. SOLUTION TO PITCH <span style={{ fontWeight: 400 }}>(optional — select a solution to position in the message)</span></label>
              <select className="input-field" style={{ width: '100%', fontSize: 12 }}
                value={selectedSolutionId} onChange={e => setSelectedSolutionId(e.target.value)}>
                <option value="">— No specific solution —</option>
                {allSolutions.map(sol => (
                  <option key={sol.id} value={sol.id}>{F(sol, 'Name')}</option>
                ))}
              </select>
              {selectedSolution && (
                <div style={{ marginTop: 6, padding: '6px 10px', background: 'rgba(191,215,48,0.06)', borderRadius: 6, fontSize: 11, color: 'var(--globant-muted)', borderLeft: '3px solid #a78bfa' }}>
                  🛠️ <strong>{F(selectedSolution, 'Name')}</strong>
                  {(() => { const d = F(selectedSolution, 'Service | Solution Detail'); return d ? <span> · {(typeof d === 'string' ? d : '').slice(0, 120)}...</span> : null; })()}
                </div>
              )}
            </div>

            {/* Step 5: Extra context */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, marginBottom: 6, color: 'var(--globant-muted)', fontWeight: 600 }}>5. YOUR CONTEXT <span style={{ fontWeight: 400 }}>(optional — add anything the AI should know)</span></label>
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
              {loadingAI ? '⏳ Generating with GPT-4o...' : !selectedChannel ? 'Select a channel first ↑' : `✨ Generate ${tabPrompts[tab]?.label} via ${selectedChannel}`}
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
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="action-btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
              <button className="action-btn" style={{ flex: 1, background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }}
                onClick={handleSaveDraft} disabled={!selectedChannel || !currentMessage.trim() || savingDraft}>
                {savingDraft ? 'Saving...' : '📝 Draft'}
              </button>
              <button className="action-btn btn-primary" style={{ flex: 1 }}
                onClick={() => selectedChannel && handleSend(selectedChannel)} disabled={!selectedChannel || !currentMessage.trim()}>
                Send {selectedChannel ? `via ${selectedChannel}` : ''}{selectedChannel === 'Email' && ccPartner && cpEmails.length > 0 ? ' + CC' : ''}
              </button>
            </div>
          </div>
        </div>
      );
    }

    // ============ FOLLOW-UP CENTER ============
    function FollowupCenter({ data, api, onLogActivity, onAddRecord }) {
      const { accounts, stakeholders, outreach } = data;
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
      const [csvStatus, setCsvStatus] = useState(null);
      const [importResults, setImportResults] = useState(null);
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
      const followupPending = useMemo(() => {
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 3); cutoff.setHours(0, 0, 0, 0);
        const results = [];
        stakeholders.forEach(s => {
          const sOutreach = outreach.filter(o => linkedIds(o, 'Stakeholder').includes(s.id))
            .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
          if (sOutreach.length === 0) return; // never contacted
          const lastDate = new Date(sOutreach[0].fields?.['Date'] || 0);
          if (lastDate >= cutoff) return; // contacted recently, skip
          // Apply filters
          if (accountSearch) {
            const term = accountSearch.toLowerCase();
            const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
            if (!accNames.some(n => n.toLowerCase().includes(term))) return;
          }
          if (selectedInfluence && F(s, 'Level of Influence') !== selectedInfluence) return;
          if (searchName && !(F(s, 'Name') || '').toLowerCase().includes(searchName.toLowerCase())) return;
          const daysSince = Math.floor((new Date() - lastDate) / (1000*60*60*24));
          results.push({ s, lastOutreach: sOutreach[0], daysSince, totalTouches: sOutreach.length });
        });
        return results.sort((a, b) => b.daysSince - a.daysSince);
      }, [stakeholders, outreach, accounts, accountSearch, selectedInfluence, searchName]);

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
            'BDR Owner': CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '',
            'CP Assigned': CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '',
          });
          await activateAccountIfNeeded(a, companyIds, data.accounts);
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
            'Channel': 'Call',
            'Date': new Date().toISOString(),
            'Status': 'Meeting Scheduled',
            'Message': notes || '',
            'Notes': `Meeting ${date ? `on ${date}` : 'TBD'} — logged from Follow-up Center`,
            'Logged By': CURRENT_USER?.name || '',
            'BDR Owner': CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '',
            'CP Assigned': CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '',
          });
          await activateAccountIfNeeded(a, companyIds, data.accounts);
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

      // Split into two groups
      const hasPregenMsg = (s) => !!(F(s, 'Personalized Email Introduction'));
      const withMessages = filtered.filter(hasPregenMsg);
      const withoutMessages = filtered.filter(s => !hasPregenMsg(s));

      // Get unique influence levels from actual data
      const influenceLevels = useMemo(() => {
        const levels = new Set();
        stakeholders.forEach(s => { const l = F(s, 'Level of Influence'); if (l) levels.add(l); });
        return [...levels].sort();
      }, [stakeholders]);

      const useMessage = (stakeholder, channel, message, ccList = []) => {
        const name = F(stakeholder, 'Name') || '';
        const email = F(stakeholder, 'Email') || '';
        const phone = F(stakeholder, 'Phone number') || '';
        const linkedin = F(stakeholder, 'LinkedIn') || '';
        let subject = '';
        let body = message;
        if (channel === 'Email' && message.startsWith('Subject:')) {
          const lines = message.split('\n');
          subject = lines[0].replace('Subject:', '').trim();
          body = lines.slice(1).join('\n').trim();
        }
        if (channel === 'WhatsApp' && phone) window.open(`https://wa.me/${String(phone).replace(/[^0-9+]/g, '')}?text=${encodeURIComponent(message)}`, '_blank');
        else if (channel === 'Email' && email) { const ccParam = ccList.length > 0 ? `&cc=${encodeURIComponent(ccList.join(','))}` : ''; window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}${ccParam}`, '_blank'); }
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
          'BDR Owner': CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '',
          'CP Assigned': CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '',
        };
        if (onAddRecord) onAddRecord('outreach', outreachFields);
        const a = api || new AirtableAPI();
        a.createRecord(TABLE_IDS.outreach, outreachFields)
          .then(() => activateAccountIfNeeded(a, companyIds, data.accounts))
          .then(() => { if (onLogActivity) onLogActivity(); })
          .catch(e => console.error('Auto-log failed:', e));
      };

      // Manual stakeholder creation in Follow-up Center
      const fuCreateStakeholder = async () => {
        if (!fuNewName.trim() || !fuNewAccountId) return;
        const fields = { 'Name': fuNewName.trim(), 'Account': [fuNewAccountId] };
        if (fuNewLast.trim()) fields['Lart name'] = fuNewLast.trim();
        if (fuNewRole.trim()) fields['Role'] = fuNewRole.trim();
        if (fuNewEmail.trim()) fields['Email'] = fuNewEmail.trim();
        if (fuNewPhone.trim()) fields['Phone number'] = fuNewPhone.trim();
        if (fuNewLinkedin.trim()) fields['LinkedIn'] = fuNewLinkedin.trim();
        if (fuNewInfluence) fields['Level of Influence'] = fuNewInfluence;
        fields['BDR Owner'] = CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '';
        fields['CP Assigned'] = CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '';
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
          .catch(e => { console.error(e); alert('Failed to create contact'); if (onLogActivity) onLogActivity(); });
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
              <div style={{ fontWeight: 600, cursor: 'pointer', color: 'var(--globant-green)' }} onClick={() => setHistoryStakeholder(s)}>{F(s, 'Name')}{F(s, 'Lart name') ? ` ${F(s, 'Lart name')}` : ''}</div>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)' }}>{F(s, 'Role')}</div>
            </td>
            <td style={{ fontSize: 12 }}>{accountNames.join(', ')}</td>
            <td><span className="badge badge-accent">{F(s, 'Level of Influence')}</span></td>
            <td style={{ textAlign: 'center' }}>{isDone ? <span style={{ color: 'var(--globant-success)' }}>✅</span> : <span style={{ color: 'var(--globant-muted)' }}>—</span>}</td>
            <td>
              {(() => {
                const preMsg = F(s, 'Personalized Email Introduction') || '';
                const fallback = `Hi ${F(s, 'Name')}, reaching out from ${COMPANY_PROFILE.companyName} regarding potential collaboration.`;
                const msg = preMsg || fallback;
                return (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <button className="action-btn btn-primary" style={{ fontSize: 11 }} onClick={() => setSelectedStakeholder(s)}>✨ Message</button>
                    {phone && <button className="action-btn btn-whatsapp" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => useMessage(s, 'WhatsApp', msg)}>💬</button>}
                    {email && <button className="action-btn btn-email" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => useMessage(s, 'Email', msg)}>✉️</button>}
                    {linkedin && <button className="action-btn btn-linkedin" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => useMessage(s, 'LinkedIn', msg)}>🔗</button>}
                    {phone && <button className="action-btn btn-call" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => useMessage(s, 'Call', msg)}>📞</button>}
                    <button className="action-btn" style={{ fontSize: 11, padding: '4px 8px', background: 'rgba(96,165,250,0.15)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.3)' }}
                      onClick={() => { setMeetingModal({ stakeholder: s }); setMeetingNotes(''); setMeetingDate(''); setMeetingTime(''); }}>📅</button>
                  </div>
                );
              })()}
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
                <div style={{ fontSize: 11, color: 'var(--globant-muted)', padding: '8px 12px', background: 'rgba(191,215,48,0.06)', borderRadius: 6, marginBottom: 12, lineHeight: 1.6 }}>
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
                                  && (F(s, 'Lart name') || '').toLowerCase() === lastName.toLowerCase()
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
                                'Lart name': row.lastName,
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

          {/* Group 1: Follow-up Pending */}
          <div className="card" style={{ borderLeft: '3px solid var(--globant-info)' }}>
            <div className="card-header">
              <h3 style={{ color: 'var(--globant-info)' }}>🔵 Follow-up Pending ({followupPending.length})</h3>
              <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Already contacted — waiting for response or next action</span>
            </div>
            {followupPending.length === 0 ? (
              <p style={{ color: 'var(--globant-muted)', fontSize: 13, padding: '8px 0' }}>No pending follow-ups right now</p>
            ) : (
              <div>
                {followupPending.map(({ s, lastOutreach, daysSince, totalTouches }) => {
                  const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
                  const lastChannel = F(lastOutreach, 'Channel');
                  const lastMsg = F(lastOutreach, 'Message');
                  const lastStatus = F(lastOutreach, 'Status');
                  const phone = F(s, 'Phone number');
                  const email = F(s, 'Email');
                  const linkedin = F(s, 'LinkedIn');
                  const fu2 = F(s, 'Follow up 2') || '';
                  const fu3 = F(s, 'Follow up 3') || '';
                  const nextFollowup = fu2 || fu3 || `Hi ${F(s, 'Name')}, just following up on my previous message. Would love to connect when you have a moment.`;
                  const urgencyColor = daysSince > 14 ? '#ef4444' : daysSince > 7 ? '#fbbf24' : '#60a5fa';
                  const urgencyBg = daysSince > 14 ? 'rgba(239,68,68,0.06)' : daysSince > 7 ? 'rgba(251,191,36,0.06)' : 'rgba(96,165,250,0.04)';

                  return (
                    <div key={s.id} style={{ padding: '14px', marginBottom: 8, borderRadius: 8, background: urgencyBg, borderLeft: `3px solid ${urgencyColor}` }}>
                      {/* Header */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <div>
                          <span style={{ fontWeight: 700, fontSize: 14, cursor: 'pointer', color: 'var(--globant-green)' }} onClick={() => setHistoryStakeholder(s)}>{F(s, 'Name')}{F(s, 'Lart name') ? ` ${F(s, 'Lart name')}` : ''}</span>
                          <span style={{ fontSize: 12, color: 'var(--globant-muted)', marginLeft: 8 }}>{F(s, 'Role')} · {accNames.join(', ')}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: urgencyColor }}>{daysSince}d ago</span>
                          <span className="badge badge-accent" style={{ fontSize: 9 }}>{totalTouches} touch{totalTouches > 1 ? 'es' : ''}</span>
                        </div>
                      </div>

                      {/* Last activity */}
                      <div style={{ fontSize: 12, color: 'var(--globant-muted)', marginBottom: 10, padding: '6px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
                        <span style={{ marginRight: 6 }}>{channelIcon[lastChannel] || '📋'}</span>
                        Last: {F(lastOutreach, 'Activity Name')} · <span className="badge badge-green" style={{ fontSize: 9 }}>{lastStatus}</span>
                        {lastMsg && <div style={{ marginTop: 4, fontSize: 11, color: 'var(--globant-text)', whiteSpace: 'pre-wrap', maxHeight: 40, overflow: 'hidden' }}>{lastMsg.substring(0, 150)}{lastMsg.length > 150 ? '...' : ''}</div>}
                      </div>

                      {/* Action buttons */}
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {/* Follow-up via channels */}
                        {email && <button className="action-btn btn-email" style={{ fontSize: 10, padding: '5px 10px' }} onClick={() => useMessage(s, 'Email', nextFollowup)}>✉️ Follow-up</button>}
                        {phone && <button className="action-btn btn-whatsapp" style={{ fontSize: 10, padding: '5px 10px' }} onClick={() => useMessage(s, 'WhatsApp', nextFollowup)}>💬 Follow-up</button>}
                        {linkedin && <button className="action-btn btn-linkedin" style={{ fontSize: 10, padding: '5px 10px' }} onClick={() => useMessage(s, 'LinkedIn', nextFollowup)}>🔗 Follow-up</button>}
                        {phone && <button className="action-btn btn-call" style={{ fontSize: 10, padding: '5px 10px' }} onClick={() => useMessage(s, 'Call', nextFollowup)}>📞 Call</button>}

                        <div style={{ width: 1, background: 'var(--globant-border)', margin: '0 4px' }} />

                        {/* Response & Meeting */}
                        <button className="action-btn btn-primary" style={{ fontSize: 10, padding: '5px 10px' }} onClick={() => { setResponseModal({ stakeholder: s, lastOutreach }); setResponseText(''); }}>
                          💬 Responded
                        </button>
                        <button className="action-btn" style={{ fontSize: 10, padding: '5px 10px', background: 'rgba(96,165,250,0.15)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.3)' }} onClick={() => { setMeetingModal({ stakeholder: s }); setMeetingNotes(''); setMeetingDate(''); setMeetingTime(''); }}>
                          📅 Schedule Meeting
                        </button>
                        <button className="action-btn btn-primary" style={{ fontSize: 10, padding: '5px 10px' }} onClick={() => setSelectedStakeholder(s)}>
                          ✨ Custom AI
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Group 2: Needs First Contact */}
          <div className="card" style={{ borderLeft: '3px solid var(--globant-warning)' }}>
            <div className="card-header">
              <h3 style={{ color: 'var(--globant-warning)' }}>🟡 Needs First Contact ({filtered.length})</h3>
              <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Never contacted — use AI or direct channel to reach out</span>
            </div>
            {filtered.length === 0 ? (
              <p style={{ color: 'var(--globant-muted)', fontSize: 13, padding: '8px 0' }}>All contacts have been reached{accountSearch ? ` for "${accountSearch}"` : ''}!</p>
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
            const msName = F(ms, 'Name') + (F(ms, 'Lart name') ? ` ${F(ms, 'Lart name')}` : '');
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
              data={data}
            />
          )}

          {historyStakeholder && (
            <StakeholderHistoryModal
              stakeholder={historyStakeholder}
              outreach={outreach}
              accounts={accounts}
              onClose={() => setHistoryStakeholder(null)}
              onRefresh={onLogActivity}
              allData={data}
            />
          )}
        </div>
      );
    }

    // ============ SHARED EDIT MODAL ============
    function EditModal({ title, fields, initialValues, onSave, onClose }) {
      const [values, setValues] = useState(() => {
        const v = {};
        fields.forEach(f => { v[f.key] = initialValues[f.key] ?? ''; });
        return v;
      });
      const [saving, setSaving] = useState(false);

      const handleSave = async () => {
        setSaving(true);
        await onSave(values);
        setSaving(false);
      };

      const set = (key, val) => setValues(p => ({ ...p, [key]: val }));

      return (
        <div className="modal-overlay" onClick={onClose}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <h3 style={{ margin: 0 }}>✏️ {title}</h3>
              <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
              {fields.map(f => (
                <div key={f.key} style={f.fullWidth ? { gridColumn: '1 / -1' } : {}}>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600, textTransform: 'uppercase' }}>{f.label}</label>
                  {f.type === 'textarea' ? (
                    <textarea className="input-field" style={{ width: '100%', minHeight: 70, resize: 'vertical', fontFamily: 'inherit', fontSize: 12 }}
                      value={values[f.key] || ''} onChange={e => set(f.key, e.target.value)} />
                  ) : f.type === 'select' ? (
                    <select className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                      value={values[f.key] || ''} onChange={e => set(f.key, e.target.value)}>
                      <option value="">Select...</option>
                      {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : f.type === 'date' ? (
                    <input type="date" className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                      value={values[f.key] ? String(values[f.key]).slice(0, 10) : ''} onChange={e => set(f.key, e.target.value)} />
                  ) : (
                    <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                      value={values[f.key] || ''} onChange={e => set(f.key, e.target.value)} />
                  )}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <button className="action-btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
              <button className="action-btn btn-primary" style={{ flex: 2 }} onClick={handleSave} disabled={saving}>
                {saving ? '⏳ Saving...' : '💾 Save Changes'}
              </button>
            </div>
          </div>
        </div>
      );
    }

    // ============ CONTACTS SECTION ============
    function ContactsSection({ data, api, onLogActivity, onAddRecord, onUpdateRecord }) {
      const { accounts, stakeholders, outreach } = data;
      const [searchName, setSearchName] = useState('');
      const [searchAccount, setSearchAccount] = useState('');
      const [selectedInfluence, setSelectedInfluence] = useState('');
      const [historyStakeholder, setHistoryStakeholder] = useState(null);
      const [selectedStakeholder, setSelectedStakeholder] = useState(null);
      const [showNewContact, setShowNewContact] = useState(false);
      const [ctxNewName, setCtxNewName] = useState('');
      const [ctxNewLast, setCtxNewLast] = useState('');
      const [ctxNewRole, setCtxNewRole] = useState('');
      const [ctxNewEmail, setCtxNewEmail] = useState('');
      const [ctxNewPhone, setCtxNewPhone] = useState('');
      const [ctxNewLinkedin, setCtxNewLinkedin] = useState('');
      const [ctxNewInfluence, setCtxNewInfluence] = useState('');
      const [ctxNewAccountId, setCtxNewAccountId] = useState('');
      const [ctxNewSource, setCtxNewSource] = useState('');
      const [ctxNewCampaign, setCtxNewCampaign] = useState('');
      const [ctxCreating, setCtxCreating] = useState(false);
      const [showNewAccount, setShowNewAccount] = useState(false);
      const [ctxNewAccountName, setCtxNewAccountName] = useState('');
      const [ctxNewAccountWebsite, setCtxNewAccountWebsite] = useState('');
      const [ctxCreatingAccount, setCtxCreatingAccount] = useState(false);
      const [editingContact, setEditingContact] = useState(null);
      const [filterSource, setFilterSource] = useState('');
      const [showContactImport, setShowContactImport] = useState(false);
      const [contactCsvRows, setContactCsvRows] = useState([]);
      const [contactImporting, setContactImporting] = useState(false);
      const [contactImportResult, setContactImportResult] = useState(null);

      const SOURCE_OPTIONS = ['Outbound', 'Inbound - Events', 'Inbound - Paid Media', 'Inbound - Referral', 'Inbound - Website', 'Inbound - Direct'];
      const isInbound = (src) => src && src.startsWith('Inbound');

      const createInlineAccount = async () => {
        if (!ctxNewAccountName.trim()) return;
        setCtxCreatingAccount(true);
        // Need real ID to link contact — must await, but skip full reload
        try {
          const a = api || new AirtableAPI();
          const fields = { 'Account Name': ctxNewAccountName.trim() };
          if (ctxNewAccountWebsite.trim()) fields['Website'] = ctxNewAccountWebsite.trim();
          if (CURRENT_USER?.role === 'bdr') fields['BDR Owner'] = CURRENT_USER?.name || '';
          if (CURRENT_USER?.role === 'cp') fields['CP Assigned'] = CURRENT_USER?.name || '';
          const record = await a.createRecord(TABLE_IDS.accounts, fields);
          if (record?.id) {
            setCtxNewAccountId(record.id);
            // Add to local state with real ID — no full reload needed
            if (onAddRecord) onAddRecord('accounts', fields);
          }
          setCtxNewAccountName(''); setCtxNewAccountWebsite('');
          setShowNewAccount(false);
        } catch (e) { console.error(e); alert('Failed to create account'); }
        setCtxCreatingAccount(false);
      };

      const createContact = async () => {
        if (!ctxNewName.trim() || !ctxNewAccountId) return;
        const fields = { 'Name': ctxNewName.trim(), 'Account': [ctxNewAccountId] };
        if (ctxNewLast.trim()) fields['Lart name'] = ctxNewLast.trim();
        if (ctxNewRole.trim()) fields['Role'] = ctxNewRole.trim();
        if (ctxNewEmail.trim()) fields['Email'] = ctxNewEmail.trim();
        if (ctxNewPhone.trim()) fields['Phone number'] = ctxNewPhone.trim();
        if (ctxNewLinkedin.trim()) fields['LinkedIn'] = ctxNewLinkedin.trim();
        if (ctxNewInfluence) fields['Level of Influence'] = ctxNewInfluence;
        if (ctxNewSource) fields['Source'] = ctxNewSource;
        if (ctxNewCampaign.trim()) fields['Campaign'] = ctxNewCampaign.trim();
        if (CURRENT_USER?.role === 'bdr') fields['BDR Owner'] = CURRENT_USER?.name || '';
        if (CURRENT_USER?.role === 'cp') fields['CP Assigned'] = CURRENT_USER?.name || '';
        // Optimistic: show instantly
        if (onAddRecord) onAddRecord('stakeholders', fields);
        // Close form immediately
        setCtxNewName(''); setCtxNewLast(''); setCtxNewRole(''); setCtxNewEmail('');
        setCtxNewPhone(''); setCtxNewLinkedin(''); setCtxNewInfluence(''); setCtxNewAccountId('');
        setCtxNewSource(''); setCtxNewCampaign('');
        setShowNewContact(false);
        // API in background
        const a = api || new AirtableAPI();
        a.createRecord(TABLE_IDS.stakeholders, fields)
          .then(() => { if (onLogActivity) onLogActivity(); })
          .catch(e => { console.error(e); alert('Failed to create contact'); if (onLogActivity) onLogActivity(); });
      };

      // ─── CSV IMPORT ───
      const handleContactCsv = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        Papa.parse(file, {
          header: true, skipEmptyLines: true,
          complete: (result) => {
            const existingEmails = new Set(stakeholders.map(s => (F(s, 'Email') || '').toLowerCase()).filter(Boolean));
            const existingFullNames = stakeholders.map(s => ((F(s, 'Name') || '') + ' ' + (F(s, 'Lart name') || '')).trim());
            const rows = result.data.map(row => {
              const norm = {};
              Object.keys(row).forEach(k => {
                const kl = k.toLowerCase().trim();
                if (kl === 'first name' || kl === 'firstname' || kl === 'name' || kl === 'nombre') norm.firstName = row[k]?.trim();
                if (kl === 'last name' || kl === 'lastname' || kl === 'apellido') norm.lastName = row[k]?.trim();
                if (kl === 'email' || kl === 'correo') norm.email = row[k]?.trim();
                if (kl === 'phone' || kl === 'telefono' || kl === 'phone number') norm.phone = row[k]?.trim();
                if (kl === 'role' || kl === 'title' || kl === 'cargo' || kl === 'job title') norm.role = row[k]?.trim();
                if (kl === 'linkedin' || kl === 'linkedin url') norm.linkedin = row[k]?.trim();
                if (kl === 'account' || kl === 'company' || kl === 'empresa') norm.accountName = row[k]?.trim();
                if (kl === 'source' || kl === 'fuente') norm.source = row[k]?.trim();
                if (kl === 'campaign' || kl === 'campaña') norm.campaign = row[k]?.trim();
                if (kl === 'country' || kl === 'pais' || kl === 'país') norm.country = row[k]?.trim();
              });
              if (!norm.firstName) return null;
              // Auto-inherit country from matched account if not set
              if (!norm.country && norm.accountName) {
                const matchedAcc = accounts.find(ac => (F(ac, 'Account Name') || '').toLowerCase() === (norm.accountName || '').toLowerCase());
                if (matchedAcc) norm.country = F(matchedAcc, 'Country') || '';
              }
              const fullName = (norm.firstName + ' ' + (norm.lastName || '')).trim();
              // Exact match
              const emailExact = norm.email && existingEmails.has(norm.email.toLowerCase());
              const nameExact = existingFullNames.some(n => n.toLowerCase() === fullName.toLowerCase());
              if (emailExact) return { ...norm, isDuplicate: true, duplicateReason: 'Email exists', isFuzzy: false, selected: false };
              if (nameExact) return { ...norm, isDuplicate: true, duplicateReason: 'Name already exists', isFuzzy: false, selected: false };
              // Fuzzy name match
              const fuzzyMatch = existingFullNames.find(n => strSimilarity(n, fullName) >= 0.78);
              if (fuzzyMatch) return { ...norm, isDuplicate: false, isFuzzy: true, fuzzyReason: `Similar to "${fuzzyMatch}"`, selected: true };
              return { ...norm, isDuplicate: false, isFuzzy: false, selected: true };
            }).filter(Boolean);
            setContactCsvRows(rows);
            setContactImportResult(null);
          }
        });
      };

      const importContacts = async () => {
        const toImport = contactCsvRows.filter(r => r.selected && !r.isDuplicate);
        if (!toImport.length) return;
        setContactImporting(true);
        let created = 0, failed = 0;
        const a = api || new AirtableAPI();
        for (const row of toImport) {
          try {
            // Resolve account by name
            const matchedAcc = row.accountName ? accounts.find(ac => (F(ac, 'Account Name') || '').toLowerCase() === row.accountName.toLowerCase()) : null;
            const fields = { 'Name': row.firstName };
            if (row.lastName) fields['Lart name'] = row.lastName;
            if (row.email) fields['Email'] = row.email;
            if (row.phone) fields['Phone number'] = row.phone;
            if (row.role) fields['Role'] = row.role;
            if (row.linkedin) fields['LinkedIn'] = row.linkedin;
            if (row.source) fields['Source'] = row.source;
            if (row.campaign) fields['Campaign'] = row.campaign;
            const resolvedCountry = row.country || (matchedAcc ? F(matchedAcc, 'Country') : '') || '';
            if (resolvedCountry) fields['Country'] = resolvedCountry;
            if (matchedAcc) fields['Account'] = [matchedAcc.id];
            if (CURRENT_USER?.role === 'bdr') fields['BDR Owner'] = CURRENT_USER?.name || '';
            await a.createRecord(TABLE_IDS.stakeholders, fields);
            created++;
            await new Promise(r => setTimeout(r, 250));
          } catch (e) { failed++; console.error(e); }
        }
        setContactImportResult({ created, failed });
        setContactImporting(false);
        if (onLogActivity) onLogActivity();
      };

      const useMessage = (stakeholder, channel, message) => {
        const name = F(stakeholder, 'Name') || '';
        const email = F(stakeholder, 'Email') || '';
        const phone = F(stakeholder, 'Phone number') || '';
        const linkedin = F(stakeholder, 'LinkedIn') || '';
        if (channel === 'WhatsApp' && phone) window.open(`https://wa.me/${String(phone).replace(/[^0-9+]/g, '')}?text=${encodeURIComponent(message)}`, '_blank');
        else if (channel === 'Email' && email) window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&body=${encodeURIComponent(message)}`, '_blank');
        else if (channel === 'LinkedIn' && linkedin) { navigator.clipboard.writeText(message).catch(() => {}); window.open(linkedin, '_blank'); }
        const companyIds = linkedIds(stakeholder, 'Account');
        const outreachFields = {
          'Activity Name': `${channel} to ${name} — ${new Date().toLocaleDateString('en-US')}`,
          'Account': companyIds, 'Stakeholder': [stakeholder.id],
          'Channel': channel, 'Date': new Date().toISOString(),
          'Status': 'Sent', 'Message': message,
          'Notes': 'Sent from Contacts',
          'Logged By': CURRENT_USER?.name || '',
          'BDR Owner': CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '',
          'CP Assigned': CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '',
        };
        if (onAddRecord) onAddRecord('outreach', outreachFields);
        const a = api || new AirtableAPI();
        a.createRecord(TABLE_IDS.outreach, outreachFields)
          .then(() => { if (onLogActivity) onLogActivity(); })
          .catch(e => console.error(e));
      };

      const saveContactEdit = async (values) => {
        if (!editingContact) return;
        // Only send fields that have a value — Airtable rejects empty strings for Email, Phone, URL, and Single Select fields
        const raw = {
          'Name': values['Name'],
          'Lart name': values['Lart name'],
          'Role': values['Role'],
          'Email': values['Email'],
          'Phone number': values['Phone number'],
          'LinkedIn': values['LinkedIn'],
          'Campaign': values['Campaign'],
          'Level of Influence': values['Level of Influence'] || null,
          'Source': values['Source'] || null,
        };
        const updatedFields = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== '' && v !== undefined));
        if (onUpdateRecord) onUpdateRecord('stakeholders', editingContact.id, updatedFields);
        setEditingContact(null);
        const a = api || new AirtableAPI();
        a.updateRecord(TABLE_IDS.stakeholders, editingContact.id, updatedFields)
          .then(() => { if (onLogActivity) onLogActivity(); })
          .catch(e => { console.error(e); alert('Failed to save. Refreshing...'); if (onLogActivity) onLogActivity(); });
      };

      const influenceLevels = useMemo(() => {
        const levels = new Set();
        stakeholders.forEach(s => { const l = F(s, 'Level of Influence'); if (l) levels.add(l); });
        return [...levels].sort();
      }, [stakeholders]);

      const filtered = useMemo(() => stakeholders.filter(s => {
        if (searchName && !(F(s, 'Name') || '').toLowerCase().includes(searchName.toLowerCase())) return false;
        if (searchAccount) {
          const term = searchAccount.toLowerCase();
          const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
          if (!accNames.some(n => n.toLowerCase().includes(term))) return false;
        }
        if (selectedInfluence && F(s, 'Level of Influence') !== selectedInfluence) return false;
        if (filterSource && F(s, 'Source') !== filterSource) return false;
        return true;
      }).sort((a, b) => (F(a, 'Name') || '').localeCompare(F(b, 'Name') || '')), [stakeholders, searchName, searchAccount, selectedInfluence, filterSource, accounts]);

      return (
        <div>
          <div className="page-header">
            <h1>Contacts</h1>
            <p>All stakeholders · {stakeholders.length} total</p>
          </div>

          <div className="filters-row">
            <input className="input-field" style={{ maxWidth: 220 }} placeholder="Search by name..." value={searchName} onChange={e => setSearchName(e.target.value)} />
            <input className="input-field" style={{ maxWidth: 220 }} placeholder="Filter by account..." value={searchAccount} onChange={e => setSearchAccount(e.target.value)} />
            <select className="input-field" style={{ maxWidth: 200 }} value={selectedInfluence} onChange={e => setSelectedInfluence(e.target.value)}>
              <option value="">All Influence Levels</option>
              {influenceLevels.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <select className="input-field" style={{ maxWidth: 200 }} value={filterSource} onChange={e => setFilterSource(e.target.value)}>
              <option value="">All Sources</option>
              {SOURCE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="action-btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setShowContactImport(!showContactImport); setContactImportResult(null); }}>
                {showContactImport ? '✕ Close Import' : '📥 Import CSV'}
              </button>
              <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={() => setShowNewContact(!showNewContact)}>
                {showNewContact ? '✕ Close' : '➕ New Contact'}
              </button>
            </div>
          </div>

          {/* New Contact Form */}
          {showNewContact && (
            <div className="card" style={{ borderLeft: '3px solid var(--globant-green)', marginBottom: 16 }}>
              <div className="card-header"><h3>➕ New Contact</h3></div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>FIRST NAME *</label>
                  <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="e.g. Khalid" value={ctxNewName} onChange={e => setCtxNewName(e.target.value)} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>LAST NAME</label>
                  <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="e.g. Al-Rashid" value={ctxNewLast} onChange={e => setCtxNewLast(e.target.value)} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>ACCOUNT *</label>
                  {!showNewAccount ? (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <select className="input-field" style={{ flex: 1, fontSize: 12, padding: '6px 8px' }} value={ctxNewAccountId} onChange={e => setCtxNewAccountId(e.target.value)}>
                        <option value="">Select account...</option>
                        {accounts.map(a => <option key={a.id} value={a.id}>{F(a, 'Account Name')}</option>)}
                      </select>
                      <button onClick={() => setShowNewAccount(true)} style={{ fontSize: 10, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--globant-green)', background: 'rgba(191,215,48,0.1)', color: 'var(--globant-green)', cursor: 'pointer', whiteSpace: 'nowrap' }}>+ New</button>
                    </div>
                  ) : (
                    <div style={{ padding: '8px', background: 'rgba(191,215,48,0.06)', borderRadius: 6, border: '1px solid rgba(191,215,48,0.2)' }}>
                      <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '5px 8px', marginBottom: 4 }} placeholder="Company name *" value={ctxNewAccountName} onChange={e => setCtxNewAccountName(e.target.value)} />
                      <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '5px 8px', marginBottom: 6 }} placeholder="Website (optional)" value={ctxNewAccountWebsite} onChange={e => setCtxNewAccountWebsite(e.target.value)} />
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="action-btn btn-primary" style={{ fontSize: 10, flex: 1 }} onClick={createInlineAccount} disabled={!ctxNewAccountName.trim() || ctxCreatingAccount}>{ctxCreatingAccount ? '⏳' : '✓ Create Account'}</button>
                        <button className="action-btn btn-ghost" style={{ fontSize: 10 }} onClick={() => { setShowNewAccount(false); setCtxNewAccountName(''); setCtxNewAccountWebsite(''); }}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>ROLE</label>
                  <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="e.g. CTO" value={ctxNewRole} onChange={e => setCtxNewRole(e.target.value)} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>EMAIL</label>
                  <input className="input-field" type="email" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="email@company.com" value={ctxNewEmail} onChange={e => setCtxNewEmail(e.target.value)} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>PHONE</label>
                  <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="+971..." value={ctxNewPhone} onChange={e => setCtxNewPhone(e.target.value)} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>LINKEDIN URL</label>
                  <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="https://linkedin.com/in/..." value={ctxNewLinkedin} onChange={e => setCtxNewLinkedin(e.target.value)} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>INFLUENCE</label>
                  <select className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} value={ctxNewInfluence} onChange={e => setCtxNewInfluence(e.target.value)}>
                    <option value="">Select...</option>
                    <option value="Decision Maker">Decision Maker</option>
                    <option value="High">High</option>
                    <option value="Influencer">Influencer</option>
                    <option value="Champion">Champion</option>
                    <option value="Medium">Medium</option>
                    <option value="Low">Low</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>SOURCE</label>
                  <select className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} value={ctxNewSource} onChange={e => setCtxNewSource(e.target.value)}>
                    <option value="">Select source...</option>
                    {SOURCE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                {isInbound(ctxNewSource) && (
                  <div>
                    <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>CAMPAIGN</label>
                    <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} placeholder="e.g. GITEX 2025" value={ctxNewCampaign} onChange={e => setCtxNewCampaign(e.target.value)} />
                  </div>
                )}
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={createContact} disabled={!ctxNewName.trim() || !ctxNewAccountId || ctxCreating}>
                  {ctxCreating ? '⏳ Creating...' : '🚀 Create Contact'}
                </button>
                <button className="action-btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowNewContact(false)}>Cancel</button>
              </div>
            </div>
          )}

          {/* CSV Import Card */}
          {showContactImport && (
            <div className="card" style={{ borderLeft: '3px solid #7c3aed', marginBottom: 16 }}>
              <div className="card-header">
                <h3>📥 Import Contacts from CSV</h3>
                <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Supported columns: First Name, Last Name, Email, Phone, Role, LinkedIn, Account, Country, Source, Campaign</span>
              </div>
              {!contactCsvRows.length ? (
                <div>
                  <input type="file" accept=".csv" onChange={handleContactCsv} style={{ fontSize: 12, color: 'var(--globant-muted)' }} />
                  <p style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 8 }}>
                    Tip: Column headers must match exactly (case-insensitive). Country is auto-inherited from the account if not specified. Duplicates by email or full name are auto-detected.
                  </p>
                </div>
              ) : (
                <div>
                  {contactImportResult ? (
                    <div style={{ padding: '12px', background: 'rgba(191,215,48,0.08)', borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
                      ✅ Import complete — <strong>{contactImportResult.created}</strong> created{contactImportResult.failed > 0 ? `, ${contactImportResult.failed} failed` : ''}.
                      <button className="action-btn btn-ghost" style={{ fontSize: 11, marginLeft: 12 }} onClick={() => { setContactCsvRows([]); setContactImportResult(null); }}>Import another</button>
                    </div>
                  ) : (
                    <>
                      <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--globant-muted)' }}>
                        {contactCsvRows.length} rows parsed · <span style={{ color: '#ef4444' }}>{contactCsvRows.filter(r => r.isDuplicate).length} exact duplicates</span>{contactCsvRows.filter(r => r.isFuzzy).length > 0 && <> · <span style={{ color: '#f59e0b' }}>{contactCsvRows.filter(r => r.isFuzzy).length} possible duplicates</span></>} · <span style={{ color: 'var(--globant-green)' }}>{contactCsvRows.filter(r => r.selected && !r.isDuplicate).length} to import</span>
                      </div>
                      <div style={{ overflowX: 'auto', marginBottom: 12 }}>
                        <table className="data-table" style={{ fontSize: 11 }}>
                          <thead>
                            <tr>
                              <th style={{ width: 32 }}>
                                <input type="checkbox" checked={contactCsvRows.every(r => r.isDuplicate || r.selected)} onChange={e => setContactCsvRows(rows => rows.map(r => r.isDuplicate ? r : { ...r, selected: e.target.checked }))} />
                              </th>
                              <th>Name</th><th>Account</th><th>Email</th><th>Country</th><th>Source</th><th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {contactCsvRows.map((row, i) => (
                              <tr key={i} style={{ opacity: row.isDuplicate ? 0.45 : 1, background: row.isFuzzy ? 'rgba(251,191,36,0.04)' : 'transparent' }}>
                                <td><input type="checkbox" checked={row.selected && !row.isDuplicate} disabled={row.isDuplicate} onChange={e => setContactCsvRows(rows => rows.map((r, j) => j === i ? { ...r, selected: e.target.checked } : r))} /></td>
                                <td>{row.firstName} {row.lastName}</td>
                                <td>{row.accountName || '—'}</td>
                                <td>{row.email || '—'}</td>
                                <td style={{ fontSize: 11 }}>{row.country ? <span style={{ color: 'var(--globant-muted)' }}>{row.country}</span> : <span style={{ color: 'rgba(255,255,255,0.2)' }}>—</span>}</td>
                                <td>{row.source || '—'}</td>
                                <td>
                                  {row.isDuplicate
                                    ? <span className="badge" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', fontSize: 9 }}>🚫 {row.duplicateReason}</span>
                                    : row.isFuzzy
                                    ? <span className="badge" style={{ background: 'rgba(251,191,36,0.15)', color: '#f59e0b', fontSize: 9 }} title={row.fuzzyReason}>⚠️ {row.fuzzyReason}</span>
                                    : <span className="badge badge-green" style={{ fontSize: 9 }}>✓ New</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={importContacts} disabled={contactImporting || !contactCsvRows.some(r => r.selected && !r.isDuplicate)}>
                          {contactImporting ? '⏳ Importing...' : `🚀 Import ${contactCsvRows.filter(r => r.selected && !r.isDuplicate).length} contacts`}
                        </button>
                        <button className="action-btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setContactCsvRows([]); setContactImportResult(null); }}>↩ Re-upload</button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Contacts Table */}
          <div className="card">
            <div className="card-header">
              <h3>👤 All Contacts ({filtered.length})</h3>
              {(searchName || searchAccount || selectedInfluence) && <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Filtered from {stakeholders.length} total</span>}
            </div>
            {filtered.length === 0 ? (
              <p style={{ color: 'var(--globant-muted)', fontSize: 13, padding: '12px 0' }}>No contacts found. {stakeholders.length === 0 ? 'Add your first contact above.' : 'Try clearing your filters.'}</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Contact</th>
                    <th>Account</th>
                    <th>Influence</th>
                    <th>Source</th>
                    <th style={{ textAlign: 'center' }}>Touches</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(s => {
                    const accNames = resolveLinked(s, 'Account', accounts, 'Account Name');
                    const phone = F(s, 'Phone number');
                    const email = F(s, 'Email');
                    const linkedin = F(s, 'LinkedIn');
                    const touches = outreach.filter(o => linkedIds(o, 'Stakeholder').includes(s.id)).length;
                    const fallback = `Hi ${F(s, 'Name')}, reaching out from ${COMPANY_PROFILE.companyName} regarding potential collaboration.`;
                    return (
                      <tr key={s.id}>
                        <td>
                          <div style={{ fontWeight: 600, cursor: 'pointer', color: 'var(--globant-green)' }} onClick={() => setHistoryStakeholder(s)}>
                            {F(s, 'Name')}{F(s, 'Lart name') ? ` ${F(s, 'Lart name')}` : ''}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--globant-muted)' }}>{F(s, 'Role')}</div>
                        </td>
                        <td style={{ fontSize: 12 }}>{accNames.join(', ')}</td>
                        <td><span className="badge badge-accent">{F(s, 'Level of Influence') || '—'}</span></td>
                        <td>
                          {F(s, 'Source') ? (
                            <span style={{
                              fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10,
                              background: isInbound(F(s, 'Source')) ? 'rgba(124,58,237,0.15)' : 'rgba(191,215,48,0.15)',
                              color: isInbound(F(s, 'Source')) ? '#a78bfa' : 'var(--globant-green)',
                              whiteSpace: 'nowrap'
                            }}>
                              {F(s, 'Source')}
                            </span>
                          ) : <span style={{ color: 'var(--globant-muted)', fontSize: 11 }}>—</span>}
                          {F(s, 'Campaign') && <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 2 }}>{F(s, 'Campaign')}</div>}
                        </td>
                        <td style={{ textAlign: 'center', fontSize: 13 }}>
                          {touches > 0 ? <span style={{ color: 'var(--globant-green)', fontWeight: 700 }}>{touches}</span> : <span style={{ color: 'var(--globant-muted)' }}>—</span>}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            <button className="action-btn btn-primary" style={{ fontSize: 11 }} onClick={() => setSelectedStakeholder(s)}>✨</button>
                            {phone && <button className="action-btn btn-whatsapp" style={{ fontSize: 11, padding: '4px 8px' }} title="WhatsApp" onClick={() => useMessage(s, 'WhatsApp', fallback)}>💬</button>}
                            {email && <button className="action-btn btn-email" style={{ fontSize: 11, padding: '4px 8px' }} title="Email" onClick={() => useMessage(s, 'Email', fallback)}>✉️</button>}
                            {linkedin && <button className="action-btn btn-linkedin" style={{ fontSize: 11, padding: '4px 8px' }} title="LinkedIn" onClick={() => useMessage(s, 'LinkedIn', fallback)}>🔗</button>}
                            {phone && <button className="action-btn btn-call" style={{ fontSize: 11, padding: '4px 8px' }} title="Call" onClick={() => useMessage(s, 'Call', fallback)}>📞</button>}
                            <button title="Edit contact" style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--globant-border)', background: 'rgba(255,255,255,0.04)', color: 'var(--globant-muted)', cursor: 'pointer' }} onClick={() => setEditingContact(s)}>✏️</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {selectedStakeholder && (
            <AIMessageModal stakeholder={selectedStakeholder} onClose={() => setSelectedStakeholder(null)} onSend={useMessage} data={data} />
          )}
          {historyStakeholder && (
            <StakeholderHistoryModal
              stakeholder={historyStakeholder}
              outreach={outreach}
              accounts={accounts}
              onClose={() => setHistoryStakeholder(null)}
              onRefresh={onLogActivity}
              allData={data}
            />
          )}
          {editingContact && (
            <EditModal
              title={`${F(editingContact, 'Name')} ${F(editingContact, 'Lart name') || ''}`.trim()}
              fields={[
                { key: 'Name', label: 'First Name' },
                { key: 'Lart name', label: 'Last Name' },
                { key: 'Role', label: 'Role / Title' },
                { key: 'Email', label: 'Email' },
                { key: 'Phone number', label: 'Phone' },
                { key: 'LinkedIn', label: 'LinkedIn URL' },
                { key: 'Level of Influence', label: 'Influence', type: 'select', options: ['Decision Maker', 'High', 'Influencer', 'Champion', 'Medium', 'Low'] },
                { key: 'Source', label: 'Source', type: 'select', options: SOURCE_OPTIONS },
                { key: 'Campaign', label: 'Campaign (if inbound)' },
              ]}
              initialValues={editingContact.fields || {}}
              onSave={saveContactEdit}
              onClose={() => setEditingContact(null)}
            />
          )}
        </div>
      );
    }

    // ============ ACTIVITY TRACKER ============
    function ActivityTracker({ data, api, onLogActivity, onUpdateRecord, onDeleteRecord }) {
      const { accounts, outreach, stakeholders } = data;
      const [accountSearch, setAccountSearch] = useState('');
      const [selectedChannel, setSelectedChannel] = useState('');
      const [selectedStatus, setSelectedStatus] = useState('');
      const [editingActivity, setEditingActivity] = useState(null);

      const saveActivityEdit = async (updatedFields) => {
        if (!editingActivity || !api) return;
        if (onUpdateRecord) onUpdateRecord('outreach', editingActivity.id, updatedFields);
        setEditingActivity(null);
        try {
          await api.updateRecord(TABLE_IDS.outreach, editingActivity.id, updatedFields);
          if (onLogActivity) onLogActivity();
        } catch (e) {
          console.error('Activity edit error', e);
          alert('Failed to save activity changes');
          if (onLogActivity) onLogActivity();
        }
      };

      const deleteActivity = async (activity) => {
        if (!confirm(`Delete "${F(activity, 'Activity Name') || 'this activity'}"? This cannot be undone.`)) return;
        if (onDeleteRecord) onDeleteRecord('outreach', activity.id);
        const a = api || new AirtableAPI();
        a.deleteRecord(TABLE_IDS.outreach, activity.id).catch(e => { console.error(e); if (onLogActivity) onLogActivity(); });
      };

      // Channel stats
      const byChannel = {};
      outreach.forEach(a => { const ch = F(a, 'Channel'); byChannel[ch] = (byChannel[ch] || 0) + 1; });

      // Unique accounts contacted
      const accountsContacted = new Set();
      outreach.forEach(a => linkedIds(a, 'Account').forEach(id => accountsContacted.add(id)));

      // Unique stakeholders contacted
      const stakeholdersContacted = new Set();
      outreach.forEach(a => linkedIds(a, 'Stakeholder').forEach(id => stakeholdersContacted.add(id)));

      // This week activities
      const now = new Date();
      const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay());
      weekStart.setHours(0, 0, 0, 0);
      const thisWeek = outreach.filter(a => new Date(a.fields?.['Date'] || 0) >= weekStart).length;

      // Today activities
      const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
      const today = outreach.filter(a => new Date(a.fields?.['Date'] || 0) >= todayStart).length;

      // Meetings & Replies
      const meetings = outreach.filter(a => F(a, 'Status') === 'Meeting Scheduled' || F(a, 'Status') === 'Meeting Booked').length;
      const replies = outreach.filter(a => F(a, 'Status') === 'Replied').length;
      const drafts = outreach.filter(a => F(a, 'Status') === 'Draft').length;

      // Filter
      const filtered = useMemo(() => outreach.filter(a => {
        if (accountSearch) {
          const term = accountSearch.toLowerCase();
          const accNames = resolveLinked(a, 'Account', accounts, 'Account Name');
          if (!accNames.some(n => n.toLowerCase().includes(term))) return false;
        }
        if (selectedChannel && F(a, 'Channel') !== selectedChannel) return false;
        if (selectedStatus && F(a, 'Status') !== selectedStatus) return false;
        return true;
      }).sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0)), [outreach, accountSearch, accounts, selectedChannel, selectedStatus]);

      const channelColors = { WhatsApp: '#25D366', Email: '#60a5fa', LinkedIn: '#0A66C2', Call: '#fbbf24' };

      return (
        <div>
          <div className="page-header">
            <h1>Activity Tracker</h1>
            <p>Full outreach performance and engagement log</p>
          </div>

          {/* KPI Dashboard */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 24 }}>
            <div className="card" style={{ textAlign: 'center', padding: '16px 12px', background: 'linear-gradient(135deg, rgba(191,215,48,0.12) 0%, rgba(191,215,48,0.03) 100%)' }}>
              <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--globant-green)', lineHeight: 1 }}>{outreach.length}</div>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Total Activities</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
              <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--globant-info)', lineHeight: 1 }}>{accountsContacted.size}</div>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Accounts Reached</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
              <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--globant-success)', lineHeight: 1 }}>{stakeholdersContacted.size}</div>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Stakeholders</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: '16px 12px', cursor: 'pointer', border: selectedStatus === 'Meeting Scheduled' ? '1px solid #60a5fa' : undefined }} onClick={() => setSelectedStatus(selectedStatus === 'Meeting Scheduled' ? '' : 'Meeting Scheduled')}>
              <div style={{ fontSize: 30, fontWeight: 800, color: '#60a5fa', lineHeight: 1 }}>{meetings}</div>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>📅 Meetings</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: '16px 12px', cursor: 'pointer', border: selectedStatus === 'Replied' ? '1px solid #4ade80' : undefined }} onClick={() => setSelectedStatus(selectedStatus === 'Replied' ? '' : 'Replied')}>
              <div style={{ fontSize: 30, fontWeight: 800, color: '#4ade80', lineHeight: 1 }}>{replies}</div>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>💬 Replies</div>
            </div>
          </div>

          {/* Channel breakdown + recency */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
            <div className="card" style={{ padding: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14, color: 'var(--globant-text)' }}>By Channel</div>
              {['Email', 'WhatsApp', 'LinkedIn', 'Call'].map(ch => {
                const count = byChannel[ch] || 0;
                const pct = outreach.length > 0 ? (count / outreach.length) * 100 : 0;
                return (
                  <div key={ch} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                      <span>{channelIcon[ch]} {ch}</span>
                      <span style={{ fontWeight: 700, color: 'var(--globant-text)' }}>{count}</span>
                    </div>
                    <div style={{ height: 6, borderRadius: 3, background: 'var(--globant-darker)' }}>
                      <div style={{ height: '100%', borderRadius: 3, width: `${pct}%`, background: channelColors[ch], transition: 'width 0.3s' }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--globant-text)' }}>Activity Pulse</div>
              <div style={{ display: 'flex', gap: 16, flex: 1, alignItems: 'center' }}>
                <div style={{ flex: 1, textAlign: 'center', padding: 16, background: 'var(--globant-darker)', borderRadius: 10 }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: today > 0 ? 'var(--globant-green)' : 'var(--globant-warning)' }}>{today}</div>
                  <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 4 }}>Today</div>
                </div>
                <div style={{ flex: 1, textAlign: 'center', padding: 16, background: 'var(--globant-darker)', borderRadius: 10 }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: thisWeek > 0 ? 'var(--globant-info)' : 'var(--globant-warning)' }}>{thisWeek}</div>
                  <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 4 }}>This Week</div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', textAlign: 'center' }}>
                {today === 0 ? '⚡ No activities yet today — time to start!' : today >= 5 ? '🔥 On fire today!' : '👍 Good momentum, keep going!'}
              </div>
            </div>
          </div>

          {/* Filters */}
          <div className="filters-row" style={{ gap: 12 }}>
            <input
              className="input-field"
              style={{ maxWidth: 300 }}
              placeholder="Type to filter by account..."
              value={accountSearch}
              onChange={e => setAccountSearch(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button className={`action-btn ${selectedChannel === '' ? 'btn-primary' : 'btn-ghost'}`} style={{ fontSize: 11 }} onClick={() => setSelectedChannel('')}>All</button>
              {['Email', 'WhatsApp', 'LinkedIn', 'Call'].map(ch => (
                <button key={ch} className={`action-btn ${selectedChannel === ch ? 'btn-primary' : 'btn-ghost'}`} style={{ fontSize: 11 }} onClick={() => setSelectedChannel(selectedChannel === ch ? '' : ch)}>
                  {channelIcon[ch]} {ch}
                </button>
              ))}
            </div>
          </div>

          {/* Activity List */}
          <div className="card">
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>Activity Log</h3>
              <span style={{ fontSize: 12, color: 'var(--globant-muted)' }}>{filtered.length} {filtered.length === 1 ? 'activity' : 'activities'}{accountSearch ? ` matching "${accountSearch}"` : ''}</span>
            </div>
            {filtered.length === 0 && <p style={{ padding: 20, color: 'var(--globant-muted)', textAlign: 'center' }}>No activities found{accountSearch ? ` for "${accountSearch}"` : ''}</p>}
            {filtered.sort((a, b) => new Date(b.fields?.['Date']) - new Date(a.fields?.['Date'])).map(a => {
              const channel = F(a, 'Channel');
              const icon = channelIcon[channel] || '📋';
              const stakeholderNames = resolveLinked(a, 'Stakeholder', stakeholders, 'Name');
              const accountNames = resolveLinked(a, 'Account', accounts, 'Account Name');

              return (
                <div key={a.id} className="log-entry">
                  <div className="log-icon" style={{ background: `${channelColors[channel] || 'rgba(191,215,48,0.15)'}22` }}>{icon}</div>
                  <div className="log-content">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div className="log-title">{F(a, 'Activity Name')}</div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span className={`badge ${F(a, 'Status') === 'Meeting Scheduled' || F(a, 'Status') === 'Meeting Booked' ? 'badge-blue' : F(a, 'Status') === 'Replied' ? 'badge-green' : F(a, 'Status') === 'Draft' ? 'badge-yellow' : 'badge-accent'}`}>{F(a, 'Status') === 'Meeting Scheduled' || F(a, 'Status') === 'Meeting Booked' ? '📅 ' : F(a, 'Status') === 'Replied' ? '💬 ' : ''}{F(a, 'Status')}</span>
                        <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => setEditingActivity(a)}>✏️</button>
                        <button style={{ fontSize: 10, padding: '2px 6px', borderRadius: 5, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', color: '#ef4444', cursor: 'pointer' }} onClick={() => deleteActivity(a)} title="Delete activity">🗑</button>
                      </div>
                    </div>
                    <div className="log-meta">
                      {stakeholderNames.join(', ')} at {accountNames.join(', ')} • {formatDate(a.fields?.['Date'])}
                    </div>
                    {F(a, 'Message') && (
                      <div style={{ fontSize: 12, color: 'var(--globant-text)', marginTop: 8, padding: '8px 12px', background: 'rgba(191,215,48,0.08)', borderRadius: 6, borderLeft: '3px solid var(--globant-accent)', whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>
                        {F(a, 'Message')}
                      </div>
                    )}
                    {F(a, 'Notes') && <p style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 4 }}>{F(a, 'Notes')}</p>}
                  </div>
                </div>
              );
            })}
          </div>

          {editingActivity && (
            <EditModal
              title={`Edit Activity`}
              fields={[
                { key: 'Activity Name', label: 'Activity Name', fullWidth: true },
                { key: 'Channel', label: 'Channel', type: 'select', options: ['Email', 'WhatsApp', 'LinkedIn', 'Call', 'In-person', 'Other'] },
                { key: 'Status', label: 'Status', type: 'select', options: ['Sent', 'Draft', 'Replied', 'Meeting Scheduled', 'Meeting Booked', 'No Reply', 'Bounced'] },
                { key: 'Message', label: 'Message', type: 'textarea', fullWidth: true },
                { key: 'Notes', label: 'Notes', type: 'textarea', fullWidth: true },
              ]}
              initialValues={editingActivity.fields || {}}
              onSave={saveActivityEdit}
              onClose={() => setEditingActivity(null)}
            />
          )}
        </div>
      );
    }

    // ============ CP BRIEFINGS ============
    function CPBriefings({ data, api, onLogActivity, onAddRecord, onUpdateRecord, onDeleteRecord, navigateToAccountId, clearNavigate }) {
      const { accounts, stakeholders, opportunities, actionPlan, outreach, solutions, events } = data;
      const [searchTerm, setSearchTerm] = useState('');
      const [selectedAccountId, setSelectedAccountId] = useState('');

      // Handle navigation from other pages
      useEffect(() => {
        if (navigateToAccountId) {
          setSelectedAccountId(navigateToAccountId);
          setSearchTerm('');
          if (clearNavigate) clearNavigate();
        }
      }, [navigateToAccountId, clearNavigate]);
      const [talkingPoints, setTalkingPoints] = useState('');
      const [loadingTP, setLoadingTP] = useState(false);
      const EXEC_SUMMARY_LS_KEY = 'oike_exec_summaries';
      const [execSummaryData, setExecSummaryData] = useState(() => {
        try { return JSON.parse(localStorage.getItem(EXEC_SUMMARY_LS_KEY) || '{}'); } catch { return {}; }
      });
      const [loadingSummary, setLoadingSummary] = useState(false);
      const execSummaryEntry = selectedAccountId ? (execSummaryData[selectedAccountId] || null) : null;
      const execSummary = execSummaryEntry?.text || '';
      const execSummaryUpdatedAt = execSummaryEntry?.updatedAt || null;
      const setExecSummary = (text) => {
        const updatedAt = new Date().toISOString();
        setExecSummaryData(prev => {
          const next = { ...prev, [selectedAccountId]: { text, updatedAt } };
          try { localStorage.setItem(EXEC_SUMMARY_LS_KEY, JSON.stringify(next)); } catch {}
          return next;
        });
      };
      const [historyStakeholder, setHistoryStakeholder] = useState(null);
      const [editingNotes, setEditingNotes] = useState(false);
      const [notesValue, setNotesValue] = useState('');
      const [savingNotes, setSavingNotes] = useState(false);
      const [contactRecs, setContactRecs] = useState('');
      const [loadingRecs, setLoadingRecs] = useState(false);
      const [stakeholderSearch, setStakeholderSearch] = useState('');
      const [filterSolutionId, setFilterSolutionId] = useState('');
      const [filterIndustry, setFilterIndustry] = useState('');
      const [filterCountry, setFilterCountry] = useState('');
      const [editingOpp, setEditingOpp] = useState(null);   // null | { opp: record | null, isNew: bool }
      const [oppForm, setOppForm] = useState({});
      const [oppFormSolIds, setOppFormSolIds] = useState([]);
      const [savingOppForm, setSavingOppForm] = useState(false);
      const [cpSelectedStakeholder, setCpSelectedStakeholder] = useState(null);
      const [cpMeetingModal, setCpMeetingModal] = useState(null);
      const [cpMeetingNotes, setCpMeetingNotes] = useState('');
      const [cpMeetingDate, setCpMeetingDate] = useState('');
      const [cpMeetingTime, setCpMeetingTime] = useState('');
      const [cpCallModal, setCpCallModal] = useState(null);
      const [cpCallNotes, setCpCallNotes] = useState('');
      const [showAccImport, setShowAccImport] = useState(false);
      const [accCsvRows, setAccCsvRows] = useState([]);
      const [accImporting, setAccImporting] = useState(false);
      const [accImportResult, setAccImportResult] = useState(null);
      const [uploadingFile, setUploadingFile] = useState(false);
      const [showSolPicker, setShowSolPicker] = useState(false);
      const [newSolName, setNewSolName] = useState('');
      const [creatingSol, setCreatingSol] = useState(false);
      const [selectedOppId, setSelectedOppId] = useState('');
      const [oppNotes, setOppNotes] = useState('');
      const [editingOppNotes, setEditingOppNotes] = useState(false);
      const [savingOppNotes, setSavingOppNotes] = useState(false);
      const [oppNextStep, setOppNextStep] = useState('');
      const [oppStakeholder, setOppStakeholder] = useState('');
      const [showAddOppStk, setShowAddOppStk] = useState(false);
      const [newOppStkName, setNewOppStkName] = useState('');
      const [newOppStkRole, setNewOppStkRole] = useState('');
      const [creatingOppStk, setCreatingOppStk] = useState(false);
      const [oppSolutionIds, setOppSolutionIds] = useState([]);
      const [removingSol, setRemovingSol] = useState(null);
      const [showNewAccount, setShowNewAccount] = useState(false);
      const [newAccName, setNewAccName] = useState('');
      const [newAccWebsite, setNewAccWebsite] = useState('');
      const [creatingAcc, setCreatingAcc] = useState(false);
      const [showNewStakeholder, setShowNewStakeholder] = useState(false);
      const [newStkName, setNewStkName] = useState('');
      const [newStkLastName, setNewStkLastName] = useState('');
      const [newStkRole, setNewStkRole] = useState('');
      const [newStkEmail, setNewStkEmail] = useState('');
      const [newStkPhone, setNewStkPhone] = useState('');
      const [newStkLinkedin, setNewStkLinkedin] = useState('');
      const [newStkInfluence, setNewStkInfluence] = useState('');
      const [creatingStk, setCreatingStk] = useState(false);
      const [bulkPainLoading, setBulkPainLoading] = useState(false);
      const [bulkPainProgress, setBulkPainProgress] = useState('');
      const [editingAccount, setEditingAccount] = useState(null);
      const now = new Date();

      const saveAccountEdit = async (updatedFields) => {
        if (!editingAccount || !api) return;
        if (onUpdateRecord) onUpdateRecord('accounts', editingAccount.id, updatedFields);
        setEditingAccount(null);
        try {
          await api.updateRecord(TABLE_IDS.accounts, editingAccount.id, updatedFields);
          if (onLogActivity) onLogActivity();
        } catch (e) {
          console.error('Account edit error', e);
          alert('Failed to save account changes');
          if (onLogActivity) onLogActivity();
        }
      };

      const mappedAccounts = useMemo(() => accounts.filter(a => linkedIds(a, 'Stakeholders').length > 0), [accounts]);
      const filteredAccounts = useMemo(() => {
        let list = searchTerm
          ? accounts.filter(a => (F(a, 'Account Name') || '').toLowerCase().includes(searchTerm.toLowerCase()))
          : [...mappedAccounts].sort((a, b) => (F(a, 'Account Name') || '').localeCompare(F(b, 'Account Name') || ''));
        if (filterSolutionId) {
          list = list.filter(a => linkedIds(a, 'Solutions').includes(filterSolutionId));
        }
        if (filterIndustry) {
          list = list.filter(a => (F(a, 'Industry') || '') === filterIndustry);
        }
        if (filterCountry) {
          list = list.filter(a => (F(a, 'Country') || '') === filterCountry);
        }
        return list;
      }, [accounts, mappedAccounts, searchTerm, filterSolutionId, filterIndustry, filterCountry]);

      const account = selectedAccountId ? accounts.find(a => a.id === selectedAccountId) : null;

      // Account data
      const name = account ? F(account, 'Account Name') : '';
      const accStakeholderIds = account ? linkedIds(account, 'Stakeholders') : [];
      const accStakeholders = accStakeholderIds.map(id => stakeholders.find(s => s.id === id)).filter(Boolean);
      const accOutreach = useMemo(() => {
        if (!account) return [];
        return outreach.filter(o => linkedIds(o, 'Account').includes(account.id))
          .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
      }, [account, outreach]);
      const opps = account ? opportunities.filter(o => linkedIds(o, 'Account').includes(account.id)) : [];
      const actions = account ? actionPlan.filter(a => linkedIds(a, 'Cuenta').includes(account.id)) : [];
      const solNames = account ? resolveLinked(account, 'Solutions', solutions, 'Name') : [];
      const recentNews = account ? F(account, 'Recent News') : '';
      const intelPlan = account ? F(account, 'Inside sales plan') : '';
      const intelNotes = account ? (F(account, 'Intel Notes') || '') : '';
      const upcomingEventsAI = account ? (F(account, 'Opcoming events') || '') : '';
      const upcomingEventsText = typeof upcomingEventsAI === 'string' ? upcomingEventsAI : String(upcomingEventsAI || '');

      const saveIntelNotes = async () => {
        if (!api || !account) return;
        setSavingNotes(true);
        try {
          await api.updateRecord(TABLE_IDS.accounts, account.id, { 'Intel Notes': notesValue });
          setEditingNotes(false);
          if (onLogActivity) onLogActivity();
        } catch (e) {
          console.error(e);
          alert('Failed to save Intel Notes');
        }
        setSavingNotes(false);
      };

      const newsItems = useMemo(() => {
        if (!recentNews || typeof recentNews !== 'string') return [];
        const raw = recentNews.split(/\n+/).map(l => l.trim()).filter(l => l.length > 3);
        // Parse into structured news items: { title, body, source }
        const items = [];
        let current = null;
        const cleanMd = (s) => s.replace(/^\.\s*/, '').replace(/\*\*/g, '').replace(/^[-•*\d.]+\s*/, '').trim();
        const isLink = (s) => /^\[Read more\]|^\[Source\]|^\[Link\]|^https?:\/\//i.test(s.trim());
        const extractUrl = (s) => { const m = s.match(/\((https?:\/\/[^)]+)\)/); return m ? m[1] : s.match(/(https?:\/\/\S+)/)?.[1] || ''; };
        const isTitle = (s) => {
          const c = cleanMd(s);
          return c.length > 10 && c.length < 200 && (/\*\*/.test(s) || /^[A-Z]/.test(c));
        };
        for (const line of raw) {
          if (isLink(cleanMd(line))) {
            if (current) current.source = extractUrl(line);
            continue;
          }
          const cleaned = cleanMd(line);
          if (!cleaned || cleaned.length < 5) continue;
          // Check if this looks like a new headline (short-ish, starts with caps or was bold)
          if (isTitle(line) && cleaned.length < 120) {
            // If we already have a title with no body and this also looks like a title, check for dups
            if (current) items.push(current);
            current = { title: cleaned, body: '', source: '' };
          } else if (current && !current.body) {
            current.body = cleaned;
          } else if (!current) {
            current = { title: cleaned, body: '', source: '' };
          }
        }
        if (current) items.push(current);
        // Deduplicate by checking title similarity
        const seen = new Set();
        const unique = items.filter(item => {
          const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return unique.slice(0, 5);
      }, [recentNews]);
      // Keep newsLines for backward compat with talking points prompt
      const newsLines = newsItems.map(n => `${n.title}${n.body ? ': ' + n.body : ''}`);

      // Upcoming events for this account
      const accEvents = useMemo(() => {
        if (!account) return [];
        return events.filter(ev => {
          const start = ev.fields?.['Starting'] ? new Date(ev.fields['Starting']) : null;
          if (!start || start < now) return false;
          const invitedIds = linkedIds(ev, 'Stakeholders invited');
          return accStakeholderIds.some(sid => invitedIds.includes(sid));
        });
      }, [account, events, accStakeholderIds]);

      // Engagement timeline per stakeholder
      const stakeholderEngagement = useMemo(() => {
        if (!account) return [];
        return accStakeholders.map(s => {
          const sName = F(s, 'Name') + (F(s, 'Lart name') ? ` ${F(s, 'Lart name')}` : '');
          const sOutreach = outreach.filter(o => linkedIds(o, 'Stakeholder').includes(s.id))
            .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
          const lastTouch = sOutreach[0] || null;
          const daysSince = lastTouch ? Math.floor((now - new Date(lastTouch.fields?.['Date'])) / (1000*60*60*24)) : null;
          const hasReplied = sOutreach.some(o => F(o, 'Status') === 'Replied');
          const hasMeeting = sOutreach.some(o => F(o, 'Status') === 'Meeting Scheduled');
          return { s, sName, sOutreach, lastTouch, daysSince, hasReplied, hasMeeting, totalTouches: sOutreach.length };
        }).sort((a, b) => {
          // Oldest outreach first: never contacted → longest since last touch → most recent
          return (b.daysSince ?? 999) - (a.daysSince ?? 999);
        });
      }, [account, accStakeholders, outreach]);

      // Bulk generate pain points for all stakeholders
      const bulkGeneratePainPoints = async () => {
        const atKey = localStorage?.getItem?.('at_key');
        const targets = stakeholderEngagement.filter(e => {
          const existing = F(e.s, 'Pain Points (Generated)') || '';
          return !existing || existing.length < 10;
        });

        if (targets.length === 0) {
          alert('All stakeholders already have pain points generated. To regenerate, clear them in Airtable first.');
          return;
        }

        setBulkPainLoading(true);
        const a = new AirtableAPI();
        const accName = account ? F(account, 'Account Name') : '';
        const accIndustry = account ? F(account, 'Industry') : '';
        const accFocus = account ? (Array.isArray(F(account, 'Service / Focus')) ? F(account, 'Service / Focus').join(', ') : F(account, 'Service / Focus') || '') : '';
        const accNews = account ? ((F(account, 'Recent News') || '').toString().slice(0, 300)) : '';

        let done = 0;
        for (const eng of targets) {
          done++;
          const sFullName = eng.sName;
          const sRole = F(eng.s, 'Role') || '';
          setBulkPainProgress(`${done}/${targets.length}: ${sFullName}`);
          try {
            const prompt = `You are a B2B sales research analyst. Analyze this stakeholder and identify their likely pain points.

STAKEHOLDER: ${sFullName}
ROLE: ${sRole}
COMPANY: ${accName}
INDUSTRY: ${accIndustry}
SERVICE FOCUS: ${accFocus || 'Not defined'}
RECENT COMPANY NEWS: ${accNews || 'Not available'}

Generate 3-5 specific, actionable pain points for this person based on their role and industry context. Each pain point should:
- Be specific to their role (not generic)
- Reference industry challenges they likely face
- Connect to areas where ${COMPANY_PROFILE.companyName} (${COMPANY_PROFILE.services}) could help

Format as bullet points. Be concise (1-2 sentences each). Write ONLY the pain points, no intro or summary.`;

            const generated = await callOpenAI({ prompt, temperature: 0.7, max_tokens: 400 });
            if (!eng.s.id.startsWith('tmp_')) {
              await a.updateRecord(TABLE_IDS.stakeholders, eng.s.id, { 'Pain Points (Generated)': generated })
                .catch(e => console.warn(`Could not save pain points for ${sFullName}:`, e.message));
            }
          } catch (e) {
            console.error(`Failed for ${sFullName}:`, e);
          }
          // Small delay to avoid rate limits
          if (done < targets.length) await new Promise(r => setTimeout(r, 500));
        }
        setBulkPainLoading(false);
        setBulkPainProgress('');
        if (onLogActivity) onLogActivity();
      };

      // Generate Executive Summary
      const generateExecSummary = async () => {
        setLoadingSummary(true);
        try {
          const newsStr = newsLines.slice(0, 5).join('\n') || 'No recent news';
          const oppStr = opps.map(o => `- ${F(o, 'Deal/Opp name')}: Stage=${F(o, 'Stage')}, Value=${o.fields?.['Value'] || 'N/A'}, Next step=${F(o, 'Next step') || 'N/A'}, Stakeholder=${F(o, 'Stakeholders') || 'N/A'}`).join('\n') || 'No opportunities';
          const solStr = solNames.join(', ') || 'None mapped';
          const stSummary = stakeholderEngagement.map(e => {
            const pain = F(e.s, 'Pain Points (Generated)') || F(e.s, 'Pain points') || '';
            const painStr = typeof pain === 'string' ? pain.slice(0, 100) : '';
            const status = e.hasMeeting ? 'Meeting' : e.hasReplied ? 'Replied' : e.totalTouches > 0 ? `${e.totalTouches}x, no reply` : 'Not contacted';
            return `- ${e.sName} (${F(e.s, 'Role')}, ${F(e.s, 'Level of Influence') || '?'}) — ${status}${painStr ? ` | Pain: ${painStr}` : ''}`;
          }).join('\n') || 'No stakeholders';
          const eventsStr = (data.events || []).filter(ev => {
            const invitedIds = linkedIds(ev, 'Stakeholders invited');
            return accStakeholderIds.some(sid => invitedIds.includes(sid));
          }).map(ev => `- ${F(ev, 'Event Name')} (${ev.fields?.['Starting'] ? new Date(ev.fields['Starting']).toLocaleDateString('en-US', {month:'short',day:'numeric'}) : '?'})`).join('\n') || 'None';
          const upcomingEvAI = account ? (F(account, 'Opcoming events') || '') : '';
          const upcomingEvStr = typeof upcomingEvAI === 'string' ? upcomingEvAI.slice(0, 300) : '';

          const prompt = `You are a senior B2B sales strategist. Create a concise EXECUTIVE SUMMARY for this account to brief a BDR before prospecting.

ACCOUNT: ${name}
INDUSTRY: ${F(account, 'Industry') || 'N/A'}
TIER: ${F(account, 'Tier') || 'N/A'}
SERVICE FOCUS: ${Array.isArray(F(account, 'Service / Focus')) ? F(account, 'Service / Focus').join(', ') : F(account, 'Service / Focus') || 'N/A'}

RECENT NEWS:
${newsStr}

INTEL NOTES (BDR first-hand context):
${intelNotes || 'None'}

SOLUTIONS MAPPED: ${solStr}

OPPORTUNITIES:
${oppStr}

STAKEHOLDER MAP:
${stSummary}

COMPANY EVENTS INTEL:
${upcomingEvStr || 'None'}

EVENTS WITH INVITED STAKEHOLDERS:
${eventsStr}

Write the Executive Summary with these sections (use ### headers):

### 🏢 Account Snapshot
2-3 sentences: What does this company do, what's their current situation based on news, and why are they relevant for ${COMPANY_PROFILE.companyName}.

### 🎯 Strategic Angle
2-3 sentences: What's the best entry point for ${COMPANY_PROFILE.companyName}? Which solutions/services are most relevant and why? What pain points or triggers should we leverage?

### 📊 Pipeline Status
2-3 sentences: Current state of opportunities, what stage they're in, blockers, and what needs to happen next to advance them.

### 👥 Relationship Map
2-3 sentences: Who are our key contacts, who's engaged, who's cold, and who's missing from the map. Where are the gaps?

### ⚡ Immediate Actions
3-4 bullet points: Specific things to do THIS WEEK. Be concrete — name stakeholders, suggest channels, reference triggers.

Be specific. Use names. No generic advice. Under 300 words total.`;

          setExecSummary(await callOpenAI({ prompt, temperature: 0.7, max_tokens: 700 }) || 'Could not generate summary.');
        } catch (e) {
          console.error(e);
          alert('Failed to generate. Error: ' + (e.message || 'unknown error'));
        }
        setLoadingSummary(false);
      };

      // Generate AI talking points
      const generateTalkingPoints = async () => {
        setLoadingTP(true);
        try {
          const stakeholderSummary = stakeholderEngagement.map(e => {
            const pain = F(e.s, 'Pain Points (Generated)') || F(e.s, 'Pain points') || 'Unknown';
            const status = e.hasMeeting ? 'Meeting Scheduled' : e.hasReplied ? 'Replied' : e.totalTouches > 0 ? `Contacted ${e.totalTouches}x, no reply` : 'Not contacted';
            return `- ${e.sName} (${F(e.s, 'Role')}): Pain points: ${typeof pain === 'string' ? pain.slice(0, 150) : pain}. Status: ${status}`;
          }).join('\n');

          const oppSummary = opps.map(o => `- ${F(o, 'Deal/Opp name')}: Stage=${F(o, 'Stage')}, Value=${o.fields?.['Value'] || 'N/A'}, Angle=${F(o, 'Suggested Angle') || 'N/A'}`).join('\n');

          const prompt = `You are a sales strategist preparing a Client Partner for meetings with ${name}.

ACCOUNT CONTEXT:
- Industry: ${F(account, 'Industry') || 'N/A'}
- Tier: ${F(account, 'Tier') || 'N/A'}
- Solutions mapped: ${solNames.join(', ') || 'None yet'}
- Service Focus: ${F(account, 'Service / Focus') || 'N/A'}

RECENT NEWS:
${newsLines.slice(0, 5).join('\n') || 'No recent news available'}

STAKEHOLDERS:
${stakeholderSummary || 'No stakeholders mapped'}

OPPORTUNITIES:
${oppSummary || 'No opportunities registered'}

EXECUTIVE SUMMARY:
${execSummary ? execSummary.slice(0, 600) : 'Not generated yet — use news, stakeholders, and opps context above'}

INTEL NOTES (recent context from BDR):
${intelNotes ? intelNotes.slice(0, 400) : 'No additional notes'}

Generate exactly 4 TALKING POINTS for the Client Partner. Each should:
1. Reference a specific stakeholder by name and their pain point
2. Connect it to a ${COMPANY_PROFILE.companyName} capability or the mapped solution
3. Be actionable — what to say or ask in the meeting
4. Use recent news if relevant as a conversation hook

Format each as:
🎯 [Stakeholder Name] — [Topic]
[2-3 sentences of what to say/ask and why]

Be specific, not generic. The CP needs to sound informed and prepared.`;

          setTalkingPoints(await callOpenAI({ prompt, temperature: 0.7, max_tokens: 600 }) || 'Could not generate talking points.');
        } catch (e) {
          console.error(e);
          alert('Failed to generate talking points. Error: ' + (e.message || 'unknown error'));
        }
        setLoadingTP(false);
      };

      // Generate "Who to Contact" AI recommendations
      const generateContactRecs = async () => {
        setLoadingRecs(true);
        try {
          const stakeholderSummary = stakeholderEngagement.length > 0
            ? stakeholderEngagement.map(e => {
                const pain = F(e.s, 'Pain Points (Generated)') || F(e.s, 'Pain points') || 'Unknown';
                const painStr = typeof pain === 'string' ? pain.slice(0, 120) : String(pain).slice(0, 120);
                const status = e.hasMeeting ? 'Meeting Scheduled' : e.hasReplied ? 'Replied' : e.totalTouches > 0 ? `Contacted ${e.totalTouches}x (last ${e.daysSince}d ago), no reply` : 'Never contacted';
                const influence = F(e.s, 'Level of Influence') || 'Unknown';
                return `- ${e.sName} | ${F(e.s, 'Role')} | Influence: ${influence} | Status: ${status} | Pain: ${painStr}`;
              }).join('\n')
            : 'NO STAKEHOLDERS MAPPED YET';

          const oppSummary = opps.length > 0
            ? opps.map(o => `- ${F(o, 'Deal/Opp name')}: Stage=${F(o, 'Stage')}, Angle=${F(o, 'Suggested Angle') || 'N/A'}`).join('\n')
            : 'No opportunities yet';

          const industry = account ? F(account, 'Industry') : '';
          const focusRaw = account ? F(account, 'Service / Focus') : '';
          const focusStr = Array.isArray(focusRaw) ? focusRaw.join(', ') : focusRaw || '';
          const newsStr = typeof recentNews === 'string' ? recentNews.slice(0, 400) : '';
          const planStr = typeof intelPlan === 'string' ? intelPlan.slice(0, 300) : '';

          const prompt = `You are a senior B2B sales strategist advising a BDR (Business Development Representative) at ${COMPANY_PROFILE.companyName} (${COMPANY_PROFILE.services}) who is prospecting ${name} in the ${industry || 'enterprise'} sector.

ACCOUNT CONTEXT:
- Company: ${name}
- Industry: ${industry || 'N/A'}
- Service Focus: ${focusStr || 'N/A'}
- Recent News: ${newsStr || 'None available'}
- Executive Summary: ${execSummary ? execSummary.slice(0, 500) : 'Not generated'}
- Intel Notes: ${intelNotes || 'None'}
- Solutions mapped: ${solNames.length > 0 ? solNames.join(', ') : 'None yet'}

CURRENT STAKEHOLDERS:
${stakeholderSummary}

PIPELINE:
${oppSummary}

Based on ALL this context, provide actionable outreach recommendations:

1. **PRIORITY CONTACTS** — Which existing stakeholders should be contacted NEXT and WHY? Consider: who hasn't been touched recently, who replied but no meeting yet, who has high influence but no contact. For each, give a specific reason and suggested approach (channel + angle).

2. **MISSING ROLES** — What roles/titles are MISSING from the stakeholder map that would be critical to advance this deal? Think about typical decision-making units for ${industry || 'enterprise'} companies buying digital transformation / AI / CX services. Suggest specific titles to search for on LinkedIn.

3. **RE-ENGAGEMENT** — Any stakeholders that went cold? Suggest a creative re-engagement tactic with a specific hook based on recent news or pain points.

4. **TIMING & TRIGGERS** — Based on news, industry context, or events, is there an urgency trigger we should leverage NOW?

Be specific, direct, and actionable. No generic advice. Use names when referring to existing stakeholders. Format with clear sections and bullet points. Keep it under 400 words.`;

          setContactRecs(await callOpenAI({ prompt, temperature: 0.7, max_tokens: 700 }) || 'No recommendations generated.');
        } catch (e) {
          console.error(e);
          alert('Failed to generate. Error: ' + (e.message || 'unknown error'));
        }
        setLoadingRecs(false);
      };

      // CP Briefings: log meeting
      const cpLogMeeting = async (stakeholder, notes, date) => {
        const sn = F(stakeholder, 'Name') || '';
        const companyIds = linkedIds(stakeholder, 'Account');
        try {
          const a = api || new AirtableAPI();
          await a.createRecord(TABLE_IDS.outreach, {
            'Activity Name': `Meeting Scheduled: ${sn} — ${new Date().toLocaleDateString('en-US')}`,
            'Account': companyIds, 'Stakeholder': [stakeholder.id],
            'Channel': 'Call', 'Date': new Date().toISOString(),
            'Status': 'Meeting Scheduled', 'Message': notes || '',
            'Notes': `Meeting ${date ? `on ${date}` : 'TBD'} — logged from CP Briefings`,
            'Logged By': CURRENT_USER?.name || '',
            'BDR Owner': CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '',
            'CP Assigned': CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '',
          });
          await activateAccountIfNeeded(a, companyIds, data.accounts);
          if (onLogActivity) onLogActivity();
        } catch (e) { console.error('Log meeting failed:', e); }
      };

      // CP Briefings: log call
      const cpLogCall = async (stakeholder, notes) => {
        const sn = F(stakeholder, 'Name') || '';
        const companyIds = linkedIds(stakeholder, 'Account');
        try {
          const a = api || new AirtableAPI();
          await a.createRecord(TABLE_IDS.outreach, {
            'Activity Name': `Call with ${sn} — ${new Date().toLocaleDateString('en-US')}`,
            'Account': companyIds, 'Stakeholder': [stakeholder.id],
            'Channel': 'Call', 'Date': new Date().toISOString(),
            'Status': 'Sent', 'Message': notes || '',
            'Notes': `Call logged from CP Briefings`,
            'Logged By': CURRENT_USER?.name || '',
            'BDR Owner': CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '',
            'CP Assigned': CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '',
          });
          await activateAccountIfNeeded(a, companyIds, data.accounts);
          if (onLogActivity) onLogActivity();
        } catch (e) { console.error('Log call failed:', e); }
      };

      // CP Briefings: use message (send + log)
      const cpUseMessage = async (stakeholder, channel, message, ccList = []) => {
        const sn = F(stakeholder, 'Name') || '';
        const email = F(stakeholder, 'Email') || '';
        const phone = F(stakeholder, 'Phone number') || '';
        const linkedin = F(stakeholder, 'LinkedIn') || '';
        let subject = '', body = message;
        if (channel === 'Email' && message.startsWith('Subject:')) {
          const lines = message.split('\n');
          subject = lines[0].replace('Subject:', '').trim();
          body = lines.slice(1).join('\n').trim();
        }
        const ccParam = (channel === 'Email' && ccList.length > 0) ? `&cc=${encodeURIComponent(ccList.join(','))}` : '';
        if (channel === 'WhatsApp' && phone) window.open(`https://wa.me/${String(phone).replace(/[^0-9+]/g, '')}?text=${encodeURIComponent(message)}`, '_blank');
        else if (channel === 'Email' && email) window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}${ccParam}`, '_blank');
        else if (channel === 'LinkedIn' && linkedin) { navigator.clipboard.writeText(message).catch(() => {}); window.open(linkedin, '_blank'); }
        else if (channel === 'Call' && phone) window.open(`tel:${phone}`, '_self');

        const companyIds = linkedIds(stakeholder, 'Account');
        try {
          const a = api || new AirtableAPI();
          await a.createRecord(TABLE_IDS.outreach, {
            'Activity Name': `${channel} to ${sn} — ${new Date().toLocaleDateString('en-US')}`,
            'Account': companyIds, 'Stakeholder': [stakeholder.id],
            'Channel': channel, 'Date': new Date().toISOString(),
            'Status': 'Sent', 'Message': message || '',
            'Notes': `Auto-logged from CP Briefings`,
            'Logged By': CURRENT_USER?.name || '',
            'BDR Owner': CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '',
            'CP Assigned': CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '',
          });
          await activateAccountIfNeeded(a, companyIds, data.accounts);
          if (onLogActivity) onLogActivity();
        } catch (e) { console.error('Auto-log failed:', e); }
      };

      // Manual Account Creation
      const createAccount = async () => {
        if (!newAccName.trim()) return;
        const exists = accounts.some(a => (F(a, 'Account Name') || '').toLowerCase() === newAccName.trim().toLowerCase());
        if (exists) { alert('Account already exists!'); return; }
        const fields = { 'Account Name': newAccName.trim() };
        if (newAccWebsite.trim()) fields['Website'] = newAccWebsite.trim();
        // Optimistic: show instantly
        if (onAddRecord) onAddRecord('accounts', fields);
        setNewAccName(''); setNewAccWebsite(''); setShowNewAccount(false);
        // API in background
        const a = api || new AirtableAPI();
        a.createRecord(TABLE_IDS.accounts, fields)
          .then(() => { if (onLogActivity) onLogActivity(); })
          .catch(e => { console.error(e); alert('Failed to create account'); if (onLogActivity) onLogActivity(); });
      };

      // Manual Stakeholder Creation
      const createStakeholder = async () => {
        if (!newStkName.trim() || !account) return;
        const fields = { 'Name': newStkName.trim(), 'Account': [account.id] };
        if (newStkLastName.trim()) fields['Lart name'] = newStkLastName.trim();
        if (newStkRole.trim()) fields['Role'] = newStkRole.trim();
        if (newStkEmail.trim()) fields['Email'] = newStkEmail.trim();
        if (newStkPhone.trim()) fields['Phone number'] = newStkPhone.trim();
        if (newStkLinkedin.trim()) fields['LinkedIn'] = newStkLinkedin.trim();
        if (newStkInfluence) fields['Level of Influence'] = newStkInfluence;
        fields['BDR Owner'] = CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '';
        fields['CP Assigned'] = CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '';
        // Optimistic: show instantly
        if (onAddRecord) onAddRecord('stakeholders', fields);
        setNewStkName(''); setNewStkLastName(''); setNewStkRole(''); setNewStkEmail('');
        setNewStkPhone(''); setNewStkLinkedin(''); setNewStkInfluence(''); setShowNewStakeholder(false);
        // API in background
        const a = api || new AirtableAPI();
        a.createRecord(TABLE_IDS.stakeholders, fields)
          .then(() => { if (onLogActivity) onLogActivity(); })
          .catch(e => { console.error(e); alert('Failed to create stakeholder'); if (onLogActivity) onLogActivity(); });
      };

      // CSV Account Import
      const handleAccCsv = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (result) => {
            const rows = result.data.map(row => {
              const norm = {};
              Object.keys(row).forEach(k => {
                const kl = k.toLowerCase().trim();
                if (kl.includes('name') || kl.includes('nombre') || kl.includes('account') || kl.includes('company') || kl.includes('empresa')) norm.name = row[k]?.trim();
                if (kl.includes('website') || kl.includes('web') || kl.includes('url') || kl.includes('sitio')) norm.website = row[k]?.trim();
              });
              return norm;
            }).filter(r => r.name);
            // Duplicate detection (exact + fuzzy)
            const existingAccNames = accounts.map(a => F(a, 'Account Name') || '');
            const enriched = rows.map(r => {
              const rLow = r.name.toLowerCase();
              const exactMatch = existingAccNames.some(n => n.toLowerCase() === rLow);
              if (exactMatch) return { ...r, isDuplicate: true, duplicateReason: 'Name exists', selected: false };
              const fuzzyMatch = existingAccNames.find(n => strSimilarity(n, r.name) >= 0.75);
              if (fuzzyMatch) return { ...r, isDuplicate: false, isFuzzy: true, fuzzyReason: `Similar to "${fuzzyMatch}"`, selected: true };
              return { ...r, isDuplicate: false, isFuzzy: false, selected: true };
            });
            setAccCsvRows(enriched);
            setAccImportResult(null);
          }
        });
      };

      const importAccounts = async () => {
        const toImport = accCsvRows.filter(r => r.selected && !r.isDuplicate);
        if (!toImport.length) return;
        setAccImporting(true);
        let created = 0, failed = 0;
        const a = api || new AirtableAPI();
        for (const row of toImport) {
          try {
            const fields = { 'Account Name': row.name };
            if (row.website) fields['Website'] = row.website;
            await a.createRecord(TABLE_IDS.accounts, fields);
            created++;
            await new Promise(r => setTimeout(r, 250));
          } catch (e) { failed++; console.error(e); }
        }
        setAccImportResult({ created, failed });
        setAccImporting(false);
        if (onLogActivity) onLogActivity();
      };

      // File upload for Intel Notes
      const handleFileUpload = async (e) => {
        const file = e.target.files[0];
        if (!file || !account) return;
        setUploadingFile(true);
        try {
          let content = '';
          if (file.name.endsWith('.csv') || file.name.endsWith('.tsv')) {
            content = await file.text();
          } else if (file.name.endsWith('.json')) {
            content = await file.text();
          } else {
            content = await file.text();
          }
          const truncated = content.slice(0, 4000);

          const prompt = `You are a B2B sales intelligence analyst. Summarize the key insights from this file that are relevant for selling digital transformation, AI, CX, and data services to ${name}.

FILE NAME: ${file.name}
FILE CONTENT:
${truncated}

Provide:
1. A brief summary (2-3 sentences) of what this file contains
2. Key insights relevant for sales outreach (3-5 bullet points)
3. Any specific names, roles, pain points, or opportunities mentioned

Be concise and actionable. Focus on what's useful for a BDR prospecting this account.`;

          const summary = await callOpenAI({ prompt, temperature: 0.5, max_tokens: 500 });

          const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
          const newEntry = `\n\n📎 FILE: ${file.name} (uploaded ${dateStr})\n${summary}`;
          const updatedNotes = (intelNotes || '') + newEntry;

          const atApi = api || new AirtableAPI();
          await atApi.updateRecord(TABLE_IDS.accounts, account.id, { 'Intel Notes': updatedNotes });
          if (onLogActivity) onLogActivity();
        } catch (e) {
          console.error(e);
          alert('Failed to process file. Check OpenAI API key.');
        }
        setUploadingFile(false);
        e.target.value = '';
      };

      // Solution management
      const currentSolIds = account ? linkedIds(account, 'Solutions') : [];
      const allSolutions = data.solutions || [];
      const availableSolutions = allSolutions.filter(s => !currentSolIds.includes(s.id));

      const addSolutionToAccount = async (solId) => {
        if (!account) return;
        try {
          const a = api || new AirtableAPI();
          await a.updateRecord(TABLE_IDS.accounts, account.id, { 'Solutions': [...currentSolIds, solId] });
          if (onLogActivity) onLogActivity();
        } catch (e) { console.error(e); alert('Failed to add solution'); }
      };

      const removeSolutionFromAccount = async (solId) => {
        if (!account) return;
        setRemovingSol(solId);
        try {
          const a = api || new AirtableAPI();
          await a.updateRecord(TABLE_IDS.accounts, account.id, { 'Solutions': currentSolIds.filter(id => id !== solId) });
          if (onLogActivity) onLogActivity();
        } catch (e) { console.error(e); alert('Failed to remove solution'); }
        setRemovingSol(null);
      };

      const createNewSolution = async () => {
        if (!newSolName.trim() || !account) return;
        setCreatingSol(true);
        try {
          const a = api || new AirtableAPI();
          const newRec = await a.createRecord(TABLE_IDS.solutions, {
            'Name': newSolName.trim(),
            'BDR Owner': CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '',
            'CP Assigned': CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '',
          });
          if (newRec?.id) {
            await a.updateRecord(TABLE_IDS.accounts, account.id, { 'Solutions': [...currentSolIds, newRec.id] });
          }
          setNewSolName('');
          if (onLogActivity) onLogActivity();
        } catch (e) { console.error(e); alert('Failed to create solution'); }
        setCreatingSol(false);
      };

      // ─── OPPORTUNITY CREATE / EDIT ───
      const OPP_STAGES = ['Prospecting', 'Qualification', 'Discovery', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost', 'On Hold'];

      const openNewOpp = () => {
        setOppForm({ name: '', stage: 'Prospecting', description: '', owner: '', value: '', closeDate: '', openingDate: '', nextStep: '' });
        setOppFormSolIds([]);
        setEditingOpp({ opp: null, isNew: true });
      };

      const openEditOpp = (opp) => {
        setOppForm({
          name: F(opp, 'Deal/Opp name') || '',
          stage: F(opp, 'Stage') || '',
          description: F(opp, 'Reason') || '',
          owner: F(opp, 'Opp Owner') || '',
          value: opp.fields?.['Value'] != null ? String(opp.fields['Value']) : '',
          closeDate: opp.fields?.['close date'] ? String(opp.fields['close date']).slice(0, 10) : '',
          openingDate: opp.fields?.['Opening date'] ? String(opp.fields['Opening date']).slice(0, 10) : '',
          nextStep: F(opp, 'Next step') || '',
        });
        setOppFormSolIds(linkedIds(opp, 'Solutions'));
        setEditingOpp({ opp, isNew: false });
      };

      const saveOppForm = async () => {
        if (!oppForm.name.trim()) { alert('Opportunity name is required'); return; }
        setSavingOppForm(true);
        try {
          const a = api || new AirtableAPI();
          const fields = {
            'Deal/Opp name': oppForm.name.trim(),
            'Stage': oppForm.stage || 'Prospecting',
            'Reason': oppForm.description.trim() || undefined,
            'Opp Owner': oppForm.owner.trim() || undefined,
            'Next step': oppForm.nextStep.trim() || undefined,
          };
          if (oppForm.value && !isNaN(Number(oppForm.value))) fields['Value'] = Number(oppForm.value);
          if (oppForm.closeDate) fields['close date'] = oppForm.closeDate;
          if (oppForm.openingDate) fields['Opening date'] = oppForm.openingDate;
          if (oppFormSolIds.length > 0) fields['Solutions'] = oppFormSolIds;
          // Remove undefined
          Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

          if (editingOpp.isNew) {
            fields['Account'] = account ? [account.id] : [];
            const newRec = await a.createRecord(TABLE_IDS.opportunities, fields);
            if (onAddRecord) onAddRecord('opportunities', { ...fields, Account: account ? [account.id] : [] });
          } else {
            await a.updateRecord(TABLE_IDS.opportunities, editingOpp.opp.id, fields);
            if (onUpdateRecord) onUpdateRecord('opportunities', editingOpp.opp.id, fields);
          }
          setEditingOpp(null);
          if (onLogActivity) onLogActivity();
        } catch (e) {
          console.error(e);
          alert('Failed to save opportunity: ' + e.message);
        }
        setSavingOppForm(false);
      };

      const deleteOpp = async (opp) => {
        if (!confirm(`Delete "${F(opp, 'Deal/Opp name')}"? This cannot be undone.`)) return;
        if (onDeleteRecord) onDeleteRecord('opportunities', opp.id);
        const a = api || new AirtableAPI();
        a.deleteRecord(TABLE_IDS.opportunities, opp.id).catch(e => { console.error(e); if (onLogActivity) onLogActivity(); });
      };

      // Opportunity modal (shared for create + edit)
      const renderOppModal = () => {
        if (!editingOpp) return null;
        const iStyle = { width: '100%', padding: '7px 9px', background: 'var(--globant-input)', border: '1px solid var(--globant-border)', borderRadius: 6, color: 'var(--globant-text)', fontSize: 12, boxSizing: 'border-box' };
        const lStyle = { fontSize: 10, color: 'var(--globant-muted)', fontWeight: 600, marginBottom: 3, textTransform: 'uppercase', display: 'block' };
        const set = (key, val) => setOppForm(p => ({ ...p, [key]: val }));
        return (
          <div className="modal-overlay" onClick={() => setEditingOpp(null)}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                <h3 style={{ margin: 0 }}>{editingOpp.isNew ? '🚀 New Opportunity' : '✏️ Edit Opportunity'}</h3>
                <button onClick={() => setEditingOpp(null)} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={lStyle}>Deal / Opportunity Name *</label>
                  <input style={iStyle} value={oppForm.name} onChange={e => set('name', e.target.value)} placeholder="e.g. AI Platform — Phase 1" autoFocus />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={lStyle}>Stage</label>
                    <select style={iStyle} value={oppForm.stage} onChange={e => set('stage', e.target.value)}>
                      {OPP_STAGES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={lStyle}>Value (USD)</label>
                    <input style={iStyle} type="number" value={oppForm.value} onChange={e => set('value', e.target.value)} placeholder="e.g. 50000" />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={lStyle}>Opening Date</label>
                    <input style={iStyle} type="date" value={oppForm.openingDate} onChange={e => set('openingDate', e.target.value)} />
                  </div>
                  <div>
                    <label style={lStyle}>Close Date</label>
                    <input style={iStyle} type="date" value={oppForm.closeDate} onChange={e => set('closeDate', e.target.value)} />
                  </div>
                </div>
                <div>
                  <label style={lStyle}>Owner</label>
                  <input style={iStyle} value={oppForm.owner} onChange={e => set('owner', e.target.value)} placeholder="e.g. John Smith" />
                </div>
                <div>
                  <label style={lStyle}>Description / Notes</label>
                  <textarea style={{ ...iStyle, minHeight: 70, resize: 'vertical' }} value={oppForm.description} onChange={e => set('description', e.target.value)} placeholder="Context, deal background, blockers..." />
                </div>
                <div>
                  <label style={lStyle}>Next Step</label>
                  <input style={iStyle} value={oppForm.nextStep} onChange={e => set('nextStep', e.target.value)} placeholder="e.g. Send proposal by Friday" />
                </div>
                <div>
                  <label style={lStyle}>Solutions</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                    {oppFormSolIds.map(sid => {
                      const sol = solutions.find(s => s.id === sid);
                      return sol ? (
                        <span key={sid} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', display: 'flex', alignItems: 'center', gap: 5 }}>
                          {F(sol, 'Name')}
                          <span style={{ cursor: 'pointer', fontWeight: 700 }} onClick={() => setOppFormSolIds(prev => prev.filter(id => id !== sid))}>×</span>
                        </span>
                      ) : null;
                    })}
                  </div>
                  <select style={iStyle} value="" onChange={e => { if (e.target.value && !oppFormSolIds.includes(e.target.value)) setOppFormSolIds(prev => [...prev, e.target.value]); }}>
                    <option value="">+ Add solution...</option>
                    {solutions.filter(s => !oppFormSolIds.includes(s.id)).map(s => <option key={s.id} value={s.id}>{F(s, 'Name')}</option>)}
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                  <button className="action-btn btn-ghost" style={{ flex: 1 }} onClick={() => setEditingOpp(null)}>Cancel</button>
                  <button className="action-btn btn-primary" style={{ flex: 2 }} onClick={saveOppForm} disabled={savingOppForm || !oppForm.name.trim()}>
                    {savingOppForm ? '⏳ Saving...' : editingOpp.isNew ? '🚀 Create Opportunity' : '💾 Save Changes'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      };

      // Reset talking points and recs when account changes
      useEffect(() => { setTalkingPoints(''); setContactRecs(''); setStakeholderSearch(''); }, [selectedAccountId]);

      return (
        <div>
          {renderOppModal()}
          <div className="page-header">
            <h1>Accounts</h1>
            <p>Executive account briefings — one-pager per account</p>
          </div>

          {/* Search + Import */}
          <div className="filters-row" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="input-field" style={{ maxWidth: 300 }} placeholder="Search account..." value={searchTerm}
              onChange={e => { setSearchTerm(e.target.value); setSelectedAccountId(''); }} />
            <select
              className="input-field"
              style={{ maxWidth: 220, fontSize: 12, padding: '8px 10px', background: 'var(--globant-card)', border: '1px solid var(--globant-border)', color: filterSolutionId ? 'var(--globant-green)' : 'var(--globant-muted)', borderRadius: 8 }}
              value={filterSolutionId}
              onChange={e => { setFilterSolutionId(e.target.value); setSelectedAccountId(''); }}
            >
              <option value="">All Solutions</option>
              {(data.solutions || []).map(s => (
                <option key={s.id} value={s.id}>{F(s, 'Name')}</option>
              ))}
            </select>
            <select
              className="input-field"
              style={{ maxWidth: 200, fontSize: 12, padding: '8px 10px', background: 'var(--globant-card)', border: '1px solid var(--globant-border)', color: filterIndustry ? 'var(--globant-info)' : 'var(--globant-muted)', borderRadius: 8 }}
              value={filterIndustry}
              onChange={e => { setFilterIndustry(e.target.value); setSelectedAccountId(''); }}
            >
              <option value="">All Industries</option>
              {[...new Set(accounts.map(a => F(a, 'Industry')).filter(Boolean))].sort().map(ind => (
                <option key={ind} value={ind}>{ind}</option>
              ))}
            </select>
            <select
              className="input-field"
              style={{ maxWidth: 180, fontSize: 12, padding: '8px 10px', background: 'var(--globant-card)', border: '1px solid var(--globant-border)', color: filterCountry ? '#f472b6' : 'var(--globant-muted)', borderRadius: 8 }}
              value={filterCountry}
              onChange={e => { setFilterCountry(e.target.value); setSelectedAccountId(''); }}
            >
              <option value="">🌍 All Countries</option>
              {[...new Set(accounts.map(a => F(a, 'Country')).filter(Boolean))].sort().map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            {(filterSolutionId || filterIndustry || filterCountry) && (
              <span
                style={{ fontSize: 11, color: 'var(--globant-green)', fontWeight: 600, cursor: 'pointer', padding: '4px 8px', background: 'rgba(191,215,48,0.1)', borderRadius: 5 }}
                onClick={() => { setFilterSolutionId(''); setFilterIndustry(''); setFilterCountry(''); }}
                title="Clear all filters"
              >
                {filteredAccounts.length} result{filteredAccounts.length !== 1 ? 's' : ''} · ✕ clear
              </span>
            )}
            {!selectedAccountId && (
              <>
                <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={() => { setShowNewAccount(!showNewAccount); setShowAccImport(false); }}>
                  {showNewAccount ? '✕ Close' : '➕ New Account'}
                </button>
                <button className="action-btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setShowAccImport(!showAccImport); setShowNewAccount(false); }}>
                  {showAccImport ? '✕ Close Import' : '📥 Import CSV'}
                </button>
              </>
            )}
          </div>

          {/* Manual Account Creation */}
          {showNewAccount && !selectedAccountId && (
            <div className="card" style={{ borderLeft: '3px solid var(--globant-green)' }}>
              <div className="card-header"><h3>➕ Create New Account</h3></div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ flex: 2, minWidth: 200 }}>
                  <label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>ACCOUNT NAME *</label>
                  <input className="input-field" style={{ width: '100%', fontSize: 12 }}
                    placeholder="e.g. Saudi Aramco" value={newAccName} onChange={e => setNewAccName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && createAccount()} />
                </div>
                <div style={{ flex: 2, minWidth: 200 }}>
                  <label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>WEBSITE</label>
                  <input className="input-field" style={{ width: '100%', fontSize: 12 }}
                    placeholder="e.g. https://aramco.com" value={newAccWebsite} onChange={e => setNewAccWebsite(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && createAccount()} />
                </div>
                <button className="action-btn btn-primary" style={{ fontSize: 12, padding: '8px 20px' }}
                  onClick={createAccount} disabled={!newAccName.trim() || creatingAcc}>
                  {creatingAcc ? '⏳ Creating...' : '🚀 Create Account'}
                </button>
              </div>
            </div>
          )}

          {/* CSV Account Import */}
          {showAccImport && !selectedAccountId && (
            <div className="card" style={{ borderLeft: '3px solid var(--globant-info)' }}>
              <div className="card-header"><h3>📥 Import Accounts from CSV</h3></div>
              <p style={{ fontSize: 12, color: 'var(--globant-muted)', marginBottom: 12, lineHeight: 1.5 }}>
                Upload a CSV with columns: <strong>Account Name</strong> (or Name/Company) and <strong>Website</strong> (optional). Duplicates are detected automatically.
              </p>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
                <input type="file" accept=".csv" onChange={handleAccCsv} style={{ fontSize: 12 }} />
                <button className="action-btn btn-ghost" style={{ fontSize: 11 }}
                  onClick={() => {
                    const csv = 'Account Name,Website\nExample Corp,https://example.com\nAcme Inc,https://acme.io';
                    const blob = new Blob([csv], { type: 'text/csv' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a'); a.href = url; a.download = 'accounts_template.csv'; a.click();
                  }}>📋 Download Template</button>
              </div>
              {accCsvRows.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--globant-text)' }}>
                    Preview: <span style={{ color: 'var(--globant-green)' }}>{accCsvRows.filter(r => r.selected && !r.isDuplicate).length} new</span> · <span style={{ color: '#ef4444' }}>{accCsvRows.filter(r => r.isDuplicate).length} exact duplicates</span>{accCsvRows.filter(r => r.isFuzzy).length > 0 && <> · <span style={{ color: '#f59e0b' }}>{accCsvRows.filter(r => r.isFuzzy).length} possible duplicates</span></>} · {accCsvRows.length} total
                  </div>
                  <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 12 }}>
                    <table className="data-table">
                      <thead><tr><th style={{ width: 30 }}></th><th>Name</th><th>Website</th><th>Status</th></tr></thead>
                      <tbody>
                        {accCsvRows.map((r, i) => (
                          <tr key={i} style={{ opacity: r.isDuplicate ? 0.5 : 1, background: r.isFuzzy ? 'rgba(251,191,36,0.04)' : 'transparent' }}>
                            <td><input type="checkbox" checked={r.selected && !r.isDuplicate} disabled={r.isDuplicate}
                              onChange={e => { const u = [...accCsvRows]; u[i].selected = e.target.checked; setAccCsvRows(u); }} /></td>
                            <td style={{ fontSize: 12 }}>{r.name}</td>
                            <td style={{ fontSize: 11, color: 'var(--globant-muted)' }}>{r.website || '—'}</td>
                            <td>
                              {r.isDuplicate
                                ? <span className="badge" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', fontSize: 9 }}>🚫 {r.duplicateReason}</span>
                                : r.isFuzzy
                                ? <span className="badge" style={{ background: 'rgba(251,191,36,0.15)', color: '#f59e0b', fontSize: 9 }} title={r.fuzzyReason}>⚠️ {r.fuzzyReason}</span>
                                : <span className="badge badge-green" style={{ fontSize: 9 }}>✓ New</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button className="action-btn btn-primary" style={{ fontSize: 12 }}
                    onClick={importAccounts} disabled={accImporting || accCsvRows.filter(r => r.selected && !r.isDuplicate).length === 0}>
                    {accImporting ? '⏳ Importing...' : `🚀 Import ${accCsvRows.filter(r => r.selected && !r.isDuplicate).length} Accounts`}
                  </button>
                  {accImportResult && (
                    <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--globant-green)' }}>
                      ✅ {accImportResult.created} created{accImportResult.failed ? `, ${accImportResult.failed} failed` : ''}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Account selector list */}
          {!selectedAccountId && (
            <div className="card">
              <div className="card-header"><h3>Select an Account</h3></div>
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead><tr><th>Account</th><th style={{ textAlign: 'center' }}>Stakeholders</th><th style={{ textAlign: 'center' }}>Outreach</th><th style={{ textAlign: 'center' }}>Opps</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {filteredAccounts.map(a => {
                      const stCount = linkedIds(a, 'Stakeholders').length;
                      const oCount = outreach.filter(o => linkedIds(o, 'Account').includes(a.id)).length;
                      const oppCount = opportunities.filter(o => linkedIds(o, 'Account').includes(a.id)).length;
                      return (
                        <tr key={a.id} onClick={() => { setSelectedAccountId(a.id); setSearchTerm(''); }} style={{ cursor: 'pointer' }}>
                          <td style={{ fontWeight: 600 }}>{F(a, 'Account Name')}</td>
                          <td style={{ textAlign: 'center' }}>{stCount}</td>
                          <td style={{ textAlign: 'center' }}>{oCount > 0 ? <span style={{ color: 'var(--globant-green)', fontWeight: 700 }}>{oCount}</span> : '—'}</td>
                          <td style={{ textAlign: 'center' }}>{oppCount > 0 ? <span className="badge badge-blue">{oppCount}</span> : '—'}</td>
                          <td>{F(a, 'Inside Sales Status') ? <span className="badge badge-accent">{F(a, 'Inside Sales Status')}</span> : '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '2px 7px' }} onClick={e => { e.stopPropagation(); setEditingAccount(a); }}>✏️</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Account Briefing */}
          {account && (
            <div>
              {/* Header */}
              <div className="card" style={{ borderLeft: '3px solid var(--globant-green)', background: 'linear-gradient(135deg, rgba(191,215,48,0.08) 0%, transparent 100%)' }}>
                <button className="action-btn btn-ghost" style={{ marginBottom: 12, fontSize: 11 }} onClick={() => setSelectedAccountId('')}>← Back</button>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                      <h2 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>{name}</h2>
                      <button className="action-btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => setEditingAccount(account)}>✏️ Edit</button>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--globant-muted)' }}>
                      {F(account, 'Industry')}{F(account, 'Tier') ? ` · ${F(account, 'Tier')}` : ''}{F(account, 'Inside Sales Status') ? ` · ${F(account, 'Inside Sales Status')}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 12, textAlign: 'center' }}>
                    <div style={{ padding: '10px 18px', background: 'var(--globant-darker)', borderRadius: 10 }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--globant-green)' }}>{accStakeholders.length}</div>
                      <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>Stakeholders</div>
                    </div>
                    <div style={{ padding: '10px 18px', background: 'var(--globant-darker)', borderRadius: 10 }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--globant-info)' }}>{accOutreach.length}</div>
                      <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>Touches</div>
                    </div>
                    <div style={{ padding: '10px 18px', background: 'var(--globant-darker)', borderRadius: 10 }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--globant-warning)' }}>{opps.length}</div>
                      <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>Opps</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* What We Know */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {/* Left: News + Plan */}
                <div>
                  {newsItems.length > 0 && (() => {
                    const lastUpd = account?.fields?.['Last Updated'];
                    const lastUpdStr = lastUpd ? new Date(lastUpd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
                    return (
                    <div className="card">
                      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h3>📰 Recent News</h3>
                        {lastUpdStr && <span style={{ fontSize: 10, color: 'var(--globant-muted)', fontWeight: 400 }}>🕐 Updated: {lastUpdStr}</span>}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {newsItems.map((item, i) => {
                          const lc = (item.title + ' ' + item.body).toLowerCase();
                          const tag = lc.includes('ai') || lc.includes('artificial') ? { label: 'AI', color: '#bfd730' }
                                    : lc.includes('digital') ? { label: 'Digital', color: '#60a5fa' }
                                    : lc.includes('partner') || lc.includes('deal') || lc.includes('agreement') ? { label: 'Partnership', color: '#a78bfa' }
                                    : lc.includes('financ') || lc.includes('revenue') || lc.includes('invest') || lc.includes('dividend') || lc.includes('earning') || lc.includes('billion') ? { label: 'Finance', color: '#4ade80' }
                                    : lc.includes('hire') || lc.includes('appoint') || lc.includes('ceo') || lc.includes('cto') || lc.includes('leader') ? { label: 'Leadership', color: '#fb923c' }
                                    : lc.includes('customer') || lc.includes('cx') || lc.includes('experience') ? { label: 'CX', color: '#f472b6' }
                                    : lc.includes('expand') || lc.includes('launch') || lc.includes('open') || lc.includes('new office') ? { label: 'Expansion', color: '#38bdf8' }
                                    : lc.includes('incident') || lc.includes('fire') || lc.includes('shutdown') || lc.includes('crisis') ? { label: 'Incident', color: '#ef4444' }
                                    : { label: 'News', color: '#94a3b8' };
                          const fullText = `${item.title}${item.body ? ' — ' + item.body : ''}`;
                          return (
                            <div key={i} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: '12px 14px', borderLeft: `3px solid ${tag.color}` }}
                              onMouseEnter={e => e.currentTarget.style.background = 'rgba(191,215,48,0.05)'}
                              onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                                <div style={{ flex: 1 }}>
                                  <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--globant-text)', lineHeight: 1.4, marginBottom: item.body ? 4 : 0 }}>{item.title}</div>
                                  {item.body && <div style={{ fontSize: 12, color: 'var(--globant-muted)', lineHeight: 1.5 }}>{item.body}</div>}
                                </div>
                                <span style={{ fontSize: 9, fontWeight: 600, padding: '3px 8px', borderRadius: 5, background: tag.color + '22', color: tag.color, whiteSpace: 'nowrap', flexShrink: 0 }}>{tag.label}</span>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                                {item.source && (
                                  <a href={item.source} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: 'var(--globant-green)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 3 }}>
                                    🔗 Source
                                  </a>
                                )}
                                <button onClick={() => navigator.clipboard.writeText(fullText)} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: 'var(--globant-muted)', cursor: 'pointer' }}>📋 Copy</button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ); })()}
                  <div className="card" style={{ borderLeft: '3px solid #60a5fa' }}>
                    <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <h3>🧠 Executive Summary</h3>
                        {execSummaryUpdatedAt && (
                          <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 2 }}>
                            Last updated: {new Date(execSummaryUpdatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </div>
                        )}
                      </div>
                      <button className="action-btn btn-primary" style={{ fontSize: 11 }}
                        onClick={generateExecSummary} disabled={loadingSummary}>
                        {loadingSummary ? '⏳ Generating...' : execSummary ? '🔄 Regenerate' : '✨ Generate with AI'}
                      </button>
                    </div>
                    {!execSummary && !loadingSummary && (
                      <p style={{ color: 'var(--globant-muted)', fontSize: 12, padding: '8px 0' }}>
                        Generate an executive summary combining recent news, intel notes, solutions, opportunities, and stakeholder status into one strategic briefing.
                      </p>
                    )}
                    {execSummary && (() => {
                      const lines = execSummary.split('\n').filter(l => l.trim());
                      return (
                        <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                          {lines.map((line, i) => {
                            const isHeader = line.match(/^#{1,3}\s/);
                            const clean = line.replace(/^#{1,3}\s+/, '').replace(/\*\*/g, '').trim();
                            if (!clean) return null;
                            if (isHeader) {
                              return <div key={i} style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa', marginTop: i > 0 ? 14 : 0, paddingBottom: 4, borderBottom: '1px solid rgba(96,165,250,0.15)' }}>{clean}</div>;
                            }
                            const isBullet = line.match(/^[\s]*[-•*]\s|^\d+\./);
                            const bulletClean = clean.replace(/^[-•*]\s*/, '').replace(/^\d+\.\s*/, '');
                            const parts = bulletClean.split(/(\*\*[^*]+\*\*)/g);
                            return (
                              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: '3px 0' }}>
                                {isBullet && <span style={{ color: '#60a5fa', fontSize: 8, marginTop: 6 }}>●</span>}
                                <span style={{ fontSize: 12, lineHeight: 1.6 }}>
                                  {parts.map((p, pi) => p.startsWith('**') && p.endsWith('**')
                                    ? <strong key={pi} style={{ color: '#60a5fa' }}>{p.slice(2, -2)}</strong>
                                    : <span key={pi}>{p}</span>
                                  )}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                  <div className="card" style={{ borderLeft: '3px solid var(--globant-accent)' }}>
                    <div className="card-header">
                      <h3>📝 Intel Notes</h3>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        {!editingNotes ? (
                          <button className="action-btn btn-primary" style={{ fontSize: 10, padding: '3px 10px' }}
                            onClick={() => { setNotesValue(intelNotes); setEditingNotes(true); }}>
                            {intelNotes ? '✏️ Edit' : '➕ Add Notes'}
                          </button>
                        ) : (
                          <>
                            <button className="action-btn btn-primary" style={{ fontSize: 10, padding: '3px 10px' }}
                              onClick={saveIntelNotes} disabled={savingNotes}>
                              {savingNotes ? '⏳ Saving...' : '💾 Save'}
                            </button>
                            <button className="action-btn" style={{ fontSize: 10, padding: '3px 10px' }}
                              onClick={() => setEditingNotes(false)}>Cancel</button>
                          </>
                        )}
                        <label style={{ cursor: 'pointer' }}>
                          <span className="action-btn" style={{ fontSize: 10, padding: '3px 10px', background: 'rgba(96,165,250,0.12)', color: 'var(--globant-info)', border: '1px solid rgba(96,165,250,0.3)', display: 'inline-block' }}>
                            {uploadingFile ? '⏳ Processing...' : '📎 Upload File'}
                          </span>
                          <input type="file" accept=".csv,.txt,.json,.md,.html,.tsv,.xml" onChange={handleFileUpload} style={{ display: 'none' }} disabled={uploadingFile} />
                        </label>
                      </div>
                    </div>
                    {editingNotes ? (
                      <textarea
                        className="input-field"
                        value={notesValue}
                        onChange={e => setNotesValue(e.target.value)}
                        placeholder="Add your intel notes here... meeting insights, context, observations, next steps..."
                        style={{ width: '100%', minHeight: 120, fontSize: 12, lineHeight: 1.6, resize: 'vertical' }}
                      />
                    ) : intelNotes ? (
                      <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--globant-text)', whiteSpace: 'pre-wrap', maxHeight: 300, overflowY: 'auto' }}>
                        {intelNotes.split(/(\n📎 FILE:)/g).map((block, i) => {
                          if (block === '\n📎 FILE:') return null;
                          const isFile = i > 0;
                          if (isFile) {
                            const fileBlock = '📎 FILE:' + block;
                            const firstLine = fileBlock.split('\n')[0];
                            return (
                              <div key={i} style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(96,165,250,0.06)', borderRadius: 8, borderLeft: '3px solid var(--globant-info)' }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-info)', marginBottom: 4 }}>{firstLine}</div>
                                <div style={{ fontSize: 12 }}>{fileBlock.split('\n').slice(1).join('\n')}</div>
                              </div>
                            );
                          }
                          return <div key={i}>{block}</div>;
                        })}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>No notes yet — click "Add Notes" to write, or "Upload File" to add intel from documents</div>
                    )}
                  </div>
                </div>

                {/* Right: Solutions + Opps + Events */}
                <div>
                  <div className="card">
                    <div className="card-header">
                      <h3>🛠️ Solutions & Approach</h3>
                      <button className="action-btn btn-ghost" style={{ fontSize: 10 }} onClick={() => setShowSolPicker(!showSolPicker)}>
                        {showSolPicker ? '✕ Close' : '➕ Add Solution'}
                      </button>
                    </div>

                    {/* Current solutions with remove */}
                    {currentSolIds.length > 0 ? (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: showSolPicker ? 12 : 0 }}>
                        {currentSolIds.map(sid => {
                          const sol = allSolutions.find(s => s.id === sid);
                          const solName = sol ? F(sol, 'Name') : sid;
                          return (
                            <span key={sid} className="badge badge-accent" style={{ fontSize: 12, padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 6 }}>
                              {solName}
                              <span style={{ cursor: 'pointer', opacity: 0.6, fontSize: 10 }}
                                onClick={() => removeSolutionFromAccount(sid)}
                                title="Remove from account">
                                {removingSol === sid ? '⏳' : '✕'}
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    ) : <p style={{ color: 'var(--globant-warning)', fontSize: 12, marginBottom: showSolPicker ? 12 : 0 }}>No solutions mapped yet</p>}

                    {/* Solution picker */}
                    {showSolPicker && (
                      <div style={{ padding: '12px', background: 'var(--globant-darker)', borderRadius: 8 }}>
                        {/* Existing solutions */}
                        {availableSolutions.length > 0 && (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, marginBottom: 6 }}>SELECT EXISTING</div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {availableSolutions.map(s => (
                                <button key={s.id} className="action-btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                                  onClick={() => addSolutionToAccount(s.id)}>
                                  + {F(s, 'Name')}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Create new */}
                        <div>
                          <div style={{ fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, marginBottom: 6 }}>OR CREATE NEW</div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <input className="input-field" style={{ flex: 1, fontSize: 12, padding: '6px 10px' }}
                              placeholder="New solution name..."
                              value={newSolName} onChange={e => setNewSolName(e.target.value)}
                              onKeyDown={e => e.key === 'Enter' && createNewSolution()} />
                            <button className="action-btn btn-primary" style={{ fontSize: 11 }}
                              onClick={createNewSolution} disabled={!newSolName.trim() || creatingSol}>
                              {creatingSol ? '⏳' : '✨ Create & Add'}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {F(account, 'Service / Focus') && (
                      <div style={{ marginTop: 10 }}>
                        <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>Focus: </span>
                        {(Array.isArray(F(account, 'Service / Focus')) ? F(account, 'Service / Focus') : [F(account, 'Service / Focus')]).map((sf, i) => (
                          <span key={i} className="badge badge-blue" style={{ marginLeft: 4 }}>{typeof sf === 'object' ? sf.name || sf : sf}</span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="card">
                    <div className="card-header">
                      <h3>🚀 Pipeline ({opps.length})</h3>
                      <button className="action-btn btn-primary" style={{ fontSize: 11, padding: '4px 12px' }} onClick={openNewOpp}>
                        ➕ New Opp
                      </button>
                    </div>
                    {opps.length === 0 && (
                      <p style={{ color: 'var(--globant-muted)', fontSize: 12, fontStyle: 'italic' }}>No opportunities yet. Click "New Opp" to create one.</p>
                    )}
                    {opps.length > 0 && opps.map(o => {
                        const stage = F(o, 'Stage');
                        const value = o.fields?.['Value'];
                        const stageColor = (stage||'').toLowerCase().includes('won') ? 'badge-green' : (stage||'').toLowerCase().includes('lost') || (stage||'').toLowerCase().includes('cancel') ? 'badge-red' : 'badge-blue';
                        const isOpen = selectedOppId === o.id;
                        return (
                          <div key={o.id} style={{ borderBottom: '1px solid var(--globant-border)' }}>
                            <div style={{ padding: '10px 0', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: 1 }}
                                onClick={() => {
                                  if (isOpen) { setSelectedOppId(''); }
                                  else {
                                    setSelectedOppId(o.id);
                                    setOppNotes(F(o, 'Reason') || '');
                                    setOppNextStep(F(o, 'Next step') || '');
                                    setOppStakeholder(F(o, 'Stakeholders') || '');
                                    setOppSolutionIds(linkedIds(o, 'Solutions'));
                                    setEditingOppNotes(false);
                                    setShowAddOppStk(false);
                                  }
                                }}>
                                <span style={{ color: 'var(--globant-green)', fontSize: 10 }}>{isOpen ? '▼' : '▶'}</span>
                                <span style={{ fontWeight: 600 }}>{F(o, 'Deal/Opp name')}</span>
                              </div>
                              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                                <span className={`badge ${stageColor}`}>{stage}</span>
                                {value ? <span className="badge badge-green">{formatCurrency(value)}</span> : null}
                                <button
                                  className="action-btn btn-ghost"
                                  style={{ fontSize: 10, padding: '2px 8px', marginLeft: 4 }}
                                  onClick={e => { e.stopPropagation(); openEditOpp(o); }}
                                  title="Edit opportunity"
                                >✏️</button>
                                <button
                                  style={{ fontSize: 10, padding: '2px 8px', marginLeft: 2, borderRadius: 5, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', color: '#ef4444', cursor: 'pointer' }}
                                  onClick={e => { e.stopPropagation(); deleteOpp(o); }}
                                  title="Delete opportunity"
                                >🗑</button>
                              </div>
                            </div>
                            {isOpen && (
                              <div style={{ padding: '0 0 14px 20px', fontSize: 12 }}>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 20px', marginBottom: 12, padding: '10px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: 8 }}>
                                  {F(o, 'Opp Owner') && <div><span style={{ color: 'var(--globant-muted)', fontSize: 10 }}>Owner:</span> <span style={{ fontWeight: 600 }}>{F(o, 'Opp Owner')}</span></div>}
                                  {F(o, 'Inside sale Rep') && <div><span style={{ color: 'var(--globant-muted)', fontSize: 10 }}>Inside Sales:</span> <span style={{ fontWeight: 600 }}>{F(o, 'Inside sale Rep')}</span></div>}
                                  {o.fields?.['close date'] && <div><span style={{ color: 'var(--globant-muted)', fontSize: 10 }}>Close Date:</span> <span style={{ fontWeight: 600 }}>{formatDate(o.fields['close date'])}</span></div>}
                                  {o.fields?.['Close probability (%)'] != null && <div><span style={{ color: 'var(--globant-muted)', fontSize: 10 }}>Probability:</span> <span style={{ fontWeight: 600 }}>{Math.round(o.fields['Close probability (%)'] * 100)}%</span></div>}
                                  {F(o, 'Opp origin') && <div><span style={{ color: 'var(--globant-muted)', fontSize: 10 }}>Origin:</span> <span style={{ fontWeight: 600 }}>{F(o, 'Opp origin')}</span></div>}
                                  {F(o, 'Tech / Ecosystem') && <div><span style={{ color: 'var(--globant-muted)', fontSize: 10 }}>Tech:</span> <span style={{ fontWeight: 600 }}>{F(o, 'Tech / Ecosystem')}</span></div>}
                                  {F(o, 'Confidence') && <div><span style={{ color: 'var(--globant-muted)', fontSize: 10 }}>Confidence:</span> <span style={{ fontWeight: 600 }}>{F(o, 'Confidence')}</span></div>}
                                </div>
                                {/* Stakeholder assigned to this opp */}
                                <div style={{ marginBottom: 12 }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-green)' }}>👤 Stakeholder</span>
                                    {!editingOppNotes && (
                                      <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '2px 8px' }}
                                        onClick={() => setEditingOppNotes(true)}>✏️ Edit</button>
                                    )}
                                  </div>
                                  {editingOppNotes ? (
                                    <div>
                                      <select className="input-field" style={{ width: '100%', fontSize: 12, marginBottom: 6 }}
                                        value={oppStakeholder}
                                        onChange={e => { setOppStakeholder(e.target.value); setShowAddOppStk(false); }}>
                                        <option value="">— Select stakeholder —</option>
                                        {accStakeholders.map(s => {
                                          const sFullName = F(s, 'Name') + (F(s, 'Lart name') ? ` ${F(s, 'Lart name')}` : '');
                                          const sRole = F(s, 'Role') || '';
                                          return <option key={s.id} value={sFullName}>{sFullName}{sRole ? ` — ${sRole}` : ''}</option>;
                                        })}
                                      </select>
                                      <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '3px 8px', marginBottom: 6 }}
                                        onClick={() => setShowAddOppStk(!showAddOppStk)}>
                                        {showAddOppStk ? '✕ Cancel' : '➕ New Contact'}
                                      </button>
                                      {showAddOppStk && (
                                        <div style={{ display: 'flex', gap: 6, marginBottom: 6, padding: '8px 10px', background: 'rgba(191,215,48,0.06)', borderRadius: 8 }}>
                                          <input className="input-field" style={{ flex: 1, fontSize: 11, padding: '5px 8px' }}
                                            placeholder="Full name" value={newOppStkName} onChange={e => setNewOppStkName(e.target.value)} />
                                          <input className="input-field" style={{ flex: 1, fontSize: 11, padding: '5px 8px' }}
                                            placeholder="Role (e.g. CTO)" value={newOppStkRole} onChange={e => setNewOppStkRole(e.target.value)} />
                                          <button className="action-btn btn-primary" style={{ fontSize: 10, padding: '4px 10px', whiteSpace: 'nowrap' }}
                                            disabled={!newOppStkName.trim() || creatingOppStk}
                                            onClick={async () => {
                                              setCreatingOppStk(true);
                                              try {
                                                const parts = newOppStkName.trim().split(/\s+/);
                                                const firstName = parts[0] || '';
                                                const lastName = parts.slice(1).join(' ') || '';
                                                await api.createRecord(TABLE_IDS.stakeholders, {
                                                  'Name': firstName,
                                                  ...(lastName ? { 'Lart name': lastName } : {}),
                                                  ...(newOppStkRole ? { 'Role': newOppStkRole } : {}),
                                                  'Account': account ? [{ id: account.id }] : [],
                                                  'BDR Owner': CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '',
                                                  'CP Assigned': CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '',
                                                });
                                                setOppStakeholder(newOppStkName.trim());
                                                setNewOppStkName('');
                                                setNewOppStkRole('');
                                                setShowAddOppStk(false);
                                                if (onLogActivity) onLogActivity();
                                              } catch (e) { console.error(e); alert('Failed to create stakeholder'); }
                                              setCreatingOppStk(false);
                                            }}>
                                            {creatingOppStk ? '⏳' : '✨ Create'}
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  ) : (
                                    <div style={{ fontSize: 12, color: oppStakeholder ? 'var(--globant-text)' : 'var(--globant-muted)', fontStyle: oppStakeholder ? 'normal' : 'italic' }}>
                                      {oppStakeholder || 'No stakeholder assigned'}
                                    </div>
                                  )}
                                </div>
                                {/* Solution linked to this opp */}
                                <div style={{ marginBottom: 12 }}>
                                  <div style={{ marginBottom: 6 }}>
                                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-green)' }}>🛠️ Solution</span>
                                  </div>
                                  {editingOppNotes ? (
                                    <div>
                                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                                        {oppSolutionIds.map(sid => {
                                          const sol = solutions.find(s => s.id === sid);
                                          if (!sol) return null;
                                          return (
                                            <span key={sid} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', display: 'flex', alignItems: 'center', gap: 5 }}>
                                              {F(sol, 'Name')}
                                              <span style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13 }}
                                                onClick={() => setOppSolutionIds(prev => prev.filter(id => id !== sid))}>×</span>
                                            </span>
                                          );
                                        })}
                                      </div>
                                      <select className="input-field" style={{ width: '100%', fontSize: 12 }}
                                        value="" onChange={e => {
                                          if (e.target.value && !oppSolutionIds.includes(e.target.value)) {
                                            setOppSolutionIds(prev => [...prev, e.target.value]);
                                          }
                                        }}>
                                        <option value="">+ Add solution...</option>
                                        {solutions.filter(s => !oppSolutionIds.includes(s.id)).map(s => (
                                          <option key={s.id} value={s.id}>{F(s, 'Name')}</option>
                                        ))}
                                      </select>
                                    </div>
                                  ) : (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                      {oppSolutionIds.length > 0 ? oppSolutionIds.map(sid => {
                                        const sol = solutions.find(s => s.id === sid);
                                        return sol ? (
                                          <span key={sid} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>
                                            {F(sol, 'Name')}
                                          </span>
                                        ) : null;
                                      }) : (
                                        <span style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>No solution assigned</span>
                                      )}
                                    </div>
                                  )}
                                </div>
                                {(F(o, 'Suggested Angle') || F(o, 'Suggested Solution Theme') || F(o, 'Potential Interest') || F(o, 'Role-Based Pain Point')) && (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                                    {F(o, 'Suggested Angle') && <span style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, background: 'rgba(191,215,48,0.12)', color: 'var(--globant-green)' }}>🎯 {F(o, 'Suggested Angle')}</span>}
                                    {F(o, 'Suggested Solution Theme') && <span style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>🛠️ {F(o, 'Suggested Solution Theme')}</span>}
                                    {F(o, 'Potential Interest') && <span style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, background: 'rgba(96,165,250,0.12)', color: '#60a5fa' }}>💡 {F(o, 'Potential Interest')}</span>}
                                    {F(o, 'Role-Based Pain Point') && <span style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, background: 'rgba(244,114,182,0.12)', color: '#f472b6' }}>⚡ {F(o, 'Role-Based Pain Point')}</span>}
                                  </div>
                                )}
                                {/* Next Step */}
                                <div style={{ marginBottom: 10 }}>
                                  <div style={{ marginBottom: 4 }}>
                                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-green)' }}>Next Step</span>
                                  </div>
                                  {editingOppNotes ? (
                                    <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px', marginBottom: 6 }}
                                      value={oppNextStep} onChange={e => setOppNextStep(e.target.value)}
                                      placeholder="What's the next step for this opp?" />
                                  ) : (
                                    <div style={{ fontSize: 12, color: oppNextStep ? 'var(--globant-text)' : 'var(--globant-muted)', fontStyle: oppNextStep ? 'normal' : 'italic' }}>
                                      {oppNextStep || 'No next step defined'}
                                    </div>
                                  )}
                                </div>
                                {/* Notes / Reason */}
                                <div style={{ marginBottom: 10 }}>
                                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-green)', display: 'block', marginBottom: 4 }}>Notes</span>
                                  {editingOppNotes ? (
                                    <textarea className="input-field" style={{ width: '100%', minHeight: 80, resize: 'vertical', fontFamily: 'inherit', fontSize: 12 }}
                                      value={oppNotes} onChange={e => setOppNotes(e.target.value)}
                                      placeholder="Add notes about this opportunity — context, blockers, updates..." />
                                  ) : (
                                    <div style={{ fontSize: 12, color: oppNotes ? 'var(--globant-text)' : 'var(--globant-muted)', fontStyle: oppNotes ? 'normal' : 'italic', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                                      {oppNotes || 'No notes yet. Click Edit to add context.'}
                                    </div>
                                  )}
                                </div>
                                {editingOppNotes && (
                                  <div style={{ display: 'flex', gap: 8 }}>
                                    <button className="action-btn btn-primary" style={{ fontSize: 11 }}
                                      disabled={savingOppNotes}
                                      onClick={async () => {
                                        setSavingOppNotes(true);
                                        try {
                                          await api.updateRecord(TABLE_IDS.opportunities, o.id, {
                                            'Reason': oppNotes,
                                            'Next step': oppNextStep,
                                            'Stakeholders': oppStakeholder,
                                            'Solutions': oppSolutionIds.map(id => ({ id })),
                                          });
                                          setEditingOppNotes(false);
                                          if (onLogActivity) onLogActivity();
                                        } catch (e) { console.error(e); alert('Failed to save'); }
                                        setSavingOppNotes(false);
                                      }}>
                                      {savingOppNotes ? '⏳ Saving...' : '💾 Save'}
                                    </button>
                                    <button className="action-btn btn-ghost" style={{ fontSize: 11 }}
                                      onClick={() => { setEditingOppNotes(false); setOppNotes(F(o, 'Reason') || ''); setOppNextStep(F(o, 'Next step') || ''); }}>
                                      Cancel
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>

                  {accEvents.length > 0 && (
                    <div className="card">
                      <div className="card-header"><h3>📅 Upcoming Events</h3></div>
                      {accEvents.map(ev => (
                        <div key={ev.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--globant-border)', fontSize: 12 }}>
                          <span style={{ fontWeight: 600 }}>{F(ev, 'Event Name')}</span>
                          <span className="badge badge-blue" style={{ marginLeft: 8 }}>{formatDate(ev.fields?.['Starting'])}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {upcomingEventsText && upcomingEventsText.length > 5 && (() => {
                    const evLines = upcomingEventsText.split(/\n+/).map(l => l.trim()).filter(l => l.length > 5);
                    const cleanMd = (s) => s.replace(/^\.\s*/, '').replace(/\*\*/g, '').replace(/^[-•*\d.]+\s*/, '').trim();
                    const isLink = (s) => /^\[.*\]\(http/i.test(s) || /^https?:\/\//i.test(s);
                    // Group into items: title + body pairs
                    const items = [];
                    let cur = null;
                    for (const line of evLines) {
                      const c = cleanMd(line);
                      if (!c || c.length < 4) continue;
                      if (isLink(c)) {
                        if (cur) { const m = line.match(/\((https?:\/\/[^)]+)\)/); if (m) cur.url = m[1]; }
                        continue;
                      }
                      if (c.length < 120 && /\*\*/.test(line)) {
                        if (cur) items.push(cur);
                        cur = { title: c, body: '', url: '' };
                      } else if (cur && !cur.body) {
                        cur.body = c;
                      } else if (!cur) {
                        cur = { title: c, body: '', url: '' };
                      }
                    }
                    if (cur) items.push(cur);
                    // Deduplicate
                    const seen = new Set();
                    const unique = items.filter(it => {
                      const k = it.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
                      if (seen.has(k)) return false;
                      seen.add(k);
                      return true;
                    }).slice(0, 5);
                    if (unique.length === 0) return null;
                    return (
                      <div className="card" style={{ borderLeft: '3px solid #38bdf8' }}>
                        <div className="card-header"><h3>🎪 Company Events Intel</h3></div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {unique.map((item, i) => (
                            <div key={i} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: '10px 12px' }}>
                              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--globant-text)', lineHeight: 1.4, marginBottom: item.body ? 4 : 0 }}>{item.title}</div>
                              {item.body && <div style={{ fontSize: 12, color: 'var(--globant-muted)', lineHeight: 1.5 }}>{item.body}</div>}
                              {item.url && (
                                <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: 'var(--globant-green)', textDecoration: 'none', marginTop: 4, display: 'inline-block' }}>🔗 Event link</a>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* AI Talking Points */}
              <div className="card" style={{ borderLeft: '3px solid var(--globant-accent)' }}>
                <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3>🎤 Recommended Talking Points</h3>
                  <button className="action-btn btn-primary" style={{ fontSize: 11 }} onClick={generateTalkingPoints} disabled={loadingTP}>
                    {loadingTP ? '⏳ Generating...' : talkingPoints ? '🔄 Regenerate' : '✨ Generate with AI'}
                  </button>
                </div>
                {!talkingPoints && !loadingTP && (
                  <p style={{ color: 'var(--globant-muted)', fontSize: 13, padding: '12px 0' }}>
                    Click "Generate with AI" to create personalized talking points based on stakeholder pain points, recent news, and mapped solutions. The CP arrives prepared.
                  </p>
                )}
                {talkingPoints && (() => {
                  const tpLines = talkingPoints.split('\n').filter(l => l.trim());
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {tpLines.map((line, i) => {
                        const isHeader = line.match(/^#{1,3}\s/) || line.match(/^\*\*[A-Z]/);
                        const clean = line.replace(/^#{1,3}\s+/, '').replace(/^\*\*/, '').replace(/\*\*$/, '').trim();
                        if (!clean) return null;
                        if (isHeader) {
                          return <div key={i} style={{ fontSize: 13, fontWeight: 700, color: 'var(--globant-green)', marginTop: i > 0 ? 10 : 0, paddingBottom: 4, borderBottom: '1px solid rgba(191,215,48,0.15)' }}>{clean.replace(/\*\*/g, '')}</div>;
                        }
                        const isBullet = line.match(/^[\s]*[-•*]\s|^\d+\./);
                        const bulletClean = clean.replace(/^[-•*]\s*/, '').replace(/^\d+\.\s*/, '');
                        const parts = bulletClean.split(/(\*\*[^*]+\*\*)/g);
                        return (
                          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '4px 0' }}>
                            {isBullet && <span style={{ color: 'var(--globant-green)', fontSize: 8, marginTop: 6 }}>●</span>}
                            <span style={{ fontSize: 12, lineHeight: 1.6 }}>
                              {parts.map((p, pi) => p.startsWith('**') && p.endsWith('**')
                                ? <strong key={pi} style={{ color: 'var(--globant-green)' }}>{p.slice(2, -2)}</strong>
                                : <span key={pi}>{p}</span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              {/* Who to Contact - AI Recommendations */}
              <div className="card" style={{ borderLeft: '3px solid var(--globant-info)' }}>
                <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3>🎯 Who to Contact Next</h3>
                  <button className="action-btn" style={{ fontSize: 11, background: 'rgba(96,165,250,0.15)', color: 'var(--globant-info)', border: '1px solid rgba(96,165,250,0.3)' }}
                    onClick={generateContactRecs} disabled={loadingRecs}>
                    {loadingRecs ? '⏳ Analyzing...' : contactRecs ? '🔄 Refresh' : '🤖 Get AI Recommendations'}
                  </button>
                </div>
                {!contactRecs && !loadingRecs && (
                  <p style={{ color: 'var(--globant-muted)', fontSize: 13, padding: '12px 0' }}>
                    AI will analyze all stakeholders, outreach history, pipeline, news, and gaps to recommend who to contact, missing roles to find, and re-engagement tactics.
                  </p>
                )}
                {contactRecs && (() => {
                  const sectionIcons = { 'PRIORITY CONTACTS': '🔥', 'MISSING ROLES': '🔍', 'RE-ENGAGEMENT': '♻️', 'TIMING & TRIGGERS': '⏰', 'TIMING': '⏰', 'TRIGGERS': '⏰' };
                  const sectionColors = { 'PRIORITY CONTACTS': '#4ade80', 'MISSING ROLES': '#60a5fa', 'RE-ENGAGEMENT': '#fbbf24', 'TIMING & TRIGGERS': '#f87171', 'TIMING': '#f87171', 'TRIGGERS': '#f87171' };
                  const sections = contactRecs.split(/#{2,3}\s+/).filter(Boolean);
                  return (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                      {sections.map((sec, i) => {
                        const lines = sec.trim().split('\n');
                        const titleLine = lines[0].replace(/\*+/g, '').trim();
                        const titleKey = Object.keys(sectionIcons).find(k => titleLine.toUpperCase().includes(k)) || '';
                        const icon = sectionIcons[titleKey] || '📋';
                        const color = sectionColors[titleKey] || 'var(--globant-info)';
                        const body = lines.slice(1).join('\n').trim();

                        const renderLine = (line, li) => {
                          const clean = line.replace(/^[\s-]*\d*\.?\s*/, '').trim();
                          if (!clean) return null;
                          // Parse **bold** segments
                          const parts = clean.split(/(\*\*[^*]+\*\*)/g);
                          return (
                            <div key={li} style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                              <span style={{ color, fontSize: 8, marginTop: 6 }}>●</span>
                              <span style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--globant-text)' }}>
                                {parts.map((p, pi) => p.startsWith('**') && p.endsWith('**')
                                  ? <strong key={pi} style={{ color }}>{p.slice(2, -2)}</strong>
                                  : <span key={pi}>{p}</span>
                                )}
                              </span>
                            </div>
                          );
                        };

                        return (
                          <div key={i} style={{ background: 'var(--globant-darker)', borderRadius: 10, padding: '14px 16px', border: `1px solid ${color}22` }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                              <span style={{ fontSize: 18 }}>{icon}</span>
                              <span style={{ fontSize: 13, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{titleLine}</span>
                            </div>
                            {body.split('\n').map((line, li) => renderLine(line, li))}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              {/* Stakeholder Map */}
              <div className="card">
                <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <h3>👥 Stakeholder Map ({stakeholderEngagement.length})</h3>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input className="input-field" style={{ maxWidth: 200, fontSize: 12, padding: '6px 12px' }}
                      placeholder="Search by name or role..."
                      value={stakeholderSearch} onChange={e => setStakeholderSearch(e.target.value)} />
                    <button className="action-btn btn-ghost" style={{ fontSize: 10, padding: '5px 10px', whiteSpace: 'nowrap' }}
                      onClick={bulkGeneratePainPoints} disabled={bulkPainLoading}>
                      {bulkPainLoading ? `⏳ ${bulkPainProgress}` : '🧠 Bulk Pain Points'}
                    </button>
                    <button className="action-btn btn-primary" style={{ fontSize: 10, padding: '5px 10px', whiteSpace: 'nowrap' }}
                      onClick={() => setShowNewStakeholder(!showNewStakeholder)}>
                      {showNewStakeholder ? '✕ Close' : '➕ Add Contact'}
                    </button>
                  </div>
                </div>

                {/* New Stakeholder Form */}
                {showNewStakeholder && (
                  <div style={{ padding: '14px', background: 'var(--globant-darker)', borderRadius: 8, marginBottom: 12, border: '1px solid var(--globant-border)' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--globant-green)', marginBottom: 10 }}>New Contact for {name}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
                      <div>
                        <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>FIRST NAME *</label>
                        <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                          placeholder="e.g. Khalid" value={newStkName} onChange={e => setNewStkName(e.target.value)} />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>LAST NAME</label>
                        <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                          placeholder="e.g. Al-Rashid" value={newStkLastName} onChange={e => setNewStkLastName(e.target.value)} />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>ROLE</label>
                        <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                          placeholder="e.g. CTO" value={newStkRole} onChange={e => setNewStkRole(e.target.value)} />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>EMAIL</label>
                        <input className="input-field" type="email" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                          placeholder="khalid@company.com" value={newStkEmail} onChange={e => setNewStkEmail(e.target.value)} />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>PHONE</label>
                        <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                          placeholder="+971..." value={newStkPhone} onChange={e => setNewStkPhone(e.target.value)} />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>LINKEDIN URL</label>
                        <input className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                          placeholder="https://linkedin.com/in/..." value={newStkLinkedin} onChange={e => setNewStkLinkedin(e.target.value)} />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 10, color: 'var(--globant-muted)', marginBottom: 3, fontWeight: 600 }}>INFLUENCE</label>
                        <select className="input-field" style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                          value={newStkInfluence} onChange={e => setNewStkInfluence(e.target.value)}>
                          <option value="">Select...</option>
                          <option value="High">High</option>
                          <option value="Medium">Medium</option>
                          <option value="Low">Low</option>
                        </select>
                      </div>
                    </div>
                    <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                      <button className="action-btn btn-primary" style={{ fontSize: 12 }}
                        onClick={createStakeholder} disabled={!newStkName.trim() || creatingStk}>
                        {creatingStk ? '⏳ Creating...' : '🚀 Create Contact'}
                      </button>
                      <button className="action-btn btn-ghost" style={{ fontSize: 12 }}
                        onClick={() => setShowNewStakeholder(false)}>Cancel</button>
                    </div>
                  </div>
                )}
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table">
                    <thead><tr><th>Name</th><th>Role</th><th>Influence</th><th>Last Contact</th><th>Pain Points</th><th>LinkedIn Insights</th><th>Status</th><th style={{ textAlign: 'center' }}>Actions</th></tr></thead>
                    <tbody>
                      {stakeholderEngagement
                        .filter(({ s, sName }) => {
                          if (!stakeholderSearch) return true;
                          const term = stakeholderSearch.toLowerCase();
                          return sName.toLowerCase().includes(term) || (F(s, 'Role') || '').toLowerCase().includes(term);
                        })
                        .map(({ s, sName, hasReplied, hasMeeting, totalTouches, lastTouch, daysSince }) => {
                        const pain = F(s, 'Pain Points (Generated)') || F(s, 'Pain points') || '';
                        const painText = typeof pain === 'string' ? pain : String(pain);
                        const liRaw = F(s, 'LinkedIn News (Generated)') || F(s, 'Linkedin lates news') || '';
                        const linkedinText = typeof liRaw === 'string' ? liRaw : String(liRaw);
                        const phone = F(s, 'Phone number');
                        const email = F(s, 'Email');
                        const linkedin = F(s, 'LinkedIn');
                        return (
                          <tr key={s.id}>
                            <td style={{ fontWeight: 600, cursor: 'pointer', color: 'var(--globant-green)' }} onClick={() => setHistoryStakeholder(s)}>{sName}</td>
                            <td style={{ fontSize: 12 }}>{F(s, 'Role')}</td>
                            <td>{F(s, 'Level of Influence') ? <span className="badge badge-accent">{F(s, 'Level of Influence')}</span> : '—'}</td>
                            <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                              {lastTouch ? (
                                <span style={{ color: daysSince > 14 ? '#ef4444' : daysSince > 7 ? '#fbbf24' : '#60a5fa', fontWeight: 600 }}>
                                  {new Date(lastTouch.fields?.['Date']).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                                  <span style={{ fontSize: 10, opacity: 0.8, marginLeft: 4 }}>({daysSince}d)</span>
                                </span>
                              ) : (
                                <span className="badge" style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444', fontSize: 10 }}>Never</span>
                              )}
                            </td>
                            <td style={{ fontSize: 12, maxWidth: 200, lineHeight: 1.4 }}>{painText.length > 100 ? painText.slice(0, 100) + '...' : painText || <span style={{ color: 'var(--globant-muted)' }}>—</span>}</td>
                            <td style={{ fontSize: 12, maxWidth: 200, lineHeight: 1.4 }}>{linkedinText.length > 100 ? linkedinText.slice(0, 100) + '...' : linkedinText || <span style={{ color: 'var(--globant-muted)' }}>—</span>}</td>
                            <td>
                              {hasMeeting ? <span className="badge badge-blue">Meeting</span> :
                               hasReplied ? <span className="badge badge-green">Replied</span> :
                               totalTouches > 0 ? <span className="badge badge-yellow">Waiting</span> :
                               <span className="badge" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>No contact</span>}
                            </td>
                            <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                              <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                                <button title="Generate AI Message" style={{ background: 'rgba(191,215,48,0.12)', border: '1px solid rgba(191,215,48,0.3)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 13 }}
                                  onClick={() => setCpSelectedStakeholder(s)}>✉️</button>
                                <button title="Schedule Meeting" style={{ background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.3)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 13 }}
                                  onClick={() => { setCpMeetingModal({ stakeholder: s }); setCpMeetingNotes(''); setCpMeetingDate(''); setCpMeetingTime(''); }}>📅</button>
                                <button title="Log Call" style={{ background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 13 }}
                                  onClick={() => { setCpCallModal(s); setCpCallNotes(''); }}>📞</button>
                                {phone && <button title={`WhatsApp: ${phone}`} style={{ background: 'rgba(37,211,102,0.12)', border: '1px solid rgba(37,211,102,0.3)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 13 }}
                                  onClick={() => window.open(`https://wa.me/${String(phone).replace(/[^0-9+]/g, '')}`, '_blank')}>💬</button>}
                                {linkedin && <button title="Open LinkedIn" style={{ background: 'rgba(10,102,194,0.12)', border: '1px solid rgba(10,102,194,0.3)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#0A66C2' }}
                                  onClick={() => window.open(linkedin, '_blank')}>in</button>}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* AI Message Modal */}
          {cpSelectedStakeholder && (
            <AIMessageModal
              stakeholder={cpSelectedStakeholder}
              onClose={() => setCpSelectedStakeholder(null)}
              onSend={cpUseMessage}
              data={data}
            />
          )}

          {/* Meeting Modal */}
          {cpMeetingModal && (() => {
            const ms = cpMeetingModal.stakeholder;
            const msName = F(ms, 'Name') + (F(ms, 'Lart name') ? ` ${F(ms, 'Lart name')}` : '');
            const msRole = F(ms, 'Role') || '';
            const msEmail = F(ms, 'Email') || '';
            const msAccNames = resolveLinked(ms, 'Account', accounts, 'Account Name');
            const buildCalendarUrl = () => {
              const startDt = new Date(`${cpMeetingDate}T${cpMeetingTime || '10:00'}`);
              const endDt = new Date(startDt.getTime() + 60 * 60 * 1000);
              const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
              const title = `${COMPANY_PROFILE.companyName} x ${msAccNames[0] || 'Account'} — ${msName}`;
              const details = `Meeting with ${msName} (${msRole}) at ${msAccNames.join(', ')}\n\n${cpMeetingNotes || 'Intro call'}`;
              return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${fmt(startDt)}/${fmt(endDt)}&details=${encodeURIComponent(details)}${msEmail ? `&add=${encodeURIComponent(msEmail)}` : ''}`;
            };
            return (
              <div className="modal-overlay" onClick={() => setCpMeetingModal(null)}>
                <div className="modal" onClick={e => e.stopPropagation()}>
                  <h3>📅 Schedule Meeting</h3>
                  <div style={{ fontSize: 13, color: 'var(--globant-muted)', marginBottom: 4 }}>{msName} · {msRole}</div>
                  <div style={{ fontSize: 12, color: 'var(--globant-accent)', marginBottom: 14 }}>{msAccNames.join(', ')}</div>
                  <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>DATE</label>
                      <input type="date" className="input-field" style={{ width: '100%' }} value={cpMeetingDate} onChange={e => setCpMeetingDate(e.target.value)} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>TIME</label>
                      <input type="time" className="input-field" style={{ width: '100%' }} value={cpMeetingTime} onChange={e => setCpMeetingTime(e.target.value)} />
                    </div>
                  </div>
                  <label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>NOTES / AGENDA</label>
                  <textarea className="input-field" style={{ width: '100%', minHeight: 70, resize: 'vertical', marginBottom: 14, fontFamily: 'inherit', fontSize: 12 }}
                    placeholder="Meeting topic, agenda..." value={cpMeetingNotes} onChange={e => setCpMeetingNotes(e.target.value)} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="action-btn btn-ghost" style={{ flex: 1 }} onClick={() => setCpMeetingModal(null)}>Cancel</button>
                    {cpMeetingDate && (
                      <button className="action-btn" style={{ flex: 1, background: 'rgba(66,133,244,0.15)', color: '#4285f4', border: '1px solid rgba(66,133,244,0.3)' }}
                        onClick={() => window.open(buildCalendarUrl(), '_blank')}>📆 Open in Calendar</button>
                    )}
                    <button className="action-btn" style={{ flex: 1, background: 'rgba(96,165,250,0.2)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.4)' }}
                      onClick={async () => { await cpLogMeeting(ms, cpMeetingNotes, cpMeetingDate); setCpMeetingModal(null); }}>
                      ✅ Log Meeting
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Log Call Modal */}
          {cpCallModal && (
            <div className="modal-overlay" onClick={() => setCpCallModal(null)}>
              <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
                <h3>📞 Log Call</h3>
                <div style={{ fontSize: 13, color: 'var(--globant-muted)', marginBottom: 12 }}>
                  {F(cpCallModal, 'Name')}{F(cpCallModal, 'Lart name') ? ` ${F(cpCallModal, 'Lart name')}` : ''} · {F(cpCallModal, 'Role')}
                </div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--globant-muted)', marginBottom: 4, fontWeight: 600 }}>CALL NOTES</label>
                <textarea className="input-field" style={{ width: '100%', minHeight: 90, resize: 'vertical', marginBottom: 14, fontFamily: 'inherit', fontSize: 12 }}
                  placeholder="What was discussed? Key takeaways, next steps..." value={cpCallNotes} onChange={e => setCpCallNotes(e.target.value)} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="action-btn btn-ghost" style={{ flex: 1 }} onClick={() => setCpCallModal(null)}>Cancel</button>
                  {F(cpCallModal, 'Phone number') && (
                    <button className="action-btn" style={{ flex: 1, background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }}
                      onClick={() => window.open(`tel:${F(cpCallModal, 'Phone number')}`, '_self')}>📱 Dial</button>
                  )}
                  <button className="action-btn" style={{ flex: 1, background: 'rgba(96,165,250,0.2)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.4)' }}
                    onClick={async () => { await cpLogCall(cpCallModal, cpCallNotes); setCpCallModal(null); }}>
                    ✅ Log Call
                  </button>
                </div>
              </div>
            </div>
          )}

          {historyStakeholder && (
            <StakeholderHistoryModal
              stakeholder={historyStakeholder}
              outreach={outreach}
              accounts={accounts}
              onClose={() => setHistoryStakeholder(null)}
              onRefresh={onLogActivity}
              allData={data}
            />
          )}

          {editingAccount && (
            <EditModal
              title={`Edit: ${F(editingAccount, 'Account Name') || 'Account'}`}
              fields={[
                { key: 'Account Name', label: 'Account Name' },
                { key: 'Website', label: 'Website' },
                { key: 'Industry', label: 'Industry' },
                { key: 'Inside Sales Status', label: 'Inside Sales Status', type: 'select', options: ['Prospect', 'Active Outreach', 'Meeting Booked', 'Qualified', 'Proposal Sent', 'Negotiation', 'Won', 'Lost', 'On Hold', 'Dormant'] },
                { key: 'Company Description', label: 'Company Description', type: 'textarea', fullWidth: true },
              ]}
              initialValues={editingAccount.fields || {}}
              onSave={saveAccountEdit}
              onClose={() => setEditingAccount(null)}
            />
          )}
        </div>
      );
    }

    // ============ INSIGHTS & CONCLUSIONS ============
    function InsightsView({ data }) {
      const { accounts, stakeholders, opportunities, actionPlan, outreach, solutions, events } = data;
      const now = new Date();
      const [timePeriod, setTimePeriod] = useState('all');

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
      const withPregen = stakeholders.filter(s => !!F(s, 'Personalized Email Introduction'));
      const withoutPregen = stakeholders.filter(s => !F(s, 'Personalized Email Introduction'));

      // ─── OUTREACH ANALYSIS ───
      const byChannel = {};
      filteredOutreach.forEach(a => { const ch = F(a, 'Channel'); byChannel[ch] = (byChannel[ch] || 0) + 1; });
      const totalOutreach = filteredOutreach.length;
      const topChannel = Object.entries(byChannel).sort((a, b) => b[1] - a[1])[0];
      const weakChannel = Object.entries(byChannel).sort((a, b) => a[1] - b[1])[0];

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
      const replyRate = totalOutreach > 0 ? Math.round((repliedCount / totalOutreach) * 100) : 0;
      const meetingRate = totalOutreach > 0 ? Math.round((meetingCount / totalOutreach) * 100) : 0;

      // Benchmarks
      const replyBench = replyRate >= 20 ? { label: 'Above benchmark', color: '#4ade80', icon: '🟢' }
        : replyRate >= 8 ? { label: 'On benchmark', color: '#fbbf24', icon: '🟡' }
        : { label: 'Below benchmark (8-20%)', color: '#f87171', icon: '🔴' };
      const meetingBench = meetingRate >= 5 ? { label: 'Above benchmark', color: '#4ade80', icon: '🟢' }
        : meetingRate >= 2 ? { label: 'On benchmark', color: '#fbbf24', icon: '🟡' }
        : { label: 'Below benchmark (2-5%)', color: '#f87171', icon: '🔴' };

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
      conclusions.push({ icon: '💰', title: 'Pipeline Health', text: `${openOpps.length} open opportunities worth ${formatCurrency(totalPipelineValue)}. Win rate: ${winRate}% (${closedWon.length} won / ${closedLost.length} lost).${wonValue > 0 ? ` Total won: ${formatCurrency(wonValue)}.` : ''}` });

      // Message readiness
      const pregenPct = stakeholders.length > 0 ? Math.round((withPregen.length / stakeholders.length) * 100) : 0;
      conclusions.push({ icon: '✉️', title: 'Message Readiness', text: `${withPregen.length} stakeholders (${pregenPct}%) have pre-generated messages. ${withoutPregen.length} still need personalized copy.` });

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

      // Without pre-generated messages
      if (withoutPregen.length > 5) {
        improvements.push({ icon: '✍️', priority: 'medium', title: 'Generate More Messages', text: `${withoutPregen.length} stakeholders don't have AI-generated intros yet. This blocks quick outreach from the Follow-up Center.` });
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

          {/* Scorecard */}
          {timePeriod !== 'all' && (
            <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--globant-green)', fontWeight: 600 }}>
              📅 Showing activity for: {periodLabel}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14, marginBottom: 24 }}>
            <div className="card" style={{ textAlign: 'center', padding: '18px 12px', background: 'linear-gradient(135deg, rgba(191,215,48,0.15) 0%, rgba(191,215,48,0.03) 100%)' }}>
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
              <div style={{ fontSize: 9, color: replyBench.color, marginTop: 4, fontWeight: 600 }}>{replyBench.icon} {replyBench.label}</div>
              <div style={{ fontSize: 9, color: 'var(--globant-muted)', marginTop: 2 }}>Benchmark: 8–20%</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: '18px 12px', borderBottom: `3px solid ${meetingBench.color}` }}>
              <div style={{ fontSize: 32, fontWeight: 800, color: meetingBench.color, lineHeight: 1 }}>{meetingRate}%</div>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Meeting Rate</div>
              <div style={{ fontSize: 9, color: meetingBench.color, marginTop: 4, fontWeight: 600 }}>{meetingBench.icon} {meetingBench.label}</div>
              <div style={{ fontSize: 9, color: 'var(--globant-muted)', marginTop: 2 }}>Benchmark: 2–5%</div>
              <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 4 }}>{meetingCount} meetings / {totalOutreach} touches</div>
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

          {/* Channel Breakdown */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>

            <div className="card" style={{ borderLeft: '3px solid var(--globant-accent)' }}>
              <div className="card-header"><h3>📡 Channel Breakdown {timePeriod !== 'all' ? `(${periodLabel})` : ''}</h3></div>
              <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--globant-muted)' }}>{totalOutreach} activities across {Object.keys(byChannel).length} channels</div>
              {Object.entries(byChannel).sort((a, b) => b[1] - a[1]).map(([ch, count], i) => {
                const pct = totalOutreach > 0 ? (count / totalOutreach) * 100 : 0;
                const chColors = { WhatsApp: '#25D366', Email: '#60a5fa', LinkedIn: '#0A66C2', Call: '#fbbf24' };
                const color = chColors[ch] || '#a78bfa';
                return (
                  <div key={ch} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                      <span style={{ fontWeight: 600 }}>{channelIcon[ch] || '📋'} {ch}</span>
                      <span style={{ fontWeight: 700 }}>{count} <span style={{ fontSize: 10, color: 'var(--globant-muted)', fontWeight: 400 }}>({Math.round(pct)}%)</span></span>
                    </div>
                    <div style={{ height: 8, borderRadius: 4, background: 'var(--globant-darker)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 4, width: `${pct}%`, background: color, transition: 'width 0.3s' }} />
                    </div>
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

          {/* Account Performance Table */}
          <div className="card">
            <div className="card-header"><h3>📊 Account Performance Ranking</h3></div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th style={{ textAlign: 'center' }}>Tier</th>
                    <th style={{ textAlign: 'center' }}>Status</th>
                    <th style={{ textAlign: 'center' }}>Stakeholders</th>
                    <th style={{ textAlign: 'center' }}>Outreach</th>
                    <th style={{ textAlign: 'center' }}>Open Opps</th>
                    <th style={{ textAlign: 'right' }}>Pipeline</th>
                    <th style={{ textAlign: 'center' }}>Solution</th>
                  </tr>
                </thead>
                <tbody>
                  {accountPerformance.map((a, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{a.name}</td>
                      <td style={{ textAlign: 'center' }}>{a.tier ? <span className="badge badge-accent">{a.tier}</span> : '—'}</td>
                      <td style={{ textAlign: 'center' }}>{a.status ? <span className="badge badge-blue">{a.status}</span> : '—'}</td>
                      <td style={{ textAlign: 'center' }}>{a.stakeholderCount}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{ fontWeight: 700, color: a.outreachCount > 0 ? 'var(--globant-green)' : 'var(--globant-warning)' }}>{a.outreachCount}</span>
                      </td>
                      <td style={{ textAlign: 'center' }}>{a.openOppCount > 0 ? <span className="badge badge-blue">{a.openOppCount}</span> : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{a.pipelineValue > 0 ? formatCurrency(a.pipelineValue) : '—'}</td>
                      <td style={{ textAlign: 'center' }}>{a.hasSolution ? '✅' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                      <span><span style={{ fontWeight: 600 }}>{F(s, 'Name')}{F(s, 'Lart name') ? ` ${F(s, 'Lart name')}` : ''}</span> <span style={{ color: 'var(--globant-muted)' }}>({F(s, 'Role')})</span></span>
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
    function EventsHub({ data, api, onLogActivity, onAddRecord, onUpdateRecord }) {
      const { accounts, stakeholders, events, outreach } = data;
      const [selectedEventId, setSelectedEventId] = useState(null);
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
      const [evCreating, setEvCreating] = useState(false);
      const [editingEvent, setEditingEvent] = useState(null);
      const now = new Date();

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
          alert('Failed to save event changes');
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
        if (evNewWebsite.trim()) fields['Website'] = evNewWebsite.trim();
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
          .catch(e => { console.error(e); alert('Failed to create event'); if (onLogActivity) onLogActivity(); });
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

      // Invite function
      const inviteStakeholder = async (stakeholder, event, channel) => {
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

        const companyIds = linkedIds(stakeholder, 'Account');
        try {
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
            'BDR Owner': CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '',
            'CP Assigned': CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '',
          });
          // 2. Add stakeholder to event's "Stakeholders invited" field
          const currentInvited = linkedIds(event, 'Stakeholders invited');
          if (!currentInvited.includes(stakeholder.id)) {
            await a.updateRecord(TABLE_IDS.events, event.id, {
              'Stakeholders invited': [...currentInvited, stakeholder.id]
            });
          }
          await activateAccountIfNeeded(a, companyIds, data.accounts);
          if (onLogActivity) onLogActivity();
        } catch (e) { console.error('Event invite log failed:', e); }
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
            return `ID:${s.id} | ${F(s, 'Name')} ${F(s, 'Lart name') || ''} | ${F(s, 'Role') || '?'} at ${accNames.join(', ')} | Industry: ${accIndustries.join(', ')} | Influence: ${F(s, 'Level of Influence') || '?'} | Pain: ${painStr}`;
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
          alert('Failed to generate suggestions. Check console.');
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
          alert('Failed to remove invitation');
        }
        setRemovingInvite(null);
      };

      const evUseMessage = async (stakeholder, channel, message, ccList = []) => {
        const sn = F(stakeholder, 'Name') || '';
        const email = F(stakeholder, 'Email') || '';
        const phone = F(stakeholder, 'Phone number') || '';
        const linkedin = F(stakeholder, 'LinkedIn') || '';
        let subject = '', body = message;
        if (channel === 'Email' && message.startsWith('Subject:')) {
          const lines = message.split('\n');
          subject = lines[0].replace('Subject:', '').trim();
          body = lines.slice(1).join('\n').trim();
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
            'BDR Owner': CURRENT_USER?.role === 'bdr' ? CURRENT_USER?.name || '' : '',
            'CP Assigned': CURRENT_USER?.role === 'cp' ? CURRENT_USER?.name || '' : '',
          });
          await activateAccountIfNeeded(a, companyIds, data.accounts);
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
                <button className="action-btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setSelectedEventId(null)}>← Back to all events</button>
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
            {(context || summary) && (
              <div className="card">
                <div className="card-header"><h3>📝 Event Details</h3></div>
                {context && <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--globant-text)', whiteSpace: 'pre-wrap', marginBottom: summary ? 14 : 0 }}>{context}</div>}
                {summary && (
                  <div style={{ padding: '10px 14px', background: 'rgba(191,215,48,0.06)', borderRadius: 8, borderLeft: '3px solid var(--globant-accent)' }}>
                    <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 6 }}>📎 Attachment Summary</div>
                    <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--globant-text)', whiteSpace: 'pre-wrap' }}>{typeof summary === 'string' ? summary.slice(0, 500) : String(summary).slice(0, 500)}</div>
                  </div>
                )}
              </div>
            )}

            {/* AI Invitation Message */}
            {aiInviteMsg && (
              <div className="card">
                <div className="card-header"><h3>✨ AI Invitation Message</h3></div>
                <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--globant-text)', whiteSpace: 'pre-wrap', padding: '10px 14px', background: 'rgba(191,215,48,0.06)', borderRadius: 8 }}>{aiInviteMsg}</div>
              </div>
            )}

            {/* Invited Stakeholders grouped by account */}
            <div className="card">
              <div className="card-header"><h3>✅ Invited Stakeholders ({invitedStakeholders.length})</h3></div>
              {invitedStakeholders.length === 0 && <p style={{ color: 'var(--globant-warning)', fontSize: 13 }}>No stakeholders invited yet.</p>}
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
                      <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', marginBottom: 4, background: 'rgba(191,215,48,0.04)', borderRadius: 6 }}>
                        <div>
                          <span style={{ fontWeight: 600, fontSize: 13, cursor: 'pointer', color: 'var(--globant-green)' }} onClick={() => setEvHistoryStakeholder(s)}>
                            {F(s, 'Name')}{F(s, 'Lart name') ? ` ${F(s, 'Lart name')}` : ''}
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
                        <div key={s.id} style={{ padding: '10px 12px', marginBottom: 6, background: 'rgba(191,215,48,0.06)', borderRadius: 8, border: '1px solid rgba(191,215,48,0.15)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: reason ? 4 : 0 }}>
                            <div>
                              <span style={{ fontWeight: 600, fontSize: 13, cursor: 'pointer', color: 'var(--globant-green)' }} onClick={() => setEvHistoryStakeholder(s)}>
                                {F(s, 'Name')}{F(s, 'Lart name') ? ` ${F(s, 'Lart name')}` : ''}
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
                              {F(s, 'Name')}{F(s, 'Lart name') ? ` ${F(s, 'Lart name')}` : ''}
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

            {/* Stakeholder History Modal */}
            {evHistoryStakeholder && (
              <StakeholderHistoryModal
                stakeholder={evHistoryStakeholder}
                outreach={outreach}
                accounts={accounts}
                onClose={() => setEvHistoryStakeholder(null)}
                onRefresh={onLogActivity}
                allData={data}
              />
            )}

            {/* AI Message Modal */}
            {evSelectedStakeholder && (
              <AIMessageModal
                stakeholder={evSelectedStakeholder}
                onClose={() => setEvSelectedStakeholder(null)}
                onSend={evUseMessage}
                data={data}
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
            <div className="card" style={{ textAlign: 'center', padding: '18px 12px', background: 'linear-gradient(135deg, rgba(191,215,48,0.12) 0%, rgba(191,215,48,0.03) 100%)' }}>
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
                  <div key={ev.id} onClick={() => setSelectedEventId(ev.id)} style={{ padding: '14px 12px', marginBottom: 8, borderRadius: 8, background: 'rgba(191,215,48,0.04)', cursor: 'pointer', transition: 'background 0.2s' }} onMouseEnter={e => e.currentTarget.style.background = 'rgba(191,215,48,0.1)'} onMouseLeave={e => e.currentTarget.style.background = 'rgba(191,215,48,0.04)'}>
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
                  <div key={ev.id} onClick={() => setSelectedEventId(ev.id)} style={{ padding: '12px', marginBottom: 6, borderRadius: 8, background: 'rgba(255,255,255,0.02)', cursor: 'pointer', transition: 'background 0.2s' }} onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'} onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}>
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
                { key: 'Website', label: 'Website' },
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

    // ============ SOLUTIONS HUB ============
    function SolutionsHub({ data, api, onLogActivity, onAddRecord, onDeleteRecord, goToAccount }) {
      const { accounts, stakeholders, opportunities, outreach, solutions } = data;
      const [selectedSolId, setSelectedSolId] = useState('');
      const [searchTerm, setSearchTerm] = useState('');
      const [solNotes, setSolNotes] = useState('');
      const [editingNotes, setEditingNotes] = useState(false);
      const [notesValue, setNotesValue] = useState('');
      const [savingNotes, setSavingNotes] = useState(false);
      const [uploadingFile, setUploadingFile] = useState(false);
      const [aiRecs, setAiRecs] = useState('');
      const [loadingRecs, setLoadingRecs] = useState(false);
      const [showAddAccount, setShowAddAccount] = useState(false);
      const [addingAccount, setAddingAccount] = useState(false);
      const [addAccSearch, setAddAccSearch] = useState('');
      const [solExecSummaryMap, setSolExecSummaryMap] = useState({});
      const [loadingSolSummary, setLoadingSolSummary] = useState(false);
      const solExecSummary = selectedSolId ? (solExecSummaryMap[selectedSolId] || '') : '';
      const setSolExecSummary = (val) => setSolExecSummaryMap(prev => ({ ...prev, [selectedSolId]: val }));

      // ─── NEW SOLUTION ───
      const [showNewSol, setShowNewSol] = useState(false);
      const [newSolForm, setNewSolForm] = useState({ name: '', type: 'Service', description: '', price: '', keyMessage: '' });
      const [savingNewSol, setSavingNewSol] = useState(false);

      const SOL_TYPES = ['Service', 'Product', 'Package', 'Consulting', 'Retainer', 'Other'];

      // ─── OPP EDIT (reuse CPBriefings modal pattern via navigate) ───
      const [solHubEditingOpp, setSolHubEditingOpp] = useState(null);
      const [solHubOppForm, setSolHubOppForm] = useState({});
      const [solHubOppSolIds, setSolHubOppSolIds] = useState([]);
      const [savingSolHubOpp, setSavingSolHubOpp] = useState(false);
      const OPP_STAGES_SH = ['Prospecting','Qualification','Discovery','Proposal','Negotiation','Closed Won','Closed Lost','On Hold'];

      const openSolHubOppEdit = (opp) => {
        setSolHubOppForm({
          name: F(opp, 'Deal/Opp name') || '',
          description: F(opp, 'Description') || '',
          stage: F(opp, 'Stage') || '',
          value: opp.fields?.['Value'] ? String(opp.fields['Value']) : '',
          closeDate: opp.fields?.['close date'] ? String(opp.fields['close date']).slice(0, 10) : '',
          openingDate: opp.fields?.['Opening date'] ? String(opp.fields['Opening date']).slice(0, 10) : '',
          nextStep: F(opp, 'Next step') || '',
        });
        setSolHubOppSolIds(linkedIds(opp, 'Solutions'));
        setSolHubEditingOpp(opp);
      };

      const saveSolHubOpp = async () => {
        if (!solHubEditingOpp || !solHubOppForm.name.trim()) return;
        setSavingSolHubOpp(true);
        try {
          const a = api || new AirtableAPI();
          const fields = { 'Deal/Opp name': solHubOppForm.name.trim() };
          if (solHubOppForm.description.trim()) fields['Description'] = solHubOppForm.description.trim();
          if (solHubOppForm.stage) fields['Stage'] = solHubOppForm.stage;
          if (solHubOppForm.value && !isNaN(Number(solHubOppForm.value))) fields['Value'] = Number(solHubOppForm.value);
          if (solHubOppForm.closeDate) fields['close date'] = solHubOppForm.closeDate;
          if (solHubOppForm.openingDate) fields['Opening date'] = solHubOppForm.openingDate;
          if (solHubOppForm.nextStep.trim()) fields['Next step'] = solHubOppForm.nextStep.trim();
          if (solHubOppSolIds.length > 0) fields['Solutions'] = solHubOppSolIds;
          await a.updateRecord(TABLE_IDS.opportunities, solHubEditingOpp.id, fields);
          setSolHubEditingOpp(null);
          if (onLogActivity) onLogActivity();
        } catch (e) { console.error(e); alert('Failed to save: ' + e.message); }
        setSavingSolHubOpp(false);
      };

      const deleteOppSH = async (opp) => {
        if (!confirm(`Delete "${F(opp, 'Deal/Opp name')}"? This cannot be undone.`)) return;
        if (onDeleteRecord) onDeleteRecord('opportunities', opp.id);
        const a = api || new AirtableAPI();
        a.deleteRecord(TABLE_IDS.opportunities, opp.id).catch(e => { console.error(e); if (onLogActivity) onLogActivity(); });
      };

      const handleCreateSolution = async () => {
        if (!newSolForm.name.trim()) { alert('Solution name is required'); return; }
        setSavingNewSol(true);
        try {
          const a = api || new AirtableAPI();

          // Step 1: create with guaranteed-safe fields only
          const safeFields = { 'Name': newSolForm.name.trim() };
          if (newSolForm.description.trim()) safeFields['Service | Solution Detail'] = newSolForm.description.trim();
          if (newSolForm.keyMessage.trim()) safeFields['Stakeholder Key Message'] = newSolForm.keyMessage.trim();

          const newRec = await a.createRecord(TABLE_IDS.solutions, safeFields);

          // Step 2: try to save Type & Price separately — if fields don't exist in Airtable yet, fail silently
          if (newRec?.id && (newSolForm.type || newSolForm.price.trim())) {
            const extraFields = {};
            if (newSolForm.type) extraFields['Type'] = newSolForm.type;
            if (newSolForm.price.trim()) extraFields['Price'] = newSolForm.price.trim();
            a.updateRecord(TABLE_IDS.solutions, newRec.id, extraFields)
              .catch(e => console.warn('Type/Price fields not in Airtable yet:', e.message));
          }

          if (onAddRecord) onAddRecord('solutions', { ...safeFields, Type: newSolForm.type, Price: newSolForm.price });
          setShowNewSol(false);
          setNewSolForm({ name: '', type: 'Service', description: '', price: '', keyMessage: '' });
          if (onLogActivity) onLogActivity();
          if (newRec?.id) setSelectedSolId(newRec.id);
        } catch (e) {
          console.error(e);
          alert('Failed to create solution: ' + e.message);
        }
        setSavingNewSol(false);
      };

      const now = new Date();

      // Compute metrics per solution
      const solutionMetrics = useMemo(() => {
        return solutions.map(sol => {
          const solAccIds = linkedIds(sol, 'Accounts - New markets');
          const solAccounts = accounts.filter(a => solAccIds.includes(a.id));
          const solStakeholderIds = new Set();
          solAccounts.forEach(a => linkedIds(a, 'Stakeholders').forEach(id => solStakeholderIds.add(id)));
          const solOutreach = outreach.filter(o => linkedIds(o, 'Account').some(aid => solAccIds.includes(aid)));
          const solOpps = opportunities.filter(o => linkedIds(o, 'Solutions').includes(sol.id));
          const openOpps = solOpps.filter(o => !['Closed Won','Closed/Won','Closed Lost','Closed/Lost','Closed/Canceled'].includes(F(o, 'Stage')));
          const pipeline = openOpps.reduce((s, o) => s + (o.fields?.['Value'] || 0), 0);
          const replied = solOutreach.filter(o => F(o, 'Status') === 'Replied').length;
          return {
            sol, id: sol.id, name: F(sol, 'Name') || 'Unnamed',
            accountCount: solAccounts.length,
            stakeholderCount: solStakeholderIds.size,
            outreachCount: solOutreach.length,
            oppCount: solOpps.length,
            openOppCount: openOpps.length,
            pipeline, replied,
          };
        }).sort((a, b) => b.accountCount - a.accountCount);
      }, [solutions, accounts, stakeholders, outreach, opportunities]);

      const filteredSolutions = (searchTerm
        ? solutionMetrics.filter(s => s.name.toLowerCase().includes(searchTerm.toLowerCase()))
        : [...solutionMetrics]
      ).sort((a, b) => a.name.localeCompare(b.name));

      // Selected solution detail
      const selectedSol = selectedSolId ? solutions.find(s => s.id === selectedSolId) : null;
      const selectedMetrics = selectedSolId ? solutionMetrics.find(m => m.id === selectedSolId) : null;

      // Load notes when selecting
      useEffect(() => {
        if (selectedSol) {
          const notes = F(selectedSol, 'Extra imput') || '';
          setSolNotes(typeof notes === 'string' ? notes : '');
          setAiRecs('');
        }
      }, [selectedSolId]);

      // Save notes
      const saveNotes = async () => {
        if (!selectedSol) return;
        setSavingNotes(true);
        try {
          const a = api || new AirtableAPI();
          await a.updateRecord(TABLE_IDS.solutions, selectedSol.id, { 'Extra imput': notesValue });
          setSolNotes(notesValue);
          setEditingNotes(false);
          if (onLogActivity) onLogActivity();
        } catch (e) { console.error(e); alert('Failed to save notes'); }
        setSavingNotes(false);
      };

      // File upload + GPT summary
      const handleFileUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploadingFile(true);
        try {
          const text = await file.text();
          const prompt = `Summarize the following file content. Extract the most relevant points for a B2B sales team selling this solution. Be concise (5-8 bullets max).\n\nFile: ${file.name}\n\n${text.slice(0, 8000)}`;
          const summary = await callOpenAI({ prompt, temperature: 0.4, max_tokens: 500 });
          const entry = `\n\n📎 FILE: ${file.name} (uploaded ${new Date().toLocaleDateString('en-GB')})\n${summary}`;
          const updated = (solNotes || '') + entry;
          const a = api || new AirtableAPI();
          await a.updateRecord(TABLE_IDS.solutions, selectedSol.id, { 'Extra imput': updated });
          setSolNotes(updated);
          if (onLogActivity) onLogActivity();
        } catch (e) { console.error(e); alert('File upload failed'); }
        setUploadingFile(false);
        e.target.value = '';
      };

      // Solution Executive Summary
      const generateSolExecSummary = async () => {
        if (!selectedSol || !selectedMetrics) return;
        setLoadingSolSummary(true);
        try {
          const solAccIds = linkedIds(selectedSol, 'Accounts - New markets');
          const solAccs = accounts.filter(a => solAccIds.includes(a.id));
          const solDetail = F(selectedSol, 'Service | Solution Detail') || '';
          const solDetailText = typeof solDetail === 'string' ? solDetail.slice(0, 800) : '';
          const solOpps = opportunities.filter(o => linkedIds(o, 'Solutions').includes(selectedSol.id));
          const openOpps = solOpps.filter(o => !['Closed Won','Closed/Won','Closed Lost','Closed/Lost','Closed/Canceled'].includes(F(o, 'Stage')));
          const wonOpps = solOpps.filter(o => ['Closed Won','Closed/Won'].includes(F(o, 'Stage')));

          // Account summaries with their news & stakeholder engagement
          const accSummaries = solAccs.slice(0, 15).map(a => {
            const aNews = F(a, 'Recent News') || '';
            const newsSnip = typeof aNews === 'string' ? aNews.slice(0, 150) : '';
            const aStks = stakeholders.filter(s => linkedIds(s, 'Account').includes(a.id));
            const aOutreach = outreach.filter(o => linkedIds(o, 'Account').includes(a.id));
            const replied = aOutreach.filter(o => F(o, 'Status') === 'Replied').length;
            const meetings = aOutreach.filter(o => F(o, 'Status') === 'Meeting Scheduled').length;
            const aOpps = solOpps.filter(o => linkedIds(o, 'Account').includes(a.id));
            return `- ${F(a, 'Account Name')} | ${F(a, 'Industry') || '?'} | Tier: ${F(a, 'Tier') || '?'} | Stakeholders: ${aStks.length} | Outreach: ${aOutreach.length} (${replied} replies, ${meetings} meetings) | Opps: ${aOpps.length}${newsSnip ? ` | News: ${newsSnip}` : ''}`;
          }).join('\n');

          // Stakeholder engagement across all accounts for this solution
          const allStkIds = new Set();
          solAccs.forEach(a => linkedIds(a, 'Stakeholders').forEach(id => allStkIds.add(id)));
          const solStks = stakeholders.filter(s => allStkIds.has(s.id));
          const stkSummary = solStks.slice(0, 20).map(s => {
            const sOut = outreach.filter(o => linkedIds(o, 'Stakeholder').includes(s.id));
            const hasReply = sOut.some(o => F(o, 'Status') === 'Replied');
            const hasMeeting = sOut.some(o => F(o, 'Status') === 'Meeting Scheduled');
            const pain = F(s, 'Pain Points (Generated)') || F(s, 'Pain points') || '';
            const painStr = typeof pain === 'string' ? pain.slice(0, 80) : '';
            const status = hasMeeting ? 'Meeting' : hasReply ? 'Replied' : sOut.length > 0 ? `${sOut.length}x, no reply` : 'Not contacted';
            const accName = resolveLinked(s, 'Account', accounts, 'Account Name')[0] || '?';
            return `- ${F(s, 'Name')} (${F(s, 'Role') || '?'}, ${accName}) — ${status}${painStr ? ` | Pain: ${painStr}` : ''}`;
          }).join('\n');

          // Non-mapped accounts as potential targets
          const nonMapped = accounts.filter(a => !solAccIds.includes(a.id) && linkedIds(a, 'Stakeholders').length > 0);
          const potentialStr = nonMapped.slice(0, 8).map(a => `- ${F(a, 'Account Name')} | ${F(a, 'Industry') || '?'} | Tier: ${F(a, 'Tier') || '?'}`).join('\n');

          const prompt = `You are a senior B2B sales strategist for ${COMPANY_PROFILE.companyName}. Create an EXECUTIVE SUMMARY for this SOLUTION to help a BDR understand the full picture and plan next moves.

SOLUTION: ${F(selectedSol, 'Name')}
DETAIL: ${solDetailText || 'Not available'}
NOTES: ${(solNotes || '').slice(0, 600) || 'None'}

METRICS:
- Accounts mapped: ${selectedMetrics.accountCount}
- Stakeholders: ${selectedMetrics.stakeholderCount}
- Total outreach: ${selectedMetrics.outreachCount}
- Replies: ${selectedMetrics.replied}
- Open opps: ${selectedMetrics.openOppCount} | Won: ${wonOpps.length}
- Pipeline: $${selectedMetrics.pipeline.toLocaleString()}

ACCOUNTS USING THIS SOLUTION:
${accSummaries || 'None'}

TOP STAKEHOLDERS:
${stkSummary || 'None'}

OPEN OPPORTUNITIES:
${openOpps.map(o => `- ${F(o, 'Deal/Opp name')}: Stage=${F(o, 'Stage')}, Value=${o.fields?.['Value'] || 'N/A'}, Next=${F(o, 'Next step') || 'N/A'}`).join('\n') || 'None'}

POTENTIAL NEW ACCOUNTS (not yet mapped):
${potentialStr || 'None'}

Write the Executive Summary with these sections (use ### headers):

### 🛠️ Solution Overview
2-3 sentences: What this solution does, its key value prop for ${COMPANY_PROFILE.market || 'your target market'}, and current positioning status.

### 📊 Traction & Pipeline
2-3 sentences: How is this solution performing? Accounts engaged, outreach results, reply rates, meetings, pipeline value. What's working and what's not.

### 🎯 Top Accounts & Engagement
3-4 sentences: Which accounts are most engaged or promising? Where are we closest to closing? Who's gone cold? Name specific accounts and stakeholders.

### 🔥 Key Pain Points & Triggers
2-3 sentences: Common pain points across stakeholders for this solution. What market triggers or news make this solution relevant right now?

### 📈 Expansion Opportunities
2-3 sentences: Which non-mapped accounts could be good targets? What industries or verticals are underrepresented?

### ⚡ Immediate Actions
4-5 bullet points: Specific things to do THIS WEEK. Name stakeholders, suggest outreach channels, reference concrete triggers.

Be specific. Use real names from the data. No generic advice. Under 350 words total.`;

          setSolExecSummary(await callOpenAI({ prompt, temperature: 0.7, max_tokens: 800 }) || 'Could not generate summary.');
        } catch (e) {
          console.error(e);
          alert('Failed to generate. Error: ' + (e.message || 'unknown error'));
        }
        setLoadingSolSummary(false);
      };

      // AI Recommendations
      const generateRecs = async () => {
        if (!selectedSol || !selectedMetrics) return;
        setLoadingRecs(true);
        try {
          const solAccIds = linkedIds(selectedSol, 'Accounts - New markets');
          const solAccounts = accounts.filter(a => solAccIds.includes(a.id));
          const solDetail = F(selectedSol, 'Service | Solution Detail') || '';
          const solDetailText = typeof solDetail === 'string' ? solDetail.slice(0, 500) : '';
          const keyMsg = F(selectedSol, 'Stakeholder Key Message') || '';
          const keyMsgText = typeof keyMsg === 'string' ? keyMsg.slice(0, 300) : Array.isArray(keyMsg) ? keyMsg.join(', ').slice(0, 300) : '';

          const accSummaries = solAccounts.slice(0, 15).map(a => {
            const aOutreach = outreach.filter(o => linkedIds(o, 'Account').includes(a.id));
            const aOpps = opportunities.filter(o => linkedIds(o, 'Account').includes(a.id));
            const lastOut = aOutreach.sort((x, y) => new Date(y.fields?.['Date'] || 0) - new Date(x.fields?.['Date'] || 0))[0];
            const daysSince = lastOut ? Math.floor((now - new Date(lastOut.fields?.['Date'])) / (1000*60*60*24)) : null;
            return `${F(a, 'Account Name')} | ${F(a, 'Industry') || '?'} | Tier: ${F(a, 'Tier') || '?'} | Outreach: ${aOutreach.length} | Last: ${daysSince !== null ? daysSince + 'd ago' : 'Never'} | Opps: ${aOpps.length}`;
          }).join('\n');

          // Accounts NOT using this solution (potential targets)
          const nonSolAccounts = accounts.filter(a => !solAccIds.includes(a.id) && linkedIds(a, 'Stakeholders').length > 0);
          const potentialTargets = nonSolAccounts.slice(0, 10).map(a => `${F(a, 'Account Name')} | ${F(a, 'Industry') || '?'} | Tier: ${F(a, 'Tier') || '?'} | Stakeholders: ${linkedIds(a, 'Stakeholders').length}`).join('\n');

          const prompt = `You are a senior B2B sales strategist for ${COMPANY_PROFILE.companyName} (${COMPANY_PROFILE.services}).

SOLUTION: ${F(selectedSol, 'Name')}
Detail: ${solDetailText || 'Not available'}
Key Message: ${keyMsgText || 'Not available'}
Notes: ${(solNotes || '').slice(0, 500) || 'None'}

CURRENT ACCOUNTS USING THIS SOLUTION (${solAccounts.length}):
${accSummaries || 'None'}

METRICS:
- Accounts: ${selectedMetrics.accountCount}
- Stakeholders reached: ${selectedMetrics.stakeholderCount}
- Total outreach: ${selectedMetrics.outreachCount}
- Replies: ${selectedMetrics.replied}
- Open opportunities: ${selectedMetrics.openOppCount}
- Pipeline value: $${selectedMetrics.pipeline.toLocaleString()}

POTENTIAL TARGET ACCOUNTS (not yet using this solution):
${potentialTargets || 'None'}

Provide strategic recommendations in these 4 sections (use ### headers):

### 🎯 Expansion Opportunities
Which current accounts should we deepen? Which potential accounts should we pitch this solution to and why?

### 💬 Messaging Strategy
What angles and pain points should we lead with? Tailored by industry if relevant.

### ⚠️ Risk & Gaps
What's weak? Stale accounts, low reply rates, missing stakeholder coverage?

### 📋 Next Actions
Top 5 specific, actionable steps to grow this solution's pipeline in the next 2 weeks.`;

          setAiRecs(await callOpenAI({ prompt, temperature: 0.6, max_tokens: 1200 }) || 'No recommendations generated.');
        } catch (e) { console.error(e); alert('Failed to generate recommendations'); }
        setLoadingRecs(false);
      };

      // Render AI recs with section cards
      const renderRecs = (text) => {
        if (!text) return null;
        const sections = text.split(/###\s+/).filter(Boolean);
        const sectionStyles = [
          { bg: 'rgba(74,222,128,0.06)', border: '#4ade80', color: '#4ade80' },
          { bg: 'rgba(96,165,250,0.06)', border: '#60a5fa', color: '#60a5fa' },
          { bg: 'rgba(251,191,36,0.06)', border: '#fbbf24', color: '#fbbf24' },
          { bg: 'rgba(191,215,48,0.06)', border: '#BFD730', color: '#BFD730' },
        ];
        return (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {sections.map((sec, i) => {
              const lines = sec.trim().split('\n');
              const title = lines[0];
              const body = lines.slice(1).join('\n').trim();
              const st = sectionStyles[i % sectionStyles.length];
              return (
                <div key={i} style={{ padding: '14px', borderRadius: 10, background: st.bg, borderLeft: `3px solid ${st.border}` }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: st.color, marginBottom: 8 }}>{title}</div>
                  <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--globant-text)', whiteSpace: 'pre-wrap' }}>{body}</div>
                </div>
              );
            })}
          </div>
        );
      };

      // ─── ADD ACCOUNT TO SOLUTION ───
      const addAccountToSolution = async (accountId) => {
        if (!api || !selectedSol) return;
        setAddingAccount(true);
        try {
          const currentAccIds = linkedIds(selectedSol, 'Accounts - New markets');
          const newAccIds = [...currentAccIds, accountId];
          await api.updateRecord(TABLE_IDS.solutions, selectedSol.id, { 'Accounts - New markets': newAccIds.map(id => ({ id })) });
          setShowAddAccount(false);
          setAddAccSearch('');
          if (onLogActivity) onLogActivity();
        } catch (e) {
          alert('Error adding account: ' + e.message);
        }
        setAddingAccount(false);
      };

      // ─── DETAIL VIEW ───
      if (selectedSol && selectedMetrics) {
        const solAccIds = linkedIds(selectedSol, 'Accounts - New markets');
        const solAccounts = accounts.filter(a => solAccIds.includes(a.id));
        const solStakeholders = [];
        solAccounts.forEach(a => {
          linkedIds(a, 'Stakeholders').forEach(sid => {
            const s = stakeholders.find(st => st.id === sid);
            if (s) solStakeholders.push({ s, account: a });
          });
        });
        const solOutreach = outreach.filter(o => linkedIds(o, 'Account').some(aid => solAccIds.includes(aid)));
        const solOpps = opportunities.filter(o => linkedIds(o, 'Solutions').includes(selectedSol.id));
        const openOpps = solOpps.filter(o => !['Closed Won','Closed/Won','Closed Lost','Closed/Lost','Closed/Canceled'].includes(F(o, 'Stage')));

        // Notes rendering
        const renderNotes = (text) => {
          if (!text) return null;
          const parts = text.split(/(📎 FILE:.*?)(?=\n📎 FILE:|$)/s).filter(Boolean);
          return parts.map((part, i) => {
            if (part.startsWith('📎 FILE:')) {
              return (
                <div key={i} style={{ padding: '8px 10px', background: 'rgba(96,165,250,0.06)', borderRadius: 6, border: '1px solid rgba(96,165,250,0.15)', marginBottom: 6, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                  {part}
                </div>
              );
            }
            return <div key={i} style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', marginBottom: 6 }}>{part}</div>;
          });
        };

        const solType = F(selectedSol, 'Type') || '';
        const solPrice = F(selectedSol, 'Price') || '';
        const typeColor = solType === 'Service' ? '#60a5fa' : solType === 'Product' ? '#4ade80' : solType === 'Retainer' ? 'var(--globant-accent)' : solType === 'Consulting' ? '#fbbf24' : '#60a5fa';

        return (
          <div>
            <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <button className="action-btn btn-ghost" style={{ fontSize: 11, marginBottom: 8 }} onClick={() => { setSelectedSolId(''); setAiRecs(''); }}>← Back to Solutions</button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <h1 style={{ margin: 0 }}>🛠️ {F(selectedSol, 'Name')}</h1>
                  {solType && <span style={{ background: `${typeColor}20`, color: typeColor, border: `1px solid ${typeColor}50`, borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 700 }}>{solType}</span>}
                  {solPrice && <span style={{ background: 'rgba(191,215,48,0.15)', color: 'var(--globant-green)', border: '1px solid rgba(191,215,48,0.3)', borderRadius: 6, padding: '3px 12px', fontSize: 13, fontWeight: 700 }}>💰 {solPrice}</span>}
                </div>
                <p style={{ marginTop: 6 }}>{F(selectedSol, 'Service | Solution Detail') ? (typeof F(selectedSol, 'Service | Solution Detail') === 'string' ? F(selectedSol, 'Service | Solution Detail').slice(0, 180) : '') : 'No detail available'}</p>
              </div>
              <button className="action-btn btn-primary" style={{ fontSize: 12 }} onClick={generateRecs} disabled={loadingRecs}>
                {loadingRecs ? '⏳ Analyzing...' : '✨ AI Recommendations'}
              </button>
            </div>

            {/* KPIs */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14, marginBottom: 24 }}>
              <div className="card" style={{ textAlign: 'center', padding: '16px 12px', background: 'linear-gradient(135deg, rgba(191,215,48,0.12) 0%, rgba(191,215,48,0.03) 100%)' }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--globant-green)', lineHeight: 1 }}>{selectedMetrics.accountCount}</div>
                <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Accounts</div>
              </div>
              <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--globant-info)', lineHeight: 1 }}>{selectedMetrics.stakeholderCount}</div>
                <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Stakeholders</div>
              </div>
              <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--globant-success)', lineHeight: 1 }}>{selectedMetrics.outreachCount}</div>
                <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Outreach</div>
              </div>
              <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--globant-warning)', lineHeight: 1 }}>{selectedMetrics.openOppCount}</div>
                <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Open Opps</div>
              </div>
              <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--globant-green)', lineHeight: 1 }}>{selectedMetrics.pipeline > 0 ? '$' + (selectedMetrics.pipeline / 1000).toFixed(0) + 'K' : '$0'}</div>
                <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Pipeline</div>
              </div>
            </div>

            {/* AI Recommendations */}
            {aiRecs && (
              <div className="card" style={{ borderLeft: '3px solid var(--globant-green)', marginBottom: 16 }}>
                <div className="card-header"><h3>🤖 AI Strategic Recommendations</h3></div>
                {renderRecs(aiRecs)}
              </div>
            )}

            {/* Executive Summary */}
            <div className="card" style={{ borderLeft: '3px solid var(--globant-accent)', marginBottom: 16 }}>
              <div className="card-header">
                <h3>🧠 Executive Summary</h3>
                <button className="action-btn btn-primary" style={{ fontSize: 11 }}
                  onClick={generateSolExecSummary} disabled={loadingSolSummary}>
                  {loadingSolSummary ? '⏳ Generating...' : solExecSummary ? '🔄 Regenerate' : '✨ Generate with AI'}
                </button>
              </div>
              {!solExecSummary && !loadingSolSummary && (
                <p style={{ color: 'var(--globant-muted)', fontSize: 12, fontStyle: 'italic' }}>
                  Generate an AI-powered executive summary with solution traction, top accounts, pain points, expansion opportunities, and immediate actions.
                </p>
              )}
              {solExecSummary && (() => {
                const lines = solExecSummary.split('\n').filter(l => l.trim());
                return (
                  <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                    {lines.map((line, i) => {
                      if (line.startsWith('### ')) return <h4 key={i} style={{ margin: '12px 0 4px', fontSize: 13, fontWeight: 700, color: 'var(--globant-text)' }}>{line.replace('### ', '')}</h4>;
                      if (line.startsWith('- ') || line.startsWith('* ')) return <div key={i} style={{ paddingLeft: 12, marginBottom: 3, position: 'relative' }}><span style={{ position: 'absolute', left: 0 }}>•</span>{line.slice(2)}</div>;
                      return <p key={i} style={{ margin: '3px 0', color: 'var(--globant-text-secondary)' }}>{line}</p>;
                    })}
                  </div>
                );
              })()}
            </div>

            {/* Two columns: Notes + Accounts */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              {/* Notes & Files */}
              <div className="card" style={{ borderLeft: '3px solid var(--globant-info)' }}>
                <div className="card-header">
                  <h3>📝 Solution Notes & Files</h3>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {!editingNotes ? (
                      <button className="action-btn btn-ghost" style={{ fontSize: 10 }} onClick={() => { setEditingNotes(true); setNotesValue(solNotes); }}>
                        {solNotes ? '✏️ Edit' : '➕ Add Notes'}
                      </button>
                    ) : (
                      <>
                        <button className="action-btn btn-primary" style={{ fontSize: 10 }} onClick={saveNotes} disabled={savingNotes}>{savingNotes ? '⏳' : '💾 Save'}</button>
                        <button className="action-btn btn-ghost" style={{ fontSize: 10 }} onClick={() => setEditingNotes(false)}>Cancel</button>
                      </>
                    )}
                    <label style={{ cursor: 'pointer' }}>
                      <input type="file" accept=".csv,.txt,.json,.md,.html,.tsv,.xml,.pdf" style={{ display: 'none' }} onChange={handleFileUpload} />
                      <span className="action-btn btn-ghost" style={{ fontSize: 10, padding: '3px 10px', display: 'inline-block' }}>{uploadingFile ? '⏳ Processing...' : '📎 Upload File'}</span>
                    </label>
                  </div>
                </div>
                {/* Airtable Attachments from Info field */}
                {(() => {
                  const attachments = selectedSol?.fields?.['Info'];
                  if (!attachments || !Array.isArray(attachments) || attachments.length === 0) return null;
                  return (
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>📁 Attached Files ({attachments.length})</div>
                      {attachments.map((att, i) => (
                        <a key={i} href={att.url} target="_blank" rel="noopener noreferrer"
                          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'rgba(96,165,250,0.06)', borderRadius: 6, border: '1px solid rgba(96,165,250,0.15)', marginBottom: 4, textDecoration: 'none', color: 'var(--globant-text)', fontSize: 12, cursor: 'pointer' }}>
                          <span style={{ fontSize: 16 }}>{att.type?.includes('pdf') ? '📄' : att.type?.includes('image') ? '🖼️' : att.type?.includes('sheet') || att.type?.includes('excel') ? '📊' : att.type?.includes('presentation') || att.type?.includes('powerpoint') ? '📽️' : '📎'}</span>
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.filename || 'Untitled'}</span>
                          <span style={{ fontSize: 10, color: 'var(--globant-muted)', whiteSpace: 'nowrap' }}>{att.size ? (att.size > 1048576 ? (att.size / 1048576).toFixed(1) + ' MB' : (att.size / 1024).toFixed(0) + ' KB') : ''}</span>
                          <span style={{ fontSize: 10, color: 'var(--globant-info)' }}>Open ↗</span>
                        </a>
                      ))}
                    </div>
                  );
                })()}
                {/* Notes */}
                {editingNotes ? (
                  <textarea className="input-field" style={{ width: '100%', minHeight: 150, resize: 'vertical', fontFamily: 'inherit', fontSize: 12 }}
                    value={notesValue} onChange={e => setNotesValue(e.target.value)}
                    placeholder="Add notes about this solution — positioning, competitive intel, key differentiators..." />
                ) : (
                  solNotes ? renderNotes(solNotes) : <p style={{ color: 'var(--globant-muted)', fontSize: 12, fontStyle: 'italic' }}>No notes yet. Add context, competitive intel, or upload files.</p>
                )}
              </div>

              {/* Accounts using this solution */}
              <div className="card" style={{ borderLeft: '3px solid var(--globant-green)' }}>
                <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3>🏢 Accounts ({solAccounts.length})</h3>
                  <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 12px' }}
                    onClick={() => { setShowAddAccount(!showAddAccount); setAddAccSearch(''); }}>
                    {showAddAccount ? '✕ Cancel' : '+ Add Account'}
                  </button>
                </div>
                {showAddAccount && (() => {
                  const available = accounts.filter(a => !solAccIds.includes(a.id));
                  const filtered = addAccSearch
                    ? available.filter(a => (F(a, 'Account Name') || '').toLowerCase().includes(addAccSearch.toLowerCase()))
                    : available.slice(0, 20);
                  return (
                    <div style={{ marginBottom: 12, padding: '10px 12px', background: 'rgba(191,215,48,0.06)', borderRadius: 8 }}>
                      <input className="input-field" style={{ width: '100%', marginBottom: 8, fontSize: 12 }}
                        placeholder="Search accounts to add..." value={addAccSearch}
                        onChange={e => setAddAccSearch(e.target.value)} autoFocus />
                      <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                        {filtered.length === 0 ? (
                          <p style={{ fontSize: 11, color: 'var(--globant-muted)', textAlign: 'center', padding: 8 }}>
                            {addAccSearch ? 'No matching accounts found' : 'All accounts already mapped'}
                          </p>
                        ) : filtered.map(a => (
                          <div key={a.id} style={{ padding: '8px 10px', marginBottom: 4, borderRadius: 6, background: 'rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', border: '1px solid rgba(191,215,48,0.1)' }}
                            onClick={() => !addingAccount && addAccountToSolution(a.id)}>
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 12 }}>{F(a, 'Account Name')}</div>
                              <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>
                                {[F(a, 'Industry'), F(a, 'Tier')].filter(Boolean).join(' · ')}
                              </div>
                            </div>
                            <span style={{ fontSize: 11, color: 'var(--globant-green)', fontWeight: 600 }}>
                              {addingAccount ? '...' : '+ Add'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                {solAccounts.length === 0 && !showAddAccount ? (
                  <p style={{ color: 'var(--globant-muted)', fontSize: 12 }}>No accounts mapped to this solution yet.</p>
                ) : solAccounts.length > 0 ? (
                  <div style={{ maxHeight: 350, overflowY: 'auto' }}>
                    {solAccounts.map(a => {
                      const aOut = outreach.filter(o => linkedIds(o, 'Account').includes(a.id));
                      const lastOut = aOut.sort((x, y) => new Date(y.fields?.['Date'] || 0) - new Date(x.fields?.['Date'] || 0))[0];
                      const daysSince = lastOut ? Math.floor((now - new Date(lastOut.fields?.['Date'])) / (1000*60*60*24)) : null;
                      const aOpps = opportunities.filter(o => linkedIds(o, 'Account').includes(a.id)).length;
                      const stCount = linkedIds(a, 'Stakeholders').length;
                      return (
                        <div key={a.id} style={{ padding: '10px 12px', marginBottom: 6, borderRadius: 8, background: 'rgba(191,215,48,0.04)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13, cursor: goToAccount ? 'pointer' : 'default', color: goToAccount ? 'var(--globant-green)' : 'inherit' }}
                              onClick={() => goToAccount && goToAccount(a.id)}
                              title="Open account overview">{F(a, 'Account Name')} →</div>
                            <div style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'flex', gap: 8, marginTop: 2 }}>
                              {F(a, 'Industry') && <span>{F(a, 'Industry')}</span>}
                              {F(a, 'Tier') && <span className="badge badge-accent" style={{ fontSize: 9 }}>{F(a, 'Tier')}</span>}
                              <span>{stCount} contacts</span>
                              <span>{aOut.length} touches</span>
                              {aOpps > 0 && <span style={{ color: 'var(--globant-info)' }}>{aOpps} opps</span>}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', fontSize: 11 }}>
                            {daysSince !== null ? (
                              <span style={{ fontWeight: 600, color: daysSince > 14 ? '#ef4444' : daysSince > 7 ? '#fbbf24' : '#60a5fa' }}>
                                {daysSince}d ago
                              </span>
                            ) : (
                              <span className="badge" style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444', fontSize: 10 }}>Never</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>

            {/* Opp Edit Modal */}
            {solHubEditingOpp && (() => {
              const iStyle = { width: '100%', padding: '7px 10px', background: 'var(--globant-input)', border: '1px solid var(--globant-border)', borderRadius: 6, color: 'var(--globant-text)', fontSize: 13, boxSizing: 'border-box' };
              const lStyle = { fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', display: 'block' };
              return (
                <div className="modal-overlay" onClick={() => setSolHubEditingOpp(null)}>
                  <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <h3 style={{ margin: 0 }}>✏️ Edit Opportunity</h3>
                      <button onClick={() => setSolHubEditingOpp(null)} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div><label style={lStyle}>Name *</label><input style={iStyle} value={solHubOppForm.name} onChange={e => setSolHubOppForm(p => ({ ...p, name: e.target.value }))} /></div>
                      <div><label style={lStyle}>Description</label><textarea style={{ ...iStyle, minHeight: 60, resize: 'vertical' }} value={solHubOppForm.description} onChange={e => setSolHubOppForm(p => ({ ...p, description: e.target.value }))} /></div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <div><label style={lStyle}>Stage</label>
                          <select style={iStyle} value={solHubOppForm.stage} onChange={e => setSolHubOppForm(p => ({ ...p, stage: e.target.value }))}>
                            <option value="">Select...</option>
                            {OPP_STAGES_SH.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                        <div><label style={lStyle}>Value ($)</label><input style={iStyle} type="number" value={solHubOppForm.value} onChange={e => setSolHubOppForm(p => ({ ...p, value: e.target.value }))} /></div>
                        <div><label style={lStyle}>Opening Date</label><input style={iStyle} type="date" value={solHubOppForm.openingDate} onChange={e => setSolHubOppForm(p => ({ ...p, openingDate: e.target.value }))} /></div>
                        <div><label style={lStyle}>Close Date</label><input style={iStyle} type="date" value={solHubOppForm.closeDate} onChange={e => setSolHubOppForm(p => ({ ...p, closeDate: e.target.value }))} /></div>
                      </div>
                      <div><label style={lStyle}>Next Step</label><input style={iStyle} value={solHubOppForm.nextStep} onChange={e => setSolHubOppForm(p => ({ ...p, nextStep: e.target.value }))} /></div>
                      <div>
                        <label style={lStyle}>Solutions</label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                          {solHubOppSolIds.map(sid => {
                            const sol = data.solutions.find(s => s.id === sid);
                            return sol ? <span key={sid} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', display: 'flex', alignItems: 'center', gap: 5 }}>{F(sol, 'Name')} <span style={{ cursor: 'pointer' }} onClick={() => setSolHubOppSolIds(p => p.filter(i => i !== sid))}>✕</span></span> : null;
                          })}
                        </div>
                        <select style={iStyle} value="" onChange={e => { if (e.target.value && !solHubOppSolIds.includes(e.target.value)) setSolHubOppSolIds(p => [...p, e.target.value]); }}>
                          <option value="">+ Add solution...</option>
                          {data.solutions.filter(s => !solHubOppSolIds.includes(s.id)).map(s => <option key={s.id} value={s.id}>{F(s, 'Name')}</option>)}
                        </select>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                      <button className="action-btn btn-primary" style={{ flex: 1 }} onClick={saveSolHubOpp} disabled={savingSolHubOpp}>{savingSolHubOpp ? '⏳ Saving...' : '💾 Save'}</button>
                      <button className="action-btn btn-ghost" onClick={() => setSolHubEditingOpp(null)}>Cancel</button>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Stakeholders + Opportunities */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {/* Stakeholders */}
              <div className="card">
                <div className="card-header"><h3>👥 Stakeholders ({solStakeholders.length})</h3></div>
                {solStakeholders.length === 0 ? (
                  <p style={{ color: 'var(--globant-muted)', fontSize: 12 }}>No stakeholders in mapped accounts.</p>
                ) : (
                  <div style={{ maxHeight: 350, overflowY: 'auto' }}>
                    <table className="data-table">
                      <thead><tr><th>Name</th><th>Role</th><th>Account</th><th>Influence</th><th>Last Contact</th></tr></thead>
                      <tbody>
                        {solStakeholders.map(({ s, account }) => {
                          const sOut = outreach.filter(o => linkedIds(o, 'Stakeholder').includes(s.id))
                            .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
                          const lastTouch = sOut[0];
                          const daysSince = lastTouch ? Math.floor((now - new Date(lastTouch.fields?.['Date'])) / (1000*60*60*24)) : null;
                          return (
                            <tr key={s.id}>
                              <td style={{ fontWeight: 600, fontSize: 12 }}>{F(s, 'Name')}{F(s, 'Lart name') ? ` ${F(s, 'Lart name')}` : ''}</td>
                              <td style={{ fontSize: 11 }}>{F(s, 'Role')}</td>
                              <td style={{ fontSize: 11 }}>{F(account, 'Account Name')}</td>
                              <td>{F(s, 'Level of Influence') ? <span className="badge badge-accent" style={{ fontSize: 9 }}>{F(s, 'Level of Influence')}</span> : '—'}</td>
                              <td style={{ fontSize: 11 }}>
                                {daysSince !== null ? (
                                  <span style={{ fontWeight: 600, color: daysSince > 14 ? '#ef4444' : daysSince > 7 ? '#fbbf24' : '#60a5fa' }}>{daysSince}d</span>
                                ) : <span style={{ color: '#ef4444', fontSize: 10 }}>Never</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Opportunities */}
              <div className="card">
                <div className="card-header"><h3>💰 Opportunities ({solOpps.length})</h3></div>
                {solOpps.length === 0 ? (
                  <p style={{ color: 'var(--globant-muted)', fontSize: 12 }}>No opportunities linked to accounts with this solution.</p>
                ) : (
                  <div style={{ maxHeight: 350, overflowY: 'auto' }}>
                    {solOpps.map(o => {
                      const stage = F(o, 'Stage') || 'Unknown';
                      const isOpen = !['Closed Won','Closed/Won','Closed Lost','Closed/Lost','Closed/Canceled'].includes(stage);
                      const val = o.fields?.['Value'] || 0;
                      const stageColor = stage.toLowerCase().includes('won') ? '#4ade80' : stage.toLowerCase().includes('lost') || stage.toLowerCase().includes('cancel') ? '#ef4444' : isOpen ? '#60a5fa' : '#8888A8';
                      return (
                        <div key={o.id} style={{ padding: '8px 10px', marginBottom: 4, borderRadius: 6, background: `${stageColor}08`, borderLeft: `3px solid ${stageColor}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 12 }}>{F(o, 'Deal/Opp name')}</div>
                            <span className="badge" style={{ background: `${stageColor}20`, color: stageColor, fontSize: 9 }}>{stage}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {val > 0 && <span style={{ fontWeight: 700, fontSize: 12, color: stageColor }}>${(val / 1000).toFixed(0)}K</span>}
                            <button title="Edit" onClick={() => openSolHubOppEdit(o)} style={{ fontSize: 11, padding: '2px 7px', borderRadius: 5, border: '1px solid var(--globant-border)', background: 'rgba(255,255,255,0.04)', color: 'var(--globant-muted)', cursor: 'pointer' }}>✏️</button>
                            <button title="Delete" onClick={() => deleteOppSH(o)} style={{ fontSize: 11, padding: '2px 7px', borderRadius: 5, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', color: '#ef4444', cursor: 'pointer' }}>🗑</button>
                          </div>
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

      // ─── LIST VIEW ───
      return (
        <div>
          <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h1>Solutions Hub</h1>
              <p>Explore solutions, track adoption across accounts, and get strategic recommendations</p>
            </div>
            <button className="action-btn btn-primary" style={{ fontSize: 12, padding: '8px 16px', marginTop: 4 }}
              onClick={() => { setShowNewSol(true); setNewSolForm({ name: '', type: 'Service', description: '', price: '', keyMessage: '' }); }}>
              ➕ New Solution
            </button>
          </div>

          {/* New Solution Modal */}
          {showNewSol && (() => {
            const iStyle = { width: '100%', padding: '8px 10px', background: 'var(--globant-input)', border: '1px solid var(--globant-border)', borderRadius: 6, color: 'var(--globant-text)', fontSize: 13, boxSizing: 'border-box' };
            const lStyle = { fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', display: 'block' };
            return (
              <div className="modal-overlay" onClick={() => setShowNewSol(false)}>
                <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                    <h3 style={{ margin: 0 }}>🛠️ New Solution</h3>
                    <button onClick={() => setShowNewSol(false)} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div>
                      <label style={lStyle}>Name *</label>
                      <input style={iStyle} value={newSolForm.name} onChange={e => setNewSolForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. AI Process Automation" autoFocus />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <div>
                        <label style={lStyle}>Type</label>
                        <select style={iStyle} value={newSolForm.type} onChange={e => setNewSolForm(p => ({ ...p, type: e.target.value }))}>
                          {SOL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                      <div>
                        <label style={lStyle}>Price (optional)</label>
                        <input style={iStyle} value={newSolForm.price} onChange={e => setNewSolForm(p => ({ ...p, price: e.target.value }))} placeholder="e.g. $5,000/mo or From $20K" />
                      </div>
                    </div>
                    <div>
                      <label style={lStyle}>Description</label>
                      <textarea style={{ ...iStyle, minHeight: 80, resize: 'vertical' }} value={newSolForm.description} onChange={e => setNewSolForm(p => ({ ...p, description: e.target.value }))} placeholder="What does this solution do? What problem does it solve?" />
                    </div>
                    <div>
                      <label style={lStyle}>Key Message for Stakeholders (optional)</label>
                      <textarea style={{ ...iStyle, minHeight: 60, resize: 'vertical' }} value={newSolForm.keyMessage} onChange={e => setNewSolForm(p => ({ ...p, keyMessage: e.target.value }))} placeholder="Main value prop to pitch to decision-makers..." />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--globant-muted)', background: 'rgba(96,165,250,0.08)', borderRadius: 6, padding: '8px 12px' }}>
                      💡 To enable Type and Price fields, add them in your Airtable Solutions table: <strong>Type</strong> (Single line text) and <strong>Price</strong> (Single line text)
                    </div>
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                      <button className="action-btn btn-ghost" onClick={() => setShowNewSol(false)}>Cancel</button>
                      <button className="action-btn btn-primary" onClick={handleCreateSolution} disabled={savingNewSol || !newSolForm.name.trim()}>
                        {savingNewSol ? '⏳ Creating...' : '✅ Create Solution'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          <div className="filters-row" style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 }}>
            <input className="input-field" style={{ maxWidth: 350 }} placeholder="Search solution..." value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)} />
            <span style={{ fontSize: 12, color: 'var(--globant-muted)' }}>{solutions.length} solutions</span>
          </div>

          {/* KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 24 }}>
            <div className="card" style={{ textAlign: 'center', padding: '18px 12px', background: 'linear-gradient(135deg, rgba(191,215,48,0.12) 0%, rgba(191,215,48,0.03) 100%)' }}>
              <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--globant-green)', lineHeight: 1 }}>{solutions.length}</div>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Total Solutions</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: '18px 12px' }}>
              <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--globant-info)', lineHeight: 1 }}>{solutionMetrics.reduce((s, m) => s + m.accountCount, 0)}</div>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Total Mappings</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: '18px 12px' }}>
              <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--globant-success)', lineHeight: 1 }}>{solutionMetrics.reduce((s, m) => s + m.outreachCount, 0)}</div>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Total Outreach</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: '18px 12px' }}>
              <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--globant-warning)', lineHeight: 1 }}>${(solutionMetrics.reduce((s, m) => s + m.pipeline, 0) / 1000).toFixed(0)}K</div>
              <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Total Pipeline</div>
            </div>
          </div>

          {/* Solutions list */}
          <div className="card">
            <div className="card-header"><h3>Solutions</h3></div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead><tr>
                  <th>Solution</th>
                  <th>Type</th>
                  <th>Price</th>
                  <th style={{ textAlign: 'center' }}>Accounts</th>
                  <th style={{ textAlign: 'center' }}>Stakeholders</th>
                  <th style={{ textAlign: 'center' }}>Outreach</th>
                  <th style={{ textAlign: 'center' }}>Replies</th>
                  <th style={{ textAlign: 'center' }}>Open Opps</th>
                  <th style={{ textAlign: 'right' }}>Pipeline</th>
                </tr></thead>
                <tbody>
                  {filteredSolutions.map(m => {
                    const solType = F(m.sol, 'Type') || '';
                    const solPrice = F(m.sol, 'Price') || '';
                    const typeColor = solType === 'Service' ? 'badge-blue' : solType === 'Product' ? 'badge-green' : solType === 'Retainer' ? 'badge-accent' : solType === 'Consulting' ? 'badge-yellow' : 'badge-blue';
                    return (
                      <tr key={m.id} onClick={() => { setSelectedSolId(m.id); setSearchTerm(''); }} style={{ cursor: 'pointer' }}>
                        <td style={{ fontWeight: 600 }}>
                          {m.name}
                          {F(m.sol, 'Service | Solution Detail') && (
                            <div style={{ fontSize: 11, color: 'var(--globant-muted)', fontWeight: 400, marginTop: 2, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {typeof F(m.sol, 'Service | Solution Detail') === 'string' ? F(m.sol, 'Service | Solution Detail').slice(0, 80) : ''}
                            </div>
                          )}
                        </td>
                        <td>{solType ? <span className={`badge ${typeColor}`} style={{ fontSize: 10 }}>{solType}</span> : <span style={{ color: 'var(--globant-muted)', fontSize: 11 }}>—</span>}</td>
                        <td style={{ fontSize: 12, fontWeight: 600, color: solPrice ? 'var(--globant-green)' : 'var(--globant-muted)' }}>{solPrice || '—'}</td>
                        <td style={{ textAlign: 'center' }}>{m.accountCount}</td>
                        <td style={{ textAlign: 'center' }}>{m.stakeholderCount}</td>
                        <td style={{ textAlign: 'center' }}><span style={{ fontWeight: 700, color: m.outreachCount > 0 ? 'var(--globant-green)' : 'var(--globant-muted)' }}>{m.outreachCount}</span></td>
                        <td style={{ textAlign: 'center' }}><span style={{ fontWeight: 700, color: m.replied > 0 ? 'var(--globant-success)' : 'var(--globant-muted)' }}>{m.replied}</span></td>
                        <td style={{ textAlign: 'center' }}>{m.openOppCount > 0 ? <span className="badge badge-blue">{m.openOppCount}</span> : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{m.pipeline > 0 ? '$' + (m.pipeline / 1000).toFixed(0) + 'K' : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      );
    }

    // ============ MAIN APP ============
    // ============ LOGIN SCREEN ============
    // ============ ACTIVATION SCREEN ============
    function ActivateScreen({ onBack }) {
      const [inviteCode, setInviteCode] = useState('');
      const [name, setName] = useState('');
      const [email, setEmail] = useState('');
      const [password, setPassword] = useState('');
      const [confirmPw, setConfirmPw] = useState('');
      const [error, setError] = useState('');
      const [success, setSuccess] = useState(false);
      const [loading, setLoading] = useState(false);

      const handleActivate = async (e) => {
        e.preventDefault();
        if (!inviteCode || !name || !email || !password) { setError('All fields are required'); return; }
        if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
        if (password !== confirmPw) { setError('Passwords do not match'); return; }
        setError('');
        setLoading(true);
        try {
          const res = await fetch('/api/auth/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inviteCode: inviteCode.trim(), name: name.trim(), email: email.trim(), password }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Activation failed');
          setSuccess(true);
        } catch (err) {
          setError(err.message || 'Activation failed');
        }
        setLoading(false);
      };

      const inputStyle = { width: '100%', padding: '12px 14px', background: 'var(--globant-darker)', border: '1px solid var(--globant-border)', borderRadius: 8, color: 'var(--globant-text)', fontSize: 14, outline: 'none' };
      const labelStyle = { fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6, display: 'block' };

      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--globant-darker)' }}>
          <div style={{ width: 400, background: 'var(--globant-card)', border: '1px solid var(--globant-border)', borderRadius: 16, padding: 40, textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, background: 'linear-gradient(135deg, #BFD730, #8fa824)', borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 24, color: 'var(--globant-dark)', margin: '0 auto 20px' }}>O</div>
            <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Activate your account</h2>
            <p style={{ fontSize: 13, color: 'var(--globant-muted)', marginBottom: 24 }}>Enter the invite code you received</p>

            {success ? (
              <div>
                <div style={{ color: 'var(--globant-success)', fontSize: 14, marginBottom: 20, padding: '14px', background: 'rgba(74,222,128,0.1)', borderRadius: 8, fontWeight: 600 }}>Account activated successfully!</div>
                <button onClick={onBack} style={{ width: '100%', padding: '13px', background: 'var(--globant-green)', border: 'none', borderRadius: 8, color: 'var(--globant-dark)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Go to Sign In</button>
              </div>
            ) : (
              <form onSubmit={handleActivate}>
                <div style={{ marginBottom: 12, textAlign: 'left' }}>
                  <label style={labelStyle}>Invite Code</label>
                  <input type="text" value={inviteCode} onChange={e => setInviteCode(e.target.value)} placeholder="e.g. EMPX-2026-PRO" style={{...inputStyle, fontFamily: 'monospace', letterSpacing: 1}} autoFocus />
                </div>
                <div style={{ marginBottom: 12, textAlign: 'left' }}>
                  <label style={labelStyle}>Full Name</label>
                  <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" style={inputStyle} />
                </div>
                <div style={{ marginBottom: 12, textAlign: 'left' }}>
                  <label style={labelStyle}>Email</label>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" style={inputStyle} />
                </div>
                <div style={{ marginBottom: 12, textAlign: 'left' }}>
                  <label style={labelStyle}>Password</label>
                  <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Min. 6 characters" style={inputStyle} />
                </div>
                <div style={{ marginBottom: 18, textAlign: 'left' }}>
                  <label style={labelStyle}>Confirm Password</label>
                  <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} placeholder="Repeat your password" style={inputStyle} />
                </div>

                {error && <div style={{ color: 'var(--globant-danger)', fontSize: 12, marginBottom: 14, padding: '8px 12px', background: 'rgba(248,113,113,0.1)', borderRadius: 8 }}>{error}</div>}

                <button type="submit" disabled={loading} style={{ width: '100%', padding: '13px', background: loading ? 'var(--globant-border)' : 'var(--globant-green)', border: 'none', borderRadius: 8, color: 'var(--globant-dark)', fontSize: 14, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer' }}>
                  {loading ? 'Activating...' : 'Activate Account'}
                </button>
              </form>
            )}

            <p style={{ fontSize: 12, color: 'var(--globant-muted)', marginTop: 20, cursor: 'pointer' }} onClick={onBack}>
              Already have an account? <strong style={{ color: 'var(--globant-green)' }}>Sign in</strong>
            </p>
          </div>
        </div>
      );
    }

    // ============ LOGIN SCREEN ============
    function LoginScreen({ onLogin }) {
      const [mode, setMode] = useState('login'); // 'login' or 'activate'
      const [email, setEmail] = useState('');
      const [password, setPassword] = useState('');
      const [error, setError] = useState('');
      const [loading, setLoading] = useState(false);

      if (mode === 'activate') {
        return <ActivateScreen onBack={() => setMode('login')} />;
      }

      const handleSubmit = async (e) => {
        e.preventDefault();
        if (!email || !password) { setError('Enter your email and password'); return; }
        setError('');
        setLoading(true);
        try {
          await loginUser(email.trim(), password);
          onLogin();
        } catch (err) {
          setError(err.message || 'Invalid credentials');
        }
        setLoading(false);
      };

      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--globant-darker)' }}>
          <div style={{ width: 380, background: 'var(--globant-card)', border: '1px solid var(--globant-border)', borderRadius: 16, padding: 40, textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, background: 'linear-gradient(135deg, #BFD730, #8fa824)', borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 24, color: 'var(--globant-dark)', margin: '0 auto 20px' }}>O</div>
            <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Welcome to Oike</h2>
            <p style={{ fontSize: 13, color: 'var(--globant-muted)', marginBottom: 28 }}>Sales Intelligence Platform</p>

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 14, textAlign: 'left' }}>
                <label style={{ fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6, display: 'block' }}>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  style={{ width: '100%', padding: '12px 14px', background: 'var(--globant-darker)', border: '1px solid var(--globant-border)', borderRadius: 8, color: 'var(--globant-text)', fontSize: 14, outline: 'none' }}
                  autoFocus
                />
              </div>
              <div style={{ marginBottom: 20, textAlign: 'left' }}>
                <label style={{ fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6, display: 'block' }}>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  style={{ width: '100%', padding: '12px 14px', background: 'var(--globant-darker)', border: '1px solid var(--globant-border)', borderRadius: 8, color: 'var(--globant-text)', fontSize: 14, outline: 'none' }}
                />
              </div>

              {error && <div style={{ color: 'var(--globant-danger)', fontSize: 12, marginBottom: 14, padding: '8px 12px', background: 'rgba(248,113,113,0.1)', borderRadius: 8 }}>{error}</div>}

              <button
                type="submit"
                disabled={loading}
                style={{ width: '100%', padding: '13px', background: loading ? 'var(--globant-border)' : 'var(--globant-green)', border: 'none', borderRadius: 8, color: 'var(--globant-dark)', fontSize: 14, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', transition: 'all 0.2s' }}
              >
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>

            <p style={{ fontSize: 12, color: 'var(--globant-muted)', marginTop: 20, cursor: 'pointer' }} onClick={() => setMode('activate')}>
              Have an invite code? <strong style={{ color: 'var(--globant-green)' }}>Activate account</strong>
            </p>

            <p style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 16 }}>Powered by <strong style={{ color: 'var(--globant-green)' }}>Oike</strong></p>
          </div>
        </div>
      );
    }

    // ============ SETTINGS MODAL ============
    function SettingsModal({ onClose }) {
      const isAdmin = CURRENT_USER?.role === 'admin';
      const [tab, setTab] = useState('workspace');
      const [profile, setProfile] = useState({ ...COMPANY_PROFILE });
      const [saved, setSaved] = useState(false);

      const handleSave = () => {
        saveCompanyProfile(profile);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      };

      const inputStyle = {
        width: '100%', padding: '8px 10px', background: 'var(--globant-input)',
        border: '1px solid var(--globant-border)', borderRadius: 6,
        color: 'var(--globant-text)', fontSize: 13, boxSizing: 'border-box',
      };
      const labelStyle = { fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', display: 'block' };

      return (
        <div className="modal-overlay" onClick={onClose}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexShrink: 0 }}>
              <h3 style={{ margin: 0 }}>⚙️ Settings</h3>
              <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '1px solid var(--globant-border)', paddingBottom: 12, flexShrink: 0 }}>
              {[
                { key: 'workspace', label: '🏢 Workspace' },
                ...(isAdmin ? [{ key: 'profile', label: '🤖 AI Profile' }] : []),
              ].map(t => (
                <button key={t.key} onClick={() => setTab(t.key)} style={{
                  background: tab === t.key ? 'rgba(191,215,48,0.15)' : 'none',
                  border: tab === t.key ? '1px solid rgba(191,215,48,0.3)' : '1px solid transparent',
                  color: tab === t.key ? 'var(--globant-green)' : 'var(--globant-muted)',
                  borderRadius: 6, padding: '6px 14px', fontSize: 12, cursor: 'pointer', fontWeight: 600,
                }}>{t.label}</button>
              ))}
            </div>

            {/* Workspace tab */}
            {tab === 'workspace' && (
              <div>
                <div style={{ padding: '12px', background: 'var(--globant-darker)', borderRadius: 8, marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase' }}>Workspace</div>
                  <div style={{ fontSize: 14, color: 'var(--globant-text)', fontWeight: 600 }}>{CLIENT_CONFIG.name || 'Oike'}</div>
                  <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 4 }}>Plan: {CLIENT_CONFIG.plan || 'standard'}</div>
                </div>
                <div style={{ padding: '12px', background: 'var(--globant-darker)', borderRadius: 8, marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--globant-muted)', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase' }}>Services</div>
                  <div style={{ fontSize: 12, color: 'var(--globant-green)', marginBottom: 4 }}>✅ Database connected</div>
                  <div style={{ fontSize: 12, color: 'var(--globant-green)' }}>✅ AI engine active</div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--globant-muted)', textAlign: 'center', marginTop: 16 }}>
                  Powered by <strong style={{ color: 'var(--globant-green)' }}>Oike</strong> · Sales Intelligence Platform
                </div>
              </div>
            )}

            {/* AI Profile tab (admin only) */}
            {tab === 'profile' && isAdmin && (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <div style={{ overflowY: 'auto', flex: 1, paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ fontSize: 12, color: 'var(--globant-muted)', background: 'rgba(191,215,48,0.08)', border: '1px solid rgba(191,215,48,0.2)', borderRadius: 8, padding: '10px 14px', lineHeight: 1.6 }}>
                  These values are injected into all AI prompts. Set them to match your company — every client gets their own AI context.
                </div>

                <div>
                  <label style={labelStyle}>Company Name</label>
                  <input style={inputStyle} value={profile.companyName} onChange={e => setProfile(p => ({ ...p, companyName: e.target.value }))} placeholder="e.g. Globant" />
                </div>

                <div>
                  <label style={labelStyle}>Services / Capabilities</label>
                  <input style={inputStyle} value={profile.services} onChange={e => setProfile(p => ({ ...p, services: e.target.value }))} placeholder="e.g. digital transformation, AI, CX, data" />
                  <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 3 }}>Short comma-separated list used in AI prompts</div>
                </div>

                <div>
                  <label style={labelStyle}>Target Market / Region</label>
                  <input style={inputStyle} value={profile.market} onChange={e => setProfile(p => ({ ...p, market: e.target.value }))} placeholder="e.g. MENA, KSA &amp; UAE" />
                </div>

                <div>
                  <label style={labelStyle}>Sender Name</label>
                  <input style={inputStyle} value={profile.senderName} onChange={e => setProfile(p => ({ ...p, senderName: e.target.value }))} placeholder="e.g. Alejandra Cadario" />
                  <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 3 }}>Name used in message sign-offs and AI context</div>
                </div>

                <div>
                  <label style={labelStyle}>Sender Title</label>
                  <input style={inputStyle} value={profile.senderTitle} onChange={e => setProfile(p => ({ ...p, senderTitle: e.target.value }))} placeholder="e.g. Business Consultant" />
                </div>

                <div>
                  <label style={labelStyle}>Company Goals / Extra Context (optional)</label>
                  <textarea style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} value={profile.goals} onChange={e => setProfile(p => ({ ...p, goals: e.target.value }))} placeholder="e.g. Expand into healthcare and government sectors. Focus on AI and data analytics offerings." />
                  <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 3 }}>Added to AI prompts as extra strategic context</div>
                </div>

                {/* Voice & Tone section */}
                <div style={{ borderTop: '1px solid var(--globant-border)', paddingTop: 14, marginTop: 2 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--globant-green)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                    ✍️ Voice & Tone
                    <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--globant-muted)' }}>— how the AI should sound when writing your messages</span>
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <label style={labelStyle}>Tone / Personality</label>
                    <input style={inputStyle} value={profile.voiceTone || ''} onChange={e => setProfile(p => ({ ...p, voiceTone: e.target.value }))}
                      placeholder="e.g. direct, warm, confident, no fluff, slight humor" />
                    <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 3 }}>Adjectives that describe how you communicate</div>
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <label style={labelStyle}>What to NEVER do</label>
                    <input style={inputStyle} value={profile.voiceAvoid || ''} onChange={e => setProfile(p => ({ ...p, voiceAvoid: e.target.value }))}
                      placeholder="e.g. never use 'I hope this finds you well', no emojis, no bullet points in messages" />
                    <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 3 }}>Hard rules — the AI will never break these</div>
                  </div>

                  <div>
                    <label style={labelStyle}>Example phrase (optional)</label>
                    <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} value={profile.voiceExample || ''} onChange={e => setProfile(p => ({ ...p, voiceExample: e.target.value }))}
                      placeholder="Paste a real message or sentence you wrote. The AI will calibrate its style to match yours." />
                    <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginTop: 3 }}>The closer to your real voice, the better the output</div>
                  </div>
                </div>

                </div>
                {/* Save button — fixed at bottom */}
                <div style={{ flexShrink: 0, paddingTop: 12, borderTop: '1px solid var(--globant-border)', marginTop: 4 }}>
                  <button
                    className="action-btn btn-primary"
                    style={{ padding: '10px 0', width: '100%', fontSize: 13 }}
                    onClick={handleSave}
                  >
                    {saved ? '✅ Saved!' : '💾 Save AI Profile'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    // ============ MAIN APP ============
    function App() {
      const [isAuthenticated, setIsAuthenticated] = useState(!!AUTH_TOKEN && !!CURRENT_USER);
      const [ready, setReady] = useState(false);
      const [page, setPage] = useState('overview');
      const [data, setData] = useState({ accounts: [], stakeholders: [], opportunities: [], actionPlan: [], outreach: [], solutions: [], events: [], clientPartners: [], sources: [] });
      const [loading, setLoading] = useState(true);
      const [api, setApi] = useState(null);
      const [showSettings, setShowSettings] = useState(false);
      const [configError, setConfigError] = useState('');
      const [navigateToAccountId, setNavigateToAccountId] = useState('');

      const goToAccount = useCallback((accountId) => {
        setNavigateToAccountId(accountId);
        setPage('accounts');
      }, []);

      // Optimistic update: add a record to local state instantly (before API response)
      const addToData = useCallback((tableKey, fields) => {
        const tempId = 'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        setData(prev => ({
          ...prev,
          [tableKey]: [...(prev[tableKey] || []), { id: tempId, fields }]
        }));
      }, []);

      // Optimistic update: edit a record in local state instantly
      const updateInData = useCallback((tableKey, recordId, updatedFields) => {
        setData(prev => ({
          ...prev,
          [tableKey]: (prev[tableKey] || []).map(r =>
            r.id === recordId ? { ...r, fields: { ...r.fields, ...updatedFields } } : r
          )
        }));
      }, []);

      const removeFromData = useCallback((tableKey, recordId) => {
        setData(prev => ({
          ...prev,
          [tableKey]: (prev[tableKey] || []).filter(r => r.id !== recordId)
        }));
      }, []);

      const [refreshing, setRefreshing] = useState(false);

      const loadData = useCallback(async (apiInstance, silent = false) => {
        if (!silent) setLoading(true);
        if (silent) setRefreshing(true);
        try {
          const keys = ['accounts','stakeholders','opportunities','actionPlan','outreach','solutions','events','clientPartners','sources'];
          const ids = [TABLE_IDS.accounts, TABLE_IDS.stakeholders, TABLE_IDS.opportunities, TABLE_IDS.actionPlan, TABLE_IDS.outreach, TABLE_IDS.solutions, TABLE_IDS.events, TABLE_IDS.clientPartners, TABLE_IDS.sources];
          // Load all tables in parallel — ~0.5s instead of ~4s
          const fetched = await Promise.all(keys.map((k, i) => apiInstance.fetchTable(ids[i]).catch(() => [])));
          const results = {};
          keys.forEach((k, i) => { results[k] = fetched[i]; });
          // Filter out placeholder opportunities named "None"
          results.opportunities = (results.opportunities || []).filter(o => {
            const name = F(o, 'Name') || F(o, 'Opportunity') || '';
            return name.toLowerCase() !== 'none';
          });

          // ── Role-based filtering ──
          const userRole = CURRENT_USER?.role || 'viewer';
          const userEmail = CURRENT_USER?.email || '';

          if (userRole === 'bdr') {
            // BDR: only accounts where Owner linked record matches user email
            // First, find the user's record ID in the Users table (loaded as part of data or from Owner links)
            const allAccounts = results.accounts || [];
            // We need to find which user record IDs match the logged-in user's email
            // Owner field links to Users table — we check if any linked Owner record's Name matches
            // Since we can't resolve the linked record here without the Users table, we use a simpler approach:
            // Load Users table to find the user's record ID
            let userRecordIds = [];
            try {
              if (TABLE_IDS.users) {
                const usersRecords = await apiInstance.fetchTable(TABLE_IDS.users);
                userRecordIds = usersRecords
                  .filter(u => (F(u, 'Email') || '').toLowerCase() === userEmail.toLowerCase())
                  .map(u => u.id);
              }
            } catch (e) { console.warn('Could not load users for filtering:', e); }

            if (userRecordIds.length > 0) {
              results.accounts = allAccounts.filter(a => {
                const ownerIds = linkedIds(a, 'Owner');
                return ownerIds.some(id => userRecordIds.includes(id));
              });
            }

            // Cascade filter: only show related data for visible accounts
            const visibleAccountIds = new Set(results.accounts.map(a => a.id));
            results.stakeholders = (results.stakeholders || []).filter(s =>
              linkedIds(s, 'Account').some(id => visibleAccountIds.has(id))
            );
            const visibleStakeholderIds = new Set(results.stakeholders.map(s => s.id));
            results.opportunities = (results.opportunities || []).filter(o =>
              linkedIds(o, 'Account').some(id => visibleAccountIds.has(id))
            );
            results.outreach = (results.outreach || []).filter(o =>
              linkedIds(o, 'Account').some(id => visibleAccountIds.has(id)) ||
              linkedIds(o, 'Stakeholder').some(id => visibleStakeholderIds.has(id))
            );
            results.actionPlan = (results.actionPlan || []).filter(ap =>
              linkedIds(ap, 'Cuenta').some(id => visibleAccountIds.has(id))
            );
          }

          if (userRole === 'cp') {
            // CP: only accounts where Client Partners linked record matches user email
            const cpRecords = results.clientPartners || [];
            const myCpIds = cpRecords
              .filter(cp => (F(cp, 'Email') || '').toLowerCase() === userEmail.toLowerCase())
              .map(cp => cp.id);

            if (myCpIds.length > 0) {
              results.accounts = (results.accounts || []).filter(a => {
                const cpIds = linkedIds(a, 'Client Partners');
                return cpIds.some(id => myCpIds.includes(id));
              });
            } else {
              results.accounts = [];
            }

            // Cascade filter
            const visibleAccountIds = new Set(results.accounts.map(a => a.id));
            results.stakeholders = (results.stakeholders || []).filter(s =>
              linkedIds(s, 'Account').some(id => visibleAccountIds.has(id))
            );
            const visibleStakeholderIds = new Set(results.stakeholders.map(s => s.id));
            results.opportunities = (results.opportunities || []).filter(o =>
              linkedIds(o, 'Account').some(id => visibleAccountIds.has(id))
            );
            results.outreach = (results.outreach || []).filter(o =>
              linkedIds(o, 'Account').some(id => visibleAccountIds.has(id)) ||
              linkedIds(o, 'Stakeholder').some(id => visibleStakeholderIds.has(id))
            );
            results.actionPlan = (results.actionPlan || []).filter(ap =>
              linkedIds(ap, 'Cuenta').some(id => visibleAccountIds.has(id))
            );
          }
          // admin: no filtering — sees everything

          setData(results);
        } catch (e) {
          console.error('Load failed:', e);
        }
        if (!silent) setLoading(false);
        if (silent) setRefreshing(false);
      }, []);

      // Auto-connect: if already authenticated, load config + data
      useEffect(() => {
        if (!isAuthenticated) { setLoading(false); return; }
        (async () => {
          try {
            await loadClientConfig();
            const a = new AirtableAPI();
            setApi(a);
            setReady(true);
            await loadData(a);
          } catch (e) {
            console.error('Init failed:', e);
            setConfigError('Failed to connect. Please try again.');
            setLoading(false);
          }
        })();
      }, [loadData, isAuthenticated]);

      // ── Login gate ──
      if (!isAuthenticated) {
        return <LoginScreen onLogin={() => setIsAuthenticated(true)} />;
      }

      if (configError) return (
        <div className="config-screen">
          <div className="config-box">
            <div className="logo-big" style={{ background: 'linear-gradient(135deg, #BFD730, #8fa824)' }}>O</div>
            <h2 style={{ marginBottom: 8 }}>Oike Sales Intelligence</h2>
            <p style={{ color: 'var(--globant-danger)', fontSize: 13 }}>{configError}</p>
            <button className="action-btn btn-primary" style={{ marginTop: 16, padding: '12px 24px' }} onClick={() => window.location.reload()}>Retry</button>
          </div>
        </div>
      );
      if (loading) return <div className="loading"><div className="spinner" /></div>;

      const bgSync = () => api && loadData(api, true);
      const pages = {
        overview: <StrategyOverview data={data} />,
        followup: <FollowupCenter data={data} api={api} onLogActivity={bgSync} onAddRecord={addToData} />,
        contacts: <ContactsSection data={data} api={api} onLogActivity={bgSync} onAddRecord={addToData} onUpdateRecord={updateInData} />,
        activity: <ActivityTracker data={data} api={api} onLogActivity={bgSync} onUpdateRecord={updateInData} onDeleteRecord={removeFromData} />,
        events: <EventsHub data={data} api={api} onLogActivity={bgSync} onAddRecord={addToData} onUpdateRecord={updateInData} />,
        insights: <InsightsView data={data} />,
        accounts: <CPBriefings data={data} api={api} onLogActivity={bgSync} onAddRecord={addToData} onUpdateRecord={updateInData} onDeleteRecord={removeFromData} navigateToAccountId={navigateToAccountId} clearNavigate={() => setNavigateToAccountId('')} />,
        solutionshub: <SolutionsHub data={data} api={api} onLogActivity={bgSync} onAddRecord={addToData} onDeleteRecord={removeFromData} goToAccount={goToAccount} />,
      };

      const navItems = [
        { icon: '📊', label: 'Strategy Overview', key: 'overview' },
        { icon: '🛠️', label: 'Solutions Hub', key: 'solutionshub' },
        { icon: '🏢', label: 'Accounts', key: 'accounts' },
        { icon: '👤', label: 'Contacts', key: 'contacts' },
        { icon: '✉️', label: 'Follow-up Center', key: 'followup' },
        { icon: '🎪', label: 'Events', key: 'events' },
        { icon: '📈', label: 'Activity Tracker', key: 'activity' },
        { icon: '🧠', label: 'Insights', key: 'insights' },
      ];

      return (
        <div>
          <div className="sidebar">
            <div className="sidebar-logo">
              <div className="logo-icon" style={{ background: 'linear-gradient(135deg, #BFD730, #8fa824)' }}>O</div>
              <div>
                <span>{CLIENT_CONFIG.name || 'Oike'}</span>
                <small>Sales Intel</small>
              </div>
            </div>
            <nav className="sidebar-nav">
              {navItems.map(item => (
                <div
                  key={item.key}
                  className={`nav-item ${page === item.key ? 'active' : ''}`}
                  onClick={() => setPage(item.key)}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span>{item.label}</span>
                </div>
              ))}
            </nav>
            <div style={{ padding: '12px 12px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button
                className="action-btn btn-ghost"
                style={{ width: '100%', fontSize: 12, padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                onClick={() => api && loadData(api)}
              >
                🔄 Refresh Data
              </button>
              <button
                className="action-btn btn-ghost"
                style={{ width: '100%', fontSize: 12, padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                onClick={() => setShowSettings(true)}
              >
                ⚙️ Settings
              </button>
            </div>
            <div className="sidebar-footer" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {CURRENT_USER && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--globant-text)' }}>{CURRENT_USER.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>{CURRENT_USER.email}</div>
                    <div style={{ fontSize: 9, marginTop: 2 }}><span style={{ background: CURRENT_USER.role === 'admin' ? 'rgba(191,215,48,0.2)' : 'rgba(96,165,250,0.2)', color: CURRENT_USER.role === 'admin' ? 'var(--globant-green)' : 'var(--globant-info)', padding: '2px 8px', borderRadius: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{CURRENT_USER.role || 'user'}</span></div>
                  </div>
                  <button onClick={logoutUser} style={{ background: 'none', border: '1px solid var(--globant-border)', borderRadius: 6, padding: '4px 10px', color: 'var(--globant-muted)', fontSize: 11, cursor: 'pointer' }} title="Sign out">↪ Exit</button>
                </div>
              )}
            </div>
          </div>
          <div className="main">
            {refreshing && (
              <div style={{ position: 'fixed', top: 8, right: 20, zIndex: 999, background: 'rgba(191,215,48,0.15)', border: '1px solid rgba(191,215,48,0.3)', borderRadius: 8, padding: '6px 14px', fontSize: 11, color: 'var(--globant-green)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>🔄</span> Syncing...
              </div>
            )}
            {pages[page] || pages.overview}
          </div>

          {/* Settings Modal */}
          {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
        </div>
      );
    }

    class ErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error }; }
      componentDidCatch(error, info) { console.error('Oike crash:', error, info); }
      render() {
        if (this.state.error) {
          return (
            <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#12121F', color: '#E8E8F0', fontFamily: 'Inter, sans-serif', padding: 40 }}>
              <div style={{ maxWidth: 480, textAlign: 'center' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
                <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12, color: '#BFD730' }}>Algo salió mal</h2>
                <p style={{ fontSize: 13, color: '#8888A8', marginBottom: 24 }}>La aplicación encontró un error inesperado. Intentá recargar la página.</p>
                <pre style={{ fontSize: 11, color: '#F87171', background: '#1E1E32', padding: '12px 16px', borderRadius: 8, textAlign: 'left', overflowX: 'auto', marginBottom: 20 }}>
                  {this.state.error.message}
                </pre>
                <button onClick={() => window.location.reload()} style={{ padding: '10px 24px', background: '#BFD730', color: '#1A1A2E', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 14 }}>
                  🔄 Recargar
                </button>
              </div>
            </div>
          );
        }
        return this.props.children;
      }
    }

    // Hide loading screen once React mounts
    const rootEl = document.getElementById('root');
    const loadingEl = document.getElementById('oike-loading');
    if (loadingEl) loadingEl.style.display = 'none';

    ReactDOM.createRoot(rootEl).render(
      <ErrorBoundary><App /></ErrorBoundary>
    );
