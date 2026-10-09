import { randomBytes } from 'node:crypto'

const STREAM_REQUEST_TIMEOUT_MS = 8_000
const PLAYLIST_MAX_BYTES = 1_000_000
const RESOURCE_MAX_BYTES = 32 * 1024 * 1024
const RESOURCE_TOKEN_TTL_MS = 5 * 60 * 1000
const MAX_RESOURCE_TOKENS = 2_000

function safeIdentifier(value, fallback) {
  const normalized = value?.trim()
  return normalized && /^[A-Za-z0-9._-]{1,80}$/.test(normalized) ? normalized : fallback
}

function parseConfiguration(environment) {
  const configuredUrl = environment.RESQ_CAMERA_HLS_URL?.trim()
  const enabled = environment.RESQ_CAMERA_ENABLED?.trim().toLowerCase() !== 'false'
  if (!enabled || !configuredUrl) return { enabled, playlistUrl: null, error: null }

  try {
    const playlistUrl = new URL(configuredUrl)
    if (!['http:', 'https:'].includes(playlistUrl.protocol)
      || playlistUrl.username
      || playlistUrl.password
      || playlistUrl.search
      || playlistUrl.hash
      || !playlistUrl.pathname.toLowerCase().endsWith('.m3u8')) {
      throw new Error('Use a credential-free HTTP(S) HLS playlist URL without query strings or fragments.')
    }
    return { enabled, playlistUrl, error: null }
  } catch (error) {
    return {
      enabled,
      playlistUrl: null,
      error: error instanceof Error ? error.message : 'Invalid HLS gateway configuration.',
    }
  }
}

function fetchErrorMessage(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return 'The configured HLS gateway did not respond before the connection timed out.'
  }
  return 'The configured HLS gateway could not be reached.'
}

function hasHlsContentType(response) {
  return /(?:application|audio|video)\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(response.headers.get('content-type') ?? '')
}

export function createHlsVideoSource({
  environment = process.env,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const config = parseConfiguration(environment)
  const accessToken = environment.RESQ_CAMERA_AUTHORIZATION?.trim()
  const label = environment.RESQ_CAMERA_LABEL?.trim()
  const gatewayIdentifier = safeIdentifier(environment.RESQ_CAMERA_GATEWAY_ID, 'configured-gateway')
  const streamIdentifier = safeIdentifier(environment.RESQ_CAMERA_STREAM_ID, 'configured-stream')
  const displayName = label && label.length <= 80 ? label : 'Authorized camera feed'
  const resources = new Map()
  let connectionStatus = !config.enabled
    ? 'disabled'
    : config.playlistUrl
      ? 'not-tested'
      : config.error
        ? 'invalid-configuration'
        : 'not-configured'
  let lastSuccessfulConnectionAt = null

  const publicConfiguration = () => ({
    configured: Boolean(config.playlistUrl),
    enabled: config.enabled,
    sourceName: displayName,
    sourceType: 'hls',
    gatewayIdentifier,
    streamIdentifier,
    protocol: 'hls',
    readOnly: true,
    connectionStatus,
    lastSuccessfulConnectionAt,
    configurationError: Boolean(config.error),
  })

  const requestHeaders = (additionalHeaders = {}) => {
    const headers = new Headers(additionalHeaders)
    if (accessToken) headers.set('authorization', accessToken)
    return headers
  }

  const resolveGatewayResource = (resource, baseUrl = config.playlistUrl) => {
    let resolved
    try {
      resolved = new URL(resource, baseUrl)
    } catch {
      throw Object.assign(new Error('The HLS playlist contains an invalid resource reference.'), { status: 502 })
    }
    if (!['http:', 'https:'].includes(resolved.protocol)
      || resolved.origin !== config.playlistUrl.origin
      || resolved.username
      || resolved.password
      || resolved.hash) {
      throw Object.assign(new Error('The HLS playlist referenced a resource outside its configured gateway.'), { status: 502 })
    }
    return resolved
  }

  const requestGateway = async (url, { range } = {}) => {
    const headers = requestHeaders({ accept: '*/*' })
    if (range && /^bytes=\d*-\d*(?:,\d*-\d*)*$/.test(range)) headers.set('range', range)
    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(STREAM_REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      connectionStatus = 'unavailable'
      throw Object.assign(new Error(fetchErrorMessage(error)), { status: 502 })
    }
    if (!response.ok) {
      connectionStatus = 'unavailable'
      throw Object.assign(new Error(`The configured HLS gateway returned HTTP ${response.status}.`), { status: 502 })
    }
    return response
  }

  const readLimitedBuffer = async (response, maxBytes, message) => {
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw Object.assign(new Error(message), { status: 502 })
    }
    if (!response.body) {
      const body = Buffer.from(await response.arrayBuffer())
      if (body.length > maxBytes) throw Object.assign(new Error(message), { status: 502 })
      return body
    }
    const reader = response.body.getReader()
    const chunks = []
    let totalBytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        totalBytes += value.byteLength
        if (totalBytes > maxBytes) {
          void reader.cancel()
          throw Object.assign(new Error(message), { status: 502 })
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks, totalBytes)
  }

  const readLimitedText = async (response, maxBytes) => {
    const body = await readLimitedBuffer(response, maxBytes, 'The HLS gateway playlist exceeded the allowed size.')
    return body.toString('utf8')
  }

  const rewriteResource = (resource) => {
    const resolved = resolveGatewayResource(resource)
    const timestamp = now()
    for (const [token, value] of resources) {
      if (value.expiresAt <= timestamp) resources.delete(token)
    }
    while (resources.size >= MAX_RESOURCE_TOKENS) {
      const oldestToken = resources.keys().next().value
      if (!oldestToken) break
      resources.delete(oldestToken)
    }
    const token = randomBytes(24).toString('base64url')
    resources.set(token, { url: resolved, expiresAt: timestamp + RESOURCE_TOKEN_TTL_MS })
    return `/api/camera-feed/resource/${token}`
  }

  const rewritePlaylist = (playlistText, baseUrl) => {
    const lines = playlistText.split(/\r?\n/)
    return lines.map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_match, resource) => `URI="${rewriteResource(resolveGatewayResource(resource, baseUrl).href)}"`)
      }
      return rewriteResource(resolveGatewayResource(trimmed, baseUrl).href)
    }).join('\n')
  }

  const validatePlaylistResources = (playlistText, baseUrl) => {
    for (const line of playlistText.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('#')) {
        for (const match of trimmed.matchAll(/URI="([^"]+)"/g)) {
          resolveGatewayResource(match[1], baseUrl)
        }
      } else {
        resolveGatewayResource(trimmed, baseUrl)
      }
    }
  }

  const fetchPlaylist = async (url = config.playlistUrl) => {
    if (!config.playlistUrl) {
      throw Object.assign(new Error(config.error ?? 'CCTV gateway is not configured.'), { status: config.error ? 503 : 503 })
    }
    const response = await requestGateway(url)
    if (!hasHlsContentType(response)) {
      connectionStatus = 'unavailable'
      throw Object.assign(new Error('The configured gateway response is not an HLS playlist.'), { status: 502 })
    }
    const playlistText = await readLimitedText(response, PLAYLIST_MAX_BYTES)
    if (!playlistText.trimStart().startsWith('#EXTM3U')) {
      connectionStatus = 'unavailable'
      throw Object.assign(new Error('The configured gateway response is not a valid HLS playlist.'), { status: 502 })
    }
    connectionStatus = 'available'
    lastSuccessfulConnectionAt = new Date(now()).toISOString()
    return { text: playlistText, url }
  }

  return {
    configuration: publicConfiguration,
    async probe() {
      if (!config.enabled) {
        connectionStatus = 'disabled'
        return { ...publicConfiguration(), message: 'The configured CCTV source is disabled.' }
      }
      if (!config.playlistUrl) {
        connectionStatus = config.error ? 'invalid-configuration' : 'not-configured'
        return {
          ...publicConfiguration(),
          message: config.error
            ? 'The CCTV gateway configuration is invalid.'
            : 'CCTV gateway not configured. Configure an authorized gateway to enable live-stream integration.',
        }
      }
      try {
        const { text, url } = await fetchPlaylist()
        validatePlaylistResources(text, url)
        return { ...publicConfiguration(), message: 'The HLS gateway playlist is reachable.' }
      } catch (error) {
        connectionStatus = 'unavailable'
        return {
          ...publicConfiguration(),
          connectionStatus: 'unavailable',
          message: error instanceof Error ? error.message : 'The HLS gateway is unavailable.',
        }
      }
    },
    async playlist() {
      try {
        const { text, url } = await fetchPlaylist()
        const body = rewritePlaylist(text, url)
        connectionStatus = 'available'
        return body
      } catch (error) {
        connectionStatus = 'unavailable'
        throw error
      }
    },
    async resource(token, { range } = {}) {
      const entry = resources.get(token)
      if (!entry || entry.expiresAt <= now()) {
        resources.delete(token)
        throw Object.assign(new Error('This stream resource expired. Reconnect to the camera feed.'), { status: 404 })
      }
      const response = await requestGateway(entry.url, { range })
      const isPlaylist = entry.url.pathname.toLowerCase().endsWith('.m3u8') || hasHlsContentType(response)
      if (isPlaylist) {
        const text = await readLimitedText(response, PLAYLIST_MAX_BYTES)
        if (!text.trimStart().startsWith('#EXTM3U')) {
          connectionStatus = 'unavailable'
          throw Object.assign(new Error('The HLS gateway returned an invalid media playlist.'), { status: 502 })
        }
        connectionStatus = 'available'
        lastSuccessfulConnectionAt = new Date(now()).toISOString()
        return { type: 'playlist', body: rewritePlaylist(text, entry.url) }
      }
      const contentLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(contentLength) && contentLength > RESOURCE_MAX_BYTES) {
        throw Object.assign(new Error('The HLS gateway stream segment exceeded the allowed size.'), { status: 502 })
      }
      const body = await readLimitedBuffer(response, RESOURCE_MAX_BYTES, 'The HLS gateway stream segment exceeded the allowed size.')
      connectionStatus = 'available'
      lastSuccessfulConnectionAt = new Date(now()).toISOString()
      return {
        type: 'resource',
        body,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        contentRange: response.headers.get('content-range'),
        acceptRanges: response.headers.get('accept-ranges'),
      }
    },
  }
}
