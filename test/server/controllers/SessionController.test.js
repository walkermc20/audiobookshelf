const { expect } = require('chai')
const sinon = require('sinon')
const Path = require('path')
const os = require('os')
const fs = require('../../../server/libs/fsExtra')

const SessionController = require('../../../server/controllers/SessionController')
const Logger = require('../../../server/Logger')

describe('SessionController.deleteHlsCache', () => {
  const VALID_UUID = '11111111-2222-4333-8444-555555555555'

  let streamsPath
  let req
  let res
  let playbackSessionManager
  let ctx // the `this` context ApiRouter passes at route registration (`.bind(this)`)

  beforeEach(async () => {
    streamsPath = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-del-test-'))
    req = {
      params: { id: VALID_UUID },
      user: { id: 'user-1', username: 'owner', isAdminOrUp: false }
    }
    res = {
      statusCode: null,
      sendStatus(code) {
        this.statusCode = code
        return this
      }
    }
    playbackSessionManager = {
      StreamsPath: streamsPath,
      sessions: [],
      persistentStreams: new Map(),
      getSession: sinon.stub(),
      removeSession: sinon.stub().resolves()
    }
    ctx = { playbackSessionManager }

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')
  })

  afterEach(async () => {
    sinon.restore()
    try {
      await fs.remove(streamsPath)
    } catch (_) {
      // best-effort cleanup
    }
  })

  it('returns 400 when session id is not a valid UUID', async () => {
    req.params.id = 'not-a-uuid'
    await SessionController.deleteHlsCache.call(ctx, req, res)
    expect(res.statusCode).to.equal(400)
  })

  it('returns 403 when an in-memory session belongs to a different non-admin user', async () => {
    playbackSessionManager.getSession.returns({ userId: 'user-2', id: VALID_UUID })

    await SessionController.deleteHlsCache.call(ctx, req, res)

    expect(res.statusCode).to.equal(403)
    expect(playbackSessionManager.removeSession.called).to.equal(false)
  })

  it('allows an admin to DELETE another users in-memory session', async () => {
    req.user.isAdminOrUp = true
    playbackSessionManager.getSession.returns({ userId: 'user-2', id: VALID_UUID })

    await SessionController.deleteHlsCache.call(ctx, req, res)

    expect(res.statusCode).to.equal(200)
    expect(playbackSessionManager.removeSession.calledOnce).to.equal(true)
  })

  it('returns 200 and wipes the cache dir when the owner DELETEs an in-memory session', async () => {
    const dir = Path.join(streamsPath, VALID_UUID)
    await fs.ensureDir(dir)
    await fs.writeFile(Path.join(dir, 'output-0.ts'), 'ts')
    playbackSessionManager.getSession.returns({ userId: 'user-1', id: VALID_UUID })

    await SessionController.deleteHlsCache.call(ctx, req, res)

    expect(res.statusCode).to.equal(200)
    expect(await fs.pathExists(dir)).to.equal(false)
  })

  it('returns 403 when session is gone but the marker on disk names a different owner (non-admin)', async () => {
    const dir = Path.join(streamsPath, VALID_UUID)
    await fs.ensureDir(dir)
    await fs.writeFile(Path.join(dir, '.persistent'), JSON.stringify({ userId: 'user-2', createdAt: Date.now() }))
    playbackSessionManager.getSession.returns(null)

    await SessionController.deleteHlsCache.call(ctx, req, res)

    expect(res.statusCode).to.equal(403)
    expect(await fs.pathExists(dir)).to.equal(true) // not deleted
  })

  it('returns 200 when session is gone and the marker matches the requesting user', async () => {
    const dir = Path.join(streamsPath, VALID_UUID)
    await fs.ensureDir(dir)
    await fs.writeFile(Path.join(dir, '.persistent'), JSON.stringify({ userId: 'user-1', createdAt: Date.now() }))
    playbackSessionManager.getSession.returns(null)

    await SessionController.deleteHlsCache.call(ctx, req, res)

    expect(res.statusCode).to.equal(200)
    expect(await fs.pathExists(dir)).to.equal(false)
  })

  it('returns 200 (idempotent) when session and cache are both absent', async () => {
    playbackSessionManager.getSession.returns(null)

    await SessionController.deleteHlsCache.call(ctx, req, res)

    expect(res.statusCode).to.equal(200)
  })

  it('falls through to delete when the marker is malformed (best-effort)', async () => {
    const dir = Path.join(streamsPath, VALID_UUID)
    await fs.ensureDir(dir)
    await fs.writeFile(Path.join(dir, '.persistent'), 'not-json')
    playbackSessionManager.getSession.returns(null)

    await SessionController.deleteHlsCache.call(ctx, req, res)

    expect(res.statusCode).to.equal(200)
    expect(await fs.pathExists(dir)).to.equal(false)
  })

  it('SIGKILLs ffmpeg via persistentStreams before fs.remove and deregisters on success', async () => {
    const dir = Path.join(streamsPath, VALID_UUID)
    await fs.ensureDir(dir)

    const killSpy = sinon.spy()
    const fakeStream = {
      ffmpeg: {
        kill(signal) {
          killSpy(signal)
          // Real Stream's SIGKILL handler sets this.ffmpeg = null synchronously.
          fakeStream.ffmpeg = null
        }
      }
    }
    playbackSessionManager.persistentStreams.set(VALID_UUID, fakeStream)
    playbackSessionManager.getSession.returns(null)

    await SessionController.deleteHlsCache.call(ctx, req, res)

    expect(killSpy.calledWith('SIGKILL')).to.equal(true)
    expect(res.statusCode).to.equal(200)
    expect(playbackSessionManager.persistentStreams.has(VALID_UUID)).to.equal(false)
  })
})
