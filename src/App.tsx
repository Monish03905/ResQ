import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type Hls from 'hls.js'
import type { PoseFrame } from './poseAnalysisTypes'
import type { VideoAnalysis } from './poseAnalysisTypes'
import {
  MAX_VIDEO_BYTES,
  MAX_VIDEO_DURATION_SECONDS,
  POSE_MODEL_ASSET,
  POSE_MODEL_NAME,
  POSE_MODEL_VERSION,
  POSE_SAMPLE_COUNT,
  processPoseVideo,
} from './poseVideo'
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpRight,
  Bell,
  Camera,
  Check,
  ChevronDown,
  Clock3,
  CloudUpload,
  Crosshair,
  FileText,
  Flame,
  HeartPulse,
  MapPin,
  Menu,
  Plus,
  Radio,
  Search,
  ShieldAlert,
  Siren,
  Thermometer,
  Users,
  Video,
  X,
} from 'lucide-react'
import './App.css'

type Incident = {
  id: string
  title: string
  location: string
  time: string
  priority: 'High' | 'Elevated' | 'Monitoring'
  people: number
  note: string
  mechanism_id: string
  status: 'open' | 'closed'
  created_at: string
}

const toggleReportedCategory = (
  categoryId: string,
  current: string[],
  update: (value: string[]) => void,
) => {
  update(current.includes(categoryId)
    ? current.filter((id) => id !== categoryId)
    : [...current, categoryId])
}

const sameSelections = (left: string[], right: string[]) =>
  left.length === right.length && left.every((id) => right.includes(id))

type GuidanceSignal = {
  id: string
  label: string
  group: string
  urgency: 'urgent' | 'review'
  note: string
}

type Mechanism = { id: string; label: string }
type CatalogCategory = { id: string; label: string; group: string; severity: string; note: string }
type IncidentStatusFilter = 'all' | Incident['status']
type CameraFeedConfig = {
  configured: boolean
  enabled: boolean
  sourceName: string
  sourceType: 'hls'
  gatewayIdentifier: string
  streamIdentifier: string
  protocol: 'hls'
  readOnly: true
  connectionStatus: 'not-configured' | 'disabled' | 'invalid-configuration' | 'not-tested' | 'available' | 'unavailable'
  lastSuccessfulConnectionAt: string | null
  configurationError?: boolean
  message?: string
}

type Assessment = {
  id: string
  incidentId: string
  reportedSignals: string[]
  reportedCauses: string[]
  reportedInjuryPatterns: string[]
  result: {
    status: string
    summary: string
    matchedSignals: Array<{ id: string; label: string; urgency: string }>
    reportedCauses: string[]
    reportedInjuryPatterns: string[]
    limitations: string
  }
  createdAt: string
}

type IncidentDetail = Incident & { latestAssessment: Assessment | null; latestVideoAnalysis: VideoAnalysis | null }

async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  })
  let value: unknown
  try {
    value = await response.json()
  } catch (error) {
    if (!response.ok) {
      throw new Error(`The local ResQ API is unavailable (HTTP ${response.status}).`)
    }
    throw new Error(`The local ResQ API returned invalid JSON: ${error instanceof Error ? error.message : 'unknown parsing error'}`)
  }
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
      ? value.error
      : `The local ResQ API returned HTTP ${response.status}.`
    throw new Error(message)
  }
  return value as T
}

const emptyIncidentForm = {
  title: '',
  location: '',
  priority: 'Monitoring' as Incident['priority'],
  people: '0',
  mechanismId: 'other-unknown',
  note: '',
}

const fallbackIncident: Incident = {
  id: '',
  title: 'Loading incidents',
  location: 'Waiting for local database',
  time: '--:--',
  priority: 'Monitoring',
  people: 0,
  note: '',
  mechanism_id: 'other-unknown',
  status: 'open',
  created_at: '',
}

const navItems = [
  { label: 'Overview', icon: Activity },
  { label: 'Incidents', icon: ShieldAlert },
  { label: 'Camera feeds', icon: Camera },
  { label: 'Response plans', icon: Users },
  { label: 'Reports', icon: FileText },
]

const poseConnections: Array<[number, number]> = [
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
]

function App() {
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [activeIncidentId, setActiveIncidentId] = useState('')
  const [signals, setSignals] = useState<GuidanceSignal[]>([])
  const [mechanisms, setMechanisms] = useState<Mechanism[]>([])
  const [causes, setCauses] = useState<CatalogCategory[]>([])
  const [injuryPatterns, setInjuryPatterns] = useState<CatalogCategory[]>([])
  const [reportedSignals, setReportedSignals] = useState<string[]>([])
  const [reportedCauses, setReportedCauses] = useState<string[]>([])
  const [reportedInjuryPatterns, setReportedInjuryPatterns] = useState<string[]>([])
  const [latestAssessment, setLatestAssessment] = useState<Assessment | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [incidentStatusFilter, setIncidentStatusFilter] = useState<IncidentStatusFilter>('all')
  const [cameraFeed, setCameraFeed] = useState<CameraFeedConfig | null>(null)
  const [feedSource, setFeedSource] = useState<'demo' | 'upload' | 'camera'>('demo')
  const [cameraState, setCameraState] = useState<'disconnected' | 'connecting' | 'ready' | 'live' | 'error'>('disconnected')
  const [cameraError, setCameraError] = useState('')
  const [cameraAuthorizationConfirmed, setCameraAuthorizationConfirmed] = useState(false)
  const [apiError, setApiError] = useState('')
  const [apiState, setApiState] = useState<'checking' | 'online' | 'offline'>('checking')
  const [showCreate, setShowCreate] = useState(false)
  const [creatingIncident, setCreatingIncident] = useState(false)
  const [updatingStatus, setUpdatingStatus] = useState(false)
  const [downloadingReport, setDownloadingReport] = useState(false)
  const [newIncident, setNewIncident] = useState(emptyIncidentForm)
  const [activeNav, setActiveNav] = useState('Overview')
  const [feedMode, setFeedMode] = useState<'Visible' | 'Thermal'>('Visible')
  const [videoUrl, setVideoUrl] = useState('')
  const [videoName, setVideoName] = useState('')
  const [uploadedVideoFile, setUploadedVideoFile] = useState<File | null>(null)
  const [videoDurationSeconds, setVideoDurationSeconds] = useState<number | null>(null)
  const [previewTimeSeconds, setPreviewTimeSeconds] = useState(0)
  const [latestVideoAnalysis, setLatestVideoAnalysis] = useState<VideoAnalysis | null>(null)
  const [poseStatus, setPoseStatus] = useState<'idle' | 'queued' | 'processing' | 'completed' | 'failed'>('idle')
  const [poseProgress, setPoseProgress] = useState(0)
  const [poseError, setPoseError] = useState('')
  const [analysisState, setAnalysisState] = useState<'idle' | 'reviewing' | 'ready'>('idle')
  const [showConnect, setShowConnect] = useState(false)
  const [checkingCameraGateway, setCheckingCameraGateway] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [currentTime, setCurrentTime] = useState(() => new Date())
  const uploadRef = useRef<HTMLInputElement>(null)
  const videoPreviewRef = useRef<HTMLVideoElement>(null)
  const hlsPlayerRef = useRef<Hls | null>(null)
  const poseOverlayRef = useRef<HTMLCanvasElement>(null)
  const processingVideoRef = useRef(false)
  const activeIncident = incidents.find((incident) => incident.id === activeIncidentId) ?? incidents[0] ?? fallbackIncident
  const visibleIncidents = incidents.filter((incident) =>
    (incidentStatusFilter === 'all' || incident.status === incidentStatusFilter)
    && `${incident.title} ${incident.location} ${incident.note}`.toLowerCase().includes(searchQuery.trim().toLowerCase()),
  )
  const hasUnsavedReviewChanges = !sameSelections(reportedSignals, latestAssessment?.reportedSignals ?? [])
    || !sameSelections(reportedCauses, latestAssessment?.reportedCauses ?? [])
    || !sameSelections(reportedInjuryPatterns, latestAssessment?.reportedInjuryPatterns ?? [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      apiRequest<Incident[]>('/api/incidents'),
      apiRequest<{
        signals: GuidanceSignal[]
        mechanisms: Mechanism[]
        causes: CatalogCategory[]
        injuryPatterns: CatalogCategory[]
      }>('/api/guidance'),
      apiRequest<CameraFeedConfig>('/api/camera-feed'),
    ]).then(([incidentRows, catalog, cameraConfiguration]) => {
      if (cancelled) return
      setIncidents(incidentRows)
      setActiveIncidentId(incidentRows[0]?.id ?? '')
      setSignals(catalog.signals)
      setMechanisms(catalog.mechanisms)
      setCauses(catalog.causes)
      setInjuryPatterns(catalog.injuryPatterns)
      setCameraFeed(cameraConfiguration)
      setApiError('')
      setApiState('online')
    }).catch((error: Error) => {
      if (!cancelled) {
        setApiError(error.message)
        setApiState('offline')
      }
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!showConnect && !showCreate) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || creatingIncident) return
      setShowConnect(false)
      setShowCreate(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [creatingIncident, showConnect, showCreate])

  useEffect(() => {
    if (feedSource !== 'camera' || !cameraFeed?.configured) {
      return
    }
    const video = videoPreviewRef.current
    if (!video) return
    const streamUrl = '/api/camera-feed/playlist'
    let player: Hls | null = null
    let disposed = false
    const fail = (message: string) => {
      if (disposed) return
      setCameraState('error')
      setCameraError(message)
    }
    const handleNativeReady = () => {
      if (disposed) return
      setCameraState('ready')
      void video.play().catch(() => setToast('Camera stream is ready. Press play to start the preview.'))
    }
    const handlePlaying = () => {
      if (disposed) return
      setCameraState('live')
      setCameraError('')
    }
    const handlePlaybackStopped = () => {
      if (disposed) return
      setCameraState((state) => state === 'live' ? 'ready' : state)
    }
    const handleNativeError = () => fail('The configured HLS gateway could not play this stream.')

    video.addEventListener('loadedmetadata', handleNativeReady)
    video.addEventListener('playing', handlePlaying)
    video.addEventListener('pause', handlePlaybackStopped)
    video.addEventListener('ended', handlePlaybackStopped)
    video.addEventListener('error', handleNativeError)
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = streamUrl
      video.load()
    } else {
      void import('hls.js/light').then(({ default: HlsPlayer }) => {
        if (disposed) return
        if (!HlsPlayer.isSupported()) {
          fail('This browser does not support HLS playback.')
          return
        }
        const hlsPlayer = new HlsPlayer({ enableWorker: true, lowLatencyMode: true })
        player = hlsPlayer
        hlsPlayerRef.current = hlsPlayer
        hlsPlayer.on(HlsPlayer.Events.MEDIA_ATTACHED, () => hlsPlayer.loadSource(streamUrl))
        hlsPlayer.on(HlsPlayer.Events.MANIFEST_PARSED, () => {
          if (disposed) return
          setCameraState('ready')
          void video.play().catch(() => {
            setToast('Camera stream is ready. Press play to start the preview.')
          })
        })
        hlsPlayer.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (!data.fatal) return
          fail('The HLS gateway stream could not be loaded. Check the gateway, network, and playlist access.')
        })
        hlsPlayer.attachMedia(video)
      }).catch((error: unknown) => {
        fail(error instanceof Error ? `HLS playback could not start: ${error.message}` : 'HLS playback could not start.')
      })
    }
    return () => {
      disposed = true
      video.removeEventListener('loadedmetadata', handleNativeReady)
      video.removeEventListener('playing', handlePlaying)
      video.removeEventListener('pause', handlePlaybackStopped)
      video.removeEventListener('ended', handlePlaybackStopped)
      video.removeEventListener('error', handleNativeError)
      player?.destroy()
      if (hlsPlayerRef.current === player) hlsPlayerRef.current = null
      if (video.src === streamUrl) {
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
    }
  }, [cameraFeed, feedSource])

  useEffect(() => {
    if (!activeIncidentId) return
    let cancelled = false
    apiRequest<IncidentDetail>(`/api/incidents/${encodeURIComponent(activeIncidentId)}`).then((incident) => {
      if (cancelled) return
      setLatestAssessment(incident.latestAssessment)
      setReportedSignals(incident.latestAssessment?.reportedSignals ?? [])
      setReportedCauses(incident.latestAssessment?.reportedCauses ?? [])
      setReportedInjuryPatterns(incident.latestAssessment?.reportedInjuryPatterns ?? [])
      setLatestVideoAnalysis(incident.latestVideoAnalysis)
      setPoseStatus(incident.latestVideoAnalysis?.status ?? 'idle')
      setPoseProgress(incident.latestVideoAnalysis?.framesProcessed ?? 0)
      setPoseError(incident.latestVideoAnalysis?.error ?? '')
      setAnalysisState(incident.latestAssessment ? 'ready' : 'idle')
      setApiError('')
      setApiState('online')
    }).catch((error: Error) => {
      if (!cancelled) {
        setApiError(error.message)
        setApiState('offline')
      }
    })
    return () => { cancelled = true }
  }, [activeIncidentId])

  useEffect(() => () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl)
  }, [videoUrl])

  useEffect(() => {
    const canvas = poseOverlayRef.current
    const video = videoPreviewRef.current
    if (!canvas || !video || !videoUrl || poseStatus !== 'completed' || !latestVideoAnalysis) return
    const frames: PoseFrame[] = latestVideoAnalysis.outputs
    if (!frames.length) return

    const draw = () => {
      const context = canvas.getContext('2d')
      if (!context) return
      const bounds = canvas.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.round(bounds.width * ratio)
      canvas.height = Math.round(bounds.height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, bounds.width, bounds.height)

      const frame = frames.reduce((closest, candidate) =>
        Math.abs(candidate.timestampSeconds - previewTimeSeconds) < Math.abs(closest.timestampSeconds - previewTimeSeconds)
          ? candidate
          : closest)
      const halfSampleInterval = latestVideoAnalysis.durationSeconds / (POSE_SAMPLE_COUNT * 2)
      if (Math.abs(frame.timestampSeconds - previewTimeSeconds) > halfSampleInterval || frame.landmarks.length !== 33) return

      const scale = Math.min(bounds.width / frame.width, bounds.height / frame.height)
      const drawnWidth = frame.width * scale
      const drawnHeight = frame.height * scale
      const offsetX = (bounds.width - drawnWidth) / 2
      const offsetY = (bounds.height - drawnHeight) / 2
      context.lineWidth = 2
      context.strokeStyle = '#d7ff75'
      context.fillStyle = '#f4ffcf'
      context.lineCap = 'round'
      for (const [start, end] of poseConnections) {
        const a = frame.landmarks[start]
        const b = frame.landmarks[end]
        if (a.visibility < 0.5 || b.visibility < 0.5) continue
        context.beginPath()
        context.moveTo(offsetX + a.x * drawnWidth, offsetY + a.y * drawnHeight)
        context.lineTo(offsetX + b.x * drawnWidth, offsetY + b.y * drawnHeight)
        context.stroke()
      }
      for (const landmark of frame.landmarks) {
        if (landmark.visibility < 0.5) continue
        context.beginPath()
        context.arc(offsetX + landmark.x * drawnWidth, offsetY + landmark.y * drawnHeight, 3, 0, Math.PI * 2)
        context.fill()
      }
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [latestVideoAnalysis, poseStatus, previewTimeSeconds, videoUrl])

  const handleUpload = (file?: File) => {
    if (!file) return
    const extension = file.name.split('.').pop()?.toLowerCase()
    const supportedType = (file.type === 'video/mp4' && extension === 'mp4')
      || (file.type === 'video/webm' && extension === 'webm')
      || (!file.type && ['mp4', 'webm'].includes(extension ?? ''))
    if (!supportedType) {
      setToast('Unsupported video. Choose an MP4 or WebM video.')
      return
    }
    if (file.size <= 0 || file.size > MAX_VIDEO_BYTES) {
      setToast(`Video must be between 1 byte and ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`)
      return
    }
    setVideoUrl(URL.createObjectURL(file))
    setFeedSource('upload')
    setCameraState('disconnected')
    setVideoName(file.name)
    setUploadedVideoFile(file)
    setVideoDurationSeconds(null)
    setPreviewTimeSeconds(0)
    setPoseStatus('idle')
    setPoseProgress(0)
    setPoseError('')
    setAnalysisState('idle')
    setToast('Video loaded for local preview. Processing is optional and will run on this device.')
  }

  const analyzeUploadedVideo = async () => {
    if (!uploadedVideoFile || !activeIncident.id || processingVideoRef.current) return
    processingVideoRef.current = true
    setPoseStatus('queued')
    setPoseProgress(0)
    setPoseError('')
    let analysisId = ''
    try {
      const result = await processPoseVideo(uploadedVideoFile, async ({ durationSeconds }) => {
        setVideoDurationSeconds(durationSeconds)
        const filename = uploadedVideoFile.name
          .replace(/[^A-Za-z0-9._-]/g, '_')
          .replace(/\.\.+/g, '.')
          .slice(0, 160)
        const queued = await apiRequest<VideoAnalysis>(
          `/api/incidents/${encodeURIComponent(activeIncident.id)}/video-analyses`,
          {
            method: 'POST',
            body: JSON.stringify({
              fileName: filename,
              fileSizeBytes: uploadedVideoFile.size,
              mimeType: uploadedVideoFile.type || `video/${uploadedVideoFile.name.split('.').pop()?.toLowerCase()}`,
              durationSeconds,
            }),
          },
        )
        analysisId = queued.id
        setLatestVideoAnalysis(queued)
        const processing = await apiRequest<VideoAnalysis>(
          `/api/incidents/${encodeURIComponent(activeIncident.id)}/video-analyses/${encodeURIComponent(queued.id)}`,
          { method: 'PATCH', body: JSON.stringify({ status: 'processing' }) },
        )
        setLatestVideoAnalysis(processing)
        setPoseStatus('processing')
      }, setPoseProgress)
      const completed = await apiRequest<VideoAnalysis>(
        `/api/incidents/${encodeURIComponent(activeIncident.id)}/video-analyses/${encodeURIComponent(analysisId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ status: 'completed', outputs: result.frames }),
        },
      )
      setLatestVideoAnalysis(completed)
      setPoseStatus('completed')
      setPoseProgress(completed.framesProcessed)
      setToast(`MediaPipe analyzed ${completed.framesProcessed} sampled frames on this device.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Video analysis failed.'
      let displayedMessage = message
      if (analysisId) {
        try {
          const failed = await apiRequest<VideoAnalysis>(
            `/api/incidents/${encodeURIComponent(activeIncident.id)}/video-analyses/${encodeURIComponent(analysisId)}`,
            {
              method: 'PATCH',
              body: JSON.stringify({ status: 'failed', error: message.slice(0, 500) }),
            },
          )
          setLatestVideoAnalysis(failed)
        } catch (persistError) {
          const persistMessage = persistError instanceof Error ? persistError.message : 'Could not persist the failure status.'
          displayedMessage = `${message} Also, the failure status could not be saved: ${persistMessage}`
        }
      }
      setPoseError(displayedMessage)
      setPoseStatus('failed')
      setToast(displayedMessage)
    } finally {
      processingVideoRef.current = false
    }
  }

  const reviewIncident = async () => {
    if (!activeIncident.id) return
    setAnalysisState('reviewing')
    try {
      const assessment = await apiRequest<Assessment>(`/api/incidents/${encodeURIComponent(activeIncident.id)}/assessments`, {
        method: 'POST',
        body: JSON.stringify({ reportedSignals, reportedCauses, reportedInjuryPatterns }),
      })
      setLatestAssessment(assessment)
      setAnalysisState('ready')
      setToast('Structured review saved to the local database.')
    } catch (error) {
      setAnalysisState('idle')
      setToast(error instanceof Error ? error.message : 'Could not save the review.')
    }
  }

  const downloadReport = async () => {
    if (!activeIncident.id) return
    setDownloadingReport(true)
    try {
      const report = await apiRequest<Record<string, unknown>>(`/api/incidents/${encodeURIComponent(activeIncident.id)}/report`)
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = `${activeIncident.id.toLowerCase()}-incident-report.json`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
      setToast('Incident report downloaded from the local database.')
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not create the report.')
    } finally {
      setDownloadingReport(false)
    }
  }

  const toggleIncidentStatus = async () => {
    if (!activeIncident.id || updatingStatus) return
    const status = activeIncident.status === 'open' ? 'closed' : 'open'
    setUpdatingStatus(true)
    try {
      const updated = await apiRequest<Incident>(`/api/incidents/${encodeURIComponent(activeIncident.id)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      })
      setIncidents((current) => current.map((incident) => incident.id === updated.id ? updated : incident))
      setToast(`Incident ${updated.id} marked ${status}.`)
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not update incident status.')
    } finally {
      setUpdatingStatus(false)
    }
  }

  const selectIncident = (incident: Incident) => {
    if (incident.id === activeIncidentId) return
    if (processingVideoRef.current) {
      setToast('Wait for the current on-device video analysis to finish before switching incidents.')
      return
    }
    setActiveIncidentId(incident.id)
    setLatestAssessment(null)
    setReportedSignals([])
    setReportedCauses([])
    setReportedInjuryPatterns([])
    setAnalysisState('idle')
    setLatestVideoAnalysis(null)
    setPoseStatus('idle')
    setPoseProgress(0)
    setPoseError('')
    setVideoUrl('')
    setVideoName('')
    setUploadedVideoFile(null)
    setVideoDurationSeconds(null)
  }

  const createIncident = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (creatingIncident) return
    setCreatingIncident(true)
    try {
      const incident = await apiRequest<Incident>('/api/incidents', {
        method: 'POST',
        body: JSON.stringify({
          ...newIncident,
          people: Number(newIncident.people),
        }),
      })
      setIncidents((current) => [incident, ...current])
      setLatestAssessment(null)
      setReportedSignals([])
      setReportedCauses([])
      setReportedInjuryPatterns([])
      setActiveIncidentId(incident.id)
      setIncidentStatusFilter('all')
      setShowCreate(false)
      setNewIncident(emptyIncidentForm)
      setToast(`Incident ${incident.id} saved to SQLite.`)
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not save the incident.')
    } finally {
      setCreatingIncident(false)
    }
  }

  const toggleSignal = (signalId: string) => {
    setReportedSignals((current) => current.includes(signalId)
      ? current.filter((id) => id !== signalId)
      : [...current, signalId])
  }

  const navTo = (label: string) => {
    setActiveNav(label)
    setMobileMenuOpen(false)
    const targets: Record<string, string> = {
      Overview: 'overview',
      Incidents: 'incidents',
      'Camera feeds': 'camera-feed',
      'Response plans': 'response-plan',
      Reports: 'incident-report',
    }
    document.getElementById(targets[label])?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const showCameraVideo = feedSource === 'camera' && cameraFeed?.configured === true
  const showUploadedVideo = feedSource === 'upload' && Boolean(videoUrl)
  const displayedVideo = showCameraVideo || showUploadedVideo
  const openCameraDialog = () => {
    setCameraAuthorizationConfirmed(false)
    setShowConnect(true)
  }
  const connectCamera = async () => {
    if (!cameraAuthorizationConfirmed || checkingCameraGateway) return
    setCameraAuthorizationConfirmed(false)
    setShowConnect(false)
    setCameraState('connecting')
    setCameraError('')
    setCheckingCameraGateway(true)
    try {
      const status = await apiRequest<CameraFeedConfig>('/api/camera-feed/status')
      setCameraFeed(status)
      if (status.connectionStatus !== 'available') {
        throw new Error(status.message ?? 'The configured CCTV gateway is unavailable.')
      }
      setFeedSource('camera')
    } catch (error) {
      setFeedSource('camera')
      setCameraState('error')
      setCameraError(error instanceof Error ? error.message : 'The configured CCTV gateway is unavailable.')
    } finally {
      setCheckingCameraGateway(false)
    }
  }

  return (
    <div className="app-shell" id="overview">
      <aside className={`sidebar ${mobileMenuOpen ? 'sidebar-open' : ''}`}>
        <a className="brand" href="#overview" onClick={() => navTo('Overview')} aria-label="ResQ home">
          <span className="brand-mark"><Crosshair size={22} strokeWidth={2.4} /></span>
          <span className="brand-name">resq<span>.</span><small>INCIDENT COMMAND</small></span>
        </a>
        <div className="workspace-picker">
          <span className="workspace-avatar">MC</span>
          <span className="workspace-label"><strong>Metro Command</strong><small>Operations workspace</small></span>
          <ChevronDown size={15} />
        </div>

        <span className="nav-caption">WORKSPACE</span>
        <nav className="primary-nav" aria-label="Main navigation">
          {navItems.map(({ label, icon: Icon }) => (
            <button key={label} className={`nav-item ${activeNav === label ? 'nav-active' : ''}`} onClick={() => navTo(label)}>
              <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
              {label === 'Incidents' && <span className="nav-count">{incidents.filter((incident) => incident.status === 'open').length}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="system-health"><span className={`health-dot health-dot-${apiState}`} /><div><strong>{apiState === 'online' ? 'Local API operational' : apiState === 'offline' ? 'Local API unavailable' : 'Checking local API'}</strong><small>{apiState === 'online' ? 'SQLite connected' : apiState === 'offline' ? 'Review connection status' : 'Connecting…'}</small></div></div>
          <div className="profile-row"><span className="profile-avatar">AR</span><span><strong>Alex Rivera</strong><small>Incident coordinator</small></span><Menu size={16} /></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu" title="Open navigation" aria-label="Open navigation" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}><Menu size={19} /></button>
          <div className="breadcrumb">Operations <span>/</span> <strong>{activeNav}</strong></div>
          <div className="topbar-actions">
            <div className="search-box"><Search size={15} /><input aria-label="Search incidents" placeholder="Search incidents" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} /></div>
            <button className="icon-button notification-button" aria-label="Notifications" onClick={() => setToast('No new notifications.') }><Bell size={18} /><i /></button>
            <span className="topbar-divider" />
            <div className="topbar-date"><span>{currentTime.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: '2-digit' }).toUpperCase()}</span><strong>{currentTime.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} <span>LOCAL</span></strong></div>
          </div>
        </header>

        <div className="content-wrap">
          <section className="page-heading">
            <div><div className="eyebrow"><span className="live-dot" /> COMMAND CENTER <span className="eyebrow-divider">/</span> LIVE EXERCISE DATA</div><h1>Incident overview</h1><p>Situational awareness for coordinated, human-led response.</p></div>
            <div className="heading-actions"><button className="button button-outline" title="Create incident" aria-label="Create incident" onClick={() => setShowCreate(true)}><Plus size={16} /> New incident</button><button className="button button-outline" title="Camera integration guidance" aria-label="Camera integration guidance" onClick={openCameraDialog}><Radio size={16} /> Connect a camera</button></div>
          </section>

          {apiError && <section className="notice-banner api-error" role="alert"><AlertTriangle size={17} /><p><strong>Local database unavailable.</strong> {apiError} Start the app with <code>npm run dev</code>.</p></section>}

          <section className="notice-banner" aria-label="Prototype limitations">
            <AlertTriangle size={17} /><p><strong>Decision-support prototype.</strong> People counts and responder-entered signs are unverified. Not for diagnosis or dispatch without human confirmation.</p><button aria-label="Dismiss notice" onClick={(event) => event.currentTarget.parentElement?.remove()}><X size={15} /></button>
          </section>

          <section className="metric-grid" aria-label="Incident summary">
            <article className="metric-card metric-alert"><div className="metric-top"><span>ACTIVE INCIDENTS</span><span className="metric-icon"><Siren size={17} /></span></div><div className="metric-value">{incidents.filter((incident) => incident.status === 'open').length.toString().padStart(2, '0')} <span className="metric-change">in local database</span></div><div className="metric-foot"><span className="metric-line"><i style={{ width: `${Math.min(100, incidents.length * 18)}%` }} /></span><span>{incidents.length} total records</span></div></article>
            <article className="metric-card"><div className="metric-top"><span>PEOPLE REPORTED</span><span className="metric-icon metric-blue"><Users size={17} /></span></div><div className="metric-value">{incidents.reduce((total, incident) => total + incident.people, 0).toString().padStart(2, '0')} <span className="metric-estimate">unverified</span></div><div className="metric-foot"><span className="metric-foot-icon"><MapPin size={13} /></span><span>Confirm on scene</span></div></article>
            <article className="metric-card"><div className="metric-top"><span>RESPONSE TEAMS</span><span className="metric-icon metric-green"><HeartPulse size={17} /></span></div><div className="metric-value">— <span className="metric-estimate">not tracked</span></div><div className="metric-foot"><span className="offline-dot" /><span>No team records configured</span></div></article>
            <article className="metric-card"><div className="metric-top"><span>CAMERA SOURCES</span><span className="metric-icon metric-sand"><Camera size={17} /></span></div><div className="metric-value">{cameraFeed?.configured ? '01' : '00'} <span className="metric-estimate">configured</span></div><div className="metric-foot"><span className={cameraState === 'live' ? 'status-check' : 'offline-dot'} />{cameraState === 'live' ? 'Read-only HLS preview playing' : cameraState === 'ready' ? 'Stream ready · playback not started' : cameraState === 'error' ? 'Gateway unavailable' : cameraFeed?.configured ? cameraFeed.connectionStatus === 'available' ? 'Gateway playlist verified' : 'Gateway not tested' : cameraFeed?.configurationError ? 'Gateway configuration invalid' : 'Gateway not configured'}</div></article>
          </section>

          <section className="workspace-grid">
            <div className="primary-column">
              <section className="panel feed-panel" id="camera-feed">
                <div className="panel-heading feed-heading"><div><div className="panel-kicker">SCENE REVIEW <span className="sample-chip">{showCameraVideo ? 'READ ONLY' : 'SAMPLE'}</span></div><h2>{showCameraVideo ? cameraFeed?.sourceName : showUploadedVideo ? videoName : activeIncident.title}</h2><p><MapPin size={13} /> {activeIncident.location}</p></div><button className="more-button" aria-label="Camera connection and authorization" onClick={openCameraDialog}>•••</button></div>
                <div className={`video-stage ${feedMode === 'Thermal' ? 'thermal-stage' : ''}`}>
                  {displayedVideo ? <video ref={videoPreviewRef} src={showUploadedVideo ? videoUrl : undefined} controls autoPlay={showCameraVideo} muted={showCameraVideo} playsInline aria-label={showCameraVideo ? 'Authorized read-only CCTV HLS preview' : 'Uploaded incident video preview'} onTimeUpdate={(event) => setPreviewTimeSeconds(event.currentTarget.currentTime)} /> : <div className="scene-image" role="img" aria-label="Illustrative street camera still"><div className="scene-shade" /><div className="camera-stamp"><span><i /> RESQ · PREVIEW</span><strong>—</strong><small>DEMO STILL · NOT A LIVE FEED</small></div><div className="scene-crosshair"><span /><i /></div><div className="scene-caption"><span>EXERCISE SCENARIO</span><strong>{activeIncident.title}</strong></div></div>}
                  {showUploadedVideo && poseStatus === 'completed' && <canvas ref={poseOverlayRef} className="pose-overlay" aria-label="Locally inferred pose landmarks at sampled frames" />}
                  {showCameraVideo && cameraState === 'connecting' && <div className="camera-stream-message" role="status">Connecting to the authorized read-only feed…</div>}
                  {showCameraVideo && cameraState === 'ready' && <div className="camera-stream-message" role="status">Stream ready. Waiting for playback…</div>}
                  {showCameraVideo && cameraState === 'error' && <div className="camera-stream-message camera-stream-error" role="alert">{cameraError}</div>}
                  <div className="feed-badges"><span className="feed-state"><i /> {showCameraVideo ? cameraState === 'live' ? 'LIVE PREVIEW' : cameraState === 'ready' ? 'STREAM READY' : cameraState === 'error' ? 'STREAM ERROR' : 'CONNECTING' : showUploadedVideo ? 'LOCAL PREVIEW' : 'DEMO FEED'}</span><span className="feed-quality">{showCameraVideo ? 'READ ONLY' : 'NO SIGNAL'}</span></div>
                  {feedMode === 'Thermal' && <div className="thermal-note"><Thermometer size={15} /> Thermal overlay preview only · no thermal sensor connected</div>}
                </div>
                <div className="feed-controls"><div className="segmented-control" role="group" aria-label="Camera display mode"><button className={feedMode === 'Visible' ? 'selected' : ''} onClick={() => setFeedMode('Visible')}><Video size={14} /> Visible</button><button className="thermal-toggle" aria-pressed={feedMode === 'Thermal'} title="Visual demonstration only; no thermal sensor is connected." onClick={() => setFeedMode(feedMode === 'Thermal' ? 'Visible' : 'Thermal')}><Thermometer size={14} /> Thermal demo</button></div><span className="feed-meta">{showCameraVideo ? cameraState === 'live' ? `${cameraFeed?.sourceName} · read-only HLS playing` : cameraState === 'ready' ? 'Stream ready · waiting for playback' : cameraState === 'error' ? cameraError : 'Checking the configured gateway…' : showUploadedVideo ? `${videoName}${videoDurationSeconds ? ` · ${videoDurationSeconds.toFixed(1)} sec` : ''}` : 'No camera connected · source unavailable'}</span>{cameraFeed?.configured && <button className="button button-quiet" onClick={openCameraDialog}><Camera size={14} /> {showCameraVideo ? 'Camera access' : 'Connect camera'}</button>}<button className="button button-quiet" onClick={() => uploadRef.current?.click()} disabled={poseStatus === 'queued' || poseStatus === 'processing'}><CloudUpload size={15} /> Upload video</button><input ref={uploadRef} type="file" accept="video/mp4,video/webm,.mp4,.webm" hidden onChange={(event) => { handleUpload(event.target.files?.[0]); event.currentTarget.value = '' }} /></div>
                {showCameraVideo && <div className="camera-review-prompt"><p><strong>Operator review required.</strong> This read-only view does not identify people, assess injuries, or trigger alarms. Record only observations confirmed by an authorized responder.</p><button className="button button-outline" onClick={() => document.getElementById('responder-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Open responder review</button></div>}
                {!showCameraVideo && <>
                <div className="pose-analysis-controls">
                  <div><strong>On-device pose landmarks</strong><small>Computer-vision measurements where supported. Pose estimates are not injury diagnoses.</small></div>
                  <button className="button button-primary" onClick={analyzeUploadedVideo} disabled={!uploadedVideoFile || !activeIncident.id || poseStatus === 'queued' || poseStatus === 'processing'}>
                    <Activity size={15} /> {poseStatus === 'queued' ? 'Queued…' : poseStatus === 'processing' ? `Analyzing ${poseProgress}/${POSE_SAMPLE_COUNT}` : poseStatus === 'completed' ? 'Analyze again' : 'Analyze on device'}
                  </button>
                </div>
                {(poseStatus === 'queued' || poseStatus === 'processing') && <div className="pose-progress" role="status">{poseStatus === 'queued' ? 'Checking video metadata…' : `Processing sample ${Math.min(POSE_SAMPLE_COUNT, poseProgress + 1)} of ${POSE_SAMPLE_COUNT}…`} This can take a while on slower devices.</div>}
                {poseStatus === 'idle' && !latestVideoAnalysis && <div className="pose-model-setup"><strong>{POSE_MODEL_NAME}</strong><span>Model: {POSE_MODEL_VERSION}</span><span>Up to {MAX_VIDEO_DURATION_SECONDS / 60} minutes and {MAX_VIDEO_BYTES / 1024 / 1024} MB per video; exactly {POSE_SAMPLE_COUNT} frames are sampled.</span><span>Required local artifact: {POSE_MODEL_ASSET}. Run <code>.\scripts\download-pose-model.ps1</code> before processing. The pinned MediaPipe WebAssembly runtime loads from jsDelivr; video frames are not sent there.</span></div>}
                {poseError && <div className="pose-error" role="alert"><strong>Pose analysis failed.</strong> {poseError} Install the model with <code>.\scripts\download-pose-model.ps1</code>.</div>}
                {latestVideoAnalysis && <section className={`pose-result pose-result-${latestVideoAnalysis.status}`} aria-live="polite">
                  <div className="pose-result-heading"><strong>Saved video analysis</strong><span>{latestVideoAnalysis.status.toUpperCase()}</span></div>
                  <p>{latestVideoAnalysis.modelName} · {latestVideoAnalysis.modelVersion} · {latestVideoAnalysis.framesProcessed}/{POSE_SAMPLE_COUNT} sampled frames analyzed · {latestVideoAnalysis.framesWithPose} with a pose detected</p>
                  <p>Model source: <a href={latestVideoAnalysis.modelSourceUrl} target="_blank" rel="noreferrer">MediaPipe Pose Landmarker</a>. {latestVideoAnalysis.datasetTrainingProvenance}</p>
                  {latestVideoAnalysis.measurements && <div className="pose-measurements">
                    <span>Mean landmark visibility <strong>{latestVideoAnalysis.measurements.averageLandmarkVisibility === null ? 'not available' : `${(latestVideoAnalysis.measurements.averageLandmarkVisibility * 100).toFixed(1)}%`}</strong></span>
                    <span>Hip-center image displacement <strong>{latestVideoAnalysis.measurements.hipCenterDisplacementPerSecond === null ? 'not available' : `${latestVideoAnalysis.measurements.hipCenterDisplacementPerSecond.toFixed(3)} normalized image-coordinate units/sec`}</strong></span>
                  </div>}
                  {latestVideoAnalysis.status === 'completed' && <div className="pose-frame-list"><strong>Sample results</strong>{latestVideoAnalysis.outputs.map((frame, index) => <span key={`${frame.timestampSeconds}-${index}`}>{frame.timestampSeconds.toFixed(1)}s · {frame.landmarks.length ? `${frame.landmarks.length} landmarks` : 'no pose detected'}</span>)}</div>}
                </section>}
                </>}
                <div className="feed-disclaimer"><AlertTriangle size={14} /><span>{showCameraVideo ? 'Authorized read-only camera preview only. Human responders must confirm and document events.' : 'Pose landmarks are estimates only. No injury detection, diagnosis, or cause inference is active.'}</span></div>
              </section>

              <section className="panel incident-panel" id="incidents">
                <div className="panel-heading list-heading"><div><div className="panel-kicker">RESPONSE QUEUE</div><h2>Incident records <span className="count-pill">{incidents.filter((incident) => incident.status === 'open').length} open</span></h2></div><button className="text-button" onClick={() => { setIncidentStatusFilter('all'); navTo('Incidents') }}>View all <ArrowUpRight size={14} /></button></div>
                <div className="incident-filters" role="group" aria-label="Filter incidents by status">
                  {(['all', 'open', 'closed'] as const).map((status) => <button
                    key={status}
                    type="button"
                    className={incidentStatusFilter === status ? 'incident-filter-selected' : ''}
                    aria-pressed={incidentStatusFilter === status}
                    onClick={() => setIncidentStatusFilter(status)}
                  >{status === 'all' ? 'All' : status === 'open' ? 'Open' : 'Closed'} <span>{status === 'all' ? incidents.length : incidents.filter((incident) => incident.status === status).length}</span></button>)}
                </div>
                <div className="incident-list">
                  {visibleIncidents.map((incident) => <button key={incident.id} className={`incident-row ${activeIncident.id === incident.id ? 'incident-selected' : ''}`} onClick={() => selectIncident(incident)}>
                    <span className={`priority-mark priority-${incident.priority.toLowerCase()}`} />
                    <span className="incident-main"><strong>{incident.title}</strong><small><MapPin size={12} /> {incident.location}</small></span>
                    <span className="incident-time"><strong>{incident.time}</strong><small>{incident.people} people · unverified</small></span>
                    <span className={`priority-tag tag-${incident.priority.toLowerCase()}`}>{incident.priority}</span>
                    <span className={`incident-status incident-status-${incident.status}`}>{incident.status}</span>
                    <ChevronDown className="row-chevron" size={15} />
                  </button>)}
                  {!visibleIncidents.length && <p className="empty-state">{searchQuery ? `No incidents match “${searchQuery}”.` : 'No incidents in this status filter.'}</p>}
                </div>
              </section>
            </div>

            <aside className="secondary-column">
              <section className="panel triage-panel" id="responder-review" tabIndex={-1}>
                <div className="panel-heading triage-heading"><div><div className="panel-kicker">FIELD REVIEW</div><h2>Incident triage</h2></div><span className="unverified-badge"><span /> UNVERIFIED</span></div>
                <div className="triage-body">
                  <div className="triage-status"><span className={`triage-symbol ${analysisState === 'ready' && !hasUnsavedReviewChanges ? 'triage-ready' : ''}`}>{analysisState === 'ready' && !hasUnsavedReviewChanges ? <Check size={19} /> : <HeartPulse size={19} />}</span><div><strong>{analysisState === 'reviewing' ? 'Saving review…' : hasUnsavedReviewChanges ? 'Unsaved responder changes' : analysisState === 'ready' ? 'Rule review saved' : 'Human review required'}</strong><small>{hasUnsavedReviewChanges ? 'Current entries differ from the saved review' : analysisState === 'ready' ? 'Responder-entered · not a diagnosis' : 'No clinical assessment available'}</small></div></div>
                  <div className="triage-observation"><span className="observation-icon"><Users size={16} /></span><div><strong>Possible people in scene</strong><p>{activeIncident.people} reported · verify visually and in person</p></div><span className="observation-label">UNCONFIRMED</span></div>
                  <div className="triage-observation"><span className="observation-icon observation-orange"><Activity size={16} /></span><div><strong>Injury status</strong><p>No injury is inferred. Record only signs confirmed by a responder.</p></div></div>
                  <fieldset className="signal-fieldset"><legend>Responder-reported warning signs</legend><div className="signal-list">{signals.map((signal) => <label className="signal-option" key={signal.id}><input type="checkbox" checked={reportedSignals.includes(signal.id)} onChange={() => toggleSignal(signal.id)} /><span><strong>{signal.label}</strong><small>{signal.group} · {signal.note}</small></span><em className={signal.urgency === 'urgent' ? 'signal-urgent' : ''}>{signal.urgency === 'urgent' ? 'ESCALATE' : 'REVIEW'}</em></label>)}</div></fieldset>
                  <fieldset className="signal-fieldset"><legend>Responder-reported incident context · not causal attribution</legend><div className="signal-list">{causes.map((cause) => <label className="signal-option" key={cause.id}><input type="checkbox" checked={reportedCauses.includes(cause.id)} onChange={() => toggleReportedCategory(cause.id, reportedCauses, setReportedCauses)} /><span><strong>{cause.label}</strong><small>{cause.group} · {cause.note}</small></span></label>)}</div></fieldset>
                  <fieldset className="signal-fieldset"><legend>Responder-reported injury observations · not diagnoses</legend><div className="signal-list">{injuryPatterns.map((pattern) => <label className="signal-option" key={pattern.id}><input type="checkbox" checked={reportedInjuryPatterns.includes(pattern.id)} onChange={() => toggleReportedCategory(pattern.id, reportedInjuryPatterns, setReportedInjuryPatterns)} /><span><strong>{pattern.label}</strong><small>{pattern.group} · {pattern.note}</small></span></label>)}</div></fieldset>
                  {latestAssessment && <div className={`assessment-result ${latestAssessment.result.status === 'urgent-human-review' ? 'assessment-urgent' : ''}`} role="status"><strong>{hasUnsavedReviewChanges ? 'Last saved review · selections have changed' : latestAssessment.result.status === 'urgent-human-review' ? 'Urgent human review prompted' : 'Human review required'}</strong><p>{latestAssessment.result.summary}</p><small>{latestAssessment.result.limitations}</small></div>}
                  {latestAssessment && <div className="recorded-context"><strong>{hasUnsavedReviewChanges ? 'Last saved responder entries' : 'Saved responder entries'}</strong><p><span>Context:</span> {latestAssessment.reportedCauses.map((id) => causes.find((cause) => cause.id === id)?.label ?? id).join(', ') || 'None selected'}</p><p><span>Injury observations:</span> {latestAssessment.reportedInjuryPatterns.map((id) => injuryPatterns.find((pattern) => pattern.id === id)?.label ?? id).join(', ') || 'None selected'}</p></div>}
                  <div className="triage-callout"><Siren size={15} /><p><strong>For an active emergency</strong> contact local emergency services. Follow dispatcher guidance and responder protocols.</p></div>
                  <button className="button button-primary review-button" onClick={reviewIncident} disabled={analysisState === 'reviewing' || !activeIncident.id}><Crosshair size={15} /> {analysisState === 'reviewing' ? 'Saving review…' : hasUnsavedReviewChanges && latestAssessment ? 'Save updated review' : 'Save structured review'}</button>
                  <p className="triage-footnote">Rule matching only. It does not analyze video, identify injuries, or replace clinical judgment.</p>
                </div>
              </section>

              <section className="panel response-panel" id="response-plan">
                <div className="panel-heading response-heading"><div><div className="panel-kicker">COORDINATION NOTES</div><h2>Response planning</h2></div><span className="sample-chip">SAMPLE</span></div>
                <div className="response-stats"><div><span>PEOPLE REPORTED</span><strong>{activeIncident.people.toString().padStart(2, '0')}<small>unverified</small></strong></div><div><span>MECHANISM REPORTED</span><strong className="mechanism-value">{mechanisms.find((mechanism) => mechanism.id === activeIncident.mechanism_id)?.label ?? 'Unknown'}<small>unverified</small></strong></div></div>
                <div className="plan-list"><div className="plan-row"><span className="plan-icon plan-blue"><Users size={15} /></span><span><strong>Personnel</strong><small>Coordinate EMS and search lead</small></span><span className="plan-dash">—</span></div><div className="plan-row"><span className="plan-icon plan-orange"><Flame size={15} /></span><span><strong>Scene safety</strong><small>Confirm hazards before entry</small></span><span className="plan-dash">—</span></div><div className="plan-row"><span className="plan-icon plan-green"><Crosshair size={15} /></span><span><strong>Supplies</strong><small>Check radio, PPE, first aid kits</small></span><span className="plan-dash">—</span></div></div>
                <div className="plan-note"><AlertTriangle size={14} /><span>Planning prompts only. Incident commander confirms staffing, supplies, and access.</span></div>
              </section>

              <section className="panel report-panel" id="incident-report">
                <div className="panel-heading report-heading"><div><div className="panel-kicker">DOCUMENTATION</div><h2>Incident report</h2></div><FileText size={18} /></div>
                <p>Build a shareable draft with incident details and verification notes. No diagnosis, medication, diet, or recovery-time predictions.</p>
                <div className="report-actions"><button className="button button-outline report-button" onClick={downloadReport} disabled={!activeIncident.id || downloadingReport}><ArrowDownToLine size={15} /> {downloadingReport ? 'Preparing report…' : 'Download incident report'}</button><button className="button button-quiet status-button" onClick={toggleIncidentStatus} disabled={!activeIncident.id || updatingStatus}>{updatingStatus ? 'Saving…' : activeIncident.status === 'open' ? 'Close incident' : 'Reopen incident'}</button></div>
              </section>
            </aside>
          </section>

          <footer className="page-footer"><span><Clock3 size={13} /> Data shown is for demonstration · Last updated {currentTime.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span><span>RESQ PROTOTYPE <i /> HUMAN REVIEW REQUIRED</span></footer>
        </div>
      </main>

      {showCreate && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !creatingIncident) setShowCreate(false) }}><section className="connect-modal create-modal" role="dialog" aria-modal="true" aria-labelledby="create-title"><button className="modal-close icon-button" aria-label="Close dialog" onClick={() => setShowCreate(false)} disabled={creatingIncident}><X size={18} /></button><span className="modal-icon"><Plus size={21} /></span><div className="panel-kicker">LOCAL INCIDENT RECORD</div><h2 id="create-title">Create incident</h2><p>Stored in the local SQLite database. Counts and reported signs remain unverified until a responder confirms them.</p><form className="create-form" onSubmit={createIncident}><label>Incident title<input required maxLength={120} value={newIncident.title} onChange={(event) => setNewIncident({ ...newIncident, title: event.target.value })} /></label><label>Location<input required maxLength={160} value={newIncident.location} onChange={(event) => setNewIncident({ ...newIncident, location: event.target.value })} /></label><div className="form-columns"><label>Mechanism<select value={newIncident.mechanismId} onChange={(event) => setNewIncident({ ...newIncident, mechanismId: event.target.value })}>{mechanisms.map((mechanism) => <option key={mechanism.id} value={mechanism.id}>{mechanism.label}</option>)}</select></label><label>Priority<select value={newIncident.priority} onChange={(event) => setNewIncident({ ...newIncident, priority: event.target.value as Incident['priority'] })}><option>Monitoring</option><option>Elevated</option><option>High</option></select></label></div><div className="form-columns"><label>People reported<input type="number" min="0" max="10000" step="1" value={newIncident.people} onChange={(event) => setNewIncident({ ...newIncident, people: event.target.value })} /></label><label>Coordinator note<input maxLength={500} value={newIncident.note} onChange={(event) => setNewIncident({ ...newIncident, note: event.target.value })} /></label></div><div className="create-actions"><button type="button" className="button button-quiet" onClick={() => setShowCreate(false)} disabled={creatingIncident}>Cancel</button><button type="submit" className="button button-primary" disabled={creatingIncident}><Check size={15} /> {creatingIncident ? 'Saving…' : 'Save incident'}</button></div></form></section></div>}
      {showConnect && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowConnect(false) }}><section className="connect-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title"><button className="modal-close icon-button" aria-label="Close dialog" onClick={() => setShowConnect(false)}><X size={18} /></button><span className="modal-icon"><Radio size={21} /></span><div className="panel-kicker">AUTHORIZED CAMERA INTEGRATION</div><h2 id="connect-title">Read-only camera preview</h2><p>Connect only to a camera you are authorized to view. ResQ plays a configured HLS gateway stream; it cannot control cameras, activate alarms, or automatically identify people or assess injuries.</p>{cameraFeed?.configured ? <div className="camera-configured"><strong>{cameraFeed.sourceName}</strong><span>Gateway status: {cameraFeed.connectionStatus} · playback only</span></div> : <div className={`camera-configured ${cameraFeed?.configurationError ? 'camera-config-error' : ''}`}><strong>{cameraFeed?.message ?? 'CCTV gateway not configured. Configure an authorized gateway to enable live-stream integration.'}</strong><span>Set RESQ_CAMERA_HLS_URL to an authorized .m3u8 stream and restart the local API. Do not put credentials or access tokens in the URL.</span></div>}<div className="integration-steps"><div><span>01</span><p><strong>Bridge CCTV through a gateway</strong><small>For RTSP cameras, configure an authorized HLS gateway such as MediaMTX. Keep camera credentials on the gateway; use HTTPS and restricted, read-only access.</small></p></div><div><span>02</span><p><strong>Configure ResQ</strong><small>Set RESQ_CAMERA_HLS_URL to the gateway's credential-free .m3u8 playlist URL; optionally set RESQ_CAMERA_LABEL, RESQ_CAMERA_GATEWAY_ID, and RESQ_CAMERA_STREAM_ID. Restart ResQ and verify the gateway before previewing.</small></p></div><div><span>03</span><p><strong>Review and report manually</strong><small>Use the incident review panel to save responder-confirmed observations. The live stream is not analyzed, recorded, or used to trigger actions.</small></p></div></div>{cameraFeed?.configured && <label className="camera-authorization"><input type="checkbox" checked={cameraAuthorizationConfirmed} onChange={(event) => setCameraAuthorizationConfirmed(event.currentTarget.checked)} /><span>I confirm I am authorized to view this camera and have a legitimate operational purpose.</span></label>}<div className="create-actions"><button className="button button-quiet" onClick={() => { setShowConnect(false); if (feedSource === 'camera') { setFeedSource('demo'); setCameraState('disconnected') } }}>{feedSource === 'camera' ? 'Disconnect preview' : 'Close'}</button>{cameraFeed?.configured && <button className="button button-primary" disabled={!cameraAuthorizationConfirmed || checkingCameraGateway} onClick={() => void connectCamera()}><Camera size={15} /> {checkingCameraGateway ? 'Checking gateway…' : 'Check and connect'}</button>}</div></section></div>}
      {toast && <div className="toast" role="status"><Check size={15} />{toast}<button aria-label="Dismiss message" onClick={() => setToast('')}><X size={14} /></button></div>}
    </div>
  )
}

export default App
