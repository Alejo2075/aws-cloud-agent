#!/usr/bin/env node
import { runCli } from "./app.js";
import { defaultDeps } from "./deps.js";

process.exitCode = await runCli(process.argv.slice(2), defaultDeps());
