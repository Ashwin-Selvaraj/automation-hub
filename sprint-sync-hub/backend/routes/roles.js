'use strict';

const express              = require('express');
const router               = express.Router();
const roleRepository       = require('../repositories/roleRepository');
const memberRoleRepository = require('../repositories/memberRoleRepository');
const memberRepository     = require('../repositories/memberRepository');
const activityLog          = require('../services/activityLog');

const ORG_ID = () => parseInt(process.env.ORGANISATION_ID || '1', 10);

// ─── GET /api/roles ───────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { type } = req.query;
    let roles = await roleRepository.findAll(ORG_ID());
    if (type === 'technical' || type === 'managerial') {
      roles = roles.filter((r) => r.role_type === type);
    }
    res.json(roles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/roles ──────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  try {
    const { name, role_type, receives_task_dms, can_be_assigned_tasks, skill_keywords, colour } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const role = await roleRepository.create(ORG_ID(), {
      name, slug, role_type, receives_task_dms, can_be_assigned_tasks, skill_keywords, colour,
    });
    activityLog.addEntry({ type: 'role_created', action: `Role created: ${name}`, success: true });
    res.status(201).json(role);
  } catch (err) {
    if (err.message.includes('unique') || err.message.includes('duplicate')) {
      return res.status(409).json({ error: 'A role with this name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/roles/:roleId ─────────────────────────────────────────────────

router.patch('/:roleId', async (req, res) => {
  try {
    const { roleId } = req.params;
    const role = await roleRepository.findById(roleId);
    if (!role) return res.status(404).json({ error: 'Role not found' });

    const updated = await roleRepository.update(roleId, req.body);
    activityLog.addEntry({ type: 'role_updated', action: `Role updated: ${role.name}`, success: true });
    res.json(updated);
  } catch (err) {
    if (err.message.startsWith('Cannot change')) return res.status(403).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/roles/:roleId ────────────────────────────────────────────────

router.delete('/:roleId', async (req, res) => {
  try {
    const { roleId } = req.params;
    const deactivated = await roleRepository.deactivate(roleId);
    activityLog.addEntry({ type: 'role_deactivated', action: `Role deactivated: ${deactivated.name}`, success: true });
    res.json({ ok: true, role: deactivated });
  } catch (err) {
    if (err.message.startsWith('Cannot deactivate')) return res.status(400).json({ error: err.message });
    if (err.message === 'Role not found') return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/roles/:roleId/members ──────────────────────────────────────────

router.get('/:roleId/members', async (req, res) => {
  try {
    const role = await roleRepository.findById(req.params.roleId);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    const members = await memberRoleRepository.getMembersWithRole(ORG_ID(), role.slug);
    res.json({ role, members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/members/:memberId/roles ─────────────────────────────────────────

router.get('/members/:memberId/roles', async (req, res) => {
  try {
    const { memberId } = req.params;
    const member = await memberRepository.findById(memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const memberWithRoles = await memberRoleRepository.getMemberWithRoles(memberId);
    const roleHistory     = await memberRoleRepository.getRoleHistory(memberId);

    res.json({
      member: { id: member.id, name: member.name, slackUserId: member.slack_user_id },
      roles: memberWithRoles?.roles || [],
      shouldReceiveTaskDms: memberWithRoles?.shouldReceiveTaskDms ?? true,
      roleHistory,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/members/:memberId/roles ─────────────────────────────────────────

router.put('/members/:memberId/roles', async (req, res) => {
  try {
    const { memberId } = req.params;
    const { updatedBy } = req.body;
    // Parse roleIds as integers — JSON may deliver them as strings or numbers
    const roleIds = (req.body.roleIds || []).map((id) => parseInt(id, 10)).filter((id) => !isNaN(id));

    if (!Array.isArray(req.body.roleIds)) return res.status(400).json({ error: 'roleIds must be an array' });

    const member = await memberRepository.findById(memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const result = await memberRoleRepository.setMemberRoles(memberId, roleIds, updatedBy || null);
    const memberWithRoles = await memberRoleRepository.getMemberWithRoles(memberId);

    // Warn if member now has only managerial roles
    let warning = null;
    if (memberWithRoles && memberWithRoles.roles.length > 0 && !memberWithRoles.hasTechnicalRole) {
      warning = `${member.name} now has only managerial roles and will no longer receive automated DMs.`;
    }

    activityLog.addEntry({
      type:     'roles_updated',
      userName: member.name,
      action:   `Roles updated: +${result.added.length} added, -${result.removed.length} removed`,
      success:  true,
    });

    res.json({
      success:  true,
      changes:  { added: result.added, removed: result.removed, unchanged: result.unchanged },
      member:   memberWithRoles,
      warning,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/members/:memberId/roles/:roleId ────────────────────────────────

router.post('/members/:memberId/roles/:roleId', async (req, res) => {
  try {
    const { memberId, roleId } = req.params;
    const { assignedBy } = req.body;

    const member = await memberRepository.findById(memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const role = await roleRepository.findById(roleId);
    if (!role) return res.status(404).json({ error: 'Role not found' });

    const assignment = await memberRoleRepository.assignRole(memberId, roleId, assignedBy || null);

    activityLog.addEntry({
      type:     'role_assigned',
      userName: member.name,
      action:   `Role assigned: ${role.name} → ${member.name}`,
      success:  true,
    });

    res.json(assignment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/members/:memberId/roles/:roleId ──────────────────────────────

router.delete('/members/:memberId/roles/:roleId', async (req, res) => {
  try {
    const { memberId, roleId } = req.params;
    const { removedBy } = req.body;

    const member = await memberRepository.findById(memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const role = await roleRepository.findById(roleId);
    if (!role) return res.status(404).json({ error: 'Role not found' });

    const removed = await memberRoleRepository.removeRole(memberId, roleId, removedBy || null);
    if (!removed) return res.status(404).json({ error: 'Role not currently assigned to member' });

    const memberWithRoles = await memberRoleRepository.getMemberWithRoles(memberId);
    let warning = null;
    if (memberWithRoles && memberWithRoles.roles.length > 0 && !memberWithRoles.hasTechnicalRole) {
      warning = `${member.name} now has only managerial roles and will no longer receive automated DMs.`;
    }

    activityLog.addEntry({
      type:     'role_removed',
      userName: member.name,
      action:   `Role removed: ${role.name} from ${member.name}`,
      success:  true,
    });

    res.json({ ok: true, warning });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
