import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

import { init } from './index.js'
import Group from '../lib/group/index.js'
import User from '../lib/user/index.js'
import Zone from '../lib/zone/index.js'
import Nameserver from '../lib/nameserver/index.js'

import groupCase from './test/group.json' with { type: 'json' }
import { grantGroupPermissions } from './test/permissions.js'
import userCase from './test/user.json' with { type: 'json' }
import nsCase from './test/zone.json' with { type: 'json' }
import nameserverCase from './test/nameserver.json' with { type: 'json' }

let server
let case2Id
let nsZoneId
const moveGroup = { id: 4094, parent_gid: groupCase.id, name: 'zone-move.route.example.com' }
const recoveryDuplicateId = 4086

const subGroup = { id: 4090, parent_gid: groupCase.id, name: 'sub.route.example.com' }
const subZone = { ...nsCase, id: 4091, gid: subGroup.id, zone: 'sub.route.example.com.' }
// one nameserver in the caller's group, one it cannot use
const ownNs = { ...nameserverCase, id: 4093, gid: groupCase.id, name: 'own.ns.example.com.' }
const otherNs = { ...nameserverCase, id: 4092, gid: 1, name: 'other.ns.example.com.' }

before(async () => {
  await Zone.destroy({ id: nsCase.id })
  await Zone.destroy({ id: recoveryDuplicateId })
  for (const name of ['route2.example.com.', 'ns.route.example.com.', 'concurrent.example.com.']) {
    for (const deleted of [false, true]) {
      for (const zone of await Zone.get({ zone: name, deleted })) await Zone.destroy({ id: zone.id })
    }
  }
  await Zone.destroy({ id: subZone.id })
  // Destroy the subgroup before recreating it: a lingering row would make
  // Group.create early-return and skip addToSubgroups, leaving the
  // nt_group_subgroups closure row (and thus the include_subgroups query) empty.
  await Group.destroy({ id: subGroup.id })
  await Group.destroy({ id: moveGroup.id })
  await Group.create(groupCase, { ifExists: 'return' })
  await Group.create(moveGroup)
  await User.create(userCase, { ifExists: 'return' })
  await grantGroupPermissions(groupCase.id)
  await Zone.create(nsCase, { ifExists: 'return' })
  await Group.create(subGroup)
  await Zone.create(subZone)
  await Nameserver.destroy({ id: ownNs.id })
  await Nameserver.destroy({ id: otherNs.id })
  await Nameserver.create(ownNs)
  await Nameserver.create(otherNs)
  server = await init()
})

after(async () => {
  if (case2Id) await Zone.destroy({ id: case2Id })
  if (nsZoneId) await Zone.destroy({ id: nsZoneId })
  await Nameserver.destroy({ id: ownNs.id })
  await Nameserver.destroy({ id: otherNs.id })
  await Zone.destroy({ id: recoveryDuplicateId })
  await Zone.destroy({ id: subZone.id })
  await Group.destroy({ id: subGroup.id })
  await Group.destroy({ id: moveGroup.id })
  await server.stop()
})

describe('zone routes', () => {
  let auth = { headers: {} }

  it('POST /session establishes a session', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/session',
      payload: {
        username: `${userCase.username}@${groupCase.name}`,
        password: userCase.password,
      },
    })
    assert.ok(res.result.user.id)
    auth.headers = { Authorization: `Bearer ${res.result.session.token}` }
  })

  it(`GET /zone/${nsCase.id}`, async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/zone/${nsCase.id}`,
      headers: auth.headers,
    })
    // console.log(res.result)
    assert.equal(res.statusCode, 200)
    assert.equal(res.result.zone[0].zone, nsCase.zone)
  })

  it('GET /zone?search=... returns DB matches', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/zone?search=route.example',
      headers: auth.headers,
    })
    assert.equal(res.statusCode, 200)
    assert.ok(res.result.zone.some((z) => z.zone === nsCase.zone))
  })

  it('POST /zone rejects an active duplicate name', async () => {
    const duplicate = { ...nsCase, zone: `${nsCase.zone}.` }
    delete duplicate.id
    const res = await server.inject({
      method: 'POST',
      url: '/zone',
      headers: auth.headers,
      payload: duplicate,
    })

    assert.equal(res.statusCode, 409)
    assert.deepEqual(res.result.zone, [])
    assert.match(res.result.meta.msg, /already taken/)
  })

  it('POST /zone rejects a case-only duplicate name', async () => {
    const duplicate = { ...nsCase, zone: `${nsCase.zone.toUpperCase()}.` }
    delete duplicate.id
    const res = await server.inject({
      method: 'POST',
      url: '/zone',
      headers: auth.headers,
      payload: duplicate,
    })

    assert.equal(res.statusCode, 409)
    assert.deepEqual(res.result.zone, [])
  })

  it('POST /zone admits only one concurrent canonical name', async () => {
    const responses = await Promise.all(
      ['concurrent.example.com', 'CONCURRENT.EXAMPLE.COM.'].map((zone) => {
        const payload = { ...nsCase, zone }
        delete payload.id
        return server.inject({
          method: 'POST',
          url: '/zone',
          headers: auth.headers,
          payload,
        })
      }),
    )
    const created = responses.find((res) => res.statusCode === 201)
    if (created) await Zone.destroy({ id: created.result.zone[0].id })

    assert.deepEqual(responses.map((res) => res.statusCode).sort(), [201, 409])
  })

  it('PUT /zone refuses recovery beside an active canonical name', async () => {
    await Zone.create({
      ...nsCase,
      id: recoveryDuplicateId,
      zone: `${nsCase.zone.toUpperCase()}.`,
      deleted: true,
    })

    const res = await server.inject({
      method: 'PUT',
      url: `/zone/${recoveryDuplicateId}`,
      headers: auth.headers,
      payload: { deleted: false },
    })

    assert.equal(res.statusCode, 409)
    assert.equal((await Zone.get({ id: recoveryDuplicateId, deleted: true }))[0].deleted, true)
  })

  it(`PUT /zone/${nsCase.id} moves it to another group`, async () => {
    const moved = await server.inject({
      method: 'PUT',
      url: `/zone/${nsCase.id}`,
      headers: auth.headers,
      payload: { gid: moveGroup.id },
    })
    assert.equal(moved.statusCode, 200)
    assert.equal(moved.result.zone[0].gid, moveGroup.id)

    const restored = await server.inject({
      method: 'PUT',
      url: `/zone/${nsCase.id}`,
      headers: auth.headers,
      payload: { gid: groupCase.id },
    })
    assert.equal(restored.statusCode, 200)
    assert.equal(restored.result.zone[0].gid, groupCase.id)
  })

  it(`PUT /zone/${nsCase.id} validates serial and unknown fields`, async () => {
    const updated = await server.inject({
      method: 'PUT',
      url: `/zone/${nsCase.id}`,
      headers: auth.headers,
      payload: { serial: 2026082601 },
    })
    assert.equal(updated.statusCode, 200)
    assert.equal(updated.result.zone[0].serial, 2026082601)

    const unknown = await server.inject({
      method: 'PUT',
      url: `/zone/${nsCase.id}`,
      headers: auth.headers,
      payload: { definitely_not_a_zone_field: true },
    })
    assert.equal(unknown.statusCode, 400)
  })

  it(`PUT /zone/${nsCase.id} assigns a usable nameserver`, async () => {
    const res = await server.inject({
      method: 'PUT',
      url: `/zone/${nsCase.id}`,
      headers: auth.headers,
      payload: { nameservers: [ownNs.id, ownNs.id] },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.result.zone[0].nameservers, [ownNs.id])

    const get = await server.inject({ method: 'GET', url: `/zone/${nsCase.id}`, headers: auth.headers })
    assert.deepEqual(get.result.zone[0].nameservers, [ownNs.id])
  })

  it(`PUT /zone/${nsCase.id} refuses a nameserver the caller cannot use`, async () => {
    const res = await server.inject({
      method: 'PUT',
      url: `/zone/${nsCase.id}`,
      headers: auth.headers,
      payload: { nameservers: [ownNs.id, otherNs.id] },
    })
    assert.equal(res.statusCode, 403)
    assert.match(res.result.meta.msg, /not usable: 4092/)
    assert.deepEqual(await Zone.nameserverIds(nsCase.id), [ownNs.id])
  })

  it(`PUT /zone/${nsCase.id} clears the assignment`, async () => {
    const res = await server.inject({
      method: 'PUT',
      url: `/zone/${nsCase.id}`,
      headers: auth.headers,
      payload: { nameservers: [] },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.result.zone[0].nameservers, [])
  })

  it('POST /zone with nameservers', async () => {
    const payload = { ...nsCase, zone: 'ns.route.example.com.', nameservers: [ownNs.id] }
    delete payload.id
    const res = await server.inject({
      method: 'POST',
      url: '/zone',
      headers: auth.headers,
      payload,
    })
    assert.equal(res.statusCode, 201)
    assert.deepEqual(res.result.zone[0].nameservers, [ownNs.id])
    nsZoneId = res.result.zone[0].id
  })

  it('POST /zone rejects a nameserver the caller cannot use', async () => {
    const payload = { ...nsCase, zone: 'ns2.route.example.com.', nameservers: [otherNs.id] }
    delete payload.id
    const res = await server.inject({
      method: 'POST',
      url: '/zone',
      headers: auth.headers,
      payload,
    })
    assert.equal(res.statusCode, 403)
    assert.equal((await Zone.get({ zone: payload.zone })).length, 0)
  })

  it('POST /zone allocates an id', async () => {
    const testCase = JSON.parse(JSON.stringify(nsCase))
    delete testCase.id
    testCase.gid = moveGroup.id
    testCase.zone = 'route2.example.com.'

    const res = await server.inject({
      method: 'POST',
      url: '/zone',
      headers: auth.headers,
      payload: testCase,
    })
    // console.log(res.result)
    assert.equal(res.statusCode, 201)
    assert.equal(res.result.zone.length, 1)
    assert.equal(res.result.zone[0].zone, 'route2.example.com.')
    assert.ok(res.result.zone[0].gid)
    case2Id = res.result.zone[0].id
    assert.ok(Number.isInteger(case2Id))

    const log = await server.inject({
      method: 'GET',
      url: `/log/zone?gid=${moveGroup.id}&search=route2.example.com.`,
      headers: auth.headers,
    })
    assert.equal(log.statusCode, 200)
    assert.equal(log.result.log[0].action, 'added')
  })

  it('PUT /zone/{id} keeps using the route id', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: `/zone/${case2Id}`,
      headers: auth.headers,
      payload: { description: 'updated' },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.result.zone[0].description, 'updated')
  })

  it('GET /zone/{id}', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/zone/${case2Id}`,
      headers: auth.headers,
    })
    // console.log(res.result)
    assert.equal(res.statusCode, 200)
    assert.ok(res.result.zone[0].gid)
  })

  it('DELETE /zone/{id}', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: `/zone/${case2Id}`,
      headers: auth.headers,
    })
    // console.log(res.result)
    assert.equal(res.statusCode, 200)

    const log = await server.inject({
      method: 'GET',
      url: `/log/zone?gid=${moveGroup.id}&search=route2.example.com.`,
      headers: auth.headers,
    })
    assert.equal(log.statusCode, 200)
    assert.equal(log.result.log[0].action, 'deleted')
  })

  it('GET /log/global includes subgroup activity', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/log/global?gid=${groupCase.id}&include_subgroups=true&search=route2.example.com.`,
      headers: auth.headers,
    })
    assert.equal(res.statusCode, 200)
    assert.ok(res.result.log.some((row) => row.title === 'route2.example.com.'))
  })

  it('DELETE /zone/{id} returns 404 when already deleted', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: `/zone/${case2Id}`,
      headers: auth.headers,
    })
    // console.log(res.result)
    assert.equal(res.statusCode, 404)
  })

  it('GET /zone/{id} hides a soft-deleted zone', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/zone/${case2Id}`,
      headers: auth.headers,
    })
    // console.log(res.result)
    // assert.equal(res.statusCode, 200)
    assert.deepEqual(res.result.zone, [])
  })

  it('GET /zone/{id}?deleted=true returns a soft-deleted zone', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/zone/${case2Id}?deleted=true`,
      headers: auth.headers,
    })
    // console.log(res.result)
    assert.equal(res.statusCode, 200)
    assert.ok(res.result.zone)
  })

  it('GET /zone?gid= excludes subgroup zones by default', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/zone?gid=${groupCase.id}`,
      headers: auth.headers,
    })
    assert.equal(res.statusCode, 200)
    const zones = res.result.zone.map((z) => z.zone)
    assert.ok(zones.includes(nsCase.zone))
    assert.ok(!zones.includes(subZone.zone))
  })

  it('GET /zone?gid=&include_subgroups=true spans the branch', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/zone?gid=${groupCase.id}&include_subgroups=true`,
      headers: auth.headers,
    })
    assert.equal(res.statusCode, 200)
    const zones = res.result.zone.map((z) => z.zone)
    assert.ok(zones.includes(nsCase.zone), 'parent zone present')
    assert.ok(zones.includes(subZone.zone), 'subgroup zone present')
  })

  it('DELETE /session', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/session',
      headers: auth.headers,
    })
    assert.equal(res.statusCode, 200)
  })
})
