const { expect } = require('chai')
const sinon = require('sinon')
const Path = require('path')
const os = require('os')
const fs = require('../../../server/libs/fsExtra')

const Stream = require('../../../server/objects/Stream')
const SocketAuthority = require('../../../server/SocketAuthority')
const Logger = require('../../../server/Logger')

describe('Stream (iOS HLS persistOnClose)', () => {
  let tmpDir
  let fakeUser
  let fakeLibraryItem

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-stream-test-'))
    fakeUser = { id: 'user-1', token: 'tok' }
    // Minimal shape Stream needs to construct without exploding.
    fakeLibraryItem = {
      isPodcast: false,
      media: {
        getPlaybackTitle: () => 'Test Book',
        getPlaybackDuration: () => 3600,
        podcastEpisodes: []
      },
      getTrackList: () => []
    }
    sinon.stub(SocketAuthority, 'clientEmitter')
    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')
  })

  afterEach(async () => {
    sinon.restore()
    try {
      await fs.remove(tmpDir)
    } catch (_) {
      // tmpdir cleanup is best-effort
    }
  })

  describe('constructor', () => {
    it('defaults persistOnClose to false when transcodeOptions omits it', () => {
      const stream = new Stream('sess-1', tmpDir, fakeUser, fakeLibraryItem, null, 0)
      expect(stream.persistOnClose).to.equal(false)
      expect(stream.isClosed).to.equal(false)
    })

    it('sets persistOnClose=true when transcodeOptions.persistOnClose is truthy', () => {
      const stream = new Stream('sess-1', tmpDir, fakeUser, fakeLibraryItem, null, 0, { persistOnClose: true })
      expect(stream.persistOnClose).to.equal(true)
    })
  })

  describe('close', () => {
    it('removes streamPath when persistOnClose is false (default behaviour preserved)', async () => {
      const stream = new Stream('sess-default', tmpDir, fakeUser, fakeLibraryItem, null, 0)
      await fs.ensureDir(stream.streamPath)
      await fs.writeFile(Path.join(stream.streamPath, 'dummy.ts'), 'data')
      expect(await fs.pathExists(stream.streamPath)).to.equal(true)

      await stream.close()

      expect(stream.isClosed).to.equal(true)
      expect(await fs.pathExists(stream.streamPath)).to.equal(false)
    })

    it('leaves streamPath and its contents intact when persistOnClose is true', async () => {
      const stream = new Stream('sess-persist', tmpDir, fakeUser, fakeLibraryItem, null, 0, { persistOnClose: true })
      await fs.ensureDir(stream.streamPath)
      await fs.writeFile(Path.join(stream.streamPath, 'dummy.ts'), 'data')

      await stream.close()

      expect(stream.isClosed).to.equal(true)
      expect(await fs.pathExists(stream.streamPath)).to.equal(true)
      expect(await fs.pathExists(Path.join(stream.streamPath, 'dummy.ts'))).to.equal(true)
    })

    it('emits a "closed" event regardless of persistOnClose', async () => {
      const stream = new Stream('sess-evt', tmpDir, fakeUser, fakeLibraryItem, null, 0, { persistOnClose: true })
      const closedSpy = sinon.spy()
      stream.on('closed', closedSpy)

      await stream.close()

      expect(closedSpy.calledOnce).to.equal(true)
    })
  })

  describe('reset', () => {
    it('is a no-op after close (isClosed gate prevents ffmpeg revival)', async () => {
      const stream = new Stream('sess-reset', tmpDir, fakeUser, fakeLibraryItem, null, 0, { persistOnClose: true })
      await stream.close()
      expect(stream.isClosed).to.equal(true)

      const startSpy = sinon.spy(stream, 'start')
      await stream.reset(100)

      expect(startSpy.called).to.equal(false)
    })
  })
})
