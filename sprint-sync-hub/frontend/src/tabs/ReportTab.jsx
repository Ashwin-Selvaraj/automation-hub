import React, { useState, useEffect } from 'react';
import { COLORS, FONTS, card, aiBox, btnPrimary, btnSecondary } from '../config.js';
import { generateReport, postReport } from '../api.js';
import { Spinner } from '../App.jsx';

export default function ReportTab({ config }) {
  const [weekIndex, setWeekIndex] = useState(0);
  const [report, setReport] = useState('');
  const [memberActivity, setMemberActivity] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [posting, setPosting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [postResult, setPostResult] = useState('');

  const durationWeeks = config?.durationWeeks || 2;
  const tabs = [
    { index: 0, label: 'Full Sprint' },
    ...Array.from({ length: durationWeeks }, (_, i) => ({ index: i + 1, label: `Week ${i + 1}` })),
  ];

  async function handleGenerate() {
    setGenerating(true);
    setError('');
    setReport('');
    setMemberActivity([]);
    try {
      const data = await generateReport(weekIndex);
      setReport(data.report || '');
      setMemberActivity(data.memberActivity || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  async function handlePost() {
    if (!report) return;
    setPosting(true);
    setPostResult('');
    try {
      await postReport(report);
      setPostResult('Posted to Slack ✓');
    } catch (e) {
      setPostResult(`Error: ${e.message}`);
    } finally {
      setPosting(false);
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(report).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const channelName = config?.channelId || 'channel';
  const maxUpdates = Math.max(...memberActivity.map((m) => m.workingDays || 1), 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h2 style={{ fontFamily: FONTS.heading, fontSize: 20, fontWeight: 700, color: COLORS.text }}>Sprint Report</h2>
        <p style={{ color: COLORS.muted, fontSize: 14, marginTop: 4 }}>Generate a Claude-drafted sprint summary and post it to Slack.</p>
      </div>

      {/* Scope selector */}
      <div style={card}>
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Report Scope</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {tabs.map((t) => (
            <button
              key={t.index}
              onClick={() => { setWeekIndex(t.index); setReport(''); setError(''); }}
              style={{
                padding: '8px 18px', borderRadius: 8,
                border: weekIndex === t.index ? `1px solid ${COLORS.primary}` : `1px solid ${COLORS.border}`,
                background: weekIndex === t.index ? 'rgba(124,106,255,0.15)' : COLORS.surface,
                color: weekIndex === t.index ? COLORS.primary : COLORS.muted,
                fontFamily: FONTS.mono, fontSize: 13, cursor: 'pointer', transition: 'all 0.15s',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={handleGenerate} disabled={generating} style={{ ...btnPrimary, display: 'flex', alignItems: 'center', gap: 8 }}>
            {generating ? <><Spinner size={14} color="#fff" /> Generating…</> : '✨ Generate Report'}
          </button>
          {generating && <span style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted }}>Asking Claude to analyse the sprint…</span>}
        </div>
        {error && <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.error, marginTop: 10 }}>{error}</p>}
      </div>

      {/* Report output */}
      {report && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Generated Report</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleCopy} style={{ ...btnSecondary, fontSize: 12, padding: '7px 14px' }}>
                {copied ? '✓ Copied' : 'Copy'}
              </button>
              <button onClick={handlePost} disabled={posting} style={{ ...btnPrimary, fontSize: 12, padding: '7px 14px', display: 'flex', alignItems: 'center', gap: 6 }}>
                {posting ? <><Spinner size={12} color="#fff" /> Posting…</> : `Post to #${channelName}`}
              </button>
            </div>
          </div>
          <div style={aiBox}>{report}</div>
          {postResult && <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.success, marginTop: 10 }}>{postResult}</p>}
        </div>
      )}

      {/* Per-member bars */}
      {memberActivity.length > 0 && (
        <div style={card}>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 16 }}>Engagement Summary</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {memberActivity.map((m) => {
              const pct = Math.min(100, Math.round((m.updateCount / (m.workingDays || 1)) * 100));
              const barColor = pct >= 80 ? COLORS.success : pct >= 50 ? COLORS.warning : COLORS.error;
              return (
                <div key={m.name}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: 14, color: COLORS.text }}>{m.name}</span>
                    <span style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted }}>{m.updateCount}/{m.workingDays} updates</span>
                  </div>
                  <div style={{ height: 8, background: COLORS.surface, borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: 4, transition: 'width 0.4s ease' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
