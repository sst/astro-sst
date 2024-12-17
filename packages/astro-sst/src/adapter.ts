import type { AstroAdapter, AstroIntegration } from "astro";
import type {
  EntrypointParameters,
  ResponseMode,
  DeploymentStrategy,
} from "./lib/types.js";
import { BuildMeta, IntegrationConfig, BuildResult } from "./lib/build-meta.js";
import { version as ASTRO_VERSION } from "astro/package.json";
import { debug } from "./lib/logger.js";

const PACKAGE_NAME = "astro-sst";
const astroMajorVersion = parseInt(ASTRO_VERSION.split(".")[0] ?? 0);

function getAdapter({
  deploymentStrategy,
  responseMode,
}: {
  deploymentStrategy: DeploymentStrategy;
  responseMode: ResponseMode;
}): AstroAdapter {
  const isStatic = deploymentStrategy === "static";

  const baseConfig: AstroAdapter = {
    name: PACKAGE_NAME,
    serverEntrypoint: `${PACKAGE_NAME}/entrypoint`,
    args: { responseMode },
    exports: ["handler"],
    adapterFeatures: {
      edgeMiddleware: false,
      buildOutput: isStatic ? "static" : "server",
    },
    supportedAstroFeatures: {
      staticOutput: "stable",
      serverOutput: "stable",
      sharpImageService: "stable",
    },
  };

  return !isStatic
    ? baseConfig
    : {
        name: baseConfig.name,
        supportedAstroFeatures: {
          ...baseConfig.supportedAstroFeatures,
          sharpImageService: "unsupported",
        },
      };
}

export default function createIntegration(
  entrypointParameters: EntrypointParameters = {}
): AstroIntegration {
  const integrationConfig: IntegrationConfig = {
    deploymentStrategy: entrypointParameters.deploymentStrategy ?? "regional",
    responseMode: entrypointParameters.responseMode ?? "buffer",
  };
  debug("astroVersion", ASTRO_VERSION);

  if (astroMajorVersion < 5) {
    throw new Error("This version of Astro is not supported by astro-sst. Please upgrade to Astro 5 or later.");
  } else if (
    integrationConfig.deploymentStrategy !== "regional" &&
    integrationConfig.responseMode === "stream"
  ) {
    throw new Error(
      `Deployment strategy ${integrationConfig.deploymentStrategy} does not support streaming responses. Use 'buffer' response mode.`
    );
  }

  return {
    name: PACKAGE_NAME,
    hooks: {
      "astro:config:setup": ({ config, updateConfig }) => {
        if (
          integrationConfig.deploymentStrategy !== "static" &&
          config.output === "static"
        ) {
          // If the user has not specified an output, we will allow the Astro config to override default deployment strategy.
          if (typeof entrypointParameters.deploymentStrategy === "undefined") {
            integrationConfig.deploymentStrategy = "static";
          } else {
            console.log(
              `[astro-sst] Overriding output to 'server' to support ${integrationConfig.deploymentStrategy} deployment.`
            );
            updateConfig({
              output: "server",
            });
            config.output = "server";
          }
        }

        if (
          integrationConfig.deploymentStrategy === "static" &&
          config.output !== "static"
        ) {
          console.log(
            `[astro-sst] Overriding output to 'static' to support ${integrationConfig.deploymentStrategy} deployment.`
          );
          updateConfig({
            output: "static",
          });
          config.output = "static";
        }

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

        if (config.output !== "static") {
          // Enable sourcemaps for SSR builds.
          updateConfig({
            vite: {
              build: {
                sourcemap: true,
              },
            },
          });
        }

        BuildMeta.setIntegrationConfig(integrationConfig);
      },
      "astro:config:done": ({ config, setAdapter }) => {
        BuildMeta.setAstroConfig(config);
        setAdapter(
          getAdapter({
            deploymentStrategy: integrationConfig.deploymentStrategy,
            responseMode: integrationConfig.responseMode,
          })
        );
      },
      "astro:build:done": async (buildResults: BuildResult) => {
        BuildMeta.setBuildResults(buildResults);
        await BuildMeta.exportBuildMeta();
      },
    },
  };
}
