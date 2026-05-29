import React, { useState, useEffect } from 'react';
import { theme, styles } from '../theme.js';
import { getHealth, getEnvStatus, postConnections } from '../api.js';
import Card, { SectionHeader } from '../components/Card.jsx';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import Spinner from '../components/Spinner.jsx';
import CredentialField from '../components/CredentialField.jsx';

const { colors, fonts } = theme;

const SECTIONS = [
  {
    id: 'slack', title: 'Slack', hasTest: true,
    fields: [
      { key: 'slack.botToken',      label: 'Bot Token',          secret: true,  dataPath: ['slack','botToken'],      hint: 'Starts with xoxb-. Scopes needed: channels:history, chat:write, im:write, users:read', steps: ['Go to api.slack.com/apps', 'Create New App → From scratch', 'OAuth & Permissions → add scopes: channels:history, chat:write, im:write, users:read, users:read.email', 'Install to workspace → copy Bot User OAuth Token'] },
      { key: 'slack.channelId',     label: 'Standup Channel ID', secret: false, dataPath: ['slack','channelId'],     saveKey: 'channelId',     hint: 'Right-click the channel in Slack → View channel details → copy the ID at the bottom (starts with C)' },
      { key: 'slack.signingSecret', label: 'Signing Secret',     secret: true,  dataPath: ['slack','signingSecret'], hint: 'App Settings → Basic Information → App Credentials → Signing Secret', steps: ['api.slack.com/apps → select your app', 'Basic Information → App Credentials', 'Copy the Signing Secret'] },
    ],
  },
  {
    id: 'jira', title: 'Jira', hasTest: true,
    fields: [
      { key: 'jira.email',      label: 'Account Email', secret: false, dataPath: ['jira','email'],      saveKey: 'jiraEmail',   hint: 'The Atlassian email address that owns the API token below' },
      { key: 'jira.apiToken',   label: 'API Token',     secret: true,  dataPath: ['jira','apiToken'],   hint: 'Generate at id.atlassian.com → Security → API tokens (shown once)', steps: ['Log in to id.atlassian.com', 'Security → API tokens → Create API token', 'Give it a name and copy the value'] },
      { key: 'jira.siteUrl',    label: 'Site URL',      secret: false, dataPath: ['jira','siteUrl'],    saveKey: 'jiraSiteUrl', hint: 'Your Atlassian domain, e.g. https://yourcompany.atlassian.net — no trailing slash' },
      { key: 'jira.cloudId',    label: 'Cloud ID',      secret: false, dataPath: ['jira','cloudId'],    saveKey: 'jiraCloudId', hint: 'UUID for your cloud instance. Find it at: https://yourcompany.atlassian.net/_edge/tenant_info', steps: ['Go to https://yourcompany.atlassian.net/_edge/tenant_info', 'Copy the cloudId value from the JSON'] },
      { key: 'jira.projectKey', label: 'Project Key',   secret: false, dataPath: ['jira','projectKey'], saveKey: 'projectKey',  hint: 'Short prefix before issue numbers, e.g. QG for QG-42' },
    ],
  },
  {
    id: 'claude', title: 'Anthropic', hasTest: true,
    fields: [
      { key: 'claude.apiKey', label: 'API Key', secret: true, dataPath: ['claude','apiKey'], hint: 'Model: claude-sonnet-4-20250514. Used for standup analysis and report generation.', steps: ['Go to console.anthropic.com', 'API Keys → Create Key', 'Copy the sk-ant-… value immediately'] },
    ],
  },
  {
    id: 'schedule', title: 'Schedule & Notifications', hasTest: false,
    fields: [
      { key: 'schedule.timezone',       label: 'Timezone',              secret: false, dataPath: ['schedule','timezone'],       saveKey: 'timezone',       hint: 'IANA timezone for all cron jobs, e.g. Asia/Kolkata, America/New_York, Europe/London' },
      { key: 'schedule.eodCheckTime',   label: 'End-of-Day Check Time', secret: false, dataPath: ['schedule','eodCheckTime'],   saveKey: 'eodCheckTime',   hint: 'HH:MM — when to check for missing standup updates each weekday (e.g. 17:30)' },
      { key: 'schedule.reportDay',      label: 'Weekly Report Day',     secret: false, dataPath: ['schedule','reportDay'],      saveKey: 'reportDay',      hint: 'Day of week to post the sprint report, e.g. Friday' },
      { key: 'schedule.reportTime',     label: 'Weekly Report Time',    secret: false, dataPath: ['schedule','reportTime'],     saveKey: 'reportTime',     hint: 'HH:MM — time on the report day to post the weekly report (e.g. 17:00)' },
      { key: 'schedule.managerSlackId', label: 'Manager Slack ID',      secret: false, dataPath: ['schedule','managerSlackId'], saveKey: 'managerSlackId', hint: 'Optional — Slack user ID of the manager who receives a DM copy of the weekly report' },
    ],
  },
];

export default function ConnectionsTab() {
  const [envStatus,    setEnvStatus]    = useState(null);
  const [health,       setHealth]       = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [testing,      setTesting]      = useState(false);
  const [testResult,   setTestResult]   = useState(null);
  const [editingKey,   setEditingKey]   = useState(null);
  const [pendingSaves, setPendingSaves] = useState({});
  const [saving,       setSaving]       = useState(false);
  const [saveMsg,      setSaveMsg]      = useState('');

  async function fetchStatus() {
    setLoading(true);
    try {
      const [env, h] = await Promise.all([
        getEnvStatus(),
        getHealth().catch(() => ({ slack: false, jira: false, claude: false, errors: {} })),
      ]);
      setEnvStatus(env); setHealth(h);
    } finally { setLoading(false); }
  }

  useEffect(() => { fetchStatus(); }, []);

  function handleFieldChange(fieldKey, newValue) {
    let saveKey = null;
    for (const s of SECTIONS) {
      const f = s.fields.find((f) => f.key === fieldKey);
      if (f?.saveKey) { saveKey = f.saveKey; break; }
    }
    if (!saveKey) return;
    setPendingSaves((prev) => ({ ...prev, [saveKey]: newValue }));
  }

  async function flushSaves() {
    const payload = { ...pendingSaves };
    if (!Object.keys(payload).length) return;
    setSaving(true); setSaveMsg('');
    try {
      await postConnections(payload);
      setSaveMsg('Saved — values updated in runtime config.');
      setPendingSaves({});
      await fetchStatus();
    } catch (e) { setSaveMsg(`Error: ${e.message}`); }
    finally { setSaving(false); setTimeout(() => setSaveMsg(''), 3500); }
  }

  useEffect(() => {
    if (editingKey === null && Object.keys(pendingSaves).length > 0) flushSaves();
  }, [editingKey]);

  async function handleTest() {
    setTesting(true); setTestResult(null);
    try {
      const h = await getHealth(); setHealth(h);
      const all = h.slack && h.jira && h.claude;
      setTestResult({ ok: all, msg: all ? 'All services connected.' : 'One or more services failed.' });
    } catch { setTestResult({ ok: false, msg: 'Could not reach backend.' }); }
    finally { setTesting(false); }
  }

  function getFieldData(dataPath) { return envStatus?.[dataPath[0]]?.[dataPath[1]] ?? null; }
  function sectionSetCount(section) { return section.fields.filter((f) => getFieldData(f.dataPath)?.set).length; }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h1 style={styles.pageTitle}>Connections</h1>
        <p style={{ ...styles.subtitle, fontStyle: 'italic', marginTop: 6 }}>
          Credentials are stored in your backend .env file and never sent to the browser.
        </p>
      </div>

      {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner size={28} /></div>}

      {!loading && SECTIONS.map((section) => {
        const setCount = sectionSetCount(section);
        const total    = section.fields.length;
        const allSet   = setCount === total;
        const sectionOk = health?.[section.id] ?? false;

        return (
          <Card key={section.id} padding="0" style={{ marginBottom: 0, overflow: 'hidden' }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 20px', borderBottom: `1px solid ${colors.gray100}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: colors.gray900 }}>{section.title}</span>
                <span style={{ fontSize: 12, color: allSet ? colors.green600 : colors.amber600, fontFamily: fonts.body }}>
                  {setCount}/{total} configured
                </span>
              </div>
              {section.hasTest && (
                <Badge variant={sectionOk ? 'success' : 'neutral'}>{sectionOk ? 'Connected' : 'Not tested'}</Badge>
              )}
            </div>
            <div style={{ padding: '20px 20px 4px' }}>
              {section.fields.map((f) => (
                <CredentialField
                  key={f.key} fieldKey={f.key} label={f.label} secret={f.secret}
                  fieldData={getFieldData(f.dataPath)} hintText={f.hint} steps={f.steps}
                  onChange={handleFieldChange} editingKey={editingKey} setEditingKey={setEditingKey}
                />
              ))}
            </div>
            {health?.errors?.[section.id] && (
              <div style={{ margin: '0 20px 16px', padding: '10px 14px', background: colors.red50, border: `1px solid #FCA5A5`, borderRadius: 6 }}>
                <p style={{ fontSize: 13, color: colors.red600, fontFamily: fonts.body }}>{health.errors[section.id]}</p>
              </div>
            )}
          </Card>
        );
      })}

      {saveMsg && !loading && (
        <p style={{ fontSize: 13, color: saveMsg.startsWith('Error') ? colors.red600 : colors.green600, fontFamily: fonts.body }}>
          {saveMsg}
        </p>
      )}

      {!loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={handleTest} disabled={testing} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {testing ? <><Spinner size={14} /> Testing…</> : 'Test All Connections'}
          </Button>
          {testResult && (
            <span style={{ fontSize: 13, color: testResult.ok ? colors.green600 : colors.red600, fontFamily: fonts.body }}>
              {testResult.ok ? '✓' : '✗'} {testResult.msg}
            </span>
          )}
          {health && !testing && (
            <div style={{ display: 'flex', gap: 12, marginLeft: 4 }}>
              {[['Slack', health.slack], ['Jira', health.jira], ['Claude', health.claude]].map(([lbl, ok]) => (
                <span key={lbl} style={{ fontSize: 13, color: ok ? colors.green600 : colors.gray400, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: ok ? colors.green600 : colors.gray300, display: 'inline-block' }} />
                  {lbl}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
