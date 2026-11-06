import { writeFileSync } from "node:fs";
import { manifestJsonSchema } from "../packages/manifest/src/index.js";

writeFileSync(
  new URL("../docs/integration/cloud-system-manifest.schema.json", import.meta.url),
  `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`,
);
