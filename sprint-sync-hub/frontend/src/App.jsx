import React, { useState, useEffect } from 'react';
import { COLORS, FONTS } from './config.js';
import { getConfig, getHealth } from './api.js';
import SprintTab from './tabs/SprintTab.jsx';
import ConnectionsTab from './tabs/ConnectionsTab.jsx';
import TeamTab from './tabs/TeamTab.jsx';
import SyncTab from './tabs/SyncTab.jsx';
import JiraTab from './tabs/JiraTab.jsx';
import ReportTab from './tabs/ReportTab.jsx';
import HowItWorksTab from './tabs/HowItWorksTab.jsx';

const TABS = [
  { id: 'sprint', label: '⚡ Sprint' },
  { id: 'connections', label: '🔌 Connections' },
  { id: 'team', label: '👥 Team' },
  { id: 'sync', label: '🔄 Sync' },
  { id: 'jira', label: '📋 Jira' },
  { id: 'report', label: '📊 Report' },
  { id: 'howto', label: '📖 How It Works' },
];

function StatusPill({ health, loading }) {
  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted }}>
      <Spinner size={12} /> Checking...
    </div>
  );
  if (!health) return null;
  const all = health.slack && health.jira && health.claude;
  const some = health.slack || health.jira || health.claude;
  const color = all ? COLORS.success : some ? COLORS.warning : COLORS.error;
  const label = all ? 'All Connected' : some ? 'Partial' : 'Disconnected';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 20, padding: '6px 14px' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
      <span style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.text }}>{label}</span>
    </div>
  );
}

export function Spinner({ size = 20, color = COLORS.primary }) {
  return (
    <div style={{
      width: size, height: size,
      border: `2px solid ${COLORS.border}`,
      borderTopColor: color,
      borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
      flexShrink: 0,
    }} />
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState('sprint');
  const [config, setConfig] = useState(null);
  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(true);

  useEffect(() => {
    getConfig().then(setConfig).catch(console.error);
    getHealth()
      .then(setHealth)
      .catch(() => setHealth({ slack: false, jira: false, claude: false, errors: {} }))
      .finally(() => setHealthLoading(false));
  }, []);

  const tabProps = { config, setConfig };

  return (
    <div style={{ minHeight: '100vh', background: COLORS.bg, display: 'flex', flexDirection: 'column' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Header */}
      <header style={{
        background: COLORS.surface,
        borderBottom: `1px solid ${COLORS.border}`,
        padding: '16px 32px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}>
        <div>
          <h1 style={{ fontFamily: FONTS.heading, fontSize: 22, fontWeight: 800, color: COLORS.text, letterSpacing: '-0.02em' }}>
            Sprint-Sync Hub
          </h1>
          <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted, marginTop: 2 }}>
            {config ? `${config.sprintName} · ${config.startDate} → ${config.endDate}` : 'Loading sprint info…'}
          </p>
        </div>
        <StatusPill health={health} loading={healthLoading} />
      </header>

      {/* Tab bar */}
      <div style={{
        background: COLORS.surface,
        borderBottom: `1px solid ${COLORS.border}`,
        padding: '0 32px',
        display: 'flex',
        gap: 4,
        overflowX: 'auto',
      }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: activeTab === tab.id ? COLORS.card : 'transparent',
              color: activeTab === tab.id ? COLORS.text : COLORS.muted,
              border: 'none',
              borderBottom: activeTab === tab.id ? `2px solid ${COLORS.primary}` : '2px solid transparent',
              padding: '12px 18px',
              fontFamily: FONTS.body,
              fontSize: 14,
              fontWeight: activeTab === tab.id ? 600 : 400,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'all 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <main style={{ flex: 1, padding: '32px', maxWidth: 1200, width: '100%', margin: '0 auto' }}>
        {activeTab === 'sprint' && <SprintTab {...tabProps} />}
        {activeTab === 'connections' && <ConnectionsTab {...tabProps} />}
        {activeTab === 'team' && <TeamTab {...tabProps} />}
        {activeTab === 'sync' && <SyncTab {...tabProps} />}
        {activeTab === 'jira' && <JiraTab {...tabProps} />}
        {activeTab === 'report' && <ReportTab {...tabProps} />}
        {activeTab === 'howto' && <HowItWorksTab />}
      </main>
    </div>
  );
}
