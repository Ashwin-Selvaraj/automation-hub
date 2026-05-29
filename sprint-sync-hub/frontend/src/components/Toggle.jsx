import React from 'react';
import { theme } from '../theme.js';

export default function Toggle({ checked, onChange, disabled = false }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        background: checked ? theme.colors.blue600 : theme.colors.gray300,
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        position: 'relative',
        transition: 'background 150ms',
        padding: 0,
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
        outline: 'none',
      }}
    >
      <div style={{
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: theme.colors.white,
        position: 'absolute',
        top: 2,
        left: checked ? 18 : 2,
        transition: 'left 150ms',
        boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
      }} />
    </button>
  );
}
