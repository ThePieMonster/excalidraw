import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import { TestResult } from './executor';

/**
 * Uploads a screenshot to the PR branch via the GitHub Contents API
 * using a [skip ci] commit so it doesn't trigger additional workflow runs.
 * Returns a raw.githubusercontent.com URL for inline embedding.
 *
 * NOTE: This approach uploads images to the PR branch (not master).
 * They are automatically cleaned up when the branch is deleted after merge.
 * If you prefer not to modify the repo at all, you can replace this with
 * an external image host (e.g. Imgur, Cloudinary, S3) and remove the
 * `contents: write` permission from qa-agent.yml.
 */
async function uploadScreenshot(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  branch: string,
  localPath: string,
  repoPath: string
): Promise<string | null> {
  try {
    if (!fs.existsSync(localPath)) {
      core.warning(`Screenshot not found: ${localPath}`);
      return null;
    }

    const content = fs.readFileSync(localPath).toString('base64');

    // Check if the file already exists (need SHA to update)
    let sha: string | undefined;
    try {
      const existing = await octokit.rest.repos.getContent({ owner, repo, path: repoPath, ref: branch });
      if (!Array.isArray(existing.data) && 'sha' in existing.data) {
        sha = existing.data.sha;
      }
    } catch {
      // File doesn't exist yet — that's expected
    }

    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: repoPath,
      message: `chore: upload QA screenshot ${path.basename(repoPath)} [skip ci]`,
      content,
      branch,
      ...(sha ? { sha } : {}),
    });

    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${repoPath}`;
    core.info(`Uploaded screenshot: ${rawUrl}`);
    return rawUrl;
  } catch (error) {
    core.warning(`Failed to upload screenshot: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function reportResults(results: TestResult[], token: string) {
  try {
    const context = github.context;

    // Local execution — just print summary
    if (!process.env.GITHUB_ACTIONS) {
      core.info("Running locally. Skipping GitHub PR comment posting.");
      const totalPassed = results.filter(r => r.passed).length;
      const totalFailed = results.length - totalPassed;
      core.info(`Summary: ${totalPassed} Passed | ${totalFailed} Failed`);
      if (totalFailed > 0) core.setFailed(`UI Validation Failed: ${totalFailed} test(s) did not pass.`);
      return;
    }

    if (!context.payload.pull_request) {
      core.warning("Not running in a pull request context. Skipping comment.");
      return;
    }

    const prNumber = context.payload.pull_request.number;
    const prBranch = context.payload.pull_request.head.ref;
    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const runId = process.env.GITHUB_RUN_ID || 'unknown';
    const octokit = github.getOctokit(token);

    let totalPassed = 0;
    let totalFailed = 0;

    let body = `## UI QA Agent Validation Results\n\n`;

    for (const res of results) {
      if (res.passed) totalPassed++;
      else totalFailed++;

      const icon = res.passed ? '✅' : '❌';
      const durationSec = (res.durationMs / 1000).toFixed(1);
      body += `### ${icon} ${res.testCase.id}: ${res.testCase.title} ⏱️ ${durationSec}s\n`;
      body += `**Expected Result:** ${res.testCase.expectedResult}\n`;

      if (!res.passed && res.reason) {
        body += `**Error Details:**\n\`\`\`\n${res.reason}\n\`\`\`\n`;
      }

      // Upload screenshot and embed inline
      if (res.screenshotPath && fs.existsSync(res.screenshotPath)) {
        const repoPath = `qa-screenshots/run-${runId}/${res.testCase.id}.png`;
        const imageUrl = await uploadScreenshot(octokit, owner, repo, prBranch, res.screenshotPath, repoPath);

        if (imageUrl) {
          body += `\n<details>\n<summary>📸 Click to view screenshot</summary>\n\n![${res.testCase.id}](${imageUrl})\n\n</details>\n\n`;
        } else {
          body += `\n*Screenshot: \`${res.testCase.id}.png\` (available in workflow artifacts)*\n\n`;
        }
      } else {
        body += `\n*No screenshot captured.*\n\n`;
      }
    }

    const artifactsUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
    const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);
    const totalDurationSec = (totalDurationMs / 1000).toFixed(1);

    body += `---\n**Summary**: ${totalPassed} Passed | ${totalFailed} Failed | ⏱️ Total: ${totalDurationSec}s\n`;
    body += `\n<details>\n<summary>📊 Test Case Timing</summary>\n\n`;
    body += `| Test Case | Status | Duration | Start | End |\n`;
    body += `|-----------|--------|----------|-------|-----|\n`;
    for (const res of results) {
      const icon = res.passed ? '✅' : '❌';
      const dur = (res.durationMs / 1000).toFixed(1);
      const start = new Date(res.startTime).toISOString().substring(11, 19);
      const end = new Date(res.endTime).toISOString().substring(11, 19);
      body += `| ${res.testCase.id}: ${res.testCase.title} | ${icon} | ${dur}s | ${start} | ${end} |\n`;
    }
    body += `| **Total** | | **${totalDurationSec}s** | | |\n`;
    body += `\n</details>\n`;

    // Fetch CI pipeline step timings
    try {
      const runIdNum = parseInt(runId, 10);
      if (!isNaN(runIdNum)) {
        const jobsResponse = await octokit.rest.actions.listJobsForWorkflowRun({
          owner,
          repo,
          run_id: runIdNum,
        });

        const jobs = jobsResponse.data.jobs;
        if (jobs.length > 0) {
          body += `\n<details>\n<summary>🔧 CI Pipeline Timing</summary>\n\n`;
          
          for (const job of jobs) {
            const jobStart = job.started_at ? new Date(job.started_at) : null;
            const jobEnd = job.completed_at ? new Date(job.completed_at) : null;
            const jobDuration = jobStart && jobEnd ? ((jobEnd.getTime() - jobStart.getTime()) / 1000).toFixed(1) : '—';
            
            body += `**${job.name}** — ${jobDuration}s total\n\n`;
            body += `| Step | Status | Duration |\n`;
            body += `|------|--------|----------|\n`;

            for (const step of job.steps || []) {
              const stepStart = step.started_at ? new Date(step.started_at) : null;
              const stepEnd = step.completed_at ? new Date(step.completed_at) : null;
              const stepDuration = stepStart && stepEnd ? ((stepEnd.getTime() - stepStart.getTime()) / 1000).toFixed(1) + 's' : '—';
              
              const statusIcon = step.conclusion === 'success' ? '✅' 
                : step.conclusion === 'failure' ? '❌' 
                : step.conclusion === 'skipped' ? '⏭️' 
                : '🔄';

              body += `| ${step.name} | ${statusIcon} | ${stepDuration} |\n`;
            }
            body += `\n`;
          }
          body += `</details>\n`;
        }
      }
    } catch (error) {
      core.warning(`Could not fetch CI step timings: ${error instanceof Error ? error.message : String(error)}`);
    }

    body += `\n📸 [View all screenshots in workflow artifacts](${artifactsUrl})\n`;

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body
    });

    if (totalFailed > 0) {
      core.setFailed(`UI Validation Failed: ${totalFailed} test(s) did not pass.`);
    } else {
      core.info("All UI validations passed successfully.");
    }

  } catch (error) {
    core.setFailed(`Failed to report results: ${error instanceof Error ? error.message : String(error)}`);
  }
}
