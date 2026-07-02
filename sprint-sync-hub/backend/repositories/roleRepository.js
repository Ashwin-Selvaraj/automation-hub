'use strict';

const db = require('../db');

const SYSTEM_ROLES = [
  {
    name: 'Backend Developer',
    slug: 'backend_developer',
    role_type: 'technical',
    receives_task_dms: true,
    can_be_assigned_tasks: true,
    skill_keywords: ['Node.js','Python','Java','API','REST','GraphQL','database','SQL','PostgreSQL','MongoDB','Redis','backend','server','microservice','Express','Django','Spring'],
    colour: '#6366F1',
    display_order: 1,
    is_system: true,
  },
  {
    name: 'Frontend Developer',
    slug: 'frontend_developer',
    role_type: 'technical',
    receives_task_dms: true,
    can_be_assigned_tasks: true,
    skill_keywords: ['React','Vue','Angular','CSS','HTML','TypeScript','JavaScript','UI','frontend','component','Tailwind','Next.js','Redux','webpack','browser'],
    colour: '#0EA5E9',
    display_order: 2,
    is_system: true,
  },
  {
    name: 'Full Stack Developer',
    slug: 'full_stack_developer',
    role_type: 'technical',
    receives_task_dms: true,
    can_be_assigned_tasks: true,
    skill_keywords: ['React','Node.js','API','fullstack','full-stack','frontend','backend','database','REST','TypeScript'],
    colour: '#8B5CF6',
    display_order: 3,
    is_system: true,
  },
  {
    name: 'UI/UX Designer',
    slug: 'ui_ux_designer',
    role_type: 'technical',
    receives_task_dms: true,
    can_be_assigned_tasks: true,
    skill_keywords: ['UI','UX','design','Figma','wireframe','prototype','user research','typography','layout','accessibility','mockup','design system'],
    colour: '#EC4899',
    display_order: 4,
    is_system: true,
  },
  {
    name: 'AI Engineer',
    slug: 'ai_engineer',
    role_type: 'technical',
    receives_task_dms: true,
    can_be_assigned_tasks: true,
    skill_keywords: ['machine learning','AI','ML','model','training','LLM','Python','TensorFlow','PyTorch','NLP','neural network','deep learning','Claude','OpenAI','RAG','embedding','fine-tuning'],
    colour: '#F59E0B',
    display_order: 5,
    is_system: true,
  },
  {
    name: 'Blockchain Developer',
    slug: 'blockchain_developer',
    role_type: 'technical',
    receives_task_dms: true,
    can_be_assigned_tasks: true,
    skill_keywords: ['blockchain','smart contract','Web3','Solidity','Ethereum','crypto','NFT','DeFi','Hardhat','Truffle','wallet','token','ERC20','decentralised'],
    colour: '#10B981',
    display_order: 6,
    is_system: true,
  },
  {
    name: 'App Developer',
    slug: 'app_developer',
    role_type: 'technical',
    receives_task_dms: true,
    can_be_assigned_tasks: true,
    skill_keywords: ['Flutter','React Native','iOS','Android','Dart','Swift','Kotlin','mobile','app','cross-platform','Expo','Firebase','push notification','App Store','Play Store','UI components','state management','BLoC','Redux','navigation','native module'],
    colour: '#84CC16',
    display_order: 7,
    is_system: true,
  },
  {
    name: 'QA Tester',
    slug: 'qa_tester',
    role_type: 'technical',
    receives_task_dms: true,
    can_be_assigned_tasks: true,
    skill_keywords: ['QA','testing','test','automation','Selenium','Cypress','Jest','Playwright','unit test','integration test','regression','bug','defect','test case','test plan','JIRA','Postman','API testing','manual testing','performance testing','load testing','UAT','quality assurance'],
    colour: '#06B6D4',
    display_order: 8,
    is_system: true,
  },
  {
    name: 'Team Lead',
    slug: 'team_lead',
    role_type: 'managerial',
    receives_task_dms: false,
    can_be_assigned_tasks: false,
    skill_keywords: [],
    colour: '#EF4444',
    display_order: 9,
    is_system: true,
  },
  {
    name: 'Process Manager',
    slug: 'process_manager',
    role_type: 'managerial',
    receives_task_dms: false,
    can_be_assigned_tasks: false,
    skill_keywords: [],
    colour: '#6B7280',
    display_order: 10,
    is_system: true,
  },
];

async function findAll(organisationId, includeInactive = false) {
  try {
    const sql = includeInactive
      ? `SELECT r.*,
           (SELECT COUNT(*) FROM member_roles mr WHERE mr.role_id = r.id AND mr.is_active = true) AS member_count
         FROM roles r
         WHERE r.organisation_id = $1
         ORDER BY r.display_order, r.name`
      : `SELECT r.*,
           (SELECT COUNT(*) FROM member_roles mr WHERE mr.role_id = r.id AND mr.is_active = true) AS member_count
         FROM roles r
         WHERE r.organisation_id = $1 AND r.is_active = true
         ORDER BY r.display_order, r.name`;
    const { rows } = await db.query(sql, [organisationId]);
    return rows;
  } catch (err) {
    console.error('[roleRepository.findAll]', err.message);
    throw err;
  }
}

async function findById(roleId) {
  try {
    const { rows } = await db.query('SELECT * FROM roles WHERE id = $1', [roleId]);
    return rows[0] || null;
  } catch (err) {
    console.error('[roleRepository.findById]', err.message);
    throw err;
  }
}

async function create(organisationId, roleData) {
  try {
    const slug = roleData.slug || roleData.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const { rows } = await db.query(
      `INSERT INTO roles
         (organisation_id, name, slug, role_type, receives_task_dms,
          can_be_assigned_tasks, skill_keywords, colour, display_order, is_system)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)
       RETURNING *`,
      [
        organisationId,
        roleData.name,
        slug,
        roleData.role_type || 'technical',
        roleData.receives_task_dms !== false,
        roleData.can_be_assigned_tasks !== false,
        roleData.skill_keywords || [],
        roleData.colour || '#6366F1',
        roleData.display_order || 99,
      ]
    );
    return rows[0];
  } catch (err) {
    console.error('[roleRepository.create]', err.message);
    throw err;
  }
}

async function update(roleId, updateData) {
  try {
    const role = await findById(roleId);
    if (!role) throw new Error('Role not found');

    if (role.is_system) {
      const protectedFields = ['role_type', 'receives_task_dms', 'can_be_assigned_tasks', 'slug'];
      for (const field of protectedFields) {
        if (updateData[field] !== undefined && updateData[field] !== role[field]) {
          throw new Error(`Cannot change "${field}" on a system role`);
        }
      }
    }

    const allowed = role.is_system
      ? ['name', 'colour', 'skill_keywords']
      : ['name', 'colour', 'skill_keywords', 'role_type', 'receives_task_dms', 'can_be_assigned_tasks', 'display_order'];

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const field of allowed) {
      if (updateData[field] !== undefined) {
        setClauses.push(`${field} = $${idx++}`);
        values.push(updateData[field]);
      }
    }

    if (setClauses.length === 0) return role;

    values.push(roleId);
    const { rows } = await db.query(
      `UPDATE roles SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return rows[0];
  } catch (err) {
    console.error('[roleRepository.update]', err.message);
    throw err;
  }
}

async function deactivate(roleId) {
  try {
    const role = await findById(roleId);
    if (!role) throw new Error('Role not found');
    if (role.is_system) throw new Error('Cannot deactivate a system role');

    const { rows: activeMembers } = await db.query(
      'SELECT COUNT(*) AS cnt FROM member_roles WHERE role_id = $1 AND is_active = true',
      [roleId]
    );
    const count = parseInt(activeMembers[0].cnt, 10);
    if (count > 0) {
      throw new Error(`Cannot deactivate — ${count} member${count !== 1 ? 's' : ''} currently have this role. Remove the role from those members first.`);
    }

    const { rows } = await db.query(
      'UPDATE roles SET is_active = false WHERE id = $1 RETURNING *',
      [roleId]
    );
    return rows[0];
  } catch (err) {
    console.error('[roleRepository.deactivate]', err.message);
    throw err;
  }
}

async function seedDefaults(organisationId) {
  try {
    for (const role of SYSTEM_ROLES) {
      await db.query(
        `INSERT INTO roles
           (organisation_id, name, slug, role_type, receives_task_dms,
            can_be_assigned_tasks, skill_keywords, colour, display_order, is_system)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
         ON CONFLICT (organisation_id, slug) DO NOTHING`,
        [
          organisationId,
          role.name,
          role.slug,
          role.role_type,
          role.receives_task_dms,
          role.can_be_assigned_tasks,
          role.skill_keywords,
          role.colour,
          role.display_order,
        ]
      );
    }
    console.log(`[roleRepository] Seeded ${SYSTEM_ROLES.length} system roles for org ${organisationId}`);
  } catch (err) {
    console.error('[roleRepository.seedDefaults]', err.message);
    throw err;
  }
}

module.exports = { findAll, findById, create, update, deactivate, seedDefaults, SYSTEM_ROLES };
