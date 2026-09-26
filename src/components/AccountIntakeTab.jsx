import React, { useEffect } from 'react';
import { F } from '../utils.jsx';

const INTAKE_FIELDS = [
  { key: 'Company Context', label: 'Contexto de la empresa', icon: '🏢' },
  { key: 'Current Sales Motion', label: 'Cómo venden hoy', icon: '🔄' },
  { key: 'Sales Team Size', label: 'Equipo de ventas', icon: '👥' },
  { key: 'Main Challenge', label: 'Desafío principal', icon: '🎯' },
  { key: "What They've Tried", label: 'Qué intentaron antes', icon: '🔬' },
  { key: 'Goals', label: 'Objetivos con Oike', icon: '🚀' },
  { key: 'Pipeline Last 90 Days', label: 'Pipeline últimos 90 días', icon: '📊' },
  { key: 'Prospecting Activity', label: 'Actividad de prospección', icon: '📤' },
  { key: 'Messaging Examples', label: 'Ejemplos de mensajería', icon: '✉️' },
  { key: 'Drive Link', label: 'Link a archivos', icon: '📎' },
  { key: 'Additional Context', label: 'Contexto adicional', icon: '📝' },
];

export default function AccountIntakeTab({
  account, intakeRecord, intakeLoading, generatingIntake, loadIntakeRecord, generateIntakeLink,
}) {
  useEffect(() => {
    if (account && !intakeRecord && !intakeLoading) loadIntakeRecord();
  }, [account?.id]);

  const fields = intakeRecord?.fields || {};
  const token = fields['Token'] || '';
  const status = fields['Status'] || '';
  const submittedAt = fields['Submitted At'];
  const intakeUrl = token ? `${window.location.origin}/intake.html?token=${token}` : '';

  const copyLink = (lang = 'es') => {
    if (!intakeUrl) return;
    const url = lang === 'en' ? intakeUrl + '&lang=en' : intakeUrl;
    navigator.clipboard.writeText(url);
    window.__oikeToast(lang === 'en' ? 'Link (EN) copied' : 'Link (ES) copiado', 'success');
  };

  const filledCount = INTAKE_FIELDS.filter(f => fields[f.key]?.trim?.()).length;

  if (intakeLoading) {
    return (
      <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--globant-muted)', fontSize: 13 }}>
        ⏳ Cargando intake…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header card */}
      <div className="card" style={{ borderLeft: '3px solid var(--globant-green)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h3 style={{ marginBottom: 6 }}>📋 Pre-diagnóstico del cliente</h3>
            <p style={{ fontSize: 12, color: 'var(--globant-muted)', margin: 0 }}>
              Generá un link único para que <strong style={{ color: 'var(--globant-text)' }}>{F(account, 'Account Name')}</strong> complete su pre-diagnóstico antes de la primera sesión.
            </p>
          </div>
          {!intakeRecord && (
            <button className="action-btn btn-primary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}
              onClick={generateIntakeLink} disabled={generatingIntake}>
              {generatingIntake ? '⏳ Generando…' : '🔗 Generar link de intake'}
            </button>
          )}
        </div>

        {/* Link + status */}
        {intakeRecord && (
          <div style={{ marginTop: 16, padding: '14px 16px', background: 'var(--globant-darker)', borderRadius: 10, border: '1px solid var(--globant-border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                background: status === 'Submitted' ? 'rgba(52,211,153,0.15)' : 'rgba(251,191,36,0.12)',
                color: status === 'Submitted' ? '#34d399' : '#fbbf24',
                border: `1px solid ${status === 'Submitted' ? 'rgba(52,211,153,0.3)' : 'rgba(251,191,36,0.25)'}`,
                whiteSpace: 'nowrap',
              }}>
                {status === 'Submitted' ? '✅ Completado' : '⏳ Pendiente'}
              </span>
              {submittedAt && (
                <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>
                  · Enviado {new Date(submittedAt).toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' })}
                </span>
              )}
              {status === 'Submitted' && (
                <span style={{ fontSize: 11, color: 'var(--globant-muted)' }}>
                  · {filledCount}/{INTAKE_FIELDS.length} campos completados
                </span>
              )}
            </div>

            {status !== 'Submitted' && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 10, color: 'var(--globant-muted)', marginBottom: 6, fontWeight: 600, letterSpacing: '0.5px' }}>LINK PARA COMPARTIR</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--globant-border)', borderRadius: 8, padding: '8px 12px', fontSize: 11, color: 'var(--globant-muted)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {intakeUrl}
                  </div>
                  <button className="action-btn btn-primary" style={{ fontSize: 11, whiteSpace: 'nowrap' }} onClick={() => copyLink('es')}>
                    📋 ES
                  </button>
                  <button className="action-btn btn-ghost" style={{ fontSize: 11, whiteSpace: 'nowrap' }} onClick={() => copyLink('en')}>
                    📋 EN
                  </button>
                </div>
                <p style={{ fontSize: 11, color: 'var(--globant-muted)', marginTop: 8, margin: '8px 0 0' }}>
                  Mandá este link al cliente por email o WhatsApp. No necesita crear cuenta.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Respuestas */}
      {intakeRecord && status === 'Submitted' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--globant-muted)', letterSpacing: '1px', textTransform: 'uppercase' }}>
            Respuestas del cliente
          </div>
          {INTAKE_FIELDS.map(({ key, label, icon }) => {
            const val = fields[key];
            if (!val) return null;
            const isUrl = key === 'Drive Link';
            return (
              <div key={key} className="card" style={{ padding: '14px 16px' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--globant-muted)', letterSpacing: '0.8px', textTransform: 'uppercase', marginBottom: 8 }}>
                  {icon} {label}
                </div>
                {isUrl ? (
                  <a href={val} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: 'var(--globant-green)', wordBreak: 'break-all' }}>{val}</a>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--globant-text)', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>{val}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state — no intake yet */}
      {!intakeRecord && !generatingIntake && (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--globant-muted)', fontSize: 13 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
          <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--globant-text)' }}>Sin intake todavía</div>
          <div>Generá el link y compartilo con el cliente para que complete el pre-diagnóstico.</div>
        </div>
      )}

    </div>
  );
}
