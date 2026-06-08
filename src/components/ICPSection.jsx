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


function ICPSection({ data, goToSolution, api, onLogActivity, onAddRecord }) {
  const { icp = [], solutions = [] } = data;
  const isAdmin = CURRENT_USER?.role === 'admin';
  const [selected, setSelected] = React.useState(null);
  const [showIcpModal, setShowIcpModal] = React.useState(false);
  const [editingIcp, setEditingIcp] = React.useState(null);
  const [icpForm, setIcpForm] = React.useState({ name: '', industry: '', country: '', b2b: 'B2B', size: '', deal: '', pains: '', triggers: '', priorities: '', exclusions: '', solutionIds: [] });
  const [savingIcp, setSavingIcp] = React.useState(false);

  const ICP_B2B_OPTIONS = ['B2B', 'B2C', 'B2B/B2C'];

  const openNewIcp = () => {
    setEditingIcp(null);
    setIcpForm({ name: '', industry: '', country: '', b2b: 'B2B', size: '', deal: '', pains: '', triggers: '', priorities: '', exclusions: '', solutionIds: [] });
    setShowIcpModal(true);
  };

  const openEditIcp = (profile) => {
    setEditingIcp(profile);
    setIcpForm({
      name: F(profile, 'Name') || '',
      industry: F(profile, 'Industry') || '',
      country: F(profile, 'Country') || '',
      b2b: F(profile, 'B2B / B2C') || 'B2B',
      size: F(profile, 'Company Size') || '',
      deal: F(profile, 'Average deal size') || '',
      pains: F(profile, 'Pains') || '',
      triggers: (() => { const t = F(profile, 'Triggers (why now)'); return Array.isArray(t) ? t.join(', ') : (t || ''); })(),
      priorities: F(profile, 'Priorities') || '',
      exclusions: F(profile, 'Exclusions (Who is not a fit)') || '',
      solutionIds: linkedIds(profile, 'Solutions'),
    });
    setShowIcpModal(true);
  };

  const saveIcp = async () => {
    if (!icpForm.name.trim()) return;
    setSavingIcp(true);
    try {
      const a = api || new AirtableAPI();
      const fields = {
        'Name': icpForm.name.trim(),
        'Industry': icpForm.industry.trim(),
        'Country': icpForm.country.trim(),
        'B2B / B2C': icpForm.b2b,
        'Company Size': icpForm.size.trim(),
        'Average deal size': icpForm.deal.trim(),
        'Pains': icpForm.pains.trim(),
        'Priorities': icpForm.priorities.trim(),
        'Exclusions (Who is not a fit)': icpForm.exclusions.trim(),
      };
      if (icpForm.triggers.trim()) {
        fields['Triggers (why now)'] = icpForm.triggers.split(',').map(t => t.trim()).filter(Boolean);
      }
      if (icpForm.solutionIds && icpForm.solutionIds.length > 0) {
        fields['Solutions'] = icpForm.solutionIds.map(id => ({ id }));
      }
      if (editingIcp) {
        await a.updateRecord(TABLE_IDS.icp, editingIcp.id, fields);
      } else {
        const rec = await a.createRecord(TABLE_IDS.icp, fields);
        if (onAddRecord) onAddRecord('icp', { ...fields, id: rec.id });
      }
      setShowIcpModal(false);
      if (onLogActivity) onLogActivity();
    } catch (e) { console.error(e); window.__oikeToast('Failed to save ICP: ' + e.message, 'error'); }
    setSavingIcp(false);
  };

  const tagStyle = (bg, color) => ({ display:'inline-block', padding:'2px 10px', borderRadius:12, fontSize:11, fontWeight:600, background:bg, color:color, marginRight:4, marginBottom:4 });
  const fieldBlock = (label, value) => value ? (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:10, fontWeight:700, color:'var(--globant-muted)', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:13, color:'var(--globant-text)', lineHeight:1.6, whiteSpace:'pre-wrap' }}>{value}</div>
    </div>
  ) : null;

  return (
    <div>
      <div className="page-header" style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
        <div>
          <h1>🎯 ICP — Ideal Customer Profiles</h1>
          <p style={{ color:'var(--globant-muted)', marginTop:4 }}>{icp.length} profiles defined</p>
        </div>
        {isAdmin && <button className="action-btn btn-primary" style={{ fontSize:12, padding:'8px 16px', marginTop:4 }} onClick={openNewIcp}>➕ New ICP</button>}
      </div>

      {/* ICP Create/Edit Modal */}
      {showIcpModal && isAdmin && (() => {
        const iStyle = { width:'100%', padding:'8px 10px', background:'var(--globant-input)', border:'1px solid var(--globant-border)', borderRadius:6, color:'var(--globant-text)', fontSize:13, boxSizing:'border-box' };
        const lStyle = { fontSize:11, color:'var(--globant-muted)', fontWeight:600, marginBottom:4, textTransform:'uppercase', display:'block' };
        return (
          <div className="modal-overlay" onClick={() => setShowIcpModal(false)}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth:560, maxHeight:'88vh', overflowY:'auto' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
                <h3 style={{ margin:0 }}>{editingIcp ? '✏️ Edit ICP' : '🎯 New ICP'}</h3>
                <button onClick={() => setShowIcpModal(false)} style={{ background:'none', border:'none', color:'var(--globant-muted)', cursor:'pointer', fontSize:18 }}>✕</button>
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:13 }}>
                <div><label style={lStyle}>Name *<InfoTip text="Give this ICP a descriptive name like 'The Sales Manager' or 'Scaling Founder'. Should describe who this customer is." /></label><input style={iStyle} value={icpForm.name} onChange={e => setIcpForm(p => ({ ...p, name: e.target.value }))} autoFocus placeholder="e.g. The Sales Manager" /></div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                  <div><label style={lStyle}>Industry<InfoTip text="The industry or sector this ICP belongs to. Can list multiple separated by /." /></label><input style={iStyle} value={icpForm.industry} onChange={e => setIcpForm(p => ({ ...p, industry: e.target.value }))} placeholder="e.g. SaaS / Consulting" /></div>
                  <div><label style={lStyle}>Country / Region<InfoTip text="Where these customers are located. Can be a country, region, or multiple markets." /></label><input style={iStyle} value={icpForm.country} onChange={e => setIcpForm(p => ({ ...p, country: e.target.value }))} placeholder="e.g. USA / LATAM" /></div>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
                  <div><label style={lStyle}>B2B / B2C<InfoTip text="Does this customer sell to businesses (B2B), consumers (B2C), or both?" /></label><select style={iStyle} value={icpForm.b2b} onChange={e => setIcpForm(p => ({ ...p, b2b: e.target.value }))}>{ICP_B2B_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}</select></div>
                  <div><label style={lStyle}>Company Size<InfoTip text="Number of employees or team members. Use ranges like '5–50' or '50+' for flexibility." /></label><input style={iStyle} value={icpForm.size} onChange={e => setIcpForm(p => ({ ...p, size: e.target.value }))} placeholder="e.g. 5–50" /></div>
                  <div><label style={lStyle}>Avg Deal Size<InfoTip text="Typical contract value for this customer. Helps calibrate the sales effort required." /></label><input style={iStyle} value={icpForm.deal} onChange={e => setIcpForm(p => ({ ...p, deal: e.target.value }))} placeholder="e.g. $10K–$50K" /></div>
                </div>
                <div><label style={lStyle}>Pains<InfoTip text="The core problems this ICP struggles with that your solution directly solves. Be specific." /></label><textarea style={{ ...iStyle, minHeight:70, resize:'vertical' }} value={icpForm.pains} onChange={e => setIcpForm(p => ({ ...p, pains: e.target.value }))} placeholder="What problems does this ICP face?" /></div>
                <div><label style={lStyle}>Triggers (comma-separated)<InfoTip text="Events or situations that create urgency for this customer to act now. E.g. missed targets, team growth, new leadership." /></label><input style={iStyle} value={icpForm.triggers} onChange={e => setIcpForm(p => ({ ...p, triggers: e.target.value }))} placeholder="e.g. Missed target, New hire, Scaling team" /></div>
                <div><label style={lStyle}>Priorities<InfoTip text="What this customer cares about most. Used to align your messaging and positioning." /></label><input style={iStyle} value={icpForm.priorities} onChange={e => setIcpForm(p => ({ ...p, priorities: e.target.value }))} placeholder="e.g. Consistency, Predictability" /></div>
                <div><label style={lStyle}>Exclusions (who is NOT a fit)<InfoTip text="Characteristics that disqualify a prospect from this ICP. Helps your team qualify faster and avoid wasted effort." /></label><input style={iStyle} value={icpForm.exclusions} onChange={e => setIcpForm(p => ({ ...p, exclusions: e.target.value }))} placeholder="e.g. No team, pre-revenue" /></div>
                <div>
                  <label style={lStyle}>Associated Offering<InfoTip text="Which of your solutions can be sold to this ICP? Select all that apply." /></label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                    {solutions.map(s => {
                      const sid = s.id;
                      const selected = (icpForm.solutionIds || []).includes(sid);
                      return (
                        <span key={sid}
                          onClick={() => setIcpForm(p => ({
                            ...p,
                            solutionIds: selected
                              ? p.solutionIds.filter(id => id !== sid)
                              : [...(p.solutionIds || []), sid]
                          }))}
                          style={{ cursor: 'pointer', padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                            background: selected ? 'rgba(91,191,181,0.2)' : 'rgba(255,255,255,0.05)',
                            color: selected ? 'var(--globant-green)' : 'var(--globant-muted)',
                            border: `1px solid ${selected ? 'rgba(91,191,181,0.4)' : 'rgba(255,255,255,0.1)'}`,
                            transition: 'all 0.15s'
                          }}>
                          {selected ? '✓ ' : ''}{F(s, 'Name')}
                        </span>
                      );
                    })}
                    {solutions.length === 0 && <span style={{ fontSize: 12, color: 'var(--globant-muted)' }}>No solutions found</span>}
                  </div>
                </div>
                <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:4 }}>
                  <button className="action-btn btn-ghost" onClick={() => setShowIcpModal(false)}>Cancel</button>
                  <button className="action-btn btn-primary" onClick={saveIcp} disabled={savingIcp || !icpForm.name.trim()}>
                    {savingIcp ? '⏳ Saving...' : editingIcp ? '✅ Save Changes' : '✅ Create ICP'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {icp.length === 0 && (
        <div className="card" style={{ textAlign:'center', padding:40 }}>
          <div style={{ fontSize:32, marginBottom:12 }}>🎯</div>
          <div style={{ color:'var(--globant-muted)', fontSize:14 }}>No ICP records found. Add profiles in Airtable to get started.</div>
        </div>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(320px, 1fr))', gap:16 }}>
        {icp.map(profile => {
          const name = F(profile, 'Name') || 'Unnamed';
          const industry = F(profile, 'Industry') || '';
          const size = F(profile, 'Company Size') || '';
          const country = F(profile, 'Country') || '';
          const b2b = F(profile, 'B2B / B2C') || '';
          const deal = F(profile, 'Average deal size') || '';
          const pains = F(profile, 'Pains') || '';
          const triggers = F(profile, 'Triggers (why now)') || '';
          const priorities = F(profile, 'Priorities') || '';
          const exclusions = F(profile, 'Exclusions (Who is not a fit)') || '';
          const solNames = F(profile, 'Name (from Solutions)') || '';
          const solNamesArr = Array.isArray(solNames) ? solNames : (solNames ? [String(solNames)] : []);
          const linkedSolIds = linkedIds(profile, 'Solutions');
          const linkedSols = linkedSolIds.map(id => solutions.find(s => s.id === id)).filter(Boolean);
          const isSelected = selected === profile.id;

          return (
            <div key={profile.id} className="card"
              style={{ cursor:'pointer', border: isSelected ? '1.5px solid var(--globant-green)' : '1px solid var(--globant-border)', transition:'border-color 0.15s' }}
              onClick={() => setSelected(isSelected ? null : profile.id)}>

              {/* Header */}
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:12 }}>
                <div>
                  <div style={{ fontSize:16, fontWeight:800, color:'var(--globant-text)', marginBottom:4 }}>{name}</div>
                  <div style={{ fontSize:12, color:'var(--globant-muted)' }}>{industry}</div>
                </div>
                <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                  {b2b && <span style={tagStyle('rgba(91,191,181,0.15)', 'var(--globant-green)')}>{b2b}</span>}
                  {isAdmin && <button onClick={e => { e.stopPropagation(); openEditIcp(profile); }} style={{ background:'rgba(255,255,255,0.05)', border:'1px solid var(--globant-border)', borderRadius:6, padding:'3px 8px', fontSize:11, color:'var(--globant-muted)', cursor:'pointer' }}>✏️</button>}
                </div>
              </div>

              {/* Quick tags */}
              <div style={{ marginBottom:12 }}>
                {size && <span style={tagStyle('rgba(96,165,250,0.12)', '#60a5fa')}>{size}</span>}
                {country && <span style={tagStyle('rgba(251,191,36,0.12)', '#fbbf24')}>{country}</span>}
                {deal && <span style={tagStyle('rgba(74,222,128,0.12)', '#4ade80')}>💰 {deal}</span>}
              </div>

              {/* Pains preview */}
              {pains && (
                <div style={{ fontSize:12, color:'var(--globant-muted)', lineHeight:1.5, marginBottom:8 }}>
                  <span style={{ color:'#f87171', fontWeight:700 }}>Pain: </span>
                  {pains.length > 100 ? pains.slice(0,100)+'...' : pains}
                </div>
              )}

              {/* Solutions linked */}
              {(linkedSols.length > 0 || solNamesArr.length > 0) && (
                <div style={{ fontSize:11, color:'var(--globant-muted)', marginBottom:8 }}>
                  <span style={{ fontWeight:600 }}>Offering: </span>
                  {linkedSols.length > 0
                    ? linkedSols.map((sol, i) => (
                        <span key={sol.id}>
                          {goToSolution
                            ? <span style={{ color:'var(--globant-green)', cursor:'pointer', fontWeight:600 }}
                                onClick={e => { e.stopPropagation(); goToSolution(sol.id); }}>
                                {F(sol, 'Name')}
                              </span>
                            : <span>{F(sol, 'Name')}</span>
                          }
                          {i < linkedSols.length - 1 ? ', ' : ''}
                        </span>
                      ))
                    : solNamesArr.join(', ')
                  }
                </div>
              )}

              {/* Expand */}
              <div style={{ fontSize:11, color:'var(--globant-green)', fontWeight:600, marginTop:4 }}>
                {isSelected ? '▲ Show less' : '▼ Show full profile'}
              </div>

              {/* Expanded detail */}
              {isSelected && (
                <div style={{ marginTop:16, paddingTop:16, borderTop:'1px solid var(--globant-border)' }}>
                  {fieldBlock('Triggers — Why now', triggers)}
                  {fieldBlock('Priorities', priorities)}
                  {fieldBlock('Full Pain Points', pains)}
                  {exclusions && (
                    <div style={{ marginBottom:14 }}>
                      <div style={{ fontSize:10, fontWeight:700, color:'#f87171', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:4 }}>⛔ Exclusions — Who is NOT a fit</div>
                      <div style={{ fontSize:13, color:'#f87171', lineHeight:1.6 }}>{exclusions}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ SOLUTIONS HUB ============

export default ICPSection;
