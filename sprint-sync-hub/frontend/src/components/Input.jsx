import React, { useState } from 'react';
import { theme } from '../theme.js';

const { colors, fonts } = theme;

export function Label({ children, htmlFor }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: 'block',
        fontSize: 12,
        fontWeight: 500,
        color: '#374151',
        marginBottom: 5,
        fontFamily: fonts.body,
      }}
    >
      {children}
    </label>
  );
}

export function Hint({ children }) {
  return (
    <p style={{
      fontSize: 12,
      color: colors.gray600,
      marginTop: 4,
      fontFamily: fonts.body,
      lineHeight: 1.5,
    }}>
      {children}
    </p>
  );
}

export default function Input({ value, onChange, placeholder, type = 'text', id, style = {}, ...rest }) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      id={id}
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        width: '100%',
        background: colors.white,
        border: focused ? `2px solid ${colors.blue600}` : `1px solid ${colors.gray300}`,
        borderRadius: 6,
        padding: focused ? '6px 11px' : '7px 12px',
        fontSize: 14,
        color: colors.gray900,
        height: 36,
        outline: 'none',
        fontFamily: fonts.body,
        boxSizing: 'border-box',
        ...style,
      }}
      {...rest}
    />
  );
}

export function FormGroup({ children, style = {} }) {
  return (
    <div style={{ marginBottom: 16, ...style }}>
      {children}
    </div>
  );
}
