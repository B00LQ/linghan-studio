# LINGHAN Studio

A self-hosted AI creation canvas: **one infinite canvas that is yours**.
The model layer talks to a local ComfyUI instance or to a cloud API, and canvases, assets and
generation history all stay on your own machine. Local compute first, your work stays yours.

## Features

**Canvas**

- Infinite canvas: pan and zoom, box select, connect nodes, double-click to add, right-click menu, undo/redo (50 steps), tidy layout
- Type-checked ports: text → prompt, image → first/last frame or reference image, video → trim/concat; wrong types cannot be connected
- Prompt window opens under the selected node, holding every image that node has produced
- Floating bottom bar for zoom and layout, centered so it never covers the canvas

**Nodes**

- Text, image, video, trim, concat and audio, all on one canvas
- An image node with a reference image is image-to-image; a video node with a first/last frame is image-to-video
- Trim and concat never touch a diffusion model (ComfyUI core Video Slice / ConcatenateVideo), so they finish in seconds
- Text nodes write with any OpenAI-compatible chat API, audio nodes speak with any OpenAI-compatible `/audio/speech` API. Without a key the text node writes a self-declared placeholder and the audio node returns a real, playable WAV placeholder, so the chain stays testable end to end

**Generation history**

- Every image node keeps its own version line: prompt, seed, duration and failures are all on record
- Reproduce a version with the same parameters and seed, switch the selected version, compare side by side, or delete a version — assets nobody references any more go with it

**Asset library**

- Content-addressed: the same bytes are stored once, whether generated or uploaded
- Server-side PNG thumbnails, asset folders, and a table view for volume and dates
- Batch place, download and delete. Folders are labels, not containers: deleting a folder keeps every asset inside it

**Publishing and server (optional)**

- Publish from the asset page; the server compresses first (PNG re-encoded to a 1600 px long edge), and a canvas snapshot can ride along
- **Nothing appears on the home page until an admin approves it** in the admin backend: review queue, approve, reject with a reason, take down, handle reports
- Private cloud backup: one checkbox keeps a work off the home page and out of the review queue, and nobody else can open it
- Accounts: email and password, email verification, password reset, session rotation and per-device revoke. Passwords are scrypt-hashed, tokens are stored only as sha256 hashes
- Rate limits, per-account quota, read-only degradation (writes refused, reads still served, login and backup stay alive), and AI-generated content labels — visible on the work page, `tEXt` metadata inside uploaded PNGs

**Data safety**

- Automatic backups (daily, checked every 6 hours, 7 kept) and one-click restore
- Backup location wizard, including detection of cloud-sync folders (OneDrive, Nutstore, Baidu Netdisk)
- Export a canvas bundle to move your work to another machine

**Desktop app**

- The download opens as its own application window — no address bar, no tabs — in a single instance, and it remembers the window size
- First-run wizard: data directory → access password → image backend. Every step can be skipped
- Self-update: reads the update source, verifies sha256, unpacks the new version and restarts (green build only)

**Interfaces**

- OpenAI-compatible gateway (`/v1/images/generations` and friends): the image backend can change without a single front-end change
- Agent entry point: an external agent can create over HTTP alone (10 tools, generation as jobs, unattended), and the canvas updates live for anyone who has it open
- Docker one-liner: `docker compose up -d --build`

## Download

Grab `LINGHAN-Studio-<version>-win-x64.zip` from [Releases](https://github.com/B00LQ/linghan-studio/releases).

- Windows x64: extract it anywhere, then double-click the launcher `启动 Studio.cmd` (Start Studio.cmd)
- Nothing to install first — the bundle carries its own Node and Electron
- **No models and no ComfyUI are included** (ComfyUI is GPL software and is not redistributed with this product). For image generation, point the wizard or Settings at your own ComfyUI instance, or paste an Ark API key
- Everything lives in the `data\` folder next to the launcher: copy the folder to move or back it up, delete it to uninstall

## Requirements

- Windows x64 for the prebuilt bundle
- Image generation needs a local ComfyUI instance (Z-Image Turbo by default) or an Ark API key; text and audio nodes need any OpenAI-compatible endpoint
- Measured on an RTX 4070 at 1024×1024: ~70–90 s for the first image (weights moving into VRAM), then ~6 s per image

## Server (optional)

Only needed if you want other people to see your work online.

```bash
STUDIO_SECRET=$(openssl rand -base64 32) \
STUDIO_MODE=cloud \
STUDIO_PUBLIC_URL=https://your-domain \
STUDIO_DATA_DIR=/data \
docker compose up -d --build
```

It serves accounts, the home-page gallery, work pages and the admin backend. Canvases, compute and
original assets always stay on each user's own machine; the server only stores compressed results.
Bind it to `127.0.0.1` behind TLS, and set `STUDIO_TRUST_PROXY=1` only when a reverse proxy really is
in front. **The first account to register becomes the admin** — you register it yourself.

## Development

```bash
pnpm install
pnpm dev:server           # server on :8080 (needs STUDIO_PASSWORD)
pnpm dev:web              # canvas on :5173, API proxied to :8080
```

- `pnpm typecheck`
- `node tests/run-regression.mjs [baseUrl] [password]`
- `node packaging/build-desktop.mjs` — green build, update zip and `update.json` (install Inno Setup to also get `setup.exe`)

## License

**Proprietary software — not open source.** All rights reserved; public visibility does not grant the
right to use, modify or redistribute it. See [LICENSE](LICENSE) for the full terms.

Canvas interaction uses [@xyflow/react](https://github.com/xyflow/xyflow) (MIT), with its notice
retained; the canvas implementation itself is original to this repository. Model weights are
not distributed with this repository and remain under their own licenses.

> Known limitations and the full configuration reference are currently written in Chinese:
> [README.zh-CN.md](README.zh-CN.md).

> 中文文档：[README.zh-CN.md](README.zh-CN.md)
