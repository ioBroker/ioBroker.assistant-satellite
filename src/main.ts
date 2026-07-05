import { Adapter, getAbsoluteInstanceDataDir, type AdapterOptions } from '@iobroker/adapter-core';
import { Satellite, loadConfig, probeWakeWord, type SatelliteState } from '@iobroker/assistant-satellite';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Built-in wake words shipped as ONNX by the satellite package (mirrors its `WAKEWORDS`). */
const BUILTIN_WAKEWORDS = ['hey_jarvis', 'alexa', 'hey_mycroft', 'hey_rhasspy'];
/** Support files that live next to the wake-word models but are not wake words themselves. */
const MODEL_SUPPORT_FILES = ['melspectrogram.onnx', 'embedding_model.onnx'];

/** An option for an `autocompleteSendTo` field. */
interface DeviceOption {
    label: string;
    value: string;
}

/** Payload of the `testWakeWord` sendTo — the (possibly unsaved) form values needed for the probe. */
interface WakeTestMsg {
    seconds?: number | string;
    micDevice?: string;
    audioBackend?: string;
    wakewordModel?: string;
    wakewordThreshold?: number | string;
}

/** Result of `testWakeWord`: structured fields (for a localized GUI message) + an English fallback string. */
interface WakeTestResult {
    error?: string;
    /** English fallback / log line. */
    result?: string;
    detected?: boolean;
    peakScore?: number;
    threshold?: number;
    micLevel?: number;
    frames?: number;
    /** Mic level was near-silent — hint to check the device. */
    lowLevel?: boolean;
}

/** Adapter settings (mirrors io-package.json `native`). */
interface AdapterConfig {
    /** Selected ioBroker.assistant instance, e.g. "assistant.0". */
    assistantInstance: string;
    /** Force a specific adapter IP (overrides the resolved one). */
    hostOverride: string;
    room: string;
    /** Local UDP port the satellite receives TTS on (named `port` so admin shows it as a used resource). */
    port: number;
    audioBackend: 'auto' | 'alsa' | 'ffmpeg';
    micDevice: string;
    speakerDevice: string;
    wakewordModel: string;
    wakewordThreshold: number;
    silenceThreshold: number;
    silenceMs: number;
    minRecordMs: number;
    maxRecordMs: number;
    preBufferChunks: number;
}

const ipToInt = (ip: string): number => ip.split('.').reduce((acc, o) => (acc << 8) + (Number(o) & 0xff), 0) >>> 0;

/** True if two IPv4 addresses share the network under `netmask`. */
function sameSubnet(a: string, b: string, netmask: string): boolean {
    const m = ipToInt(netmask);
    return (ipToInt(a) & m) === (ipToInt(b) & m);
}

class AssistantSatellite extends Adapter {
    declare config: AdapterConfig;
    private satellite: Satellite | null = null;

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({ ...options, name: 'assistant-satellite' });
        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /** Writable instance data dir (models download here). */
    private instanceDataDir(): string {
        return getAbsoluteInstanceDataDir(this);
    }

    private async onReady(): Promise<void> {
        const c = this.config;
        const { host, port } = await this.resolveAssistant();
        if (!host) {
            this.log.warn('No assistant selected — pick an ioBroker.assistant instance in the settings.');
        } else {
            this.log.info(`ioBroker.assistant → ${host}:${port} (instance ${c.assistantInstance || '-'}).`);
        }

        const cfg = loadConfig({
            logLevel: this.log.level === 'debug' || this.log.level === 'silly' ? 'debug' : 'info',
            device: this.namespace.replace('.', '-'), // e.g. assistant-satellite-0
            room: c.room || '',
            host,
            port,
            listenPort: c.port || 7776,
            audioBackend: c.audioBackend || 'auto',
            micDevice: c.micDevice || 'default',
            speakerDevice: c.speakerDevice || 'default',
            wakewordModel: c.wakewordModel || 'hey_jarvis',
            wakewordThreshold: c.wakewordThreshold || 0.5,
            modelsDir: path.join(this.instanceDataDir(), 'models'),
            silenceThreshold: c.silenceThreshold || 300,
            silenceMs: c.silenceMs || 800,
            minRecordMs: c.minRecordMs || 800,
            maxRecordMs: c.maxRecordMs || 8000,
            preBufferChunks: c.preBufferChunks ?? 5,
        });

        this.satellite = new Satellite(cfg, {
            log: this.log,
            onStatus: (state: SatelliteState) => {
                this.setState('status', { val: state, ack: true }).catch(e =>
                    this.log.error(`Cannot set status: ${e}`),
                );
            },
        });

        try {
            await this.satellite.start();
            await this.setState('info.connection', { val: true, ack: true });
        } catch (e) {
            this.log.error(`Could not start satellite: ${(e as Error).message}`);
            await this.setState('info.connection', { val: false, ack: true });
        }
    }

    /**
     * GUI "Test wake word": listen on the mic for `seconds` and report whether the wake word was
     * detected (peak score + level). Uses the (unsaved) form values passed in `msg`, falling back to the
     * saved config, so the test works without saving. Pauses the running satellite and restarts it after.
     */
    private async testWakeWord(msg: WakeTestMsg): Promise<WakeTestResult> {
        const c = this.config;
        const seconds = Number(msg.seconds) || 15;
        const cfg = loadConfig({
            device: this.namespace.replace('.', '-'),
            audioBackend: ((msg.audioBackend || c.audioBackend || 'auto').trim() || 'auto') as
                'auto' | 'alsa' | 'ffmpeg',
            micDevice: (msg.micDevice || '').trim() || c.micDevice || 'default',
            wakewordModel: (msg.wakewordModel || '').trim() || c.wakewordModel || 'hey_jarvis',
            wakewordThreshold: Number(msg.wakewordThreshold) || c.wakewordThreshold || 0.5,
            modelsDir: path.join(this.instanceDataDir(), 'models'),
        });
        const wasRunning = !!this.satellite;
        try {
            if (this.satellite) {
                this.log.info('Pausing satellite for the wake-word test …');
                await this.satellite.stop();
                this.satellite = null;
                await new Promise(r => setTimeout(r, 300)); // let ALSA fully release the mic before re-opening
            }
            await this.setState('test.detected', { val: false, ack: true });
            await this.setState('test.running', { val: true, ack: true });
            this.log.info(`Wake-word test: listening ${seconds} s — say the wake word now …`);
            const res = await probeWakeWord(cfg, this.log, seconds, (score, rms, detected) => {
                // Live values for the interactive GUI meter.
                this.setState('test.score', { val: Math.round(score * 1000) / 1000, ack: true }).catch(() => {});
                this.setState('test.micLevel', { val: Math.round(rms), ack: true }).catch(() => {});
                if (detected) {
                    this.setState('test.detected', { val: true, ack: true }).catch(() => {});
                }
            });
            await this.setState('test.peakScore', { val: Math.round(res.peakScore * 1000) / 1000, ack: true });
            await this.setState('test.detected', { val: res.detected, ack: true });
            const hint =
                res.peakRms < 200
                    ? ' Mic level very low — check the microphone device.'
                    : res.detected
                      ? ''
                      : ' Try lowering the threshold or speaking closer.';
            const message = res.detected
                ? `Wake word DETECTED — peak score ${res.peakScore.toFixed(2)} (threshold ${res.threshold}), mic level ${res.peakRms.toFixed(0)}.`
                : `NOT detected — peak score ${res.peakScore.toFixed(2)} (threshold ${res.threshold}), mic level ${res.peakRms.toFixed(0)}, ${res.frames} frames.${hint}`;
            this.log.info(`Wake-word test result: ${message}`);
            // Structured fields so the admin GUI can render a localized message; `result` = English fallback.
            return {
                result: message,
                detected: res.detected,
                peakScore: Math.round(res.peakScore * 100) / 100,
                threshold: res.threshold,
                micLevel: Math.round(res.peakRms),
                frames: res.frames,
                lowLevel: res.peakRms < 200,
            };
        } catch (e) {
            return { error: (e as Error).message };
        } finally {
            await this.setState('test.running', { val: false, ack: true }).catch(() => {});
            if (wasRunning) {
                try {
                    await this.onReady(); // rebuild + restart the satellite
                } catch (e) {
                    this.log.error(`Could not restart satellite after test: ${(e as Error).message}`);
                }
            }
        }
    }

    /**
     * Resolve the target address of the selected assistant instance:
     *  - hostOverride wins;
     *  - a specific bind address on the assistant is used as-is;
     *  - '0.0.0.0' → 127.0.0.1 if the assistant runs on this host, else the assistant host's IP that
     *    shares a subnet with one of ours (so it is reachable over the LAN).
     */
    private async resolveAssistant(): Promise<{ host: string; port: number }> {
        const c = this.config;
        let port = 7775;
        let bind = '0.0.0.0';
        let assistantHost = '';
        if (c.assistantInstance) {
            try {
                const obj = await this.getForeignObjectAsync(`system.adapter.${c.assistantInstance}`);
                const native = (obj?.native || {}) as {
                    port?: number;
                    voicePort?: number;
                    bind?: string;
                    voiceBindAddress?: string;
                };
                port = Number(native.port ?? native.voicePort) || 7775;
                bind = String(native.bind || native.voiceBindAddress || '0.0.0.0');
                assistantHost = (obj?.common as { host?: string } | undefined)?.host || '';
            } catch (e) {
                this.log.warn(`Cannot read ${c.assistantInstance}: ${(e as Error).message}`);
            }
        }

        const override = (c.hostOverride || '').trim();
        if (override) {
            return { host: override, port };
        }
        if (bind && bind !== '0.0.0.0') {
            return { host: bind, port };
        }
        if (assistantHost && assistantHost === this.host) {
            return { host: '127.0.0.1', port };
        }
        return { host: (await this.resolveHostIp(assistantHost)) || '127.0.0.1', port };
    }

    /** Find the assistant host's IPv4 that shares a subnet with one of this host's interfaces. */
    private async resolveHostIp(hostName: string): Promise<string> {
        if (!hostName) {
            return '';
        }
        const remote: { address: string; netmask: string }[] = [];
        try {
            const obj = await this.getForeignObjectAsync(`system.host.${hostName}`);
            const ifaces = (obj?.native as { hardware?: { networkInterfaces?: Record<string, unknown[]> } })?.hardware
                ?.networkInterfaces;
            for (const list of Object.values(ifaces || {})) {
                for (const i of (list || []) as {
                    address?: string;
                    netmask?: string;
                    family?: string | number;
                    internal?: boolean;
                }[]) {
                    if (!i.internal && (i.family === 'IPv4' || i.family === 4) && i.address && i.netmask) {
                        remote.push({ address: i.address, netmask: i.netmask });
                    }
                }
            }
        } catch (e) {
            this.log.debug(`resolveHostIp(${hostName}): ${(e as Error).message}`);
        }
        if (!remote.length) {
            return '';
        }
        const local: string[] = [];
        for (const list of Object.values(os.networkInterfaces())) {
            for (const i of list || []) {
                if (!i.internal && i.family === 'IPv4') {
                    local.push(i.address);
                }
            }
        }
        for (const r of remote) {
            if (local.some(l => sameSubnet(l, r.address, r.netmask))) {
                return r.address;
            }
        }
        return remote[0].address; // fallback: first IPv4 of the assistant host
    }

    /** Admin config message handler (autocomplete/dropdown data sources). */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (obj?.command === 'getMicDevices' || obj?.command === 'getSpeakerDevices') {
            const kind = obj.command === 'getMicDevices' ? 'mic' : 'speaker';
            const backend = (obj.message as { backend?: string } | undefined)?.backend || 'auto';
            const options = await this.listAudioDevices(kind, backend);
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, options, obj.callback);
            }
            return;
        }
        if (obj?.command === 'getWakewords') {
            const options = await this.listWakewords();
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, options, obj.callback);
            }
            return;
        }
        if (obj?.command === 'testWakeWord') {
            const result = await this.testWakeWord((obj.message || {}) as WakeTestMsg);
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
            }
            return;
        }
        if (obj?.command === 'getAssistantInstances') {
            const options: { label: string; value: string }[] = [];
            try {
                const view = await this.getObjectViewAsync('system', 'instance', {
                    startkey: 'system.adapter.assistant.',
                    endkey: 'system.adapter.assistant.香',
                });
                for (const row of view.rows) {
                    // Exclude other adapters that merely start with "assistant" (e.g. this one).
                    const id = row.id.replace('system.adapter.', '');
                    if (/^assistant\.\d+$/.test(id)) {
                        const host = (row.value?.common as { host?: string } | undefined)?.host || '?';
                        options.push({ label: `${id} (host: ${host})`, value: id });
                    }
                }
            } catch (e) {
                this.log.warn(`getAssistantInstances failed: ${(e as Error).message}`);
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, options, obj.callback);
            }
        }
    }

    /** Resolve 'auto' → alsa on Linux, ffmpeg elsewhere (mirrors the satellite's `resolveBackend`). */
    private effectiveBackend(pref: string): 'alsa' | 'ffmpeg' {
        if (pref === 'alsa' || pref === 'ffmpeg') {
            return pref;
        }
        return process.platform === 'linux' ? 'alsa' : 'ffmpeg';
    }

    /**
     * Run a listing CLI and return combined stdout+stderr. `arecord`/`ffmpeg` print their device list to
     * stderr and exit non-zero, so a non-zero exit is not treated as failure — only a missing binary is.
     */
    private async runCli(cmd: string, args: string[]): Promise<string> {
        try {
            const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 5000 });
            return `${stdout}\n${stderr}`;
        } catch (e) {
            const err = e as { stdout?: string; stderr?: string; code?: string };
            if (err.code === 'ENOENT') {
                throw new Error(`${cmd} is not installed`);
            }
            return `${err.stdout || ''}\n${err.stderr || ''}`;
        }
    }

    /** Parse `arecord -l` / `aplay -l` into `plughw:card,device` options. */
    private parseAlsaDevices(output: string): DeviceOption[] {
        const options: DeviceOption[] = [];
        const re = /^card (\d+):\s*(.+?)\s*\[(.+?)],\s*device (\d+):\s*(.+?)\s*\[(.+?)]/;
        for (const line of output.split('\n')) {
            const m = re.exec(line.trim());
            if (m) {
                const value = `plughw:${m[1]},${m[4]}`;
                options.push({ value, label: `${value} — ${m[3]}` });
            }
        }
        return options;
    }

    /** Parse `ffmpeg -list_devices` dshow output (Windows) into audio-input device names. */
    private parseDshowDevices(output: string): DeviceOption[] {
        const lines = output.split('\n');
        const options: DeviceOption[] = [];
        // Newer ffmpeg tags each line: `"Mic (Realtek)" (audio)`.
        for (const line of lines) {
            const m = /"([^"]+)"\s*\(audio\)/.exec(line);
            if (m) {
                options.push({ value: m[1], label: m[1] });
            }
        }
        if (options.length) {
            return options;
        }
        // Older ffmpeg: an "audio devices" section header, then quoted names (skip "Alternative name").
        let inAudio = false;
        for (const line of lines) {
            if (/audio devices/i.test(line)) {
                inAudio = true;
                continue;
            }
            if (/video devices/i.test(line)) {
                inAudio = false;
                continue;
            }
            if (!inAudio || /Alternative name/i.test(line)) {
                continue;
            }
            const m = /"([^"]+)"/.exec(line);
            if (m) {
                options.push({ value: m[1], label: m[1] });
            }
        }
        return options;
    }

    /** Parse `ffmpeg -f avfoundation -list_devices` output (macOS); the value is the device index. */
    private parseAvfoundationDevices(output: string): DeviceOption[] {
        const options: DeviceOption[] = [];
        let inAudio = false;
        for (const line of output.split('\n')) {
            if (/audio devices/i.test(line)) {
                inAudio = true;
                continue;
            }
            if (/video devices/i.test(line)) {
                inAudio = false;
                continue;
            }
            if (!inAudio) {
                continue;
            }
            const m = /\[(\d+)]\s*(.+)$/.exec(line);
            if (m) {
                options.push({ value: m[1], label: `[${m[1]}] ${m[2].trim()}` });
            }
        }
        return options;
    }

    /**
     * List microphone / speaker devices available on this host via CLI, honouring the chosen backend.
     * Always offers 'default' first; the field is freeSolo so anything can still be typed by hand.
     */
    private async listAudioDevices(kind: 'mic' | 'speaker', backendPref: string): Promise<DeviceOption[]> {
        const backend = this.effectiveBackend(backendPref);
        const options: DeviceOption[] = [{ value: 'default', label: 'default (system default)' }];
        try {
            if (backend === 'alsa') {
                const tool = kind === 'mic' ? 'arecord' : 'aplay';
                options.push(...this.parseAlsaDevices(await this.runCli(tool, ['-l'])));
            } else if (process.platform === 'win32') {
                // dshow enumerates capture devices only; there is no CLI playback-device list.
                if (kind === 'mic') {
                    const out = await this.runCli('ffmpeg', [
                        '-hide_banner',
                        '-list_devices',
                        'true',
                        '-f',
                        'dshow',
                        '-i',
                        'dummy',
                    ]);
                    options.push(...this.parseDshowDevices(out));
                }
            } else if (process.platform === 'darwin') {
                // avfoundation enumerates capture devices only.
                if (kind === 'mic') {
                    const out = await this.runCli('ffmpeg', [
                        '-hide_banner',
                        '-f',
                        'avfoundation',
                        '-list_devices',
                        'true',
                        '-i',
                        '',
                    ]);
                    options.push(...this.parseAvfoundationDevices(out));
                }
            } else {
                // ffmpeg on Linux uses ALSA device names — reuse the ALSA listing.
                const tool = kind === 'mic' ? 'arecord' : 'aplay';
                options.push(...this.parseAlsaDevices(await this.runCli(tool, ['-l'])));
            }
        } catch (e) {
            this.log.warn(`Cannot list ${kind} devices (${backend}): ${(e as Error).message}`);
        }
        return options;
    }

    /** List selectable wake words: the built-in ONNX models plus any local `.onnx` in the models dir. */
    private async listWakewords(): Promise<DeviceOption[]> {
        const options: DeviceOption[] = BUILTIN_WAKEWORDS.map(v => ({ value: v, label: `${v} (built-in)` }));
        try {
            const dir = path.join(this.instanceDataDir(), 'models');
            for (const file of await fs.readdir(dir)) {
                if (file.endsWith('.onnx') && !MODEL_SUPPORT_FILES.includes(file)) {
                    options.push({ value: path.join(dir, file), label: `${file} (local)` });
                }
            }
        } catch {
            // models dir may not exist yet — built-ins are enough
        }
        return options;
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            await this.satellite?.stop();
            await this.setState('info.connection', { val: false, ack: true });
        } catch {
            // ignore
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<AdapterOptions> | undefined) => new AssistantSatellite(options);
} else {
    (() => new AssistantSatellite())();
}
