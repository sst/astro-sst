import type {
  AstroConfig,
  IntegrationResolvedRoute,
  RouteType,
  ValidRedirectStatus,
} from "astro";
import ASTRO_PACKAGE from "astro/package.json" with { type: "json" };
import { copyFile, readFile, writeFile } from "fs/promises";
import path, { dirname, join, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BUILD_META_FILE_NAME = "sst.buildMeta.json";

type ResponseMode = "stream" | "buffer";

export type BuildMetaConfig = {
  astroVersion: string;
  pluginVersion: string;
  base: AstroConfig["base"];
  domainName?: string;
  responseMode: ResponseMode;
  outputMode: AstroConfig["output"];
  pageResolution: AstroConfig["build"]["format"];
  trailingSlash: AstroConfig["trailingSlash"];
  serverBuildOutputFile: string;
  clientBuildOutputDir: string;
  clientBuildVersionedSubDir: string;
  routes: Array<{
    route: string;
    type: RouteType;
    pattern: string;
    prerender?: boolean;
    redirectPath?: string;
    redirectStatus?: ValidRedirectStatus;
  }>;
};

export type IntegrationConfig = {
  responseMode: ResponseMode;
};

export class BuildMeta {
  protected static integrationConfig: IntegrationConfig;
  protected static astroConfig: AstroConfig;
  protected static routes: IntegrationResolvedRoute[];
  protected static buildOutput: AstroConfig["output"];

  public static setIntegrationConfig(config: IntegrationConfig) {
    this.integrationConfig = config;
  }

  public static setAstroConfig(config: AstroConfig) {
    this.astroConfig = config;
  }

  public static setRoutes(routes: IntegrationResolvedRoute[]) {
    this.routes = routes;
  }

  public static setBuildOutput(output: AstroConfig["output"]) {
    this.buildOutput = output;
  }

  public static async handlePrerendered404InSsr() {
    // Note about handling 404 pages. Here is Astro's behavior:
    // - when static/prerendered, Astro builds a /404.html file in the client build
    //   output dir
    // - when SSR, Astro server handles /404 route
    //
    // We could handle the /404.html with CloudFront's custom error response feature,
    // but that would not work when routing the Astro app on a base path. This is the case
    // when sharing the same CloudFront distribution with an API or another site. It
    // does not make sense to have a custom error response shared across all.
    // ie. redirecting to Astro's 404 page when API returns a 404 response does not
    // make sense.
    //
    // So here is what we do when a request comes in for an invalid route ie. /garbage:
    // - Case 1: static (no server)
    //   => CF function S3 look up will fail, and uri will be rewritten to /404.html
    // - Case 2: prerendered (has server)
    //   => CF function S3 look up will fail, and request will be sent to the server
    //      function. Server fails to serve /garbage, and cannot find the route. Server
    //      tries to serve /404, and cannot find the route. Server finally serves the
    //      404.html file manually bundled into it.
    //   => that's why we copy 404.html into the server output
    // - Case 3: SSR (has server)
    //   => In CF function S3 look up will fail, and request is sent to the server
    //      function. Server fails to serve /garbage, and cannot find the route. Server
    //      tries to serve /404, and cannot find the route. Server finally serves the
    //      404.html file manually bundled into it.

    if (this.buildOutput !== "server") return;

    try {
      await copyFile(
        path.join(fileURLToPath(this.astroConfig.build.client), "404.html"),
        path.join(fileURLToPath(this.astroConfig.build.server), "404.html")
      );
    } catch (error) {
      // Silently ignore errors, as the 404 page might not exist
    }
  }

  /**
   * The main function that exports all build metadata to a JSON file.
   * Processes all routes from the build result, handles trailing slash redirects,
   * adds asset routes, and writes the complete configuration to the output directory.
   */
  public static async writeToFile() {
    const rootDir = fileURLToPath(this.astroConfig.root);
    const clientOutputPath = fileURLToPath(this.astroConfig.build.client);
    const serverOutputPath = fileURLToPath(this.astroConfig.build.server);
    const metadataPath = join(
      relative(rootDir, fileURLToPath(this.astroConfig.outDir)),
      BUILD_META_FILE_NAME
    );

    // Process all routes and create any necessary redirects for trailing slashes
    const routes = this.routes.flatMap((route) => {
      const trailingSlash = this.astroConfig.trailingSlash;
      const isStatic = this.buildOutput === "static";
      const routeSet: BuildMetaConfig["routes"] = [
        {
          route: route.pattern + (trailingSlash === "always" ? "/" : ""),
          type: route.type,
          // regex for matching request URL
          // ie.  "[fruit]/about.astro"- pattern is pattern: /^/([^/]+?)/about/?$/ fbanana/about") is "true"
          pattern: route.pattern.toString(),
          prerender:
            route.type !== "redirect"
              ? isStatic || route.isPrerendered
              : undefined,
          // determine the redirect path based on different possible configurations
          redirectPath: route.redirectRoute
            ? BuildMeta.buildRedirectPath(route.redirectRoute)
            : typeof route.redirect === "string"
              ? route.redirect
              : route.redirect?.destination,
          // get status code if available
          redirectStatus:
            typeof route.redirect === "object"
              ? route.redirect.status
              : undefined,
        },
      ];

      // Add trailing slash redirects for pages (except the root page)
      if (route.type === "page" && route.pattern !== "/") {
        if (trailingSlash === "never") {
          // Add redirect from "/route/" to "/route" at the start
          routeSet.unshift({
            route: route.pattern + "/",
            type: "redirect" as const,
            pattern: route.pattern.toString().replace(/\$\/$/, "\\/$/"),
            redirectPath: BuildMeta.buildRedirectPath(route),
          });
        } else if (trailingSlash === "always") {
          // Add redirect from "/route" to "/route/" at the end
          routeSet.push({
            route: route.pattern.replace(/\/$/, ""),
            type: "redirect" as const,
            pattern: route.pattern.toString().replace(/\\\/\$\/$/, "$/"),
            redirectPath: BuildMeta.buildRedirectPath(route),
          });
        }
      }

      return routeSet;
    });

    // Add a catch-all route for static assets in static output mode
    if (this.buildOutput === "static") {
      // Find the index of the last asset route to insert after it
      const lastAssetIndex = routes.reduce(
        (acc, { route }, index) =>
          route.startsWith(`/${this.astroConfig.build.assets}`) ? index : acc,
        -1
      );

      // Insert catch-all route for assets
      routes.splice(lastAssetIndex + 1, 0, {
        route: `/${this.astroConfig.build.assets}/[...slug]`,
        type: "endpoint",
        pattern: `/^\\/${this.astroConfig.build.assets}\\/.*?\\/?$/`,
        prerender: true,
      });
    }

    // Write the build metadata to the output file
    await writeFile(
      metadataPath,
      JSON.stringify({
        astroVersion: ASTRO_PACKAGE.version,
        pluginVersion: await this.getAdapterVersion(),
        base: this.astroConfig.base,
        // Extract domain name from site URL if available
        domainName:
          typeof this.astroConfig.site === "string" &&
          this.astroConfig.site.length > 0
            ? new URL(this.astroConfig.site).hostname
            : undefined,
        responseMode: this.integrationConfig.responseMode,
        outputMode: this.buildOutput,
        pageResolution: this.astroConfig.build.format,
        trailingSlash: this.astroConfig.trailingSlash,
        serverBuildOutputFile: join(
          relative(rootDir, serverOutputPath),
          this.astroConfig.build.serverEntry
        ),
        clientBuildOutputDir: (() => {
          const p = relative(rootDir, clientOutputPath);
          // Fix for Astro's behavior with static output mode.
          // Astro sets client build paths as if the site was configured for server deployment
          // even when it's actually static. We need to adjust the path to be correct.
          //
          return this.buildOutput === "static" ? join(p, "../") : p;
        })(),
        clientBuildVersionedSubDir: this.astroConfig.build.assets,
        routes,
      } satisfies BuildMetaConfig)
    );
  }

  /**
   * Creates a redirect path string from route segments.
   * Handles dynamic segments by replacing them with ${n} placeholders.
   * Takes trailing slash configuration into account.
   *
   * Example: For "/blog/[id]" route with "always" trailing slash, returns "/blog/${1}/"
   */
  private static buildRedirectPath({ segments }: IntegrationResolvedRoute) {
    const trailingSlash = this.astroConfig.trailingSlash;
    let i = 0;
    return (
      "/" +
      segments
        .map((segment) =>
          segment
            .map((part) => (part.dynamic ? `\${${++i}}` : part.content))
            .join("")
        )
        .join("/") +
      (trailingSlash === "always" ? "/" : "")
    ).replace(/\/+/g, "/"); // Clean up any duplicate slashes
  }

  private static async getAdapterVersion() {
    // get the astro-sst version
    try {
      return (
        (JSON.parse(
          await readFile(join(__dirname, "..", "..", "package.json"), "utf-8")
        ).version as string) ?? "unknown"
      );
    } catch (error) {
      throw new Error("Failed to get adapter version", { cause: error });
    }
  }
}
