import React, { useState, useEffect } from 'react';
import { COLORS, FONTS, card, label, input, hint, btnPrimary, btnSecondary } from '../config.js';
import { postTeamMembers } from '../api.js';
import { Spinner } from '../App.jsx';

const AVATAR_COLORS = ['#7C6AFF', '#00D9C8', '#FFC147', '#FF4757', '#00C896', '#FF6B9D', '#4ECDC4'];

function Avatar({ initials, index }) {
  const bg = AVATAR_COLORS[index % AVATAR_COLORS.length];
  return (
    <div style={{
      width: 40, height: 40, borderRadius: '50%',
      background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: FONTS.mono, fontSize: 13, fontWeight: 500, color: '#fff', flexShrink: 0,
    }}>
      {initials || '??'}
    </div>
  );
}

export default function TeamTab({ config, setConfig }) {
  const [members, setMembers] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newId, setNewId] = useState('');
  const [newRole, setNewRole] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (config?.teamMembers) setMembers(config.teamMembers);
  }, [config]);

  function getInitials(name) {
    return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);
  }

  async function save(updated) {
    setSaving(true);
    setError('');
    try {
      await postTeamMembers(updated);
      setMembers(updated);
      setConfig((c) => ({ ...c, teamMembers: updated }));
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleAdd() {
    if (!newName.trim() || !newId.trim()) {
      setError('Name and Slack ID are required');
      return;
    }
    const member = {
      id: newId.trim(),
      name: newName.trim(),
      initials: getInitials(newName.trim()),
      role: newRole.trim() || undefined,
    };
    const updated = [...members, member];
    await save(updated);
    setNewName(''); setNewId(''); setNewRole('');
    setShowForm(false);
  }

  async function handleRemove(id) {
    const updated = members.filter((m) => m.id !== id);
    setConfirmRemove(null);
    await save(updated);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h2 style={{ fontFamily: FONTS.heading, fontSize: 20, fontWeight: 700, color: COLORS.text }}>Team Members</h2>
        <p style={{ color: COLORS.muted, fontSize: 14, marginTop: 4 }}>These are the Slack users whose messages will be tracked and matched to Jira tasks.</p>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted }}>{members.length} member{members.length !== 1 ? 's' : ''}</p>
          <button onClick={() => setShowForm(!showForm)} style={{ ...btnSecondary, fontSize: 13, padding: '8px 16px' }}>
            {showForm ? '✕ Cancel' : '+ Add Member'}
          </button>
        </div>

        {members.length === 0 ? (
          <p style={{ fontFamily: FONTS.mono, fontSize: 13, color: COLORS.muted, textAlign: 'center', padding: 24 }}>
            No team members yet. Add members to start tracking standups.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {members.map((m, i) => (
              <div key={m.id} style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '12px 14px', borderRadius: 10,
                background: confirmRemove === m.id ? 'rgba(255,71,87,0.06)' : 'transparent',
                border: confirmRemove === m.id ? `1px solid ${COLORS.error}` : '1px solid transparent',
                transition: 'all 0.15s',
              }}>
                <Avatar initials={m.initials} index={i} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600, color: COLORS.text, fontSize: 15 }}>{m.name}</span>
                    {m.role && (
                      <span style={{
                        fontFamily: FONTS.mono, fontSize: 10, color: COLORS.secondary,
                        background: 'rgba(0,217,200,0.1)', border: `1px solid rgba(0,217,200,0.2)`,
                        borderRadius: 4, padding: '2px 7px', textTransform: 'uppercase',
                      }}>{m.role}</span>
                    )}
                  </div>
                  <span style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted }}>{m.id}</span>
                </div>
                {confirmRemove === m.id ? (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => handleRemove(m.id)} style={{ ...btnSecondary, fontSize: 12, padding: '6px 12px', color: COLORS.error, borderColor: COLORS.error }}>Remove</button>
                    <button onClick={() => setConfirmRemove(null)} style={{ ...btnSecondary, fontSize: 12, padding: '6px 12px' }}>Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmRemove(m.id)} style={{ background: 'none', border: 'none', color: COLORS.muted, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 4 }}>✕</button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add member inline form */}
        {showForm && (
          <div style={{ marginTop: 16, padding: 16, background: COLORS.surface, borderRadius: 10, border: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ fontFamily: FONTS.heading, fontSize: 14, fontWeight: 700, color: COLORS.text }}>New Team Member</p>
            <div>
              <label style={label}>Display Name</label>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} style={input} placeholder="Alice Smith" />
            </div>
            <div>
              <label style={label}>Slack User ID</label>
              <input value={newId} onChange={(e) => setNewId(e.target.value)} style={input} placeholder="U0123456789" />
              <p style={hint}>Right-click user in Slack → View profile → More → Copy member ID</p>
            </div>
            <div>
              <label style={label}>Role (optional)</label>
              <input value={newRole} onChange={(e) => setNewRole(e.target.value)} style={input} placeholder="Frontend Engineer" />
            </div>
            {error && <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.error }}>{error}</p>}
            <button onClick={handleAdd} disabled={saving} style={{ ...btnPrimary, alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 8 }}>
              {saving ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Add Member'}
            </button>
          </div>
        )}

        {error && !showForm && <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.error, marginTop: 8 }}>{error}</p>}
        {saving && <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}><Spinner size={14} /><span style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted }}>Saving…</span></div>}
      </div>
    </div>
  );
}
