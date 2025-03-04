import type { APIGatewayProxyEventV2, Callback, Context } from "aws-lambda";
import type { Writable } from "stream";

export interface ResponseStream extends Writable {
  getBufferedData(): Buffer;
  setContentType(contentType: string): void;
}

export type RequestHandler = (
  event: APIGatewayProxyEventV2,
  streamResponse: ResponseStream,
  context?: Context,
  callback?: Callback
) => void | Promise<void>;

export type EntrypointParameters = {
  responseMode?: ResponseMode;
};

export type ResponseMode = "stream" | "buffer";
export type OutputMode = "server" | "static";
export type PageResolution = "file" | "directory" | "preserve";
export type TrailingSlash = "never" | "always" | "ignore";
