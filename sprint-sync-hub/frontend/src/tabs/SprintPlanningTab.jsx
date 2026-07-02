import React, { useState } from 'react';
import { theme, styles } from '../theme.js';
import { API_BASE, apiHeaders } from '../config.js';

const { colors, fonts, radius, shadows } = theme;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function api(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    ...opts,
  }).then(async (r) => {
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  });
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function twoWeeksLater() {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString().split('T')[0];
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PRIORITY_STYLE = {
  Highest: { bg: '#FEF2F2', text: '#DC2626', border: '#FECACA' },
  High:    { bg: '#FFF7ED', text: '#C2410C', border: '#FDBA74' },
  Medium:  { bg: '#F9FAFB', text: '#374151', border: '#E5E7EB' },
  Low:     { bg: '#F9FAFB', text: '#9CA3AF', border: '#E5E7EB' },
};

const DOMAIN_STYLE = {
  backend:    { bg: '#EFF6FF', text: '#2563EB', border: '#BFDBFE', label: 'Backend' },
  frontend:   { bg: '#F0FDF4', text: '#16A34A', border: '#BBF7D0', label: 'Frontend' },
  ai:         { bg: '#FFFBEB', text: '#D97706', border: '#FDE68A', label: 'AI' },
  blockchain: { bg: '#F0FDFA', text: '#0D9488', border: '#99F6E4', label: 'Blockchain' },
  design:     { bg: '#FDF4FF', text: '#9333EA', border: '#E9D5FF', label: 'Design' },
  fullstack:  { bg: '#F5F3FF', text: '#7C3AED', border: '#DDD6FE', label: 'Full Stack' },
  general:    { bg: '#F9FAFB', text: '#6B7280', border: '#E5E7EB', label: 'General' },
};

// Which role slugs are eligible per domain
const DOMAIN_SLUGS = {
  backend:    ['backend_developer', 'full_stack_developer'],
  frontend:   ['frontend_developer', 'full_stack_developer'],
  ai:         ['ai_engineer'],
  blockchain: ['blockchain_developer'],
  design:     ['ui_ux_designer'],
  fullstack:  ['full_stack_developer', 'backend_developer', 'frontend_developer'],
  general:    null, // all assignable
};

function isEligibleForDomain(member, domain) {
  const slugs = DOMAIN_SLUGS[domain] ?? null;
  if (slugs === null) return true;
  return (member.roleSlugs || []).some((s) => slugs.includes(s));
}

// ─── Small UI primitives ──────────────────────────────────────────────────────

function PriorityBadge({ priority }) {
  const s = PRIORITY_STYLE[priority] || PRIORITY_STYLE.Medium;
  return (
    <span style={{
      display: 'inline-block', fontSize: 11, fontWeight: 600, fontFamily: fonts.body,
      padding: '2px 8px', borderRadius: 100,
      background: s.bg, color: s.text, border: `1px solid ${s.border}`,
    }}>
      {priority}
    </span>
  );
}

function DomainBadge({ domain }) {
  const s = DOMAIN_STYLE[domain] || DOMAIN_STYLE.general;
  return (
    <span style={{
      display: 'inline-block', fontSize: 11, fontWeight: 600, fontFamily: fonts.body,
      padding: '2px 8px', borderRadius: 100,
      background: s.bg, color: s.text, border: `1px solid ${s.border}`,
    }}>
      {s.label}
    </span>
  );
}

function Tag({ label }) {
  return (
    <span style={{
      display: 'inline-block', fontSize: 11, fontFamily: fonts.mono,
      padding: '2px 7px', borderRadius: 4,
      background: colors.blue50, color: colors.blue600,
      border: `1px solid ${colors.tintBlue.border}`,
    }}>
      {label}
    </span>
  );
}

function Btn({ children, onClick, primary, disabled, loading, danger, small }) {
  const [hov, setHov] = useState(false);
  const base = {
    fontFamily: fonts.body, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
    border: 'none', borderRadius: radius.md, transition: 'all 0.15s',
    display: 'inline-flex', alignItems: 'center', gap: 6, outline: 'none',
    padding: small ? '6px 14px' : '9px 20px',
    fontSize: small ? 13 : 14,
    opacity: disabled ? 0.5 : 1,
  };
  let extra;
  if (danger) {
    extra = { background: hov ? '#B91C1C' : colors.red600, color: '#fff' };
  } else if (primary) {
    extra = { background: hov ? colors.blue700 : colors.blue600, color: '#fff' };
  } else {
    extra = {
      background: hov ? colors.gray100 : '#fff',
      color: colors.gray700,
      border: `1px solid ${colors.gray200}`,
    };
  }
  return (
    <button style={{ ...base, ...extra }} onClick={onClick} disabled={disabled || loading}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>
      {loading ? <Spinner size={14} color={primary ? '#fff' : colors.blue600} /> : null}
      {children}
    </button>
  );
}

function Spinner({ size = 18, color = colors.blue600 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      style={{ animation: 'spin 0.8s linear infinite', flexShrink: 0 }}>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="3" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function Card({ children, style }) {
  return (
    <div style={{
      background: colors.white, border: `1px solid ${colors.gray200}`,
      borderRadius: radius.lg, boxShadow: shadows.card,
      ...style,
    }}>
      {children}
    </div>
  );
}

// ─── STATE 1: Input form ──────────────────────────────────────────────────────

function InputState({ onBreakdown }) {
  const [form, setForm] = useState({
    sprintName: '',
    startDate:  today(),
    endDate:    twoWeeksLater(),
    goalText:   '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function handleSubmit() {
    if (!form.sprintName.trim()) return setError('Sprint name is required.');
    if (!form.goalText.trim())   return setError('Sprint goal is required.');
    setError(null);
    setLoading(true);
    try {
      const data = await api('/api/sprint-planning/breakdown', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      onBreakdown(form, data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const inputStyle = {
    width: '100%', boxSizing: 'border-box',
    fontFamily: fonts.body, fontSize: 14,
    padding: '8px 12px', borderRadius: radius.md,
    border: `1px solid ${colors.gray200}`,
    color: colors.gray900, background: colors.white, outline: 'none',
  };
  const labelStyle = {
    display: 'block', fontSize: 13, fontWeight: 600,
    color: colors.gray700, fontFamily: fonts.body, marginBottom: 6,
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <h2 style={{ ...styles.pageTitle, marginBottom: 4 }}>Plan New Sprint</h2>
      <p style={{ ...styles.subtitle, marginBottom: 32 }}>
        Describe your sprint goal and Claude will break it into role-matched, workload-balanced tasks.
      </p>

      <Card style={{ padding: 28 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 20 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>Sprint name</label>
            <input style={inputStyle} placeholder="Sprint 13"
              value={form.sprintName} onChange={(e) => set('sprintName', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Start date</label>
            <input type="date" style={inputStyle}
              value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>End date</label>
            <input type="date" style={inputStyle}
              value={form.endDate} onChange={(e) => set('endDate', e.target.value)} />
          </div>
        </div>

        <div style={{ marginBottom: 24 }}>
          <label style={labelStyle}>Sprint goal</label>
          <textarea
            style={{ ...inputStyle, resize: 'vertical', minHeight: 96 }}
            placeholder="Describe what this sprint needs to deliver..."
            value={form.goalText}
            onChange={(e) => set('goalText', e.target.value)}
          />
        </div>

        {error && (
          <div style={{
            marginBottom: 16, padding: '10px 14px', borderRadius: radius.md,
            background: colors.tintRed.bg, color: colors.tintRed.text,
            border: `1px solid ${colors.tintRed.border}`,
            fontSize: 13, fontFamily: fonts.body,
          }}>
            {error}
          </div>
        )}

        <Btn primary loading={loading} onClick={handleSubmit} disabled={loading}>
          {loading ? 'Claude is thinking…' : 'Break Down Sprint →'}
        </Btn>
      </Card>
    </div>
  );
}

// ─── Workload panel (right sidebar) ──────────────────────────────────────────

function WorkloadPanel({ members, assignments, tasks }) {
  // Count in-plan assignments per member
  const planCounts = {};
  Object.values(assignments).forEach((mid) => {
    if (mid) planCounts[mid] = (planCounts[mid] || 0) + 1;
  });

  return (
    <Card style={{ padding: '16px 20px', position: 'sticky', top: 72, minWidth: 210 }}>
      <div style={{ ...styles.sectionHeader, marginBottom: 14 }}>Team Workload</div>
      {members.length === 0 && (
        <p style={{ fontSize: 12, color: colors.gray400, fontFamily: fonts.body }}>No team data</p>
      )}
      {members.map((m) => {
        const existing = m.currentTasks || 0;
        const planned  = planCounts[m.memberId] || 0;
        const total    = existing + planned;
        const roleLabel = (m.roles || []).slice(0, 1).join(', ') || 'Engineer';

        // Bar: 0=empty, 1-2=green, 3-4=amber, 5+=red; max visual at 8
        const barPct  = Math.min(total / 8, 1);
        const barColor = total === 0 ? colors.gray200 : total <= 2 ? colors.green600 : total <= 4 ? colors.amber600 : colors.red600;
        const label   = total === 0 ? 'free' : total <= 2 ? `${total} tasks` : total <= 4 ? `${total} tasks` : `${total} tasks ← heavy`;

        return (
          <div key={m.memberId} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
              <span style={{ fontSize: 12, fontFamily: fonts.body, color: colors.gray800, fontWeight: 500 }}>
                {m.name}
              </span>
              <span style={{
                fontSize: 10, fontFamily: fonts.mono,
                color: total >= 5 ? colors.red600 : total === 0 ? colors.gray400 : colors.gray600,
              }}>
                {label}
              </span>
            </div>
            <div style={{ fontSize: 10, color: colors.gray400, fontFamily: fonts.body, marginBottom: 3 }}>
              {roleLabel}
            </div>
            <div style={{ height: 5, borderRadius: 3, background: colors.gray100, overflow: 'hidden', position: 'relative' }}>
              {total === 0
                ? <div style={{ height: '100%', width: '100%', background: 'transparent', border: `1px solid ${colors.gray200}`, borderRadius: 3 }} />
                : <div style={{ height: '100%', width: `${barPct * 100}%`, background: barColor, borderRadius: 3, transition: 'width 0.3s' }} />
              }
            </div>
          </div>
        );
      })}
    </Card>
  );
}

// ─── Assignment summary ───────────────────────────────────────────────────────

function AssignmentSummary({ tasks, assignments, workloadSnapshot }) {
  const memberById = {};
  (workloadSnapshot || []).forEach((m) => { memberById[m.memberId] = m; });

  // Compute per-member task list from current assignments state
  const byMember = {};
  tasks.forEach((task, idx) => {
    const mid = assignments[idx];
    if (!mid) return;
    const member = memberById[mid];
    const name   = member?.name || `Member #${mid}`;
    if (!byMember[name]) byMember[name] = { name, roles: member?.roles || [], tasks: [] };
    byMember[name].tasks.push(task);
  });

  const unassigned = tasks.filter((_, idx) => !assignments[idx]);

  const rows = Object.values(byMember).sort((a, b) => b.tasks.length - a.tasks.length);

  return (
    <Card style={{ marginBottom: 20 }}>
      <div style={{
        padding: '12px 20px', borderBottom: `1px solid ${colors.gray100}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={styles.sectionHeader}>Sprint Assignment Summary</span>
      </div>

      {rows.map((row) => (
        <div key={row.name} style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '9px 20px', borderBottom: `1px solid ${colors.gray100}`,
        }}>
          <span style={{ fontSize: 13, fontFamily: fonts.body, color: colors.gray800, fontWeight: 500, minWidth: 120 }}>
            {row.name}
          </span>
          <span style={{ fontSize: 12, fontFamily: fonts.body, color: colors.gray500, flex: 1 }}>
            {(row.roles || []).slice(0, 2).join(', ') || 'Engineer'}
          </span>
          <span style={{
            fontSize: 13, fontWeight: 600, fontFamily: fonts.body,
            color: row.tasks.length >= 5 ? colors.red600 : colors.gray700,
          }}>
            {row.tasks.length} task{row.tasks.length !== 1 ? 's' : ''}
          </span>
        </div>
      ))}

      {unassigned.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '9px 20px', borderBottom: `1px solid ${colors.gray100}`,
          background: colors.tintAmber.bg,
        }}>
          <span style={{ fontSize: 13, fontFamily: fonts.body, color: colors.amber600, fontWeight: 500, flex: 1 }}>
            Unassigned
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, fontFamily: fonts.body, color: colors.amber600 }}>
            {unassigned.length} task{unassigned.length !== 1 ? 's' : ''} ⚠ Requires manual assignment
          </span>
        </div>
      )}

      <div style={{
        padding: '9px 20px',
        borderTop: `1px solid ${colors.gray100}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 12, color: colors.gray400, fontFamily: fonts.body }}>
          {tasks.length} total tasks · {tasks.length - unassigned.length} assigned
        </span>
      </div>
    </Card>
  );
}

// ─── Task card ────────────────────────────────────────────────────────────────

function TaskCard({ task, idx, workloadSnapshot, assignedMemberId, onUpdate, onAssign, onRemove }) {
  const [editingTitle, setEditingTitle] = useState(false);

  const allRankings       = task.allRankings       || [];
  const assignmentReasons = task.assignmentReasons || [];
  const assignmentScore   = task.assignmentScore   || null;

  const currentRanking = allRankings.find((r) => r.memberId === assignedMemberId);
  const displayScore   = currentRanking?.score ?? assignmentScore;
  const displayReasons = currentRanking?.reasons ?? assignmentReasons;

  // Split members into eligible (match domain) and others
  const members         = workloadSnapshot || [];
  const eligibleMembers = members.filter((m) => isEligibleForDomain(m, task.domain));
  const otherMembers    = members.filter((m) => !isEligibleForDomain(m, task.domain));

  // Warn if assigned member is outside domain
  const assignedMember     = members.find((m) => m.memberId === assignedMemberId);
  const domainMismatch     = assignedMember && !isEligibleForDomain(assignedMember, task.domain) && task.domain !== 'general';
  const requiresManual     = task.requiresManualAssignment && !assignedMemberId;

  return (
    <Card style={{ padding: '16px 20px', position: 'relative' }}>
      <button onClick={onRemove} style={{
        position: 'absolute', top: 12, right: 12,
        background: 'none', border: 'none', cursor: 'pointer',
        color: colors.gray400, fontSize: 16, lineHeight: 1, padding: 4,
      }} title="Remove task">×</button>

      {/* Priority + domain + title */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8, paddingRight: 28, flexWrap: 'wrap' }}>
        <div style={{ flexShrink: 0, paddingTop: 1 }}>
          <PriorityBadge priority={task.priority} />
        </div>
        {task.domain && (
          <div style={{ flexShrink: 0, paddingTop: 1 }}>
            <DomainBadge domain={task.domain} />
          </div>
        )}
        {editingTitle ? (
          <input
            autoFocus
            value={task.title}
            onChange={(e) => onUpdate('title', e.target.value)}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => e.key === 'Enter' && setEditingTitle(false)}
            style={{
              flex: 1, fontFamily: fonts.body, fontSize: 14, fontWeight: 600,
              color: colors.gray900, border: `1px solid ${colors.blue600}`,
              borderRadius: radius.sm, padding: '2px 6px', outline: 'none', minWidth: 120,
            }}
          />
        ) : (
          <span
            onClick={() => setEditingTitle(true)}
            title="Click to edit"
            style={{
              flex: 1, fontSize: 14, fontWeight: 600, color: colors.gray900,
              fontFamily: fonts.body, cursor: 'text',
              borderBottom: `1px dashed ${colors.gray300}`,
              lineHeight: 1.4, minWidth: 120,
            }}
          >
            {task.title || <span style={{ color: colors.gray400 }}>Untitled task</span>}
          </span>
        )}
      </div>

      <p style={{ fontSize: 13, color: colors.gray600, fontFamily: fonts.body, margin: '0 0 10px', lineHeight: 1.6 }}>
        {task.description}
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: colors.gray600, fontFamily: fonts.body }}>
          <span style={{ color: colors.gray400 }}>Due: </span>{formatDate(task.suggestedDueDate)}
        </span>
        <span style={{ fontSize: 12, color: colors.gray600, fontFamily: fonts.body }}>
          <span style={{ color: colors.gray400 }}>Est: </span>{task.estimatedDays}d
        </span>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {(task.skillTags || []).map((tag) => <Tag key={tag} label={tag} />)}
        </div>
      </div>

      {/* Requires manual assignment warning */}
      {requiresManual && (
        <div style={{
          marginBottom: 10, padding: '8px 12px', borderRadius: radius.md,
          background: '#FFFBEB', color: '#D97706',
          border: '1px solid #FDE68A', fontSize: 12, fontFamily: fonts.body,
        }}>
          ⚠ No {task.domain} engineers in the team — please assign manually
        </div>
      )}

      {/* Assignment section */}
      <div style={{
        borderTop: `1px solid ${colors.gray100}`, paddingTop: 10,
        display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'start',
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: colors.gray600, fontFamily: fonts.body, whiteSpace: 'nowrap' }}>
              Assigned to:
            </span>
            <select
              value={assignedMemberId || ''}
              onChange={(e) => onAssign(e.target.value ? parseInt(e.target.value, 10) : null)}
              style={{
                fontFamily: fonts.body, fontSize: 13, padding: '4px 8px',
                borderRadius: radius.sm, border: `1px solid ${colors.gray200}`,
                color: colors.gray700, background: colors.white, cursor: 'pointer',
              }}
            >
              <option value="">— Unassigned —</option>
              {eligibleMembers.length > 0 && eligibleMembers.map((m) => (
                <option key={m.memberId} value={m.memberId}>{m.name}</option>
              ))}
              {otherMembers.length > 0 && (
                <optgroup label="Outside task domain">
                  {otherMembers.map((m) => (
                    <option key={m.memberId} value={m.memberId}>{m.name} (outside domain)</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          {/* Domain mismatch warning */}
          {domainMismatch && (
            <div style={{ fontSize: 11, color: colors.amber600, fontFamily: fonts.body, marginBottom: 6 }}>
              ⚠ This member's role doesn't match the task domain
            </div>
          )}

          {/* Assignment reasons */}
          {displayReasons.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              {displayReasons.map((reason, i) => (
                <div key={i} style={{
                  fontSize: 11, fontFamily: fonts.body, lineHeight: 1.5,
                  color: reason.startsWith('⚠') || reason.toLowerCase().includes('low') ? colors.amber600 : colors.green600,
                }}>
                  {reason}
                </div>
              ))}
            </div>
          )}

          {/* Alternative assignee */}
          {task.alternativeAssigneeName && task.alternativeAssigneeId && task.alternativeAssigneeId !== assignedMemberId && (
            <div style={{ fontSize: 11, color: colors.gray400, fontFamily: fonts.body }}>
              Alternative: {task.alternativeAssigneeName}&nbsp;&nbsp;
              <button
                onClick={() => onAssign(task.alternativeAssigneeId)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: colors.linkBlue, fontSize: 11, fontFamily: fonts.body,
                  padding: 0, textDecoration: 'underline',
                }}
              >
                Assign instead
              </button>
            </div>
          )}
        </div>

        {/* Score badge */}
        {displayScore !== null && (
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: 42, height: 42, borderRadius: '50%',
              background: displayScore >= 70 ? colors.green50 : displayScore >= 50 ? colors.blue50 : colors.tintAmber.bg,
              border: `2px solid ${displayScore >= 70 ? colors.green600 : displayScore >= 50 ? colors.blue600 : colors.amber600}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 700, fontFamily: fonts.body,
              color: displayScore >= 70 ? colors.green600 : displayScore >= 50 ? colors.blue600 : colors.amber600,
            }}>
              {displayScore}
            </div>
            <div style={{ fontSize: 9, color: colors.gray400, fontFamily: fonts.body, marginTop: 2, textAlign: 'center' }}>
              / 100
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function ConfirmDialog({ sprintName, taskCount, onConfirm, onCancel }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <Card style={{ padding: 28, maxWidth: 400, width: '90%' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: colors.gray900, fontFamily: fonts.body }}>
          Create sprint in Jira?
        </h3>
        <p style={{ fontSize: 14, color: colors.gray600, fontFamily: fonts.body, margin: '0 0 24px', lineHeight: 1.6 }}>
          This will create <strong>{sprintName}</strong> in Jira with <strong>{taskCount} tasks</strong> and
          post a kickoff message to your Slack standup channel.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Btn onClick={onCancel}>Cancel</Btn>
          <Btn primary onClick={onConfirm}>Yes, Create Sprint</Btn>
        </div>
      </Card>
    </div>
  );
}

// ─── STATE 2: Review ──────────────────────────────────────────────────────────

function ReviewState({ formData, breakdownData, onCreate, onBack }) {
  const { sprintName, startDate, endDate, goalText } = formData;
  const { suggestedTasks: initialTasks, workloadSnapshot, teamCapacity, totalWorkingDays, warning } = breakdownData;

  // workloadSnapshot is the new format; fall back to teamCapacity for backward compat
  const members = workloadSnapshot || (teamCapacity || []).map((m) => ({
    memberId:      m.memberId,
    name:          m.name,
    roles:         [],
    roleSlugs:     [],
    currentTasks:  m.currentTasks || 0,
    capacityLabel: m.currentTasks === 0 ? 'free' : m.currentTasks <= 2 ? 'light' : m.currentTasks <= 4 ? 'moderate' : 'heavy',
  }));

  const [tasks, setTasks]             = useState(() => initialTasks.map((t, i) => ({ ...t, _idx: i })));
  const [assignments, setAssignments] = useState(() => {
    const map = {};
    initialTasks.forEach((t, i) => {
      if (t.suggestedAssigneeId) map[i] = t.suggestedAssigneeId;
    });
    return map;
  });
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);

  function updateTask(idx, field, value) {
    setTasks((prev) => prev.map((t, i) => i === idx ? { ...t, [field]: value } : t));
  }

  function removeTask(idx) {
    setTasks((prev) => prev.filter((_, i) => i !== idx));
    setAssignments((prev) => {
      const next = {};
      let newIdx = 0;
      for (let i = 0; i < tasks.length; i++) {
        if (i === idx) continue;
        if (prev[i] !== undefined) next[newIdx] = prev[i];
        newIdx++;
      }
      return next;
    });
  }

  function addTask() {
    setTasks((prev) => [
      ...prev,
      {
        title: '', description: '', domain: 'general', priority: 'Medium',
        estimatedDays: 2, suggestedDueDate: endDate, skillTags: [],
        assignmentReasons: [], allRankings: [],
        requiresManualAssignment: false,
      },
    ]);
  }

  // Check if any task requires manual assignment but has none
  const blockedTasks = tasks.filter((t, idx) => t.requiresManualAssignment && !assignments[idx]);
  const canCreate    = blockedTasks.length === 0 && tasks.length > 0;

  async function handleCreate() {
    setShowConfirm(false);
    setLoading(true);
    setError(null);
    try {
      const result = await api('/api/sprint-planning/create', {
        method: 'POST',
        body: JSON.stringify({ sprintName, startDate, endDate, goalText, tasks, assignments }),
      });
      onCreate(result);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  const assignedCount = new Set(Object.values(assignments).filter(Boolean)).size;

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ ...styles.pageTitle, marginBottom: 4 }}>Review Sprint Plan</h2>
        <p style={{ ...styles.subtitle }}>
          {tasks.length} tasks suggested for <strong>{sprintName}</strong>
        </p>
      </div>

      {/* Summary bar */}
      <Card style={{ padding: '12px 20px', marginBottom: 20, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        {[
          [`${tasks.length}`, 'tasks'],
          [`${assignedCount}`, 'members assigned'],
          [`${totalWorkingDays}`, 'working days'],
        ].map(([val, label]) => (
          <div key={label} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 20, fontWeight: 700, color: colors.blue600, fontFamily: fonts.body }}>{val}</span>
            <span style={{ fontSize: 13, color: colors.gray400, fontFamily: fonts.body }}>{label}</span>
          </div>
        ))}
      </Card>

      {/* Heavy load warning */}
      {warning && (
        <div style={{
          marginBottom: 16, padding: '10px 14px', borderRadius: radius.md,
          background: colors.tintAmber.bg, color: colors.tintAmber.text,
          border: `1px solid ${colors.tintAmber.border}`,
          fontSize: 13, fontFamily: fonts.body,
        }}>
          ⚠ {warning}
        </div>
      )}

      {error && (
        <div style={{
          marginBottom: 16, padding: '10px 14px', borderRadius: radius.md,
          background: colors.tintRed.bg, color: colors.tintRed.text,
          border: `1px solid ${colors.tintRed.border}`,
          fontSize: 13, fontFamily: fonts.body,
        }}>
          {error}
        </div>
      )}

      {/* Two-column layout */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* Task cards */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 12 }}>
            {tasks.map((task, idx) => (
              <TaskCard
                key={idx}
                task={task}
                idx={idx}
                workloadSnapshot={members}
                assignedMemberId={assignments[idx] || null}
                onUpdate={(field, val) => updateTask(idx, field, val)}
                onAssign={(memberId) => setAssignments((prev) => ({ ...prev, [idx]: memberId }))}
                onRemove={() => removeTask(idx)}
              />
            ))}
          </div>

          <button onClick={addTask} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: colors.linkBlue, fontSize: 13, fontFamily: fonts.body, fontWeight: 500,
            padding: '4px 0', marginBottom: 24,
          }}>
            + Add Task
          </button>

          {/* Assignment summary */}
          <AssignmentSummary tasks={tasks} assignments={assignments} workloadSnapshot={members} />

          {/* Block create if manual assignments missing */}
          {blockedTasks.length > 0 && (
            <div style={{
              marginBottom: 16, padding: '10px 14px', borderRadius: radius.md,
              background: colors.tintRed.bg, color: colors.tintRed.text,
              border: `1px solid ${colors.tintRed.border}`,
              fontSize: 13, fontFamily: fonts.body,
            }}>
              Please assign all tasks before creating the sprint.
              {' '}{blockedTasks.length} task{blockedTasks.length !== 1 ? 's' : ''} still need{blockedTasks.length === 1 ? 's' : ''} a manual assignee.
            </div>
          )}
        </div>

        {/* Workload sidebar */}
        {members.length > 0 && (
          <div style={{ width: 230, flexShrink: 0 }}>
            <WorkloadPanel members={members} assignments={assignments} tasks={tasks} />
          </div>
        )}
      </div>

      {/* Sticky action bar */}
      <div style={{
        position: 'sticky', bottom: 0, background: colors.white,
        borderTop: `1px solid ${colors.gray200}`,
        padding: '14px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginTop: 8,
      }}>
        <Btn onClick={onBack}>← Back</Btn>
        <Btn
          primary loading={loading}
          onClick={() => setShowConfirm(true)}
          disabled={loading || tasks.length === 0 || !canCreate}
        >
          Create Sprint in Jira →
        </Btn>
      </div>

      {showConfirm && (
        <ConfirmDialog
          sprintName={sprintName}
          taskCount={tasks.length}
          onConfirm={handleCreate}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}

// ─── STATE 3: Confirmed ───────────────────────────────────────────────────────

function ConfirmedState({ formData, createResult, onBackToOverview }) {
  const { sprintName, startDate, endDate } = formData;
  const {
    tasksCreated, tasksFailed, createdIssues,
    kickoffMessageSent, jiraSiteUrl,
    validationWarnings, jiraIdWarnings,
  } = createResult;

  const successIssues = (createdIssues || []).filter((i) => i.success);
  const failedIssues  = (createdIssues || []).filter((i) => !i.success);
  const allWarnings   = [...(validationWarnings || []), ...(jiraIdWarnings || [])];

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
        <div style={{
          width: 40, height: 40, borderRadius: '50%',
          background: colors.green50, display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M4 10l4 4 8-8" stroke={colors.green600} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div>
          <h2 style={{ ...styles.pageTitle, margin: 0 }}>{sprintName} created</h2>
          <p style={{ ...styles.subtitle, marginTop: 2 }}>
            Sprint window: {formatDate(startDate)} – {formatDate(endDate)}
          </p>
        </div>
      </div>

      <Card style={{ padding: '14px 20px', marginBottom: 16, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <StatPill value={tasksCreated} label="tasks created in Jira" color={colors.green600} />
        {tasksFailed > 0 && <StatPill value={tasksFailed} label="tasks failed" color={colors.red600} />}
        <StatPill
          value={kickoffMessageSent ? '✓' : '✗'}
          label={kickoffMessageSent ? 'Kickoff message posted' : 'Kickoff message failed'}
          color={kickoffMessageSent ? colors.green600 : colors.amber600}
        />
      </Card>

      {!kickoffMessageSent && (
        <div style={{
          padding: '10px 14px', borderRadius: radius.md, marginBottom: 16,
          background: colors.tintAmber.bg, color: colors.tintAmber.text,
          border: `1px solid ${colors.tintAmber.border}`,
          fontSize: 13, fontFamily: fonts.body,
        }}>
          ⚠ Kickoff message could not be posted to Slack — please post manually.
        </div>
      )}

      {allWarnings.length > 0 && (
        <div style={{
          padding: '10px 14px', borderRadius: radius.md, marginBottom: 16,
          background: colors.tintAmber.bg, color: colors.tintAmber.text,
          border: `1px solid ${colors.tintAmber.border}`,
          fontSize: 13, fontFamily: fonts.body,
        }}>
          {allWarnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}

      <Card style={{ padding: 0, marginBottom: 24, overflow: 'hidden' }}>
        <div style={{ padding: '12px 20px', borderBottom: `1px solid ${colors.gray100}` }}>
          <span style={styles.sectionHeader}>Created Issues</span>
        </div>
        {successIssues.map((issue) => (
          <div key={issue.key} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 20px', borderBottom: `1px solid ${colors.gray100}`,
          }}>
            <a
              href={`${jiraSiteUrl}/browse/${issue.key}`}
              target="_blank" rel="noopener noreferrer"
              style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.linkBlue, fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap' }}
            >
              {issue.key}
            </a>
            <span style={{ fontSize: 13, color: colors.gray700, fontFamily: fonts.body, flex: 1 }}>
              {issue.summary}
            </span>
          </div>
        ))}
        {failedIssues.map((issue, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'flex-start', gap: 12,
            padding: '10px 20px', borderBottom: `1px solid ${colors.gray100}`,
            background: colors.tintRed.bg,
          }}>
            <span style={{ fontSize: 12, color: colors.red600, fontFamily: fonts.mono, whiteSpace: 'nowrap', paddingTop: 1 }}>FAILED</span>
            <div>
              <div style={{ fontSize: 13, color: colors.gray700, fontFamily: fonts.body }}>{issue.summary}</div>
              <div style={{ fontSize: 12, color: colors.red600, fontFamily: fonts.body, marginTop: 2 }}>{issue.error}</div>
            </div>
          </div>
        ))}
      </Card>

      <div style={{ display: 'flex', gap: 12 }}>
        {jiraSiteUrl && (
          <a href={`${jiraSiteUrl}/jira/software/projects`} target="_blank" rel="noopener noreferrer">
            <Btn>View in Jira ↗</Btn>
          </a>
        )}
        <Btn primary onClick={onBackToOverview}>Back to Overview</Btn>
      </div>
    </div>
  );
}

function StatPill({ value, label, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ fontSize: 18, fontWeight: 700, color, fontFamily: fonts.body }}>{value}</span>
      <span style={{ fontSize: 12, color: colors.gray400, fontFamily: fonts.body }}>{label}</span>
    </div>
  );
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

export default function SprintPlanningTab({ navigate }) {
  const [state, setState]                 = useState('input');
  const [formData, setFormData]           = useState(null);
  const [breakdownData, setBreakdownData] = useState(null);
  const [createResult, setCreateResult]  = useState(null);

  function handleBreakdown(form, data) {
    setFormData(form);
    setBreakdownData(data);
    setState('review');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleCreate(result) {
    setCreateResult(result);
    setState('confirmed');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleBack() {
    setState('input');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <div style={{ paddingBottom: 80 }}>
      {state === 'input' && <InputState onBreakdown={handleBreakdown} />}
      {state === 'review' && (
        <ReviewState
          formData={formData}
          breakdownData={breakdownData}
          onCreate={handleCreate}
          onBack={handleBack}
        />
      )}
      {state === 'confirmed' && (
        <ConfirmedState
          formData={formData}
          createResult={createResult}
          onBackToOverview={() => navigate && navigate('overview')}
        />
      )}
    </div>
  );
}
