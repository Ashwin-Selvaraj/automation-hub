'use strict';

const express       = require('express');
const router        = express.Router();
const zohoService   = require('../services/zohoService');
const configService = require('../services/configService');
const memberRepo    = require('../repositories/memberRepository');

function today() {
  return new Date().toISOString().split('T')[0];
}

// ─── GET /api/attendance/today ─────────────────────────────────────────────────
// Who is in, who is absent, who is on leave — right now.

router.get('/today', async (req, res) => {
  try {
    if (!zohoService.isConfigured()) {
      return res.json({ configured: false, message: 'Zoho not configured', present: [], absent: [], onLeave: [], late: [] });
    }

    const cfg     = configService.getSprintConfig();
    const orgId   = parseInt(process.env.ORGANISATION_ID || '1', 10);
    const dateStr = today();

    // Prefer DB members (have email); fall back to config members
    let members = await memberRepo.findAll(orgId);
    if (!members.length) members = cfg.teamMembers;

    const workStart = process.env.WORK_START_TIME || '09:00';

    const results = await Promise.all(
      members
        .filter((m) => m.email || m.email_address)
        .map(async (m) => {
          const email = m.email || m.email_address;
          const [att, leave] = await Promise.all([
            zohoService.getAttendance(email, dateStr).catch(() => null),
            zohoService.isOnLeave(email, dateStr).catch(() => ({ onLeave: false })),
          ]);
          const lateInfo = att?.checkedIn
            ? await zohoService.isLateCheckIn(email, dateStr, workStart).catch(() => ({ late: false, minutesLate: 0 }))
            : { late: false, minutesLate: 0 };
          return { member: { id: m.slack_id || m.id, name: m.name, email }, att, leave, lateInfo };
        })
    );

    const present  = results.filter((r) => r.att?.checkedIn && !r.leave?.onLeave);
    const onLeave  = results.filter((r) => r.leave?.onLeave);
    const absent   = results.filter((r) => !r.att?.checkedIn && !r.leave?.onLeave);
    const late     = results.filter((r) => r.lateInfo?.late);

    res.json({
      configured: true,
      date: dateStr,
      present:  present.map((r) => ({ ...r.member, checkInTime: r.att?.checkInTime, checkOutTime: r.att?.checkOutTime, hoursWorked: r.att?.hoursWorked })),
      onLeave:  onLeave.map((r)  => ({ ...r.member, leaveType: r.leave?.leaveType, reason: r.leave?.reason })),
      absent:   absent.map((r)   => ({ ...r.member })),
      late:     late.map((r)     => ({ ...r.member, checkInTime: r.att?.checkInTime, minutesLate: r.lateInfo?.minutesLate })),
      summary: { total: results.length, present: present.length, onLeave: onLeave.length, absent: absent.length, late: late.length },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/attendance/member/:memberId ─────────────────────────────────────
// One member's attendance for a specific date (default: today).

router.get('/member/:memberId', async (req, res) => {
  try {
    if (!zohoService.isConfigured()) {
      return res.json({ configured: false });
    }

    const orgId    = parseInt(process.env.ORGANISATION_ID || '1', 10);
    const dateStr  = req.query.date || today();
    const members  = await memberRepo.findAll(orgId);
    const member   = members.find((m) => String(m.id) === req.params.memberId || m.slack_id === req.params.memberId);

    if (!member || !member.email) {
      return res.status(404).json({ error: 'Member not found or has no email address for Zoho lookup' });
    }

    const workStart = process.env.WORK_START_TIME || '09:00';
    const [att, leave, lateInfo] = await Promise.all([
      zohoService.getAttendance(member.email, dateStr),
      zohoService.isOnLeave(member.email, dateStr),
      zohoService.getAttendance(member.email, dateStr).then((a) =>
        a?.checkedIn ? zohoService.isLateCheckIn(member.email, dateStr, workStart) : { late: false, minutesLate: 0 }
      ),
    ]);

    res.json({ configured: true, date: dateStr, member: { id: member.id, name: member.name, email: member.email }, att, leave, lateInfo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/attendance/late-today ──────────────────────────────────────────

router.get('/late-today', async (req, res) => {
  try {
    if (!zohoService.isConfigured()) {
      return res.json({ configured: false, late: [] });
    }

    const orgId     = parseInt(process.env.ORGANISATION_ID || '1', 10);
    const dateStr   = today();
    const workStart = process.env.WORK_START_TIME || '09:00';
    const members   = await memberRepo.findAll(orgId);

    const results = await Promise.all(
      members
        .filter((m) => m.email)
        .map(async (m) => {
          const lateInfo = await zohoService.isLateCheckIn(m.email, dateStr, workStart).catch(() => ({ late: false, minutesLate: 0 }));
          if (!lateInfo.late) return null;
          const att = await zohoService.getAttendance(m.email, dateStr).catch(() => null);
          return { member: { id: m.slack_id || m.id, name: m.name, email: m.email }, checkInTime: att?.checkInTime, minutesLate: lateInfo.minutesLate };
        })
    );

    res.json({ configured: true, date: dateStr, late: results.filter(Boolean) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
