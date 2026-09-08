#!/usr/bin/env bun

const usage = `Passoff

Usage:
  passoff ask <harness> [options] <task>

Commands:
  ask       Give a bounded task to another coding harness

Options:
  -h, --help  Show this help
`;

const [command] = Bun.argv.slice(2);

if (command === undefined || command === "--help" || command === "-h") {
  console.log(usage);
} else {
  console.error(`Unknown command: ${command}\n`);
  console.error(usage);
  process.exitCode = 1;
}
