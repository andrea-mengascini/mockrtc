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

// Opt-in libdatachannel logging (MOCKRTC_NDC_LOG=Verbose|Debug|Info|Warning) to diagnose ICE/TURN.
if (process.env.MOCKRTC_NDC_LOG) {
    try { (NodeDataChannel as any).initLogger(process.env.MOCKRTC_NDC_LOG); } catch (e) { /* ignore */ }
}

/**
 * Convert browser RTCIceServer[] ({ urls, username, credential }) to the format
 * node-datachannel expects ({ hostname, port, username?, password? }[]). Used so
 * MockRTC's external leg can gather srflx/relay candidates via the app's STUN/TURN
 * and be reachable by a remote (e.g. a cloud SFU) behind NAT, instead of advertising
 * only host candidates (which a remote SFU can't reach).
 */
export function toNodeDataChannelIceServers(servers: unknown): Array<{
    hostname: string; port: number; username?: string; password?: string; relayType?: string;
}> {
    if (!Array.isArray(servers)) return [];
    const out: Array<{ hostname: string; port: number; username?: string; password?: string; relayType?: string }> = [];
    for (const s of servers as any[]) {
        if (!s) continue;
        const urls: string[] = Array.isArray(s.urls) ? s.urls : (s.urls ? [s.urls] : []);
        for (const raw of urls) {
            if (typeof raw !== 'string') continue;
            const m = /^(stun|stuns|turn|turns):([^?]+)/i.exec(raw.trim());
            if (!m) continue;
            const scheme = m[1].toLowerCase();
            let hostport = m[2];
            const at = hostport.lastIndexOf('@');
            if (at >= 0) hostport = hostport.slice(at + 1);
            let hostname = hostport;
            let port = (scheme === 'turns' || scheme === 'stuns') ? 5349 : 3478;
            const colon = hostport.lastIndexOf(':');
            if (colon > 0 && /^\d+$/.test(hostport.slice(colon + 1))) {
                hostname = hostport.slice(0, colon);
                port = parseInt(hostport.slice(colon + 1), 10);
            }
            const server: { hostname: string; port: number; username?: string; password?: string; relayType?: string } = { hostname, port };
            if (scheme.startsWith('turn')) {
                if (s.username != null) server.username = String(s.username);
                if (s.credential != null) server.password = String(s.credential);
                // relayType makes node-datachannel/libjuice ALLOCATE a TURN relay (vs treating it as STUN).
                const transport = (/transport=(\w+)/i.exec(raw) || [])[1];
                server.relayType = scheme === 'turns'
                    ? 'TurnTls'
                    : (transport && transport.toLowerCase() === 'tcp' ? 'TurnTcp' : 'TurnUdp');
            }
            out.push(server);
        }
    }
    return out;
}

/**
 * An RTC connection is a single connection. This base class defines the raw connection management and
 * tracking logic for a generic connection. The MockRTCConnection subclass extends this and adds
 * logic to support control channels, proxying and other MockRTC-specific additions.
 */
export class RTCConnection extends EventEmitter {

    readonly id = randomUUID();

    // Set to null when the connection is closed, as otherwise calling any method (including checking
    // the connection state) will segfault the process.
    private rawConn: NodeDataChannel.PeerConnection | null;

    private remoteDescription: RTCSessionDescriptionInit & ParsedSDP | undefined;
    private localDescription: MockRTCSessionDescription & ParsedSDP | undefined;

    // Trickled remote ICE candidates that arrive before the remote description is set
    // (node-datachannel requires the remote description first). Flushed in setRemoteDescription.
    private pendingRemoteCandidates: Array<{ candidate: string; mid: string }> = [];

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

    constructor(connConfig: { iceServers?: unknown } = {}) {
        super();

        // External legs (browser<->SFU bridging) pass the app's iceServers so node-datachannel
        // gathers reachable srflx/relay candidates; internal/browser-facing legs default to [].
        this.rawConn = new NodeDataChannel.PeerConnection("MockRTCConnection", {
            iceServers: toNodeDataChannelIceServers(connConfig.iceServers) as any,
            forceMediaTransport: true
        });

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
            if (state === 'connected') {
                this.emit('connection-connected');
            } else if (state === 'closed' || state === 'disconnected') {
                this.emit('connection-closed');
                this.remoteDescription = undefined;
                this.localDescription = undefined;
            }
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

        trackStream.on('close', () => {
            const trackIndex = this.trackedMediaTracks.findIndex(c => c.stream === trackStream);
            if (trackIndex !== -1) {
                this.trackedMediaTracks.splice(trackIndex, 1);
            }
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

        // Flush trickled candidates that arrived before the remote description was set.
        const pending = this.pendingRemoteCandidates;
        this.pendingRemoteCandidates = [];
        for (const c of pending) {
            try { this.rawConn.addRemoteCandidate(c.candidate, c.mid); } catch (e) { /* ignore */ }
        }
    }

    /** Add a remote (trickled) ICE candidate, buffering until the remote description is set. */
    addRemoteCandidate(candidateInit: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null }) {
        if (!this.rawConn) return;
        const candidate = candidateInit?.candidate;
        if (!candidate) return; // end-of-candidates sentinel / empty
        const mid = candidateInit.sdpMid != null
            ? candidateInit.sdpMid
            : (candidateInit.sdpMLineIndex != null ? String(candidateInit.sdpMLineIndex) : "0");
        if (!this.remoteDescription) {
            this.pendingRemoteCandidates.push({ candidate, mid });
            return;
        }
        try { this.rawConn.addRemoteCandidate(candidate, mid); } catch (e) { /* ignore */ }
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

    async getMirroredLocalOffer(
        sdpToMirror: string,
        options: { addDataStream?: boolean } = {}
    ): Promise<MockRTCSessionDescription> {
        if (!this.rawConn) throw new Error("Can't get local description after connection is closed");

        const offerToMirror = SDP.parse(sdpToMirror);

        const mediaStreamsToMirror = offerToMirror.media.filter(media => media.type !== 'application');
        const shouldMirrorDataStream = offerToMirror.media.some(media => media.type === 'application');

        mediaStreamsToMirror.forEach((mediaToMirror) => {
            // Skip media tracks that we already have
            if (this.mediaTracks.find(({ mid }) => mid === mediaToMirror.mid!)) return;

            const mid = mediaToMirror.mid!.toString();
            const direction = sdpDirectionToNDCDirection(mediaToMirror.direction);

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

        const offerSDP = SDP.parse(localDesc.sdp);
        mirrorMediaParams(offerToMirror, offerSDP);
        localDesc.sdp = SDP.write(offerSDP);

        this.localDescription = {
            ...localDesc as MockRTCSessionDescription,
            parsedSdp: offerSDP
        };
        return this.localDescription;
    }

    async getMirroredLocalAnswer(sdpToMirror: string): Promise<MockRTCSessionDescription> {
        const localDesc = this.rawConn!.localDescription()!;

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

            this.setRemoteDescription(offer);

            if (options.mirrorSDP) {
                return this.getMirroredLocalAnswer(options.mirrorSDP);
            } else {
                return this.buildLocalDescription();
            }
        },

        addRemoteCandidate: async (candidate: any): Promise<void> => {
            this.addRemoteCandidate(candidate);
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