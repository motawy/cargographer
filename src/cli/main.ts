#!/usr/bin/env node
import { Command } from 'commander';
import { createIndexCommand } from './index.js';
import { createUsesCommand } from './uses.js';
import { createImpactCommand } from './impact.js';
import { createTraceCommand } from './trace.js';
import { createGenerateCommand } from './generate.js';
import { createResetCommand } from './reset.js';
import { createServeCommand } from './serve.js';

const program = new Command();

program
  .name('cartograph')
  .description('Map your codebase so AI can navigate it')
  .version('0.1.0');

program.addCommand(createIndexCommand());
program.addCommand(createUsesCommand());
program.addCommand(createImpactCommand());
program.addCommand(createTraceCommand());
program.addCommand(createGenerateCommand());
program.addCommand(createResetCommand());
program.addCommand(createServeCommand());

program.parse();
