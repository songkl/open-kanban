import { Command } from "commander";

const program = new Command();

program
  .name("open-kanban-cli")
  .description("Open Kanban CLI - command-line client for the Open Kanban board")
  .version("0.1.0");

program.parse(process.argv);