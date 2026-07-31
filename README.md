# SonicDrop

SonicDrop moves plaintext messages and very small files between nearby devices with sound above 20 kHz. It runs entirely in the browser: one device broadcasts through its speaker and the other listens through its microphone.

- **Website:** [sonicdrop.io](https://sonicdrop.io)
- **Source:** [github.com/hellogumbo/sonicdrop](https://github.com/hellogumbo/sonicdrop)
- **License:** [MIT](./LICENSE)

## Run it

```bash
pnpm install
pnpm dev
```

That starts the local development UI on `localhost`. To use two physical devices, build and publish the static `dist` folder on an HTTPS host:

```bash
pnpm build
```

Open the same HTTPS URL on both devices, choose **Receive** first, then write a message or choose a file on the sender. Browsers only allow microphone access from HTTPS pages or `localhost`; a plain LAN IP over HTTP will not work.

## Deploy to Vercel

SonicDrop is a static Vite app and does not require a server-side runtime. Configure the `hellogumbo` Vercel project with these settings:

- Framework preset: **Vite**
- Install command: `pnpm install --frozen-lockfile`
- Build command: `pnpm build`
- Output directory: `dist`

`sonicdrop.io` is registered on the Vercel project. In Cloudflare DNS, point the apex to Vercel with `A @ 76.76.21.21`, use DNS-only mode while Vercel verifies the domain, and allow time for nameserver and record propagation. Keep `https://sonicdrop.io` as the canonical public URL.

### Use the reserved ngrok domain

Run the app and tunnel in separate terminals:

```bash
pnpm dev --host 127.0.0.1
ngrok http --url=sonicdrop.ngrok.io 5173
```

The Vite config allowlists that exact hostname. If you switch to another ngrok domain, update `server.allowedHosts` in `vite.config.ts` to match it rather than allowing every host.

## What this prototype supports

- Plaintext messages up to 512 UTF-8 bytes, with a 280-byte or smaller target
- Files up to 4 KB, with a 1 KB or smaller target
- Fixed 48 kHz Web Audio paths
- Four continuous-phase FSK carriers at 20.80, 21.12, 21.44, and 21.76 kHz
- Hamming single-bit correction on each byte
- CRC-32 validation on every frame
- SHA-256 verification before a message is shown or a file can be saved
- No audible fallback frequency

The link is intentionally slow: a frame carries 63 logical bytes and takes about 6.55 seconds. Compact message framing lets up to 25 UTF-8 bytes fit in one frame; a 280-byte message takes about 39 seconds and the 512-byte ceiling takes about 59 seconds.

The 4 KB file limit is a deliberate prototype guardrail, not a fundamental acoustic threshold. At the current bitrate it already means roughly seven to eight minutes in the air, and every additional frame increases the chance that one missed frame prevents completion. The wire format could be expanded, but larger payloads need retransmission and throughput improvements first.

Speaker and microphone frequency response varies widely, so real-device range and reliability need to be measured on the intended hardware. Although the carrier is above 20 kHz, consumer speakers can produce audible distortion; keep devices close, use modest volume, and stop if anyone detects sound.

## Range and throughput research

The current modem is intentionally conservative. The evidence, tradeoffs, and proposed path toward room-scale range and materially higher throughput are documented in [Range and throughput research](./docs/RANGE-AND-THROUGHPUT.md). The recommended next experiment keeps the existing frame format while adding an ultrasonic chirp/channel probe and adaptive tone banks; it does not silently move into the potentially audible 18–20 kHz band.

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build
```

## License

SonicDrop is open source under the [MIT License](./LICENSE). Copyright (c) 2026 Gumbo.
