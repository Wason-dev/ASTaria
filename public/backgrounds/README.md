# ASTaria bundled backgrounds

ASTaria ships 16 background media assets: eight 1080p high-bitrate H.264 clips (20 Mbps target, 30 FPS, seven-second loops) and eight 4K high-quality WebP stills. The set covers both scene views (panorama and horizon), portrait and landscape orientations, and light/dark themes. All assets are rendered with ASTaria's own black-hole renderer; no third-party footage is used. The bundled set is approximately 137 MiB.

`manifest.json` and `horizon-manifest.json` record dimensions, byte lengths, target bitrates, WebP quality and SHA-256 values. The horizon set uses the expanded capture range and exposure compensation documented in [the rendering decisions](../../docs/POWER_AND_RENDERING_DECISIONS.md).

Optional 4K high-bitrate clips are kept outside the application payload in `media-assets/4k`. They are not included in installation packages and are not available for download in the current public version; application builds must not attempt to download an unpublished pack. The pinned catalog and download/caching implementation live under `src/prototype/mediaPack*`.

Legacy 720p and standard-quality preferences resolve to the bundled 1080p high-quality video and 4K stills. The retained videos are not re-encoded at a lower bitrate. Build verification rejects obsolete or optional encodes added to this directory.
