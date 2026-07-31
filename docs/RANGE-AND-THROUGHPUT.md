# Range and throughput research

## Bottom line

SonicDrop can become faster and work across a room on commodity speakers and microphones, but there is no single frequency band that simultaneously guarantees inaudibility, long range, high throughput, and broad device support.

The current 20.80–21.76 kHz design makes a sensible first-prototype trade: it stays above the nominal upper edge of human hearing and fits inside a 48 kHz Web Audio path. It also sits in the weakest, most device-dependent part of many consumer audio chains. Research systems get their largest gains in one of three ways:

1. move down into 18–20 kHz, where consumer hardware is usually stronger but some people can hear the signal;
2. probe the actual channel and adapt frequency, rate, and coding to the device pair;
3. replace long, independent noncoherent symbols with synchronization, channel estimation, coherent modulation and equalization, spread-spectrum chirps, or OFDM.

For SonicDrop, the recommended order is **adaptive channel probing and a chirp preamble first, selective retransmission second, then a phase-coherent equalized waveform or carefully piloted OFDM**. Keep the default carrier above 20 kHz. Treat any 18–20 kHz profile as an explicitly opt-in experiment, never as guaranteed inaudible.

The research gives useful reference points, not browser performance promises. A credible first target to validate is reliable text transfer at 2–5 m on a representative phone/laptop matrix. A 5–10 m target should follow only after rate adaptation, interleaving/FEC, and retransmission exist.

## What the current modem is doing

The current implementation is defined in [`src/audio/protocol.ts`](../src/audio/protocol.ts):

| Property | Current value | Consequence |
| --- | ---: | --- |
| Audio sample rate | 48,000 samples/s | Nyquist limit is 24 kHz; there is little room above the carriers for real output/input filters. |
| 4-CPFSK tones | 20.80, 21.12, 21.44, 21.76 kHz | 960 Hz occupied span, with 320 Hz tone spacing. |
| Symbol duration | 600 samples = 12.5 ms | 80 symbols/s; each 4-ary symbol represents 2 coded bits. |
| Gross tone rate | 160 coded bit/s | Before preamble, trailing silence, FEC, headers, and transfer metadata. |
| Frame | 40-symbol preamble + 480-symbol body + 50 ms silence | 6.55 seconds per frame. |
| Application fragment | At most 63 bytes/frame | At most about 76.9 fragment bit/s before transfer-envelope overhead. |
| Error protection | Hamming(12,8), frame CRC-32, final SHA-256 | Corrects isolated one-bit codeword errors and detects corruption, but does not recover a missing frame or authenticate a sender. |
| Peak digital amplitude | 0.12 | Conservatively avoids digital clipping, but acoustic SPL and ultrasonic output still vary by device and volume setting. |

The 320 Hz separation is four cycles of the 80 Hz symbol-rate resolution, and continuous phase plus windowed analysis avoids the most obvious transition clicks. Those are useful properties to preserve.

The main limitations are elsewhere:

- **The band is fixed.** Consumer speaker and microphone response near Nyquist is highly irregular. A good lane on one device pair can be a notch on another.
- **The band is high for commodity hardware.** Jeon, Kim, and Lee report that COTS microphones and speakers become severely frequency-selective above 21 kHz. BatNet likewise found response to vary by both frequency and device.
- **The channel estimate is deliberately narrow.** Version 3 uses the balanced sync field to estimate per-carrier gain and noise, with an independent raw-decision fallback when that estimate becomes stale before the body. It still does not track a changing channel or undo intersymbol interference. Reflections, sample-clock offset, and movement still alter the received waveform.
- **Errors are bursty, not independent.** Version 3 transmits Hamming bits column-major so short bursts are distributed across codewords, but a hand movement or multipath null can still damage a complete frame.
- **A single missing frame prevents completion.** At 4 KB, many minutes and dozens of frames must all arrive. Range and file size therefore compound the loss probability.
- **A reported 48 kHz stream is not proof of ultrasonic bandwidth.** It verifies the rate exposed by the browser, not the response of the DAC, amplifier, speaker, microphone, analog filter, OS processing, or resampler.

## The audibility boundary is not a hard line

“18–20 kHz” is often called near-ultrasonic, but it is not reliably inaudible. A PNAS study states that young healthy adults can hear tones up to at least 20 kHz. Controlled measurements have also obtained hearing thresholds above 20 kHz for some listeners, at high sound-pressure levels. In addition, modulation discontinuities and nonlinear consumer speakers can create audible clicks, subharmonics, or intermodulation products even when every intended carrier is above 20 kHz. Hush observed audible artifacts from simple carrier modulation above 20 kHz and designed its waveform around that problem.

Therefore:

- do not silently move SonicDrop into 18–20 kHz;
- describe the current and future default as **designed above the nominal hearing range**, not as universally inaudible;
- retain continuous phase, smooth attack/release envelopes, and a conservative output level;
- do not solve range by simply maximizing volume—the browser cannot measure acoustic SPL or distortion at the listener;
- test for audible by-products with measurement microphones and listeners across devices;
- if an 18–20 kHz mode is researched, make it opt-in, visibly label it “near-ultrasonic; may be audible,” and stop playback immediately on request.

Primary hearing sources: [Motlagh Zadeh et al., PNAS 2019](https://doi.org/10.1073/pnas.1903315116) and [Ashihara et al., Acoustical Science and Technology 2006](https://doi.org/10.1250/ast.27.12).

## What published systems demonstrate

Rates below are the authors’ reported endpoints under their own hardware and test conditions. They are not directly comparable, but together they expose the design space.

| System | Frequency band | Modulation/protocol | Reported rate | Reported distance | What SonicDrop should learn |
| --- | --- | --- | ---: | ---: | --- |
| **SonicDrop v3 current** | 20.80–21.76 kHz | Gray-mapped 4-CPFSK; bit-interleaved Hamming(12,8); soft decisions; CRC-32 | ~76.9 bit/s max frame-fragment rate | Not physically characterized | Establish a real device/distance baseline before changing the waveform. |
| [Google Nearby ultrasound](https://doi.org/10.1109/TMM.2017.2766049) | 18.5–20 kHz | Direct-sequence spread spectrum, a 127-chip pseudorandom code, and orthogonal MFSK symbols | 94.5 raw bit/s | Reliable at 2 m; often worked at 10 m | Correlation/spreading can trade spectral efficiency for resilience to multipath, motion, weak signal, and narrowband noise. The band is not guaranteed inaudible. |
| [High Data Rate NUSC](https://eurasip.org/Proceedings/Eusipco/Eusipco2021/pdfs/0001681.pdf) | 18–20 kHz, centered at 19 kHz | 2 ksymbol/s QPSK with phase-coherent adaptive decision-feedback equalization | 4 kbit/s | Up to 5 m between consumer laptops | Equalization and phase/timing tracking can recover orders of magnitude more throughput from the same narrow channel. The paper used 30% of symbols for training. The band conflicts with a strict inaudibility requirement. |
| [HRCSS](https://doi.org/10.1109/TMC.2021.3051665) | 18–22 kHz | Multiple loosely orthogonal chirp carriers, channel probing, and rate adaptation | 500 bit/s at 10 m; 125 bit/s at 20 m | 10 m and 20 m endpoints | A probe/feedback handshake and adaptive chirp bandwidth can choose range over rate as conditions worsen. Its full band includes potentially audible frequencies. |
| [BatNet](https://arxiv.org/pdf/2008.00136) | 20–24 kHz | Coherent 8-PSK with preamble, phase-drift correction, and short error-correction blocks | 685.7 bit/s reported in its comparison | 6–8 m facing the speaker; possibly <1 m off-axis | A strict-ultrasonic phone link can cross a room, but calibration, orientation, movement, and phase tracking dominate. The top of its band is unusable at an exact 48 kHz Nyquist boundary in a browser implementation. |
| [Hush](https://doi.org/10.1109/JIOT.2018.2848099) | 17.528–20.930 kHz | 78-subcarrier OFDM with amplitude/phase modulation | 4.9 kbit/s effective | Ideal at 5–20 cm | OFDM can be fast on commodity phones at proximity range, but this result spends bandwidth below 20 kHz and does not demonstrate room-scale range. It also documents audible modulation artifacts and sample-rate mismatch. |
| [Chirp aerial acoustic modem](https://doi.org/10.1109/INFOCOM.2015.7218629) | 19.5–22.2 kHz | Up/down chirp binary orthogonal keying with matched filtering | 16 bit/s | Up to 25 m indoors | Chirp correlation is an excellent acquisition/range tool, but using one long chirp per data bit spends too much time-bandwidth product for SonicDrop’s payload. Use chirps for probing and synchronization before adopting them for every bit. |
| [UltraComm](https://doi.org/10.1007/978-3-030-38819-5_12) | 40 kHz AM carrier carrying 1.1–19.9 kHz OFDM baseband | 2-ASK OFDM exploiting microphone-circuit nonlinearity | 16.24 kbit/s at 20 cm; other devices 13–16 kbit/s | Primarily 20 cm; BER measured through 1 m | This is a useful research ceiling, not a browser-ready design: it used a signal generator and ultrasonic transducer array, and 40 kHz cannot be emitted by a 48 kHz Web Audio path. |

Two conclusions are especially important:

1. **Frequency choice alone does not produce both range and speed.** The 25 m chirp result is 16 bit/s; the 4.9 kbit/s OFDM result is measured at centimeters. HRCSS explicitly adapts between rate and range.
2. **The 4 kbit/s at 5 m result is the most compelling signal-processing direction**, but its success depends on the 18–20 kHz band and adaptive coherent equalization. SonicDrop should reproduce the method above 20 kHz and measure what performance remains rather than assuming the published number transfers unchanged.

## Recommended phased roadmap

### Phase 0: build a repeatable channel benchmark

Do this before replacing the modem. The current waveform is the control group.

- Record raw input and decoded outcomes at 0.25, 0.5, 1, 2, 3, 5, and 10 m.
- Test speaker-to-microphone orientations at 0°, 90°, and 180°, plus handheld movement.
- Include quiet room, reverberant room, office noise, and music/TV conditions.
- Cover current iOS Safari, Android Chrome, and desktop Chrome/Safari on a named device matrix.
- Capture per-frequency received power/noise, estimated clock/frequency offset, symbol confidence, corrected codewords, frame erasures, packet error rate, and end-to-end goodput.
- Measure audible by-products separately; never infer inaudibility from a spectrum plot alone.
- Define success before testing: for example, at least 99% verified completion for a 64-byte message over 100 trials, with p50 and p95 completion time reported.

This benchmark answers whether today’s range problem is primarily band response, synchronization, multipath, orientation, or coding.

### Phase 1: adaptive band probe and chirp acquisition

Keep the current 4-CPFSK body initially so improvements can be isolated.

1. Prepend a smooth linear or logarithmic chirp across a nominally ultrasonic candidate band, initially about 20.1–22.1 kHz.
2. At the receiver, use matched filtering for arrival detection and estimate frequency response, noise floor, clock offset, Doppler/frequency offset, and likely delay spread.
3. Divide the usable region into candidate tone banks and score each bank by minimum lane SNR, not average SNR. Avoid deep notches.
4. Support several profiles: robust (long symbol/stronger FEC), balanced, and fast (short symbol/higher order).
5. Add a half-duplex acoustic response so the receiver can report the chosen profile. HRCSS’s channel-probing frame and adaptation frame are a useful model. If return audio is not yet implemented, display the recommended profile for manual selection during experiments.
6. Preserve continuous phase and window every start, stop, and profile transition.

The default candidate bank should remain above 20 kHz. An experimental 18–20 kHz bank can quantify the range opportunity, but must be separately enabled and labeled as potentially audible.

### Phase 2: compare two higher-throughput physical layers

Do not jump straight to a single “final” modem. Implement both behind the same frame/link interface and compare on the Phase 0 matrix.

**A. Single-carrier coherent QPSK with adaptive equalization**

- Root-raised-cosine pulse shaping.
- A chirp/acquisition field followed by a known pilot/training sequence.
- Timing recovery, carrier-frequency/phase tracking, and a phase-coherent adaptive decision-feedback equalizer.
- Soft symbol likelihoods exposed to the FEC decoder.
- Start below the 2 ksymbol/s research result and increase only when measured packet error stays inside the target.

This is the highest-priority throughput experiment because the EUSIPCO system directly demonstrated 4 kbit/s at 5 m and explained why an equalizer is necessary in a frequency-selective, time-varying indoor channel.

**B. Adaptive chirp-spread or OFDM profile**

- For chirps, overlap orthogonal carriers rather than spending a complete wideband chirp on one bit; HRCSS is the relevant design reference.
- For OFDM, estimate every subcarrier from pilots, disable notched carriers, equalize per carrier, track common phase error, and choose modulation per subcarrier.
- Measure peak-to-average power ratio and audible intermodulation products. High-PAPR OFDM can clip or drive nonlinear phone speakers even when the digital peak is normalized.
- Size the cyclic prefix from measured delay spread. A blindly long guard interval can erase the expected throughput gain.

Single-carrier QPSK with a DFE is likely the cleaner first browser implementation. OFDM becomes attractive once channel estimation, clock-offset correction, and adaptive bit loading are stable.

### Phase 3: stronger FEC beyond the v3 interleaver

- Keep the v3 coded-bit interleaver across time and extend the same principle across frequency for future multicarrier modes.
- Replace per-byte Hamming with a code that can use soft decisions and correct bursts: a convolutional code, LDPC, or a practical short-block alternative selected by measured packet-error curves.
- Keep a CRC on independently retransmittable blocks and SHA-256 for final accidental-corruption detection.
- Make code rate adaptive. More parity is useful at distance; it is wasted airtime on a clean proximity link.
- Version the physical/profile parameters explicitly so an old receiver fails closed instead of mis-decoding a new waveform.

### Phase 4: recover erasures with ARQ or fountain symbols

For two-device transfers, use time-division half duplex:

1. sender transmits a short burst of numbered blocks;
2. receiver returns a compact acknowledgement bitmap and updated profile recommendation;
3. sender selectively repeats only missing blocks.

Selective-repeat ARQ is a better first step than replaying the whole transfer. Keep windows small enough that acknowledgement airtime and role-switch latency do not dominate. [RFC 3366](https://www.rfc-editor.org/rfc/rfc3366.html) gives protocol-design guidance for link ARQ.

For one-way broadcast, add systematic erasure coding across blocks. [RaptorQ, RFC 6330](https://www.rfc-editor.org/rfc/rfc6330.html), can generate additional repair symbols until a receiver has enough independent symbols to reconstruct an object. A simpler Reed–Solomon erasure layer may be easier for SonicDrop’s current 4 KB scale; benchmark both before adopting a larger dependency.

Do not raise the 4 KB product limit until a missed block can be recovered. Higher PHY speed improves time-on-air, but recovery semantics are what make a larger transfer dependable.

### Phase 5: encrypt and authenticate the transfer

An air gap is not confidentiality. Any microphone in range can record the waveform, and CRC-32/SHA-256 do not prove who sent it.

- Encrypt the logical envelope before FEC with an authenticated-encryption scheme such as AES-GCM.
- Bind protocol version, profile, transfer ID, block index/count, filename/MIME metadata, and a fresh transfer nonce as authenticated associated data.
- Establish a key with an authenticated bootstrap: a scanned receiver public key/QR, a pre-shared passphrase, or an acoustic ECDH exchange confirmed by a short authentication string shown on both devices.
- Use a unique nonce per key and transfer, cache recently accepted transfer nonces, and reject replay.
- Authenticate fountain/repair symbols or authenticate the reconstructed object before exposing it; malicious repair symbols can otherwise poison decoding.
- Treat speaker fingerprints as a heuristic signal, not cryptographic identity.

The [Web Cryptography specification](https://www.w3.org/TR/WebCryptoAPI/) defines browser primitives including ECDH/X25519, HKDF, AES-GCM, HMAC, and digital signatures. Choose the final suite from algorithms supported by the target browser matrix, and test interoperability rather than assuming every Level 2 algorithm is present everywhere.

### Phase 6: optimize only against measured goodput

Tune symbol rate, occupied bandwidth, pilot fraction, FEC rate, ARQ window, and transmit level together. The optimization target should be **verified application bytes per second at a defined completion probability and distance**, not raw symbol rate.

Publish a compatibility/range matrix with every release. Device-specific frequency response and orientation are intrinsic to the medium, so a single unqualified distance number would be misleading.

## Browser and Web Audio constraints

| Constraint | Why it matters | Implementation response |
| --- | --- | --- |
| 48 kHz gives a 24 kHz Nyquist limit | Filters and resamplers need transition room; a tone numerically below 24 kHz may still be suppressed or distorted. | Keep useful carriers comfortably below 24 kHz. Probe response instead of assuming 20–24 kHz is available. Never port BatNet’s complete 20–24 kHz band literally. |
| `AudioContext({sampleRate})` requests an exposed context rate | The Web Audio spec defines the requested context rate, but that value does not certify the analog speaker/microphone response or absence of OS resampling. | Continue checking `AudioContext.sampleRate`; also estimate actual sender/receiver clock offset from every preamble. |
| Media capture settings are constrained, not raw-hardware access | Browser/OS capture can apply echo cancellation, noise suppression, AGC, filtering, routing, or resampling. Defaults can differ by platform. | Request `echoCancellation`, `noiseSuppression`, and `autoGainControl` as `false`; inspect `getSupportedConstraints()`, track capabilities, and `getSettings()`; reject or downgrade when the path cannot preserve the band. |
| Microphone access is permissioned and secure-context-only | A receiver cannot passively start from arbitrary HTTP or without user consent. | Deploy only over HTTPS, start listening from a clear user action, and surface permission/device failures. |
| AudioWorklet renders in small real-time blocks | DSP must finish before the next render deadline, while long equalizers/FEC can exceed a worklet’s real-time budget. | Keep capture/mixing in AudioWorklet; move correlation, equalization, and decoding to a Worker or WebAssembly with bounded queues. Do not allocate heavily in the audio callback. |
| Sample clocks differ | Hush measured substantial sender/receiver mismatch; movement also creates phase/frequency drift at these short wavelengths. | Estimate timing and carrier offset in the preamble, track it through pilots, and resample or rotate phase continuously. |
| Built-in phone audio is directional | BatNet measured 6–8 m facing the speaker but potentially less than 1 m at other angles. | Give orientation guidance, visualize measured link quality, and adapt before bulk transmission. Do not market one distance without orientation conditions. |
| Bluetooth/headset paths often band-limit audio | A 48 kHz logical stream may arrive through a speech codec that removes near-ultrasound. | Prefer and identify the built-in speaker/microphone; fail clearly on known headset/Bluetooth routes. |
| Browser scheduling and lifecycle are not a radio MAC | Backgrounding, interruption, route changes, calls, and device sleep can stop or alter audio. | Treat `suspend`, track `ended`/`mute`, visibility, and route changes as link loss; resume only with explicit state recovery. |

Normative browser references: [Web Audio API](https://www.w3.org/TR/webaudio-1.0/), [Web Audio API 1.1 rendering model](https://www.w3.org/TR/webaudio-1.1/), and [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/).

## Recommended immediate experiment

The smallest experiment with the best information gain is:

1. retain the current frames, FEC, and 4-CPFSK body;
2. add a 20.1–22.1 kHz chirp plus a multitone calibration field;
3. test several four-tone banks between 20.1 and 22.1 kHz, several symbol lengths, and three coding rates;
4. have the receiver log per-bank SNR, delay spread proxy, frequency offset, frame confidence, and outcome;
5. run the Phase 0 matrix and compare verified completion probability and goodput with the current fixed band;
6. only then build the coherent QPSK/DFE prototype against the same benchmark.

This separates “the current fixed lanes miss the hardware sweet spot” from “the physical layer needs a different modulation.” It also creates the measurement and negotiation machinery every later protocol will need.

## Primary sources

### Acoustic communication

- Pascal Getreuer, Chet Gnegy, Richard F. Lyon, and Rif A. Saurous, **“Ultrasonic Communication Using Consumer Hardware,”** IEEE Transactions on Multimedia 20(6), 2018. [DOI](https://doi.org/10.1109/TMM.2017.2766049) · [author page](https://getreuer.info/papers/getreuer2018ultrasonic/)
- Gizem Tabak, Xintian Eddie Lin, and Andrew C. Singer, **“High Data Rate Near-Ultrasonic Communication with Consumer Devices,”** EUSIPCO 2021. [official proceedings PDF](https://eurasip.org/Proceedings/Eusipco/Eusipco2021/pdfs/0001681.pdf)
- Chao Cai, Zhe Chen, Jun Luo, Henglin Pu, Menglan Hu, and Rong Zheng, **“Boosting Chirp Signal Based Aerial Acoustic Communication under Dynamic Channel Conditions,”** IEEE Transactions on Mobile Computing 21(9), 2022. [DOI](https://doi.org/10.1109/TMC.2021.3051665)
- Almos Zarandy, Ilia Shumailov, and Ross Anderson, **“BatNet: Data Transmission Between Smartphones over Ultrasound,”** 2020. [author preprint](https://arxiv.org/pdf/2008.00136)
- Ed Novak, Zhuofan Tang, and Qun Li, **“Ultrasound Proximity Networking on Smart Mobile Devices for IoT Applications,”** IEEE Internet of Things Journal 6(1), 2019. [DOI](https://doi.org/10.1109/JIOT.2018.2848099) · [author manuscript](https://www.cs.wm.edu/~liqun/paper/iotj19.pdf)
- Hyewon Lee, Tae Hyun Kim, Jun Won Choi, and Sunghyun Choi, **“Chirp Signal-Based Aerial Acoustic Communication for Smart Devices,”** IEEE INFOCOM 2015. [DOI](https://doi.org/10.1109/INFOCOM.2015.7218629)
- Kwang Myung Jeon, Hong Kook Kim, and Myung J. Lee, **“Noncoherent Low-Frequency Ultrasonic Communication System with Optimum Symbol Length,”** International Journal of Distributed Sensor Networks, 2016. [DOI/full text](https://doi.org/10.1155/2016/9713180)
- Luke Deshotels, **“Inaudible Sound as a Covert Channel in Mobile Devices,”** USENIX WOOT 2014. [conference page and paper](https://www.usenix.org/conference/woot14/workshop-program/presentation/deshotels)
- Guoming Zhang, Xiaoyu Ji, Xinyan Zhou, Donglian Qi, and Wenyuan Xu, **“UltraComm: High-Speed and Inaudible Acoustic Communication,”** QShine 2019 proceedings, 2020. [DOI](https://doi.org/10.1007/978-3-030-38819-5_12) · [paper](https://eudl.eu/pdf/10.1007/978-3-030-38819-5_12)

### Hearing and audibility

- Lina Motlagh Zadeh et al., **“Extended High-Frequency Hearing Enhances Speech Perception in Noise,”** PNAS 116(47), 2019. [DOI](https://doi.org/10.1073/pnas.1903315116) · [full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC6876232/)
- Kaoru Ashihara, Kenji Kurakata, Tazu Mizunami, and Kazuma Matsushita, **“Hearing Threshold for Pure Tones Above 20 kHz,”** Acoustical Science and Technology 27(1), 2006. [DOI/full text](https://doi.org/10.1250/ast.27.12)

### Browser and link-layer standards

- W3C, [Web Audio API](https://www.w3.org/TR/webaudio-1.0/) and [Web Audio API 1.1](https://www.w3.org/TR/webaudio-1.1/).
- W3C, [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/).
- W3C, [Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/).
- IETF, [RFC 3366: Advice to Link Designers on Link ARQ](https://www.rfc-editor.org/rfc/rfc3366.html).
- IETF, [RFC 6330: RaptorQ Forward Error Correction Scheme for Object Delivery](https://www.rfc-editor.org/rfc/rfc6330.html).
