import React from 'react';
import { F, linkedIds } from '../utils.jsx';
import { TABLE_IDS, CURRENT_USER } from '../globals.js';

export default function AccountIntelTab({
  radarData, loadingRadar, generateAccountRadar, generateMeddpicc,
  accStakeholders, stakeholderEngagement, opps, meddpiccValues, MEDDPICC_FIELDS, loadingMeddpicc,
  newsItems,
  intelNotes, editingNotes, notesValue, setNotesValue, setEditingNotes, saveIntelNotes, savingNotes,
  setCpSelectedStakeholder, setAccDetailTab,
  isAdmin, users, account, api, onLogActivity, onUpdateRecord,
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Recommended Actions */}
      <div className="card" style={{ borderLeft: '3px solid #34d399' }}>
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>⚡ Recommended Actions</h3>
          <button className="action-btn btn-primary" style={{ fontSize: 11, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)' }}
            onClick={() => { generateAccountRadar(); generateMeddpicc(); }} disabled={loadingRadar}>
            {loadingRadar ? '⏳' : radarData ? '🔄 Refresh Intel' : '✨ Generate Intel'}
          </button>
        </div>
        {!radarData && !loadingRadar && (
          <p style={{ fontSize: 12, color: 'var(--globant-muted)' }}>Generate the Account Brief to get this week's recommended actions.</p>
        )}
        {loadingRadar && <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--globant-muted)', fontSize: 13 }}>⏳ Building playbook…</div>}
        {radarData?.recommended_actions?.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
            {radarData.recommended_actions.slice(0, 3).map((act, i) => {
              const tempCfg = act.temperature === 'HOT' ? { icon: '🔥', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.2)', color: '#f87171' }
                            : act.temperature === 'WARM' ? { icon: '🌡️', bg: 'rgba(251,146,60,0.08)', border: 'rgba(251,146,60,0.2)', color: '#fb923c' }
                            : { icon: '❄️', bg: 'rgba(148,163,184,0.06)', border: 'rgba(148,163,184,0.15)', color: '#94a3b8' };
              return (
                <div key={i} style={{ padding: '12px 14px', borderRadius: 10, background: tempCfg.bg, border: `1px solid ${tempCfg.border}`, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ fontSize: 20, flexShrink: 0, marginTop: 1 }}>{tempCfg.icon}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: 'var(--globant-text)', lineHeight: 1.5 }}>{act.action}</div>
                    {act.channel && <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 4 }}>via {act.channel}</div>}
                  </div>
                  {(() => {
                    const stkNameRaw = act.stakeholder_name || act.stakeholder || '';
                    const stk = stkNameRaw
                      ? accStakeholders.find(s => (F(s,'Name')||'').toLowerCase().includes(stkNameRaw.split(' ')[0].toLowerCase()))
                      : null;
                    const ch = (act.channel || '').toLowerCase();
                    const email = stk ? F(stk, 'Email') : null;
                    const linkedin = stk ? F(stk, 'LinkedIn') : null;
                    const phone = stk ? F(stk, 'Phone number') : null;
                    let btnLabel, btnAction, btnStyle;
                    if (ch.includes('email') && email) {
                      btnLabel = '✉️ Send Email';
                      btnAction = () => { if (stk) setCpSelectedStakeholder(stk); };
                      btnStyle = { background: 'rgba(91,191,181,0.15)', color: '#5bbfb5', border: '1px solid rgba(91,191,181,0.3)' };
                    } else if (ch.includes('linkedin') && linkedin) {
                      btnLabel = 'in Connect';
                      btnAction = () => window.open(linkedin, '_blank');
                      btnStyle = { background: 'rgba(10,102,194,0.15)', color: '#60a5fa', border: '1px solid rgba(10,102,194,0.3)' };
                    } else if ((ch.includes('whatsapp') || ch.includes('phone') || ch.includes('call')) && phone) {
                      btnLabel = ch.includes('whatsapp') ? '💬 WhatsApp' : '📞 Call';
                      btnAction = () => window.open(ch.includes('call') ? `tel:${phone}` : 'https://wa.me/' + String(phone).replace(/[^0-9+]/g, ''), '_blank');
                      btnStyle = { background: 'rgba(37,211,102,0.12)', color: '#34d399', border: '1px solid rgba(37,211,102,0.3)' };
                    } else if (stk || stkNameRaw) {
                      btnLabel = `→ ${stkNameRaw || 'Stakeholders'}`;
                      btnAction = () => setAccDetailTab('contacts');
                      btnStyle = {};
                    } else { return null; }
                    return (
                      <button className="action-btn btn-ghost" style={{ fontSize: 11, flexShrink: 0, ...btnStyle }} onClick={btnAction}>
                        {btnLabel}
                      </button>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Red Flags */}
      <div className="card" style={{ borderLeft: '3px solid #ef4444' }}>
        <div className="card-header"><h3>🚨 Red Flags</h3></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(() => {
            const flags = [];
            if (accStakeholders.length === 0) flags.push('No contacts mapped — who is the champion?');
            if (accStakeholders.length > 0 && !stakeholderEngagement.some(e => e.hasReplied)) flags.push('No reply from any contact yet — engagement is low');
            const staleCount = stakeholderEngagement.filter(e => e.daysSince !== null && e.daysSince > 21).length;
            if (staleCount > 0) flags.push(`${staleCount} contact(s) haven't been touched in 3+ weeks`);
            if (opps.length === 0) flags.push('No open opportunities — is there a confirmed need?');
            if (accStakeholders.length > 0 && !accStakeholders.some(s => (F(s,'Level of Influence')||'').toLowerCase() === 'champion')) flags.push('No champion identified among contacts');
            if (Object.keys(meddpiccValues).length === 0) flags.push('Deal health not qualified — MEDDPICC is empty');
            if (flags.length === 0) flags.push('No major red flags detected. Account looks healthy!');
            return flags.map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 0', borderBottom: i < flags.length-1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                <span style={{ fontSize: 14, flexShrink: 0 }}>{f.startsWith('No major') ? '✅' : '⚠️'}</span>
                <span style={{ fontSize: 12, color: f.startsWith('No major') ? '#34d399' : 'var(--globant-text)', lineHeight: 1.5 }}>{f}</span>
              </div>
            ));
          })()}
        </div>
      </div>

      {/* MEDDPICC */}
      <div className="card" style={{ borderLeft: '3px solid #f472b6' }}>
        <div className="card-header">
          <h3>🎯 MEDDPICC</h3>
          {Object.keys(meddpiccValues).length === 0 && !loadingMeddpicc && (
            <span style={{ fontSize: 11, color: 'var(--globant-muted)', fontStyle: 'italic' }}>Generated with Intel</span>
          )}
          {loadingMeddpicc && <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>⏳ Qualifying…</span>}
        </div>
        {Object.keys(meddpiccValues).length === 0 && !loadingMeddpicc && (
          <p style={{ fontSize: 12, color: 'var(--globant-muted)', margin: 0 }}>Hit "Generate Intel" above to auto-qualify this deal across all MEDDPICC criteria.</p>
        )}
        {Object.keys(meddpiccValues).length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 4 }}>
            {MEDDPICC_FIELDS.map(f => {
              const val = meddpiccValues[f.key] || '';
              const hasContent = val && val.length > 5 && val.toLowerCase() !== 'unknown' && !val.toLowerCase().startsWith('unknown —');
              const icon = hasContent ? '✅' : '⚠️';
              return (
                <div key={f.key} style={{ padding: '10px 12px', background: 'var(--globant-darker)', borderRadius: 9, border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 13 }}>{icon}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#f472b6', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{f.label}</span>
                  </div>
                  <div style={{ fontSize: 11, color: hasContent ? 'var(--globant-text)' : 'var(--globant-muted)', lineHeight: 1.5, fontStyle: hasContent ? 'normal' : 'italic' }}>
                    {val || 'Unknown — needs discovery'}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* TL;DR */}
      <div style={{ background: 'linear-gradient(135deg, rgba(167,139,250,0.14) 0%, rgba(91,191,181,0.08) 100%)', border: '1px solid rgba(167,139,250,0.22)', borderRadius: 12, padding: '16px 20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#a78bfa', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: 6 }}>TL;DR</div>
            {radarData ? (
              <>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--globant-text)', lineHeight: 1.6 }}>{radarData.tldr}</p>
                <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {radarData.est_budget && <span style={{ fontSize: 11, background: 'rgba(74,222,128,0.12)', color: '#4ade80', padding: '3px 10px', borderRadius: 8, fontWeight: 600 }}>💰 {radarData.est_budget}</span>}
                  {radarData.portfolio_label && <span style={{ fontSize: 11, background: 'rgba(96,165,250,0.12)', color: '#60a5fa', padding: '3px 10px', borderRadius: 8, fontWeight: 600 }}>🏷️ {radarData.portfolio_label}</span>}
                </div>
              </>
            ) : (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--globant-muted)' }}>{loadingRadar ? '⏳ Generating brief…' : 'Generate the Account Brief to see a summary of this account.'}</p>
            )}
          </div>
          <button className="action-btn btn-primary" style={{ fontSize: 11, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)', flexShrink: 0 }}
            onClick={async () => { generateAccountRadar(); generateMeddpicc(); }} disabled={loadingRadar}>
            {loadingRadar ? '⏳' : radarData ? '🔄 Refresh Intel' : '✨ Generate Intel'}
          </button>
        </div>
      </div>

      {/* Tu Intel */}
      <div style={{ border: '1px solid rgba(91,191,181,0.18)', borderRadius: 12, padding: '14px 18px', background: 'rgba(91,191,181,0.04)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: editingNotes || intelNotes ? 10 : 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--globant-green)', letterSpacing: '1px', textTransform: 'uppercase' }}>🗒️ Tu Intel</span>
            {intelNotes && !editingNotes && <span style={{ fontSize: 10, color: 'var(--globant-muted)' }}>· se suma al brief cuando generás</span>}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {!editingNotes ? (
              <button className="action-btn btn-ghost" style={{ fontSize: 11 }} onClick={() => { setNotesValue(intelNotes); setEditingNotes(true); }}>
                {intelNotes ? '✏️ Editar' : '➕ Agregar'}
              </button>
            ) : (
              <>
                <button className="action-btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setEditingNotes(false)}>Cancelar</button>
                <button className="action-btn btn-primary" style={{ fontSize: 11 }} onClick={saveIntelNotes} disabled={savingNotes}>
                  {savingNotes ? '⏳' : '💾 Guardar'}
                </button>
              </>
            )}
          </div>
        </div>
        {editingNotes ? (
          <textarea className="input-field" value={notesValue} onChange={e => setNotesValue(e.target.value)}
            placeholder="Lo que sabés de esta cuenta — reuniones, contactos clave, decisiones, contexto interno..."
            style={{ width: '100%', minHeight: 100, fontSize: 12, lineHeight: 1.6, resize: 'vertical', marginTop: 4 }} />
        ) : intelNotes ? (
          <div style={{ fontSize: 12, color: 'var(--globant-text)', lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto' }}>{intelNotes}</div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--globant-muted)', fontStyle: 'italic' }}>Anotá lo que sabés — reuniones, contexto, señales internas. La IA lo usa al generar el brief.</div>
        )}
      </div>

      {/* Recent News */}
      {(() => {
        return (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: '#fbbf24', letterSpacing: '1px', textTransform: 'uppercase' }}>📰 Recent News</span>
            </div>
            {newsItems.length === 0 && (
              <p style={{ fontSize: 12, color: 'var(--globant-muted)', margin: 0 }}>No hay noticias cargadas para esta cuenta. Agregá el campo "Recent News" en Airtable.</p>
            )}
            {newsItems.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
                {newsItems.map((item, i) => {
                  const lc = (item.title + ' ' + item.body).toLowerCase();
                  const tag = lc.includes('ai') || lc.includes('artificial') ? { label: 'AI', color: '#bfd730' }
                            : lc.includes('partner') || lc.includes('deal') || lc.includes('agreement') ? { label: 'Partnership', color: '#a78bfa' }
                            : lc.includes('financ') || lc.includes('revenue') || lc.includes('invest') || lc.includes('billion') ? { label: 'Finance', color: '#4ade80' }
                            : lc.includes('hire') || lc.includes('appoint') || lc.includes('ceo') || lc.includes('cto') ? { label: 'Leadership', color: '#fb923c' }
                            : lc.includes('expand') || lc.includes('launch') || lc.includes('new office') ? { label: 'Expansion', color: '#38bdf8' }
                            : { label: 'News', color: '#94a3b8' };
                  const fullText = `${item.title}${item.body ? ' — ' + item.body : ''}`;
                  return (
                    <div key={i} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: '12px 14px', borderLeft: `3px solid ${tag.color}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: item.body ? 5 : 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--globant-text)', lineHeight: 1.4 }}>{item.title}</div>
                        <span style={{ fontSize: 9, fontWeight: 600, padding: '2px 7px', borderRadius: 5, background: tag.color + '22', color: tag.color, whiteSpace: 'nowrap', flexShrink: 0 }}>{tag.label}</span>
                      </div>
                      {item.body && <div style={{ fontSize: 11, color: 'var(--globant-muted)', lineHeight: 1.5, marginBottom: 6 }}>{item.body}</div>}
                      <div style={{ display: 'flex', gap: 8 }}>
                        {item.source && <a href={item.source} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: 'var(--globant-green)', textDecoration: 'none' }}>🔗 Source</a>}
                        <button onClick={() => navigator.clipboard.writeText(fullText)} style={{ fontSize: 10, padding: '1px 7px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: 'var(--globant-muted)', cursor: 'pointer' }}>📋</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {/* Intel Detail */}
      {radarData && (() => {
        const rd = radarData;
        const sectionTitle = (icon, label, color = '#5BBFB5') => (
          <div style={{ fontSize: 10, fontWeight: 800, color, letterSpacing: '1px', textTransform: 'uppercase', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{icon}</span><span>{label}</span>
          </div>
        );
        const box = (children, style = {}) => (
          <div style={{ background: 'var(--globant-darker)', borderRadius: 10, padding: '14px 16px', border: '1px solid rgba(255,255,255,0.06)', ...style }}>
            {children}
          </div>
        );
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {box(<>
                {sectionTitle('📰', 'Key Developments', '#fbbf24')}
                {(rd.key_developments || []).map((d, i) => (
                  <div key={i} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: i < (rd.key_developments.length - 1) ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--globant-text)', marginBottom: 3 }}>{d.headline}</div>
                    <div style={{ fontSize: 11, color: '#5BBFB5', marginBottom: 2 }}>→ {d.signal}</div>
                    {d.source && <div style={{ fontSize: 10, color: 'var(--globant-muted)' }}>Source: {d.source}</div>}
                  </div>
                ))}
                {(!rd.key_developments || rd.key_developments.length === 0) && <div style={{ fontSize: 11, color: 'var(--globant-muted)' }}>No key developments found.</div>}
              </>)}
              {box(<>
                {sectionTitle('👥', 'People Moves', '#fb923c')}
                {(rd.people_moves || []).length > 0 ? rd.people_moves.map((m, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--globant-text)' }}>{m.name}</div>
                    <div style={{ fontSize: 11, color: '#fb923c', marginBottom: 2 }}>{m.move}</div>
                    <div style={{ fontSize: 11, color: 'var(--globant-muted)' }}>{m.relevance}</div>
                  </div>
                )) : <div style={{ fontSize: 11, color: 'var(--globant-muted)' }}>No significant people moves detected.</div>}
                {rd.social_sentiment && <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  {sectionTitle('📣', 'Social Sentiment', '#60a5fa')}
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--globant-muted)', lineHeight: 1.6 }}>{rd.social_sentiment}</p>
                </div>}
              </>)}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {box(<>
                {sectionTitle('💰', 'Financial Signals', '#4ade80')}
                <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--globant-muted)', lineHeight: 1.6 }}>{rd.financial_signals || '—'}</p>
                {sectionTitle('💼', 'Hiring Signals', '#a78bfa')}
                <p style={{ margin: 0, fontSize: 11, color: 'var(--globant-muted)', lineHeight: 1.6 }}>{rd.hiring_signals || '—'}</p>
              </>)}
              {box(<>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>⚙️</span><span>Tech Stack</span>
                  {rd._techFromSnov
                    ? <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 5, background: 'rgba(52,211,153,0.12)', color: '#34d399', border: '1px solid rgba(52,211,153,0.2)', letterSpacing: 0.5 }}>✓ Verified</span>
                    : <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 5, background: 'rgba(148,163,184,0.1)', color: '#94a3b8', border: '1px solid rgba(148,163,184,0.15)', letterSpacing: 0.5 }}>~ Inferred</span>}
                </div>
                {(rd.tech_stack || []).map((t, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--globant-text)' }}>{t.tool}</div>
                    <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginBottom: 2 }}>{t.category}</div>
                    {t.opportunity && <div style={{ fontSize: 10, color: '#5BBFB5' }}>⚡ {t.opportunity}</div>}
                  </div>
                ))}
                {(!rd.tech_stack || rd.tech_stack.length === 0) && <div style={{ fontSize: 11, color: 'var(--globant-muted)', marginBottom: 12 }}>No tech stack signals found.</div>}
                {rd.competitive && <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  {sectionTitle('🏆', 'Competitive', '#f472b6')}
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--globant-muted)', lineHeight: 1.6 }}>{rd.competitive}</p>
                </div>}
              </>)}
            </div>
            {(rd.upcoming_events || []).length > 0 && box(<>
              {sectionTitle('📅', 'Upcoming Events', '#38bdf8')}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {rd.upcoming_events.map((ev, i) => (
                  <div key={i} style={{ flex: '1 1 220px', background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.15)', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--globant-text)' }}>{ev.event}</div>
                    {ev.date && <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginBottom: 4 }}>📅 {ev.date}</div>}
                    {ev.angle && <div style={{ fontSize: 11, color: '#38bdf8' }}>→ {ev.angle}</div>}
                  </div>
                ))}
              </div>
            </>)}
          </div>
        );
      })()}

      {/* Team Assignment — admin only */}
      {isAdmin && (() => {
        const bdrs = users.filter(u => {
          const r = F(u, 'Role');
          const role = typeof r === 'object' ? r?.name : r;
          return (role || '').toLowerCase() === 'bdr';
        });
        const cps = users.filter(u => {
          const r = F(u, 'Role');
          const role = typeof r === 'object' ? r?.name : r;
          return (role || '').toLowerCase() === 'cp';
        });
        const currentBdrIds = linkedIds(account, 'BDR');
        const currentCpIds = linkedIds(account, 'CP');
        const currentBdr = currentBdrIds[0] || '';
        const currentCp = currentCpIds[0] || '';

        const assignUser = async (field, userId) => {
          if (!api) return;
          try {
            const val = userId ? [userId] : [];
            await api.updateRecord(TABLE_IDS.accounts, account.id, { [field]: val });
            if (onUpdateRecord) onUpdateRecord('accounts', account.id, { [field]: val });
            if (onLogActivity) onLogActivity();
          } catch (e) { window.__oikeToast('Failed to assign: ' + e.message, 'error'); }
        };

        const sStyle = { width: '100%', padding: '7px 10px', background: 'var(--globant-input)', border: '1px solid var(--globant-border)', borderRadius: 6, color: 'var(--globant-text)', fontSize: 12, boxSizing: 'border-box' };
        const lStyle = { fontSize: 10, fontWeight: 700, color: 'var(--globant-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 5, display: 'block' };

        return (
          <div className="card" style={{ borderLeft: '3px solid #a78bfa', marginBottom: 16 }}>
            <div className="card-header"><h3>👥 Team Assignment</h3></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <label style={lStyle}>BDR Assigned</label>
                <select style={sStyle} value={currentBdr} onChange={e => assignUser('BDR', e.target.value)}>
                  <option value="">— Unassigned —</option>
                  {bdrs.map(u => <option key={u.id} value={u.id}>{F(u, 'Name') || F(u, 'Email') || u.id}</option>)}
                </select>
              </div>
              <div>
                <label style={lStyle}>Client Partner Assigned</label>
                <select style={sStyle} value={currentCp} onChange={e => assignUser('CP', e.target.value)}>
                  <option value="">— Unassigned —</option>
                  {cps.map(u => <option key={u.id} value={u.id}>{F(u, 'Name') || F(u, 'Email') || u.id}</option>)}
                </select>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
