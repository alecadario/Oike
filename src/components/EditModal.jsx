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
                  {f.options.map(o => typeof o === 'object'
                    ? <option key={o.value} value={o.value}>{o.label}</option>
                    : <option key={o} value={o}>{o}</option>
                  )}
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

export default EditModal;
