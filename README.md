# astro-sst

This adapter allows Astro to deploy your SSR or static site to [AWS](https://aws.amazon.com/).

## Installation

Add the AWS adapter to enable SST in your Astro project with the following `astro add` command. This will install the adapter and make the appropriate changes to your `astro.config.mjs` file in one step.

```sh
# Using NPM
npx astro add astro-sst
# Using Yarn
yarn astro add astro-sst
# Using PNPM
pnpm astro add astro-sst
```

If you prefer to install the adapter manually instead, complete the following two steps:

1. Install the AWS adapter to your project's dependencies using your preferred package manager. If you're using npm or aren't sure, run this in the terminal:

   ```bash
     npm install astro-sst
   ```

1. Add two new lines to your `astro.config.mjs` project configuration file.

   ```js title="astro.config.mjs" ins={2, 5-6}
   import { defineConfig } from "astro/config";
   import aws from "astro-sst";

   export default defineConfig({
     output: "server",
     adapter: aws(),
   });
   ```

### Response Mode

When utilizing `server` output, you can choose how responses are handled:

- `buffer`: Responses are buffered and sent as a single response. (_default_)
- `stream`: Responses are streamed as they are generated.

```js title="astro.config.mjs" ins={2, 5-6}
import { defineConfig } from "astro/config";
import aws from "astro-sst";

export default defineConfig({
  output: "server",
  adapter: aws({
    responseMode: "stream",
  }),
});
```

## Upgrading from v2

If you're upgrading from v2 of this adapter, here are the key changes to be aware of:

1. Remove the `deploymentStrategy` option from `astro.config.mjs`. Instead, the `output` setting in your Astro config is now used to determine the deployment type:
   - If you previously used `deploymentStrategy: "regional"`, now set `output: "server"` in `astro.config.mjs`.
   - If you previously used `deploymentStrategy: "edge"`, now set `output: "server"` in `astro.config.mjs`. Update SST to v3.9.25 or later. And configure [`regions`](https://sst.dev/docs/component/aws/astro#regions) on your Astro component.
   - If you previously used `deploymentStrategy: "static"`, now set `output: "static"` in `astro.config.mjs`.

2. Remove the `serverRoutes` option from `astro.config.mjs`
