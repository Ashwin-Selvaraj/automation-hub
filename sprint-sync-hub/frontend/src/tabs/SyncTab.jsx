import React, { useState, useEffect } from 'react';
import { theme, styles } from '../theme.js';
import { getSlackMessages, runSync, getSyncLog, postJiraComment, sendDM, getJiraIssues, getOverdueIssues } from '../api.js';
import Card, { SectionHeader } from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Badge from '../components/Badge.jsx';
import Avatar from '../components/Avatar.jsx';
import Spinner from '../components/Spinner.jsx';

const { colors, fonts } = theme;

function msgStatusVariant(status) {
  if (status === 'matched')  return 'success';
  if (status === 'no_match') return 'warning';
  return 'neutral';
}
function msgStatusLabel(status) {
  if (status === 'matched')  return 'Matched';
  if (status === 'no_match') return 'No Match';
  return 'Pending';
}

function MessageRow({ msg, index, config, log }) {
  const [expanded,     setExpanded]     = useState(false);
  const [commentText,  setCommentText]  = useState('');
  const [commenting,   setCommenting]   = useState(false);
  const [dming,        setDming]        = useState(false);
  const [actionResult, setActionResult] = useState('');

  const member     = config?.teamMembers?.find((m) => m.id === msg.userId);
  const memberName = member?.name || msg.userId || 'Unknown';
  const logEntry   = log.find((e) => e.slackMessageTs === msg.ts);
  const status     = logEntry?.type === 'match' ? 'matched' : logEntry?.type === 'no_match_dm' ? 'no_match' : 'pending';
  const jiraKey    = logEntry?.jiraKey;
  const date       = msg.date ? new Date(msg.date).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const preview    = (msg.text || '').replace(/\n/g, ' ').slice(0, 120);

  async function handleComment() {
    if (!jiraKey || !commentText.trim()) return;
    setCommenting(true);
    try { await postJiraComment(jiraKey, commentText); setActionResult(`Comment added to ${jiraKey}`); setCommentText(''); }
    catch (e) { setActionResult(`Error: ${e.message}`); }
    finally { setCommenting(false); }
  }

  async function handleDM() {
    if (!member?.id || !msg.text) return;
    setDming(true);
    try { await sendDM(member.id, msg.text); setActionResult('DM sent'); }
    catch (e) { setActionResult(`Error: ${e.message}`); }
    finally { setDming(false); }
  }

  return (
    <>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', cursor: 'pointer' }}
      >
        <Avatar name={memberName} size={28} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 500, color: colors.gray900 }}>{memberName}</span>
            <span style={{ fontSize: 13, color: colors.gray400, marginLeft: 'auto', flexShrink: 0 }}>{date}</span>
          </div>
          <p style={{ fontSize: 13, color: colors.gray600, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {preview}{(msg.text?.length || 0) > 120 ? '…' : ''}
          </p>
        </div>
        <Badge variant={msgStatusVariant(status)} style={{ flexShrink: 0, marginLeft: 8 }}>{msgStatusLabel(status)}</Badge>
        <span style={{ fontSize: 12, color: colors.gray400, flexShrink: 0, marginLeft: 4 }}>{expanded ? '▾' : '▸'}</span>
      </div>

      {expanded && (
        <div style={{ paddingLeft: 40, paddingBottom: 16 }}>
          <p style={{ fontSize: 13, color: colors.gray600, lineHeight: 1.7, marginBottom: 12, whiteSpace: 'pre-wrap' }}>{msg.text}</p>

          {logEntry && status === 'matched' && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ fontSize: 13, color: colors.blue600, marginBottom: 6 }}>
                Matched to <span style={{ fontFamily: fonts.mono }}>{logEntry.jiraKey}</span>
                {logEntry.action && <span style={{ marginLeft: 8 }}><Badge variant="info">{logEntry.action}</Badge></span>}
              </p>
              {logEntry.details && (
                <>
                  <p style={{ fontSize: 11, color: colors.gray400, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>AI Draft</p>
                  <div style={styles.aiBox}>{logEntry.details}</div>
                </>
              )}
            </div>
          )}
          {logEntry && status === 'no_match' && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ fontSize: 11, color: colors.gray400, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>AI Draft</p>
              <div style={styles.aiBox}>{logEntry.details || 'No match found for this update.'}</div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {jiraKey && (
              <>
                <input
                  value={commentText} onChange={(e) => setCommentText(e.target.value)}
                  placeholder={`Comment on ${jiraKey}…`}
                  style={{
                    height: 32, padding: '0 12px', borderRadius: 6, border: `1px solid ${colors.gray300}`,
                    fontSize: 13, fontFamily: fonts.body, outline: 'none', width: 240,
                  }}
                />
                <Button variant="primary" size="sm" onClick={handleComment} disabled={commenting || !commentText.trim()} style={{ display: 'flex', gap: 6 }}>
                  {commenting ? <Spinner size={12} /> : 'Add Jira Comment'}
                </Button>
              </>
            )}
            <Button variant="secondary" size="sm" onClick={handleDM} disabled={dming || !member?.id} style={{ display: 'flex', gap: 6 }}>
              {dming ? <Spinner size={12} /> : 'Send DM'}
            </Button>
          </div>
          {actionResult && <p style={{ fontSize: 12, color: colors.green600, marginTop: 6 }}>{actionResult}</p>}
        </div>
      )}
    </>
  );
}

function IssueRow({ issue, siteUrl, config }) {
  const [commentText, setCommentText] = useState('');
  const [commenting,  setCommenting]  = useState(false);
  const [dmSending,   setDmSending]   = useState(false);
  const [result,      setResult]      = useState('');
  const issueUrl = siteUrl ? `${siteUrl.replace(/\/$/, '')}/browse/${issue.key}` : null;
  const member   = config?.teamMembers?.find((m) => m.email === issue.assigneeEmail || m.name === issue.assigneeName);

  async function handleComment() {
    setCommenting(true);
    try { await postJiraComment(issue.key, commentText); setResult('Comment added'); setCommentText(''); }
    catch (e) { setResult(`Error: ${e.message}`); }
    finally { setCommenting(false); }
  }

  async function handleDM() {
    setDmSending(true);
    const msg = `Reminder: ${issue.key} — "${issue.summary}" is ${issue.daysOverdue ? issue.daysOverdue + ' day(s) overdue' : 'due'}. Please update: ${issueUrl || issue.key}`;
    try { await sendDM(member.id, msg); setResult('DM sent'); }
    catch (e) { setResult(`Error: ${e.message}`); }
    finally { setDmSending(false); }
  }

  const statusV = issue.status === 'Done' ? 'success' : issue.status === 'In Progress' ? 'info' : issue.daysOverdue ? 'error' : 'neutral';

  return (
    <tr style={{ borderBottom: `1px solid ${colors.gray100}` }}>
      <td style={{ padding: '10px 12px', fontFamily: fonts.mono, fontSize: 12, color: colors.blue600, whiteSpace: 'nowrap' }}>
        {issueUrl ? <a href={issueUrl} target="_blank" rel="noreferrer" style={{ color: colors.blue600, textDecoration: 'none' }}>{issue.key}</a> : issue.key}
      </td>
      <td style={{ padding: '10px 12px', fontSize: 13, color: colors.gray700, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{issue.summary}</td>
      <td style={{ padding: '10px 12px' }}><Badge variant={statusV}>{issue.status}</Badge></td>
      <td style={{ padding: '10px 12px', fontSize: 13, color: colors.gray600 }}>{issue.assigneeName || '—'}</td>
      {issue.daysOverdue !== undefined && <td style={{ padding: '10px 12px' }}><Badge variant="error">{issue.daysOverdue}d overdue</Badge></td>}
      <td style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Comment…"
            style={{ height: 28, padding: '0 10px', borderRadius: 6, border: `1px solid ${colors.gray300}`, fontSize: 12, outline: 'none', width: 120 }} />
          <Button variant="secondary" size="sm" onClick={handleComment} disabled={commenting || !commentText.trim()}>
            {commenting ? <Spinner size={10} /> : 'Add'}
          </Button>
          {member?.id && (
            <Button variant="secondary" size="sm" onClick={handleDM} disabled={dmSending}>
              {dmSending ? <Spinner size={10} /> : 'Remind'}
            </Button>
          )}
        </div>
        {result && <p style={{ fontSize: 11, color: colors.green600, marginTop: 4 }}>{result}</p>}
      </td>
    </tr>
  );
}

export default function SyncTab({ config }) {
  const [messages, setMessages] = useState([]);
  const [log,      setLog]      = useState([]);
  const [issues,   setIssues]   = useState([]);
  const [overdue,  setOverdue]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [syncing,  setSyncing]  = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [error,    setError]    = useState('');
  const siteUrl = config?.jiraSiteUrl || '';

  async function fetchData() {
    setLoading(true);
    try {
      const [msgData, logData, issData, ovData] = await Promise.all([
        getSlackMessages(14), getSyncLog(50), getJiraIssues(), getOverdueIssues(),
      ]);
      setMessages(msgData.messages || []);
      setLog(logData.entries || []);
      setIssues(issData.issues || []);
      setOverdue(ovData.issues || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { fetchData(); }, []);

  async function handleSync() {
    setSyncing(true); setSyncResult(null);
    try { const r = await runSync(); setSyncResult(r); await fetchData(); }
    catch (e) { setError(e.message); }
    finally { setSyncing(false); }
  }

  const pending = messages.filter((m) => !log.some((e) => e.slackMessageTs === m.ts));
  const thCols  = ['Key', 'Summary', 'Status', 'Assignee', 'Actions'];
  const thColsOD = ['Key', 'Summary', 'Status', 'Assignee', 'Overdue', 'Actions'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h1 style={styles.pageTitle}>Huddle → Jira Sync</h1>
        <p style={styles.subtitle}>Slack messages matched to Jira tasks in {config?.sprintName || 'this sprint'}.</p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <span style={{ fontSize: 14, color: colors.gray600 }}>
          {messages.length} message{messages.length !== 1 ? 's' : ''} · <span style={{ color: pending.length > 0 ? colors.amber600 : colors.gray400 }}>{pending.length} unprocessed</span>
        </span>
        <Button variant="primary" onClick={handleSync} disabled={syncing} style={{ display: 'flex', gap: 8 }}>
          {syncing ? <><Spinner size={14} /> Syncing…</> : 'Run Sync'}
        </Button>
      </div>

      {syncResult && (
        <div style={{ padding: '10px 16px', background: colors.green50, border: `1px solid #86EFAC`, borderRadius: 6, fontSize: 13, color: colors.green600 }}>
          Sync complete — Processed: {syncResult.processed} · Matched: {syncResult.matched} · No match: {syncResult.noMatch} · Errors: {syncResult.errors}
        </div>
      )}
      {error && (
        <div style={{ padding: '10px 16px', background: colors.red50, border: `1px solid #FCA5A5`, borderRadius: 6, fontSize: 13, color: colors.red600 }}>{error}</div>
      )}

      <Card padding="0" style={{ marginBottom: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${colors.gray100}` }}>
          <SectionHeader style={{ marginBottom: 0, paddingBottom: 0, borderBottom: 'none' }}>Messages</SectionHeader>
        </div>
        <div style={{ padding: '0 20px' }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner size={28} /></div>
          ) : messages.length === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center' }}>
              <p style={{ fontSize: 14, fontWeight: 500, color: colors.gray900 }}>No messages found</p>
              <p style={{ fontSize: 13, color: colors.gray400, marginTop: 4 }}>Make sure SLACK_CHANNEL_ID is configured and the sprint window is set.</p>
            </div>
          ) : (
            messages.map((msg, i) => (
              <div key={msg.ts} style={{ borderTop: i > 0 ? `1px solid ${colors.gray100}` : 'none' }}>
                <MessageRow msg={msg} index={i} config={config} log={log} />
              </div>
            ))
          )}
        </div>
      </Card>

      <Card padding="0" style={{ marginBottom: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${colors.gray100}` }}>
          <SectionHeader style={{ marginBottom: 0, paddingBottom: 0, borderBottom: 'none' }}>Activity Log</SectionHeader>
        </div>
        {log.length === 0 ? (
          <div style={{ padding: '32px 20px', textAlign: 'center' }}>
            <p style={{ fontSize: 13, color: colors.gray400 }}>No activity yet. Run a sync to see entries here.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Time', 'Member', 'Jira', 'Action', 'Status'].map((h) => (
                    <th key={h} style={{ fontSize: 11, fontWeight: 600, color: colors.gray600, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '8px 12px', borderBottom: `1px solid ${colors.gray200}`, textAlign: 'left', background: colors.white, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {log.slice(0, 20).map((e) => (
                  <tr key={e.id} style={{ borderBottom: `1px solid ${colors.gray100}` }}>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: colors.gray400, fontFamily: fonts.mono, whiteSpace: 'nowrap' }}>{new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                    <td style={{ padding: '10px 12px', fontSize: 14, color: colors.gray700 }}>{e.userName || '—'}</td>
                    <td style={{ padding: '10px 12px', fontFamily: fonts.mono, fontSize: 12, color: colors.blue600 }}>{e.jiraKey || '—'}</td>
                    <td style={{ padding: '10px 12px', fontSize: 13, color: colors.gray600, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.action}</td>
                    <td style={{ padding: '10px 12px' }}><Badge variant={e.success ? 'success' : 'error'}>{e.success ? 'OK' : 'Error'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {!loading && issues.length > 0 && (
        <Card padding="0" style={{ marginBottom: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: `1px solid ${colors.gray100}` }}>
            <SectionHeader style={{ marginBottom: 0, paddingBottom: 0, borderBottom: 'none' }}>Sprint Tasks ({issues.length})</SectionHeader>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{thCols.map((h) => <th key={h} style={{ fontSize: 11, fontWeight: 600, color: colors.gray600, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '8px 12px', borderBottom: `1px solid ${colors.gray200}`, textAlign: 'left', background: colors.white, whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
              <tbody>{issues.map((issue) => <IssueRow key={issue.key} issue={issue} siteUrl={siteUrl} config={config} />)}</tbody>
            </table>
          </div>
        </Card>
      )}

      {!loading && overdue.length > 0 && (
        <Card padding="0" style={{ marginBottom: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: `1px solid ${colors.gray100}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <SectionHeader style={{ marginBottom: 0, paddingBottom: 0, borderBottom: 'none' }}>Overdue Issues</SectionHeader>
            <Badge variant="error">{overdue.length}</Badge>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{thColsOD.map((h) => <th key={h} style={{ fontSize: 11, fontWeight: 600, color: colors.gray600, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '8px 12px', borderBottom: `1px solid ${colors.gray200}`, textAlign: 'left', background: colors.white, whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
              <tbody>{overdue.map((issue) => <IssueRow key={issue.key} issue={issue} siteUrl={siteUrl} config={config} />)}</tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
