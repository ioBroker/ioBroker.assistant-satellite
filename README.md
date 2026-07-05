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

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
* (@GermanBluefox) Initial commit

## License

MIT License

Copyright (c) 2026 Denis Haev <dogafox@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

