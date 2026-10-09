export type PoseLandmark = {
  x: number
  y: number
  z: number
  visibility: number
  presence: number | null
}

export type PoseFrame = {
  timestampSeconds: number
  width: number
  height: number
  landmarks: PoseLandmark[]
}

export type PoseProcessingStatus = 'queued' | 'processing' | 'completed' | 'failed'

export type VideoAnalysis = {
  id: string
  incidentId: string
  fileName: string
  fileSizeBytes: number
  mimeType: string
  durationSeconds: number
  status: PoseProcessingStatus
  modelName: string
  modelVersion: string
  modelAsset: string
  modelSourceUrl: string
  datasetTrainingProvenance: string
  framesProcessed: number
  framesWithPose: number
  outputs: PoseFrame[]
  measurements: {
    sampledFrameCount: number
    framesWithPose: number
    averageLandmarkVisibility: number | null
    hipCenterDisplacementPerSecond: number | null
  } | null
  error: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}
