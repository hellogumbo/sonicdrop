import { describe, expect, it } from 'vitest'
import {
  AUDIO_SAMPLE_RATE,
  FRAME_BYTES,
  FRAME_SAMPLES,
  MAX_MESSAGE_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_TRANSFER_FRAMES,
  PEAK_AMPLITUDE,
  ProtocolError,
  TONE_FREQUENCIES,
  TRANSFER_FLAG_MESSAGE,
  assembleTransfer,
  buildEncodedTransfer,
  buildMessageTransfer,
  buildTransfer,
  createRawFrame,
  crc32,
  decodeFrameFromPcm,
  estimateFrameCount,
  hammingDecodeWord,
  hammingEncodeByte,
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
