import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import * as u from './utils.ts';

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, u.CORS_HEADERS);
    res.end();
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  const testCaseName = u.getTestCaseName(body);
  const requestFile = u.join(u.fixtureDir, `proxy-request-${testCaseName}.json`);
  try {
    u.writeFileSync(requestFile, body);
  } catch (err: any) {
    console.error('Failed to write request file:', err.message);
  }

  if (body.length > 0 && body.length < 500) {
    console.log(`→ [${testCaseName}] Request:`, body.toString());
  } else if (body.length > 0) {
    console.log(`→ [${testCaseName}] Request: ${body.length} bytes`);
  }

  const targetUrl = u.getNextEndpoint();
  const url = new URL(targetUrl);
  console.log(`   Using endpoint: ${targetUrl}`);

  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    },
  };

  const protocol = url.protocol === 'https:' ? await import('node:https') : http;

  const proxyReq = protocol.request(options, (proxyRes) => {
    const responseChunks: Buffer[] = [];
    proxyRes.on('data', (chunk: Buffer) => responseChunks.push(chunk));
    proxyRes.on('end', () => {
      const responseBody = Buffer.concat(responseChunks);
      const responseFile = u.join(u.fixtureDir, `proxy-response-${testCaseName}.json`);
      try {
        u.writeFileSync(responseFile, responseBody);
      } catch (err: any) {
        console.error('Failed to write response file:', err.message);
      }

      if (responseBody.length > 0 && responseBody.length < 500) {
        console.log(`← [${testCaseName}] Response:`, responseBody.toString());
      } else if (responseBody.length > 0) {
        console.log(`← [${testCaseName}] Response: ${responseBody.length} bytes`);
      }

      res.writeHead(proxyRes.statusCode || 200, {
        ...u.CORS_HEADERS,
        'Content-Type': proxyRes.headers['content-type'] || 'application/json',
      });
      res.end(responseBody);
    });
  });

  proxyReq.on('error', (err: Error) => {
    console.error('Proxy error:', err);
    res.writeHead(502, { ...u.CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
  });

  proxyReq.write(body);
  proxyReq.end();
}

const server = http.createServer(handleRequest);

server.listen(u.PROXY_PORT, () => {
  console.log(`Proxy server running at http://localhost:${u.PROXY_PORT}`);
  u.RPC_ENDPOINTS.forEach((endpoint, i) => {
    console.log(`  ${i + 1}. ${endpoint}`);
  });
  console.log('\nRequest/Response logs: test/fixture/proxy-{request,response}-<testcase>.json');
});
