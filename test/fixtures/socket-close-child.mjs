import { DotLive } from '../../src/live.mjs';
import { createWebSocket } from '../../src/websocket.mjs';
const [url,mode] = process.argv.slice(2), started = Date.now(), events = [];
const client = { transport: { authLoader: async () => ({accessToken:'synthetic',accountId:'account'}), request: async () => ({websocket_url:'wss://ws.chatgpt.com/synthetic'}) }, resolveRoom: async () => 'room', history: async () => ({messages:[],newestItemId:null}) };
const controller = new AbortController();
const live = new DotLive(client, { webSocketFactory: () => { const socket = createWebSocket(url); socket.addEventListener('close', () => { events.push('transport-closed'); console.log(JSON.stringify({event:'transport-closed',elapsed:Date.now()-started})); }); return socket; } });
await live.watch({roomId:'room',signal:controller.signal,reconnect:false,
  onReady: () => { if (mode !== 'callback') controller.abort(); },
  onEvent: async event => { if (mode === 'callback' && event.type === 'read') { events.push('callback-started'); controller.abort(); await new Promise(resolve => setTimeout(resolve,25)); events.push('callback-finished'); } }
});
console.log(JSON.stringify({event:'watch-finished',elapsed:Date.now()-started,events}));
