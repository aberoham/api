import assert from 'node:assert/strict'
import { describe, it, after, before } from 'node:test'

import Group from '../../group/index.js'
import User from '../../user/index.js'
import Permission from '../index.js'

import groupTestCase from '../../group/test/group.json' with { type: 'json' }
import userTestCase from '../../user/test/user.json' with { type: 'json' }
import permTestCase from './permission.json' with { type: 'json' }

before(async () => {
  await Group.create({ id: 1, parent_gid: 0, name: 'root' }, { ifExists: 'return' })
  await Permission.create({ gid: 1, name: 'Root group permissions' }, { ifExists: 'return' })
  await Group.create(groupTestCase, { ifExists: 'return' })
  await User.create(userTestCase, { ifExists: 'return' })
})

after(async () => {
  await Permission.disconnect()
})

describe('permission', function () {
  it('reads the seeded v2-style group permission row', async () => {
    const p = await Permission.get({ gid: 1 })
    assert.ok(p)
    assert.equal(p.group.id, 1)
    assert.equal(p.user.id, null)
  })

  it('creates a permission', async () => {
    assert.ok(await Permission.create(permTestCase, { ifExists: 'return' }))
  })

  it('get: by id', async () => {
    assert.deepEqual(await Permission.get({ id: permTestCase.id }), permTestCase)
  })

  it('get: by user id', async () => {
    assert.deepEqual(await Permission.get({ uid: permTestCase.user.id }), permTestCase)
  })

  it('get: by group id', async () => {
    // Permission.get({ gid }) returns the GROUP-level permission (uid IS NULL),
    // not a user's permission — even when the user perm also stores a gid.
    const p = await Permission.get({ gid: groupTestCase.id })
    assert.ok(p, 'group permission exists')
    assert.equal(p.group.id, groupTestCase.id)
    assert.equal(p.name, `Group ${groupTestCase.name} perms`)
  })

  it('getGroup: gets group permissions', async () => {
    // getGroup returns the group-level permission for the user's group
    const p = await Permission.getGroup({ uid: userTestCase.id })
    assert.ok(p, 'group permission exists for user')
    assert.equal(p.group.id, groupTestCase.id)
  })

  it('changes a permission', async () => {
    assert.ok(
      await Permission.put({
        id: permTestCase.id,
        name: 'Changed',
        group_write: 1,
      }),
    )
    const perm = await Permission.get({ id: permTestCase.id })
    assert.deepEqual(perm.name, 'Changed')
    assert.equal(perm.group.write, true)
    assert.equal(perm.group_write, undefined)
    assert.ok(
      await Permission.put({
        id: permTestCase.id,
        name: 'Test Permission',
        group_write: 0,
      }),
    )
  })

  it('finds a group permission by its id', async () => {
    const gid = 4300
    await Group.destroy({ id: gid })
    await Group.create({ id: gid, parent_gid: groupTestCase.id, name: 'perm-by-id' })
    const gp = await Permission.get({ gid })
    assert.equal((await Permission.get({ id: gp.id }))?.group.id, gid)
    await Group.destroy({ id: gid })
  })

  it('stops applying a deleted explicit permission', async () => {
    await Permission.delete({ id: permTestCase.id })
    assert.equal(await Permission.get({ uid: userTestCase.id }), undefined)
    const effective = await Permission.getEffective(userTestCase.id)
    assert.equal(effective.group.id, groupTestCase.id)
    assert.equal(effective.name, `Group ${groupTestCase.name} perms`)
    await Permission.delete({ id: permTestCase.id, deleted: 0 })
  })

  it('reactivates a soft-deleted permission instead of duplicating it', async () => {
    await Permission.delete({ id: permTestCase.id })
    assert.equal(await Permission.create(permTestCase), permTestCase.id)
    assert.ok(await Permission.get({ id: permTestCase.id }))
  })

  it('changes nested permission fields alone', async () => {
    assert.ok(await Permission.put({ id: permTestCase.id, self_write: true, zone: { write: false } }))
    const perm = await Permission.get({ id: permTestCase.id })
    assert.equal(perm.self_write, true)
    assert.deepEqual(perm.zone, { ...permTestCase.zone, write: false })
    assert.ok(await Permission.put({ id: permTestCase.id, self_write: false, zone: { write: true } }))
  })

  it('deletes a permission', async () => {
    assert.ok(await Permission.delete({ id: permTestCase.id }))
    let p = await Permission.get({ id: permTestCase.id, deleted: 1 })
    assert.equal(p?.deleted, true)
    await Permission.delete({ id: permTestCase.id, deleted: 0 }) // restore
    p = await Permission.get({ id: permTestCase.id })
    assert.equal(p.deleted, undefined)
  })

  it('destroys a permission', async () => {
    assert.ok(await Permission.destroy({ id: permTestCase.id }))
    const p = await Permission.get({ uid: userTestCase.id })
    assert.equal(p, undefined)
  })
})

describe('permission ids', () => {
  // a user and a group may share an id, but never a permission
  const gid = 47301
  const uids = [47301, 47302, 47303]
  const gids = [gid, 47302]
  let groupPerm
  let userPerm

  const userCase = (id, inherit) => ({
    id,
    gid,
    username: `permids${id}`,
    email: `permids${id}@example.com`,
    password: 'Wh@tA-Decent#P6ssw0rd',
    first_name: 'Perm',
    last_name: 'Ids',
    inherit_group_permissions: inherit,
  })

  async function cleanup() {
    for (const uid of uids) {
      for (const deleted of [false, true]) {
        const p = await Permission.get({ uid, deleted })
        if (p) await Permission.destroy({ id: p.id })
      }
      await User.destroy({ id: uid })
    }
    for (const g of gids) {
      for (const deleted of [false, true]) {
        const p = await Permission.get({ gid: g, deleted })
        if (p) await Permission.destroy({ id: p.id })
      }
      await Group.destroy({ id: g })
    }
  }

  before(async () => {
    await cleanup()
    await Group.create({ id: gid, parent_gid: 0, name: 'permids.test' })
    await Group.create({ id: gids[1], parent_gid: 0, name: 'permids2.test' })
    await User.create(userCase(uids[0], false))
    await User.create(userCase(uids[2], true))
    groupPerm = await Permission.get({ gid })
    userPerm = await Permission.get({ uid: uids[0] })
  })

  after(cleanup)

  it('gives a user and a group with the same id different permission ids', () => {
    assert.ok(groupPerm, 'the group has no permission')
    assert.ok(userPerm, 'the user has no permission')
    assert.notEqual(groupPerm.id, userPerm.id)
  })

  it('names no user on a group permission', () => {
    assert.equal(groupPerm.user.id ?? null, null)
  })

  it('get: by a group permission id', async () => {
    assert.deepEqual(await Permission.get({ id: groupPerm.id }), groupPerm)
  })

  it('delete: revokes the group permission and leaves the user one', async () => {
    assert.ok(await Permission.delete({ id: groupPerm.id }))
    try {
      assert.equal(
        await Permission.getGroup({ uid: uids[0] }),
        undefined,
        'getGroup read a deleted permission',
      )
      assert.equal(await Permission.get({ gid }), undefined)
      assert.equal(await Permission.get({ gid, deleted: 0 }), undefined)
      assert.equal((await Permission.get({ gid, deleted: 1 }))?.id, groupPerm.id)

      const [group] = await Group.get({ id: gid })
      assert.equal(group.permissions, undefined, 'Group.get read a deleted permission')
      const [inheriting] = await User.get({ id: uids[2] })
      assert.equal(inheriting.permissions, undefined, 'User.get read a deleted group permission')

      assert.ok(await Group.put({ id: gid, usable_ns: ['3'] }))
      assert.equal(
        (await Permission.get({ uid: uids[0] }))?.id,
        userPerm.id,
        'the user permission was revoked',
      )
    } finally {
      await Permission.delete({ id: groupPerm.id, deleted: 0 })
    }
    assert.deepEqual((await Permission.get({ gid })).nameserver.usable, groupPerm.nameserver.usable)
  })

  it('delete: hides a user permission from uid reads', async () => {
    assert.ok(await Permission.delete({ id: userPerm.id }))
    try {
      assert.equal(await Permission.get({ uid: uids[0] }), undefined)
      assert.equal(await Permission.get({ uid: uids[0], deleted: 0 }), undefined)
      assert.equal((await Permission.get({ uid: uids[0], deleted: 1 }))?.id, userPerm.id)
      const [user] = await User.get({ id: uids[0] })
      assert.equal(user.permissions.id, groupPerm.id, 'User.get read a deleted user permission')
    } finally {
      await Permission.delete({ id: userPerm.id, deleted: 0 })
    }
    assert.equal(await Permission.get({ uid: uids[0], deleted: 1 }), undefined)
  })

  it('a user going explicit gets an unused permission id', async () => {
    await User.create(userCase(uids[1], true))
    assert.ok(await User.put({ id: uids[1], inherit_group_permissions: false }))

    const perm = await Permission.get({ uid: uids[1] })
    const taken = [groupPerm.id, userPerm.id, (await Permission.get({ gid: gids[1] })).id]
    assert.ok(perm, 'the user has no permission')
    assert.ok(!taken.includes(perm.id), `permission id ${perm.id} is taken`)
    assert.equal((await Permission.get({ id: perm.id }))?.user?.id, uids[1])
  })
})
