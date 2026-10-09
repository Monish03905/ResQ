import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHlsVideoSource } from './videoSource.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const catalog = JSON.parse(readFileSync(resolve(here, '../data/guidance-catalog.json'), 'utf8'))
const databasePath = resolve(process.env.RESQ_DB_PATH ?? resolve(here, '../data/resq.sqlite'))
const maxVideoBytes = 100 * 1024 * 1024
const maxVideoDurationSeconds = 300
const maxPoseFrames = 15
const poseModelName = 'MediaPipe Pose Landmarker Lite'
const poseModelVersion = 'float16 (artifact SHA256 59929e1d…690d574a)'
const poseModelAsset = 'pose_landmarker_lite.task'
const poseModelSourceUrl = 'https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker'
const poseModelPath = resolve(here, '../public/models', poseModelAsset)
const videoSource = createHlsVideoSource()
if (videoSource.configuration().configurationError) {
  console.error('Camera feed configuration error: The HLS gateway settings are invalid; no camera source is enabled.')
}
mkdirSync(dirname(databasePath), { recursive: true })

const database = new DatabaseSync(databasePath)
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    location TEXT NOT NULL,
    time TEXT NOT NULL,
    priority TEXT NOT NULL CHECK (priority IN ('High', 'Elevated', 'Monitoring')),
    people INTEGER NOT NULL DEFAULT 0 CHECK (people >= 0),
    note TEXT NOT NULL DEFAULT '',
    mechanism_id TEXT NOT NULL DEFAULT 'other-unknown',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS guidance_signals (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    group_name TEXT NOT NULL,
    urgency TEXT NOT NULL,
    note TEXT NOT NULL,
    catalog_version TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mechanism_categories (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    catalog_version TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS injury_patterns (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    group_name TEXT NOT NULL,
    severity TEXT NOT NULL,
    note TEXT NOT NULL,
    catalog_version TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cause_categories (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    group_name TEXT NOT NULL,
    severity TEXT NOT NULL,
    note TEXT NOT NULL,
    catalog_version TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assessments (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    reported_signals TEXT NOT NULL,
    reported_causes TEXT NOT NULL DEFAULT '[]',
    reported_injury_patterns TEXT NOT NULL DEFAULT '[]',
    result TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS video_analyses (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    duration_seconds REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    model_name TEXT NOT NULL,
    model_version TEXT NOT NULL,
    model_asset TEXT NOT NULL,
    frames_processed INTEGER NOT NULL DEFAULT 0,
    frames_with_pose INTEGER NOT NULL DEFAULT 0,
    outputs TEXT NOT NULL DEFAULT '[]',
    measurements TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );
`)

const assessmentColumns = new Set(database.prepare('PRAGMA table_info(assessments)').all().map((column) => column.name))
if (!assessmentColumns.has('reported_causes')) {
  database.exec("ALTER TABLE assessments ADD COLUMN reported_causes TEXT NOT NULL DEFAULT '[]'")
}
if (!assessmentColumns.has('reported_injury_patterns')) {
  database.exec("ALTER TABLE assessments ADD COLUMN reported_injury_patterns TEXT NOT NULL DEFAULT '[]'")
}

const seedIncident = database.prepare(`
  INSERT OR IGNORE INTO incidents (id, title, location, time, priority, people, note, mechanism_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const seedDate = new Date().toISOString()
;
[
  ['RQ-2408', 'Warehouse fire', 'North loading bay · Sector 4', '10:42 AM', 'High', 3, 'Smoke reported near the east stairwell. Scene assessment needed.', 'fire-smoke'],
  ['RQ-2407', 'Road collision', 'Harbor road · Junction 12', '10:18 AM', 'Elevated', 2, 'Traffic hazard reported. Dispatch confirmation pending.', 'road-collision'],
  ['RQ-2405', 'Building evacuation', 'Civic center · West entrance', '9:56 AM', 'Monitoring', 8, 'Occupant count is unverified. Search teams coordinating.', 'other-unknown'],
].forEach((incident) => seedIncident.run(...incident, seedDate))

const seedSignal = database.prepare(`
  INSERT INTO guidance_signals (id, label, group_name, urgency, note, catalog_version)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET label=excluded.label, group_name=excluded.group_name,
    urgency=excluded.urgency, note=excluded.note, catalog_version=excluded.catalog_version
`)
for (const signal of catalog.signals) {
  seedSignal.run(signal.id, signal.label, signal.group, signal.urgency, signal.note, catalog.version)
}

const seedMechanism = database.prepare(`
  INSERT INTO mechanism_categories (id, label, catalog_version) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET label=excluded.label, catalog_version=excluded.catalog_version
`)
for (const mechanism of catalog.mechanisms) {
  seedMechanism.run(mechanism.id, mechanism.label, catalog.version)
}

const seedCause = database.prepare(`
  INSERT INTO cause_categories (id, label, group_name, severity, note, catalog_version)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET label=excluded.label, group_name=excluded.group_name,
    severity=excluded.severity, note=excluded.note, catalog_version=excluded.catalog_version
`)
for (const cause of catalog.causes ?? []) {
  seedCause.run(cause.id, cause.label, cause.group, cause.severity, cause.note, catalog.version)
}

const seedInjuryPattern = database.prepare(`
  INSERT INTO injury_patterns (id, label, group_name, severity, note, catalog_version)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET label=excluded.label, group_name=excluded.group_name,
    severity=excluded.severity, note=excluded.note, catalog_version=excluded.catalog_version
`)
for (const pattern of catalog.injuryPatterns ?? []) {
  seedInjuryPattern.run(pattern.id, pattern.label, pattern.group, pattern.severity, pattern.note, catalog.version)
}

function removeObsoleteCatalogRows(table, items) {
  const ids = items.map((item) => item.id)
  if (ids.length) {
    database.prepare(`DELETE FROM ${table} WHERE id NOT IN (${ids.map(() => '?').join(', ')})`).run(...ids)
  } else {
    database.prepare(`DELETE FROM ${table}`).run()
  }
}

removeObsoleteCatalogRows('guidance_signals', catalog.signals)
removeObsoleteCatalogRows('mechanism_categories', catalog.mechanisms)
removeObsoleteCatalogRows('cause_categories', catalog.causes ?? [])
removeObsoleteCatalogRows('injury_patterns', catalog.injuryPatterns ?? [])

const statements = {
  incidents: database.prepare("SELECT * FROM incidents ORDER BY CASE priority WHEN 'High' THEN 0 WHEN 'Elevated' THEN 1 ELSE 2 END, created_at DESC"),
  searchIncidents: database.prepare('SELECT * FROM incidents WHERE title LIKE ? OR location LIKE ? OR note LIKE ? ORDER BY created_at DESC'),
  incident: database.prepare('SELECT * FROM incidents WHERE id = ?'),
  guidance: database.prepare('SELECT id, label, group_name AS "group", urgency, note FROM guidance_signals ORDER BY rowid'),
  mechanisms: database.prepare('SELECT id, label FROM mechanism_categories ORDER BY rowid'),
  causes: database.prepare('SELECT id, label, group_name AS "group", severity, note FROM cause_categories ORDER BY rowid'),
  injuryPatterns: database.prepare('SELECT id, label, group_name AS "group", severity, note FROM injury_patterns ORDER BY rowid'),
  latestAssessment: database.prepare('SELECT * FROM assessments WHERE incident_id = ? ORDER BY created_at DESC LIMIT 1'),
  latestVideoAnalysis: database.prepare('SELECT * FROM video_analyses WHERE incident_id = ? ORDER BY created_at DESC LIMIT 1'),
  videoAnalysis: database.prepare('SELECT * FROM video_analyses WHERE id = ? AND incident_id = ?'),
  insertIncident: database.prepare(`INSERT INTO incidents (id, title, location, time, priority, people, note, mechanism_id, created_at)
    VALUES (@id, @title, @location, @time, @priority, @people, @note, @mechanism_id, @created_at)`),
  insertAssessment: database.prepare(`INSERT INTO assessments
    (id, incident_id, reported_signals, reported_causes, reported_injury_patterns, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  insertVideoAnalysis: database.prepare(`INSERT INTO video_analyses
    (id, incident_id, file_name, file_size_bytes, mime_type, duration_seconds, status,
     model_name, model_version, model_asset, outputs, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, '[]', ?)`),
  updateVideoAnalysis: database.prepare(`UPDATE video_analyses
    SET status = ?, frames_processed = ?, frames_with_pose = ?, outputs = ?, measurements = ?, error = ?,
        started_at = ?, completed_at = ?
    WHERE id = ? AND incident_id = ?`),
  updateStatus: database.prepare('UPDATE incidents SET status = ? WHERE id = ?'),
}

function send(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

function sendVideoResource(response, resource) {
  if (resource.type === 'playlist') {
    response.writeHead(200, {
      'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(resource.body)
    return
  }
  const headers = {
    'content-type': resource.contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (resource.contentRange) headers['content-range'] = resource.contentRange
  if (resource.acceptRanges) headers['accept-ranges'] = resource.acceptRanges
  response.writeHead(resource.contentRange ? 206 : 200, headers)
  response.end(resource.body)
}

async function readBody(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 1_000_000) throw Object.assign(new Error('Request body is too large.'), { status: 413 })
  }
  let parsed
  try {
    parsed = body ? JSON.parse(body) : {}
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('Request body must be a JSON object.'), { status: 400 })
  }
  return parsed
}

function getIncident(id) {
  const incident = statements.incident.get(id)
  if (!incident) return null
  const assessment = statements.latestAssessment.get(id)
  const videoAnalysis = statements.latestVideoAnalysis.get(id)
  return {
    ...incident,
    latestAssessment: assessment ? {
      ...assessment,
      reportedSignals: JSON.parse(assessment.reported_signals),
      reportedCauses: JSON.parse(assessment.reported_causes),
      reportedInjuryPatterns: JSON.parse(assessment.reported_injury_patterns),
      result: JSON.parse(assessment.result),
    } : null,
    latestVideoAnalysis: videoAnalysis ? serializeVideoAnalysis(videoAnalysis) : null,
  }
}

function serializeVideoAnalysis(row) {
  return {
    id: row.id,
    incidentId: row.incident_id,
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    mimeType: row.mime_type,
    durationSeconds: row.duration_seconds,
    status: row.status,
    modelName: row.model_name,
    modelVersion: row.model_version,
    modelAsset: row.model_asset,
    modelSourceUrl: poseModelSourceUrl,
    datasetTrainingProvenance: 'Not specified by the selected pretrained model artifact; ResQ does not claim training-dataset provenance.',
    framesProcessed: row.frames_processed,
    framesWithPose: row.frames_with_pose,
    outputs: JSON.parse(row.outputs),
    measurements: row.measurements ? JSON.parse(row.measurements) : null,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

function validatePoseFrames(value, durationSeconds) {
  if (!Array.isArray(value) || value.length !== maxPoseFrames) return false
  let previousTimestamp = -1
  for (const frame of value) {
    if (!frame || typeof frame !== 'object'
      || !Number.isFinite(frame.timestampSeconds)
      || frame.timestampSeconds <= previousTimestamp
      || frame.timestampSeconds >= durationSeconds
      || !Number.isInteger(frame.width) || frame.width < 1 || frame.width > 8192
      || !Number.isInteger(frame.height) || frame.height < 1 || frame.height > 8192
      || !Array.isArray(frame.landmarks)
      || (frame.landmarks.length !== 0 && frame.landmarks.length !== 33)) return false
    previousTimestamp = frame.timestampSeconds
    for (const landmark of frame.landmarks) {
      if (!landmark || !Number.isFinite(landmark.x) || landmark.x < -1 || landmark.x > 2
        || !Number.isFinite(landmark.y) || landmark.y < -1 || landmark.y > 2
        || !Number.isFinite(landmark.z) || landmark.z < -10 || landmark.z > 10
        || !Number.isFinite(landmark.visibility) || landmark.visibility < 0 || landmark.visibility > 1
        || (landmark.presence !== null
          && (!Number.isFinite(landmark.presence) || landmark.presence < 0 || landmark.presence > 1))) return false
    }
  }
  return true
}

function calculatePoseMeasurements(frames) {
  const observedFrames = frames.filter((frame) => frame.landmarks.length === 33)
  const visibilities = observedFrames.flatMap((frame) => frame.landmarks.map((landmark) => landmark.visibility))
  const pelvisCenter = (frame) => {
    const leftHip = frame.landmarks[23]
    const rightHip = frame.landmarks[24]
    if (leftHip.visibility < 0.5 || rightHip.visibility < 0.5) return null
    return { x: (leftHip.x + rightHip.x) / 2, y: (leftHip.y + rightHip.y) / 2 }
  }
  let hipCenterDisplacementPerSecond = null
  const first = observedFrames.map((frame) => ({ frame, center: pelvisCenter(frame) })).find((item) => item.center)
  const last = observedFrames.map((frame) => ({ frame, center: pelvisCenter(frame) })).findLast((item) => item.center)
  if (first && last && first.frame !== last.frame) {
    const elapsed = last.frame.timestampSeconds - first.frame.timestampSeconds
    if (elapsed > 0) {
      hipCenterDisplacementPerSecond = Math.hypot(
        last.center.x - first.center.x,
        last.center.y - first.center.y,
      ) / elapsed
    }
  }
  return {
    sampledFrameCount: frames.length,
    framesWithPose: observedFrames.length,
    averageLandmarkVisibility: visibilities.length
      ? visibilities.reduce((sum, visibility) => sum + visibility, 0) / visibilities.length
      : null,
    hipCenterDisplacementPerSecond,
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const segments = url.pathname.split('/').filter(Boolean)
  try {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      const databaseAvailable = Boolean(database.prepare('SELECT 1 AS available').get()?.available)
      const camera = videoSource.configuration()
      return send(response, databaseAvailable ? 200 : 503, {
        status: databaseAvailable ? 'ok' : 'degraded',
        database: databaseAvailable ? 'available' : 'unavailable',
        videoProcessing: 'browser-on-device',
        poseModel: existsSync(poseModelPath) ? 'available' : 'not-installed',
        cctvGateway: !camera.configured
          ? camera.connectionStatus
          : camera.connectionStatus === 'unavailable' || camera.connectionStatus === 'invalid-configuration'
            ? 'unavailable'
            : camera.connectionStatus === 'available'
              ? 'available'
              : 'configured-not-tested',
        catalogVersion: catalog.version,
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/camera-feed') {
      const configuration = videoSource.configuration()
      if (!configuration.configured) {
        return send(response, 200, {
          ...configuration,
          message: configuration.configurationError
            ? 'The CCTV gateway configuration is invalid.'
            : 'CCTV gateway not configured. Configure an authorized gateway to enable live-stream integration.',
        })
      }
      return send(response, 200, configuration)
    }
    if (request.method === 'GET' && url.pathname === '/api/camera-feed/status') {
      const status = await videoSource.probe()
      return send(response, status.connectionStatus === 'unavailable' ? 503 : 200, status)
    }
    if (request.method === 'GET' && url.pathname === '/api/camera-feed/playlist') {
      const body = await videoSource.playlist()
      return sendVideoResource(response, { type: 'playlist', body })
    }
    if (request.method === 'GET' && segments[0] === 'api' && segments[1] === 'camera-feed'
      && segments[2] === 'resource' && segments.length === 4 && /^[A-Za-z0-9_-]{32}$/.test(segments[3])) {
      const resource = await videoSource.resource(segments[3], { range: request.headers.range })
      return sendVideoResource(response, resource)
    }
    if (request.method === 'GET' && url.pathname === '/api/guidance') {
      return send(response, 200, {
        ...catalog,
        signals: statements.guidance.all(),
        mechanisms: statements.mechanisms.all(),
        causes: statements.causes.all(),
        injuryPatterns: statements.injuryPatterns.all(),
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/incidents') {
      const query = (url.searchParams.get('q') ?? '').trim()
      const rows = query ? statements.searchIncidents.all(`%${query}%`, `%${query}%`, `%${query}%`) : statements.incidents.all()
      return send(response, 200, rows)
    }
    if (request.method === 'POST' && url.pathname === '/api/incidents') {
      const body = await readBody(request)
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      const location = typeof body.location === 'string' ? body.location.trim() : ''
      const people = body.people ?? 0
      const priority = body.priority ?? 'Monitoring'
      const mechanismId = body.mechanismId ?? 'other-unknown'
      const note = body.note ?? ''
      if (!title || !location || title.length > 120 || location.length > 160
        || !Number.isInteger(people) || people < 0 || people > 10000
        || !['High', 'Elevated', 'Monitoring'].includes(priority)
        || !catalog.mechanisms.some((item) => item.id === mechanismId)
        || typeof note !== 'string' || note.length > 500) {
        return send(response, 400, { error: 'Provide a title (1-120 characters), location (1-160 characters), valid priority and mechanism, a whole-number people count from 0 to 10000, and a note no longer than 500 characters.' })
      }
      const incident = {
        id: `RQ-${randomUUID().slice(0, 8).toUpperCase()}`,
        title,
        location,
        time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        priority,
        people,
        note: note.trim(),
        mechanism_id: mechanismId,
        status: 'open',
        created_at: new Date().toISOString(),
      }
      statements.insertIncident.run({
        id: incident.id,
        title: incident.title,
        location: incident.location,
        time: incident.time,
        priority: incident.priority,
        people: incident.people,
        note: incident.note,
        mechanism_id: incident.mechanism_id,
        created_at: incident.created_at,
      })
      return send(response, 201, incident)
    }

    if (segments[0] === 'api' && segments[1] === 'incidents' && segments[2]) {
      const id = segments[2]
      if (request.method === 'POST' && segments[3] === 'video-analyses' && segments.length === 4) {
        if (!statements.incident.get(id)) return send(response, 404, { error: 'Incident not found.' })
        const body = await readBody(request)
        const validFileName = typeof body.fileName === 'string'
          && body.fileName.length > 0 && body.fileName.length <= 160
          && !/[\\/]/.test(body.fileName) && !body.fileName.includes('..')
        if (!validFileName
          || !Number.isSafeInteger(body.fileSizeBytes) || body.fileSizeBytes <= 0 || body.fileSizeBytes > maxVideoBytes
          || !['video/mp4', 'video/webm'].includes(body.mimeType)
          || !Number.isFinite(body.durationSeconds) || body.durationSeconds <= 0 || body.durationSeconds > maxVideoDurationSeconds) {
          return send(response, 400, {
            error: `Provide a safe file name, an MP4 or WebM up to ${maxVideoBytes / 1024 / 1024} MB, and a video duration up to ${maxVideoDurationSeconds} seconds.`,
          })
        }
        const analysisId = randomUUID()
        const createdAt = new Date().toISOString()
        statements.insertVideoAnalysis.run(
          analysisId,
          id,
          body.fileName,
          body.fileSizeBytes,
          body.mimeType,
          body.durationSeconds,
          poseModelName,
          poseModelVersion,
          poseModelAsset,
          createdAt,
        )
        return send(response, 201, serializeVideoAnalysis(statements.videoAnalysis.get(analysisId, id)))
      }
      if (request.method === 'PATCH' && segments[3] === 'video-analyses' && segments.length === 5) {
        const row = statements.videoAnalysis.get(segments[4], id)
        if (!row) return send(response, 404, { error: 'Video analysis not found.' })
        const body = await readBody(request)
        if (!['processing', 'completed', 'failed'].includes(body.status)) {
          return send(response, 400, { error: 'Analysis status must be processing, completed, or failed.' })
        }
        const transitionAllowed = (row.status === 'queued' && ['processing', 'failed'].includes(body.status))
          || (row.status === 'processing' && ['completed', 'failed'].includes(body.status))
        if (!transitionAllowed) return send(response, 409, { error: `Analysis cannot transition from ${row.status} to ${body.status}.` })

        let outputs = []
        let measurements = null
        let errorMessage = null
        let framesWithPose = 0
        if (body.status === 'completed') {
          if (!validatePoseFrames(body.outputs, row.duration_seconds)) {
            return send(response, 400, { error: `Completed analysis must contain exactly ${maxPoseFrames} valid sampled frame results.` })
          }
          outputs = body.outputs
          measurements = calculatePoseMeasurements(outputs)
          framesWithPose = measurements.framesWithPose
        } else if (body.status === 'failed') {
          if (typeof body.error !== 'string' || !body.error.trim() || body.error.length > 500) {
            return send(response, 400, { error: 'Provide a concise processing error for a failed analysis.' })
          }
          errorMessage = body.error.trim()
        }
        const now = new Date().toISOString()
        statements.updateVideoAnalysis.run(
          body.status,
          outputs.length,
          framesWithPose,
          JSON.stringify(outputs),
          measurements ? JSON.stringify(measurements) : null,
          errorMessage,
          body.status === 'processing' ? now : row.started_at,
          body.status === 'completed' || body.status === 'failed' ? now : null,
          row.id,
          id,
        )
        return send(response, 200, serializeVideoAnalysis(statements.videoAnalysis.get(row.id, id)))
      }
      if (request.method === 'GET' && segments[3] === 'report') {
        const incident = getIncident(id)
        if (!incident) return send(response, 404, { error: 'Incident not found.' })
        return send(response, 200, {
          product: 'ResQ incident coordination prototype',
          generatedAt: new Date().toISOString(),
          incident,
          guidanceCatalog: {
            id: catalog.id,
            version: catalog.version,
            sources: catalog.sources,
            mechanisms: statements.mechanisms.all(),
            causes: statements.causes.all(),
            injuryPatterns: statements.injuryPatterns.all(),
            signals: statements.guidance.all(),
          },
          limitations: [
            'This report contains responder-entered observations and rule matches only; it is not an AI diagnosis.',
            'Video analysis, when present, is on-device pose landmark estimation and normalized image-coordinate movement measurement only; it does not detect or diagnose injuries.',
            'The selected pretrained pose model does not specify training-dataset provenance in the artifact; ResQ does not claim that it was trained on injury data.',
            'The local API validates the submitted result structure but does not cryptographically attest that inference was run by the stated browser model.',
            'No injury, cause, age, gender, or emotional-state inference was performed.',
            'Use qualified responders and local emergency protocols for all clinical and dispatch decisions.',
          ],
        })
      }
      if (request.method === 'POST' && segments[3] === 'assessments') {
        if (!statements.incident.get(id)) return send(response, 404, { error: 'Incident not found.' })
        const body = await readBody(request)
        const reportedSignals = body.reportedSignals ?? []
        const reportedCauses = body.reportedCauses ?? []
        const reportedInjuryPatterns = body.reportedInjuryPatterns ?? []
        if (![reportedSignals, reportedCauses, reportedInjuryPatterns].every(Array.isArray)) {
          return send(response, 400, { error: 'Reported signals, causes, and injury patterns must be arrays.' })
        }
        const normalizedLists = [
          [...new Set(reportedSignals)],
          [...new Set(reportedCauses)],
          [...new Set(reportedInjuryPatterns)],
        ]
        const allowedLists = [
          new Set(catalog.signals.map((item) => item.id)),
          new Set((catalog.causes ?? []).map((item) => item.id)),
          new Set((catalog.injuryPatterns ?? []).map((item) => item.id)),
        ]
        if (normalizedLists.some((items, index) =>
          items.some((item) => typeof item !== 'string' || !allowedLists[index].has(item)))) {
          return send(response, 400, { error: 'Assessment contains an unknown catalog item.' })
        }
        const [uniqueSignals, uniqueCauses, uniqueInjuryPatterns] = normalizedLists
        const matched = catalog.signals.filter((signal) => uniqueSignals.includes(signal.id))
        const urgent = matched.some((signal) => signal.urgency === 'urgent')
        const result = {
          engine: 'transparent-rule-matcher',
          catalogVersion: catalog.version,
          status: urgent ? 'urgent-human-review' : 'human-review-required',
          summary: urgent
            ? 'A responder-entered emergency warning sign was selected. Contact local emergency services and follow dispatcher guidance.'
            : 'No urgent catalog warning sign was selected. This does not rule out serious injury; request qualified in-person assessment.',
          matchedSignals: matched.map(({ id: signalId, label, urgency }) => ({ id: signalId, label, urgency })),
          reportedCauses: uniqueCauses,
          reportedInjuryPatterns: uniqueInjuryPatterns,
          limitations: 'This is deterministic rule matching, not machine learning, video analysis, diagnosis, or a substitute for local protocols.',
        }
        const assessmentId = randomUUID()
        const createdAt = new Date().toISOString()
        statements.insertAssessment.run(
          assessmentId,
          id,
          JSON.stringify(uniqueSignals),
          JSON.stringify(uniqueCauses),
          JSON.stringify(uniqueInjuryPatterns),
          JSON.stringify(result),
          createdAt,
        )
        return send(response, 201, {
          id: assessmentId,
          incidentId: id,
          reportedSignals: uniqueSignals,
          reportedCauses: uniqueCauses,
          reportedInjuryPatterns: uniqueInjuryPatterns,
          result,
          createdAt,
        })
      }
      if (request.method === 'PATCH' && segments[3] === 'status') {
        const body = await readBody(request)
        if (!['open', 'closed'].includes(body.status)) return send(response, 400, { error: 'Status must be open or closed.' })
        const update = statements.updateStatus.run(body.status, id)
        if (!Number(update.changes)) return send(response, 404, { error: 'Incident not found.' })
        return send(response, 200, getIncident(id))
      }
      if (request.method === 'GET' && segments.length === 3) {
        const incident = getIncident(id)
        return incident ? send(response, 200, incident) : send(response, 404, { error: 'Incident not found.' })
      }
    }
    return send(response, 404, { error: 'Route not found.' })
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500
    const message = status >= 500
      ? error.message ?? 'Unexpected server error.'
      : error.message ?? 'The request could not be completed.'
    return send(response, status, { error: message })
  }
})

const port = Number(process.env.RESQ_API_PORT ?? 4174)
server.listen(port, '127.0.0.1', () => {
  console.log(`ResQ API listening at http://127.0.0.1:${port}`)
})

function close() {
  server.close(() => {
    database.close()
    process.exit(0)
  })
}
process.on('SIGINT', close)
process.on('SIGTERM', close)