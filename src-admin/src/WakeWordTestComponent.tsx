import React from 'react';
import { Box, Button, LinearProgress, Paper, Typography, Alert } from '@mui/material';
import { Mic as MicIcon, GraphicEq as ScoreIcon, CheckCircle as OkIcon } from '@mui/icons-material';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n } from '@iobroker/adapter-react-v5';

// Register this component's translations so the `custom_asat_*` keys resolve.
const translations: Record<string, Record<string, string>> = {};
const i18nModules = import.meta.glob('./i18n/*.json', { eager: true }) as Record<
    string,
    { default: Record<string, string> }
>;
for (const [p, mod] of Object.entries(i18nModules)) {
    const lang = p.split('/').pop()?.replace('.json', '') || 'en';
    translations[lang] = mod.default;
}
I18n.extendTranslations(translations);

const TEST_SECONDS = 15;
/** RMS value that maps to a "full" mic meter (speech is usually well below full scale of 32768). */
const MIC_FULL = 6000;

/** Mirror of the adapter's `testWakeWord` sendTo response. */
interface WakeTestResult {
    error?: string;
    detected?: boolean;
    peakScore?: number;
    threshold?: number;
    micLevel?: number;
    frames?: number;
    lowLevel?: boolean;
}

interface WwState extends ConfigGenericState {
    alive: boolean;
    running: boolean;
    micLevel: number;
    score: number;
    detected: boolean;
    lastResult: string;
}

/**
 * Interactive wake-word test: click "Start", speak the wake word, and watch the live microphone level
 * and wake-word score. Detection lights up immediately. Uses the current (unsaved) mic/wake-word form
 * values via the `testWakeWord` sendTo, and reads live values from the `test.*` states.
 */
export default class WakeWordTestComponent extends ConfigGeneric<ConfigGenericProps, WwState> {
    private subs: string[] = [];

    constructor(props: ConfigGenericProps) {
        super(props);
        this.state = {
            ...this.state,
            alive: false,
            running: false,
            micLevel: 0,
            score: 0,
            detected: false,
            lastResult: '',
        };
    }

    private get instanceId(): string {
        const ctx = this.props.oContext;
        return `${ctx.adapterName}.${ctx.instance}`;
    }

    private get threshold(): number {
        const t = Number((this.props.data as { wakewordThreshold?: number })?.wakewordThreshold);
        return t > 0 && t <= 1 ? t : 0.5;
    }

    async componentDidMount(): Promise<void> {
        super.componentDidMount();
        const socket = this.props.oContext.socket;
        const map: Record<string, (v: unknown) => Partial<WwState>> = {
            [`system.adapter.${this.instanceId}.alive`]: v => ({ alive: !!v }),
            [`${this.instanceId}.test.running`]: v => ({ running: !!v }),
            [`${this.instanceId}.test.micLevel`]: v => ({ micLevel: Number(v) || 0 }),
            [`${this.instanceId}.test.score`]: v => ({ score: Number(v) || 0 }),
            [`${this.instanceId}.test.detected`]: v => ({ detected: !!v }),
        };
        for (const [id, apply] of Object.entries(map)) {
            try {
                const st = await socket.getState(id);
                this.setState(apply(st?.val) as WwState);
            } catch {
                /* ignore */
            }
            const handler = (_id: string, state: ioBroker.State | null | undefined): void =>
                this.setState(apply(state?.val) as WwState);
            (this as unknown as { [k: string]: unknown })[`_h_${id}`] = handler;
            socket.subscribeState(id, handler);
            this.subs.push(id);
        }
    }

    componentWillUnmount(): void {
        const socket = this.props.oContext.socket;
        for (const id of this.subs) {
            const handler = (this as unknown as { [k: string]: (...a: unknown[]) => void })[`_h_${id}`];
            if (handler) {
                socket.unsubscribeState(id, handler);
            }
        }
        super.componentWillUnmount?.();
    }

    private start = (): void => {
        const d = (this.props.data || {}) as Record<string, unknown>;
        this.setState({ detected: false, score: 0, micLevel: 0, lastResult: '' });
        this.props.oContext.socket
            .sendTo(this.instanceId, 'testWakeWord', {
                seconds: TEST_SECONDS,
                micDevice: d.micDevice,
                audioBackend: d.audioBackend,
                wakewordModel: d.wakewordModel,
                wakewordThreshold: d.wakewordThreshold,
            })
            .then(res => {
                const r = res as WakeTestResult | undefined;
                if (r?.error) {
                    this.setState({ lastResult: `⚠ ${r.error}` });
                    return;
                }
                if (!r) {
                    return;
                }
                const ps = String(r.peakScore ?? 0);
                const th = String(r.threshold ?? this.threshold);
                const ml = String(r.micLevel ?? 0);
                let msg: string;
                if (r.detected) {
                    msg = I18n.t('custom_asat_Wake word DETECTED — peak score %s (threshold %s), mic level %s.', ps, th, ml);
                } else {
                    const hint = r.lowLevel
                        ? I18n.t('custom_asat_Mic level very low — check the microphone device.')
                        : I18n.t('custom_asat_Try lowering the threshold or speaking closer.');
                    msg = `${I18n.t('custom_asat_NOT detected — peak score %s (threshold %s), mic level %s, %s frames.', ps, th, ml, String(r.frames ?? 0))} ${hint}`;
                }
                this.setState({ lastResult: msg });
            })
            .catch((e: Error) => this.setState({ lastResult: `⚠ ${e.message}` }));
    };

    renderItem(): React.JSX.Element {
        const { alive, running, micLevel, score, detected, lastResult } = this.state;
        const th = this.threshold;
        const micPct = Math.min(100, (micLevel / MIC_FULL) * 100);
        const scorePct = Math.min(100, score * 100);

        return (
            <Paper style={{ padding: 16, marginTop: 8 }}>
                <Typography variant="h6" gutterBottom>
                    {I18n.t('custom_asat_Wake-word test')}
                </Typography>

                {!alive ? (
                    <Alert severity="info">{I18n.t('custom_asat_Start the instance to test the wake word.')}</Alert>
                ) : (
                    <>
                        <Button variant="contained" onClick={this.start} disabled={running} startIcon={<MicIcon />}>
                            {running
                                ? I18n.t('custom_asat_Listening… say the wake word')
                                : I18n.t('custom_asat_Test wake word (%s s)', String(TEST_SECONDS))}
                        </Button>

                        {/* mic level meter */}
                        <Box style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <MicIcon fontSize="small" />
                            <Box style={{ flex: 1 }}>
                                <LinearProgress
                                    variant="determinate"
                                    value={micPct}
                                    color={micLevel < 200 ? 'inherit' : 'primary'}
                                    style={{ height: 12, borderRadius: 6 }}
                                />
                            </Box>
                            <Typography variant="caption" style={{ width: 90 }}>
                                {I18n.t('custom_asat_mic')}: {Math.round(micLevel)}
                            </Typography>
                        </Box>

                        {/* wake-word score meter with threshold marker */}
                        <Box style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <ScoreIcon fontSize="small" />
                            <Box style={{ flex: 1, position: 'relative' }}>
                                <LinearProgress
                                    variant="determinate"
                                    value={scorePct}
                                    color={score >= th ? 'success' : 'warning'}
                                    style={{ height: 12, borderRadius: 6 }}
                                />
                                {/* threshold marker */}
                                <Box
                                    style={{
                                        position: 'absolute',
                                        top: -2,
                                        bottom: -2,
                                        left: `${th * 100}%`,
                                        width: 2,
                                        background: '#f44336',
                                    }}
                                    title={`${I18n.t('custom_asat_threshold')} ${th}`}
                                />
                            </Box>
                            <Typography variant="caption" style={{ width: 90 }}>
                                {I18n.t('custom_asat_score')}: {score.toFixed(2)}
                            </Typography>
                        </Box>

                        {detected && (
                            <Alert severity="success" icon={<OkIcon />} style={{ marginTop: 16 }}>
                                {I18n.t('custom_asat_Wake word detected!')}
                            </Alert>
                        )}

                        {lastResult && !detected && (
                            <Typography variant="body2" style={{ marginTop: 12 }}>
                                {lastResult}
                            </Typography>
                        )}
                    </>
                )}
            </Paper>
        );
    }
}
