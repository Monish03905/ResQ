# Runtime Validation Report

**Generated:** 2026-10-09
**Target:** `C:\Users\monis\OneDrive\Desktop\ResQ`

## Summary

| Step | Status | Exit code | Details |
|---|---|---:|---|
| Startup | PASS | n/a | `npm run dev -- --host 127.0.0.1` remains running; Vite ready on 5180, API ready on 4174, `/api/health` returned `status: ok`. |
| API integration | PASS | 0 | `npm test`; 6 tests passed, 0 failed, 0 skipped. |
| Lint | PASS | 0 | `npm run lint` (Oxlint). |
| Production build | PASS | 0 | `npm run build` (TypeScript and Vite). |
| Browser E2E | PASS | n/a | Editor browser workflow (no CLI exit code): production preview, no-camera guidance, authorized gateway check, proxied HLS playback and stopped-playback state. |

**Overall:** PASS for the tested local prototype flows. This is not a clinical, dispatch, production-security, or real-camera certification.

## Browser verification

Used the editor browser against the production build and an isolated local test API/gateway:

- Verified the no-source dialog displays: “CCTV gateway not configured. Configure an authorized gateway to enable live-stream integration.”
- Confirmed the operator authorization acknowledgement is required before connecting.
- Verified the API checks the configured HLS playlist before connecting; the browser then loads only same-origin `/api/camera-feed/...` URLs.
- Played a locally generated 320×240, four-second HLS test clip through the configured server proxy. Browser video reached `readyState: 4`; playback advanced, and the UI showed **LIVE PREVIEW** only while it was actually playing.
- Confirmed pause/end returns the UI to **STREAM READY**, rather than leaving a stale live indicator.
- No camera hardware, RTSP device, external gateway, or public internet HLS source was verified.

## API and security/privacy checks

- Integration tests cover incident/review/report persistence, additive database migration, rejected camera URL configuration, mocked-gateway authorization, playlist rewriting, nested playlist and segment delivery, unknown/expired token rejection, and cross-origin resource rejection.
- Camera configuration, health, and probe responses contain no upstream URL or authorization value. The configured authorization value is sent only to the fixed server-side gateway.
- Redirects are blocked; gateway requests have a timeout and bounded playlist/resource reads; resource references are constrained to the configured origin and use expiring opaque tokens.
- The camera remains read-only. ResQ does not trigger alarms, control devices, infer demographic or emotional traits, diagnose injuries, or automatically create incident findings.
- There is no application authentication, role-based authorization, or access audit trail. The operator checkbox is not access control; keep this local prototype off untrusted networks.

## Environment and known gaps

- Node.js **v22.20.0** is available. Startup emits Node's expected experimental `node:sqlite` warning; SQLite health checks and persistence tests passed. The warning is documented and intentionally not suppressed.
- Docker is unavailable (daemon not responding). This project uses local SQLite and a loopback HTTP mock gateway; no Docker-managed service is required by the tested flows.
- `npx playwright install chromium` completed successfully. Browser E2E was executed with the editor browser; no persistent Playwright test suite was added.
- No fresh model-inference run was part of this validation. Pose landmarks remain measurements, not injury findings. The system is not validated for clinical decisions or emergency dispatch.

## Bundle comparison

The lazy HLS player now uses `hls.js/light`. The HLS chunk decreased from the prior measured **574.41 kB minified / 178.97 kB gzip** to **359.07 kB minified / 114.22 kB gzip** (about **37.5%** smaller minified and **36.2%** smaller gzip). The HLS chunk remains lazy-loaded.
