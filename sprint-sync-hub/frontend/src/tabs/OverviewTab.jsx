import React, { useState, useEffect } from 'react';
import { theme, styles } from '../theme.js';
import { getSlackMessages, getJiraIssues, getSyncLog } from '../api.js';
import { API_BASE } from '../config.js';
import Card, { SectionHeader } from '../components/Card.jsx';
import Badge from '../components/Badge.jsx';
import Toggle from '../components/Toggle.jsx';
import Spinner from '../components/Spinner.jsx';

const { colors, fonts } = theme;

const AUTOMATIONS = [
  { name: 'Huddle Sync',      desc: 'Matches Slack standup messages to Jira tasks every 30 min, Mon–Fri 8am–8pm.' },
  { name: 'Deadline Check',   desc: 'DMs assignees of tasks due today. Runs at 9:00 am daily.' },
  { name: 'End-of-Day Check', desc: 'DMs members with no standup update. Runs Mon–Fri at the configured EOD time.' },
  { name: 'Weekly Report',    desc: 'Posts AI sprint summary to the Slack channel. Runs on the configured report day.' },
];

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
              <td style={{ padding: '10px 12px', fontSize: 13, color: colors.gray600, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
  const [enabled,     setEnabled]     = useState([true, true, true, true]);
  const [perfDash,    setPerfDash]    = useState(null);
  const [popup,       setPopup]       = useState(null); // 'posted' | 'missing' | 'tasks' | 'present' | 'leave' | 'late' | null
  const [attendance,  setAttendance]  = useState(null); // Zoho data

  useEffect(() => {
    Promise.all([
      getSlackMessages(30).catch(() => ({ messages: [] })),
      getJiraIssues().catch(() => ({ issues: [] })),
      getSyncLog(50).catch(() => ({ entries: [] })),
      fetch(`${API_BASE}/api/performance/dashboard`).then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch(`${API_BASE}/api/attendance/today`).then((r) => r.ok ? r.json() : null).catch(() => null),
    ]).then(([msgData, issData, logData, perf, att]) => {
      setMessages(msgData.messages || []);
      setIssues(issData.issues || []);
      setLog(logData.entries || []);
      setPerfDash(perf);
      setAttendance(att);
    }).finally(() => setLoading(false));
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

      {/* Attendance row (Zoho) — only shown when Zoho is configured */}
      {attendance?.configured && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: colors.gray400, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            Attendance Today
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            {[
              { id: 'present', label: 'Present',   value: attendance.summary?.present  ?? 0, tint: colors.tintGreen,  members: attendance.present  || [] },
              { id: 'leave',   label: 'On Leave',  value: attendance.summary?.onLeave  ?? 0, tint: { bg: colors.gray50, border: colors.gray200, text: colors.gray500 }, members: attendance.onLeave || [] },
              { id: 'absent',  label: 'Absent',    value: attendance.summary?.absent   ?? 0, tint: colors.tintRed,    members: attendance.absent   || [] },
              { id: 'late',    label: 'Late Today', value: attendance.summary?.late    ?? 0, tint: colors.tintAmber,  members: attendance.late     || [] },
            ].map((m) => (
              <MetricCard
                key={m.id}
                label={m.label}
                value={m.value}
                loading={loading}
                tint={m.tint}
                onClick={!loading ? () => setPopup(m.id) : undefined}
              />
            ))}
          </div>
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
      <Card style={{ marginBottom: 0 }}>
        <SectionHeader>Automations</SectionHeader>
        <div>
          {AUTOMATIONS.map((a, i) => (
            <React.Fragment key={a.name}>
              {i > 0 && <div style={styles.divider} />}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
                <div>
                  <div style={{ fontSize: 14, color: colors.gray900, fontWeight: 400 }}>{a.name}</div>
                  <div style={{ fontSize: 12, color: colors.gray400, marginTop: 2 }}>{a.desc}</div>
                </div>
                <Toggle checked={enabled[i]} onChange={(v) => setEnabled((p) => p.map((x, j) => j === i ? v : x))} />
              </div>
            </React.Fragment>
          ))}
        </div>
      </Card>

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
