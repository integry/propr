#!/usr/bin/env tsx

import 'dotenv/config';
import { listRepositoryBranchConfigurations } from '../src/git/repoManager.ts';

interface RepoConfig {
    branch: string;
    envKey: string;
}

function main(): void {
    console.log('GitFix Repository Branch Configurations\n');
    
    const configs = listRepositoryBranchConfigurations() as Record<string, RepoConfig>;
    const configCount = Object.keys(configs).length;
    
    if (configCount === 0) {
        console.log('No repository-specific branch configurations found.');
        console.log('\nTo configure repository-specific branches, add environment variables like:');
        console.log('   GIT_DEFAULT_BRANCH_OWNER_REPO=branch_name');
        console.log('\n   Example:');
        console.log('   GIT_DEFAULT_BRANCH_INTEGRY_FOREX=dev');
        console.log('\nSee docs/REPOSITORY_BRANCH_CONFIG.md for detailed documentation.');
        return;
    }
    
    console.log(`Found ${configCount} repository-specific branch configuration${configCount > 1 ? 's' : ''}:\n`);
    
    const sortedRepos = Object.keys(configs).sort();
    
    sortedRepos.forEach(repoKey => {
        const config = configs[repoKey];
        console.log(`${repoKey}`);
        console.log(`   Branch: ${config.branch}`);
        console.log(`   Environment Variable: ${config.envKey}`);
        console.log('');
    });
    
    console.log('Global Configuration:');
    console.log(`   Fallback Branch: ${process.env.GIT_FALLBACK_BRANCH || 'main (default)'}`);
    console.log(`   Default Branch: ${process.env.GIT_DEFAULT_BRANCH || 'main (default)'}`);
    
    console.log('\nNotes:');
    console.log('   - Repository-specific configurations take highest priority');
    console.log('   - If a configured branch doesn\'t exist, automatic detection will be used');
    console.log('   - Changes to .env file require restart to take effect');
    console.log('\nFor more information, see docs/REPOSITORY_BRANCH_CONFIG.md');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
