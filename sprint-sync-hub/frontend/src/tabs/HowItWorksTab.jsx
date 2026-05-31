import React, { useState } from 'react';
import { theme } from '../theme.js';

const { colors, fonts } = theme;

// ─── Design primitives ────────────────────────────────────────────────────────

function Chip({ label, color, bg }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: 10, fontWeight: 700, fontFamily: fonts.body,
      textTransform: 'uppercase', letterSpacing: '0.06em',
      padding: '2px 8px', borderRadius: 99,
      color: color || colors.blue600,
      background: bg || colors.blue50,
      whiteSpace: 'nowrap', flexShrink: 0,
    }}>
      {label}
    </span>
  );
}

function SectionHeading({ children }) {
  return (
    <h2 style={{
      fontSize: 11, fontWeight: 700, color: colors.gray400,
      textTransform: 'uppercase', letterSpacing: '0.08em',
      fontFamily: fonts.body, margin: '32px 0 12px',
    }}>
      {children}
    </h2>
  );
}

function Divider() {
  return <div style={{ height: 1, background: colors.gray100, margin: '14px 0' }} />;
}

// ─── Accordion (for admin / setup content) ───────────────────────────────────

function Accordion({ icon, title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{
      background: colors.white,
      border: `1px solid ${colors.gray200}`,
      borderRadius: 10,
      overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '16px 20px', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>{icon}</span>
        <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: colors.gray900, fontFamily: fonts.body }}>
          {title}
        </span>
        <span style={{
          fontSize: 11, color: colors.gray400, fontFamily: fonts.body,
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s ease', flexShrink: 0,
        }}>▶</span>
      </button>
      {open && (
        <div style={{
          padding: '0 20px 20px',
          borderTop: `1px solid ${colors.gray100}`,
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Automation trigger card ──────────────────────────────────────────────────

function TriggerCard({ icon, title, when, what, suppressed, accentColor, accentBg }) {
  const accent = accentColor || colors.blue600;
  const bg     = accentBg    || colors.blue50;
  return (
    <div style={{
      background: colors.white,
      border: `1px solid ${colors.gray200}`,
      borderRadius: 10,
      padding: '18px 20px',
      display: 'flex', gap: 16,
    }}>
      {/* Icon */}
      <div style={{
        width: 40, height: 40, borderRadius: 10,
        background: bg, color: accent,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 20, flexShrink: 0,
      }}>
        {icon}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: colors.gray900, fontFamily: fonts.body }}>
            {title}
          </span>
        </div>

        {/* When */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: colors.gray400, fontFamily: fonts.body, whiteSpace: 'nowrap', marginTop: 2, minWidth: 40 }}>WHEN</span>
          <span style={{ fontSize: 13, color: colors.gray600, fontFamily: fonts.body, lineHeight: 1.5 }}>{when}</span>
        </div>

        {/* What */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: suppressed ? 10 : 0 }}>
          <span style={{ fontSize: 11, color: colors.gray400, fontFamily: fonts.body, whiteSpace: 'nowrap', marginTop: 2, minWidth: 40 }}>WHAT</span>
          <span style={{ fontSize: 13, color: colors.gray600, fontFamily: fonts.body, lineHeight: 1.5 }}>{what}</span>
        </div>

        {/* Suppression note */}
        {suppressed && (
          <div style={{
            display: 'flex', gap: 6, alignItems: 'flex-start',
            padding: '8px 10px', borderRadius: 6,
            background: '#F0FDF4', border: '1px solid #BBF7D0',
          }}>
            <span style={{ fontSize: 13 }}>🛡️</span>
            <span style={{ fontSize: 12, color: '#166534', fontFamily: fonts.body, lineHeight: 1.5 }}>
              {suppressed}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Score factor row ─────────────────────────────────────────────────────────

function ScoreFactor({ label, points, description, direction }) {
  const positive = direction === '+';
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '48px 1fr',
      gap: 14, alignItems: 'start', padding: '10px 0',
      borderBottom: `1px solid ${colors.gray100}`,
    }}>
      <div style={{
        fontSize: 13, fontWeight: 800, fontFamily: fonts.body,
        color: positive ? '#059669' : colors.red600,
        background: positive ? '#F0FDF4' : '#FEF2F2',
        border: `1px solid ${positive ? '#BBF7D0' : '#FECACA'}`,
        borderRadius: 6, padding: '3px 0', textAlign: 'center',
      }}>
        {points}
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: colors.gray900, fontFamily: fonts.body }}>{label}</div>
        <div style={{ fontSize: 12, color: colors.gray400, fontFamily: fonts.body, marginTop: 2, lineHeight: 1.5 }}>{description}</div>
      </div>
    </div>
  );
}

// ─── Shield row (suppression) ─────────────────────────────────────────────────

function ShieldRow({ icon, title, detail }) {
  return (
    <div style={{
      display: 'flex', gap: 12, alignItems: 'flex-start',
      padding: '12px 14px',
      background: '#F0FDF4', borderRadius: 8,
      border: '1px solid #D1FAE5',
    }}>
      <span style={{ fontSize: 16, flexShrink: 0, lineHeight: 1.4 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#065F46', fontFamily: fonts.body }}>{title}</div>
        <div style={{ fontSize: 12, color: '#047857', fontFamily: fonts.body, marginTop: 2, lineHeight: 1.5 }}>{detail}</div>
      </div>
    </div>
  );
}

// ─── Admin prose helpers ──────────────────────────────────────────────────────

function AdminP({ children }) {
  return <p style={{ fontSize: 13, color: colors.gray600, lineHeight: 1.7, marginTop: 12, fontFamily: fonts.body }}>{children}</p>;
}

function AdminStep({ n, children }) {
  return (
    <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
      <span style={{
        fontSize: 11, fontWeight: 700, color: colors.blue600,
        background: colors.blue50, borderRadius: '50%',
        width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, fontFamily: fonts.body,
      }}>{n}</span>
      <p style={{ fontSize: 13, color: colors.gray600, lineHeight: 1.6, fontFamily: fonts.body }}>{children}</p>
    </div>
  );
}

function InlineCode({ children }) {
  return (
    <code style={{
      fontFamily: fonts.mono || 'monospace',
      fontSize: 11, background: colors.gray100,
      padding: '1px 5px', borderRadius: 4,
      color: colors.gray700,
    }}>
      {children}
    </code>
  );
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

export default function HowItWorksTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 800 }}>

      {/* ── Hero ── */}
      <div style={{ marginBottom: 4 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: colors.gray900, fontFamily: fonts.body, letterSpacing: '-0.02em', marginBottom: 8 }}>
          Help & How It Works
        </h1>
        <p style={{ fontSize: 14, color: colors.gray500, fontFamily: fonts.body, lineHeight: 1.6, maxWidth: 620 }}>
          Automation-Hub watches your team's Slack standup channel, connects each update to
          the right Jira task automatically, and nudges people who fall through the cracks —
          so nothing gets lost and your sprint report writes itself.
        </p>
      </div>

      {/* Integration pills */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        {[
          { label: 'Slack',        icon: '💬', color: colors.blue600,  bg: colors.blue50  },
          { label: 'Jira',         icon: '📋', color: '#0052CC',       bg: '#E3F2FD'      },
          { label: 'Claude AI',    icon: '🤖', color: '#7C3AED',       bg: '#F5F3FF'      },
          { label: 'Zoho People',  icon: '🏢', color: '#059669',       bg: '#ECFDF5'      },
          { label: 'PostgreSQL',   icon: '🗄️', color: colors.gray600,  bg: colors.gray100 },
        ].map(({ label, icon, color, bg }) => (
          <div key={label} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 12px', borderRadius: 8,
            background: bg, border: `1px solid ${color}22`,
          }}>
            <span style={{ fontSize: 14 }}>{icon}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color, fontFamily: fonts.body }}>{label}</span>
          </div>
        ))}
      </div>

      {/* ─────────────────────────────────────────────────────────────────────── */}
      {/* SECTION A — DMs you will receive */}
      {/* ─────────────────────────────────────────────────────────────────────── */}

      <SectionHeading>💬 Slack DMs you may receive</SectionHeading>
      <p style={{ fontSize: 13, color: colors.gray400, fontFamily: fonts.body, marginBottom: 16, lineHeight: 1.6 }}>
        These are the only situations where the system will send you a direct message.
        Each one fires at most once per day per person.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

        <TriggerCard
          icon="🔗"
          title="Your standup couldn't be matched to a Jira task"
          accentColor={colors.blue600} accentBg={colors.blue50}
          when="You posted in #tech-huddle, but Claude couldn't confidently link it to any open Jira task in this sprint (match confidence < 70%)."
          what="A friendly DM asking you to update your Jira board manually, with a direct link to the project board."
          suppressed="Won't fire again for the same person on the same day."
        />

        <TriggerCard
          icon="⏰"
          title="End of day — no standup posted"
          accentColor={colors.amber600} accentBg="#FFFBEB"
          when={<>EOD check runs at <strong>6:30 PM IST</strong> (Mon–Fri). You are present at work (Zoho shows you checked in) but have not posted anything in #tech-huddle today.</>}
          what="A DM reminding you to post a quick standup update — even a short one counts."
          suppressed="Skipped if you are on approved leave, didn't check in (absent), or already checked out more than 1 hour before 6:30 PM."
        />

        <TriggerCard
          icon="🚪"
          title="You checked out without posting a standup"
          accentColor="#D97706" accentBg="#FEF3C7"
          when="Zoho People shows your checkout time just appeared, and you have no standup post for today. Checked every 15 minutes between 4:30 PM – 7:30 PM."
          what={<>A warm DM acknowledging you've already left and gently asking you to drop a quick update in #tech-huddle when you have a moment. <em>No urgency, just a nudge.</em></>}
          suppressed="Won't fire if you already received a missing-standup DM today (20-hour dedup window)."
        />

        <TriggerCard
          icon="📅"
          title="Your task is overdue"
          accentColor={colors.red600} accentBg="#FEF2F2"
          when="A Jira task assigned to you has a due date in the past and is not marked Done. Checked daily at 9:00 AM."
          what="A DM with the task name, how many days overdue, and a direct Jira link. If the task is 3+ days overdue, a second escalation DM is also sent, and the manager is notified separately."
          suppressed="Won't fire again for the same task within 24 hours."
        />

        <TriggerCard
          icon="📊"
          title="Weekly sprint report (in #tech-huddle)"
          accentColor={colors.green600} accentBg="#ECFDF5"
          when={<>Runs on <strong>Friday at 5:00 PM</strong> (configurable). Covers the full sprint week.</>}
          what="Posted to the standup channel — not a DM. Includes team standup rate, Jira task progress, top performers, and an AI-written sprint narrative. If a Manager Slack ID is configured, the same report is also DM'd directly to the manager."
        />

      </div>

      {/* ─────────────────────────────────────────────────────────────────────── */}
      {/* SECTION B — Jira actions */}
      {/* ─────────────────────────────────────────────────────────────────────── */}

      <SectionHeading>📋 Jira — what happens automatically</SectionHeading>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

        <TriggerCard
          icon="✅"
          title="Standup matched → Jira comment + status update"
          accentColor="#0052CC" accentBg="#E3F2FD"
          when="You post in #tech-huddle and Claude matches your message to a Jira task with ≥ 70% confidence."
          what="Two things happen automatically: (1) a comment is added to the Jira issue summarising what you said, and (2) the issue status is transitioned based on what Claude inferred — e.g. To Do → In Progress, In Progress → In Review."
        />

        <TriggerCard
          icon="🚫"
          title="No match found → no Jira changes made"
          accentColor={colors.gray500} accentBg={colors.gray50}
          when="Claude can't match your standup to any task (confidence < 70%)."
          what="Nothing is touched in Jira. You receive a DM (see above) asking you to update the board manually. This protects against incorrect automated transitions."
        />

      </div>

      {/* ─────────────────────────────────────────────────────────────────────── */}
      {/* SECTION C — Suppression — trust */}
      {/* ─────────────────────────────────────────────────────────────────────── */}

      <SectionHeading>🛡️ When you won't hear from us</SectionHeading>
      <p style={{ fontSize: 13, color: colors.gray400, fontFamily: fonts.body, marginBottom: 12, lineHeight: 1.6 }}>
        The system checks Zoho People before sending any DM. These conditions completely suppress notifications.
        Suppressed days are also <strong style={{ color: colors.gray600 }}>not counted against your performance score.</strong>
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ShieldRow icon="🌴" title="On approved leave"
          detail="If Zoho People shows approved leave for today, all standup-related DMs are skipped. The day is excluded from your standup attendance calculation entirely." />
        <ShieldRow icon="🏠" title="Didn't check in (absent, WFH without Zoho)"
          detail="If Zoho has no check-in record for you today, the system assumes you're absent and skips the EOD DM. The day is not counted as a missed standup." />
        <ShieldRow icon="🌅" title="Left early (checked out >1 hour before 6:30 PM)"
          detail="If your Zoho checkout time is more than 1 hour before the EOD check time, the EOD DM is skipped. The system knows you've already left." />
        <ShieldRow icon="🔕" title="Already notified today"
          detail="A 20-hour deduplication window prevents receiving more than one missing-standup DM per day, regardless of which trigger fired first." />
        <ShieldRow icon="⚠️" title="No active sprint"
          detail="The checkout detection job skips entirely if there's no active sprint in the database. No DMs are sent without a sprint context." />
        <ShieldRow icon="🔌" title="Zoho not configured"
          detail="If the Zoho People integration is not set up, attendance checks are skipped. EOD reminders still fire, but without leave/absence filtering." />
      </div>

      {/* ─────────────────────────────────────────────────────────────────────── */}
      {/* SECTION D — Performance score */}
      {/* ─────────────────────────────────────────────────────────────────────── */}

      <SectionHeading>🏆 How your performance score is calculated</SectionHeading>
      <p style={{ fontSize: 13, color: colors.gray400, fontFamily: fonts.body, marginBottom: 12, lineHeight: 1.6 }}>
        Scores run from 0–100. The starting point is 100 and points are added or deducted based on activity.
        Leave days and absences are excluded from the denominator before any calculation.
      </p>

      <div style={{
        background: colors.white, border: `1px solid ${colors.gray200}`,
        borderRadius: 10, padding: '4px 20px 4px',
      }}>
        <ScoreFactor
          label="Standup attendance rate" direction="+"
          points="×40"
          description="(Days you posted ÷ working days you were present) × 40. The single biggest factor." />
        <ScoreFactor
          label="Task completion rate" direction="+"
          points="×30"
          description="(Jira tasks completed ÷ tasks assigned) × 30." />
        <ScoreFactor
          label="Deadline hit rate" direction="+"
          points="×20"
          description="(Deadlines met ÷ total deadlines) × 20. Only tasks with a due date count." />
        <ScoreFactor
          label="Jira engagement bonus" direction="+"
          points="+5"
          description="Awarded if you have zero no-match DMs received this sprint (your standups consistently link to Jira tasks)." />
        <ScoreFactor
          label="Missed standup penalty" direction="-"
          points="-2"
          description="Per working day you were present but didn't post. Capped at -10." />
        <ScoreFactor
          label="Bulk post penalty" direction="-"
          points="-2"
          description="Per day posted as a bulk catch-up (e.g. posting 3 days of updates in one message on Friday). Capped at -10. Daily posting is what's rewarded." />
        <ScoreFactor
          label="Overdue task penalty" direction="-"
          points="-5"
          description="Per task that was overdue at any point this sprint. Capped at -15." />
        <div style={{ padding: '10px 0 4px', fontSize: 12, color: colors.gray400, fontFamily: fonts.body }}>
          Final score is clamped to 0–100. Scores ≥ 75 = Strong · 50–74 = On Track · &lt; 50 = At Risk.
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────────── */}
      {/* SECTION E — Cron schedule */}
      {/* ─────────────────────────────────────────────────────────────────────── */}

      <SectionHeading>🕐 When each job runs</SectionHeading>

      <div style={{
        background: colors.white, border: `1px solid ${colors.gray200}`,
        borderRadius: 10, overflow: 'hidden',
      }}>
        {[
          { time: '10:00 AM',              days: 'Every day',         label: 'Daily huddle sync',         desc: 'Fetches Slack messages, runs Claude matching, posts Jira comments, sends no-match DMs.',              color: colors.blue600 },
          { time: '9:00 AM',               days: 'Mon – Fri',         label: 'Deadline check',            desc: 'Finds overdue Jira tasks and sends reminder DMs to assignees.',                                      color: colors.red600  },
          { time: '6:30 PM',               days: 'Mon – Fri',         label: 'EOD standup check',         desc: 'Checks who hasn\'t posted today. Verifies leave/absence via Zoho before sending any DM.',            color: colors.amber600},
          { time: 'Every 15 min 4:30–7:30 PM', days: 'Mon – Fri',    label: 'Checkout detection',        desc: 'Polls Zoho for new checkouts. Sends a nudge DM if the member checked out without a standup post.',    color: '#7C3AED'      },
          { time: 'Friday 5:00 PM',         days: 'Weekly',           label: 'Sprint report',             desc: 'AI-generated sprint summary posted to the standup channel and DM\'d to the manager.',                 color: colors.green600},
        ].map((job, i, arr) => (
          <div key={job.label} style={{
            display: 'grid', gridTemplateColumns: '160px 1fr',
            borderBottom: i < arr.length - 1 ? `1px solid ${colors.gray100}` : 'none',
          }}>
            <div style={{
              padding: '14px 16px',
              borderRight: `1px solid ${colors.gray100}`,
              display: 'flex', flexDirection: 'column', justifyContent: 'center',
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: job.color, fontFamily: fonts.body }}>{job.time}</div>
              <div style={{ fontSize: 11, color: colors.gray400, fontFamily: fonts.body, marginTop: 2 }}>{job.days}</div>
            </div>
            <div style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: colors.gray900, fontFamily: fonts.body }}>{job.label}</div>
              <div style={{ fontSize: 12, color: colors.gray500, fontFamily: fonts.body, marginTop: 3, lineHeight: 1.5 }}>{job.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ─────────────────────────────────────────────────────────────────────── */}
      {/* SECTION F — FAQ */}
      {/* ─────────────────────────────────────────────────────────────────────── */}

      <SectionHeading>❓ Frequently asked questions</SectionHeading>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[
          {
            q: 'I posted a standup but still got a "couldn\'t match to Jira" DM. Why?',
            a: 'Claude reads your message and compares it to the open Jira tasks in the current sprint. If your message is too vague, uses different terminology than the Jira task title, or the task isn\'t in the active sprint, the match confidence falls below 70% and no automatic update is made. The fix is to mention the task name or key in your standup, or update Jira manually.',
          },
          {
            q: 'I\'m on leave but still received a DM. What happened?',
            a: 'The leave check only works if Zoho People is connected and your leave is marked as "approved" in Zoho on today\'s date. If Zoho isn\'t configured, or your leave is pending/informal, the system has no way to know. Contact your admin to either set up the Zoho integration or configure leave properly.',
          },
          {
            q: 'My performance score dropped. What\'s the main reason?',
            a: 'The standup attendance rate accounts for 40% of your score — it\'s the biggest single factor. Check the Performance tab → your member card → the stat bars. If your standup % is low that\'s the primary driver. Scroll down in your profile drawer to see the per-day breakdown.',
          },
          {
            q: 'Will Jira tasks be transitioned automatically even if I don\'t want that?',
            a: 'Yes, when a match is found with ≥ 70% confidence, Claude will attempt a status transition based on what your update implies (e.g. "finished the login page" → Done). If you want to prevent this, mention in your standup that work is ongoing. The transition only fires when Claude is confident about completion language.',
          },
          {
            q: 'I posted updates for the whole week in one message on Friday. Will that hurt my score?',
            a: 'Yes. Bulk posting is detected automatically and each retroactively posted day is penalised –2 points (capped at –10 for the sprint). This is intentional — daily visibility matters for the team. Post a short update each day, even one sentence.',
          },
          {
            q: 'How do I stop receiving a specific DM?',
            a: 'The best way is to fix the underlying condition (post your standup, update Jira, mark leave in Zoho). There\'s no opt-out. DMs have a 20-hour dedup window so you won\'t receive the same nudge twice in a day.',
          },
        ].map(({ q, a }) => (
          <Accordion key={q} icon="💬" title={q}>
            <AdminP>{a}</AdminP>
          </Accordion>
        ))}
      </div>

      {/* ─────────────────────────────────────────────────────────────────────── */}
      {/* SECTION G — Admin / setup (accordion — lower priority) */}
      {/* ─────────────────────────────────────────────────────────────────────── */}

      <SectionHeading>⚙️ Admin — setup & configuration</SectionHeading>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

        <Accordion icon="🔗" title="Connecting Slack, Jira, Claude AI, and Zoho">
          <AdminP>All credentials are stored encrypted in the database — go to the <strong>Connections</strong> tab to configure them from the UI. You never need to restart the server after saving credentials via the dashboard.</AdminP>
          <AdminStep n="1">Slack: create an app at <InlineCode>api.slack.com/apps</InlineCode> → add scopes <InlineCode>channels:history</InlineCode>, <InlineCode>chat:write</InlineCode>, <InlineCode>im:write</InlineCode>, <InlineCode>users:read</InlineCode> → install to workspace → paste Bot Token and Channel ID into Connections.</AdminStep>
          <AdminStep n="2">Jira: create an API token at <InlineCode>id.atlassian.com → Security → API tokens</InlineCode> → paste email, token, site URL, and project key into Connections.</AdminStep>
          <AdminStep n="3">Claude AI: get an API key at <InlineCode>console.anthropic.com</InlineCode> → paste into Connections.</AdminStep>
          <AdminStep n="4">Zoho People (optional): register an app at <InlineCode>accounts.zoho.com/developerconsole</InlineCode> → generate a refresh token with scopes <InlineCode>ZOHOPEOPLE.attendance.READ</InlineCode>, <InlineCode>ZOHOPEOPLE.leave.READ</InlineCode>, <InlineCode>ZOHOPEOPLE.employee.READ</InlineCode> → paste Client ID, Secret, Refresh Token, and domain (zoho.in / zoho.com / zoho.eu) into Connections.</AdminStep>
        </Accordion>

        <Accordion icon="👥" title="Adding or updating team members">
          <AdminP>Team members are managed from the <strong>Team</strong> tab in this dashboard. Each member needs a Slack User ID (starts with U) and a display name.</AdminP>
          <AdminP>For Zoho attendance features to work, each member also needs their work email address — this is what the system uses to look up their Zoho record.</AdminP>
          <AdminP>Alternatively, edit <InlineCode>backend/seeders/members.js</InlineCode> directly and run <InlineCode>npm run seed:members</InlineCode> from the backend folder for bulk imports.</AdminP>
        </Accordion>

        <Accordion icon="🕐" title="Changing the cron schedule">
          <AdminP>All schedule settings are configurable from the <strong>Connections</strong> tab → Schedule section. Changes take effect on the next server restart.</AdminP>
          <AdminP>Available settings: timezone, daily sync time (default 10:00 AM), EOD check time (default 6:30 PM), weekly report day (default Friday), report time (default 5:00 PM), and manager Slack ID for report DMs.</AdminP>
        </Accordion>

        <Accordion icon="🏃" title="Starting a new sprint">
          <AdminP>Go to the <strong>Sprint</strong> tab. Update the sprint name, start date, and duration. The system creates a new sprint record in the database and all new standup posts, stats, and performance scores will be associated with it.</AdminP>
          <AdminP>Previous sprint data is retained and viewable in each member's performance history (last 5 sprints shown in the profile drawer).</AdminP>
        </Accordion>

        <Accordion icon="🔐" title="Encryption and security">
          <AdminP>Sensitive values (Slack bot token, Jira API token, Anthropic API key, Zoho secrets) are encrypted at rest in the database using AES-256-GCM. The encryption key is stored as <InlineCode>ENCRYPTION_KEY</InlineCode> in your environment.</AdminP>
          <AdminP>Generate a key with: <InlineCode>node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"</InlineCode> — must be 64 hex characters or 32 ASCII characters. Without this key set, a dev-only fallback is used (not safe for production).</AdminP>
          <AdminP>The frontend never receives API tokens. All credential reads happen server-side only.</AdminP>
        </Accordion>

        <Accordion icon="🚀" title="Deploying to production">
          <AdminP>Frontend (React + Vite): deploy to Vercel. Set <InlineCode>VITE_API_URL</InlineCode> to your backend URL in the Vercel environment variables.</AdminP>
          <AdminP>Backend (Node.js + Express): deploy to Railway, Render, or any Node host. Copy every key from your <InlineCode>.env</InlineCode> file as environment variables in the hosting dashboard. The cron jobs start automatically when the server boots.</AdminP>
          <AdminP>Database: PostgreSQL is required. Railway and Render both offer managed Postgres. Set <InlineCode>DATABASE_URL</InlineCode> to the connection string. Migrations run automatically on first boot.</AdminP>
        </Accordion>

      </div>

      {/* Footer */}
      <div style={{
        marginTop: 40, paddingTop: 20,
        borderTop: `1px solid ${colors.gray100}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 8,
      }}>
        <span style={{ fontSize: 12, color: colors.gray300, fontFamily: fonts.body }}>
          Automation-Hub · Built with Slack, Jira, Claude AI &amp; Zoho People
        </span>
        <span style={{ fontSize: 12, color: colors.gray300, fontFamily: fonts.body }}>
          Questions? Update this page in <InlineCode>frontend/src/tabs/HowItWorksTab.jsx</InlineCode>
        </span>
      </div>

    </div>
  );
}
