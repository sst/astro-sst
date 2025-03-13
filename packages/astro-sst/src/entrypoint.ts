import fs from "fs/promises";
import type { SSRManifest } from "astro";
import type {
  APIGatewayProxyEventV2,
  CloudFrontRequestEvent,
  Callback,
  Context,
} from "aws-lambda";
import { NodeApp, applyPolyfills } from "astro/app/node";
import type { IntegrationConfig } from "./lib/build-meta";
import { InternalEvent, convertFrom, convertTo } from "./lib/event-mapper.js";
import { debug } from "./lib/logger.js";
import { ResponseStream } from "./lib/types";

type RequestHandler = (
  event: APIGatewayProxyEventV2,
  streamResponse: ResponseStream,
  context?: Context,
  callback?: Callback
) => void | Promise<void>;

applyPolyfills();

declare global {
  const awslambda: {
    streamifyResponse(handler: RequestHandler): RequestHandler;
    HttpResponseStream: {
      from(
        underlyingStream: ResponseStream,
        metadata: {
          statusCode: number;
          headers?: Record<string, string>;
        }
      ): ResponseStream;
    };
  };
}

function createRequest(internalEvent: InternalEvent) {
  const requestUrl = internalEvent.url;
  const requestProps = {
    method: internalEvent.method,
    headers: internalEvent.headers,
    body: ["GET", "HEAD"].includes(internalEvent.method)
      ? undefined
      : internalEvent.body,
  };
  return new Request(requestUrl, requestProps);
}

export function createExports(
  manifest: SSRManifest,
  { responseMode }: IntegrationConfig
) {
  debug("handlerInit", responseMode);

  const isStreaming = responseMode === "stream";
  const app = new NodeApp(manifest);

  function build404Url(url: string) {
    const url404 = new URL(url);
    url404.pathname = "/404";
    url404.search = "";
    url404.hash = "";
    return url404.toString();
  }

  async function streamHandler(
    event: APIGatewayProxyEventV2,
    responseStream: ResponseStream
  ) {
    debug("event", event);

    const internalEvent = convertFrom(event);
    let request = createRequest(internalEvent);
    let routeData = app.match(request);
    if (!routeData) {
      // handle prerendered 404
      if (await existsAsync("404.html")) {
        return streamError(
          404,
          await fs.readFile("404.html", "utf-8"),
          responseStream
        );
      }

      // handle server-side 404
      request = createRequest({
        ...internalEvent,
        url: build404Url(internalEvent.url),
      });
      routeData = app.match(request);
      if (!routeData) {
        return streamError(404, "Not found", responseStream);
      }
    }

    const response = await app.render(request, {
      routeData,
      clientAddress:
        internalEvent.headers["x-forwarded-for"] || internalEvent.remoteAddress,
    });

    // Stream response back to Cloudfront
    const convertedResponse = await convertTo({
      type: internalEvent.type,
      response,
      responseStream,
      cookies: Array.from(app.setCookieHeaders(response)),
    });

    debug("response", convertedResponse);
  }

  async function bufferHandler(
    event: APIGatewayProxyEventV2 | CloudFrontRequestEvent
  ) {
    debug("event", event);

    const internalEvent = convertFrom(event);
    let request = createRequest(internalEvent);
    let routeData = app.match(request);
    if (!routeData) {
      // handle prerendered 404
      if (await existsAsync("404.html")) {
        return convertTo({
          type: internalEvent.type,
          response: new Response(await fs.readFile("404.html", "utf-8"), {
            status: 404,
            headers: {
              "Content-Type": "text/html",
            },
          }),
        });
      }

      // handle server-side 404
      request = createRequest({
        ...internalEvent,
        url: build404Url(internalEvent.url),
      });
      routeData = app.match(request);
      if (!routeData) {
        return convertTo({
          type: internalEvent.type,
          response: new Response("Not found", { status: 404 }),
        });
      }
    }

    // Process request
    const response = await app.render(request, {
      routeData,
      clientAddress:
        internalEvent.headers["x-forwarded-for"] || internalEvent.remoteAddress,
    });

    // Buffer response back to Cloudfront
    const convertedResponse = await convertTo({
      type: internalEvent.type,
      response,
      cookies: Array.from(app.setCookieHeaders(response)),
    });

    debug("response", convertedResponse);
    return convertedResponse;
  }

  return {
    // https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html
    handler: isStreaming
      ? awslambda.streamifyResponse(streamHandler)
      : bufferHandler,
  };
}

export function streamError(
  statusCode: number,
  error: string | Error,
  responseStream: ResponseStream
) {
  console.error(error);

  responseStream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: {
      "Content-Type": "text/html",
    },
  });

  responseStream.write(error.toString());
  responseStream.end();
}

async function existsAsync(input: string) {
  return fs
    .access(input)
    .then(() => true)
    .catch(() => false);
}
