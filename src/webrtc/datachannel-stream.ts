/*
 * SPDX-FileCopyrightText: 2022 Tim Perry <tim@httptoolkit.tech>
 * SPDX-License-Identifier: Apache-2.0
 */

import * as stream from 'stream';
import type * as NodeDataChannel from 'node-datachannel';

/**
 * Turns a node-datachannel DataChannel into a real Node.js stream, complete with
 * buffering, backpressure (up to a point - if the buffer fills up, messages are dropped),
 * and support for piping data elsewhere.
 *
 * Read & written data may be either UTF-8 strings or Buffers - this difference exists at
 * the protocol level, and is preserved here throughout.
 */
export class DataChannelStream extends stream.Duplex {

    private readonly channelId: number;
    private readonly channelLabel: string;
    private readonly channelProtocol: string;
    private pendingMessages: Array<string | Buffer> = [];

    constructor(
        private rawChannel: NodeDataChannel.DataChannel,
        streamOptions: {
            // These are the only Duplex options supported:
            readableHighWaterMark?: number | undefined;
            writableHighWaterMark?: number | undefined;
            allowHalfOpen?: boolean;
        } = {}
    ) {
        super({
            allowHalfOpen: false, // Default to autoclose on end().
            ...streamOptions,
            objectMode: true // Preserve the string/buffer distinction (WebRTC treats them differently)
        });

        this.channelId = rawChannel.getId();
        this.channelLabel = rawChannel.getLabel();
        this.channelProtocol = rawChannel.getProtocol();

        rawChannel.onMessage((msg) => {
            // Independently of the stream and it's normal events, we also fire our own
            // read/wrote-data events, used for MockRTC event subscriptions. These aren't
            // buffered, and this ensures that those events do not consume data that will
            // separately be processed by handler steps.
            const size = Buffer.isBuffer(msg) ? msg.byteLength : msg.length;
            console.log(`[MockRTC] DataChannelStream onMessage — channel="${this.channelLabel}" ${Buffer.isBuffer(msg) ? 'binary' : 'text'} ${size} bytes`);
            this.emit('read-data', msg);

            this.pendingMessages.push(msg);
            this.flushPendingMessages();
        });

        // When the DataChannel closes, the readable & writable ends close
        rawChannel.onClosed(() => {
            this.push(null);
            this.destroy();
        });

        rawChannel.onError((errMsg) => {
            this.destroy(new Error(`DataChannel error: ${errMsg}`));
        });

        // Buffer all writes until the DataChannel opens
        if (!rawChannel.isOpen()) {
            this.cork();
            rawChannel.onOpen(() => {
                this.uncork();
                this._isOpen = true;
                this.emit('channel-open');
            });
        } else {
            setImmediate(() => {
                this._isOpen = true;
                this.emit('channel-open');
            });
        }
    }

    private _isOpen = false;
    get isOpen() {
        return this._isOpen;
    }

    private _readActive = true;
    _read() {
        // Stop dropping messages, if the buffer filling up meant we were doing so before.
        this._readActive = true;
        this.flushPendingMessages();
    }

    private flushPendingMessages() {
        while (this._readActive && this.pendingMessages.length > 0) {
            const nextMessage = this.pendingMessages.shift()!;

            // If the push is rejected, we pause flushing until the next call to _read().
            this._readActive = this.push(nextMessage);
        }
    }

    _write(chunk: string | Buffer | unknown, encoding: string, callback: (error: Error | null) => void) {
        try {
            if (Buffer.isBuffer(chunk)) {
                this.rawChannel.sendMessageBinary(chunk as unknown as Uint8Array);
            } else if (typeof chunk === 'string') {
                this.rawChannel.sendMessage(chunk);
            } else {
                const typeName = (chunk as object).constructor.name || typeof chunk;
                throw new Error(`Cannot write ${typeName} to DataChannel stream`);
            }

            this.emit('wrote-data', chunk);
            callback(null);
        } catch (e) {
            callback(e as Error);
        }
    }

    _final(callback: (error: Error | null) => void) {
        if (!this.allowHalfOpen) this.destroy();
        callback(null);
    }

    _destroy(maybeErr: Error | null, callback: (error: Error | null) => void) {
        // When the stream is destroyed, we close the DataChannel.
        this.rawChannel.close();
        callback(maybeErr);
    }

    get id() {
        return this.channelId;
    }

    get label() {
        return this.channelLabel;
    }

    get protocol() {
        return this.channelProtocol;
    }

}
