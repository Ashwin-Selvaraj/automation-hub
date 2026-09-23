import React, { useState, useEffect } from 'react';
import { theme, styles } from '../theme.js';
import { getSlackMessages, getJiraIssues, getSyncLog, getAutomations, setAutomationEnabled, runAutomation, getBrief } from '../api.js';
import { API_BASE, apiHeaders } from '../config.js';
import Card, { SectionHeader } from '../components/Card.jsx';
import Badge from '../components/Badge.jsx';
import Toggle from '../components/Toggle.jsx';
import Spinner from '../components/Spinner.jsx';
import CheckoutCard from '../components/CheckoutCard.jsx';

const { colors, fonts } = theme;

// Who an automation talks to. Worth surfacing: an automation that messages the
// whole team deserves more thought before switching it on than one that only
// writes to Jira.
const AUDIENCE_LABEL = {
  lead:     'Goes to you',
  member:   'Messages the team',
  reviewer: 'Messages reviewers',
  channel:  'Posts to the channel',
  system:   'No messages',
};

function relativeTime(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return null;
  const mins = Math.round(diff / 60000);
  if (mins < 1)    return 'just now';
  if (mins < 60)   return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24)  return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ─── Daily brief ──────────────────────────────────────────────────────────────

const BRIEF_SECTIONS = [
  { key: 'blockers',   label: 'Blocked',     tone: 'urgent' },
  { key: 'overdue',    label: 'Overdue',     tone: 'urgent' },
  { key: 'dueSoon',    label: 'Due soon',    tone: 'watch'  },
  { key: 'stale',      label: 'Not moving',  tone: 'watch'  },
  { key: 'offPlan',    label: 'Off-plan',    tone: 'watch'  },
  { key: 'wip',        label: 'Overloaded',  tone: 'watch'  },
  { key: 'scopeAdded', label: 'Added late',  tone: 'watch'  },
];

// Delivery forecast states. "Too early" is deliberately styled as neutral —
// refusing to guess is a correct answer, not a warning.
const FORECAST_TONE = {
  'at-risk':   { label: 'At risk',   color: 'red'    },
  stalled:     { label: 'Stalled',   color: 'red'    },
  'on-track':  { label: 'On track',  color: 'green'  },
  'too-early': { label: 'Too early', color: 'muted'  },
};

function BriefCard() {
  const [brief, setBrief] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getBrief()
      .then((d) => { setBrief(d); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const s = brief?.signals;
  const quiet = (s?.noUpdate?.length || 0) + (s?.unmatched?.length || 0);
  const counts = s
    ? BRIEF_SECTIONS.map((sec) => ({ ...sec, n: (s[sec.key] || []).length })).filter((c) => c.n > 0)
    : [];

  return (
    <Card style={{ marginBottom: 24 }}>
      <SectionHeader>Today's brief</SectionHeader>

      {loading && <Spinner />}
      {error && <div style={{ fontSize: 13, color: colors.red600 }}>{error}</div>}

      {s && (
        <>
          {s.focus && (
            <div style={{
              fontSize: 14, color: colors.gray900, lineHeight: 1.55,
              paddingBottom: 14, marginBottom: 14, borderBottom: `1px solid ${colors.gray200 || '#e5e7eb'}`,
            }}>
              {s.focus}
            </div>
          )}

          {counts.length === 0 && quiet === 0 && (
            <div style={{ fontSize: 14, color: colors.gray400 }}>
              Nothing needs your attention this morning.
            </div>
          )}

          {counts.length > 0 && (
            <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginBottom: quiet ? 12 : 0 }}>
              {counts.map((c) => (
                <div key={c.key}>
                  <div style={{
                    fontSize: 22, fontWeight: 500,
                    color: c.tone === 'urgent' ? colors.red600 : colors.amber600,
                  }}>{c.n}</div>
                  <div style={{ fontSize: 11, color: colors.gray400, marginTop: 1 }}>{c.label}</div>
                </div>
              ))}
            </div>
          )}

          {quiet > 0 && (
            <div style={{ fontSize: 12, color: colors.gray400 }}>
              {quiet === 1 ? '1 person was' : `${quiet} people were`} quiet today.{' '}
              {[...(s.noUpdate || []), ...(s.unmatched || [])].join(', ')}.
              {' '}Nobody was messaged about it.
            </div>
          )}

          {s.forecast && FORECAST_TONE[s.forecast.status] && (() => {
            const tone = FORECAST_TONE[s.forecast.status];
            const color = tone.color === 'red' ? colors.red600
                        : tone.color === 'green' ? colors.green600
                        : colors.gray400;
            return (
              <div style={{
                marginTop: 12, paddingTop: 12,
                borderTop: `1px solid ${colors.gray200 || '#e5e7eb'}`,
                display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
              }}>
                <span style={{
                  fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase',
                  color, fontWeight: 600,
                }}>{tone.label}</span>
                <span style={{ fontSize: 12, color: colors.gray400 }}>{s.forecast.summary}</span>
              </div>
            );
          })()}

          {!s.forecast && s.progress?.total > 0 && (
            <div style={{ fontSize: 12, color: colors.gray400, marginTop: 10 }}>
              Sprint: {s.progress.done} of {s.progress.total} done · {s.daysLeft} working days left
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ─── Automations ──────────────────────────────────────────────────────────────

function AutomationRow({ automation, onToggle, onRun, busy }) {
  const { key, name, description, schedule, scheduleError, enabled, audience, lastRun } = automation;
  const failed = lastRun?.status === 'failed';

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, color: colors.gray900 }}>{name}</span>
          <span style={{ fontSize: 11, color: colors.gray400, fontFamily: fonts.mono || fonts.body }}>
            {AUDIENCE_LABEL[audience] || audience}
          </span>
        </div>
        <div style={{ fontSize: 12, color: colors.gray400, marginTop: 2 }}>{description}</div>
        <div style={{ fontSize: 11, color: colors.gray400, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {scheduleError
            ? <span style={{ color: colors.red600 }}>Schedule problem: {scheduleError}</span>
            : <span>{enabled ? schedule : 'Not scheduled'}</span>}
          {lastRun && (
            <span style={{ color: failed ? colors.red600 : colors.gray400 }}>
              last run {relativeTime(lastRun.at)}{failed ? ' — failed' : ''}
            </span>
          )}
        </div>
        {failed && lastRun.error && (
          <div style={{ fontSize: 11, color: colors.red600, marginTop: 3 }}>{lastRun.error}</div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => onRun(key)}
          disabled={busy}
          style={{
            fontSize: 11, color: colors.gray400, background: 'none',
            border: `1px solid ${colors.gray200 || '#e5e7eb'}`, borderRadius: 4,
            padding: '3px 8px', cursor: busy ? 'default' : 'pointer',
            fontFamily: fonts.body, opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? 'Running…' : 'Run now'}
        </button>
        <Toggle checked={enabled} onChange={(v) => onToggle(key, v)} />
      </div>
    </div>
  );
}

function AutomationsCard() {
  const [automations, setAutomations] = useState(null);
  const [error,   setError]   = useState(null);
  const [busyKey, setBusyKey] = useState(null);

  const load = () => getAutomations()
    .then((d) => { setAutomations(d.automations); setError(null); })
    .catch((e) => setError(e.message));

  useEffect(() => { load(); }, []);

  const toggle = async (key, enabled) => {
    // Optimistic — the switch should feel immediate; a failure re-reads truth.
    setAutomations((prev) => prev.map((a) => (a.key === key ? { ...a, enabled } : a)));
    try {
      await setAutomationEnabled(key, enabled);
      await load();
    } catch (e) {
      setError(e.message);
      await load();
    }
  };

  const run = async (key) => {
    setBusyKey(key);
    try {
      await runAutomation(key);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyKey(null);
      await load();
    }
  };

  return (
    <Card style={{ marginBottom: 0 }}>
      <SectionHeader>Automations</SectionHeader>
      {error && (
        <div style={{ fontSize: 12, color: colors.red600, marginBottom: 10 }}>{error}</div>
      )}
      {automations === null && !error && <Spinner />}
      {automations?.length === 0 && (
        <div style={{ fontSize: 13, color: colors.gray400 }}>No automations are registered.</div>
      )}
      <div>
        {(automations || []).map((a, i) => (
          <React.Fragment key={a.key}>
            {i > 0 && <div style={styles.divider} />}
            <AutomationRow
              automation={a}
              onToggle={toggle}
              onRun={run}
              busy={busyKey === a.key}
            />
          </React.Fragment>
        ))}
      </div>
    </Card>
  );
}

// ─── Member list popup ────────────────────────────────────────────────────────

function MemberListPopup({ title, members, emptyText, accentColor, onClose }) {
  // Close on Escape
  useEffect(() => {
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [onClose]);

  function initials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2);
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)',
          zIndex: 300, backdropFilter: 'blur(1px)',
        }}
      />
      {/* Panel */}
      <div style={{
        position: 'fixed', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        background: colors.white, borderRadius: 12,
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
        zIndex: 301, width: 340, maxHeight: '70vh',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.gray100}`,
          background: colors.gray50,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              background: accentColor, flexShrink: 0,
            }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: colors.gray900, fontFamily: fonts.body }}>
              {title}
            </span>
            <span style={{
              fontSize: 11, fontWeight: 700, background: accentColor + '22',
              color: accentColor, padding: '1px 7px', borderRadius: 99,
              fontFamily: fonts.body,
            }}>
              {members.length}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: colors.gray100, border: 'none', borderRadius: '50%',
              width: 26, height: 26, cursor: 'pointer', fontSize: 15,
              color: colors.gray500, display: 'flex', alignItems: 'center',
              justifyContent: 'center', lineHeight: 1,
            }}
          >×</button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', padding: '8px 0' }}>
          {members.length === 0 ? (
            <div style={{
              padding: '28px 20px', textAlign: 'center',
              fontSize: 13, color: colors.gray400, fontFamily: fonts.body,
            }}>
              {emptyText}
            </div>
          ) : (
            members.map((m, i) => (
              <div
                key={m.id || m.userId || i}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 20px',
                  borderBottom: i < members.length - 1 ? `1px solid ${colors.gray100}` : 'none',
                }}
              >
                {/* Avatar */}
                <div style={{
                  width: 36, height: 36, borderRadius: '50%',
                  background: colors.blue50, color: colors.blue600,
                  fontSize: 13, fontWeight: 700, fontFamily: fonts.body,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, border: `2px solid ${colors.gray200}`,
                }}>
                  {initials(m.name)}
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: colors.gray900, fontFamily: fonts.body }}>
                    {m.name}
                  </div>
                  {m.role && (
                    <div style={{ fontSize: 11, color: colors.gray400, fontFamily: fonts.body, marginTop: 1 }}>
                      {m.role}
                    </div>
                  )}
                </div>
                {/* Time posted (if available) */}
                {m.time && (
                  <div style={{ marginLeft: 'auto', fontSize: 11, color: colors.gray400, fontFamily: fonts.body, whiteSpace: 'nowrap' }}>
                    {m.time}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

// ─── Jira Tasks popup ────────────────────────────────────────────────────────

function statusColor(status) {
  if (!status) return colors.gray400;
  const s = status.toLowerCase();
  if (s.includes('done') || s.includes('closed') || s.includes('complete')) return colors.green600;
  if (s.includes('progress') || s.includes('review')) return colors.blue600;
  if (s.includes('block') || s.includes('overdue')) return colors.red600;
  return colors.amber600;
}

function JiraTasksPopup({ issues, onClose }) {
  useEffect(() => {
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [onClose]);

  const grouped = issues.reduce((acc, iss) => {
    const s = iss.status || 'Unknown';
    if (!acc[s]) acc[s] = [];
    acc[s].push(iss);
    return acc;
  }, {});

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 300, backdropFilter: 'blur(1px)' }} />
      <div style={{
        position: 'fixed', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        background: colors.white, borderRadius: 12,
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
        zIndex: 301, width: 500, maxHeight: '75vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.gray100}`,
          background: colors.gray50, flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: colors.green600 }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: colors.gray900 }}>Tasks in Jira</span>
            <span style={{ fontSize: 11, fontWeight: 700, background: colors.green600 + '22', color: colors.green600, padding: '1px 7px', borderRadius: 99 }}>
              {issues.length}
            </span>
          </div>
          <button onClick={onClose} style={{ background: colors.gray100, border: 'none', borderRadius: '50%', width: 26, height: 26, cursor: 'pointer', fontSize: 15, color: colors.gray500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', padding: '8px 0' }}>
          {issues.length === 0 ? (
            <div style={{ padding: '28px 20px', textAlign: 'center', fontSize: 13, color: colors.gray400 }}>No tasks found in Jira.</div>
          ) : (
            Object.entries(grouped).map(([status, items]) => (
              <div key={status}>
                {/* Status group header */}
                <div style={{ padding: '8px 20px 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(status), flexShrink: 0 }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: colors.gray500, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {status} ({items.length})
                  </span>
                </div>
                {items.map((iss, i) => (
                  <div key={iss.key} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 12,
                    padding: '9px 20px',
                    borderBottom: `1px solid ${colors.gray50}`,
                    background: i % 2 === 0 ? colors.white : colors.gray50,
                  }}>
                    {/* Issue key */}
                    <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.blue600, fontWeight: 700, whiteSpace: 'nowrap', marginTop: 1, minWidth: 70 }}>
                      {iss.key}
                    </span>
                    {/* Summary */}
                    <span style={{ fontSize: 13, color: colors.gray800, flex: 1, lineHeight: 1.5 }}>{iss.summary}</span>
                    {/* Assignee */}
                    {iss.assigneeName && iss.assigneeName !== 'Unassigned' && (
                      <span style={{ fontSize: 11, color: colors.gray400, whiteSpace: 'nowrap', marginTop: 1 }}>{iss.assigneeName}</span>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

// ─── Metric card — optionally clickable ──────────────────────────────────────

function MetricCard({ label, value, loading, tint, onClick }) {
  const [hovered, setHovered] = useState(false);
  const bg     = tint ? tint.bg     : colors.white;
  const border = tint ? tint.border : colors.gray200;
  const valCol = tint ? tint.text   : colors.gray900;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => onClick && setHovered(true)}
      onMouseLeave={() => onClick && setHovered(false)}
      style={{
        background: bg,
        border: `1px solid ${hovered ? valCol : border}`,
        borderRadius: 8,
        padding: '20px 20px 16px',
        boxShadow: hovered ? `0 4px 12px ${border}88` : '0 1px 3px rgba(0,0,0,0.06)',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'all 0.15s ease',
        position: 'relative',
      }}
    >
      <div style={{ fontSize: 28, fontWeight: 700, color: valCol, fontFamily: fonts.body, lineHeight: 1.2 }}>
        {loading ? <Spinner size={24} /> : value ?? '—'}
      </div>
      <div style={{
        fontSize: 12, color: valCol, opacity: 0.65,
        marginTop: 6, fontFamily: fonts.body,
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        {label}
        {onClick && !loading && (
          <span style={{ opacity: 0.5, fontSize: 11 }}>↗</span>
        )}
      </div>
    </div>
  );
}

// ─── Activity table ───────────────────────────────────────────────────────────

function ActivityTable({ entries }) {
  if (!entries.length) {
    return (
      <div style={{ padding: '32px 0', textAlign: 'center' }}>
        <p style={{ fontSize: 14, fontWeight: 500, color: colors.gray900 }}>No activity yet</p>
        <p style={{ fontSize: 13, color: colors.gray400, marginTop: 4 }}>Run a sync to see entries here.</p>
      </div>
    );
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Time', 'Member', 'Action', 'Status'].map((h) => (
              <th key={h} style={{
                fontSize: 11, fontWeight: 600, color: colors.gray600, textTransform: 'uppercase',
                letterSpacing: '0.05em', padding: '8px 12px', borderBottom: `1px solid ${colors.gray200}`,
                textAlign: 'left', background: colors.white, whiteSpace: 'nowrap',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.slice(0, 10).map((e) => (
            <tr key={e.id} style={{ borderBottom: `1px solid ${colors.gray100}` }}>
              <td style={{ padding: '10px 12px', fontSize: 12, color: colors.gray400, fontFamily: fonts.mono, whiteSpace: 'nowrap' }}>
                {new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </td>
              <td style={{ padding: '10px 12px', fontSize: 14, color: colors.gray700 }}>{e.userName || '—'}</td>
              <td
                title={e.details || undefined}
                style={{ padding: '10px 12px', fontSize: 13, color: colors.gray600, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: e.details ? 'help' : 'default' }}
              >
                {e.jiraKey && (
                  <span style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.blue600, marginRight: 6 }}>{e.jiraKey}</span>
                )}
                {e.action}
              </td>
              <td style={{ padding: '10px 12px' }}>
                <Badge variant={e.success ? 'success' : 'error'}>{e.success ? 'OK' : 'Error'}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

export default function OverviewTab({ config, navigate }) {
  const [messages,    setMessages]    = useState([]);
  const [issues,      setIssues]      = useState([]);
  const [log,         setLog]         = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [perfDash,    setPerfDash]    = useState(null);
  const [popup,        setPopup]        = useState(null); // 'posted' | 'missing' | 'tasks' | 'present' | 'leave' | 'late' | null
  const [attendance,     setAttendance]     = useState(null); // Zoho data
  const [attendanceError, setAttendanceError] = useState(null); // Zoho error string
  const [mismatchData,   setMismatchData]   = useState(null); // mismatch alerts

  const loadAttendance = () => {
    fetch(`${API_BASE}/api/attendance/today`, { headers: apiHeaders() })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        return body;
      })
      .then((data) => {
        console.log('[Overview] Attendance response:', data);
        setAttendance(data);
        setAttendanceError(null);
      })
      .catch((err) => {
        console.error('[Overview] Failed to fetch attendance:', err.message);
        setAttendanceError(err.message);
      });
  };

  const resolveMismatch = (eventId) => {
    fetch(`${API_BASE}/api/mismatch/${eventId}/resolve`, { method: 'PATCH', headers: apiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({}) })
      .then((r) => r.ok ? r.json() : null)
      .then(() => {
        setMismatchData((prev) => prev
          ? { ...prev, events: prev.events.map((e) => e.id === eventId ? { ...e, resolved: true } : e) }
          : prev
        );
      })
      .catch(console.error);
  };

  useEffect(() => {
    Promise.all([
      getSlackMessages(30).catch(() => ({ messages: [] })),
      getJiraIssues().catch(() => ({ issues: [] })),
      getSyncLog(50).catch(() => ({ entries: [] })),
      fetch(`${API_BASE}/api/performance/dashboard`, { headers: apiHeaders() }).then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch(`${API_BASE}/api/mismatch/current`, { headers: apiHeaders() }).then((r) => r.ok ? r.json() : null).catch(() => null),
    ]).then(([msgData, issData, logData, perf, mismatch]) => {
      setMessages(msgData.messages || []);
      setIssues(issData.issues || []);
      setLog(logData.entries || []);
      setPerfDash(perf);
      setMismatchData(mismatch);
    }).finally(() => setLoading(false));

    // Load attendance separately so its errors are isolated
    loadAttendance();

    // Auto-refresh every 5 minutes
    const interval = setInterval(() => {
      loadAttendance();
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // ── Who posted today ───────────────────────────────────────────────────────
  const today      = new Date().toDateString();
  const todayMsgs  = messages.filter((m) => m.date && new Date(m.date).toDateString() === today);
  const teamMembers = config?.teamMembers || [];

  const postedMap = {};
  for (const msg of todayMsgs) {
    if (!msg.userId) continue;
    if (!postedMap[msg.userId] || msg.date > postedMap[msg.userId]) {
      postedMap[msg.userId] = msg.date;
    }
  }

  const postedMembers = teamMembers
    .filter((m) => postedMap[m.id])
    .map((m) => ({
      ...m,
      time: new Date(postedMap[m.id]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }));

  const missingMembers = teamMembers.filter((m) => !postedMap[m.id]);
  const postedCount  = teamMembers.length > 0 ? postedMembers.length : new Set(todayMsgs.map((m) => m.userId).filter(Boolean)).size;
  const missingCount = teamMembers.length > 0 ? missingMembers.length : Math.max(0, (config?.teamMembers?.length || 0) - postedCount);

  // ── Metrics ────────────────────────────────────────────────────────────────
  const ts = perfDash?.teamStats;
  const metrics = ts ? [
    { id: 'score',    label: 'Avg Performance Score', value: ts.avgScore + '',         tint: colors.tintBlue   },
    { id: 'complete', label: 'Completion Rate',        value: ts.avgCompletion + '%',   tint: colors.tintGreen  },
    { id: 'deadline', label: 'Deadline Rate',          value: ts.avgDeadlineRate + '%', tint: colors.tintAmber  },
    { id: 'standup',  label: 'Standup Rate',           value: ts.avgStandupRate + '%',  tint: colors.tintPurple },
  ] : [
    { id: 'messages', label: 'Messages This Sprint',   value: messages.length,  tint: colors.tintBlue,  navigate: 'sync' },
    { id: 'tasks',    label: 'Tasks in Jira',          value: issues.length,    tint: colors.tintGreen, clickable: true  },
    { id: 'posted',   label: 'Posted Today',           value: postedCount,      tint: colors.tintAmber, clickable: true  },
    { id: 'missing',  label: 'Missing Today',          value: missingCount,     tint: colors.tintRed,   clickable: true  },
  ];

  const atRisk = perfDash?.atRisk || [];

  function handleCardClick(m) {
    if (m.navigate) { navigate?.(m.navigate); return; }
    if (m.clickable) setPopup(m.id);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h1 style={styles.pageTitle}>Overview</h1>
        <p style={styles.subtitle}>{config?.sprintName || 'Sprint'} · {config?.startDate} → {config?.endDate}</p>
      </div>

      {/* The same brief that gets DM'd each morning — first thing on the page,
          because it is the thing worth reading first. */}
      <BriefCard />

      <CheckoutCard />

      {/* ── Needs Your Attention (mismatch alerts) ── */}
      {mismatchData && mismatchData.events && mismatchData.events.filter((e) => !e.resolved).length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: colors.amber600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            ⚠️  Needs Your Attention
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {mismatchData.events.filter((e) => !e.resolved).map((evt) => {
              const hoursAgo = Math.round((Date.now() - new Date(evt.createdAt).getTime()) / 3600000);
              const timeLabel = hoursAgo < 1 ? 'just now' : `${hoursAgo}h ago`;
              const typeLabel = evt.matchType === 'unassigned_task' ? 'working on someone else\'s task'
                : evt.matchType === 'different_project' ? 'work outside project scope'
                : 'no matching sprint task';
              return (
                <div key={evt.id} style={{
                  background: colors.tintAmber.bg,
                  border: `1px solid ${colors.tintAmber.border}`,
                  borderLeft: `3px solid ${colors.amber600}`,
                  borderRadius: '0 6px 6px 0',
                  padding: '10px 14px',
                  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: colors.gray900, fontFamily: colors.fonts || 'inherit', marginBottom: 2 }}>
                      {evt.memberName}
                    </div>
                    <div style={{ fontSize: 13, color: '#92400E', lineHeight: 1.5, marginBottom: 4 }}>
                      {evt.mismatchDetails || typeLabel}
                    </div>
                    <div style={{ fontSize: 12, color: colors.gray400 }}>
                      {evt.memberDmSent ? 'DM sent' : 'No DM sent'} · {timeLabel}
                    </div>
                  </div>
                  <button
                    onClick={() => resolveMismatch(evt.id)}
                    style={{
                      flexShrink: 0, background: 'white', border: `1px solid ${colors.gray200}`,
                      borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 600,
                      color: colors.gray600, cursor: 'pointer', whiteSpace: 'nowrap',
                    }}
                  >
                    Resolve
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {metrics.map((m) => (
          <MetricCard
            key={m.id}
            label={m.label}
            value={m.value}
            loading={loading}
            tint={m.tint}
            onClick={(m.clickable || m.navigate) && !loading ? () => handleCardClick(m) : undefined}
          />
        ))}
      </div>

      {/* Attendance error state — only show when feature is enabled */}
      {attendanceError && attendance?.enabled !== false && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, marginBottom: 8,
          background: '#FFFBEB', border: '1px solid #FDE68A',
          display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 12, color: '#92400E', fontFamily: 'inherit',
        }}>
          <span>⚠ Attendance unavailable: {attendanceError}</span>
          <a href="/api/debug/zoho" target="_blank" rel="noopener noreferrer"
            style={{ color: '#2563EB', fontSize: 11, textDecoration: 'underline', whiteSpace: 'nowrap' }}>
            Run diagnostic →
          </a>
        </div>
      )}

      {/* Attendance section — hidden entirely when feature flag is OFF */}
      {attendance?.enabled !== false && attendance?.configured && (
        <div>
          {/* Header row with source badge */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: colors.gray400, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Attendance Today
            </div>
            {attendance.source && (
              <span style={{
                fontSize: 10, fontWeight: 600, fontFamily: fonts.mono,
                padding: '2px 8px', borderRadius: 100,
                ...(attendance.source === 'zoho_api'
                  ? { background: '#F0FDF4', color: '#16A34A', border: '1px solid #BBF7D0' }
                  : attendance.source === 'zoho_webhook'
                  ? { background: '#EFF6FF', color: '#2563EB', border: '1px solid #BFDBFE' }
                  : attendance.source === 'mixed'
                  ? { background: '#F9FAFB', color: '#6B7280', border: '1px solid #E5E7EB' }
                  : { background: '#FFFBEB', color: '#D97706', border: '1px solid #FDE68A' } // slack_presence
                ),
              }}>
                {attendance.source === 'zoho_api'       ? '● Zoho API'
                : attendance.source === 'zoho_webhook'  ? '● Zoho Live'
                : attendance.source === 'mixed'         ? '● Mixed sources'
                : '● Slack Activity'}
              </span>
            )}
          </div>

          {/* Summary metric cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 14 }}>
            {[
              { id: 'present', label: 'Present',    value: attendance.summary?.present ?? 0, tint: colors.tintGreen,  members: attendance.present  || [] },
              { id: 'leave',   label: 'On Leave',   value: attendance.summary?.onLeave ?? 0, tint: { bg: colors.gray50, border: colors.gray200, text: colors.gray500 }, members: attendance.onLeave || [] },
              { id: 'absent',  label: 'Absent',     value: attendance.summary?.absent  ?? 0, tint: colors.tintRed,    members: attendance.absent   || [] },
              { id: 'late',    label: 'Late Today',  value: attendance.summary?.late   ?? 0, tint: colors.tintAmber,  members: attendance.late     || [] },
            ].map((m) => (
              <MetricCard key={m.id} label={m.label} value={m.value} loading={loading}
                tint={m.tint} onClick={!loading ? () => setPopup(m.id) : undefined} />
            ))}
          </div>

          {/* Present / Absent two-column list */}
          {(attendance.present?.length > 0 || attendance.absent?.length > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {/* Present */}
              <div style={{
                background: '#F0FDF4', border: '1px solid #BBF7D0',
                borderRadius: 8, padding: '10px 14px',
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#15803D', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Present ({attendance.present?.length ?? 0})
                </div>
                {(attendance.present || []).map((m) => (
                  <div key={m.memberId || m.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 12 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#16A34A', flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ fontWeight: 500, color: colors.gray800, fontFamily: fonts.body, flex: 1 }}>{m.name}</span>
                    {m.checkInTime && (
                      <span style={{ color: colors.gray400, fontFamily: fonts.mono, fontSize: 11 }}>
                        {m.checkInTime}
                        {m.isLate && (
                          <span title={`Late by ${m.lateByMinutes} min`} style={{ color: '#D97706', marginLeft: 3 }}>⚠</span>
                        )}
                      </span>
                    )}
                  </div>
                ))}
                {(attendance.present || []).length === 0 && (
                  <div style={{ fontSize: 12, color: colors.gray400, fontFamily: fonts.body }}>No check-ins yet</div>
                )}
              </div>

              {/* Absent */}
              <div style={{
                background: '#FEF2F2', border: '1px solid #FECACA',
                borderRadius: 8, padding: '10px 14px',
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#DC2626', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Absent ({attendance.absent?.length ?? 0})
                </div>
                {(attendance.absent || []).map((m) => (
                  <div key={m.memberId || m.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 12 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#D1D5DB', flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ color: colors.gray500, fontFamily: fonts.body }}>{m.name}</span>
                  </div>
                ))}
                {(attendance.absent || []).length === 0 && (
                  <div style={{ fontSize: 12, color: colors.gray400, fontFamily: fonts.body }}>Everyone is in 🎉</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* At-risk row */}
      {atRisk.length > 0 && (
        <Card style={{ marginBottom: 0, padding: '12px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: colors.red600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
            At Risk
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {atRisk.map((m) => (
              <div key={m.member_id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                  background: colors.red600, flexShrink: 0,
                }} />
                <span style={{ fontWeight: 600, color: colors.gray900, fontFamily: fonts.body }}>{m.name}</span>
                <span style={{ color: colors.red600, fontFamily: fonts.body }}>{m.riskReason}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Activity log */}
      <Card style={{ marginBottom: 0 }}>
        <SectionHeader>Recent Activity</SectionHeader>
        <ActivityTable entries={log} />
      </Card>

      {/* Automations */}
      <AutomationsCard />

      {/* Popups */}
      {popup === 'posted' && (
        <MemberListPopup
          title="Posted Today"
          members={postedMembers.length > 0 ? postedMembers : Array.from(new Set(todayMsgs.map(m => m.userId).filter(Boolean))).map(id => ({ id, name: id }))}
          emptyText="Nobody has posted a standup today yet."
          accentColor={colors.amber600}
          onClose={() => setPopup(null)}
        />
      )}
      {popup === 'missing' && (
        <MemberListPopup
          title="Missing Today"
          members={missingMembers}
          emptyText="Everyone has posted today! 🎉"
          accentColor={colors.red600}
          onClose={() => setPopup(null)}
        />
      )}
      {popup === 'tasks' && (
        <JiraTasksPopup
          issues={issues}
          onClose={() => setPopup(null)}
        />
      )}
      {popup === 'present' && attendance?.present && (
        <MemberListPopup
          title="Present Today"
          members={attendance.present.map((m) => ({ ...m, role: m.checkInTime ? `Checked in at ${m.checkInTime}` : undefined }))}
          emptyText="No check-ins recorded yet today."
          accentColor={colors.green600}
          onClose={() => setPopup(null)}
        />
      )}
      {popup === 'leave' && attendance?.onLeave && (
        <MemberListPopup
          title="On Leave Today"
          members={attendance.onLeave.map((m) => ({ ...m, role: m.leaveType || 'Approved Leave' }))}
          emptyText="Nobody is on leave today."
          accentColor={colors.gray400}
          onClose={() => setPopup(null)}
        />
      )}
      {popup === 'absent' && attendance?.absent && (
        <MemberListPopup
          title="Absent Today"
          members={attendance.absent}
          emptyText="No absences recorded today."
          accentColor={colors.red600}
          onClose={() => setPopup(null)}
        />
      )}
      {popup === 'late' && attendance?.late && (
        <MemberListPopup
          title="Late Today"
          members={attendance.late.map((m) => ({ ...m, role: m.checkInTime ? `Checked in at ${m.checkInTime} (${m.minutesLate} min late)` : undefined }))}
          emptyText="No late arrivals today. 🎉"
          accentColor={colors.amber600}
          onClose={() => setPopup(null)}
        />
      )}
    </div>
  );
}
