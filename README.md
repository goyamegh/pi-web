# pi-web

A small local/Tailscale web UI for [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent).

The app is TypeScript end-to-end:

- `server.ts` is the Pi API/WebSocket server, run directly with `tsx`
- `src/main.ts` is the Vite frontend with HMR
- in dev, `server.ts` embeds Vite middleware so API, WebSocket, and HMR run in one process

## Install

```bash
npm install
```

## Run locally with Vite HMR

```bash
npm run dev
```

This starts one TypeScript Node process. It serves:

- Vite frontend with HMR
- Pi API routes under `/api/*`
- Pi WebSocket at `/ws`

Open:

```text
http://127.0.0.1:8787
```

Edit files under `src/` and Vite will update the UI live. Edit `server.ts` and `tsx --watch` restarts the server.

By default, Pi operates in the directory where you start this server. To point Pi at another project:

```bash
PI_WEB_CWD=/Users/ashwin/projects/comfy-lan-webapp npm run dev
```

## Production build

```bash
npm run build
npm start
```

`npm start` serves the compiled `dist/` app and API from one process.

## Run on Tailscale with MagicDNS

Recommended: keep the Node app localhost-only and expose it with Tailscale Serve.

```bash
npm run build
PI_WEB_TOKEN="$(openssl rand -hex 32)" \
PI_WEB_CWD=/Users/ashwin/projects/comfy-lan-webapp \
HOST=127.0.0.1 \
PORT=8787 \
npm start
```

In another terminal:

```bash
tailscale serve --bg http://127.0.0.1:8787
```

Then open:

```text
https://<machine-name>.<tailnet>.ts.net
```

Click **Token** in the UI and paste the `PI_WEB_TOKEN` value.

## Direct Tailnet bind

You can also bind directly to your Tailscale IP:

```bash
PI_WEB_TOKEN="$(openssl rand -hex 32)" \
HOST="$(tailscale ip -4)" \
PORT=8787 \
npm start
```

Then open:

```text
http://<machine-name>:8787
```

## Environment variables

- `HOST` - bind host, default `127.0.0.1`
- `PORT` - bind port, default `8787`
- `PI_WEB_TOKEN` - optional bearer token for API/WebSocket access
- `PI_WEB_CWD` - project directory Pi should operate in, default current directory
- `PI_WEB_NO_SESSION=1` - use in-memory sessions only

## Security

This app can drive Pi tools such as `bash`, `write`, and `edit`. Use Tailscale ACLs and set `PI_WEB_TOKEN`.
