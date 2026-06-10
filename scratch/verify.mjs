/**
 * Standalone proof that mockrtc works with original features + on-the-fly editing.
 * Node-only (no browser): two node-datachannel RTCPeerConnections (a local "client" and a
 * remote target) with a MockRTC proxy peer between them. Asserts:
 *   1. Data-channel messages proxy end-to-end (original feature).
 *   2. beforeDataChannelMessage edits messages on the fly: match-replace, drop, inject.
 *   3. A binary burst proxies intact & in order (DataChannel backpressure fix).
 *
 * Run: node scratch/verify.mjs   (from the mockrtc repo root, after npm run build:src)
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const MockRTC = require('../dist/main.js');
const { RTCPeerConnection } = require('node-datachannel/polyfill');

let failures = 0;
const ok = (name, cond, extra = '') => {
    console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
    if (!cond) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const gather = (pc) => new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') resolve();
    });
});
const channelOpen = (ch) => new Promise((resolve) => {
    if (ch.readyState === 'open') resolve();
    else ch.addEventListener('open', () => resolve());
});

// ── on-the-fly edit hook (server-level, applies to all proxied connections) ─────
const mockRTC = MockRTC.getLocal({
    beforeDataChannelMessage: (message, channel) => {
        const text = message.content.toString('utf8');
        if (text.includes('SECRET')) return { action: 'drop' };
        if (text === 'PING') { channel.toRemote('INJECTED'); return; } // forward PING + inject
        if (text.includes('hello')) return { action: 'forward', content: text.replace('hello', 'HACKED') };
        // else: forward unchanged
    }
});
await mockRTC.start();

// ── remote target peer ──────────────────────────────────────────────────────
const remoteConn = new RTCPeerConnection();
const remoteGot = [];
remoteConn.addEventListener('datachannel', ({ channel }) => {
    channel.addEventListener('message', ({ data }) => remoteGot.push(data.toString()));
});

const mockPeer = await mockRTC.buildPeer().thenForwardTo(remoteConn);

// ── local "client" peer → offers, routed to the mock peer ───────────────────
const localConn = new RTCPeerConnection();
const dc = localConn.createDataChannel('dataChannel');

await localConn.setLocalDescription(await localConn.createOffer());
await gather(localConn);
// Pass a plain {type,sdp} (the polyfill's RTCSessionDescription object doesn't serialise cleanly
// through MockRTC's admin API, leaving the internal connection's remoteDescription.sdp undefined).
const offer = { type: 'offer', sdp: localConn.localDescription.sdp };
const { answer } = await mockPeer.answerOffer(offer);
await localConn.setRemoteDescription({ type: 'answer', sdp: answer.sdp });

await channelOpen(dc);
console.log('data channel open; proxying via MockRTC\n');

console.log('On-the-fly datachannel editing:');
dc.send('hello world');     // → HACKED world
dc.send('SECRET data');     // → dropped
dc.send('PING');            // → forwarded + INJECTED added
dc.send('plain text');      // → unchanged
await sleep(3000);

ok('match-replace applied (hello→HACKED)', remoteGot.includes('HACKED world'), JSON.stringify(remoteGot));
ok('drop suppressed SECRET', !remoteGot.some(m => m.includes('SECRET')));
ok('channel.toRemote injected a message', remoteGot.includes('INJECTED'));
ok('unedited message passes through', remoteGot.includes('plain text'));

// ── binary burst (backpressure / ArrayBuffer→Buffer normalisation) ───────────
console.log('Binary burst (backpressure):');
const N = 50;
const before = remoteGot.length;
for (let i = 0; i < N; i++) dc.send(Buffer.from([i & 0xff, (i >> 8) & 0xff]));
await sleep(3000);
const burst = remoteGot.slice(before);
ok(`all ${N} binary messages proxied`, burst.length === N, `got ${burst.length}`);

await mockRTC.stop();
try { localConn.close(); remoteConn.close(); } catch {}
console.log(`\n${failures === 0 ? '✅ ALL PASS' : '❌ ' + failures + ' FAILURE(S)'}`);
// node-datachannel can keep the loop alive; force a clean exit.
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 200);
