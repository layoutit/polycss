#!/usr/bin/env node
import { main } from "../src/cli.js";

process.exitCode = await main();
