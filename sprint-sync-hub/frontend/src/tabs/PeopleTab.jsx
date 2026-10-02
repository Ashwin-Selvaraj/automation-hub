import React, { useEffect, useState, useCallback } from 'react';
import { theme } from '../theme.js';
import Card, { SectionHeader } from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Spinner from '../components/Spinner.jsx';
import {
  getPeople, setOneOnOneSchedule, getOneOnOnePrep, getOneOnOnes, recordOneOnOne,
  setFollowUpDone, getRecognition, getEvidence, downloadEvidence,
} from '../api.js';

const { colors, fonts } = theme;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CADENCES = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
];

const fieldStyle = {
  height: 32, border: `1px solid ${colors.gray300}`, borderRadius: 6, padding: '0 8px',
  fontSize: 13, fontFamily: fonts.body, color: colors.gray900, background: colors.white,
  boxSizing: 'border-box',
};
const muted = { fontSize: 12, color: colors.gray600 };
const listStyle = { margin: '4px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: colors.gray700 };

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
}

function ErrorLine({ error }) {
  if (!error) return null;
  return <div role="alert" style={{ ...muted, color: colors.red600 || '#DC2626', marginTop: 8 }}>{error}</div>;
}

function Section({ title, children }) {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: colors.gray700, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

// ─── Recognition ──────────────────────────────────────────────────────────────

function RecognitionCard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getRecognition().then(setData).catch((e) => setError(e.message));
  }, []);

  return (
    <Card>
      <SectionHeader>Worth recognising this week</SectionHeader>
      {!data && !error && <Spinner />}
      <ErrorLine error={error} />
      {data && (
        <>
          {data.people.length === 0 && <div style={muted}>Nothing specific in Jira or GitHub this week.</div>}
          {data.people.map((p) => (
            <div key={p.memberId} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: colors.gray900 }}>{p.name}</div>
              <ul style={listStyle}>{p.items.map((item, i) => <li key={i}>{item.text}</li>)}</ul>
            </div>
          ))}
          <div style={{ ...muted, marginTop: 8 }}>
            {data.from} to {data.to}. Suggestions for you to acknowledge in your own words — nothing is posted.
            People not listed may have done work these tools can’t see.
            {data.github === 'not-configured' && ' GitHub is not connected, so reviews are not included.'}
            {data.github === 'timed-out' && ' GitHub took too long, so reviews are missing.'}
          </div>
        </>
      )}
    </Card>
  );
}

// ─── One person ───────────────────────────────────────────────────────────────

function ScheduleRow({ member, onSaved }) {
  const [weekday, setWeekday] = useState(member.one_on_one_weekday ?? '');
  const [cadence, setCadence] = useState(member.one_on_one_cadence || 'weekly');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setWeekday(member.one_on_one_weekday ?? '');
    setCadence(member.one_on_one_cadence || 'weekly');
  }, [member.id, member.one_on_one_weekday, member.one_on_one_cadence]);

  async function save(nextWeekday, nextCadence) {
    setBusy(true); setError(null);
    try {
      await setOneOnOneSchedule(member.id, nextWeekday === '' ? null : Number(nextWeekday), nextCadence);
      onSaved();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={muted} htmlFor="oo-weekday">1:1 day</label>
        <select id="oo-weekday" style={fieldStyle} value={weekday} disabled={busy}
          onChange={(e) => { setWeekday(e.target.value); save(e.target.value, cadence); }}>
          <option value="">No regular 1:1</option>
          {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select>
        <select aria-label="Cadence" style={fieldStyle} value={cadence} disabled={busy || weekday === ''}
          onChange={(e) => { setCadence(e.target.value); save(weekday, e.target.value); }}>
          {CADENCES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        {busy && <Spinner size={14} />}
      </div>
      <div style={{ ...muted, marginTop: 4 }}>
        {weekday === ''
          ? 'Set a day and you’ll get a prep DM that morning.'
          : 'You’ll get a prep DM that morning. Fortnightly and monthly count from the last 1:1 you record.'}
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

function FollowUp({ action, firstName, onToggle }) {
  const [busy, setBusy] = useState(false);
  const done = Boolean(action.done_at);
  return (
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, color: colors.gray700, padding: '2px 0' }}>
      <input type="checkbox" checked={done} disabled={busy}
        onChange={async () => { setBusy(true); try { await onToggle(action, !done); } finally { setBusy(false); } }} />
      <span style={{ textDecoration: done ? 'line-through' : 'none', color: done ? colors.gray400 : undefined }}>
        <strong>{action.owner === 'lead' ? 'You' : firstName}:</strong> {action.text}
      </span>
    </label>
  );
}

function PrepView({ prep, onToggleAction }) {
  const firstName = prep.member.name.split(/\s+/)[0];
  const followUps = [...prep.actions.open, ...prep.actions.closedSinceLast];
  return (
    <div>
      <div style={muted}>
        {prep.lastHeldOn ? `Since your last recorded 1:1 on ${prep.lastHeldOn}.` : 'No earlier 1:1 recorded, so this covers the last two weeks.'}
      </div>

      {followUps.length > 0 && (
        <Section title="Follow-ups">
          {followUps.map((a) => <FollowUp key={a.id} action={a} firstName={firstName} onToggle={onToggleAction} />)}
        </Section>
      )}

      <Section title="Worth asking about">
        <ul style={listStyle}>{prep.topics.map((t, i) => <li key={i}>{t}</li>)}</ul>
      </Section>

      {prep.shipped.length > 0 && (
        <Section title={`Closed since then (${prep.shipped.length})`}>
          <ul style={listStyle}>{prep.shipped.map((t) => <li key={t.key}><strong>{t.key}</strong> {t.title}</li>)}</ul>
        </Section>
      )}

      {prep.inFlight.length > 0 && (
        <Section title={`In progress now (${prep.inFlight.length})`}>
          <ul style={listStyle}>
            {prep.inFlight.map((t) => (
              <li key={t.key}>
                <strong>{t.key}</strong> {t.title} <span style={muted}>({t.status}{t.idleDays >= 5 ? ` · no movement in ${t.idleDays} days` : ''})</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {prep.mentions.length > 0 && (
        <Section title="In their own words">
          <ul style={listStyle}>{prep.mentions.map((m, i) => <li key={i}>{m.date}: “{m.text}”</li>)}</ul>
        </Section>
      )}

      {(prep.theirPrs.length > 0 || prep.reviewsOwed.length > 0) && (
        <Section title="Code review">
          <ul style={listStyle}>
            {prep.theirPrs.map((p) => (
              <li key={`${p.repo}#${p.number}`}>
                Their <a href={p.url} target="_blank" rel="noreferrer" style={{ color: colors.linkBlue }}>#{p.number} {p.title}</a> is waiting for review ({Math.round(p.waitingHours)}h)
              </li>
            ))}
            {prep.reviewsOwed.length > 0 && <li>{prep.reviewsOwed.length} review request{prep.reviewsOwed.length === 1 ? '' : 's'} waiting on them</li>}
          </ul>
        </Section>
      )}
      {prep.github === 'pending' && <div style={{ ...muted, marginTop: 8 }}>GitHub data is still loading — refresh in a moment.</div>}

      {prep.lastNotes && (
        <Section title={`Your notes from ${prep.lastHeldOn}`}>
          <div style={{ fontSize: 13, color: colors.gray700, whiteSpace: 'pre-wrap' }}>{prep.lastNotes}</div>
        </Section>
      )}

      <div style={{ ...muted, marginTop: 16, fontStyle: 'italic' }}>What the tools can see. The 1:1 is for what they can’t.</div>
    </div>
  );
}

function RecordForm({ member, onRecorded }) {
  const firstName = member.name.split(/\s+/)[0];
  const [heldOn, setHeldOn] = useState(localToday());
  const [notes, setNotes] = useState('');
  const [actions, setActions] = useState([{ owner: 'lead', text: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const update = (i, patch) => setActions((list) => list.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null); setSaved(false);
    try {
      await recordOneOnOne(member.id, { heldOn, notes, actions: actions.filter((a) => a.text.trim()) });
      setNotes(''); setActions([{ owner: 'lead', text: '' }]); setSaved(true);
      onRecorded();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={muted} htmlFor="oo-date">Held on</label>
        <input id="oo-date" type="date" style={fieldStyle} value={heldOn} max={localToday()} onChange={(e) => setHeldOn(e.target.value)} required />
      </div>
      <textarea
        aria-label="Notes"
        placeholder="Notes — private to you, stored encrypted, never included in evidence packs or the activity log"
        value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={10000}
        style={{ ...fieldStyle, height: 96, width: '100%', padding: 8, marginTop: 8, resize: 'vertical' }}
      />
      <div style={{ ...muted, marginTop: 8 }}>Follow-ups agreed</div>
      {actions.map((a, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <select aria-label="Who" style={{ ...fieldStyle, flexShrink: 0 }} value={a.owner} onChange={(e) => update(i, { owner: e.target.value })}>
            <option value="lead">You</option>
            <option value="member">{firstName}</option>
          </select>
          <input aria-label="Follow-up" style={{ ...fieldStyle, flex: 1, minWidth: 0 }} value={a.text} maxLength={500}
            placeholder="e.g. Find out about the conference budget" onChange={(e) => update(i, { text: e.target.value })} />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="secondary" size="sm" onClick={() => setActions((l) => [...l, { owner: 'lead', text: '' }])}>Add follow-up</Button>
        <Button type="submit" size="sm" disabled={busy}>{busy ? 'Saving…' : 'Record 1:1'}</Button>
        {saved && <span style={{ ...muted, color: colors.green600 }}>Recorded.</span>}
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

function History({ oneOnOnes }) {
  const [open, setOpen] = useState(null);
  if (oneOnOnes.length === 0) return <div style={muted}>No 1:1s recorded yet.</div>;
  return (
    <ul style={{ ...listStyle, listStyle: 'none', paddingLeft: 0 }}>
      {oneOnOnes.map((o) => (
        <li key={o.id}>
          <button type="button" onClick={() => setOpen(open === o.id ? null : o.id)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: colors.linkBlue, fontSize: 13, fontFamily: fonts.body }}>
            {dateOnly(o.held_on)}
          </button>
          {open === o.id && (
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: colors.gray700, margin: '4px 0 8px' }}>
              {o.notes || <span style={muted}>No notes.</span>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function EvidencePanel({ member }) {
  const today = localToday();
  const [from, setFrom] = useState(shiftDays(today, -182));
  const [to, setTo] = useState(today);
  const [pack, setPack] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { setPack(null); setError(null); }, [member.id]);

  async function preview() {
    setBusy(true); setError(null);
    try { setPack((await getEvidence(member.id, from, to)).pack); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function download() {
    setBusy(true); setError(null);
    try {
      const { name, text } = await downloadEvidence(member.id, from, to);
      const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const d = pack?.deadlines;
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="date" aria-label="From" style={fieldStyle} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <span style={muted}>to</span>
        <input type="date" aria-label="To" style={fieldStyle} value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
        <Button variant="secondary" size="sm" disabled={busy} onClick={preview}>Preview</Button>
        <Button size="sm" disabled={busy} onClick={download}>Download Markdown</Button>
        {busy && <Spinner size={14} />}
      </div>
      <ErrorLine error={error} />
      {pack && (
        <div style={{ marginTop: 12, fontSize: 13, color: colors.gray700 }}>
          <div>
            {pack.completed.total} task{pack.completed.total === 1 ? '' : 's'} closed
            {Object.keys(pack.completed.byType).length > 0 && ` (${Object.entries(pack.completed.byType).map(([t, n]) => `${t}: ${n}`).join(', ')})`}
            {' · '}due dates: {d.onTime.length} on time, {d.late.length} late, {d.open.length} still open past due
            {pack.member.githubLogin && ` · ${pack.github.authored.length} PRs merged, ${pack.github.reviewed.length} teammates’ PRs reviewed`}
          </div>
          <Section title="What this does not show">
            <ul style={listStyle}>{pack.limits.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </Section>
        </div>
      )}
      <div style={{ ...muted, marginTop: 8 }}>Facts with their sources, for a review you write. No scores, no comparison with teammates, no 1:1 notes.</div>
    </div>
  );
}

function PersonPanel({ member, onChanged }) {
  const [prep, setPrep] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    getOneOnOnePrep(member.id).then((r) => setPrep(r.prep)).catch((e) => setError(e.message));
    getOneOnOnes(member.id).then((r) => setHistory(r.oneOnOnes)).catch(() => {});
  }, [member.id]);

  useEffect(() => { setPrep(null); setHistory([]); load(); }, [load]);

  async function toggleAction(action, done) {
    try {
      await setFollowUpDone(action.id, done);
      load(); onChanged();
    } catch (e) { setError(e.message); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <Card>
        <SectionHeader>{member.name}</SectionHeader>
        <ScheduleRow member={member} onSaved={onChanged} />
      </Card>
      <Card>
        <SectionHeader>1:1 prep</SectionHeader>
        <ErrorLine error={error} />
        {!prep && !error && <Spinner />}
        {prep && <PrepView prep={prep} onToggleAction={toggleAction} />}
      </Card>
      <Card>
        <SectionHeader>Record a 1:1</SectionHeader>
        <RecordForm member={member} onRecorded={() => { load(); onChanged(); }} />
        <Section title="Earlier 1:1s"><History oneOnOnes={history} /></Section>
      </Card>
      <Card>
        <SectionHeader>Review evidence</SectionHeader>
        <EvidencePanel member={member} />
      </Card>
    </div>
  );
}

// ─── Tab ──────────────────────────────────────────────────────────────────────

export default function PeopleTab() {
  const [members, setMembers] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    getPeople().then((r) => {
      setMembers(r.members);
      setSelectedId((id) => id ?? r.members[0]?.id ?? null);
    }).catch((e) => setError(e.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  const selected = members?.find((m) => m.id === selectedId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: colors.gray900, margin: 0 }}>People</h1>
        <p style={{ ...muted, fontSize: 13, margin: '4px 0 0' }}>
          1:1 prep, follow-ups, recognition and review evidence. Only you see this — nothing here is sent to the people it is about.
        </p>
      </div>

      <ErrorLine error={error} />
      {!members && !error && <Spinner />}

      {members && members.length === 0 && (
        <Card><div style={muted}>No team members yet. Add them on the Team tab.</div></Card>
      )}

      {members && members.length > 0 && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <Card padding="8px 0" style={{ flex: '1 1 220px', maxWidth: 320 }}>
            {members.map((m) => {
              const active = m.id === selectedId;
              return (
                <button key={m.id} type="button" onClick={() => setSelectedId(m.id)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                    background: active ? colors.blue50 : 'transparent', padding: '8px 16px', fontFamily: fonts.body,
                    borderLeft: `2px solid ${active ? colors.blue600 : 'transparent'}`,
                  }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: active ? colors.blue600 : colors.gray900 }}>{m.name}</div>
                  <div style={muted}>
                    {m.one_on_one_weekday != null ? `${WEEKDAYS[m.one_on_one_weekday]}s, ${m.one_on_one_cadence}` : 'No regular 1:1'}
                    {m.last_held_on && ` · last ${dateOnly(m.last_held_on)}`}
                    {m.open_actions > 0 && ` · ${m.open_actions} open follow-up${m.open_actions === 1 ? '' : 's'}`}
                  </div>
                </button>
              );
            })}
          </Card>
          <div style={{ flex: '3 1 420px', minWidth: 0 }}>
            {selected && <PersonPanel key={selected.id} member={selected} onChanged={load} />}
          </div>
        </div>
      )}

      <RecognitionCard />
    </div>
  );
}
