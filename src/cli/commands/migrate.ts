import { migrateToYAML, hasYAMLConfig } from '../config-yaml';

export async function migrateCommand(): Promise<void> {
  try {
    if (hasYAMLConfig()) {
      console.log('✅ Already using YAML config');
      console.log('');
      console.log('Location: ~/.janee/config.yaml');
      return;
    }

    console.log('🔄 Migrating to YAML config...');
    console.log('');

    migrateToYAML();

    console.log('');
    console.log('✅ Migration complete!');
    console.log('');
    console.log('Changes:');
    console.log('  • Config format: JSON → YAML');
    console.log('  • New capabilities model');
    console.log('  • Old config backed up: ~/.janee/config.json.bak');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Review: cat ~/.janee/config.yaml');
    console.log('  2. Start MCP server: janee serve --mcp');

  } catch (error) {
    if (error instanceof Error) {
      console.error('❌ Error:', error.message);
    } else {
      console.error('❌ Unknown error occurred');
    }
    process.exit(1);
  }
}
