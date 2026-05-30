import React, { useState, useEffect, useRef, useCallback } from 'react';
import { theme, styles } from '../theme.js';
import { postTeamMembers, getEnvStatus } from '../api.js';
import Card, { SectionHeader } from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Avatar from '../components/Avatar.jsx';
import Input, { Label, Hint, FormGroup } from '../components/Input.jsx';
import Badge from '../components/Badge.jsx';
import Spinner from '../components/Spinner.jsx';

const { colors, fonts } = theme;

function getInitials(name) {
  if (!name) return '??';
  return name.trim().split(/\s+/).map((w) => w[0] || '').join('').toUpperCase().slice(0, 2) || '??';
}

function parseBulkText(text) {
  const cleaned = text.replace(/\\\s*[\r\n]+\s*/g, '').replace(/,\s*([}\]])/g, '$1').trim();
  const jsonPart = cleaned.startsWith('TEAM_MEMBERS') ? cleaned.replace(/^TEAM_MEMBERS\s*=\s*/, '') : cleaned;
  return JSON.parse(jsonPart);
}

// ─── Bulk Import Panel ────────────────────────────────────────────────────────

function BulkImportPanel({ onImport, saving }) {
  const [text,    setText]    = useState('');
  const [preview, setPreview] = useState([]);
  const [error,   setError]   = useState('');

  function handleParse() {
    setError(''); setPreview([]);
    try {
      const parsed = parseBulkText(text);
      if (!Array.isArray(parsed)) { setError('Expected a JSON array [ … ]'); return; }
      const normalised = parsed.map((m) => ({
        id: String(m.id || '').trim(), name: String(m.name || '').trim(),
        initials: String(m.initials || getInitials(m.name || '')).toUpperCase().slice(0, 2),
        ...(m.role ? { role: String(m.role).trim() } : {}),
      })).filter((m) => m.id && m.name);
      if (!normalised.length) { setError('No valid members found (each needs id + name)'); return; }
      setPreview(normalised);
    } catch (e) { setError('JSON error: ' + e.message); }
  }

  return (
    <div style={{ marginBottom: 20, padding: '16px 20px', background: colors.gray50, borderRadius: 6, border: `1px solid ${colors.gray200}` }}>
      <p style={{ fontSize: 13, fontWeight: 500, color: colors.gray900, marginBottom: 4 }}>Bulk Import from JSON</p>
      <p style={{ fontSize: 12, color: colors.gray600, marginBottom: 12 }}>
        Paste a JSON array or the full <code style={{ fontFamily: fonts.mono, background: colors.gray100, padding: '1px 4px', borderRadius: 3 }}>TEAM_MEMBERS=[…]</code> line.
      </p>
      <textarea
        value={text} onChange={(e) => { setText(e.target.value); setError(''); setPreview([]); }}
        rows={6} placeholder={'[\n  {"id":"U0123","name":"Alice Smith","initials":"AS"},\n  {"id":"U0456","name":"Bob Jones"}\n]'}
        style={{
          width: '100%', background: colors.white, border: `1px solid ${colors.gray300}`,
          borderRadius: 6, padding: '8px 12px', fontFamily: fonts.mono, fontSize: 12,
          outline: 'none', resize: 'vertical', lineHeight: 1.7, color: colors.gray900,
        }}
      />
      {error && <p style={{ fontSize: 12, color: colors.red600, marginTop: 6 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <Button variant="secondary" size="sm" onClick={handleParse}>Preview</Button>
        {preview.length > 0 && (
          <Button variant="primary" size="sm" onClick={() => onImport(preview)} disabled={saving}>
            {saving ? 'Importing…' : `Import ${preview.length} members`}
          </Button>
        )}
      </div>
      {preview.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 12, color: colors.green600, marginBottom: 8 }}>✓ {preview.length} valid member{preview.length !== 1 ? 's' : ''} ready</p>
          {preview.map((m, i) => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: i > 0 ? `1px solid ${colors.gray100}` : 'none' }}>
              <Avatar initials={m.initials} size={28} />
              <span style={{ fontSize: 14, color: colors.gray900 }}>{m.name}</span>
              {m.role && <Badge variant="neutral">{m.role}</Badge>}
              <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.gray400, marginLeft: 'auto' }}>{m.id}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Add Member Form ──────────────────────────────────────────────────────────

function AddMemberForm({ onSave, onCancel, saving, error }) {
  const [name, setName] = useState('');
  const [id,   setId]   = useState('');
  const [role, setRole] = useState('');

  function handleSave() {
    if (!name.trim() || !id.trim()) return;
    onSave({ id: id.trim(), name: name.trim(), initials: getInitials(name.trim()), ...(role.trim() ? { role: role.trim() } : {}) });
  }

  return (
    <div style={{ padding: '16px 20px', background: colors.gray50, borderRadius: 6, border: `1px solid ${colors.gray200}`, marginBottom: 20 }}>
      <p style={{ fontSize: 13, fontWeight: 500, color: colors.gray900, marginBottom: 16 }}>New Team Member</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
        <FormGroup style={{ marginBottom: 0 }}>
          <Label>Display Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Alice Smith" />
        </FormGroup>
        <FormGroup style={{ marginBottom: 0 }}>
          <Label>Slack User ID</Label>
          <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="U0123456789" style={{ fontFamily: fonts.mono }} />
        </FormGroup>
        <FormGroup style={{ marginBottom: 0 }}>
          <Label>Role (optional)</Label>
          <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Frontend Engineer" />
        </FormGroup>
      </div>
      {error && <p style={{ fontSize: 12, color: colors.red600, marginBottom: 8 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" size="sm" onClick={handleSave} disabled={saving || !name.trim() || !id.trim()}>
          {saving ? 'Saving…' : 'Add Member'}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// ─── Member Row — each row owns its own confirming state ─────────────────────

const MemberRow = React.memo(function MemberRow({ m, isLast, onRemove }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <tr style={{ borderBottom: isLast ? 'none' : `1px solid ${colors.gray100}` }}>
      <td style={{ padding: '10px 12px', verticalAlign: 'middle' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar initials={m.initials || getInitials(m.name)} size={28} />
          <span style={{ fontSize: 14, fontWeight: 500, color: colors.gray900 }}>{m.name}</span>
        </div>
      </td>
      <td style={{ padding: '10px 12px', fontFamily: fonts.mono, fontSize: 12, color: colors.gray400, verticalAlign: 'middle' }}>{m.id}</td>
      <td style={{ padding: '10px 12px', fontSize: 13, color: colors.gray600, verticalAlign: 'middle' }}>{m.role || '—'}</td>
      <td style={{ padding: '10px 12px', verticalAlign: 'middle', width: 160, minWidth: 160 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button variant="danger" size="sm" onClick={() => confirming ? (setConfirming(false), onRemove(m.id)) : setConfirming(true)}>
            Remove
          </Button>
          {confirming && (
            <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
          )}
        </div>
      </td>
    </tr>
  );
});

// ─── Main Tab ─────────────────────────────────────────────────────────────────

export default function TeamTab({ config, setConfig }) {
  const [members,   setMembers]   = useState(() => config?.teamMembers || []);
  const [envInfo,   setEnvInfo]   = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [showBulk,  setShowBulk]  = useState(false);
  const [showForm,  setShowForm]  = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [saveMsg,   setSaveMsg]   = useState('');
  const [formError, setFormError] = useState('');

  const membersRef = useRef(members);
  useEffect(() => { membersRef.current = members; }, [members]);

  useEffect(() => {
    if (config?.teamMembers !== undefined) setMembers(config.teamMembers);
  }, [config]);

  useEffect(() => {
    getEnvStatus().then((s) => {
      const t = s?.team ?? null;
      setEnvInfo(t);
      if (t?.members?.length && !t.isPlaceholder && !t.parseError) {
        setMembers((prev) => (prev.length === 0 ? t.members : prev));
        setConfig?.((c) => c ? { ...c, teamMembers: t.members } : c);
      }
    }).catch(() => setEnvInfo(null)).finally(() => setLoading(false));
  }, []);

  async function persistMembers(updated) {
    setSaving(true); setFormError('');
    try {
      await postTeamMembers(updated);
      setMembers(updated);
      setConfig?.((c) => ({ ...c, teamMembers: updated }));
      setSaveMsg('Saved');
      setTimeout(() => setSaveMsg(''), 2500);
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  const handleRemove = useCallback((id) => {
    persistMembers(membersRef.current.filter((x) => x.id !== id));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fromEnv = envInfo?.rawSet && !envInfo?.isPlaceholder && !envInfo?.parseError && envInfo?.count > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={styles.pageTitle}>Team Members</h1>
        <p style={styles.subtitle}>These members are checked daily for standup updates.</p>
      </div>

      {!loading && envInfo?.parseError && (
        <div style={{ padding: '12px 16px', background: colors.red50, border: `1px solid #FCA5A5`, borderRadius: 6 }}>
          <p style={{ fontSize: 13, fontWeight: 500, color: colors.red600 }}>TEAM_MEMBERS in backend/.env could not be parsed</p>
          <p style={{ fontSize: 12, color: colors.gray600, marginTop: 4 }}>Use Bulk Import below to fix it.</p>
        </div>
      )}
      {!loading && envInfo?.isPlaceholder && (
        <div style={{ padding: '12px 16px', background: colors.amber50, border: `1px solid #FCD34D`, borderRadius: 6 }}>
          <p style={{ fontSize: 12, color: colors.amber600 }}>TEAM_MEMBERS still has placeholder IDs. Replace with real Slack user IDs.</p>
        </div>
      )}
      {!loading && fromEnv && (
        <div style={{ padding: '10px 16px', background: colors.green50, border: `1px solid #86EFAC`, borderRadius: 6 }}>
          <p style={{ fontSize: 12, color: colors.green600 }}>✓ {envInfo.count} member{envInfo.count !== 1 ? 's' : ''} loaded from TEAM_MEMBERS in backend/.env</p>
        </div>
      )}

      <Card padding="0" style={{ marginBottom: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: `1px solid ${colors.gray100}` }}>
          <span style={{ fontSize: 13, color: colors.gray600 }}>
            {loading ? <Spinner size={12} /> : `${members.length} member${members.length !== 1 ? 's' : ''}`}
            {saveMsg && <span style={{ marginLeft: 10, fontSize: 12, color: colors.green600 }}>{saveMsg}</span>}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => { setShowBulk((v) => !v); setShowForm(false); }}>
              {showBulk ? 'Close import' : 'Bulk Import'}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { setShowForm((v) => !v); setShowBulk(false); setFormError(''); }}>
              {showForm ? 'Cancel' : '+ Add Member'}
            </Button>
          </div>
        </div>

        <div style={{ padding: '16px 20px' }}>
          {showBulk && (
            <BulkImportPanel
              saving={saving}
              onImport={(m) => { persistMembers(m); setShowBulk(false); }}
            />
          )}
          {showForm && (
            <AddMemberForm
              saving={saving}
              error={formError}
              onCancel={() => setShowForm(false)}
              onSave={(m) => { persistMembers([...members, m]); setShowForm(false); }}
            />
          )}

          {members.length === 0 && !loading ? (
            <div style={{ padding: '32px 0', textAlign: 'center' }}>
              <p style={{ fontSize: 14, fontWeight: 500, color: colors.gray900 }}>No team members yet</p>
              <p style={{ fontSize: 13, color: colors.gray400, marginTop: 4 }}>Use Bulk Import or + Add Member to get started.</p>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Member', 'Slack ID', 'Role', 'Actions'].map((h) => (
                    <th key={h} style={{
                      fontSize: 11, fontWeight: 600, color: colors.gray600,
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                      padding: '8px 12px', borderBottom: `1px solid ${colors.gray200}`,
                      textAlign: 'left',
                      ...(h === 'Actions' ? { width: 160, minWidth: 160 } : {}),
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.map((m, i) => (
                  <MemberRow
                    key={m.id}
                    m={m}
                    isLast={i === members.length - 1}
                    onRemove={handleRemove}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}
