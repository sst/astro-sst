import type {
  AstroConfig,
  AstroIntegration,
  IntegrationRouteData,
  RouteType,
  ValidRedirectStatus,
} from "astro";
import path, { dirname, join, relative } from "path";
import { readFile, writeFile, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import ASTRO_PACKAGE from "astro/package.json" with { type: "json" };
import type {
  OutputMode,
  PageResolution,
  ResponseMode,
  TrailingSlash,
} from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BUILD_META_FILE_NAME = "sst.buildMeta.json";

type SerializableRoute = {
  route: string;
  type: RouteType;
  pattern: string;
  prerender?: boolean;
  redirectPath?: string;
  redirectStatus?: ValidRedirectStatus;
};

export type BuildMetaConfig = {
  astroVersion: string;
  pluginVersion: string;
  domainName?: string;
  responseMode: ResponseMode;
  outputMode: OutputMode;
  pageResolution: PageResolution;
  trailingSlash: TrailingSlash;
  serverBuildOutputFile: string;
  clientBuildOutputDir: string;
  clientBuildVersionedSubDir: string;
  routes: Array<{
    route: string;
    type: RouteType;
    pattern: string;
    prerender?: boolean;
    redirectPath?: string;
    redirectStatus?: 300 | 301 | 302 | 303 | 304 | 307 | 308;
  }>;
};

export type IntegrationConfig = {
  responseMode: ResponseMode;
};

export class BuildMeta {
  protected static integrationConfig: IntegrationConfig;
  protected static astroConfig: AstroConfig;

  public static setIntegrationConfig(config: IntegrationConfig) {
    this.integrationConfig = config;
  }

  public static setAstroConfig(config: AstroConfig) {
    this.astroConfig = config;
  }

  private static getRedirectPath(
    { segments }: IntegrationRouteData,
    trailingSlash: TrailingSlash
  ) {
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
    ).replace(/\/+/g, "/");
  }

  private static getSerializableRoute(
    route: IntegrationRouteData,
    trailingSlash: TrailingSlash,
    outputMode: OutputMode
  ): SerializableRoute {
    const isStatic = outputMode === "static";
    return {
      route: route.route + (trailingSlash === "always" ? "/" : ""),
      type: route.type,
      pattern: route.pattern.toString(),
      prerender:
        route.type !== "redirect" ? isStatic || route.prerender : undefined,
      redirectPath:
        typeof route.redirectRoute !== "undefined"
          ? BuildMeta.getRedirectPath(route.redirectRoute, trailingSlash)
          : typeof route.redirect === "string"
            ? route.redirect
            : route.redirect?.destination,
      redirectStatus:
        typeof route.redirect === "object" ? route.redirect.status : undefined,
    };
  }

  private static getTrailingSlashRedirect(
    route: IntegrationRouteData,
    trailingSlash: "always" | "never"
  ) {
    if (trailingSlash === "never") {
      return {
        route: route.route + "/",
        type: "redirect" as const,
        pattern: route.pattern.toString().replace(/\$\/$/, "\\/$/"),
        redirectPath: BuildMeta.getRedirectPath(route, trailingSlash),
      };
    }

    return {
      route: route.route.replace(/\/$/, ""),
      type: "redirect" as const,
      pattern: route.pattern.toString().replace(/\\\/\$\/$/, "$/"),
      redirectPath: BuildMeta.getRedirectPath(route, trailingSlash),
    };
  }

  public static async handlePrerendered404InSsr() {
    if (this.astroConfig.output !== "server") return;

    try {
      await copyFile(
        path.join(fileURLToPath(this.astroConfig.build.client), "404.html"),
        path.join(fileURLToPath(this.astroConfig.build.server), "404.html")
      );
    } catch (error) {}
  }

  public static async exportBuildMeta(
    buildResult: Parameters<
      NonNullable<AstroIntegration["hooks"]["astro:build:done"]>
    >[0]
  ) {
    const rootDir = fileURLToPath(this.astroConfig.root);

    const outputPath = join(
      relative(rootDir, fileURLToPath(this.astroConfig.outDir)),
      BUILD_META_FILE_NAME
    );

    const routes = buildResult.routes
      .map((route: IntegrationRouteData) => {
        const routeSet = [
          this.getSerializableRoute(
            route,
            this.astroConfig.trailingSlash,
            this.astroConfig.output
          ),
        ];

        if (route.type === "page" && route.route !== "/") {
          if (this.astroConfig.trailingSlash === "never") {
            routeSet.unshift(
              this.getTrailingSlashRedirect(
                route,
                this.astroConfig.trailingSlash
              )
            );
          } else if (this.astroConfig.trailingSlash === "always") {
            routeSet.push(
              this.getTrailingSlashRedirect(
                route,
                this.astroConfig.trailingSlash
              )
            );
          }
        }

        return routeSet;
      })
      .flat();

    if (this.astroConfig.output === "static") {
      const lastAssetIndex = routes.reduce(
        (acc, { route }, index) =>
          route.startsWith(`/${this.astroConfig.build.assets}`) ? index : acc,
        -1
      );

      routes.splice(lastAssetIndex + 1, 0, {
        route: `/${this.astroConfig.build.assets}/[...slug]`,
        type: "endpoint",
        pattern: `/^\\/${this.astroConfig.build.assets}\\/.*?\\/?$/`,
        prerender: true,
      });
    }

    let pluginVersion;
    try {
      pluginVersion = JSON.parse(
        await readFile(join(__dirname, "..", "..", "package.json"), "utf-8")
      ).version;
    } catch (error) {
      throw new Error("Failed to get plugin version", { cause: error });
    }

    const buildMeta = {
      astroVersion: ASTRO_PACKAGE.version,
      pluginVersion: pluginVersion ?? "unknown",
      domainName:
        typeof this.astroConfig.site === "string" &&
        this.astroConfig.site.length > 0
          ? new URL(this.astroConfig.site).hostname
          : undefined,
      responseMode: this.integrationConfig.responseMode,
      outputMode: this.astroConfig.output,
      pageResolution: this.astroConfig.build.format,
      trailingSlash: this.astroConfig.trailingSlash,
      serverBuildOutputFile: join(
        relative(rootDir, fileURLToPath(this.astroConfig.build.server)),
        this.astroConfig.build.serverEntry
      ),
      clientBuildOutputDir: relative(
        rootDir,
        fileURLToPath(this.astroConfig.build.client)
      ),
      clientBuildVersionedSubDir: this.astroConfig.build.assets,
      routes,
    } satisfies BuildMetaConfig;

    /**
     * For some reason the Astro integration system sets the following values
     * as if the site was configured for server deployment even when it's
     * actually configured for static. For this reason, we need to override these
     * values as best we can.
     **/
    if (this.astroConfig.output === "static") {
      buildMeta.clientBuildOutputDir = join(
        buildMeta.clientBuildOutputDir,
        "../"
      );
    }

    await writeFile(outputPath, JSON.stringify(buildMeta));
  }
}
