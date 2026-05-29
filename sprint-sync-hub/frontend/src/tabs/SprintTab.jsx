import React, { useState, useEffect } from 'react';
import { theme, styles } from '../theme.js';
import { postSprintConfig, getSlackMessages, getJiraIssues } from '../api.js';
import Card, { SectionHeader } from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Input, { Label, Hint, FormGroup } from '../components/Input.jsx';
import Spinner from '../components/Spinner.jsx';

const { colors, fonts } = theme;

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function fmtDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

const DURATIONS = [
  { weeks: 1, label: '1 Week',  desc: '5 working days' },
  { weeks: 2, label: '2 Weeks', desc: '10 working days' },
  { weeks: 3, label: '3 Weeks', desc: '15 working days' },
];

function DurationCard({ opt, selected, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={() => onClick(opt.weeks)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        flex: 1, padding: '16px', textAlign: 'center', cursor: 'pointer',
        background: selected ? colors.blue50 : hovered ? colors.gray50 : colors.white,
        border: `${selected ? 2 : 1}px solid ${selected ? colors.blue600 : colors.gray200}`,
        borderRadius: 6, outline: 'none',
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600, color: selected ? colors.blue600 : colors.gray900 }}>
        {opt.label}
      </div>
      <div style={{ fontSize: 12, color: colors.gray400, marginTop: 4 }}>{opt.desc}</div>
    </button>
  );
}

export default function SprintTab({ config, setConfig }) {
  const [sprintName,    setSprintName]    = useState(config?.sprintName || '');
  const [startDate,     setStartDate]     = useState(config?.startDate  || '');
  const [durationWeeks, setDurationWeeks] = useState(config?.durationWeeks || 2);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [error,   setError]   = useState('');
  const [msgCount, setMsgCount] = useState(null);
  const [taskCount, setTaskCount] = useState(null);

  useEffect(() => {
    if (config) {
      setSprintName(config.sprintName || '');
      setStartDate(config.startDate || '');
      setDurationWeeks(config.durationWeeks || 2);
    }
  }, [config]);

  useEffect(() => {
    getSlackMessages(30).then((d) => setMsgCount(d.messages?.length ?? 0)).catch(() => setMsgCount('—'));
    getJiraIssues().then((d)      => setTaskCount(d.issues?.length ?? 0)).catch(() => setTaskCount('—'));
  }, []);

  const endDate = startDate ? addDays(startDate, durationWeeks * 7 - 1) : null;
  const weeks   = [];
  if (startDate) {
    for (let i = 0; i < durationWeeks; i++) {
      weeks.push({ label: `Week ${i + 1}`, start: addDays(startDate, i * 7), end: addDays(startDate, i * 7 + 6) });
    }
  }

  async function handleSave() {
    setSaving(true); setError('');
    try {
      await postSprintConfig({ sprintName, startDate, durationWeeks });
      setConfig?.((c) => ({ ...c, sprintName, startDate, durationWeeks, endDate }));
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h1 style={styles.pageTitle}>Sprint Configuration</h1>
        <p style={styles.subtitle}>All data is filtered to this sprint window.</p>
      </div>

      <Card style={{ marginBottom: 0 }}>
        <SectionHeader>Duration</SectionHeader>
        <div style={{ display: 'flex', gap: 12 }}>
          {DURATIONS.map((opt) => (
            <DurationCard key={opt.weeks} opt={opt} selected={durationWeeks === opt.weeks} onClick={setDurationWeeks} />
          ))}
        </div>
      </Card>

      <Card style={{ marginBottom: 0 }}>
        <SectionHeader>Details</SectionHeader>
        <FormGroup>
          <Label htmlFor="sprint-name">Sprint Name</Label>
          <Input id="sprint-name" value={sprintName} onChange={(e) => setSprintName(e.target.value)} placeholder="e.g. Sprint 12" />
          <Hint>Used in Jira comments and the weekly report header.</Hint>
        </FormGroup>
        <FormGroup>
          <Label htmlFor="start-date">Start Date</Label>
          <Input id="start-date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <Hint>End date is calculated automatically based on duration.</Hint>
        </FormGroup>
        {error && <p style={{ fontSize: 13, color: colors.red600, marginBottom: 12 }}>{error}</p>}
        <Button variant="primary" onClick={handleSave} disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {saving ? <><Spinner size={14} /> Saving…</> : saved ? '✓ Saved' : 'Save Sprint'}
        </Button>
      </Card>

      {endDate && (
        <Card style={{ marginBottom: 0 }}>
          <SectionHeader>Sprint Window</SectionHeader>
          <div style={{ fontSize: 14, color: colors.gray900, marginBottom: 16 }}>
            {fmtDate(startDate)} → {fmtDate(endDate)}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {weeks.map((w, i) => (
                <tr key={w.label} style={{ borderTop: i > 0 ? `1px solid ${colors.gray100}` : 'none' }}>
                  <td style={{ padding: '8px 0', fontSize: 14, fontWeight: 500, color: colors.gray900, width: 80 }}>{w.label}</td>
                  <td style={{ padding: '8px 0', fontSize: 14, color: colors.gray600 }}>{fmtDate(w.start)} – {fmtDate(w.end)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {[
          { label: 'Slack Messages in Sprint', value: msgCount },
          { label: 'Jira Tasks in Sprint',     value: taskCount },
        ].map((stat) => (
          <Card key={stat.label} style={{ marginBottom: 0, textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 600, color: colors.gray900, lineHeight: 1.2 }}>
              {stat.value === null ? <Spinner size={22} /> : stat.value}
            </div>
            <div style={{ fontSize: 12, color: colors.gray400, marginTop: 6 }}>{stat.label}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}
