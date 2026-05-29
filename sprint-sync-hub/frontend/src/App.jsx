import React, { useState, useEffect } from 'react';
import { theme } from './theme.js';
import { getConfig, getHealth } from './api.js';
import OverviewTab    from './tabs/OverviewTab.jsx';
import ConnectionsTab from './tabs/ConnectionsTab.jsx';
import TeamTab        from './tabs/TeamTab.jsx';
import SprintTab      from './tabs/SprintTab.jsx';
import SyncTab        from './tabs/SyncTab.jsx';
import ReportTab      from './tabs/ReportTab.jsx';

const { colors, fonts } = theme;

const NAV = [
  { id: 'overview',    label: 'Overview'     },
  { id: 'connections', label: 'Connections'  },
  { id: 'team',        label: 'Team'         },
  { id: 'sprint',      label: 'Sprint'       },
  { id: 'sync',        label: 'Sync'         },
  { id: 'report',      label: 'Report'       },
];

function useWindowWidth() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const fn = () => setW(window.innerWidth);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  return w;
}

function NavItem({ id, label, active, onClick }) {
  const [hovered, setHovered] = useState(false);
  const isActive = active === id;
  return (
    <button
      onClick={() => onClick(id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        background: isActive ? colors.blue50 : hovered ? colors.gray100 : 'transparent',
        color: isActive ? colors.blue600 : colors.gray600,
        border: 'none',
        borderLeft: `2px solid ${isActive ? colors.blue600 : 'transparent'}`,
        padding: '0 16px', height: 36,
        fontSize: 13, fontWeight: 500, fontFamily: fonts.body,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

export default function App() {
  const [active, setActive]         = useState('overview');
  const [config, setConfig]         = useState(null);
  const [health, setHealth]         = useState(null);
  const [healthLoading, setHL]      = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const width   = useWindowWidth();
  const mobile  = width < 768;

  useEffect(() => {
    getConfig().then(setConfig).catch(console.error);
    getHealth()
      .then(setHealth)
      .catch(() => setHealth({ slack: false, jira: false, claude: false, errors: {} }))
      .finally(() => setHL(false));
  }, []);

  const all      = health?.slack && health?.jira && health?.claude;
  const dotColor = healthLoading ? colors.gray400 : all ? colors.green600 : colors.red600;
  const tabProps = { config, setConfig };

  function navigate(id) { setActive(id); if (mobile) setMobileOpen(false); }

  const sidebar = (
    <nav style={{
      width: mobile ? 220 : 220, background: colors.gray50,
      borderRight: `1px solid ${colors.gray200}`,
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      padding: '16px 0',
      position: mobile ? 'fixed' : 'sticky',
      top: 56, height: 'calc(100vh - 56px)',
      zIndex: mobile ? 150 : 1,
      flexShrink: 0, overflowY: 'auto',
    }}>
      <div>
        {NAV.map((item) => (
          <NavItem key={item.id} id={item.id} label={item.label} active={active} onClick={navigate} />
        ))}
      </div>
      <div style={{ padding: '0 16px 8px', fontSize: 11, color: colors.gray400, fontFamily: fonts.body }}>
        v1.0.0
      </div>
    </nav>
  );

  return (
    <div style={{ minHeight: '100vh', background: colors.gray50, fontFamily: fonts.body }}>
      {/* Top bar */}
      <div style={{
        height: 56, background: colors.white, borderBottom: `1px solid ${colors.gray200}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 24px', position: 'sticky', top: 0, zIndex: 200,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {mobile && (
            <button onClick={() => setMobileOpen(!mobileOpen)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: colors.gray600, padding: '4px 8px 4px 0', lineHeight: 1 }}>
              ☰
            </button>
          )}
          {/* Shield logo mark */}
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
            <path d="M12 2L4 5.5V11c0 5.25 3.5 9.65 8 11 4.5-1.35 8-5.75 8-11V5.5L12 2z" fill={colors.blue600} />
            <path d="M8.5 11.5l2.5 2.5 4.5-4.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span style={{ fontSize: 15, fontWeight: 700, color: colors.blue600, letterSpacing: '-0.01em' }}>Sprint-Sync</span>
          <span style={{ color: colors.gray200, fontSize: 14, padding: '0 2px' }}>·</span>
          <span style={{ fontSize: 14, color: colors.gray400 }}>{config?.sprintName || '—'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontFamily: fonts.body }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, display: 'inline-block' }} />
          <span style={{ color: dotColor }}>
            {healthLoading ? 'Checking…' : all ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', minHeight: 'calc(100vh - 56px)' }}>
        {(!mobile || mobileOpen) && sidebar}

        {mobile && mobileOpen && (
          <div onClick={() => setMobileOpen(false)}
            style={{ position: 'fixed', inset: 0, top: 56, background: 'rgba(0,0,0,0.25)', zIndex: 140 }} />
        )}

        <main style={{ flex: 1, padding: mobile ? 16 : 32, minWidth: 0 }}>
          <div style={{ maxWidth: 880, margin: '0 auto' }}>
            {active === 'overview'    && <OverviewTab    {...tabProps} />}
            {active === 'connections' && <ConnectionsTab {...tabProps} />}
            {active === 'team'        && <TeamTab        {...tabProps} />}
            {active === 'sprint'      && <SprintTab      {...tabProps} />}
            {active === 'sync'        && <SyncTab        {...tabProps} />}
            {active === 'report'      && <ReportTab      {...tabProps} />}
          </div>
        </main>
      </div>
    </div>
  );
}
