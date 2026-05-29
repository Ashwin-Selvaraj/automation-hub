import React, { useState } from 'react';
import { theme, styles } from '../theme.js';
import { generateReport, postReport } from '../api.js';
import Card, { SectionHeader } from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Spinner from '../components/Spinner.jsx';

const { colors, fonts } = theme;

function ScopeSelector({ tabs, active, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${colors.gray200}`, marginBottom: 20 }}>
      {tabs.map((t) => {
        const isActive = active === t.index;
        return (
          <button
            key={t.index}
            onClick={() => onChange(t.index)}
            style={{
              padding: '8px 16px', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 14, fontFamily: fonts.body,
              color: isActive ? colors.blue600 : colors.gray400,
              fontWeight: isActive ? 500 : 400,
              borderBottom: `2px solid ${isActive ? colors.blue600 : 'transparent'}`,
              marginBottom: -1, outline: 'none',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function MemberBreakdown({ memberActivity }) {
  if (!memberActivity.length) return null;
  return (
    <Card style={{ marginBottom: 0 }}>
      <SectionHeader>Member Breakdown</SectionHeader>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Member', 'Updates Posted', 'Working Days', 'Coverage'].map((h) => (
              <th key={h} style={{
                fontSize: 11, fontWeight: 600, color: colors.gray600, textTransform: 'uppercase',
                letterSpacing: '0.05em', padding: '8px 12px', borderBottom: `1px solid ${colors.gray200}`,
                textAlign: 'left', background: colors.white,
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {memberActivity.map((m, i) => (
            <tr key={m.name} style={{ borderBottom: i < memberActivity.length - 1 ? `1px solid ${colors.gray100}` : 'none' }}>
              <td style={{ padding: '10px 12px', fontSize: 14, fontWeight: 500, color: colors.gray900 }}>{m.name}</td>
              <td style={{ padding: '10px 12px', fontSize: 14, color: colors.gray700, textAlign: 'center' }}>{m.updateCount}</td>
              <td style={{ padding: '10px 12px', fontSize: 14, color: colors.gray700, textAlign: 'center' }}>{m.workingDays}</td>
              <td style={{ padding: '10px 12px', fontSize: 14, color: colors.gray900, fontFamily: fonts.mono }}>
                {m.updateCount} / {m.workingDays}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export default function ReportTab({ config }) {
  const [weekIndex,      setWeekIndex]      = useState(0);
  const [report,         setReport]         = useState('');
  const [memberActivity, setMemberActivity] = useState([]);
  const [generating,     setGenerating]     = useState(false);
  const [posting,        setPosting]        = useState(false);
  const [copied,         setCopied]         = useState(false);
  const [error,          setError]          = useState('');
  const [postResult,     setPostResult]     = useState('');

  const durationWeeks = config?.durationWeeks || 2;
  const tabs = [
    { index: 0, label: 'Full Sprint' },
    ...Array.from({ length: durationWeeks }, (_, i) => ({ index: i + 1, label: `Week ${i + 1}` })),
  ];

  async function handleGenerate() {
    setGenerating(true); setError(''); setReport(''); setMemberActivity([]);
    try {
      const data = await generateReport(weekIndex);
      setReport(data.report || ''); setMemberActivity(data.memberActivity || []);
    } catch (e) { setError(e.message); }
    finally { setGenerating(false); }
  }

  async function handlePost() {
    if (!report) return;
    setPosting(true); setPostResult('');
    try { await postReport(report); setPostResult('Posted to Slack'); }
    catch (e) { setPostResult(`Error: ${e.message}`); }
    finally { setPosting(false); }
  }

  function handleCopy() {
    navigator.clipboard.writeText(report).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    });
  }

  const channelName = config?.channelId || 'channel';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h1 style={styles.pageTitle}>Weekly Report</h1>
        <p style={styles.subtitle}>Generate a Claude-drafted sprint summary and post it to Slack.</p>
      </div>

      <Card style={{ marginBottom: 0 }}>
        <ScopeSelector tabs={tabs} active={weekIndex} onChange={(i) => { setWeekIndex(i); setReport(''); setError(''); }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button variant="primary" onClick={handleGenerate} disabled={generating} style={{ display: 'inline-flex', gap: 8 }}>
            {generating ? <><Spinner size={14} /> Generating…</> : 'Generate Report'}
          </Button>
          {generating && <span style={{ fontSize: 13, color: colors.gray400 }}>Asking Claude to analyse the sprint…</span>}
        </div>

        {error && <p style={{ fontSize: 13, color: colors.red600, marginTop: 12 }}>{error}</p>}
      </Card>

      {report && (
        <Card style={{ marginBottom: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <SectionHeader style={{ marginBottom: 0, paddingBottom: 0, borderBottom: 'none' }}>Generated Report</SectionHeader>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="secondary" size="sm" onClick={handleCopy}>{copied ? '✓ Copied' : 'Copy'}</Button>
              <Button variant="secondary" size="sm" onClick={handlePost} disabled={posting} style={{ display: 'inline-flex', gap: 6 }}>
                {posting ? <><Spinner size={12} /> Posting…</> : `Post to #${channelName}`}
              </Button>
            </div>
          </div>
          <p style={{ fontSize: 11, color: colors.gray400, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>AI Draft</p>
          <div style={styles.aiBox}>{report}</div>
          {postResult && (
            <p style={{ fontSize: 13, color: postResult.startsWith('Error') ? colors.red600 : colors.green600, marginTop: 10 }}>
              {postResult.startsWith('Error') ? '✗' : '✓'} {postResult}
            </p>
          )}
        </Card>
      )}

      <MemberBreakdown memberActivity={memberActivity} />
    </div>
  );
}
