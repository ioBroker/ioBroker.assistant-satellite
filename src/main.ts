import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import { Satellite, loadConfig, type SatelliteState } from '@iobroker/assistant-satellite';
import * as os from 'node:os';
import * as path from 'node:path';

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
    logLevel: 'info' | 'debug';
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

    /** Writable instance data dir (models download here). `getAbsoluteInstanceDataDir` lacks a type. */
    private instanceDataDir(): string {
        return (this as unknown as { getAbsoluteInstanceDataDir(): string }).getAbsoluteInstanceDataDir();
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
            logLevel: c.logLevel || 'info',
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
                this.setStateAsync('status', { val: state, ack: true }).catch(e =>
                    this.log.error(`Cannot set status: ${e}`),
                );
            },
        });

        try {
            await this.satellite.start();
            await this.setStateAsync('info.connection', { val: true, ack: true });
        } catch (e) {
            this.log.error(`Could not start satellite: ${(e as Error).message}`);
            await this.setStateAsync('info.connection', { val: false, ack: true });
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

    /** Admin config: list available ioBroker.assistant instances for the instance dropdown. */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
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

    private async onUnload(callback: () => void): Promise<void> {
        try {
            await this.satellite?.stop();
            await this.setStateAsync('info.connection', { val: false, ack: true });
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
