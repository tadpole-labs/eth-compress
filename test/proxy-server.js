import { writeFileSync } from 'fs';
import http from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 42069;

// Round-robin RPC endpoints
const RPC_ENDPOINTS = [
  'https://developer-access-mainnet.base.org',
  'https://base.drpc.org',
  'https://base.llamarpc.com',
];

let currentEndpointIndex = 0;

const getNextEndpoint = () => {
  const endpoint = RPC_ENDPOINTS[currentEndpointIndex];
  currentEndpointIndex = (currentEndpointIndex + 1) % RPC_ENDPOINTS.length;
  return endpoint;
};

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

  // Parse request to determine test case name
  let testCaseName = 'unknown';
  try {
    const requestJson = JSON.parse(body.toString());
    const method = requestJson.method || 'unknown';
    const id = requestJson.id !== undefined ? requestJson.id : 'no-id';

    // Check if it's an eth_call with state override (compressed)
    if (method === 'eth_call' && requestJson.params && requestJson.params.length >= 3) {
      const stateOverride = requestJson.params[2];
      if (stateOverride && Object.keys(stateOverride).length > 0) {
        testCaseName = `eth_call_compressed_${id}`;
      } else {
        testCaseName = `eth_call_${id}`;
      }
    } else {
      testCaseName = `${method}_${id}`;
    }
  } catch (err) {
    testCaseName = `raw_${Date.now()}`;
  }

  // Write request to file (per test case)
  const requestFile = join(__dirname, 'fixture', `proxy-request-${testCaseName}.json`);
  try {
    writeFileSync(requestFile, body);
  } catch (err) {
    console.error('Failed to write request file:', err.message);
  }

  if (body.length > 0 && body.length < 500) {
    console.log(`→ [${testCaseName}] Request:`, body.toString());
  } else if (body.length > 0) {
    console.log(`→ [${testCaseName}] Request: ${body.length} bytes`);
  }

  const targetUrl = getNextEndpoint();
  const TARGET_URL = new URL(targetUrl);

  console.log(`   Using endpoint: ${targetUrl}`);

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

      // Write response to file (per test case)
      const responseFile = join(__dirname, 'fixture', `proxy-response-${testCaseName}.json`);
      try {
        writeFileSync(responseFile, responseBody);
      } catch (err) {
        console.error('Failed to write response file:', err.message);
      }

      if (responseBody.length > 0 && responseBody.length < 500) {
        console.log(`← [${testCaseName}] Response:`, responseBody.toString());
      } else if (responseBody.length > 0) {
        console.log(`← [${testCaseName}] Response: ${responseBody.length} bytes`);
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
  console.log('Round-robin endpoints:');
  RPC_ENDPOINTS.forEach((endpoint, i) => {
    console.log(`  ${i + 1}. ${endpoint}`);
  });
  console.log('\nRequest/Response logs: test/fixture/proxy-{request,response}-<testcase>.json');
});
