# Optional 4K background assets

This directory contains the optional 4K high-bitrate background clips. They are intentionally kept outside `public/`, the production bundles, the mobile native payloads and the desktop packaging roots: they are not installed with the application and are not available for download in the current public version.

`manifest.json` records byte lengths and SHA-256 values for all eight clips (about 312 MiB). The application pins the same values in `src/prototype/mediaPackCatalog.ts`. Updating footage requires a new immutable resource revision with matching catalog entries and a desktop CSP allowlist entry; do not silently overwrite a published revision.

The default installation includes the 16 assets listed in `public/backgrounds/manifest.json` and `public/backgrounds/horizon-manifest.json`: 1080p high-bitrate clips and 4K high-quality stills for both scene views, themes and orientations. Legacy settings resolve to these defaults without deleting saved user preferences.

Publication of the optional pack is pending. No application build or public document may offer it as a download before the resource revision is published; builds must not attempt to fetch an unpublished pack.
