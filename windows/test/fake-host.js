import net from 'node:net';

export const fabricated = {
  bundleId: 'win.notepad.exe',
  displayUUID: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  processStartedAt: 1763700000.25,
};
export const windowsPacket = { protocol: 1, type: 'windows',
  displays: [{ kind: 'desktop', displayId: 7, displayUUID: fabricated.displayUUID, main: true,
    displayConfiguration: { boundsPoints: [0, 0, 1920, 1080], pixelWidth: 1920, pixelHeight: 1080, rotation: 0, scaleX: 1, scaleY: 1 } }],
  windows: [{ windowId: 4242, pid: 100, bundleId: fabricated.bundleId, title: 'notepad', displayName: 'notepad',
    processStartedAt: fabricated.processStartedAt, windowRectPoints: [10, 20, 800, 600] }] };
export const diagnosticPacket = { protocol: 1, type: 'diagnostic', code: 'permission_preflight',
  bundleId: 'com.factory.applets.host', bundlePath: 'C:\\relay', executablePath: 'C:\\relay\\Windows.exe',
  screenRecording: true, accessibility: true, permissionRequested: false, launchMode: 'launchservices-ipc', processId: 100,
  lifecycle: { appKitInitialized: true, eventLoopRunning: true, launchFinished: true, mainThread: true }, stage: 'app_ready' };

export const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
export const line = value => Buffer.from(JSON.stringify(value) + '\n');
export function frame(sequence, target, overrides = {}, image = jpeg) {
  const header = Buffer.from(JSON.stringify({ protocol: 1, type: 'frame', sequence, ...target, mediaType: 'image/jpeg',
    width: 200, height: 100, captureTimeSeconds: 10, sentUptimeSeconds: 10.5, contentRectPixels: [0, 0, 200, 100],
    initialWindowRectPoints: [10, 20, 800, 600], processStartedAt: fabricated.processStartedAt,
    contentScale: 1, scaleFactor: 1, replacedFrames: 0, bytes: image.length, ...overrides }));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(header.length);
  return Buffer.concat([size, header, image]);
}

/** Host side of the supervisor contract over a Unix socket; "script" decides what each request gets. */
export function startFakeHost(endpoint, script, { hello = { protocol: 1, type: 'hello', pid: 100 } } = {}) {
  const seen = { requests: [], acks: 0 };
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    let pending = Buffer.alloc(0), requested = false;
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (!requested) {
        const end = pending.indexOf(10);
        if (end < 0) return;
        requested = true;
        const args = JSON.parse(pending.subarray(0, end).toString());
        pending = pending.subarray(end + 1);
        seen.requests.push(args);
        script({ args, socket, seen });
      }
      if (!pending.length) return;
      seen.acks += pending.length;
      pending = Buffer.alloc(0);
      socket.emit('acks');
    });
    socket.write(line(hello));
  });
  return new Promise(resolve => server.listen(endpoint, () => resolve({ seen, close: () => new Promise(done => server.close(done)) })));
}
