import http from 'http';
import { BASE_RPC_URL } from './utils.js';

const PORT = 42069;
const TARGET_URL = new URL(BASE_RPC_URL);

const server = http.createServer(async (req, res) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  if (body.length > 0) console.log('→ Request:', body.toString());

  const options = {
    hostname: TARGET_URL.hostname,
    port: TARGET_URL.port || 443,
    path: TARGET_URL.pathname,
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    },
  };

  const protocol = TARGET_URL.protocol === 'https:' ? await import('https') : http;

  const proxyReq = protocol.default.request(options, (proxyRes) => {
    const responseChunks = [];
    proxyRes.on('data', (chunk) => responseChunks.push(chunk));
    proxyRes.on('end', () => {
      const responseBody = Buffer.concat(responseChunks);

      if (responseBody.length > 0 && responseBody.length < 1000) {
        console.log('← Response:', responseBody.toString());
      }

      res.writeHead(proxyRes.statusCode, {
        ...corsHeaders,
        'Content-Type': proxyRes.headers['content-type'] || 'application/json',
      });
      res.end(responseBody);
    });
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err);
    res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
  });

  proxyReq.write(body);
  proxyReq.end();
});

server.listen(PORT, () => {
  console.log(`Proxy server running at http://localhost:${PORT}`);
  console.log(`Forwarding requests to ${BASE_RPC_URL}`);
});
