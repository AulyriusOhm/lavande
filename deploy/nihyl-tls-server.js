const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');

const LISTEN = { host: process.env.LISTEN_HOST || '10.1.50.10', port: Number(process.env.LISTEN_PORT || 443) };
const TARGET = { host: process.env.TARGET_HOST || '127.0.0.1', port: Number(process.env.TARGET_PORT || 3030) };
const tls = {
  key: fs.readFileSync(process.env.TLS_KEY || '/certs/tls.key'),
  cert: fs.readFileSync(process.env.TLS_CERT || '/certs/tls.crt'),
};

function forwardHeaders(req) {
  const headers = Object.assign({}, req.headers);
  const peer = req.socket.remoteAddress;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-for'] = (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'] + ', ' : '') + peer;
  return headers;
}

const server = https.createServer(tls, (req, res) => {
  // Maquette « Widget Lavande » : le portail dev (8443) la sert sous /widget ;
  // le bastion n'a pas de route /widget, on redirige sans toucher au proxy.
  if (/^\/widget\/?(\?.*)?$/.test(req.url)) {
    res.writeHead(302, { Location: 'https://plasma.int.lanro.eu:8443/widget' });
    res.end();
    return;
  }
  const upstream = http.request(
    { host: TARGET.host, port: TARGET.port, method: req.method, path: req.url, headers: forwardHeaders(req) },
    (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); }
  );
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('bad gateway'); });
  req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(TARGET.port, TARGET.host, () => {
    let raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
    const headers = forwardHeaders(req);
    for (const name of Object.keys(headers)) raw += name + ': ' + headers[name] + '\r\n';
    raw += '\r\n';
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });

server.listen(LISTEN.port, LISTEN.host, () => console.log('tls-proxy ' + LISTEN.host + ':' + LISTEN.port + ' -> ' + TARGET.host + ':' + TARGET.port));
