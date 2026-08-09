import { trace, context, propagation, type Span, type Tracer } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { FastifyInstrumentation } from "@opentelemetry/instrumentation-fastify";
import type { AppConfig } from "../config.js";

export interface Tracing {
  tracer(): Tracer;
  startSpan(name: string): Span | undefined;
  inject(): Record<string, string>;
  shutdown(): Promise<void>;
  started: boolean;
}

class NoopTracing implements Tracing {
  started = false;
  tracer(): Tracer {
    return trace.getTracer("noop");
  }
  startSpan(): undefined {
    return undefined;
  }
  inject(): Record<string, string> {
    return {};
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export function createTracing(config: AppConfig): Tracing {
  const endpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    return new NoopTracing();
  }
  const exporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
  const resource = resourceFromAttributes({
    [SemanticResourceAttributes.SERVICE_NAME]: config.OTEL_SERVICE_NAME,
  });
  const sdk = new NodeSDK({
    traceExporter: exporter,
    resource,
    instrumentations: [new HttpInstrumentation(), new FastifyInstrumentation()],
  });
  sdk.start();
  return {
    started: true,
    tracer() {
      return trace.getTracer(config.OTEL_SERVICE_NAME);
    },
    startSpan(name) {
      return this.tracer().startSpan(name);
    },
    inject() {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      return carrier;
    },
    async shutdown() {
      await sdk.shutdown();
    },
  };
}