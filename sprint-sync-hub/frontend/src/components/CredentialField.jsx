import React, { useState, useEffect } from 'react';
import { theme } from '../theme.js';
import Badge from './Badge.jsx';

const { colors, fonts } = theme;

function HowTo({ steps }) {
  const [open, setOpen] = useState(false);
  if (!steps?.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          color: colors.blue600, fontSize: 13, fontFamily: fonts.body,
        }}
      >
        {open ? '▾' : '▸'} How to get this
      </button>
      {open && (
        <ol style={{ marginTop: 8, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {steps.map((s, i) => (
            <li key={i} style={{ fontSize: 13, color: colors.gray600, fontFamily: fonts.body, lineHeight: 1.7 }}>
              {s}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default function CredentialField({
  fieldKey, label: lbl, secret, fieldData, hintText, steps, onChange, editingKey, setEditingKey,
}) {
  const isSet     = fieldData?.set ?? false;
  const preview   = fieldData?.preview ?? null;
  const value     = fieldData?.value ?? '';
  const isEditing = editingKey === fieldKey;
  const [draft, setDraft] = useState(value);

  useEffect(() => { setDraft(value); }, [value]);

  function startEdit()  { setDraft(value); setEditingKey(fieldKey); }
  function cancelEdit() { setDraft(value); setEditingKey(null); }
  function commitEdit() { onChange(fieldKey, draft.trim()); setEditingKey(null); }

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <label style={{ fontSize: 12, fontWeight: 500, color: '#374151', fontFamily: fonts.body }}>
          {lbl}
        </label>
        <Badge variant={isSet ? 'success' : 'warning'}>{isSet ? 'Set' : 'Not set'}</Badge>
      </div>

      {secret ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: colors.gray50, border: `1px solid ${isSet ? colors.gray200 : '#FCD34D'}`,
          borderRadius: 6, padding: '7px 12px',
        }}>
          <span style={{
            fontFamily: fonts.mono, fontSize: 13, flex: 1,
            color: isSet ? colors.gray900 : colors.gray400,
            letterSpacing: isSet ? '0.04em' : 'normal',
          }}>
            {isSet ? preview : 'Not configured'}
          </span>
          <span style={{
            fontFamily: fonts.mono, fontSize: 11, color: colors.gray400,
            background: colors.gray100, border: `1px solid ${colors.gray200}`,
            borderRadius: 4, padding: '2px 8px', flexShrink: 0,
          }}>
            🔒 .env only
          </span>
        </div>
      ) : isEditing ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') cancelEdit(); }}
            style={{
              flex: 1, fontFamily: fonts.mono, fontSize: 13,
              border: `2px solid ${colors.blue600}`, borderRadius: 6,
              padding: '6px 11px', outline: 'none', height: 36,
            }}
          />
          <button onClick={commitEdit} style={btnPrimSm}>Save</button>
          <button onClick={cancelEdit} style={btnSecSm}>✕</button>
        </div>
      ) : (
        <div onClick={startEdit} title="Click to edit" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'text',
          background: colors.white, border: `1px solid ${isSet ? colors.gray200 : '#FCD34D'}`,
          borderRadius: 6, padding: '7px 12px',
        }}>
          <span style={{ fontSize: 13, color: isSet ? colors.gray900 : colors.gray400, fontFamily: fonts.mono }}>
            {isSet ? value : 'Click to configure…'}
          </span>
          <span style={{ fontSize: 11, color: colors.gray400, fontFamily: fonts.body, marginLeft: 8 }}>Edit</span>
        </div>
      )}

      {hintText && (
        <p style={{ fontSize: 12, color: colors.gray600, marginTop: 4, fontFamily: fonts.body, lineHeight: 1.5 }}>
          {hintText}
        </p>
      )}
      {secret && isSet && (
        <p style={{ fontSize: 12, color: colors.gray400, marginTop: 4, fontFamily: fonts.body }}>
          To change: edit <code style={{ fontFamily: fonts.mono, background: colors.gray100, padding: '1px 4px', borderRadius: 3 }}>backend/.env</code> then restart the server.
        </p>
      )}
      {!isSet && <HowTo steps={steps} />}
    </div>
  );
}

const btnPrimSm = {
  height: 34, padding: '0 12px', background: colors.blue600, color: '#fff',
  border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', flexShrink: 0,
};
const btnSecSm = {
  height: 34, padding: '0 12px', background: '#fff', color: '#374151',
  border: `1px solid ${colors.gray300}`, borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', flexShrink: 0,
};
