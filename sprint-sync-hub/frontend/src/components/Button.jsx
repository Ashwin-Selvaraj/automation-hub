import React, { useState } from 'react';
import { theme } from '../theme.js';

const { colors, fonts } = theme;

const base = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  height: 34,
  padding: '0 16px',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  fontFamily: fonts.body,
  cursor: 'pointer',
  border: 'none',
  outline: 'none',
  whiteSpace: 'nowrap',
  transition: 'background 120ms',
  textDecoration: 'none',
};

const smOverride = { height: 28, padding: '0 12px', fontSize: 12 };

export default function Button({
  variant = 'primary',
  size = 'md',
  disabled = false,
  onClick,
  children,
  style = {},
  type = 'button',
}) {
  const [hovered, setHovered] = useState(false);

  let variantStyle = {};
  if (variant === 'primary') {
    variantStyle = {
      background: disabled ? '#93C5FD' : hovered ? '#1D4ED8' : colors.blue600,
      color: colors.white,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.7 : 1,
    };
  } else if (variant === 'secondary') {
    variantStyle = {
      background: hovered ? colors.gray50 : colors.white,
      color: colors.gray700,
      border: `1px solid ${colors.gray300}`,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.6 : 1,
    };
  } else if (variant === 'danger') {
    variantStyle = {
      background: hovered ? colors.red50 : colors.white,
      color: colors.red600,
      border: '1px solid #FCA5A5',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.6 : 1,
    };
  }

  return (
    <button
      type={type}
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => !disabled && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ ...base, ...variantStyle, ...(size === 'sm' ? smOverride : {}), ...style }}
    >
      {children}
    </button>
  );
}
