const { expect } = require('chai')
const sinon = require('sinon')
const Path = require('path')
const os = require('os')
const fs = require('../../../server/libs/fsExtra')

const PlaybackSessionManager = require('../../../server/managers/PlaybackSessionManager')
const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')

describe('PlaybackSessionManager.removeOrphanStreams (iOS HLS persistent TTL)', () => {
  const uuids = {
    orphan: '11111111-aaaa-4111-8111-111111111111',
    persistentFresh: '22222222-bbbb-4222-8222-222222222222',
    persistentStale: '33333333-cccc-4333-8333-333333333333',
    active: '44444444-dddd-4444-8444-444444444444',
    notUuid: 'not-a-uuid-dir-should-be-ignored'
  }

  let tmpMetadata
  let psm
  let originalServerSettings
  let originalMetadataPath

  beforeEach(async () => {
    tmpMetadata = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-psm-test-'))
    originalMetadataPath = global.MetadataPath
    global.MetadataPath = tmpMetadata

    psm = new PlaybackSessionManager()

    // Fixture: plain orphan, no marker
    await fs.ensureDir(Path.join(psm.StreamsPath, uuids.orphan))
    await fs.writeFile(Path.join(psm.StreamsPath, uuids.orphan, 'output-0.ts'), 'x')

    // Fixture: persistent, fresh marker (created now)
    await fs.ensureDir(Path.join(psm.StreamsPath, uuids.persistentFresh))
    const freshMarker = Path.join(psm.StreamsPath, uuids.persistentFresh, '.persistent')
    await fs.writeFile(freshMarker, JSON.stringify({ userId: 'u', createdAt: Date.now() }))

    // Fixture: persistent, stale marker (backdated 100 days)
    await fs.ensureDir(Path.join(psm.StreamsPath, uuids.persistentStale))
    const staleMarker = Path.join(psm.StreamsPath, uuids.persistentStale, '.persistent')
    await fs.writeFile(staleMarker, JSON.stringify({ userId: 'u', createdAt: Date.now() }))
    const hundredDaysAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    await fs.utimes(staleMarker, hundredDaysAgo, hundredDaysAgo)

    // Fixture: active session (still in memory), should be left alone
    await fs.ensureDir(Path.join(psm.StreamsPath, uuids.active))
    psm.sessions = [{ id: uuids.active }]

    // Fixture: non-uuid dir that the sweeper should ignore entirely
    await fs.ensureDir(Path.join(psm.StreamsPath, uuids.notUuid))

    originalServerSettings = Database.serverSettings
    Database.serverSettings = { iosHlsPersistTtlDays: 30 }

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')
  })

  afterEach(async () => {
    sinon.restore()
    Database.serverSettings = originalServerSettings
    global.MetadataPath = originalMetadataPath
    try {
      await fs.remove(tmpMetadata)
    } catch (_) {
      // best-effort
    }
  })

  it('removes orphan dirs that lack a .persistent marker', async () => {
    await psm.removeOrphanStreams()
    expect(await fs.pathExists(Path.join(psm.StreamsPath, uuids.orphan))).to.equal(false)
  })

  it('keeps persistent dirs whose marker mtime is younger than TTL', async () => {
    await psm.removeOrphanStreams()
    expect(await fs.pathExists(Path.join(psm.StreamsPath, uuids.persistentFresh))).to.equal(true)
  })

  it('evicts persistent dirs whose marker mtime is older than TTL', async () => {
    await psm.removeOrphanStreams()
    expect(await fs.pathExists(Path.join(psm.StreamsPath, uuids.persistentStale))).to.equal(false)
  })

  it('keeps dirs whose session id is still in psm.sessions', async () => {
    await psm.removeOrphanStreams()
    expect(await fs.pathExists(Path.join(psm.StreamsPath, uuids.active))).to.equal(true)
  })

  it('ignores directories whose name is not a UUID', async () => {
    await psm.removeOrphanStreams()
    expect(await fs.pathExists(Path.join(psm.StreamsPath, uuids.notUuid))).to.equal(true)
  })

  it('honours Database.serverSettings.iosHlsPersistTtlDays (short TTL evicts fresh dirs too)', async () => {
    Database.serverSettings = { iosHlsPersistTtlDays: 0 }
    // Keep fresh marker mtime a couple of seconds in the past so it counts as past-TTL.
    const freshMarker = Path.join(psm.StreamsPath, uuids.persistentFresh, '.persistent')
    const twoSecAgo = new Date(Date.now() - 2000)
    await fs.utimes(freshMarker, twoSecAgo, twoSecAgo)

    await psm.removeOrphanStreams()

    expect(await fs.pathExists(Path.join(psm.StreamsPath, uuids.persistentFresh))).to.equal(false)
  })
})
