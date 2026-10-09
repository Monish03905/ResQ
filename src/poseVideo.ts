import type { PoseFrame } from './poseAnalysisTypes'

export const MAX_VIDEO_BYTES = 100 * 1024 * 1024
export const MAX_VIDEO_DURATION_SECONDS = 300
export const POSE_SAMPLE_COUNT = 15
export const POSE_MODEL_NAME = 'MediaPipe Pose Landmarker Lite'
export const POSE_MODEL_VERSION = 'float16 (artifact SHA256 59929e1d…690d574a)'
export const POSE_MODEL_ASSET = 'pose_landmarker_lite.task'

type WorkerReply =
  | { id: number; type: 'ready'; modelName: string; modelVersion: string }
  | { id: number; type: 'result'; frame: PoseFrame }
  | { id: number; type: 'error'; message: string }

type WorkerRequest =
  | { id: number; type: 'initialize'; modelUrl: string }
  | { id: number; type: 'infer'; image: ImageBitmap; timestampSeconds: number }
  | { id: number; type: 'close' }

function waitForVideoEvent(video: HTMLVideoElement, eventName: 'loadedmetadata' | 'seeked'): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out while reading video ${eventName === 'seeked' ? 'frame' : 'metadata'}.`))
    }, 15_000)
    const cleanup = () => {
      window.clearTimeout(timeout)
      video.removeEventListener(eventName, handleSuccess)
      video.removeEventListener('error', handleError)
    }
    const handleSuccess = () => {
      cleanup()
      resolve()
    }
    const handleError = () => {
      cleanup()
      reject(new Error('The browser could not decode this video. Try an MP4 (H.264) or WebM file.'))
    }
    video.addEventListener(eventName, handleSuccess, { once: true })
    video.addEventListener('error', handleError, { once: true })
  })
}

function makeWorkerRequest(
  worker: Worker,
  request: WorkerRequest,
  expectedType: WorkerReply['type'],
): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.removeEventListener('message', onMessage)
      reject(new Error('Pose inference timed out. Try a shorter video or a device with WebAssembly support.'))
    }, 120_000)
    const onMessage = (event: MessageEvent<WorkerReply>) => {
      if (event.data.id !== request.id) return
      window.clearTimeout(timeout)
      worker.removeEventListener('message', onMessage)
      if (event.data.type === 'error') reject(new Error(event.data.message))
      else if (event.data.type !== expectedType) reject(new Error('The pose worker returned an unexpected response.'))
      else resolve(event.data)
    }
    worker.addEventListener('message', onMessage)
    worker.postMessage(request, request.type === 'infer' ? [request.image] : [])
  })
}

export async function processPoseVideo(
  file: File,
  onMetadata: (metadata: { durationSeconds: number; width: number; height: number }) => Promise<void>,
  onProgress: (processed: number) => void,
): Promise<{ durationSeconds: number; frames: PoseFrame[]; modelName: string; modelVersion: string }> {
  const fileUrl = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true
  video.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
  video.src = fileUrl
  document.body.append(video)

  const worker = new Worker(new URL('./poseAnalysis.worker.ts', import.meta.url))
  let workerRequestId = 0
  try {
    const metadataReady = waitForVideoEvent(video, 'loadedmetadata')
    video.load()
    await metadataReady
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.videoWidth <= 0 || video.videoHeight <= 0) {
      throw new Error('The selected video has invalid duration or dimensions.')
    }
    if (video.duration > MAX_VIDEO_DURATION_SECONDS) {
      throw new Error(`Videos must be ${MAX_VIDEO_DURATION_SECONDS / 60} minutes or shorter.`)
    }
    await onMetadata({ durationSeconds: video.duration, width: video.videoWidth, height: video.videoHeight })

    const basePath = import.meta.env.BASE_URL
    const modelUrl = `${basePath.endsWith('/') ? basePath : `${basePath}/`}models/${POSE_MODEL_ASSET}`
    const initialized = await makeWorkerRequest(worker, {
      id: workerRequestId++,
      type: 'initialize',
      modelUrl,
    }, 'ready')
    if (initialized.type !== 'ready') throw new Error('The pose model did not initialize.')

    const frames: PoseFrame[] = []
    for (let index = 0; index < POSE_SAMPLE_COUNT; index += 1) {
      const timestampSeconds = video.duration * ((index + 0.5) / POSE_SAMPLE_COUNT)
      if (Math.abs(video.currentTime - timestampSeconds) > 0.015) {
        const seeked = waitForVideoEvent(video, 'seeked')
        video.currentTime = timestampSeconds
        await seeked
      }
      const image = await createImageBitmap(video)
      const result = await makeWorkerRequest(worker, {
        id: workerRequestId++,
        type: 'infer',
        image,
        timestampSeconds,
      }, 'result')
      if (result.type !== 'result') throw new Error('The pose worker returned no frame result.')
      frames.push(result.frame)
      onProgress(frames.length)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    }
    return {
      durationSeconds: video.duration,
      frames,
      modelName: initialized.modelName,
      modelVersion: initialized.modelVersion,
    }
  } finally {
    worker.terminate()
    video.pause()
    video.removeAttribute('src')
    video.load()
    video.remove()
    URL.revokeObjectURL(fileUrl)
  }
}
