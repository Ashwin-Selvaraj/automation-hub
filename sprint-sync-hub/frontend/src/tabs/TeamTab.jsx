import React, { useState, useEffect } from 'react';
import { COLORS, FONTS, card, label, input, hint, btnPrimary, btnSecondary } from '../config.js';
import { postTeamMembers, getEnvStatus } from '../api.js';
import { Spinner } from '../App.jsx';

const AVATAR_COLORS = ['#7C6AFF', '#00D9C8', '#FFC147', '#FF4757', '#00C896', '#FF6B9D', '#4ECDC4'];

function Avatar({ initials, index }) {
  const bg = AVATAR_COLORS[index % AVATAR_COLORS.length];
  return (
    <div style={{
      width: 40, height: 40, borderRadius: '50%', background: bg,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: FONTS.mono, fontSize: 13, fontWeight: 500, color: '#fff', flexShrink: 0,
    }}>
      {(initials || '??').slice(0, 2).toUpperCase()}
    </div>
  );
}

function getInitials(name) {
  if (!name) return '??';
  return name.trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2);
}

/** Generates the correct single-line TEAM_MEMBERS value for .env */
function toEnvLine(members) {
  return 'TEAM_MEMBERS=' + JSON.stringify(
    members.map(({ id, name, initials, role }) =>
      Object.fromEntries(Object.entries({ id, name, initials, role }).filter(([, v]) => v))
    )
  );
}

export default function TeamTab({ config, setConfig }) {
  const [members, setMembers]         = useState(() => config?.teamMembers || []);
  const [envInfo, setEnvInfo]         = useState(null);
  const [loading, setLoading]         = useState(true);

  // Single-add form
  const [showForm, setShowForm]       = useState(false);
  const [newName, setNewName]         = useState('');
  const [newId, setNewId]             = useState('');
  const [newRole, setNewRole]         = useState('');

  // Bulk import panel
  const [showBulk, setShowBulk]       = useState(false);
  const [bulkText, setBulkText]       = useState('');
  const [bulkError, setBulkError]     = useState('');
  const [bulkPreview, setBulkPreview] = useState([]);

  // .env snippet panel
  const [showSnippet, setShowSnippet] = useState(false);
  const [snippetCopied, setSnippetCopied] = useState(false);

  const [saving, setSaving]           = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [error, setError]             = useState('');
  const [saveMsg, setSaveMsg]         = useState('');

  // Sync from config prop whenever it arrives
  useEffect(() => {
    if (config?.teamMembers !== undefined) {
      setMembers(config.teamMembers);
    }
  }, [config]);

  // Fetch env-status to detect parse errors / placeholder values
  useEffect(() => {
    getEnvStatus()
      .then((status) => {
        const t = status?.team ?? null;
        setEnvInfo(t);
        // If env has real (non-placeholder) members and local state is empty, apply them
        if (t?.members?.length && !t.isPlaceholder && !t.parseError) {
          setMembers((prev) => (prev.length === 0 ? t.members : prev));
          setConfig?.((c) => c ? { ...c, teamMembers: t.members } : c);
        }
      })
      .catch(() => setEnvInfo(null))
      .finally(() => setLoading(false));
  }, []);

  async function persistMembers(updated) {
    setSaving(true);
    setError('');
    try {
      await postTeamMembers(updated);
      setMembers(updated);
      setConfig?.((c) => ({ ...c, teamMembers: updated }));
      setSaveMsg('Saved ✓');
      setTimeout(() => setSaveMsg(''), 2500);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleAddOne() {
    if (!newName.trim() || !newId.trim()) { setError('Name and Slack ID are required'); return; }
    const m = {
      id: newId.trim(),
      name: newName.trim(),
      initials: getInitials(newName.trim()),
      ...(newRole.trim() && { role: newRole.trim() }),
    };
    await persistMembers([...members, m]);
    setNewName(''); setNewId(''); setNewRole('');
    setShowForm(false);
  }

  async function handleRemove(id) {
    setConfirmRemove(null);
    await persistMembers(members.filter((m) => m.id !== id));
  }

  // ── Bulk import ──────────────────────────────────────────────────────────────
  function parseBulkText(text) {
    // Strip trailing backslashes (common copy-paste from .env drafts)
    const cleaned = text
      .replace(/\\\s*[\r\n]+\s*/g, '')
      .replace(/,\s*([}\]])/g, '$1')
      .trim();
    // Accept either a bare array or TEAM_MEMBERS=<array>
    const jsonPart = cleaned.startsWith('TEAM_MEMBERS')
      ? cleaned.replace(/^TEAM_MEMBERS\s*=\s*/, '')
      : cleaned;
    return JSON.parse(jsonPart);
  }

  function handleBulkParse() {
    setBulkError('');
    setBulkPreview([]);
    try {
      const parsed = parseBulkText(bulkText);
      if (!Array.isArray(parsed)) { setBulkError('Expected a JSON array [ … ]'); return; }
      // Auto-fill missing initials
      const normalised = parsed.map((m) => ({
        id: String(m.id || '').trim(),
        name: String(m.name || '').trim(),
        initials: String(m.initials || getInitials(m.name || '')).trim().toUpperCase().slice(0, 2),
        ...(m.role ? { role: String(m.role).trim() } : {}),
      })).filter((m) => m.id && m.name);
      if (!normalised.length) { setBulkError('No valid members found (each needs at least id + name)'); return; }
      setBulkPreview(normalised);
    } catch (e) {
      setBulkError('JSON parse error: ' + e.message);
    }
  }

  async function handleBulkImport() {
    if (!bulkPreview.length) return;
    await persistMembers(bulkPreview);
    setBulkText('');
    setBulkPreview([]);
    setShowBulk(false);
  }

  // ── .env snippet ─────────────────────────────────────────────────────────────
  function copySnippet() {
    navigator.clipboard.writeText(toEnvLine(members)).then(() => {
      setSnippetCopied(true);
      setTimeout(() => setSnippetCopied(false), 2500);
    });
  }

  const fromEnv = envInfo?.rawSet && !envInfo?.isPlaceholder && !envInfo?.parseError && envInfo?.count > 0;
  const hasParseError = envInfo?.parseError;
  const hasPlaceholder = envInfo?.isPlaceholder;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Header */}
      <div>
        <h2 style={{ fontFamily: FONTS.heading, fontSize: 20, fontWeight: 700, color: COLORS.text }}>Team Members</h2>
        <p style={{ color: COLORS.muted, fontSize: 14, marginTop: 4 }}>
          Slack users whose messages will be tracked and matched to Jira tasks.
        </p>
      </div>

      {/* ── Status banners ──────────────────────────────────────────────────── */}

      {/* Parse error */}
      {!loading && hasParseError && (
        <div style={{ background: 'rgba(255,71,87,0.07)', border: `1px solid ${COLORS.error}`, borderRadius: 10, padding: '14px 18px' }}>
          <p style={{ fontFamily: FONTS.mono, fontSize: 13, color: COLORS.error, fontWeight: 500 }}>⚠ TEAM_MEMBERS in backend/.env could not be parsed</p>
          <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted, marginTop: 6, lineHeight: 1.7 }}>
            dotenv does not support multi-line values or trailing commas. Use the <strong style={{ color: COLORS.text }}>Bulk Import</strong> panel below — paste your JSON array, click Import, then use the generated <strong style={{ color: COLORS.text }}>.env snippet</strong> to update your file.
          </p>
        </div>
      )}

      {/* Placeholder warning */}
      {!loading && hasPlaceholder && (
        <div style={{ background: 'rgba(255,193,71,0.07)', border: `1px solid ${COLORS.warning}`, borderRadius: 10, padding: '14px 18px' }}>
          <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.warning }}>
            ⚠ <strong style={{ color: COLORS.text }}>TEAM_MEMBERS</strong> still has placeholder IDs (U00000000…). Replace with real Slack user IDs.
          </p>
        </div>
      )}

      {/* Loaded from env */}
      {!loading && fromEnv && (
        <div style={{ background: 'rgba(0,200,150,0.06)', border: `1px solid rgba(0,200,150,0.25)`, borderRadius: 10, padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: COLORS.success, fontSize: 15 }}>✓</span>
          <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.success }}>
            {envInfo.count} member{envInfo.count !== 1 ? 's' : ''} loaded from <strong style={{ color: COLORS.text }}>TEAM_MEMBERS</strong> in backend/.env
          </p>
        </div>
      )}

      {/* ── Member list card ────────────────────────────────────────────────── */}
      <div style={card}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {loading
              ? <span style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted, display: 'flex', alignItems: 'center', gap: 6 }}><Spinner size={12} /> Loading…</span>
              : <span style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted }}>{members.length} member{members.length !== 1 ? 's' : ''}</span>
            }
            {saveMsg && <span style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.success }}>{saveMsg}</span>}
            {saving && <Spinner size={12} />}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => { setShowBulk(!showBulk); setShowForm(false); }}
              style={{ ...btnSecondary, fontSize: 12, padding: '7px 14px', color: COLORS.secondary, borderColor: COLORS.secondary }}
            >
              {showBulk ? '✕ Close import' : '⬆ Bulk Import'}
            </button>
            <button
              onClick={() => { setShowForm(!showForm); setShowBulk(false); setError(''); }}
              style={{ ...btnSecondary, fontSize: 13, padding: '7px 14px' }}
            >
              {showForm ? '✕ Cancel' : '+ Add One'}
            </button>
          </div>
        </div>

        {/* ── Bulk import panel ─────────────────────────────────────────────── */}
        {showBulk && (
          <div style={{ marginBottom: 20, padding: 16, background: COLORS.surface, borderRadius: 10, border: `1px solid ${COLORS.secondary}` }}>
            <p style={{ fontFamily: FONTS.heading, fontSize: 14, fontWeight: 700, color: COLORS.text, marginBottom: 4 }}>Bulk Import from JSON</p>
            <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted, marginBottom: 10, lineHeight: 1.6 }}>
              Paste your JSON array below (or the full <code style={{ color: COLORS.secondary }}>TEAM_MEMBERS=[…]</code> line from your .env). Trailing backslashes and commas are automatically cleaned.
            </p>
            <textarea
              value={bulkText}
              onChange={(e) => { setBulkText(e.target.value); setBulkError(''); setBulkPreview([]); }}
              rows={8}
              placeholder={`[
  {"id":"U06T89E0BN2","name":"Geerthika V","initials":"GV"},
  {"id":"U074QLDJQ5P","name":"Ashwin","initials":"AS"}
]`}
              style={{
                width: '100%', background: '#070810',
                border: `1px solid ${COLORS.border}`, borderRadius: 8,
                padding: '10px 14px', color: COLORS.text,
                fontFamily: FONTS.mono, fontSize: 12, outline: 'none',
                resize: 'vertical', lineHeight: 1.7,
              }}
            />
            {bulkError && (
              <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.error, marginTop: 6 }}>✗ {bulkError}</p>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
              <button onClick={handleBulkParse} style={{ ...btnSecondary, fontSize: 12, padding: '8px 14px' }}>Preview</button>
              {bulkPreview.length > 0 && (
                <button onClick={handleBulkImport} disabled={saving} style={{ ...btnPrimary, fontSize: 12, padding: '8px 18px', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {saving ? <><Spinner size={12} color="#fff" /> Importing…</> : `Import ${bulkPreview.length} members`}
                </button>
              )}
            </div>

            {/* Preview rows */}
            {bulkPreview.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.success, marginBottom: 8 }}>
                  ✓ {bulkPreview.length} valid member{bulkPreview.length !== 1 ? 's' : ''} ready to import
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {bulkPreview.map((m, i) => (
                    <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: COLORS.card, borderRadius: 8 }}>
                      <Avatar initials={m.initials} index={i} />
                      <div style={{ flex: 1 }}>
                        <span style={{ fontWeight: 600, color: COLORS.text, fontSize: 14 }}>{m.name}</span>
                        {m.role && <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: COLORS.secondary, marginLeft: 8 }}>{m.role}</span>}
                      </div>
                      <span style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted }}>{m.id}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Single-add form ───────────────────────────────────────────────── */}
        {showForm && (
          <div style={{ marginBottom: 20, padding: 16, background: COLORS.surface, borderRadius: 10, border: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ fontFamily: FONTS.heading, fontSize: 14, fontWeight: 700, color: COLORS.text }}>New Team Member</p>
            <div>
              <label style={label}>Display Name</label>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} style={input} placeholder="Alice Smith" />
            </div>
            <div>
              <label style={label}>Slack User ID</label>
              <input value={newId} onChange={(e) => setNewId(e.target.value)} style={input} placeholder="U0123456789" />
              <p style={hint}>Slack → right-click user → View profile → ⋯ More → Copy member ID</p>
            </div>
            <div>
              <label style={label}>Role (optional)</label>
              <input value={newRole} onChange={(e) => setNewRole(e.target.value)} style={input} placeholder="Frontend Engineer" />
            </div>
            {error && <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.error }}>{error}</p>}
            <button onClick={handleAddOne} disabled={saving} style={{ ...btnPrimary, alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 8 }}>
              {saving ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Add Member'}
            </button>
          </div>
        )}

        {/* ── Member rows ───────────────────────────────────────────────────── */}
        {!loading && members.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '28px 16px' }}>
            <p style={{ fontFamily: FONTS.mono, fontSize: 13, color: COLORS.muted }}>No team members yet.</p>
            <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted, marginTop: 6 }}>
              Use <strong style={{ color: COLORS.text }}>Bulk Import</strong> to paste your existing JSON, or <strong style={{ color: COLORS.text }}>+ Add One</strong> to add manually.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {members.map((m, i) => (
              <div key={m.id} style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '11px 14px', borderRadius: 10,
                background: confirmRemove === m.id ? 'rgba(255,71,87,0.06)' : 'transparent',
                border: confirmRemove === m.id ? `1px solid ${COLORS.error}` : '1px solid transparent',
                transition: 'all 0.15s',
              }}>
                <Avatar initials={m.initials || getInitials(m.name)} index={i} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, color: COLORS.text, fontSize: 15 }}>{m.name}</span>
                    {m.role && (
                      <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: COLORS.secondary, background: 'rgba(0,217,200,0.1)', border: `1px solid rgba(0,217,200,0.2)`, borderRadius: 4, padding: '2px 7px', textTransform: 'uppercase' }}>{m.role}</span>
                    )}
                  </div>
                  <span style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.muted }}>{m.id}</span>
                </div>
                {confirmRemove === m.id ? (
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    <button onClick={() => handleRemove(m.id)} style={{ ...btnSecondary, fontSize: 12, padding: '6px 12px', color: COLORS.error, borderColor: COLORS.error }}>Remove</button>
                    <button onClick={() => setConfirmRemove(null)} style={{ ...btnSecondary, fontSize: 12, padding: '6px 12px' }}>Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmRemove(m.id)} style={{ background: 'none', border: 'none', color: COLORS.muted, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 4, flexShrink: 0 }}>✕</button>
                )}
              </div>
            ))}
          </div>
        )}

        {error && !showForm && <p style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.error, marginTop: 10 }}>{error}</p>}
      </div>

      {/* ── .env snippet generator ───────────────────────────────────────────── */}
      {members.length > 0 && (
        <div style={{ ...card, background: COLORS.surface }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              backend/.env snippet — paste this to persist across restarts
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setShowSnippet(!showSnippet)} style={{ ...btnSecondary, fontSize: 11, padding: '5px 12px' }}>
                {showSnippet ? 'Hide' : 'Show'}
              </button>
              <button onClick={copySnippet} style={{ ...btnSecondary, fontSize: 11, padding: '5px 12px', color: snippetCopied ? COLORS.success : undefined }}>
                {snippetCopied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>
          {showSnippet && (
            <pre style={{
              fontFamily: FONTS.mono, fontSize: 11, color: COLORS.secondary,
              background: '#070810', border: `1px solid ${COLORS.border}`,
              borderRadius: 8, padding: '12px 14px', margin: 0,
              whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.7,
            }}>
              {toEnvLine(members)}
            </pre>
          )}
          <p style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.muted, marginTop: 8 }}>
            Replace the <code style={{ color: COLORS.secondary }}>TEAM_MEMBERS=</code> line in backend/.env with the above, then restart the server.
          </p>
        </div>
      )}

    </div>
  );
}
