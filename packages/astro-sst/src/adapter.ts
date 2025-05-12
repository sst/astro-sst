import type { AstroIntegration } from "astro";
import { BuildMeta, IntegrationConfig } from "./lib/build-meta.js";
import ASTRO_PACKAGE from "astro/package.json" with { type: "json" };
import { debug } from "./lib/logger.js";

const PACKAGE_NAME = "astro-sst";
const astroMajorVersion = parseInt(ASTRO_PACKAGE.version.split(".")[0] ?? 0);

export default function createIntegration(
  entrypointParameters: IntegrationConfig = {
    responseMode: "buffer",
  }
): AstroIntegration {
  debug("astroVersion", ASTRO_PACKAGE.version);

  if (astroMajorVersion < 5) {
    throw new Error(
      "astro-sst requires Astro 5 or newer. Please upgrade your Astro app. Alternatively, use v2 of astro-sst by pinning to `astro-sst@two`."
    );
  }

  return {
    name: PACKAGE_NAME,
    hooks: {
      "astro:config:setup": ({ config, updateConfig }) => {
        if (
          config.output !== "static" &&
          config.image.service.entrypoint.endsWith("sharp") &&
          config.image.remotePatterns.length === 0 &&
          config.image.domains.length === 0 &&
          typeof config.site === "string"
        ) {
          const siteUrl = new URL(config.site);
          updateConfig({
            image: {
              remotePatterns: [
                {
                  protocol: siteUrl.protocol,
                  hostname: siteUrl.hostname,
                  port: siteUrl.port,
                  pathname: `${config.build.assets}/**`,
                },
              ],
            },
          });
        }

        // Enable sourcemaps for SSR builds.
        updateConfig({
          vite: {
            build: {
              sourcemap: config.vite.build?.sourcemap ?? true,
            },
          },
        });

        BuildMeta.setIntegrationConfig(entrypointParameters);
      },
      "astro:routes:resolved": ({ routes }) => {
        BuildMeta.setRoutes(routes);
      },
      "astro:config:done": ({ config, setAdapter, buildOutput }) => {
        BuildMeta.setAstroConfig(config);
        BuildMeta.setBuildOutput(buildOutput);
        setAdapter({
          name: PACKAGE_NAME,
          serverEntrypoint: `${PACKAGE_NAME}/entrypoint`,
          args: { responseMode: entrypointParameters.responseMode },
          exports: ["handler"],
          adapterFeatures: {
            edgeMiddleware: false,
            buildOutput: buildOutput,
          },
          supportedAstroFeatures: {
            hybridOutput: "stable",
            staticOutput: "stable",
            serverOutput: "stable",
            sharpImageService: "stable",
          },
        });
      },

      "astro:build:done": async () => {
        await BuildMeta.handlePrerendered404InSsr();
        await BuildMeta.writeToFile();
      },
    },
  };
}
