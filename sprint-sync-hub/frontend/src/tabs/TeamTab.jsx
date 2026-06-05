import React, { useState, useEffect, useRef, useCallback } from 'react';
import { theme, styles } from '../theme.js';
import {
  getMembers, getRoles, updateMemberRoles,
  syncAll, fetchSlackEmails, fetchJiraIds,
  setMemberJiraId, postTeamMembers,
} from '../api.js';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Avatar from '../components/Avatar.jsx';
import Spinner from '../components/Spinner.jsx';

const { colors, fonts } = theme;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getInitials(name) {
  if (!name) return '??';
  return name.trim().split(/\s+/).map((w) => w[0] || '').join('').toUpperCase().slice(0, 2);
}

// Deterministic colour from name string
function nameToColor(name) {
  const palette = ['#6366F1','#0EA5E9','#8B5CF6','#EC4899','#F59E0B','#10B981','#EF4444','#06B6D4','#F97316','#14B8A6'];
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

// ─── Role Pill ────────────────────────────────────────────────────────────────

function RolePill({ role, pending, onRemove }) {
  // pending: 'add' | 'remove' | null
  const colour = pending === 'remove' ? colors.gray300
    : pending === 'add'    ? '#D97706'
    : role.colour || '#6366F1';

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: colour + '20', color: colour,
      border: `1px solid ${colour}55`,
      borderRadius: 4, padding: '2px 6px',
      fontSize: 11, fontWeight: 600,
      textDecoration: pending === 'remove' ? 'line-through' : 'none',
      opacity: pending === 'remove' ? 0.65 : 1,
      whiteSpace: 'nowrap',
    }}>
      {pending === 'add' && <span style={{ fontSize: 10 }}>+</span>}
      {role.name}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(role.id); }}
          title="Remove role"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: colour, padding: 0, lineHeight: 1, fontSize: 13, marginLeft: 1 }}
        >×</button>
      )}
    </span>
  );
}

// ─── Add Role Dropdown ────────────────────────────────────────────────────────

function AddRoleDropdown({ availableRoles, onAdd, onClose }) {
  const ref = useRef(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  if (!availableRoles.length) return null;

  return (
    <div ref={ref} style={{
      position: 'absolute', zIndex: 50, top: '100%', left: 0,
      background: colors.white, border: `1px solid ${colors.gray200}`,
      borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
      minWidth: 180, padding: '4px 0', marginTop: 4,
    }}>
      {availableRoles.map((role) => (
        <button
          key={role.id}
          onClick={() => { onAdd(role.id); onClose(); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            padding: '6px 12px', border: 'none', background: 'transparent',
            cursor: 'pointer', textAlign: 'left', fontSize: 13, color: colors.gray700,
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = colors.gray50}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: role.colour, flexShrink: 0 }} />
          {role.name}
        </button>
      ))}
    </div>
  );
}

// ─── Jira ID Cell ─────────────────────────────────────────────────────────────

function JiraIdCell({ member, onSaved }) {
  const [editing,  setEditing]  = useState(false);
  const [value,    setValue]    = useState('');
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');

  async function handleSave() {
    if (!value.trim()) return;
    setSaving(true); setError('');
    try {
      await setMemberJiraId(member.id, value.trim());
      setEditing(false);
      onSaved(member.id, value.trim(), 'manual');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (member.jiraAccountId) {
    const isManual = member.jiraAccountIdSource === 'manual';
    const short    = member.jiraAccountId.slice(0, 8) + '...';
    return (
      <span title={member.jiraAccountId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.gray400 }}>{short}</span>
        {isManual && (
          <span style={{ fontSize: 10, background: colors.amber50, color: colors.amber600, border: `1px solid #FCD34D`, borderRadius: 3, padding: '1px 4px', fontWeight: 600 }}>
            manual
          </span>
        )}
      </span>
    );
  }

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input
            autoFocus
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditing(false); }}
            placeholder="24-char alphanumeric"
            style={{
              padding: '3px 6px', border: `1px solid ${colors.gray300}`, borderRadius: 4,
              fontSize: 11, fontFamily: fonts.mono, width: 160, outline: 'none',
            }}
          />
          <Button variant="primary" size="sm" onClick={handleSave} disabled={saving || !value.trim()}>
            {saving ? '…' : 'Save'}
          </Button>
          <button onClick={() => setEditing(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: colors.gray400 }}>✕</button>
        </div>
        {error && <span style={{ fontSize: 11, color: colors.red600 }}>{error}</span>}
        <span style={{ fontSize: 10, color: colors.gray400 }}>Find in Jira: Profile → Account settings</span>
      </div>
    );
  }

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 12, color: colors.amber600 }}>⚠ Not found</span>
      <button
        onClick={() => { setEditing(true); setValue(''); }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: colors.blue600, textDecoration: 'underline', padding: 0 }}
      >
        Enter ID
      </button>
    </span>
  );
}

// ─── Member Row ───────────────────────────────────────────────────────────────

const MemberRow = React.memo(function MemberRow({
  member, allRoles, pendingChange, onRoleChange, onJiraIdSaved, isLast,
}) {
  const [showRoleDropdown, setShowRoleDropdown] = useState(false);

  // Compute which role IDs are currently "live" (including pending changes)
  const originalIds = member.roles.map((r) => r.id);
  const currentIds  = pendingChange ? pendingChange.newRoleIds : originalIds;

  // Roles to display: show all originalIds (with pending state) + new pending adds
  const displayRoles = allRoles.filter((r) =>
    currentIds.includes(r.id) || originalIds.includes(r.id)
  );
  const availableRoles = allRoles.filter((r) => !currentIds.includes(r.id));

  function handleRemove(roleId) {
    const next = currentIds.filter((id) => id !== roleId);
    onRoleChange(member.id, member.name, next);
  }

  function handleAdd(roleId) {
    if (!currentIds.includes(roleId)) {
      onRoleChange(member.id, member.name, [...currentIds, roleId]);
    }
  }

  const hasPending = !!pendingChange;

  return (
    <tr style={{ borderBottom: isLast ? 'none' : `1px solid ${colors.gray100}`, background: hasPending ? '#FFFBEB' : 'transparent' }}>

      {/* Member */}
      <td style={{ padding: '10px 12px', verticalAlign: 'middle', minWidth: 160 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            width: 28, height: 28, borderRadius: '50%',
            background: nameToColor(member.name),
            color: '#fff', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0,
          }}>
            {getInitials(member.name)}
          </span>
          <div style={{ minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 500, color: colors.gray900, display: 'block' }}>
              {member.name}
              {hasPending && <span style={{ marginLeft: 6, width: 7, height: 7, borderRadius: '50%', background: colors.amber600, display: 'inline-block', verticalAlign: 'middle' }} title="Unsaved changes" />}
            </span>
            <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.gray400 }}>
              {member.slackUserId}
            </span>
          </div>
        </div>
      </td>

      {/* Roles */}
      <td style={{ padding: '10px 12px', verticalAlign: 'middle' }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', position: 'relative' }}>
          {displayRoles.map((role) => {
            const isAdd    = pendingChange && !originalIds.includes(role.id) && currentIds.includes(role.id);
            const isRemove = pendingChange && originalIds.includes(role.id) && !currentIds.includes(role.id);
            return (
              <RolePill
                key={role.id}
                role={role}
                pending={isAdd ? 'add' : isRemove ? 'remove' : null}
                onRemove={isRemove ? null : handleRemove}
              />
            );
          })}

          {/* Add role button */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setShowRoleDropdown((v) => !v)}
              style={{
                background: 'none', border: `1px dashed ${colors.gray300}`, borderRadius: 4,
                cursor: 'pointer', padding: '2px 7px', fontSize: 11, color: colors.gray400,
                lineHeight: 1.4,
              }}
            >
              + role
            </button>
            {showRoleDropdown && (
              <AddRoleDropdown
                availableRoles={availableRoles}
                onAdd={handleAdd}
                onClose={() => setShowRoleDropdown(false)}
              />
            )}
          </div>
        </div>
      </td>

      {/* Email */}
      <td style={{ padding: '10px 12px', verticalAlign: 'middle', minWidth: 180 }}>
        {member.email
          ? <span style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.gray600 }}>{member.email}</span>
          : <span style={{ fontSize: 12, color: colors.gray300 }}>—</span>
        }
      </td>

      {/* Jira ID */}
      <td style={{ padding: '10px 12px', verticalAlign: 'middle', minWidth: 160 }}>
        <JiraIdCell
          member={member}
          onSaved={onJiraIdSaved}
        />
      </td>

      {/* Status */}
      <td style={{ padding: '10px 12px', verticalAlign: 'middle', width: 80 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: member.isActive ? colors.green600 : colors.gray400 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: member.isActive ? colors.green600 : colors.gray300 }} />
          {member.isActive ? 'Active' : 'Inactive'}
        </span>
      </td>
    </tr>
  );
});

// ─── Pending Changes Bar ──────────────────────────────────────────────────────

function PendingBar({ pendingChanges, allRoles, isSaving, saveResult, onSaveAll, onDiscard }) {
  const entries  = Object.entries(pendingChanges);
  const count    = entries.length;
  if (!count && !saveResult) return null;

  const roleById = Object.fromEntries(allRoles.map((r) => [r.id, r]));

  function describeDiff(change) {
    const added   = change.newRoleIds.filter((id) => !change.originalRoleIds.includes(id));
    const removed = change.originalRoleIds.filter((id) => !change.newRoleIds.includes(id));
    const parts   = [];
    if (added.length)   parts.push(added.map((id)   => `+${roleById[id]?.name || id}`).join(', '));
    if (removed.length) parts.push(removed.map((id) => `−${roleById[id]?.name || id}`).join(', '));
    return parts.join(', ');
  }

  return (
    <div style={{
      position: 'sticky', bottom: 0, left: 0, right: 0,
      background: '#FFFBEB',
      border: `1px solid #FCD34D`,
      borderRadius: 8,
      padding: '12px 16px',
      boxShadow: '0 -2px 12px rgba(0,0,0,0.08)',
      marginTop: 16,
    }}>
      {count > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: colors.amber600, marginBottom: 4 }}>
                {count} unsaved role change{count !== 1 ? 's' : ''}
              </p>
              <p style={{ fontSize: 12, color: colors.gray600, lineHeight: 1.6 }}>
                {entries.map(([, ch]) => `${ch.memberName} (${describeDiff(ch)})`).join('  ·  ')}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
              <button
                onClick={onDiscard}
                disabled={isSaving}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: colors.gray600, textDecoration: 'underline', padding: '4px 0' }}
              >
                Discard
              </button>
              <Button variant="primary" size="sm" onClick={onSaveAll} disabled={isSaving}>
                {isSaving ? <><Spinner size={12} />&nbsp; Saving…</> : `Save All Changes (${count})`}
              </Button>
            </div>
          </div>
        </>
      )}

      {saveResult && (
        <p style={{
          marginTop: count > 0 ? 8 : 0,
          fontSize: 12,
          color: saveResult.errors.length === 0 ? colors.green600
            : saveResult.savedCount > 0          ? colors.amber600
            : colors.red600,
        }}>
          {saveResult.errors.length === 0
            ? `✓ Saved roles for ${saveResult.savedCount} member${saveResult.savedCount !== 1 ? 's' : ''}`
            : saveResult.savedCount > 0
              ? `✓ Saved ${saveResult.savedCount}, ✗ Failed ${saveResult.errors.length} — ${saveResult.errors.map((e) => `${e.memberName}: ${e.error}`).join(', ')}`
              : `✗ Save failed — ${saveResult.errors.map((e) => e.error).join(', ')}`
          }
        </p>
      )}
    </div>
  );
}

// ─── Main Tab ─────────────────────────────────────────────────────────────────

export default function TeamTab() {
  const [members,        setMembers]        = useState([]);
  const [allRoles,       setAllRoles]       = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [pendingChanges, setPendingChanges] = useState({});
  const [isSaving,       setIsSaving]       = useState(false);
  const [saveResult,     setSaveResult]     = useState(null);
  const [syncing,        setSyncing]        = useState(false);
  const [syncResult,     setSyncResult]     = useState(null);
  const saveResultTimer = useRef(null);

  // ─── Load members + roles ───────────────────────────────────────────────────
  const loadMembers = useCallback(async () => {
    try {
      const [mems, roles] = await Promise.all([
        getMembers(),
        getRoles().catch(() => []),
      ]);
      setMembers(mems);
      setAllRoles(roles);
    } catch (err) {
      console.error('[TeamTab] loadMembers failed:', err.message);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    loadMembers().finally(() => setLoading(false));
  }, [loadMembers]);

  // ─── Role change (local pending state only — no API call yet) ──────────────
  function handleRoleChange(memberId, memberName, newRoleIds) {
    const member      = members.find((m) => m.id === memberId);
    const originalIds = (member?.roles || []).map((r) => r.id);

    // If new set equals original, remove the pending entry (no change)
    const isDirty = JSON.stringify([...newRoleIds].sort()) !== JSON.stringify([...originalIds].sort());
    if (!isDirty) {
      setPendingChanges((prev) => {
        const next = { ...prev };
        delete next[memberId];
        return next;
      });
      return;
    }
    setPendingChanges((prev) => ({
      ...prev,
      [memberId]: { originalRoleIds: originalIds, newRoleIds, memberName },
    }));
  }

  // ─── Save all pending changes ───────────────────────────────────────────────
  async function handleSaveAll() {
    setIsSaving(true);
    setSaveResult(null);
    const results = { saved: [], errors: [] };

    for (const [memberIdStr, change] of Object.entries(pendingChanges)) {
      const memberId = parseInt(memberIdStr, 10);
      try {
        await updateMemberRoles(memberId, change.newRoleIds);
        results.saved.push({ memberId, memberName: change.memberName });
      } catch (err) {
        results.errors.push({ memberId, memberName: change.memberName, error: err.message });
      }
    }

    setIsSaving(false);

    // Remove successfully saved entries from pending
    if (results.errors.length === 0) {
      setPendingChanges({});
    } else {
      const failedIds = new Set(results.errors.map((e) => String(e.memberId)));
      setPendingChanges((prev) => {
        const kept = {};
        Object.entries(prev).forEach(([id, ch]) => { if (failedIds.has(id)) kept[id] = ch; });
        return kept;
      });
    }

    // Reload member data to reflect saved roles
    await loadMembers();

    const result = { success: results.errors.length === 0, savedCount: results.saved.length, errors: results.errors };
    setSaveResult(result);

    // Auto-dismiss save result after 5 s
    clearTimeout(saveResultTimer.current);
    saveResultTimer.current = setTimeout(() => setSaveResult(null), 5000);
  }

  // ─── Discard pending changes ────────────────────────────────────────────────
  function handleDiscard() {
    setPendingChanges({});
    setSaveResult(null);
  }

  // ─── Jira ID inline saved ───────────────────────────────────────────────────
  function handleJiraIdSaved(memberId, jiraAccountId, source) {
    setMembers((prev) =>
      prev.map((m) =>
        m.id === memberId ? { ...m, jiraAccountId, jiraAccountIdSource: source } : m
      )
    );
  }

  // ─── Sync from Slack & Jira ─────────────────────────────────────────────────
  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await syncAll();
      setSyncResult(res);
      await loadMembers(); // reload to show new emails/IDs
    } catch (err) {
      setSyncResult({ error: err.message });
    } finally {
      setSyncing(false);
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────
  const pendingCount = Object.keys(pendingChanges).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 80 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={styles.pageTitle}>Team Members</h1>
          <p style={{ ...styles.subtitle, marginTop: 2 }}>
            {loading ? '—' : `${members.length} member${members.length !== 1 ? 's' : ''}`}
            {pendingCount > 0 && (
              <span style={{ marginLeft: 10, fontSize: 12, color: colors.amber600, fontWeight: 500 }}>
                · {pendingCount} unsaved change{pendingCount !== 1 ? 's' : ''}
              </span>
            )}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={handleSync} disabled={syncing}>
          {syncing ? <><Spinner size={12} />&nbsp; Syncing…</> : 'Sync from Slack & Jira'}
        </Button>
      </div>

      {/* Sync result banner */}
      {syncResult && !syncResult.error && (
        <div style={{ padding: '10px 14px', background: colors.green50, border: `1px solid #86EFAC`, borderRadius: 6, fontSize: 12, color: colors.green600 }}>
          {[
            syncResult.slackEmails?.fetched?.length > 0 && `✓ ${syncResult.slackEmails.fetched.length} email${syncResult.slackEmails.fetched.length !== 1 ? 's' : ''} fetched from Slack`,
            syncResult.slackEmails?.failed?.length  > 0 && `✗ ${syncResult.slackEmails.failed.length} emails failed`,
            syncResult.jiraIds?.matched?.length     > 0 && `✓ ${syncResult.jiraIds.matched.length} Jira ID${syncResult.jiraIds.matched.length !== 1 ? 's' : ''} matched`,
            syncResult.jiraIds?.notFound?.length    > 0 && `⚠ ${syncResult.jiraIds.notFound.length} member${syncResult.jiraIds.notFound.length !== 1 ? 's' : ''} need manual Jira ID`,
          ].filter(Boolean).join('  ·  ') || 'Nothing to sync — all members already have emails and Jira IDs.'}
        </div>
      )}
      {syncResult?.error && (
        <div style={{ padding: '10px 14px', background: '#FEF2F2', border: `1px solid #FECACA`, borderRadius: 6, fontSize: 12, color: colors.red600 }}>
          ✗ Sync failed: {syncResult.error}
        </div>
      )}

      {/* Table */}
      <Card padding="0" style={{ overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center' }}><Spinner size={24} /></div>
        ) : members.length === 0 ? (
          <div style={{ padding: '40px 0', textAlign: 'center' }}>
            <p style={{ fontSize: 14, fontWeight: 500, color: colors.gray900 }}>No team members yet</p>
            <p style={{ fontSize: 13, color: colors.gray400, marginTop: 4 }}>
              Add members via the config or Bulk Import.
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.gray200}` }}>
                  {['Member', 'Roles', 'Email', 'Jira ID', 'Status'].map((h) => (
                    <th key={h} style={{
                      fontSize: 11, fontWeight: 600, color: colors.gray600,
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                      padding: '8px 12px', textAlign: 'left',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.map((m, i) => (
                  <MemberRow
                    key={m.id}
                    member={m}
                    allRoles={allRoles}
                    pendingChange={pendingChanges[m.id] || null}
                    onRoleChange={handleRoleChange}
                    onJiraIdSaved={handleJiraIdSaved}
                    isLast={i === members.length - 1}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Sticky pending changes bar */}
      <PendingBar
        pendingChanges={pendingChanges}
        allRoles={allRoles}
        isSaving={isSaving}
        saveResult={saveResult}
        onSaveAll={handleSaveAll}
        onDiscard={handleDiscard}
      />
    </div>
  );
}
