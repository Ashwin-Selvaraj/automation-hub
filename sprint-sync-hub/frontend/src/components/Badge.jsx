import React from 'react';
import { theme } from '../theme.js';

const { colors, fonts } = theme;

const VARIANTS = {
  success: { background: colors.green50,  color: colors.green600 },
  warning: { background: colors.amber50,  color: colors.amber600 },
  error:   { background: colors.red50,    color: colors.red600   },
  neutral: { background: colors.gray100,  color: colors.gray600  },
  info:    { background: colors.blue50,   color: colors.blue600  },
};

export default function Badge({ variant = 'neutral', children, style = {} }) {
  const v = VARIANTS[variant] || VARIANTS.neutral;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 12,
      fontWeight: 500,
      fontFamily: fonts.body,
      whiteSpace: 'nowrap',
      background: v.background,
      color: v.color,
      ...style,
    }}>
      {children}
    </span>
  );
}
