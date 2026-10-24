const http = require('http');
const dgram = require('dgram');
const dns = require('dns');
const bedrock = require('bedrock-protocol');

// ================= CONFIGURAÇÃO =================
// O bot tenta o primeiro endereço; se falhar, tenta o próximo, e assim por diante.
const targets = [
  { host: 'servidorescola.falixsrv.me', port: 19132 },
  { host: '192.200.119.234', port: 11645 },
];
const USERNAME = 'Bot_AFK_247';
const VERSION = process.env.BEDROCK_VERSION || undefined; // ex: '1.21.80'
// ================================================

let targetIndex = 0;
let client = null;
let status = 'iniciando';
let attempts = 0;
let reconnectTimer = null;
let joinTimeout = null;

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const current_target = () => targets[targetIndex];

// ============ TESTE DE REDE (diagnóstico) ============
// Manda um "ping" UDP do tipo RakNet direto ao servidor, sem usar o bot,
// para mostrar no log se a hospedagem consegue falar com o Minecraft.
const RAK_MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');

function probe(t) {
  dns.lookup(t.host, { family: 4 }, (err, addr) => {
    if (err) return log(`[teste] DNS falhou para ${t.host}: ${err.code}`);
    log(`[teste] ${t.host} resolve para ${addr}`);
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = () => { if (!done) { done = true; try { sock.close(); } catch (_) {} } };
    const pkt = Buffer.alloc(33);
    pkt[0] = 0x01;
    pkt.writeBigInt64BE(BigInt(Date.now()), 1);
    RAK_MAGIC.copy(pkt, 9);
    pkt.writeBigInt64BE(123456789n, 25);
    const timer = setTimeout(() => {
      log(`[teste] SEM RESPOSTA UDP de ${addr}:${t.port} em 6s -> a hospedagem não alcança o servidor por UDP, ou o servidor não está respondendo nesse endereço/porta`);
      finish();
    }, 6000);
    sock.on('error', (e) => { clearTimeout(timer); log('[teste] erro de socket UDP:', e.code || e.message); finish(); });
    sock.on('message', (msg) => {
      clearTimeout(timer);
      if (msg[0] === 0x1c && msg.length > 35) {
        const len = msg.readUInt16BE(33);
        const info = msg.slice(35, 35 + len).toString('utf8');
        const f = info.split(';');
        log(`[teste] UDP OK! O servidor respondeu: nome="${f[1]}" protocolo=${f[2]} versao=${f[3]} jogadores=${f[4]}/${f[5]}`);
      } else {
        log('[teste] UDP OK, mas a resposta veio em formato inesperado');
      }
      finish();
    });
    sock.send(pkt, t.port, addr, (e) => { if (e) { clearTimeout(timer); log('[teste] falha ao enviar UDP:', e.code || e.message); finish(); } });
  });
}

function cleanup() {
  clearTimeout(joinTimeout);
  if (client) {
    try { client.removeAllListeners(); client.on('error', () => {}); client.close(); } catch (_) {}
    client = null;
  }
}

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  cleanup();
  attempts++;
  // passa para o próximo endereço da lista
  targetIndex = (targetIndex + 1) % targets.length;
  const delay = Math.min(5000 * attempts, 60000); // 5s, 10s, ... máx 60s
  const next = current_target();
  status = `reconectando em ${delay / 1000}s (${reason}) -> próximo: ${next.host}:${next.port}`;
  log(status);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  cleanup();
  const t = current_target();
  status = `conectando em ${t.host}:${t.port}`;
  log(status);
  probe(t);

  const opts = {
    host: t.host,
    port: t.port,
    username: USERNAME,
    offline: true,
    skipPing: true,
    useNativeRaknet: false, // usa RakNet em JS (não precisa compilar nada)
  };
  if (VERSION) opts.version = VERSION;

  try {
    client = bedrock.createClient(opts);
  } catch (err) {
    return scheduleReconnect('erro ao criar cliente: ' + err.message);
  }

  const current = client;
  const guard = (fn) => (...args) => { if (client === current) fn(...args); };

  // se não entrar em 45s, tenta o próximo endereço
  joinTimeout = setTimeout(() => scheduleReconnect('timeout ao entrar'), 45000);

  current.on('spawn', guard(() => {
    clearTimeout(joinTimeout);
    attempts = 0;
    status = `online em ${t.host}:${t.port}`;
    log('Bot entrou no servidor!', t.host, t.port);
  }));
  current.on('kick', guard((p) => scheduleReconnect('kick: ' + (p?.message || 'sem motivo'))));
  current.on('disconnect', guard((p) => scheduleReconnect('disconnect: ' + (p?.message || 'sem motivo'))));
  current.on('close', guard(() => scheduleReconnect('conexão fechada')));
  current.on('error', guard((err) => scheduleReconnect('erro: ' + (err?.message || err))));
}

// ============ SERVIDOR HTTP (mantém a hospedagem ativa) ============
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Trocar o endereço principal sem redeploy: /set?host=IP&port=PORTA
  if (url.pathname === '/set') {
    const host = url.searchParams.get('host');
    const port = parseInt(url.searchParams.get('port'), 10);
    if (host) targets[0].host = host;
    if (port) targets[0].port = port;
    targetIndex = 0;
    attempts = 0;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connect();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`Reconectando em ${targets[0].host}:${targets[0].port}`);
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`Bot_AFK_247 ativo\nStatus: ${status}`);
});

server.listen(process.env.PORT || 3000, () => {
  log('HTTP rodando na porta', process.env.PORT || 3000);
});

// Auto-ping: evita que a hospedagem (Render) durma por falta de acessos
const selfUrl = process.env.RENDER_EXTERNAL_URL;
if (selfUrl) {
  setInterval(() => {
    fetch(selfUrl).then(() => log('auto-ping ok')).catch((e) => log('auto-ping falhou:', e.message));
  }, 10 * 60 * 1000);
}

// Evita que o processo caia por erros inesperados
process.on('uncaughtException', (e) => log('uncaughtException:', e.message));
process.on('unhandledRejection', (e) => log('unhandledRejection:', e?.message || e));

connect();
