import React from 'react';
import { theme } from '../theme.js';

const { colors, fonts } = theme;

export default function StatusDot({ connected, loading, text, size = 7 }) {
  const color = loading
    ? colors.gray400
    : connected
    ? colors.green600
    : colors.red600;

  const label = text || (loading ? 'Checking…' : connected ? 'Connected' : 'Disconnected');

  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 13,
      color: loading ? colors.gray400 : connected ? colors.green600 : colors.red600,
      fontFamily: fonts.body,
    }}>
      <span style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        display: 'inline-block',
        flexShrink: 0,
      }} />
      {label}
    </div>
  );
}
