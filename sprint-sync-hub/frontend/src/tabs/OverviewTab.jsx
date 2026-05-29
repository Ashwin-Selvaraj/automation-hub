import React, { useState, useEffect } from 'react';
import { theme, styles } from '../theme.js';
import { getSlackMessages, getJiraIssues, getSyncLog } from '../api.js';
import Card, { SectionHeader } from '../components/Card.jsx';
import Badge from '../components/Badge.jsx';
import Toggle from '../components/Toggle.jsx';
import Spinner from '../components/Spinner.jsx';

const { colors, fonts } = theme;

const AUTOMATIONS = [
  { name: 'Huddle Sync',          desc: 'Matches Slack standup messages to Jira tasks every 30 min, Mon–Fri 8am–8pm.' },
  { name: 'Deadline Check',       desc: 'DMs assignees of tasks due today. Runs at 9:00 am daily.' },
  { name: 'End-of-Day Check',     desc: 'DMs members with no standup update. Runs Mon–Fri at the configured EOD time.' },
  { name: 'Weekly Report',        desc: 'Posts AI sprint summary to the Slack channel. Runs on the configured report day.' },
];

function MetricCard({ label, value, loading }) {
  return (
    <Card style={{ marginBottom: 0 }}>
      <div style={{ fontSize: 28, fontWeight: 600, color: colors.gray900, fontFamily: fonts.body, lineHeight: 1.2 }}>
        {loading ? <Spinner size={24} /> : value ?? '—'}
      </div>
      <div style={{ fontSize: 12, color: colors.gray400, marginTop: 6, fontFamily: fonts.body }}>{label}</div>
    </Card>
  );
}

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

export default function OverviewTab({ config }) {
  const [messages,  setMessages]  = useState([]);
  const [taskCount, setTaskCount] = useState(null);
  const [log,       setLog]       = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [enabled,   setEnabled]   = useState([true, true, true, true]);

  useEffect(() => {
    Promise.all([
      getSlackMessages(30).catch(() => ({ messages: [] })),
      getJiraIssues().catch(() => ({ issues: [] })),
      getSyncLog(50).catch(() => ({ entries: [] })),
    ]).then(([msgData, issData, logData]) => {
      setMessages(msgData.messages || []);
      setTaskCount((issData.issues || []).length);
      setLog(logData.entries || []);
    }).finally(() => setLoading(false));
  }, []);

  const today       = new Date().toDateString();
  const todayMsgs   = messages.filter((m) => m.date && new Date(m.date).toDateString() === today);
  const postedNames = new Set(todayMsgs.map((m) => m.userId).filter(Boolean));
  const postedToday = postedNames.size;
  const totalM      = config?.teamMembers?.length || 0;
  const missingToday = Math.max(0, totalM - postedToday);

  const metrics = [
    { label: 'Messages This Sprint', value: messages.length },
    { label: 'Tasks in Jira',        value: taskCount       },
    { label: 'Posted Today',         value: postedToday     },
    { label: 'Missing Today',        value: missingToday    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h1 style={styles.pageTitle}>Overview</h1>
        <p style={styles.subtitle}>{config?.sprintName || 'Sprint'} · {config?.startDate} → {config?.endDate}</p>
      </div>

      {/* Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {metrics.map((m) => <MetricCard key={m.label} label={m.label} value={m.value} loading={loading} />)}
      </div>

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
    </div>
  );
}
