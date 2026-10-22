# ASTaria local black-hole media

All 48 assets are generated from ASTaria's own black-hole renderer. No screenshots of user data or third-party footage are used.

- Native source: 3840×2160 landscape / 2160×3840 portrait, Ultra, Float32 geodesic lookup.
- Separate dark/light palettes and portrait composition; no enlargement of a 720p/1080p source to label it 4K.
- Each orientation/palette: 4K, 1080p, 720p; high and standard quality.
- Images: WebP quality 96/90, taken at the video loop's first frame.
- Video: H.264 High, yuv420p, 30 FPS, 7 seconds. A one-second crossfade joins the original 8-second master. Video target Mbps: 45/30 (4K), 20/12 (1080p), 10/6 (720p). Encoder overhead can put measured bitrate above target.
- Total asset bytes and SHA-256 values are in `manifest.json`. The set is approximately 443 MiB, which increases installation size.

To regenerate, run `node scripts/capture-background-media.mjs`, open its local capture page, and click the 4K master-generation button. This writes 240 PNG frames for each of the four compositions into the local `artifacts/background-media-2026-10-22` directory. Then run `node scripts/encode-background-media.mjs`. Capture and encoding require substantial temporary space; master frames are not shipped.

`node scripts/verify-background-media.mjs` verifies actual dimensions, hashes, video codec/pixel format/fps/duration/bitrate, and decodes every video. It does not establish hardware decoding, battery benefit, or visual acceptance on a phone. Use a final native build for those checks.
