import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export function wsFrame(opcode, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let head;
  if (payload.length < 126) head = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length <= 65535) head = Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]);
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([head, payload]);
}
export async function socketServer({ onSubscribe, onClose, reject, onUpgrade } = {}) {
  const peers = new Set(), requests = [], events = [], timers = new Set();
  const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); };
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    peers.add(socket); requests.push({ url: request.url, headers: request.headers });
    socket.on('error', () => {}); socket.on('end', () => { events.push('tcp-ended'); socket.end(); }); socket.on('close', () => { peers.delete(socket); events.push('tcp-closed'); });
    if (reject) { const response = reject(request); if(response) { socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${response.status} Test\r\nConnection: close\r\n${Object.entries(response.headers ?? {}).map(([k,v]) => `${k}: ${v}\r\n`).join('')}Content-Length: ${Buffer.byteLength(response.body ?? '')}\r\n\r\n`), Buffer.from(response.body ?? '')])); return; } }
    if (onUpgrade?.(request, socket) === false) return;
    const key = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
    let pending = Buffer.alloc(0);
    socket.on('data', bytes => {
      pending = Buffer.concat([pending, bytes]);
      for (;;) {
        if (pending.length < 2) return;
        let size = pending[1] & 127, offset = 2;
        if (size === 126) { if (pending.length < 4) return; size = pending.readUInt16BE(2); offset = 4; }
        if (size === 127) { if (pending.length < 10) return; size = Number(pending.readBigUInt64BE(2)); offset = 10; }
        const masked = Boolean(pending[1] & 128), maskSize = masked ? 4 : 0;
        if (pending.length < offset + maskSize + size) return;
        const opcode = pending[0] & 15, mask = pending.subarray(offset, offset + maskSize); offset += maskSize;
        const data = Buffer.from(pending.subarray(offset, offset + size)); pending = pending.subarray(offset + size);
        if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        if (opcode === 1) {
          const commands = JSON.parse(data.toString());
          const topic = commands.find(c => c.command?.type === 'subscribe')?.command.topic_id;
          if (topic) { events.push('subscribed'); socket.write(wsFrame(1, JSON.stringify([{ id: 2, reply: { type: 'subscribe', topic_id: topic, recovered: false } }]))); onSubscribe?.({ socket, topic, later, requests, events }); }
        } else if (opcode === 8) { events.push('client-close'); onClose?.({ socket, payload: data, later, events }); }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `ws://127.0.0.1:${server.address().port}`, peers, requests, events,
    close: async () => { for (const timer of timers) clearTimeout(timer); for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
