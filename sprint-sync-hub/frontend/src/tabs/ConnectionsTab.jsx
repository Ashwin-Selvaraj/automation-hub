import React, { useState, useEffect } from 'react';
import { COLORS, FONTS, card, label, hint, btnPrimary, btnSecondary } from '../config.js';
import { getHealth, getEnvStatus, postConnections } from '../api.js';
import { Spinner } from '../App.jsx';

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Top connection status badge (Connected / Error / Checking) */
function ConnectionBadge({ ok, loading }) {
  if (loading) return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted }}>
      <Spinner size={10} color={COLORS.muted} /> Checking…
    </span>
  );
  const color = ok ? COLORS.success : COLORS.error;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: ok ? 'rgba(0,200,150,0.1)' : 'rgba(255,71,87,0.1)',
      border: `1px solid ${color}`, borderRadius: 20,
      padding: '4px 14px', fontFamily: FONTS.mono, fontSize: 12, color,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, display: 'inline-block',
        boxShadow: ok ? `0 0 6px ${COLORS.success}` : 'none' }} />
      {ok ? 'Connected' : 'Error'}
    </span>
  );
}

/** Pill shown on a field that's already set via .env */
function SetBadge() {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      background: 'rgba(0,200,150,0.1)', border: `1px solid ${COLORS.success}`,
      borderRadius: 4, padding: '3px 10px',
      fontFamily: FONTS.mono, fontSize: 11, color: COLORS.success, flexShrink: 0,
    }}>
      ✓ Set in .env
    </span>
  );
}

/** Pill shown on a field that is missing from .env */
function MissingBadge() {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      background: 'rgba(255,193,71,0.1)', border: `1px solid ${COLORS.warning}`,
      borderRadius: 4, padding: '3px 10px',
      fontFamily: FONTS.mono, fontSize: 11, color: COLORS.warning, flexShrink: 0,
    }}>
      ⚠ Not set
    </span>
  );
}

/** Collapsible "How to get this" guide */
function HowTo({ steps }) {
  const [open, setOpen] = useState(false);
  if (!steps?.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{ background: 'none', border: 'none', color: COLORS.muted, fontFamily: FONTS.mono, fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, padding: 0 }}
      >
        {open ? '▼' : '▶'} How to get this
      </button>
      {open && (
        <ol style={{ marginTop: 8, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {steps.map((s, i) => (
            <li key={i} style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted, lineHeight: 1.6 }}>{s}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * A single credential field.
 *
 * secret=true  → value never leaves server. Shows masked preview when set.
 *                Input is locked. Change requires .env edit + restart.
 * secret=false → non-sensitive value. Shows current value pre-filled.
 *                User can edit and save live.
 */
function CredentialField({ fieldKey, label: lbl, secret, fieldData, hintText, steps, onChange, editingKey, setEditingKey }) {
  const isSet    = fieldData?.set ?? false;
  const preview  = fieldData?.preview ?? null;   // masked string, secrets only
  const value    = fieldData?.value   ?? '';      // actual value, non-secrets only
  const isEditing = editingKey === fieldKey;

  const [draft, setDraft] = useState(value);

  // Keep draft in sync if envStatus refreshes
  useEffect(() => { setDraft(value); }, [value]);

  function startEdit() { setDraft(value); setEditingKey(fieldKey); }
  function cancelEdit() { setDraft(value); setEditingKey(null); }
  function commitEdit() { onChange(fieldKey, draft.trim()); setEditingKey(null); }

  return (
    <div style={{ marginBottom: 18 }}>
      {/* Row: label + status badge */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontFamily: FONTS.mono, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: COLORS.muted }}>
          {lbl}
        </span>
        {isSet ? <SetBadge /> : <MissingBadge />}
      </div>

      {secret ? (
        /* ── SECRET FIELD ── locked, shows masked preview only */
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: COLORS.surface, border: `1px solid ${isSet ? COLORS.border : COLORS.warning}`,
          borderRadius: 8, padding: '9px 14px',
        }}>
          <span style={{ fontFamily: FONTS.mono, fontSize: 13, color: isSet ? COLORS.success : COLORS.muted, flex: 1, letterSpacing: '0.04em' }}>
            {isSet ? preview : 'Not configured'}
          </span>
          <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: COLORS.muted, background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 4, padding: '2px 8px', flexShrink: 0 }}>
            🔒 .env only
          </span>
        </div>
      ) : isEditing ? (
        /* ── NON-SECRET: editing state ── */
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') cancelEdit(); }}
            style={{
              flex: 1, background: COLORS.surface, border: `1px solid ${COLORS.primary}`,
              borderRadius: 8, padding: '9px 14px', color: COLORS.text,
              fontFamily: FONTS.mono, fontSize: 13, outline: 'none',
            }}
          />
          <button onClick={commitEdit} style={{ ...btnPrimary, fontSize: 12, padding: '8px 14px', flexShrink: 0 }}>Save</button>
          <button onClick={cancelEdit} style={{ ...btnSecondary, fontSize: 12, padding: '8px 12px', flexShrink: 0 }}>✕</button>
        </div>
      ) : (
        /* ── NON-SECRET: display state ── */
        <div
          onClick={startEdit}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, cursor: 'text',
            background: COLORS.surface,
            border: `1px solid ${isSet ? COLORS.border : COLORS.warning}`,
            borderRadius: 8, padding: '9px 14px',
            transition: 'border-color 0.15s',
          }}
          title="Click to edit"
        >
          <span style={{ fontFamily: FONTS.mono, fontSize: 13, color: isSet ? COLORS.text : COLORS.muted, flex: 1 }}>
            {isSet ? value : 'Click to configure…'}
          </span>
          <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: COLORS.muted, flexShrink: 0 }}>
            ✎ edit
          </span>
        </div>
      )}

      {hintText && (
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted, marginTop: 4, lineHeight: 1.5 }}>{hintText}</p>
      )}
      {secret && isSet && (
        <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted, marginTop: 4 }}>
          To change: edit <code style={{ color: COLORS.secondary }}>backend/.env</code> → restart the backend server.
        </p>
      )}
      {!isSet && <HowTo steps={steps} />}
    </div>
  );
}

// ─── Section definitions ──────────────────────────────────────────────────────

const SECTIONS = [
  {
    id: 'slack',
    icon: '💬',
    title: 'Slack',
    fields: [
      {
        key: 'slack.botToken',
        label: 'Bot Token',
        secret: true,
        dataPath: ['slack', 'botToken'],
        hint: 'Starts with xoxb-. Scopes needed: channels:history, chat:write, im:write, users:read',
        steps: ['Go to api.slack.com/apps', 'Create New App → From scratch', 'OAuth & Permissions → add scopes: channels:history, chat:write, im:write, users:read, users:read.email', 'Install to workspace → copy Bot User OAuth Token'],
      },
      {
        key: 'slack.channelId',
        label: 'Standup Channel ID',
        secret: false,
        dataPath: ['slack', 'channelId'],
        saveKey: 'channelId',
        hint: 'Right-click the channel in Slack → View channel details → copy the ID at the bottom (starts with C)',
      },
      {
        key: 'slack.signingSecret',
        label: 'Signing Secret',
        secret: true,
        dataPath: ['slack', 'signingSecret'],
        hint: 'App Settings → Basic Information → App Credentials → Signing Secret',
        steps: ['api.slack.com/apps → select your app', 'Basic Information → App Credentials', 'Copy the Signing Secret'],
      },
    ],
  },
  {
    id: 'jira',
    icon: '📋',
    title: 'Jira',
    fields: [
      {
        key: 'jira.email',
        label: 'Account Email',
        secret: false,
        dataPath: ['jira', 'email'],
        saveKey: 'jiraEmail',
        hint: 'The Atlassian email address that owns the API token below',
      },
      {
        key: 'jira.apiToken',
        label: 'API Token',
        secret: true,
        dataPath: ['jira', 'apiToken'],
        hint: 'Never use your password — generate a dedicated API token at id.atlassian.com',
        steps: ['Log in to id.atlassian.com', 'Security → API tokens → Create API token', 'Give it a name and copy the value (shown once)'],
      },
      {
        key: 'jira.siteUrl',
        label: 'Site URL',
        secret: false,
        dataPath: ['jira', 'siteUrl'],
        saveKey: 'jiraSiteUrl',
        hint: 'Your Atlassian domain, e.g. https://yourcompany.atlassian.net — no trailing slash',
      },
      {
        key: 'jira.cloudId',
        label: 'Cloud ID',
        secret: false,
        dataPath: ['jira', 'cloudId'],
        saveKey: 'jiraCloudId',
        hint: 'UUID for your Atlassian cloud instance — used by some Jira REST v3 endpoints',
        steps: [
          'Go to https://yourcompany.atlassian.net/_edge/tenant_info',
          'Copy the "cloudId" value from the JSON response',
        ],
      },
      {
        key: 'jira.projectKey',
        label: 'Project Key',
        secret: false,
        dataPath: ['jira', 'projectKey'],
        saveKey: 'projectKey',
        hint: 'The short prefix before issue numbers, e.g. QG for QG-42',
      },
    ],
  },
  {
    id: 'claude',
    icon: '🤖',
    title: 'Anthropic (Claude AI)',
    fields: [
      {
        key: 'claude.apiKey',
        label: 'API Key',
        secret: true,
        dataPath: ['claude', 'apiKey'],
        hint: 'Used for standup analysis and report generation. Model: claude-sonnet-4-20250514',
        steps: ['Go to console.anthropic.com', 'API Keys → Create Key', 'Copy the sk-ant-… value immediately — it is shown only once'],
      },
    ],
  },
  {
    id: 'schedule',
    icon: '🕐',
    title: 'Schedule & Notifications',
    fields: [
      {
        key: 'schedule.timezone',
        label: 'Timezone',
        secret: false,
        dataPath: ['schedule', 'timezone'],
        saveKey: 'timezone',
        hint: 'IANA timezone for all cron jobs, e.g. Asia/Kolkata, America/New_York, Europe/London',
      },
      {
        key: 'schedule.eodCheckTime',
        label: 'End-of-Day Check Time',
        secret: false,
        dataPath: ['schedule', 'eodCheckTime'],
        saveKey: 'eodCheckTime',
        hint: 'HH:MM — when to check for missing standup updates each weekday (e.g. 17:30)',
      },
      {
        key: 'schedule.reportDay',
        label: 'Weekly Report Day',
        secret: false,
        dataPath: ['schedule', 'reportDay'],
        saveKey: 'reportDay',
        hint: 'Day of week to post the sprint report, e.g. Friday',
      },
      {
        key: 'schedule.reportTime',
        label: 'Weekly Report Time',
        secret: false,
        dataPath: ['schedule', 'reportTime'],
        saveKey: 'reportTime',
        hint: 'HH:MM — time on the report day to post the weekly report (e.g. 17:00)',
      },
      {
        key: 'schedule.managerSlackId',
        label: 'Manager Slack ID',
        secret: false,
        dataPath: ['schedule', 'managerSlackId'],
        saveKey: 'managerSlackId',
        hint: 'Optional — Slack user ID of the manager who receives a DM copy of weekly reports',
      },
    ],
  },
];

// ─── Main component ───────────────────────────────────────────────────────────

export default function ConnectionsTab() {
  const [envStatus, setEnvStatus]     = useState(null);
  const [health, setHealth]           = useState(null);
  const [loading, setLoading]         = useState(true);
  const [testing, setTesting]         = useState(false);
  const [saving, setSaving]           = useState(false);
  const [saveMsg, setSaveMsg]         = useState('');
  const [editingKey, setEditingKey]   = useState(null);   // which field is in edit mode
  const [pendingSaves, setPendingSaves] = useState({});   // { saveKey: newValue }

  async function fetchStatus() {
    setLoading(true);
    try {
      const [env, h] = await Promise.all([
        getEnvStatus(),
        getHealth().catch(() => ({ slack: false, jira: false, claude: false, errors: {} })),
      ]);
      setEnvStatus(env);
      setHealth(h);
    } catch {
      /* backend not reachable */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchStatus(); }, []);

  /** Called when user saves an editable (non-secret) field */
  function handleFieldChange(fieldKey, newValue) {
    // Find the saveKey for this field
    let saveKey = null;
    for (const section of SECTIONS) {
      const f = section.fields.find((f) => f.key === fieldKey);
      if (f?.saveKey) { saveKey = f.saveKey; break; }
    }
    if (!saveKey) return;
    setPendingSaves((prev) => ({ ...prev, [saveKey]: newValue }));
  }

  /** Flush all pending saves to the backend */
  async function flushSaves(extra = {}) {
    const payload = { ...pendingSaves, ...extra };
    if (!Object.keys(payload).length) return;
    setSaving(true);
    setSaveMsg('');
    try {
      await postConnections(payload);
      setSaveMsg('Saved ✓ — values updated in runtime config');
      setPendingSaves({});
      await fetchStatus();          // re-fetch to reflect saved values
    } catch (e) {
      setSaveMsg(`Error: ${e.message}`);
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(''), 3000);
    }
  }

  // Auto-save whenever pendingSaves changes and editingKey becomes null (user clicked Save/Cancel)
  useEffect(() => {
    if (editingKey === null && Object.keys(pendingSaves).length > 0) {
      flushSaves();
    }
  }, [editingKey]);

  async function handleTest() {
    setTesting(true);
    try {
      const h = await getHealth();
      setHealth(h);
    } catch {
      setHealth({ slack: false, jira: false, claude: false, errors: {} });
    } finally {
      setTesting(false);
    }
  }

  /** Get field data from envStatus given a ['section', 'key'] path */
  function getFieldData(dataPath) {
    if (!envStatus) return null;
    return envStatus[dataPath[0]]?.[dataPath[1]] ?? null;
  }

  // Overall set-counts for each section
  function sectionSetCount(section) {
    return section.fields.filter((f) => getFieldData(f.dataPath)?.set).length;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* Header */}
      <div>
        <h2 style={{ fontFamily: FONTS.heading, fontSize: 20, fontWeight: 700, color: COLORS.text }}>
          Service Connections
        </h2>
        <p style={{ color: COLORS.muted, fontSize: 14, marginTop: 4 }}>
          Secrets live only in <code style={{ fontFamily: FONTS.mono, background: COLORS.surface, padding: '2px 6px', borderRadius: 4 }}>backend/.env</code> and are never sent to the browser.
          Non-sensitive values (channel ID, project key, etc.) can be updated directly here.
        </p>
      </div>

      {/* Security notice */}
      <div style={{ background: 'rgba(0,217,200,0.05)', border: `1px solid rgba(0,217,200,0.25)`, borderRadius: 12, padding: '14px 18px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 18, marginTop: 1 }}>🔒</span>
        <div>
          <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.secondary, fontWeight: 500 }}>
            Two types of fields — different rules apply
          </p>
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted, marginTop: 5, lineHeight: 1.7 }}>
            <span style={{ color: COLORS.success }}>🔒 .env only</span> — API tokens &amp; signing secrets. Shown masked. Must be changed in <strong style={{ color: COLORS.text }}>backend/.env</strong> then restart the server.{' '}
            <span style={{ color: COLORS.text }}>✎ Editable</span> — channel ID, emails, URLs, project key. Safe to update live from this panel; take effect immediately without a restart.
          </p>
        </div>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <Spinner size={28} />
        </div>
      )}

      {/* Sections */}
      {!loading && SECTIONS.map((section) => {
        const setCount   = sectionSetCount(section);
        const totalCount = section.fields.length;
        const allSet     = setCount === totalCount;
        // Schedule section has no live connection test — only Slack/Jira/Claude do
        const hasHealthCheck = ['slack', 'jira', 'claude'].includes(section.id);
        const sectionOk  = health?.[section.id] ?? false;

        return (
          <div key={section.id} style={{ ...card, padding: 0, overflow: 'hidden' }}>

            {/* Section header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: `1px solid ${COLORS.border}`,
              background: COLORS.surface,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20 }}>{section.icon}</span>
                <h3 style={{ fontFamily: FONTS.heading, fontSize: 15, fontWeight: 700, color: COLORS.text }}>
                  {section.title}
                </h3>
                {/* Field coverage pill */}
                <span style={{
                  fontFamily: FONTS.mono, fontSize: 11,
                  color: allSet ? COLORS.success : COLORS.warning,
                  background: allSet ? 'rgba(0,200,150,0.1)' : 'rgba(255,193,71,0.1)',
                  border: `1px solid ${allSet ? COLORS.success : COLORS.warning}`,
                  borderRadius: 20, padding: '2px 10px',
                }}>
                  {setCount}/{totalCount} configured
                </span>
              </div>
              {hasHealthCheck && <ConnectionBadge ok={sectionOk} loading={false} />}
            </div>

            {/* Fields */}
            <div style={{ padding: '20px 20px 8px' }}>
              {section.fields.map((f) => (
                <CredentialField
                  key={f.key}
                  fieldKey={f.key}
                  label={f.label}
                  secret={f.secret}
                  fieldData={getFieldData(f.dataPath)}
                  hintText={f.hint}
                  steps={f.steps}
                  onChange={handleFieldChange}
                  editingKey={editingKey}
                  setEditingKey={setEditingKey}
                />
              ))}
            </div>

            {/* Section-level error */}
            {health?.errors?.[section.id] && (
              <div style={{ margin: '0 20px 16px', padding: '10px 14px', background: 'rgba(255,71,87,0.06)', border: `1px solid ${COLORS.error}`, borderRadius: 8 }}>
                <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.error }}>
                  ✗ {health.errors[section.id]}
                </p>
              </div>
            )}
          </div>
        );
      })}

      {/* Save feedback */}
      {saveMsg && (
        <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: saveMsg.startsWith('Error') ? COLORS.error : COLORS.success }}>
          {saveMsg}
        </p>
      )}

      {/* Test all connections */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <button
          onClick={handleTest}
          disabled={testing || loading}
          style={{ ...btnPrimary, display: 'flex', alignItems: 'center', gap: 8 }}
        >
          {testing ? <><Spinner size={14} color="#fff" /> Testing…</> : '🧪 Test All Connections'}
        </button>

        {health && !testing && (
          <div style={{ display: 'flex', gap: 12 }}>
            {[
              { label: 'Slack',  ok: health.slack },
              { label: 'Jira',   ok: health.jira },
              { label: 'Claude', ok: health.claude },
            ].map(({ label: lbl, ok }) => (
              <span key={lbl} style={{ fontFamily: FONTS.mono, fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ color: ok ? COLORS.success : COLORS.error }}>{ok ? '●' : '○'}</span>
                <span style={{ color: COLORS.muted }}>{lbl}</span>
              </span>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
