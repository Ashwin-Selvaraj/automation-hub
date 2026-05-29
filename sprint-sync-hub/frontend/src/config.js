export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export const COLORS = {
  bg: '#07080F',
  surface: '#0E0F1A',
  card: '#131422',
  border: '#1A1B2E',
  primary: '#7C6AFF',
  secondary: '#00D9C8',
  warning: '#FFC147',
  error: '#FF4757',
  success: '#00C896',
  text: '#EEEEFF',
  muted: '#5A5B75',
};

export const FONTS = {
  body: "'DM Sans', sans-serif",
  heading: "'Syne', sans-serif",
  mono: "'DM Mono', monospace",
};

export const card = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 16,
  padding: 24,
};

export const aiBox = {
  background: '#0A1A18',
  border: `1px solid ${COLORS.secondary}`,
  borderRadius: 10,
  padding: 16,
  fontFamily: FONTS.mono,
  fontSize: 13,
  color: COLORS.secondary,
  lineHeight: 1.7,
  whiteSpace: 'pre-wrap',
};

export const label = {
  display: 'block',
  fontFamily: FONTS.mono,
  fontSize: 11,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: COLORS.muted,
  marginBottom: 6,
};

export const input = {
  width: '100%',
  background: COLORS.surface,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  padding: '10px 14px',
  color: COLORS.text,
  fontFamily: FONTS.body,
  fontSize: 14,
  outline: 'none',
};

export const hint = {
  fontFamily: FONTS.mono,
  fontSize: 11,
  color: COLORS.muted,
  marginTop: 4,
};

export const btnPrimary = {
  background: 'linear-gradient(135deg, #7C6AFF, #5B4FCC)',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  padding: '10px 20px',
  fontFamily: FONTS.body,
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
  transition: 'opacity 0.15s',
};

export const btnSecondary = {
  background: COLORS.surface,
  color: COLORS.text,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  padding: '10px 20px',
  fontFamily: FONTS.body,
  fontWeight: 500,
  fontSize: 14,
  cursor: 'pointer',
  transition: 'opacity 0.15s',
};
