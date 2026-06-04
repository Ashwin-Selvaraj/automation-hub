import React, { useState, useEffect, useCallback } from 'react';
import { theme, styles } from '../theme.js';
import { getRoles, createRole, updateRole, deleteRole, getRoleMembers } from '../api.js';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Spinner from '../components/Spinner.jsx';

const { colors, fonts } = theme;

const COLOUR_SWATCHES = ['#6366F1','#0EA5E9','#8B5CF6','#EC4899','#F59E0B','#10B981','#EF4444','#6B7280','#F97316','#14B8A6'];

function RolePill({ name, colour, size = 'md' }) {
  const fontSize = size === 'sm' ? 11 : 12;
  const px = size === 'sm' ? 6 : 8;
  const py = size === 'sm' ? 2 : 3;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      background: colour + '22', color: colour,
      border: `1px solid ${colour}55`,
      borderRadius: 4, padding: `${py}px ${px}px`,
      fontSize, fontWeight: 600, lineHeight: 1,
      whiteSpace: 'nowrap',
    }}>
      {name}
    </span>
  );
}

function KeywordTag({ kw, onRemove }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: colors.gray100, color: colors.gray700,
      border: `1px solid ${colors.gray200}`,
      borderRadius: 4, padding: '3px 8px', fontSize: 12,
    }}>
      {kw}
      {onRemove && (
        <button onClick={() => onRemove(kw)} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: colors.gray400, fontSize: 13, lineHeight: 1, padding: 0,
        }}>×</button>
      )}
    </span>
  );
}

function RoleEditForm({ role, onSave, onCancel, saving }) {
  const [name,    setName]    = useState(role?.name || '');
  const [colour,  setColour]  = useState(role?.colour || '#6366F1');
  const [roleType, setRoleType] = useState(role?.role_type || 'technical');
  const [receivesDms,  setReceivesDms]  = useState(role?.receives_task_dms !== false);
  const [canAssign,    setCanAssign]    = useState(role?.can_be_assigned_tasks !== false);
  const [keywords, setKeywords] = useState(role?.skill_keywords || []);
  const [kwInput,  setKwInput]  = useState('');

  const isSystem = role?.is_system;

  function addKeyword() {
    const kw = kwInput.trim();
    if (kw && !keywords.includes(kw)) {
      setKeywords((p) => [...p, kw]);
    }
    setKwInput('');
  }

  function handleKwKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); addKeyword(); }
  }

  function handleSave() {
    if (!name.trim()) return;
    const data = { name: name.trim(), colour, skill_keywords: keywords };
    if (!isSystem) {
      data.role_type = roleType;
      data.receives_task_dms = receivesDms;
      data.can_be_assigned_tasks = canAssign;
    }
    onSave(data);
  }

  return (
    <div style={{ padding: '16px 20px', background: colors.blue50, borderRadius: 6, border: `1px solid #C7D2FE` }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: colors.gray600, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>Name</label>
          <input
            value={name} onChange={(e) => setName(e.target.value)}
            style={{ width: '100%', padding: '6px 10px', border: `1px solid ${colors.gray300}`, borderRadius: 4, fontSize: 13, fontFamily: fonts.body, outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: colors.gray600, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>Colour</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {COLOUR_SWATCHES.map((c) => (
              <button key={c} onClick={() => setColour(c)} style={{
                width: 22, height: 22, borderRadius: 4, background: c,
                border: colour === c ? `2px solid ${colors.gray900}` : `2px solid transparent`,
                cursor: 'pointer', padding: 0,
              }} />
            ))}
          </div>
        </div>
      </div>

      {!isSystem && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: colors.gray600, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>Type</label>
            <select value={roleType} onChange={(e) => setRoleType(e.target.value)}
              style={{ padding: '6px 10px', border: `1px solid ${colors.gray300}`, borderRadius: 4, fontSize: 13, fontFamily: fonts.body, width: '100%' }}>
              <option value="technical">Technical</option>
              <option value="managerial">Managerial</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: colors.gray600, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>Receives DMs</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={receivesDms} onChange={(e) => setReceivesDms(e.target.checked)} />
              Automated DMs
            </label>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: colors.gray600, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>Assignable</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={canAssign} onChange={(e) => setCanAssign(e.target.checked)} />
              Can receive tasks
            </label>
          </div>
        </div>
      )}

      {isSystem && (
        <p style={{ fontSize: 12, color: colors.gray400, marginBottom: 12, fontStyle: 'italic' }}>
          System role — type, DM settings, and assignability cannot be changed.
        </p>
      )}

      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: colors.gray600, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>Skill Keywords</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {keywords.map((kw) => <KeywordTag key={kw} kw={kw} onRemove={(k) => setKeywords((p) => p.filter((x) => x !== k))} />)}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={kwInput} onChange={(e) => setKwInput(e.target.value)} onKeyDown={handleKwKeyDown}
            placeholder="Type keyword and press Enter"
            style={{ flex: 1, padding: '6px 10px', border: `1px solid ${colors.gray300}`, borderRadius: 4, fontSize: 13, fontFamily: fonts.body, outline: 'none' }}
          />
          <Button variant="secondary" size="sm" onClick={addKeyword}>Add</Button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" size="sm" onClick={handleSave} disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function RoleCard({ role, onEdit, onDelete }) {
  const [showMembers, setShowMembers] = useState(false);
  const [members, setMembers] = useState([]);
  const [loadingMembers, setLoadingMembers] = useState(false);

  async function toggleMembers() {
    if (!showMembers && members.length === 0) {
      setLoadingMembers(true);
      try {
        const data = await getRoleMembers(role.id);
        setMembers(data.members || []);
      } catch (_) {}
      setLoadingMembers(false);
    }
    setShowMembers((v) => !v);
  }

  const memberCount = parseInt(role.member_count || 0, 10);

  return (
    <div style={{
      border: `1px solid ${colors.gray200}`, borderRadius: 6,
      background: colors.white, marginBottom: 8, overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: role.colour, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: colors.gray900 }}>{role.name}</span>
            <span style={{ fontSize: 11, color: colors.gray400, background: colors.gray100, borderRadius: 3, padding: '2px 6px' }}>
              {memberCount} member{memberCount !== 1 ? 's' : ''}
            </span>
            <span style={{ fontSize: 11, color: role.role_type === 'technical' ? colors.blue600 : colors.red600, background: role.role_type === 'technical' ? colors.blue50 : '#FEF2F2', borderRadius: 3, padding: '2px 6px', fontWeight: 500 }}>
              {role.role_type}
            </span>
            {role.receives_task_dms && <span style={{ fontSize: 11, color: colors.green600, background: colors.green50, borderRadius: 3, padding: '2px 6px' }}>Receives DMs</span>}
            {role.can_be_assigned_tasks && <span style={{ fontSize: 11, color: colors.green600, background: colors.green50, borderRadius: 3, padding: '2px 6px' }}>Assignable</span>}
          </div>
          {(role.skill_keywords || []).length > 0 && (
            <p style={{ fontSize: 11, color: colors.gray400, marginTop: 4, marginBottom: 0 }}>
              {role.skill_keywords.slice(0, 8).join(' · ')}{role.skill_keywords.length > 8 ? ` +${role.skill_keywords.length - 8} more` : ''}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <Button variant="secondary" size="sm" onClick={() => toggleMembers()}>
            {loadingMembers ? <Spinner size={10} /> : (showMembers ? 'Hide Members' : 'View Members')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onEdit(role)}>Edit</Button>
          {!role.is_system && (
            <Button variant="danger" size="sm" onClick={() => onDelete(role)}>Delete</Button>
          )}
        </div>
      </div>

      {showMembers && (
        <div style={{ borderTop: `1px solid ${colors.gray100}`, padding: '10px 16px', background: colors.gray50 }}>
          {members.length === 0
            ? <p style={{ fontSize: 12, color: colors.gray400 }}>No members currently have this role.</p>
            : members.map((m) => (
              <div key={m.id} style={{ fontSize: 13, color: colors.gray700, padding: '4px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 24, height: 24, borderRadius: '50%', background: colors.blue600, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
                  {m.name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)}
                </span>
                {m.name}
              </div>
            ))
          }
        </div>
      )}
    </div>
  );
}

export default function RolesTab() {
  const [roles,        setRoles]        = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [editingRole,  setEditingRole]  = useState(null); // role being edited
  const [showAddForm,  setShowAddForm]  = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [error,        setError]        = useState('');
  const [toast,        setToast]        = useState('');

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }

  const loadRoles = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getRoles();
      setRoles(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadRoles(); }, [loadRoles]);

  async function handleSaveEdit(data) {
    setSaving(true);
    try {
      await updateRole(editingRole.id, data);
      setEditingRole(null);
      showToast(`Role "${data.name}" updated`);
      await loadRoles();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleCreate(data) {
    setSaving(true);
    try {
      await createRole(data);
      setShowAddForm(false);
      showToast(`Role "${data.name}" created`);
      await loadRoles();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(role) {
    if (!window.confirm(`Deactivate role "${role.name}"? This cannot be undone.`)) return;
    try {
      await deleteRole(role.id);
      showToast(`Role "${role.name}" deactivated`);
      await loadRoles();
    } catch (err) {
      setError(err.message);
    }
  }

  const technical  = roles.filter((r) => r.role_type === 'technical');
  const managerial = roles.filter((r) => r.role_type === 'managerial');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={styles.pageTitle}>Roles</h1>
        <p style={styles.subtitle}>Manage role definitions and skill keywords. Assign roles to members from the Team page.</p>
      </div>

      {toast && (
        <div style={{ padding: '10px 16px', background: colors.green50, border: `1px solid #86EFAC`, borderRadius: 6 }}>
          <p style={{ fontSize: 13, color: colors.green600, margin: 0 }}>✓ {toast}</p>
        </div>
      )}

      {error && (
        <div style={{ padding: '10px 16px', background: '#FEF2F2', border: `1px solid #FECACA`, borderRadius: 6 }}>
          <p style={{ fontSize: 13, color: colors.red600, margin: 0 }}>{error}</p>
          <button onClick={() => setError('')} style={{ fontSize: 12, color: colors.red600, background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 4 }}>Dismiss</button>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spinner size={24} /></div>
      ) : (
        <>
          {/* Technical Roles */}
          <Card padding="20px">
            <h2 style={{ fontSize: 14, fontWeight: 700, color: colors.blue600, marginBottom: 4 }}>Technical Roles</h2>
            <p style={{ fontSize: 12, color: colors.gray400, marginBottom: 16 }}>These roles receive automated DMs and can be assigned tasks.</p>

            {technical.map((role) => (
              editingRole?.id === role.id
                ? <RoleEditForm key={role.id} role={role} onSave={handleSaveEdit} onCancel={() => setEditingRole(null)} saving={saving} />
                : <RoleCard key={role.id} role={role} onEdit={setEditingRole} onDelete={handleDelete} />
            ))}
          </Card>

          {/* Managerial Roles */}
          <Card padding="20px">
            <h2 style={{ fontSize: 14, fontWeight: 700, color: colors.red600, marginBottom: 4 }}>Managerial Roles</h2>
            <p style={{ fontSize: 12, color: colors.gray400, marginBottom: 16 }}>
              These roles never receive automated task DMs. If a member has both a managerial and technical role, they will still receive DMs.
            </p>

            {managerial.map((role) => (
              editingRole?.id === role.id
                ? <RoleEditForm key={role.id} role={role} onSave={handleSaveEdit} onCancel={() => setEditingRole(null)} saving={saving} />
                : <RoleCard key={role.id} role={role} onEdit={setEditingRole} onDelete={handleDelete} />
            ))}
          </Card>

          {/* Add Custom Role */}
          <Card padding="20px">
            {showAddForm
              ? <RoleEditForm role={null} onSave={handleCreate} onCancel={() => setShowAddForm(false)} saving={saving} />
              : (
                <Button variant="secondary" size="sm" onClick={() => setShowAddForm(true)}>
                  + Add Custom Role
                </Button>
              )
            }
          </Card>
        </>
      )}
    </div>
  );
}
