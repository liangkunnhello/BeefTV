# Changelog

All notable public changes to BeefTV are documented in this file.

## Unreleased

- Built-in BeefAPI can be connected from the desktop app without pasting a key.
- Prepared the first audited public source snapshot.
- Added reproducible local builds, automated quality checks, and multi-architecture container publishing.
- Standardized public artifacts, runtime identifiers, documentation, and repository links on the BeefTV name.

## v1.6.8

- Add the `wan-task-gateway` plugin (provider `wan-task-gateway-video`): one protocol for the Alibaba video family on relay gateways - `wan-3.0`, `wan3.0-video-prime`, `happyhorse-1.1-t2v/i2v/r2v` and `happyhorse-1.0-video-edit`. Create with `POST /v1/wan/video-generation/video-synthesis` plus `X-DashScope-Async: enable`, poll `GET /v1/wan/task/{task_id}`, and map first/last frame, reference image, reference video and driving audio by role and operation.
- Publish a capability profile for the new protocol (480p/720p/1080p, 2-15 seconds, reference-to-video and video-edit operations).
- Note: this protocol is implemented from the gateway contract plus the official DashScope documentation and has not been verified end-to-end yet - the six models still answer `503 no_available_providers` on the current channel key.

## v1.6.7

- Raise the video duration ceiling to 30 seconds for the relay-gateway Seedance protocols (`ark-task-gateway-video`, `ark-task-gateway-video-25`). Verified against the gateway: a 30-second request is accepted (token usage exactly doubles versus 15 seconds) and returns a 30-second video.
- Keep the official Volcengine Ark and Agent Plan protocols at their measured 1-15 second range.

## v1.6.6

- Canvas navigation follows "middle-drag to pan, scroll to zoom": the mouse wheel and trackpad vertical scrolling now zoom around the pointer, while horizontal trackpad gestures and Shift + wheel keep panning.
- Middle-drag panning now suppresses the browser/WebView middle-button defaults (autoscroll, paste, extra menus), so the gesture no longer fights the platform default.
- Sync the canvas shortcut list and the feature docs with the navigation contract.

## v1.6.5

- Support `doubao-seedance-2.5` through relay gateways with a dedicated `ark-task-gateway-video-25` protocol: the create request uses a top-level `prompt` instead of the Ark `content[]` array, and the task is polled on `GET /v1/videos/{task_id}`, whose task object carries `status` and `video_url`.
- Map a single reference image to `input_reference` and multiple images to `image_urls`, matching the documented Seedance 2.5 parameter contract.

## v1.6.4

- Load the model protocol catalog from the backend plugin runtime instead of a hardcoded built-in list, so declarative plugin protocols (for example Ark Task Gateway) are selectable in the model request-protocol picker.

## v1.6.3

- Fetch the channel model catalog through the same-origin backend on desktop builds, so pulling models no longer hangs when the webview cannot reach the upstream directly.
- Allow the `X-Canvas-Upstream-Headers` request header in the desktop CORS middleware, so channels that carry custom headers pass their preflight.

## v1.6.2

- Add an `ark-task-gateway` protocol plugin for relay gateways that expose the Ark/Seedance task API under `/v1/contents/generations/tasks`, with the gateway address configured per channel.
- Prefer `platform_task_id` when reading poll responses, so relay gateways that return their own internal task id no longer break subsequent polling.
- Add macOS one-click start/stop scripts that prepare the Go and frontend toolchains, build the official plugin packages on demand, and record the real listener pid.
- Build desktop installers for macOS (arm64, amd64) and Windows (amd64) from this repository and publish the signed updater feed `desktop-update.json` next to them.

## v1.6.1

- Explain input and output moderation failures by text, image, video and audio, including copyright, privacy and counterfeit-content restrictions.
- Preserve specific failure guidance and request IDs when reloading task history; avoid attributing general moderation failures to real-person references.
- Distinguish upstream billing problems, configured usage limits, concurrency limits and model permissions, including errors wrapped in generic request codes.
- Keep uncertain submissions and unchanged moderation failures from automatically generating another request.

## v1.6.0

- Add depth action capture to the canvas video-processing menu on Apple Silicon Macs, with an optional local runtime and separately cached Small model weights.
- Download and verify depth components from the BeefTV release, with a Hugging Face fallback for model weights and visible task progress.
- Keep video first-frame posters visible until hover playback presents a decoded frame, preventing black flashes when playback starts or stops.
- Preserve current generation, reference-media, desktop-update, and task-retry contracts while integrating the new workflow.

## v1.5.9

- Validate reference image dimensions, aspect ratios, file sizes and audio/video duration using each model's configured capabilities before submitting.
- Preserve supported reference counts, resolutions and durations instead of silently dropping media or downgrading requested settings.
- Support local and inline reference audio for BeefAPI and native Ark channels, while retaining provider-specific audio-only rules.
- Show actionable reference conversion and request-size errors in both canvas nodes and task history, with safe diagnostics and no unsafe unchanged retries.

## v1.5.8

- Add a persistent light/dark switch to the workspace sidebar, with matching home, asset library, menus and settings surfaces.
- Restore canvas appearance controls with light, dark and custom modes; keep each canvas appearance independent from the workspace theme.
- New canvases follow the workspace theme unless an explicit default appearance is saved.

## v1.5.7

- Desktop update checks and downloads now use Cloudflare-hosted files, preserving signed manifests and package integrity verification.
- Publish immutable platform packages before switching the update feed, with verified downloads and protection against incomplete or older releases.
- Check Seedance reference audio total duration and explain gateway media validation failures with the affected clip and actionable limits.

## v1.5.6

- Validate Seedance reference audio/video duration before submission and preserve duration metadata for character voice samples.
- Explain material conversion failures with actionable duration limits and retain request identifiers for support.
- Keep existing task polling available and prevent unsafe resubmission while provider acceptance is uncertain.

## v1.5.5

- Desktop update checks and downloads now use the current user's static HTTP/HTTPS system proxy on macOS and Windows when no explicit environment proxy is configured.
- Keep a manual update check in the sidebar and show a retry action when checking fails, instead of hiding connection failures.
- Preserve proxy bypass rules, signed manifest verification and package integrity checks throughout redirected downloads.

## v1.5.4

- Generation failures now explain the cause and the next action across canvas nodes, task history and custom channels.
- Distinguish content moderation, account quota, provider billing, invalid parameters, rate limits, uncertain submissions and failed result downloads without guessing refunds or the offending input.
- Preserve safe error codes and request identifiers for support, including business errors returned with HTTP 200 and JSON errors inside media downloads.
- Prevent unsafe unchanged batch retries; edited prompts and reference media can be submitted as new attempts after moderation failures.
- Cover all 42 currently declared BeefAPI error codes with a shared frontend and backend regression contract.
- Improved the shared model picker with a viewport-safe, internally scrollable layout and consistent single-line model options.
- Removed redundant model icons, secondary descriptions, and stale option backgrounds from model selection UI.
- Restored native right-click paste behavior in canvas prompt editors and added regression coverage.
- Added regression coverage for generation output delivery, model picker overflow, and local generation error handling.
- Added a canonical local app update script to keep one installed BeefTV application instead of accumulating duplicate builds.

## v1.5.3

- Desktop builds show the installed version in the sidebar and check for published updates on startup.
- Signed updates can be downloaded in the app, then installed with an explicit restart while keeping local projects, assets, settings and connections.
- Pending canvas, director and timeline saves are checked before restarting; failed downloads or verification leave the current installation intact.
- Maintainers can build and publish signed macOS and Windows update packages from main. Existing installations need one manual upgrade to this version before in-app updates are available.

## v1.5.2

- Improved canvas node rendering and inline image cropping, annotation, and local redraw interactions.
- Rebuilt the recycle bin with a fixed two-row viewport, selection, recovery, and confirmed permanent deletion.
- Fixed project cover selection across media nodes and canvases, including fallbacks and centered empty placeholders.
- Added a short product demo and updated the README branding.

## v1.5.1

- Initial public BeefTV snapshot.
- Local-first AI video workspace with image, video, audio, text, asset, canvas, and model-channel workflows.
- BeefAPI remains a built-in local channel while its model catalog is discovered dynamically.
