import autocannon from "autocannon";

const url = process.env.TARGET_URL ?? "http://localhost:8080";
const duration = Number(process.env.DURATION ?? 10);
const connections = Number(process.env.CONNECTIONS ?? 100);

const instance = autocannon({
  url: `${url}/healthz`,
  duration,
  connections,
  pipelining: 1,
});

autocannon.track(instance);

instance.on("done", (result) => {
  const p99 = result.latency.p99;
  const rps = result.requests.average;
  console.log(`\np99 latency: ${p99}ms`);
  console.log(`Average RPS: ${rps}`);
  if (p99 > 50) {
    console.error("FAIL: p99 edge overhead exceeds 50ms");
    process.exit(1);
  }
  if (rps < 1000) {
    console.error("FAIL: throughput below 1000 RPS for this connection count");
    process.exit(1);
  }
  console.log("PASS");
});