import { createServer } from "node:http";

export const textItem = (text) => ({
  type: "message",
  role: "assistant",
  id: "msg_fixture",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
export const callItem = (name, args, callId = "call_fixture") => ({
  type: "function_call",
  name,
  id: "fc_fixture",
  call_id: callId,
  arguments: JSON.stringify(args),
  status: "completed",
});

export async function openResponsesFixture(answer) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      req.setEncoding("utf8");
      for await (const chunk of req) raw += chunk;
      const call = {
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: JSON.parse(raw),
      };
      requests.push(call);
      const item = await answer(call, requests.length);
      if (item.httpStatus) {
        res.writeHead(item.httpStatus, {
          "Content-Type": "application/json",
          ...item.headers,
        });
        return res.end(
          JSON.stringify({ error: { code: item.code, message: item.message } }),
        );
      }
      const events = [
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: { id: "resp_fixture", status: "completed", output: [item] },
        },
      ];
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        events
          .map(
            (e) => "event: " + e.type + "\ndata: " + JSON.stringify(e) + "\n\n",
          )
          .join(""),
      );
    } catch {
      res.writeHead(400);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = "http://127.0.0.1:" + server.address().port + "/v1";
  const settings = {
    model: "gpt-6.1-sol",
    baseUrl,
    apiKey: async () => "local-fixture-only",
    setupHint: "测试端点",
    status: async () => ({
      runtime: "Pi RPC 1.5.2",
      model: "gpt-6.1-sol",
      host: "127.0.0.1",
      configured: true,
      format: "responses",
    }),
  };
  return {
    settings,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
