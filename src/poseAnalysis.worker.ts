const MODEL_NAME = 'MediaPipe Pose Landmarker Lite'
const MODEL_VERSION = 'float16 (artifact SHA256 59929e1d…690d574a)'
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm'
const TASKS_VISION_BUNDLE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/vision_bundle.js'
type PoseLandmark = {
  x: number
  y: number
  z: number
  visibility?: number
  presence?: number
}
type PoseFrame = {
  timestampSeconds: number
  width: number
  height: number
  landmarks: Array<{ x: number; y: number; z: number; visibility: number; presence: number | null }>
}
type PoseLandmarker = {
  detectForVideo(image: ImageBitmap, timestampMilliseconds: number): { landmarks: PoseLandmark[][] }
  close(): void
}
type MediaPipeRuntime = {
  FilesetResolver: { forVisionTasks(wasmBase: string): Promise<unknown> }
  PoseLandmarker: {
    createFromOptions(
      files: unknown,
      options: {
        baseOptions: { modelAssetPath: string; delegate?: 'GPU' }
        runningMode: 'VIDEO'
        numPoses: number
        minPoseDetectionConfidence: number
        minPosePresenceConfidence: number
        minTrackingConfidence: number
      },
    ): Promise<PoseLandmarker>
  }
}
type WorkerScope = typeof self & {
  importScripts: (...urls: string[]) => void
  Vision?: MediaPipeRuntime
}
const workerScope = self as WorkerScope
let landmarker: PoseLandmarker | undefined

type Request =
  | { id: number; type: 'initialize'; modelUrl: string }
  | { id: number; type: 'infer'; image: ImageBitmap; timestampSeconds: number }
  | { id: number; type: 'close' }

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    if (request.type === 'initialize') {
      workerScope.importScripts(TASKS_VISION_BUNDLE)
      const runtime = workerScope.Vision
      if (!runtime) throw new Error('The pinned MediaPipe worker runtime did not load.')
      const files = await runtime.FilesetResolver.forVisionTasks(WASM_BASE)
      const options = {
        baseOptions: { modelAssetPath: request.modelUrl },
        runningMode: 'VIDEO' as const,
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }
      try {
        landmarker = await runtime.PoseLandmarker.createFromOptions(files, {
          ...options,
          baseOptions: { ...options.baseOptions, delegate: 'GPU' },
        })
      } catch {
        landmarker = await runtime.PoseLandmarker.createFromOptions(files, options)
      }
      self.postMessage({ id: request.id, type: 'ready', modelName: MODEL_NAME, modelVersion: MODEL_VERSION })
      return
    }
    if (request.type === 'infer') {
      if (!landmarker) throw new Error('The pose model has not been initialized.')
      const result = landmarker.detectForVideo(request.image, request.timestampSeconds * 1000)
      const landmarks = result.landmarks[0]?.map((landmark) => ({
        x: landmark.x,
        y: landmark.y,
        z: landmark.z,
        visibility: landmark.visibility ?? 0,
        presence: landmark.presence ?? null,
      })) ?? []
      const frame: PoseFrame = {
        timestampSeconds: request.timestampSeconds,
        width: request.image.width,
        height: request.image.height,
        landmarks,
      }
      request.image.close()
      self.postMessage({ id: request.id, type: 'result', frame })
      return
    }
    landmarker?.close()
    landmarker = undefined
    self.close()
  } catch (error) {
    if (request.type === 'infer') request.image.close()
    self.postMessage({
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : 'Pose inference failed.',
    })
  }
}
