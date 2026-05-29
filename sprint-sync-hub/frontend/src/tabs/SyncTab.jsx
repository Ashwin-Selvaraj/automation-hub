import React, { useState, useEffect } from 'react';
import { COLORS, FONTS, card, aiBox, btnPrimary, btnSecondary } from '../config.js';
import { getSlackMessages, runSync, getSyncLog, postJiraComment, sendDM } from '../api.js';
import { Spinner } from '../App.jsx';

const AVATAR_COLORS = ['#7C6AFF', '#00D9C8', '#FFC147', '#FF4757', '#00C896'];

function Avatar({ name, index }) {
  const initials = name ? name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2) : '??';
  return (
    <div style={{ width: 34, height: 34, borderRadius: '50%', background: AVATAR_COLORS[index % AVATAR_COLORS.length], display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONTS.mono, fontSize: 11, color: '#fff', flexShrink: 0 }}>
      {initials}
    </div>
  );
}

function StatusBadge({ status, jiraKey }) {
  if (status === 'matched') return (
    <span style={{ fontFamily: FONTS.mono, fontSize: 11, background: 'rgba(0,200,150,0.12)', color: COLORS.success, border: `1px solid ${COLORS.success}`, borderRadius: 4, padding: '2px 8px' }}>
      Matched → {jiraKey}
    </span>
  );
  if (status === 'no_match') return (
    <span style={{ fontFamily: FONTS.mono, fontSize: 11, background: 'rgba(255,193,71,0.12)', color: COLORS.warning, border: `1px solid ${COLORS.warning}`, borderRadius: 4, padding: '2px 8px' }}>
      No Match → DM sent
    </span>
  );
  return (
    <span style={{ fontFamily: FONTS.mono, fontSize: 11, background: 'rgba(90,91,117,0.2)', color: COLORS.muted, border: `1px solid ${COLORS.border}`, borderRadius: 4, padding: '2px 8px' }}>
      Pending
    </span>
  );
}

function MessageCard({ msg, index, config, log }) {
  const [expanded, setExpanded] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [dming, setDming] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [actionResult, setActionResult] = useState('');

  const member = config?.teamMembers?.find((m) => m.id === msg.userId);
  const memberName = member?.name || msg.userId || 'Unknown';

  const logEntry = log.find((e) => e.slackMessageTs === msg.ts);
  const status = logEntry?.type === 'match' ? 'matched' : logEntry?.type === 'no_match_dm' ? 'no_match' : 'pending';
  const jiraKey = logEntry?.jiraKey;

  const date = msg.date ? new Date(msg.date).toLocaleString() : '';
  const preview = (msg.text || '').split('\n').slice(0, 2).join(' ').substring(0, 120);

  async function handleComment() {
    if (!jiraKey || !commentText.trim()) return;
    setCommenting(true);
    try {
      await postJiraComment(jiraKey, commentText);
      setActionResult(`Comment added to ${jiraKey}`);
      setCommentText('');
    } catch (e) {
      setActionResult(`Error: ${e.message}`);
    } finally {
      setCommenting(false);
    }
  }

  async function handleDM() {
    if (!member?.id || !msg.text) return;
    setDming(true);
    try {
      await sendDM(member.id, msg.text);
      setActionResult('DM sent successfully');
    } catch (e) {
      setActionResult(`Error: ${e.message}`);
    } finally {
      setDming(false);
    }
  }

  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <Avatar name={memberName} index={index} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontWeight: 600, color: COLORS.text, fontSize: 14 }}>{memberName}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted }}>{date}</span>
              <StatusBadge status={status} jiraKey={jiraKey} />
            </div>
          </div>
          <p style={{ color: COLORS.muted, fontSize: 13, marginTop: 4, lineHeight: 1.5, wordBreak: 'break-word' }}>{preview}{msg.text?.length > 120 ? '…' : ''}</p>
        </div>
        <button onClick={() => setExpanded(!expanded)} style={{ background: 'none', border: 'none', color: COLORS.muted, cursor: 'pointer', fontSize: 14, flexShrink: 0, padding: 4 }}>
          {expanded ? '▼' : '▶'}
        </button>
      </div>

      {expanded && (
        <div style={{ padding: '0 16px 16px', borderTop: `1px solid ${COLORS.border}` }}>
          <div style={{ paddingTop: 14 }}>
            <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Full Message</p>
            <p style={{ color: COLORS.text, fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{msg.text}</p>
          </div>

          {logEntry && (
            <div style={{ marginTop: 14 }}>
              <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>AI Analysis</p>
              {status === 'matched' ? (
                <div style={aiBox}>
                  {`Issue: ${logEntry.jiraKey || '—'}\nAction: ${logEntry.action}\nDetails: ${logEntry.details || '—'}`}
                </div>
              ) : (
                <div>
                  <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted, marginBottom: 4 }}>DM sent to @{memberName}</p>
                  <div style={aiBox}>{logEntry.details || 'No match found for this update.'}</div>
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {jiraKey && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1, minWidth: 200 }}>
                <input
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  placeholder={`Comment on ${jiraKey}…`}
                  style={{ flex: 1, background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '8px 12px', color: COLORS.text, fontFamily: FONTS.body, fontSize: 13, outline: 'none' }}
                />
                <button onClick={handleComment} disabled={commenting || !commentText.trim()} style={{ ...btnSecondary, fontSize: 12, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {commenting ? <Spinner size={12} /> : 'Add Comment'}
                </button>
              </div>
            )}
            <button onClick={handleDM} disabled={dming || !member?.id} style={{ ...btnSecondary, fontSize: 12, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 6 }}>
              {dming ? <Spinner size={12} /> : `Send DM Manually`}
            </button>
          </div>
          {actionResult && <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.success, marginTop: 8 }}>{actionResult}</p>}
        </div>
      )}
    </div>
  );
}

export default function SyncTab({ config }) {
  const [messages, setMessages] = useState([]);
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [error, setError] = useState('');

  async function fetchData() {
    setLoading(true);
    try {
      const [msgData, logData] = await Promise.all([getSlackMessages(14), getSyncLog(50)]);
      setMessages(msgData.messages || []);
      setLog(logData.entries || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchData(); }, []);

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await runSync();
      setSyncResult(result);
      await fetchData();
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  }

  const pending = messages.filter((m) => !log.some((e) => e.slackMessageTs === m.ts));
  const matched = log.filter((e) => e.type === 'match').length;
  const noMatch = log.filter((e) => e.type === 'no_match_dm').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontFamily: FONTS.heading, fontSize: 20, fontWeight: 700, color: COLORS.text }}>Standup Sync</h2>
          <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
            {[
              { label: 'Messages', value: messages.length, color: COLORS.text },
              { label: 'Unprocessed', value: pending.length, color: COLORS.warning },
              { label: 'Matched', value: matched, color: COLORS.success },
              { label: 'No Match', value: noMatch, color: COLORS.error },
            ].map((s) => (
              <span key={s.label} style={{ fontFamily: FONTS.mono, fontSize: 12 }}>
                <span style={{ color: s.color, fontWeight: 500 }}>{s.value}</span>
                <span style={{ color: COLORS.muted }}> {s.label}</span>
              </span>
            ))}
          </div>
        </div>
        <button onClick={handleSync} disabled={syncing} style={{ ...btnPrimary, display: 'flex', alignItems: 'center', gap: 8 }}>
          {syncing ? <><Spinner size={14} color="#fff" /> Syncing…</> : '🔄 Run Sync Now'}
        </button>
      </div>

      {syncResult && (
        <div style={{ background: 'rgba(0,200,150,0.06)', border: `1px solid ${COLORS.success}`, borderRadius: 10, padding: 14, fontFamily: FONTS.mono, fontSize: 13, color: COLORS.success }}>
          Sync complete — Processed: {syncResult.processed} · Matched: {syncResult.matched} · No match: {syncResult.noMatch} · Errors: {syncResult.errors}
        </div>
      )}

      {error && <div style={{ background: 'rgba(255,71,87,0.06)', border: `1px solid ${COLORS.error}`, borderRadius: 10, padding: 14, fontFamily: FONTS.mono, fontSize: 13, color: COLORS.error }}>{error}</div>}

      {/* Message list */}
      <div>
        <h3 style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Channel Messages (last 14 days in sprint)</h3>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={32} /></div>
        ) : messages.length === 0 ? (
          <div style={{ ...card, textAlign: 'center', color: COLORS.muted, fontFamily: FONTS.mono, fontSize: 13, padding: 40 }}>
            No messages found in the current sprint window. Make sure SLACK_CHANNEL_ID is configured.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {messages.map((msg, i) => (
              <MessageCard key={msg.ts} msg={msg} index={i} config={config} log={log} />
            ))}
          </div>
        )}
      </div>

      {/* Activity log */}
      <div style={card}>
        <h3 style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>Activity Log</h3>
        {log.length === 0 ? (
          <p style={{ fontFamily: FONTS.mono, fontSize: 13, color: COLORS.muted }}>No activity yet. Run a sync to see entries here.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONTS.mono, fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                  {['Time', 'Type', 'User', 'Jira', 'Action', 'Status'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: COLORS.muted, fontWeight: 400, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {log.slice(0, 20).map((e) => (
                  <tr key={e.id} style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                    <td style={{ padding: '8px 10px', color: COLORS.muted, whiteSpace: 'nowrap' }}>{new Date(e.timestamp).toLocaleTimeString()}</td>
                    <td style={{ padding: '8px 10px', color: COLORS.secondary }}>{e.type}</td>
                    <td style={{ padding: '8px 10px', color: COLORS.text }}>{e.userName || '—'}</td>
                    <td style={{ padding: '8px 10px', color: COLORS.primary }}>{e.jiraKey || '—'}</td>
                    <td style={{ padding: '8px 10px', color: COLORS.muted, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.action}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{ color: e.success ? COLORS.success : COLORS.error }}>{e.success ? '✓' : '✗'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
