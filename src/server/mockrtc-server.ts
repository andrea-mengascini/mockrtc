/*
 * SPDX-FileCopyrightText: 2022 Tim Perry <tim@httptoolkit.tech>
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from "path";
import { EventEmitter } from "events";

import { MockRTC, MockRTCEvent, MockRTCOptions } from "../mockrtc";
import { MockRTCBase } from "../mockrtc-base";
import { MockRTCServerPeer } from "./mockrtc-server-peer";
import { MockRTCPeer } from "../mockrtc-peer";
import { RTCConnection } from "../webrtc/rtc-connection";

import type { MatcherDefinition } from "../matching/matcher-definitions";
import { MatcherImpl, MatcherLookup } from "../matching/matcher-impls";
import type { BeforeDataChannelMessage, HandlerStepDefinition } from "../handling/handler-step-definitions";
import { DynamicProxyStepImpl, HandlerStepImpl, StepLookup } from "../handling/handler-step-impls";

function composeDataChannelRules(rules: any[]): BeforeDataChannelMessage {
    return async (msg, channel) => {
        for (const rule of rules) {
            if (rule.match(msg)) {
                const result = await rule.transform(msg, channel);
                if (result != null) return result;
            }
        }
    };
}

const MATCHING_PEER_ID = 'matching-peer';

export class MockRTCServer extends MockRTCBase implements MockRTC {

    private debug: boolean = false;

    constructor(
        private options: MockRTCOptions = {}
    ) {
        super();
        this.debug = !!options.debug;

        if (!options.beforeDataChannelMessage && process.env.WEBRTC_RULES) {
            try {
                const ruleOrRules = require(path.resolve(process.env.WEBRTC_RULES));
                const rules = Array.isArray(ruleOrRules) ? ruleOrRules : [ruleOrRules];
                this.options = { ...options, beforeDataChannelMessage: composeDataChannelRules(rules) };
                console.log(`[MockRTC] Loaded ${rules.length} data channel rule(s) from ${process.env.WEBRTC_RULES}`);
            } catch (e) {
                console.error('[MockRTC] Failed to load WEBRTC_RULES:', e);
            }
        }
    }

    private eventEmitter = new EventEmitter();

    async start(): Promise<void> {
        if (this.debug) console.log("Starting MockRTC mock session");

        this.matchingPeer = this._activePeers[MATCHING_PEER_ID] = new MockRTCServerPeer(
            this.matchConnection.bind(this),
            { ...this.options, peerId: MATCHING_PEER_ID },
            this.eventEmitter
        );
    }

    async stop(): Promise<void> {
        if (this.debug) console.log("Stopping MockRTC mock session");
        await this.reset();
    }

    async reset() {
        await Promise.all(
            this.activePeers.map(peer =>
                peer.close()
            )
        );

        this._activePeers = {};
        this.matchingPeer = undefined;
        this.rules = [];

        this.eventEmitter.removeAllListeners();
    }

    private _activePeers: { [id: string]: MockRTCServerPeer } = {};
    get activePeers(): Readonly<MockRTCServerPeer[]> {
        return Object.values(this._activePeers);
    }

    getPeer(id: string): MockRTCServerPeer {
        return this._activePeers[id];
    }

    async on(event: MockRTCEvent, callback: (...args: any) => void) {
        this.eventEmitter.on(event, callback);
    }

    // Matching API:

    private matchingPeer: MockRTCServerPeer | undefined;

    getMatchingPeer(): MockRTCPeer {
        if (!this.matchingPeer) {
            throw new Error('Cannot get matching peer as the mock session is not started');
        }

        return this.matchingPeer;
    }

    private rules: Array<{
        matchers: MatcherImpl[],
        handlerSteps: HandlerStepImpl[]
    }> = [];

    async setRulesFromDefinitions(
        rules: Array<{
            matchers: MatcherDefinition[],
            steps: HandlerStepDefinition[]
        }>
    ) {
        this.rules = [];
        await Promise.all(rules.map(({ matchers, steps }) =>
            this.addRuleFromDefinition(matchers, steps)
        ));
    }

    async addRuleFromDefinition(
        matcherDefinitions: MatcherDefinition[],
        handlerStepDefinitions: HandlerStepDefinition[]
    ) {
        const matchers = matcherDefinitions.map((definition): MatcherImpl => {
            return Object.assign(
                Object.create(MatcherLookup[definition.type].prototype),
                definition
            );
        });

        const handlerSteps = handlerStepDefinitions.map((definition): HandlerStepImpl => {
            const step = Object.assign(
                Object.create(StepLookup[definition.type].prototype),
                definition
            );
            this.injectHook(step);
            return step;
        });

        this.rules.push({ matchers, handlerSteps });
    }

    private async matchConnection(connection: RTCConnection) {
        if (this.debug) console.log('Matching incoming RTC connection...');
        await connection.waitUntilConnected();

        for (const rule of this.rules) {
            const matches = rule.matchers.every(matcher => matcher.matches(connection));

            if (matches) {
                if (this.debug) console.log(`Matched incoming RTC connection, running steps: ${
                    rule.handlerSteps.map(s => s.type).join(', ')
                }`);

                return rule.handlerSteps;
            }
        }

        if (this.debug) console.log('RTC connection did not match any rules');

        // Unmatched connections are proxied dynamically. In practice, that means they're accepted
        // and ignored initially, unless an external peer also connects and is attached:
        console.log(`[MockRTC] matchConnection → DynamicProxy hook=${!!this.options.beforeDataChannelMessage}`);
        return [new DynamicProxyStepImpl({ beforeDataChannelMessage: this.options.beforeDataChannelMessage })];
    }

    // Peer definition API:

    private injectHook(step: HandlerStepImpl): void {
        if (step.type === 'rtc-dynamic-proxy' && this.options.beforeDataChannelMessage) {
            const dynStep = step as DynamicProxyStepImpl;
            if (!dynStep.beforeDataChannelMessage) {
                dynStep.beforeDataChannelMessage = this.options.beforeDataChannelMessage;
            }
        }
    }

    async buildPeerFromDefinition(handlerStepDefinitions: HandlerStepDefinition[]): Promise<MockRTCServerPeer> {
        const handlerSteps = handlerStepDefinitions.map((definition): HandlerStepImpl => {
            const step = Object.assign(
                Object.create(StepLookup[definition.type].prototype),
                definition
            );
            this.injectHook(step);
            return step;
        });
        const peer = new MockRTCServerPeer(
            () => handlerSteps, // Always runs a fixed set of steps
            this.options,
            this.eventEmitter
        );
        this._activePeers[peer.peerId] = peer;
        if (this.debug) console.log(
            `Built MockRTC peer ${peer.peerId} with steps: ${handlerStepDefinitions.map(d => d.type).join(', ')}`
        );
        return peer;
    }

}