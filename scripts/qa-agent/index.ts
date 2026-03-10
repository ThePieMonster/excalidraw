import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import { parseQATestingSection } from './parser';
import { executeTestCase, TestResult } from './executor';

console.log('Starting QA Agent script...');

async function run() {
  try {
    const ghToken = process.env.GITHUB_TOKEN;
    if (!ghToken) {
      throw new Error("GITHUB_TOKEN is missing.");
    }

    const context = github.context;
    const prBody = context.payload.pull_request?.body || process.env.MOCK_PR_BODY;

    if (!prBody) {
      core.info("No PR body found. Exiting gracefully.");
      return;
    }

    const qaPlan = parseQATestingSection(prBody);
    if (!qaPlan || qaPlan.testCases.length === 0) {
      core.info("No actionable tests found in QA_TESTING block. Exiting.");
      return;
    }

    core.info(`Found ${qaPlan.testCases.length} test cases to execute.`);

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const results: TestResult[] = [];

    for (const tc of qaPlan.testCases) {
      const result = await executeTestCase(tc, appUrl);
      results.push(result);
    }

    // Save results to JSON for the reporter job to consume
    const resultsDir = path.join(process.cwd(), 'results');
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(resultsDir, 'results.json'),
      JSON.stringify(results, null, 2)
    );
    core.info(`Test results saved to results/results.json`);

    // Fail the job if any tests failed (so the reporter job knows)
    const totalFailed = results.filter(r => !r.passed).length;
    if (totalFailed > 0) {
      core.setFailed(`UI Validation Failed: ${totalFailed} test(s) did not pass.`);
    }

  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

run();
