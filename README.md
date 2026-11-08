# Frame / Follow

A client-side choreography video reframing tool. Choose a video, drag the timeline to a clear frame, select a person, wait for pose analysis, adjust the crop in the live preview, then export an MP4. Your video is processed on your device and is not uploaded.

[Try the live demo](https://mon-jai.github.io/frame-follow/).

## Development and GitHub Pages

Install Node.js and pnpm, then run `pnpm install` and `pnpm dev`. `pnpm build` generates the static site in `dist/`, with relative asset paths suitable for a GitHub Pages project site. In repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**; the included workflow builds and deploys `dist/` when changes are pushed to `main`. You can also open `dist/index.html` directly for a local preview.

Installation configures Git's `core.hooksPath` to `.githooks`. The pre-commit hook builds and stages `dist/`; it refuses to run when tracked application files have unstaged changes, so stage those changes first. Git hooks are local and can be bypassed; run `pnpm build` manually if hooks are disabled. The hook requires pnpm to be available on PATH.

## How it works

MediaPipe Pose Landmarker analyzes detected poses at 10 samples per second and follows the selected person forward and backward from the chosen frame. The camera follows the trunk or an estimated anatomical center of mass, interpolates gaps, and applies adjustable smoothing. The preview crops the original video directly on a canvas; settings do not require another encode. The export uses FFmpeg.wasm, x264's `placebo` preset and CRF 18, cropping at source pixel dimensions without scaling. Audio, when present, is encoded as AAC. Output dimensions are rounded down to even pixels for H.264 compatibility.

The app initializes the bundled MediaPipe pose model and WASM runtime when the page loads. When opened directly from a `file://` URL, browser restrictions require downloading the pinned MediaPipe assets and FFmpeg core from their upstream hosts; served builds use the bundled assets. Video content remains local. The tracker matches people by proximity and may lose the subject or switch identities when people overlap or cross. Center of mass is an approximation, not a physical measurement. Browser video decoding support varies. Long or high-resolution videos can take substantial time and memory to analyze and encode; the maximum-effort export is especially slow. Use a current desktop browser for best results.

## Open-source components

- [MediaPipe Tasks Vision 0.10.21](https://github.com/google-ai-edge/mediapipe) and its [Pose Landmarker Full model](https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task): Apache 2.0. The model license was [confirmed by a MediaPipe maintainer](https://github.com/google-ai-edge/mediapipe/issues/6306).
- [FFmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) and its GPL-enabled FFmpeg core, including x264: GPL-compatible free software. The distributed core is subject to GPL terms; see the upstream project for source and license details.
- [Vite](https://github.com/vitejs/vite): MIT.

- [Inter Variable](https://github.com/rsms/inter): SIL Open Font License 1.1; bundled via Fontsource.

## License

The project source is available under the [MIT License](LICENSE). Third-party components retain their own licenses, including the GPL-enabled FFmpeg core described above.
