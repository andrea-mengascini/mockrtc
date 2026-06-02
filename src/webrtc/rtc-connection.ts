/*
 * SPDX-FileCopyrightText: 2022 Tim Perry <tim@httptoolkit.tech>
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import * as SDP from 'sdp-transform';

import * as NodeDataChannel from 'node-datachannel';

import type { MockRTCSessionDescription } from '../mockrtc';
import {
    ConnectionMetadata,
    MockRTCSession,
    AnswerOptions,
    OfferOptions
} from '../mockrtc-peer';

import { DataChannelStream } from './datachannel-stream';
import { MediaTrackStream } from './mediatrack-stream';

export type ParsedSDP = {
    parsedSdp: SDP.SessionDescription;
};

/**
 * An RTC connection is a single connection. This base class defines the raw connection management and
 * tracking logic for a generic connection. The MockRTCConnection subclass extends this and adds
 * logic to support control channels, proxying and other MockRTC-specific additions.
 */

/**
 * If MOCKRTC_PUBLIC_IP is set, inject a server-reflexive (srflx) candidate so that the
 * remote peer (e.g. Zoom SFU on the public internet) can reach this server through NAT.
 * Required when STUN is firewalled and node-datachannel only gathers private host candidates.
 * Assumes 1:1 NAT where the public IP maps to the private IP on the same port.
 */
function injectPublicIpCandidate(sdp: string): string {
    const publicIp = process.env.MOCKRTC_PUBLIC_IP;
    if (!publicIp || !sdp) return sdp;

    const lines = sdp.split('\r\n');
    const patched: string[] = [];
    let lastHostIp = '';
    let lastHostPort = '';

    for (const line of lines) {
        if (line.startsWith('a=candidate:') && line.includes(' UDP ') && line.includes(' typ host')) {
            const parts = line.split(' ');
            if (parts.length >= 8) { lastHostIp = parts[4]; lastHostPort = parts[5]; }
        }
        if (line === 'a=end-of-candidates' && lastHostIp && lastHostPort) {
            patched.push(
                `a=candidate:99 1 UDP 1686052863 ${publicIp} ${lastHostPort}` +
                ` typ srflx raddr ${lastHostIp} rport ${lastHostPort}`
            );
            lastHostIp = '';
            lastHostPort = '';
        }
        patched.push(line);
    }
    return patched.join('\r\n');
}

// ── ICE diagnostics (opt-in via MOCKRTC_ICE_DEBUG) ──────────────────────────────
// Traces why the external MockRTC↔SFU leg fails ICE behind NAT. Set MOCKRTC_ICE_DEBUG=1
// for per-connection candidate/state tracing, or to a libdatachannel level
// (Verbose|Debug|Info|Warning|Error|Fatal) to also stream the native ICE engine logs.
const _ICE_DEBUG_RAW = process.env.MOCKRTC_ICE_DEBUG;
const ICE_DEBUG = !!_ICE_DEBUG_RAW;
const _NDC_LEVELS = ['Verbose', 'Debug', 'Info', 'Warning', 'Error', 'Fatal'];
if (ICE_DEBUG) {
    const level = _NDC_LEVELS.includes(_ICE_DEBUG_RAW!)
        ? (_ICE_DEBUG_RAW as NodeDataChannel.LogLevel)
        : 'Warning';
    try {
        NodeDataChannel.initLogger(level, (lvl, msg) => console.log(`[ndc:${lvl}] ${msg}`));
    } catch (e) {
        console.warn('[ice-debug] initLogger failed:', (e as Error).message);
    }
}

// Optional single-interface ICE binding (see PeerConnection config below).
const BIND_ADDRESS = process.env.MOCKRTC_BIND_ADDRESS || undefined;
if (BIND_ADDRESS) console.log(`[MockRTC] Binding ICE to ${BIND_ADDRESS} (MOCKRTC_BIND_ADDRESS)`);

function iceCandType(line: string): string {
    const m = /typ (host|srflx|prflx|relay)/.exec(line);
    return m ? m[1] : '?';
}

function candidateLinesFrom(sdp: string | undefined | null): string[] {
    if (!sdp) return [];
    return sdp.split(/\r?\n/).filter(l => l.startsWith('a=candidate:'));
}

export class RTCConnection extends EventEmitter {

    readonly id = randomUUID();

    // For lifecycle timing diagnostics (ICE_DEBUG): how long from creation to connect/close.
    private readonly _createdAt = Date.now();

    // Set to null when the connection is closed, as otherwise calling any method (including checking
    // the connection state) will segfault the process.
    private rawConn: NodeDataChannel.PeerConnection | null
        = new NodeDataChannel.PeerConnection("MockRTCConnection", {
            // STUN is required so that MockRTC's server-side connection to the Zoom SFU includes
            // the server's public reflexive address as an ICE candidate. Without it, only private
            // IPs are advertised and the SFU (on the public internet) cannot reach MockRTC.
            iceServers: [
                { hostname: 'stun.l.google.com', port: 19302 },
                { hostname: 'stun1.l.google.com', port: 19302 },
            ],
            forceMediaTransport: true,
            // Bind ICE to a single interface when MOCKRTC_BIND_ADDRESS is set. On multi-homed hosts
            // (e.g. a machine with a WireGuard tunnel), libdatachannel otherwise gathers host
            // candidates on every interface and tries to send STUN from non-routable ones, producing
            // ENETUNREACH (errno 101) and polluting ICE with unreachable candidates — which
            // destabilises the external SFU leg. Pin it to the default-route interface instead.
            ...(BIND_ADDRESS ? { bindAddress: BIND_ADDRESS } : {}),
        });

    private remoteDescription: RTCSessionDescriptionInit & ParsedSDP | undefined;
    private localDescription: MockRTCSessionDescription & ParsedSDP | undefined;

    private _connectionMetadata: ConnectionMetadata = {};
    public get metadata() {
        return this._connectionMetadata;
    }

    private readonly trackedChannels: Array<{ stream: DataChannelStream, isLocal: boolean }> = [];

    get channels(): ReadonlyArray<DataChannelStream> {
        return this.trackedChannels
            .map(channel => channel.stream);
    }

    get localChannels(): ReadonlyArray<DataChannelStream> {
        return this.trackedChannels
            .filter(channel => channel.isLocal)
            .map(channel => channel.stream);
    }

    get remoteChannels(): ReadonlyArray<DataChannelStream> {
        return this.trackedChannels
            .filter(channel => !channel.isLocal)
            .map(channel => channel.stream);
    }

    private readonly trackedMediaTracks: Array<{ stream: MediaTrackStream, isLocal: boolean }> = [];

    get mediaTracks(): ReadonlyArray<MediaTrackStream> {
        return this.trackedMediaTracks
            .map(track => track.stream);
    }

    get localMediaTracks(): ReadonlyArray<MediaTrackStream> {
        return this.trackedMediaTracks
            .filter(track => track.isLocal)
            .map(track => track.stream);
    }

    get remoteMediaTracks(): ReadonlyArray<MediaTrackStream> {
        return this.trackedMediaTracks
            .filter(track => !track.isLocal)
            .map(track => track.stream);
    }

    constructor() {
        super();

        this.rawConn!.onDataChannel((channel) => {
            if (!this.rawConn) return; // https://github.com/murat-dogan/node-datachannel/issues/103

            this.trackNewChannel(channel, { isLocal: false });
        });

        this.rawConn!.onTrack((track: NodeDataChannel.Track) => {
            if (!this.rawConn) return; // https://github.com/murat-dogan/node-datachannel/issues/103

            this.trackNewMediaTrack(track, { isLocal: false });
        });

        // Important to remember that only node-dc only allows one listener per event. To handle that,
        // we reemit important events here to use normal node event methods instead:
        this.rawConn!.onStateChange((state) => {
            if (!this.rawConn) return;
            this.emit('connection-state-changed', state);
        });

        this.on('connection-state-changed', (state) => {
            if (ICE_DEBUG) console.log(`[lifecycle ${this.id.slice(0, 8)} ${
                this.constructor.name}] state=${state} t+${Date.now() - this._createdAt}ms`);
            if (state === 'connected') {
                this.emit('connection-connected');
            } else if (state === 'closed' || state === 'disconnected') {
                this.emit('connection-closed');
                this.remoteDescription = undefined;
                this.localDescription = undefined;
            }
        });

        if (ICE_DEBUG) this.setupIceDebug();
    }

    // Per-connection ICE tracing. `MockRTCConnection` = internal browser-facing leg,
    // base `RTCConnection` = external SFU-facing leg — the one failing behind NAT.
    private _iceDbgLocalCands: string[] = [];
    private setupIceDebug() {
        const conn = this.rawConn!;
        const tag = `${this.constructor.name}#${this.id.slice(0, 8)}`;

        conn.onLocalCandidate((candidate, mid) => {
            if (!this.rawConn) return;
            this._iceDbgLocalCands.push(candidate);
            console.log(`[ice-debug] ${tag} +localCand mid=${mid} typ=${iceCandType(candidate)} ${candidate}`);
        });

        conn.onIceStateChange((state) => {
            if (!this.rawConn) return;
            console.log(`[ice-debug] ${tag} iceState=${state}`);
            if (state !== 'failed' && state !== 'connected' && state !== 'completed') return;

            const localTypes = this._iceDbgLocalCands.map(iceCandType);
            const remote = candidateLinesFrom(conn.remoteDescription()?.sdp);
            const remoteTypes = remote.map(iceCandType);
            const safe = <T>(fn: () => T): T | '?' => { try { return fn(); } catch { return '?'; } };
            const pair = safe(() => conn.getSelectedCandidatePair());

            console.log(`[ice-debug] ${tag} ICE ${state.toUpperCase()} — ` +
                `local(${this._iceDbgLocalCands.length})=[${localTypes.join(',') || 'none'}] ` +
                `remoteSFU(${remote.length})=[${remoteTypes.join(',') || 'none'}]`);
            console.log(`[ice-debug] ${tag} selectedPair=${pair && pair !== '?' ? JSON.stringify(pair) : 'NONE'} ` +
                `rtt=${safe(() => conn.rtt())} bytesRecv=${safe(() => conn.bytesReceived())}`);
            for (const l of remote) console.log(`[ice-debug] ${tag}   R ${l.replace(/^a=/, '')}`);
        });
    }

    createDataChannel(label: string) {
        if (!this.rawConn) throw new Error("Can't create data channel after connection is closed");
        const channel = this.rawConn.createDataChannel(label);
        return this.trackNewChannel(channel, { isLocal: true });
    }

    protected trackNewChannel(channel: NodeDataChannel.DataChannel, options: { isLocal: boolean }) {
        const channelStream = new DataChannelStream(channel);
        this.trackedChannels.push({ stream: channelStream, isLocal: options.isLocal });

        channelStream.on('close', () => {
            const channelIndex = this.trackedChannels.findIndex(c => c.stream === channelStream);
            if (channelIndex !== -1) {
                this.trackedChannels.splice(channelIndex, 1);
            }
        });

        channelStream.on('error', (error) => {
            console.error('Channel error:', error);
        });
        this.emit('channel-created', channelStream);
        this.emit(`${options.isLocal ? 'local' : 'remote'}-channel-created`, channelStream);

        channelStream.once('channel-open', () => {
            this.emit('channel-open', channelStream);
            this.emit(`${options.isLocal ? 'local' : 'remote'}-channel-open`, channelStream);
        });

        return channelStream;
    }

    protected trackNewMediaTrack(track: NodeDataChannel.Track, options: { isLocal: boolean }) {
        const trackStream = new MediaTrackStream(track);
        this.trackedMediaTracks.push({ stream: trackStream, isLocal: options.isLocal });

        // Capture mid/type now: once the track closes the raw track is destroyed and reading
        // `.mid`/`.type` throws ("called on destroyed track").
        const trackMid = trackStream.mid;
        const trackType = trackStream.type;

        if (ICE_DEBUG) console.log(`[tracks ${this.id.slice(0, 8)}] +track mid=${
            trackMid} type=${trackType} isLocal=${options.isLocal} (now ${
            this.trackedMediaTracks.length})`);

        trackStream.on('close', () => {
            const trackIndex = this.trackedMediaTracks.findIndex(c => c.stream === trackStream);
            if (trackIndex !== -1) {
                this.trackedMediaTracks.splice(trackIndex, 1);
            }
            if (ICE_DEBUG) console.log(`[tracks ${this.id.slice(0, 8)}] -track mid=${
                trackMid} type=${trackType} CLOSED (now ${this.trackedMediaTracks.length})`);
        });

        trackStream.on('error', (error) => {
            console.error('Media track error:', error);
        });

        this.emit('track-created', trackStream);
        this.emit(`${options.isLocal ? 'local' : 'remote'}-track-created`, trackStream);

        trackStream.once('track-open', () => {
            this.emit('track-open', trackStream);
            this.emit(`${options.isLocal ? 'local' : 'remote'}-track-open`, trackStream);
        });

        return trackStream;
    }

    setRemoteDescription(description: RTCSessionDescriptionInit) {
        if (!this.rawConn) throw new Error("Can't set remote description after connection is closed");

        this.remoteDescription = {
            ...description,
            parsedSdp: SDP.parse(description.sdp ?? '')
        };
        const { type: offerType, sdp: offerSdp } = description;
        if (!offerSdp) throw new Error("Cannot set MockRTC peer description without providing an SDP");
        this.rawConn.setRemoteDescription(offerSdp, offerType[0].toUpperCase() + offerType.slice(1) as any);
    }

    /**
     * Gets the local description for this connection, waiting until gathering is complete to provide a
     * full result. Because this waits for gathering, it will not resolve if no DataChannel, other
     * tracks or remote description have been provided beforehand.
     */
    async buildLocalDescription(): Promise<MockRTCSessionDescription> {
        if (!this.rawConn) throw new Error("Can't get local description after connection is closed");

        let setupChannel: NodeDataChannel.DataChannel | undefined;
        if (this.rawConn.gatheringState() === 'new') {
            // We can't create an offer until we have something to negotiate, but we don't want to
            // negotiate ourselves when we don't really know what's being negotiated here. To work
            // around that, we create a channel to trigger gathering & get an offer, and then we
            // remove it before the offer is delivered, so it's never visible remotely.
            setupChannel = this.rawConn.createDataChannel('mockrtc.setup-channel');
        }

        await new Promise<void>((resolve) => {
            this.rawConn!.onGatheringStateChange((state) => {
                if (state === 'complete') resolve();
            });

            // Handle race conditions where gathering has already completed
            if (this.rawConn!.gatheringState() === 'complete') resolve();
        });

        if (!this.rawConn) throw new Error("Connection was closed while building local description");

        const sessionDescription = this.rawConn.localDescription() as MockRTCSessionDescription;
        setupChannel?.close(); // Close the temporary setup channel, if we created one
        sessionDescription.sdp = injectPublicIpCandidate(sessionDescription.sdp ?? '');
        this.localDescription = {
            ...sessionDescription,
            parsedSdp: SDP.parse(sessionDescription.sdp ?? '')
        };
        return sessionDescription;
    }

    getRemoteDescription() {
        if (!this.rawConn) throw new Error("Can't get remote description after connection is closed");
        return this.remoteDescription;
    }

    getLocalDescription() {
        if (!this.rawConn) throw new Error("Can't get local description after connection is closed");
        return this.localDescription;
    }

    getSelectedCandidates() {
        if (!this.rawConn) throw new Error("Can't get selected candidates after connection is closed");

        const candidates = this.rawConn.getSelectedCandidatePair();
        if (!candidates || !candidates.local || !candidates.remote) return undefined;

        // Rename transportType -> protocol, to better match the browser WebRTC APIs
        // N.b. we omit transportType from *Candidate here
        const { transportType: localTransportType, ...localCandidate } = candidates.local;
        const { transportType: remoteTransportType, ...remoteCandidate } = candidates.remote;

        return {
            local: {
                ...localCandidate,
                type: candidates.local.type as RTCIceCandidateType,
                protocol: localTransportType.toLowerCase()
            },
            remote: {
                ...remoteCandidate,
                type: candidates.remote.type as RTCIceCandidateType,
                protocol: remoteTransportType.toLowerCase()
            }
        };
    }

    /**
     * Adds a local media track for each relevant non-application m-line in the given SDP, copying its
     * mid, type, direction and SSRCs. libdatachannel only includes a media track in a generated
     * description if the track exists *before* that description is built — so this must run before
     * setLocalDescription (when offering) or setRemoteDescription (when answering).
     *
     * `onlySendTracks` (used when answering) restricts creation to media the mirrored peer is sending
     * (sendonly/sendrecv) — i.e. downlink streams that *we* must forward on to the browser. Inbound
     * (recvonly) streams are received from the other peer via onTrack, so pre-creating them here would
     * duplicate the track. This is the fix for remote-participant video/audio: when the browser is the
     * offerer for a downlink stream, the answer path previously created no send-track, so MockRTC had
     * nothing to forward the SFU's media into (black tiles / no remote audio).
     */
    private addMirroredMediaTracks(sdpToMirror: string, options: { onlySendTracks?: boolean } = {}) {
        if (!this.rawConn) throw new Error("Can't add media tracks after connection is closed");

        const mediaStreamsToMirror = SDP.parse(sdpToMirror).media.filter(media => media.type !== 'application');

        mediaStreamsToMirror.forEach((mediaToMirror) => {
            const mid = mediaToMirror.mid!.toString();

            // Skip media tracks that we already have
            if (this.mediaTracks.find((track) => track.mid === mid)) return;

            // When answering, only create tracks for media the peer sends to us to forward on.
            // Note: an m-line with no explicit direction defaults to sendrecv (RFC 3264), and
            // sdp-transform reports that as `undefined` — so we must exclude only *explicit*
            // recvonly/inactive lines, not treat undefined as non-sending (that bug left some
            // downlink video tracks uncreated → still-black tiles).
            if (options.onlySendTracks &&
                (mediaToMirror.direction === 'recvonly' || mediaToMirror.direction === 'inactive')
            ) {
                if (ICE_DEBUG) console.log(`[tracks ${this.id.slice(0, 8)}] skip mid=${mid} type=${
                    mediaToMirror.type} dir=${mediaToMirror.direction} (not a send track)`);
                return;
            }

            // The answer to the browser's recvonly offer must be sendonly (we only forward SFU media
            // down to the browser on these tracks); for offers, preserve the mirrored direction.
            const direction = options.onlySendTracks
                ? NodeDataChannel.Direction.SendOnly
                : sdpDirectionToNDCDirection(mediaToMirror.direction);

            if (ICE_DEBUG) console.log(`[tracks ${this.id.slice(0, 8)}] addTrack mid=${mid} type=${
                mediaToMirror.type} srcDir=${mediaToMirror.direction} ndcDir=${direction}`);

            const media = mediaToMirror.type === 'video'
                ? new NodeDataChannel.Video(mid, direction)
                : new NodeDataChannel.Audio(mid, direction)

            // Copy SSRC data (awkward translation between per-attr and full-value structures)
            const ssrcs = mediaToMirror.ssrcs?.reduce((ssrcs, kv) => {
                ssrcs[kv.id] ||= {};
                ssrcs[kv.id][kv.attribute] = kv.value;
                return ssrcs;
            }, {} as { [id: string]: { [attr: string]: string | undefined } }) ?? {};

            Object.keys(ssrcs).forEach((id) => {
                const ssrcAttrs = ssrcs[id];
                const [msid, trackId] = ssrcAttrs.msid?.split(' ') ?? [];
                if (!msid) {
                    media.addSSRC(
                        parseInt(id, 10),
                        ssrcAttrs['cname']
                    );
                } else {
                    media.addSSRC(
                        parseInt(id, 10),
                        ssrcAttrs['cname'],
                        msid,
                        trackId
                    );
                }
            });

            const track = this.rawConn!.addTrack(media);
            this.trackNewMediaTrack(track, { isLocal: true });
        });
    }

    async getMirroredLocalOffer(
        sdpToMirror: string,
        options: { addDataStream?: boolean } = {}
    ): Promise<MockRTCSessionDescription> {
        if (!this.rawConn) throw new Error("Can't get local description after connection is closed");

        const offerToMirror = SDP.parse(sdpToMirror);

        const mediaStreamsToMirror = offerToMirror.media.filter(media => media.type !== 'application');
        const shouldMirrorDataStream = offerToMirror.media.some(media => media.type === 'application');

        // When offering, mirror every media line (both directions): we're re-creating the peer's
        // whole offer onward, so all m-lines need a local track to appear in the description.
        this.addMirroredMediaTracks(sdpToMirror);

        let setupChannel: NodeDataChannel.DataChannel | undefined;
        const channelRequiredForDescription = this.rawConn.gatheringState() === 'new' &&
            !mediaStreamsToMirror.length;
        if (shouldMirrorDataStream || channelRequiredForDescription || options.addDataStream) {
            // See getLocalDescription() above: if we want a description and we have no media, we
            // need to make a stub channel to allow us to negotiate _something_.
            // In addition, we might actually have data channels to mirror. In that case, we need
            // to create a temporary data channel to force that negotiation (which will be closed
            // again shortly, so that it never actually gets created).
            setupChannel = this.rawConn.createDataChannel('mockrtc.setup-channel');
        }

        this.rawConn.setLocalDescription(NodeDataChannel.DescriptionType.Offer);
        await new Promise<void>((resolve) => {
            this.rawConn!.onGatheringStateChange((state) => {
                if (state === 'complete') resolve();
            });

            // Handle race conditions where gathering has already completed
            if (this.rawConn!.gatheringState() === 'complete') resolve();
        });

        if (!this.rawConn) throw new Error("Connection was closed while building the local description");

        const localDesc = this.rawConn.localDescription()!;
        setupChannel?.close(); // Close the temporary setup channel, if we created one

        const offerSDP = SDP.parse(injectPublicIpCandidate(localDesc.sdp));
        mirrorMediaParams(offerToMirror, offerSDP);
        normalizeBundledCodecParams(offerSDP);
        localDesc.sdp = SDP.write(offerSDP);

        this.localDescription = {
            ...localDesc as MockRTCSessionDescription,
            parsedSdp: offerSDP
        };
        return this.localDescription;
    }

    async getMirroredLocalAnswer(sdpToMirror: string): Promise<MockRTCSessionDescription> {
        const localDesc = this.rawConn!.localDescription()!;
        localDesc.sdp = injectPublicIpCandidate(localDesc.sdp ?? '');

        const answerToMirror = SDP.parse(sdpToMirror);
        const answerSDP = SDP.parse(localDesc.sdp!);
        mirrorMediaParams(answerToMirror, answerSDP);

        localDesc.sdp = SDP.write(answerSDP);

        this.localDescription = {
            ...localDesc as MockRTCSessionDescription,
            parsedSdp: answerSDP
        };
        return this.localDescription;
    }

    waitUntilConnected() {
        return new Promise<void>((resolve, reject) => {
            if (!this.rawConn) throw new Error("Connection closed while/before waiting until connected");

            this.on('connection-state-changed', (state) => {
                if (state === 'connected') resolve();
                if (state === 'failed') {
                    reject(new Error("Connection failed while waiting for connection"));
                }
            });

            if (this.rawConn.state() === 'connected') resolve();
            if (this.rawConn.state() === 'failed') {
                reject(new Error("Connection failed while waiting for connection"));
            }
        });
    }

    readonly sessionApi: MockRTCSession = {
        sessionId: this.id, // The session id is actually just the connection id, shhh don't tell anyone.

        createOffer: async (options: OfferOptions = {}): Promise<MockRTCSessionDescription> => {
            if (options.connectionMetadata) {
                this._connectionMetadata = {
                    ...this._connectionMetadata,
                    ...options.connectionMetadata
                };
            }

            if (options.mirrorSDP) {
                return this.getMirroredLocalOffer(options.mirrorSDP, {
                    addDataStream: !!options.addDataStream
                });
            } else {
                return this.buildLocalDescription();
            }
        },

        completeOffer: async (answer: MockRTCSessionDescription): Promise<void> => {
            this.setRemoteDescription(answer);
        },

        answerOffer: async (
            offer: MockRTCSessionDescription,
            options: AnswerOptions = {}
        ): Promise<MockRTCSessionDescription> => {
            if (options.connectionMetadata) {
                this._connectionMetadata = {
                    ...this._connectionMetadata,
                    ...options.connectionMetadata
                };
            }

            if (options.mirrorSDP) {
                // Create send-tracks for the downlink media (what the mirrored peer/SFU is sending)
                // *before* setRemoteDescription, so libdatachannel includes them in the answer it
                // generates. Without this, the answer carries no track for the browser to receive on,
                // so MockRTC has nothing to forward the SFU's media into — remote tiles stay black.
                this.addMirroredMediaTracks(options.mirrorSDP, { onlySendTracks: true });
            }

            this.setRemoteDescription(offer);

            if (options.mirrorSDP) {
                return this.getMirroredLocalAnswer(options.mirrorSDP);
            } else {
                return this.buildLocalDescription();
            }
        }
    };

    async close() {
        if (!this.rawConn) return; // Already closed

        const { rawConn } = this;
        this.rawConn = null; // Drop the reference, so nothing tries to use it after close
        this.remoteDescription = undefined;
        this.localDescription = undefined;

        if (rawConn.state() === 'closed') return;
        rawConn.close();
        this.emit('connection-closed');
    }

}

function sdpDirectionToNDCDirection(direction: SDP.SharedAttributes['direction']): NodeDataChannel.Direction {
    if (direction === 'inactive') return NodeDataChannel.Direction.Inactive;
    else if (direction?.length === 8) {
        return direction[0].toUpperCase() +
            direction.slice(1, 4) +
            direction[4].toUpperCase() +
            direction.slice(5) as NodeDataChannel.Direction;
    } else {
        return NodeDataChannel.Direction.Unknown;
    }
};

/**
 * Normalizes fmtp parameters for duplicate payload types across m-sections within the same
 * BUNDLE group. Chrome rejects SDP offers where the same payload type appears in multiple
 * BUNDLE m-sections with different fmtp configs (INVALID_PARAMETER / "codec collision").
 * First occurrence wins — all subsequent m-sections in the group get the same fmtp config.
 */
function normalizeBundledCodecParams(sdp: SDP.SessionDescription) {
    if (!sdp.groups) return;

    for (const group of sdp.groups) {
        if (group.type !== 'BUNDLE') continue;

        const bundleMids = new Set(String(group.mids).split(' '));
        const bundledMedia = sdp.media.filter(m =>
            m.mid != null && bundleMids.has(m.mid.toString())
        );

        // First fmtp config seen for each payload type becomes canonical
        const canonical = new Map<number, string>();
        for (const m of bundledMedia) {
            if (!m.fmtp) continue;
            for (const entry of m.fmtp) {
                if (!canonical.has(entry.payload)) canonical.set(entry.payload, entry.config);
            }
        }

        // Apply canonical config to every fmtp entry in the group
        for (const m of bundledMedia) {
            if (!m.fmtp) continue;
            m.fmtp = m.fmtp.map(entry => ({
                payload: entry.payload,
                config: canonical.get(entry.payload) ?? entry.config
            }));
        }
    }
}

/**
 * Takes two parsed descriptions (typically a real description we want to mock, and our own current
 * self-generated description) and modifies the target description sure that the media params for
 * each stream in the source description match.
 *
 * In theory, this should guarantee that RTP packets generated by the source and forwarded through
 * the target's connection can be interpreted by somebody connected to the target.
 */
function mirrorMediaParams(source: SDP.SessionDescription, target: SDP.SessionDescription) {
    target.msidSemantic = source.msidSemantic;

    const sourceMediaStreams = source.media.filter(m => m.type !== 'application');
    sourceMediaStreams.forEach((sourceMedia) => {
        const targetMedia = target.media
            .find((targetMedia) => targetMedia.mid === sourceMedia.mid);
        if (!targetMedia) {
            throw new Error(
                `Missing mid ${sourceMedia.mid} in target when mirroring media params`
            );
        }

        if (sourceMedia.type !== targetMedia.type) {
            throw new Error(
                `Unexpected media type (${
                    targetMedia.type
                }) for mid ${
                    targetMedia.mid
                } when mirroring media params`
            );
        }

        // Copy all the semantic parameters of the RTP & RTCP streams themselves, so that RTP packets
        // can be forwarded correctly, but without copying the fingerprint or similar, so we can still
        // act as a MitM to intercept the packets:
        targetMedia.msid = sourceMedia.msid;
        targetMedia.protocol = sourceMedia.protocol;
        targetMedia.ext = sourceMedia.ext;
        targetMedia.payloads = sourceMedia.payloads;
        targetMedia.rtp = sourceMedia.rtp;
        targetMedia.fmtp = sourceMedia.fmtp;
        targetMedia.rtcp = sourceMedia.rtcp;
        targetMedia.rtcpFb = sourceMedia.rtcpFb;
        targetMedia.ssrcGroups = sourceMedia.ssrcGroups;

        // SSRC info is especially important here: this is used to map RTP SSRCs to track mids, so if
        // this is incorrect, the recipient track will not receive the data we're sending.
        // Although in some cases we do already have some SSRC info here, for offers where we've already
        // defined the tracks ourselves, libdatachannel doesn't support all params and it's best to copy
        // the full definition itself directly to make sure they match:
        targetMedia.ssrcs = sourceMedia.ssrcs;
    });
}