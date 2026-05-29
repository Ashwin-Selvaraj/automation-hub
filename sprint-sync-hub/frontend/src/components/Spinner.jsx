import React from 'react';
import { theme } from '../theme.js';

export default function Spinner({ size = 20 }) {
  return (
    <div
      aria-label="Loading"
      style={{
        width: size,
        height: size,
        border: `2px solid ${theme.colors.gray200}`,
        borderTopColor: theme.colors.blue600,
        borderRadius: '50%',
        animation: 'spin 600ms linear infinite',
        flexShrink: 0,
        display: 'inline-block',
      }}
    />
  );
}
