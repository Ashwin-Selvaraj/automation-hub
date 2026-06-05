'use strict';

const { query, getClient } = require('../db');

// ─── getMemberRoles ───────────────────────────────────────────────────────────

async function getMemberRoles(memberId) {
  try {
    const { rows } = await query(
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
      id:                 r.role_id,          // role DB id  (integer)
      memberRoleId:       r.id,               // join-table row id
      roleId:             r.role_id,
      name:               r.role_name,
      roleName:           r.role_name,
      slug:               r.role_slug,
      roleSlug:           r.role_slug,
      role_type:          r.role_type,
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

// ─── getMemberWithRoles ───────────────────────────────────────────────────────

async function getMemberWithRoles(memberId) {
  try {
    const { rows: memberRows } = await query(
      'SELECT * FROM members WHERE id = $1',
      [memberId]
    );
    if (!memberRows[0]) return null;
    const member = memberRows[0];

    const { rows: roleRows } = await query(
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
      id:                    r.id,
      name:                  r.name,
      slug:                  r.slug,
      role_type:             r.role_type,
      colour:                r.colour,
      receives_task_dms:     r.receives_task_dms,
      can_be_assigned_tasks: r.can_be_assigned_tasks,
      skill_keywords:        r.skill_keywords || [],
      assignedAt:            r.assigned_at,
    }));

    const hasTechnicalRole     = roles.some((r) => r.role_type === 'technical');
    const hasManagerialRole    = roles.some((r) => r.role_type === 'managerial');
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
      jiraAccountId:       member.jira_account_id,
      jiraAccountIdSource: member.jira_account_id_source,
      isActive:            member.is_active,
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

// ─── getAllMembersWithRoles ───────────────────────────────────────────────────

async function getAllMembersWithRoles(organisationId) {
  try {
    const { rows: members } = await query(
      'SELECT * FROM members WHERE organisation_id = $1 AND is_active = true ORDER BY name',
      [organisationId]
    );

    const { rows: allRoleRows } = await query(
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
      const hasTechnicalRole     = roles.some((r) => r.role_type === 'technical');
      const hasManagerialRole    = roles.some((r) => r.role_type === 'managerial');
      const shouldReceiveTaskDms = roles.length === 0
        ? true
        : roles.some((r) => r.role_type === 'technical' && r.receives_task_dms);
      const allSkillKeywords = [...new Set(
        roles.filter((r) => r.role_type === 'technical').flatMap((r) => r.skill_keywords || [])
      )];
      return {
        memberId:            member.id,
        id:                  member.id,
        name:                member.name,
        slackUserId:         member.slack_user_id,
        email:               member.email,
        jiraAccountId:       member.jira_account_id,
        jiraAccountIdSource: member.jira_account_id_source,
        isActive:            member.is_active,
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

// ─── setMemberRoles — atomic transaction ─────────────────────────────────────

async function setMemberRoles(memberId, newRoleIds, updatedBy) {
  // Ensure IDs are integers
  const parsedNewIds = (newRoleIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const parsedUpdatedBy = updatedBy ? parseInt(updatedBy, 10) : null;

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Step 1: Get currently active role IDs
    const currentResult = await client.query(
      `SELECT role_id FROM member_roles WHERE member_id = $1 AND is_active = true`,
      [memberId]
    );
    const currentRoleIds = currentResult.rows.map((r) => r.role_id);

    // Step 2: Calculate diff
    const toAdd    = parsedNewIds.filter((id) => !currentRoleIds.includes(id));
    const toRemove = currentRoleIds.filter((id) => !parsedNewIds.includes(id));
    const unchanged = currentRoleIds.filter((id) => parsedNewIds.includes(id));

    console.log(`[setMemberRoles] Member ${memberId}: adding [${toAdd}], removing [${toRemove}], unchanged [${unchanged}]`);

    // Step 3: Soft-delete removed roles
    for (const roleId of toRemove) {
      const r = await client.query(
        `UPDATE member_roles
         SET is_active = false, removed_at = NOW(), removed_by = $1
         WHERE member_id = $2 AND role_id = $3 AND is_active = true`,
        [parsedUpdatedBy, memberId, roleId]
      );
      console.log(`[setMemberRoles] Removed role ${roleId} from member ${memberId}: ${r.rowCount} row(s) updated`);
    }

    // Step 4: Insert or reactivate new roles
    // The UNIQUE(member_id, role_id) constraint (from migration 011) allows
    // ON CONFLICT to target exactly one row and flip it back to active.
    for (const roleId of toAdd) {
      const r = await client.query(
        `INSERT INTO member_roles
           (member_id, role_id, organisation_id, is_active, assigned_at, assigned_by)
         VALUES (
           $1, $2,
           (SELECT organisation_id FROM members WHERE id = $1),
           true, NOW(), $3
         )
         ON CONFLICT (member_id, role_id)
         DO UPDATE SET
           is_active   = true,
           assigned_at = NOW(),
           assigned_by = $3,
           removed_at  = NULL,
           removed_by  = NULL`,
        [memberId, roleId, parsedUpdatedBy]
      );
      console.log(`[setMemberRoles] Added role ${roleId} to member ${memberId}: ${r.rowCount} row(s) affected`);
    }

    await client.query('COMMIT');

    // Return updated role list
    const updated = await getMemberRoles(memberId);
    return { added: toAdd, removed: toRemove, unchanged, roles: updated };

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[setMemberRoles] ROLLBACK for member ${memberId}:`, err.message);
    throw new Error(`setMemberRoles failed: ${err.message}`);
  } finally {
    client.release();
  }
}

// ─── assignRole ──────────────────────────────────────────────────────────────

async function assignRole(memberId, roleId, assignedBy) {
  try {
    const { rows: memberRows } = await query('SELECT organisation_id FROM members WHERE id = $1', [memberId]);
    const orgId = memberRows[0]?.organisation_id;

    const { rows } = await query(
      `INSERT INTO member_roles
         (member_id, role_id, organisation_id, is_active, assigned_at, assigned_by)
       VALUES ($1, $2, $3, true, NOW(), $4)
       ON CONFLICT (member_id, role_id)
       DO UPDATE SET
         is_active   = true,
         assigned_at = NOW(),
         assigned_by = $4,
         removed_at  = NULL,
         removed_by  = NULL
       RETURNING *`,
      [memberId, roleId, orgId, assignedBy || null]
    );
    return rows[0];
  } catch (err) {
    console.error('[memberRoleRepository.assignRole]', err.message);
    throw err;
  }
}

// ─── removeRole ──────────────────────────────────────────────────────────────

async function removeRole(memberId, roleId, removedBy) {
  try {
    const { rows } = await query(
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

// ─── getMembersWithRole ───────────────────────────────────────────────────────

async function getMembersWithRole(organisationId, roleSlug) {
  try {
    const { rows } = await query(
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

// ─── getMembersWhoReceiveDMs ──────────────────────────────────────────────────

async function getMembersWhoReceiveDMs(organisationId) {
  try {
    const { rows } = await query(
      `SELECT DISTINCT m.id, m.name, m.slack_user_id, m.email
       FROM members m
       WHERE m.organisation_id = $1 AND m.is_active = true
         AND (
           EXISTS (
             SELECT 1 FROM member_roles mr
             JOIN roles r ON r.id = mr.role_id
             WHERE mr.member_id = m.id AND mr.is_active = true
               AND r.is_active = true AND r.role_type = 'technical'
               AND r.receives_task_dms = true
           )
           OR NOT EXISTS (
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

// ─── getRoleHistory ───────────────────────────────────────────────────────────

async function getRoleHistory(memberId) {
  try {
    const { rows } = await query(
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
