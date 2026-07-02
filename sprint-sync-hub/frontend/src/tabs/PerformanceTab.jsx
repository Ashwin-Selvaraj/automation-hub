import React, { useState, useEffect, useCallback, useRef } from 'react';
import { theme } from '../theme.js';
import { API_BASE, apiHeaders } from '../config.js';
import Spinner from '../components/Spinner.jsx';
import Badge   from '../components/Badge.jsx';

const { colors, fonts } = theme;

// ─── API ──────────────────────────────────────────────────────────────────────

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: apiHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiPost(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: apiHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Scoring helpers (mirrors backend) ───────────────────────────────────────

function scoreColor(score) {
  const n = parseFloat(score ?? 0);
  if (n >= 75) return colors.green600;
  if (n >= 50) return colors.amber600;
  return colors.red600;
}

function scoreBg(score) {
  const n = parseFloat(score ?? 0);
  if (n >= 75) return colors.green50;
  if (n >= 50) return colors.amber50;
  return colors.red50;
}

function getLabel(score) {
  const n = parseFloat(score ?? 0);
  if (n >= 90) return 'Excellent';
  if (n >= 75) return 'Strong';
  if (n >= 60) return 'On Track';
  if (n >= 45) return 'Needs Attention';
  return 'At Risk';
}

function getLabelVariant(score) {
  const n = parseFloat(score ?? 0);
  if (n >= 75) return 'success';
  if (n >= 50) return 'warning';
  return 'error';
}

function getRisk(s) {
  if (!s) return 'low';
  const r = parseFloat(s.standup_days_expected) > 0
    ? parseFloat(s.standup_days_posted) / parseFloat(s.standup_days_expected) : 1;
  const score = parseFloat(s.performance_score ?? 0);
  if (score < 40 || parseInt(s.deadlines_missed) >= 2 || r < 0.4) return 'high';
  if (score < 60 || parseInt(s.deadlines_missed) >= 1 || r < 0.6) return 'medium';
  return 'low';
}

function riskColor(level) {
  if (level === 'high')   return colors.red600;
  if (level === 'medium') return colors.amber600;
  return colors.green600;
}
function riskBg(level) {
  if (level === 'high')   return colors.red50;
  if (level === 'medium') return colors.amber50;
  return colors.green50;
}

function pct(a, b) {
  if (!b || parseFloat(b) === 0) return 100;
  return Math.round((parseFloat(a) / parseFloat(b)) * 100);
}

function initials(name) {
  if (!name) return '?';
  return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7)   return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(dateStr).getDay()];
  return new Date(dateStr).toLocaleDateString();
}

function notifLabel(type) {
  const m = {
    no_match_dm:         'No-match DM sent',
    deadline_reminder:   'Deadline reminder',
    missing_standup:     'Missing standup DM',
    weekly_report:       'Weekly report posted',
    deadline_overdue_3d: 'Escalation: 3+ days overdue',
  };
  return m[type] || type;
}

// ─── Atom components ─────────────────────────────────────────────────────────

function Avatar({ name, size = 40 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: colors.blue50, color: colors.blue600,
      fontSize: size * 0.36, fontWeight: 700, fontFamily: fonts.body,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, letterSpacing: '-0.5px',
      border: `2px solid ${colors.gray200}`,
    }}>
      {initials(name)}
    </div>
  );
}

function ScoreRing({ score, size = 64 }) {
  const n   = parseFloat(score ?? 0);
  const r   = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * (n / 100);
  const col  = scoreColor(n);
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={colors.gray100} strokeWidth={7} />
      <circle
        cx={size/2} cy={size/2} r={r} fill="none"
        stroke={col} strokeWidth={7}
        strokeDasharray={`${dash} ${circ - dash}`}
        strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.5s ease' }}
      />
    </svg>
  );
}

function StatBar({ label, value, total, color }) {
  const p = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 4, fontSize: 11, fontFamily: fonts.body,
      }}>
        <span style={{ color: colors.gray400, fontWeight: 500 }}>{label}</span>
        <span style={{ color: colors.gray700, fontWeight: 600 }}>{value} / {total}</span>
      </div>
      <div style={{ height: 4, borderRadius: 99, background: colors.gray100, overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: 99,
          width: `${p}%`, background: color || colors.blue600,
          transition: 'width 0.4s ease',
        }} />
      </div>
    </div>
  );
}

function TrendChip({ trend }) {
  if (!trend || trend === 'stable') return (
    <span style={{ fontSize: 11, color: colors.gray400, fontWeight: 500 }}>→ Stable</span>
  );
  if (trend === 'improving') return (
    <span style={{ fontSize: 11, color: colors.green600, fontWeight: 700 }}>↑ Improving</span>
  );
  return (
    <span style={{ fontSize: 11, color: colors.red600, fontWeight: 700 }}>↓ Declining</span>
  );
}

function SectionLabel({ children, danger = false }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700,
      color: danger ? colors.red600 : colors.gray400,
      textTransform: 'uppercase', letterSpacing: '0.07em',
      marginBottom: 10, fontFamily: fonts.body,
    }}>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: colors.gray100, margin: '16px 0' }} />;
}

// ─── Team-level hero numbers ──────────────────────────────────────────────────

function TeamHero({ stats, loading }) {
  const items = [
    { label: 'Avg Score',       value: stats ? `${stats.avgScore}` : null,         sub: 'out of 100' },
    { label: 'Completion Rate', value: stats ? `${stats.avgCompletion}%` : null,    sub: 'tasks done' },
    { label: 'Deadline Rate',   value: stats ? `${stats.avgDeadlineRate}%` : null,  sub: 'on time'    },
    { label: 'Standup Rate',    value: stats ? `${stats.avgStandupRate}%` : null,   sub: 'attendance' },
  ];

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1,
      border: `1px solid ${colors.gray200}`, borderRadius: 10, overflow: 'hidden',
      background: colors.gray200, marginBottom: 28,
    }}>
      {items.map(({ label, value, sub }) => (
        <div key={label} style={{
          background: colors.white, padding: '18px 20px',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          <span style={{ fontSize: 11, color: colors.gray400, fontWeight: 500, fontFamily: fonts.body, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {label}
          </span>
          <span style={{ fontSize: 28, fontWeight: 800, color: colors.blue600, fontFamily: fonts.body, lineHeight: 1.1 }}>
            {loading ? <Spinner size={20} /> : (value ?? '—')}
          </span>
          <span style={{ fontSize: 11, color: colors.gray400, fontFamily: fonts.body }}>{sub}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Member score card ────────────────────────────────────────────────────────

function MemberCard({ row, rank, onClick }) {
  const [hovered, setHovered] = useState(false);
  const score        = parseFloat(row.performance_score ?? 0);
  const standupRate  = pct(row.standup_days_posted, row.standup_days_expected);
  const taskRate     = pct(row.tasks_completed, row.tasks_assigned);
  const deadlineRate = row.deadlines_total > 0
    ? pct(row.deadlines_hit, row.deadlines_total) : null;
  const risk = getRisk(row);

  return (
    <div
      onClick={() => onClick(row.member_id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: colors.white,
        border: `1px solid ${hovered ? colors.blue600 : colors.gray200}`,
        borderRadius: 12, padding: '20px 20px 18px',
        cursor: 'pointer',
        boxShadow: hovered
          ? '0 4px 16px rgba(13,33,102,0.10)'
          : '0 1px 4px rgba(0,0,0,0.05)',
        transition: 'all 0.15s ease',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Rank badge */}
      <div style={{
        position: 'absolute', top: 14, right: 14,
        fontSize: 10, fontWeight: 700, color: colors.gray400, fontFamily: fonts.body,
      }}>
        #{rank}
      </div>

      {/* Top row: avatar + score ring */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar name={row.name} size={40} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: colors.gray900, fontFamily: fonts.body }}>
              {row.name}
            </div>
            <div style={{ fontSize: 11, color: colors.gray400, fontFamily: fonts.body, marginTop: 1 }}>
              {row.role || 'Team Member'}
            </div>
          </div>
        </div>

        {/* Score ring with number overlay */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <ScoreRing score={score} size={60} />
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 0,
          }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: scoreColor(score), fontFamily: fonts.body, lineHeight: 1 }}>
              {Math.round(score)}
            </span>
          </div>
        </div>
      </div>

      {/* Performance label + risk */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
        <Badge variant={getLabelVariant(score)} style={{ fontSize: 11 }}>
          {getLabel(score)}
        </Badge>
        {risk !== 'low' && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 99,
            background: riskBg(risk), color: riskColor(risk), fontFamily: fonts.body,
            textTransform: 'capitalize',
          }}>
            {risk === 'high' ? '⚠ High Risk' : '⚡ Medium Risk'}
          </span>
        )}
      </div>

      {/* Stat bars */}
      <StatBar
        label="Standups"
        value={parseInt(row.standup_days_posted) || 0}
        total={parseInt(row.standup_days_expected) || 0}
        color={standupRate >= 80 ? colors.green600 : standupRate >= 60 ? colors.amber600 : colors.red600}
      />
      <StatBar
        label="Tasks"
        value={parseInt(row.tasks_completed) || 0}
        total={parseInt(row.tasks_assigned) || 0}
        color={taskRate >= 80 ? colors.green600 : taskRate >= 50 ? colors.amber600 : colors.red600}
      />
      {row.deadlines_total > 0 && (
        <StatBar
          label="Deadlines"
          value={parseInt(row.deadlines_hit) || 0}
          total={parseInt(row.deadlines_total) || 0}
          color={deadlineRate >= 80 ? colors.green600 : deadlineRate >= 60 ? colors.amber600 : colors.red600}
        />
      )}

      {/* Footer: streak + trend */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginTop: 12, paddingTop: 10, borderTop: `1px solid ${colors.gray100}`,
      }}>
        <span style={{ fontSize: 11, color: colors.gray400, fontFamily: fonts.body }}>
          🔥 <strong style={{ color: colors.gray700 }}>{row.standup_streak_current || 0}</strong> day streak
        </span>
        <TrendChip trend={row.trend} />
      </div>
    </div>
  );
}

// ─── Leaderboard table ────────────────────────────────────────────────────────

function LeaderboardTable({ rows, onMemberClick, expandedId, setExpandedId }) {
  return (
    <div style={{
      border: `1px solid ${colors.gray200}`, borderRadius: 10, overflow: 'hidden',
    }}>
      {/* Head */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '44px 1fr 100px 80px 80px 80px 70px 56px 60px',
        padding: '9px 16px',
        background: colors.gray50,
        borderBottom: `1px solid ${colors.gray200}`,
        fontSize: 10, fontWeight: 700, color: colors.gray400,
        textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: fonts.body,
      }}>
        <span>#</span>
        <span>Member</span>
        <span>Score</span>
        <span>Standups</span>
        <span>Tasks</span>
        <span>Deadlines</span>
        <span>Mismatches</span>
        <span>Streak</span>
        <span>Trend</span>
      </div>

      {rows.length === 0 && (
        <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: 13, color: colors.gray400, fontFamily: fonts.body }}>
          No data yet — click <strong>Compute Scores</strong> above to generate scores.
        </div>
      )}

      {rows.map((row, i) => (
        <React.Fragment key={row.member_id}>
          <TableRow
            row={row} rank={i + 1}
            expanded={expandedId === row.member_id}
            onToggle={() => setExpandedId(expandedId === row.member_id ? null : row.member_id)}
            onNameClick={() => onMemberClick(row.member_id)}
          />
          {expandedId === row.member_id && (
            <ExpandedRow memberId={row.member_id} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function TableRow({ row, rank, expanded, onToggle, onNameClick }) {
  const [hovered, setHovered] = useState(false);
  const score = parseFloat(row.performance_score ?? 0);
  const deadlineCell = row.deadlines_total > 0
    ? row.deadlines_missed > 0
      ? <span style={{ color: colors.red600, fontWeight: 600 }}>{row.deadlines_missed} missed</span>
      : <span style={{ color: colors.green600, fontWeight: 600 }}>{row.deadlines_hit}/{row.deadlines_total}</span>
    : <span style={{ color: colors.gray300 }}>—</span>;

  return (
    <div
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: '44px 1fr 100px 80px 80px 80px 70px 56px 60px',
        padding: '11px 16px', alignItems: 'center',
        borderBottom: `1px solid ${colors.gray100}`,
        background: expanded ? colors.blue50 : hovered ? colors.gray50 : colors.white,
        cursor: 'pointer', transition: 'background 0.1s',
        fontSize: 13, fontFamily: fonts.body,
      }}
    >
      {/* Rank */}
      <span style={{ fontWeight: 700, color: rank <= 3 ? colors.blue600 : colors.gray300, fontSize: 12 }}>
        {rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`}
      </span>

      {/* Member */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Avatar name={row.name} size={30} />
        <div>
          <button
            onClick={(e) => { e.stopPropagation(); onNameClick(); }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              fontSize: 13, fontWeight: 600, color: colors.gray900, fontFamily: fonts.body,
              textDecoration: 'underline', textDecorationColor: 'transparent',
            }}
            onMouseEnter={(e) => e.currentTarget.style.textDecorationColor = colors.blue600}
            onMouseLeave={(e) => e.currentTarget.style.textDecorationColor = 'transparent'}
          >
            {row.name}
          </button>
          <div style={{ fontSize: 10, color: colors.gray400 }}>{row.role || ''}</div>
        </div>
      </div>

      {/* Score */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 18, fontWeight: 800, color: scoreColor(score) }}>
          {Math.round(score)}
        </span>
        <Badge variant={getLabelVariant(score)} style={{ fontSize: 10, padding: '1px 6px' }}>
          {getLabel(score)}
        </Badge>
      </div>

      {/* Standups */}
      <span style={{ color: colors.gray700 }}>
        {row.standup_days_posted ?? '0'} / {row.standup_days_expected ?? '0'}
      </span>

      {/* Tasks */}
      <span style={{ color: colors.gray700 }}>
        {row.tasks_completed ?? '0'} / {row.tasks_assigned ?? '0'}
      </span>

      {/* Deadlines */}
      {deadlineCell}

      {/* Mismatches */}
      {(() => {
        const n = row.mismatch_count ?? 0;
        const color = n === 0 ? colors.gray300 : n === 1 ? colors.amber600 : colors.red600;
        return <span style={{ fontWeight: n > 0 ? 700 : 400, color }}>{n}</span>;
      })()}

      {/* Streak */}
      <span style={{ color: colors.gray700 }}>
        {row.standup_streak_current || 0}d
      </span>

      {/* Trend */}
      <TrendChip trend={row.trend} />
    </div>
  );
}

function ExpandedRow({ memberId }) {
  const [history, setHistory] = useState(null);

  useEffect(() => {
    apiFetch(`/api/performance/member/${memberId}/history?limit=3`)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [memberId]);

  return (
    <div style={{
      padding: '14px 16px 16px 70px',
      background: `linear-gradient(to bottom, ${colors.blue50}, ${colors.white})`,
      borderBottom: `1px solid ${colors.gray200}`,
    }}>
      <SectionLabel>Sprint History</SectionLabel>
      {!history ? (
        <Spinner size={16} />
      ) : history.length === 0 ? (
        <span style={{ fontSize: 12, color: colors.gray400, fontFamily: fonts.body }}>No history yet.</span>
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10,
        }}>
          {history.slice(0, 3).map((h, i) => {
            const sp = pct(h.standup_days_posted, h.standup_days_expected);
            const cp = Math.round(parseFloat(h.completion_rate || 0));
            const sc = parseFloat(h.performance_score || 0);
            return (
              <div key={i} style={{
                background: colors.white, border: `1px solid ${colors.gray200}`,
                borderRadius: 8, padding: '10px 14px',
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: colors.gray400, fontFamily: fonts.body, marginBottom: 6 }}>
                  {h.sprint_name}
                </div>
                <div style={{ fontSize: 20, fontWeight: 800, color: scoreColor(sc), fontFamily: fonts.body }}>
                  {Math.round(sc)}
                </div>
                <div style={{ fontSize: 11, color: colors.gray400, marginTop: 4, fontFamily: fonts.body }}>
                  Standup {sp}% · Done {cp}%
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Member profile drawer ────────────────────────────────────────────────────

function MemberDrawer({ memberId, onClose }) {
  const [profile,         setProfile]         = useState(null);
  const [loading,         setLoading]         = useState(true);
  const [error,           setError]           = useState(null);
  const [checkoutHistory, setCheckoutHistory] = useState(null);
  const [mismatchHistory, setMismatchHistory] = useState(null);

  useEffect(() => {
    if (!memberId) return;
    setLoading(true); setError(null);
    Promise.all([
      apiFetch(`/api/performance/member/${memberId}`),
      fetch(`${API_BASE}/api/checkout/history?memberId=${memberId}&days=30`, { headers: apiHeaders() })
        .then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch(`${API_BASE}/api/mismatch/member/${memberId}`, { headers: apiHeaders() })
        .then((r) => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([prof, hist, mismatch]) => { setProfile(prof); setCheckoutHistory(hist); setMismatchHistory(mismatch); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [memberId]);

  useEffect(() => {
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [onClose]);

  const m = profile;
  const s = m?.currentSummary;
  const score = parseFloat(s?.performance_score ?? 0);

  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
        zIndex: 200, backdropFilter: 'blur(2px)',
      }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 420,
        background: colors.white, zIndex: 201,
        boxShadow: '-8px 0 40px rgba(0,0,0,0.14)',
        display: 'flex', flexDirection: 'column', overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 24px 18px',
          borderBottom: `1px solid ${colors.gray100}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: colors.gray50,
          flexShrink: 0,
        }}>
          {loading ? (
            <Spinner size={20} />
          ) : m ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <Avatar name={m.member?.name} size={48} />
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, color: colors.gray900, fontFamily: fonts.body }}>
                  {m.member?.name}
                </div>
                <div style={{ fontSize: 12, color: colors.gray400, fontFamily: fonts.body, marginTop: 2 }}>
                  {m.member?.role || 'Team Member'}
                  {m.member?.email && ` · ${m.member.email}`}
                </div>
              </div>
            </div>
          ) : <span />}
          <button onClick={onClose} style={{
            background: colors.gray100, border: 'none', borderRadius: '50%',
            width: 28, height: 28, cursor: 'pointer', fontSize: 16,
            color: colors.gray600, display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>×</button>
        </div>

        {error && (
          <div style={{ padding: 24, color: colors.red600, fontSize: 13, fontFamily: fonts.body }}>
            Error: {error}
          </div>
        )}

        {!loading && m && (
          <div style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 0 }}>

            {/* Score hero */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 20,
              padding: '18px 20px', background: scoreBg(score),
              border: `1px solid ${scoreColor(score)}22`,
              borderRadius: 10, marginBottom: 20,
            }}>
              <ScoreRing score={score} size={72} />
              <div>
                <div style={{ fontSize: 42, fontWeight: 900, color: scoreColor(score), fontFamily: fonts.body, lineHeight: 1 }}>
                  {Math.round(score)}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: scoreColor(score), fontFamily: fonts.body, marginTop: 3 }}>
                  {getLabel(score)}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
                    background: riskBg(getRisk(s)), color: riskColor(getRisk(s)), fontFamily: fonts.body,
                    textTransform: 'capitalize',
                  }}>{getRisk(s)} risk</span>
                  <TrendChip trend={m.trend} />
                </div>
              </div>
            </div>

            {/* Sprint stats */}
            {s ? (
              <>
                <SectionLabel>This Sprint</SectionLabel>

                <StatBar label="Standup Attendance"
                  value={parseInt(s.standup_days_posted) || 0}
                  total={parseInt(s.standup_days_expected) || 0}
                  color={colors.blue600} />
                <StatBar label="Task Completion"
                  value={parseInt(s.tasks_completed) || 0}
                  total={parseInt(s.tasks_assigned) || 0}
                  color={colors.green600} />
                {s.deadlines_total > 0 && (
                  <StatBar label="Deadlines Hit"
                    value={parseInt(s.deadlines_hit) || 0}
                    total={parseInt(s.deadlines_total) || 0}
                    color={colors.amber600} />
                )}

                <Divider />

                {/* Key numbers grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 18 }}>
                  {[
                    ['Jira Auto-Updates', s.jira_auto_updates ?? 0],
                    ['No-Match DMs',      s.no_match_dms_received ?? 0],
                    ['Tasks In Progress', s.tasks_in_progress ?? 0],
                    ['Avg Days Overdue',  parseFloat(s.avg_days_overdue ?? 0).toFixed(1)],
                  ].map(([label, val]) => (
                    <div key={label} style={{
                      background: colors.gray50, border: `1px solid ${colors.gray100}`,
                      borderRadius: 8, padding: '10px 14px',
                    }}>
                      <div style={{ fontSize: 10, color: colors.gray400, fontFamily: fonts.body, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: colors.gray900, fontFamily: fonts.body, marginTop: 4 }}>{val}</div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, color: colors.gray400, fontFamily: fonts.body, marginBottom: 18 }}>
                No sprint summary computed yet.
              </div>
            )}

            {/* Streak */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '10px 16px', background: colors.amber50,
              border: `1px solid ${colors.tintAmber.border}`,
              borderRadius: 8, marginBottom: 18,
            }}>
              <span style={{ fontSize: 20 }}>🔥</span>
              <span style={{ fontSize: 13, fontFamily: fonts.body, color: colors.gray700 }}>
                <strong>{s?.standup_streak_current ?? m.overallStats?.current_standup_streak ?? 0}</strong> day current streak
                {' · '}
                Best ever: <strong>{s?.standup_streak_max ?? m.overallStats?.longest_ever_streak ?? 0}</strong> days
              </span>
            </div>

            {/* Attendance (from Zoho) */}
            {s && (s.days_present > 0 || s.days_on_leave > 0 || s.days_absent > 0 || s.late_arrivals > 0) && (
              <>
                <Divider />
                <SectionLabel>Attendance This Sprint</SectionLabel>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 14 }}>
                  {[
                    ['Days Present',   s.days_present   ?? 0, colors.green600,  colors.green50],
                    ['On Leave',       s.days_on_leave  ?? 0, colors.gray400,   colors.gray50],
                    ['Absent',         s.days_absent    ?? 0, colors.red600,    colors.red50],
                    ['Late Arrivals',  s.late_arrivals  ?? 0, colors.amber600,  colors.amber50],
                  ].map(([label, val, color, bg]) => (
                    <div key={label} style={{
                      background: bg, border: `1px solid ${color}22`,
                      borderRadius: 8, padding: '10px 14px',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}>
                      <div style={{ fontSize: 11, color: colors.gray500, fontFamily: fonts.body, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color, fontFamily: fonts.body }}>{val}</div>
                    </div>
                  ))}
                </div>
                <div style={{
                  display: 'flex', gap: 16, alignItems: 'center',
                  padding: '10px 14px', background: colors.gray50,
                  border: `1px solid ${colors.gray100}`, borderRadius: 8, marginBottom: 18,
                  fontSize: 12, fontFamily: fonts.body, color: colors.gray600,
                }}>
                  {s.avg_checkin_time && (
                    <span>⏰ Avg check-in: <strong>{s.avg_checkin_time}</strong></span>
                  )}
                  {s.attendance_rate != null && (
                    <span>📊 Attendance rate: <strong style={{ color: parseFloat(s.attendance_rate) >= 90 ? colors.green600 : parseFloat(s.attendance_rate) >= 75 ? colors.amber600 : colors.red600 }}>{parseFloat(s.attendance_rate ?? 100).toFixed(0)}%</strong></span>
                  )}
                  {s.days_on_leave > 0 && (
                    <span style={{ color: colors.gray400 }}>({s.days_on_leave} day{s.days_on_leave !== 1 ? 's' : ''} leave excluded from standup score)</span>
                  )}
                </div>
              </>
            )}

            {/* Checkout vs Standup — Last 30 Days */}
            {checkoutHistory && checkoutHistory.history && checkoutHistory.history.length > 0 && (
              <>
                <Divider />
                <SectionLabel>Checkout vs Standup — Last 30 Days</SectionLabel>
                {/* Calendar grid: 6 cols × 5 rows = 30 days */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(6, 28px)',
                  gap: 4,
                  marginBottom: 12,
                }}>
                  {checkoutHistory.history.map((day) => {
                    let bg, symbol, title;
                    if (day.isWeekend) {
                      bg = 'transparent'; symbol = ''; title = day.date + ' (weekend)';
                    } else if (day.onLeave) {
                      bg = '#E0E7FF'; symbol = 'L'; title = day.date + ' — On leave';
                    } else if (day.absent) {
                      bg = '#F3F4F6'; symbol = '–'; title = day.date + ' — Absent';
                    } else if (day.checkedOut && day.postedStandup) {
                      bg = '#DCF7E8'; symbol = '✓'; title = day.date + ` — Checked out ${day.checkOutTime || ''}, standup posted`;
                    } else if (day.checkedOut && !day.postedStandup) {
                      bg = '#FEF3C7'; symbol = '!'; title = day.date + ` — Checked out ${day.checkOutTime || ''}, no standup`;
                    } else {
                      bg = '#DBEAFE'; symbol = '→'; title = day.date + ' — Still in / ongoing';
                    }
                    return (
                      <div
                        key={day.date}
                        title={title}
                        style={{
                          width: 28, height: 28, borderRadius: 4,
                          background: bg,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: day.isWeekend ? 0 : 11, fontWeight: 700,
                          color: day.onLeave ? '#4338CA' :
                                 day.absent  ? colors.gray400 :
                                 day.checkedOut && day.postedStandup ? '#065F46' :
                                 day.checkedOut ? '#92400E' : '#1E40AF',
                          cursor: 'default',
                          border: day.isWeekend ? 'none' : `1px solid ${bg === 'transparent' ? 'transparent' : bg + 'cc'}`,
                        }}
                      >
                        {symbol}
                      </div>
                    );
                  })}
                </div>
                {/* Legend summary */}
                <div style={{
                  display: 'flex', gap: 18, flexWrap: 'wrap',
                  fontSize: 11, color: colors.gray500, fontFamily: fonts.body, marginBottom: 18,
                }}>
                  <span><strong style={{ color: '#065F46' }}>{checkoutHistory.summary.checkoutWithStandup}</strong> checkout + standup</span>
                  <span><strong style={{ color: '#92400E' }}>{checkoutHistory.summary.checkoutWithoutStandup}</strong> checkout without standup</span>
                  <span><strong style={{ color: colors.gray400 }}>{checkoutHistory.summary.absent}</strong> absent</span>
                  {checkoutHistory.summary.onLeave > 0 && (
                    <span><strong style={{ color: '#4338CA' }}>{checkoutHistory.summary.onLeave}</strong> on leave</span>
                  )}
                </div>
              </>
            )}

            {/* ── Task Alignment ─────────────────────────────────────── */}
            {mismatchHistory && (
              <>
                <Divider />
                <SectionLabel>Task Alignment — {m?.currentSummary?.sprint_name || 'This Sprint'}</SectionLabel>
                {(() => {
                  const events    = mismatchHistory.events || [];
                  const matched   = (m?.currentSummary?.standup_days_posted || 0) - events.filter((e) => !e.resolved).length;
                  const mismatches = events.length;
                  return (
                    <>
                      <div style={{ display: 'flex', gap: 20, marginBottom: 12 }}>
                        <span style={{ fontSize: 13, fontFamily: fonts.body, color: colors.green600 }}>
                          ✓ <strong>{Math.max(0, matched)}</strong> standup messages matched
                        </span>
                        {mismatches > 0 && (
                          <span style={{ fontSize: 13, fontFamily: fonts.body, color: colors.amber600 }}>
                            ⚠ <strong>{mismatches}</strong> mismatch{mismatches !== 1 ? 'es' : ''} detected
                          </span>
                        )}
                      </div>
                      {events.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
                          {events.map((evt) => {
                            const dateLabel = evt.created_at
                              ? new Date(evt.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                              : '';
                            const desc = evt.mismatch_details || evt.match_type || 'Mismatch detected';
                            return (
                              <div key={evt.id} style={{
                                display: 'flex', alignItems: 'baseline', gap: 6,
                                fontSize: 12, fontFamily: fonts.body,
                                color: evt.resolved ? colors.gray300 : colors.amber600,
                                textDecoration: evt.resolved ? 'line-through' : 'none',
                              }}>
                                <span>└</span>
                                <span style={{ flex: 1 }}>{desc}</span>
                                {dateLabel && <span style={{ color: colors.gray400, textDecoration: 'none', flexShrink: 0 }}>{dateLabel}</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {events.length === 0 && (
                        <div style={{ fontSize: 12, color: colors.gray400, fontFamily: fonts.body, marginBottom: 14 }}>
                          No mismatches this sprint ✓
                        </div>
                      )}
                    </>
                  );
                })()}
              </>
            )}

            {/* Overall stats */}
            {m.overallStats && (
              <>
                <Divider />
                <SectionLabel>All-Time</SectionLabel>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 18 }}>
                  {[
                    ['Sprints',    m.overallStats.sprints_participated],
                    ['Tasks Done', m.overallStats.total_tasks_completed],
                    ['Avg Score',  Math.round(parseFloat(m.overallStats.avg_performance_score || 0))],
                    ['Deadlines ✓', m.overallStats.total_deadlines_hit],
                    ['Deadlines ✗', m.overallStats.total_deadlines_missed],
                    ['Standups',   m.overallStats.total_standup_posts],
                  ].map(([label, val]) => (
                    <div key={label} style={{
                      background: colors.gray50, border: `1px solid ${colors.gray100}`,
                      borderRadius: 8, padding: '10px 12px', textAlign: 'center',
                    }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: colors.blue600, fontFamily: fonts.body }}>{val ?? 0}</div>
                      <div style={{ fontSize: 10, color: colors.gray400, fontFamily: fonts.body, marginTop: 2 }}>{label}</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Sprint history */}
            {m.history && m.history.length > 0 && (
              <>
                <Divider />
                <SectionLabel>Sprint History (last 5)</SectionLabel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, borderRadius: 8, overflow: 'hidden', border: `1px solid ${colors.gray200}`, marginBottom: 18 }}>
                  {m.history.map((h, i) => {
                    const sc = parseFloat(h.performance_score || 0);
                    const sp = pct(h.standup_days_posted, h.standup_days_expected);
                    return (
                      <div key={i} style={{
                        display: 'grid', gridTemplateColumns: '1fr 56px 56px 56px',
                        padding: '9px 14px', alignItems: 'center', gap: 8,
                        background: i % 2 === 0 ? colors.white : colors.gray50,
                        fontSize: 12, fontFamily: fonts.body,
                        borderBottom: i < m.history.length - 1 ? `1px solid ${colors.gray100}` : 'none',
                      }}>
                        <span style={{ color: colors.gray700, fontWeight: 500 }}>{h.sprint_name}</span>
                        <span style={{ fontWeight: 700, color: scoreColor(sc), textAlign: 'right' }}>{Math.round(sc)}</span>
                        <span style={{ color: colors.gray600, textAlign: 'right' }}>{sp}% 🎙</span>
                        <span style={{ color: colors.gray600, textAlign: 'right' }}>{Math.round(parseFloat(h.completion_rate || 0))}% ✓</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* Recent activity */}
            {m.recentActivity && m.recentActivity.length > 0 && (
              <>
                <Divider />
                <SectionLabel>Recent Activity</SectionLabel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {m.recentActivity.slice(0, 10).map((a, i) => (
                    <div key={i} style={{
                      display: 'flex', gap: 10, alignItems: 'flex-start',
                      fontSize: 12, fontFamily: fonts.body,
                    }}>
                      <span style={{ color: colors.gray300, whiteSpace: 'nowrap', minWidth: 64 }}>
                        {timeAgo(a.sent_at)}
                      </span>
                      <span style={{ color: colors.gray600 }}>{notifLabel(a.type)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Activity feed ────────────────────────────────────────────────────────────

function ActivityFeed({ items, onMemberClick }) {
  if (!items || items.length === 0) return (
    <div style={{ fontSize: 13, color: colors.gray400, fontFamily: fonts.body, padding: '8px 0' }}>
      No activity recorded yet.
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {items.map((a, i) => (
        <div key={i} style={{
          display: 'flex', gap: 12, alignItems: 'center',
          padding: '8px 0',
          borderBottom: i < items.length - 1 ? `1px solid ${colors.gray100}` : 'none',
          fontSize: 13, fontFamily: fonts.body,
        }}>
          <span style={{ color: colors.gray300, whiteSpace: 'nowrap', minWidth: 72, fontSize: 12 }}>
            {timeAgo(a.sent_at)}
          </span>
          {a.member_name && (
            <button
              onClick={() => a.member_id && onMemberClick(a.member_id)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                fontSize: 13, fontWeight: 600, color: colors.blue600, fontFamily: fonts.body,
                whiteSpace: 'nowrap',
              }}
            >
              {a.member_name}
            </button>
          )}
          <span style={{ color: colors.gray600 }}>{notifLabel(a.type)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

export default function PerformanceTab() {
  const [dashboard, setDashboard]       = useState(null);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState(null);
  const [view, setView]                 = useState('cards');   // 'cards' | 'table'
  const [drawerMemberId, setDrawer]     = useState(null);
  const [tableExpanded, setTableExp]    = useState(null);
  const [computing, setComputing]       = useState(false);
  const [computeMsg, setComputeMsg]     = useState(null);
  const [mismatchStats, setMismatchStats] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    Promise.all([
      apiFetch('/api/performance/dashboard'),
      fetch(`${API_BASE}/api/mismatch/stats`, { headers: apiHeaders() }).then((r) => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([dash, mstats]) => { setDashboard(dash); setMismatchStats(mstats); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function computeScores() {
    setComputing(true); setComputeMsg(null);
    try {
      // get active sprint id from dashboard or leaderboard
      const sprintId = dashboard?.leaderboard?.[0]?.sprint_id;
      if (!sprintId) {
        // try fetching health to get sprint name, then just reload
        await apiPost('/api/performance/sprint/0/compute').catch(() => {});
      } else {
        await apiPost(`/api/performance/sprint/${sprintId}/compute`);
      }
      setComputeMsg('Scores recomputed!');
      await load();
    } catch (e) {
      setComputeMsg(`Error: ${e.message}`);
    } finally {
      setComputing(false);
      setTimeout(() => setComputeMsg(null), 3000);
    }
  }

  const { teamStats, leaderboard = [], atRisk = [], recentActivity = [] } = dashboard || {};

  // Build per-member mismatch count from stats
  const mismatchByMember = {};
  if (mismatchStats?.byMember) {
    for (const m of mismatchStats.byMember) mismatchByMember[m.memberId] = m.count;
  }

  // Enrich leaderboard rows with trend and mismatch count
  const enriched = leaderboard.map((row, i, arr) => ({
    ...row,
    trend:         row.trend || 'stable',
    mismatch_count: mismatchByMember[row.member_id] || 0,
  }));

  return (
    <div style={{ padding: '24px 0', maxWidth: 960, fontFamily: fonts.body }}>

      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: colors.blue600, margin: 0, fontFamily: fonts.body }}>
            Performance
          </h1>
          <p style={{ fontSize: 13, color: colors.gray400, margin: '4px 0 0', fontFamily: fonts.body }}>
            Scores built from standup attendance, task completion, and deadline tracking.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* View toggle */}
          <div style={{
            display: 'flex', border: `1px solid ${colors.gray200}`, borderRadius: 6, overflow: 'hidden',
          }}>
            {['cards', 'table'].map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{
                  padding: '6px 14px', fontSize: 12, fontWeight: 600,
                  fontFamily: fonts.body, cursor: 'pointer', border: 'none',
                  background: view === v ? colors.blue600 : colors.white,
                  color: view === v ? colors.white : colors.gray600,
                  transition: 'all 0.15s',
                  textTransform: 'capitalize',
                }}
              >
                {v === 'cards' ? '⊞ Cards' : '≡ Table'}
              </button>
            ))}
          </div>

          {/* Compute button */}
          <button
            onClick={computeScores}
            disabled={computing}
            style={{
              padding: '7px 16px', fontSize: 12, fontWeight: 700,
              fontFamily: fonts.body, cursor: computing ? 'default' : 'pointer',
              background: computing ? colors.gray100 : colors.blue600,
              color: computing ? colors.gray400 : colors.white,
              border: 'none', borderRadius: 6,
              display: 'flex', alignItems: 'center', gap: 6,
              transition: 'all 0.15s',
            }}
          >
            {computing ? <Spinner size={12} /> : '⟳'}
            {computing ? 'Computing…' : 'Compute Scores'}
          </button>

          {/* Refresh */}
          <button
            onClick={load}
            style={{
              padding: '7px 12px', fontSize: 12, fontWeight: 600,
              fontFamily: fonts.body, cursor: 'pointer',
              background: colors.white, color: colors.gray600,
              border: `1px solid ${colors.gray200}`, borderRadius: 6,
            }}
          >
            ↻
          </button>
        </div>
      </div>

      {/* Compute feedback */}
      {computeMsg && (
        <div style={{
          padding: '10px 16px', borderRadius: 8, marginBottom: 16, fontSize: 13,
          background: computeMsg.startsWith('Error') ? colors.red50 : colors.green50,
          color: computeMsg.startsWith('Error') ? colors.red600 : colors.green600,
          border: `1px solid ${computeMsg.startsWith('Error') ? colors.tintRed.border : colors.tintGreen.border}`,
          fontFamily: fonts.body,
        }}>
          {computeMsg}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{
          padding: '12px 16px', background: colors.red50, borderRadius: 8, fontSize: 13,
          color: colors.red600, border: `1px solid ${colors.tintRed.border}`,
          marginBottom: 20, fontFamily: fonts.body,
        }}>
          {error} —{' '}
          <button onClick={load} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.blue600, fontWeight: 700 }}>
            Retry
          </button>
        </div>
      )}

      {/* Full-page loading */}
      {loading && !dashboard && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
          <Spinner size={36} />
        </div>
      )}

      {dashboard && (
        <>
          {/* Team hero */}
          <TeamHero stats={teamStats} loading={loading} />

          {/* At-risk banner */}
          {atRisk.length > 0 && (
            <div style={{
              marginBottom: 24, padding: '14px 18px',
              background: colors.red50, border: `1px solid ${colors.tintRed.border}`,
              borderRadius: 10,
            }}>
              <SectionLabel danger>At Risk ({atRisk.length})</SectionLabel>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {atRisk.map((m) => (
                  <button
                    key={m.member_id}
                    onClick={() => setDrawer(m.member_id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 12px', background: colors.white,
                      border: `1px solid ${colors.tintRed.border}`, borderRadius: 99,
                      cursor: 'pointer', fontSize: 12, fontFamily: fonts.body,
                      color: colors.gray900,
                    }}
                  >
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: riskColor(m.riskLevel || 'high'),
                      display: 'inline-block', flexShrink: 0,
                    }} />
                    <span style={{ fontWeight: 600 }}>{m.name}</span>
                    <span style={{ color: colors.red600, fontSize: 11 }}>{m.riskReason}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Card grid or table */}
          {view === 'cards' ? (
            enriched.length === 0 ? (
              <div style={{
                textAlign: 'center', padding: '48px 24px',
                background: colors.gray50, border: `1px solid ${colors.gray200}`,
                borderRadius: 12, fontSize: 14, color: colors.gray400, fontFamily: fonts.body,
              }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>📊</div>
                No performance data yet.<br />
                <strong style={{ color: colors.gray600 }}>Click "Compute Scores"</strong> to analyse the current sprint.
              </div>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                gap: 16, marginBottom: 28,
              }}>
                {enriched.map((row, i) => (
                  <MemberCard key={row.member_id} row={row} rank={i + 1} onClick={setDrawer} />
                ))}
              </div>
            )
          ) : (
            <div style={{ marginBottom: 28 }}>
              <LeaderboardTable
                rows={enriched}
                onMemberClick={setDrawer}
                expandedId={tableExpanded}
                setExpandedId={setTableExp}
              />
            </div>
          )}

          {/* Activity feed */}
          <div style={{
            border: `1px solid ${colors.gray200}`, borderRadius: 10,
            padding: '18px 20px',
          }}>
            <div style={{
              fontSize: 10, fontWeight: 700, color: colors.gray400,
              textTransform: 'uppercase', letterSpacing: '0.07em',
              marginBottom: 14, fontFamily: fonts.body,
            }}>
              Activity Feed
            </div>
            <ActivityFeed items={recentActivity} onMemberClick={setDrawer} />
          </div>
        </>
      )}

      {/* Member drawer */}
      {drawerMemberId && (
        <MemberDrawer memberId={drawerMemberId} onClose={() => setDrawer(null)} />
      )}
    </div>
  );
}
