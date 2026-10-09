# Local pose-analysis workflow

## Purpose and boundaries

ResQ optionally runs the pretrained MediaPipe Pose Landmarker Lite model in the user's browser. It estimates one person's 33 pose landmarks in sampled video frames. This is a general pose-estimation task, not an injury or cause classifier. A missing pose is not evidence that a person is absent or uninjured. ResQ does not infer diagnoses, severity, identity, age, gender, emotion, or treatment.

The user-facing responsible-use notice is: “This prototype provides computer-vision measurements where supported. Pose estimates are not injury diagnoses. The system has not been validated for clinical decisions or emergency dispatch.”

The selected model artifact does not specify training-dataset provenance. The project therefore records that provenance as unspecified and does not claim the model was trained or validated on injury data. Movement/action datasets are not interchangeable with injury datasets. In particular, ResQ does not bundle or use Penn Action as injury labels.

## Setup and operation

1. Install dependencies with `npm install`.
2. Run `.\scripts\download-pose-model.ps1` from the project root. The script verifies the official MediaPipe model URL against the expected size and SHA-256 before installing it under `public/models/`.
3. Start the app with `npm run dev`, choose an incident, upload an MP4 or WebM (up to 100 MB and 300 seconds), and select **Analyze on device**.
4. ResQ samples exactly 15 frames, runs the model in a browser worker, reports progress/errors, and overlays landmarks at sampled timestamps in the preview.

The model file is not committed. The version-pinned MediaPipe worker bundle and WebAssembly runtime are loaded from jsDelivr at `@mediapipe/tasks-vision@1.1.0`; the model is served by the local app. The browser sends no video frames to either service. The API receives only metadata and the resulting pose landmarks.

## Persistence and report data

The local API creates a `video_analyses` row when processing starts and tracks `queued`, `processing`, `completed`, or `failed` status. The API validates the lifecycle and result shape, calculates mean landmark visibility and hip-center displacement, and associates the latest analysis with incident detail and JSON reports. Source video bytes are never uploaded or persisted by the API. Deleting an incident cascades to its analysis records. The API does not cryptographically attest that submitted landmarks came from the stated browser model.

The reported hip-center displacement is measured in normalized image-coordinate units per second. It is affected by framing, camera motion, occlusion, perspective, pose-estimation error, and sample spacing; it is not physical distance, fall detection, or an injury indicator. Landmark visibility is a model estimate, not clinical confidence.

## Troubleshooting and verification

- If the model is missing, rerun the download script and confirm that `public/models/pose_landmarker_lite.task` exists.
- If decoding fails, try a browser-supported MP4 (H.264) or WebM clip.
- If the browser cannot initialize WebAssembly or access the pinned runtime, the analysis reports a failure; no sample result is fabricated.
- Use only video you are authorized to process. Current limits are 100 MB, 5 minutes, and 15 sampled frames. Analysis is local, but the resulting metadata and landmarks persist in the local SQLite database and incident reports.

Run `npm test`, `npm run build`, and `npm run lint` to validate the project. To verify real inference, use an authorized test clip that visibly contains a person, confirm that one or more sampled frames contain 33 returned landmarks and that the overlay follows the sampled timestamps, then confirm the saved result appears after reloading the incident. A successful model load with zero detected poses is not a positive pose-detection test.

## Future dataset work

No training data is needed to run the pretrained pose model, and no new injury dataset is imported by this prototype. Before any future dataset is added, document its original source, license/permissions, consent and privacy basis, label definitions, representation, annotation quality, retention policy, and intended use. Do not relabel action/activity annotations as injuries or use observational datasets to validate clinical claims.
