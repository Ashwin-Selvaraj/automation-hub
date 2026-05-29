import React, { useState, useEffect } from 'react';
import { COLORS, FONTS, card, label, input, hint, btnPrimary, btnSecondary } from '../config.js';
import { postSprintConfig, getSlackMessages, getJiraIssues } from '../api.js';
import { Spinner } from '../App.jsx';

const DURATION_OPTIONS = [
  { weeks: 1, label: '1 Week', desc: '5 working days' },
  { weeks: 2, label: '2 Weeks', desc: '10 working days (most common)' },
  { weeks: 3, label: '3 Weeks', desc: '15 working days' },
];

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export default function SprintTab({ config, setConfig }) {
  const [sprintName, setSprintName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [durationWeeks, setDurationWeeks] = useState(2);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
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
    getJiraIssues().then((d) => setTaskCount(d.issues?.length ?? 0)).catch(() => setTaskCount('—'));
  }, []);

  const endDate = startDate ? addDays(startDate, durationWeeks * 7 - 1) : null;

  const weeks = [];
  if (startDate) {
    for (let i = 0; i < durationWeeks; i++) {
      const ws = addDays(startDate, i * 7);
      const we = addDays(startDate, i * 7 + 6);
      weeks.push({ label: `Week ${i + 1}`, start: ws, end: we });
    }
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      await postSprintConfig({ sprintName, startDate, durationWeeks });
      setConfig((c) => ({ ...c, sprintName, startDate, durationWeeks, endDate }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h2 style={{ fontFamily: FONTS.heading, fontSize: 20, fontWeight: 700, color: COLORS.text }}>Sprint Configuration</h2>
        <p style={{ color: COLORS.muted, fontSize: 14, marginTop: 4 }}>Set the sprint dates that filter all Slack messages and Jira tasks.</p>
      </div>

      {/* Duration selector */}
      <div style={card}>
        <p style={{ ...label, marginBottom: 12 }}>Sprint Duration</p>
        <div style={{ display: 'flex', gap: 12 }}>
          {DURATION_OPTIONS.map((opt) => (
            <button
              key={opt.weeks}
              onClick={() => setDurationWeeks(opt.weeks)}
              style={{
                flex: 1,
                padding: '20px 16px',
                borderRadius: 12,
                border: durationWeeks === opt.weeks ? `2px solid ${COLORS.primary}` : `1px solid ${COLORS.border}`,
                background: durationWeeks === opt.weeks ? 'rgba(124,106,255,0.12)' : COLORS.surface,
                cursor: 'pointer',
                textAlign: 'center',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ fontFamily: FONTS.heading, fontSize: 22, fontWeight: 700, color: durationWeeks === opt.weeks ? COLORS.primary : COLORS.text }}>
                {opt.label}
              </div>
              <div style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted, marginTop: 4 }}>{opt.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Form fields */}
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div>
          <label style={label}>Sprint Name</label>
          <input
            value={sprintName}
            onChange={(e) => setSprintName(e.target.value)}
            style={{ ...input }}
            placeholder="e.g. Sprint 12"
          />
          <p style={hint}>Used in Jira comments and the weekly report header.</p>
        </div>
        <div>
          <label style={label}>Sprint Start Date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{ ...input, colorScheme: 'dark' }}
          />
          <p style={hint}>End date is calculated automatically based on duration.</p>
        </div>
        {endDate && (
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1, background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '10px 14px' }}>
              <p style={{ ...label, marginBottom: 2 }}>Start</p>
              <p style={{ fontFamily: FONTS.mono, fontSize: 14, color: COLORS.secondary }}>{formatDate(startDate)}</p>
            </div>
            <div style={{ flex: 1, background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '10px 14px' }}>
              <p style={{ ...label, marginBottom: 2 }}>End</p>
              <p style={{ fontFamily: FONTS.mono, fontSize: 14, color: COLORS.secondary }}>{formatDate(endDate)}</p>
            </div>
          </div>
        )}
        {error && <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.error }}>{error}</p>}
        <button onClick={handleSave} disabled={saving} style={{ ...btnPrimary, alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 8 }}>
          {saving ? <><Spinner size={14} color="#fff" /> Saving…</> : saved ? '✓ Saved' : 'Save Sprint'}
        </button>
      </div>

      {/* Week breakdown */}
      {weeks.length > 0 && (
        <div style={card}>
          <p style={{ ...label, marginBottom: 12 }}>Sprint Breakdown</p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONTS.mono, fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                {['Week', 'Start', 'End', 'Days'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', padding: '8px 12px', color: COLORS.muted, fontWeight: 400, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={w.label} style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                  <td style={{ padding: '10px 12px', color: COLORS.primary, fontWeight: 500 }}>{w.label}</td>
                  <td style={{ padding: '10px 12px', color: COLORS.text }}>{formatDate(w.start)}</td>
                  <td style={{ padding: '10px 12px', color: COLORS.text }}>{formatDate(w.end)}</td>
                  <td style={{ padding: '10px 12px', color: COLORS.muted }}>5 working days</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Live stats */}
      <div style={{ display: 'flex', gap: 16 }}>
        {[
          { label: 'Messages in Sprint', value: msgCount, color: COLORS.secondary },
          { label: 'Jira Tasks in Sprint', value: taskCount, color: COLORS.primary },
        ].map((stat) => (
          <div key={stat.label} style={{ ...card, flex: 1, textAlign: 'center' }}>
            <div style={{ fontFamily: FONTS.heading, fontSize: 36, fontWeight: 700, color: stat.color }}>
              {stat.value === null ? <Spinner /> : stat.value}
            </div>
            <div style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted, marginTop: 6 }}>{stat.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
