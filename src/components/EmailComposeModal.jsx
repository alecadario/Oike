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


function EmailComposeModal({ stakeholder, initialSubject = '', initialBody = '', replyContext = null, accounts, outreach, gmailConnected, onClose, onSuccess }) {
  const [subject, setSubject] = React.useState(initialSubject);
  const [body, setBody] = React.useState(initialBody);
  const [sending, setSending] = React.useState(false);
  const [savingDraft, setSavingDraft] = React.useState(false);
  const [status, setStatus] = React.useState(''); // success/error message

  const email = F(stakeholder, 'Email') || '';
  const sName = `${F(stakeholder, 'Name') || ''} ${F(stakeholder, 'Last name') || ''}`.trim();
  const accountIds = linkedIds(stakeholder, 'Account') || [];

  // Find reply context from outreach history if not provided
  const resolvedReplyCtx = React.useMemo(() => {
    if (replyContext) return replyContext;
    const sOut = outreach
      .filter(o => linkedIds(o, 'Stakeholder').includes(stakeholder.id))
      .sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0));
    const lastReceived = sOut.find(o => ['Received', 'Replied'].includes(F(o, 'Status') || ''));
    if (!lastReceived) return null;
    const n = F(lastReceived, 'Notes') || '';
    return {
      threadId:  (n.match(/\[gthread:([^\]]+)\]/) || [])[1] || null,
      inReplyTo: (n.match(/\[gmsgid:([^\]]+)\]/) || [])[1] || null,
      readMsgId: (n.match(/\[gmsg:([^\]]+)\]/) || [])[1]   || null,
    };
  }, [replyContext, outreach, stakeholder]);

  const doSend = async (draft = false) => {
    if (!subject.trim() || !body.trim()) { setStatus('⚠️ Subject and body are required.'); return; }
    if (!email) { setStatus('⚠️ This contact has no email address.'); return; }

    draft ? setSavingDraft(true) : setSending(true);
    setStatus('');

    if (gmailConnected) {
      try {
        const res = await fetch('/api/gmail/send', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            to: email,
            subject: subject.trim(),
            message: body.trim(),
            threadId:      resolvedReplyCtx?.threadId  || undefined,
            inReplyTo:     resolvedReplyCtx?.inReplyTo || undefined,
            readMessageId: resolvedReplyCtx?.readMsgId || undefined,
            stakeholderId: stakeholder.id,
            accountIds,
            baseId: AIRTABLE_BASE_ID,
            outreachTableId: TABLE_IDS.outreach,
            draft,
          }),
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Send failed');
        setStatus(draft ? '✅ Draft saved to Gmail!' : '✅ Email sent!');
        setTimeout(() => { if (onSuccess) onSuccess(); }, 800);
      } catch (e) {
        // If Gmail auth fails, fall back to Gmail compose URL
        if (e.message?.includes('connect') || e.message?.includes('auth') || e.message?.includes('scope')) {
          window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
          setStatus('⚠️ Reconnect Gmail in Settings. Opening Gmail compose instead.');
        } else {
          setStatus(`❌ ${e.message}`);
        }
      }
    } else {
      // No Gmail → open Gmail compose URL
      window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
      onClose();
    }

    setSending(false);
    setSavingDraft(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1100 }}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 560, borderRadius: 14, padding: 0, overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ padding: '14px 20px', background: 'var(--globant-surface)', borderBottom: '1px solid var(--globant-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>✉️ Compose Email</div>
            <div style={{ fontSize: 12, color: 'var(--globant-muted)', marginTop: 2 }}>To: <strong>{sName}</strong> &lt;{email}&gt;</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--globant-muted)', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Gmail status indicator */}
          {!gmailConnected && (
            <div style={{ fontSize: 11, color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: 8, padding: '6px 12px' }}>
              ⚠️ Gmail not connected — will open Gmail compose in a new tab. <a href="#settings" style={{ color: '#60a5fa' }} onClick={onClose}>Connect in Settings</a>
            </div>
          )}
          {replyContext?.inReplyTo && (
            <div style={{ fontSize: 11, color: '#4ade80', background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.15)', borderRadius: 8, padding: '6px 12px' }}>
              ↩ Replying in the same thread
            </div>
          )}

          {/* Subject */}
          <div>
            <label style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'block', marginBottom: 4 }}>Subject</label>
            <input
              className="input-field"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Email subject…"
              style={{ width: '100%', boxSizing: 'border-box' }}
              autoFocus={!subject}
            />
          </div>

          {/* Body */}
          <div>
            <label style={{ fontSize: 11, color: 'var(--globant-muted)', display: 'block', marginBottom: 4 }}>Message</label>
            <textarea
              className="input-field"
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="Write your message here…"
              rows={10}
              style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.55 }}
              autoFocus={!!subject && !body}
            />
          </div>

          {status && (
            <div style={{ fontSize: 12, color: status.startsWith('✅') ? '#4ade80' : status.startsWith('⚠️') ? '#fbbf24' : '#f87171', padding: '6px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.04)' }}>
              {status}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--globant-border)', display: 'flex', gap: 8, justifyContent: 'flex-end', background: 'var(--globant-surface)' }}>
          <button className="action-btn" onClick={onClose} style={{ fontSize: 12, padding: '7px 14px' }}>Cancel</button>
          {gmailConnected && (
            <button className="action-btn" disabled={savingDraft} onClick={() => doSend(true)} style={{ fontSize: 12, padding: '7px 14px', opacity: savingDraft ? 0.6 : 1 }}>
              {savingDraft ? '⏳ Saving…' : '📝 Save Draft'}
            </button>
          )}
          <button className="action-btn btn-primary" disabled={sending} onClick={() => doSend(false)} style={{ fontSize: 12, padding: '7px 18px', opacity: sending ? 0.6 : 1 }}>
            {sending ? '⏳ Sending…' : gmailConnected ? '📤 Send' : '📤 Open in Gmail'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============ GLOBAL SEARCH MODAL ============

export default EmailComposeModal;
