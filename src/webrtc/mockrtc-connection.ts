/*
 * SPDX-FileCopyrightText: 2022 Tim Perry <tim@httptoolkit.tech>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Transform } from 'stream';
import type * as NodeDataChannel from 'node-datachannel';

import { MockRTCControlMessage, MOCKRTC_CONTROL_CHANNEL } from './control-channel';
import type {
    BeforeDataChannelMessage,
    RTCDataChannelChannel,
    RTCDataChannelMessage,
    RTCDataChannelMessageResult
} from '../handling/handler-step-definitions';

import { DataChannelStream } from './datachannel-stream';
import { MediaTrackStream } from './mediatrack-stream';
import { RTCConnection } from './rtc-connection';

// ── Data channel transform helpers ──────────────────────────────────────────

function normalizeForWrite(content: string | Buffer, isBinary: boolean): string | Buffer {
    return isBinary
        ? (Buffer.isBuffer(content) ? content : Buffer.from(content as string))
        : (typeof content === 'string' ? content : content.toString('utf8'));
}

function makeTransformPipe(
    src: DataChannelStream,
    dst: DataChannelStream,
    fromPeer: RTCDataChannelMessage['fromPeer'],
    injection: RTCDataChannelChannel,
    hook: BeforeDataChannelMessage
): void {
    const t = new Transform({
        objectMode: true,
        transform(chunk: string | Buffer, _enc: string, done: (err?: Error | null, data?: any) => void) {
            const isBinary = Buffer.isBuffer(chunk);
            const content = isBinary ? chunk as Buffer : Buffer.from(chunk as string);

            Promise.resolve(hook({ content, isBinary, channelLabel: src.label, fromPeer }, injection))
                .then((result: RTCDataChannelMessageResult | void) => {
                    if (result?.action === 'drop') { done(); return; }
                    if (result?.action === 'forward' && result.content != null) {
                        done(null, normalizeForWrite(result.content, isBinary));
                    } else {
                        done(null, chunk); // forward unchanged
                    }
                })
                .catch((e: Error) => {
                    console.error('[MockRTC] beforeDataChannelMessage error:', e);
                    done(null, chunk);
                });
        }
    });
    src.pipe(t).pipe(dst);
}

function proxyChannelPair(
    internalCh: DataChannelStream,
    externalCh: DataChannelStream,
    hook?: BeforeDataChannelMessage
): void {
    if (!hook) {
        internalCh.pipe(externalCh);
        externalCh.pipe(internalCh);
        return;
    }

    const injection: RTCDataChannelChannel = {
        toPeer:   (c, b = false) => internalCh.write(normalizeForWrite(c, b)),
        toRemote: (c, b = false) => externalCh.write(normalizeForWrite(c, b)),
        label: internalCh.label
    };

    makeTransformPipe(internalCh, externalCh, 'internal', injection, hook);
    makeTransformPipe(externalCh, internalCh, 'external', injection, hook);
}

export class MockRTCConnection extends RTCConnection {

    // If the client supports a MockRTC control channge to send extra metadata during mocking,
    // they will create this at startup, and we'll track it here, separately from all other channels.
    private controlChannel: DataChannelStream | undefined;
    private externalConnection: RTCConnection | undefined;

    constructor(
        private getExternalConnection: (id: string) => RTCConnection
    ) {
        super();
    }

    protected trackNewChannel(channel: NodeDataChannel.DataChannel, options: { isLocal: boolean }) {
        if (channel.getLabel() === MOCKRTC_CONTROL_CHANNEL && !options.isLocal) {
            // We don't track the control channel like other channels - we handle it specially.
            if (this.controlChannel) {
                const error = new Error('Cannot open multiple control channels simultaneously');
                channel.sendMessage(JSON.stringify({
                    type: 'error',
                    error: error.message
                }));
                setTimeout(() => channel.close(), 100);
                throw error;
            }

            this.controlChannel = new DataChannelStream(channel);

            this.controlChannel.on('data', (msg) => {
                try {
                    const controlMessage = JSON.parse(msg) as MockRTCControlMessage;

                    if (controlMessage.type === 'attach-external') {
                        if (this.externalConnection) {
                            throw new Error('Cannot attach mock connection to multiple external connections');
                        }

                        const externalConnection = this.getExternalConnection(controlMessage.id);
                        // We don't attach until the external connection actually connects. Typically that's
                        // already happened at this point, but its not guaranteed, so best to check:
                        externalConnection.waitUntilConnected().then(() => {
                            this.externalConnection = externalConnection;
                            this.emit('external-connection-attached', this.externalConnection);
                        }).catch((err) => {
                            console.warn("External connection failed, cannot attach:", err.message || err);
                        });

                        // We don't necessarily proxy traffic through to the external connection at this
                        // point, that depends on the specific handling that's used here.
                    } else {
                        throw new Error(`Unrecognized control channel message: ${controlMessage.type}`);
                    }
                } catch (e: any) {
                    console.warn("Failed to handle control channel message", e);
                    this.controlChannel?.write(JSON.stringify({
                        type: 'error',
                        error: e.message || e
                    }));
                }
            });

            this.controlChannel.on('close', () => {
                this.controlChannel = undefined;
            });

            this.controlChannel.on('error', (error) => {
                console.error('Control channel error:', error);
            });

            return this.controlChannel!;
        } else {
            return super.trackNewChannel(channel, options);
        }
    }

    async proxyTrafficToExternalConnection(hook?: BeforeDataChannelMessage) {
        if (!this.externalConnection) {
            await new Promise((resolve) => this.once('external-connection-attached', resolve));
        }

        await this.proxyTrafficTo(this.externalConnection!, hook);
        return this.externalConnection!;
    }

    async proxyTrafficTo(externalConnection: RTCConnection, hook?: BeforeDataChannelMessage) {
        if (this.externalConnection) {
            if (externalConnection !== this.externalConnection) {
                throw new Error('Cannot attach multiple external connections');
            }
        } else {
            await externalConnection.waitUntilConnected();
            this.externalConnection = externalConnection;
            this.emit('external-connection-attached', this.externalConnection);
        }

        /**
         * When proxying traffic, you effectively have four peers, each with a connection endpoint:
         * - The incoming RTCPeerConnection that we're mocking ('internal')
         * - This MockRTC connection, with an associated MockRTCPeer that it will actually connect to ('mock')
         * - A MockRTC external connection that will connect to the remote peer ('external')
         * - The original remote peer that we're connecting to ('remote')
         *
         * Once the proxy is set up, the the connection structure works like so:
         * INTERNAL <--> MOCK <--> EXTERNAL <--> REMOTE
         *
         * Here we connect the internal & external connections together, proxying all behaviours between the
         * two so that from this point forwards every event on one is reflected on the other.
         *
         * Note that this isn't necessarily the initialization of either connection: the remote peer could
         * have been connected for a while (sending data with no response), and the internal peer could have
         * been fully interacting with steps before this point.
         */


        // Mirror connection closure:
        const closeDebug = !!(process.env.MOCKRTC_RELAY_DEBUG || process.env.MOCKRTC_ICE_DEBUG);
        this.on('connection-closed', () => {
            if (closeDebug) console.log(`[lifecycle ${this.id.slice(0, 8)}] INTERNAL (browser) closed first → tearing down external`);
            externalConnection.close();
        });
        externalConnection.on('connection-closed', () => {
            if (closeDebug) console.log(`[lifecycle ${this.id.slice(0, 8)}] EXTERNAL (SFU) closed first → tearing down internal`);
            this.close();
        });

        /// --- Data channels: --- ///

        // Forward *all* existing internal channels to the external connection:
        this.channels.forEach((channel: DataChannelStream) => { // All channels, in case a previous step created one
            const mirrorChannelStream = externalConnection.createDataChannel(channel.label);
            proxyChannelPair(channel, mirrorChannelStream, hook);
        });

        // Forward any existing external channels back to this peer connection. Note that we're mirroring
        // *remote* channels only, so we skip the channels that we've just created above.
        externalConnection.remoteChannels.forEach((channel: DataChannelStream) => {
            const mirrorChannelStream = this.createDataChannel(channel.label);
            proxyChannelPair(mirrorChannelStream, channel, hook); // mirror=internal, channel=external
        });

        // If any new channels open in future, mirror them to the other peer:
        this.on('remote-channel-created', (incomingChannel: DataChannelStream) => {
            const mirrorChannelStream = externalConnection.createDataChannel(incomingChannel.label);
            proxyChannelPair(incomingChannel, mirrorChannelStream, hook);
        });
        externalConnection.on('remote-channel-created', (incomingChannel: DataChannelStream) => {
            const mirrorChannelStream = this.createDataChannel(incomingChannel.label);
            proxyChannelPair(mirrorChannelStream, incomingChannel, hook); // mirror=internal, incoming=external
        });

        /// --- Media tracks: --- ///

        // Unlike data channels (negotiated in-band, so they never exist before this point), media
        // tracks are negotiated in the SDP. Crucially, in SFU topologies (e.g. Zoom) tracks are added
        // *incrementally via renegotiation* as remote participants enable their camera/mic — long after
        // proxying begins. A one-shot `forEach` over the tracks present at setup time therefore relays
        // only the local outbound track (so a participant sees themselves) and silently drops every
        // remote participant's track (so all other tiles stay black).
        //
        // Instead we relay dynamically: track both sides' tracks by mid, and pipe a pair together as
        // soon as the matching mid appears on each side — including tracks created later by renegotiation,
        // mirroring how data channels above listen for `remote-channel-created`.

        // Diagnostics: trace track registration & pairing so we can tell, per connection, whether
        // remote media tracks ever arrive on both legs and get relayed. Gated on MOCKRTC_RELAY_DEBUG
        // (or the existing MOCKRTC_ICE_DEBUG) to stay silent in normal runs.
        const relayDebug = !!(process.env.MOCKRTC_RELAY_DEBUG || process.env.MOCKRTC_ICE_DEBUG);
        const relayTag = `[relay ${this.id.slice(0, 8)}]`;
        const rlog = (...args: any[]) => { if (relayDebug) console.log(relayTag, ...args); };

        const pendingMockTracks = new Map<string, MediaTrackStream>();
        const pendingExternalTracks = new Map<string, MediaTrackStream>();
        const pipedMids = new Set<string>();

        const tryPipeTrack = (mid: string) => {
            if (pipedMids.has(mid)) return;
            const mockTrack = pendingMockTracks.get(mid);
            const externalTrack = pendingExternalTracks.get(mid);
            if (!mockTrack || !externalTrack) {
                rlog(`mid ${mid} waiting for pair (mock=${!!mockTrack} external=${!!externalTrack})`);
                return; // Wait until both sides have negotiated this mid.
            }

            pendingMockTracks.delete(mid);
            pendingExternalTracks.delete(mid);

            if (mockTrack.type !== externalTrack.type) {
                // Negotiation mismatch — skip just this track rather than throwing, so one bad track
                // can't tear down the whole connection (including the data channel proxy).
                console.warn(`[MockRTC] Skipping media relay for mid ${mid}: mismatched types (${
                    mockTrack.type
                }/${
                    externalTrack.type
                })`);
                return;
            }

            pipedMids.add(mid);
            rlog(`PIPED mid ${mid} (${mockTrack.type}) mock<->external`);
            // Bidirectional relay: external (SFU) → mock (browser) and back. RTP is forwarded opaquely.
            mockTrack.pipe(externalTrack).pipe(mockTrack);
        };

        const registerMockTrack = (track: MediaTrackStream) => {
            if (track.mid == null) return;
            rlog(`+mock track mid=${track.mid} type=${track.type}`);
            pendingMockTracks.set(track.mid, track);
            tryPipeTrack(track.mid);
        };
        const registerExternalTrack = (track: MediaTrackStream) => {
            if (track.mid == null) return;
            rlog(`+external track mid=${track.mid} type=${track.type}`);
            pendingExternalTracks.set(track.mid, track);
            tryPipeTrack(track.mid);
        };

        rlog(`proxy setup: mock has ${this.mediaTracks.length} track(s), external has ${
            externalConnection.mediaTracks.length} track(s)`);

        // Relay tracks already negotiated at setup time...
        this.mediaTracks.forEach(registerMockTrack);
        externalConnection.mediaTracks.forEach(registerExternalTrack);

        // ...and any tracks added later via renegotiation (the SFU/remote-participant case):
        this.on('track-created', registerMockTrack);
        externalConnection.on('track-created', registerExternalTrack);
    }

}