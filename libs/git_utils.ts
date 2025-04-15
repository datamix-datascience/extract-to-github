import * as core from '@actions/core';
import * as exec from '@actions/exec';

export async function configure_git(user_name: string, user_email: string): Promise<void> {
  try {
    core.info(`Configuring Git user: ${user_name} <${user_email}>`);
    await exec.exec('git', ['config', '--global', 'user.name', user_name]);
    await exec.exec('git', ['config', '--global', 'user.email', user_email]);
  } catch (error: any) {
    core.warning(`Failed to configure Git user: ${error.message}`);
  }
}

export async function commit_and_push_changes(
  commit_message: string,
  branch_name: string,
  output_directory: string // Specific directory to add
): Promise<void> {
  try {
    core.info('Adding generated files to Git index...');
    // Add only the specific output directory to avoid unrelated changes
    await exec.exec('git', ['add', output_directory]);

    // Check if there are staged changes within the target directory
    let git_status = '';
    const options = {
      listeners: {
        stdout: (data: Buffer) => { git_status += data.toString(); },
      },
      ignoreReturnCode: true // Don't fail if no changes
    };
    // Check status specifically for the output directory path
    const exit_code = await exec.exec('git', ['status', '--porcelain', '--', output_directory], options);

    if (!git_status.trim()) {
      core.info(`No changes detected within '${output_directory}'. Nothing to commit.`);
      return;
    }

    core.info('Committing changes...');
    await exec.exec('git', ['commit', '-m', commit_message]);

    core.info(`Pushing changes to branch ${branch_name}...`);
    await exec.exec('git', ['push', 'origin', branch_name]);

    core.info('Changes pushed successfully.');

  } catch (error: any) {
    core.setFailed(`Failed to commit and push changes: ${error.message}`);
    throw error; // Re-throw to fail the action step
  }
}
