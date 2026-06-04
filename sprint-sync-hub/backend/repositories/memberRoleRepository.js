'use strict';

const db = require('../db');

async function getMemberRoles(memberId) {
  try {
    const { rows } = await db.query(
      `SELECT mr.id, mr.role_id, r.name AS role_name, r.slug AS role_slug,
              r.role_type, r.colour, r.receives_task_dms, r.can_be_assigned_tasks,
              mr.assigned_at
       FROM member_roles mr
       JOIN roles r ON r.id = mr.role_id
       WHERE mr.member_id = $1 AND mr.is_active = true AND r.is_active = true
       ORDER BY r.display_order, r.name`,
      [memberId]
    );
    return rows.map((r) => ({
      id:                 r.id,
      roleId:             r.role_id,
      roleName:           r.role_name,
      roleSlug:           r.role_slug,
      roleType:           r.role_type,
      colour:             r.colour,
      receivesDms:        r.receives_task_dms,
      canBeAssignedTasks: r.can_be_assigned_tasks,
      assignedAt:         r.assigned_at,
    }));
  } catch (err) {
    console.error('[memberRoleRepository.getMemberRoles]', err.message);
    throw err;
  }
}

async function getMemberWithRoles(memberId) {
  try {
    const { rows: memberRows } = await db.query(
      'SELECT * FROM members WHERE id = $1',
      [memberId]
    );
    if (!memberRows[0]) return null;
    const member = memberRows[0];

    const { rows: roleRows } = await db.query(
      `SELECT r.id, r.name, r.slug, r.role_type, r.colour,
              r.receives_task_dms, r.can_be_assigned_tasks, r.skill_keywords,
              mr.assigned_at
       FROM member_roles mr
       JOIN roles r ON r.id = mr.role_id
       WHERE mr.member_id = $1 AND mr.is_active = true AND r.is_active = true
       ORDER BY r.display_order, r.name`,
      [memberId]
    );

    const roles = roleRows.map((r) => ({
      id:                 r.id,
      name:               r.name,
      slug:               r.slug,
      role_type:          r.role_type,
      colour:             r.colour,
      receives_task_dms:  r.receives_task_dms,
      can_be_assigned_tasks: r.can_be_assigned_tasks,
      skill_keywords:     r.skill_keywords || [],
      assignedAt:         r.assigned_at,
    }));

    const hasTechnicalRole  = roles.some((r) => r.role_type === 'technical');
    const hasManagerialRole = roles.some((r) => r.role_type === 'managerial');
    const shouldReceiveTaskDms = roles.length === 0
      ? true
      : roles.some((r) => r.role_type === 'technical' && r.receives_task_dms);

    // Combine all skill keywords from technical roles
    const allSkillKeywords = [...new Set(
      roles.filter((r) => r.role_type === 'technical').flatMap((r) => r.skill_keywords || [])
    )];

    return {
      memberId:            member.id,
      name:                member.name,
      slackUserId:         member.slack_user_id,
      email:               member.email,
      roles,
      hasTechnicalRole,
      hasManagerialRole,
      shouldReceiveTaskDms,
      allSkillKeywords,
    };
  } catch (err) {
    console.error('[memberRoleRepository.getMemberWithRoles]', err.message);
    throw err;
  }
}

async function getAllMembersWithRoles(organisationId) {
  try {
    const { rows: members } = await db.query(
      'SELECT * FROM members WHERE organisation_id = $1 AND is_active = true ORDER BY name',
      [organisationId]
    );

    const { rows: allRoleRows } = await db.query(
      `SELECT mr.member_id, r.id, r.name, r.slug, r.role_type, r.colour,
              r.receives_task_dms, r.can_be_assigned_tasks, r.skill_keywords,
              mr.assigned_at
       FROM member_roles mr
       JOIN roles r ON r.id = mr.role_id
       JOIN members m ON m.id = mr.member_id
       WHERE m.organisation_id = $1 AND mr.is_active = true AND r.is_active = true
       ORDER BY mr.member_id, r.display_order, r.name`,
      [organisationId]
    );

    // Group role rows by member_id
    const rolesByMember = {};
    for (const row of allRoleRows) {
      if (!rolesByMember[row.member_id]) rolesByMember[row.member_id] = [];
      rolesByMember[row.member_id].push({
        id:                    row.id,
        name:                  row.name,
        slug:                  row.slug,
        role_type:             row.role_type,
        colour:                row.colour,
        receives_task_dms:     row.receives_task_dms,
        can_be_assigned_tasks: row.can_be_assigned_tasks,
        skill_keywords:        row.skill_keywords || [],
        assignedAt:            row.assigned_at,
      });
    }

    return members.map((member) => {
      const roles = rolesByMember[member.id] || [];
      const hasTechnicalRole  = roles.some((r) => r.role_type === 'technical');
      const hasManagerialRole = roles.some((r) => r.role_type === 'managerial');
      const shouldReceiveTaskDms = roles.length === 0
        ? true
        : roles.some((r) => r.role_type === 'technical' && r.receives_task_dms);
      const allSkillKeywords = [...new Set(
        roles.filter((r) => r.role_type === 'technical').flatMap((r) => r.skill_keywords || [])
      )];
      return {
        memberId:            member.id,
        name:                member.name,
        slackUserId:         member.slack_user_id,
        email:               member.email,
        roles,
        hasTechnicalRole,
        hasManagerialRole,
        shouldReceiveTaskDms,
        allSkillKeywords,
      };
    });
  } catch (err) {
    console.error('[memberRoleRepository.getAllMembersWithRoles]', err.message);
    throw err;
  }
}

async function assignRole(memberId, roleId, assignedBy) {
  try {
    // Check for existing active assignment
    const { rows: existing } = await db.query(
      'SELECT * FROM member_roles WHERE member_id = $1 AND role_id = $2 AND is_active = true',
      [memberId, roleId]
    );
    if (existing[0]) return existing[0];

    // Re-activate a removed assignment if one exists
    const { rows: inactive } = await db.query(
      'SELECT * FROM member_roles WHERE member_id = $1 AND role_id = $2 AND is_active = false LIMIT 1',
      [memberId, roleId]
    );
    if (inactive[0]) {
      const { rows } = await db.query(
        `UPDATE member_roles
         SET is_active = true, removed_at = NULL, removed_by = NULL,
             assigned_at = NOW(), assigned_by = $1
         WHERE id = $2 RETURNING *`,
        [assignedBy || null, inactive[0].id]
      );
      return rows[0];
    }

    // Get organisation_id from member
    const { rows: memberRows } = await db.query('SELECT organisation_id FROM members WHERE id = $1', [memberId]);
    const orgId = memberRows[0]?.organisation_id;

    const { rows } = await db.query(
      `INSERT INTO member_roles (organisation_id, member_id, role_id, assigned_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [orgId, memberId, roleId, assignedBy || null]
    );
    return rows[0];
  } catch (err) {
    console.error('[memberRoleRepository.assignRole]', err.message);
    throw err;
  }
}

async function removeRole(memberId, roleId, removedBy) {
  try {
    const { rows } = await db.query(
      `UPDATE member_roles
       SET is_active = false, removed_at = NOW(), removed_by = $1
       WHERE member_id = $2 AND role_id = $3 AND is_active = true
       RETURNING *`,
      [removedBy || null, memberId, roleId]
    );
    return rows.length > 0;
  } catch (err) {
    console.error('[memberRoleRepository.removeRole]', err.message);
    throw err;
  }
}

async function setMemberRoles(memberId, newRoleIds, updatedBy) {
  try {
    const current = await getMemberRoles(memberId);
    const currentIds = current.map((r) => r.roleId);

    const toAdd    = newRoleIds.filter((id) => !currentIds.includes(id));
    const toRemove = currentIds.filter((id) => !newRoleIds.includes(id));
    const unchanged = currentIds.filter((id) => newRoleIds.includes(id));

    await Promise.all(toRemove.map((roleId) => removeRole(memberId, roleId, updatedBy)));
    await Promise.all(toAdd.map((roleId)    => assignRole(memberId, roleId, updatedBy)));

    return { added: toAdd, removed: toRemove, unchanged };
  } catch (err) {
    console.error('[memberRoleRepository.setMemberRoles]', err.message);
    throw err;
  }
}

async function getMembersWithRole(organisationId, roleSlug) {
  try {
    const { rows } = await db.query(
      `SELECT m.id, m.name, m.slack_user_id, m.email, mr.assigned_at
       FROM members m
       JOIN member_roles mr ON mr.member_id = m.id AND mr.is_active = true
       JOIN roles r ON r.id = mr.role_id AND r.slug = $2 AND r.is_active = true
       WHERE m.organisation_id = $1 AND m.is_active = true
       ORDER BY m.name`,
      [organisationId, roleSlug]
    );
    return rows;
  } catch (err) {
    console.error('[memberRoleRepository.getMembersWithRole]', err.message);
    throw err;
  }
}

async function getMembersWhoReceiveDMs(organisationId) {
  try {
    // Members who have at least one technical role with receives_task_dms = true,
    // plus members with NO roles assigned (default = receives DMs)
    const { rows } = await db.query(
      `SELECT DISTINCT m.id, m.name, m.slack_user_id, m.email
       FROM members m
       WHERE m.organisation_id = $1 AND m.is_active = true
         AND (
           -- Has at least one technical role that receives DMs
           EXISTS (
             SELECT 1 FROM member_roles mr
             JOIN roles r ON r.id = mr.role_id
             WHERE mr.member_id = m.id AND mr.is_active = true
               AND r.is_active = true AND r.role_type = 'technical'
               AND r.receives_task_dms = true
           )
           OR
           -- Has no roles assigned at all (default: receives DMs)
           NOT EXISTS (
             SELECT 1 FROM member_roles mr
             WHERE mr.member_id = m.id AND mr.is_active = true
           )
         )
       ORDER BY m.name`,
      [organisationId]
    );
    return rows;
  } catch (err) {
    console.error('[memberRoleRepository.getMembersWhoReceiveDMs]', err.message);
    throw err;
  }
}

async function getRoleHistory(memberId) {
  try {
    const { rows } = await db.query(
      `SELECT mr.id, r.id AS role_id, r.name AS role_name, r.slug AS role_slug,
              r.role_type, r.colour, mr.assigned_at, mr.removed_at, mr.is_active
       FROM member_roles mr
       JOIN roles r ON r.id = mr.role_id
       WHERE mr.member_id = $1
       ORDER BY mr.assigned_at DESC`,
      [memberId]
    );
    return rows;
  } catch (err) {
    console.error('[memberRoleRepository.getRoleHistory]', err.message);
    throw err;
  }
}

module.exports = {
  getMemberRoles,
  getMemberWithRoles,
  getAllMembersWithRoles,
  assignRole,
  removeRole,
  setMemberRoles,
  getMembersWithRole,
  getMembersWhoReceiveDMs,
  getRoleHistory,
};
