import { Command } from 'commander';
import { createIndexCommand } from './index.js';

const program = new Command();

program
  .name('cartograph')
  .description('Map your codebase so AI can navigate it')
  .version('0.1.0');

program.addCommand(createIndexCommand());

program.parse();
