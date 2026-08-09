const http = require("http");
const app = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url === "/v1/sessions")
    return res.end(JSON.stringify({ accessToken: "a", refreshToken: "r", tokenType: "Bearer", expiresIn: 3600 }));
  if (req.url?.startsWith("/v1/users/"))
    return res.end(JSON.stringify({ userId: req.url.split("/").pop() }));
  if (req.url?.startsWith("/v1/kyc/") && !req.url.endsWith("/start"))
    return res.end(JSON.stringify({ userId: req.url.split("/").pop(), status: "not_started" }));
  if (req.url === "/v1/kyc/start")
    return res.end(JSON.stringify({ referenceId: "k1", status: "pending", createdAt: new Date().toISOString() }));
  if (req.url === "/v1/quotes")
    return res.end(
      JSON.stringify({
        quoteId: "q1",
        baseCurrency: "USD",
        quoteCurrency: "ETH",
        baseAmount: "100",
        quoteAmount: "0.05",
        rate: "0.0005",
        expiresAt: new Date().toISOString(),
        paymentMethod: "card",
        fees: { network: "1", partner: "0", total: "1" },
      }),
    );
  if (req.url === "/v1/transactions")
    return res.end(JSON.stringify({ transactionId: "t1", status: "pending_payment", createdAt: new Date().toISOString() }));
  if (req.url?.startsWith("/v1/transactions/"))
    return res.end(
      JSON.stringify({ sagaState: "INITIATED", transactionId: req.url.split("/").pop(), createdAt: new Date().toISOString() }),
    );
  if (req.url === "/v1/partner/api-keys/verify")
    return res.end(JSON.stringify({ partnerId: "p1", identity: "partner-1" }));
  if (req.url === "/v1/partner/webhooks")
    return res.end(
      JSON.stringify({ webhookId: "w1", url: "https://x.com", events: ["transaction.completed"], createdAt: new Date().toISOString() }),
    );
  res.end("{}");
});
app.listen(8080);