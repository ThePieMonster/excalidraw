import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { reportResults } from './reporter';
import { TestResult } from './executor';

console.log('Starting QA Reporter...');

async function run() {
    try {
        const ghToken = process.env.GITHUB_TOKEN;
        if (!ghToken) {
            throw new Error("GITHUB_TOKEN is missing.");
        }

        const resultsPath = path.join(process.cwd(), 'results', 'results.json');
        if (!fs.existsSync(resultsPath)) {
            core.warning("No results.json found. The QA validation job may have been skipped.");
            return;
        }

        const results: TestResult[] = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
        core.info(`Loaded ${results.length} test results from results.json`);

        await reportResults(results, ghToken);

    } catch (error) {
        core.setFailed(`Failed to report results: ${error instanceof Error ? error.message : String(error)}`);
    }
}

run();
