<img src="admin/assistant-satellite.svg" alt="ioBroker.assistant" width="200"/>

# ioBroker.assistant-satellite

An ioBroker adapter that turns the host it runs on into a **voice satellite** for
[`ioBroker.assistant`](https://github.com/ioBroker/ioBroker.assistant): it detects the wake word,
streams the microphone to the assistant's voice server and plays the spoken reply.

It is a thin wrapper around the standalone [`@iobroker/assistant-satellite`](https://github.com/ioBroker/assistant-satellite)
package — use this adapter when the satellite device already runs ioBroker (config + status via the
admin UI). On a bare Pi without ioBroker, use the standalone package directly
(`npx @iobroker/assistant-satellite`).

## Requirements

- A mic + speaker on the host
- Audio backend (auto-selected): **Linux** → `alsa-utils` (`arecord`/`aplay`); **Windows/macOS** → `ffmpeg`
- A running `ioBroker.assistant` instance with the Voice server enabled

## Setup

Install the adapter, add an instance, then in its settings:

- **Adapter host** — IP of the `ioBroker.assistant` host (`127.0.0.1` if the same box), port `7775`
- **Microphone / speaker device** — e.g. `plughw:2,0` on a Pi (`arecord -l` to list)
- **Wake word** — `hey_jarvis` (default), `alexa`, `hey_mycroft`, `hey_rhasspy`, or a custom `.onnx`

On first start the OpenWakeWord models download into the instance data dir. Then say the wake word →
speak → the answer is played back. The `status` state shows `idle` / `listening` / `processing` / `speaking`.

## License

MIT © ioBroker
