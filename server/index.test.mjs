import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createHlsVideoSource } from './videoSource.mjs'

const serverFile = fileURLToPath(new URL('./index.mjs', import.meta.url))

async function reservePort() {
  const probe = createServer()
  await new Promise((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen))
  const port = probe.address().port
  await new Promise((resolveClose) => probe.close(resolveClose))
  return port
}

function waitForReady(child) {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error('API did not start in time.')), 5000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (!chunk.includes('ResQ API listening')) return
      clearTimeout(timeout)
      resolveReady()
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectReady(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      rejectReady(new Error(`API exited before startup with code ${code}.`))
    })
  })
}

test('SQLite API persists incidents, rule reviews, and reports', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'resq-api-test-'))
  const port = await reservePort()
  const child = spawn(process.execPath, [serverFile], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: {
      ...process.env,
      RESQ_DB_PATH: join(temporaryDirectory, 'test.sqlite'),
      RESQ_API_PORT: String(port),
      RESQ_CAMERA_HLS_URL: 'https://gateway.example.test/front/index.m3u8',
      RESQ_CAMERA_LABEL: 'Front entrance',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    await waitForReady(child)
    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json())
    assert.equal(health.status, 'ok')
    assert.equal(health.database, 'available')
    assert.equal(health.cctvGateway, 'configured-not-tested')
    const cameraFeed = await fetch(`${baseUrl}/api/camera-feed`).then((response) => response.json())
    assert.deepEqual(cameraFeed, {
      configured: true,
      enabled: true,
      sourceName: 'Front entrance',
      sourceType: 'hls',
      gatewayIdentifier: 'configured-gateway',
      streamIdentifier: 'configured-stream',
      protocol: 'hls',
      readOnly: true,
      connectionStatus: 'not-tested',
      lastSuccessfulConnectionAt: null,
      configurationError: false,
    })
    assert.equal(JSON.stringify(cameraFeed).includes('gateway.example.test'), false)

    const catalog = await fetch(`${baseUrl}/api/guidance`).then((response) => response.json())
    assert.equal(catalog.mechanisms.length, 7)
    assert.equal(catalog.signals.length, 7)
    assert.ok(catalog.causes.length > 0)
    assert.ok(catalog.injuryPatterns.length > 0)

    const invalidIncidentResponse = await fetch(`${baseUrl}/api/incidents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Bad mechanism',
        location: 'Test sector',
        mechanismId: 'unlisted-mechanism',
      }),
    })
    assert.equal(invalidIncidentResponse.status, 400)

    const createdResponse = await fetch(`${baseUrl}/api/incidents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Integration test incident',
        location: 'Test sector',
        priority: 'High',
        people: 1,
        mechanismId: 'fall',
        note: 'Automated test record.',
      }),
    })
    assert.equal(createdResponse.status, 201)
    const incident = await createdResponse.json()

    const assessmentResponse = await fetch(`${baseUrl}/api/incidents/${incident.id}/assessments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reportedSignals: ['unresponsive'],
        reportedCauses: ['fall-height'],
        reportedInjuryPatterns: ['head-neck-spine'],
      }),
    })
    assert.equal(assessmentResponse.status, 201)
    const assessment = await assessmentResponse.json()
    assert.equal(assessment.result.status, 'urgent-human-review')
    assert.equal(assessment.result.engine, 'transparent-rule-matcher')
    assert.deepEqual(assessment.reportedCauses, ['fall-height'])
    assert.deepEqual(assessment.reportedInjuryPatterns, ['head-neck-spine'])

    const invalidAssessmentResponse = await fetch(`${baseUrl}/api/incidents/${incident.id}/assessments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reportedCauses: ['unlisted-cause'] }),
    })
    assert.equal(invalidAssessmentResponse.status, 400)

    const detail = await fetch(`${baseUrl}/api/incidents/${incident.id}`).then((response) => response.json())
    assert.deepEqual(detail.latestAssessment.reportedSignals, ['unresponsive'])
    assert.deepEqual(detail.latestAssessment.reportedCauses, ['fall-height'])
    assert.deepEqual(detail.latestAssessment.reportedInjuryPatterns, ['head-neck-spine'])
    assert.equal(detail.latestAssessment.result.status, 'urgent-human-review')

    const search = await fetch(`${baseUrl}/api/incidents?q=Integration%20test`).then((response) => response.json())
    assert.equal(search.some((row) => row.id === incident.id), true)

    const report = await fetch(`${baseUrl}/api/incidents/${incident.id}/report`).then((response) => response.json())
    assert.equal(report.incident.id, incident.id)
    assert.equal(report.guidanceCatalog.version, catalog.version)
    assert.equal(report.guidanceCatalog.causes.some((cause) => cause.id === 'fall-height'), true)
    assert.equal(report.incident.latestAssessment.result.status, 'urgent-human-review')
    assert.deepEqual(report.incident.latestAssessment.reportedInjuryPatterns, ['head-neck-spine'])

    const videoAnalysisUrl = `${baseUrl}/api/incidents/${incident.id}/video-analyses`
    const rejectedUpload = await fetch(videoAnalysisUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: '..\\private.mp4',
        fileSizeBytes: 256,
        mimeType: 'video/mp4',
        durationSeconds: 4,
      }),
    })
    assert.equal(rejectedUpload.status, 400)

    const invalidFormat = await fetch(videoAnalysisUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: 'clip.avi',
        fileSizeBytes: 256,
        mimeType: 'video/x-msvideo',
        durationSeconds: 4,
      }),
    })
    assert.equal(invalidFormat.status, 400)

    const oversizedVideo = await fetch(videoAnalysisUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: 'clip.mp4',
        fileSizeBytes: 100 * 1024 * 1024 + 1,
        mimeType: 'video/mp4',
        durationSeconds: 4,
      }),
    })
    assert.equal(oversizedVideo.status, 400)

    const queuedResponse = await fetch(videoAnalysisUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: 'local_clip.mp4',
        fileSizeBytes: 1024,
        mimeType: 'video/mp4',
        durationSeconds: 8,
      }),
    })
    assert.equal(queuedResponse.status, 201)
    const queuedAnalysis = await queuedResponse.json()
    assert.equal(queuedAnalysis.status, 'queued')
    assert.equal(queuedAnalysis.modelName, 'MediaPipe Pose Landmarker Lite')

    const analysisUrl = `${videoAnalysisUrl}/${queuedAnalysis.id}`
    const processingResponse = await fetch(analysisUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'processing' }),
    })
    assert.equal(processingResponse.status, 200)
    assert.equal((await processingResponse.json()).status, 'processing')

    const invalidCompletion = await fetch(analysisUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed', outputs: [] }),
    })
    assert.equal(invalidCompletion.status, 400)

    const outputs = Array.from({ length: 15 }, (_, index) => ({
      timestampSeconds: 8 * ((index + 0.5) / 15),
      width: 640,
      height: 480,
      landmarks: Array.from({ length: 33 }, (_, landmarkIndex) => ({
        x: landmarkIndex === 23 || landmarkIndex === 24 ? 0.4 + index / 30 : 0.5,
        y: 0.5,
        z: 0,
        visibility: 0.9,
        presence: 0.9,
      })),
    }))
    const completedResponse = await fetch(analysisUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed', outputs }),
    })
    assert.equal(completedResponse.status, 200)
    const completedAnalysis = await completedResponse.json()
    assert.equal(completedAnalysis.framesProcessed, 15)
    assert.equal(completedAnalysis.framesWithPose, 15)
    assert.ok(Math.abs(completedAnalysis.measurements.averageLandmarkVisibility - 0.9) < 1e-12)
    assert.match(completedAnalysis.modelSourceUrl, /^https:\/\/ai\.google\.dev\//)
    assert.match(completedAnalysis.datasetTrainingProvenance, /does not claim training-dataset provenance/)
    assert.ok(completedAnalysis.measurements.hipCenterDisplacementPerSecond > 0)

    const videoDetail = await fetch(`${baseUrl}/api/incidents/${incident.id}`).then((response) => response.json())
    assert.equal(videoDetail.latestVideoAnalysis.id, queuedAnalysis.id)
    assert.equal(videoDetail.latestVideoAnalysis.status, 'completed')
    const videoReport = await fetch(`${baseUrl}/api/incidents/${incident.id}/report`).then((response) => response.json())
    assert.equal(videoReport.incident.latestVideoAnalysis.framesProcessed, 15)

    const invalidTransition = await fetch(analysisUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'processing' }),
    })
    assert.equal(invalidTransition.status, 409)

    const updateResponse = await fetch(`${baseUrl}/api/incidents/${incident.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    })
    assert.equal(updateResponse.status, 200)
    assert.equal((await updateResponse.json()).status, 'closed')
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await once(child, 'exit')
    }
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('existing assessment databases gain structured observation columns', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'resq-legacy-test-'))
  const databasePath = join(temporaryDirectory, 'legacy.sqlite')
  const legacyDatabase = new DatabaseSync(databasePath)
  legacyDatabase.exec(`CREATE TABLE assessments (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    reported_signals TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE cause_categories (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    group_name TEXT NOT NULL,
    severity TEXT NOT NULL,
    note TEXT NOT NULL,
    catalog_version TEXT NOT NULL
  );
  INSERT INTO cause_categories VALUES ('retired-cause', 'Retired', 'Test', 'review', 'Old row', '0.0.0');`)
  legacyDatabase.close()

  const port = await reservePort()
  const child = spawn(process.execPath, [serverFile], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: { ...process.env, RESQ_DB_PATH: databasePath, RESQ_API_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await waitForReady(child)
    const cameraFeed = await fetch(`http://127.0.0.1:${port}/api/camera-feed`).then((response) => response.json())
    assert.equal(cameraFeed.configured, false)
    assert.equal(cameraFeed.connectionStatus, 'not-configured')
    assert.equal(cameraFeed.message, 'CCTV gateway not configured. Configure an authorized gateway to enable live-stream integration.')
    const gatewayStatusResponse = await fetch(`http://127.0.0.1:${port}/api/camera-feed/status`)
    assert.equal(gatewayStatusResponse.status, 200)
    assert.equal((await gatewayStatusResponse.json()).message, cameraFeed.message)
    assert.equal(cameraFeed.readOnly, true)
    const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true })
    const columns = migratedDatabase.prepare('PRAGMA table_info(assessments)').all().map((column) => column.name)
    migratedDatabase.close()
    assert.ok(columns.includes('reported_causes'))
    assert.ok(columns.includes('reported_injury_patterns'))
    const synchronizedDatabase = new DatabaseSync(databasePath, { readOnly: true })
    assert.equal(synchronizedDatabase.prepare("SELECT count(*) AS count FROM cause_categories WHERE id = 'retired-cause'").get().count, 0)
    synchronizedDatabase.close()
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await once(child, 'exit')
    }
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('camera feed configuration rejects credentials and non-HLS URLs', async () => {
  const invalidCameraUrls = [
    'https://user:secret@gateway.example.test/front/index.m3u8',
    'https://gateway.example.test/front/index.m3u8?token=secret',
    'https://gateway.example.test/front/stream.mp4',
    'rtsp://camera.local/front',
  ]
  for (const cameraUrl of invalidCameraUrls) {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'resq-camera-test-'))
    const port = await reservePort()
    const child = spawn(process.execPath, [serverFile], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      env: {
        ...process.env,
        RESQ_DB_PATH: join(temporaryDirectory, 'test.sqlite'),
        RESQ_API_PORT: String(port),
        RESQ_CAMERA_HLS_URL: cameraUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    try {
      await waitForReady(child)
      const configuration = await fetch(`http://127.0.0.1:${port}/api/camera-feed`).then((response) => response.json())
      assert.equal(configuration.configured, false, `Expected ${cameraUrl} to be rejected.`)
      assert.equal(configuration.configurationError, true)
      assert.equal(configuration.connectionStatus, 'invalid-configuration')
    } finally {
      if (child.exitCode === null) {
        child.kill()
        await once(child, 'exit')
      }
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }
})

test('camera gateway proxy verifies and rewrites authorized HLS playlists without leaking credentials', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'resq-camera-proxy-test-'))
  const gatewayAuthorization = []
  const gateway = createHttpServer((request, response) => {
    gatewayAuthorization.push(request.headers.authorization)
    if (request.url === '/front/index.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=120000\nnested/variant.m3u8\n')
      return
    }
    if (request.url === '/front/nested/variant.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      response.end('#EXTM3U\n#EXTINF:2,\nchunk.ts\n#EXT-X-ENDLIST\n')
      return
    }
    if (request.url === '/front/nested/chunk.ts') {
      response.writeHead(200, { 'content-type': 'video/mp2t' })
      response.end(Buffer.from([0x47, 0x40, 0x00, 0x10]))
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise((resolveListen) => gateway.listen(0, '127.0.0.1', resolveListen))
  const gatewayPort = gateway.address().port
  const port = await reservePort()
  const child = spawn(process.execPath, [serverFile], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: {
      ...process.env,
      RESQ_DB_PATH: join(temporaryDirectory, 'test.sqlite'),
      RESQ_API_PORT: String(port),
      RESQ_CAMERA_HLS_URL: `http://127.0.0.1:${gatewayPort}/front/index.m3u8`,
      RESQ_CAMERA_AUTHORIZATION: 'Bearer test-camera-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    await waitForReady(child)
    const configuration = await fetch(`${baseUrl}/api/camera-feed`).then((response) => response.json())
    assert.equal(configuration.connectionStatus, 'not-tested')
    assert.equal(JSON.stringify(configuration).includes('test-camera-secret'), false)

    const probeResponse = await fetch(`${baseUrl}/api/camera-feed/status`)
    assert.equal(probeResponse.status, 200)
    const probe = await probeResponse.json()
    assert.equal(probe.connectionStatus, 'available')
    assert.ok(probe.lastSuccessfulConnectionAt)
    assert.equal(JSON.stringify(probe).includes('test-camera-secret'), false)

    const playlistResponse = await fetch(`${baseUrl}/api/camera-feed/playlist`)
    assert.equal(playlistResponse.status, 200)
    const playlist = await playlistResponse.text()
    assert.match(playlist, /#EXT-X-STREAM-INF:BANDWIDTH=120000/)
    assert.match(playlist, /\/api\/camera-feed\/resource\/[A-Za-z0-9_-]{32}/)
    assert.equal(playlist.includes(`127.0.0.1:${gatewayPort}`), false)

    const nestedResourcePath = playlist.match(/(\/api\/camera-feed\/resource\/[A-Za-z0-9_-]{32})/)?.[1]
    assert.ok(nestedResourcePath)
    const nestedPlaylistResponse = await fetch(`${baseUrl}${nestedResourcePath}`)
    assert.equal(nestedPlaylistResponse.status, 200)
    const nestedPlaylist = await nestedPlaylistResponse.text()
    assert.match(nestedPlaylist, /#EXT-X-ENDLIST/)
    const segmentPath = nestedPlaylist.match(/(\/api\/camera-feed\/resource\/[A-Za-z0-9_-]{32})/)?.[1]
    assert.ok(segmentPath)
    const segmentResponse = await fetch(`${baseUrl}${segmentPath}`)
    assert.equal(segmentResponse.status, 200)
    assert.deepEqual([...new Uint8Array(await segmentResponse.arrayBuffer())], [0x47, 0x40, 0x00, 0x10])

    const unknownResource = await fetch(`${baseUrl}/api/camera-feed/resource/${'A'.repeat(32)}`)
    assert.equal(unknownResource.status, 404)
    assert.ok(gatewayAuthorization.length >= 4)
    assert.ok(gatewayAuthorization.every((authorization) => authorization === 'Bearer test-camera-secret'))
    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json())
    assert.equal(health.cctvGateway, 'available')
    assert.equal(JSON.stringify(health).includes('test-camera-secret'), false)
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await once(child, 'exit')
    }
    await new Promise((resolveClose) => gateway.close(resolveClose))
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('HLS adapter rejects cross-origin playlist resources and sanitizes gateway failures', async () => {
  const source = createHlsVideoSource({
    environment: {
      RESQ_CAMERA_HLS_URL: 'https://gateway.example.test/front/index.m3u8',
      RESQ_CAMERA_AUTHORIZATION: 'Bearer never-return-this',
    },
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.get('authorization'), 'Bearer never-return-this')
      return new Response('#EXTM3U\n#EXTINF:2,\nhttps://attacker.example.test/segment.ts\n', {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      })
    },
  })

  await assert.rejects(source.playlist(), { status: 502 })
  assert.equal(source.configuration().connectionStatus, 'unavailable')
  const probe = await source.probe()
  assert.equal(probe.connectionStatus, 'unavailable')
  assert.equal(probe.message, 'The HLS playlist referenced a resource outside its configured gateway.')
  assert.equal(JSON.stringify(probe).includes('never-return-this'), false)
  assert.equal(JSON.stringify(probe).includes('attacker.example.test'), false)
})

test('HLS resource tokens expire without another gateway request', async () => {
  let clock = 1_000
  let gatewayRequests = 0
  const source = createHlsVideoSource({
    environment: { RESQ_CAMERA_HLS_URL: 'https://gateway.example.test/front/index.m3u8' },
    now: () => clock,
    fetchImpl: async () => {
      gatewayRequests += 1
      return new Response('#EXTM3U\n#EXTINF:2,\nsegment.ts\n', {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      })
    },
  })

  const playlist = await source.playlist()
  const token = playlist.match(/\/api\/camera-feed\/resource\/([A-Za-z0-9_-]{32})/)?.[1]
  assert.ok(token)
  clock += 5 * 60 * 1000 + 1

  await assert.rejects(source.resource(token), { status: 404 })
  assert.equal(gatewayRequests, 1)
})