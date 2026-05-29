import React, { useState, useEffect } from 'react';
import { COLORS, FONTS, card, btnSecondary } from '../config.js';
import { getJiraIssues, getOverdueIssues, postJiraComment, sendDM } from '../api.js';
import { Spinner } from '../App.jsx';

const STATUS_COLORS = {
  'To Do': { bg: 'rgba(90,91,117,0.2)', text: COLORS.muted },
  'In Progress': { bg: 'rgba(255,193,71,0.15)', text: COLORS.warning },
  'In Review': { bg: 'rgba(124,106,255,0.15)', text: COLORS.primary },
  'Done': { bg: 'rgba(0,200,150,0.15)', text: COLORS.success },
};

const PRIORITY_COLORS = {
  'Highest': COLORS.error,
  'High': '#FF8C42',
  'Medium': COLORS.warning,
  'Low': COLORS.muted,
  'Lowest': COLORS.muted,
};

function StatusBadge({ status }) {
  const c = STATUS_COLORS[status] || { bg: 'rgba(90,91,117,0.2)', text: COLORS.muted };
  return (
    <span style={{ fontFamily: FONTS.mono, fontSize: 11, background: c.bg, color: c.text, borderRadius: 4, padding: '3px 8px' }}>
      {status}
    </span>
  );
}

function IssueCard({ issue, onComment, siteUrl }) {
  const [expanded, setExpanded] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [commenting, setCommenting] = useState(false);
  const [result, setResult] = useState('');

  async function handleComment() {
    if (!commentText.trim()) return;
    setCommenting(true);
    try {
      await postJiraComment(issue.key, commentText);
      setResult('Comment added ✓');
      setCommentText('');
    } catch (e) {
      setResult(`Error: ${e.message}`);
    } finally {
      setCommenting(false);
    }
  }

  const issueUrl = siteUrl ? `${siteUrl.replace(/\/$/, '')}/browse/${issue.key}` : null;

  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: 12 }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.primary, fontWeight: 500 }}>{issue.key}</span>
            <StatusBadge status={issue.status} />
            {issue.priority && (
              <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: PRIORITY_COLORS[issue.priority] || COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                ● {issue.priority}
              </span>
            )}
          </div>
          <p style={{ color: COLORS.text, fontSize: 14, lineHeight: 1.4 }}>{issue.summary}</p>
          {issue.assigneeName && (
            <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted, marginTop: 4 }}>Assignee: {issue.assigneeName}</p>
          )}
        </div>
        <span style={{ color: COLORS.muted, fontSize: 14, flexShrink: 0 }}>{expanded ? '▼' : '▶'}</span>
      </div>

      {expanded && (
        <div style={{ padding: '0 16px 16px', borderTop: `1px solid ${COLORS.border}` }}>
          {issueUrl && (
            <a href={issueUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 12, fontFamily: FONTS.mono, fontSize: 12, color: COLORS.secondary, textDecoration: 'none' }}>
              Open in Jira →
            </a>
          )}
          <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Add a comment…"
              style={{ flex: 1, background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '8px 12px', color: COLORS.text, fontFamily: FONTS.body, fontSize: 13, outline: 'none' }}
            />
            <button onClick={handleComment} disabled={commenting || !commentText.trim()} style={{ ...btnSecondary, fontSize: 12, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 6 }}>
              {commenting ? <Spinner size={12} /> : 'Comment'}
            </button>
          </div>
          {result && <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.success, marginTop: 6 }}>{result}</p>}
        </div>
      )}
    </div>
  );
}

function OverdueCard({ issue, config, siteUrl }) {
  const [dmSending, setDmSending] = useState(false);
  const [dmResult, setDmResult] = useState('');

  const member = config?.teamMembers?.find(
    (m) => m.email === issue.assigneeEmail || m.name === issue.assigneeName
  );
  const issueUrl = siteUrl ? `${siteUrl.replace(/\/$/, '')}/browse/${issue.key}` : null;

  async function handleReminder() {
    if (!member?.id) return;
    setDmSending(true);
    try {
      const msg = `⚠️ Reminder: *${issue.key}* — "${issue.summary}" is ${issue.daysOverdue} day(s) overdue. Please update it: ${issueUrl || issue.key}`;
      await sendDM(member.id, msg);
      setDmResult('DM sent ✓');
    } catch (e) {
      setDmResult(`Error: ${e.message}`);
    } finally {
      setDmSending(false);
    }
  }

  return (
    <div style={{ ...card, borderLeft: `3px solid ${COLORS.error}`, padding: '14px 16px' }}>
      <div style={{ display: 'flex', align: 'flex-start', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.primary }}>{issue.key}</span>
            <span style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.error, background: 'rgba(255,71,87,0.1)', borderRadius: 4, padding: '2px 8px' }}>
              {issue.daysOverdue}d overdue
            </span>
          </div>
          <p style={{ color: COLORS.text, fontSize: 14, lineHeight: 1.4 }}>{issue.summary}</p>
          {issue.assigneeName && (
            <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted, marginTop: 4 }}>Assignee: {issue.assigneeName}</p>
          )}
          {issue.duedate && (
            <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted }}>Due: {issue.duedate}</p>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
          <button onClick={handleReminder} disabled={dmSending || !member?.id} style={{ ...btnSecondary, fontSize: 12, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 6, borderColor: COLORS.error, color: COLORS.error }}>
            {dmSending ? <Spinner size={12} /> : '📩 Send Reminder'}
          </button>
          {!member && <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: COLORS.muted }}>No Slack ID mapped</span>}
          {dmResult && <span style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.success }}>{dmResult}</span>}
        </div>
      </div>
    </div>
  );
}

export default function JiraTab({ config }) {
  const [issues, setIssues] = useState([]);
  const [overdue, setOverdue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const siteUrl = config?.jiraSiteUrl || '';

  useEffect(() => {
    Promise.all([getJiraIssues(), getOverdueIssues()])
      .then(([issData, ovData]) => {
        setIssues(issData.issues || []);
        setOverdue(ovData.issues || []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={36} /></div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h2 style={{ fontFamily: FONTS.heading, fontSize: 20, fontWeight: 700, color: COLORS.text }}>Jira Board</h2>
        <p style={{ color: COLORS.muted, fontSize: 14, marginTop: 4 }}>Issues updated within the current sprint window.</p>
      </div>

      {error && (
        <div style={{ background: 'rgba(255,71,87,0.06)', border: `1px solid ${COLORS.error}`, borderRadius: 10, padding: 14, fontFamily: FONTS.mono, fontSize: 13, color: COLORS.error }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: overdue.length ? '1fr 1fr' : '1fr', gap: 24 }}>
        {/* Sprint tasks */}
        <div>
          <h3 style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
            Active Sprint Tasks ({issues.length})
          </h3>
          {issues.length === 0 ? (
            <div style={{ ...card, textAlign: 'center', color: COLORS.muted, fontFamily: FONTS.mono, fontSize: 13, padding: 32 }}>
              No issues found in this sprint window.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {issues.map((issue) => (
                <IssueCard key={issue.key} issue={issue} onComment={postJiraComment} siteUrl={siteUrl} />
              ))}
            </div>
          )}
        </div>

        {/* Overdue */}
        {overdue.length > 0 && (
          <div>
            <h3 style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.error, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
              Overdue ({overdue.length})
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {overdue.map((issue) => (
                <OverdueCard key={issue.key} issue={issue} config={config} siteUrl={siteUrl} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
