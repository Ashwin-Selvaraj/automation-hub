import React from 'react';
import { theme } from '../theme.js';

export default function Card({ children, style = {}, padding = '20px 24px' }) {
  return (
    <div style={{
      background: theme.colors.white,
      border: `1px solid ${theme.colors.gray200}`,
      borderRadius: 6,
      padding,
      boxShadow: theme.shadows.card,
      ...style,
    }}>
      {children}
    </div>
  );
}

export function SectionHeader({ children, style = {} }) {
  return (
    <div style={{
      fontSize: 11,
      fontWeight: 600,
      color: '#6B7280',
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      paddingBottom: 10,
      borderBottom: '1px solid #F3F4F6',
      marginBottom: 16,
      fontFamily: theme.fonts.body,
      ...style,
    }}>
      {children}
    </div>
  );
}
