import React from 'react';
import { theme } from '../theme.js';

function getInitials(name) {
  if (!name) return '??';
  return name.trim().split(/\s+/).map((w) => w[0] || '').join('').toUpperCase().slice(0, 2) || '??';
}

export default function Avatar({ name, initials, size = 28 }) {
  const text = (initials || getInitials(name)).slice(0, 2).toUpperCase();
  const fontSize = size <= 28 ? 11 : size <= 36 ? 12 : 13;
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: '50%',
      background: theme.colors.gray100,
      color: theme.colors.gray600,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize,
      fontWeight: 500,
      fontFamily: theme.fonts.body,
      flexShrink: 0,
      userSelect: 'none',
    }}>
      {text}
    </div>
  );
}
