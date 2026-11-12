#!/usr/bin/env node
import { main } from '../src/cli.js';
main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`lake-gate: ${e.message}\n`); process.exitCode = 2; });
