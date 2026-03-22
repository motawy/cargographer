#!/usr/bin/env node
import { Command } from 'commander';
import { createIndexCommand } from './index.js';
import { createUsesCommand } from './uses.js';
import { createImpactCommand } from './impact.js';
import { createTraceCommand } from './trace.js';
import { createGenerateCommand } from './generate.js';
import { createResetCommand } from './reset.js';
import { createServeCommand } from './serve.js';
import { createStatusCommand } from './status.js';
import { createTableCommand } from './table.js';
import { createSchemaCommand } from './schema.js';
import { createTableGraphCommand } from './table-graph.js';
import { createTableUsageCommand } from './table-usage.js';
import { createSchemaImportCommand } from './schema-import.js';
import { createSearchContentCommand } from './search-content.js';
import { createCompareManyCommand } from './compare-many.js';
import { createTestTargetsCommand } from './test-targets.js';

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
program.addCommand(createStatusCommand());
program.addCommand(createSchemaCommand());
program.addCommand(createTableCommand());
program.addCommand(createTableGraphCommand());
program.addCommand(createTableUsageCommand());
program.addCommand(createSchemaImportCommand());
program.addCommand(createSearchContentCommand());
program.addCommand(createCompareManyCommand());
program.addCommand(createTestTargetsCommand());
program.addCommand(createServeCommand());

program.parse();
