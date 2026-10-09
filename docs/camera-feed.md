# Authorized read-only camera feed

## Supported connection

ResQ plays one operator-configured HLS (`.m3u8`) stream through a same-origin server proxy. It does not ingest RTSP itself. Bridge an authorized IP camera through a gateway such as [MediaMTX](https://mediamtx.org/docs/features/read), then configure the gateway playlist URL in the API environment. The browser receives only `/api/camera-feed/playlist` and opaque, short-lived resource paths; the configured gateway URL and optional authorization header remain server-side.

Example for a local PowerShell development session:

```powershell
$env:RESQ_CAMERA_HLS_URL = "https://gateway.example.test/front/index.m3u8"
$env:RESQ_CAMERA_LABEL = "Front entrance"
$env:RESQ_CAMERA_GATEWAY_ID = "building-west"
$env:RESQ_CAMERA_STREAM_ID = "front-entry"
# Optional gateway Authorization header value; keep it in a protected secret store.
$env:RESQ_CAMERA_AUTHORIZATION = "Bearer <secret>"
npm run dev
```

`RESQ_CAMERA_LABEL`, `RESQ_CAMERA_GATEWAY_ID`, and `RESQ_CAMERA_STREAM_ID` are optional display/metadata values. `RESQ_CAMERA_ENABLED=false` disables the source. Restart the API after changing settings. The URL must use HTTP or HTTPS, have a `.m3u8` path, and contain no username, password, query string, or fragment. Do not put credentials in the URL. `RESQ_CAMERA_AUTHORIZATION` is sent only by the API to the configured gateway; store it in an appropriately protected environment/secret store.

`GET /api/camera-feed` reports configuration without returning the gateway URL or secret. `GET /api/camera-feed/status` checks that the configured playlist is reachable and valid. A successful check means the playlist responded; it does not mean the browser has started playback. The UI reports **LIVE PREVIEW** only after the video element enters playback. With no configured source, the UI states: “CCTV gateway not configured. Configure an authorized gateway to enable live-stream integration.”

The API rewrites playlist resource references to opaque same-origin tokens, rejects references outside the configured gateway origin, blocks redirects, limits request duration and response sizes, and expires tokens after five minutes. HLS.js is loaded lazily using its light build; Safari may use native HLS. Use HTTPS for the configured gateway and app outside a local development environment. Configure gateway authentication and network authorization outside this prototype. Follow the [MediaMTX authentication guidance](https://mediamtx.org/docs/features/authentication).

The proxy protects the upstream URL from the browser but is not an access-control boundary: the local prototype has no user authentication, role-based access, or audit log. Anyone who can reach the app can request the configured feed. Keep ResQ bound to its configured local interface and do not expose it or the gateway to an untrusted network. The Connect dialog's authorization checkbox is only an operator acknowledgement.

## Operator workflow and limits

1. Confirm camera ownership, permission, purpose, notices/consent where applicable, and the organization's retention/access policies.
2. Configure a secure gateway with read-only access to the intended stream and the minimum necessary users.
3. Set the HLS URL and optional display/authorization values in the local API environment and restart ResQ.
4. In the UI, acknowledge authorization and use **Check and connect**. The API verifies the playlist before the browser starts playback. Use **Disconnect preview** when finished.
5. If an event is observed, select or create the relevant incident. A qualified responder records only directly confirmed observations in the structured review and saves the report.

The stream is preview-only: ResQ does not store stream bytes, snapshots, or camera credentials. Camera preview does not run pose inference, people counting, face recognition, demographic/emotion estimation, injury/risk prediction, or automatic event classification. It cannot move cameras, send commands to a recorder, operate an alarm, or otherwise control local devices. The operator report contains only manually entered incident/assessment data; it does not include a camera recording or claim that a camera observation was independently verified.

This local prototype has no user authentication, role-based access, audit log, or production retention controls. Do not expose it or the gateway to an untrusted network or use it for operational surveillance until those controls are implemented and reviewed. Follow legal, privacy, security, and organizational requirements before connecting a real feed.

## References

- [MediaMTX: reading streams](https://mediamtx.org/docs/features/read)
- [MediaMTX: authentication](https://mediamtx.org/docs/features/authentication)
- [hls.js project and browser requirements](https://github.com/video-dev/hls.js)
