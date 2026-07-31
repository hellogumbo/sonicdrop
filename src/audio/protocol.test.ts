import { describe, expect, it } from 'vitest'
import {
  AUDIO_SAMPLE_RATE,
  FRAME_BYTES,
  FRAME_SAMPLES,
  LEADER_SYMBOL_COUNT,
  MAX_MESSAGE_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_TRANSFER_FRAMES,
  PEAK_AMPLITUDE,
  PREAMBLE_SYMBOL_COUNT,
  ProtocolError,
  SYMBOL_SAMPLES,
  SYNC_SYMBOLS,
  TONE_FREQUENCIES,
  TRANSFER_FLAG_MESSAGE,
  assembleTransfer,
  buildEncodedTransfer,
  buildMessageTransfer,
  buildTransfer,
  createRawFrame,
  crc32,
  decodeFrameFromPcm,
  encodeFrameBodySymbols,
  estimateFrameCount,
  hammingDecodeWord,
  hammingEncodeByte,
  measureUltrasonicLevel,
  modulateFrame,
  parseRawFrame,
} from './protocol'

describe('SonicDrop protocol framing', () => {
  it('builds, parses, reorders, and verifies a complete transfer', async () => {
    const data = Uint8Array.from({ length: 180 }, (_, index) => (index * 37) & 0xff)
    const encoded = await buildTransfer('all-bytes.bin', 'application/octet-stream', data)

    expect(encoded.id).toBe(encoded.transferId)
    expect(encoded.name).toBe('all-bytes.bin')
    expect(encoded.mimeType).toBe('application/octet-stream')
    expect(encoded.bytes).toBe(data.length)
    expect(encoded.frames.length).toBeGreaterThan(1)
    expect(encoded.frames).toHaveLength(
      estimateFrameCount({
        name: encoded.name,
        mimeType: encoded.mimeType,
        size: encoded.bytes,
      }),
    )

    for (let index = 0; index < encoded.frames.length; index += 1) {
      expect(encoded.frames[index]).toHaveLength(FRAME_BYTES)
      const frame = parseRawFrame(encoded.frames[index])
      expect(frame.transferId).toBe(encoded.id)
      expect(frame.frameIndex).toBe(index)
      expect(frame.frameCount).toBe(encoded.frames.length)
    }

    const assembled = await assembleTransfer([...encoded.frames].reverse())
    expect(assembled.name).toBe('all-bytes.bin')
    expect(assembled.mimeType).toBe('application/octet-stream')
    expect(assembled.data).toEqual(data)
    expect(assembled.transferId).toBe(encoded.id)
  })

  it('uses the standard IEEE CRC-32 check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf4_3926)
  })

  it('rejects a payload whose CRC no longer matches', async () => {
    const transfer = await buildTransfer('a', '', new Uint8Array([1, 2, 3]))
    const damaged = Uint8Array.from(transfer.frames[0])
    damaged[13] ^= 0x80

    let caught: unknown
    try {
      parseRawFrame(damaged)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ProtocolError)
    expect((caught as ProtocolError).code).toBe('CRC_MISMATCH')
  })

  it('bounds the largest legal transfer envelope', async () => {
    const transfer = await buildTransfer(
      'n'.repeat(255),
      'm'.repeat(255),
      new Uint8Array(MAX_PAYLOAD_BYTES),
    )

    expect(transfer.frames).toHaveLength(MAX_TRANSFER_FRAMES)
    expect((await assembleTransfer(transfer.frames)).data).toHaveLength(MAX_PAYLOAD_BYTES)
  })

  it('applies metadata limits to estimates before broadcast starts', () => {
    expect(() => estimateFrameCount({
      name: 'n'.repeat(256),
      mimeType: 'text/plain',
      size: 1,
    })).toThrowError(ProtocolError)
  })

  it('binds transfer identity to metadata as well as payload bytes', async () => {
    const data = Uint8Array.from({ length: 180 }, (_, index) => index)
    const first = await buildTransfer('one.txt', 'text/plain', data)
    const second = await buildTransfer('two.txt', 'text/plain', data)

    expect(first.transferId).not.toBe(second.transferId)
    await expect(assembleTransfer([
      first.frames[0],
      ...second.frames.slice(1),
    ])).rejects.toMatchObject({ code: 'INVALID_FRAME' })
  })

  it('round-trips a compact UTF-8 message without file metadata', async () => {
    const message = '  Hi 🌊\n'
    const transfer = await buildMessageTransfer(message)
    expect(transfer.frames).toHaveLength(1)

    const assembled = await assembleTransfer(transfer.frames)
    expect(assembled.flags & TRANSFER_FLAG_MESSAGE).toBe(TRANSFER_FLAG_MESSAGE)
    expect(assembled.name).toBe('')
    expect(assembled.mimeType).toBe('')
    expect(new TextDecoder('utf-8', { fatal: true }).decode(assembled.data)).toBe(message)
  })

  it('limits messages by UTF-8 bytes rather than JavaScript characters', async () => {
    await expect(buildMessageTransfer('é'.repeat(MAX_MESSAGE_BYTES / 2))).resolves.toBeDefined()
    await expect(buildMessageTransfer('é'.repeat(MAX_MESSAGE_BYTES / 2 + 1))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  it('enforces compact-message invariants on builders and incoming frames', async () => {
    await expect(buildEncodedTransfer({
      name: 'note.txt',
      mime: 'text/plain',
      data: new TextEncoder().encode('hello'),
      flags: TRANSFER_FLAG_MESSAGE,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    await expect(buildEncodedTransfer({
      name: '',
      mime: '',
      data: new Uint8Array(MAX_MESSAGE_BYTES + 1),
      flags: TRANSFER_FLAG_MESSAGE,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    const fileTransfer = await buildTransfer('', '', new Uint8Array(MAX_MESSAGE_BYTES + 1))
    const forgedMessageFrames = fileTransfer.frames.map((raw) => {
      const parsed = parseRawFrame(raw)
      return createRawFrame({
        flags: TRANSFER_FLAG_MESSAGE,
        transferId: parsed.transferId,
        frameIndex: parsed.frameIndex,
        frameCount: parsed.frameCount,
        payload: parsed.payload,
      })
    })
    await expect(assembleTransfer(forgedMessageFrames)).rejects.toMatchObject({
      code: 'INVALID_FRAME',
    })
  })
})

describe('Hamming(12,8)', () => {
  it('pins the v3 interleaved body mapping to a golden vector', () => {
    const rawFrame = Uint8Array.from(
      '5344032012345678000200073f0b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186abd0f51a3f6489aed3f81d42678cb1d6fb20456a8fb4d9fe23486d92b7dc01d226ada9'
        .match(/.{2}/g)!
        .map((byte) => Number.parseInt(byte, 16)),
    )
    const symbols = encodeFrameBodySymbols(rawFrame)

    expect(symbols).toHaveLength(480)
    expect(crc32(symbols)).toBe(0xccd5_5798)
    expect([
      ...symbols.slice(0, 12),
      ...symbols.slice(36, 44),
      ...symbols.slice(116, 124),
      ...symbols.slice(236, 244),
      ...symbols.slice(356, 364),
      ...symbols.slice(472, 480),
    ]).toEqual([
      2, 3, 1, 2, 1, 1, 3, 3, 0, 1, 0, 2,
      2, 0, 1, 0, 1, 2, 1, 3,
      2, 3, 3, 2, 2, 2, 3, 1,
      1, 0, 1, 2, 3, 0, 2, 2,
      0, 3, 0, 2, 1, 0, 1, 3,
      1, 1, 1, 1, 1, 1, 0, 2,
    ])
  })

  it('round-trips every possible byte', () => {
    for (let byte = 0; byte <= 0xff; byte += 1) {
      const decoded = hammingDecodeWord(hammingEncodeByte(byte))
      expect(decoded.byte).toBe(byte)
      expect(decoded.corrected).toBe(false)
    }
  })

  it('corrects every possible one-bit error', () => {
    for (const byte of [0x00, 0x01, 0x55, 0xa6, 0xff]) {
      const encoded = hammingEncodeByte(byte)
      for (let bit = 0; bit < 12; bit += 1) {
        const decoded = hammingDecodeWord(encoded ^ (1 << bit))
        expect(decoded.byte).toBe(byte)
        expect(decoded.corrected).toBe(true)
      }
    }
  })
})

describe('strict ultrasonic PCM', () => {
  it('keeps every carrier above 20 kHz and below the 48 kHz Nyquist limit', () => {
    expect(AUDIO_SAMPLE_RATE).toBe(48_000)
    expect(Math.min(...TONE_FREQUENCIES)).toBeGreaterThan(20_000)
    expect(Math.max(...TONE_FREQUENCIES)).toBeLessThan(AUDIO_SAMPLE_RATE / 2)
    expect(PEAK_AMPLITUDE).toBeLessThanOrEqual(0.12)
  })

  it('measures frequency-shifted carrier energy without reacting to loud audible audio', () => {
    const audibleOnly = new Float32Array(2_048)

    for (let index = 0; index < audibleOnly.length; index += 1) {
      audibleOnly[index] = 0.45 * Math.sin(
        2 * Math.PI * 1_100 * index / AUDIO_SAMPLE_RATE,
      )
    }

    expect(measureUltrasonicLevel(audibleOnly)).toBeLessThan(0.0001)
    for (const offsetHz of [-100, 0, 100]) {
      const withCarrier = Float32Array.from(audibleOnly, (audible, index) => (
        audible + 0.025 * Math.sin(
          2 * Math.PI * (TONE_FREQUENCIES[2] + offsetHz) * index / AUDIO_SAMPLE_RATE,
        )
      ))
      expect(measureUltrasonicLevel(withCarrier)).toBeGreaterThan(0.02)
    }
  })

  it('returns finite zero for degenerate level windows and refreshes its window cache', () => {
    for (const samples of [
      new Float32Array(),
      Float32Array.of(1),
      Float32Array.of(1, -1),
    ]) {
      const level = measureUltrasonicLevel(samples)
      expect(Number.isFinite(level)).toBe(true)
      expect(level).toBe(0)
    }

    const carrier = (length: number) => Float32Array.from(
      { length },
      (_, index) => 0.025 * Math.sin(
        2 * Math.PI * TONE_FREQUENCIES[1] * index / AUDIO_SAMPLE_RATE,
      ),
    )
    const firstLength = carrier(1_024)
    expect(measureUltrasonicLevel(firstLength)).toBeGreaterThan(0.02)
    expect(measureUltrasonicLevel(carrier(1_537))).toBeGreaterThan(0.02)
    expect(measureUltrasonicLevel(firstLength)).toBeGreaterThan(0.02)
  })

  it('finds and decodes exact PCM after an arbitrary leading offset', async () => {
    const transfer = await buildTransfer('a', '', new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    expect(transfer.frames).toHaveLength(1)

    const framePcm = modulateFrame(transfer.frames[0])
    const leadingSamples = 137
    const pcm = new Float32Array(leadingSamples + framePcm.length + 31)
    pcm.set(framePcm, leadingSamples)

    const decoded = decodeFrameFromPcm(pcm)
    expect(decoded).not.toBeNull()
    expect(decoded?.startSample).toBe(leadingSamples)
    expect(decoded?.endSample).toBe(leadingSamples + FRAME_SAMPLES)
    expect(decoded?.frame.raw).toEqual(transfer.frames[0])
    expect(decoded?.frame.payload).toEqual(parseRawFrame(transfer.frames[0]).payload)
  }, 20_000)

  it('recovers an attenuated frame through deterministic background noise', async () => {
    const transfer = await buildTransfer('noisy', '', new Uint8Array([3, 1, 4, 1, 5, 9]))
    const framePcm = modulateFrame(transfer.frames[0])
    const leadingSamples = 223
    const pcm = new Float32Array(leadingSamples + framePcm.length + 181)

    for (let index = 0; index < pcm.length; index += 1) {
      pcm[index] = 0.00035 * Math.sin(index * 0.731) + 0.0002 * Math.cos(index * 0.193)
    }
    for (let index = 0; index < framePcm.length; index += 1) {
      pcm[leadingSamples + index] += framePcm[index] * 0.35
    }

    const decoded = decodeFrameFromPcm(pcm)
    expect(decoded?.frame.raw).toEqual(transfer.frames[0])
  }, 20_000)

  it('calibrates carrier-specific attenuation below the channel-gain floor', async () => {
    const transfer = await buildTransfer(
      'notched',
      '',
      Uint8Array.from({ length: 37 }, (_, index) => (index * 31 + 5) & 0xff),
    )
    const framePcm = modulateFrame(transfer.frames[0])
    const bodySymbols = encodeFrameBodySymbols(transfer.frames[0])
    const transmittedSymbols = new Uint8Array(PREAMBLE_SYMBOL_COUNT + bodySymbols.length)
    transmittedSymbols.fill(0, 0, LEADER_SYMBOL_COUNT)
    transmittedSymbols.set(SYNC_SYMBOLS, LEADER_SYMBOL_COUNT)
    transmittedSymbols.set(bodySymbols, PREAMBLE_SYMBOL_COUNT)
    const amplitudeGains = [0.8, 0.52, 0.12, 1] as const

    for (let symbolIndex = 0; symbolIndex < transmittedSymbols.length; symbolIndex += 1) {
      const gain = amplitudeGains[transmittedSymbols[symbolIndex]]
      const symbolStart = symbolIndex * SYMBOL_SAMPLES
      for (let sample = 0; sample < SYMBOL_SAMPLES; sample += 1) {
        framePcm[symbolStart + sample] *= gain
      }
    }

    expect(amplitudeGains[2] ** 2).toBeLessThan(0.06 * amplitudeGains[3] ** 2)
    expect(decodeFrameFromPcm(framePcm)?.frame.raw).toEqual(transfer.frames[0])
  }, 20_000)

  it('recovers a frame through a short competing-tone burst', async () => {
    const transfer = await buildTransfer(
      'burst',
      '',
      Uint8Array.from({ length: 31 }, (_, index) => (index * 29 + 7) & 0xff),
    )
    const framePcm = modulateFrame(transfer.frames[0])
    const bodySymbols = encodeFrameBodySymbols(transfer.frames[0])
    const burstSymbol = 120

    for (let damaged = 0; damaged < 2; damaged += 1) {
      const symbolIndex = burstSymbol + damaged
      const wrongTone = (bodySymbols[symbolIndex] + 1) % TONE_FREQUENCIES.length
      const phaseStep = 2 * Math.PI * TONE_FREQUENCIES[wrongTone] / AUDIO_SAMPLE_RATE
      const symbolStart = (PREAMBLE_SYMBOL_COUNT + symbolIndex) * SYMBOL_SAMPLES

      for (let sample = 0; sample < SYMBOL_SAMPLES; sample += 1) {
        framePcm[symbolStart + sample] = PEAK_AMPLITUDE * Math.sin(sample * phaseStep)
      }
    }

    expect(decodeFrameFromPcm(framePcm)?.frame.raw).toEqual(transfer.frames[0])
  }, 20_000)

  it('falls back to raw body decisions after sync-only carrier interference', async () => {
    const transfer = await buildTransfer(
      'sync-interference',
      '',
      Uint8Array.from({ length: 63 }, (_, index) => (index * 43 + 17) & 0xff),
    )
    const framePcm = modulateFrame(transfer.frames[0])
    const interferenceFrequency = TONE_FREQUENCIES[2]
    const phaseStep = 2 * Math.PI * interferenceFrequency / AUDIO_SAMPLE_RATE
    const interferenceEnd = PREAMBLE_SYMBOL_COUNT * SYMBOL_SAMPLES

    // The interferer raises the sync-derived floor for carrier 2, then vanishes
    // for the clean body so only the independent raw hard path can recover it.
    for (let sample = 0; sample < interferenceEnd; sample += 1) {
      framePcm[sample] += 0.16 * Math.sin(sample * phaseStep + 0.37)
    }

    expect(decodeFrameFromPcm(framePcm)?.frame.raw).toEqual(transfer.frames[0])
  }, 20_000)

  it('decodes under loud audible playback and output compression', async () => {
    const transfer = await buildTransfer('music', '', new Uint8Array([8, 6, 7, 5, 3, 0, 9]))
    const framePcm = modulateFrame(transfer.frames[0])
    const leadingSamples = 311
    const pcm = new Float32Array(leadingSamples + framePcm.length + 97)
    const audibleFrequencies = [110, 440, 1_760, 7_040, 15_360]

    for (let index = 0; index < pcm.length; index += 1) {
      const movement = 0.72 + 0.28 * Math.sin(2 * Math.PI * 2.3 * index / AUDIO_SAMPLE_RATE)
      let audible = 0
      for (let tone = 0; tone < audibleFrequencies.length; tone += 1) {
        audible += (0.13 / (tone + 1)) * Math.sin(
          2 * Math.PI * audibleFrequencies[tone] * index / AUDIO_SAMPLE_RATE + tone * 0.91,
        )
      }
      const signalIndex = index - leadingSamples
      const ultrasonic = signalIndex >= 0 && signalIndex < framePcm.length
        ? framePcm[signalIndex] * 0.16
        : 0
      const mixed = audible * movement + ultrasonic
      pcm[index] = Math.tanh(mixed * 1.8) / Math.tanh(1.8)
    }

    expect(decodeFrameFromPcm(pcm)?.frame.raw).toEqual(transfer.frames[0])
  }, 20_000)

  it('decodes while rejecting an in-band harmonic from audible playback', async () => {
    const transfer = await buildTransfer('harmonic', '', new Uint8Array([2, 7, 1, 8, 2, 8]))
    const framePcm = modulateFrame(transfer.frames[0])
    const leadingSamples = 173

    for (const carrierFrequency of TONE_FREQUENCIES) {
      const pcm = new Float32Array(leadingSamples + framePcm.length + 83)
      const audibleFrequency = carrierFrequency / 2

      for (let index = 0; index < pcm.length; index += 1) {
        const audible = 0.36 * Math.sin(
          2 * Math.PI * audibleFrequency * index / AUDIO_SAMPLE_RATE,
        )
        const playbackWithEvenOrderDistortion = audible + 0.3 * audible * audible
        const signalIndex = index - leadingSamples
        const ultrasonic = signalIndex >= 0 && signalIndex < framePcm.length
          ? framePcm[signalIndex] * 0.15
          : 0
        pcm[index] = playbackWithEvenOrderDistortion + ultrasonic
      }

      expect(decodeFrameFromPcm(pcm)?.frame.raw).toEqual(transfer.frames[0])
    }
  }, 20_000)

  it('reassembles consecutive PCM frames using the decoder’s consumed range', async () => {
    const data = Uint8Array.from({ length: 70 }, (_, index) => (index * 19) & 0xff)
    const transfer = await buildTransfer('b', '', data)
    expect(transfer.frames).toHaveLength(2)

    const leadingSamples = 91
    const pcmFrames = transfer.frames.map(modulateFrame)
    const stream = new Float32Array(
      leadingSamples + pcmFrames.reduce((total, pcm) => total + pcm.length, 0),
    )
    let writeOffset = leadingSamples
    for (const pcm of pcmFrames) {
      stream.set(pcm, writeOffset)
      writeOffset += pcm.length
    }

    const decodedFrames = []
    let unread = stream
    for (let index = 0; index < transfer.frames.length; index += 1) {
      const decoded = decodeFrameFromPcm(unread)
      expect(decoded).not.toBeNull()
      decodedFrames.push(decoded!.frame)
      unread = unread.slice(decoded!.endSample)
    }

    const assembled = await assembleTransfer(decodedFrames)
    expect(assembled.data).toEqual(data)
  }, 20_000)

  it('rejects a sustained carrier without repeatedly rescanning the same region', () => {
    const interferer = new Float32Array(AUDIO_SAMPLE_RATE * 9)
    const phaseStep = 2 * Math.PI * TONE_FREQUENCIES[0] / AUDIO_SAMPLE_RATE
    for (let index = 0; index < interferer.length; index += 1) {
      interferer[index] = 0.05 * Math.sin(index * phaseStep)
    }

    expect(decodeFrameFromPcm(interferer)).toBeNull()
  }, 2_000)
})
