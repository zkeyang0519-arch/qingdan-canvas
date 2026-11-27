import { request } from "node:http";

// Node fetch rewrites Sec-Fetch-Mode to cors. Use an HTTP request to reproduce
// actual browser navigation headers instead of weakening the callback guard.
export function navigationRequest(url, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          for (const item of Array.isArray(value) ? value : [value])
            if (item !== undefined) responseHeaders.append(name, item);
        }
        resolve(
          new Response(Buffer.concat(chunks), {
            status: res.statusCode,
            headers: responseHeaders,
          }),
        );
      });
    });
    req.on("error", reject);
    req.end();
  });
}
