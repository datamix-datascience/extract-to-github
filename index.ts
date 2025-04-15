import * as core from '@actions/core';
import * as github from '@actions/github';
import * as path from 'path';
import * as fs from 'fs-extra';
import { Buffer } from 'buffer';

import { get_google_auth } from './libs/google_auth';
import { convert_pdf_to_pngs } from './libs/pdf_converter';
import { configure_git, commit_and_push_changes } from './libs/git_utils';

// --- Helper Type Guard ---
function is_readable_stream(obj: any): obj is NodeJS.ReadableStream {
  return obj !== null && typeof obj === 'object' && typeof obj.pipe === 'function';
}

// --- Constants for Google MIME Types ---
const GOOGLE_WORKSPACE_EXPORTABLE_TYPES = [
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.spreadsheet', // Spreadsheets can export to PDF too
  'application/vnd.google-apps.drawing',
  // Add others if needed, e.g., 'application/vnd.google-apps.script' if exportable?
];
const NATIVE_PDF_TYPE = 'application/pdf';

// --- Main Function ---
async function run(): Promise<void> {
  core.startGroup('Initialization');
  const github_token = core.getInput('github_token', { required: true });
  const link_file_suffix = core.getInput('link_file_suffix', { required: true });
  const output_base_dir = core.getInput('output_directory', { required: true });
  const resolution_dpi = parseInt(core.getInput('image_resolution', { required: true }), 10);
  const git_user_name = core.getInput('git_user_name', { required: true });
  const git_user_email = core.getInput('git_user_email', { required: true });

  if (isNaN(resolution_dpi) || resolution_dpi <= 0) {
    core.setFailed('Invalid image_resolution provided.');
    return;
  }

  if (github.context.eventName !== 'pull_request') {
    core.warning('Action should run on the "pull_request" event. Skipping.');
    return;
  }
  if (!github.context.payload.pull_request) {
    core.setFailed('Pull request payload not found in context.');
    return;
  }

  const pr = github.context.payload.pull_request;
  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const pr_number = pr.number;
  const head_sha = pr.head.sha;
  const head_ref = pr.head.ref;

  core.info(`Processing PR #${pr_number} on branch '${head_ref}' (SHA: ${head_sha})`);
  core.info(`Looking for link files ending with: ${link_file_suffix}`);
  core.info(`Outputting PNGs to directory: ${output_base_dir}`);
  core.info(`PNG Resolution: ${resolution_dpi} DPI`);
  core.endGroup();

  core.startGroup('Authenticating Services');
  const octokit = github.getOctokit(github_token);
  const google_clients = await get_google_auth();
  if (!google_clients) {
    core.endGroup(); return;
  }
  const { drive } = google_clients;
  core.endGroup();

  core.startGroup('Finding Changed Link Files');
  let changed_link_files: { path: string; base_name: string }[] = [];
  try {
    const files_iterator = octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
      owner, repo, pull_number: pr_number, per_page: 100,
    });

    for await (const { data: files } of files_iterator) {
      for (const file of files) {
        if (
          file.filename.endsWith(link_file_suffix) &&
          (file.status === 'added' || file.status === 'modified')
        ) {
          // Use the full filename minus the suffix as the base for the output folder
          const base_name = file.filename.substring(0, file.filename.length - link_file_suffix.length);
          core.info(` -> Found candidate: ${file.filename} (Status: ${file.status}) -> Output Base: ${base_name}`);
          changed_link_files.push({ path: file.filename, base_name });
        }
      }
    }
    core.info(`Found ${changed_link_files.length} potential link file(s) to process.`);
  } catch (error: any) {
    core.setFailed(`Failed to list PR files: ${error.message}`);
    core.endGroup(); return;
  }
  core.endGroup();

  if (changed_link_files.length === 0) {
    core.info('No changed link files found in this PR update. Nothing to do.');
    core.setOutput('generated_files_count', 0);
    return;
  }

  let total_pngs_generated = 0;
  const temp_dir = path.join(process.env.RUNNER_TEMP || '/tmp', `gdoc-diff-${Date.now()}`);
  await fs.ensureDir(temp_dir);
  core.info(`Using temporary directory: ${temp_dir}`);

  core.startGroup('Processing Files and Generating PNGs');
  for (const link_file of changed_link_files) {
    core.info(`Processing: ${link_file.path}`);
    let file_id: string | null = null;
    let mime_type: string | null = null;
    let original_name: string | null = null; // Store original name if available

    // 1. Get File ID and MIME Type from link file content
    try {
      core.debug(`Fetching content for: ${link_file.path} at ref ${head_sha}`);
      const { data: content_response } = await octokit.rest.repos.getContent({
        owner, repo, path: link_file.path, ref: head_sha,
      });

      if ('content' in content_response && content_response.encoding === 'base64') {
        const file_content_str = Buffer.from(content_response.content, 'base64').toString('utf-8');
        const file_data = JSON.parse(file_content_str);
        if (file_data && typeof file_data.id === 'string' && typeof file_data.mimeType === 'string') {
          file_id = file_data.id;
          mime_type = file_data.mimeType;
          original_name = typeof file_data.name === 'string' ? file_data.name : null; // Optional name
          core.info(`   - Extracted Drive ID: ${file_id}, MIME Type: ${mime_type}${original_name ? `, Name: ${original_name}` : ''}`);
        } else {
          core.warning(`   - Could not find 'id' and 'mimeType' fields in JSON content of ${link_file.path}`);
          continue;
        }
      } else {
        core.warning(`   - Could not retrieve valid base64 content for ${link_file.path}`);
        continue;
      }
    } catch (error: any) {
      core.warning(`   - Failed to get or parse content of ${link_file.path}: ${error.message}`);
      continue;
    }

    if (!file_id || !mime_type) continue; // Should not happen if parsing succeeded

    // 2. Fetch PDF content (Export or Download)
    // Use the base_name derived from the link file path for the temporary PDF
    const temp_pdf_base = link_file.base_name.replace(/[^a-zA-Z0-9_.-]/g, '_'); // Sanitize name for temp file
    const temp_pdf_path = path.join(temp_dir, `${temp_pdf_base}.pdf`);
    let fetch_error: Error | null = null;

    try {
      core.info(`   - Preparing to fetch PDF content for ID ${file_id} (Type: ${mime_type})`);
      let response_stream: NodeJS.ReadableStream | null = null;

      if (GOOGLE_WORKSPACE_EXPORTABLE_TYPES.includes(mime_type)) {
        core.info(`   - Exporting Google Workspace file as PDF...`);
        const response = await drive.files.export(
          { fileId: file_id, mimeType: 'application/pdf' },
          { responseType: 'stream' }
        );
        if (is_readable_stream(response.data)) {
          response_stream = response.data;
        } else {
          throw new Error('Drive export did not return a readable stream.');
        }
      } else if (mime_type === NATIVE_PDF_TYPE) {
        core.info(`   - Downloading native PDF file...`);
        const response = await drive.files.get(
          { fileId: file_id, alt: 'media' },
          { responseType: 'stream' }
        );
        if (is_readable_stream(response.data)) {
          response_stream = response.data;
        } else {
          throw new Error('Drive get/media did not return a readable stream.');
        }
      } else {
        core.warning(`   - Skipping file: Unsupported MIME type ${mime_type} for PDF conversion.`);
        continue; // Skip to the next link file
      }

      // Pipe the stream to the temporary file
      core.info(`   - Writing fetched data to temporary PDF: ${temp_pdf_path}`);
      const dest = fs.createWriteStream(temp_pdf_path);
      await new Promise((resolve, reject) => {
        if (!response_stream) { // Should be caught above, but double-check
          return reject(new Error("Response stream is null"));
        }
        response_stream.pipe(dest)
          .on('finish', () => {
            core.info(`   - Successfully saved temporary PDF.`);
            resolve(undefined);
          })
          .on('error', (err) => {
            core.error(`   - Error writing temporary PDF: ${err.message}`);
            reject(err); // Reject the promise on stream error
          });
      });

    } catch (error: any) {
      fetch_error = error; // Store error to handle after potential cleanup attempt
      // Log specific Drive API errors
      const gaxiosError = error as { code?: number; message: string; }; // Type assertion for common error shape
      if (gaxiosError.code === 404) {
        core.error(`   - Fetch failed: Google Drive file ID ${file_id} not found (404).`);
      } else if (gaxiosError.code === 403) {
        core.error(`   - Fetch failed: Permission denied for Google Drive file ID ${file_id} (403).`);
      } else {
        core.error(`   - Fetch failed for file ID ${file_id}: ${gaxiosError.message}`);
      }
      // Attempt to clean up potentially incomplete/empty temp file
      await fs.remove(temp_pdf_path).catch(rmErr => core.warning(`Failed to remove incomplete temp file ${temp_pdf_path}: ${rmErr.message}`));
      continue; // Skip to next link file
    }

    // If fetch succeeded, proceed to conversion
    // 3. Convert PDF to PNGs
    // Output path: output_base_dir / relative path from repo root / base_name / 0001.png
    const relative_dir = path.dirname(link_file.path); // Get dir of the link file
    // Use link_file.base_name which correctly excludes the suffix
    const image_output_dir = path.join(output_base_dir, relative_dir, link_file.base_name);

    core.info(`   - Converting PDF to PNGs in directory: ${image_output_dir}`);
    const generated_pngs = await convert_pdf_to_pngs(temp_pdf_path, image_output_dir, resolution_dpi);
    total_pngs_generated += generated_pngs.length;

    // 4. Clean up temporary PDF
    core.debug(`   - Removing temporary PDF: ${temp_pdf_path}`);
    await fs.remove(temp_pdf_path);

  } // End loop through link files
  core.endGroup();

  // Cleanup temp dir
  await fs.remove(temp_dir);
  core.info(`Temporary directory cleaned up: ${temp_dir}`);

  core.setOutput('generated_files_count', total_pngs_generated);

  if (total_pngs_generated > 0) {
    core.startGroup('Committing and Pushing PNGs');
    await configure_git(git_user_name, git_user_email);
    // More generic commit message
    const commit_message = `[skip ci] Generate visual diff PNGs for PR #${pr_number}\n\nGenerates PNG images for visual diffing of Google Drive files updated in this PR.`;
    // Pass the top-level output directory to the git commit function
    await commit_and_push_changes(commit_message, head_ref, output_base_dir);
    core.endGroup();
  } else {
    core.info('No PNGs were generated in this run (or only unsupported file types were found).');
  }

  core.info('Google Document Visual Diff Generator completed.');
}

// Run the main function and catch any unhandled errors
run().catch((error: any) => {
  core.error(`Action failed with error: ${error.message}`);
  if (error.stack) {
    core.debug(error.stack);
  }
  core.setFailed(error.message);
});
