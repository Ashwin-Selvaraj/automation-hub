import React, { useState, useEffect } from 'react';
import { COLORS, FONTS, card, label, input, hint, btnPrimary, btnSecondary } from '../config.js';
import { getHealth } from '../api.js';
import { Spinner } from '../App.jsx';

function StatusBadge({ ok, loading }) {
  if (loading) return <span style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted }}>Checking…</span>;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: ok ? 'rgba(0,200,150,0.1)' : 'rgba(255,71,87,0.1)',
      border: `1px solid ${ok ? COLORS.success : COLORS.error}`,
      borderRadius: 20, padding: '4px 12px',
      fontFamily: FONTS.mono, fontSize: 12,
      color: ok ? COLORS.success : COLORS.error,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: ok ? COLORS.success : COLORS.error, display: 'inline-block' }} />
      {ok ? 'Connected' : 'Error'}
    </span>
  );
}

function CollapsibleHow({ steps }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 12 }}>
      <button onClick={() => setOpen(!open)} style={{ background: 'none', border: 'none', color: COLORS.muted, fontFamily: FONTS.mono, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
        {open ? '▼' : '▶'} How to get this
      </button>
      {open && (
        <ol style={{ marginTop: 10, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {steps.map((step, i) => (
            <li key={i} style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted, lineHeight: 1.6 }}>{step}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Field({ lbl, name, placeholder, type = 'text', hintText, steps }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={label}>{lbl}</label>
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        style={{ ...input }}
        autoComplete="off"
      />
      <p style={hint}>{hintText}</p>
      {steps && <CollapsibleHow steps={steps} />}
    </div>
  );
}

export default function ConnectionsTab() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth({ slack: false, jira: false, claude: false, errors: {} })).finally(() => setLoading(false));
  }, []);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await getHealth();
      setHealth(result);
      setTestResult(result);
    } catch (e) {
      setTestResult({ error: e.message });
    } finally {
      setTesting(false);
    }
  }

  const sections = [
    {
      id: 'slack',
      icon: '💬',
      title: 'Slack',
      ok: health?.slack,
      fields: [
        { lbl: 'Bot Token', name: 'SLACK_BOT_TOKEN', placeholder: 'xoxb-…', type: 'password', hintText: 'Starts with xoxb-. Required scope: channels:history, chat:write, users:read, im:write', steps: ['Go to api.slack.com/apps', 'Create a new app → From scratch', 'Add OAuth scopes: channels:history, chat:write, im:write, users:read, users:read.email', 'Install app to workspace', 'Copy the Bot User OAuth Token'] },
        { lbl: 'Channel ID', name: 'SLACK_CHANNEL_ID', placeholder: 'Cxxxxxxxxxx', hintText: 'Right-click the channel in Slack → Copy link → the ID is at the end of the URL' },
        { lbl: 'Signing Secret', name: 'SLACK_SIGNING_SECRET', placeholder: 'your-signing-secret', type: 'password', hintText: 'Found in App Settings → Basic Information → App Credentials' },
      ],
    },
    {
      id: 'jira',
      icon: '📋',
      title: 'Jira',
      ok: health?.jira,
      fields: [
        { lbl: 'Email', name: 'JIRA_EMAIL', placeholder: 'admin@yourcompany.com', hintText: 'The email address of the Jira account that owns the API token' },
        { lbl: 'API Token', name: 'JIRA_API_TOKEN', placeholder: 'your-jira-api-token', type: 'password', hintText: 'Never use your password — generate a dedicated API token', steps: ['Log in to id.atlassian.com', 'Go to Security → API tokens', 'Create API token → copy the value'] },
        { lbl: 'Site URL', name: 'JIRA_SITE_URL', placeholder: 'https://yourcompany.atlassian.net', hintText: 'Your Atlassian domain — no trailing slash' },
        { lbl: 'Project Key', name: 'JIRA_PROJECT_KEY', placeholder: 'QG', hintText: 'The short key shown before issue numbers (e.g. QG-42)' },
      ],
    },
    {
      id: 'claude',
      icon: '🤖',
      title: 'Anthropic (Claude AI)',
      ok: health?.claude,
      fields: [
        { lbl: 'API Key', name: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-…', type: 'password', hintText: 'Your Anthropic API key — used for standup analysis and report generation', steps: ['Go to console.anthropic.com', 'API Keys → Create Key', 'Copy the sk-ant-… value immediately (shown only once)'] },
      ],
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h2 style={{ fontFamily: FONTS.heading, fontSize: 20, fontWeight: 700, color: COLORS.text }}>Service Connections</h2>
        <p style={{ color: COLORS.muted, fontSize: 14, marginTop: 4 }}>Credentials are stored only in the backend <code style={{ fontFamily: FONTS.mono, background: COLORS.surface, padding: '2px 6px', borderRadius: 4 }}>.env</code> file — never in your browser.</p>
      </div>

      {/* Security note */}
      <div style={{ background: 'rgba(0,217,200,0.06)', border: `1px solid ${COLORS.secondary}`, borderRadius: 12, padding: 16, display: 'flex', gap: 12 }}>
        <span style={{ fontSize: 20 }}>🔒</span>
        <div>
          <p style={{ fontFamily: FONTS.mono, fontSize: 13, color: COLORS.secondary, fontWeight: 500 }}>Credentials never leave your server</p>
          <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted, marginTop: 4, lineHeight: 1.6 }}>
            All API tokens (Slack, Jira, Anthropic) live exclusively in <strong style={{ color: COLORS.text }}>backend/.env</strong> on your machine.
            This dashboard only displays status — it never reads or stores secrets. Restart the backend after editing .env.
          </p>
        </div>
      </div>

      {sections.map((section) => (
        <div key={section.id} style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 22 }}>{section.icon}</span>
              <h3 style={{ fontFamily: FONTS.heading, fontSize: 16, fontWeight: 700, color: COLORS.text }}>{section.title}</h3>
            </div>
            <StatusBadge ok={section.ok} loading={loading} />
          </div>

          <div style={{ background: COLORS.surface, borderRadius: 10, padding: 16, marginBottom: 4 }}>
            <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.warning, marginBottom: 8 }}>⚠️ EDIT IN BACKEND/.ENV — NOT HERE</p>
            {section.fields.map((f) => (
              <Field key={f.name} {...f} />
            ))}
          </div>

          {health?.errors?.[section.id] && (
            <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.error, marginTop: 8 }}>
              Error: {health.errors[section.id]}
            </p>
          )}
        </div>
      ))}

      {/* Test button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <button onClick={handleTest} disabled={testing} style={{ ...btnPrimary, display: 'flex', alignItems: 'center', gap: 8 }}>
          {testing ? <><Spinner size={14} color="#fff" /> Testing…</> : '🧪 Test All Connections'}
        </button>
        {testResult && !testResult.error && (
          <span style={{ fontFamily: FONTS.mono, fontSize: 13, color: testResult.slack && testResult.jira && testResult.claude ? COLORS.success : COLORS.warning }}>
            Slack: {testResult.slack ? '✓' : '✗'} · Jira: {testResult.jira ? '✓' : '✗'} · Claude: {testResult.claude ? '✓' : '✗'}
          </span>
        )}
        {testResult?.error && <span style={{ fontFamily: FONTS.mono, fontSize: 13, color: COLORS.error }}>{testResult.error}</span>}
      </div>
    </div>
  );
}
