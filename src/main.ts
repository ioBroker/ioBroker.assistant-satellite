import { Adapter, getAbsoluteInstanceDataDir, type AdapterOptions } from '@iobroker/adapter-core';
import {
    Satellite,
    LocalListener,
    loadConfig,
    probeWakeWord,
    type SatelliteState,
} from '@iobroker/assistant-satellite';
// playPcm isn't re-exported from the package index (yet) — deep-import it (no `exports` map restricts this).
import { playPcm } from '@iobroker/assistant-satellite/build/audio';
import { execFile, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Built-in wake words shipped as ONNX by the satellite package (mirrors its `WAKEWORDS`). */
const BUILTIN_WAKEWORDS = ['hey_jarvis', 'alexa', 'hey_mycroft', 'hey_rhasspy'];
/**
 * Custom wake words shipped with the adapter (ONNX in `models/`). name → file; the external `.onnx.data`
 *  weights sit next to it and are resolved automatically by onnxruntime.
 */
const BUNDLED_WAKEWORDS: Record<string, string> = { io_broker: 'io_broker.onnx' };
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
    wakewordModel2?: string;
    wakewordModel3?: string;
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
    /** Transport to the assistant: 'udp' = Hannah audio stream; 'ioBroker' = audio blobs over sendTo (no UDP). */
    transport: 'udp' | 'ioBroker';
    /** Force a specific adapter IP (overrides the resolved one). */
    hostOverride: string;
    room: string;
    /** Local UDP port the satellite receives TTS on (named `port` so admin shows it as a used resource). */
    port: number;
    audioBackend: 'auto' | 'alsa' | 'ffmpeg';
    micDevice: string;
    speakerDevice: string;
    /** ALSA mixer simple-control for volume/mute ('' = auto-detect on the speaker's card). */
    mixerControl: string;
    wakewordModel: string;
    /** Optional additional wake words — the satellite triggers on any of them. */
    wakewordModel2: string;
    wakewordModel3: string;
    /** Last file picked in the upload widget (uploads land in the instance meta storage). */
    wakewordUpload: string;
    wakewordThreshold: number;
    silenceThreshold: number;
    silenceMs: number;
    minRecordMs: number;
    maxRecordMs: number;
    preBufferChunks: number;
    /** Follow-up conversation mode: keep the mic open after a reply (no wake word needed). */
    followUp: boolean;
    /** Seconds to wait for a follow-up before returning to wake-word mode. */
    followUpSeconds: number;
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
    /** ioBroker-transport listener (no UDP); used when transport = 'ioBroker'. */
    private localListener: LocalListener | null = null;
    /** Heartbeat timer that keeps the satellite registered/alive on the assistant (ioBroker transport). */
    private heartbeat: ioBroker.Interval | null = null;
    /** Currently playing announcement (so a new one / barge-in can stop it). */
    private announcePlayback: { proc: ChildProcess } | null = null;
    /** Cached ALSA mixer simple-control name (auto-detected once). */
    private mixerControlCache: string | null = null;

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({ ...options, name: 'assistant-satellite' });
        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /** Writable instance data dir (models download here). */
    private instanceDataDir(): string {
        return getAbsoluteInstanceDataDir(this);
    }

    /**
     * Copy user-uploaded `.onnx` models from the instance meta storage (jsonConfig upload widget) to the
     * filesystem models dir, so the core lib can load them by path, and they appear in the wake-word
     * dropdown (`listWakewords` scans that dir). Idempotent — overwrites to pick up re-uploads.
     */
    private async syncUploadedModels(): Promise<void> {
        const dir = path.join(this.instanceDataDir(), 'models');
        let entries: { file: string; isDir: boolean }[];
        try {
            entries = await this.readDirAsync(this.namespace, '');
        } catch {
            return; // nothing uploaded yet
        }
        const models = entries.filter(e => !e.isDir && e.file.endsWith('.onnx'));
        if (!models.length) {
            return;
        }
        await fs.mkdir(dir, { recursive: true });
        for (const e of models) {
            try {
                const res = await this.readFileAsync(this.namespace, e.file);
                const data =
                    res && typeof res === 'object' && 'file' in res
                        ? (res as { file: Buffer | string }).file
                        : (res as unknown as Buffer | string);
                await fs.writeFile(path.join(dir, e.file), Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary'));
                this.log.debug(`Synced uploaded wake-word model: ${e.file}`);
            } catch (err) {
                this.log.warn(`Could not sync uploaded model ${e.file}: ${(err as Error).message}`);
            }
        }
    }

    // ── Volume / mute via the ALSA mixer of the speaker's card (ALSA backend only) ───────────────────

    /** ALSA card number from the speaker device (`plughw:2,0` → "2"); null → default card. */
    private mixerCard(): string | null {
        const m = (this.config.speakerDevice || '').trim().match(/^(?:plug)?hw:(\d+)/i);
        return m ? m[1] : null;
    }

    /** The mixer simple-control to drive: config override, else the first sensible playback control. */
    private async detectMixerControl(card: string | null): Promise<string | null> {
        if (this.config.mixerControl?.trim()) {
            return this.config.mixerControl.trim();
        }
        if (this.mixerControlCache) {
            return this.mixerControlCache;
        }
        try {
            const { stdout } = await execFileAsync('amixer', [...(card ? ['-c', card] : []), 'scontrols']);
            const names = [...stdout.matchAll(/Simple mixer control '([^']+)'/g)].map(x => x[1]);
            const preferred = ['Master', 'PCM', 'Speaker', 'Headphone', 'Playback'];
            this.mixerControlCache = preferred.find(p => names.includes(p)) || names[0] || null;
        } catch {
            this.mixerControlCache = null;
        }
        return this.mixerControlCache;
    }

    /** Push the persisted volume/mute states to the ALSA mixer. */
    private async applyVolume(): Promise<void> {
        if (this.config.audioBackend === 'ffmpeg') {
            return; // amixer is ALSA-only
        }
        const card = this.mixerCard();
        const control = await this.detectMixerControl(card);
        if (!control) {
            this.log.debug('No ALSA mixer control found — volume control unavailable on this device.');
            return;
        }
        const vol = Math.max(0, Math.min(100, Math.round(Number((await this.getStateAsync('volume'))?.val ?? 100))));
        const muted = !!(await this.getStateAsync('mute'))?.val;
        try {
            await execFileAsync('amixer', [
                ...(card ? ['-c', card] : []),
                'sset',
                control,
                `${vol}%`,
                muted ? 'mute' : 'unmute',
            ]);
            this.log.debug(`Volume set: ${control} ${vol}%${muted ? ' (muted)' : ''}`);
        } catch (e) {
            this.log.warn(`amixer failed for control '${control}': ${(e as Error).message}`);
        }
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            return; // only react to user/program writes
        }
        if (id.endsWith('.volume') || id.endsWith('.mute')) {
            // Confirm the write, then push it to the mixer.
            await this.setStateAsync(id.endsWith('.mute') ? 'mute' : 'volume', { val: state.val, ack: true });
            await this.applyVolume();
        }
    }

    /**
     * Resolve a wake-word value for the core lib: a bundled name → its shipped file path; a built-in
     *  openWakeWord name / URL / local path passes through unchanged.
     */
    private resolveWakeword(name: string): string {
        const file = BUNDLED_WAKEWORDS[name];
        return file ? path.join(__dirname, '..', 'models', file) : name;
    }

    /** Combine the up-to-three wake-word fields into the comma-separated list the core lib parses. */
    private joinWakewords(c: AdapterConfig): string {
        const list = [c.wakewordModel, c.wakewordModel2, c.wakewordModel3]
            .map(s => (s || '').trim())
            .filter(Boolean)
            .map(w => this.resolveWakeword(w));
        return list.length ? list.join(',') : 'hey_jarvis';
    }

    /** Wake-word list for a test: the (unsaved) form fields if present, else the saved config. */
    private joinTestWakewords(msg: WakeTestMsg, c: AdapterConfig): string {
        const fromMsg = [msg.wakewordModel, msg.wakewordModel2, msg.wakewordModel3]
            .map(s => (s || '').trim())
            .filter(Boolean)
            .map(w => this.resolveWakeword(w));
        return fromMsg.length ? fromMsg.join(',') : this.joinWakewords(c);
    }

    /** Build the core-lib config shared by the UDP satellite and the local listener. */
    private buildCoreConfig(host: string, port: number): ReturnType<typeof loadConfig> {
        const c = this.config;
        return loadConfig({
            logLevel: this.log.level === 'debug' || this.log.level === 'silly' ? 'debug' : 'info',
            device: this.namespace.replace('.', '-'),
            room: c.room || '',
            host,
            port,
            listenPort: c.port || 7776,
            audioBackend: c.audioBackend || 'auto',
            micDevice: c.micDevice || 'default',
            speakerDevice: c.speakerDevice || 'default',
            wakewordModel: this.joinWakewords(c),
            wakewordThreshold: c.wakewordThreshold || 0.5,
            modelsDir: path.join(this.instanceDataDir(), 'models'),
            silenceThreshold: c.silenceThreshold || 300,
            silenceMs: c.silenceMs || 800,
            minRecordMs: c.minRecordMs || 800,
            maxRecordMs: c.maxRecordMs || 8000,
            preBufferChunks: c.preBufferChunks ?? 5,
            followUp: !!c.followUp,
            followUpWindowMs: (c.followUpSeconds || 6) * 1000,
            maxFollowUps: 4,
        });
    }

    /**
     * ioBroker transport: local wake-word + record, send the utterance to the assistant over the message
     * bus (`voice` sendTo), play back the returned reply. No UDP, STT/TTS stay central on the assistant.
     */
    private async startLocalListener(): Promise<void> {
        const cfg = this.buildCoreConfig('', 0); // host/port unused in this mode
        this.localListener = new LocalListener(cfg, {
            log: this.log,
            onStatus: (state: SatelliteState) => {
                this.setState('status', { val: state, ack: true }).catch(e =>
                    this.log.error(`Cannot set status: ${e}`),
                );
            },
            onUtterance: (pcm, sampleRate) => this.queryAssistant(pcm, sampleRate),
        });
        try {
            await this.localListener.start();
            await this.setState('info.connection', { val: true, ack: true });
        } catch (e) {
            this.log.error(`Could not start local listener: ${(e as Error).message}`);
            await this.setState('info.connection', { val: false, ack: true });
        }
    }

    /** Send a recorded utterance to the assistant and return the reply audio to play, or null. */
    private async queryAssistant(
        pcm: Buffer,
        sampleRate: number,
    ): Promise<{ pcm: Buffer; sampleRate: number; listen?: boolean } | null> {
        const inst = this.config.assistantInstance;
        if (!inst) {
            this.log.warn('No assistant instance selected — cannot send the query.');
            return null;
        }
        try {
            const res = (await this.sendToAsync(inst, 'voice', {
                audio: pcm.toString('base64'),
                format: 'pcm',
                sampleRate,
                source: this.namespace.replace('.', '-'),
                room: this.config.room || '',
            })) as {
                text?: string;
                answer?: string;
                audio?: string;
                sampleRate?: number;
                listen?: boolean;
                error?: string;
            };
            if (res?.error) {
                this.log.warn(`Assistant error: ${res.error}`);
                return null;
            }
            if (res?.text) {
                this.log.info(`Q: ${res.text}`);
            }
            if (res?.answer) {
                this.log.info(`A: ${res.answer}`);
            }
            // The assistant asks us to keep listening (it asked a question) → open the mic for the answer.
            if (res?.listen) {
                this.log.info('Mic ON — assistant is waiting for an answer (opening mic, no wake word needed).');
            }
            if (res?.audio) {
                return {
                    pcm: Buffer.from(res.audio, 'base64'),
                    sampleRate: res.sampleRate || 24000,
                    listen: !!res.listen,
                };
            }
            return null;
        } catch (e) {
            this.log.error(`Assistant query failed: ${(e as Error).message}`);
            return null;
        }
    }

    /** Register/heartbeat with the assistant (ioBroker transport) so it lists us and can push announcements. */
    private registerWithAssistant(state: SatelliteState | 'offline'): void {
        const inst = this.config.assistantInstance;
        if (!inst) {
            return;
        }
        this.sendTo(inst, 'registerSatellite', {
            device: this.namespace.replace('.', '-'),
            room: this.config.room || '',
            state,
        });
    }

    /** Play a pushed announcement (`announce` message from the assistant): raw 16-bit mono PCM (base64). */
    private async playAnnouncement(msg: { audio?: string; sampleRate?: number; priority?: boolean }): Promise<void> {
        if (!msg?.audio) {
            return;
        }
        // Do-Not-Disturb suppresses pushed announcements — except priority ones (text started with "!").
        if (!msg.priority && (await this.getStateAsync('dnd'))?.val) {
            this.log.debug('Announcement suppressed (Do-Not-Disturb).');
            return;
        }
        try {
            // Stop any announcement already playing so the newest one wins.
            this.announcePlayback?.proc.kill('SIGKILL');
            const pcm = Buffer.from(msg.audio, 'base64');
            const backend = this.effectiveBackend(this.config.audioBackend || 'auto');
            const device = this.config.speakerDevice || 'default';
            await this.setState('status', { val: 'speaking', ack: true }).catch(() => {});
            const { proc, done } = playPcm(pcm, msg.sampleRate || 24000, backend, device, this.log);
            this.announcePlayback = { proc };
            await done;
        } catch (e) {
            this.log.warn(`Announcement playback failed: ${(e as Error).message}`);
        } finally {
            this.announcePlayback = null;
            await this.setState('status', { val: 'idle', ack: true }).catch(() => {});
        }
    }

    private async onReady(): Promise<void> {
        const c = this.config;
        await this.syncUploadedModels(); // materialize any uploaded .onnx models to the FS models dir
        // Volume/mute drive the ALSA mixer of the speaker's card — apply the persisted value on start.
        await this.subscribeStatesAsync('volume');
        await this.subscribeStatesAsync('mute');
        await this.applyVolume();
        if ((c.transport || 'ioBroker') === 'ioBroker') {
            this.log.info(`ioBroker transport → assistant '${c.assistantInstance || '-'}' (no UDP).`);
            await this.startLocalListener();
            // Register with the assistant so we show up under assistant.0.satellites and can receive
            // pushed announcements; refresh periodically as a heartbeat.
            this.registerWithAssistant('idle');
            this.heartbeat = this.setInterval(() => this.registerWithAssistant('idle'), 30000) || null;
            return;
        }
        const { host, port } = await this.resolveAssistant();
        if (!host) {
            this.log.warn('No assistant selected — pick an ioBroker.assistant instance in the settings.');
        } else {
            this.log.info(`ioBroker.assistant → ${host}:${port} (instance ${c.assistantInstance || '-'}).`);
        }

        const cfg = this.buildCoreConfig(host, port);

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
        await this.syncUploadedModels(); // so an uploaded model can be tested right away
        const seconds = Number(msg.seconds) || 15;
        const cfg = loadConfig({
            device: this.namespace.replace('.', '-'),
            audioBackend: ((msg.audioBackend || c.audioBackend || 'auto').trim() || 'auto') as
                'auto' | 'alsa' | 'ffmpeg',
            micDevice: (msg.micDevice || '').trim() || c.micDevice || 'default',
            wakewordModel: this.joinTestWakewords(msg, c),
            wakewordThreshold: Number(msg.wakewordThreshold) || c.wakewordThreshold || 0.5,
            modelsDir: path.join(this.instanceDataDir(), 'models'),
        });
        const wasRunning = !!this.satellite || !!this.localListener;
        try {
            if (this.satellite || this.localListener) {
                this.log.info('Pausing satellite for the wake-word test …');
                await this.satellite?.stop();
                await this.localListener?.stop();
                this.satellite = null;
                this.localListener = null;
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

    /** Admin config message handler (autocomplete/dropdown data sources) + pushed announcements. */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        // Announcement pushed by the assistant (tts.text / per-satellite tts) → play it locally.
        if (obj?.command === 'announce') {
            await this.playAnnouncement(
                (obj.message || {}) as { audio?: string; sampleRate?: number; priority?: boolean },
            );
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
            }
            return;
        }
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
        await this.syncUploadedModels(); // surface freshly-uploaded models in the dropdown
        const options: DeviceOption[] = [
            ...BUILTIN_WAKEWORDS.map(v => ({ value: v, label: `${v} (built-in)` })),
            ...Object.keys(BUNDLED_WAKEWORDS).map(v => ({ value: v, label: `${v} (bundled)` })),
        ];
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
            if (this.heartbeat) {
                this.clearInterval(this.heartbeat);
                this.heartbeat = null;
            }
            this.announcePlayback?.proc.kill('SIGKILL');
            this.registerWithAssistant('offline'); // tell the assistant we're gone
            await this.satellite?.stop();
            await this.localListener?.stop();
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
