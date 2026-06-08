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
      window.__oikeToast('Failed to save activity changes', 'error');
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

  // Active accounts
  const activeAccountsCount = accounts.filter(a => ['Active', 'Activo'].includes(F(a, 'Inside Sales Status'))).length;

  // Meetings, Replies & Bounced
  const meetings = outreach.filter(a => F(a, 'Status') === 'Meeting Scheduled' || F(a, 'Status') === 'Meeting Booked').length;
  const replies = outreach.filter(a => F(a, 'Status') === 'Replied').length;
  const bouncedActivities = outreach.filter(a => F(a, 'Status') === 'Bounced').length;
  const drafts = outreach.filter(a => F(a, 'Status') === 'Draft').length;

  // Filter
  const filtered = useMemo(() => outreach.filter(a => {
    if (accountSearch) {
      const term = accountSearch.toLowerCase();
      const accNames = resolveLinked(a, 'Account', accounts, 'Account Name');
      if (!accNames.some(n => n.toLowerCase().includes(term))) return false;
    }
    if (selectedChannel) {
      const ch = F(a, 'Channel');
      const st = F(a, 'Status');
      if (selectedChannel === 'Meeting') {
        // Match any activity logged as meeting (new channel or old status-based)
        if (ch !== 'Meeting' && st !== 'Meeting Scheduled' && st !== 'Meeting Booked') return false;
      } else {
        if (ch !== selectedChannel) return false;
      }
    }
    if (selectedStatus && F(a, 'Status') !== selectedStatus) return false;
    return true;
  }).sort((a, b) => new Date(b.fields?.['Date'] || 0) - new Date(a.fields?.['Date'] || 0)), [outreach, accountSearch, accounts, selectedChannel, selectedStatus]);

  const channelColors = { WhatsApp: '#25D366', Email: '#60a5fa', LinkedIn: '#0A66C2', Call: '#fbbf24', Meeting: '#a78bfa' };

  return (
    <div>
      <div className="page-header">
        <h1>Activity Tracker</h1>
        <p>Full outreach performance and engagement log</p>
      </div>

      {/* KPI Dashboard */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 12, marginBottom: 24 }}>
        <div className="card" style={{ textAlign: 'center', padding: '16px 12px', background: 'linear-gradient(135deg, rgba(91,191,181,0.12) 0%, rgba(91,191,181,0.03) 100%)' }}>
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
        <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
          <div style={{ fontSize: 30, fontWeight: 800, color: '#60a5fa', lineHeight: 1 }}>{activeAccountsCount}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>Active Accounts</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '16px 12px', cursor: 'pointer', border: selectedStatus === 'Meeting Scheduled' ? '1px solid #60a5fa' : undefined }} onClick={() => setSelectedStatus(selectedStatus === 'Meeting Scheduled' ? '' : 'Meeting Scheduled')}>
          <div style={{ fontSize: 30, fontWeight: 800, color: '#60a5fa', lineHeight: 1 }}>{meetings}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>📅 Meetings</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '16px 12px', cursor: 'pointer', border: selectedStatus === 'Replied' ? '1px solid #4ade80' : undefined }} onClick={() => setSelectedStatus(selectedStatus === 'Replied' ? '' : 'Replied')}>
          <div style={{ fontSize: 30, fontWeight: 800, color: '#4ade80', lineHeight: 1 }}>{replies}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>💬 Replies</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '16px 12px', cursor: 'pointer', borderBottom: bouncedActivities > 0 ? '3px solid #ea580c' : undefined, border: selectedStatus === 'Bounced' ? '1px solid #ea580c' : undefined }} onClick={() => setSelectedStatus(selectedStatus === 'Bounced' ? '' : 'Bounced')}>
          <div style={{ fontSize: 30, fontWeight: 800, color: bouncedActivities > 0 ? '#ea580c' : 'var(--globant-muted)', lineHeight: 1 }}>{bouncedActivities}</div>
          <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 6 }}>💭 Bounced</div>
        </div>
      </div>

      {/* Channel breakdown + recency */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14, color: 'var(--globant-text)' }}>By Channel</div>
          {['Email', 'WhatsApp', 'LinkedIn', 'Call', 'Meeting'].map(ch => {
            const count = ch === 'Meeting'
              ? outreach.filter(a => F(a,'Channel') === 'Meeting' || F(a,'Status') === 'Meeting Scheduled' || F(a,'Status') === 'Meeting Booked').length
              : byChannel[ch] || 0;
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
          {['Email', 'WhatsApp', 'LinkedIn', 'Call', 'Meeting'].map(ch => (
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
          const status = F(a, 'Status');
          const isMeeting = status === 'Meeting Scheduled' || status === 'Meeting Booked' || channel === 'Meeting';
          const icon = isMeeting ? '📅' : (channelIcon[channel] || '📋');
          const stakeholderNames = resolveLinked(a, 'Stakeholder', stakeholders, 'Name');
          const accountNames = resolveLinked(a, 'Account', accounts, 'Account Name');

          return (
            <div key={a.id} className="log-entry">
              <div className="log-icon" style={{ background: `${channelColors[channel] || 'rgba(91,191,181,0.15)'}22` }}>{icon}</div>
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
                  <div style={{ fontSize: 12, color: 'var(--globant-text)', marginTop: 8, padding: '8px 12px', background: 'rgba(91,191,181,0.08)', borderRadius: 6, borderLeft: '3px solid var(--globant-accent)', whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>
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

export default ActivityTracker;
